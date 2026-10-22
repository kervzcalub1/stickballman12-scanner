// POST /api/batches/add-box  { batchId, trackingNumber, boxNumber?, poBoxId?, untied? } -> { ok, box }
// Adds a physical box (its own tracking #) to an open multi-box batch. The box
// starts 'pending'; box-commit marks it received. (V6 Feature 7)
//
// On a batch received against a PO, the box is tied to the label it is
// (batch_boxes.po_box_id) when the opened label and the carton's number agree. On a
// STORE order they must agree — the tie is which store's pairs these are — so a
// disagreement is a 409 with a `code` (resolveBoxLabel), unless the person says to
// receive it `untied` (tied on the order later). A store box whose label had no number
// yet takes this carton's (the store shipped under its own label).
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import {
  addBatchBox, getBatchWithBoxes, claimForTracking, dbConfigured, SHIPMENT_KINDS,
  getPo, resolveBoxLabel, poBoxByTracking, updatePoBox, addPoComment,
} from '../_lib/db.js';
import { registerWarehouseTracking, registerTracking } from '../_lib/tracking.js';

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
  const trackingNumber = String(body.trackingNumber ?? '').trim().slice(0, 120) || null;
  const boxNumber = Number.isInteger(Number(body.boxNumber)) && Number(body.boxNumber) > 0 ? Number(body.boxNumber) : null;
  const poBoxId = Number.isInteger(Number(body.poBoxId)) && Number(body.poBoxId) > 0 ? Number(body.poBoxId) : null;
  const untied = body.untied === true;
  if (!Number.isInteger(batchId)) return send(res, 400, { ok: false, error: 'A valid batchId is required.' });

  try {
    const found = await getBatchWithBoxes(batchId);
    if (!found || !SHIPMENT_KINDS.includes(found.batch.kind)) return send(res, 404, { ok: false, error: 'Batch not found.' });
    if (found.batch.status !== 'open') return send(res, 409, { ok: false, error: 'This batch is already finished — reopen it to add a box.' });
    let tie = {};
    let saveOnLabel = null;
    if (found.batch.po_id) {
      const po = await getPo(found.batch.po_id);
      const r = await resolveBoxLabel(found.batch.po_id, { poBoxId, trackingNumber });
      if (po?.by_store) {
        if (r.code && !untied) {
          return send(res, 409, {
            ok: false, code: r.code,
            error: `${r.error} On an order bought from several stores every box has to be tied to its label — `
              + 'that is which store it came from. Or receive it as not tied to a store, and tie it on the order later.',
          });
        }
        tie = { setLabel: true, poBoxId: r.code || untied ? null : r.poBoxId };
        if (!r.code && !untied && r.saveTracking && trackingNumber && !(await poBoxByTracking(trackingNumber))) saveOnLabel = r.label;
      } else if (!r.code && (poBoxId != null || r.poBoxId != null)) {
        // An ordinary order: tie when the two agree; a disagreement is left to the
        // number, as it always was (a parcel can be re-taped).
        tie = { setLabel: true, poBoxId: r.poBoxId };
      }
    }
    const box = await addBatchBox(batchId, { trackingNumber, boxNumber, ...tie }, user.name || user.username || '');
    if (saveOnLabel) {
      const updated = await updatePoBox(Number(saveOnLabel.id), { trackingNumber, trackingSource: 'store' });
      registerTracking([{ number: trackingNumber, carrier: updated?.carrier_key }])
        .catch((e) => console.warn('[batches/add-box] registerTracking:', e.message));
      addPoComment({
        poId: found.batch.po_id, kind: 'system', audience: 'internal',
        body: `Label ${saveOnLabel.box_number} had no tracking number — recorded the store's own, ${trackingNumber}, off the carton at receiving.`,
        author: { id: Number(user.uid) || null, name: user.name || user.username || '', role: user.role },
      }).catch(() => { /* non-blocking */ });
    }
    // A number typed here used to have no courier feed behind it at all — the box
    // showed "No courier updates" forever. Fire-and-forget: receiving must never wait
    // on a third-party account, and the claim makes it safe to call on every add.
    if (box?.tracking_number) {
      registerWarehouseTracking([box.tracking_number], { claim: claimForTracking, label: 'batches/add-box' })
        .catch((e) => console.warn('[batches/add-box] register:', e.message));
    }
    return send(res, 200, { ok: true, box });
  } catch (e) {
    console.error('[batches/add-box]', e.message);
    return send(res, 500, { ok: false, error: 'Could not add the box.' });
  }
}
