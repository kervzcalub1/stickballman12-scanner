// AI background removal for the branding pipeline — replaces the old colour-threshold
// flood-fill with a real segmentation matte (clean edges, correct lace-loop holes, no
// eaten shoe parts, no grey halo). Uses BiRefNet (general) via @tugrul/rembg on
// onnxruntime-node — fully in-process on CPU, no API, no per-image cost.
//
// Why the full BiRefNet and not ISNet / BiRefNet-lite: the GOAT studio background is
// near-white, and white shoes (e.g. Air Max 90 'Infrared', all-white uppers) sit on it
// with very low contrast. ISNet and the lite swin_tiny BiRefNet both give the white
// upper/midsole only ~30% confidence, so hardening the matte punches see-through holes
// through the white parts. The full BiRefNet keeps the whole shoe (white heel, midsole,
// translucent Air unit) — it only dims the whole matte uniformly to ~65-80% alpha,
// which liftAlpha() rescales back to opaque. Cost: ~1 GB model, ~45-50 s/image on CPU.
//
// The model isn't committed; it's fetched once to assets/branding/models (gitignored)
// on first use and cached, and the ort session is created once and reused.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ort = require('onnxruntime-node');
const sharp = require('sharp');
const { BackgroundRemover } = require('@tugrul/rembg');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MODEL_DIR = path.join(ROOT, 'assets/branding/models');
const MODEL_PATH = path.join(MODEL_DIR, 'birefnet-full.onnx');
const MODEL_URL = 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/BiRefNet-general-epoch_244.onnx';
// BiRefNet uses ImageNet normalisation (NOT ISNet's [0.5]/[1.0]).
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
const INPUT = 1024; // BiRefNet's native input size

async function ensureModel() {
  if (fs.existsSync(MODEL_PATH) && fs.statSync(MODEL_PATH).size > 1_000_000) return;
  fs.mkdirSync(MODEL_DIR, { recursive: true });
  const resp = await fetch(MODEL_URL);
  if (!resp.ok) throw new Error(`model download failed (${resp.status})`);
  const buf = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(MODEL_PATH, buf);
}

let removerPromise = null;
function getRemover() {
  if (!removerPromise) {
    removerPromise = (async () => {
      await ensureModel();
      const session = await ort.InferenceSession.create(MODEL_PATH, { graphOptimizationLevel: 'all' });
      return new BackgroundRemover(session, MEAN, STD);
    })().catch((e) => { removerPromise = null; throw e; });
  }
  return removerPromise;
}

// Warm the model up front (optional) so the first brand isn't slow.
export async function warmCutout() { try { await getRemover(); return true; } catch { return false; } }

// Lift the BiRefNet matte to a clean cutout. Via @tugrul/rembg the full model returns
// a GLOBALLY-OFFSET matte, not a clean 0/1: on a white shoe against GOAT's near-white
// studio bg the background lands at alpha ~0.66 and the shoe at ~0.88, with a nearly
// empty valley between the two modes. Both the offset and the shoe/bg levels drift
// per-photo, so a fixed threshold is fragile — instead find the valley with Otsu and
// smoothstep a narrow band across it: background → transparent, shoe → opaque, with a
// thin anti-aliased transition at the true edge.
function liftAlpha(data) {
  const total = data.length / 4;
  const hist = new Array(256).fill(0);
  for (let i = 3; i < data.length; i += 4) hist[data[i]]++;
  // Otsu: the threshold that maximises between-class variance (bg vs shoe).
  let sum = 0; for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, maxVar = -1, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > maxVar) { maxVar = v; thr = t; }
  }
  const lo = Math.max(0, thr - 12) / 255, hi = Math.min(255, thr + 12) / 255;
  for (let i = 3; i < data.length; i += 4) {
    const a = data[i] / 255;
    const t = a <= lo ? 0 : a >= hi ? 1 : (a - lo) / (hi - lo);
    data[i] = Math.round((t * t * (3 - 2 * t)) * 255);
  }
  return data;
}

// Belt-and-suspenders after liftAlpha: on some photos (light multicolour uppers on the
// near-white bg) Otsu lands a hair low and leaves the background inside the shoe's
// bounding box at partial alpha — a faint rectangular halo behind the shoe. The real
// background always touches the frame border and the shoe never encloses it, so flood
// the border inward and zero every not-fully-opaque pixel reachable through other
// not-fully-opaque pixels. The opaque shoe body (255) blocks the flood, so interior
// translucency (Air units, etc.) — not border-connected — is preserved.
function clearBorderBackground(data, w, h) {
  const OPAQUE = 235; // ≥ this = shoe, blocks the flood
  const seen = new Uint8Array(w * h);
  const stack = [];
  for (let x = 0; x < w; x++) { stack.push(x, 0, x, h - 1); }
  for (let y = 0; y < h; y++) { stack.push(0, y, w - 1, y); }
  while (stack.length) {
    const y = stack.pop(), x = stack.pop();
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const p = y * w + x;
    if (seen[p]) continue; seen[p] = 1;
    if (data[p * 4 + 3] >= OPAQUE) continue; // hit the shoe — stop
    data[p * 4 + 3] = 0;
    stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
  }
  return data;
}

// Cut a shoe out of its background → transparent PNG buffer. (Not sharp-trimmed:
// trim() compares RGB against the top-left pixel, which for a black shoe on a
// transparent-black border wrongly eats the shoe. The caller trims via the alpha
// channel instead.)
export async function cutoutToPng(buffer) {
  const remover = await getRemover();
  const resized = await sharp(buffer).resize(INPUT, INPUT, { fit: 'inside' }).toBuffer();
  const masked = await remover.mask(sharp(resized));
  const { data, info } = await masked.raw().toBuffer({ resolveWithObject: true });
  liftAlpha(data);
  clearBorderBackground(data, info.width, info.height);
  return sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } }).png().toBuffer();
}
