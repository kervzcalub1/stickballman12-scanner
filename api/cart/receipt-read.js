// POST /api/cart/receipt-read  { cartId, fileId }  -> { ok, rows, statedTotal, check, … }
//
// Reading an uploaded receipt with a vision model, because tesseract cannot read a
// photograph of one. Measured on a real Athlete's Foot receipt: a 960×1280 phone shot of
// the paper lying on a desk came out at ~132 DPI of grey-on-grey text, and OCR returned
// NOTHING from it. The same image through this endpoint returned all ten lines, all
// nineteen pairs, $1,395, and correctly took the Net Price over the ticket price on
// every discounted row.
//
// THE MODEL IS A READER, NOT A DECIDER. Everything it returns lands in the same editable
// table the parser's rows land in, and nothing is committed until a person has looked —
// that rule does not soften because the reading got better. If anything it matters more:
// tesseract fails visibly and this fails cleanly, returning a well-formed row with a
// plausible code and a plausible price. On a money screen a plausible wrong number is
// the worst possible output.
//
// So the receipt is made to check itself (`src/lib/receiptCheck.js`): the rows must add
// up to the subtotal the till printed, and the quantities to its item count. That is
// arithmetic off the paper, not trust in the model.
//
// The key never leaves the server, the image is fetched from OUR bucket rather than
// posted up again by the phone, and it is downscaled first — a receipt needs nothing
// like a modern camera's resolution to be legible, and image tokens are what the call
// actually costs.
import { getJsonBody, send, applySecurity, rateLimit, requireRole, isPrivileged } from '../_lib/util.js';
import { getBuyCart, getBuyCartFile, logCartEvent, dbConfigured } from '../_lib/db.js';
import { cartVisibleTo, requireBuyerAccess } from '../_lib/buycart.js';
import { getObject, r2Configured } from '../_lib/r2.js';
import { imageForModel, readReceiptOnce, receiptAiConfigured, RECEIPT_MODEL as MODEL } from '../_lib/receipt-ai.js';

// The model call itself lives in api/_lib/receipt-ai.js, shared with store-order receipts.
export { receiptAiConfigured };

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['supplier', 'warehouse', 'ph_team']);
  if (!user) return;
  if (!(await requireBuyerAccess(req, res, user))) return;
  // Tighter than the upload: this one costs money on every call, and it is a read of a
  // document the caller has to be allowed to act on anyway.
  if (!rateLimit(req, { windowMs: 60_000, max: 12 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded — wait a minute before reading another.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  if (!receiptAiConfigured())
    return send(res, 503, { ok: false, error: 'Reading receipts with AI is not configured on this server.' });
  if (!r2Configured()) return send(res, 503, { ok: false, error: 'File storage is not configured.' });

  const body = await getJsonBody(req);
  const cartId = Number(body.cartId);
  const fileId = Number(body.fileId);
  if (!Number.isInteger(cartId) || !Number.isInteger(fileId))
    return send(res, 400, { ok: false, error: 'Which receipt?' });

  try {
    const cart = await getBuyCart(cartId);
    if (!cart) return send(res, 404, { ok: false, error: 'That buying request does not exist.' });
    if (!cartVisibleTo(user, cart)) return send(res, 403, { ok: false, error: 'You do not have access to this request.' });
    if (user.role === 'supplier' && !isPrivileged(user.role) && Number(cart.buyer_user_id) !== Number(user.uid))
      return send(res, 403, { ok: false, error: 'You do not have access to this request.' });

    const file = await getBuyCartFile(cartId, fileId);
    if (!file || file.kind !== 'receipt')
      return send(res, 404, { ok: false, error: 'That receipt is not on this request.' });
    // A PDF already has text in it — `manifestImport`'s machinery reads that on the
    // client for free, and paying a model to look at a picture of text we can already
    // extract would be spending money to lose accuracy.
    if (String(file.content_type || '').includes('pdf'))
      return send(res, 409, { ok: false, error: 'That is a PDF — its text is read directly, no AI needed.' });

    const { rows, subtotal, tax, statedTotal, itemsSold, check, usage } =
      await readReceiptOnce(await imageForModel(await getObject(file.r2_key)));

    await logCartEvent({
      cartId, kind: 'receipt_ai_read', actor: user,
      body: `${rows.length} lines read from “${file.name || 'receipt'}” by ${MODEL}`
        + (check.ok ? ' · agrees with the receipt’s own totals' : ` · ${check.problems.length} discrepancy(ies) flagged`),
    });

    return send(res, 200, {
      ok: true, rows, subtotal, tax, statedTotal, itemsSold, check, model: MODEL,
      usage,
    });
  } catch (e) {
    console.error('[cart/receipt-read]', e.message);
    if (e.status) return send(res, e.status, { ok: false, error: e.message.replace('type it in', 'paste the text') });
    return send(res, 500, { ok: false, error: 'Could not read that receipt.' });
  }
}
