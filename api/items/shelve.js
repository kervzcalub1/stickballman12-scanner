// POST /api/items/shelve { locationCode, units:[{ vin, nowHasBox }] }
//   -> { ok, updated, gotBox, location, results }
// Put-away / transfer: place scanned units on a shelf. Boxed units (or ones that
// now have a box) become In Stock at that location; a unit still without a box
// keeps its no-box status but is still recorded there. Warehouse + admin.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { getLocationByCode, shelveItems, dbConfigured } from '../_lib/db.js';
import { normalizeLocationCode } from '../_lib/locations.js';

const MAX_UNITS = 1000;
const VIN_RE = /^SBM-\d{6}-\d+$/i;

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const code = normalizeLocationCode(body.locationCode);
  if (!code) return send(res, 400, { ok: false, error: 'A valid shelf code is required.' });

  const units = (Array.isArray(body.units) ? body.units : [])
    .map((u) => ({ vin: String(u?.vin || '').trim().toUpperCase(), nowHasBox: !!u?.nowHasBox }))
    .filter((u) => VIN_RE.test(u.vin));
  if (!units.length) return send(res, 400, { ok: false, error: 'Scan at least one VIN to shelve.' });
  if (units.length > MAX_UNITS) return send(res, 400, { ok: false, error: `Too many units (max ${MAX_UNITS}).` });

  try {
    const location = await getLocationByCode(code);
    if (!location) return send(res, 404, { ok: false, error: `Unknown shelf “${code}”.` });
    if (!location.active) return send(res, 409, { ok: false, error: `Shelf “${code}” is inactive.` });

    const createdBy = user.name || user.username || '';
    const { updated, gotBox, results } = await shelveItems({ location, units, createdBy });
    return send(res, 200, { ok: true, updated, gotBox, location: { code: location.code, label: location.label, warehouse: location.warehouse, area: location.area }, results });
  } catch (e) {
    console.error('[items/shelve]', e.message);
    return send(res, 500, { ok: false, error: 'Could not shelve the items. Please try again.' });
  }
}
