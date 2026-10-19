// GET /api/cancellations/get?id=N -> { ok, row (with events) }
import { send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { dbConfigured, getCancellation } from '../_lib/db.js';
import { VIEW_ROLES, idOf } from './_shared.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireRole(req, res, VIEW_ROLES)) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const id = idOf(new URL(req.url, 'http://x').searchParams.get('id'));
  if (!id) return send(res, 400, { ok: false, error: 'Which cancellation?' });
  const row = await getCancellation(id).catch(() => null);
  if (!row) return send(res, 404, { ok: false, error: 'That cancellation does not exist.' });
  return send(res, 200, { ok: true, row });
}
