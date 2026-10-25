// GET /api/inbound-issues/get?id= -> { ok, row (with events) }
import { send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { dbConfigured, getInboundIssue } from '../_lib/db.js';
import { VIEW_ROLES, idOf } from './_shared.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, VIEW_ROLES);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const id = idOf(new URL(req.url, 'http://x').searchParams.get('id'));
  if (!id) return send(res, 400, { ok: false, error: 'Which case?' });
  try {
    const row = await getInboundIssue(id);
    if (!row) return send(res, 404, { ok: false, error: `Case #${id} does not exist.` });
    return send(res, 200, { ok: true, row });
  } catch (e) {
    console.error('[inbound-issues/get]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load that case.' });
  }
}
