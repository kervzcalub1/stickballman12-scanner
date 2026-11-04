// /api/items/stock-count — a Stock Check count (docs/context/inventory.md "Stock Check").
//   GET                                   -> { ok, count | null, tally, scans }   (resume after a refresh)
//   POST { action:'start', scanId? | sku+size, vinOnly? }  -> { ok, count, tally, scans }
//   POST { action:'undo'|'finish'|'cancel', id }           -> { ok, count, tally, scans }
// The count, its tally and Shopify's number (read HERE, at start and again at finish)
// are all the server's. A count belongs to the person who started it; nobody else can
// scan into it, undo it or finish it.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import {
  dbConfigured, getStockCount, getOpenStockCount, startStockCount, claimScanForCount, getStockScan,
  stockCountTally, stockCountScans, undoLastStockCountScan, finishStockCount, cancelStockCount,
} from '../_lib/db.js';
import { readShopify } from '../_lib/stock-check.js';
import { shopifyForSize } from '../../src/lib/stockCheck.js';

async function shopifyQty(sku, size) {
  try {
    const s = await readShopify(sku);
    return s.error ? { qty: null, error: s.error } : { qty: shopifyForSize(s.products, size).qty, checkedAt: s.checkedAt };
  } catch (e) { return { qty: null, error: e.message }; }
}
const out = async (count, extra = {}) => ({
  ok: true, count, ...(count ? { tally: await stockCountTally(count.id), scans: await stockCountScans(count.id) } : { tally: null, scans: [] }), ...extra,
});

export default async function handler(req, res) {
  applySecurity(req, res);
  const user = requireRole(req, res, ['warehouse', 'ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 })) return send(res, 429, { ok: false, error: 'Please wait a moment.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const username = user.username || String(user.uid || '');

  try {
    if (req.method === 'GET') return send(res, 200, await out(await getOpenStockCount(username)));
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
    const body = await getJsonBody(req);

    if (body.action === 'start') {
      let sku = String(body.sku || '').trim().toUpperCase();
      let size = String(body.size || '').trim();
      let name = body.name ? String(body.name).slice(0, 200) : null;
      // Started from a scan: the shoe and size are the SCAN's, as the server recorded it.
      const first = body.scanId != null ? await getStockScan(Number(body.scanId)) : null;
      if (body.scanId != null) {
        if (!first || first.username !== username) return send(res, 404, { ok: false, error: 'That scan isn’t yours.' });
        sku = first.sku; size = first.size; name = first.name;
      }
      if (!sku || !size) return send(res, 400, { ok: false, error: 'Pick a shoe and a size to count.' });
      const sh = await shopifyQty(sku, size);
      const count = await startStockCount({ username, userName: user.name || null, sku, size, name, vinOnly: !!body.vinOnly, expected: sh.qty });
      // The box in hand is #1 — when it's a pair (box or VIN), and allowed in this count.
      const pairScan = first && (first.kind === 'upc' || (first.kind === 'vin' && first.vin));
      if (pairScan && !(count.vin_only && first.kind !== 'vin')) await claimScanForCount(first.id, count.id, username);
      return send(res, 200, await out(count, { shopifyError: sh.error || null }));
    }

    const count = await getStockCount(Number(body.id));
    if (!count || count.username !== username) return send(res, 404, { ok: false, error: 'That count isn’t yours, or is gone.' });
    if (count.status !== 'open') return send(res, 409, { ok: false, error: 'That count is already closed.', count });

    if (body.action === 'undo') { await undoLastStockCountScan(count.id); return send(res, 200, await out(count)); }
    if (body.action === 'cancel') return send(res, 200, await out(await cancelStockCount(count.id)));
    if (body.action === 'finish') {
      // Compared with Shopify as it is NOW; when unreadable, with the number read at the start.
      const sh = await shopifyQty(count.sku, count.size);
      const done = await finishStockCount(count.id, { expectedEnd: sh.qty ?? count.expected_start });
      if (!done) return send(res, 409, { ok: false, error: 'That count is already closed.' });
      return send(res, 200, await out(done, { shopifyError: sh.error || null, checkedAt: sh.checkedAt || null }));
    }
    return send(res, 400, { ok: false, error: 'Unknown action.' });
  } catch (e) {
    console.error('[items/stock-count]', e.message);
    return send(res, 500, { ok: false, error: 'The count could not be updated.' });
  }
}
