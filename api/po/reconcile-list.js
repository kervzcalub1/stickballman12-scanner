// GET /api/po/reconcile-list  (warehouse / ph_team / admin)
// POs that have been received against — 'receiving' (awaiting reconcile) first,
// then 'reconciled' (done) — for the Reconciliation screen's list. Each still-open PO
// carries an `rc` block so the card can say what's actually wrong ("2 short", "still
// receiving") instead of a blanket "To reconcile".
import { send, applySecurity, requireRole } from '../_lib/util.js';
import {
  listReconcilePos, autoReconcileIfClean, getPoReconcileState, dbConfigured,
} from '../_lib/db.js';

const rcBlock = (st) => ({
  ...(st.summary || {}),
  intake_done: st.intakeDone,
  awaiting_boxes: st.awaitingBoxes,
});

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireRole(req, res, ['warehouse', 'ph_team'])) return;
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  try {
    let pos = await listReconcilePos();
    // Self-heal: close out any still-open PO that reconciles clean. Catches orders
    // received before auto-reconcile existed, and any run that lost its post-response
    // best-effort call. autoReconcileIfClean is a no-op unless every guard passes.
    const open = pos.filter((p) => p.status === 'receiving');
    if (open.length) {
      const closed = await Promise.all(open.map((p) =>
        autoReconcileIfClean(Number(p.id)).catch((e) => {
          console.warn('[po/reconcile-list] auto-reconcile skipped:', e.message);
          return null;
        })));
      if (closed.some(Boolean)) pos = await listReconcilePos();
    }
    // Label what's left. A closed PO already has its frozen summary on the row; a
    // still-open one gets a fresh read (the same state the auto-close guard just saw).
    const withState = await Promise.all(pos.map(async (p) => {
      if (p.status !== 'receiving') {
        return { ...p, rc: p.snapshot_summary || null, snapshot_summary: undefined };
      }
      const st = await getPoReconcileState(Number(p.id)).catch(() => null);
      return { ...p, rc: st ? rcBlock(st) : null, snapshot_summary: undefined };
    }));
    return send(res, 200, { ok: true, pos: withState });
  } catch (e) {
    console.error('[po/reconcile-list]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load purchase orders.' });
  }
}
