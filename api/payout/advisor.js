// POST /api/payout/advisor  { messages:[{role,content}], context:{…} }
//   -> { ok, reply }  ·  503 when no model key is configured
//
// The Payout Calculator's advisor: a chat that can see the calculation on screen AND
// what our own inventory knows about the shoe, and will argue with you about whether
// to buy it.
//
// Three things worth knowing before changing this:
//
// 1. **The rules are injected, never written out by hand.** The fee defaults and the
//    Buy/Watch/Pass thresholds come from `src/lib/payout.js` — the same module the
//    screen computes with. The tool this was ported from typed "StockX fees: 10%…
//    A strong deal is 30%+ ROI" into the prompt as prose, which is fine until someone
//    changes a constant and the advisor keeps confidently quoting last month's numbers.
//    Here they cannot drift apart.
//
// 2. **What we send is aggregate.** `advisorSkuHistory` returns counts, averages and a
//    median — no VINs, no batch codes, no people. This payload leaves our servers for a
//    third-party model, so it carries what informs a buy decision and nothing that
//    identifies a person or a shipment.
//
// 3. **It is optional.** No key → 503 with a plain message, and the screen hides the
//    panel. Nothing else on the calculator depends on it.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { advisorSkuHistory, dbConfigured } from '../_lib/db.js';
import { DEFAULT_FEE_PCT, BUY_MIN_PROFIT, BUY_MIN_ROI } from '../../src/lib/payout.js';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
// Pinned by env so the model can be moved without a deploy. Default matches the engine
// this was ported from.
const MODEL = process.env.PAYOUT_AI_MODEL || 'gpt-5.4-mini';

const MAX_TURNS = 20;      // the conversation the model sees
const MAX_CHARS = 4000;    // per message

export function advisorConfigured() {
  return !!process.env.OPENAI_API_KEY;
}

// A compact, human-readable brief. Plain lines beat JSON here: the model reads it more
// reliably, and a person debugging a bad answer can see exactly what it was told.
function renderContext(ctx = {}, history) {
  const L = [];
  const money = (v) => (v == null || v === '' ? null : `$${Number(v).toFixed(2)}`);
  if (ctx.name || ctx.sku) L.push(`SHOE: ${[ctx.name, ctx.sku, ctx.size ? `size ${ctx.size}` : null].filter(Boolean).join(' · ')}`);
  else L.push('SHOE: nothing loaded yet.');

  if (ctx.cost) {
    const c = ctx.cost;
    L.push(`COST AT THE REGISTER: ${money(c.finalCost) || '—'} (shelf ${money(c.shelf) || '—'}`
      + `${c.storePct ? `, store ${c.storePct}%` : ''}${c.promoPct ? `, promo ${c.promoPct}%` : ''}`
      + `${c.giftPct ? `, gift card ${c.giftPct}%` : ''}${c.couponAmt ? `, coupon ${money(c.couponAmt)}` : ''}`
      + `${c.cashbackPct ? `, cashback ${c.cashbackPct}%` : ''}${c.taxPct ? `, tax ${c.taxPct}%` : ''}`
      + `${c.tipAmt ? `, tip ${money(c.tipAmt)}` : ''}${c.shippingAmt ? `, shipping ${money(c.shippingAmt)}` : ''})`);
  }

  if (Array.isArray(ctx.payouts)) {
    for (const p of ctx.payouts) {
      if (!p?.salePrice) { L.push(`${String(p?.label || '?').toUpperCase()}: no sale price entered.`); continue; }
      L.push(`${String(p.label).toUpperCase()}: sale ${money(p.salePrice)} − ${p.feePct}% fees `
        + `= payout ${money(p.payout)} · profit ${money(p.profit)} · ROI ${Number(p.roi).toFixed(1)}%`);
    }
  }
  if (ctx.market?.alias) L.push(`ALIAS MARKET (${ctx.basis === 'consigned' ? 'consigned' : 'With You'}): ${ctx.market.alias}`);
  if (ctx.market?.stockx) L.push(`STOCKX MARKET: ${ctx.market.stockx}`);
  if (ctx.liquidity) L.push(`LIQUIDITY (entered by the user): sells ${ctx.liquidity}`);
  if (ctx.verdict) L.push(`CURRENT CALL: ${ctx.verdict}`);

  if (history) {
    const h = [];
    h.push(`${history.on_hand} on hand${ctx.size ? ` (${history.on_hand_size} in size ${ctx.size})` : ''}`);
    if (history.sold_total) h.push(`${history.sold_total} sold all time, ${history.sold_90d} in the last 90 days`);
    if (history.median_days_to_sell != null) h.push(`median ${history.median_days_to_sell} days from receiving to sold`);
    if (history.last_cost != null) h.push(`we last paid ${money(history.last_cost)}${history.last_cost_on ? ` on ${history.last_cost_on}` : ''}`);
    if (history.avg_cost != null) h.push(`average paid ${money(history.avg_cost)}`);
    L.push(`OUR HISTORY WITH THIS SKU: ${h.join('; ')}.`);
  }
  return L.join('\n');
}

function systemPrompt(contextBlock) {
  return `You are the buying advisor inside Stickballman12's Payout Calculator. A warehouse
buyer is standing in a shop with a shoe in their hand, deciding whether to buy it. Help
them decide.

WHAT YOU CAN SEE RIGHT NOW:
${contextBlock}

THE NUMBERS THIS APP USES (these are the live values — use them, don't invent others):
- Default platform fees: Alias ${DEFAULT_FEE_PCT.alias}% (7% commission + 2.9% ACH), StockX ${DEFAULT_FEE_PCT.stockx}% (7% seller + 3% payment).
  The buyer may override either for a reduced-fee seller programme — if a fee is shown above, that one is real.
- payout = sale price − fees. profit = payout − final cost. ROI = profit ÷ final cost.
- This app calls it a BUY only when profit is at least $${BUY_MIN_PROFIT} AND ROI is at least ${BUY_MIN_ROI}%.
  One of the two is a WATCH; neither is a PASS. Judge against those, not your own rules of thumb.
- Alias prices here are quoted "With You" by default — the buyer holds the pair and ships it when it sells.
  Consigned pricing is a different, usually higher number; say so if it matters to the answer.
- StockX's API gives no last-sale figure. Never quote one for StockX; Alias last-sold is real.

HOW TO ANSWER:
- Be direct and opinionated. A bad deal should be called bad in the first sentence.
- Show the arithmetic when it decides something: "$105 − 9.9% = $94.60, minus $88 cost = $6.60, 7.5% ROI."
- Answer "what if" questions by recalculating, not by hedging.
- Two to four sentences for a simple question. Longer only when the analysis earns it.
- Weigh how fast it sells. Capital tied up in a slow mover is a real cost even at a good ROI.
- Our own history above outranks any general intuition about the shoe. If we paid less
  before, or the last batch sat for months, lead with that.
- If a number you need isn't on screen, say which one and stop. Never invent a price.
- Talk like an experienced buyer to a colleague. No preamble, no disclaimers.
- Plain prose. **Bold** is fine around the numbers that decide the answer, and \`code\`
  for a SKU — the screen renders both. No headings, bullet lists or tables: those render
  literally, as raw #s and dashes, in the small panel this appears in.`;
}

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse', 'ph_team']); // admin/superadmin auto-allowed
  if (!user) return;
  // Every turn costs money upstream. Throttled harder than the price lookups.
  if (!rateLimit(req, { windowMs: 60_000, max: 12 }))
    return send(res, 429, { ok: false, error: 'Give the advisor a moment — too many questions at once.' });
  if (!advisorConfigured())
    return send(res, 503, { ok: false, error: 'The advisor isn’t configured on this server (no model key).' });

  const body = await getJsonBody(req);
  const messages = (Array.isArray(body.messages) ? body.messages : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-MAX_TURNS)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }));
  if (!messages.length) return send(res, 400, { ok: false, error: 'Nothing to ask.' });

  const ctx = body.context && typeof body.context === 'object' ? body.context : {};
  let history = null;
  try {
    if (dbConfigured() && ctx.sku) history = await advisorSkuHistory(ctx.sku, ctx.size);
  } catch { /* history is a bonus, never the reason the advisor fails */ }

  try {
    const r = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'system', content: systemPrompt(renderContext(ctx, history)) }, ...messages],
      }),
      signal: AbortSignal.timeout(45_000),
    });
    const data = await r.json().catch(() => null);
    if (!r.ok) {
      // Surface the upstream reason in the log; keep the screen's copy plain.
      console.error('[payout/advisor]', r.status, JSON.stringify(data?.error || data).slice(0, 300));
      const msg = r.status === 429
        ? 'The model is rate-limited right now — try again in a moment.'
        : 'The advisor couldn’t answer just now.';
      return send(res, 502, { ok: false, error: msg });
    }
    const reply = data?.choices?.[0]?.message?.content?.trim();
    if (!reply) return send(res, 502, { ok: false, error: 'The advisor returned an empty answer.' });
    return send(res, 200, { ok: true, reply });
  } catch (e) {
    console.error('[payout/advisor]', e.message);
    return send(res, 502, { ok: false, error: 'The advisor couldn’t be reached.' });
  }
}
