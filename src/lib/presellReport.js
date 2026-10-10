// Pre-sell Listings reports — PDF + CSV (docs/context/presell-listings.md → "Reports").
//
// Two reports, each for a date range (EST):
//   · STOCK  — what's left: every SKU + size first listed in the range, pairs / sold / left,
//              in transit or arrived, supplier, PO, tracking, cost, what's listed where.
//              The inbound side reads it to know what's coming and what's already sold.
//   · SALES  — what sold in the range: price, payout, cost, net per sale, with totals.
// Built client-side from what the tab already loaded; CSV and PDF come from the SAME rows,
// so the two files can never disagree. jsPDF is lazy-loaded.
//
// ⚠️ Every string DRAWN into the PDF must be plain ASCII: jsPDF's built-in Helvetica
// drops em-dashes and middots silently (see batchReport.js).
import { lazyImport } from './chunkLoad.js';
import { toCsv } from './manifestCsv.js';
import { estDate, estTime } from './format.js';
import { saleNet } from './presellDetails.js';

const PLAT = { alias: 'Alias', stockx: 'StockX' };
const n2 = (v) => (v == null || !Number.isFinite(Number(v)) ? '' : Number(v).toFixed(2));
const usd = (v) => (v == null || !Number.isFinite(Number(v)) ? '-' : `${Number(v) < 0 ? '-' : ''}$${Math.abs(Number(v)).toFixed(2)}`);
const cents = (c) => (c == null ? null : Number(c) / 100);
const range = (a, b) => (a == null ? '' : a === b ? `$${Math.round(a / 100)}` : `$${Math.round(a / 100)}-${Math.round(b / 100)}`);
const sizeNum = (z) => { const m = String(z || '').match(/\d+(?:\.\d+)?/); return m ? Number(m[0]) : Infinity; };

// Where a stock row stands, in words the floor uses.
export function stockState(s) {
  if (s.in_transit && s.arrived_at) return `Arrived ${estDate(s.arrived_at)}`;
  if (s.in_transit) return `In transit${s.expected_on ? ` (exp ${String(s.expected_on).slice(0, 10)})` : ''}`;
  return 'Pre-sell (not bought)';
}

/* --------------------------------- rows --------------------------------- */
export function stockReportRows(rows) {
  return [...(rows || [])]
    .sort((a, b) => String(a.sku).localeCompare(String(b.sku)) || sizeNum(a.size) - sizeNum(b.size))
    .map((s) => {
      const left = Math.max(0, Number(s.qty) - Number(s.sold));
      const cost = s.unit_cost != null ? Number(s.unit_cost) : null;
      return {
        listed: estDate(s.created_at), sku: s.sku, name: s.name || '', size: s.size,
        qty: Number(s.qty), sold: Number(s.sold), left, state: stockState(s),
        supplier: s.supplier || s.po_supplier || '', po: s.po_code || '',
        tracking: (s.tracking_numbers || []).join(' '), trackingCount: (s.tracking_numbers || []).length,
        note: s.transit_note || '',
        shelf: s.shelf_price != null ? Number(s.shelf_price) : null, cost,
        preset: s.cost_stack?.preset || '',
        leftValue: cost != null ? Math.round(cost * left * 100) / 100 : null,
        alias: `${s.alias_live || 0} live${s.alias_other ? ` / ${s.alias_other} other` : ''}`,
        aliasPrice: range(s.alias_min_cents, s.alias_max_cents),
        stockx: `${s.stockx_live || 0} live${s.stockx_other ? ` / ${s.stockx_other} other` : ''}`,
        stockxPrice: range(s.stockx_min_cents, s.stockx_max_cents),
      };
    });
}

export function salesReportRows(rows) {
  return [...(rows || [])]
    .sort((a, b) => new Date(a.sold_at || a.created_at) - new Date(b.sold_at || b.created_at))
    .map((x) => {
      const net = saleNet(x);
      const at = x.sold_at || x.created_at;
      return {
        date: estDate(at), time: estTime(at), sku: x.sku || '', name: x.name || '', size: x.size || '',
        platform: PLAT[x.platform] || x.platform, order: x.order_id,
        price: net.price, payout: net.payout, payoutEst: net.estimated, cost: net.cost, net: net.profit,
        supplier: x.supplier || '', po: x.po_code || '',
        kind: x.in_transit ? (x.arrived_at ? 'In transit (arrived)' : 'In transit') : 'Pre-sell (source it)',
      };
    });
}

function sum(rows, k) { return Math.round(rows.reduce((t, r) => t + (Number(r[k]) || 0), 0) * 100) / 100; }

export function stockTotals(rs) {
  return {
    lines: rs.length, qty: sum(rs, 'qty'), sold: sum(rs, 'sold'), left: sum(rs, 'left'),
    inTransit: rs.filter((r) => r.state.startsWith('In transit')).reduce((t, r) => t + r.left, 0),
    leftValue: sum(rs, 'leftValue'), noCost: rs.filter((r) => r.cost == null).length,
  };
}
export function salesTotals(rs) {
  const costed = rs.filter((r) => r.cost != null);
  return {
    count: rs.length, price: sum(rs, 'price'), payout: sum(rs, 'payout'),
    cost: sum(costed, 'cost'), net: sum(costed, 'net'), noCost: rs.length - costed.length,
    estimated: rs.filter((r) => r.payoutEst).length,
  };
}

/* ---------------------------------- CSV ---------------------------------- */
export function stockReportCsv(rows) {
  return toCsv([
    ['listed', 'Listed (EST)'], ['sku', 'SKU'], ['name', 'Name'], ['size', 'Size'], ['qty', 'Pairs'], ['sold', 'Sold'], ['left', 'Left'],
    ['state', 'Status'], ['supplier', 'Supplier'], ['po', 'PO'], ['tracking', 'Tracking numbers'], ['note', 'Shipment note'],
    ['shelf', 'Shelf $'], ['preset', 'Preset'], ['cost', 'Cost $ / pair'], ['leftValue', 'Left at cost $'],
    ['alias', 'Alias listings'], ['aliasPrice', 'Alias price'], ['stockx', 'StockX listings'], ['stockxPrice', 'StockX price'],
  ], stockReportRows(rows).map((r) => ({ ...r, shelf: n2(r.shelf), cost: n2(r.cost), leftValue: n2(r.leftValue) })));
}
export function salesReportCsv(rows) {
  return toCsv([
    ['date', 'Sold (EST)'], ['time', 'Time'], ['sku', 'SKU'], ['name', 'Name'], ['size', 'Size'], ['platform', 'Platform'], ['order', 'Order'],
    ['price', 'Price $'], ['payout', 'Payout $'], ['payoutEst', 'Payout estimated'], ['cost', 'Cost $'], ['net', 'Net $'],
    ['supplier', 'Supplier'], ['po', 'PO'], ['kind', 'Kind'],
  ], salesReportRows(rows).map((r) => ({ ...r, price: n2(r.price), payout: n2(r.payout), payoutEst: r.payoutEst ? 'yes' : '', cost: n2(r.cost), net: n2(r.net) })));
}

/* ---------------------------------- PDF ---------------------------------- */
const PAGE_W = 279.4;   // US Letter, LANDSCAPE, mm — wide tables
const PAGE_H = 215.9;
const MARGIN = 10;
const INK = [17, 24, 39];
const MUTED = [107, 114, 128];
const ACCENT = [139, 92, 246];
const HAIR = [209, 213, 219];
const ZEBRA = [244, 246, 250];
const ascii = (v) => String(v ?? '').replace(/[–—]/g, '-').replace(/[·•]/g, '|').replace(/[^\x20-\x7e]/g, '');

// cols: [[label, width mm (0 = takes the rest), right-aligned?]], cells: string[][]
async function tablePdf({ title, subtitle, summary, cols, cells, footer }) {
  const mod = await lazyImport(() => import('jspdf'));
  const JsPDF = mod.jsPDF || mod.default;
  const doc = new JsPDF({ unit: 'mm', format: [PAGE_W, PAGE_H], orientation: 'landscape' });
  const right = PAGE_W - MARGIN;
  const flexW = right - MARGIN - cols.reduce((t, c) => t + c[1], 0);
  const widths = cols.map((c) => c[1] || flexW);
  let y = 0;
  const fit = (text, w) => {
    let t = ascii(text);
    while (t.length > 1 && doc.getTextWidth(t) > w - 2) t = t.slice(0, -2);
    return t !== ascii(text) ? `${t.slice(0, -1)}.` : t;
  };
  const header = () => {
    doc.setFillColor(...ACCENT); doc.rect(0, 0, PAGE_W, 3, 'F');
    y = MARGIN + 4;
    doc.setTextColor(...INK); doc.setFont('helvetica', 'bold'); doc.setFontSize(14);
    doc.text(ascii(title), MARGIN, y);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(...MUTED);
    doc.text(ascii(subtitle), right, y, { align: 'right' });
    y += 6;
  };
  const head = () => {
    doc.setFillColor(...ZEBRA); doc.rect(MARGIN, y, right - MARGIN, 6.5, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5); doc.setTextColor(...MUTED);
    let x = MARGIN;
    cols.forEach(([label, , num], i) => {
      if (num) doc.text(ascii(label), x + widths[i] - 1.5, y + 4.4, { align: 'right' }); else doc.text(ascii(label), x + 1.5, y + 4.4);
      x += widths[i];
    });
    y += 6.5;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...INK);
  };
  header();
  // The totals block — what the report answers, before the detail.
  doc.setDrawColor(...HAIR); doc.setLineWidth(0.2);
  const cw = (right - MARGIN) / summary.length;
  doc.rect(MARGIN, y, right - MARGIN, 12);
  summary.forEach(([label, value], i) => {
    const x = MARGIN + i * cw;
    if (i) doc.line(x, y, x, y + 12);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(6.5); doc.setTextColor(...MUTED);
    doc.text(ascii(label).toUpperCase(), x + 2, y + 4);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(...INK);
    doc.text(fit(value, cw), x + 2, y + 9.5);
  });
  y += 16;
  if (!cells.length) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(...MUTED);
    doc.text('Nothing in this date range.', MARGIN, y + 4);
    return doc;
  }
  head();
  cells.forEach((row, ri) => {
    if (y > PAGE_H - MARGIN - 10) { doc.addPage(); header(); head(); }
    if (ri % 2) { doc.setFillColor(...ZEBRA); doc.rect(MARGIN, y, right - MARGIN, 5.5, 'F'); }
    let x = MARGIN;
    row.forEach((text, i) => {
      const t = fit(text, widths[i]);
      if (cols[i][2]) doc.text(t, x + widths[i] - 1.5, y + 3.9, { align: 'right' }); else doc.text(t, x + 1.5, y + 3.9);
      x += widths[i];
    });
    y += 5.5;
  });
  if (footer) {
    doc.setDrawColor(...HAIR); doc.line(MARGIN, y + 1, right, y + 1);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(...MUTED);
    doc.text(ascii(footer), MARGIN, y + 5.5);
  }
  return doc;
}

const rangeLabel = (from, to) => (from && to ? `${from} to ${to}` : from ? `from ${from}` : to ? `up to ${to}` : 'all dates');

export async function stockReportPdf(rows, { from, to, generatedAt }) {
  const rs = stockReportRows(rows);
  const t = stockTotals(rs);
  return tablePdf({
    title: 'Pre-sell stock - what is left',
    subtitle: `Listed ${rangeLabel(from, to)} (EST)  |  ${generatedAt}`,
    summary: [['SKU x size', String(t.lines)], ['Pairs', String(t.qty)], ['Sold', String(t.sold)], ['Left', String(t.left)],
      ['Left in transit', String(t.inTransit)], ['Left at cost', `${usd(t.leftValue)}${t.noCost ? ` (${t.noCost} no cost)` : ''}`]],
    cols: [['SKU', 26], ['Name', 0], ['Size', 12], ['Pairs', 12, true], ['Sold', 11, true], ['Left', 11, true], ['Status', 32],
      ['Supplier / PO', 34], ['Tracking', 30], ['Cost', 16, true], ['Alias', 26], ['StockX', 26]],
    cells: rs.map((r) => [r.sku, r.name, r.size, String(r.qty), String(r.sold), String(r.left), r.state,
      [r.supplier, r.po].filter(Boolean).join(' / ') || '-',
      r.trackingCount ? `${r.tracking.split(' ')[0]}${r.trackingCount > 1 ? ` +${r.trackingCount - 1}` : ''}` : '-',
      usd(r.cost), `${r.alias}${r.aliasPrice ? ` ${r.aliasPrice}` : ''}`, `${r.stockx}${r.stockxPrice ? ` ${r.stockxPrice}` : ''}`]),
    footer: 'Cost = shelf price through the supplier preset (landed). Blank cost = none entered. Full tracking lists are in the CSV.',
  });
}

export async function salesReportPdf(rows, { from, to, generatedAt }) {
  const rs = salesReportRows(rows);
  const t = salesTotals(rs);
  return tablePdf({
    title: 'Pre-sell sales',
    subtitle: `Sold ${rangeLabel(from, to)} (EST)  |  ${generatedAt}`,
    summary: [['Sales', String(t.count)], ['Sold for', usd(t.price)], ['Payout', `${usd(t.payout)}${t.estimated ? ` (${t.estimated} est.)` : ''}`],
      ['Cost', `${usd(t.cost)}${t.noCost ? ` (${t.noCost} no cost)` : ''}`], ['Net', usd(t.net)]],
    cols: [['Sold (EST)', 30], ['SKU', 26], ['Name', 0], ['Size', 12], ['Platform', 16], ['Order', 30],
      ['Price', 17, true], ['Payout', 19, true], ['Cost', 17, true], ['Net', 17, true], ['Supplier / PO', 30]],
    cells: rs.map((r) => [`${r.date} ${r.time}`, r.sku, r.name, r.size, r.platform, r.order,
      usd(r.price), `${usd(r.payout)}${r.payoutEst ? '*' : ''}`, usd(r.cost), usd(r.net), [r.supplier, r.po].filter(Boolean).join(' / ') || '-']),
    footer: `Payout = the platform's own figure; * = estimated from the default fee (Alias 9.9%, StockX 10%). Net = payout - cost; totals count only sales with a cost.`,
  });
}
