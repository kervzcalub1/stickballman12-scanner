// Reading a shop receipt with a vision model — shared by the buying request's receipt
// (api/cart/receipt-read.js, one read) and a store order's receipts (api/po/receipt-read.js,
// read TWICE). The full reasoning is at the top of cart/receipt-read.js: tesseract can't
// read a phone photo of a receipt; the model can, and is a READER, never a decider —
// everything it returns is shown to a person, and the receipt is made to check itself
// (`src/lib/receiptCheck.js`).
//
// Twice, on a store order (docs/store-orders-plan.md §4.6): the total is what Kevin audits
// the card statement against, and the cancellations reader showed a single read can come
// back with a wrong digit at high confidence. Two independent reads that agree on the total
// are worth trusting a little more; two that disagree are flagged, and the person types it.
//
// `RECEIPT_AI_URL` points the reader somewhere else (the e2e suite runs a fake on
// localhost, so a test run never spends OpenAI money). Same contract as CANCEL_AI_URL.
import { checkReceiptRead } from '../../src/lib/receiptCheck.js';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
export const RECEIPT_MODEL = process.env.RECEIPT_AI_MODEL || process.env.PAYOUT_AI_MODEL || 'gpt-5.4-mini';
const MAX_EDGE = 1500;
const TIMEOUT_MS = 45_000;

export const receiptAiConfigured = () => !!process.env.OPENAI_API_KEY;
const aiUrl = () => process.env.RECEIPT_AI_URL || OPENAI_URL;

export const RECEIPT_PROMPT = `Read this shop receipt and return JSON only, in this exact shape:
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

/** Shrink an image for the model. Falls back to the original bytes if sharp can't. */
export async function imageForModel(buf) {
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

// Errors carry `status` (502 the reader failed / answered nonsense, 504 timed out) so the
// endpoints can hand back the same words they always did.
const fail = (status, message) => Object.assign(new Error(message), { status });
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) / 100 : null; };

/** One read of an already-shrunk image → the normalised receipt. */
export async function readReceiptOnce({ b64, mime }) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let payload;
  try {
    const r = await fetch(aiUrl(), {
      method: 'POST',
      signal: ac.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: RECEIPT_MODEL,
        response_format: { type: 'json_object' },
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: RECEIPT_PROMPT },
            { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
          ],
        }],
      }),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      console.error('[receipt-ai] reader', r.status, detail.slice(0, 300));
      throw fail(502, 'The reader did not answer. Try again, or type it in instead.');
    }
    payload = await r.json();
  } catch (e) {
    if (e.name === 'AbortError') throw fail(504, 'The reader took too long. Try again, or type it in instead.');
    throw e;
  } finally { clearTimeout(timer); }

  let out;
  try { out = JSON.parse(payload?.choices?.[0]?.message?.content || '{}'); }
  catch { throw fail(502, 'The reader answered with something unreadable. Type it in instead.'); }

  const rows = (Array.isArray(out.rows) ? out.rows : []).slice(0, 300).map((r) => {
    const qty = Math.min(Math.max(parseInt(r.qty, 10) || 1, 1), 999);
    const totalPrice = num(r.totalPrice);
    return {
      sku: String(r.sku ?? '').trim().toUpperCase().slice(0, 40),
      size: String(r.size ?? '').trim().slice(0, 20) || null,
      qty,
      totalPrice,
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
  return { rows, subtotal, tax, statedTotal, itemsSold, check, model: RECEIPT_MODEL, usage: payload?.usage || null };
}

/**
 * Two independent reads of the same receipt. `agreed` = both returned the same printed
 * total (to the cent). The first read's lines are returned; `totals` has both.
 */
export async function readReceiptTwice(buf) {
  const img = await imageForModel(buf);
  const [a, b] = await Promise.all([readReceiptOnce(img), readReceiptOnce(img)]);
  const agreed = a.statedTotal != null && b.statedTotal != null && a.statedTotal === b.statedTotal;
  return { ...a, agreed, totals: [a.statedTotal, b.statedTotal] };
}
