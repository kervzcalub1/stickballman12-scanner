// AI background removal for the branding pipeline. Two interchangeable providers,
// selected at runtime by cutoutProvider() — the rest of the pipeline is identical:
//
//   • 'local'    — BiRefNet (general) via @tugrul/rembg on onnxruntime-node, fully
//                  in-process on CPU. No API, no per-image cost, best matte quality.
//                  BUT: ~1 GB model in RAM + ~45-50 s/image. Fine on a dev box; on a
//                  small web dyno it OOM-kills the process and blows the request past
//                  the gateway timeout → 502. This is the DEFAULT (localhost).
//   • 'removebg' — hosted remove.bg call: a few seconds/image, no model in memory, no
//                  onnxruntime/sharp loaded at all. Set REMOVEBG_API_KEY (or
//                  CUTOUT_PROVIDER=removebg) on constrained hosts (Railway) so Brand
//                  & Fill runs without the 1 GB model. Costs per image.
//
// Why the full BiRefNet locally and not ISNet / BiRefNet-lite: the GOAT studio
// background is near-white, and white shoes (e.g. Air Max 90 'Infrared', all-white
// uppers) sit on it with very low contrast. ISNet and the lite swin_tiny BiRefNet both
// give the white upper/midsole only ~30% confidence, so hardening the matte punches
// see-through holes through the white parts. The full BiRefNet keeps the whole shoe
// (white heel, midsole, translucent Air unit) — it only dims the whole matte uniformly
// to ~65-80% alpha, which liftAlpha() rescales back to opaque.
//
// The local model isn't committed; it's fetched once to assets/branding/models
// (gitignored) on first use and cached, and the ort session is created once and reused.
// The heavy native deps (onnxruntime-node, sharp, @tugrul/rembg) are required LAZILY so
// the 'removebg' path never loads them — that's what keeps prod off the 1 GB model.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fetchWithTimeout } from './util.js';

const require = createRequire(import.meta.url);
// Lazy native-module getters — only the 'local' provider ever touches these, so hosts
// running 'removebg' never load onnxruntime/sharp (nor risk their native-binary install).
let _ort, _sharp, _rembg;
const ort = () => (_ort ||= require('onnxruntime-node'));
const sharpLib = () => (_sharp ||= require('sharp'));
const rembg = () => (_rembg ||= require('@tugrul/rembg'));

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
      const session = await ort().InferenceSession.create(MODEL_PATH, { graphOptimizationLevel: 'all' });
      return new (rembg().BackgroundRemover)(session, MEAN, STD);
    })().catch((e) => { removerPromise = null; throw e; });
  }
  return removerPromise;
}

// Warm the model up front (optional) so the first brand isn't slow. No-op unless the
// local provider is active — we must never trigger the 1 GB download on a removebg host.
export async function warmCutout() {
  if (cutoutProvider() !== 'local') return true;
  try { await getRemover(); return true; } catch { return false; }
}

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

// Which cutout provider to use. Explicit CUTOUT_PROVIDER wins; otherwise a present
// REMOVEBG_API_KEY opts into the hosted path, else the in-process BiRefNet model.
export function cutoutProvider() {
  const p = (process.env.CUTOUT_PROVIDER || '').trim().toLowerCase();
  if (p) return p;
  return process.env.REMOVEBG_API_KEY ? 'removebg' : 'local';
}

// Cut a shoe out of its background → transparent PNG buffer. Dispatches to the active
// provider; both return the same shape (PNG bytes with a clean alpha) so the branding
// pipeline (bbox trim, shadow, composite) doesn't care which one ran.
export async function cutoutToPng(buffer) {
  if (cutoutProvider() === 'removebg') return cutoutRemoveBg(buffer);
  return cutoutLocal(buffer);
}

// Hosted provider: remove.bg returns an already-clean transparent PNG, so none of the
// local matte post-processing (liftAlpha / clearBorderBackground) applies here.
async function cutoutRemoveBg(buffer) {
  const key = process.env.REMOVEBG_API_KEY;
  if (!key) throw new Error('REMOVEBG_API_KEY is not set');
  const form = new FormData();
  form.append('image_file', new Blob([buffer]), 'shoe.png');
  form.append('size', 'auto');     // best resolution the account's plan allows
  form.append('format', 'png');    // keep the alpha channel
  form.append('type', 'product');  // shoes are product shots
  const resp = await fetchWithTimeout(
    'https://api.remove.bg/v1.0/removebg',
    { method: 'POST', headers: { 'X-Api-Key': key }, body: form },
    30000,
  );
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`remove.bg ${resp.status} ${detail.slice(0, 200)}`);
  }
  return Buffer.from(await resp.arrayBuffer());
}

// Local provider: BiRefNet matte + valley-lift + border flood. (Not sharp-trimmed:
// trim() compares RGB against the top-left pixel, which for a black shoe on a
// transparent-black border wrongly eats the shoe. The caller trims via the alpha
// channel instead.)
async function cutoutLocal(buffer) {
  const sharp = sharpLib();
  const remover = await getRemover();
  const resized = await sharp(buffer).resize(INPUT, INPUT, { fit: 'inside' }).toBuffer();
  const masked = await remover.mask(sharp(resized));
  const { data, info } = await masked.raw().toBuffer({ resolveWithObject: true });
  liftAlpha(data);
  clearBorderBackground(data, info.width, info.height);
  return sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } }).png().toBuffer();
}
