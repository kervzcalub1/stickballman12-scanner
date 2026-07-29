// Shelf-location code helpers (server-side; the client mirrors isLocationCode in
// src/lib/codes.js). A location `code` is the scannable barcode value and is
// globally unique: SITE-AREA-BAY-SHELF (e.g. MNH-WH-A2-04). Whole-bay spots
// (pods) omit the shelf → SITE-AREA-BAY (e.g. MNH-PD-1). See
// docs/shelf-location-system-plan.md.

export const SITE_PREFIXES = {
  'Manheim Main Shed': 'MNH',
  'Mount Joy': 'MTJ',
  "Kready's Farm": 'KRF',
};
export const AREA_PREFIXES = {
  'Warehouse Rows': 'WH',
  Pods: 'PD',
  'Office Space': 'OF',
  'Basement Space': 'BS',
};
export const SITES = Object.keys(SITE_PREFIXES);
export const AREAS = Object.keys(AREA_PREFIXES);

export const pad2 = (n) => String(n).padStart(2, '0');

// Derive a short prefix from free text (uppercase alphanumerics) for sites/areas
// that aren't in the known maps (manually-added warehouses).
export const derivePrefix = (s, len) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, len) || 'X';
export const sitePrefixFor = (warehouse) => SITE_PREFIXES[warehouse] || derivePrefix(warehouse, 3);
export const areaPrefixFor = (area) => (area ? (AREA_PREFIXES[area] || derivePrefix(area, 2)) : null);
// Bay as a code segment: uppercased, spaces stripped ("Pod 1" → "POD1", "A2" → "A2").
export const bayCodeFor = (bay) => String(bay || '').toUpperCase().replace(/\s+/g, '');

// The derived Row/aisle key — the bay's leading letters ("A2" → "A", "Pod 1" → "POD").
// A Row is NOT stored anywhere: the Locations tile view groups bays by this, and renaming a
// row means rewriting that prefix on each of its bays. Must stay in step with `rowKeyOf` in
// src/screens/Locations.jsx, or the server would rename a different set than the tile shows.
export const bayRowKey = (bay) => {
  const m = String(bay ?? '').match(/^\s*([A-Za-z]+)/);
  return m ? m[1].toUpperCase() : String(bay ?? '');
};

// The label `create` gives a shelf when none is typed — "A2-04", or just the bay for a
// whole-bay pod. Used to tell an auto-generated name (which should follow a move, since it
// describes the position) from one a human typed (which must not be overwritten).
export const autoLabelFor = (bay, shelf) => (shelf != null && shelf !== ''
  ? `${String(bay).trim()}-${pad2(shelf)}`
  : String(bay).trim());

// Build the canonical code from parts. `bayCode` is the code segment ("A2",
// "K10", or a pod number "1"); shelf null/'' → whole-bay.
export function buildLocationCode({ sitePrefix, areaPrefix, bayCode, shelf }) {
  const segs = [sitePrefix, areaPrefix, bayCode].filter((s) => s != null && s !== '');
  if (shelf != null && shelf !== '') segs.push(pad2(shelf));
  return segs.join('-').toUpperCase();
}

// Normalize a scanned/typed code: uppercase, strip spaces, keep A-Z 0-9 and
// dashes. Returns null if empty or malformed.
export function normalizeLocationCode(s) {
  const v = String(s ?? '').trim().toUpperCase().replace(/\s+/g, '');
  if (!v) return null;
  if (!/^[A-Z0-9][A-Z0-9-]{1,39}$/.test(v)) return null;
  return v;
}

// Does this scanned value look like a shelf-location code (vs a VIN / UPC)?
// VIN = SBM-YYMMDD-######; UPC = all digits. Location = LETTERS-... with a dash.
export function isLocationCode(s) {
  const v = String(s ?? '').trim().toUpperCase();
  if (/^SBM-/.test(v)) return false;
  if (/^\d+$/.test(v)) return false;
  return /^[A-Z]{2,4}-[A-Z0-9-]+$/.test(v);
}
