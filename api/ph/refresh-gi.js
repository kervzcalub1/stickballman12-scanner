// POST /api/ph/refresh-gi  { vins:[…] }  ->  { ok, updated, checked, configured }
// Re-fetches the Alias Global Indicator for the given items and recomputes each
// Final price (GI + 20%), preserving PH-typed manual price overrides. Powers the
// "Refresh prices" button on the PH Report / New Inventory grid. PH Team + admin
// only (pricing is hidden from warehouse). Alias calls are deduped by catalog+size.
import { getJsonBody, send, applySecurity, rateLimit, requireAuth } from '../_lib/util.js';
import { getItemsForGiRefresh, dbConfigured } from '../_lib/db.js';
import { refreshGiForItems } from '../_lib/intake.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireAuth(req, res);
  if (!user) return;
  // Pricing is hidden from warehouse — only PH Team, admin, and superadmin can re-price.
  if (user.role !== 'ph_team' && user.role !== 'admin' && user.role !== 'superadmin')
    return send(res, 403, { ok: false, error: 'Not allowed to refresh prices.' });
  // Alias-heavy — keep this well throttled.
  if (!rateLimit(req, { windowMs: 60_000, max: 6 }))
    return send(res, 429, { ok: false, error: 'Please wait a moment before refreshing again.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const vins = (Array.isArray(body.vins) ? body.vins : [])
    .map((v) => String(v || '').trim().toUpperCase()).filter(Boolean);
  if (!vins.length) return send(res, 400, { ok: false, error: 'No items to refresh.' });
  if (vins.length > 2000) return send(res, 400, { ok: false, error: 'Too many items to refresh at once (max 2000).' });

  try {
    const rows = await getItemsForGiRefresh(vins);
    const result = await refreshGiForItems(rows, { preserveOverrides: true });
    if (!result.configured)
      return send(res, 200, { ok: true, configured: false, updated: 0, checked: 0 });
    return send(res, 200, { ok: true, configured: true, updated: result.updated, checked: result.checked });
  } catch (e) {
    console.error('[ph/refresh-gi]', e.message);
    return send(res, 500, { ok: false, error: 'Could not refresh prices. Please try again.' });
  }
}
