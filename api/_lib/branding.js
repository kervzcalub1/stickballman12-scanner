// Server-side listing-image branding — composites a shoe photo onto the
// Stickballman12 templates (brick wall + logo + chalk box) with the shoe name and
// SKU, using @napi-rs/canvas so the exact fonts render identically on Railway.
//
// Templates live in src/components/ImageTemplate/{1..7}.png (1600×1600):
//   1..5 = shoe-angle backgrounds · 6 = spec background · 7 = finished welcome slide.
// Fonts (committed) in assets/branding/fonts. "The Youngest" (Canva-only) is
// substituted by Playfair Display for the serif title.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
import { cutoutToPng, cutoutProvider } from './cutout.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const TEMPLATE_DIR = path.join(ROOT, 'src/components/ImageTemplate');
const FONT_DIR = path.join(ROOT, 'assets/branding/fonts');

// All layout/geometry is authored in this 1600×1600 design space; a smaller output
// (e.g. eBay's recommended 1400²) is produced by resampling the finished canvas, so
// the composition is pixel-identical, just a different resolution.
const W = 1600;
export const OUTPUT_SIZES = [1400, 1600]; // client-selectable final sizes (eBay rec = 1400)
// Accept any sane square size (the endpoint also uses a smaller internal preview size);
// anything out of range falls back to the 1600 design size.
const clampOutSize = (n) => { const v = Math.round(Number(n)); return Number.isFinite(v) && v >= 200 && v <= 2000 ? v : W; };
// @napi-rs/canvas JPEG quality is 0–100 (NOT 0–1). 90 ≈ Canva's export (~0.8–1 MB).
const JPEG_QUALITY = 90;
// Placement (validated against the sample): shoe centered in the chalk box; title
// serif at the top (wraps to 2 lines, kept clear of the logo); SKU in Bebas at the
// bottom. Positions are constant across the 5 shoe templates.
const SHOE_BOX = { cx: 800, cy: 812, w: 1050, h: 770 };
// Shoe drop shadow — dialed in the Shadow Playground (canvas-space px, down-right).
// filter: drop-shadow(28px 30px 42px rgba(0,0,0,0.78)).
const SHOE_SHADOW = { offsetX: 28, offsetY: 30, blur: 42, color: 'rgba(0,0,0,0.78)' };
const TITLE = { cx: 800, topY: 188, size: 80, maxW: 1010, lineGap: 12, maxLines: 2 };
const SKU = { cx: 800, y: 1476, size: 104 };
// The bullet block is VERTICALLY CENTERED between boxTop and boxBottom automatically —
// its real height (bullets + wrapped lines) is measured, so it stays centered whether it
// has 3 bullets or 7. contLineH = spacing between wrapped continuation lines within ONE
// bullet; maxW = right edge for wrapping (long colorways wrap here). outlineWidth/
// outlineColor draw a stroke around the bullet text (0 = off). All tuned in the spec playground.
const SPEC = { startX: 300, boxTop: 430, boxBottom: 1200, lineH: 118, size: 96, bulletR: 9, gap: 42, contLineH: 90, maxW: 1000, outlineWidth: 5, outlineColor: '#000000' };

// Encode the canvas to JPEG and stamp the JFIF density to 96 DPI (Canva parity).
// napi-canvas writes units=0/density=1 (which tools read as 72 DPI); we patch the
// APP0 header bytes — units→1 (inch), X/Y density→96. Pixel data is untouched.
function encodeJpeg(canvas, outSize = W) {
  let src = canvas;
  if (outSize !== W) {
    const c = createCanvas(outSize, outSize);
    c.getContext('2d').drawImage(canvas, 0, 0, outSize, outSize); // high-quality downscale
    src = c;
  }
  const buf = src.toBuffer('image/jpeg', JPEG_QUALITY);
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF && buf[3] === 0xE0
    && buf.toString('latin1', 6, 11) === 'JFIF\0') {
    buf[13] = 1;                         // units = dots per inch
    buf.writeUInt16BE(96, 14);           // Xdensity
    buf.writeUInt16BE(96, 16);           // Ydensity
  }
  return buf;
}

let fontsReady = false;
function ensureFonts() {
  if (fontsReady) return;
  // Title = "The Youngest" (Serif Book) — the real Canva face (was Playfair Display,
  // a stand-in). SKU = Bebas Neue.
  GlobalFonts.registerFromPath(path.join(FONT_DIR, 'TheYoungest-Serif-Book.ttf'), 'SbTitle');
  GlobalFonts.registerFromPath(path.join(FONT_DIR, 'BebasNeue-Regular.ttf'), 'SbSku');
  fontsReady = true;
}

// Angle → template number (1..5). The 5 photo slides in listing order.
export const ANGLE_TEMPLATE = { side: 1, diagonal: 2, top: 3, outsole: 4, rear: 5 };
export const SPEC_TEMPLATE = 6;
export const WELCOME_TEMPLATE = 7;

// FALLBACK cutout (colour-threshold flood-fill) — used only if the AI matte fails.
// Removes near-pure-white bg then erodes the soft grey shadow, stopping at shoe
// material. Returns { canvas, bbox } of the trimmed shoe.
function cutoutFallback(shoeImg) {
  const c = createCanvas(shoeImg.width, shoeImg.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(shoeImg, 0, 0);
  const id = ctx.getImageData(0, 0, c.width, c.height);
  const { data, width: iw, height: ih } = id;
  // Stage 1 — remove ONLY the near-pure-white studio background, flood-filled from
  // the borders. Conservative on purpose: anything with real colour or even slightly
  // off-white is the shoe and must be kept. Interior whites (midsoles, stripes) aren't
  // border-connected, so they survive.
  const isWhiteBg = (i) => data[i] > 244 && data[i + 1] > 244 && data[i + 2] > 244;
  const stack = [];
  const seen = new Uint8Array(iw * ih);
  for (let x = 0; x < iw; x++) stack.push(x, 0, x, ih - 1);
  for (let y = 0; y < ih; y++) stack.push(0, y, iw - 1, y);
  while (stack.length) {
    const y = stack.pop(), x = stack.pop();
    if (x < 0 || y < 0 || x >= iw || y >= ih) continue;
    const pi = y * iw + x; if (seen[pi]) continue; seen[pi] = 1;
    if (!isWhiteBg(pi * 4)) continue;
    data[pi * 4 + 3] = 0;
    stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
  }
  // Stage 2 — fade the soft grey drop shadow the white bg left behind: erode inward
  // from the transparent edge, but ONLY through light-grey neutral pixels (the
  // shadow). It stops at any shoe material — dark, coloured, or bright white — so it
  // can't bite into the shoe. Bounded passes keep it to the thin shadow band.
  const isShadow = (i) => {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const mn = Math.min(r, g, b), mx = Math.max(r, g, b);
    return mn >= 206 && mn < 245 && (mx - mn) < 16;
  };
  for (let pass = 0; pass < 7; pass++) {
    const clear = [];
    for (let y = 0; y < ih; y++) for (let x = 0; x < iw; x++) {
      const pi = y * iw + x;
      if (data[pi * 4 + 3] === 0 || !isShadow(pi * 4)) continue;
      if ((x > 0 && data[(pi - 1) * 4 + 3] === 0) || (x < iw - 1 && data[(pi + 1) * 4 + 3] === 0)
        || (y > 0 && data[(pi - iw) * 4 + 3] === 0) || (y < ih - 1 && data[(pi + iw) * 4 + 3] === 0)) clear.push(pi);
    }
    if (!clear.length) break;
    for (const pi of clear) data[pi * 4 + 3] = 0;
  }
  ctx.putImageData(id, 0, 0);
  let minX = iw, minY = ih, maxX = 0, maxY = 0;
  for (let y = 0; y < ih; y++) for (let x = 0; x < iw; x++) {
    if (data[(y * iw + x) * 4 + 3] > 10) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  if (maxX <= minX || maxY <= minY) return { canvas: c, bbox: { x: 0, y: 0, w: iw, h: ih } };
  return { canvas: c, bbox: { x: minX, y: minY, w: maxX - minX, h: maxY - minY } };
}

// Greedy word-wrap to a max pixel width, unbounded lines (for left-aligned spec
// bullets — a long colorway wraps instead of running off the slide).
function wrapGreedy(ctx, text, maxW) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const lines = []; let cur = '';
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t;
  }
  if (cur) lines.push(cur);
  return lines;
}

function wrapLines(ctx, text, maxW, maxLines) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const width = (ws) => ctx.measureText(ws.join(' ')).width;
  if (width(words) <= maxW) return [words.join(' ')];
  // Two-line case: pick the split that BALANCES the line widths (nicer than a greedy
  // fill that dumps one leftover word on line 2).
  if (maxLines >= 2) {
    let best = null;
    for (let i = 1; i < words.length; i++) {
      const w1 = width(words.slice(0, i)), w2 = width(words.slice(i));
      if (w1 <= maxW && w2 <= maxW) { const score = Math.abs(w1 - w2); if (!best || score < best.score) best = { i, score }; }
    }
    if (best) return [words.slice(0, best.i).join(' '), words.slice(best.i).join(' ')];
  }
  // Fallback: greedy fill, capped at maxLines.
  const lines = []; let cur = '';
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t;
  }
  if (cur) lines.push(cur);
  return lines.slice(0, maxLines);
}

// Text drop shadows dialed in the Text Shadow Playground and given in canvas-space px —
// offsetX/offsetY/blur/alpha map 1:1 to the CSS text-shadow the playground exports
// (both preview and render use the same canvas shadow model, so what's tuned is what
// renders). Each element carries its own shadow.
const TITLE_SHADOW = { offsetX: 5.7, offsetY: 5.7, blur: 5, color: 'rgba(0,0,0,1)' };
const SKU_SHADOW = { offsetX: 5.7, offsetY: 5.7, blur: 5, color: 'rgba(0,0,0,1)' };
function applyShadow(ctx, sh) {
  ctx.shadowColor = sh.color;
  ctx.shadowBlur = sh.blur;
  ctx.shadowOffsetX = sh.offsetX;
  ctx.shadowOffsetY = sh.offsetY;
}

function drawTitle(ctx, title) {
  ctx.textAlign = 'center'; ctx.fillStyle = '#fff';
  ctx.font = `${TITLE.size}px SbTitle`;
  const lines = wrapLines(ctx, title, TITLE.maxW, TITLE.maxLines);
  ctx.save();
  applyShadow(ctx, TITLE_SHADOW);
  lines.forEach((ln, i) => ctx.fillText(ln, TITLE.cx, TITLE.topY + i * (TITLE.size + TITLE.lineGap)));
  ctx.restore();
}

function drawSku(ctx, sku) {
  ctx.textAlign = 'center'; ctx.fillStyle = '#fff';
  ctx.font = `${SKU.size}px SbSku`;
  ctx.save();
  applyShadow(ctx, SKU_SHADOW);
  ctx.fillText(String(sku || '').toUpperCase(), SKU.cx, SKU.y);
  ctx.restore();
}

// Tight bounding box of an image's non-transparent pixels (via the alpha channel).
export function alphaBbox(img) {
  const c = createCanvas(img.width, img.height);
  const cx = c.getContext('2d');
  cx.drawImage(img, 0, 0);
  const d = cx.getImageData(0, 0, img.width, img.height).data;
  let minX = img.width, minY = img.height, maxX = 0, maxY = 0;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    if (d[(y * img.width + x) * 4 + 3] > 12) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  if (maxX <= minX || maxY <= minY) return { x: 0, y: 0, w: img.width, h: img.height };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// The default auto-fit placement (shoe bbox centered + scaled into SHOE_BOX). The
// live editor starts from this and lets PH move/scale from here; a saved edit arrives
// as an explicit { dx, dy, dw, dh } transform in 1600-space.
export function fitShoeBox(bbox) {
  const scale = Math.min(SHOE_BOX.w / bbox.w, SHOE_BOX.h / bbox.h);
  const dw = bbox.w * scale, dh = bbox.h * scale;
  return { dx: SHOE_BOX.cx - dw / 2, dy: SHOE_BOX.cy - dh / 2, dw, dh };
}

// Cut a shoe out and return { pngBuffer, bbox, width, height } for the live editor.
// The editor draws this exact PNG, so the final brand reuses it (precut) and the
// placement is truly WYSIWYG.
export async function cutoutForEdit(shoeBuffer) {
  const pngBuffer = await cutoutToPng(shoeBuffer);
  const img = await loadImage(pngBuffer);
  return { pngBuffer, bbox: alphaBbox(img), width: img.width, height: img.height };
}

// Brand one shoe angle: template N + cut-out shoe + title + SKU → JPEG buffer.
// `precut` = shoeBuffer is ALREADY a transparent cutout (from the editor) — don't
// re-cut it. `transform` = explicit { dx, dy, dw, dh } placement in 1600-space (from
// the editor); when absent the shoe auto-fits the chalk box.
export async function brandPhoto({ templateNum = 1, shoeBuffer, title, sku, outSize = W, precut = false, transform = null }) {
  outSize = clampOutSize(outSize);
  ensureFonts();
  const canvas = createCanvas(W, W);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(await loadImage(path.join(TEMPLATE_DIR, `${templateNum}.png`)), 0, 0, W, W);
  if (shoeBuffer) {
    let cut, bbox;
    if (precut) {
      // Already a transparent cutout — load as-is (identical bytes → identical bbox
      // to what the editor measured, so its transform lines up exactly).
      const img = await loadImage(shoeBuffer);
      cut = img; bbox = alphaBbox(img);
    } else {
      // Preferred: AI matte (clean edges, no halo/eaten parts).
      try {
        const img = await loadImage(await cutoutToPng(shoeBuffer));
        cut = img; bbox = alphaBbox(img);
      } catch (e) {
        // The colour-threshold fallback removes the near-white bg but LEAVES the source's
        // baked reflection ("land effect"). That's acceptable as a last resort when no AI
        // provider is even configured (bare local dev), but when a hosted provider IS
        // configured and just failed (usually a Replicate 429 throttle), shipping the
        // land-effect image silently is worse than failing — so re-throw and let the slot
        // report the error, so PH knows to retry rather than saving a bad slide.
        if (cutoutProvider() !== 'local') { console.error('[branding] cutout failed (hosted provider):', e.message); throw e; }
        console.error('[branding] AI cutout failed, using threshold fallback:', e.message);
        const fb = cutoutFallback(await loadImage(shoeBuffer));
        cut = fb.canvas; bbox = fb.bbox;
      }
    }
    const place = (transform && transform.dw > 0 && transform.dh > 0)
      ? transform : fitShoeBox(bbox);
    // Drop shadow dialed in the Shadow Playground (see SHOE_SHADOW). With the clean AI
    // cutout there's no leftover API shadow to clash with, so this reads as one natural
    // shadow rather than the old "landing" artifact.
    ctx.save();
    applyShadow(ctx, SHOE_SHADOW);
    ctx.drawImage(cut, bbox.x, bbox.y, bbox.w, bbox.h, place.dx, place.dy, place.dw, place.dh);
    ctx.restore();
  }
  drawTitle(ctx, title);
  drawSku(ctx, sku);
  return encodeJpeg(canvas, outSize);
}

// Brand the spec slide: template 6 + title + SKU + bullet list → JPEG buffer. Each
// bullet wraps to SPEC.maxW (a long colorway spans multiple lines and pushes the
// bullets below it down, instead of running off the edge of the slide).
export async function brandSpec({ title, sku, bullets = [], outSize = W }) {
  outSize = clampOutSize(outSize);
  ensureFonts();
  const canvas = createCanvas(W, W);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(await loadImage(path.join(TEMPLATE_DIR, `${SPEC_TEMPLATE}.png`)), 0, 0, W, W);
  drawTitle(ctx, title);
  ctx.textAlign = 'left'; ctx.fillStyle = '#fff';
  ctx.font = `${SPEC.size}px SbSku`;
  ctx.lineJoin = 'round'; ctx.miterLimit = 2;
  const outline = SPEC.outlineWidth > 0;
  const shadowOn = () => { ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 5; ctx.shadowOffsetX = 4; ctx.shadowOffsetY = 4; };
  const shadowOff = () => { ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0; };
  // Pre-wrap every bullet so we know the whole block's height, then center it vertically
  // in the spec box. `advance` is the total y-travel of the loop; the baseline span is
  // `advance - lineH` (the last line adds no trailing gap). Offset by half the cap-height
  // (ascent) so the visible glyphs — not the baselines — sit centered.
  const wrapped = bullets.slice(0, 7).map((b) => wrapGreedy(ctx, String(b).toUpperCase(), SPEC.maxW));
  const advance = wrapped.reduce((s, lines) => s + SPEC.lineH + (lines.length - 1) * SPEC.contLineH, 0);
  const tm = ctx.measureText('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
  const ascent = tm.actualBoundingBoxAscent || SPEC.size * 0.72;
  const descent = tm.actualBoundingBoxDescent || 0;
  const centerY = (SPEC.boxTop + SPEC.boxBottom) / 2;
  ctx.save();
  let y = centerY - (advance - SPEC.lineH) / 2 + (ascent - descent) / 2;
  wrapped.forEach((lines) => {
    shadowOn();
    ctx.beginPath(); ctx.arc(SPEC.startX, y - SPEC.size * 0.32, SPEC.bulletR, 0, Math.PI * 2); ctx.fill();
    lines.forEach((ln, li) => {
      const ly = y + li * SPEC.contLineH;
      // Outline first (crisp, no shadow), then the fill on top (with the drop shadow).
      if (outline) { shadowOff(); ctx.lineWidth = SPEC.outlineWidth; ctx.strokeStyle = SPEC.outlineColor; ctx.strokeText(ln, SPEC.startX + SPEC.gap, ly); }
      shadowOn(); ctx.fillText(ln, SPEC.startX + SPEC.gap, ly);
    });
    y += SPEC.lineH + (lines.length - 1) * SPEC.contLineH;
  });
  ctx.restore();
  drawSku(ctx, sku);
  return encodeJpeg(canvas, outSize);
}

// The finished welcome slide is static — just return the template bytes.
export async function welcomeSlide({ outSize = W } = {}) {
  outSize = clampOutSize(outSize);
  const canvas = createCanvas(W, W);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(await loadImage(path.join(TEMPLATE_DIR, `${WELCOME_TEMPLATE}.png`)), 0, 0, W, W);
  return encodeJpeg(canvas, outSize);
}

// Best-effort spec bullets from the marketplace description + colorway. No structured
// spec feed exists, so keyword-match the prose into the standard bullet vocabulary.
// Colour always comes through (from the API colorway).
export function specBulletsFromDescription(description = '', colorway = '') {
  const t = String(description).toLowerCase();
  const bullets = [];
  const has = (...ws) => ws.some((w) => t.includes(w));
  // Fit
  if (has('snug fit', 'snug and comfortable', 'sock-like', 'bootie')) bullets.push('Snug Fit');
  else bullets.push('Regular Fit');
  // Upper — check the real upper materials before "knit" (which usually refers to
  // an interior knit *bootie*, not the upper). Only call it a knit upper when the
  // prose clearly says so.
  if (has('leather upper', 'full-grain', 'suede')) bullets.push('Leather Upper');
  else if (has('synthetic upper', 'molded synthetic', 'synthetic material')) bullets.push('Synthetic Material Upper');
  else if (has('primeknit', 'flyknit', 'knit upper', 'woven upper')) bullets.push('Knit Upper');
  else if (has('mesh upper', 'engineered mesh')) bullets.push('Mesh Upper');
  else if (has('synthetic')) bullets.push('Synthetic Material Upper');
  else if (has('mesh')) bullets.push('Mesh Upper');
  // Sockliner
  if (has('bootie', 'sockliner', 'textile lining', 'knit bootie')) bullets.push('Textile Sockliner');
  // Midsole
  if (has('boost')) bullets.push('Boost Midsole');
  else if (has('zoom', 'react', 'cushlon', 'air unit', 'air-sole')) bullets.push('Cushioned Midsole');
  else if (has('lightstrike', 'bounce', 'foam')) bullets.push('Foam Midsole');
  // Outsole — nearly all performance sneakers have one; default to rubber unless stated.
  if (has('gum outsole', 'gum rubber')) bullets.push('Gum Rubber Outsole');
  else bullets.push('Rubber Outsole');
  if (colorway) bullets.push(`Colorway: ${String(colorway).replace(/\//g, ' / ')}`);
  return bullets;
}
