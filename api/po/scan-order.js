// POST /api/po/scan-order  (ph_team / admin)
//   { poId, sku, size, qty?, name?, upc?, colorway?, gender?, unitCost?, tip? }
// Whole-order manifest (Path C): the supplier gave ONE list for the whole purchase with no
// per-box breakdown, so PH enters it against the PO itself (a po_line with po_box_id NULL)
// rather than a specific label. Flips the PO to manifest_scope='po'. Always on-behalf.
// A PO can't mix a per-box manifest and a whole-order one. Writes only po_lines.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { getPo, poHasBoxLines, addPoOrderScan, setPoManifestScope, dbConfigured } from '../_lib/db.js';
import { money } from '../_lib/po-manifest.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const poId = Number(body.poId);
  const sku = String(body.sku ?? '').trim().slice(0, 60);
  const size = String(body.size ?? '').trim().slice(0, 20);
  const qty = Math.min(999, Math.max(1, parseInt(body.qty, 10) || 1));
  if (!Number.isInteger(poId)) return send(res, 400, { ok: false, error: 'A valid order is required.' });
  if (!sku || !size) return send(res, 400, { ok: false, error: 'SKU and size are required.' });

  try {
    const po = await getPo(poId);
    if (!po) return send(res, 404, { ok: false, error: 'Purchase order not found.' });
    if (po.status !== 'draft')
      return send(res, 409, { ok: false, error: 'This order is already shipped — it can no longer be edited.' });
    if (await poHasBoxLines(poId))
      return send(res, 409, { ok: false, error: 'This PO already has a per-box manifest — add items to a label instead.' });

    // Env admin/superadmin have a non-numeric uid; stamp the flag but leave entered_by NULL.
    const uidNum = Number(user.uid);
    const enteredBy = Number.isInteger(uidNum) ? uidNum : null;

    const line = await addPoOrderScan({
      poId, sku, size, qty,
      name: String(body.name ?? '').trim().slice(0, 200) || null,
      upc: String(body.upc ?? '').trim().slice(0, 40) || null,
      colorway: String(body.colorway ?? '').trim().slice(0, 120) || null,
      gender: String(body.gender ?? '').trim().slice(0, 20) || null,
      unitCost: money(body.unitCost),
      tip: money(body.tip),
      enteredBy,
      enteredOnBehalf: true,
    });
    await setPoManifestScope(poId, 'po');
    return send(res, 200, { ok: true, line });
  } catch (e) {
    console.error('[po/scan-order]', e.message);
    return send(res, 500, { ok: false, error: 'Could not add the item.' });
  }
}
