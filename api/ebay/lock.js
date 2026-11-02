// POST /api/ebay/lock { itemId, lock: true|false, note? } -> { ok, lock }
// 🔒 KEEP PRICE on a whole eBay listing (docs/context/ebay-api-reprice.md "Locks"): the
// exceptions no reprice run may touch, in any direction — e.g. listed at $120 on a $60
// market, held on purpose. `api/ebay/reprice.js` refuses a locked listing whatever the
// screen sends. PH + admin (the same people who reprice).
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { dbConfigured, setEbayPriceLock, clearEbayPriceLock } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['ph_team']);   // admin/superadmin auto-allowed
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const b = await getJsonBody(req);
  const itemId = String(b.itemId ?? '').replace(/[^0-9]/g, '').slice(0, 30);
  if (!itemId) return send(res, 400, { ok: false, error: 'Which listing?' });
  try {
    if (b.lock === false) return send(res, 200, { ok: true, lock: null, unlocked: await clearEbayPriceLock(itemId) });
    const note = String(b.note ?? '').trim().slice(0, 300) || null;
    return send(res, 200, { ok: true, lock: await setEbayPriceLock(itemId, { note, by: user.name || user.username || null }) });
  } catch (e) {
    console.error('[ebay/lock]', e.message);
    return send(res, 500, { ok: false, error: 'Could not save the lock.' });
  }
}
