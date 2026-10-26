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
import { gtinValid, upcDigits } from '../../src/lib/gtin.js';
import { resolveUpc } from '../upc-search.js';

// What the UPC step reaches out to — swappable in tests.
export const IO = { resolveUpc };

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
export const RECEIPT_MODEL = process.env.RECEIPT_AI_MODEL || process.env.PAYOUT_AI_MODEL || 'gpt-5.4-mini';
// A receipt is a tall strip of small print. Cropped to the paper and stood upright, its long
// edge gets this many pixels — a whole 22-item Nike Factory receipt shrunk to 1500 px across
// the full photo came back with invented codes (2026-10-27); cropped at 2400 it read every
// total and 16 of 21 UPCs exactly, and the check digit caught the other five.
const MAX_EDGE = 2400;
const TIMEOUT_MS = 45_000;

export const receiptAiConfigured = () => !!process.env.OPENAI_API_KEY;
const aiUrl = () => process.env.RECEIPT_AI_URL || OPENAI_URL;

// No example codes in here: given "e.g. HJ5996-001" the model copied it onto a receipt that
// never printed a style code at all.
export const RECEIPT_PROMPT = `Read this shop receipt and return JSON only, in this exact shape:
{"rows":[{"name":"","upc":"","sku":"","size":"","qty":0,"totalPrice":0}],"subtotal":0,"tax":0,"statedTotal":0,"itemsSold":0}

- One row per item line, in the order printed.
- "name" is the item name as printed.
- "upc" is the long barcode number printed on the item (often 12-14 digits, may start with 00).
  Copy EVERY digit exactly. null if the receipt prints none or you cannot read all of it.
- "sku" is a manufacturer style code ONLY if the receipt prints one (letters+digits with a
  dash). Many receipts print a UPC instead — then "sku" is null. Never make one up.
- "size" is the size printed for the item, null if none.
- "qty" is the quantity for that line (1 when not printed).
- "totalPrice" is what was ACTUALLY CHARGED for that line. When a line shows a gross
  price, then discounts, then a "Final Price" / "Net Price", use that final one. Never the gross.
- "subtotal", "tax", "statedTotal" and "itemsSold" are the receipt's OWN printed figures.
  Use null for any the receipt does not print — never a calculated stand-in, because
  they are what the lines get checked against.
- Copy digits exactly as printed. If a line is not legible, LEAVE IT OUT rather than
  guessing: a missing line is caught by the totals, an invented one is not.`;

/**
 * Where the paper is in the photo: the bounding box of the bright pixels, read off a small
 * greyscale copy. A receipt is the whitest thing in the frame; null when the picture doesn't
 * look like that (mostly bright already, or nothing bright), and then nothing is cropped.
 */
async function paperBox(sharp, buf) {
  const W = 400;
  const { data, info } = await sharp(buf).greyscale().resize({ width: W, height: W, fit: 'inside' }).raw()
    .toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  let bright = 0;
  const cols = new Array(w).fill(0); const rows = new Array(h).fill(0);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (data[y * w + x] >= 185) { bright += 1; cols[x] += 1; rows[y] += 1; }
  }
  const frac = bright / (w * h);
  if (frac < 0.03 || frac > 0.7) return null;
  // A column/row counts as paper when a fair share of it is bright — stray glare doesn't.
  const span = (arr, len) => {
    const need = Math.max(2, Math.round(len * 0.08));
    const first = arr.findIndex((n) => n >= need);
    let last = -1; for (let i = arr.length - 1; i >= 0; i--) if (arr[i] >= need) { last = i; break; }
    return first < 0 ? null : [first, last];
  };
  const xs = span(cols, h); const ys = span(rows, w);
  if (!xs || !ys) return null;
  const pad = 0.015;
  const x0 = Math.max(0, xs[0] / w - pad); const x1 = Math.min(1, (xs[1] + 1) / w + pad);
  const y0 = Math.max(0, ys[0] / h - pad); const y1 = Math.min(1, (ys[1] + 1) / h + pad);
  if ((x1 - x0) * (y1 - y0) > 0.9) return null;   // the paper fills the frame — nothing to crop
  return { x0, x1, y0, y1 };
}

/**
 * The receipt, ready for the model: EXIF-rotated, cropped to the paper, stood upright when it
 * lies on its side (a strip much wider than tall), long edge capped at MAX_EDGE. Falls back to
 * the original bytes if sharp can't read it.
 */
export async function imageForModel(buf) {
  try {
    const sharp = (await import('sharp')).default;
    const upright = await sharp(buf).rotate().toBuffer({ resolveWithObject: true });   // honour EXIF
    let img = upright.data;
    let { width, height } = upright.info;
    const box = await paperBox(sharp, img).catch(() => null);
    if (box) {
      const left = Math.floor(box.x0 * width); const top = Math.floor(box.y0 * height);
      const cw = Math.max(1, Math.min(width - left, Math.ceil((box.x1 - box.x0) * width)));
      const ch = Math.max(1, Math.min(height - top, Math.ceil((box.y1 - box.y0) * height)));
      img = await sharp(img).extract({ left, top, width: cw, height: ch }).toBuffer();
      width = cw; height = ch;
    }
    // Lying on its side: a receipt is a TALL strip, so one much wider than tall is turned.
    let pipe = sharp(img);
    if (width > height * 1.6) pipe = pipe.rotate(90);
    const out = await pipe
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 88 })
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
      size: String(r.size ?? '').trim().replace(/^size:?\s*/i, '').slice(0, 20) || null,
      qty,
      totalPrice,
      unitPrice: totalPrice != null && qty > 0 ? Math.round((totalPrice / qty) * 100) / 100 : null,
      name: String(r.name ?? '').trim().slice(0, 200) || null,
      upc: upcDigits(r.upc).slice(0, 14) || null,
      source: 'ocr',
    };
  // A line with a code of either kind, or at least a price (a UPC that couldn't be read is
  // still a pair that was paid for — the person types its style code).
  }).filter((r) => r.sku || r.upc || r.totalPrice != null);
  const subtotal = num(out.subtotal);
  const statedTotal = num(out.statedTotal);
  const tax = num(out.tax);
  const itemsSold = Number.isFinite(Number(out.itemsSold)) ? Number(out.itemsSold) : null;
  const check = checkReceiptRead({ rows, subtotal, itemsSold, statedTotal, tax });
  return { rows, subtotal, tax, statedTotal, itemsSold, check, model: RECEIPT_MODEL, usage: payload?.usage || null };
}

/**
 * Two independent reads of the same receipt. `agreed` = both returned the same printed
 * total (to the cent). The first read's lines are returned, with every UPC turned into a
 * style code and checked (`resolveReceiptUpcs`, using the second read to repair a misread
 * one); `totals` has both totals.
 */
export async function readReceiptTwice(buf) {
  const img = await imageForModel(buf);
  const [a, b] = await Promise.all([readReceiptOnce(img), readReceiptOnce(img)]);
  const agreed = a.statedTotal != null && b.statedTotal != null && a.statedTotal === b.statedTotal;
  const rows = await resolveReceiptUpcs(a.rows, b.rows);
  const check = checkReceiptRead({ rows, subtotal: a.subtotal, itemsSold: a.itemsSold, statedTotal: a.statedTotal, tax: a.tax });
  if (!agreed && a.statedTotal != null && b.statedTotal != null)
    check.problems.push(`The two readings disagree on the total ($${a.statedTotal.toFixed(2)} vs $${b.statedTotal.toFixed(2)}) — check it against the paper.`);
  check.ok = check.problems.length === 0;
  return { ...a, rows, check, agreed, totals: [a.statedTotal, b.statedTotal] };
}

// ---------------------------------------------------------------- UPCs → style codes
// Receipts from Nike's own stores print a UPC per item, not a style code
// (`NIKE METCON 8 / 00196154520164 Size: 10`). Each UPC is checked three ways before its
// style code is used: its check digit (catches a misread digit), the lookup receiving uses
// (StockX → Nike → our stock → Alias), and the SIZE it names against the size printed. A row
// that fails keeps its price but gets a blank style code and a note — a person types it.

const STOP = new Set(['nike', 'air', 'jordan', 'the', 'and', 'of', 'men', 'mens', 'women', 'womens', 'wmns', 'kids', 'big', 'little', 'shoe', 'shoes', 'og']);
const words = (s) => new Set(String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length >= 2 && !STOP.has(w)));
/** Do the printed name and the catalogue's name share a meaningful word ("metcon", "tatum")? */
export const namesAgree = (printed, catalogue) => {
  const a = words(printed); if (!a.size || !catalogue) return true;   // nothing to compare → not a disagreement
  const b = words(catalogue);
  return [...a].some((w) => b.has(w));
};
/** The printed size vs the size the UPC names: same number (a W/Y/C suffix is extra detail). */
export const sizesAgree = (printed, scanned) => {
  if (!printed || !scanned) return true;
  const n = (v) => parseFloat(String(v).replace(/[^0-9.]/g, ''));
  return n(printed) === n(scanned);
};

async function lookUp(upc, cache) {
  if (!cache.has(upc)) cache.set(upc, IO.resolveUpc(upc).catch(() => null));
  return cache.get(upc);
}

/**
 * `rows` (the read whose lines are used) and `other` (a second read, may be empty) → rows
 * with `sku` filled from the UPC, `size` from the UPC when it agrees (it carries the W/Y/C),
 * and `note` on any row a person must look at.
 */
export async function resolveReceiptUpcs(rows, other = []) {
  const cache = new Map();
  // UPCs from EITHER read that pass the check digit — a misread one in this read is often
  // read right in the other (or on another line of the same shoe).
  const pool = [...rows, ...other].filter((r) => r.upc && gtinValid(r.upc));
  const out = [];
  for (const r of rows) {
    if (!r.upc) { out.push(r); continue; }                // a printed style code, as before
    let upc = r.upc; let repaired = false;
    if (!gtinValid(upc)) {
      // Repair only when ONE other valid UPC fits this line: same printed size and price,
      // and a name that agrees.
      const fits = [...new Set(pool.filter((p) => sizesAgree(r.size, p.size) && p.totalPrice === r.totalPrice
        && namesAgree(r.name, p.name)).map((p) => p.upc))];
      if (fits.length === 1) { upc = fits[0]; repaired = true; }
      else {
        out.push({ ...r, sku: '', note: `UPC read as ${r.upc} fails its check digit — it was misread. Type the style code.` });
        continue;
      }
    }
    const hit = await lookUp(upc, cache);
    if (!hit?.sku) {
      out.push({ ...r, upc, sku: '', note: `UPC ${upc} isn't in StockX, Nike or our stock. Type the style code.` });
      continue;
    }
    if (!sizesAgree(r.size, hit.scannedSize)) {
      out.push({ ...r, upc, sku: '', note: `UPC ${upc} is ${hit.sku} size ${hit.scannedSize}, but the receipt says size ${r.size} — check the UPC and type the style code.` });
      continue;
    }
    const catName = hit.fb?.name || hit.fb?.title || null;
    const note = !namesAgree(r.name, catName)
      ? `UPC ${upc} is “${catName}” — the receipt says “${r.name}”. Check it's the same shoe.`
      : repaired ? `UPC was misread on this line — taken from the other reading (${upc}).` : null;
    out.push({ ...r, upc, sku: hit.sku, size: hit.scannedSize || r.size, ...(note ? { note } : {}) });
  }
  return out;
}
