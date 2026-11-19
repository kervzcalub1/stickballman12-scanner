// Manifest discrepancy reports — the rules the form, the server and the page share
// (docs/context/manifest-reports.md).
//
// THE PROBLEM IT SOLVES (owner, 2026-11-20): a parcel's own paperwork (the packing slip
// in an online order's box, or a manifest a supplier slipped inside without sending us
// one) says 4 pairs and the box holds 2. The warehouse has to be able to say so on the
// spot — a photo of the boxes, a photo of the manifest — and the PH team has to hear at
// once, because a short parcel is money to claim while the store still answers.
//
// A report is an inbound-issues CASE (type `manifest`), so taking it, chasing the store
// and resolving it are the flow PH already knows. The mismatches the app finds by itself
// against a recorded online order (type `online_order`) are the same kind of problem and
// sit on the same page.

/** The case types the Manifest Discrepancies page lists. */
export const MANIFEST_TYPES = ['manifest', 'online_order'];
export const isManifestCase = (r) => MANIFEST_TYPES.includes(String(r?.type || ''));

export const ORIGINS = [
  ['online', 'Online order'],
  ['supplier', 'Supplier'],
];
export const originLabel = (k) => (ORIGINS.find(([v]) => v === k) || [])[1] || '';

export const MAX_LINES = 40;
const qty = (v) => {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 9999 ? Math.round(n) : null;
};
const str = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * The typed rows, cleaned: a row counts once it names a shoe (or a size) and has at least
 * one number. A blank side is 0 — "the manifest lists 2, none in the box" is typed as 2 and
 * nothing.
 */
export function cleanManifestLines(lines) {
  return (Array.isArray(lines) ? lines : [])
    .map((l) => ({ shoe: str(l?.shoe, 120), size: str(l?.size, 20), listed: qty(l?.listed), got: qty(l?.got) }))
    .filter((l) => (l.shoe || l.size) && (l.listed != null || l.got != null))
    .map((l) => ({ ...l, listed: l.listed ?? 0, got: l.got ?? 0 }))
    .slice(0, MAX_LINES);
}

/**
 * Pairs the manifest lists vs pairs in the box. With rows typed, the rows ARE the count;
 * without, the two totals typed at the top.
 */
export function manifestTotals({ lines = [], listed = null, got = null } = {}) {
  const rows = cleanManifestLines(lines);
  if (rows.length) return { listed: rows.reduce((n, l) => n + l.listed, 0), got: rows.reduce((n, l) => n + l.got, 0), fromLines: true };
  return { listed: qty(listed), got: qty(got), fromLines: false };
}

/** "SHORT by 2" / "2 EXTRA" / "same count, wrong pairs" — the one phrase everyone reads first. */
export function gapWords(listed, got) {
  if (listed == null || got == null) return '';
  const gap = Number(listed) - Number(got);
  if (gap > 0) return `SHORT by ${gap}`;
  if (gap < 0) return `${-gap} EXTRA`;
  return 'same count, different pairs';
}

const lineWords = (l) => `${[l.shoe, l.size && `size ${l.size}`].filter(Boolean).join(' · ')}: manifest ${l.listed}, in the box ${l.got}`;

/** The rows that differ, as sentences — for the case's Details, the alert and the copy. */
export function manifestDiffLines(lines) {
  return cleanManifestLines(lines).filter((l) => l.listed !== l.got).map(lineWords);
}

/**
 * The case's Details text: everything, in words, so the Inbound Issues page, its CSV and
 * "Copy for supplier" carry the report without knowing about the `manifest` column.
 */
export function manifestDescription({ origin, store, orderNumber, lines = [], listed, got, note }) {
  const t = manifestTotals({ lines, listed, got });
  const rows = cleanManifestLines(lines);
  return [
    `The manifest in the parcel lists ${t.listed ?? '?'} pair${t.listed === 1 ? '' : 's'}; ${t.got ?? '?'} in the box (${gapWords(t.listed, t.got)}).`,
    [originLabel(origin), store, orderNumber && `order #${orderNumber}`].filter(Boolean).join(' · '),
    ...rows.map((l) => `· ${lineWords(l)}`),
    note ? `Note: ${note}` : '',
  ].filter(Boolean).join('\n').slice(0, 1000);
}

/** What is wrong with the form, or '' when it can be sent. One sentence, the first problem. */
export function manifestReportProblem({ origin, store, lines = [], listed, got, note, boxPhotos = [], manifestPhotos = [] }, { storeKnown = false } = {}) {
  if (!ORIGINS.some(([k]) => k === origin)) return 'Is it an online order or a supplier delivery?';
  if (!str(store, 120) && !storeKnown) return origin === 'online' ? 'Which store is it from? (It is on the packing slip.)' : 'Which supplier is it from?';
  const t = manifestTotals({ lines, listed, got });
  if (t.listed == null) return 'How many pairs does the manifest list?';
  if (t.got == null) return 'How many pairs are in the box?';
  const differs = t.listed !== t.got || cleanManifestLines(lines).some((l) => l.listed !== l.got);
  if (!differs && !str(note, 1000)) return 'The manifest and the box show the same count. Say what is different in the note (wrong shoe, wrong size).';
  if (!boxPhotos.length) return 'Take a photo of the boxes that arrived.';
  if (!manifestPhotos.length) return 'Take a photo of the manifest.';
  return '';
}

/** A tracking number as a key: letters and digits only, upper case. */
export const trackKey = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** The page's tabs → which case statuses each one holds. */
export const VIEWS = [
  ['open', 'Not taken'],
  ['working', 'Being worked'],
  ['resolved', 'Resolved'],
  ['all', 'All'],
];
