// POST /api/po/receipt-sign  { poId, storeId, contentType } -> { ok, uploadUrl, key }
// (supplier on their own store order / ph_team / admin)
//
// Step 1 of attaching a store's receipt (a photo or a PDF) to a store order — the same
// presigned-PUT pattern as a buying request's files (api/cart/file-sign.js): the phone
// sends the bytes straight to our bucket, then po/receipt-attach records it. R2's presign
// can't enforce a size, so the client refuses anything over 15 MB before asking.
// docs/store-orders-plan.md §4.6.
import { getJsonBody, send, applySecurity, rateLimit, requireRole, isPrivileged } from '../_lib/util.js';
import { getPo, getPoStore, dbConfigured } from '../_lib/db.js';
import { presignPutUrl, r2Configured } from '../_lib/r2.js';

export const RECEIPT_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'application/pdf': 'pdf' };

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['supplier', 'ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  if (!r2Configured()) return send(res, 503, { ok: false, error: 'File storage is not configured (R2 env vars missing).' });

  const body = await getJsonBody(req);
  const poId = Number(body.poId);
  const storeId = Number(body.storeId);
  const contentType = RECEIPT_EXT[body.contentType] ? body.contentType : null;
  if (!Number.isInteger(poId) || !Number.isInteger(storeId)) return send(res, 400, { ok: false, error: 'Pick the store this receipt is from.' });
  if (!contentType) return send(res, 400, { ok: false, error: 'Upload a photo or a PDF of the receipt.' });

  try {
    const po = await getPo(poId);
    const st = await getPoStore(storeId);
    if (!po || !st || Number(st.po_id) !== poId) return send(res, 404, { ok: false, error: 'That store is not on this order.' });
    if (user.role === 'supplier' && !isPrivileged(user.role) && Number(po.supplier_user_id) !== Number(user.uid))
      return send(res, 403, { ok: false, error: 'You do not have access to this order.' });
    if (po.audited_at) return send(res, 409, { ok: false, error: `${po.po_code} has been audited — it takes no more receipts.` });
    const key = `po-receipts/${po.po_code}/${storeId}-${Date.now()}.${RECEIPT_EXT[contentType]}`;
    return send(res, 200, { ok: true, uploadUrl: presignPutUrl({ key, expiresIn: 300 }), key });
  } catch (e) {
    console.error('[po/receipt-sign]', e.message);
    return send(res, 500, { ok: false, error: 'Could not prepare that upload.' });
  }
}
