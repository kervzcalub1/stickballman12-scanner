// GET /api/shein/status -> { ok, configured, missing, connected, … }   never a key
// PH + admin. docs/context/shein-fix.md → "SHEIN API".
import { send, applySecurity, requireRole } from '../_lib/util.js';
import { sheinStatus } from '../_lib/shein.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['ph_team']);
  if (!user) return;
  return send(res, 200, { ok: true, ...(await sheinStatus()) });
}
