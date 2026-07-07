// POST /api/ph/update  { vin | vins[], fields:{price,global_indicator,
//   added_to_intel_inv,synced_alias,synced_stockx,synced_shopify,ph_note} }
//   ->  { ok, row, rows }
// OR (atomic multi-size group save):
//   POST /api/ph/update  { sizes:[{ vins:[...], fields:{...} }, ...], baseEditedAt }
//   -> { ok, row, rows }
// Saves a PH-Team row edit, logging each changed field to the item's history.
// Accepts a single `vin` OR a `vins[]` array (a consolidated grid row that
// covers several identical units) for a single-fields edit, OR a `sizes[]`
// batch — one `{vins,fields}` entry per SIZE of a PH grid group — which is
// applied as ONE atomic transaction (all sizes commit together, or none do;
// see `phUpdateGroup` in db.js). Restricted to the ph_team and admin roles.
import { getJsonBody, send, applySecurity, rateLimit, requireAuth } from '../_lib/util.js';
import { phUpdateItems, phUpdateGroup, dbConfigured } from '../_lib/db.js';

const BOOL_FIELDS = ['added_to_intel_inv', 'synced_alias', 'synced_stockx', 'synced_shopify'];

// Sanitize one `fields` object server-side (never trust the client). Returns
// `{ fields }` on success or `{ error }` (a client-facing message) on failure.
function sanitizeFields(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const fields = {};
  if ('price' in src) {
    const n = src.price === '' || src.price == null ? null : Number(src.price);
    if (n != null && (!Number.isFinite(n) || n < 0 || n > 1_000_000)) return { error: 'Invalid price.' };
    fields.price = n;
  }
  if ('global_indicator' in src) {
    const n = src.global_indicator === '' || src.global_indicator == null ? null : Number(src.global_indicator);
    if (n != null && (!Number.isFinite(n) || n < 0 || n > 1_000_000)) return { error: 'Invalid global indicator.' };
    fields.global_indicator = n;
  }
  for (const k of BOOL_FIELDS) if (k in src) fields[k] = Boolean(src[k]);
  if ('ph_note' in src) fields.ph_note = String(src.ph_note ?? '').slice(0, 2000);
  return { fields };
}

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireAuth(req, res);
  if (!user) return;
  // Editing the report is PH Team (or superadmin) only — admin and warehouse are read-only.
  if (user.role !== 'ph_team' && user.role !== 'superadmin')
    return send(res, 403, { ok: false, error: 'Only PH Team can edit the report.' });
  if (!rateLimit(req, { windowMs: 60_000, max: 120 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const by = user.name || user.username || '';

  // Optimistic concurrency baseline (the latest last_edit_at the client saw). It is
  // REQUIRED — omitting it used to bypass the conflict check and let a stale client
  // silently overwrite a concurrent edit. The grid always sends it (null or a ts).
  if (!('baseEditedAt' in body))
    return send(res, 400, { ok: false, error: 'Stale edit — reload the grid and try again.' });
  const baseEditedAt = body.baseEditedAt;

  if (Array.isArray(body.sizes)) {
    // Atomic multi-size group save — one entry per size, applied all-or-nothing.
    if (!body.sizes.length) return send(res, 400, { ok: false, error: 'No sizes to save.' });
    if (body.sizes.length > 200) return send(res, 400, { ok: false, error: 'Too many sizes in one update.' });
    const sizeUpdates = [];
    let totalVins = 0;
    for (const s of body.sizes) {
      const vins = (Array.isArray(s?.vins) ? s.vins : [])
        .map((v) => String(v || '').trim().toUpperCase()).filter(Boolean);
      if (!vins.length) continue;
      totalVins += vins.length;
      const { fields, error } = sanitizeFields(s?.fields);
      if (error) return send(res, 400, { ok: false, error });
      sizeUpdates.push({ vins, fields });
    }
    if (!sizeUpdates.length) return send(res, 400, { ok: false, error: 'Missing VIN.' });
    if (totalVins > 1000) return send(res, 400, { ok: false, error: 'Too many items in one update.' });

    try {
      const rows = await phUpdateGroup(sizeUpdates, by, baseEditedAt);
      if (!rows.length) return send(res, 404, { ok: false, error: 'No matching items found.' });
      return send(res, 200, { ok: true, row: rows[0], rows });
    } catch (e) {
      if (e.conflict) return send(res, 409, { ok: false, error: e.message, conflict: true });
      console.error('[ph/update]', e.message);
      return send(res, 500, { ok: false, error: 'Could not save the change.' });
    }
  }

  const vins = (Array.isArray(body.vins) ? body.vins : [body.vin])
    .map((v) => String(v || '').trim().toUpperCase()).filter(Boolean);
  if (!vins.length) return send(res, 400, { ok: false, error: 'Missing VIN.' });
  if (vins.length > 1000) return send(res, 400, { ok: false, error: 'Too many items in one update.' });

  const { fields, error } = sanitizeFields(body.fields);
  if (error) return send(res, 400, { ok: false, error });

  try {
    const rows = await phUpdateItems(vins, fields, by, baseEditedAt);
    if (!rows.length) return send(res, 404, { ok: false, error: 'No matching items found.' });
    return send(res, 200, { ok: true, row: rows[0], rows });
  } catch (e) {
    if (e.conflict) return send(res, 409, { ok: false, error: e.message, conflict: true });
    console.error('[ph/update]', e.message);
    return send(res, 500, { ok: false, error: 'Could not save the change.' });
  }
}
