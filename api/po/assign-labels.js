// POST /api/po/assign-labels  (ph_team / admin)
//   { poId, assignments: [{ boxId, trackingNumber, carrierKey? }] }
//
// The manifest-first counterpart to creating an order FROM its labels. The supplier has
// already declared the boxes; this puts the courier's tracking numbers onto them.
//
// The mapping cannot be derived — a numberless box has nothing to match a page against —
// so it is whatever PH confirmed on screen. The client defaults it to page order (page 1
// → box 1) and lets any row be changed before saving; the server just refuses anything
// incoherent. That is the opposite of `attachPoLabels`, which maps a PDF's pages onto
// labels that already carry numbers, and must never use page order.
//
// Assigning clears the supplier's outstanding label request, and registers each number
// with the tracking aggregator exactly as creating a label does.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { getPoFull, assignPoTracking, setLabelsRequested, addPoComment, PO_FROZEN, dbConfigured } from '../_lib/db.js';
import { registerTracking } from '../_lib/tracking.js';

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
  const assignments = (Array.isArray(body.assignments) ? body.assignments : [])
    .slice(0, 200)
    .map((a) => ({
      boxId: Number(a?.boxId),
      trackingNumber: String(a?.trackingNumber ?? '').trim().slice(0, 120),
      carrierKey: a?.carrierKey ?? null,
    }))
    .filter((a) => Number.isInteger(a.boxId) && a.trackingNumber);
  if (!Number.isInteger(poId)) return send(res, 400, { ok: false, error: 'A valid poId is required.' });
  if (!assignments.length) return send(res, 400, { ok: false, error: 'Nothing to assign.' });

  try {
    const data = await getPoFull(poId);
    if (!data) return send(res, 404, { ok: false, error: 'Purchase order not found.' });
    if (PO_FROZEN.includes(data.po.status))
      return send(res, 409, { ok: false, error: `${data.po.po_code} is ${data.po.status} — its labels are settled.` });

    const r = await assignPoTracking(poId, assignments);
    if (r.error) return send(res, 409, { ok: false, error: r.error });

    const after = await getPoFull(poId);
    // Registering here is what makes 17TRACK start watching and pushing status on its own
    // — the same call `po/create` makes when the order is raised labels-first.
    const track = assignments.map((a) => ({ number: a.trackingNumber, carrier: a.carrierKey }));
    registerTracking(track).catch((e) => console.warn('[po/assign-labels] registerTracking:', e.message));

    // The request is answered only once EVERY box has a number: a partial assignment on a
    // six-box order still leaves the supplier waiting, and clearing the flag would drop it
    // out of the queue with boxes still label-less.
    const own = (after.boxes || []).filter((b) => b.kind !== 'replacement');
    const allLabelled = own.length > 0 && own.every((b) => b.tracking_number);
    // Take the row BACK from the clear — `after` was read before it, so returning that
    // one would tell the client the order is still waiting when it isn't.
    let po = after.po;
    if (allLabelled && po.labels_requested_at) po = (await setLabelsRequested(poId, null)) || po;

    await addPoComment({
      poId, kind: 'system',
      body: `${assignments.length} tracking number(s) assigned — `
        + assignments.map((a) => {
          const b = own.find((x) => Number(x.id) === a.boxId);
          return `box ${b?.box_number ?? '?'} → ${a.trackingNumber}`;
        }).join(', ')
        + (allLabelled ? '. Every box now has a label.' : '.'),
      author: { id: Number(user.uid) || null, name: user.name || user.username || '', role: user.role },
    }).catch((e) => console.warn('[po/assign-labels] system comment:', e.message));

    return send(res, 200, { ok: true, assigned: r.count, allLabelled, po, boxes: after.boxes });
  } catch (e) {
    console.error('[po/assign-labels]', e.message);
    if (e.code === '23505') return send(res, 409, { ok: false, error: 'One of those tracking numbers was just used elsewhere — reload and try again.' });
    return send(res, 500, { ok: false, error: 'Could not assign the labels.' });
  }
}
