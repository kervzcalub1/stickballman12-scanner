// POST /api/po/label-add  (ph_team / admin)
//   { poId, labels: [{ trackingNumber, carrierKey? }] }
// Adds shipping labels to an order that already exists — the supplier bought more, or a
// tracking number only turned up after the order was raised. New labels are numbered on
// from the highest already there (a label keeps its number for life: it's what the
// warehouse writes on the carton), start as 'pending', and are registered with the
// tracking aggregator exactly as the ones created with the order are.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { getPoFull, addPoLabels, poBoxByTracking, addPoComment, PO_FROZEN, dbConfigured } from '../_lib/db.js';
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
  const poId = Number(body.poId);
  if (!Number.isInteger(poId)) return send(res, 400, { ok: false, error: 'A valid poId is required.' });
  const labels = (Array.isArray(body.labels) ? body.labels : []).slice(0, 50).map((l) => ({
    trackingNumber: String(l?.trackingNumber ?? '').trim().slice(0, 120),
    carrierKey: Number.isInteger(Number(l?.carrierKey)) && Number(l?.carrierKey) > 0 ? Number(l.carrierKey) : null,
  }));
  if (!labels.length) return send(res, 400, { ok: false, error: 'Add at least one label.' });

  try {
    const data = await getPoFull(poId);
    if (!data) return send(res, 404, { ok: false, error: 'Purchase order not found.' });
    if (PO_FROZEN.includes(data.po.status)) {
      return send(res, 409, { ok: false, error: `${data.po.po_code} is ${data.po.status} — its count is settled, so labels can't be added to it.` });
    }
    // Two labels can't share a tracking number: both would claim the same received box
    // (the received-vs-declared match is that string) and the labels PDF couldn't tell
    // their pages apart. Checked against every order, because the clash is global.
    const seen = new Set();
    for (const l of labels) {
      const key = l.trackingNumber.toUpperCase().replace(/\s+/g, '');
      if (!key) continue;
      if (seen.has(key)) return send(res, 400, { ok: false, error: `${l.trackingNumber} is in this list twice.` });
      seen.add(key);
      const clash = await poBoxByTracking(l.trackingNumber);
      if (clash) {
        return send(res, 409, {
          ok: false,
          error: `${l.trackingNumber} is already label ${clash.box_number} on ${clash.po_code}. `
            + 'A tracking number identifies one parcel, so it can only be on one label.',
        });
      }
    }

    const boxes = await addPoLabels(poId, labels, user.name || user.username || '');
    const trackItems = boxes.filter((b) => b.tracking_number).map((b) => ({ number: b.tracking_number, carrier: b.carrier_key }));
    if (trackItems.length)
      registerTracking(trackItems).catch((e) => console.warn('[po/label-add] registerTracking:', e.message));
    await addPoComment({
      poId, kind: 'system',
      body: `${boxes.length} label(s) added — ${boxes.map((b) => `${b.box_number} (${b.tracking_number || 'no tracking #'})`).join(', ')}.`,
      author: { id: Number(user.uid) || null, name: user.name || user.username || '', role: user.role },
    }).catch((e) => console.warn('[po/label-add] system comment:', e.message));
    return send(res, 200, { ok: true, boxes });
  } catch (e) {
    console.error('[po/label-add]', e.message);
    return send(res, 500, { ok: false, error: 'Could not add the label(s).' });
  }
}
