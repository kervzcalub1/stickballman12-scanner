// POST /api/po/comment  (warehouse / ph_team / admin)  { poId, body }
// Appends one entry to the PO's INTERNAL resolution thread — coordination between
// warehouse and PH while a discrepancy is being chased ("Andrew's not answering",
// "still no credit on the invoice").
// Internal by design: the supplier reads the single reconciliation note (po/note), which
// is written on purpose for them. A supplier-readable thread would either suppress that
// frankness or leak it. The `audience` column exists so that can change later without a
// migration — but nothing here writes anything other than 'internal'.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { getPo, addPoComment, COMMENT_MAX, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse', 'ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const poId = Number(body.poId);
  if (!Number.isInteger(poId)) return send(res, 400, { ok: false, error: 'A valid poId is required.' });
  const text = String(body.body ?? '').trim();
  if (!text) return send(res, 400, { ok: false, error: 'Write something before posting.' });
  if (text.length > COMMENT_MAX)
    return send(res, 400, { ok: false, error: `That's too long (max ${COMMENT_MAX} characters).` });

  try {
    const po = await getPo(poId);
    if (!po) return send(res, 404, { ok: false, error: 'Purchase order not found.' });
    const comment = await addPoComment({
      poId, body: text,
      author: { id: Number(user.uid) || null, name: user.name || user.username || '', role: user.role },
    });
    return send(res, 200, { ok: true, comment });
  } catch (e) {
    console.error('[po/comment]', e.message);
    return send(res, 500, { ok: false, error: 'Could not post the comment.' });
  }
}
