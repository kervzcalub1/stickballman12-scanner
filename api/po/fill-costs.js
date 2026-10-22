// GET  /api/po/fill-costs?poId=…          -> { ok, plan }            (preview, writes nothing)
// POST /api/po/fill-costs { poId, apply }  -> { ok, filled, plan }    (ph_team / admin)
//
// "Fill costs from this order's list" (docs/store-orders-plan.md §4.4 [M14]). A store
// order's pairs are often received before Joey's list (or its prices) is in, so they land
// with a blank cost while the list beside them later has every price. This runs the
// admin-wide cost backfill for ONE order — the pairs in batches linked to it — with the
// same rules: the pair's own label first (tied, then by number), on a store order that
// label's STORE's price only (a box tied to no store stays blank), the supplier's preset
// required. Only blank costs are ever filled.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { getPo, addPoComment, dbConfigured } from '../_lib/db.js';
import { buildCostPlan, applyCostPlan } from '../_lib/cost-backfill.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (!['GET', 'POST'].includes(req.method)) return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 20 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = req.method === 'POST' ? await getJsonBody(req) : {};
  const poId = Number(req.method === 'GET' ? new URL(req.url, 'http://x').searchParams.get('poId') : body.poId);
  if (!Number.isInteger(poId) || poId < 1) return send(res, 400, { ok: false, error: 'A valid order is required.' });

  try {
    const po = await getPo(poId);
    if (!po) return send(res, 404, { ok: false, error: 'Purchase order not found.' });
    if (req.method === 'GET') {
      const { summary } = await buildCostPlan({ poId });
      return send(res, 200, { ok: true, plan: summary });
    }
    if (body.apply !== true) return send(res, 400, { ok: false, error: 'Nothing to do — preview first.' });
    // Re-planned at the click, as in items/cost-backfill.
    const plan = await buildCostPlan({ poId });
    const filled = await applyCostPlan(plan, user.username);
    if (filled > 0) {
      const uidNum = Number(user.uid);
      await addPoComment({
        poId, kind: 'system', audience: 'internal',
        body: `Filled the cost of ${filled} received pair${filled === 1 ? '' : 's'} from this order's list.`,
        author: { id: Number.isInteger(uidNum) ? uidNum : null, name: user.name || user.username || '', role: user.role },
      }).catch(() => { /* non-blocking */ });
    }
    return send(res, 200, { ok: true, filled, plan: plan.summary });
  } catch (e) {
    console.error('[po/fill-costs]', e.message);
    return send(res, 500, { ok: false, error: 'Could not work out the costs from this order.' });
  }
}
