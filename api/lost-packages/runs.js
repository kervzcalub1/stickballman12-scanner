// Lost Package Tracker Tool — the saved runs (docs/context/lost-packages.md).
//   GET  /api/lost-packages/runs  -> { ok, runs, carriers: { ready, missing } }
//   POST /api/lost-packages/runs  { monthLabel, sourceName, sheetsScanned, rowsScanned, rowsSkipped,
//                                   counts, orderCount }  -> { ok, id }
// Phase 1 is worked out in the browser; this saves its header, then /orders takes the orders
// in chunks. Admins + the PH team (requireRole lets admins through).
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { listLostRuns, createLostRun, dbConfigured } from '../_lib/db.js';
import { carriersConfigured, missingCarrierKeys } from '../_lib/lostpkg-carriers.js';

const int = (v) => (Number.isInteger(Number(v)) && Number(v) >= 0 ? Number(v) : 0);

export default async function handler(req, res) {
  applySecurity(req, res);
  if (!['GET', 'POST'].includes(req.method)) return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  try {
    if (req.method === 'GET') {
      return send(res, 200, { ok: true, runs: await listLostRuns(), carriers: { ready: carriersConfigured(), missing: missingCarrierKeys() } });
    }
    const b = await getJsonBody(req);
    const monthLabel = String(b.monthLabel || '').trim().slice(0, 80);
    if (!monthLabel) return send(res, 400, { ok: false, error: 'Say which month this workbook is for.' });
    const counts = {};
    for (const k of ['Lost', 'Delivered', 'Cancelled', 'Refunded']) counts[k] = int(b.counts?.[k]);
    const orderCount = int(b.orderCount);
    if (!orderCount) return send(res, 400, { ok: false, error: 'This workbook has no orders with a tracking or order number.' });
    if (orderCount > 50_000) return send(res, 400, { ok: false, error: 'That is more orders than one month’s workbook holds — check the file.' });
    const id = await createLostRun({
      monthLabel, sourceName: String(b.sourceName || '').slice(0, 200), actor: user,
      sheetsScanned: int(b.sheetsScanned), rowsScanned: int(b.rowsScanned), rowsSkipped: int(b.rowsSkipped), counts, orderCount,
    });
    return send(res, 200, { ok: true, id });
  } catch (e) {
    console.error('[lost-packages/runs]', e.message);
    return send(res, 500, { ok: false, error: 'Could not reach the saved runs.' });
  }
}
