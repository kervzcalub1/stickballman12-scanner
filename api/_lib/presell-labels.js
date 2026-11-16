// Pre-sell fulfilment — every shipping label of one platform in ONE PDF
// (docs/context/presell-fulfillment.md → "Labels by platform").
//
// Both platforms make the UPS label at the sale and hand us a link to it (Alias: a PDF;
// StockX: a label-only PDF, else a PNG). The warehouse prints 20–60 of them a shift, so
// instead of opening each link this fetches them SERVER-SIDE (the files sit on other
// origins the browser can't read) and merges them, one label after the other, in the order
// asked for — the pick list's order.
//
// The links come from OUR database (written by the status sync from the platform's own
// answer), never from the request. Still: https only, no IP literals / localhost.
import { labelLink } from '../../src/lib/presellFulfill.js';

export const LABELS_MAX = 300;            // labels per download
const MAX_BYTES = 15 * 1024 * 1024;       // one label file
const FETCH_MS = 20_000;
const PARALLEL = 6;
const PAGE = [288, 432];                  // 4 x 6 in, in points — for a label that came as a picture

export function labelUrlAllowed(url) {
  let u;
  try { u = new URL(String(url)); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  const h = u.hostname.toLowerCase();
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(':')) return false;   // IPv4 / IPv6 literal
  return true;
}

const kindOf = (b) => (
  b.length > 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 ? 'pdf'
    : b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 ? 'png'
      : b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff ? 'jpg' : null
);

async function fetchLabel(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_MS);
  try {
    const r = await fetch(url, { signal: ac.signal, redirect: 'follow' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error('file too large');
    return buf;
  } finally { clearTimeout(timer); }
}

// sales: rows of presell_sales (id, order_id, label_url, ship_docs), ALREADY in print order.
// -> { bytes | null, included: [order_id], missing: [{ order_id, reason }] }
// with: 'label' = the label alone · 'instructions' = StockX's "Attach Shipping Label to Shipping
// Box" sheet (order #, shoe, size, ship-by) WITH the label, 4 x 6 thermal; the letter sheet if
// there is no thermal one; the bare label if StockX gave neither — a parcel never loses its label.
export const docLink = (s, withDoc = 'label') => (
  withDoc === 'instructions' ? (s?.ship_docs?.thermal || s?.ship_docs?.letter || labelLink(s)) : labelLink(s)
);

export async function mergeLabels(sales, { fetcher = fetchLabel, with: withDoc = 'label' } = {}) {
  const jobs = sales.map((s) => ({ s, url: docLink(s, withDoc), buf: null, reason: null }));
  let next = 0;
  async function worker() {
    for (;;) {
      const j = jobs[next++];
      if (!j) return;
      if (!j.url) { j.reason = 'no label yet'; continue; }
      if (!labelUrlAllowed(j.url)) { j.reason = 'label link not usable'; continue; }
      try { j.buf = await fetcher(j.url); } catch (e) { j.reason = e.name === 'AbortError' ? 'timed out' : (e.message || 'could not be downloaded'); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL, jobs.length) }, worker));

  const { PDFDocument } = await import('pdf-lib');
  const out = await PDFDocument.create();
  const included = [];
  const missing = [];
  for (const j of jobs) {
    if (!j.buf) { missing.push({ order_id: j.s.order_id, reason: j.reason || 'could not be downloaded' }); continue; }
    try {
      const kind = kindOf(j.buf);
      if (kind === 'pdf') {
        const src = await PDFDocument.load(j.buf, { ignoreEncryption: true });
        // Copied, not re-drawn: the page keeps its vectors, so the barcode prints as UPS made it.
        for (const p of await out.copyPages(src, src.getPageIndices())) out.addPage(p);
      } else if (kind === 'png' || kind === 'jpg') {
        const img = kind === 'png' ? await out.embedPng(j.buf) : await out.embedJpg(j.buf);
        // A landscape picture gets a landscape page; the picture fills it, never stretched.
        const [pw, ph] = img.width > img.height ? [PAGE[1], PAGE[0]] : PAGE;
        const k = Math.min(pw / img.width, ph / img.height);
        const page = out.addPage([pw, ph]);
        page.drawImage(img, { x: (pw - img.width * k) / 2, y: (ph - img.height * k) / 2, width: img.width * k, height: img.height * k });
      } else throw new Error('not a PDF or a picture');
      included.push(j.s.order_id);
    } catch (e) { missing.push({ order_id: j.s.order_id, reason: e.message || 'could not be read' }); }
  }
  return { bytes: included.length ? Buffer.from(await out.save()) : null, included, missing };
}
