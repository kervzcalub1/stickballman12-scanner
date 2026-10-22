// POST /api/po/receipt-attach  { poId, storeId, key, name?, contentType?, sizeBytes?, amount? }
//   -> { ok, receipt }   (supplier on their own store order / ph_team / admin)
// Step 2: record the uploaded receipt against its store. The key must be one receipt-sign
// handed out for THIS order and store — never an arbitrary object in the bucket.
import { getJsonBody, send, applySecurity, rateLimit, requireRole, isPrivileged } from '../_lib/util.js';
import { getPo, getPoStore, addPoStoreReceipt, addPoComment, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['supplier', 'ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const poId = Number(body.poId);
  const storeId = Number(body.storeId);
  const key = String(body.key ?? '').trim();
  if (!Number.isInteger(poId) || !Number.isInteger(storeId)) return send(res, 400, { ok: false, error: 'Pick the store this receipt is from.' });

  try {
    const po = await getPo(poId);
    const st = await getPoStore(storeId);
    if (!po || !st || Number(st.po_id) !== poId) return send(res, 404, { ok: false, error: 'That store is not on this order.' });
    if (user.role === 'supplier' && !isPrivileged(user.role) && Number(po.supplier_user_id) !== Number(user.uid))
      return send(res, 403, { ok: false, error: 'You do not have access to this order.' });
    if (po.audited_at) return send(res, 409, { ok: false, error: `${po.po_code} has been audited — it takes no more receipts.` });
    const esc = String(po.po_code).replace(/[^A-Za-z0-9-]/g, '');
    if (esc !== po.po_code || !new RegExp(`^po-receipts/${esc}/${storeId}-\\d+\\.(jpg|png|webp|heic|pdf)$`).test(key))
      return send(res, 400, { ok: false, error: 'Invalid file key.' });
    const amt = body.amount == null || body.amount === '' ? null : Number(body.amount);
    const uid = Number(user.uid);
    const receipt = await addPoStoreReceipt({
      storeId, key,
      name: String(body.name ?? '').trim().slice(0, 200) || null,
      contentType: String(body.contentType ?? '').slice(0, 100) || null,
      sizeBytes: Number.isInteger(Number(body.sizeBytes)) ? Number(body.sizeBytes) : null,
      amount: Number.isFinite(amt) && amt >= 0 ? Math.round(amt * 100) / 100 : null,
      uploadedBy: user.name || user.username || '', uploadedById: Number.isInteger(uid) ? uid : null,
    });
    await addPoComment({
      poId, kind: 'system', audience: 'internal',
      body: `${st.name}: receipt ${receipt.name || ''} added by ${user.name || user.username || 'someone'}.`.replace('  ', ' '),
      author: { id: Number.isInteger(uid) ? uid : null, name: user.name || user.username || '', role: user.role },
    }).catch(() => { /* non-blocking */ });
    return send(res, 200, { ok: true, receipt: { ...receipt, store_name: st.name } });
  } catch (e) {
    console.error('[po/receipt-attach]', e.message);
    return send(res, 500, { ok: false, error: 'Could not save that receipt.' });
  }
}
