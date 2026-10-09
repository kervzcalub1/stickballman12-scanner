// Paste Alex's message into Pre-sell Listings (docs/context/presell-listings.md → "Paste").
// His shape, 2026-10-10:
//
//   JA1091-100
//   Nike Air Griffey Max 1 'Cincinnati Reds'
//
//   8x 12
//   8.5 x 14
//   …
//
// = a style code line, an optional shoe-name line, then "size x quantity" lines. Sometimes
// no name. Several shoes in one message: each style code starts a new one. Anything that
// isn't one of those is returned in `skipped`, never guessed at.

// "8x 12", "8.5 x 14", "10 × 26", "9*19", "US 9.5 x 17", "7W x 3", "8 - 12"? (no — a dash
// reads like a size range, so it's refused rather than guessed).
const SIZE_LINE = /^(?:us\s*)?(\d{1,2}(?:\.\d)?)\s*([a-z]{0,2})\s*[x×*]\s*(\d{1,3})\s*(?:pairs?|pcs?|units?)?$/i;
// A style code: letters/digits with a digit, ≥ 5 chars, optional "-NNN" tail (JA1091-100,
// DD1391-100, KI6956, 305381-007, IB4025-100). One token on the line.
const STYLE_LINE = /^[A-Z0-9]{2,}(?:-[A-Z0-9]{2,4})?$/i;
const looksLikeStyle = (t) => STYLE_LINE.test(t) && /\d/.test(t) && /[A-Z]|-/i.test(t) && t.replace('-', '').length >= 5;

export function parsePresellPaste(text) {
  const shoes = [];
  const skipped = [];
  let cur = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/[​ ]/g, ' ').trim();
    if (!line) continue;
    const m = line.match(SIZE_LINE);
    if (m) {
      if (!cur) { skipped.push({ line, why: 'a size before any style code' }); continue; }
      const size = String(Number(m[1])) + (m[2] ? m[2].toUpperCase() : '');
      const qty = Number(m[3]);
      if (!(qty >= 1)) { skipped.push({ line, why: 'quantity 0' }); continue; }
      const had = cur.sizes.find((s) => s.size === size);
      if (had) had.qty += qty; else cur.sizes.push({ size, qty });
      continue;
    }
    const token = line.replace(/^sku[:\s]+/i, '').trim();
    if (looksLikeStyle(token)) {
      cur = { sku: token.toUpperCase(), name: '', sizes: [] };
      shoes.push(cur);
      continue;
    }
    // The first plain line after a style code (before any size) is the shoe's name.
    if (cur && !cur.name && !cur.sizes.length) { cur.name = line; continue; }
    skipped.push({ line, why: 'not a style code, a name or "size x quantity"' });
  }
  const kept = shoes.filter((s) => s.sizes.length);
  for (const s of shoes) if (!s.sizes.length) skipped.push({ line: s.sku, why: 'a style code with no sizes under it' });
  return {
    shoes: kept,
    skipped,
    pairs: kept.reduce((n, s) => n + s.sizes.reduce((k, z) => k + z.qty, 0), 0),
  };
}
