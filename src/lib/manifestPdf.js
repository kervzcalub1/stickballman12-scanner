// Inbound-shipment manifest → PDF, for the PH "Purchase Orders" page. Two shapes:
//   • 'perbox'  — one PDF, a PAGE PER BOX. Each page carries that label's tracking
//                 number + carrier and the items expected in that box.
//   • 'whole'   — one PDF for the whole order (may run to several pages): every
//                 expected item in one table, with all the order's tracking numbers
//                 listed up top.
// Letter-size document pages (not a die-cut label), so it reads/prints like a packing
// slip. jsPDF is lazy-loaded on demand — same pattern as labelPdf.js. Key fields
// (tracking #s, total pairs, supplier, tag/code, date of purchase) sit in the header
// of every page so a loose sheet is never ambiguous. The caller downloads the blob
// (see ManifestPrint.jsx) rather than printing it inline.
//
// Both shapes must account for WHOLE-ORDER (Path C) manifests, where PH enters one
// list against the purchase and every line has a NULL `po_box_id`. Those lines belong
// to no label, so 'perbox' gives them their own page at the back instead of dropping
// them — otherwise a warehouse printing the per-box manifest (the one you carry to
// the pallet) got a stack of "No items recorded for this box".
//
// Every string that gets DRAWN is plain ASCII: jsPDF's built-in Helvetica silently
// drops em-dashes and middots, so "Tag / Code —" printed as a blank cell.
import { carrierName } from './carriers.js';

// US Letter in mm (portrait). UPS/US-carrier shop, so Letter over A4.
const PAGE_W = 215.9;
const PAGE_H = 279.4;
const MARGIN = 14;

// Brand palette — kept subtle so it prints cleanly on a mono laser too.
const INK = [17, 24, 39];      // near-black text
const MUTED = [107, 114, 128]; // grey sub-text
const ACCENT = [37, 99, 235];  // blue header bar
const HAIR = [209, 213, 219];  // hairline rules
const ZEBRA = [244, 246, 250]; // alternating row fill
const SHORT_RED = [180, 45, 45];   // declared and not found
const EXTRA_AMBER = [166, 106, 20]; // turned up undeclared

async function loadJsPDF() {
  const mod = await import('jspdf');
  return mod.jsPDF || mod.default;
}

const fmtDate = (d) => {
  if (!d) return '-';
  const s = String(d).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : s;
};
const plural = (n, w) => `${n} ${n === 1 ? w : (w.endsWith('x') ? `${w}es` : `${w}s`)}`;

// A labelled key/value cell in the meta grid.
function metaCell(doc, x, y, w, label, value) {
  doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5);
  doc.setTextColor(...MUTED);
  doc.text(String(label).toUpperCase(), x, y);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(11);
  doc.setTextColor(...INK);
  const lines = doc.splitTextToSize(String(value || '-'), w).slice(0, 2);
  lines.forEach((ln, i) => doc.text(ln, x, y + 5 + i * 5));
  return y + 5 + lines.length * 5;
}

// SHIP TO — where the box is headed. Boxed off under the meta grid so it reads as an
// address rather than another PO field, and drawn on EVERY page: a page separated from
// the rest of the stack still has to be routable. Returns the y it ended at.
function drawShipTo(doc, x, y, w, shipTo) {
  if (!shipTo || !String(shipTo.street || '').trim()) return y;
  const cityLine = [[shipTo.city, shipTo.state].filter(Boolean).join(', '), shipTo.zip]
    .filter(Boolean).join(' ');
  const rows = [shipTo.name, shipTo.street, cityLine, shipTo.phone, shipTo.email]
    .map((s) => String(s || '').trim()).filter(Boolean);
  const h = 6 + rows.length * 4.6 + 2;
  doc.setDrawColor(...HAIR); doc.setLineWidth(0.3);
  doc.roundedRect(x, y - 4, w, h, 1.5, 1.5, 'S');
  doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(...MUTED);
  doc.text('SHIP TO', x + 3, y + 0.5);
  let ty = y + 5;
  rows.forEach((r, i) => {
    doc.setFont('helvetica', i === 0 ? 'bold' : 'normal');
    doc.setFontSize(i < 3 ? 9.5 : 8);
    doc.setTextColor(...(i < 3 ? INK : MUTED));
    doc.text(doc.splitTextToSize(r, w - 6)[0], x + 3, ty);
    ty += 4.6;
  });
  return y - 4 + h;
}

// Shared page header: accent bar + title + the key fields + ship-to + optional tracking
// list. Returns the y-coordinate where body content can start.
function drawHeader(doc, { businessName, title, po, trackingNumbers, subtitle, shipTo }) {
  // Accent bar
  doc.setFillColor(...ACCENT);
  doc.rect(0, 0, PAGE_W, 4, 'F');

  let y = MARGIN + 4;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(15); doc.setTextColor(...INK);
  doc.text(businessName || 'Inbound Shipment', MARGIN, y);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(...MUTED);
  doc.text(title, PAGE_W - MARGIN, y, { align: 'right' });
  y += 3;
  doc.setDrawColor(...HAIR); doc.setLineWidth(0.3);
  doc.line(MARGIN, y, PAGE_W - MARGIN, y);
  y += 7;

  // Meta grid — two rows of columns.
  const colW = (PAGE_W - MARGIN * 2 - 12) / 3;
  const x0 = MARGIN, x1 = MARGIN + colW + 6, x2 = MARGIN + (colW + 6) * 2;
  metaCell(doc, x0, y, colW, 'Supplier', po.supplier_name);
  metaCell(doc, x1, y, colW, 'Tag / Code', po.tag_code || '-');
  metaCell(doc, x2, y, colW, 'PO', po.po_code);
  y += 16;
  metaCell(doc, x0, y, colW, 'Date of Purchase', fmtDate(po.date_of_purchase));
  if (subtitle) metaCell(doc, x1, y, colW * 2 + 6, subtitle.label, subtitle.value);
  y += 16;

  // Where it's going, boxed, above the tracking numbers.
  const shipEnd = drawShipTo(doc, MARGIN, y, colW * 1.6, shipTo);
  if (shipEnd !== y) y = shipEnd + 6;

  // Tracking numbers block (whole-order manifest lists them all here).
  if (trackingNumbers && trackingNumbers.length) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(...MUTED);
    doc.text('TRACKING NUMBERS', MARGIN, y);
    y += 4.5;
    doc.setFont('courier', 'normal'); doc.setFontSize(9.5); doc.setTextColor(...INK);
    trackingNumbers.forEach((t) => {
      const line = t.carrier ? `${t.number}   (${t.carrier})` : t.number;
      doc.text(line, MARGIN, y);
      y += 5;
    });
    y += 2;
  }
  return y;
}

// A CONTINUATION page's header — one line, not the whole block.
//
// A long table used to reprint the entire page header on every page: the supplier
// block, the ship-to box and every tracking number on the order. On a real 18-box
// order that turned the reconciliation into 20 pages, most of it the same 18
// tracking numbers over and over. The order's identity only has to be established
// once; a continuation page needs to say which document it belongs to and get out of
// the way, then repeat the TABLE head (which `drawItemTable`/`drawCompareTable`
// already do) so the columns stay readable.
function drawContinuedHeader(doc, { businessName, title, po }) {
  doc.setFillColor(...ACCENT);
  doc.rect(0, 0, PAGE_W, 4, 'F');
  let y = MARGIN + 2;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(...INK);
  doc.text(businessName || 'Inbound Shipment', MARGIN, y);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...MUTED);
  const right = [po?.po_code, title, 'continued'].filter(Boolean).join('  ·  ');
  doc.text(right, PAGE_W - MARGIN, y, { align: 'right' });
  y += 2.5;
  doc.setDrawColor(...HAIR); doc.setLineWidth(0.3);
  doc.line(MARGIN, y, PAGE_W - MARGIN, y);
  return y + 5;
}

// Draw the item-table header row at y; returns the next y.
function drawTableHead(doc, y, cols) {
  doc.setFillColor(...INK);
  doc.rect(MARGIN, y, PAGE_W - MARGIN * 2, 7, 'F');
  doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(255, 255, 255);
  cols.forEach((c) => doc.text(c.label, c.align === 'right' ? c.x + c.w : c.x, y + 4.7, { align: c.align || 'left' }));
  return y + 7;
}

// A declared amount, or null. BLANK IS NOT ZERO here — a supplier who skipped the
// cost on a line has said nothing about it, and printing "$0.00" would put a number
// on the sheet nobody typed (see docs/context/costs.md).
const declared = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const usd = (n) => (n == null ? '' : `$${n.toFixed(2)}`);

// Column layout for the item table. `prices` widens it to what the supplier typed
// per size — cost and tip are both PER PAIR, so the line column is qty x (cost + tip).
function itemCols(prices = false) {
  const left = MARGIN + 3;
  const right = PAGE_W - MARGIN - 3;
  if (!prices) {
    return [
      { key: 'name', label: 'ITEM', x: left, w: 86 },
      { key: 'sku', label: 'SKU', x: left + 90, w: 34 },
      { key: 'size', label: 'SIZE', x: left + 128, w: 18 },
      { key: 'qty', label: 'PAIRS', x: right - 2, w: 0, align: 'right' },
    ];
  }
  return [
    { key: 'name', label: 'ITEM', x: left, w: 54 },
    { key: 'sku', label: 'SKU', x: left + 57, w: 30 },
    { key: 'size', label: 'SIZE', x: left + 90, w: 14 },
    { key: 'qty', label: 'PAIRS', x: left + 118, w: 0, align: 'right' },
    { key: 'cost', label: 'COST/PR', x: left + 145, w: 0, align: 'right' },
    { key: 'tip', label: 'TIP/PR', x: left + 168, w: 0, align: 'right' },
    { key: 'line', label: 'LINE TOTAL', x: right - 2, w: 0, align: 'right' },
  ];
}

// Render a list of item rows, paginating with a repeated header when a page fills.
// `header()` re-draws the page header on each new page. Returns { doc, totalPairs }.
function drawItemTable(doc, startY, items, headerFn, prices = false) {
  const cols = itemCols(prices);
  let y = drawTableHead(doc, startY, cols);
  let total = 0;
  let costTotal = 0; let tipTotal = 0; let blankLines = 0;
  const rowH = 7;
  items.forEach((it, i) => {
    if (y + rowH > PAGE_H - 20) {
      doc.addPage();
      const hy = headerFn();
      y = drawTableHead(doc, hy, cols);
    }
    if (i % 2 === 1) { doc.setFillColor(...ZEBRA); doc.rect(MARGIN, y, PAGE_W - MARGIN * 2, rowH, 'F'); }
    const qty = Number(it.qty_expected) || 0;
    total += qty;
    doc.setTextColor(...INK); doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
    const name = doc.splitTextToSize(String(it.name || it.sku || '-'), cols[0].w)[0] || '-';
    doc.text(name, cols[0].x, y + 4.8);
    doc.setFont('courier', 'normal'); doc.setFontSize(8.5);
    doc.text(String(it.sku || '-'), cols[1].x, y + 4.8);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
    doc.text(String(it.size || '-'), cols[2].x, y + 4.8);
    doc.setFont('helvetica', 'bold');
    doc.text(String(qty), cols[3].x, y + 4.8, { align: 'right' });
    if (prices) {
      const c = declared(it.unit_cost); const t = declared(it.tip);
      if (c == null && t == null) blankLines += 1;
      costTotal += (c || 0) * qty; tipTotal += (t || 0) * qty;
      const line = c == null && t == null ? null : ((c || 0) + (t || 0)) * qty;
      doc.setFont('helvetica', 'normal');
      doc.text(usd(c) || '--', cols[4].x, y + 4.8, { align: 'right' });
      doc.text(usd(t) || '--', cols[5].x, y + 4.8, { align: 'right' });
      doc.setFont('helvetica', 'bold');
      doc.text(usd(line) || '--', cols[6].x, y + 4.8, { align: 'right' });
    }
    doc.setDrawColor(...HAIR); doc.setLineWidth(0.2);
    doc.line(MARGIN, y + rowH, PAGE_W - MARGIN, y + rowH);
    y += rowH;
  });
  // Total strip
  y += 2;
  doc.setDrawColor(...INK); doc.setLineWidth(0.5);
  doc.line(PAGE_W - MARGIN - 70, y, PAGE_W - MARGIN, y);
  y += 6;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(10.5); doc.setTextColor(...INK);
  doc.text('TOTAL PAIRS', PAGE_W - MARGIN - 70, y);
  doc.text(String(total), PAGE_W - MARGIN, y, { align: 'right' });
  if (prices) {
    const row = (label, value, bold) => {
      y += 5.6;
      doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(bold ? 10.5 : 9.5);
      doc.setTextColor(...(bold ? INK : MUTED));
      doc.text(label, PAGE_W - MARGIN - 70, y);
      doc.text(value, PAGE_W - MARGIN, y, { align: 'right' });
    };
    row('Cost', usd(costTotal));
    if (tipTotal > 0) row('Tips', usd(tipTotal));
    row('TOTAL DECLARED', usd(costTotal + tipTotal), true);
    if (blankLines) {
      // Said out loud, because a total that silently skipped lines reads as complete.
      y += 5;
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...MUTED);
      doc.text(`${blankLines} line${blankLines === 1 ? '' : 's'} with no cost or tip entered - not counted in the total`,
        PAGE_W - MARGIN, y, { align: 'right' });
    }
    doc.setTextColor(...INK);
  }
  return { y, total };
}

// Footer on every page (page N of M + generated stamp). Called after all pages exist.
function stampFooters(doc, generatedAt) {
  const n = doc.getNumberOfPages();
  for (let p = 1; p <= n; p++) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(...MUTED);
    doc.text(generatedAt, MARGIN, PAGE_H - 8);
    doc.text(`Page ${p} of ${n}`, PAGE_W - MARGIN, PAGE_H - 8, { align: 'right' });
  }
}

// Box ids arrive as BIGINT strings, so compare numerically — but a NULL id is not a
// box, and `Number(null)` is 0, which would make every order-level line "match" a
// box whose id is null/0. Normalize to null-or-number and never match null to null.
const boxIdOf = (v) => (v == null || v === '' ? null : Number(v));
function linesForBox(lines, boxId) {
  const want = boxIdOf(boxId);
  if (want == null) return [];
  return (lines || []).filter((l) => boxIdOf(l.po_box_id) === want);
}
// Whole-order (Path C) lines: entered against the purchase, not against a label.
const orderLevelLines = (lines) => (lines || []).filter((l) => boxIdOf(l.po_box_id) == null);

const sortLines = (lines) => (lines || []).slice().sort((a, b) =>
  String(a.name || a.sku).localeCompare(String(b.name || b.sku)) || String(a.size).localeCompare(String(b.size)));

const trackingList = (boxes) => (boxes || [])
  .filter((b) => b.tracking_number)
  .map((b) => ({ number: b.tracking_number, carrier: carrierName(b.carrier || b.carrier_key) }));

// Their list vs our count, one row per SKU+size. Same paginating shape as the item
// table, but four number columns and a plain-word verdict — the sheet gets read by
// someone who didn't build the software, so "Short 1" beats a colour or a minus sign.
function drawCompareTable(doc, startY, rows, headerFn) {
  const left = MARGIN + 3;
  const right = PAGE_W - MARGIN - 3;
  const cols = [
    { label: 'ITEM', x: left, w: 66 },
    { label: 'SKU', x: left + 70, w: 32 },
    { label: 'SIZE', x: left + 106, w: 14 },
    { label: 'THEIRS', x: left + 132, w: 0, align: 'right' },
    { label: 'OURS', x: left + 152, w: 0, align: 'right' },
    { label: 'RESULT', x: right, w: 0, align: 'right' },
  ];
  let y = drawTableHead(doc, startY, cols);
  const rowH = 7;
  let theirs = 0; let ours = 0;
  rows.forEach((r, i) => {
    if (y + rowH > PAGE_H - 20) { doc.addPage(); y = drawTableHead(doc, headerFn(), cols); }
    if (i % 2 === 1) { doc.setFillColor(...ZEBRA); doc.rect(MARGIN, y, PAGE_W - MARGIN * 2, rowH, 'F'); }
    const exp = Number(r.expected) || 0; const rec = Number(r.received) || 0;
    theirs += exp; ours += rec;
    const verdict = exp === rec ? 'Match'
      : rec < exp ? `Short ${exp - rec}`
        : exp === 0 ? 'Not on their list' : `Extra ${rec - exp}`;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...INK);
    doc.text(doc.splitTextToSize(String(r.name || r.sku || '-'), cols[0].w)[0] || '-', cols[0].x, y + 4.8);
    doc.setFont('courier', 'normal'); doc.setFontSize(8.5);
    doc.text(doc.splitTextToSize(String(r.sku || '-'), cols[1].w)[0] || '-', cols[1].x, y + 4.8);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
    doc.text(String(r.size ?? '-'), cols[2].x, y + 4.8);
    doc.text(String(exp), cols[3].x, y + 4.8, { align: 'right' });
    doc.text(String(rec), cols[4].x, y + 4.8, { align: 'right' });
    doc.setFont('helvetica', exp === rec ? 'normal' : 'bold');
    doc.setTextColor(...(exp === rec ? MUTED : INK));
    doc.text(verdict, cols[5].x, y + 4.8, { align: 'right' });
    y += rowH;
  });
  doc.setDrawColor(...HAIR); doc.setLineWidth(0.4);
  doc.line(MARGIN, y, PAGE_W - MARGIN, y);
  y += 6;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(...INK);
  doc.text('TOTALS', MARGIN + 3, y);
  doc.text(String(theirs), cols[3].x, y, { align: 'right' });
  doc.text(String(ours), cols[4].x, y, { align: 'right' });
  const diff = ours - theirs;
  doc.text(diff === 0 ? 'Match' : diff < 0 ? `Short ${-diff}` : `Extra ${diff}`, cols[5].x, y, { align: 'right' });
  return y;
}

// An italic "nothing here" note under a header.
// Discrepancy report, box by box — ONLY the boxes that differ.
//
// The point of the sheet is "go and look in these boxes", so a clean box has no place
// on it beyond one line at the end saying it was checked. A box heading is kept with
// its first row: a heading stranded at the foot of a page reads as a box with nothing
// wrong.
function drawBoxDiffs(doc, startY, boxes, headerFn) {
  const left = MARGIN + 3;
  const right = PAGE_W - MARGIN - 3;
  const cols = [
    { label: '', x: left, w: 12 },
    { label: 'ITEM', x: left + 16, w: 82 },
    { label: 'SKU', x: left + 102, w: 34 },
    { label: 'SIZE', x: right, w: 0, align: 'right' },
  ];
  const rowH = 7;
  let y = startY;
  for (const b of boxes) {
    if (y + rowH * 3 > PAGE_H - 20) { doc.addPage(); y = headerFn(); }
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10.5); doc.setTextColor(...INK);
    const heading = b.kind === 'replacement' ? 'Replacement shipment' : `Box ${b.box_number}`;
    doc.text(heading, left, y + 4);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(...MUTED);
    doc.text(`declared ${b.expected_units}  ·  counted ${b.received_units}`, left + 32, y + 4);
    y = drawTableHead(doc, y + 6.5, cols);
    b.diffs.forEach((d, i) => {
      if (y + rowH > PAGE_H - 20) { doc.addPage(); y = drawTableHead(doc, headerFn(), cols); }
      if (i % 2 === 1) { doc.setFillColor(...ZEBRA); doc.rect(MARGIN, y, PAGE_W - MARGIN * 2, rowH, 'F'); }
      const missing = d.kind === 'missing';
      doc.setFont('helvetica', 'bold'); doc.setFontSize(9);
      doc.setTextColor(...(missing ? SHORT_RED : EXTRA_AMBER));
      doc.text(`${missing ? '-' : '+'}${d.qty}`, cols[0].x, y + 4.8);
      doc.setFont('helvetica', 'normal'); doc.setTextColor(...INK);
      doc.text(doc.splitTextToSize(String(d.name || d.sku || '-'), cols[1].w)[0] || '-', cols[1].x, y + 4.8);
      doc.setFont('courier', 'normal'); doc.setFontSize(8.5);
      doc.text(doc.splitTextToSize(String(d.sku || '-'), cols[2].w)[0] || '-', cols[2].x, y + 4.8);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
      doc.text(String(d.size || '-'), cols[3].x, y + 4.8, { align: 'right' });
      y += rowH;
    });
    y += 6;
  }
  return y;
}

function drawNote(doc, y, text) {
  doc.setFont('helvetica', 'italic'); doc.setFontSize(10); doc.setTextColor(...MUTED);
  doc.splitTextToSize(text, PAGE_W - MARGIN * 2).forEach((ln, i) => doc.text(ln, MARGIN, y + 6 + i * 5));
}

// Build the manifest PDF. `mode`: 'perbox' | 'whole'. Returns a jsPDF doc.
// `boxId` narrows 'perbox' to ONE label — the sheet a supplier prints for the box they
// just closed, to tape to that box before sealing it. The "Box N of M" denominator still
// counts every label on the order, so a single sheet says which box of the shipment it is.
export async function buildManifestPdf({ po, boxes = [], lines = [], businessName, mode = 'whole', generatedAt = '', boxId = null, shipTo = null, receivedBoxes = null, compare = null, boxDiffs = null, prices = false }) {
  const jsPDF = await loadJsPDF();
  const doc = new jsPDF({ unit: 'mm', format: [PAGE_W, PAGE_H], orientation: 'portrait' });
  const stamp = generatedAt || '';

  if (mode === 'perbox') {
    // One page per box. A box with no items still gets a page (so the count of pages
    // matches the count of labels and nothing looks "missing"). A replacement label is
    // a reship the WAREHOUSE raised, not one of the supplier's — so it doesn't count
    // towards "box N of M", same rule the PO roll-ups use.
    const supplierBoxes = (boxes || []).filter((b) => b.kind !== 'replacement');
    const all = [...supplierBoxes, ...(boxes || []).filter((b) => b.kind === 'replacement')];
    // One label only, when asked for — but numbered against the whole order (above).
    const only = boxIdOf(boxId);
    const list = only == null ? all : all.filter((b) => boxIdOf(b.id) === only);
    const orderLines = sortLines(orderLevelLines(lines));
    let drawn = 0;
    const newPage = () => { if (drawn++) doc.addPage(); };

    list.forEach((box) => {
      newPage();
      const tn = box.tracking_number
        ? [{ number: box.tracking_number, carrier: carrierName(box.carrier || box.carrier_key) }]
        : [];
      const subtitle = box.kind === 'replacement'
        ? { label: 'Shipment', value: 'Replacement shipment' }
        : { label: 'Box', value: `Box ${box.box_number} of ${supplierBoxes.length}` };
      const header = () => drawHeader(doc, {
        businessName, title: 'Inbound Shipment Manifest', po, trackingNumbers: tn, subtitle, shipTo,
      });
      const startY = header();
      const items = sortLines(linesForBox(lines, box.id));
      if (items.length) drawItemTable(doc, startY, items, () => drawContinuedHeader(doc, { businessName, title: 'Inbound Shipment Manifest', po }), prices);
      else if (orderLines.length) drawNote(doc, startY, 'This order was manifested as one whole-order list, not box by box - the full item list is on the last page.');
      else drawNote(doc, startY, 'No items recorded for this box.');
    });

    // The whole-order (Path C) list, on its own page at the back.
    if (orderLines.length) {
      newPage();
      const header = () => drawHeader(doc, {
        businessName, title: 'Inbound Shipment Manifest - Whole Order', po, shipTo,
        trackingNumbers: trackingList(boxes),
        subtitle: { label: 'Scope', value: 'Whole order - not broken out by box' },
      });
      drawItemTable(doc, header(), orderLines, () => drawContinuedHeader(doc, { businessName, title: 'Inbound Shipment Manifest - Whole Order', po }), prices);
    }

    // No labels and nothing manifested — still produce a readable sheet.
    if (!drawn) {
      const startY = drawHeader(doc, { businessName, title: 'Inbound Shipment Manifest', po, trackingNumbers: [], shipTo });
      drawNote(doc, startY, 'No labels or items recorded on this order yet.');
    }
  } else if (mode === 'discrepancies') {
    // The short sheet: only the boxes whose contents disagree with what that label
    // declared. This is the one somebody carries into the warehouse, so everything that
    // is already settled is compressed to a single line at the end rather than printed.
    const received = (boxDiffs || []).filter((b) => b.received);
    const pending = (boxDiffs || []).filter((b) => !b.received);
    const dirty = received.filter((b) => b.diffs?.length);
    const clean = received.filter((b) => !b.diffs?.length);
    const header = () => drawHeader(doc, {
      businessName, title: 'Discrepancy Report - By Box', po, trackingNumbers: [], shipTo,
      subtitle: { label: 'Scope', value: dirty.length
        ? `${dirty.length} of ${received.length} boxes differ`
        : `All ${received.length} boxes match their manifest` },
    });
    let y = header();
    if (dirty.length) {
      y = drawBoxDiffs(doc, y, dirty, () => drawContinuedHeader(doc, { businessName, title: 'Discrepancy Report - By Box', po }));
    } else {
      y = drawNote(doc, y, 'Every box we opened holds exactly what its label declared.');
    }
    // What was checked and found correct still belongs on the page — a discrepancy sheet
    // that lists only problems can't be told apart from one where nobody looked.
    if (y + 24 > PAGE_H - 20) { doc.addPage(); y = drawContinuedHeader(doc, { businessName, title: 'Discrepancy Report - By Box', po }); }
    doc.setDrawColor(...HAIR); doc.setLineWidth(0.3);
    doc.line(MARGIN, y, PAGE_W - MARGIN, y);
    y += 6;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...MUTED);
    if (clean.length) {
      doc.text(doc.splitTextToSize(`Checked and correct: box ${clean.map((b) => b.box_number).join(', ')}.`, PAGE_W - MARGIN * 2 - 6), MARGIN + 3, y);
      y += 6;
    }
    if (pending.length) {
      // Not a shortage: an undelivered box has nothing to be short of yet.
      doc.text(doc.splitTextToSize(`Still to arrive, not counted as short: box ${pending.map((b) => b.box_number).join(', ')}.`, PAGE_W - MARGIN * 2 - 6), MARGIN + 3, y);
      y += 6;
    }
  } else if (mode === 'received') {
    // WHAT WE RECEIVED, box by box — our own count, not the supplier's claim. This is the
    // sheet that settles a shortage: every box we opened, its tracking number, and what
    // came out of it, then a reconciliation page putting their list next to our count.
    //
    // Deliberately NOT "expected vs received" per box: on a whole-order manifest there is
    // no per-box expectation, and inventing one would be us making up a claim the supplier
    // never made. Per box we state only what we counted; the comparison happens once, at
    // the order level, where their list actually lives.
    const list = (receivedBoxes || []);
    let drawn = 0;
    list.forEach((box) => {
      if (drawn++) doc.addPage();
      const tn = box.tracking_number
        ? [{ number: box.tracking_number, carrier: carrierName(box.carrier || box.carrier_key) }]
        : [];
      const header = () => drawHeader(doc, {
        businessName, title: 'Received - Our Count', po, trackingNumbers: tn, shipTo,
        subtitle: box.box_number
          ? { label: 'Box', value: `Box ${box.box_number} of ${list.filter((b) => b.box_number).length}` }
          : { label: 'Box', value: 'Not recorded against a box' },
      });
      const startY = header();
      const items = sortLines((box.items || []).map((i) => ({ ...i, qty_expected: i.qty })));
      if (items.length) drawItemTable(doc, startY, items, () => drawContinuedHeader(doc, { businessName, title: 'Received - Our Count', po }));
      else drawNote(doc, startY, 'This box was opened and nothing was in it.');
    });

    // The comparison, once, at the order level.
    if (compare && compare.rows && compare.rows.length) {
      if (drawn++) doc.addPage();
      const header = () => drawHeader(doc, {
        businessName, title: 'Received - Reconciliation', po, trackingNumbers: trackingList(boxes), shipTo,
        subtitle: { label: 'Scope', value: 'Their list vs our count, whole order' },
      });
      drawCompareTable(doc, header(), compare.rows, () => drawContinuedHeader(doc, { businessName, title: 'Received - Reconciliation', po }));
    }

    if (!drawn) {
      const startY = drawHeader(doc, { businessName, title: 'Received - Our Count', po, trackingNumbers: [], shipTo });
      drawNote(doc, startY, 'Nothing has been received against this order yet.');
    }
  } else {
    // Whole order — every line (box lines + order-level Path-C lines), all tracking up top.
    const tns = trackingList(boxes);
    const header = () => drawHeader(doc, {
      businessName, title: 'Inbound Shipment Manifest - Whole Order', po, trackingNumbers: tns, shipTo,
      subtitle: { label: 'Labels', value: plural((boxes || []).filter((b) => b.kind !== 'replacement').length, 'box') },
    });
    const startY = header();
    const allItems = sortLines(lines);
    if (allItems.length) drawItemTable(doc, startY, allItems, () => drawContinuedHeader(doc, { businessName, title: 'Inbound Shipment Manifest - Whole Order', po }), prices);
    else drawNote(doc, startY, 'No items recorded on this order yet.');
  }

  stampFooters(doc, stamp);
  return doc;
}
