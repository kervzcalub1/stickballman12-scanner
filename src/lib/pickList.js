// Pick lists for marketplace orders — eBay (eBay page → Orders) and SHEIN (SHEIN page → Orders).
// docs/context/ebay-orders.md → "Pick list", docs/context/shein-live-fix.md → "Orders + pick list".
//
// A person ticks the orders to pick and downloads ONE PDF sized for a 4 x 6 in thermal label
// printer. One entry per PAIR (an order with two shoes = two entries, each with the order #):
//   #order number                 (1 of 2 when the order has more than one pair)
//   shoe name                     (at most 2 lines, then "...")
//   SKU <style code>    Size <size>
// Download only: the browser saves the file, nothing opens a print dialog.
//
// ─── Why these numbers (thermal analysis) ──────────────────────────────────────────────────
// Direct-thermal label printers are 203 dpi (some 300). At 203 dpi 1 pt = 203/72 = 2.82 dots.
// A dot that is half-burnt reads as grey and a 1-2 dot stroke breaks up, so every stroke must be
// at least ~3 dots, everything is pure black (#000), and nothing is grey or hairline.
// Helvetica-Bold (Adobe AFM, units per 1000 em): CapHeight 718, XHeight 532, Descender -207,
// StdVW 140 (vertical stem), StdHW 118 (horizontal stem — the thinnest stroke of the face).
//   · body 14 pt:  cap height 10.05 pt = 28.3 dots; x-height 7.45 pt = 21 dots;
//                  vertical stem 1.96 pt = 5.5 dots; thinnest stroke 1.65 pt = 4.7 dots  (≥ 3 ✓)
//   · order # at its 12 pt floor: thinnest stroke 1.42 pt = 4.0 dots                    (≥ 3 ✓)
//   · header / footer 10 pt: thinnest stroke 1.18 pt = 3.3 dots                         (≥ 3 ✓)
//   · (plain Helvetica at 10 pt: StdHW 76 → 0.76 pt = 2.1 dots — why nothing here is regular weight)
//   · rules 2 pt = 5.6 dots (never thinner than 1.5 pt = 4.2 dots).
// Leading 1.3 x (14 pt → 18.2 pt line): a descender ends 2.9 pt under its baseline, the next
// line's capitals start 5.2 pt (14.7 dots) below that — clear white between lines, no smudge.
// Between entries: 7 pt white + a 2 pt black rule + 7 pt white. Margins 0.2 in (14.4 pt) on every
// side: label printers clip or shift up to ~0.1 in at the edges.
// The page: 288 x 432 pt. Header 27 pt + footer 19 pt leave 357.2 pt for entries. The worst entry
// that keeps SKU + size on one line is 4 lines = 72.8 pt; 4 of them + 3 separators = 339.2 pt ✓.
// A SKU too long to share its line with the size pushes the size onto a 5th line (91 pt); the
// pager measures every entry and starts a new page early, so a page holds 3 of those, never spills.
import { estDate, estClock } from './format.js';
import { styleFromTitle } from './ebayReprice.js';

export const PICK = {
  W: 288, H: 432,                     // 4 x 6 in, portrait
  M: 14.4,                            // 0.2 in margin, all sides
  BODY: 14, SMALL: 10, ORDER_MIN: 12, // pt, all Helvetica-Bold
  LEAD: 1.3,
  RULE: 2, GAP: 7,                    // separator: GAP white, RULE black, GAP white
  MAX_PER_PAGE: 4, NAME_LINES: 2, SKU_LINES: 2,
  DPI: 203,
};
const LINE = PICK.BODY * PICK.LEAD;                               // 18.2
const SMALL_LINE = PICK.SMALL * PICK.LEAD;                        // 13
export const HEADER_H = SMALL_LINE + 4 + PICK.RULE + 8;           // 27
export const FOOTER_H = 6 + SMALL_LINE;                           // 19
export const CONTENT_W = PICK.W - 2 * PICK.M;                     // 259.2
export const ENTRIES_TOP = PICK.M + HEADER_H;                     // 41.4
export const ENTRIES_BOTTOM = PICK.H - PICK.M - FOOTER_H;         // 398.6
export const SEP_H = PICK.GAP + PICK.RULE + PICK.GAP;             // 16
export const LINE_H = LINE;
// Where a line's baseline sits: the glyph box (cap 0.718 + descender 0.207 em) centred in the line.
const baseline = (top, size, lineH) => top + (lineH - 0.925 * size) / 2 + 0.718 * size;
// Dots a stroke of `pt` makes on the printer.
export const dots = (pt, dpi = PICK.DPI) => (pt * dpi) / 72;
export const HELV_BOLD = { cap: 718, xHeight: 532, descender: -207, stdVW: 140, stdHW: 118 };

// jsPDF's built-in Helvetica speaks WinAnsi only and drops what it can't draw without a word
// (see batchReport.js). Every string drawn is folded to plain ASCII first.
export const ascii = (v) => String(v ?? '')
  .replace(/[\u2018\u2019\u02bc\u2032]/g, "'").replace(/[\u201c\u201d\u2033]/g, '"').replace(/[\u2013\u2014\u2212]/g, '-')
  .replace(/[\u00b7\u2022]/g, '|').replace(/\u2026/g, '...')
  .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^\x20-\x7e]/g, ' ').replace(/\s+/g, ' ').trim();

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// 'YYYY-MM-DD' (an EST day) → '12 Nov 2026'. Pure string math: no clock, no timezone.
export const dayWords = (ymdStr) => { const [y, m, d] = String(ymdStr).split('-').map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; };
export const PLATFORM_WORDS = { ebay: 'eBay', shein: 'SHEIN' };
// pick-list-ebay-2026-11-12.pdf — the EST day of `now`, never the viewer's own date.
export const pickListFileName = (platform, now = new Date()) => `pick-list-${platform}-${estDate(now)}.pdf`;

/* ---------------------------------- entries ---------------------------------- */

// The SKU the warehouse picks by: the style code on the box (from Shopify's copy, else read from the
// title), else the listing's own SKU number.
const pickSku = (style, title, sku) => String(style || styleFromTitle(title) || sku || '').trim();
// "1 of 2" on each pair of a multi-pair order.
function numberPairs(list) {
  const per = new Map();
  for (const e of list) per.set(e.orderNo, (per.get(e.orderNo) || 0) + 1);
  const seen = new Map();
  return list.map((e) => { const i = (seen.get(e.orderNo) || 0) + 1; seen.set(e.orderNo, i); return { ...e, pair: i, pairs: per.get(e.orderNo) }; });
}

// eBay orders (as the Orders tab holds them) → one entry per pair. A line of qty 2 = 2 entries.
export function ebayPickEntries(orders) {
  const out = [];
  for (const o of orders || []) {
    for (const l of o.lines || []) {
      const qty = Math.max(1, Number(l.qty) || 1);
      for (let i = 0; i < qty; i++) out.push({ orderNo: String(o.order_id), name: l.title || '', sku: pickSku(l.style, l.title, l.sku), size: l.size || l.shopify_size || '' });
    }
  }
  return numberPairs(out);
}

/* --------------------------------- SHEIN orders -------------------------------- */
// shein_order_units has one row per PAIR (SHEIN's goodsId); an order is its rows by order_no.
// The words for SHEIN's own state (newGoodsStatus, docs/shein-api-reference.md → order-detail):
//   1 待处理 pending · 2 待发货 to ship · 7 待揽收 waiting for pick-up · 4 shipped · 5 signed for ·
//   6 refunded · 8 lost · 9 rejected. Exchange tag 2 / 4 = swapped out (no longer to ship).
export const SHEIN_ORDER_STATES = {
  new: ['New order', 'warn'], to_ship: ['To ship', 'info'], pickup: ['Waiting for pick-up', 'info'],
  shipped: ['Shipped', 'ok'], delivered: ['Delivered', 'ok'], lost: ['Lost in transit', 'bad'], rejected: ['Buyer refused it', 'bad'],
  cancelled: ['Cancelled / refunded', 'muted'], shein_ships: ['SHEIN ships it', 'muted'],
};
export const SHEIN_UNIT_WORDS = { 1: 'new order', 2: 'to ship', 4: 'shipped', 5: 'delivered', 6: 'refunded', 7: 'waiting for pick-up', 8: 'lost', 9: 'refused' };
// The ones still in the warehouse waiting to go — "Select awaiting shipment" on both tabs.
export const SHEIN_AWAITING = new Set(['new', 'to_ship', 'pickup']);
export const EBAY_AWAITING = new Set(['late', 'due_today', 'to_ship']);
export const SHEIN_ORDER_RANK = ['new', 'to_ship', 'pickup', 'lost', 'rejected', 'shipped', 'delivered', 'shein_ships', 'cancelled'];

// A pair still ours to ship: not swapped out, not refunded.
export const sheinLiveUnit = (u) => [1, 3].includes(Number(u.exchange_tag ?? 1)) && Number(u.unit_status) !== 6;
export function sheinOrderStateOf(units) {
  const us = units || [];
  if (us.length && us.every((u) => Number(u.stock_mode ?? 3) !== 3)) return 'shein_ships';
  const live = us.filter(sheinLiveUnit).map((u) => Number(u.unit_status));
  if (!live.length) return 'cancelled';
  if (live.includes(1)) return 'new';
  if (live.includes(2)) return 'to_ship';
  if (live.includes(7)) return 'pickup';
  if (live.includes(8)) return 'lost';
  if (live.includes(9)) return 'rejected';
  if (live.every((s) => s === 5)) return 'delivered';
  return 'shipped';
}
// Rows from /api/shein/orders → one order each, in the order a person works them: still to go
// first (new, to ship, pick-up), then the newest.
export function sheinOrdersFromUnits(units) {
  const by = new Map();
  for (const u of units || []) {
    const k = String(u.order_no || '');
    if (!k) continue;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(u);
  }
  const out = [...by.entries()].map(([orderNo, us]) => {
    const sorted = [...us].sort((a, b) => String(a.goods_id).localeCompare(String(b.goods_id)));
    const times = sorted.map((u) => u.order_time || u.first_seen).filter(Boolean).sort();
    return { order_no: orderNo, sold_at: times[0] || null, units: sorted, state: sheinOrderStateOf(sorted) };
  });
  return out.sort((a, b) => (SHEIN_ORDER_RANK.indexOf(a.state) - SHEIN_ORDER_RANK.indexOf(b.state)) || String(b.sold_at || '').localeCompare(String(a.sold_at || '')));
}
// The shoe a SHEIN pair is: Shopify's name + size for its seller SKU (SHEIN's own title is long
// and SEO-shaped), else SHEIN's title and the size SHEIN printed on the order.
export const sheinUnitShoe = (u) => {
  const name = u.shopify_title || u.title || '';
  return { name, sku: pickSku(u.style, name, u.seller_sku), size: u.shopify_size || u.size_attr || '' };
};
// SHEIN orders → one entry per live pair (a refunded or swapped-out pair isn't picked).
export function sheinPickEntries(orders) {
  const out = [];
  for (const o of orders || []) for (const u of (o.units || []).filter(sheinLiveUnit)) out.push({ orderNo: String(o.order_no), ...sheinUnitShoe(u) });
  return numberPairs(out);
}

/* ---------------------------------- layout ---------------------------------- */

// Words into lines no wider than `w`; a word wider than a line is broken by character.
function wrap(text, w, widthOf, size) {
  const words = ascii(text).split(' ').filter(Boolean);
  const lines = [];
  let cur = '';
  const push = (word) => {
    // a single word wider than the line: hard-break it
    let rest = word;
    while (widthOf(rest, size) > w) {
      let n = rest.length - 1;
      while (n > 1 && widthOf(rest.slice(0, n), size) > w) n--;
      lines.push(rest.slice(0, n)); rest = rest.slice(n);
    }
    return rest;
  };
  for (const word of words) {
    const tryLine = cur ? `${cur} ${word}` : word;
    if (widthOf(tryLine, size) <= w) { cur = tryLine; continue; }
    if (cur) lines.push(cur);
    cur = push(word);
  }
  if (cur) lines.push(cur);
  return lines;
}
// At most `max` lines; the last one ends in "..." when anything was cut.
function capLines(lines, max, w, widthOf, size) {
  if (lines.length <= max) return lines;
  const out = lines.slice(0, max);
  let last = out[max - 1];
  while (last.length && widthOf(`${last}...`, size) > w) last = last.slice(0, -1).trimEnd();
  out[max - 1] = `${last}...`;
  return out;
}

// One entry → its lines, each { text, size, align, right? } (right = a second text on the same line,
// right-aligned). Every width is measured with `widthOf(text, pt)` = Helvetica-Bold width in pt.
export function entryLines(e, widthOf) {
  const W = CONTENT_W;
  const B = PICK.BODY;
  const lines = [];
  // 1 · the order number: never wrapped, never cut. It shrinks only if it must, never under 12 pt.
  const no = ascii(e.orderNo);
  let orderText = `#${no}`;
  let size = B;
  while (size > PICK.ORDER_MIN && widthOf(orderText, size) > W) size -= 0.5;
  if (widthOf(orderText, size) > W) orderText = no;                     // drop the "#" before anything else
  const pairNote = e.pairs > 1 ? `${e.pair} of ${e.pairs}` : '';
  if (widthOf(orderText, size) > W) {
    // No real eBay / SHEIN number gets here (≤ 20 characters; 12 pt holds ~28). Should one ever come, it
    // runs onto a second line, every character kept, rather than off the edge of the label.
    for (const t of wrap(orderText, W, widthOf, size)) lines.push({ text: t, size, kind: 'order' });
  } else {
    const room = pairNote && widthOf(orderText, size) + 12 + widthOf(pairNote, size) <= W;
    lines.push({ text: orderText, size, kind: 'order', ...(room ? { right: pairNote } : {}) });
  }
  // 2 · the shoe: up to 2 lines.
  const name = capLines(wrap(e.name || '(no name)', W, widthOf, B), PICK.NAME_LINES, W, widthOf, B);
  for (const t of name) lines.push({ text: t, size: B, kind: 'name' });
  // 3 · SKU and size on one line when they fit; else the SKU (up to 2 lines), then the size.
  const sku = `SKU ${ascii(e.sku) || '-'}`;
  const sz = `Size ${ascii(e.size) || '?'}`;
  if (widthOf(sku, B) + 14 + widthOf(sz, B) <= W) lines.push({ text: sku, size: B, kind: 'sku', right: sz });
  else {
    for (const t of capLines(wrap(sku, W, widthOf, B), PICK.SKU_LINES, W, widthOf, B)) lines.push({ text: t, size: B, kind: 'sku' });
    lines.push({ text: sz, size: B, kind: 'size' });
  }
  return lines;
}
export const entryHeight = (lines) => lines.length * LINE;

// Entries → pages of drawing operations, in pt from the top-left corner:
//   { t: 'text', text, x, y (baseline), size, align: 'left'|'right' } · { t: 'rule', x1, x2, y, w }
// At most 4 entries a page, and a new page as soon as the next entry wouldn't fit above the footer.
export function layoutPickList(entries, { widthOf, platform = 'ebay', day, madeAt = '' }) {
  const label = PLATFORM_WORDS[platform] || platform;
  const orders = new Set((entries || []).map((e) => e.orderNo)).size;
  const pages = [];
  let page = null;
  let y = 0;
  const open = () => { page = { entries: [], ops: [] }; pages.push(page); y = ENTRIES_TOP; };
  for (const e of entries || []) {
    const lines = entryLines(e, widthOf);
    const h = entryHeight(lines);
    const sep = page && page.entries.length ? SEP_H : 0;
    if (!page || page.entries.length >= PICK.MAX_PER_PAGE || y + sep + h > ENTRIES_BOTTOM) open();
    if (page.entries.length) {
      page.ops.push({ t: 'rule', x1: PICK.M, x2: PICK.W - PICK.M, y: y + PICK.GAP + PICK.RULE / 2, w: PICK.RULE });
      y += SEP_H;
    }
    const top = y;
    lines.forEach((l, i) => {
      const by = baseline(top + i * LINE, l.size, LINE);
      page.ops.push({ t: 'text', text: l.text, x: PICK.M, y: by, size: l.size, align: 'left', kind: l.kind });
      if (l.right) page.ops.push({ t: 'text', text: l.right, x: PICK.W - PICK.M, y: by, size: l.size, align: 'right', kind: `${l.kind}-right` });
    });
    y = top + h;
    page.entries.push({ ...e, top, height: h, lines: lines.length });
  }
  if (!pages.length) { open(); page.ops.push({ t: 'text', text: 'Nothing selected.', x: PICK.M, y: baseline(ENTRIES_TOP, PICK.BODY, LINE), size: PICK.BODY, align: 'left', kind: 'empty' }); }
  // Header and footer on every page, now that the page count is known.
  const pairs = (entries || []).length;
  pages.forEach((p, i) => {
    const hy = baseline(PICK.M, PICK.SMALL, SMALL_LINE);
    p.ops.unshift(
      { t: 'text', text: ascii(`${label} pick list | ${dayWords(day)} EST`), x: PICK.M, y: hy, size: PICK.SMALL, align: 'left', kind: 'header' },
      { t: 'text', text: `page ${i + 1}/${pages.length}`, x: PICK.W - PICK.M, y: hy, size: PICK.SMALL, align: 'right', kind: 'header-right' },
      { t: 'rule', x1: PICK.M, x2: PICK.W - PICK.M, y: PICK.M + SMALL_LINE + 4 + PICK.RULE / 2, w: PICK.RULE },
    );
    const fy = baseline(PICK.H - PICK.M - SMALL_LINE, PICK.SMALL, SMALL_LINE);
    p.ops.push({ t: 'text', text: `${pairs} pair${pairs === 1 ? '' : 's'} | ${orders} order${orders === 1 ? '' : 's'}`, x: PICK.M, y: fy, size: PICK.SMALL, align: 'left', kind: 'footer' });
    if (madeAt) p.ops.push({ t: 'text', text: ascii(madeAt), x: PICK.W - PICK.M, y: fy, size: PICK.SMALL, align: 'right', kind: 'footer-right' });
  });
  return { pages, pairs, orders };
}

/* ------------------------------------ PDF ------------------------------------ */

// Helvetica-Bold width in pt, from jsPDF's own metrics (the same numbers it lays the PDF out with).
export function boldMeasure(doc) {
  return (text, size) => { doc.setFont('helvetica', 'bold'); return doc.getStringUnitWidth(String(text)) * size; };
}
// The PDF itself (a jsPDF doc). `JsPDF` is passed in by tests; the page lazy-loads it.
export async function pickListPdf(entries, { platform, now = new Date(), JsPDF = null } = {}) {
  let Ctor = JsPDF;
  if (!Ctor) {
    const { lazyImport } = await import('./chunkLoad.js');
    const mod = await lazyImport(() => import('jspdf'));
    Ctor = mod.jsPDF || mod.default;
  }
  const doc = new Ctor({ unit: 'pt', format: [PICK.W, PICK.H], orientation: 'portrait', compress: true });
  doc.setProperties({ title: `${PLATFORM_WORDS[platform] || platform} pick list ${estDate(now)}`, creator: 'Stickballman12' });
  const { pages } = layoutPickList(entries, { widthOf: boldMeasure(doc), platform, day: estDate(now), madeAt: `made ${estClock(now)} EST` });
  pages.forEach((p, i) => {
    if (i) doc.addPage([PICK.W, PICK.H], 'portrait');
    doc.setTextColor(0, 0, 0); doc.setDrawColor(0, 0, 0); doc.setFont('helvetica', 'bold');
    for (const op of p.ops) {
      if (op.t === 'rule') { doc.setLineWidth(op.w); doc.setLineCap('butt'); doc.line(op.x1, op.y, op.x2, op.y); continue; }
      doc.setFontSize(op.size);
      doc.text(op.text, op.x, op.y, op.align === 'right' ? { align: 'right' } : undefined);
    }
  });
  return doc;
}
