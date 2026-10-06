// POST /api/receipts/assign { id, userId|null } -> { ok }
// Say who bought it, when no registered purchase email matched (or matched wrongly).
// Admin only — it decides whose spend a receipt counts as (docs/context/receipts.md).
import { getJsonBody, send, applySecurity, rateLimit, requireAdmin } from '../_lib/util.js';
import { dbConfigured, assignEmailReceipt } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireAdmin(req, res);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const b = await getJsonBody(req);
  const id = Number(b.id);
  const userId = b.userId == null || b.userId === '' ? null : Number(b.userId);
  if (!Number.isSafeInteger(id) || id <= 0 || (userId !== null && (!Number.isSafeInteger(userId) || userId <= 0)))
    return send(res, 400, { ok: false, error: 'Which receipt, and whose?' });
  try {
    const row = await assignEmailReceipt(id, userId, user.name || user.username || null);
    if (!row) return send(res, 404, { ok: false, error: 'That receipt no longer exists.' });
    return send(res, 200, { ok: true });
  } catch (e) {
    if (/foreign key/i.test(e.message)) return send(res, 400, { ok: false, error: 'That account no longer exists.' });
    console.error('[receipts/assign]', e.message);
    return send(res, 500, { ok: false, error: 'Could not save.' });
  }
}
