// Reading a cancellation photo on OUR server, no AI (owner, 2026-11-10; docs/context/cancellations.md).
//
// tesseract reads the picture into text, TWICE, prepared two different ways (large + sharpened
// as scattered text, and smaller + plain grey as a page — black-and-white lost a label with a
// shadow across it, so it isn't used). src/lib/cancellations.js
// `ordersFromText` picks the order numbers out of each text. A number both reads found is
// "agreed"; one only a single read found is still filed, flagged "reads disagree", so it is
// never lost. Nothing leaves the server, and it costs nothing per photo.
//
// Measured on the real Alias labels of 2026-10-20 (WhatsApp copies, 471 px wide): order #,
// style code and size all read right; the small "ORDER #" caption and the tracking line don't
// read at all — which is why `ordersFromText` takes a lone 9–10 digit line on a packing label.
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { ordersFromText, orderKey } from '../../src/lib/cancellations.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..'); // eng.traineddata is checked in
const TIMEOUT_MS = 25_000;   // a noisy photo of a screen can run past this; then the AI (or a person) has it

/** Can sharp open this picture at all? (An iPhone HEIC sent "as a file" can't be.) */
export async function canOpenImage(buf) {
  try { const sharp = (await import('sharp')).default; await sharp(buf).metadata(); return true; } catch { return false; }
}

async function readOnce(buf) {
  const sharp = (await import('sharp')).default;
  const { createWorker, PSM } = await import('tesseract.js');
  const meta = await sharp(buf).rotate().metadata();
  const wide = Math.max(meta.width || 0, meta.height || 0) || 1600;
  // Scale so the long edge is ~3600 / ~2400 px: small print on a phone photo needs the room.
  const big = await sharp(buf).rotate().resize({ width: Math.round(3600 * (meta.width || wide) / wide) })
    .greyscale().normalise().sharpen().png().toBuffer();
  const page = await sharp(buf).rotate().resize({ width: Math.round(2400 * (meta.width || wide) / wide) })
    .greyscale().normalise().png().toBuffer();
  let worker; let timer;
  try {
    worker = await createWorker('eng', 1, { langPath: REPO_ROOT, gzip: false, cachePath: tmpdir() });
    const run = async () => {
      await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
      const a = (await worker.recognize(big)).data.text;
      await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
      const b = await worker.recognize(page).then((r) => r.data.text, () => null);
      return { a, b };
    };
    const late = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('local read timed out')), TIMEOUT_MS); });
    return await Promise.race([run(), late]);
  } finally {
    clearTimeout(timer);
    if (worker) await worker.terminate().catch(() => {});
  }
}

// One at a time: each worker loads the language model into memory, and an album is several
// photos arriving at once.
let queue = Promise.resolve();
const queued = (fn) => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run; };

/**
 * The picture → { orders:[…], what, text } in the same shape the AI reader returns, plus the
 * text it read (kept on the row, so a miss can be turned into a new rule). Throws only when
 * tesseract itself fails; "no order found" is orders: [].
 */
export async function readCancellationLocally(buf, platform = null) {
  const { a, b } = await queued(() => readOnce(buf));
  const first = ordersFromText(a, platform);
  const second = b == null ? null : ordersFromText(b, platform);
  const keysB = new Set((second || []).map((o) => orderKey(o.order_number)));
  const keysA = new Set(first.map((o) => orderKey(o.order_number)));
  const agreed = (k) => (second == null ? null : keysB.has(k));
  const orders = [
    ...first.map((o) => ({ ...o, agreed: agreed(orderKey(o.order_number)) })),
    // Only the second read saw it: filed too (never dropped), flagged for a closer look.
    ...(second || []).filter((o) => !keysA.has(orderKey(o.order_number))).map((o) => ({ ...o, agreed: false, onlySecond: true })),
  ];
  // The style code / size from whichever read found them.
  const one = (k) => first.find((o) => o[k])?.[k] || second?.find((o) => o[k])?.[k] || null;
  return {
    what: '',
    text: [a, b].filter(Boolean).join('\n----\n').slice(0, 4000),
    orders: orders.map((o) => ({
      platform: o.platform, order_number: o.order_number,
      sku: o.sku || (orders.length === 1 ? one('sku') : null), size: o.size || (orders.length === 1 ? one('size') : null),
      product: o.product || (orders.length === 1 ? one('product') : null),
      // tesseract has no honest "how sure" for a whole number; the two reads ARE the check.
      confidence: o.agreed ? 0.99 : 0.5, unclear: [], agreed: o.agreed, onlySecond: !!o.onlySecond, why: o.why,
    })),
  };
}
