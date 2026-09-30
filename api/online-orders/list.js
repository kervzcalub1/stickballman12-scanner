// GET /api/online-orders/list?q=&view=all|expected|ordered|followup|cancelled
//   -> { ok, orders:[…shapeOrder], counts:{ needs_request, requested, expected } }
// Online orders — shoes the PH team bought from an online store (its own list, not a PO).
// PH records them; the WAREHOUSE reads the same list to know what is on its way
// ("expected") and counts each parcel in. Read-only.
import { send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { dbConfigured, listOnlineOrders, onlineOrderCounts } from '../_lib/db.js';
import { shapeOrder } from './_shared.js';

const VIEWS = ['all', 'expected', 'ordered', 'followup', 'cancelled'];

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['ph_team', 'warehouse']); // admin/superadmin auto-allowed
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const params = new URL(req.url, 'http://x').searchParams;
  const q = String(params.get('q') || '').trim().slice(0, 80);
  const view = VIEWS.includes(params.get('view')) ? params.get('view') : 'all';
  try {
    const [rows, counts] = await Promise.all([listOnlineOrders({ q, view }), onlineOrderCounts()]);
    return send(res, 200, { ok: true, orders: rows.map(shapeOrder), counts });
  } catch (e) {
    console.error('[online-orders/list]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load online orders.' });
  }
}
