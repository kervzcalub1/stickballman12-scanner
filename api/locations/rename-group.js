// POST /api/locations/rename-group
//   { match: { warehouse, area?, bay?, bayPrefix? }, patch: { warehouse?, area?, bay?, bayPrefix? },
//     dryRun? }
//   -> { ok, count, liveItems, changes: [{ id, label, from, to }], conflicts?, locations? }
//
// Rename or move a WHOLE NODE of the Locations tree at once — a site, an area, a row, or a
// bay — instead of editing its shelves one at a time. `locations` holds one row per SHELF;
// the folder levels are just its distinct `warehouse`/`area`/`bay` values (and Row is derived
// from the bay's leading letters and stored nowhere), so "rename this area" IS "rewrite `area`
// on all 189 shelves under it". That's the whole reason this endpoint exists: doing it through
// the per-shelf editor meant 189 passes.
//
// How much of the path is pinned in `match` decides the scope:
//   { warehouse }                     → the site
//   { warehouse, area }               → one area  (area: null is the real "(no area)" folder)
//   { warehouse, area, bayPrefix }    → one derived row
//   { warehouse, area, bay }          → one bay
// `patch` may rename in place or MOVE the node somewhere else (e.g. patch an area onto a bay
// to relocate that bay). `bayPrefix` in the patch substitutes the prefix on every bay in the
// row, so Row A → Row B rewrites A1…A5 as B1…B5.
//
// The site and area segments are baked into the scannable barcode (MNH-WH-A2-04), so any of
// these reissues the `code` on every shelf underneath and every printed label needs
// reprinting. `dryRun` returns exactly what would change so the UI can say so before you
// commit. Warehouse + admin.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import {
  listLocationGroup, findLocationCodeConflicts, countLiveItemsAt, applyLocationMoves, dbConfigured,
} from '../_lib/db.js';
import {
  buildLocationCode, sitePrefixFor, areaPrefixFor, bayCodeFor, bayRowKey, autoLabelFor,
} from '../_lib/locations.js';

const clean = (s, n) => String(s ?? '').trim().slice(0, n);
// Only the keys actually present in `match` narrow the scope, so `undefined` (absent) and
// `null` (the "(no area)" folder) have to stay distinguishable all the way down.
const pick = (obj, key, max) => (key in obj ? (clean(obj[key], max) || null) : undefined);

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 30 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const m = body.match && typeof body.match === 'object' ? body.match : {};
  const p = body.patch && typeof body.patch === 'object' ? body.patch : {};
  const dryRun = !!body.dryRun;

  const match = {
    warehouse: clean(m.warehouse, 80),
    ...('area' in m ? { area: pick(m, 'area', 80) } : {}),
    ...('bay' in m ? { bay: clean(m.bay, 40) } : {}),
    ...('bayPrefix' in m ? { bayPrefix: clean(m.bayPrefix, 40) } : {}),
  };
  if (!match.warehouse) return send(res, 400, { ok: false, error: 'A warehouse / site is required.' });
  if ('bay' in match && !match.bay) return send(res, 400, { ok: false, error: 'A bay is required.' });
  if ('bayPrefix' in match && !match.bayPrefix) return send(res, 400, { ok: false, error: 'A row is required.' });

  const nextWarehouse = 'warehouse' in p ? clean(p.warehouse, 80) : null;
  const nextArea = 'area' in p ? pick(p, 'area', 80) : undefined;
  const nextBay = 'bay' in p ? clean(p.bay, 40) : null;
  const nextPrefix = 'bayPrefix' in p ? clean(p.bayPrefix, 40) : null;
  if ('warehouse' in p && !nextWarehouse) return send(res, 400, { ok: false, error: 'Enter a warehouse / site name.' });
  if ('bay' in p && !nextBay) return send(res, 400, { ok: false, error: 'Enter a bay name.' });
  if ('bayPrefix' in p && !nextPrefix) return send(res, 400, { ok: false, error: 'Enter a row name.' });
  if (!('warehouse' in p) && nextArea === undefined && !('bay' in p) && !('bayPrefix' in p))
    return send(res, 400, { ok: false, error: 'Nothing to change.' });
  // Renaming a bay only makes sense one bay at a time — a whole row shares a prefix, not a name.
  if ('bay' in p && !('bay' in match))
    return send(res, 400, { ok: false, error: 'Renaming a bay needs a single bay selected.' });

  try {
    const rows = await listLocationGroup(match);
    if (!rows.length) return send(res, 404, { ok: false, error: 'No shelves found here — it may have been renamed already.' });

    const moves = rows.map((r) => {
      const warehouse = nextWarehouse ?? r.warehouse;
      const area = nextArea !== undefined ? nextArea : r.area;
      let bay = r.bay;
      if (nextBay) bay = nextBay;
      else if (nextPrefix) {
        // Substitute just the row prefix, keeping whatever follows it: A1 → B1, A10 → B10.
        const key = bayRowKey(r.bay);
        bay = `${nextPrefix}${String(r.bay).slice(key.length)}`;
      }
      const code = buildLocationCode({
        sitePrefix: sitePrefixFor(warehouse), areaPrefix: areaPrefixFor(area),
        bayCode: bayCodeFor(bay), shelf: r.shelf,
      });
      // A label that still matches the auto default describes the POSITION, so it follows the
      // move; one someone typed is left exactly as it is.
      const label = r.label && r.label !== autoLabelFor(r.bay, r.shelf)
        ? r.label
        : autoLabelFor(bay, r.shelf);
      return { id: Number(r.id), warehouse, area, bay, code, label, from: r.code };
    });

    // Two shelves landing on one code — e.g. merging two bays that both have a shelf 04.
    const seen = new Map();
    for (const mv of moves) {
      if (seen.has(mv.code)) {
        return send(res, 409, {
          ok: false,
          error: `That would put two shelves on the same barcode (${mv.code}). Give them different bay or shelf numbers first.`,
        });
      }
      seen.set(mv.code, mv.id);
    }
    // ...or colliding with a shelf that isn't part of this move.
    const conflicts = await findLocationCodeConflicts([...seen.keys()], moves.map((x) => x.id));
    if (conflicts.length) {
      return send(res, 409, {
        ok: false,
        error: `${conflicts.length === 1 ? 'A shelf' : `${conflicts.length} shelves`} already use that code (${conflicts.slice(0, 3).map((c) => c.code).join(', ')}${conflicts.length > 3 ? '…' : ''}).`,
        conflicts,
      });
    }

    const changed = moves.filter((mv) => mv.code !== mv.from);
    const liveItems = await countLiveItemsAt(moves.map((x) => x.id));
    const changes = moves.map((mv) => ({ id: mv.id, label: mv.label, from: mv.from, to: mv.code }));

    if (dryRun) {
      return send(res, 200, { ok: true, dryRun: true, count: moves.length, changedCount: changed.length, liveItems, changes });
    }

    await applyLocationMoves(moves);
    return send(res, 200, {
      ok: true, count: moves.length, changedCount: changed.length, liveItems, changes,
      // The moved rows, shaped like `locations` list rows, so the client can reprint the
      // affected labels without another round trip.
      locations: moves.map((mv) => ({
        id: String(mv.id), code: mv.code, warehouse: mv.warehouse, area: mv.area,
        bay: mv.bay, label: mv.label,
      })),
    });
  } catch (e) {
    console.error('[locations/rename-group]', e.message);
    if (e.code === '23505') return send(res, 409, { ok: false, error: 'One of those codes is already taken — reload and try again.' });
    return send(res, 500, { ok: false, error: 'Could not rename these shelves.' });
  }
}
