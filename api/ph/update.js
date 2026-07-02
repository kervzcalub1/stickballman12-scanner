// POST /api/ph/update  { vin | vins[], fields:{price,global_indicator,
//   added_to_intel_inv,synced_alias,synced_stockx,synced_shopify,ph_note} }
//   ->  { ok, row, rows }
// Saves a PH-Team row edit, logging each changed field to the item's history.
// Accepts a single `vin` OR a `vins[]` array (a consolidated grid row that
// covers several identical units). Restricted to the ph_team and admin roles.
import { getJsonBody, send, applySecurity, rateLimit, requireAuth } from '../_lib/util.js';
import { phUpdateItems, dbConfigured } from '../_lib/db.js';

const BOOL_FIELDS = ['added_to_intel_inv', 'synced_alias', 'synced_stockx', 'synced_shopify'];

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireAuth(req, res);
  if (!user) return;
  // Editing the report is PH Team only — admin and warehouse are read-only.
  if (user.role !== 'ph_team')
    return send(res, 403, { ok: false, error: 'Only PH Team can edit the report.' });
  if (!rateLimit(req, { windowMs: 60_000, max: 120 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const vins = (Array.isArray(body.vins) ? body.vins : [body.vin])
    .map((v) => String(v || '').trim().toUpperCase()).filter(Boolean);
  const raw = body.fields && typeof body.fields === 'object' ? body.fields : {};
  if (!vins.length) return send(res, 400, { ok: false, error: 'Missing VIN.' });
  if (vins.length > 1000) return send(res, 400, { ok: false, error: 'Too many items in one update.' });

  // Sanitize the editable fields server-side (never trust the client).
  const fields = {};
  if ('price' in raw) {
    const n = raw.price === '' || raw.price == null ? null : Number(raw.price);
    if (n != null && (!Number.isFinite(n) || n < 0 || n > 1_000_000))
      return send(res, 400, { ok: false, error: 'Invalid price.' });
    fields.price = n;
  }
  if ('global_indicator' in raw) {
    const n = raw.global_indicator === '' || raw.global_indicator == null ? null : Number(raw.global_indicator);
    if (n != null && (!Number.isFinite(n) || n < 0 || n > 1_000_000))
      return send(res, 400, { ok: false, error: 'Invalid global indicator.' });
    fields.global_indicator = n;
  }
  for (const k of BOOL_FIELDS) if (k in raw) fields[k] = Boolean(raw[k]);
  if ('ph_note' in raw) fields.ph_note = String(raw.ph_note ?? '').slice(0, 2000);

  // Optimistic concurrency baseline (the latest last_edit_at the client saw). It is
  // REQUIRED — omitting it used to bypass the conflict check and let a stale client
  // silently overwrite a concurrent edit. The grid always sends it (null or a ts).
  if (!('baseEditedAt' in body))
    return send(res, 400, { ok: false, error: 'Stale edit — reload the grid and try again.' });
  const baseEditedAt = body.baseEditedAt;

  try {
    const rows = await phUpdateItems(vins, fields, user.name || user.username || '', baseEditedAt);
    if (!rows.length) return send(res, 404, { ok: false, error: 'No matching items found.' });
    return send(res, 200, { ok: true, row: rows[0], rows });
  } catch (e) {
    if (e.conflict) return send(res, 409, { ok: false, error: e.message, conflict: true });
    console.error('[ph/update]', e.message);
    return send(res, 500, { ok: false, error: 'Could not save the change.' });
  }
}
