// Barcode / code parsing: VIN vs UPC vs SKU detection, tracking-number
// extraction, UPC symbology, US size charts, numeric size parsing.

// Code-type detection so a scan/typed code is routed correctly BEFORE any API
// call: our minted VIN is `SBM-YYMMDD-<sequence>` (alphanumeric); a UPC/EAN is
// 8–14 digits; anything else is treated as a SKU.
export const VIN_RE = /^SBM-\d{6}-\d+$/i;
export const isVinCode = (s) => VIN_RE.test(String(s || '').trim());
export const isUpcCode = (s) => /^\d{8,14}$/.test(String(s || '').trim());
// A shelf-location barcode: LETTERS-… with a dash (e.g. MNH-WH-A2-04), distinct
// from a VIN (SBM-…) and a UPC (all digits). Mirrors api/_lib/locations.js.
export const isLocationCode = (s) => {
  const v = String(s || '').trim().toUpperCase();
  if (VIN_RE.test(v)) return false;
  if (/^\d+$/.test(v)) return false;
  return /^[A-Z]{2,4}-[A-Z0-9-]+$/.test(v);
};

// Extract a clean carrier tracking number from a scanned shipping barcode.
// UPS 1Z barcodes encode the tracking directly; FedEx Ground "96…" barcodes
// encode 34 digits whose last 12 are the tracking number.
export function parseTrackingNumber(raw) {
  const s = String(raw || '').toUpperCase();

  // FedEx 2D (PDF417) labels encode ISO-15434 "[)>" MH10 data, not a bare number.
  // Its "31Z" element carries the 34-digit Ground "96" barcode whose LAST 12 digits
  // are the tracking number (e.g. 31Z9632…382167272716 → 382167272716). Do this
  // FIRST — the field code "3(1Z…)" would otherwise false-match the UPS pattern.
  if (s.includes('[)>')) {
    const fx = s.match(/31Z(\d{20,40})/) || s.match(/(96\d{18,38})/);
    if (fx) return fx[1].slice(-12);
  }

  const clean = s.replace(/\s+/g, '');
  // FedEx Ground "96" barcode scanned on its own (all digits, starts with 96).
  if (/^\d{20,40}$/.test(clean) && clean.startsWith('96')) return clean.slice(-12);
  // UPS: 1Z + 16 chars, but only as a STANDALONE token so an embedded "…31Z9632…"
  // inside a FedEx blob can't masquerade as a UPS number.
  const ups = clean.match(/(?:^|[^0-9A-Z])(1Z[0-9A-Z]{16})(?![0-9A-Z])/);
  if (ups) return ups[1];
  if (/^\d{12}$/.test(clean)) return clean;         // FedEx Express / bare 12-digit
  return clean;                                     // anything else: as scanned
}

// Standard US shoe-size chart — a last-resort fallback to populate the "add
// another size" dropdown when the API returns only the single scanned size.
// `kind`: 'w' women's (5–12, "W" suffix), 'y' youth/kids (1–7, "Y" suffix),
// '' men's (6–16, no suffix). Half sizes included.
export function usSizeChart(kind) {
  const ranges = { w: [5, 12], y: [1, 7], '': [6, 16] };
  const [lo, hi] = ranges[kind] || ranges[''];
  const out = [];
  for (let h = lo * 2; h <= hi * 2; h++) {
    const n = h / 2;
    const label = Number.isInteger(n) ? String(n) : n.toFixed(1);
    out.push(kind ? `${label}${kind.toUpperCase()}` : label);
  }
  return out;
}

// Product UPC helpers for box-style labels.
export const upcDigits = (u) => String(u || '').replace(/\D/g, '');
export function upcFormat(u) {
  const d = upcDigits(u);
  if (d.length === 12) return 'UPC';
  if (d.length === 13) return 'EAN13';
  if (d.length === 8) return 'EAN8';
  return 'CODE128';
}

// Split a size into the number and the men's/women's marker a shoe box prints
// ("11.5 M", "9 W") — warehouse can't tell a women's 9 from a men's 9 on a
// replacement box otherwise. Three sources, in order of how much we trust them:
//   1. the size string's own suffix — StockX and our own records write "8.5W" /
//      "10Y", and that came off the actual pair;
//   2. `items.gender` / the catalogue's gender (Men/Women/Youth/Toddler/Unisex,
//      per normalizeGender in api/_lib/util.js) — only set when the lookup that
//      created the unit knew it, so plenty of older rows are NULL;
//   3. the product name, which is where the brand puts it when nothing else does
//      ("Nike Wmns Air Force 1", "Dunk Low (GS)") — same heuristics as the
//      server's title branch.
// Unisex and unknown stay BARE — a wrong letter on the box is worse than none.
const SUFFIX_FROM_SIZE = { W: 'W', M: 'M', Y: 'Y', GS: 'Y', K: 'Y', C: 'C', TD: 'C', PS: 'C' };
export function sizeParts(size, gender, name) {
  const raw = String(size ?? '').trim();
  if (!raw) return { num: '', suffix: '' };
  // Anything that isn't "<number><optional suffix>" is a hand-typed custom size —
  // pass it through untouched rather than guessing at it.
  const m = raw.match(/^([\d.]+)\s*(W|M|Y|GS|K|C|TD|PS)?$/i);
  if (!m) return { num: raw, suffix: '' };
  const fromSize = SUFFIX_FROM_SIZE[(m[2] || '').toUpperCase()] || '';
  const g = String(gender || '').trim();
  const fromGender = /^wom/i.test(g) ? 'W'
    : /^men/i.test(g) ? 'M'
      : /^(youth|grade|kid)/i.test(g) ? 'Y'
        : /^(toddler|infant)/i.test(g) ? 'C' : '';
  const t = String(name || '');
  const fromName = /wmns|women|\(w\)/i.test(t) ? 'W'
    : /\(td\)|toddler|\(ps\)/i.test(t) ? 'C'
      : /\(gs\)|grade school|youth|\bkids?\b/i.test(t) ? 'Y'
        : /\bmens?\b/i.test(t) ? 'M' : '';
  return { num: m[1], suffix: fromSize || fromGender || fromName };
}

// The same thing as one string, for on-screen text ("9 W", "11.5 M", "10").
export function sizeLabel(size, gender, name) {
  const { num, suffix } = sizeParts(size, gender, name);
  if (!num) return '';
  return suffix ? `${num} ${suffix}` : num;
}

// Numeric value of a size string ("9.5W" -> 9.5) for sorting; NaN if none.
export const sizeNum = (s) => { const m = String(s).match(/[\d.]+/); return m ? parseFloat(m[0]) : NaN; };

// Order sizes smallest→largest for display. Numeric value drives the order
// (handles "8.5W" / "10Y"); non-numeric / not-yet-typed custom sizes sort last.
export function compareSizes(a, b) {
  const na = sizeNum(a?.size ?? a);
  const nb = sizeNum(b?.size ?? b);
  const aNaN = Number.isNaN(na);
  const bNaN = Number.isNaN(nb);
  if (aNaN && bNaN) return String(a?.size ?? a).localeCompare(String(b?.size ?? b));
  if (aNaN) return 1;
  if (bNaN) return -1;
  if (na !== nb) return na - nb;
  return String(a?.size ?? a).localeCompare(String(b?.size ?? b));
}

// --- Scan de-duplication ---------------------------------------------------
// A live camera re-reads the SAME barcode many times a second, so a repeat inside
// this window is one physical scan, not two pairs. It must NEVER be applied to a
// scanner gun or a typed submit: those are deliberate acts, and six identical
// boxes scanned back to back really are six pairs — silently dropping the fast
// ones is the one failure a rapid, uninterrupted scan flow cannot afford.
// `seen` is a mutable { code -> last-seen ms } map owned by the caller.
export const RESCAN_COOLDOWN_MS = 1200;
export function isCameraReread(seen, code, now, windowMs = RESCAN_COOLDOWN_MS) {
  const last = seen?.[code];
  return last != null && now - last < windowMs;
}
