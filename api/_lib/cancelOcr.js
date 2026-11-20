// Reading a cancellation photo on OUR server, no AI (owner, 2026-11-10; docs/context/cancellations.md).
//
// tesseract reads the picture into text, TWICE, prepared two different ways (large + sharpened
// as scattered text, and smaller + plain grey as a page — black-and-white lost a label with a
// shadow across it, so it isn't used). src/lib/cancellations.js
// `ordersFromText` picks the order numbers out of each text. A number both reads found is
// "agreed"; one only a single read found is still filed, flagged "reads disagree", so it is
// never lost. Nothing leaves the server, and it costs nothing per photo.
//
// When the two reads DISAGREE, a third read (mid-size, plain, as a page) breaks the tie: the
// number two of the three reads saw wins (`settleWithThird`). Measured 2026-11-15 in the CI
// image (Ubuntu, Liberation Sans): the first read turned the leading "99" of a printed label
// into "09" on ~40 % of labels (once "00", which filed one photo as TWO cancellations); the
// first two reads alone can't say which is right, two of three can. On the real phone photos
// the first read is still the best single read, so it stays first.
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

// How each read prepares the picture: [long edge px, sharpen?, page mode].
const PREP = {
  first: [3600, true, 'SPARSE_TEXT'],   // large + sharpened, scattered text
  second: [2400, false, 'AUTO'],        // smaller + plain grey, as a page
  third: [3000, false, 'AUTO'],         // the tie-break: only when the first two disagree
  // Only when NEITHER of the first two found a number. Measured on a real SHEIN slip (thin serif
  // print, 1200 px photo): of 60 preparations, sharpened at 3000 px as a page was one of the
  // few that read the "Order Number: GS…" line as one piece.
  rescue: [3000, true, 'AUTO'],
};

/** tesseract over the picture, once per named prep → { name: text | null }. */
async function readWith(buf, names) {
  const sharp = (await import('sharp')).default;
  const { createWorker, PSM } = await import('tesseract.js');
  const meta = await sharp(buf).rotate().metadata();
  const wide = Math.max(meta.width || 0, meta.height || 0) || 1600;
  // Scale so the long edge is ~3600 / ~2400 px: small print on a phone photo needs the room.
  const prepared = await Promise.all(names.map(async (n) => {
    const [edge, sharpen] = PREP[n];
    let p = sharp(buf).rotate().resize({ width: Math.round(edge * (meta.width || wide) / wide) }).greyscale().normalise();
    if (sharpen) p = p.sharpen();
    return p.png().toBuffer();
  }));
  let worker; let timer;
  try {
    worker = await createWorker('eng', 1, { langPath: REPO_ROOT, gzip: false, cachePath: tmpdir() });
    const run = async () => {
      const out = {};
      for (let i = 0; i < names.length; i++) {
        await worker.setParameters({ tessedit_pageseg_mode: PSM[PREP[names[i]][2]] });
        // The first read failing is a failure; a later one failing is just "no second opinion".
        const r = worker.recognize(prepared[i]).then((x) => x.data.text);
        out[names[i]] = i === 0 ? await r : await r.catch(() => null);
      }
      return out;
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
/**
 * The two reads' orders → one list. A number both reads found is "agreed"; one only the second
 * read found is filed too (never dropped), flagged "only one read found it" — EXCEPT a number
 * ONE CHARACTER away from a first-read number the second read did NOT find: that is the same
 * label misread ("#991138546" / "#091138546", 2026-11-13 — one photo became two cancellations),
 * so it is one order, flagged "reads disagree" with the other reading on the row (`other`). If
 * the second read found BOTH numbers, they are two real orders (consecutive numbers on one
 * photo) and both are filed. Pure, so it can be tested without tesseract.
 */
export function mergeReads(first, second) {
  const keysB = new Set((second || []).map((o) => orderKey(o.order_number)));
  const keysA = new Set(first.map((o) => orderKey(o.order_number)));
  const agreed = (k) => (second == null ? null : keysB.has(k));
  const oneOff = (x, y) => x.length === y.length && [...x].filter((c, i) => c !== y[i]).length === 1;
  const misreadOf = new Map();   // first-read key → what the second read said instead
  const onlySecond = [];
  for (const o of (second || []).filter((s) => !keysA.has(orderKey(s.order_number)))) {
    const k = orderKey(o.order_number);
    const twin = first.find((f) => {
      const fk = orderKey(f.order_number);
      return !keysB.has(fk) && !misreadOf.has(fk) && oneOff(fk, k);
    });
    if (twin) misreadOf.set(orderKey(twin.order_number), o.order_number);
    else onlySecond.push(o);
  }
  return [
    ...first.map((o) => {
      const k = orderKey(o.order_number);
      const other = misreadOf.get(k);
      return other ? { ...o, agreed: false, other } : { ...o, agreed: agreed(k) };
    }),
    // Only the second read saw it: filed too (never dropped), flagged for a closer look.
    ...onlySecond.map((o) => ({ ...o, agreed: false, onlySecond: true })),
  ];
}

// Edit distance between two order numbers (a misread can drop or add a digit: "991144585"
// read as "0901144585").
function editDistance(x, y) {
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[y.length];
}

/**
 * The two reads disagreed: a third read decides. `merged` = mergeReads(first, second); `third`
 * = the third read's orders (null = it failed → nothing changes).
 *   - a one-character pair (first said X, second said Y): the one the third read ALSO saw is
 *     the number; the other reading is kept on the row (`other`).
 *   - a number only one of the first two saw, that the third read saw too: agreed.
 *   - a number ONLY ONE of the three reads saw, within two characters of a number two reads
 *     agree on: the same label misread ("991177462" / "001177462" filed one photo as two
 *     cancellations, CI 2026-11-15) — folded into that order as its `other`, not filed. NOT
 *     when any one read saw BOTH numbers: then they are two real orders on one photo.
 * Anything the third read can't settle stays flagged exactly as mergeReads left it. Pure.
 */
export function settleWithThird(merged, third, first = [], second = []) {
  if (third == null) return merged;
  const keysC = new Set(third.map((o) => orderKey(o.order_number)));
  const seen = (n) => n != null && keysC.has(orderKey(n));
  const out = merged.map((o) => {
    if (o.agreed !== false) return { ...o };
    if (o.other && seen(o.other) && !seen(o.order_number)) {
      return { ...o, order_number: o.other, other: o.order_number, agreed: true, byThird: true };
    }
    if (seen(o.order_number)) {
      const { onlySecond, ...rest } = o;
      return { ...rest, agreed: true, byThird: true };
    }
    return o;
  });
  const settled = out.filter((o) => o.agreed === true);
  const reads = [first, second || [], third].map((r) => new Set(r.map((x) => orderKey(x.order_number))));
  const together = (k1, k2) => reads.some((r) => r.has(k1) && r.has(k2));
  const kept = [];
  for (const o of out) {
    if (o.agreed === false && !o.other) {
      const k = orderKey(o.order_number);
      const twin = settled.find((s) => { const sk = orderKey(s.order_number); return sk !== k && editDistance(sk, k) <= 2 && !together(sk, k); });
      if (twin) { twin.other ||= o.order_number; continue; }
    }
    kept.push(o);
  }
  return kept;
}

export async function readCancellationLocally(buf, platform = null) {
  const { first: a, second: b } = await queued(() => readWith(buf, ['first', 'second']));
  const first = ordersFromText(a, platform);
  const second = b == null ? null : ordersFromText(b, platform);
  let orders = mergeReads(first, second);
  // The two reads disagree: a third read, prepared another way, decides (settleWithThird).
  let c = null; let third = null;
  if (second != null && orders.some((o) => o.agreed === false)) {
    c = await queued(() => readWith(buf, ['third'])).then((r) => r.third, () => null);
    third = c == null ? null : ordersFromText(c, platform);
    orders = settleWithThird(orders, third, first, second);
  } else if (!orders.length) {
    // Neither read found a number: one more look, prepared another way (rescue), before giving up
    // (a SHEIN slip's thin serif "Order Number:" line can read on one preparation and not the
    // others). What only this read saw is recorded as unchecked — one read is not two.
    c = await queued(() => readWith(buf, ['rescue'])).then((r) => r.rescue, () => null);
    third = c == null ? null : ordersFromText(c, platform);
    orders = (third || []).map((o) => ({ ...o, agreed: null }));
  }
  // The style code / size from whichever read found them.
  const one = (k) => first.find((o) => o[k])?.[k] || second?.find((o) => o[k])?.[k] || third?.find((o) => o[k])?.[k] || null;
  return {
    what: '',
    text: [a, b, c].filter(Boolean).join('\n----\n').slice(0, 4000),
    orders: orders.map((o) => ({
      platform: o.platform, order_number: o.order_number,
      sku: o.sku || (orders.length === 1 ? one('sku') : null), size: o.size || (orders.length === 1 ? one('size') : null),
      product: o.product || (orders.length === 1 ? one('product') : null),
      // tesseract has no honest "how sure" for a whole number; the two reads ARE the check.
      confidence: o.agreed ? 0.99 : 0.5, unclear: [], agreed: o.agreed, onlySecond: !!o.onlySecond, why: o.why,
      // The first two reads disagreed and the third decided: recorded, and marked [CHECK].
      ...(o.byThird ? { byThird: true } : {}),
      // The second read's version of a one-character misread (the row says "Second read said …").
      ...(o.other ? { other: o.other } : {}),
    })),
  };
}
