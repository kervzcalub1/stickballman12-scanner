// GET  /api/ebay/orders?from=YYYY-MM-DD&to=YYYY-MM-DD -> { ok, orders, sync, canOrders }
//   orders created in that EST range (default: the last 30 days) plus every one still not
//   shipped; each line with its photo, each tracking number with the carrier's word (17TRACK).
// POST /api/ebay/orders { from? } -> { ok, started }   sync in the background (from = backfill)
// PH + admin. docs/context/ebay-orders.md
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { dbConfigured, listEbayOrders, ebayItemImages, trackingStatusFor } from '../_lib/db.js';
import { ebayConfigured, ebayStatus } from '../_lib/ebay.js';
import { runEbayOrdersSync, readSync, syncRunning } from '../_lib/ebay-orders-sync.js';
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
  if (!ebayConfigured()) return send(res, 503, { ok: false, error: 'eBay isn’t set up on this server.' });

  if (req.method === 'GET') {
    const q = new URL(req.url, 'http://x').searchParams;
    const today = estToday();
    const fromYmd = YMD.test(q.get('from') || '') ? q.get('from') : addDays(today, -30);
    const toYmd = YMD.test(q.get('to') || '') ? q.get('to') : today;
    const rows = await listEbayOrders(estDayStart(fromYmd).toISOString(), estDayStart(addDays(toYmd, 1)).toISOString());
    const images = await ebayItemImages(rows.flatMap((o) => (o.lines || []).map((l) => l.item_id)));
    const track = await trackingStatusFor(rows.flatMap((o) => (o.fulfillments || []).map((f) => f.number)));
    const key = (n) => String(n || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const orders = rows.map((o) => ({
      ...o,
      lines: (o.lines || []).map((l) => ({ ...l, image_url: images.get(String(l.item_id)) || null })),
      fulfillments: (o.fulfillments || []).map((f) => {
        const t = track.get(key(f.number));
        return { ...f, status: t?.tracking_status || null, detail: t?.tracking_sub_status_descr || t?.last_checkpoint || null, checked_at: t?.checked_at || null };
      }),
    }));
    const st = await ebayStatus();
    return send(res, 200, { ok: true, orders, from: fromYmd, to: toYmd, sync: await readSync(), canOrders: st.canOrders, connected: st.connected });
  }
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const b = await getJsonBody(req);
  const s = await readSync();
  if (syncRunning(s)) return send(res, 409, { ok: false, error: `${s.by || 'Someone'} is syncing eBay orders right now.` });
  const fromYmd = YMD.test(String(b.from || '')) ? b.from : null;
  runEbayOrdersSync({ by: user.name || user.username || '', fromYmd });
  return send(res, 200, { ok: true, started: true });
}
