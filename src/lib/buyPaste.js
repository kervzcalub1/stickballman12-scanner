// Two short texts a buying request is run on (docs/context/buy-cart.md → "One card per shoe").
//
// 1. WHAT THE SUPPLIER SENDS, pasted into "Add a pair":
//
//      100000317
//      Sizes 8-12 $50
//
//    → { sku: '100000317', sizes: ['8','8.5', … '12'], price: 50 }. A range takes EVERY
//    half size (the owner's call, 2026-10-24); a list ("8, 9, 10.5") takes exactly those;
//    "9 x 2" is a size with 2 on the shop's shelf. It only FILLS THE FORM — the buyer checks
//    the sizes and the price there, and nothing is asked until they press Ask.
//
// 2. WHAT AN APPROVER REPLIES to the shoe's Telegram card:
//
//      11 x 3
//      10.5 x 4
//
//    → approve 11 ×3 and 10.5 ×4; every other size on the card is turned down. Strict on
//    purpose — this spends money, so a line that can't be read refuses the whole reply
//    rather than approving the part that could.

// A size as people type it: 8, 8.5, 10.5W, 5Y, 4.5C. Two digits at most, so a style code's
// digits never read as one.
const SIZE = '(\\d{1,2}(?:\\.5)?)\\s?([MWYCK])?';
const SIZE_RE = new RegExp(`^${SIZE}$`, 'i');
const RANGE_RE = new RegExp(`${SIZE}\\s*(?:-|–|—|to)\\s*${SIZE}`, 'gi');
// "$1,050" is 1050, not 1 (the comma used to end the number).
const AMOUNT = '((?:\\d{1,3}(?:,\\d{3})+|\\d{1,5})(?:\\.\\d{1,2})?)';
const PRICE_RE = new RegExp(`(?:\\$|@|usd\\s*)\\s*${AMOUNT}|${AMOUNT}\\s*(?:usd|dollars?)\\b`, 'i');
// A style code: has a digit, 5+ characters, optionally one split — a dash (DZ5485-201) or
// a space before exactly three characters (DZ5485 201). The space form never takes a size:
// "100000317 10-12" and "IB4025100 10.5" are a code and then sizes, not "100000317-10".
const SKU_RE = /\b(?:sku[:#\s]*)?((?=[A-Z0-9-]*\d)[A-Z0-9]{2,}(?:-[A-Z0-9]{2,4}|\s[A-Z0-9]{3}(?![.\d]|\s*(?:-|–|—|to)\s*\d))?)\b/gi;
const amount = (s) => Number(String(s).replace(/,/g, ''));

const label = (n, suffix) => `${Number(n)}${suffix ? suffix.toUpperCase() : ''}`;

/** Expand "8-12" (or "5Y-7Y") into every half size, both ends included. Null if silly. */
export function expandRange(lo, hi, suffix = '') {
  const a = Number(lo); const b = Number(hi);
  // 22 is the top of any size run we buy; "40-44" is EU sizing, not nine US sizes.
  if (!(a > 0) || !(b > a) || b - a > 12 || b > 22) return null;
  const out = [];
  for (let x = a; x <= b + 1e-9; x += 0.5) out.push(label(Math.round(x * 2) / 2, suffix));
  return out;
}

export function parseBuyPaste(text) {
  // `price` is the run's price; `sizePrice` the sizes a line priced differently
  // ("8-10 $50" / "11-12 $60" → 11–12 at $60, not quietly at $50).
  const out = { sku: null, sizes: [], price: null, sizePrice: {}, available: {}, unread: [], warnings: [] };
  const linePrice = {};   // size → the price on the line it was read from
  let general = null;     // a price on a line with no sizes ("$50" alone, or on the SKU line)
  const add = (sz, lp) => {
    if (!out.sizes.includes(sz)) out.sizes.push(sz);
    if (lp != null && linePrice[sz] == null) linePrice[sz] = lp;
  };
  for (const raw of String(text || '').split(/\r?\n/)) {
    let line = raw.replace(/[​ ]/g, ' ').trim();
    if (!line) continue;
    let used = false;

    let lp = null;
    const p = PRICE_RE.exec(line);
    if (p) {
      lp = amount(p[1] ?? p[2]);
      line = line.replace(p[0], ' ').trim();
      used = true;
      // Two prices on one line can't be told apart by size — say so rather than guess.
      const p2 = PRICE_RE.exec(line);
      if (p2) {
        out.warnings.push(`Two prices on one line ("${raw.trim()}") — only ${p[0].trim()} was used; check each size's price.`);
        line = line.replace(p2[0], ' ').trim();
      }
    }
    // The style code: only before any size has been read, and only a token that can't be
    // a size itself ("10.5" is never a SKU).
    if (!out.sku) {
      const m = [...line.matchAll(SKU_RE)].find((x) => x[1].replace(/[-\s]/g, '').length >= 5 && !SIZE_RE.test(x[1]));
      if (m) {
        out.sku = m[1].toUpperCase().replace(/\s+/, '-');
        line = line.replace(m[0], ' ').trim();
        used = true;
      }
    }
    const keyword = /\b(?:sizes?|sz)\b/i.test(line);
    line = line.replace(/^(?:sizes?|sz|us)\b[:\s]*/i, '').replace(/\b(?:sizes?|sz)\b[:\s]*/gi, ' ').trim();

    // "9 x 2" — a size, and how many the shop has of it.
    const sx = new RegExp(`^${SIZE}\\s*[x×*]\\s*(\\d{1,3})$`, 'i').exec(line);
    if (sx) {
      const sz = label(sx[1], sx[2]);
      add(sz, lp);
      if (Number(sx[3]) > 0) out.available[sz] = Number(sx[3]);
      continue;
    }

    // Ranges first, then whatever single sizes are left on the line.
    const found = [];
    let ranged = false;
    const rest = line.replace(RANGE_RE, (whole, lo, s1, hi, s2) => {
      const run = expandRange(lo, hi, s2 || s1 || '');
      if (!run) return ` ${whole} `;   // left in place, so it is reported as unread
      found.push(...run); ranged = true;
      return ' ';
    });
    const leftover = [];
    for (const t of rest.split(/[\s,;/|&+]+|\band\b/i).map((x) => x.trim()).filter(Boolean)) {
      const m = SIZE_RE.exec(t);
      if (m && Number(m[1]) > 0 && Number(m[1]) <= 22) found.push(label(m[1], m[2])); else leftover.push(t);
    }
    // A line of words with a number in it ("Club C 85 Vintage") is the shoe's NAME, not a
    // size list — its numbers are only sizes when the line says so or is nothing else.
    if (leftover.length && !keyword && !ranged) {
      if (!used) out.unread.push(raw.trim());
      if (lp != null && general == null) general = lp;
      continue;
    }
    if (!found.length && lp != null && general == null) general = lp;
    found.forEach((sz) => add(sz, lp));
    if (leftover.length) out.unread.push(leftover.join(' '));
  }
  // The run's price: one given on its own, else the one most sizes carry. Every size priced
  // otherwise keeps its own.
  if (general != null) out.price = general;
  else {
    const n = new Map();
    for (const v of Object.values(linePrice)) n.set(v, (n.get(v) || 0) + 1);
    out.price = n.size ? [...n.entries()].sort((a, b) => b[1] - a[1])[0][0] : null;
  }
  for (const [sz, v] of Object.entries(linePrice)) if (v !== out.price) out.sizePrice[sz] = v;
  out.sizes.sort((a, b) => parseFloat(a) - parseFloat(b) || a.localeCompare(b));
  return out;
}

// Size labels compare loosely only in the obvious ways: case, spaces, a leading "US".
// "7.5" and "7.5W" stay different shoes (api/_lib/buyingStock.js says the same).
export const sizeKey = (v) => String(v ?? '').trim().toUpperCase().replace(/^US\s*/, '').replace(/\s+/g, '');

/**
 * Read an approver's reply against the sizes on the card.
 * @param {string} text
 * @param {Array<{id:number, size:string}>} lines  the card's lines
 * @returns {{ ok:true, approve:Array<{line, qty}>, reject:Array<line> } | { ok:false, error:string }}
 */
export function parseApprovalReply(text, lines) {
  const bySize = new Map(lines.map((l) => [sizeKey(l.size), l]));
  // Two lines of one size on a card can't be told apart by a reply — the second would be
  // turned down as "left out" without anyone having said so.
  if (bySize.size < lines.length)
    return { ok: false, error: 'This card has the same size twice, so a reply can’t say which — decide it on the request’s page.' };
  // "9" for the card's "9W" (or "5" for "5Y") when it is the only 9 on the card.
  const byNumber = (t) => {
    const n = parseFloat(sizeKey(t));
    if (!/^\d{1,2}(\.5)?$/.test(sizeKey(t))) return null;
    const hits = lines.filter((l) => parseFloat(sizeKey(l.size)) === n);
    return hits.length === 1 ? hits[0] : null;
  };
  const qty = new Map();
  const bad = []; const unknown = []; const twice = [];
  let all = null;
  for (const raw of String(text || '').split(/[\r\n,;]+/)) {
    const t = raw.trim();
    if (!t) continue;
    const m = /^(\S+?)\s*(?:[x×*:=]|-(?=\s*\d+\s*$))\s*(\d{1,3})\s*(?:pairs?|prs?)?$/i.exec(t);
    if (!m) { bad.push(t); continue; }
    const n = Number(m[2]);
    if (/^all$/i.test(m[1])) { all = n; continue; }
    const line = bySize.get(sizeKey(m[1])) || byNumber(m[1]);
    if (!line) { unknown.push(m[1]); continue; }
    if (qty.has(line.id)) twice.push(line.size);
    qty.set(line.id, n);
  }
  if (bad.length)
    return { ok: false, error: `Couldn't read ${bad.map((b) => `"${b}"`).join(', ')}. Reply one size per line, like "9 x 5" — sizes you leave out are turned down.` };
  if (unknown.length)
    return { ok: false, error: `${unknown.join(', ')} ${unknown.length === 1 ? 'isn’t' : 'aren’t'} on this card (sizes: ${lines.map((l) => l.size).join(', ')}). Nothing was recorded.` };
  if (twice.length)
    return { ok: false, error: `Size ${[...new Set(twice)].join(', ')} is in the reply twice — say each size once. Nothing was recorded.` };
  if (all == null && !qty.size) return { ok: false, error: 'Reply with the sizes to buy, one per line, like "9 x 5".' };
  const approve = []; const reject = [];
  for (const l of lines) {
    const n = qty.has(l.id) ? qty.get(l.id) : all;
    if (n > 0) approve.push({ line: l, qty: n }); else reject.push(l);
  }
  return { ok: true, approve, reject };
}
