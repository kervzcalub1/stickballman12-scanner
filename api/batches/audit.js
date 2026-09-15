// POST /api/batches/audit  { batchId, note? } -> { ok, audit }
// Sign off the audit on a batch that was received WITHOUT a manifest ("Did this package
// come with a manifest?" = No on Step 1). The person signing has confirmed — against the
// tracking number's purchase order, or with the supplier — that everything expected
// arrived. Recorded once, with a name; the flag then stops counting on Home.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { auditBatch, getBatchWithBoxes, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const batchId = Number(body.batchId);
  if (!Number.isInteger(batchId) || batchId <= 0) return send(res, 400, { ok: false, error: 'A valid batchId is required.' });
  const note = String(body.note ?? '').trim().slice(0, 2000) || null;

  try {
    const found = await getBatchWithBoxes(batchId);
    if (!found) return send(res, 404, { ok: false, error: 'Batch not found.' });
    if (found.batch.manifest_received !== false)
      return send(res, 409, { ok: false, error: 'This batch was received with a manifest — there is no audit to sign off.' });
    if (found.batch.audited_at)
      return send(res, 409, { ok: false, error: `Already audited by ${found.batch.audited_by || 'somebody'}.` });
    const audit = await auditBatch(batchId, note, user.name || user.username || null);
    if (!audit) return send(res, 409, { ok: false, error: 'Could not sign off this batch.' });
    return send(res, 200, { ok: true, audit });
  } catch (e) {
    console.error('[batches/audit]', e.message);
    return send(res, 500, { ok: false, error: 'Could not record the audit.' });
  }
}
