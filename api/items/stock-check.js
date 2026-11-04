// POST /api/items/stock-check  { code, size?, countId?, via?, recheck? }
//   -> { ok, kind, code, shoe, pair, sticker, shopify, unknown?, scan: { id, counted, note }, tally? }
//
// Stock Check (docs/context/inventory.md): one scan, one answer — and every scan is
// RECORDED here, under the person who made it (My Scans reads them back).
//   VIN  -> the pair's own record (in inventory or not, and why) + Shopify for its size.
//   UPC  -> which shoe and size the box is (the receiving resolver) + Shopify.
//   SKU  -> Shopify for every size (`size` narrows it).
// With `countId` the scan belongs to a count: no Shopify read, and THIS endpoint decides
// whether it counts (same shoe + size, a pair not already counted, VIN-only respected).
// The browser never says what was counted. `recheck` = "Check again": answered, not logged.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { dbConfigured, getStockCount, recordStockScan, stockCountTally } from '../_lib/db.js';
import { readShopify, resolveStockCode, verdictWord, cleanVia } from '../_lib/stock-check.js';

// A plain check still answers when its history row can't be written (e.g. before db:setup
// created the table) — the answer is the point; the history is the record of it.
async function recordQuietly(row) {
  try { return await recordStockScan(row); } catch (e) { console.error('[items/stock-check] history not recorded:', e.message); return null; }
}
import { shopifyForSize, countDecision } from '../../src/lib/stockCheck.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse', 'ph_team']);   // admin auto-allowed
  if (!user) return;
  // A count is a scan a second for a few minutes — mostly without the Shopify read.
  if (!rateLimit(req, { windowMs: 60_000, max: 240 }))
    return send(res, 429, { ok: false, error: 'Too many scans at once — wait a moment.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const code = String(body.code || '').trim().slice(0, 80);
  if (!code) return send(res, 400, { ok: false, error: 'Scan a box or a VIN, or type a SKU.' });
  const username = user.username || String(user.uid || '');
  const who = { username, userName: user.name || null };
  const via = cleanVia(body.via);

  try {
    // ---- a scan inside a count ----
    if (body.countId != null) {
      const count = await getStockCount(Number(body.countId));
      if (!count || count.username !== username) return send(res, 404, { ok: false, error: 'That count isn’t yours, or is gone.' });
      if (count.status !== 'open') return send(res, 409, { ok: false, error: 'That count is already closed.' });
      const r = await resolveStockCode(code);
      const d = countDecision(count, r);
      const scan = await recordStockScan({
        ...who, countId: count.id, code, kind: r.kind, via, sku: r.shoe?.sku, size: r.shoe?.size, name: r.shoe?.name,
        vin: r.pair?.vin, itemStatus: r.pair?.status, verdict: verdictWord(r), counted: d.counted,
        note: [d.note, via === 'typed' ? 'typed by hand' : null].filter(Boolean).join(' · ') || null,
      });
      const tally = await stockCountTally(count.id);
      return send(res, 200, { ok: true, kind: r.kind, code, shoe: r.shoe, pair: r.pair,
        scan: { id: Number(scan.id), counted: scan.counted, note: scan.note }, tally });
    }

    // ---- a plain check ----
    const r = await resolveStockCode(code, body.size);
    const { kind, shoe, pair, sticker } = r;
    if (!shoe?.sku) {
      const scan = body.recheck ? null : await recordQuietly({ ...who, code, kind, via, vin: pair?.vin, verdict: verdictWord(r) });
      return send(res, 200, { ok: true, kind, code, shoe: null, pair, sticker, shopify: null, unknown: !pair && !sticker,
        scan: scan ? { id: Number(scan.id) } : null });
    }
    const shopify = await readShopify(shoe.sku);
    // A typed SKU has no name of its own — take the listing's.
    if (!shoe.name && shopify.products?.length) shoe.name = shopify.products[0].title || null;
    const qty = shoe.size && !shopify.error ? shopifyForSize(shopify.products, shoe.size).qty : null;
    const scan = body.recheck ? null : await recordQuietly({
      ...who, code, kind, via, sku: shoe.sku, size: shoe.size, name: shoe.name, vin: pair?.vin,
      itemStatus: pair?.status, verdict: verdictWord(r), shopifyQty: qty,
    });
    return send(res, 200, { ok: true, kind, code, shoe, pair, sticker, shopify, scan: scan ? { id: Number(scan.id) } : null });
  } catch (e) {
    console.error('[items/stock-check]', e.message);
    return send(res, 500, { ok: false, error: 'The check failed — scan again.' });
  }
}
