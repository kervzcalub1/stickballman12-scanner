// Inbound-shipment manifest → PDF, for the PH "Purchase Orders" page. Two shapes:
//   • 'perbox'  — one PDF, a PAGE PER BOX. Each page carries that label's tracking
//                 number + carrier and the items expected in that box.
//   • 'whole'   — one PDF for the whole order (may run to several pages): every
//                 expected item in one table, with all the order's tracking numbers
//                 listed up top.
// Letter-size document pages (not a die-cut label), so it reads/prints like a packing
// slip. jsPDF is lazy-loaded on demand — same pattern as labelPdf.js. Key fields
// (tracking #s, total pairs, supplier, tag/code, date of purchase) sit in the header
// of every page so a loose sheet is never ambiguous. Reuses dispatchPdf/isTouchPrint
// from labelPdf.js for the print/open handoff.
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

async function loadJsPDF() {
  const mod = await import('jspdf');
  return mod.jsPDF || mod.default;
}

const fmtDate = (d) => {
  if (!d) return '—';
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
  const lines = doc.splitTextToSize(String(value || '—'), w).slice(0, 2);
  lines.forEach((ln, i) => doc.text(ln, x, y + 5 + i * 5));
  return y + 5 + lines.length * 5;
}

// Shared page header: accent bar + title + the five key fields + optional tracking list.
// Returns the y-coordinate where body content can start.
function drawHeader(doc, { businessName, title, po, trackingNumbers, subtitle }) {
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
  metaCell(doc, x1, y, colW, 'Tag / Code', po.tag_code || '—');
  metaCell(doc, x2, y, colW, 'PO', po.po_code);
  y += 16;
  metaCell(doc, x0, y, colW, 'Date of Purchase', fmtDate(po.date_of_purchase));
  if (subtitle) metaCell(doc, x1, y, colW * 2 + 6, subtitle.label, subtitle.value);
  y += 16;

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

// Draw the item-table header row at y; returns the next y.
function drawTableHead(doc, y, cols) {
  doc.setFillColor(...INK);
  doc.rect(MARGIN, y, PAGE_W - MARGIN * 2, 7, 'F');
  doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(255, 255, 255);
  cols.forEach((c) => doc.text(c.label, c.align === 'right' ? c.x + c.w : c.x, y + 4.7, { align: c.align || 'left' }));
  return y + 7;
}

// Column layout for the item table.
function itemCols() {
  const left = MARGIN + 3;
  const right = PAGE_W - MARGIN - 3;
  return [
    { key: 'name', label: 'ITEM', x: left, w: 86 },
    { key: 'sku', label: 'SKU', x: left + 90, w: 34 },
    { key: 'size', label: 'SIZE', x: left + 128, w: 18 },
    { key: 'qty', label: 'PAIRS', x: right - 2, w: 0, align: 'right' },
  ];
}

// Render a list of item rows, paginating with a repeated header when a page fills.
// `header()` re-draws the page header on each new page. Returns { doc, totalPairs }.
function drawItemTable(doc, startY, items, headerFn) {
  const cols = itemCols();
  let y = drawTableHead(doc, startY, cols);
  let total = 0;
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
    const name = doc.splitTextToSize(String(it.name || it.sku || '—'), cols[0].w)[0] || '—';
    doc.text(name, cols[0].x, y + 4.8);
    doc.setFont('courier', 'normal'); doc.setFontSize(8.5);
    doc.text(String(it.sku || '—'), cols[1].x, y + 4.8);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
    doc.text(String(it.size || '—'), cols[2].x, y + 4.8);
    doc.setFont('helvetica', 'bold');
    doc.text(String(qty), cols[3].x, y + 4.8, { align: 'right' });
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

// Group PO lines by box id; box lines keyed by Number(po_box_id).
function linesForBox(lines, boxId) {
  return (lines || []).filter((l) => Number(l.po_box_id) === Number(boxId));
}

// Build the manifest PDF. `mode`: 'perbox' | 'whole'. Returns a jsPDF doc.
export async function buildManifestPdf({ po, boxes = [], lines = [], businessName, mode = 'whole', generatedAt = '' }) {
  const jsPDF = await loadJsPDF();
  const doc = new jsPDF({ unit: 'mm', format: [PAGE_W, PAGE_H], orientation: 'portrait' });
  const stamp = generatedAt || '';

  if (mode === 'perbox') {
    // One page per box. A box with no items still gets a page (so the count of pages
    // matches the count of labels and nothing looks "missing").
    const list = boxes.length ? boxes : [{ box_number: 1, id: null }];
    list.forEach((box, idx) => {
      if (idx > 0) doc.addPage();
      const tn = box.tracking_number
        ? [{ number: box.tracking_number, carrier: carrierName(box.carrier || box.carrier_key) }]
        : [];
      const startY = drawHeader(doc, {
        businessName, title: 'Inbound Shipment Manifest', po, trackingNumbers: tn,
        subtitle: { label: 'Box', value: `Box ${box.box_number} of ${list.length}` },
      });
      const items = linesForBox(lines, box.id);
      if (items.length) {
        drawItemTable(doc, startY, items, () => drawHeader(doc, {
          businessName, title: 'Inbound Shipment Manifest', po, trackingNumbers: tn,
          subtitle: { label: 'Box', value: `Box ${box.box_number} of ${list.length}` },
        }));
      } else {
        doc.setFont('helvetica', 'italic'); doc.setFontSize(10); doc.setTextColor(...MUTED);
        doc.text('No items recorded for this box.', MARGIN, startY + 6);
      }
    });
  } else {
    // Whole order — every line (box lines + order-level Path-C lines), all tracking up top.
    const tns = (boxes || [])
      .filter((b) => b.tracking_number)
      .map((b) => ({ number: b.tracking_number, carrier: carrierName(b.carrier || b.carrier_key) }));
    const header = () => drawHeader(doc, {
      businessName, title: 'Inbound Shipment Manifest — Whole Order', po, trackingNumbers: tns,
      subtitle: { label: 'Labels', value: plural((boxes || []).length, 'box') },
    });
    const startY = header();
    const allItems = (lines || []).slice().sort((a, b) =>
      String(a.name || a.sku).localeCompare(String(b.name || b.sku)) || String(a.size).localeCompare(String(b.size)));
    if (allItems.length) drawItemTable(doc, startY, allItems, header);
    else {
      doc.setFont('helvetica', 'italic'); doc.setFontSize(10); doc.setTextColor(...MUTED);
      doc.text('No items recorded on this order yet.', MARGIN, startY + 6);
    }
  }

  stampFooters(doc, stamp);
  return doc;
}
