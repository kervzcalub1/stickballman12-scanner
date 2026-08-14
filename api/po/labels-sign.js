// POST /api/po/labels-sign  (ph_team / admin)  { poId, contentType? }
// Presigned PUT for the courier's labels PDF, so the file goes straight from the browser
// to R2 and the Node server never handles the bytes (same shape as photo uploads).
// The key is derived server-side from the PO id — a client-chosen key could overwrite
// another order's labels.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { getPo, dbConfigured } from '../_lib/db.js';
import { presignPutUrl, r2Configured } from '../_lib/r2.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 30 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  if (!r2Configured()) return send(res, 503, { ok: false, error: 'File storage is not configured.' });

  const body = await getJsonBody(req);
  const poId = Number(body.poId);
  if (!Number.isInteger(poId)) return send(res, 400, { ok: false, error: 'A valid poId is required.' });

  try {
    const po = await getPo(poId);
    if (!po) return send(res, 404, { ok: false, error: 'Purchase order not found.' });
    // Timestamped so re-uploading a corrected sheet can't collide with the old object
    // while a download is mid-flight; the previous key is deleted by labels-attach.
    const key = `po-labels/${po.po_code}-${Date.now()}.pdf`;
    return send(res, 200, { ok: true, key, url: presignPutUrl({ key, expiresIn: 300 }) });
  } catch (e) {
    console.error('[po/labels-sign]', e.message);
    return send(res, 500, { ok: false, error: 'Could not prepare the upload.' });
  }
}
