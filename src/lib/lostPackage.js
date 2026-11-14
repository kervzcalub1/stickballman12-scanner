// Lost Package Tracker Tool (docs/context/lost-packages.md) — the pure half, shared by the
// page (Phase 1 runs in the browser) and the server (Phase 2's worker, the downloads).
//
// A port of "Stickballman12LLC - Lost Package Tracker Tool v1.1.0" (a local Python/Flask tool
// started from run.bat / run.command). Same rules, so a month scanned here comes out the
// same as it did there:
//   Phase 1 reads EVERY tab of the month's "Make | Order Updates Sheet | <Month Year>.xlsx",
//   keys each order by tracking number (else order number) and labels it
//   Refunded > Cancelled > Delivered > Lost — "Lost" = nothing in the workbook says delivered.
//   Phase 2 asks the couriers about the Lost ones (api/_lib/lostpkg-carriers.js).
//
// ONE DELIBERATE DIFFERENCE from the original (2026-11-14): it counted a courier answer as
// DELIVERED whenever the text held "deliv" — so "out_for_delivery", "On FedEx vehicle for
// delivery" and a FAILED delivery all came back delivered and dropped off the lost list,
// which is exactly the package this tool exists to catch. Here only a real delivery counts
// (`courierClass`).
import { openWorkbook, readSheet } from './sheinReprice.js';
import { buildXlsxBook } from './xlsx.js';

/* --------------------------------- Phase 1 --------------------------------- */

const DELIVERED_RE = /\bdelivered\b|\bdeliverd\b|\bdelivrd\b|\bpod\b|left at (door|front|porch|mailroom|reception)|handed to (resident|recipient|customer)/i;
const CANCELLED_RE = /\bcancell?ed\b|\bcancel\b/i;
const REFUNDED_RE = /\brefunded\b|\brefund\b/i;
// "Not delivered", "never delivered", "wasn't delivered", "hasn't been delivered" say the
// OPPOSITE, but match \bdelivered\b — the order would drop off the Lost list (QA 2026-11-13;
// the same class of bug as the original's Phase 2 "deliv"). The negated phrase is removed first.
const NEGATED_DELIVERED = /\b(?:not|never|(?:was|is|has|have|had|were)n['’]?t)\s+(?:yet\s+|been\s+|yet\s+been\s+)?(?:delivered|deliverd|delivrd|left at (?:door|front|porch|mailroom|reception)|handed to (?:resident|recipient|customer))\b/gi;
const saysDelivered = (text) => DELIVERED_RE.test(String(text || '').replace(NEGATED_DELIVERED, ' '));

const STATUS_HINTS = ['delivery status', 'shipping status', 'status', 'order status', 'tracking status', 'lost', 'lost - overdue 14+ days'];
const TRACKING_EXACT = ['tracking number', 'tracking #', 'tracking no', 'tracking no.', 'tracking id', 'trackingnumber'];
const ORDER_EXACT = ['order number', 'order #', 'order no', 'order id', 'ordernumber'];
// Never the Tracking Number column, whatever else the header says ("Tracking Courier" was
// matched once and folded every FedEx row into one order — the original's v1.1.0 fix).
const TRACKING_NEGATIVES = ['courier', 'carrier', 'company', 'service', 'method', 'type', 'status', 'url', 'link'];
const JUNK = new Set(['none', 'nan', 'n/a', 'na', '-', '', 'null', 'tbd', 'pending']);

const s = (v) => (v == null ? '' : String(v).trim());
const normHeader = (v) => s(v).replace(/\s+/g, ' ').toLowerCase();
const realId = (v) => !!v && !JUNK.has(v.toLowerCase().trim());
// Excel keeps a number typed into a cell as a number, and the month's sheet can hold it in
// scientific notation (as a number OR as text): FedEx 493235840438 arrives as
// "4.93235840438E11" (owner 2026-11-14 — FedEx can't read that, so the order was never
// really checked). Expanded digit-for-digit as TEXT (never through Number, which would round
// long numbers); a value that isn't a whole number is left alone. "1234.0" → "1234" too.
const SCI_RE = /^(\d+)(?:\.(\d+))?e\+?(\d+)$/i;
export function excelIdText(v) {
  const t = s(v);
  const m = t.match(SCI_RE);
  if (m) {
    const [, int, frac = '', expS] = m;
    const exp = Number(expS);
    if (frac.length > exp) return t;
    return (int + frac + '0'.repeat(exp - frac.length)).replace(/^0+(?=\d)/, '');
  }
  return /^\d+\.0+$/.test(t) ? t.replace(/\.0+$/, '') : t;
}
const stripDotZero = excelIdText;

/** Which column is tracking / order / status, by the header row (0-based). */
export function detectColumns(header) {
  const map = {};
  header.forEach((cell, i) => {
    const h = normHeader(cell);
    if (!h) return;
    if (h.includes('tracking') && !TRACKING_NEGATIVES.some((n) => h.includes(n)) && TRACKING_EXACT.includes(h)) map.tracking ??= i;
    if (ORDER_EXACT.includes(h)) map.order ??= i;
    if (STATUS_HINTS.includes(h)) map.status ??= i;
  });
  header.forEach((cell, i) => {
    const h = normHeader(cell);
    if (!h) return;
    if (map.tracking == null && h.includes('tracking') && !TRACKING_NEGATIVES.some((n) => h.includes(n))) map.tracking = i;
    // Never a date or status column ("Order Date", "Order Status") — with no "Order Number"
    // header, the loose match took the dates as order numbers (QA 2026-11-13).
    if (map.order == null && h.includes('order') && !/tracking|date|status/.test(h)) map.order = i;
    if (map.status == null && STATUS_HINTS.some((x) => h.includes(x))) map.status = i;
  });
  return map;
}

export const classifyOrder = (o) => (o.refunded ? 'Refunded' : o.cancelled ? 'Cancelled' : o.delivered ? 'Delivered' : 'Lost');
export const CLASSES = ['Lost', 'Delivered', 'Cancelled', 'Refunded'];

/**
 * Phase 1 over a parsed workbook: `sheets` = [{ name, rows: [[cell, …], …] }] (row 0 = header).
 * Returns { orders, sheetsScanned, rowsScanned, rowsSkipped, counts }. Each order carries the
 * first row it was seen on (by the first sheet's header names), the evidence, and — for an
 * order keyed by its ORDER number — a tracking number found for that order on any other row
 * (the original's Phase 2 "order → tracking" fallback, worked out here once).
 */
export function scanSheets(sheets) {
  const orders = new Map();
  const orderToTracking = new Map();
  let canonical = [];
  let rowsScanned = 0;
  let rowsSkipped = 0;

  for (const sheet of sheets) {
    const [header = [], ...rows] = sheet.rows;
    if (!sheet.rows.length) continue;
    const headerList = Array.from({ length: header.length }, (_, i) => s(header[i]));
    if (!canonical.length && headerList.some(Boolean)) canonical = headerList;
    const cols = detectColumns(headerList);
    // The Make sheet's own positions when a header can't be found: F order, K tracking, O status.
    const tCol = cols.tracking ?? (headerList.length > 10 ? 10 : null);
    const oCol = cols.order ?? (headerList.length > 5 ? 5 : null);
    const stCol = cols.status ?? (headerList.length > 14 ? 14 : null);

    for (const row of rows) {
      if (!row || !row.some((c) => s(c) !== '')) continue;
      rowsScanned++;
      let tracking = tCol != null ? stripDotZero(s(row[tCol])) : '';
      let order = oCol != null ? stripDotZero(s(row[oCol])) : '';
      if (JUNK.has(tracking.toLowerCase())) tracking = '';
      if (JUNK.has(order.toLowerCase())) order = '';
      if (order && tracking && !orderToTracking.has(order)) orderToTracking.set(order, tracking);

      const key = realId(tracking) ? `T:${tracking}` : realId(order) ? `O:${order}` : null;
      if (!key) { rowsSkipped++; continue; }
      let rec = orders.get(key);
      if (!rec) {
        const first = {};
        for (let i = 0; i < row.length; i++) first[canonical[i] || `col_${i + 1}`] = row[i] ?? '';
        rec = { key, tracking, order, first, sheet: sheet.name, delivered: false, cancelled: false, refunded: false, evidence: [] };
        orders.set(key, rec);
      }
      if (!rec.tracking && tracking) rec.tracking = tracking;
      if (!rec.order && order) rec.order = order;

      const status = stCol != null ? s(row[stCol]) : '';
      const blob = row.filter((c) => c != null).map(s).join(' | ');
      const hit = (re) => re.test(status) || re.test(blob);
      if ((saysDelivered(status) || saysDelivered(blob)) && !rec.delivered) { rec.delivered = true; rec.evidence.push(`delivered @ ${sheet.name}`); }
      if (hit(CANCELLED_RE) && !rec.cancelled) { rec.cancelled = true; rec.evidence.push(`cancelled @ ${sheet.name}`); }
      if (hit(REFUNDED_RE) && !rec.refunded) { rec.refunded = true; rec.evidence.push(`refunded @ ${sheet.name}`); }
    }
  }

  const counts = { Lost: 0, Delivered: 0, Cancelled: 0, Refunded: 0 };
  const out = [...orders.values()].map((r) => {
    const cls = classifyOrder(r);
    counts[cls]++;
    return toOrderRow(r, cls, r.tracking ? '' : (orderToTracking.get(r.order) || ''));
  });
  return { orders: out, sheetsScanned: sheets.length, rowsScanned, rowsSkipped, counts };
}

// Excel stores a date as a day count from 1899-12-30. A cell under a "date" header that is
// a plain number in a sensible range is shown as YYYY-MM-DD, as the original printed it.
const excelDate = (v) => {
  const n = Number(v);
  if (!(s(v) !== '' && Number.isFinite(n) && n > 20000 && n < 80000)) return s(v);
  const d = new Date(Date.UTC(1899, 11, 30) + Math.round(n * 86400000));
  return d.toISOString().slice(0, 10);
};
const pick = (first, ...names) => {
  for (const n of names) {
    const k = Object.keys(first).find((x) => x && x.trim().toLowerCase() === n.toLowerCase());
    if (k != null && s(first[k]) !== '') return s(first[k]);
  }
  return '';
};

// What is kept per order (the page, the database and both downloads read this shape).
function toOrderRow(r, cls, trackingFallback) {
  const f = r.first;
  return {
    key: r.key,
    tracking: r.tracking,
    order_number: r.order,
    tracking_fallback: trackingFallback || '',
    store: pick(f, 'Store Name'),
    product: pick(f, 'Product Name'),
    sku: pick(f, 'SKU'),
    qty: pick(f, 'Quantity'),
    courier: pick(f, 'Tracking Courier'),
    order_date: excelDate(pick(f, 'Order Date')),
    eta: excelDate(pick(f, 'Estimated Date Arrival')),
    status_written: pick(f, 'Delivery Status', 'Status'),
    first_sheet: r.sheet,
    evidence: r.evidence.join('; '),
    p1_class: cls,
  };
}

/** Phase 1 straight from the .xlsx file's bytes. Throws a plain-words Error on a bad file. */
export function scanWorkbookBytes(bytes) {
  const book = openWorkbook(bytes);
  if (!book) throw new Error('That file is not an Excel workbook (.xlsx). Download the month’s Order Updates sheet as .xlsx and try again.');
  const sheets = book.sheets.map((sh) => {
    const grid = readSheet(book, sh.name) || [];
    return { name: sh.name, rows: Array.from(grid, (r) => (r ? Array.from(r, (c) => c ?? '') : [])) };
  });
  if (!sheets.length) throw new Error('That workbook has no sheets.');
  return scanSheets(sheets);
}

/** "Make | Order Updates Sheet | November 2026.xlsx" → "November 2026" (else the name, trimmed). */
export function monthFromFileName(name) {
  const base = s(name).replace(/\.[a-z0-9]+$/i, '');
  const m = base.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}/i);
  return m ? m[0].replace(/^\w/, (c) => c.toUpperCase()) : base.slice(0, 60);
}

/* --------------------------------- Phase 2 --------------------------------- */

const lower = (v) => s(v).toLowerCase();

export function normalizeCourier(c) {
  const x = lower(c).replace(/\s+/g, '');
  if (x.includes('fedex')) return 'fedex';
  if (x.includes('ups')) return 'ups';
  if (x.includes('usps') || x.includes('postal')) return 'usps';
  if (x.includes('canadapost') || (x.includes('canada') && x.includes('post'))) return 'canadapost';
  if (x.includes('dhl')) return 'dhl';
  return x || 'unknown';
}

/** The courier, from the "Tracking Courier" cell, else from the number's shape. */
export function inferCourier(tracking, courierCell) {
  const c = normalizeCourier(courierCell);
  if (c !== 'unknown') return c;
  const t = s(tracking).replace(/\s+/g, '');
  if (/^\d{12}$/.test(t)) return 'fedex';
  if (/^1Z/i.test(t) && t.length >= 16) return 'ups';
  if (/^9\d+$/.test(t) && (t.length === 20 || t.length === 22)) return 'usps';
  return 'unknown';
}

/** Which service is asked first, and which one if that fails (the original's routing table). */
export function routeFor(courier) {
  if (['ups', 'usps', 'canadapost', 'dhl'].includes(courier)) return { primary: 'easypost', fallback: 'fedex' };
  return { primary: 'fedex', fallback: 'easypost' };
}

export const cleanTracking = (t) => stripDotZero(s(t).replace(/\s+/g, ''));

/**
 * A courier's answer → delivered / cancelled / refunded / shipping / unknown.
 * `delivered` = the courier SAYS it was delivered (see the header: the original counted any
 * "deliv", so out-for-delivery and failed deliveries vanished from the lost list).
 */
export function courierClass({ delivered = false, status = '', raw = '' }) {
  const st = lower(status);
  const rw = lower(raw);
  if (delivered) return 'delivered';
  if (st.includes('cancel') || /cancel/.test(rw)) return 'cancelled';
  if (/refund/.test(rw)) return 'refunded';
  if (!st || st === 'unknown') {
    if (!rw || rw === 'unknown' || rw === 'unknown | unknown') return 'unknown';
  }
  return 'shipping';
}

export const P2_LABEL = {
  lost: 'Lost (not delivered)', delivered: 'Delivered', cancelled: 'Cancelled',
  refunded: 'Refunded', failed: 'Failed to scan',
};

/* -------------------------------- Downloads -------------------------------- */

const P1_COLS = ['Status', 'Tracking Number', 'Order Number', 'Store Name', 'Product Name', 'SKU', 'Quantity',
  'Tracking Courier', 'Order Date', 'Estimated Date Arrival', 'Delivery Status (as written)', 'First Seen Sheet', 'Evidence'];
// excelIdText again here: a run saved before 2026-11-14 still holds "4.93235840438E11".
const p1Row = (o) => [o.p1_class, excelIdText(o.tracking), excelIdText(o.order_number), o.store, o.product, o.sku, o.qty, o.courier,
  o.order_date, o.eta, o.status_written, o.first_sheet, o.evidence];
const cols = (labels) => labels.map((label) => ({ label, maxWidth: 48 }));

/** The Phase 1 workbook: Summary, then Lost / Delivered / Cancelled / Refunded. */
export function phase1Book(run, orders) {
  const counts = run.counts || {};
  const summary = [
    ['Tool', 'Stickballman12LLC - Lost Package Tracker Tool'],
    ['Phase', '1 (Data-only scan)'],
    ['Month', run.month_label || ''],
    ['Source File', run.source_name || ''],
    ['Sheets Scanned', run.sheets_scanned],
    ['Rows Scanned', run.rows_scanned],
    ['Rows Skipped (no tracking/order)', run.rows_skipped],
    ['Unique Orders', orders.length],
    ...CLASSES.map((c) => [c, counts[c] ?? orders.filter((o) => o.p1_class === c).length]),
  ];
  return buildXlsxBook([
    { sheetName: 'Summary', columns: cols(['Item', 'Value']), rows: summary },
    ...CLASSES.map((c) => ({ sheetName: c, columns: cols(P1_COLS), rows: orders.filter((o) => o.p1_class === c).map(p1Row) })),
  ]);
}

const P2_EXTRA = ['PHASE2_COURIER_USED', 'PHASE2_PRIMARY', 'PHASE2_FALLBACK', 'PHASE2_STATUS', 'PHASE2_RAW', 'PHASE2_ERROR', 'PHASE2_CHECKED'];
const p2Row = (o) => [...p1Row(o), o.p2_courier, o.p2_primary, o.p2_fallback, P2_LABEL[o.p2_class] || o.p2_class || 'not checked',
  o.p2_raw, o.p2_error, o.p2_checked_est || ''];

/** The Phase 2 workbook, as the original laid it out: Lost / Cancel / Refund / Failed / Summary. */
export function phase2Book(run, lostOrders) {
  const by = (c) => lostOrders.filter((o) => o.p2_class === c);
  const notChecked = lostOrders.filter((o) => !o.p2_class);
  const summary = [
    ['Month', run.month_label || ''],
    ['Source File', run.source_name || ''],
    ['Phase 2 state', run.p2_status || ''],
    ['Checked', lostOrders.length - notChecked.length],
    ['Not checked yet', notChecked.length],
    ['Delivered (dropped from the list)', by('delivered').length],
    ['Confirmed Lost (still in transit / not delivered)', by('lost').length],
    ['Cancelled', by('cancelled').length],
    ['Refunded', by('refunded').length],
    ['Failed to scan', by('failed').length],
  ];
  const head = cols([...P1_COLS, ...P2_EXTRA]);
  return buildXlsxBook([
    { sheetName: 'PHASE 2 LOST PACKAGES', columns: head, rows: by('lost').map(p2Row) },
    { sheetName: 'PHASE 2 CANCEL', columns: head, rows: by('cancelled').map(p2Row) },
    { sheetName: 'PHASE 2 REFUND', columns: head, rows: by('refunded').map(p2Row) },
    { sheetName: 'FAILED TO SCAN', columns: head, rows: by('failed').map(p2Row) },
    ...(notChecked.length ? [{ sheetName: 'NOT CHECKED YET', columns: head, rows: notChecked.map(p2Row) }] : []),
    { sheetName: 'SUMMARY', columns: cols(['Item', 'Value']), rows: summary },
  ]);
}
