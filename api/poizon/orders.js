// GET  /api/poizon/orders?from=YYYY-MM-DD&to=YYYY-MM-DD -> { ok, orders, from, to, sync, configured, auto }
//   POIZON orders sold in that EST range (default: the last 30 days) plus every one still to ship
//   (last 60 days). Read from poizon_orders, the copy the sync keeps of Shopify's POIZON orders:
//   no Shopify call per view. The page builds the pick list PDF in the browser (src/lib/pickList.js).
// POST /api/poizon/orders -> { ok, started }   read Shopify now, in the background
// PH + admin. docs/context/poizon-orders.md
import { send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { dbConfigured, listPoizonOrders } from '../_lib/db.js';
import { shopifyConfigured } from '../_lib/shopify.js';
import { runPoizonOrdersSync, readSync, syncRunning } from '../_lib/poizon-orders.js';
import { poizonOrdersWorkerEnabled } from '../_lib/poizon-orders-worker.js';
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

  if (req.method === 'GET') {
    const q = new URL(req.url, 'http://x').searchParams;
    const today = estToday();
    const fromYmd = YMD.test(q.get('from') || '') ? q.get('from') : addDays(today, -30);
    const toYmd = YMD.test(q.get('to') || '') ? q.get('to') : today;
    const orders = await listPoizonOrders(estDayStart(fromYmd).toISOString(), estDayStart(addDays(toYmd, 1)).toISOString());
    return send(res, 200, { ok: true, orders, from: fromYmd, to: toYmd, sync: await readSync(), configured: shopifyConfigured(), auto: poizonOrdersWorkerEnabled() });
  }
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!shopifyConfigured()) return send(res, 503, { ok: false, error: 'Shopify isn’t set up on this server.' });
  const s = await readSync();
  if (syncRunning(s)) return send(res, 409, { ok: false, error: `${s.by && s.by !== 'auto' ? s.by : 'The server'} is reading POIZON orders right now.` });
  runPoizonOrdersSync({ by: user.name || user.username || '' }).catch((e) => console.error('[poizon-orders] sync', e.message));
  return send(res, 200, { ok: true, started: true });
}
