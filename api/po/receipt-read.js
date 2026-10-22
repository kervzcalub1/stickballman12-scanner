// POST /api/po/receipt-read  { poId, receiptId }  (ph_team / admin; the supplier on a receipt they uploaded)
//   -> { ok, rows, statedTotal, agreed, totals, check, … }
// Reads a store receipt PHOTO with the vision model, TWICE (api/_lib/receipt-ai.js): two
// reads that agree on the printed total prefill it; two that don't are flagged and the
// person types it. Nothing is saved here — the person confirms the total through
// po/audit `receipt_amount`. A PDF is read in the browser (pdfjs), not here.
import { getJsonBody, send, applySecurity, rateLimit, requireRole, isPrivileged } from '../_lib/util.js';
import { getPo, getPoStoreReceipt, dbConfigured } from '../_lib/db.js';
import { getObject, r2Configured } from '../_lib/r2.js';
import { readReceiptTwice, receiptAiConfigured } from '../_lib/receipt-ai.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['supplier', 'ph_team']);
  if (!user) return;
  // Two model calls each: tighter than the uploads.
  if (!rateLimit(req, { windowMs: 60_000, max: 12 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded — wait a minute before reading another.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  if (!receiptAiConfigured()) return send(res, 503, { ok: false, error: 'Reading receipts with AI is not configured on this server.' });
  if (!r2Configured()) return send(res, 503, { ok: false, error: 'File storage is not configured.' });

  const body = await getJsonBody(req);
  const poId = Number(body.poId);
  const receiptId = Number(body.receiptId);
  if (!Number.isInteger(poId) || !Number.isInteger(receiptId)) return send(res, 400, { ok: false, error: 'Which receipt?' });

  try {
    const po = await getPo(poId);
    const r = await getPoStoreReceipt(receiptId);
    if (!po || !r || Number(r.po_id) !== poId || !r.r2_key) return send(res, 404, { ok: false, error: 'That receipt is not on this order.' });
    if (user.role === 'supplier' && !isPrivileged(user.role)
      && (Number(po.supplier_user_id) !== Number(user.uid) || Number(r.uploaded_by_id) !== Number(user.uid)))
      return send(res, 403, { ok: false, error: 'You do not have access to this receipt.' });
    if (String(r.content_type || '').includes('pdf') || /\.pdf$/i.test(r.r2_key))
      return send(res, 409, { ok: false, error: 'That is a PDF — its text is read directly, no AI needed.' });
    const out = await readReceiptTwice(await getObject(r.r2_key));
    return send(res, 200, { ok: true, ...out });
  } catch (e) {
    console.error('[po/receipt-read]', e.message);
    if (e.status) return send(res, e.status, { ok: false, error: e.message });
    return send(res, 500, { ok: false, error: 'Could not read that receipt.' });
  }
}
