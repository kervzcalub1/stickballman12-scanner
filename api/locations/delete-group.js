// POST /api/locations/delete-group
//   { match: { warehouse, area?, bay?, bayPrefix? }, dryRun? }
//   -> { ok, count, deleted, liveItems, detached, shelves: [{ id, code, label }] }
//
// Delete a WHOLE NODE of the Locations tree — a site, an area, a row, or a bay — instead of
// removing its shelves one at a time. Same reason `rename-group` exists: `locations` holds one
// row per SHELF, and Site / Area / Bay are just its distinct `warehouse`/`area`/`bay` values
// (Row is derived from the bay's leading letters and stored nowhere), so "delete this area" IS
// "delete all 189 shelves under it". `match` is scoped exactly as in rename-group:
//   { warehouse } = the site · +area = one area · +bayPrefix = one row · +bay = one bay.
//
// Live stock anywhere beneath BLOCKS the whole delete (409) — nothing is removed, because a
// half-deleted rack is worse than a refusal. Sold/shipped units are detached and keep their
// `location_code` as history. `dryRun` returns the same counts without writing, so the confirm
// can say how many shelves and pairs are involved before you commit. Warehouse + admin.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { listLocationGroup, deleteLocationGroup, dbConfigured } from '../_lib/db.js';

const clean = (s, n) => String(s ?? '').trim().slice(0, n);
// Only the keys actually present in `match` narrow the scope, so `undefined` (absent) and
// `null` (the "(no area)" folder) have to stay distinguishable.
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

  try {
    const rows = await listLocationGroup(match);
    if (!rows.length) return send(res, 404, { ok: false, error: 'No shelves found here — it may have been renamed or removed already.' });

    const ids = rows.map((r) => Number(r.id));
    const r = await deleteLocationGroup(ids, { dryRun });
    if (r.blocked) {
      return send(res, 409, {
        ok: false,
        error: `${r.live} pair${r.live === 1 ? ' is' : 's are'} still shelved here. Move them to another shelf first — nothing was deleted.`,
        itemCount: r.live,
      });
    }
    return send(res, 200, {
      ok: true,
      dryRun,
      count: rows.length,
      deleted: r.deleted,
      liveItems: r.live,
      detached: r.detached,
      shelves: rows.map((x) => ({ id: String(x.id), code: x.code, label: x.label })),
    });
  } catch (e) {
    console.error('[locations/delete-group]', e.message);
    return send(res, 500, { ok: false, error: 'Could not delete these shelves.' });
  }
}
