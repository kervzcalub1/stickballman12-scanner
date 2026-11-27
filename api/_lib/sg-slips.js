// Stadium Goods: the number on the packing slip, read from the slip itself
// (docs/context/cancellations.md "Stadium Goods: both numbers").
//
// A Stadium Goods order has THREE numbers, and two systems that each know only some of them:
//   · the Shopify order name            "#34788"        — ours; in Shopify
//   · Stadium Goods' order number       "CK5191830247"  — in Shopify (attribute "Order Number")
//   · the number under the slip's barcode "FAR02077816" — printed on the packing slip the floor
//                                                         photographs; in Shopify NOWHERE
// Stadium Goods tracks a cancellation by the first and the last (owner, 2026-11-28: record
// "#34788 | FAR02077816"). What ties them together is the slip: every Stadium Goods order in
// Shopify carries a link to its own packing slip (attribute "Packing Slip", a one-page PDF on
// Stadium Goods' server), and that PDF has the barcode number in its text — measured on #34788.
//
// So, once per order: fetch that PDF, take the number, keep it on the order's row in the Shopify
// order index (shopify_order_index.slip_numbers). Then a slip number read off a photo — or typed
// in a reply — leads straight to its order, and the row gets all three numbers and the shoe.
// ONLY the number is kept. The PDF (it has the customer's address) is read in memory and dropped.
//
// Read-only, and only from Stadium Goods: the link must be https on *.stadiumgoods.com, a
// redirect anywhere else is refused, and the answer must be a PDF of a sane size.
import { sgSlipsToRead, setSgSlipRead, fillSgCancellationRefs } from './db.js';

/** What the number under a Stadium Goods barcode looks like: three letters, eight digits. */
export const SG_SLIP_NO = /\b[A-Z]{3}\d{8}\b/g;
const MAX_BYTES = 5 * 1024 * 1024;
const GAP_MS = () => Math.max(200, Number(process.env.SG_SLIP_GAP_MS) || 1000);
const BATCH = () => Math.max(1, Math.min(200, Number(process.env.SG_SLIP_BATCH) || 60));

export const isSgSlipUrl = (u) => {
  try { const x = new URL(String(u || '')); return x.protocol === 'https:' && /(^|\.)stadiumgoods\.com$/i.test(x.hostname); } catch { return false; }
};

/** The text of a PDF, page by page (pdfjs — already a dependency; its legacy build runs in Node). */
export async function pdfText(buf) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true, isEvalSupported: false, verbosity: 0 });
  const doc = await task.promise;
  const out = [];
  try {
    for (let i = 1; i <= Math.min(doc.numPages, 5); i += 1) {
      const tc = await (await doc.getPage(i)).getTextContent();
      out.push(tc.items.map((it) => it.str).join('\n'));
    }
  } finally { await Promise.resolve(task.destroy?.()).catch(() => {}); }
  return out.join('\n');
}
/** The slip numbers in a slip's text — never the fulfilment number ("SONDSS_CKRS00003620"). Pure. */
export function slipNumbersFromText(text) {
  const out = new Set();
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim().toUpperCase();
    if (/SONDSS|CKRS/.test(line)) continue;
    for (const m of line.matchAll(SG_SLIP_NO)) out.add(m[0]);
  }
  return [...out];
}

/** Fetch one order's packing slip → { numbers } or { error }. `io.fetch` lets a test stand in. */
export async function readSgSlip(url, io = {}) {
  if (!isSgSlipUrl(url)) return { error: 'not a Stadium Goods link' };
  try {
    const res = await (io.fetch || fetch)(url, { redirect: 'follow', signal: AbortSignal.timeout(30_000) });
    if (res.url && !isSgSlipUrl(res.url)) return { error: 'the link led away from Stadium Goods' };
    // 429 = Stadium Goods is telling us to slow down (measured: 4 at a time, 150 ms apart, drew
    // them within a minute): the caller stops the pass. 404 / 410 = that slip is gone for good.
    if (!res.ok) return { error: `HTTP ${res.status}`, throttled: res.status === 429, gone: res.status === 404 || res.status === 410 };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) return { error: 'the document is too big to be a packing slip' };
    if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') return { error: 'not a PDF' };
    const numbers = slipNumbersFromText(await (io.pdfText || pdfText)(buf));
    return numbers.length ? { numbers } : { error: 'no slip number in the document' };
  } catch (e) {
    return { error: String(e?.message || e).slice(0, 200) };
  }
}

/**
 * One pass: read the slips of orders that don't have their number yet (newest first), then
 * give every Stadium Goods cancellation row whose number is now known its Shopify order.
 */
export async function readSgSlipsOnce({ limit = BATCH(), io = {} } = {}) {
  const todo = await (io.todo || sgSlipsToRead)(limit);
  let read = 0; let failed = 0; let throttled = false;
  for (const o of todo) {
    const out = await readSgSlip(o.slip_url, io);
    // Told to slow down: stop here, and count nothing against this order — the next pass (a few
    // minutes on) starts again from it.
    if (out.throttled) { throttled = true; break; }
    await (io.save || setSgSlipRead)(o.shopify_order_id, out);
    if (out.numbers) read += 1; else failed += 1;
    if (todo.length > 1) await new Promise((r) => setTimeout(r, io.gapMs ?? GAP_MS()));
  }
  const filled = read ? await (io.fill || fillSgCancellationRefs)().catch(() => 0) : 0;
  return { read, failed, filled, throttled, more: !throttled && todo.length >= limit };
}

// ── The worker ──
// Production only by default, like the index it feeds (dev would fetch real customers' slips
// for nothing); SG_SLIPS=on|off overrides. Every 3 minutes; while a backlog remains (the first
// run after a deploy: ~1,000 orders of the last 30 days) it carries straight on.
export function sgSlipsWorkerEnabled(env = process.env) {
  const flag = String(env.SG_SLIPS || '').trim().toLowerCase();
  if (flag === 'on') return true;
  if (flag === 'off') return false;
  return String(env.RAILWAY_ENVIRONMENT_NAME || '').trim().toLowerCase() === 'production';
}
let started = false; let running = false;
export function startSgSlipsWorker() {
  if (started || !sgSlipsWorkerEnabled()) return;
  started = true;
  console.log('[sg-slips] worker on: the slip number of each Stadium Goods order, from its packing slip');
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const out = await readSgSlipsOnce();
      if (out.read || out.failed || out.throttled) console.log(`[sg-slips] read ${out.read}, failed ${out.failed}${out.filled ? `, ${out.filled} cancellation row(s) given their order` : ''}${out.throttled ? ' — Stadium Goods asked us to slow down; carrying on at the next pass' : ''}`);
      if (out.more) setTimeout(run, 5_000).unref?.();
    } catch (e) {
      console.error('[sg-slips] tick', e.message);
    } finally { running = false; }
  };
  setTimeout(() => { run(); setInterval(run, 3 * 60_000).unref?.(); }, 150_000).unref?.();
}
