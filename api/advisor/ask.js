// POST /api/advisor/ask  { messages:[{role,content}], context:{page,…} }
//   -> { ok, reply, used:[toolName…] }  ·  503 when no model key is configured
//
// The app-wide advisor. Reachable from every screen via the floating button, it can see
// **what's on the screen you're standing on** and can **look things up in our own data**
// to answer.
//
// Design notes worth reading before changing this:
//
// 1. **Every tool is READ-ONLY, and that's structural, not a promise.** All five are
//    existing queries; nothing here can write, and the prompt says so. An advisor that
//    could change stock would be a liability the moment it misunderstood a question.
//
// 2. **It answers from our data, not from memory.** Left to itself a model will happily
//    invent a plausible shelf location. The tools exist so "where is this pair" has a
//    real answer, and the prompt forbids guessing when a lookup comes back empty.
//
// 3. **The rules are injected, never typed.** Fee defaults and the Buy/Watch/Pass
//    thresholds come from `src/lib/payout.js` — the same module the calculator computes
//    with, so the advisor cannot quote a threshold the screen disagrees with.
//
// 4. **SOP answers are role-scoped.** `search_sop` runs through `sopRoleForAccount` —
//    the same rule the /sop screen applies — so a warehouse account can't reach the PH
//    team's procedures by asking nicely.
//
// 5. **Aggregate out, mostly.** SKU history is counts and medians. `find_stock` is the
//    one tool that returns per-pair rows (a VIN and a shelf) — because "which pair, and
//    where" is the question, and that data is already on the Inventory screen every one
//    of these roles can open.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { advisorSkuHistory, findStockByCode, pendingCounts,
  ourListingFlags, dbConfigured } from '../_lib/db.js';
import { priceInquiryForSkuSizes } from '../_lib/intake.js';
import { stockxConfigured, stockxPriceForSkuSize } from '../_lib/stockx.js';
import { shopifyConfigured, shopifyTopSellers, shopifyVelocity,
  shopifyInventoryForSku } from '../_lib/shopify.js';
import { DEFAULT_FEE_PCT, BUY_MIN_PROFIT, BUY_MIN_ROI } from '../../src/lib/payout.js';
import { searchSop, articleById, sopRoleForAccount } from '../../src/lib/sop/index.js';
import { ADVISOR_NAME } from '../../src/lib/advisorContext.js';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = process.env.PAYOUT_AI_MODEL || 'gpt-5.4-mini';

const MAX_TURNS = 20;        // conversation depth the model sees
const MAX_CHARS = 4000;      // per message
const MAX_TOOL_HOPS = 4;     // lookups per question — a bound on cost and latency

export function advisorConfigured() {
  return !!process.env.OPENAI_API_KEY;
}

/* ------------------------------------------------------------------ */
/* Tools — all reads, all existing queries                            */
/* ------------------------------------------------------------------ */

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'sku_history',
      description: 'What WE know about a shoe. Two things at once: our INVENTORY (pairs on hand, what we last and typically paid, median days from receiving to sold) and its real SALES VELOCITY over the last 30 days across every channel — units sold, the per-channel split, sizes, average price and the liquidity band. Use this before any opinion about whether a shoe is worth buying or how fast it moves; the velocity is measured, not estimated.',
      parameters: {
        type: 'object',
        properties: {
          sku: { type: 'string', description: 'Style ID, e.g. DD1391-100' },
          size: { type: 'string', description: 'Optional US size, e.g. "10.5"' },
        },
        required: ['sku'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_stock',
      description: 'Find the actual pairs we hold, by VIN, UPC barcode or style ID. Returns each pair with its status and shelf location. Use this for "do we have", "where is", "which shelf".',
      parameters: {
        type: 'object',
        properties: { code: { type: 'string', description: 'A VIN, a UPC, or a style ID' } },
        required: ['code'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pending_work',
      description: 'The warehouse-wide backlog right now: pairs not yet listed to each store, awaiting shelving, bought without a box, missing a cost, awaiting shipment, restocks pending, and POs waiting to be reconciled. Use for "what needs doing", "what are we behind on".',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_sop',
      description: "Search the written procedures and FAQs in this app — how to receive a shipment, shelve a pair, resolve a no-box, reconcile a purchase order, print labels, rescale stock, and so on. Use this for every \"how do I\", \"what's the process\", \"where do I go to…\", \"what's the rule about…\" question. Returns the procedure's steps.",
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Plain words, e.g. "shelve a pair with no box" or "reconcile a PO shortage"' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'top_sellers',
      description: "What is actually SELLING, ranked, over a window — across EVERY channel (GOAT, StockX, eBay, TikTok, the online store) with the per-channel split, average price and sizes. Use for \"what's our best seller this week\", \"what's moving\", \"what should we restock\". Defaults to 7 days.",
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'integer', description: 'Window in days. 7 = this week, 30 = this month. 60 is the maximum — the sales feed does not reach further back.' },
          limit: { type: 'integer', description: 'How many styles to return. Default 10, max 50.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'stock_status',
      description: "How many of a style we appear to have: Shopify's inventory figures by size, plus what OUR OWN records say is on hand and listed to each store. Use for \"do we have it\", \"how many are left\", \"what sizes do we have\". The result carries a disclaimer about accuracy — repeat it.",
      parameters: {
        type: 'object',
        properties: { sku: { type: 'string', description: 'Style ID, e.g. DD1391-100' } },
        required: ['sku'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'market_price',
      description: 'Live market prices for one shoe in one size: Alias (lowest ask, highest offer, last sold, Global Indicator) and StockX (lowest ask, highest bid) when configured. Costs an upstream call each time — one size per question unless asked otherwise.',
      parameters: {
        type: 'object',
        properties: {
          sku: { type: 'string' },
          size: { type: 'string' },
          consigned: { type: 'boolean', description: 'false (default) = Alias "With You" pricing, which is what the buying screens quote. true = consigned.' },
        },
        required: ['sku', 'size'],
      },
    },
  },
];

// One procedure, trimmed to what can be quoted back: what it's for, when it applies,
// and the steps. Long articles are cut rather than sent whole — the answer is meant to
// be three sentences, not a manual page.
function renderArticle(a) {
  if (!a) return null;
  return {
    id: a.id,
    title: a.title,
    summary: a.summary || null,
    when: a.when || null,
    steps: (a.steps || []).slice(0, 14).map((st) => [st.do, st.note].filter(Boolean).join(' — ').slice(0, 320)),
  };
}

async function runTool(name, args, user) {
  const sku = String(args?.sku || '').trim();
  const size = args?.size == null ? null : String(args.size).trim();
  switch (name) {
    case 'sku_history': {
      if (!dbConfigured() || !sku) return { error: 'no sku given' };
      const [held, sales] = await Promise.all([
        advisorSkuHistory(sku, size),
        shopifyConfigured() ? shopifyVelocity(sku, { days: 30 }) : Promise.resolve(null),
      ]);
      return {
        inventory: held || { note: 'we have never held this SKU' },
        // Two different kinds of "no": the export isn't loaded at all, versus it IS
        // loaded and this style has never sold. The first is missing data, the second
        // is a finding — conflating them talks someone out of a good buy.
        // Every channel at once — GOAT, StockX, eBay, TikTok, the online store — with the
        // split, because "44 sold" and "44 sold, 24 of them on GOAT" are different
        // instructions to whoever decides where to list next.
        sales: sales && !sales.error
          ? { ...sales, note: sales.sold === 0 ? 'no sales in this window' : undefined }
          : { note: 'Shopify is not configured here — say the velocity is unknown, do not guess it' },
      };
    }
    case 'find_stock': {
      const code = String(args?.code || '').trim();
      if (!dbConfigured() || !code) return { error: 'no code given' };
      const rows = await findStockByCode(code, 25);
      if (!rows?.length) return { note: 'nothing on file for that code' };
      // Trimmed to what answers "which pair, and where" — the rest is noise in a prompt.
      return {
        found: rows.length,
        pairs: rows.slice(0, 25).map((r) => ({
          vin: r.vin, sku: r.sku, size: r.size, status: r.status,
          location: r.location || null, name: r.name || null,
        })),
      };
    }
    case 'pending_work': {
      if (!dbConfigured()) return { error: 'database unavailable' };
      return await pendingCounts();
    }
    case 'search_sop': {
      const q = String(args?.query || '').trim();
      if (!q) return { error: 'no query given' };
      // Scoped to the ASKER'S role, using the same rule the /sop screen applies
      // (sopRoleForAccount). A warehouse account must not reach the PH team's
      // procedures through the advisor when the SOP page itself would refuse.
      const hits = searchSop(q, sopRoleForAccount(user?.role));
      if (!hits.length) return { note: 'no procedure or FAQ matches that — say so rather than inventing a process' };
      return {
        found: hits.length,
        results: hits.slice(0, 3).map((h) => (h.kind === 'faq'
          ? { kind: 'faq', question: h.title, answer: String(h.answer || h.a || '').slice(0, 800), article: h.see || null }
          : renderArticle(articleById(h.id)))),
      };
    }
    case 'top_sellers': {
      if (!shopifyConfigured()) return { error: 'Shopify is not configured here, so there is no sales feed to rank' };
      const r = await shopifyTopSellers({ days: args?.days, limit: args?.limit });
      if (!r || r.error) return { error: r?.error || 'Shopify is not configured here' };
      return {
        ...r,
        ...(r.unmatched_units
          ? { unmatched_note: `${r.unmatched_units} units sold had no style code in their product title and are not in this ranking` }
          : {}),
        ...(r.truncated ? { warning: 'more orders in this window than were read; the ranking may be incomplete' } : {}),
      };
    }
    case 'stock_status': {
      if (!sku) return { error: 'no sku given' };
      const [shop, ours] = await Promise.all([
        shopifyConfigured() ? shopifyInventoryForSku(sku) : Promise.resolve(null),
        dbConfigured() ? ourListingFlags(sku) : Promise.resolve(null),
      ]);
      return {
        // Asked "how many do we have", give the numbers and then SAY THIS, every time.
        // Shopify's count is what Shopify believes; our flags are what PH ticked. A pair
        // can be listed and already gone, or on a shelf and never listed. Neither is a
        // physical count, and only one place has that.
        how_many_disclaimer: 'These are Shopify inventory figures and our own sync flags — NOT a physical count. They can be stale or wrong in both directions. For a number to act on, ask the warehouse.',
        shopify: shop || { note: 'Shopify is not configured on this server — say so, do not infer' },
        our_records: ours || { note: 'database unavailable' },
      };
    }
    case 'market_price': {
      if (!sku || !size) return { error: 'sku and size are both required' };
      const consigned = args?.consigned === true;
      const out = { sku, size, basis: consigned ? 'consigned' : 'with_you' };
      try {
        const a = await priceInquiryForSkuSizes(sku, [size], { consigned });
        out.alias = a.results?.[0] || (a.configured ? 'no Alias market for this size' : 'Alias not configured');
      } catch { out.alias = 'Alias lookup failed'; }
      try {
        if (!stockxConfigured()) out.stockx = 'StockX not configured';
        else {
          const s = await stockxPriceForSkuSize(sku, size);
          out.stockx = s?.market || 'no StockX market for this size';
          if (s?.product?.exact === false) out.stockx_warning = `StockX matched a different style (${s.product.styleId})`;
        }
      } catch { out.stockx = 'StockX lookup failed'; }
      return out;
    }
    default:
      return { error: `unknown tool ${name}` };
  }
}

/* ------------------------------------------------------------------ */
/* Prompt                                                              */
/* ------------------------------------------------------------------ */

// Whatever screen the user is on describes itself. Unknown shapes are stringified
// rather than dropped — a screen that publishes something new shouldn't need this file
// changed to benefit from it.
function renderScreen(ctx = {}) {
  if (!ctx || typeof ctx !== 'object' || !Object.keys(ctx).length) return 'Nothing in particular — they opened the advisor from somewhere with no page data.';
  const lines = [];
  if (ctx.page) lines.push(`PAGE: ${ctx.page}`);
  for (const [k, v] of Object.entries(ctx)) {
    if (k === 'page' || v == null || v === '') continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') lines.push(`${k}: ${v}`);
    else lines.push(`${k}: ${JSON.stringify(v)}`);
  }
  return lines.join('\n').slice(0, 6000);
}

function systemPrompt(screen, user) {
  // The admin account is itself named "Alex", so the identity line is explicit about
  // which Alex is which — otherwise the model has two of them and picks wrong.
  return `You are ${ADVISOR_NAME}, the advisor inside Stickballman12, a shoe-inventory app used
by a warehouse team, a pricing/listing team, and admins. You are talking to ${user?.name || 'a member of staff'}${user?.role ? `, whose role is ${user.role}` : ''}
— that is the person, not you; you are ${ADVISOR_NAME} and they are not.
Answer questions about their stock, their backlog, how to do things in this app, and
whether a pair is worth buying.

WHAT'S ON THEIR SCREEN RIGHT NOW:
${screen}

LOOKING THINGS UP:
- You have seven read-only tools: sku_history, find_stock, pending_work, top_sellers,
  stock_status, market_price, and search_sop — the written procedures and FAQs.
- "What's selling / what's our best seller / what's moving" is top_sellers, not a SKU
  lookup. You do not need them to name a style first.
- **Sales come from Shopify, which carries EVERY channel** — GOAT, StockX, eBay, TikTok,
  the online store — so a total is a real total. Give the channel split when it changes
  what someone would do: "44 sold, 24 of them on GOAT" tells them where to list next.
- **The sales feed reaches 60 days.** Never state or imply anything about older sales.
- **Asked how many we HAVE, give the numbers and then pass on the disclaimer the tool
  returns**, every time: these are Shopify's figures and our sync flags, not a physical
  count, and the warehouse is the place to get a number worth acting on. Do not drop that
  caveat to sound more confident.
- If a tool reports a \`permission\` problem, say the figure is unavailable. Never
  substitute a zero — "none left" and "we can't see it" are opposite answers.
- Be precise about WHOSE truth you are quoting. Sales and inventory come from Shopify;
  our sync flags are what PH ticked here. Where the two disagree, that gap is the
  interesting part — say it rather than picking one.
- USE THEM. Do not answer a question about our stock, our costs, our backlog or a live
  price from memory — look it up. You cannot know these; they change hourly.
- You cannot change anything. Every tool is a read. If asked to mark something sold,
  move stock, or edit a price, say that's not something you can do and name the screen
  that does it.
- If a lookup comes back empty, say so plainly. Never fill the gap with a plausible
  guess — a made-up shelf number sends someone walking to the wrong aisle, and an
  invented procedure is worse: it reads exactly like a real one.
- For "how do I" questions, search_sop FIRST and answer from what it returns, naming the
  procedure. Our SOPs are the authority on how this app is used here; a generally
  sensible warehouse process that isn't ours is a wrong answer.
- search_sop is scoped to this person's role. If nothing comes back, the procedure may
  simply belong to another desk — say that, don't reconstruct it.

THE NUMBERS THIS APP USES (live values — use these, not your own rules of thumb):
- Platform fees: Alias ${DEFAULT_FEE_PCT.alias}% (7% commission + 2.9% ACH), StockX ${DEFAULT_FEE_PCT.stockx}% (7% seller + 3% payment).
- payout = sale price − fees. profit = payout − cost. ROI = profit ÷ cost.
- A BUY needs BOTH: at least $${BUY_MIN_PROFIT} profit a pair AND at least ${BUY_MIN_ROI}% ROI.
  One of the two is a WATCH; neither is a PASS.
- Alias is quoted "With You" (we hold the pair and ship on sale) unless told otherwise.
  Consigned is a different, usually higher number.
- StockX's API has no last-sale figure. Never quote one for StockX; Alias last-sold is real.
- Everything in this business runs on EST.

HOW TO ANSWER:
- Be direct and opinionated. A bad deal is called bad in the first sentence.
- Show the arithmetic when it decides something: "$105 − 9.9% = $94.60, minus $88 cost = $6.60, 7.5% ROI."
- Two to four sentences for a simple question. Longer only when the analysis earns it.
- Our own history outranks any general intuition about a shoe. If we paid less before,
  or the last batch sat for months, lead with that.
- Judge how fast it sells on the MEASURED velocity from sku_history, not on the liquidity
  someone picked by hand on the screen. Where they disagree, say so — "you've marked it
  weekly, but it's sold 16 in the last 30 days" is exactly what this is for.
- Talk like an experienced colleague. No preamble, no disclaimers, no offers to help further.
- Don't sign off, don't greet, and don't introduce yourself unless asked — this is a
  running thread, not a series of letters.
- Plain prose. **Bold** is fine around the numbers that decide the answer, and \`code\` for
  a SKU or VIN — the panel renders both. No headings, bullet lists or tables: they render
  literally in a panel this small.`;
}

/* ------------------------------------------------------------------ */

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  // Suppliers are deliberately absent: their portal is a different app with none of
  // this data in it.
  const user = requireRole(req, res, ['warehouse', 'ph_team']); // admin/superadmin auto-allowed
  if (!user) return;
  // Each question can cost several upstream calls. Throttled accordingly.
  if (!rateLimit(req, { windowMs: 60_000, max: 12 }))
    return send(res, 429, { ok: false, error: 'Give the advisor a moment — too many questions at once.' });
  if (!advisorConfigured())
    return send(res, 503, { ok: false, error: 'The advisor isn’t configured on this server (no model key).' });

  const body = await getJsonBody(req);
  const history = (Array.isArray(body.messages) ? body.messages : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-MAX_TURNS)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }));
  if (!history.length) return send(res, 400, { ok: false, error: 'Nothing to ask.' });

  const ctx = body.context && typeof body.context === 'object' ? body.context : {};
  const messages = [{ role: 'system', content: systemPrompt(renderScreen(ctx), user) }, ...history];
  const used = [];

  try {
    for (let hop = 0; hop <= MAX_TOOL_HOPS; hop += 1) {
      // The last hop drops the tools entirely, which forces an answer instead of a
      // fifth lookup the user is still waiting on.
      const canCallTools = hop < MAX_TOOL_HOPS;
      const r = await fetch(OPENAI_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, messages, ...(canCallTools ? { tools: TOOLS } : {}) }),
        signal: AbortSignal.timeout(60_000),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) {
        console.error('[advisor]', r.status, JSON.stringify(data?.error || data).slice(0, 300));
        return send(res, 502, {
          ok: false,
          error: r.status === 429 ? 'The model is rate-limited right now — try again in a moment.' : 'The advisor couldn’t answer just now.',
        });
      }
      const msg = data?.choices?.[0]?.message;
      if (!msg) return send(res, 502, { ok: false, error: 'The advisor returned nothing.' });

      const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      if (!calls.length) {
        const reply = String(msg.content || '').trim();
        if (!reply) return send(res, 502, { ok: false, error: 'The advisor returned an empty answer.' });
        return send(res, 200, { ok: true, reply, used });
      }

      // Echo the assistant's tool_calls back verbatim — the API rejects tool results
      // that don't answer a call it can see in the history.
      messages.push(msg);
      for (const call of calls) {
        let args = {};
        try { args = JSON.parse(call.function?.arguments || '{}'); } catch { /* bad JSON → empty args, the tool reports why */ }
        const name = call.function?.name;
        used.push(name);
        let result;
        try { result = await runTool(name, args, user); } catch (e) { result = { error: e.message }; }
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result).slice(0, 8000) });
      }
    }
    return send(res, 502, { ok: false, error: 'The advisor kept looking things up without answering.' });
  } catch (e) {
    console.error('[advisor]', e.message);
    return send(res, 502, { ok: false, error: 'The advisor couldn’t be reached.' });
  }
}
