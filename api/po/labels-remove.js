// POST /api/po/labels-remove  (ph_team / admin)  { poId, fileId }
// Deletes ONE of the order's labels PDFs. Only the labels that file was serving lose
// their page — each falls back to an older file that also carries it, if there is one
// (removePoLabelFile) — and the object is taken out of the bucket, best-effort.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { removePoLabelFile, dbConfigured } from '../_lib/db.js';
import { deleteObject, r2Configured } from '../_lib/r2.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 30 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const poId = Number(body.poId);
  const fileId = Number(body.fileId);
  if (!Number.isInteger(poId) || !Number.isInteger(fileId))
    return send(res, 400, { ok: false, error: 'A valid poId and fileId are required.' });

  try {
    const r = await removePoLabelFile(poId, fileId);
    if (!r) return send(res, 404, { ok: false, error: 'That labels file is not on this order.' });
    if (r2Configured()) {
      deleteObject(r.key).catch((e) => console.warn('[po/labels-remove] object:', e.message));
    }
    console.log(`[po/labels-remove] file ${fileId} on PO ${poId} removed by ${user.username || user.uid}`);
    return send(res, 200, { ok: true, unmapped: r.unmapped, remapped: r.remapped });
  } catch (e) {
    console.error('[po/labels-remove]', e.message);
    return send(res, 500, { ok: false, error: 'Could not remove the labels file.' });
  }
}
