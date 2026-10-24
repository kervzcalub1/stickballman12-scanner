// POST /api/inbound-issues/report
//   { scope:'pair', vin, type, description?, photos? }
//   { scope:'shipment', code (tracking # or batch code), type, description?, expectedCount?, receivedCount?, photos? }
//   -> { ok, row }
// A problem found AFTER receiving (a pair opened at shelving, a short count noticed the
// next day). Filed on the pair / shipment exactly as if it had been recorded at receiving:
// the same history rows (item 'issue' event / shipment_issues) plus a case for PH.
import { send, applySecurity, rateLimit, requireRole, getJsonBody } from '../_lib/util.js';
import {
  dbConfigured, findItemForIssue, findShipmentForIssue, insertIssueEvents, insertIssues, openInboundIssues, cleanPhotoUrls,
} from '../_lib/db.js';
import { alertInboundIssuesReported } from '../_lib/alerts.js';
import { SHIPMENT_TYPES, PAIR_TYPES } from '../../src/lib/inboundIssues.js';
import { VIN_RE } from '../_lib/vins.js';

// Only a supplier delivery is a claim. In-store trips, counted existing stock and empty-box
// orders must never reach the PH team (PH_EXCLUDED_KINDS) — and rescale has no shipment.
const NOT_A_DELIVERY = 'That isn’t from a supplier delivery (in-store, existing stock, rescale or empty boxes) — there is no one to claim from here.';
const isDelivery = (kind) => kind == null || kind === 'receiving';
import { VIEW_ROLES, actorOf, uidOf, text } from './_shared.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, VIEW_ROLES);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 30 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const b = await getJsonBody(req);
  const by = actorOf(user);
  const byUid = uidOf(user);
  const type = String(b.type || '');
  const description = text(b.description, 1000);
  const photos = cleanPhotoUrls(b.photos);
  try {
    let rows;
    if (b.scope === 'pair') {
      if (!PAIR_TYPES.some(([k]) => k === type)) return send(res, 400, { ok: false, error: 'Pick what is wrong with the pair.' });
      const vin = String(b.vin || '').trim().toUpperCase();
      if (!VIN_RE.test(vin)) return send(res, 400, { ok: false, error: 'Scan or type the pair’s VIN (its 1ID sticker).' });
      const it = await findItemForIssue(vin);
      if (!it) return send(res, 404, { ok: false, error: `No pair with VIN ${vin}.` });
      if (['sold', 'shipped'].includes(it.status)) return send(res, 409, { ok: false, error: `${vin} is already ${it.status}.` });
      if (!it.batch_id || !isDelivery(it.kind)) return send(res, 409, { ok: false, error: NOT_A_DELIVERY });
      await insertIssueEvents([{ itemId: it.id, type, note: description || '', photos }], by);
      rows = await openInboundIssues({ batchId: it.batch_id, boxId: it.box_id, pairs: [{ itemId: it.id, type, note: description, photos }], by, byUid, source: 'page' });
    } else if (b.scope === 'shipment') {
      if (!SHIPMENT_TYPES.some(([k]) => k === type)) return send(res, 400, { ok: false, error: 'Pick what is wrong with the delivery.' });
      const found = await findShipmentForIssue(b.code);
      if (!found) return send(res, 404, { ok: false, error: 'No received shipment with that tracking number or batch code.' });
      if (!isDelivery(found.kind)) return send(res, 409, { ok: false, error: NOT_A_DELIVERY });
      const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Math.max(0, Math.round(Number(v))));
      const [rec] = await insertIssues(found.batch_id, [{ type, description, expectedCount: num(b.expectedCount), receivedCount: num(b.receivedCount), photos }], by);
      rows = await openInboundIssues({
        batchId: found.batch_id, boxId: found.box_id, by, byUid, source: 'page',
        shipment: [{ shipmentIssueId: rec.id, type, description, expectedCount: rec.expected_count, receivedCount: rec.received_count, photos }],
      });
    } else {
      return send(res, 400, { ok: false, error: 'Is it about one pair or the whole delivery?' });
    }
    alertInboundIssuesReported(rows, { id: byUid, name: by });
    return send(res, 200, { ok: true, row: rows[0] || null });
  } catch (e) {
    console.error('[inbound-issues/report]', e.message);
    return send(res, 500, { ok: false, error: 'Could not report that.' });
  }
}
