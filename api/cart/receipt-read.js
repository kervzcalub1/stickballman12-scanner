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
import { cartVisibleTo } from '../_lib/buycart.js';
import { getObject, r2Configured } from '../_lib/r2.js';
import { checkReceiptRead } from '../../src/lib/receiptCheck.js';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = process.env.RECEIPT_AI_MODEL || process.env.PAYOUT_AI_MODEL || 'gpt-5.4-mini';
// A receipt is a column of text. Past ~1500px on the long edge the model reads no better
// and every extra pixel is billed, so this is a cost bound rather than a quality one.
const MAX_EDGE = 1500;
const TIMEOUT_MS = 45_000;

export const receiptAiConfigured = () => !!process.env.OPENAI_API_KEY;

const PROMPT = `Read this shop receipt and return JSON only, in this exact shape:
{"rows":[{"sku":"","size":"","qty":0,"totalPrice":0}],"subtotal":0,"tax":0,"statedTotal":0,"itemsSold":0}

- "sku" is the manufacturer style code printed on the line (e.g. IM4613-400, HJ5996-001).
- "qty" is the quantity column for that line.
- "totalPrice" is what was ACTUALLY CHARGED for that line. When a line shows a gross
  price, then a Discount, then a "Net Price", use the NET price. Never the gross.
- "subtotal", "tax", "statedTotal" and "itemsSold" are the receipt's OWN printed figures.
  Use null for any the receipt does not print — never a calculated stand-in, because
  they are what the lines get checked against.
- Copy digits exactly as printed. If a line is not legible, LEAVE IT OUT rather than
  guessing: a missing line is caught by the totals, an invented one is not.`;

/** Fetch from our bucket and shrink. Falls back to the original bytes if sharp can't. */
async function imageForModel(key) {
  const buf = await getObject(key);   // already a Buffer
  try {
    const sharp = (await import('sharp')).default;
    const out = await sharp(buf)
      .rotate()                            // honour EXIF, or a phone-held-sideways receipt arrives on its side
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer();
    return { b64: out.toString('base64'), mime: 'image/jpeg' };
  } catch {
    return { b64: buf.toString('base64'), mime: 'image/jpeg' };
  }
}

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['supplier', 'warehouse', 'ph_team']);
  if (!user) return;
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

    const { b64, mime } = await imageForModel(file.r2_key);

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    let payload;
    try {
      const r = await fetch(OPENAI_URL, {
        method: 'POST',
        signal: ac.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        body: JSON.stringify({
          model: MODEL,
          response_format: { type: 'json_object' },
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: PROMPT },
              { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
            ],
          }],
        }),
      });
      if (!r.ok) {
        const detail = await r.text().catch(() => '');
        console.error('[cart/receipt-read] openai', r.status, detail.slice(0, 300));
        return send(res, 502, { ok: false, error: 'The reader did not answer. Try again, or paste the text instead.' });
      }
      payload = await r.json();
    } finally { clearTimeout(timer); }

    let out;
    try { out = JSON.parse(payload?.choices?.[0]?.message?.content || '{}'); }
    catch { return send(res, 502, { ok: false, error: 'The reader answered with something unreadable. Paste the text instead.' }); }

    const num = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) / 100 : null; };
    const rows = (Array.isArray(out.rows) ? out.rows : []).slice(0, 300).map((r) => {
      const qty = Math.min(Math.max(parseInt(r.qty, 10) || 1, 1), 999);
      const totalPrice = num(r.totalPrice);
      return {
        sku: String(r.sku ?? '').trim().toUpperCase().slice(0, 40),
        size: String(r.size ?? '').trim().slice(0, 20) || null,
        qty,
        totalPrice,
        // Derived here, never asked for: a unit price the model states separately is a
        // second number that can disagree with the two it was derived from.
        unitPrice: totalPrice != null && qty > 0 ? Math.round((totalPrice / qty) * 100) / 100 : null,
        name: String(r.name ?? '').trim().slice(0, 200) || null,
        source: 'ocr',
      };
    }).filter((r) => r.sku);

    const subtotal = num(out.subtotal);
    const statedTotal = num(out.statedTotal);
    const tax = num(out.tax);
    const itemsSold = Number.isFinite(Number(out.itemsSold)) ? Number(out.itemsSold) : null;
    const check = checkReceiptRead({ rows, subtotal, itemsSold, statedTotal, tax });

    // On the trail, because a machine reading is a fact about how these numbers got here.
    // Whether it AGREED with the receipt is part of that fact, not a detail.
    await logCartEvent({
      cartId, kind: 'receipt_ai_read', actor: user,
      body: `${rows.length} lines read from “${file.name || 'receipt'}” by ${MODEL}`
        + (check.ok ? ' · agrees with the receipt’s own totals' : ` · ${check.problems.length} discrepancy(ies) flagged`),
    });

    return send(res, 200, {
      ok: true, rows, subtotal, tax, statedTotal, itemsSold, check, model: MODEL,
      usage: payload?.usage || null,
    });
  } catch (e) {
    const aborted = e.name === 'AbortError';
    console.error('[cart/receipt-read]', e.message);
    return send(res, aborted ? 504 : 500, {
      ok: false,
      error: aborted ? 'The reader took too long. Try again, or paste the text instead.' : 'Could not read that receipt.',
    });
  }
}
