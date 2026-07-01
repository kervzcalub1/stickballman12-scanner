// POST /api/locations/bulk { warehouse, area?, entries:[{ bay, shelves }] }
//   -> { ok, inserted, total }
// Bulk-add shelves (e.g. seed a new warehouse's rows). Each entry generates
// shelf 1..N for its bay (shelves = 0 → one whole-bay spot). Idempotent — codes
// that already exist are skipped. Warehouse + admin.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { bulkCreateLocations, dbConfigured } from '../_lib/db.js';
import { buildLocationCode, sitePrefixFor, areaPrefixFor, bayCodeFor, pad2 } from '../_lib/locations.js';

const clean = (s, n) => String(s ?? '').trim().slice(0, n);
const MAX = 2000;

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 30 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const warehouse = clean(body.warehouse, 80);
  const area = clean(body.area, 80) || null;
  const entries = (Array.isArray(body.entries) ? body.entries : [])
    .map((e) => ({ bay: clean(e.bay, 40), shelves: Math.max(0, Math.min(99, Number(e.shelves) || 0)) }))
    .filter((e) => e.bay);
  if (!warehouse) return send(res, 400, { ok: false, error: 'Warehouse is required.' });
  if (!entries.length) return send(res, 400, { ok: false, error: 'Add at least one bay.' });

  const sitePrefix = sitePrefixFor(warehouse);
  const areaPrefix = areaPrefixFor(area);
  const list = [];
  let sort = 0;
  for (const e of entries) {
    const bayCode = bayCodeFor(e.bay);
    if (e.shelves === 0) {
      list.push({ code: buildLocationCode({ sitePrefix, areaPrefix, bayCode, shelf: null }), warehouse, area, bay: e.bay, shelf: null, label: e.bay, sort_order: sort++ });
    } else {
      for (let s = 1; s <= e.shelves; s++) {
        list.push({ code: buildLocationCode({ sitePrefix, areaPrefix, bayCode, shelf: s }), warehouse, area, bay: e.bay, shelf: s, label: `${e.bay}-${pad2(s)}`, sort_order: sort++ });
      }
    }
  }
  if (list.length > MAX) return send(res, 400, { ok: false, error: `That's ${list.length} shelves — too many at once (max ${MAX}).` });

  try {
    const { inserted, total } = await bulkCreateLocations(list, user.name || user.username || '');
    return send(res, 200, { ok: true, inserted, total });
  } catch (e) {
    console.error('[locations/bulk]', e.message);
    return send(res, 500, { ok: false, error: 'Could not add the shelves.' });
  }
}
