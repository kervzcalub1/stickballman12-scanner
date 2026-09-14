// "How many of this shoe do we already hold, in this size?" — one pair, one answer.
//
// Extracted so the SCREEN (`api/cart/stock.js`, every line of a request at once) and the
// TELEGRAM CARD (`api/_lib/notify.js`, one line as it is asked about) cannot disagree.
// Two copies of this arithmetic would eventually give an approver a different number
// depending on where they read it, which is worse than not showing it at all.
//
// The basis and every judgement in it are documented in `docs/context/buy-cart.md`:
// Shopify is the authority for what we have LISTED, our `synced_shopify = false` units
// are what Shopify cannot see, and the seam between them is that column so nothing is
// counted twice.
import { stockOnHandBySizeForSku } from './db.js';
import { shopifyConfigured, shopifyInventoryForSku } from './shopify.js';

// Sizes match on an exact (trimmed, lowercased) label and nothing cleverer. "7.5" and
// "7.5W" are different shoes on different feet.
const key = (v) => String(v ?? '').trim().toLowerCase();

const EMPTY = {
  on_hand: 0, listed_shopify: 0, not_listed: 0, no_box: 0,
  in_store_or_existing: 0, pre_sell: 0, pre_sold: 0,
};

/**
 * @param {{sku: string, size: ?string}} pair
 * @param {{ours: ?Array, shop: ?object}} [pre] already-fetched sources, when the caller
 *   is reading many lines of one style and does not want to fetch per line.
 */
export function readLineStock({ sku, size }, pre) {
  const ours = pre?.ours || null;
  const shop = pre?.shop || null;
  const configured = shopifyConfigured();

  // A Shopify figure we could not get is `null`, never 0. "None left" and "we can't see
  // it" are opposite answers, and only one of them justifies buying more.
  const shopOk = !!shop && !shop.error && !shop.permission;
  const shopUnavailable = !configured
    ? 'Shopify is not connected on this server'
    : shop?.permission || (shop?.error ? 'Shopify inventory lookup failed' : (shop ? null : 'Shopify inventory lookup failed'));

  const styleOnHand = (ours || []).reduce((n, x) => n + (Number(x.on_hand) || 0), 0);
  const row = (ours || []).find((x) => key(x.size) === key(size)) || null;
  const sizeOurs = row ? {
    on_hand: Number(row.on_hand) || 0,
    listed_shopify: Number(row.listed_shopify) || 0,
    not_listed: Number(row.not_listed) || 0,
    no_box: Number(row.no_box) || 0,
    in_store_or_existing: Number(row.off_ph) || 0,
    pre_sell: Number(row.pre_sell) || 0,
    pre_sold: Number(row.pre_sold) || 0,
  } : { ...EMPTY };

  let shopSize = null;
  if (shopOk) {
    const hit = Object.entries(shop.sizes || {}).find(([label]) => key(label) === key(size));
    // An exact-size miss on a live Shopify answer is a real zero: the style was found
    // and this size had nothing sellable on it.
    shopSize = size ? (hit ? Number(hit[1]) || 0 : 0) : null;
  }

  // Shopify's listed figure plus what Shopify cannot see. With Shopify down it falls
  // back to our own records for BOTH halves and says which it is, rather than reporting
  // a half-count as a whole one.
  const weHold = !size ? null
    : shopSize != null ? shopSize + sizeOurs.not_listed
      : sizeOurs.on_hand;

  return {
    sku, size: size || null,
    we_hold: weHold,
    basis: !size ? 'no_size' : shopSize != null ? 'shopify_plus_unlisted' : 'our_records_only',
    shopify: { qty: shopSize, unavailable: shopUnavailable || null },
    ours: sizeOurs,
    // Pairs OUR records call listed that Shopify no longer shows — usually sold on a
    // channel and not yet scanned out. A finding, never arithmetic to fold in.
    unscanned_gap: shopSize != null && sizeOurs.listed_shopify > shopSize
      ? sizeOurs.listed_shopify - shopSize : 0,
    style_on_hand: styleOnHand,
    other_sizes: Math.max(0, styleOnHand - sizeOurs.on_hand),
  };
}

/** Fetch both sources for one style and read one size out of them. */
export async function stockForPair({ sku, size }) {
  const [oursR, shopR] = await Promise.allSettled([
    stockOnHandBySizeForSku(sku),
    shopifyConfigured() ? shopifyInventoryForSku(sku) : Promise.resolve(null),
  ]);
  return readLineStock({ sku, size }, {
    ours: oursR.status === 'fulfilled' ? (oursR.value || []) : null,
    shop: shopR.status === 'fulfilled' ? shopR.value : null,
  });
}

/** One line of prose for a person: what we hold, and where it is. */
export function stockSentence(s) {
  if (!s) return 'Stock unknown.';
  if (s.basis === 'no_size') return `${s.style_on_hand} on hand across every size (this line has no size).`;
  if (s.basis === 'our_records_only') {
    return `${s.we_hold} on hand — our own records only (${s.shopify.unavailable}).`;
  }
  const bits = [];
  if (s.ours.not_listed > 0) bits.push(`${s.ours.not_listed} not listed yet`);
  if (s.other_sizes > 0) bits.push(`${s.other_sizes} in other sizes`);
  if (s.ours.pre_sold > 0) bits.push(`${s.ours.pre_sold} pre-sold, not counted`);
  return s.we_hold === 0
    ? `None of this size on hand${bits.length ? ` (${bits.join(', ')})` : ''}.`
    : `${s.we_hold} on hand${bits.length ? ` — ${bits.join(', ')}` : ''}.`;
}
