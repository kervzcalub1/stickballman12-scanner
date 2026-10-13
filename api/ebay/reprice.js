// POST /api/ebay/reprice { changes:[{ itemId, variationKey, price, marketCents?, markupPct? }], allowBig? } (≤ 20)
//   -> { ok, results:[{ itemId, variationKey, ok, skipped?, error?, price? }], needsReconnect? }
// GET  /api/ebay/reprice -> { ok, edits }   the log of prices sent from here
// Reprice eBay sizes through the API (docs/context/ebay-api-reprice.md). PH + admin.
// Each size must be in the last pull, a fixed-price listing, and — for a multi-size
// listing — have a Custom label (eBay can't address a variation without one). A move of
// more than half the price either way is refused unless the person ticked "big swings"
// (usually a wrong style code pricing the shoe off another shoe). Price only, never qty.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { dbConfigured, ebayListingSizes, logEbayPriceEdits, setEbayListingPrices, recentEbayPriceEdits } from '../_lib/db.js';
import { ebayConfigured, reviseEbayPrices } from '../_lib/ebay.js';
import { BIG_SWING } from '../../src/lib/shopifyListings.js';

const MAX = 20;

export default async function handler(req, res) {
  applySecurity(req, res);
  const user = requireRole(req, res, ['ph_team']);   // admin/superadmin auto-allowed
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  if (req.method === 'GET') return send(res, 200, { ok: true, edits: await recentEbayPriceEdits() });
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!ebayConfigured()) return send(res, 503, { ok: false, error: 'eBay isn’t set up on this server.' });

  const b = await getJsonBody(req);
  const changes = (Array.isArray(b.changes) ? b.changes : []).map((c) => ({
    itemId: String(c?.itemId ?? '').replace(/[^0-9]/g, ''),
    variationKey: String(c?.variationKey ?? ''),
    price: Math.round(Number(c?.price) * 100) / 100,
    marketCents: Number.isInteger(c?.marketCents) ? c.marketCents : null,
    markupPct: Number.isFinite(Number(c?.markupPct)) ? Number(c.markupPct) : null,
  })).filter((c) => c.itemId);
  if (!changes.length) return send(res, 400, { ok: false, error: 'Which sizes?' });
  if (changes.length > MAX) return send(res, 400, { ok: false, error: `At most ${MAX} at a time.` });

  const known = new Map((await ebayListingSizes(changes.map((c) => ({ item_id: c.itemId }))))
    .map((r) => [`${r.item_id}|${r.variation_key}`, r]));
  const results = [];
  const send_ = [];
  for (const c of changes) {
    const key = `${c.itemId}|${c.variationKey}`;
    const row = known.get(key);
    const skip = (error) => results.push({ itemId: c.itemId, variationKey: c.variationKey, ok: false, skipped: true, error });
    if (!row) { skip('Not in the last pull — pull again.'); continue; }
    if (!Number.isFinite(c.price) || c.price < 1 || c.price > 100000) { skip('Price must be $1–$100,000.'); continue; }
    if (row.listing_type && row.listing_type !== 'FixedPriceItem') { skip(`Not a fixed-price listing (${row.listing_type}).`); continue; }
    if (row.variation_key && !row.sku) { skip('This size has no Custom label on eBay, so eBay can’t be told which size to reprice.'); continue; }
    const old = row.price == null ? null : Number(row.price);
    if (old === c.price) { results.push({ itemId: c.itemId, variationKey: c.variationKey, ok: true, same: true, price: c.price }); continue; }
    if (!b.allowBig && old > 0 && Math.abs(c.price - old) / old > BIG_SWING) { skip(`A move from $${old} to $${c.price} is more than ${BIG_SWING * 100}% — tick “Include big swings” if it’s right.`); continue; }
    send_.push({ key, itemId: c.itemId, sku: row.variation_key ? row.sku : null, price: c.price, c, row, old });
  }

  const answers = new Map((await reviseEbayPrices(send_)).map((a) => [a.key, a]));
  const log = [];
  const done = [];
  let needsReconnect = false;
  for (const s of send_) {
    const a = answers.get(s.key) || { ok: false, error: 'No answer from eBay.' };
    if (a.auth) needsReconnect = true;
    log.push({ item_id: s.itemId, variation_key: s.row.variation_key, sku: s.row.sku, size: s.row.size, title: s.row.title,
      old_price: s.old, new_price: s.price, market_cents: s.c.marketCents, markup_pct: s.c.markupPct, ok: a.ok, error: a.error || null });
    if (a.ok) done.push({ item_id: s.itemId, variation_key: s.row.variation_key, price: s.price });
    results.push({ itemId: s.itemId, variationKey: s.row.variation_key, ok: a.ok, error: a.error, price: a.ok ? s.price : undefined });
  }
  await logEbayPriceEdits(log, user.name || user.username || '');
  await setEbayListingPrices(done);
  return send(res, 200, { ok: true, results, needsReconnect });
}
