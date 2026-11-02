// POST /api/stockx/lock { listingIds:[…], lock: true|false, note? } -> { ok, count }
// 🔒 KEEP PRICE on StockX listings (docs/context/stockx-reprice.md): no reprice run touches
// them — the server checks on every run. ≤ 1,000 a call. PH + admin.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { dbConfigured, setStockxLocks, clearStockxLocks } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const b = await getJsonBody(req);
  const ids = [...new Set((Array.isArray(b.listingIds) ? b.listingIds : []).map((x) => String(x ?? '').trim().slice(0, 64)).filter(Boolean))];
  if (!ids.length) return send(res, 400, { ok: false, error: 'Which listings?' });
  if (ids.length > 1000) return send(res, 400, { ok: false, error: 'At most 1,000 listings at a time.' });
  try {
    const count = b.lock === false
      ? await clearStockxLocks(ids)
      : await setStockxLocks(ids, { note: String(b.note ?? '').trim().slice(0, 300) || null, by: user.name || user.username || null });
    return send(res, 200, { ok: true, count });
  } catch (e) {
    console.error('[stockx/lock]', e.message);
    return send(res, 500, { ok: false, error: 'Could not save the locks.' });
  }
}
