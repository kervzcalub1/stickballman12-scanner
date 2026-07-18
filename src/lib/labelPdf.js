// Exact-size, one-label-per-page PDF generation for thermal label printers
// (Rollo / Dymo / Brother QL). Replaces `window.print()` + `@page` for labels.
//
// Why a PDF instead of printing the page: on iOS Safari / AirPrint the browser
// IGNORES the CSS `@page { size }` descriptor and force-injects a url / date /
// "Page X of Y" header-footer that `margin:0` can't remove — so labels come out
// mis-scaled with the site URL printed along the bottom, and a single label
// spills across two sheets. A PDF whose page IS the label prints 1:1 with no
// browser chrome, batches naturally as a multi-page document, and behaves the
// same on iOS and desktop. jsPDF + jsbarcode are both lazy-loaded on print.

const PT_PER_MM = 72 / 25.4; // 2.8346 — jsPDF font sizes are in points

// Label stock, keyed for the size <select>. `long`/`short` are the die-cut
// dimensions in mm; labels are laid out landscape (long side = page width) since
// the content (wide barcode) reads best that way — matching what the Brother QL
// driver shows as "Landscape".
export const LABEL_STOCKS = {
  rollo: { label: 'Rollo 2.25 × 1.25"', long: 57.15, short: 31.75 },
  dymo: { label: 'Dymo 2.125 × 1.125"', long: 53.98, short: 28.58 },
  box: { label: 'Box label 3.14 × 1.96"', long: 79.76, short: 49.78 },
  cr80: { label: 'Card 3.375 × 2.125"', long: 85.73, short: 53.98 },
  dk11202: { label: 'Brother 62 × 100 mm (DK-11202)', long: 100, short: 62 },
};

async function loadJsPDF() {
  const mod = await import('jspdf');
  return mod.jsPDF || mod.default;
}
async function loadJsBarcode() {
  const mod = await import('jsbarcode');
  return mod.default || mod;
}

// Render a barcode onto a canvas at generous pixel density so it stays sharp and
// scannable when scaled into the PDF. Returns the canvas, or null if the value
// can't be encoded even as CODE128.
function barcodeCanvas(JsBarcode, value, { format = 'CODE128', height = 90, width = 2 } = {}) {
  const canvas = document.createElement('canvas');
  const opts = { displayValue: false, height, width, margin: 0 };
  try {
    JsBarcode(canvas, String(value), { format, ...opts });
  } catch {
    try { JsBarcode(canvas, String(value), { format: 'CODE128', ...opts }); }
    catch { return null; }
  }
  return canvas;
}

// Rotate a canvas 90° CCW so a horizontal barcode becomes a vertical one (box
// labels put the UPC on the left edge, like a real shoe box).
function rotate90(canvas) {
  const r = document.createElement('canvas');
  r.width = canvas.height;
  r.height = canvas.width;
  const ctx = r.getContext('2d');
  ctx.translate(r.width / 2, r.height / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
  return r;
}

// Vertically-centered stack of centered blocks that auto-scales to fill the
// label. `blocks` items: { kind:'text', text, pt0, bold, mono, clamp } or
// { kind:'img', dataUrl, h0, fill }. `pt0`/`h0` are base sizes; a single scale
// factor `k` is chosen so the whole stack fits the page height, then applied to
// every block — so the same design fills a tiny Rollo and a big 62×100 label.
function drawStack(doc, pw, ph, blocks) {
  const gap0 = 1.3;
  const maxW = pw * 0.9;
  const measure = (k) => blocks.map((b) => {
    if (b.kind === 'img') return { ...b, h: b.h0 * k };
    doc.setFont(b.mono ? 'courier' : 'helvetica', b.bold ? 'bold' : 'normal');
    doc.setFontSize(b.pt0 * k);
    let lines = doc.splitTextToSize(b.text, maxW);
    if (b.clamp) lines = lines.slice(0, b.clamp);
    const lh = (b.pt0 * k) / PT_PER_MM * 1.12;
    return { ...b, lines, lh, h: lines.length * lh };
  });
  const at1 = measure(1);
  const total1 = at1.reduce((s, b) => s + b.h, 0) + gap0 * (at1.length - 1);
  const k = Math.min(2.4, (ph * 0.9) / total1);
  const m = measure(k);
  const total = m.reduce((s, b) => s + b.h, 0) + gap0 * k * (m.length - 1);
  let y = (ph - total) / 2;
  for (const b of m) {
    if (b.kind === 'img') {
      const w = b.fill ? pw * 0.88 : b.w0 * k;
      doc.addImage(b.dataUrl, 'PNG', (pw - w) / 2, y, w, b.h);
    } else {
      doc.setFont(b.mono ? 'courier' : 'helvetica', b.bold ? 'bold' : 'normal');
      doc.setFontSize(b.pt0 * k);
      b.lines.forEach((ln, i) => doc.text(ln, pw / 2, y + i * b.lh, { align: 'center', baseline: 'top' }));
    }
    y += b.h + gap0 * k;
  }
}

// One VIN tracking label: shoe name (2-line clamp), SKU | SIZE, VIN, CODE128
// barcode of the VIN, VIN text.
function drawVinLabel(doc, JsBarcode, pw, ph, it) {
  const blocks = [];
  if (it.name) blocks.push({ kind: 'text', text: String(it.name).toUpperCase(), pt0: 8, bold: true, clamp: 2 });
  blocks.push({ kind: 'text', text: `${it.sku || '—'}   |   ${it.size || '—'}`, pt0: 14, bold: true });
  blocks.push({ kind: 'text', text: `VIN: ${it.vin}`, pt0: 8, bold: true });
  const bc = barcodeCanvas(JsBarcode, it.vin, { format: 'CODE128' });
  if (bc) blocks.push({ kind: 'img', dataUrl: bc.toDataURL('image/png'), h0: 9, fill: true });
  blocks.push({ kind: 'text', text: it.vin, pt0: 7.5, mono: true });
  drawStack(doc, pw, ph, blocks);
}

// One box-style label (No-Box UPC): vertical UPC barcode on the left, text block
// (name / big size / colorway / SKU) on the right — mirrors a real shoe box. If
// there's no UPC on file we fall back to a centered text-only label.
function drawBoxLabel(doc, JsBarcode, pw, ph, it) {
  const upc = it.upc ? String(it.upc).replace(/\D/g, '') : '';
  const bc = upc ? barcodeCanvas(JsBarcode, upc, { format: upc.length === 12 ? 'UPC' : upc.length === 13 ? 'EAN13' : 'CODE128' }) : null;
  if (!bc) {
    const blocks = [
      { kind: 'text', text: String(it.name || '—').toUpperCase(), pt0: 10, bold: true, clamp: 2 },
      { kind: 'text', text: String(it.size || '—'), pt0: 20, bold: true },
      { kind: 'text', text: String(it.sku || '—'), pt0: 12, bold: true },
      { kind: 'text', text: `No UPC on file — ${it.vin}`, pt0: 8 },
    ];
    drawStack(doc, pw, ph, blocks);
    return;
  }
  // Left column: rotated (vertical) barcode.
  const rot = rotate90(bc);
  const colW = pw * 0.16;
  const bcH = ph * 0.82;
  const bcW = Math.min(colW * 0.9, (rot.width / rot.height) * bcH);
  const padX = pw * 0.05;
  doc.addImage(rot.toDataURL('image/png'), 'PNG', padX + (colW - bcW) / 2, (ph - bcH) / 2, bcW, bcH);
  // Right column: text stack, left-aligned.
  const tx = padX + colW + pw * 0.04;
  const tw = pw - tx - pw * 0.05;
  const rows = [];
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  const nameLines = doc.splitTextToSize(String(it.name || '—').toUpperCase(), tw).slice(0, 2);
  rows.push({ lines: nameLines, pt: 11 });
  rows.push({ lines: [String(it.size || '—')], pt: 22 });
  if (it.colorway) rows.push({ lines: doc.splitTextToSize(String(it.colorway).toUpperCase(), tw).slice(0, 1), pt: 8 });
  rows.push({ lines: [String(it.sku || '—')], pt: 13 });
  const heights = rows.map((r) => r.lines.length * (r.pt / PT_PER_MM * 1.12));
  const gap = ph * 0.03;
  const totalH = heights.reduce((s, h) => s + h, 0) + gap * (rows.length - 1);
  let ty = (ph - totalH) / 2;
  rows.forEach((r, ri) => {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(r.pt);
    const lh = r.pt / PT_PER_MM * 1.12;
    r.lines.forEach((ln, i) => doc.text(ln, tx, ty + i * lh, { align: 'left', baseline: 'top' }));
    ty += heights[ri] + gap;
  });
}

// One shelf-location label: big location name, warehouse/area sub-line, CODE128
// barcode of the location code, code text.
function drawShelfLabel(doc, JsBarcode, pw, ph, loc) {
  const blocks = [
    { kind: 'text', text: String(loc.label || loc.code), pt0: 26, bold: true, clamp: 1 },
  ];
  const sub = `${loc.warehouse || ''}${loc.area ? ` · ${loc.area}` : ''}`.trim();
  if (sub) blocks.push({ kind: 'text', text: sub.toUpperCase(), pt0: 7 });
  const bc = barcodeCanvas(JsBarcode, loc.code, { format: 'CODE128' });
  if (bc) blocks.push({ kind: 'img', dataUrl: bc.toDataURL('image/png'), h0: 9, fill: true });
  blocks.push({ kind: 'text', text: String(loc.code), pt0: 9, mono: true });
  drawStack(doc, pw, ph, blocks);
}

// Build a multi-page PDF, one label per page, sized exactly to the stock.
// `kind`: 'vin' | 'box' | 'shelf'. Returns a jsPDF doc (ready to output).
export async function buildLabelPdf({ kind, items, stock }) {
  const s = LABEL_STOCKS[stock] || LABEL_STOCKS.rollo;
  const list = (items || []).filter(Boolean);
  const [jsPDF, JsBarcode] = await Promise.all([loadJsPDF(), loadJsBarcode()]);
  const W = s.long;
  const H = s.short;
  let doc = null;
  for (const it of list) {
    if (!doc) doc = new jsPDF({ unit: 'mm', format: [W, H], orientation: 'landscape' });
    else doc.addPage([W, H], 'landscape');
    const pw = doc.internal.pageSize.getWidth();
    const ph = doc.internal.pageSize.getHeight();
    if (kind === 'box') drawBoxLabel(doc, JsBarcode, pw, ph, it);
    else if (kind === 'shelf') drawShelfLabel(doc, JsBarcode, pw, ph, it);
    else drawVinLabel(doc, JsBarcode, pw, ph, it);
  }
  if (!doc) doc = new jsPDF({ unit: 'mm', format: [W, H], orientation: 'landscape' }); // empty guard
  return doc;
}

// True for touch devices whose print pipeline blocks programmatic printing
// (iOS Safari, Android Chrome). There we open the PDF in a new tab so the user
// can share → Print; on desktop we auto-print via a hidden iframe.
export function isTouchPrint() {
  const ua = navigator.userAgent || '';
  return /iP(hone|ad|od)|Android/.test(ua) || (/Macintosh/.test(ua) && 'ontouchend' in document);
}

// Hand a built PDF to the OS. On touch devices pass a `preWin` opened
// synchronously in the click handler (so it isn't popup-blocked); we set its
// location to the PDF. On desktop we print via a hidden iframe.
export function dispatchPdf(doc, preWin) {
  const blob = doc.output('blob');
  const url = URL.createObjectURL(blob);
  if (preWin) {
    preWin.location.href = url;
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return;
  }
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  iframe.src = url;
  iframe.onload = () => {
    try { iframe.contentWindow.focus(); iframe.contentWindow.print(); } catch { /* ignore */ }
    setTimeout(() => { URL.revokeObjectURL(url); iframe.remove(); }, 60000);
  };
  document.body.appendChild(iframe);
}
