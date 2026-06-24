// Barcode / code parsing: VIN vs UPC vs SKU detection, tracking-number
// extraction, UPC symbology, US size charts, numeric size parsing.

// Code-type detection so a scan/typed code is routed correctly BEFORE any API
// call: our minted VIN is `SBM-YYMMDD-<sequence>` (alphanumeric); a UPC/EAN is
// 8–14 digits; anything else is treated as a SKU.
export const VIN_RE = /^SBM-\d{6}-\d+$/i;
export const isVinCode = (s) => VIN_RE.test(String(s || '').trim());
export const isUpcCode = (s) => /^\d{8,14}$/.test(String(s || '').trim());

// Extract a clean carrier tracking number from a scanned shipping barcode.
// UPS 1Z barcodes encode the tracking directly; FedEx Ground "96…" barcodes
// encode 34 digits whose last 12 are the tracking number.
export function parseTrackingNumber(raw) {
  const s = String(raw || '').toUpperCase().replace(/\s+/g, '');
  const ups = s.match(/1Z[0-9A-Z]{16}/);            // UPS: 1Z + 16 chars
  if (ups) return ups[0];
  if (/^\d{20,40}$/.test(s) && s.startsWith('96')) return s.slice(-12); // FedEx Ground 96-barcode
  if (/^\d{12}$/.test(s)) return s;                 // FedEx Express
  return s;                                         // anything else: as scanned
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
