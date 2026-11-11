// GET /api/shein/orders?from=YYYY-MM-DD&to=YYYY-MM-DD -> { ok, units, from, to, sync }
//   every SHEIN pair sold in that EST range (default: the last 30 days) plus every pair still
//   waiting to go (new / to ship / pick-up, last 60 days), each with Shopify's name, style code and
//   size for its seller SKU. Read-only, from what the sales sync already recorded in
//   shein_order_units: no SHEIN call per view. The page groups them into orders (src/lib/pickList.js)
//   and builds the pick list PDF in the browser. PH + admin.
//   docs/context/shein-live-fix.md → "Orders + pick list"
import { send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { dbConfigured, listSheinOrderUnits } from '../_lib/db.js';
import { readSync } from '../_lib/shein-orders.js';
import { estDayStart } from '../../src/lib/ebayCoupons.js';
import { estToday } from '../../src/lib/format.js';

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };

export default async function handler(req, res) {
  applySecurity(req, res);
  const user = requireRole(req, res, ['ph_team']);   // admin/superadmin auto-allowed
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const q = new URL(req.url, 'http://x').searchParams;
  const today = estToday();
  const fromYmd = YMD.test(q.get('from') || '') ? q.get('from') : addDays(today, -30);
  const toYmd = YMD.test(q.get('to') || '') ? q.get('to') : today;
  const units = await listSheinOrderUnits(estDayStart(fromYmd).toISOString(), estDayStart(addDays(toYmd, 1)).toISOString());
  const sync = await readSync();
  return send(res, 200, { ok: true, units, from: fromYmd, to: toYmd, sync: { orders: sync.orders || 'off', polledAt: sync.polledAt || null, since: sync.since || null } });
}
