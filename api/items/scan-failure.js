// POST /api/items/scan-failure  { code, reason, detail?, screen? }  -> { ok }
//
// Records a scan that did not land. Fire-and-forget from the client: nothing about this
// endpoint may slow down or block a scan, because it exists to explain scans that are
// already going wrong.
//
// Why it exists: the reason a scan failed used to live only in the scanner's browser
// tab. When the floor reported that scan-out "kept failing", there was no record to
// look at — the answer had to be reconstructed from a phone video. One row per failure
// makes that a query.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { recordScanFailure, dbConfigured } from '../_lib/db.js';

const REASONS = ['not_a_vin', 'not_found', 'available', 'assigned', 'assigned_gone', 'void', 'unknown', 'duplicate', 'already_done'];

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse', 'ph_team']);
  if (!user) return;
  // A scan gun in a bad state can fire fast; the ceiling is high enough never to be the
  // thing that breaks a real run, and low enough to bound a stuck loop.
  if (!rateLimit(req, { windowMs: 60_000, max: 600 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const code = String(body.code ?? '').trim().slice(0, 120);
  const reason = REASONS.includes(body.reason) ? body.reason : 'not_found';
  if (!code) return send(res, 400, { ok: false, error: 'Nothing to record.' });

  try {
    await recordScanFailure({
      code, reason,
      detail: String(body.detail ?? '').slice(0, 300) || null,
      screen: String(body.screen ?? '').slice(0, 40) || null,
      userName: user.name || user.username || null,
    });
    return send(res, 200, { ok: true });
  } catch (e) {
    console.error('[items/scan-failure]', e.message);
    // Still 200: the caller is mid-scan and must not be told the audit trail is broken.
    return send(res, 200, { ok: false });
  }
}
