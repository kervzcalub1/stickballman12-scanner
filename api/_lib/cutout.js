// AI background removal for the branding pipeline. Two interchangeable providers,
// selected at runtime by cutoutProvider() — the rest of the pipeline is identical:
//
//   • 'local'     — BiRefNet (general) via @tugrul/rembg on onnxruntime-node, fully
//                   in-process on CPU. No API, no per-image cost, best matte quality.
//                   BUT: ~1 GB model in RAM + ~45-50 s/image. Fine on a dev box; on a
//                   small web dyno it OOM-kills the process and blows the request past
//                   the gateway timeout → 502. This is the DEFAULT (localhost).
//   • 'replicate' — hosted Replicate running BiRefNet (the SAME model as local, so the
//                   matte matches what was validated on the white shoes). ~$0.0005/img,
//                   no model in memory. PREFERRED for prod: set REPLICATE_API_TOKEN.
//   • 'removebg'  — hosted remove.bg call: simple sync API but ~$0.23/img (pricey).
//                   Set REMOVEBG_API_KEY. Kept as an alternative.
// Both hosted paths run in seconds and never load onnxruntime/sharp or the 1 GB model.
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
// hosted-provider key opts in (Replicate preferred — cheapest and runs BiRefNet, the
// same model as local), else the in-process BiRefNet.
export function cutoutProvider() {
  const p = (process.env.CUTOUT_PROVIDER || '').trim().toLowerCase();
  if (p) return p;
  if (process.env.REPLICATE_API_TOKEN) return 'replicate';
  if (process.env.REMOVEBG_API_KEY) return 'removebg';
  return 'local';
}

// Cut a shoe out of its background → transparent PNG buffer. Dispatches to the active
// provider; all return the same shape (PNG bytes with a clean alpha) so the branding
// pipeline (bbox trim, shadow, composite) doesn't care which one ran.
export async function cutoutToPng(buffer) {
  switch (cutoutProvider()) {
    case 'replicate': return cutoutReplicate(buffer);
    case 'removebg':  return cutoutRemoveBg(buffer);
    default:          return cutoutLocal(buffer);
  }
}

// Hosted provider: Replicate running BiRefNet — the SAME architecture as the local
// model, so the matte matches what was validated on the low-contrast white shoes, at
// ~$0.0005/image and zero infra. Returns an already-clean transparent PNG (no local
// matte post-processing). Community models run via /v1/predictions with a version hash
// (the /v1/models/.../predictions shortcut is official-models only), so we resolve the
// model's latest version once (cached) and reuse it. `Prefer: wait` gives a near-
// synchronous response; we poll if the job hasn't finished inside the wait window.
const REPLICATE_MODEL = process.env.REPLICATE_MODEL || '851-labs/background-remover';
let _replicateVersion = null;
async function replicateVersion(auth) {
  if (process.env.REPLICATE_VERSION) return process.env.REPLICATE_VERSION;
  if (_replicateVersion) return _replicateVersion;
  const r = await fetchWithTimeout(`https://api.replicate.com/v1/models/${REPLICATE_MODEL}`, { headers: auth }, 15000);
  if (!r.ok) throw new Error(`replicate model lookup ${r.status}`);
  const id = (await r.json())?.latest_version?.id;
  if (!id) throw new Error(`replicate model ${REPLICATE_MODEL} has no version`);
  _replicateVersion = id;
  return id;
}
async function cutoutReplicate(buffer) {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) throw new Error('REPLICATE_API_TOKEN is not set');
  const auth = { Authorization: `Bearer ${token}` };
  const version = await replicateVersion(auth);
  // Pass the shoe bytes inline as a data URI — no need to host/upload it first.
  const dataUri = `data:image/png;base64,${buffer.toString('base64')}`;
  const body = JSON.stringify({ version, input: { image: dataUri, format: 'png' } });
  // Retry on 429: Replicate throttles hard (6/min, burst 1) while account credit < $5,
  // and Brand & Fill fires cutouts back-to-back. Without this a throttled request would
  // fall through to the threshold cutout (which leaves a background box). Wait + retry.
  let resp;
  for (let attempt = 0; ; attempt++) {
    resp = await fetchWithTimeout(
      'https://api.replicate.com/v1/predictions',
      { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', Prefer: 'wait' }, body },
      70000, // > the 60s server-side `Prefer: wait` window
    );
    if (resp.status !== 429 || attempt >= 4) break;
    const retryAfter = Number(resp.headers.get('retry-after'));
    const waitS = Math.min(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 3 * (attempt + 1), 15);
    await new Promise((r) => setTimeout(r, waitS * 1000));
  }
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`replicate create ${resp.status} ${detail.slice(0, 200)}`);
  }
  let pred = await resp.json();
  // Poll to a terminal state if `Prefer: wait` returned before completion.
  const started = Date.now();
  while (!['succeeded', 'failed', 'canceled'].includes(pred.status)) {
    if (Date.now() - started > 120000) throw new Error('replicate timed out');
    await new Promise((r) => setTimeout(r, 1500));
    const get = await fetchWithTimeout(pred.urls.get, { headers: auth }, 15000);
    if (!get.ok) throw new Error(`replicate poll ${get.status}`);
    pred = await get.json();
  }
  if (pred.status !== 'succeeded') throw new Error(`replicate ${pred.status}: ${pred.error || ''}`);
  const out = Array.isArray(pred.output) ? pred.output[0] : pred.output;
  if (!out || typeof out !== 'string') throw new Error('replicate returned no image');
  const img = await fetchWithTimeout(out, {}, 30000);
  if (!img.ok) throw new Error(`replicate output fetch ${img.status}`);
  return Buffer.from(await img.arrayBuffer());
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
