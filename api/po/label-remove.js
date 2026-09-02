// POST /api/po/label-remove  (ph_team / admin)  { boxId, confirm }
// Deletes a label that shouldn't be on the order — entered twice, or a box the supplier
// cancelled. Its manifest lines go with it: that list described a box that no longer
// exists. `confirm` is the label's own number typed back, because there is no undo.
//
// A label with stock already counted into it is NEVER deleted — it can only be moved to
// another order (POST /api/po/label-move). The record of what physically arrived has to
// outlive any tidying up of the paperwork, so the refusal names the move as the way out
// rather than leaving the caller stuck.
import { getJsonBody, send, applySecurity, rateLimit, requireRole, isPrivileged } from '../_lib/util.js';
import { getPoBox, getPo, removePoBox, syncExpectedBoxes, addPoComment, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  // A supplier can delete a box off their OWN order while it hasn't shipped — they packed
  // it, and a box declared by mistake shouldn't need us to remove it. Everything that
  // makes removal dangerous (stock counted into it, a settled order) is checked below and
  // applies to them the same way.
  const user = requireRole(req, res, ['ph_team', 'supplier']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 30 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const boxId = Number(body.boxId);
  const confirm = String(body.confirm ?? '').trim();
  if (!Number.isInteger(boxId)) return send(res, 400, { ok: false, error: 'A valid boxId is required.' });

  try {
    const box = await getPoBox(boxId);
    if (!box) return send(res, 404, { ok: false, error: 'That label no longer exists.' });
    const po = await getPo(box.po_id);
    // Checked server-side as well as in the dialog: the typed number is the confirmation,
    // not a UI formality.
    const bySupplier = user.role === 'supplier' && !isPrivileged(user.role);
    if (bySupplier) {
      const po = await getPo(box.po_id);
      if (!po || Number(po.supplier_user_id) !== Number(user.uid))
        return send(res, 403, { ok: false, error: 'You do not have access to this order.' });
      // "As long as the box is not yet shipped." Once the carrier has it, the box is a
      // record of something that physically left, and the count is no longer theirs alone.
      if (!['pending', 'packed', 'pre_transit'].includes(box.status))
        return send(res, 409, { ok: false, error: `Box ${box.box_number} is already on its way — it can’t be removed. Tell us and we’ll sort it out.` });
    }
    if (confirm !== String(box.box_number)) {
      return send(res, 400, { ok: false, error: `Type ${box.box_number} exactly to confirm removing this label.` });
    }
    const r = await removePoBox(boxId);
    if (r.error) return send(res, 409, { ok: false, error: r.error, mustMove: r.mustMove === true, received: r.received ?? 0 });
    await syncExpectedBoxes(box.po_id);
    await addPoComment({
      poId: box.po_id, kind: 'system',
      body: `Label ${box.box_number} (${box.tracking_number || 'no tracking #'}) removed`
        + (r.linesRemoved ? `, with the ${r.linesRemoved} line(s) declared for it.` : '.'),
      author: { id: Number(user.uid) || null, name: user.name || user.username || '', role: user.role },
    }).catch((e) => console.warn('[po/label-remove] system comment:', e.message));
    console.log(`[po/label-remove] ${po?.po_code} label ${box.box_number} removed by ${user.username || user.uid}`);
    return send(res, 200, { ok: true, boxNumber: box.box_number, linesRemoved: r.linesRemoved });
  } catch (e) {
    console.error('[po/label-remove]', e.message);
    return send(res, 500, { ok: false, error: 'Could not remove the label.' });
  }
}
