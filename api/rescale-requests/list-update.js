// POST /api/rescale-requests/list-update { id, listing:[{size, global_indicator,
//   price, added_to_intel_inv, synced_alias, synced_stockx, synced_shopify}] }
//   -> { ok, request }
// PH records its per-size listing decision (GI + Final price + II/AL/SX/SH) on an
// AUDITED rescale request. Stored on the request itself (requests aren't tied to
// VINs). PH Team + admin only; warehouse never lists.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { updateRescaleRequestListing, dbConfigured } from '../_lib/db.js';

const numOrNull = (v) => {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 1_000_000 ? n : null;
};

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['ph_team']); // admin auto-allowed
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const id = Number(body.id) || 0;
  if (!id) return send(res, 400, { ok: false, error: 'Missing request id.' });

  const listing = (Array.isArray(body.listing) ? body.listing : [])
    .map((e) => ({
      size: String(e.size ?? '').trim().slice(0, 24),
      global_indicator: numOrNull(e.global_indicator),
      price: numOrNull(e.price),
      added_to_intel_inv: !!e.added_to_intel_inv,
      synced_alias: !!e.synced_alias,
      synced_stockx: !!e.synced_stockx,
      synced_shopify: !!e.synced_shopify,
    }))
    .filter((e) => e.size)
    .slice(0, 100);

  try {
    const request = await updateRescaleRequestListing(id, listing, user.name || user.username || '');
    if (!request) return send(res, 404, { ok: false, error: 'Request not found or not audited yet.' });
    return send(res, 200, { ok: true, request });
  } catch (e) {
    console.error('[rescale-requests/list-update]', e.message);
    return send(res, 500, { ok: false, error: 'Could not save the listing.' });
  }
}
