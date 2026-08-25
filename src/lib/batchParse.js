// Turning a supplier's message into rows we can price.
//
// Ported from GemsClean/payout-calculator (`bulk-deals.ts` / `parse-batch.ts`) — the
// deterministic half of it. The source falls back to a model when its own parse looks
// shaky; this doesn't. A parse you can SEE and correct beats a parse that costs money
// and can still be wrong in a way nobody notices, and every row lands in an editable
// table before a single price is looked up.
//
// Two shapes, because sellers send two shapes:
//
//   GROUPED — a header line naming the shoe, then its size run underneath:
//     DD1391-100 Dunk Low Panda $95
//     9 x 2
//     9.5 x 1
//     ⸻
//     FQ8080-133 Air Max $110
//     10 x 3
//
//   PER LINE — everything on one line, one line per size:
//     DD1391-100 size 9 $95 qty 2
//     FQ8080-133 sz 10 x3 $110
//
// Grouped is tried first and only accepted if a header was actually found, because the
// per-line parser will happily read "9 x 2" as a nameless row and produce garbage.

// A style code (DD1391-100, FQ8080-133) or a bare UPC. Kept loose on purpose: adidas,
// New Balance and Nike all shape these differently.
//
// The third alternative is the code written with a SPACE instead of a hyphen —
// "IB8857 141" — because that is how people actually type it, and a paste that fails
// with "nothing recognisable" teaches them the tool is broken rather than that they
// missed a dash. It is deliberately stricter than the hyphen form: BOTH halves must
// contain a digit. Without that, "RM Hemp" out of "Jordan 4 RM Hemp" reads as a style
// code and the whole shoe name becomes a header for sizes that were never under it.
const SKU_TOKEN_RE = /\b[A-Z0-9]{2,10}-[A-Z0-9]{2,5}\b|\b\d{12,14}\b|\b(?=[A-Z0-9]*\d)[A-Z0-9]{2,10}[ \t]+(?=[A-Z0-9]*\d)[A-Z0-9]{2,5}\b/i;
// However it was written, it is stored hyphenated and upper-case — one SKU, one key,
// so "ib8857 141" and "IB8857-141" group together instead of being priced twice.
const normSku = (raw) => String(raw || '').trim().toUpperCase().replace(/[ \t]+/g, '-');
// "9 x 2", "9.5 × 1", "10W x 3" — a size, a multiplier, a count.
//
// The size is capped at TWO digits, and that cap is load-bearing: a numeric style code
// written with a space ("315121 115") otherwise reads as "size 315121, quantity 115" and
// is swallowed as a size line before it can be recognised as the header it is. No shoe
// is a size 315121.
const SIZE_QTY_RE = /^\s*([0-9]{1,2}(?:[.,][05])?\s*(?:[CYWcyw])?)\s*[x×X*]\s*([0-9]+)\s*(?:pairs?|prs?)?\s*$/;
// "9 - 2", "9: 2", "9/2" — same thing with any separator. Looser, so it runs second.
const SIZE_QTY_LOOSE_RE = /^\s*([0-9]{1,2}(?:[.,][05])?\s*[CYWcyw]?)[^0-9]+([0-9]+)\s*(?:pairs?|prs?)?\s*$/;
const SEPARATOR_RE = /^[\s\-–—⸻=_*•·.]+$/;
const TOTAL_RE = /^\s*(?:total|subtotal|grand\s+total|sum|qty)\b/i;

const MAX_ROWS = 300;

// "9.5" not "9,5"; "10w" not "10 W". Sizes are matched against Alias/StockX labels
// later, and a stray space is the difference between a hit and "no market".
const normSize = (raw) => String(raw).trim().replace(/\s+/g, '').replace(',', '.').toUpperCase();

const money = (v) => {
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

// A price on the header line applies to every size under it — "$95" or "cost 95" or "@95".
function costFromLine(text) {
  const dollar = text.match(/\$\s*([0-9]+(?:\.[0-9]{1,2})?)/);
  if (dollar) return money(dollar[1]);
  const keyed = text.match(/\b(?:cost|paid|price|each|per\s*pair|@)\s*[:#-]?\s*\$?\s*([0-9]+(?:\.[0-9]{1,2})?)\b/i);
  return keyed ? money(keyed[1]) : undefined;
}

function headerLine(line) {
  // A size run is never a header, whatever else the line looks like. Belt and braces:
  // the size patterns are checked first at the call site too, but only once a group is
  // already open — the FIRST line of a paste has no group yet.
  if (sizeQtyLine(line)) return null;
  const m = line.match(SKU_TOKEN_RE);
  if (!m) return null;
  const name = line
    .replace(m[0], '')
    .replace(/\$\s*[0-9]+(?:\.[0-9]+)?/g, '')
    .replace(/\b(?:cost|paid|price|each|per\s*pair|@)\b/gi, '')
    .replace(/[–—|·•:\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { sku: normSku(m[0]), name: name || '', cost: costFromLine(line) };
}

function sizeQtyLine(line) {
  const m = line.match(SIZE_QTY_RE) || line.match(SIZE_QTY_LOOSE_RE);
  if (!m) return null;
  return { size: normSize(m[1]), qty: Math.max(1, parseInt(m[2], 10) || 1) };
}

let rowSeq = 1;
const mkRow = (r) => ({
  key: `br${rowSeq++}`,
  sku: normSku(r.sku),
  name: r.name || '',
  size: r.size || '',
  qty: Math.max(1, Math.round(Number(r.qty) || 1)),
  // Blank, not 0 — "they didn't say" and "it's free" are different, and only one of
  // them should produce a verdict. Kept as a string so the table edits like a field.
  cost: r.cost == null ? '' : String(r.cost),
});

// Header + size run. Returns [] when no header line was found, which is the signal to
// fall through to the per-line parser.
export function parseGrouped(text) {
  const rows = [];
  let ctx = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (SEPARATOR_RE.test(line)) { ctx = null; continue; }
    if (TOTAL_RE.test(line)) continue;         // "Total: 12 pairs" is a footer, not a row
    const sq = sizeQtyLine(line);
    if (sq && ctx) { rows.push(mkRow({ ...ctx, ...sq })); continue; }
    const h = headerLine(line);
    if (h) { ctx = h; continue; }
  }
  return rows.slice(0, MAX_ROWS);
}

// One row per line, each carrying its own style code.
export function parsePerLine(text) {
  const rows = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || SEPARATOR_RE.test(line) || TOTAL_RE.test(line)) continue;
    const m = line.match(SKU_TOKEN_RE);
    if (!m) continue;                          // no style code = nothing to price
    const sku = m[0];
    const rest = line.replace(sku, ' ');
    const size = rest.match(/\b(?:sz|size)\s*[:#-]?\s*([0-9]+(?:[.,][05])?\s*[CYWcyw]?)/i)?.[1]
      // "…- 9 -" / "… 9.5 x2": a bare size, only where it can't be the qty or the price.
      || rest.match(/(?:^|\s)([0-9]{1,2}(?:[.,][05])?[CYWcyw]?)(?=\s*[x×X*]\s*[0-9])/)?.[1]
      || '';
    const qty = rest.match(/\b(?:qty|quantity|pairs?|prs?)\s*[:#-]?\s*([0-9]+)\b/i)?.[1]
      || rest.match(/[x×X*]\s*([0-9]+)\b/)?.[1]
      || 1;
    const name = rest
      .replace(/\$\s*[0-9]+(?:\.[0-9]+)?/g, '')
      .replace(/\b(?:sz|size|qty|quantity|pairs?|prs?|cost|paid|price|each)\b\s*[:#-]?\s*[0-9.]*/gi, '')
      .replace(/[x×X*]\s*[0-9]+/g, '')
      .replace(/[–—|·•:\-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    rows.push(mkRow({ sku: normSku(sku), name, size: size ? normSize(size) : '', qty, cost: costFromLine(rest) }));
  }
  return rows.slice(0, MAX_ROWS);
}

/** Parse a pasted list. Grouped first — see the note at the top of the file. */
export function parseBatch(text) {
  const grouped = parseGrouped(text);
  if (grouped.length) return { rows: grouped, shape: 'grouped' };
  const perLine = parsePerLine(text);
  return { rows: perLine, shape: perLine.length ? 'per-line' : 'none' };
}

/** A blank row for the "add one by hand" button. */
export const blankBatchRow = () => mkRow({});

export { MAX_ROWS };
