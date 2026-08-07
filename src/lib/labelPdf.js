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

import { sizeParts } from './codes.js';

const PT_PER_MM = 72 / 25.4; // 2.8346 — jsPDF font sizes are in points

// Label stock, keyed for the size <select>. `long`/`short` are the die-cut
// dimensions in mm; labels are laid out landscape (long side = page width) since
// the content (wide barcode) reads best that way — matching what the Brother QL
// driver shows as "Landscape".
export const LABEL_STOCKS = {
  small35: { label: 'Small 1.1 × 3.5"', long: 88.9, short: 27.94 },
  rollo: { label: 'Rollo 2.25 × 1.25"', long: 57.15, short: 31.75 },
  dymo: { label: 'Dymo 2.125 × 1.125"', long: 53.98, short: 28.58 },
  box: { label: 'Box label 3.14 × 1.96"', long: 79.76, short: 49.78 },
  cr80: { label: 'Card 3.375 × 2.125"', long: 85.73, short: 53.98 },
  dk11202: { label: 'Brother 62 × 100 mm (DK-11202)', long: 100, short: 62 },
};

// The shoe name only fits legibly on a large label. On anything smaller than the
// 62 × 100 mm stock we drop it — SKU + size + VIN barcode is all the warehouse /
// shelving flow needs, and cramming the name onto a small label just shrinks the
// bits that actually get scanned/read. Threshold keyed on the short side.
const NAME_MIN_SHORT_MM = 62;

// A lazily-imported vendor chunk that fails to load is almost always a STALE TAB,
// not a broken build: every deploy renames the lazy chunks (each one embeds the
// main bundle's hash in its own content, so its filename hash moves too), and a
// tab left open across a deploy asks the server for a filename that no longer
// exists. The warehouse keeps the app open all shift, so this is routine. Tag the
// failure so the UI can say "reload" — swallowing it is what made a box label
// render with a blank barcode column and a Print button that did nothing.
export class ChunkLoadError extends Error {
  constructor(cause) {
    super('The app was updated while this tab was open. Reload the page, then print again.');
    this.name = 'ChunkLoadError';
    this.cause = cause;
  }
}
export const isChunkLoadError = (e) => e?.name === 'ChunkLoadError';

async function lazy(load) {
  try { return await load(); }
  catch (e) { throw new ChunkLoadError(e); }
}
async function loadJsPDF() {
  return lazy(async () => {
    const mod = await import('jspdf');
    return mod.jsPDF || mod.default;
  });
}
// Shared with the on-screen <Barcode> preview so both halves of a label fail the
// same way — and say the same thing — when the chunk is gone.
export async function loadJsBarcode() {
  return lazy(async () => {
    const mod = await import('jsbarcode');
    return mod.default || mod;
  });
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

// One VIN tracking label: shoe name (2-line clamp, large stock only), SKU | SIZE,
// VIN, CODE128 barcode of the VIN, VIN text.
function drawVinLabel(doc, JsBarcode, pw, ph, it, showName) {
  const blocks = [];
  if (showName && it.name) blocks.push({ kind: 'text', text: String(it.name).toUpperCase(), pt0: 8, bold: true, clamp: 2 });
  blocks.push({ kind: 'text', text: `${it.sku || '—'}   |   ${it.size || '—'}`, pt0: 14, bold: true });
  blocks.push({ kind: 'text', text: `VIN: ${it.vin}`, pt0: 8, bold: true });
  // A tracking label whose barcode didn't encode is just a sticker — it can't be
  // scanned, and nobody notices until the pair is on a shelf. Fail the print.
  const bc = barcodeCanvas(JsBarcode, it.vin, { format: 'CODE128' });
  if (!bc) throw new Error(`Couldn’t build the barcode for ${it.vin}.`);
  blocks.push({ kind: 'img', dataUrl: bc.toDataURL('image/png'), h0: 9, fill: true });
  blocks.push({ kind: 'text', text: it.vin, pt0: 7.5, mono: true });
  drawStack(doc, pw, ph, blocks);
}

// One box-style label (No-Box UPC): vertical UPC barcode on the left, text block
// on the right — mirrors a real shoe box, so the rows run in the same order Nike
// prints them: NAME, colorway (lighter/narrower, directly under the name), then
// the big size, then the SKU. The size carries the men's/women's marker
// ("9 W" / "11.5 M") set small next to the number, since a bare "9" on a
// replacement box doesn't say which it is. If there's no UPC on file we fall
// back to a centered text-only label with the same row order.
function drawBoxLabel(doc, JsBarcode, pw, ph, it) {
  const sz = sizeParts(it.size, it.gender, it.name);
  const upc = it.upc ? String(it.upc).replace(/\D/g, '') : '';
  const bc = upc ? barcodeCanvas(JsBarcode, upc, { format: upc.length === 12 ? 'UPC' : upc.length === 13 ? 'EAN13' : 'CODE128' }) : null;
  // "No UPC on file" is a truthful label for a pair we never got a UPC for. It is
  // a LIE when we have one and merely failed to encode it — that prints a label
  // the warehouse believes is the best we could do, when a reload would have
  // produced a scannable one. Only the genuinely-empty case falls back.
  if (upc && !bc) throw new Error(`Couldn’t build the barcode for UPC ${upc}.`);
  if (!bc) {
    const blocks = [
      { kind: 'text', text: String(it.name || '—').toUpperCase(), pt0: 10, bold: true, clamp: 2 },
    ];
    if (it.colorway) blocks.push({ kind: 'text', text: String(it.colorway).toUpperCase(), pt0: 7, clamp: 2 });
    blocks.push({ kind: 'text', text: sz.num ? `${sz.num}${sz.suffix ? ` ${sz.suffix}` : ''}` : '—', pt0: 20, bold: true });
    blocks.push({ kind: 'text', text: String(it.sku || '—'), pt0: 12, bold: true });
    // A box label can be printed for a catalogue hit with no unit behind it
    // (Box Labels tool, "label only") — then there's no VIN to name.
    blocks.push({ kind: 'text', text: it.vin ? `No UPC on file — ${it.vin}` : 'No UPC on file', pt0: 8 });
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
  rows.push({ lines: doc.splitTextToSize(String(it.name || '—').toUpperCase(), tw).slice(0, 2), pt: 11, bold: true });
  if (it.colorway) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    rows.push({ lines: doc.splitTextToSize(String(it.colorway).toUpperCase(), tw).slice(0, 2), pt: 8, bold: false });
  }
  // Size and its M/W marker are ONE string at ONE size — same weight, same
  // baseline, no chance of them drifting apart. `fit` shrinks the row if a long
  // one ("10.5 W") would run past the label edge on small stock.
  rows.push({ lines: [sz.num ? `${sz.num}${sz.suffix ? ` ${sz.suffix}` : ''}` : '—'], pt: 22, bold: true, fit: true });
  rows.push({ lines: [String(it.sku || '—')], pt: 13, bold: true });
  const gap = ph * 0.03;
  const measure = (k) => rows.map((r) => r.lines.length * (r.pt * k / PT_PER_MM * 1.12));
  // A two-line name AND a two-line colorway can outgrow a small stock, so scale
  // the whole column down to fit rather than letting rows run off the label.
  const total1 = measure(1).reduce((s, h) => s + h, 0) + gap * (rows.length - 1);
  const k = Math.min(1, (ph * 0.94) / total1);
  const heights = measure(k);
  const totalH = heights.reduce((s, h) => s + h, 0) + gap * k * (rows.length - 1);
  let ty = (ph - totalH) / 2;
  rows.forEach((r, ri) => {
    let pt = r.pt * k;
    doc.setFont('helvetica', r.bold ? 'bold' : 'normal');
    doc.setFontSize(pt);
    // Unwrapped rows (the size) would run off the edge rather than wrap — pull
    // them back to the column width instead.
    if (r.fit) {
      const w = doc.getTextWidth(r.lines[0]);
      if (w > tw) { pt *= tw / w; doc.setFontSize(pt); }
    }
    const lh = pt / PT_PER_MM * 1.12;
    r.lines.forEach((ln, i) => doc.text(ln, tx, ty + i * lh, { align: 'left', baseline: 'top' }));
    ty += heights[ri] + gap * k;
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
  if (!bc) throw new Error(`Couldn’t build the barcode for ${loc.code}.`);
  blocks.push({ kind: 'img', dataUrl: bc.toDataURL('image/png'), h0: 9, fill: true });
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
  const showName = s.short >= NAME_MIN_SHORT_MM;
  let doc = null;
  for (const it of list) {
    if (!doc) doc = new jsPDF({ unit: 'mm', format: [W, H], orientation: 'landscape' });
    else doc.addPage([W, H], 'landscape');
    const pw = doc.internal.pageSize.getWidth();
    const ph = doc.internal.pageSize.getHeight();
    if (kind === 'box') drawBoxLabel(doc, JsBarcode, pw, ph, it);
    else if (kind === 'shelf') drawShelfLabel(doc, JsBarcode, pw, ph, it);
    else drawVinLabel(doc, JsBarcode, pw, ph, it, showName);
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
//
// Every path here has a way to fail that leaves the user staring at the preview
// with nothing happening — a blocked popup, a `frame-src` that won't allow a
// `blob:` frame, an `onload` that never comes. So each one falls back to simply
// downloading the PDF: an extra tap to open it, but never a dead button.
export function dispatchPdf(doc, preWin, filename = 'labels.pdf') {
  const url = URL.createObjectURL(doc.output('blob'));
  const release = () => setTimeout(() => URL.revokeObjectURL(url), 60000);
  let settled = false;
  const download = () => {
    if (settled) return;
    settled = true;
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    release();
  };

  if (preWin) { settled = true; preWin.location.href = url; release(); return; }
  // Touch with no window means the popup was blocked — iOS won't print a hidden
  // iframe either, so go straight to the file.
  if (isTouchPrint()) { download(); return; }

  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  iframe.src = url;
  // A CSP-blocked frame still fires `load` — but on an opaque about:blank, where
  // touching contentWindow throws SecurityError. That throw is the signal that
  // the frame never got the PDF, so treat it as a failure rather than a
  // shrugged-off "ignore" that prints nothing.
  const timer = setTimeout(() => { iframe.remove(); download(); }, 4000);
  iframe.onload = () => {
    clearTimeout(timer);
    try {
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
    } catch {
      iframe.remove();
      download();
      return;
    }
    settled = true;
    setTimeout(() => { URL.revokeObjectURL(url); iframe.remove(); }, 60000);
  };
  document.body.appendChild(iframe);
}
