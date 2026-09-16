// Telling the outside world that a buyer has asked about a pair.
//
// One POST to a Make.com custom webhook, from which Make builds the Telegram card the
// desk taps. `MAKE_WEBHOOK_URL` in the environment, never in the source: anybody holding
// that URL can inject into their scenario, so it is a credential.
//
// ── Two rules this has to obey ────────────────────────────────────────────────
//
// It must NEVER make the buyer wait. They are standing in a shop; a Make outage, a slow
// scenario or a DNS failure must cost them nothing. So this is called after the response
// has gone out and it swallows everything — the worst case is a line the desk has to
// notice on the screen instead, which is exactly where they used to have to notice it.
//
// It must fire AFTER the market read, not with the add. The buy call is written a few
// seconds later by `priceInBackground`, and a card that goes out first says "not priced"
// on every pair — which is the one thing the approver most needs and the reason to have
// a card at all.
import { getBuyCart, getBuyCartLine } from './db.js';
import { fundingTarget, fundingTaxPct } from './buycart.js';
import { stockForPair, stockSentence } from './buyingStock.js';
import { calcPayout, DEFAULT_FEE_PCT, PLATFORMS } from '../../src/lib/payout.js';

// THE TEST SUITE MUST NOT POST TO TELEGRAM.
//
// The e2e suite builds real requests — `E2E Buyer`, `E2E Store` — and adding a line is
// what sends a card, so every local run put approval cards in front of the desk for pairs
// nobody is buying. Teardown then deletes the cart, and the card OUTLIVES the request it
// describes: tapping its button answers "That buying request does not exist", which is
// the endpoint being correct about a row that is genuinely gone. BC-2923 was one of these.
//
// It is stopped the way the 17TRACK leak is stopped — `playwright.config.js` blanks
// MAKE_WEBHOOK_URL for the server it starts, and vite's devApi only fills a var that is
// `undefined`, so an empty string is already "set" and .env cannot put the real URL back.
//
// IT IS *NOT* GUARDED ON APP_ENV, and that is the correction, not an omission. A guard on
// `APP_ENV !== 'dev'` covers the suite and the developer's own dev server alike — and the
// dev server is where this feature is actually exercised by a person. It shipped that way
// for half an hour and silently swallowed every card from `npm run dev`, which looked
// exactly like Make dropping them: two rounds of chasing the wrong half of the system
// while someone waited. A control that cannot tell a test run from a human doing their
// job is not a control, it is an outage with a rationale.
export const notifyConfigured = () => !!String(process.env.MAKE_WEBHOOK_URL || '').trim();

// WHICH INSTANCE SENT IT. Dev and prod share one bot, one group and one webhook; the
// scenario carries this on every button's callback_data and posts the tap back to the
// matching host, so a card from a dev tunnel is recorded on the dev server and never on
// production. `vite.config.js` pins APP_ENV=dev for the dev server; server.mjs (Railway)
// never sets it, so anything else reads as prod — the safe default, and what Make
// assumes when the field is missing.
export const notifyEnv = () => (process.env.APP_ENV === 'dev' ? 'dev' : 'prod');

const money = (n) => (n == null || !Number.isFinite(Number(n)) ? null : Math.round(Number(n) * 100) / 100);
const dollars = (n) => (money(n) == null ? '—' : `$${money(n).toFixed(2)}`);

/**
 * @param {number} cartId
 * @param {number} lineId
 * @param {{ photoFileId?: number|null, photoCount?: number }} [extra]
 */
export async function notifyLineAsked(cartId, lineId, extra = {}) {
  // THIS RETURN USED TO BE SILENT, and it was the only path in here that reached no
  // further and logged nothing — so a server configured not to send looked exactly like a
  // server that had sent successfully. That ambiguity cost two rounds of "no card
  // arrived" with a person waiting, and it is the same lesson as the failed scan: a
  // refusal has to leave a line, or it cannot be told apart from the thing working.
  const url = String(process.env.MAKE_WEBHOOK_URL || '').trim();
  if (!url) {
    console.log(`[notify] line ${lineId} — MAKE_WEBHOOK_URL is blank on this server, so no card was sent`);
    return { sent: false, reason: 'MAKE_WEBHOOK_URL is not set' };
  }

  const rawBase = String(process.env.APP_BASE_URL || '').trim().replace(/\/+$/, '');
  // A URL the receiver cannot reach is WORSE than no URL. Make runs on its own servers:
  // handed a localhost link its HTTP module errors, and because that module sits in
  // front of `sendPhoto` the whole scenario dies — so an unreachable photo costs the
  // card, not just the picture. Better to say there isn't one and let the card through.
  const localOnly = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|$)/i.test(rawBase);
  const base = localOnly ? '' : rawBase;
  const photoNote = !rawBase
    ? 'APP_BASE_URL is not set on the server, so there is no address to fetch the photo from'
    : localOnly
      ? `APP_BASE_URL is ${rawBase}, which only resolves on the machine running the app — set it to a public origin (a tunnel, or the deployed host)`
      : null;

  try {
    const [cart, line] = await Promise.all([getBuyCart(cartId), getBuyCartLine(cartId, lineId)]);
    if (!cart || !line) {
      console.warn(`[notify] cart ${cartId} line ${lineId} — gone before the card could be built`);
      return { sent: false, reason: 'cart or line is gone' };
    }

    // Never fatal. A Shopify outage costs the card its stock line, not its existence.
    let stock = null;
    try { stock = await stockForPair({ sku: line.sku, size: line.size }); } catch { /* noted below */ }

    // BOTH platforms, not just the winner. The stored snapshot keeps only the best one —
    // enough to make a call, and not enough to judge it. An approver comparing "98.9% via
    // Alias" against "12% via StockX" is looking at a very different decision from one
    // where the two agree, and the second number is what tells them which they are in.
    //
    // Re-derived rather than stored: both market prices and the landed cost are already
    // on the line, and `calcPayout` is the same function the calculator and the screen
    // run. Deriving it here cannot drift from them; a second stored column could.
    const cost = money(line.final_cost);
    const byPlatform = (cost == null ? [] : [
      ['alias', money(line.alias_price)],
      ['stockx', money(line.stockx_price)],
    ].filter(([, price]) => price != null && price > 0)
      .map(([key, price]) => {
        const p = calcPayout(key, price, cost, DEFAULT_FEE_PCT[key]);
        return {
          platform: key,
          label: PLATFORMS.find((x) => x.key === key)?.label || key,
          // The lowest ask on that platform — the number the call was computed FROM.
          // Shown because an approver cannot sanity-check a percentage against a shoe
          // they know, and can against a price.
          market: price,
          payout: money(p.payout),
          profit: money(p.profit),
          roi: money(p.roi),
        };
      }))
      // The WINNING platform first — the one `Decision` and `Profit` above refer to —
      // then the rest by ROI. `dealVerdict` does not simply pick the biggest ROI (a slow
      // seller can lose to a smaller, faster margin), so sorting on ROI alone would have
      // quietly put the loser on the top line.
      .sort((a, b) => {
        const best = line.best_platform;
        if (a.platform === best && b.platform !== best) return -1;
        if (b.platform === best && a.platform !== best) return 1;
        return (b.roi ?? -Infinity) - (a.roi ?? -Infinity);
      });

    const call = line.verdict ? {
      verdict: line.verdict,
      profit: money(line.profit),
      roi: money(line.roi),
      platform: line.best_platform || null,
      payout: money(line.best_payout),
      alias: money(line.alias_price),
      stockx: money(line.stockx_price),
      liquidity: line.liquidity || null,
      lands_at: cost,
      // Every platform we have a price for, best first. `platform`/`roi` above stay the
      // WINNER, so nothing reading the old fields changes meaning.
      platforms: byPlatform,
    } : null;

    // A ready-to-send caption. Built HERE rather than in Make so the wording lives with
    // the rules it describes — a card that says "BUY" while the screen says "Pass"
    // because somebody edited a scenario is the failure worth spending a field on.
    //
    // Four labelled blocks, blank-line separated. On a phone in a group chat a wall of
    // dot-separated values is one long line to squint at; a labelled block is something
    // you can find the number in without reading the rest. The order is the order an
    // approver decides in: what it is, what it costs, what it earns, what we already
    // hold — and only then the paperwork.
    const priced = call && call.verdict;
    const caption = [
      // WHAT THE SHOE IS, on its own lines. The style code alone identified the pair for
      // anyone holding it, and for nobody else — an approver reading a group chat knows
      // "Air Jordan 1 Mid 'Patent Bred Toe'" and does not carry HV4091-006 in their head.
      // The name is dropped rather than printed empty: a blank first line reads as a
      // broken card, and the code below still says exactly which pair this is.
      ...(String(line.name || '').trim() ? [String(line.name).trim()] : []),
      line.sku,
      ...(line.size ? [`Size: ${line.size}`] : []),
      // Read off the LINE, not the call. What a pair costs us is its shelf price through
      // the cost stack — it exists whether or not Alias and StockX answered, and an
      // approver looking at an unpriced pair still wants to know what it would cost.
      `Shelf ${dollars(line.shelf_price)}${money(line.final_cost) != null ? ` · costs us ${dollars(line.final_cost)}/unit` : ''}`,
      '',
      'Payout Engine Result:',
      // No market is not a bad call, and must never render as one. "We didn't look" and
      // "we looked and it's bad" are different answers to somebody deciding whether to
      // spend, so the block says which rather than printing an empty Decision line.
      ...(priced
        ? [
          `Decision: ${String(call.verdict).toUpperCase()}`,
          `Profit: ${dollars(call.profit)}`,
          // One line per platform we have a price for, best first. The `Profit:` line
          // above is the WINNING platform's, so repeating it in brackets here printed
          // the same figure twice; the other platform's money is on `call.platforms`
          // for anything that needs it.
          //
          // Both matter because two platforms agreeing and two platforms disagreeing are
          // different decisions, and the snapshot only ever kept the winner — enough to
          // make a call, not enough to judge one.
          ...(byPlatform.length
            ? byPlatform.map((p) => `${p.label}: ${dollars(p.market)} ask · ${p.roi != null ? `${p.roi.toFixed(1)}%` : '—'} ROI`)
            : [`${call.roi != null ? `${call.roi.toFixed(1)}%` : '—'} ROI via ${call.platform || '—'}`]),
        ]
        : ['Not priced — no Alias or StockX market for this size right now.']),
      '',
      'Inventory:',
      stock ? stockSentence(stock) : 'Stock could not be read.',
      '',
      cart.cart_code,
      `Supplier: ${cart.buyer_name}`,
      // Dropped rather than printed empty: "Store: —" reads like a missing field the
      // approver should chase, and a request cannot be sent without a store anyway.
      ...(cart.retailer ? [`Store: ${cart.retailer}`] : []),
    ].join('\n');

    const body = {
      event: 'buying_line_asked',
      env: notifyEnv(),
      sent_at: new Date().toISOString(),
      request: {
        id: Number(cart.id),
        code: cart.cart_code,
        buyer: cart.buyer_name,
        retailer: cart.retailer || null,
        purpose: cart.purpose || null,
        status: cart.status,
      },
      line: {
        id: Number(line.id),
        sku: line.sku,
        size: line.size || null,
        name: line.name || null,
        colorway: line.colorway || null,
        shelf_price: money(line.shelf_price),
        // The buyer states no quantity — it is the decision being asked for, and the
        // approve call below will not be accepted without one.
        qty: null,
      },
      call,
      stock,
      photo: {
        file_id: extra.photoFileId ?? null,
        count: extra.photoCount ?? 0,
        // An ABSOLUTE url Make can fetch with the API key. Relative would be useless —
        // the scenario has no idea where we live. `APP_BASE_URL` is the one thing this
        // needs from the environment beyond the key itself; without it the field is null
        // and the card simply goes out without a picture.
        url: (base && extra.photoFileId) ? `${base}/api/cart/shoe-photo?fileId=${extra.photoFileId}` : null,
        // Named so nobody has to guess. The VALUE never leaves the server.
        auth_header: 'x-api-key',
        // WHY there is no url, in words. A null with no reason sends somebody reading a
        // Make execution off to check the wrong thing.
        unavailable: (extra.photoFileId && !base) ? photoNote : null,
      },
      caption,
      // Exactly what to post back, minus the quantity the approver chooses. Spelled out
      // so the scenario does not have to know our URL shapes.
      decide: {
        cart_id: Number(cart.id),
        line_ids: [Number(line.id)],
        approve_needs: 'qty',
      },
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error(`[notify] ${cart.cart_code} ${line.sku}/${line.size || '—'} — Make answered ${res.status}`);
      return { sent: false, reason: `webhook ${res.status}` };
    }
    // A SUCCESSFUL SEND LEAVES A LINE TOO.
    //
    // Only failures logged, so "no card arrived" had two explanations that looked
    // identical from here: we never sent, or we sent and the scenario dropped it. Twice
    // that cost a round of guessing with a person waiting. A send is the one moment we
    // can testify to, so it says so — with what Make answered, because a 200 from the
    // webhook means QUEUED, not delivered.
    console.log(`[notify] ${cart.cart_code} ${line.sku}/${line.size || '—'} → Make ${res.status}`
      + `${body.photo.url ? ' (with photo)' : ' (no photo)'}`);
    return { sent: true };
  } catch (e) {
    // Swallowed on purpose. See the header: the buyer must never pay for this.
    console.error('[notify] could not tell Make about the line:', e.message);
    return { sent: false, reason: e.message };
  }
}

/**
 * A REQUEST-level event: the buyer closed their list, or opened it again.
 *
 * Same webhook, same `event` field; the scenario routes on it and posts the caption as
 * a plain message — no photo, no buttons, nothing to decide. Plain text only: the Make
 * side sends it with no parse mode, so a stray `*` or `<` would print, not format.
 *
 * Why the group hears about it at all: the desk funds a TOTAL, and a list that has just
 * been closed is a total that is now final — while a list that has just been re-opened
 * is a total about to move, possibly after cards have already gone out. Both change
 * what the person holding the cards should do next.
 *
 * Fire-and-forget, like the line card: the buyer never waits on Make.
 *
 * @param {number} cartId
 * @param {'buying_request_closed'|'buying_request_reopened'} event
 * @param {object} [actor]  who pressed it (the caption names the buyer off the request)
 */
export async function notifyRequestEvent(cartId, event, actor = null) {
  const url = String(process.env.MAKE_WEBHOOK_URL || '').trim();
  if (!url) {
    console.log(`[notify] cart ${cartId} ${event} — MAKE_WEBHOOK_URL is blank on this server, so nothing was sent`);
    return { sent: false, reason: 'MAKE_WEBHOOK_URL is not set' };
  }
  try {
    const cart = await getBuyCart(cartId);
    if (!cart) return { sent: false, reason: 'cart is gone' };
    const n = (v) => Number(v) || 0;
    const target = fundingTarget(cart);
    const tax = fundingTaxPct(cart);
    const rejected = n(cart.line_count) - n(cart.approved_count) - n(cart.pending_count);
    const pairs = (k) => `${k} pair${k === 1 ? '' : 's'}`;
    const closed = event === 'buying_request_closed';
    const caption = [
      closed
        ? `${cart.cart_code} — ${cart.buyer_name} closed the request`
        : `${cart.cart_code} — ${cart.buyer_name} re-opened the request and is adding more pairs`,
      `${pairs(n(cart.line_count))} asked · ${n(cart.approved_count)} approved · ${n(cart.pending_count)} still waiting${rejected > 0 ? ` · ${rejected} turned down` : ''}`,
      closed
        ? `Approved ${dollars(cart.approved_amount)}${tax ? ` + ${tax}% tax` : ''} = ${dollars(target)} to fund${n(cart.gc_total) > 0 ? ` · ${dollars(cart.gc_total)} in cards already issued` : ''}`
        : n(cart.gc_total) > 0
          ? `Cards issued so far: ${dollars(cart.gc_total)} — a top-up may be needed once the new lines are approved.`
          : 'No cards issued yet.',
      ...(cart.retailer ? [`Store: ${cart.retailer}`] : []),
    ].join('\n');

    const body = {
      event,
      env: notifyEnv(),
      sent_at: new Date().toISOString(),
      request: {
        id: Number(cart.id),
        code: cart.cart_code,
        buyer: cart.buyer_name,
        retailer: cart.retailer || null,
        purpose: cart.purpose || null,
        status: cart.status,
        line_count: n(cart.line_count),
        pending_count: n(cart.pending_count),
        approved_count: n(cart.approved_count),
        rejected_count: Math.max(0, rejected),
        approved_amount: money(cart.approved_amount),
        funding_target: money(target),
        gc_total: money(cart.gc_total),
      },
      caption,
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error(`[notify] ${cart.cart_code} ${event} — Make answered ${res.status}`);
      return { sent: false, reason: `webhook ${res.status}` };
    }
    console.log(`[notify] ${cart.cart_code} ${event} → Make ${res.status}`);
    return { sent: true };
  } catch (e) {
    console.error(`[notify] could not tell Make about ${event}:`, e.message);
    return { sent: false, reason: e.message };
  }
}
