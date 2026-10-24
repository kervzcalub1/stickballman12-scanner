// POST /api/po/store-tracking  (supplier on their own store order / ph_team / admin)
//   { boxId, trackingNumber, carrierKey? } -> { ok, ...order }
//
// A store that ships a box under ITS OWN label (not one we bought) — the supplier records
// that carton's tracking number on the store's box, so the warehouse can match it when it
// lands (docs/store-orders-plan.md §8b). Same checks as any label number: one parcel, one
// label, across every order; registered with 17TRACK on the way out. Marked
// `tracking_source = 'store'`.
//
// A supplier may only fill a box with no number yet, or change one they recorded
// themselves — never overwrite a label we bought. Staff may do either.
import { getJsonBody, send, applySecurity, rateLimit, requireRole, isPrivileged } from '../_lib/util.js';
import {
  getPoBox, getPo, getPoFull, updatePoBox, poBoxByTracking, poBoxReceived, addPoComment, PO_FROZEN, dbConfigured,
} from '../_lib/db.js';
import { registerTracking } from '../_lib/tracking.js';
import { supplierPoView } from '../_lib/po-supplier-view.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['supplier', 'ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const boxId = Number(body.boxId);
  const tracking = String(body.trackingNumber ?? '').trim().slice(0, 120);
  if (!Number.isInteger(boxId)) return send(res, 400, { ok: false, error: 'A valid box is required.' });
  if (!/[A-Za-z0-9]{6,}/.test(tracking.replace(/[^A-Za-z0-9]/g, ''))) {
    return send(res, 400, { ok: false, error: 'Enter the tracking number off the store\'s label (at least 6 letters or digits).' });
  }
  const bySupplier = user.role === 'supplier' && !isPrivileged(user.role);

  try {
    const box = await getPoBox(boxId);
    if (!box) return send(res, 404, { ok: false, error: 'That box no longer exists.' });
    const po = await getPo(box.po_id);
    if (bySupplier && Number(po?.supplier_user_id) !== Number(user.uid))
      return send(res, 403, { ok: false, error: 'You do not have access to this order.' });
    if (!po?.by_store || box.po_store_id == null)
      return send(res, 409, { ok: false, error: 'Only a box on an order bought from several stores takes a store\'s own tracking number.' });
    if (PO_FROZEN.includes(po.status))
      return send(res, 409, { ok: false, error: `${po.po_code} is ${po.status} — its count is settled, so its labels can't be edited.` });
    if (bySupplier && box.tracking_number && box.tracking_source !== 'store')
      return send(res, 409, { ok: false, error: `Box ${box.box_number} already has the label we sent (${box.tracking_number}). Ask us if the store shipped it some other way.` });
    // Labels have no 'received' status — what counts is pairs already counted into it.
    if (bySupplier && (await poBoxReceived(box)).units > 0)
      return send(res, 409, { ok: false, error: `Box ${box.box_number} has already been received — ask us if its number is wrong.` });
    const clash = await poBoxByTracking(tracking, { exceptBoxId: boxId });
    if (clash) {
      return send(res, 409, {
        ok: false,
        error: `${tracking} is already label ${clash.box_number} on ${clash.po_code}. A tracking number identifies one parcel, so it can only be on one label.`,
      });
    }
    const patch = { trackingNumber: tracking, trackingSource: 'store' };
    if (body.carrierKey !== undefined) {
      const n = Number(body.carrierKey);
      patch.carrierKey = Number.isInteger(n) && n > 0 ? n : null;
    }
    const updated = await updatePoBox(boxId, patch);
    registerTracking([{ number: updated.tracking_number, carrier: updated.carrier_key }])
      .catch((e) => console.warn('[po/store-tracking] registerTracking:', e.message));
    const uidNum = Number(user.uid);
    await addPoComment({
      poId: box.po_id, kind: 'system',
      body: `Box ${box.box_number}: the store's own tracking number ${box.tracking_number ? `${box.tracking_number} → ` : ''}${updated.tracking_number}.`,
      author: { id: Number.isInteger(uidNum) ? uidNum : null, name: user.name || user.username || '', role: user.role },
    }).catch((e) => console.warn('[po/store-tracking] system comment:', e.message));
    const data = await getPoFull(box.po_id);
    return send(res, 200, { ok: true, ...(bySupplier ? supplierPoView(data) : data) });
  } catch (e) {
    console.error('[po/store-tracking]', e.message);
    return send(res, 500, { ok: false, error: 'Could not save the tracking number.' });
  }
}
