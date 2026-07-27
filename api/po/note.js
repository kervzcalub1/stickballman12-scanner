// POST /api/po/note  (warehouse / ph_team / admin)  { poId, note }
// Saves the PO's reconciliation note — the "why" behind the outcome (what the supplier
// said about a shortage, what got credited, why it was closed out). One editable field
// per PO, writable at ANY status: the resolution usually lands days after the count did,
// often once the PO is already reconciled or archived.
// The supplier sees this READ-ONLY in their portal, so it doubles as the message to them
// — but never with the author's name (po/get strips the byline for suppliers).
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { getPo, setPoReconcileNote, RECONCILE_NOTE_MAX, dbConfigured } from '../_lib/db.js';

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
  if (typeof body.note !== 'string' && body.note != null)
    return send(res, 400, { ok: false, error: 'The note must be text.' });
  if (String(body.note ?? '').length > RECONCILE_NOTE_MAX)
    return send(res, 400, { ok: false, error: `The note is too long (max ${RECONCILE_NOTE_MAX} characters).` });

  try {
    const po = await getPo(poId);
    if (!po) return send(res, 404, { ok: false, error: 'Purchase order not found.' });
    const saved = await setPoReconcileNote(poId, body.note, user.name || user.username || '');
    return send(res, 200, { ok: true, ...saved });
  } catch (e) {
    console.error('[po/note]', e.message);
    return send(res, 500, { ok: false, error: 'Could not save the note.' });
  }
}
