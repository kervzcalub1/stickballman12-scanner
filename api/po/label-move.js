// POST /api/po/label-move  (ph_team / admin)
//   { boxId, targetPoId }  |  { boxId, newPo: { supplierName?, tagCode?, dateOfPurchase? } }
// Moves a label to another order — an existing one, or a new one raised for it here. This
// is the only way out for a label the warehouse has already counted stock into: deleting
// it would take that record with it, so `label-remove` refuses and points here instead.
//
// The move takes everything that describes the label: its manifest lines AND the box the
// warehouse received against it. Moving the label alone would leave the old order holding
// units nothing claims and the new one reading fully short — worse than not moving it at
// all. See movePoBox in api/_lib/db.js for the two shapes a received box can take.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import {
  getPoBox, getPo, getPoFull, createPo, movePoBox, removePoBox, addPoComment, dbConfigured,
} from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 30 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const boxId = Number(body.boxId);
  if (!Number.isInteger(boxId)) return send(res, 400, { ok: false, error: 'A valid boxId is required.' });

  try {
    const box = await getPoBox(boxId);
    if (!box) return send(res, 404, { ok: false, error: 'That label no longer exists.' });
    const from = await getPo(box.po_id);

    let targetPoId = Number(body.targetPoId);
    let created = null;
    if (!Number.isInteger(targetPoId)) {
      const n = body.newPo;
      if (!n || typeof n !== 'object') {
        return send(res, 400, { ok: false, error: 'Pick an order to move this label to, or give the details for a new one.' });
      }
      // A new order raised for the label inherits the supplier it was bought from — that
      // fact belongs to the parcel, not to the order it was filed under by mistake.
      const supplierName = String(n.supplierName ?? from?.supplier_name ?? '').trim().slice(0, 120);
      if (!supplierName) return send(res, 400, { ok: false, error: 'The new order needs a supplier name.' });
      const rawDate = String(n.dateOfPurchase ?? '').trim();
      const madeOn = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate
        : (from?.date_of_purchase ? String(from.date_of_purchase).slice(0, 10) : null);
      // Created with the moving label as its ONLY label — createPo needs at least one, and
      // handing it this label's tracking number would make two labels claim one parcel.
      // So: a placeholder label, which the move then replaces by deleting it below.
      const shell = await createPo({
        supplierName,
        supplierUserId: from?.supplier_user_id ?? null,
        tagCode: String(n.tagCode ?? from?.tag_code ?? '').trim().slice(0, 120) || null,
        dateOfPurchase: madeOn,
        notes: `Raised to hold label ${box.box_number} moved off ${from?.po_code || 'another order'}.`,
        labels: [{ trackingNumber: '', carrierKey: null }],
        createdBy: user.name || user.username || '',
      });
      targetPoId = Number(shell.po.id);
      created = shell.po;
    }

    const r = await movePoBox(boxId, targetPoId, { createdBy: user.name || user.username || '' });
    if (r.error) return send(res, 409, { ok: false, error: r.error });

    // The placeholder has done its job — the real label is on the order now. Dropped
    // rather than left behind as a blank label nobody can account for. (It can't be the
    // last one: the moved label is on the order by this point.)
    if (created) {
      const full = await getPoFull(targetPoId);
      for (const b of (full?.boxes || [])) {
        if (!b.tracking_number && Number(b.id) !== Number(boxId)) await removePoBox(Number(b.id));
      }
    }

    const author = { id: Number(user.uid) || null, name: user.name || user.username || '', role: user.role };
    const moved = r.units > 0 ? ` ${r.units} pair(s) already received on it moved too` : '';
    await addPoComment({
      poId: Number(box.po_id), kind: 'system',
      body: `Label ${box.box_number} (${box.tracking_number || 'no tracking #'}) moved to ${r.to.po_code}, where it is label ${r.boxNumber}.${moved}${moved ? '.' : ''}`,
      author,
    }).catch((e) => console.warn('[po/label-move] system comment:', e.message));
    await addPoComment({
      poId: Number(targetPoId), kind: 'system',
      body: `Label ${r.boxNumber} (${box.tracking_number || 'no tracking #'}) moved in from ${r.from?.po_code || 'another order'}, where it was label ${box.box_number}.${moved}${moved ? '.' : ''}`
        + (r.createdBatch ? ` Its received box landed in a new batch, ${r.createdBatch}.` : ''),
      author,
    }).catch((e) => console.warn('[po/label-move] system comment:', e.message));
    console.log(`[po/label-move] ${from?.po_code} label ${box.box_number} → ${r.to.po_code} by ${user.username || user.uid}`);
    return send(res, 200, {
      ok: true, to: r.to, boxNumber: r.boxNumber, units: r.units,
      createdPo: created ? { id: created.id, po_code: created.po_code } : null,
      createdBatch: r.createdBatch, movedBatches: r.movedBatches,
    });
  } catch (e) {
    console.error('[po/label-move]', e.message);
    return send(res, 500, { ok: false, error: 'Could not move the label.' });
  }
}
