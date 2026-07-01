// POST /api/locations/create { warehouse, area?, bay, shelf? } -> { ok, location }
// Add one shelf (manual). The code is built server-side from the parts. Whole-bay
// spots pass no shelf. Warehouse + admin.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { createLocation, dbConfigured } from '../_lib/db.js';
import { buildLocationCode, sitePrefixFor, areaPrefixFor, bayCodeFor, pad2 } from '../_lib/locations.js';

const clean = (s, n) => String(s ?? '').trim().slice(0, n);

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const warehouse = clean(body.warehouse, 80);
  const area = clean(body.area, 80) || null;
  const bay = clean(body.bay, 40);
  const shelfRaw = body.shelf;
  const shelf = shelfRaw === '' || shelfRaw == null ? null : Math.max(1, Math.min(99, Number(shelfRaw) || 0));
  if (!warehouse) return send(res, 400, { ok: false, error: 'Warehouse is required.' });
  if (!bay) return send(res, 400, { ok: false, error: 'Bay is required.' });
  if (shelfRaw !== '' && shelfRaw != null && !Number.isInteger(shelf)) return send(res, 400, { ok: false, error: 'Shelf must be a number.' });

  const code = buildLocationCode({ sitePrefix: sitePrefixFor(warehouse), areaPrefix: areaPrefixFor(area), bayCode: bayCodeFor(bay), shelf });
  const label = clean(body.label, 40) || (shelf ? `${bay}-${pad2(shelf)}` : bay);

  try {
    const location = await createLocation({ code, warehouse, area, bay, shelf, label }, user.name || user.username || '');
    if (!location) return send(res, 409, { ok: false, error: `A shelf with code “${code}” already exists.` });
    return send(res, 200, { ok: true, location });
  } catch (e) {
    console.error('[locations/create]', e.message);
    return send(res, 500, { ok: false, error: 'Could not add the shelf.' });
  }
}
