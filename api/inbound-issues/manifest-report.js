// POST /api/inbound-issues/manifest-report
//   { origin:'online'|'supplier', tracking?, store?, orderNumber?, listed?, got?,
//     lines?: [{ shoe, size, listed, got }], boxPhotos: [url], manifestPhotos: [url], note? }
//   -> { ok, row }
// The warehouse opens a parcel and its own paperwork does not match what is inside: the
// packing slip of an online order, or a manifest a supplier slipped in the box (they never
// sent us one, so there is no PO manifest to receive against). Filed as an inbound-issues
// case of type `manifest` and told to the PH team at once (docs/context/manifest-reports.md).
// It does not need the parcel to be received first: no batch, no order on file, no tracking
// number are all fine. What it does need is a photo of the boxes and a photo of the manifest.
import { send, applySecurity, rateLimit, requireRole, getJsonBody } from '../_lib/util.js';
import {
  dbConfigured, findShipmentForIssue, openInboundIssues, cleanPhotoUrls, findOpenManifestCase, onlineOrderByTracking,
} from '../_lib/db.js';
import { alertManifestDiscrepancy } from '../_lib/alerts.js';
import { normalizeTrackingNumber } from '../_lib/tracking.js';
import { cleanManifestLines, manifestTotals, manifestDescription, manifestReportProblem } from '../../src/lib/manifestReports.js';
import { VIEW_ROLES, actorOf, uidOf, text } from './_shared.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, VIEW_ROLES);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 20 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const b = await getJsonBody(req);
  const by = actorOf(user);
  const byUid = uidOf(user);
  const origin = String(b.origin || '');
  const typed = text(b.tracking, 60);
  const tracking = typed ? (normalizeTrackingNumber(typed) || typed).toUpperCase() : null;
  const note = text(b.note, 600);
  const lines = cleanManifestLines(b.lines);
  const boxPhotos = cleanPhotoUrls(b.boxPhotos, 6);
  const manifestPhotos = cleanPhotoUrls(b.manifestPhotos, 6);
  try {
    // What we already know about this parcel from its tracking number: the online order
    // (store, order #) and the delivery it was received as, if it has been.
    let order = null;
    try { order = tracking ? await onlineOrderByTracking(tracking) : null; } catch { order = null; }
    const store = text(b.store, 120) || order?.store || null;
    const orderNumber = text(b.orderNumber, 80) || order?.order_number || null;
    const form = { origin, store, orderNumber, lines, listed: b.listed, got: b.got, note, boxPhotos, manifestPhotos };
    const problem = manifestReportProblem(form);
    if (problem) return send(res, 400, { ok: false, error: problem });

    if (tracking) {
      const dupe = await findOpenManifestCase(tracking);
      if (dupe) return send(res, 409, { ok: false, caseId: dupe, error: `That parcel is already reported: case #${dupe}. Add your photos or a note there.` });
    }
    // Only a supplier delivery is linked: an in-store trip or counted stock that happens to
    // share the number must never reach the PH team through a case (PH_EXCLUDED_KINDS).
    const found = tracking ? await findShipmentForIssue(tracking) : null;
    const linked = found && (found.kind == null || found.kind === 'receiving') ? found : null;

    const t = manifestTotals(form);
    const rows = await openInboundIssues({
      batchId: linked?.batch_id ?? null, boxId: linked?.box_id ?? null, by, byUid, source: 'manifest',
      shipment: [{
        type: 'manifest',
        description: manifestDescription(form),
        expectedCount: t.listed, receivedCount: t.got,
        photos: [...boxPhotos, ...manifestPhotos],
        supplier: store, trackingNumber: tracking,
        manifest: { origin, store, orderNumber, lines, boxPhotos, manifestPhotos, note },
      }],
    });
    alertManifestDiscrepancy(rows[0], { id: byUid, name: by });
    return send(res, 200, { ok: true, row: rows[0] || null });
  } catch (e) {
    console.error('[inbound-issues/manifest-report]', e.message);
    return send(res, 500, { ok: false, error: 'Could not send the report.' });
  }
}
