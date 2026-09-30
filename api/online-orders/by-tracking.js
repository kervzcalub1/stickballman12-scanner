// GET /api/online-orders/by-tracking?t=<tracking> -> { ok, order|null }
// Receive New asks this when a tracking number is typed or scanned: is this parcel an
// online order? If so the screen says what it should hold, and each pair's cost comes
// from the order's ACTUAL cost for that SKU + size (docs/context/online-orders.md).
// Spaces / case ignored. The newest order wins if two share a number. Read-only.
import { send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { dbConfigured, onlineOrderByTracking, getOnlineOrder } from '../_lib/db.js';
import { shapeOrder } from './_shared.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse', 'ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const t = String(new URL(req.url, 'http://x').searchParams.get('t') || '').trim().slice(0, 60);
  if (t.replace(/\s+/g, '').length < 8) return send(res, 200, { ok: true, order: null });
  try {
    const hit = await onlineOrderByTracking(t, null);
    if (!hit) return send(res, 200, { ok: true, order: null });
    return send(res, 200, { ok: true, order: shapeOrder(await getOnlineOrder(Number(hit.id))) });
  } catch (e) {
    // Before db:setup has created the table: no online orders, not a broken receive.
    if (/online_orders/.test(e.message)) return send(res, 200, { ok: true, order: null });
    console.error('[online-orders/by-tracking]', e.message);
    return send(res, 500, { ok: false, error: 'Could not look that tracking number up.' });
  }
}
