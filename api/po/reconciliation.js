// GET /api/po/reconciliation?poId=  (warehouse / ph_team / admin)
// The expected-vs-received table + summary for a PO (computed on demand), plus what we
// counted BOX BY BOX (`received_boxes`) for the shortage evidence. If the PO is already
// reconciled, the frozen snapshot is on the PO too (po.reconciliation).
import { send, applySecurity, requireRole } from '../_lib/util.js';
import {
  getPoReconcileState, getPoResolution, listPoComments, resolutionView,
  stepsFor, getPoReceivedBoxes, getPoBoxDiffs, dbConfigured,
} from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireRole(req, res, ['warehouse', 'ph_team'])) return;
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const poId = Number(new URL(req.url, 'http://x').searchParams.get('poId'));
  if (!Number.isInteger(poId)) return send(res, 400, { ok: false, error: 'A valid poId is required.' });

  try {
    // One read for both the table and the "is anything still coming?" flags the
    // header chip needs to distinguish "still receiving" from "genuinely done".
    const st = await getPoReconcileState(poId);
    if (!st) return send(res, 404, { ok: false, error: 'Purchase order not found.' });
    const { intakeDone, awaitingBoxes, ...data } = st;
    // Resolution + thread ride along on the screen's existing fetch rather than adding
    // two more round trips. Both are cheap and only ever load when an order is opened.
    // `receivedBoxes` = our own per-box count, for the "this is what we opened" evidence
    // (and the PDF built from it). Same fetch, since it's only ever read on this screen.
    // `box_diffs` = the same comparison per LABEL, so a shortage says which box to open
    // rather than only which shoe. Empty on a whole-order manifest, which has no per-box
    // expectation to compare against.
    const [resolution, comments, receivedBoxes, boxDiffs] = await Promise.all([
      getPoResolution(poId),
      listPoComments(poId, { limit: 50 }),
      getPoReceivedBoxes(poId),
      getPoBoxDiffs(poId),
    ]);
    return send(res, 200, {
      ok: true, ...data,
      intake_done: intakeDone, awaiting_boxes: awaitingBoxes,
      resolution: resolutionView(resolution),
      steps: stepsFor(resolution?.outcome),
      comments,
      received_boxes: receivedBoxes,
      box_diffs: boxDiffs,
    });
  } catch (e) {
    console.error('[po/reconciliation]', e.message);
    return send(res, 500, { ok: false, error: 'Could not compute the reconciliation.' });
  }
}
