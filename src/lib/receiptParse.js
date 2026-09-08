// Reading a shop receipt into lines, so twenty-four pairs don't get typed in by hand.
//
// This is a different job from `batchParse.js`, which reads a seller's size run. A
// receipt is a till printout: one row per item, with a style code somewhere on it, a
// size, a quantity and — the part that matters here — money. Two prices, in fact, and
// telling them apart is most of the work: `2 @ 84.99` and `169.98` on the same row are
// the same fact stated twice, and reading the second as a unit price doubles the spend.
//
// **Nothing here decides anything.** Every row lands in an editable table before it is
// committed, exactly like batch analysis, because a receipt read wrong is a
// reconciliation that quietly balances against the wrong number. OCR makes that more
// true, not less: a thermal receipt photographed in a car park will mis-read a digit,
// and the review step is what catches it.
//
// Three sources, one parser: pasted text, text pulled out of a PDF with pdfjs (the same
// machinery `manifestImport.js` already uses), and OCR of a photo via tesseract. They
// differ only in how the text arrives; `source` is carried through so a line can say
// where it came from when somebody questions it.

const MAX_ROWS = 300;

// A style code, same family as batchParse's but ANCHORED differently: on a receipt the
// code sits inside a longer line of product text, so this matches anywhere.
// Nike/Jordan write `DD1391-100`, adidas `IE7002`, and some tills separate with a space.
const SKU_RE = /\b([A-Z]{1,2}[A-Z0-9]{3,9}-[A-Z0-9]{2,5}|[A-Z]{2}\d{4,6})\b/;
// A bare all-numeric style with a hyphen (`315121-115`) — Nike's older codes.
const NUM_SKU_RE = /\b(\d{6}-\d{3})\b/;
// `Size 9.5`, `SZ 10W`, `US 8`, or a lone `9.5` sitting in its own column.
const SIZE_RE = /\b(?:size|sz|us)\s*[:.]?\s*([0-9]{1,2}(?:\.[05])?\s*[CYWMcywm]?)\b/i;
const BARE_SIZE_RE = /(?:^|\s)([0-9]{1,2}\.[05]|[0-9]{1,2})\s*([CYWcyw])?(?=\s|$)/;
// `2 @ 84.99` / `2 x 84.99` / `QTY 2` — the quantity and, when the till prints it, the
// unit price beside it. This is the row shape worth trusting most: it states both.
const QTY_AT_RE = /\b(\d{1,3})\s*(?:@|x|×)\s*\$?\s*([0-9,]+\.\d{2})\b/i;
const QTY_RE = /\b(?:qty|quantity)\s*[:.]?\s*(\d{1,3})\b/i;
// Every money-looking token on the line. Order matters — a till prints the line total
// last, which is why the LAST one is taken as the total when nothing better is on offer.
const MONEY_RE = /\$?\s*([0-9]{1,3}(?:,[0-9]{3})*\.[0-9]{2})\b/g;
// Rows that are not merchandise. A receipt is mostly this.
const NOISE_RE = /^\s*(?:subtotal|sub-total|total|tax|sales\s*tax|change|cash|visa|mastercard|amex|discover|gift\s*card|balance|tender|auth|approval|ref|trace|merchant|store\s*#|cashier|register|thank|return|policy|survey|www\.|http|member|rewards?|points?|savings?|you\s+saved|discount|coupon|promo|shipping|handling|order\s*#|invoice|date|time|phone|associate)\b/i;

const money = (v) => {
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : undefined;
};
const normSize = (raw) => String(raw ?? '').trim().replace(/\s+/g, '').replace(',', '.').toUpperCase() || null;
const normSku = (raw) => String(raw ?? '').trim().toUpperCase().replace(/[ \t]+/g, '-');

// A receipt's own stated total, so the reconciliation checks against what the shop
// says rather than against our sum of its rows. When they disagree, that IS the
// finding — a line we misread, or something on the receipt we didn't count.
export function receiptTotalFrom(text) {
  const lines = String(text || '').split(/\r?\n/);
  let grand = null; let plain = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^\s*(?:grand\s+total|total\s+due|amount\s+due|order\s+total)\b/i.test(line)) {
      const m = [...line.matchAll(MONEY_RE)].pop();
      if (m) grand = money(m[1]);
    } else if (/^\s*total\b/i.test(line) && !/subtotal/i.test(line)) {
      const m = [...line.matchAll(MONEY_RE)].pop();
      if (m && plain == null) plain = money(m[1]);
    }
  }
  // A "Grand total" wins over a bare "Total": some tills print both, and the bare one
  // is the pre-tax subtotal under another name.
  return grand ?? plain ?? null;
}

// Money, size and quantity off a line — the numeric half of an item, wherever it sits.
//
// The unit-vs-total rule, which is most of the care in this file:
//  · `2 @ 84.99` states the UNIT price outright — take it, and prefer a total the till
//    actually printed over one we multiply (a three-for-two promo rounds on the
//    receipt, not in our arithmetic).
//  · Otherwise, take the LAST money token as the line total and divide by the quantity.
//    Tills print the extended price last, and dividing a total is safe where
//    multiplying a misread unit price is not.
function readAmounts(line, skuText) {
  // Look for the size AFTER the style code where there is one: a code like
  // `DD1391-100` is full of digits a bare-size pattern would happily eat.
  const rest = skuText && line.includes(skuText) ? line.slice(line.indexOf(skuText) + skuText.length) : line;
  const sizeM = line.match(SIZE_RE) || rest.match(BARE_SIZE_RE);
  const size = sizeM ? normSize(sizeM[1] + (sizeM[2] || '')) : null;

  const qtyAt = line.match(QTY_AT_RE);
  const qtyM = line.match(QTY_RE);
  const qty = qtyAt ? Number(qtyAt[1]) : (qtyM ? Number(qtyM[1]) : 1);

  const monies = [...line.matchAll(MONEY_RE)].map((m) => money(m[1])).filter((n) => n != null);
  let unitPrice; let totalPrice;
  if (qtyAt) {
    unitPrice = money(qtyAt[2]);
    const printed = monies.filter((n) => n !== unitPrice).pop();
    totalPrice = printed ?? Math.round(unitPrice * qty * 100) / 100;
  } else if (monies.length) {
    totalPrice = monies[monies.length - 1];
    unitPrice = qty > 0 ? Math.round((totalPrice / qty) * 100) / 100 : totalPrice;
  }
  return { size, qty: qty > 0 ? Math.min(qty, 999) : 1, unitPrice: unitPrice ?? null, totalPrice: totalPrice ?? null };
}

// Whatever is left once the code, the sizes and the money are gone. Rough on purpose —
// it is a label for the person checking the table, never something matched on.
function readName(line, skuText) {
  return String(line)
    .replace(skuText || '', ' ')
    .replace(MONEY_RE, ' ')
    .replace(/\b(?:size|sz|us|qty|quantity)\s*[:.]?\s*[0-9.]+\s*[CYWMcywm]?\b/gi, ' ')
    .replace(/\b\d{1,3}\s*(?:@|x|×)\s*\S+/gi, ' ')
    .replace(/[|·•]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim().slice(0, 120) || null;
}

// The style code on a line, with the exact text that matched (needed to slice it back out).
function readSku(line) {
  const m = line.match(SKU_RE) || line.match(NUM_SKU_RE);
  return m ? { sku: normSku(m[1]), text: m[1] } : null;
}

/**
 * One SINGLE-LINE receipt row → an item, or null if it isn't merchandise. Exported for
 * the tests and for the review table's "re-read this row" action; the whole-receipt
 * parser below handles the far more common two-line shape.
 */
export function parseReceiptLine(raw, { source = 'paste' } = {}) {
  const line = String(raw || '').trim();
  if (!line || NOISE_RE.test(line)) return null;
  const found = readSku(line);
  if (!found) return null;
  const amt = readAmounts(line, found.text);
  if (amt.totalPrice == null) return null;
  return { sku: found.sku, ...amt, name: readName(line, found.text), source };
}

/**
 * A whole receipt. Returns `{ rows, total, statedTotal, skipped }`.
 *
 * `statedTotal` is what the receipt SAYS; `total` is what its rows add up to. Both are
 * returned rather than one being chosen, because the gap between them is information —
 * it is the difference between "we read this receipt" and "we read most of it".
 */
export function parseReceipt(text, { source = 'paste' } = {}) {
  const lines = String(text || '').split(/\r?\n/);
  const rows = [];
  let skipped = 0;
  // A till usually prints an item over TWO lines: the product name and its style code on
  // one, then the size, quantity and money indented underneath. So a style code with no
  // money beside it is not junk to drop — it is a header still waiting for its numbers,
  // and holding it open for the next line is the difference between reading a receipt
  // and reading nothing at all.
  //
  // The header is only ever completed by the line DIRECTLY after it, and never by a
  // noise line. That is what stops an unclosed header swallowing the `GIFT CARD …
  // 200.00` rows at the bottom and inventing a purchase out of a tender line.
  let pending = null;
  const flush = () => { pending = null; };
  for (const raw of lines) {
    const line = String(raw || '').trim();
    if (!line) { flush(); continue; }
    if (rows.length >= MAX_ROWS) { skipped++; flush(); continue; }
    if (NOISE_RE.test(line)) { flush(); continue; }

    const found = readSku(line);
    if (found) {
      const amt = readAmounts(line, found.text);
      if (amt.totalPrice != null) {
        // Everything on one line — the simpler shape, and no header needed.
        rows.push({ sku: found.sku, ...amt, name: readName(line, found.text), source });
        flush();
      } else {
        // A code with no money: hold it for the numbers below.
        pending = { sku: found.sku, name: readName(line, found.text) };
      }
      continue;
    }

    if (pending) {
      const amt = readAmounts(line, null);
      if (amt.totalPrice != null) {
        rows.push({ sku: pending.sku, ...amt, name: pending.name, source });
        flush();
      }
      // A line between the two that carries no money (a colourway, a promo note) is
      // passed over with the header still open — receipts wrap where they please.
      continue;
    }
  }
  const total = Math.round(rows.reduce((n, r) => n + (Number(r.totalPrice) || 0), 0) * 100) / 100;
  return { rows, total, statedTotal: receiptTotalFrom(text), skipped };
}

/**
 * Compare what was approved against what the receipt says was bought.
 *
 * Three findings, and all three matter to a different person:
 *  · `bought_unapproved` — company money spent on something nobody signed off.
 *  · `approved_not_bought` — approved and not purchased; the funds went elsewhere.
 *  · `qty_differs` — bought more or fewer than approved.
 *
 * Matched on SKU + size, upper-cased and trimmed on both sides, the same way the
 * reconciliation matches a manifest. A size written `7.5W` is a different shoe from
 * `7.5`, so it is never normalised away.
 */
export function compareReceiptToApproved(receiptLines, approvedLines) {
  const key = (r) => `${String(r.sku || '').trim().toUpperCase()}|${String(r.size || '').trim().toUpperCase()}`;
  const approved = new Map();
  for (const l of approvedLines || []) {
    const k = key(l);
    approved.set(k, (approved.get(k) || 0) + (Number(l.qty) || 0));
  }
  const bought = new Map();
  for (const r of receiptLines || []) {
    const k = key(r);
    bought.set(k, (bought.get(k) || 0) + (Number(r.qty) || 0));
  }
  const out = [];
  for (const k of new Set([...approved.keys(), ...bought.keys()])) {
    const [sku, size] = k.split('|');
    const a = approved.get(k) || 0;
    const b = bought.get(k) || 0;
    if (a === b) continue;
    out.push({
      sku, size: size || null, approved: a, bought: b,
      flag: a === 0 ? 'bought_unapproved' : b === 0 ? 'approved_not_bought' : 'qty_differs',
    });
  }
  return out.sort((x, y) => (x.sku || '').localeCompare(y.sku || ''));
}
