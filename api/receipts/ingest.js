// POST /api/receipts/ingest   header: x-api-key: <RECEIPT_INGEST_KEY>
//   { message_key, mailbox, folder, received_at, from, subject, recipients:{to,cc,delivered_to,original_to},
//     store, store_location:{name,store_number,address,city,state,zip}, order_number,
//     totals:{subtotal,tax,shipping,total}, items:[{name,style_id,sku,upc,size,qty,final_price}], text, warnings }
//   -> 200 { ok, id, duplicate?, buyerMatched? } · 400 bad body · 401 bad key · 503 not configured
//
// The Make "Receipt sweep" scenario files every store receipt it finds in our order
// mailboxes (spam folders included) here, one email per call (docs/context/receipts.md).
// Machine-to-machine: no session, the key IS the credential, compared in constant time.
// It only ever ADDS a row — a duplicate is answered 200 so the sweep's overlapping windows
// are harmless, and nothing here can change or remove a receipt a person already sorted.
import { getJsonBody, send, applySecurity, rateLimit } from '../_lib/util.js';
import { dbConfigured, ingestEmailReceipt } from '../_lib/db.js';
import { ingestKeyOk, ingestConfigured, normalizeReceiptBody } from '../_lib/receipt-ingest.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!ingestConfigured())
    return send(res, 503, { ok: false, error: 'Receipt ingest is not configured (RECEIPT_INGEST_KEY missing on the server).' });
  if (!ingestKeyOk(req.headers['x-api-key'])) return send(res, 401, { ok: false, error: 'Bad or missing API key.' });
  if (!rateLimit(req, { windowMs: 60_000, max: 600 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const r = normalizeReceiptBody(await getJsonBody(req));
  if (!r) return send(res, 400, { ok: false, error: 'message_key is required.' });
  try {
    const out = await ingestEmailReceipt(r);
    return send(res, 200, { ok: true, id: out.id, duplicate: out.duplicate, buyerMatched: !!out.buyerUserId });
  } catch (e) {
    console.error('[receipts/ingest]', e.message);
    return send(res, 500, { ok: false, error: 'Could not file the receipt.' });
  }
}
