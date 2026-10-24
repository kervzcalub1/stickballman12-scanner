// The store-order audit as a PDF (docs/store-orders-plan.md §4.6) — what Kevin hands Joey
// or files: one row per store (declared → received → short / over, then the money), the
// total, and every SKU + size that came out different. Built from the SAME object the
// screen and the CSV use (`po/audit` → variance, or the frozen `audit_snapshot`), so the
// three can never disagree. Landscape Letter: ten columns don't fit upright.
import { lazyImport } from './chunkLoad.js';
import { estDate } from './format.js';

const INK = [17, 24, 39];
const MUTED = [107, 114, 128];
const HAIR = [220, 223, 228];
const ACCENT = [61, 107, 255];
const RED = [180, 45, 45];
const AMBER = [166, 106, 20];
const PAGE_W = 279.4;
const PAGE_H = 215.9;
const M = 12;

const money = (n) => (n == null ? '—' : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const signed = (n) => (n == null ? '—' : `${n > 0 ? '+' : ''}${money(n)}`);

async function loadJsPDF() {
  return lazyImport(async () => { const mod = await import('jspdf'); return mod.jsPDF || mod.default; });
}

// Columns: [label, width, align]. The store name takes what's left.
const COLS = [
  ['Store', 0, 'left'], ['Declared', 18, 'right'], ['Declared $', 24, 'right'], ['Receipt $', 24, 'right'],
  ['Charged $', 24, 'right'], ['Received', 18, 'right'], ['Short', 14, 'right'], ['Over', 14, 'right'],
  ['$ owed', 22, 'right'], ['Card vs list+tax', 28, 'right'],
];

export async function buildStoreAuditPdf(v, { po, businessName = 'Stickballman12', generatedAt = '' } = {}) {
  const JsPDF = await loadJsPDF();
  const doc = new JsPDF({ orientation: 'landscape', unit: 'mm', format: 'letter' });
  const fixed = COLS.reduce((n, c) => n + c[1], 0);
  const widths = COLS.map((c) => c[1] || (PAGE_W - M * 2 - fixed));
  const xs = widths.reduce((acc, w, i) => { acc.push(i ? acc[i - 1] + widths[i - 1] : M); return acc; }, []);
  const landed = v.landed || {};
  const audited = !!po?.audited_at;
  const showShort = landed.landed || audited;
  let y = 0;

  const header = () => {
    doc.setFillColor(...ACCENT); doc.rect(0, 0, PAGE_W, 4, 'F');
    y = M + 4;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(14); doc.setTextColor(...INK);
    doc.text(`${businessName} — store audit`, M, y);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(...MUTED);
    doc.text(`${po?.po_code || v.po_code || ''}${po?.supplier_name ? ` · ${po.supplier_name}` : ''}`, PAGE_W - M, y, { align: 'right' });
    y += 5;
    const state = audited
      ? `Audited by ${po.audited_by || 'staff'} · ${estDate(po.audited_at)} EST${po.audit_note ? ` · “${po.audit_note}”` : ''}`
      : landed.landed
        ? `${landed.override ? `Called landed by ${landed.override.by}${landed.override.note ? ` (“${landed.override.note}”)` : ''}` : 'Landed'} · ${landed.labels_in} of ${landed.labels} boxes in · NOT audited yet`
        : `${landed.labels_in} of ${landed.labels} boxes in — still arriving; nothing is counted short yet`;
    doc.setFontSize(9); doc.text(state, M, y);
    if (generatedAt) doc.text(`Generated ${generatedAt} EST`, PAGE_W - M, y, { align: 'right' });
    y += 3;
    doc.setDrawColor(...HAIR); doc.setLineWidth(0.3); doc.line(M, y, PAGE_W - M, y);
    y += 6;
  };
  const tableHead = () => {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(...MUTED);
    COLS.forEach(([label, , align], i) => {
      doc.text(label, align === 'right' ? xs[i] + widths[i] - 1 : xs[i], y, { align });
    });
    y += 2; doc.line(M, y, PAGE_W - M, y); y += 5;
  };
  const row = (cells, { bold = false, colors = {} } = {}) => {
    if (y > PAGE_H - M - 8) { doc.addPage(); header(); tableHead(); }
    doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(9);
    cells.forEach((c, i) => {
      doc.setTextColor(...(colors[i] || INK));
      const text = i === 0 ? doc.splitTextToSize(String(c), widths[0] - 2)[0] : String(c);
      doc.text(text, COLS[i][2] === 'right' ? xs[i] + widths[i] - 1 : xs[i], y, { align: COLS[i][2] });
    });
    y += 6;
  };

  header(); tableHead();
  for (const s of v.stores || []) {
    const owedColor = showShort && s.owed ? RED : INK;
    row([
      s.name, s.declared_units, money(s.declared_total), s.receipt_total == null ? 'no receipt' : money(s.receipt_total),
      money(s.charged_total), s.received_units, showShort ? s.short : '—', s.over,
      showShort ? money(s.owed) : '—', signed(s.charged_minus_expected ?? s.charged_minus_declared),
    ], { colors: { 6: showShort && s.short ? RED : INK, 7: s.over ? AMBER : INK, 8: owedColor, 9: s.charge_flag === 'over' ? RED : s.charge_flag === 'under' ? AMBER : INK } });
  }
  const t = v.totals || {};
  doc.setDrawColor(...INK); doc.line(M, y - 4, PAGE_W - M, y - 4);
  row(['Total', t.declared_units, money(t.declared_total), money(t.receipt_total), money(t.charged_total), t.received_units,
    showShort ? t.short : '—', t.over, showShort ? money(t.owed) : '—',
    t.charged_total != null && t.expected_charge != null ? signed(t.charged_total - t.expected_charge)
      : t.charged_total != null && t.declared_total != null ? signed(t.charged_total - t.declared_total) : '—'], { bold: true });

  const notes = [];
  if (v.untied_units) notes.push(`Not tied to a store: ${v.untied_units} pair(s).`);
  if (v.list_after_receiving) notes.push('The list was entered after receiving started.');
  if (v.tax_pct) notes.push(`Card compared with the list plus ${v.tax_pct}% sales tax (${v.tax_source}).`);
  if (showShort && t.overcharge > 0) notes.push(`Charged over list + tax: ${money(t.overcharge)}.`);
  if (showShort && t.undercharge > 0) notes.push(`Charged under the list: ${money(t.undercharge)} - check the list's prices (the supplier is paid on the list).`);
  if (notes.length) {
    y += 2; doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...AMBER);
    for (const n of notes) { doc.text(n, M, y); y += 5; }
  }

  // Every SKU + size that came out different — the evidence behind the table.
  const lines = [];
  for (const s of v.stores || []) for (const g of s.skus || []) for (const z of g.sizes || []) {
    if ((showShort && z.short) || z.over) lines.push({ store: s.name, ...z });
  }
  if (lines.length) {
    y += 4;
    if (y > PAGE_H - M - 20) { doc.addPage(); header(); }
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(...INK);
    doc.text('Differences by size', M, y); y += 6;
    doc.setFontSize(9);
    for (const z of lines) {
      if (y > PAGE_H - M - 6) { doc.addPage(); header(); }
      const parts = [];
      if (showShort && z.short) parts.push(`${z.short} short${z.owed != null ? ` (${money(z.owed)})` : ''}`);
      if (z.over) parts.push(`${z.over} over`);
      doc.setFont('helvetica', 'normal'); doc.setTextColor(...INK);
      doc.text(`${z.store} · ${z.sku}${z.name ? ` ${z.name}` : ''} · size ${z.size}: declared ${z.declared}, received ${z.received} — ${parts.join(', ')}`.slice(0, 170), M, y);
      y += 5;
    }
  }
  return doc;
}

export async function downloadStoreAuditPdf(v, opts = {}) {
  const doc = await buildStoreAuditPdf(v, opts);
  doc.save(`audit-${opts.po?.po_code || v.po_code || 'order'}.pdf`);
}
