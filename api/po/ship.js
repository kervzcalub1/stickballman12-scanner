// POST /api/po/ship  (supplier / admin)  { poBoxId }
// Marks one label shipped (must hold ≥1 item). When every label on the PO is
// shipped, the PO flips to 'shipped'. Returns the refreshed full PO.
import { STILL_WITH_SUPPLIER } from '../_lib/po-manifest.js';
import { getJsonBody, send, applySecurity, rateLimit, requireRole, isPrivileged, hideReceivedUnits } from '../_lib/util.js';
import { getPoBox, getPo, countPoBoxLines, countPoOrderLines, shipPoBox, getPoFull,
  getCartIdForPo, getCartPackState, dbConfigured } from '../_lib/db.js';
import { registerTracking } from '../_lib/tracking.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['supplier']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const poBoxId = Number(body.poBoxId);
  if (!Number.isInteger(poBoxId)) return send(res, 400, { ok: false, error: 'A valid label is required.' });

  try {
    const box = await getPoBox(poBoxId);
    if (!box) return send(res, 404, { ok: false, error: 'Label not found.' });
    const po = await getPo(box.po_id);
    if (!po) return send(res, 404, { ok: false, error: 'Purchase order not found.' });
    if (!isPrivileged(user.role) && Number(po.supplier_user_id) !== Number(user.uid))
      return send(res, 403, { ok: false, error: 'You do not have access to this order.' });
    // Same set as close-box: a label still with the supplier hasn't been closed yet, so
    // point at that step rather than claiming it's already shipped.
    if (STILL_WITH_SUPPLIER.includes(box.status))
      return send(res, 409, { ok: false, error: 'Close the box for shipment before shipping it.' });
    if (box.status !== 'packed')
      return send(res, 409, { ok: false, error: 'This label is already shipped.' });
    // "Don't ship an empty box." On a WHOLE-ORDER manifest (Path C) a box holds no lines
    // of its own by design — po/scan refuses per-box lines on such an order — so this
    // check made those orders unshippable by anyone, supplier and admin alike. The
    // declaration is at order level there, so that is what has to be non-empty.
    const declared = po.manifest_scope === 'po'
      ? await countPoOrderLines(po.id)
      : await countPoBoxLines(poBoxId);
    if (declared < 1)
      return send(res, 400, {
        ok: false,
        error: po.manifest_scope === 'po'
          ? 'Nothing has been declared on this order yet.'
          : 'Scan at least one item into this label before shipping it.',
      });

    // A cart-raised order carries a RECEIPT as its ceiling, and under a per-box manifest
    // reconciliation only counts lines on labels that shipped — so a pair that was bought
    // and never packed into any box is not "short", it is absent from the arithmetic
    // entirely, and the order would receive and reconcile perfectly clean while the shoe
    // is nowhere. Shipping the last box is the moment that becomes permanent.
    //
    // Earlier boxes may ship while others are still filling; what is refused is closing
    // the door on unpacked stock.
    const cartId = await getCartIdForPo(po.id);
    if (cartId) {
      const pack = await getCartPackState(cartId);
      const stillFilling = (pack?.boxes || []).some((b) => b.id !== poBoxId && b.status === 'pending');
      if (pack && pack.unpacked > 0 && !stillFilling)
        return send(res, 409, {
          ok: false,
          error: `${pack.unpacked} of ${pack.totalQty} pairs on the receipt are still not packed into a box. Pack them, or add another label to put them in.`,
        });
    }

    await shipPoBox(poBoxId);
    // Start tracking this label's shipment (best-effort; no-ops without a key).
    if (box.tracking_number) registerTracking([{ number: box.tracking_number, carrier: box.carrier_key }]).catch((e) => console.warn('[po/ship] registerTracking:', e.message));
    const data = await getPoFull(box.po_id);
    if (!isPrivileged(user.role)) data.boxes = hideReceivedUnits(data.boxes);
    return send(res, 200, { ok: true, ...data });
  } catch (e) {
    console.error('[po/ship]', e.message);
    return send(res, 500, { ok: false, error: 'Could not ship the label.' });
  }
}
