// POST /api/locations/update { id, label?, active?, warehouse?, area?, bay?, shelf? }
//   -> { ok, location, codeChanged }
// Two shapes in one endpoint:
//   • label / active only  → the cheap patch (rename, deactivate). Unchanged behaviour.
//   • any structural field → a MOVE: the shelf's site/area/bay/shelf-number change, the
//     scannable `code` is rebuilt from the new parts (same builder as create), and every
//     unit on the shelf has its location_code snapshot rewritten. `codeChanged` tells the
//     client to tell the user to reprint the shelf label.
// Warehouse + admin.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { getLocationById, updateLocation, moveLocation, dbConfigured } from '../_lib/db.js';
import { buildLocationCode, sitePrefixFor, areaPrefixFor, bayCodeFor, pad2 } from '../_lib/locations.js';

const clean = (s, n) => String(s ?? '').trim().slice(0, n);
const STRUCTURAL = ['warehouse', 'area', 'bay', 'shelf'];

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const id = Number(body.id) || 0;
  if (!id) return send(res, 400, { ok: false, error: 'Missing location id.' });

  const moving = STRUCTURAL.some((k) => k in body);
  if (!moving) {
    const patch = {};
    if ('label' in body) patch.label = clean(body.label, 40) || null;
    if ('active' in body) patch.active = !!body.active;
    if (!Object.keys(patch).length) return send(res, 400, { ok: false, error: 'Nothing to update.' });
    try {
      const location = await updateLocation(id, patch);
      if (!location) return send(res, 404, { ok: false, error: 'Location not found.' });
      return send(res, 200, { ok: true, location, codeChanged: false });
    } catch (e) {
      console.error('[locations/update]', e.message);
      return send(res, 500, { ok: false, error: 'Could not update the shelf.' });
    }
  }

  // --- Move: merge the patch onto the current row, then rebuild the code. ---
  let current;
  try { current = await getLocationById(id); }
  catch (e) {
    console.error('[locations/update]', e.message);
    return send(res, 500, { ok: false, error: 'Could not update the shelf.' });
  }
  if (!current) return send(res, 404, { ok: false, error: 'Location not found.' });

  const warehouse = 'warehouse' in body ? clean(body.warehouse, 80) : current.warehouse;
  const area = 'area' in body ? (clean(body.area, 80) || null) : current.area;
  const bay = 'bay' in body ? clean(body.bay, 40) : current.bay;
  let shelf = current.shelf;
  if ('shelf' in body) {
    const raw = body.shelf;
    if (raw === '' || raw == null) shelf = null;
    else {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 99) return send(res, 400, { ok: false, error: 'Shelf must be a whole number from 1 to 99 (or blank for a whole bay).' });
      shelf = n;
    }
  }
  if (!warehouse) return send(res, 400, { ok: false, error: 'Warehouse is required.' });
  if (!bay) return send(res, 400, { ok: false, error: 'Bay is required.' });

  const code = buildLocationCode({ sitePrefix: sitePrefixFor(warehouse), areaPrefix: areaPrefixFor(area), bayCode: bayCodeFor(bay), shelf });
  // A blank label falls back to the same default create uses, so a moved shelf never
  // keeps a name that describes where it used to be.
  const label = 'label' in body
    ? (clean(body.label, 40) || (shelf ? `${bay}-${pad2(shelf)}` : bay))
    : (current.label || (shelf ? `${bay}-${pad2(shelf)}` : bay));

  try {
    const location = await moveLocation(id, { code, warehouse, area, bay, shelf, label });
    if (!location) return send(res, 404, { ok: false, error: 'Location not found.' });
    return send(res, 200, { ok: true, location, codeChanged: code !== current.code, previousCode: current.code });
  } catch (e) {
    if (/duplicate key|unique/i.test(e.message || '')) {
      return send(res, 409, { ok: false, error: `Another shelf already uses the code “${code}”.` });
    }
    console.error('[locations/update]', e.message);
    return send(res, 500, { ok: false, error: 'Could not update the shelf.' });
  }
}
