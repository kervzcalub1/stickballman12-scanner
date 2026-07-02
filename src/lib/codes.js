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
