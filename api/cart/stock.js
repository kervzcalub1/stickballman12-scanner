// POST /api/cart/stock  { cartId }  -> { ok, shopify, lines: [...] }
//
// "How many of these do we already have?" — asked of every line on a buying request at
// once, on demand.
//
// **Why this exists.** The request answers what a pair costs and what it would sell
// for, and says nothing at all about how many of it are already sitting on our own
// shelves. An approver reading a good ROI has no way to see that PH is still trying to
// move the six we bought last month, so the same shoe gets bought again — and the buy
// call, which is about the market, will go on saying BUY every time.
//
// **The basis is Shopify plus what is not yet listed**, and that is one sentence with
// two halves that must not overlap:
//
//   · **Shopify** is the live authority for anything we have LISTED. Every channel —
//     GOAT, StockX, eBay, TikTok — lands there (`shopify.md`), so a pair that sold this
//     morning is already off Shopify's count while our own `items` row still reads
//     in-stock until somebody scans it out at the end of a shift.
//   · **Our own not-yet-listed units** are the pairs Shopify cannot see at all: still
//     being priced, no-box, in-store, existing stock, held pre-sell. Shopify reports
//     zero for them, correctly, and zero is the wrong answer to "do we have any".
//
// So the seam is `synced_shopify`, and the count is Shopify's figure for the size plus
// our not-listed units of that size. Our OWN count of listed pairs is not added — it is
// the same shelf Shopify already counted — but it is returned beside it, because when
// the two disagree the gap is itself the finding: pairs that sold and were never
// scanned out.
//
// Read-only, and visible to anyone who can read the request — the buyer included. A
// buyer standing in the shop is the one person who can still decide not to pick it up,
// and suppliers can already ask the advisor the same question (`SUPPLIER_TOOLS`).
import { getJsonBody, send, applySecurity, rateLimit, requireAuth, blockIfMustChange } from '../_lib/util.js';
import { getBuyCartFull, stockOnHandBySizeForSku, dbConfigured } from '../_lib/db.js';
import { shopifyConfigured, shopifyInventoryForSku } from '../_lib/shopify.js';
import { cartVisibleTo } from '../_lib/buycart.js';

// Sizes match on an exact (trimmed, lowercased) label and nothing cleverer — the same
// rule the advisor's breakdown uses. "7.5" and "7.5W" are different shoes on different
// feet, and a fuzzy match would invent stock that does not exist.
const key = (v) => String(v ?? '').trim().toLowerCase();

// One press must not turn into forty upstream calls. A request with more distinct
// styles than this gets its stock read for the first 25 and says so, rather than
// hanging on a Shopify page-through nobody is waiting for.
const MAX_STYLES = 25;

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireAuth(req, res);
  if (!user) return;
  if (blockIfMustChange(user, res)) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 30 }))
    return send(res, 429, { ok: false, error: 'Please wait a moment before checking stock again.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const cartId = Number(body.cartId);
  if (!Number.isInteger(cartId)) return send(res, 400, { ok: false, error: 'A valid cartId is required.' });

  try {
    const full = await getBuyCartFull(cartId);
    if (!full) return send(res, 404, { ok: false, error: 'That buying request does not exist.' });
    if (!cartVisibleTo(user, full)) return send(res, 403, { ok: false, error: 'You do not have access to this request.' });

    const lines = full.lines || [];
    const styles = [...new Set(lines.map((l) => String(l.sku || '').trim()).filter(Boolean))];
    const used = styles.slice(0, MAX_STYLES);

    // allSettled per style, and the two sources kept independent: a Shopify outage must
    // not cost us the shelf count that came out of our own database, and a style that
    // errors must not blank the other nineteen.
    const configured = shopifyConfigured();
    const readings = await Promise.all(used.map(async (sku) => {
      const [oursR, shopR] = await Promise.allSettled([
        stockOnHandBySizeForSku(sku),
        configured ? shopifyInventoryForSku(sku) : Promise.resolve(null),
      ]);
      return {
        sku,
        ours: oursR.status === 'fulfilled' ? (oursR.value || []) : null,
        shop: shopR.status === 'fulfilled' ? shopR.value : null,
      };
    }));
    const bySku = new Map(readings.map((r) => [r.sku, r]));

    const out = lines.map((l) => {
      const sku = String(l.sku || '').trim();
      const r = bySku.get(sku);
      if (!r) return { lineId: Number(l.id), sku, size: l.size || null, checked: false };

      const ours = r.ours;
      const shop = r.shop;
      // A Shopify figure we could not get is `null`, never 0. "None left" and "we can't
      // see it" are opposite answers, and only one of them justifies buying more.
      const shopOk = !!shop && !shop.error && !shop.permission;
      const shopUnavailable = !configured
        ? 'Shopify is not connected on this server'
        : shop?.permission || (shop?.error ? 'Shopify inventory lookup failed' : (shop ? null : 'Shopify inventory lookup failed'));

      const styleOnHand = (ours || []).reduce((n, x) => n + (Number(x.on_hand) || 0), 0);
      const row = (ours || []).find((x) => key(x.size) === key(l.size)) || null;
      const sizeOurs = row
        ? {
            on_hand: Number(row.on_hand) || 0,
            listed_shopify: Number(row.listed_shopify) || 0,
            not_listed: Number(row.not_listed) || 0,
            no_box: Number(row.no_box) || 0,
            in_store_or_existing: Number(row.off_ph) || 0,
            pre_sell: Number(row.pre_sell) || 0,
            pre_sold: Number(row.pre_sold) || 0,
          }
        : { on_hand: 0, listed_shopify: 0, not_listed: 0, no_box: 0, in_store_or_existing: 0, pre_sell: 0, pre_sold: 0 };

      let shopSize = null;
      if (shopOk) {
        const hit = Object.entries(shop.sizes || {}).find(([label]) => key(label) === key(l.size));
        // An exact-size miss on a live Shopify answer is a real zero: the style was
        // found and this size had nothing sellable on it.
        shopSize = l.size ? (hit ? Number(hit[1]) || 0 : 0) : null;
      }

      // The headline. Shopify's listed figure plus what Shopify cannot see. With
      // Shopify down it falls back to our own records for BOTH halves and says which
      // it is, rather than reporting a half-count as a whole one.
      const weHold = !l.size ? null
        : shopSize != null ? shopSize + sizeOurs.not_listed
          : sizeOurs.on_hand;

      return {
        lineId: Number(l.id),
        sku,
        size: l.size || null,
        checked: true,
        we_hold: weHold,
        basis: !l.size ? 'no_size' : shopSize != null ? 'shopify_plus_unlisted' : 'our_records_only',
        shopify: { qty: shopSize, unavailable: shopUnavailable || null },
        ours: sizeOurs,
        // Pairs OUR records call listed on Shopify that Shopify is no longer showing.
        // Usually sold on a channel and not yet scanned out — worth surfacing, never
        // worth silently adding to the count.
        unscanned_gap: shopSize != null && sizeOurs.listed_shopify > shopSize
          ? sizeOurs.listed_shopify - shopSize : 0,
        style_on_hand: styleOnHand,
        other_sizes: Math.max(0, styleOnHand - sizeOurs.on_hand),
        sizes: (ours || []).map((x) => ({ size: x.size, on_hand: Number(x.on_hand) || 0 })),
      };
    });

    return send(res, 200, {
      ok: true,
      // Said once, for the whole answer, and repeated on screen: this is Shopify's
      // belief plus our own records, not a physical count.
      disclaimer: 'Shopify inventory plus our own unlisted units — not a physical count. For a number to act on, ask the warehouse.',
      truncated: styles.length > used.length
        ? `Only the first ${MAX_STYLES} styles on this request were checked.` : null,
      lines: out,
    });
  } catch (e) {
    return send(res, 500, { ok: false, error: e.message || 'Could not read stock levels.' });
  }
}
