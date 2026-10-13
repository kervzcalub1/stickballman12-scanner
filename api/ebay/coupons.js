// GET  /api/ebay/coupons            -> { ok, coupons, log, canMarket }   coded coupons on the account
// POST /api/ebay/coupons { action:'create', coupon:{…form…} }            -> { ok, promotionId }
// POST /api/ebay/coupons { action:'pause'|'resume'|'delete', promotionId } -> { ok }
// eBay coded coupons (docs/context/ebay-coupons.md). PH + admin. eBay holds the coupons —
// we keep no copy, only a log of who did what (ebay_coupon_log). The form is checked by
// the same rules the page uses (src/lib/ebayCoupons.js); the photo is taken from the
// first picked listing that has one, read from OUR pull rather than from the browser.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { dbConfigured, ebayListingSizes, logEbayCoupon, recentEbayCouponLog } from '../_lib/db.js';
import { ebayConfigured, ebayStatus, listEbayCoupons, createEbayCoupon, ebayCouponAction } from '../_lib/ebay.js';
import { buildCoupon } from '../../src/lib/ebayCoupons.js';
import { estToday } from '../../src/lib/format.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  const user = requireRole(req, res, ['ph_team']);   // admin/superadmin auto-allowed
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 30 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  if (!ebayConfigured()) return send(res, 503, { ok: false, error: 'eBay isn’t set up on this server.' });
  const by = user.name || user.username || '';

  if (req.method === 'GET') {
    const st = await ebayStatus();
    const log = await recentEbayCouponLog();
    if (!st.connected) return send(res, 200, { ok: true, coupons: [], log, canMarket: false });
    try {
      return send(res, 200, { ok: true, coupons: await listEbayCoupons(), log, canMarket: st.canMarket });
    } catch (e) {
      return send(res, 200, { ok: true, coupons: null, log, canMarket: st.canMarket, error: e.message, needsReconnect: !!e.auth || !!e.notConnected });
    }
  }
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });

  const b = await getJsonBody(req);
  if (b.action === 'create') {
    const f = b.coupon || {};
    const ids = (Array.isArray(f.listingIds) ? f.listingIds : []).map((x) => String(x).replace(/[^0-9]/g, '')).filter(Boolean);
    const rows = await ebayListingSizes(ids.map((id) => ({ item_id: id })));
    const inPull = new Set(rows.map((r) => r.item_id));
    const missing = ids.filter((id) => !inPull.has(id));
    if (missing.length) return send(res, 400, { ok: false, error: `${missing.length} picked listing${missing.length === 1 ? ' isn’t' : 's aren’t'} in the last pull (ended?) — pull again.` });
    const byId = new Map(rows.map((r) => [r.item_id, r]));
    const imageUrl = ids.map((id) => byId.get(id)?.image_url).find(Boolean) || null;
    const built = buildCoupon({ ...f, listingIds: ids, imageUrl, todayYmd: estToday() }, new Date());
    if (built.error) return send(res, 400, { ok: false, error: built.error });
    const p = built.payload;
    try {
      const promotionId = await createEbayCoupon(p);
      await logEbayCoupon({ promotionId, action: 'create', code: p.couponConfiguration.couponCode, name: p.name, detail: p, ok: true, by });
      return send(res, 200, { ok: true, promotionId });
    } catch (e) {
      await logEbayCoupon({ action: 'create', code: p.couponConfiguration.couponCode, name: p.name, detail: p, ok: false, error: e.message, by });
      return send(res, e.auth || e.notConnected ? 409 : 502, { ok: false, error: e.message, needsReconnect: !!e.auth || !!e.notConnected });
    }
  }
  if (['pause', 'resume', 'delete'].includes(b.action)) {
    const id = String(b.promotionId || '').trim();
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) return send(res, 400, { ok: false, error: 'Which coupon?' });
    try {
      await ebayCouponAction(id, b.action);
      await logEbayCoupon({ promotionId: id, action: b.action, code: b.code, name: b.name, ok: true, by });
      return send(res, 200, { ok: true });
    } catch (e) {
      await logEbayCoupon({ promotionId: id, action: b.action, code: b.code, name: b.name, ok: false, error: e.message, by });
      return send(res, e.auth || e.notConnected ? 409 : 502, { ok: false, error: e.message, needsReconnect: !!e.auth || !!e.notConnected });
    }
  }
  return send(res, 400, { ok: false, error: 'Unknown action.' });
}
