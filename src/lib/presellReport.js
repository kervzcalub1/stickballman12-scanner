// Pre-sell Listings reports — PDF + CSV (docs/context/presell-listings.md → "Reports").
//
// One report per tab (owner, 2026-10-10), each for a date range (EST):
//   · STOCK    (Stock tab)    — the pairs we have: per SKU + size first listed in the range,
//                pairs / sold / left, in transit or arrived, supplier, PO, tracking, cost,
//                with a subtotal per SKU. The inbound side reads it for what's coming.
//   · LISTINGS (Listings tab) — every Alias / StockX listing created in the range (the tab's
//                platform + status filter apply): status, price, est. payout, listing id.
//   · SALES    (Sales tab)    — what sold in the range: price, payout, cost, net, totals.
// Built client-side from what the tab already loaded; CSV and PDF come from the SAME rows,
// so the two files can never disagree. jsPDF is lazy-loaded.
//
// ⚠️ Every string DRAWN into the PDF must be plain ASCII: jsPDF's built-in Helvetica
// drops em-dashes and middots silently (see batchReport.js).
import { lazyImport } from './chunkLoad.js';
import { toCsv } from './manifestCsv.js';
import { estDate, estTime, estClock } from './format.js';
import { saleNet } from './presellDetails.js';
import { WHERE, pickGroups, fulfillTotals, timeLeft, urgency, labelLink } from './presellFulfill.js';

const PLAT = { alias: 'Alias', stockx: 'StockX' };
const n2 = (v) => (v == null || !Number.isFinite(Number(v)) ? '' : Number(v).toFixed(2));
const usd = (v) => (v == null || !Number.isFinite(Number(v)) ? '-' : `${Number(v) < 0 ? '-' : ''}$${Math.abs(Number(v)).toFixed(2)}`);
const cents = (c) => (c == null ? null : Number(c) / 100);
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
        date: estDate(at), time: estTime(at), at, sku: x.sku || '', name: x.name || '', size: x.size || '',
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
export async function tablePdf({ title, subtitle, summary, cols, cells, footer }) {
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
  // A row is string[] — or { bold, cells } for a subtotal line (ruled above, bold).
  cells.forEach((item, ri) => {
    const row = Array.isArray(item) ? item : item.cells;
    if (y > PAGE_H - MARGIN - 10) { doc.addPage(); header(); head(); }
    if (!Array.isArray(item) && item.bold) {
      doc.setDrawColor(...HAIR); doc.line(MARGIN, y, right, y);
      doc.setFont('helvetica', 'bold');
    } else if (ri % 2) { doc.setFillColor(...ZEBRA); doc.rect(MARGIN, y, right - MARGIN, 5.5, 'F'); }
    let x = MARGIN;
    row.forEach((text, i) => {
      const t = fit(text, widths[i]);
      if (cols[i][2]) doc.text(t, x + widths[i] - 1.5, y + 3.9, { align: 'right' }); else doc.text(t, x + 1.5, y + 3.9);
      x += widths[i];
    });
    doc.setFont('helvetica', 'normal');
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
  // One line per size, then a bold subtotal per SKU (when it has more than one size).
  const cells = [];
  for (let i = 0; i < rs.length; i++) {
    const r = rs[i];
    cells.push([r.sku, r.name, r.size, String(r.qty), String(r.sold), String(r.left), r.state,
      [r.supplier, r.po].filter(Boolean).join(' / ') || '-',
      r.trackingCount ? `${r.tracking.split(' ')[0]}${r.trackingCount > 1 ? ` +${r.trackingCount - 1}` : ''}` : '-',
      usd(r.cost), usd(r.leftValue)]);
    if (rs[i + 1]?.sku !== r.sku) {
      const g = rs.filter((x) => x.sku === r.sku);
      if (g.length > 1) {
        const gt = stockTotals(g);
        cells.push({ bold: true, cells: [`${r.sku} total`, `${g.length} sizes`, '', String(gt.qty), String(gt.sold), String(gt.left), '', '', '', '',
          gt.leftValue ? usd(gt.leftValue) : '-'] });
      }
    }
  }
  return tablePdf({
    title: 'Pre-sell stock report - have / sold / left',
    subtitle: `Listed ${rangeLabel(from, to)} (EST)  |  ${generatedAt}`,
    summary: [['SKU x size', String(t.lines)], ['Pairs we have', String(t.qty)], ['Sold', String(t.sold)], ['Left', String(t.left)],
      ['Left in transit', String(t.inTransit)], ['Left at cost', `${usd(t.leftValue)}${t.noCost ? ` (${t.noCost} no cost)` : ''}`]],
    cols: [['SKU', 28], ['Name', 0], ['Size', 12], ['Pairs', 13, true], ['Sold', 12, true], ['Left', 12, true], ['Status', 34],
      ['Supplier / PO', 36], ['Tracking', 32], ['Cost', 17, true], ['Left at cost', 21, true]],
    cells,
    footer: 'Cost = shelf price through the supplier preset (landed). "-" = none entered. Full tracking lists are in the CSV.',
  });
}

/* ------------------------------- Listings -------------------------------- */
const STATUS_WORD = { pending: 'Pending', live: 'Live', off: 'Not live', sold: 'Sold', deleted: 'Deleted', failed: 'Failed' };
export function listingsReportRows(rows) {
  return [...(rows || [])]
    .sort((a, b) => String(a.sku).localeCompare(String(b.sku)) || sizeNum(a.size) - sizeNum(b.size)
      || String(a.platform).localeCompare(String(b.platform)) || new Date(a.created_at) - new Date(b.created_at))
    .map((l) => {
      // Payout if it sold at this price (default fee); net only when a cost was entered.
      const m = saleNet({ platform: l.platform, price_cents: l.price_cents, payout_cents: null, unit_cost: l.unit_cost });
      return {
        listed: estDate(l.created_at), time: estTime(l.created_at), at: l.created_at, sku: l.sku, name: l.name || '', size: l.size,
        platform: PLAT[l.platform] || l.platform, status: STATUS_WORD[l.status] || l.status,
        price: m.price, payout: m.payout, cost: m.cost, net: m.profit,
        listingId: l.external_id || '', by: l.created_by || '', error: l.last_error || '',
        supplier: l.supplier || '', po: l.po_code || '',
      };
    });
}
export function listingsTotals(rs) {
  const by = (k, v) => rs.filter((r) => r[k] === v).length;
  return {
    count: rs.length, live: by('status', 'Live'), off: by('status', 'Not live'), pending: by('status', 'Pending'),
    sold: by('status', 'Sold'), gone: by('status', 'Deleted') + by('status', 'Failed'),
    alias: by('platform', 'Alias'), stockx: by('platform', 'StockX'),
  };
}
export function listingsReportCsv(rows) {
  return toCsv([
    ['listed', 'Listed (EST)'], ['time', 'Time'], ['sku', 'SKU'], ['name', 'Name'], ['size', 'Size'], ['platform', 'Platform'], ['status', 'Status'],
    ['price', 'Price $'], ['payout', 'Est. payout $'], ['cost', 'Cost $'], ['net', 'Est. net $'], ['listingId', 'Listing id'], ['by', 'Listed by'],
    ['supplier', 'Supplier'], ['po', 'PO'], ['error', 'Last problem'],
  ], listingsReportRows(rows).map((r) => ({ ...r, price: n2(r.price), payout: n2(r.payout), cost: n2(r.cost), net: n2(r.net) })));
}
export async function listingsReportPdf(rows, { from, to, generatedAt, scope = '' }) {
  const rs = listingsReportRows(rows);
  const t = listingsTotals(rs);
  return tablePdf({
    title: 'Pre-sell listings report',
    subtitle: `Created ${rangeLabel(from, to)} (EST)${scope ? `  |  ${scope}` : ''}  |  ${generatedAt}`,
    summary: [['Listings', String(t.count)], ['Alias / StockX', `${t.alias} / ${t.stockx}`], ['Live', String(t.live)], ['Not live', String(t.off)],
      ['Pending', String(t.pending)], ['Sold', String(t.sold)], ['Deleted / failed', String(t.gone)]],
    cols: [['Listed (EST)', 30], ['SKU', 26], ['Name', 0], ['Size', 12], ['Platform', 16], ['Status', 18],
      ['Price', 16, true], ['Est. payout', 20, true], ['Est. net', 18, true], ['Listing id', 44]],
    cells: rs.map((r) => [`${r.listed} ${estClock(r.at)}`, r.sku, r.name, r.size, r.platform, r.status,
      usd(r.price), usd(r.payout), usd(r.net), r.listingId || '-']),
    footer: 'Est. payout = price less the default fee (Alias 9.9%, StockX 10%). Est. net = that payout - cost, only where a cost was entered.',
  });
}

export async function salesReportPdf(rows, { from, to, generatedAt }) {
  const rs = salesReportRows(rows);
  const t = salesTotals(rs);
  return tablePdf({
    title: 'Pre-sell sales report',
    subtitle: `Sold ${rangeLabel(from, to)} (EST)  |  ${generatedAt}`,
    summary: [['Sales', String(t.count)], ['Sold for', usd(t.price)], ['Payout', `${usd(t.payout)}${t.estimated ? ` (${t.estimated} est.)` : ''}`],
      ['Cost', `${usd(t.cost)}${t.noCost ? ` (${t.noCost} no cost)` : ''}`], ['Net', usd(t.net)]],
    cols: [['Sold (EST)', 30], ['SKU', 26], ['Name', 0], ['Size', 12], ['Platform', 16], ['Order', 30],
      ['Price', 17, true], ['Payout', 19, true], ['Cost', 17, true], ['Net', 17, true], ['Supplier / PO', 30]],
    cells: rs.map((r) => [`${r.date} ${estClock(r.at)}`, r.sku, r.name, r.size, r.platform, r.order,
      usd(r.price), `${usd(r.payout)}${r.payoutEst ? '*' : ''}`, usd(r.cost), usd(r.net), [r.supplier, r.po].filter(Boolean).join(' / ') || '-']),
    footer: `Payout = the platform's own figure; * = estimated from the default fee (Alias 9.9%, StockX 10%). Net = payout - cost; totals count only sales with a cost.`,
  });
}

/* ------------------------------ Pick list -------------------------------- */
// 📦 Fulfill tab (docs/context/presell-fulfillment.md): the pre-sell orders still to ship, one
// block per SKU + size (pull all the 10.5s at once), most urgent first, with WHERE the pair is
// (set aside · shelf · in transit · source it), the ship-by deadline and the UPS tracking — a
// tick box per order. Rows come from assignWhere (src/lib/presellFulfill.js). Letter PORTRAIT.

const shipByText = (v) => (v ? `${estDate(v)} ${estClock(v)}` : 'no deadline');
export function pickListCsv(rows, now = Date.now()) {
  const out = [];
  for (const g of pickGroups(rows)) for (const x of g.orders) {
    out.push({ shipBy: x.ship_by ? shipByText(x.ship_by) : '', left: timeLeft(x.ship_by, now), sku: g.sku || '', name: g.name || '', size: g.size || '',
      platform: PLAT[x.platform] || x.platform, order: x.order_id, where: WHERE[x.where]?.word || '', status: x.order_status || 'not read yet',
      carrier: x.carrier || '', tracking: x.tracking_number || '', label: labelLink(x) || '',
      supplier: x.supplier || '', po: x.po_code || '' });
  }
  return toCsv([
    ['shipBy', 'Ship by (EST)'], ['left', 'Time left'], ['sku', 'SKU'], ['name', 'Name'], ['size', 'Size'], ['platform', 'Platform'],
    ['order', 'Order'], ['where', 'Where is the pair'], ['status', 'Platform status'], ['carrier', 'Carrier'], ['tracking', 'Tracking'],
    ['label', 'Label'], ['supplier', 'Supplier'], ['po', 'PO'],
  ], out);
}

export async function pickListPdf(rows, { generatedAt, scope = '', now = Date.now() }) {
  const mod = await lazyImport(() => import('jspdf'));
  const JsPDF = mod.jsPDF || mod.default;
  const W = 215.9; const H = 279.4; const M = 10; const R = W - M;
  const doc = new JsPDF({ unit: 'mm', format: [W, H], orientation: 'portrait' });
  const groups = pickGroups(rows);
  const t = fulfillTotals(rows, now);
  // x, width (mm) per order column
  const C = { box: [M, 7], by: [M + 7, 34], left: [M + 41, 20], plat: [M + 61, 15], order: [M + 76, 33], where: [M + 109, 36], track: [M + 145, R - M - 145] };
  let y = 0; let page = 1;
  const fit = (text, w) => {
    let s = ascii(text);
    while (s.length > 1 && doc.getTextWidth(s) > w - 2) s = s.slice(0, -2);
    return s !== ascii(text) ? `${s.slice(0, -1)}.` : s;
  };
  const top = () => {
    doc.setFillColor(...ACCENT); doc.rect(0, 0, W, 3, 'F');
    y = M + 4;
    doc.setTextColor(...INK); doc.setFont('helvetica', 'bold'); doc.setFontSize(14);
    doc.text('Pre-sell pick list - orders to ship', M, y);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...MUTED);
    doc.text(ascii(`${generatedAt}  |  page ${page}`), R, y, { align: 'right' });
    if (scope) { y += 4.5; doc.text(ascii(scope), M, y); }
    y += 5;
  };
  const colHead = () => {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(7); doc.setTextColor(...MUTED);
    [['by', 'SHIP BY (EST)'], ['left', 'TIME LEFT'], ['plat', 'PLATFORM'], ['order', 'ORDER #'], ['where', 'WHERE IS THE PAIR'], ['track', 'TRACKING']]
      .forEach(([k, l]) => doc.text(l, C[k][0] + 1, y + 3));
    y += 4.5;
  };
  const newPage = () => { doc.addPage(); page++; top(); colHead(); };
  top();
  // Totals first: what the floor has to do today.
  const sum = [['To ship', t.toShip], ['Late', t.overdue], ['Due < 24 h', t.today], ['Set aside', t.ready], ['Shelf', t.shelf], ['In transit', t.transit], ['Source it', t.source]];
  const cw = (R - M) / sum.length;
  doc.setDrawColor(...HAIR); doc.setLineWidth(0.2); doc.rect(M, y, R - M, 12);
  sum.forEach(([l, v], i) => {
    const x = M + i * cw;
    if (i) doc.line(x, y, x, y + 12);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(6.5); doc.setTextColor(...MUTED); doc.text(l.toUpperCase(), x + 2, y + 4);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(...INK); doc.text(String(v), x + 2, y + 9.8);
  });
  y += 16;
  if (!groups.length) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(...MUTED);
    doc.text('Nothing to ship.', M, y + 4);
    return doc;
  }
  colHead();
  for (const g of groups) {
    if (y > H - M - 22) newPage();
    // Group bar: SKU + size big, name, what it takes.
    doc.setFillColor(...ZEBRA); doc.rect(M, y, R - M, 8, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10.5); doc.setTextColor(...INK);
    const head = `${g.sku}   size ${g.size}`;
    doc.text(ascii(head), M + 1.5, y + 5.5);
    const hw = doc.getTextWidth(ascii(head));
    const parts = ['ready', 'shelf', 'transit', 'source'].map((w) => [w, g.count(w)]).filter(([, n]) => n)
      .map(([w, n]) => `${n} ${WHERE[w].short.toLowerCase()}`).join(', ');
    const right = `${g.orders.length} to ship${parts ? `: ${parts}` : ''}`;
    doc.setFontSize(8.5);
    doc.text(ascii(right), R - 1.5, y + 5.5, { align: 'right' });
    const rw = doc.getTextWidth(ascii(right));
    doc.setFont('helvetica', 'normal'); doc.setTextColor(...MUTED);
    doc.text(fit(g.name || '', R - M - hw - rw - 10), M + hw + 5, y + 5.5);
    y += 9;
    for (const x of g.orders) {
      if (y > H - M - 12) { newPage(); doc.setFont('helvetica', 'italic'); doc.setFontSize(7.5); doc.setTextColor(...MUTED); doc.text(ascii(`${g.sku} size ${g.size} (continued)`), M + 1.5, y + 3); y += 4.5; }
      const u = urgency(x.ship_by, now);
      doc.setDrawColor(...INK); doc.setLineWidth(0.3); doc.rect(C.box[0] + 1.5, y + 1, 3.6, 3.6);
      doc.setFontSize(8.5); doc.setTextColor(...INK);
      doc.setFont('helvetica', u === 'overdue' || u === 'today' ? 'bold' : 'normal');
      doc.text(fit(shipByText(x.ship_by), C.by[1]), C.by[0] + 1, y + 4);
      doc.text(fit(`${u === 'overdue' ? '! ' : ''}${timeLeft(x.ship_by, now)}`, C.left[1]), C.left[0] + 1, y + 4);
      doc.setFont('helvetica', 'normal');
      doc.text(fit(PLAT[x.platform] || x.platform, C.plat[1]), C.plat[0] + 1, y + 4);
      doc.text(fit(x.order_id, C.order[1]), C.order[0] + 1, y + 4);
      doc.setFont('helvetica', 'bold');
      doc.text(fit(WHERE[x.where]?.short || '', C.where[1]), C.where[0] + 1, y + 4);
      doc.setFont('helvetica', 'normal');
      const track = x.tracking_number ? `${x.carrier ? `${x.carrier} ` : ''}${x.tracking_number}` : (labelLink(x) ? 'label made' : 'NO LABEL YET');
      doc.text(fit(track, C.track[1]), C.track[0] + 1, y + 4);
      // Platform status when it isn't the ordinary "waiting to ship" one (e.g. card failed).
      const odd = x.order_status && !/LABEL_GENERATED|^CREATED$/.test(x.order_status) ? x.order_status : (!x.order_status ? 'not read from the platform yet' : '');
      if (odd || (x.where === 'transit' && (x.transit_note || x.expected_on))) {
        y += 4.2;
        doc.setFontSize(7); doc.setTextColor(...MUTED);
        const note = [odd && `Platform: ${odd}`, x.where === 'transit' && [x.transit_note, x.expected_on && `expected ${String(x.expected_on).slice(0, 10)}`].filter(Boolean).join(', ')].filter(Boolean).join('  |  ');
        doc.text(fit(note, R - C.by[0]), C.by[0] + 1, y + 3.4);
      }
      y += 5.6;
      doc.setDrawColor(...HAIR); doc.setLineWidth(0.15); doc.line(M, y, R, y);
    }
    y += 2.5;
  }
  if (y > H - M - 12) { doc.addPage(); page++; top(); }
  doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(...MUTED);
  doc.text(ascii('Labels: print each order\'s label from the Fulfill tab (Alias PDF, StockX 4x6). Ship by = the platform cancels after it. Tick the box once packed and labelled.'), M, y + 4, { maxWidth: R - M });
  return doc;
}
