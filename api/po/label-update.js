// POST /api/po/label-update  (ph_team / admin)
//   { boxId, trackingNumber?, carrierKey? }
// Corrects a label's tracking number or carrier. This is more than cosmetic: the tracking
// number is what ties a label to the box the warehouse received (`getPoFull` matches on
// that string), what the labels PDF maps its pages by, and what the aggregator watches —
// so a typo'd number means a parcel nobody is tracking and a box that reconciles against
// nothing. The corrected number is registered for tracking on the way out.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import {
  getPoBox, getPo, updatePoBox, poBoxByTracking, poBoxReceived, addPoComment, PO_FROZEN, dbConfigured,
} from '../_lib/db.js';
import { registerTracking } from '../_lib/tracking.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const boxId = Number(body.boxId);
  if (!Number.isInteger(boxId)) return send(res, 400, { ok: false, error: 'A valid boxId is required.' });

  try {
    const box = await getPoBox(boxId);
    if (!box) return send(res, 404, { ok: false, error: 'That label no longer exists.' });
    const po = await getPo(box.po_id);
    if (PO_FROZEN.includes(po?.status)) {
      return send(res, 409, { ok: false, error: `${po.po_code} is ${po.status} — its count is settled, so its labels can't be edited.` });
    }

    const patch = {};
    if (body.trackingNumber !== undefined) {
      const v = String(body.trackingNumber ?? '').trim().slice(0, 120) || null;
      if (v) {
        const clash = await poBoxByTracking(v, { exceptBoxId: boxId });
        if (clash) {
          return send(res, 409, {
            ok: false,
            error: `${v} is already label ${clash.box_number} on ${clash.po_code}. `
              + 'A tracking number identifies one parcel, so it can only be on one label.',
          });
        }
      }
      patch.trackingNumber = v;
    }
    if (body.carrierKey !== undefined) {
      const n = Number(body.carrierKey);
      patch.carrierKey = Number.isInteger(n) && n > 0 ? n : null;
    }
    if (!Object.keys(patch).length) return send(res, 200, { ok: true, box });

    // Changing the number re-points the label at a different parcel, so anything already
    // counted against the OLD number stops being matched to it. Say so rather than
    // silently detaching stock from the label it was received on.
    const before = await poBoxReceived(box);
    const updated = await updatePoBox(boxId, patch);
    if (patch.trackingNumber !== undefined && updated?.tracking_number)
      registerTracking([{ number: updated.tracking_number, carrier: updated.carrier_key }])
        .catch((e) => console.warn('[po/label-update] registerTracking:', e.message));
    await addPoComment({
      poId: box.po_id, kind: 'system',
      body: `Label ${box.box_number} tracking ${box.tracking_number || '—'} → ${updated?.tracking_number || '—'}.`
        + (before.units > 0 ? ` ${before.units} pair(s) were counted against the old number and no longer match this label.` : ''),
      author: { id: Number(user.uid) || null, name: user.name || user.username || '', role: user.role },
    }).catch((e) => console.warn('[po/label-update] system comment:', e.message));
    return send(res, 200, { ok: true, box: updated, unmatchedUnits: before.units });
  } catch (e) {
    console.error('[po/label-update]', e.message);
    return send(res, 500, { ok: false, error: 'Could not update the label.' });
  }
}
