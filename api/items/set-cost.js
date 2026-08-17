// POST /api/items/set-cost { vins:[], cost } -> { ok, updated }
// Set (or clear) what a set of pairs cost. `cost: null` / '' clears it back to
// "unknown" — NOT to zero; see below. Admin + warehouse + PH.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { setItemsCost, dbConfigured } from '../_lib/db.js';

const MAX_VINS = 500;   // one SKU+size group; far above any real click
const MAX_COST = 100000;

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse', 'ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const vins = (Array.isArray(body.vins) ? body.vins : [])
    .map((v) => String(v || '').trim().toUpperCase()).filter(Boolean);
  if (!vins.length) return send(res, 400, { ok: false, error: 'No units selected.' });
  if (vins.length > MAX_VINS) return send(res, 400, { ok: false, error: 'Too many units in one save.' });

  // Blank clears the cost to NULL. That is a different claim from $0 — "nobody has
  // told us what this cost" vs "this was free" — and the two must not collapse into
  // each other, the same rule the PO lines follow (purchase-orders.md).
  const raw = body.cost;
  let cost = null;
  if (raw !== null && raw !== undefined && String(raw).trim() !== '') {
    cost = Number(raw);
    if (!Number.isFinite(cost)) return send(res, 400, { ok: false, error: 'Cost must be a number.' });
    // Receiving already rejects a negative cost rather than silently storing it
    // (receiving.md) — same answer here, so the two entry points agree.
    if (cost < 0) return send(res, 400, { ok: false, error: 'Cost can’t be negative.' });
    if (cost > MAX_COST) return send(res, 400, { ok: false, error: 'That cost looks wrong — check the amount.' });
    cost = Math.round(cost * 100) / 100;
  }

  try {
    const rows = await setItemsCost(vins, cost, user.name || user.username || '');
    return send(res, 200, { ok: true, updated: rows.length, cost });
  } catch (e) {
    console.error('[items/set-cost]', e.message);
    return send(res, 500, { ok: false, error: 'Could not save the cost.' });
  }
}
