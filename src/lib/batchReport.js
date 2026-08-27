// A batch's own manifest — what arrived in this shipment — as PDF or CSV (2026-08-28).
//
// Asked for from the Batch page, and it answers the four questions that identify a
// shipment on paper: DATE ORDER, DATE DELIVERED, BATCH NO. and PO NUMBER. The rows
// beneath are what was actually counted into it, so the sheet stands on its own when it
// is filed, emailed, or handed to someone chasing a delivery.
//
// Built CLIENT-side from the data the Batch page already has (`api.batchFull`), the same
// way the PO manifests are built (`manifestPdf.js`) — and, like those, both formats come
// from ONE input so a CSV can never disagree with the PDF of the same report. jsPDF is
// lazy-loaded on demand.
//
// ⚠️ Every string DRAWN into the PDF must be plain ASCII: jsPDF's built-in Helvetica
// silently drops em-dashes and middots, so "—" prints as an empty cell.
import { toCsv } from './manifestCsv.js';
import { estDate } from './format.js';

const PAGE_W = 215.9;   // US Letter, portrait, mm — a document, not a die-cut label
const PAGE_H = 279.4;
const MARGIN = 14;
const INK = [17, 24, 39];
const MUTED = [107, 114, 128];
const ACCENT = [37, 99, 235];
const HAIR = [209, 213, 219];
const ZEBRA = [244, 246, 250];

const dash = '-';                       // ASCII, see the warning above
const ymd = (v) => (v ? String(v).slice(0, 10) : '');

// The four header facts, derived once and shared by both formats.
//
// `date_received` is the day the shipment was RECEIVED here, which is what "delivered"
// means to the person reading this sheet. Where it was never entered we fall back to the
// day the batch was created and say so, rather than printing a date the warehouse never
// stated as a delivery.
export function batchReportFacts(batch) {
  const b = batch || {};
  const delivered = ymd(b.date_received);
  return {
    dateOrder: ymd(b.po_date_of_purchase),
    dateDelivered: delivered || ymd(b.created_at && estDate(b.created_at)),
    deliveredIsFallback: !delivered,
    batchNo: b.batch_code || '',
    poNumber: b.po_code || '',
    supplier: (b.supplier_name || '').trim(),
    tracking: (b.tracking_number || '').trim(),
    noTracking: b.no_tracking === true,
  };
}

// One line per SKU+size, which is how a manifest is read and checked against a carton —
// not one line per pair. Boxed and loose units are kept apart because "which box" is the
// question a discrepancy conversation turns on.
export function batchReportRows({ items = [], boxes = [] }) {
  const boxById = new Map((boxes || []).map((b) => [String(b.id), b]));
  const grouped = new Map();
  for (const it of items) {
    const box = it.box_id != null ? boxById.get(String(it.box_id)) : null;
    const key = `${box ? box.box_number : ''}|${it.sku || ''}|${it.size || ''}`;
    const row = grouped.get(key);
    if (row) { row.qty += 1; continue; }
    grouped.set(key, {
      box: box ? Number(box.box_number) : null,
      boxTracking: box ? (box.tracking_number || '') : '',
      sku: it.sku || '',
      size: it.size || '',
      name: it.name || '',
      qty: 1,
    });
  }
  return [...grouped.values()].sort((a, b) => (a.box ?? 1e9) - (b.box ?? 1e9)
    || String(a.sku).localeCompare(String(b.sku))
    || String(a.size).localeCompare(String(b.size), undefined, { numeric: true }));
}

export function buildBatchReportCsv({ batch, items = [], boxes = [] }) {
  const f = batchReportFacts(batch);
  const rows = batchReportRows({ items, boxes });
  if (!rows.length) return '';
  // The four identifying facts repeat on EVERY row on purpose: a CSV gets sorted,
  // filtered and pasted into someone else's sheet, and a header block would be lost the
  // first time that happens.
  const cols = [
    ['date_order', 'DATE ORDER'], ['date_delivered', 'DATE DELIVERED'],
    ['batch_no', 'Batch No.'], ['po_number', 'PO Number'],
    ['box', 'Box'], ['box_tracking', 'Box tracking'],
    ['sku', 'SKU'], ['size', 'Size'], ['name', 'Name'], ['qty', 'Qty'],
  ];
  return toCsv(cols, rows.map((r) => ({
    date_order: f.dateOrder, date_delivered: f.dateDelivered,
    batch_no: f.batchNo, po_number: f.poNumber || 'none',
    // 'loose' rather than a blank cell, matching the PDF. Box is an identifier, not a
    // quantity, so nothing arithmetic is lost — and an empty cell reads as "missing
    // data" just as easily as "no box", which is the ambiguity this app keeps paying for.
    box: r.box ?? 'loose', box_tracking: r.boxTracking,
    sku: r.sku, size: r.size, name: r.name, qty: r.qty,
  })));
}

async function loadJsPDF() {
  const mod = await import('jspdf');
  return mod.jsPDF || mod.default;
}

export async function buildBatchReportPdf({ batch, items = [], boxes = [], businessName = '', generatedAt = '' }) {
  const JsPDF = await loadJsPDF();
  const doc = new JsPDF({ unit: 'mm', format: [PAGE_W, PAGE_H], orientation: 'portrait' });
  const f = batchReportFacts(batch);
  const rows = batchReportRows({ items, boxes });
  const right = PAGE_W - MARGIN;
  let y = 0;

  const header = () => {
    doc.setFillColor(...ACCENT);
    doc.rect(0, 0, PAGE_W, 3, 'F');
    y = MARGIN + 4;
    doc.setTextColor(...INK); doc.setFont('helvetica', 'bold'); doc.setFontSize(15);
    doc.text('Batch manifest', MARGIN, y);
    if (businessName) {
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...MUTED);
      doc.text(String(businessName).slice(0, 40), right, y, { align: 'right' });
    }
    y += 7;

    // The four asked-for facts, in a labelled grid so the sheet is unambiguous on its own.
    const cells = [
      ['DATE ORDER', f.dateOrder || (f.poNumber ? 'not recorded' : 'no purchase order')],
      ['DATE DELIVERED', f.dateDelivered ? `${f.dateDelivered}${f.deliveredIsFallback ? ' (created)' : ''}` : 'not recorded'],
      ['BATCH NO.', f.batchNo || dash],
      ['PO NUMBER', f.poNumber || 'not against a PO'],
    ];
    const w = (right - MARGIN) / 4;
    doc.setDrawColor(...HAIR); doc.setLineWidth(0.2);
    doc.rect(MARGIN, y, right - MARGIN, 13);
    cells.forEach(([label, value], i) => {
      const x = MARGIN + i * w;
      if (i) doc.line(x, y, x, y + 13);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(...MUTED);
      doc.text(label, x + 2.5, y + 4.5);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(...INK);
      doc.text(String(value).slice(0, 24), x + 2.5, y + 10);
    });
    y += 18;

    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...MUTED);
    const sub = [
      f.supplier ? `Supplier: ${f.supplier}` : '',
      f.tracking ? `Tracking: ${f.tracking}` : (f.noTracking ? 'Tracking: stated as none' : ''),
      `${items.length} pair${items.length === 1 ? '' : 's'}`,
      generatedAt,
    ].filter(Boolean).join('   |   ');
    doc.text(sub, MARGIN, y);
    y += 6;
  };

  const columns = [
    ['Box', 14], ['SKU', 30], ['Size', 14], ['Name', 0], ['Qty', 14],
  ];
  const nameW = right - MARGIN - columns.reduce((n, c) => n + c[1], 0);

  const tableHead = () => {
    doc.setFillColor(...ZEBRA);
    doc.rect(MARGIN, y, right - MARGIN, 7, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(...MUTED);
    let x = MARGIN + 2;
    for (const [label, w] of columns) {
      const width = w || nameW;
      doc.text(label, label === 'Qty' ? x + width - 4 : x, y + 4.7, label === 'Qty' ? { align: 'right' } : undefined);
      x += width;
    }
    y += 7;
  };

  header();
  if (!rows.length) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(...MUTED);
    doc.text('Nothing has been counted into this batch yet.', MARGIN, y + 4);
    return doc;
  }
  tableHead();

  doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
  rows.forEach((r, i) => {
    if (y > PAGE_H - MARGIN - 14) {   // room for the row plus the footer rule
      doc.addPage(); header(); tableHead(); doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
    }
    if (i % 2) { doc.setFillColor(...ZEBRA); doc.rect(MARGIN, y, right - MARGIN, 6, 'F'); }
    doc.setTextColor(...INK);
    let x = MARGIN + 2;
    const cells = [
      r.box != null ? String(r.box) : 'loose',
      r.sku || dash,
      r.size || dash,
      (r.name || dash).slice(0, 46),
      String(r.qty),
    ];
    cells.forEach((text, ci) => {
      const width = columns[ci][1] || nameW;
      if (ci === 4) doc.text(text, x + width - 4, y + 4.2, { align: 'right' });
      else doc.text(text, x, y + 4.2);
      x += width;
    });
    y += 6;
  });

  doc.setDrawColor(...HAIR); doc.line(MARGIN, y + 1, right, y + 1);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(...INK);
  doc.text(`TOTAL  ${items.length} pair${items.length === 1 ? '' : 's'}`, right, y + 6, { align: 'right' });
  return doc;
}
