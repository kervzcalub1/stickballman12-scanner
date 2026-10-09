// GET /api/ebay/status -> { ok, configured, missing, secrets, sandbox, connected, user,
//   connectedBy, connectedAt, refreshExpiresAt, pull }   (docs/context/ebay-listings.md)
// PH + admin. Never returns a token — only whether there is one and until when.
import { send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { dbConfigured } from '../_lib/db.js';
import { ebayStatus } from '../_lib/ebay.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['ph_team']);   // admin/superadmin auto-allowed
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  return send(res, 200, { ok: true, ...(await ebayStatus()) });
}
