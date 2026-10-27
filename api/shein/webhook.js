// POST /api/shein/webhook   SHEIN's push the moment an order changes (event "order-change":
// { orderNo, orderStatus, changeTime }) — the fast half of "a SHEIN sale leaves Shopify at
// once" (docs/context/shein-live-fix.md → "Sales"). No app login: the signature (our app id +
// secret over this path) is the proof, and the body only names an order — we read the order
// itself from SHEIN's API before touching Shopify. Answers 200 at once (SHEIN gives 1.5 s)
// and works after. The minute poll catches anything this misses.
// SHEIN's console has ONE webhook URL for the app: ours is /api/shein/callback (also the
// sign-in return, GET) — callback.js hands its POSTs here. /api/shein/webhook works too.
import { applySecurity, rateLimit, send } from '../_lib/util.js';
import { sheinOpenWebhook } from '../_lib/shein.js';
import { processOrders, readSync } from '../_lib/shein-orders.js';
import { dbConfigured } from '../_lib/db.js';
import { listingReviewEvent, listingPriceAuditEvent } from '../_lib/shein-listing.js';

// SHEIN Listings (docs/context/shein-listings.md → Phase 2): the product review pushes —
// product_document_audit_status_notice { spu_name, skc_name, version, audit_state, failed_reason }
// and product_document_receive_status_notice { spu_name, version, received_success, failed_reason }.
// Swappable in tests.
export const HOOK = { listingReviewEvent, listingPriceAuditEvent };
// product_price_audit_status_notice { spu_name, skc_name, sku_code, site, audit_state 1 pass / 2 reject, audit_reason } (Phase 3).
export const isPriceAuditEvent = (event, code = '') => /^product_price_audit_status_notice/i.test(String(code))
  || (!!event?.sku_code && event?.audit_state != null && !event?.version && !event?.document_sn);
export const isProductReviewEvent = (event, code = '') => !isPriceAuditEvent(event, code) && !!event?.spu_name
  && (event.audit_state != null || event.received_success != null || /^product_document_(audit|receive)_status_notice/i.test(String(code)));


async function rawBody(req, max = 256 * 1024) {
  if (req.rawBody) return req.rawBody;
  if (req.body && typeof req.body === 'object' && Object.keys(req.body).length) return Buffer.from(JSON.stringify(req.body));
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > max) return null; chunks.push(c); }
  return Buffer.concat(chunks);
}

// `eventData` out of multipart/form-data (what SHEIN sends), urlencoded, or JSON.
export function eventDataFrom(contentType, buf) {
  const ct = String(contentType || '');
  const text = buf ? buf.toString('utf8') : '';
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ct);
  if (/multipart\/form-data/i.test(ct) && m) {
    for (const part of text.split(`--${(m[1] || m[2]).trim()}`)) {
      if (!/name="eventData"/i.test(part)) continue;
      const i = part.indexOf('\r\n\r\n');
      return i < 0 ? '' : part.slice(i + 4).replace(/\r\n$/, '').trim();
    }
    return '';
  }
  if (/x-www-form-urlencoded/i.test(ct)) return new URLSearchParams(text).get('eventData') || '';
  try { const j = JSON.parse(text); return String(j.eventData || ''); } catch { return ''; }
}

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!rateLimit(req, { windowMs: 60_000, max: 600 })) return send(res, 429, { ok: false });
  // SHEIN checks the URL is alive when it's saved in the console — an unsigned call is
  // answered (and ignored); a call that carries a signature must pass it.
  if (!req.headers['x-lt-signature']) return send(res, 200, { ok: true, ignored: true });
  const buf = await rawBody(req);
  const path = new URL(req.url || '/', 'http://x').pathname.replace(/\/+$/, '');
  // SHEIN signs over the exact path it called — try it as called and without a trailing dot.
  const eventData = eventDataFrom(req.headers['content-type'], buf);
  const event = sheinOpenWebhook({ headers: req.headers, path, eventData }) || sheinOpenWebhook({ headers: req.headers, path: path.replace(/\.+$/, ''), eventData });
  // Not verified → answered 200 and IGNORED (SHEIN's console test must pass; nothing moves
  // without a valid signature, and the minute poll catches any real order we drop here).
  if (!event) { console.warn(`[shein/webhook] unverified push on ${path} (${req.headers['x-lt-eventcode'] || 'no event code'}) — ignored`); return send(res, 200, { ok: true, ignored: 'unverified' }); }
  const code = String(req.headers['x-lt-eventcode'] || '');
  send(res, 200, { ok: true });
  // A price rise SHEIN reviewed (Phase 3) — never stock.
  if (isPriceAuditEvent(event, code)) {
    if (!dbConfigured()) return;
    try {
      const r = await HOOK.listingPriceAuditEvent(event);
      console.log(`[shein/webhook] ${code || 'price audit'} ${event.sku_code} → ${r.handled} listing item(s)`);
    } catch (e) { console.error('[shein/webhook] price audit', event.sku_code, e.message); }
    return;
  }
  // A product review result (one of OUR listing edits approved / rejected) — never stock.
  if (isProductReviewEvent(event, code)) {
    if (!dbConfigured()) return;
    try {
      const r = await HOOK.listingReviewEvent(event, code);
      console.log(`[shein/webhook] ${code || 'product review'} ${event.spu_name} → ${r.handled} listing item(s)${r.why ? ` (${r.why})` : ''}`);
    } catch (e) { console.error('[shein/webhook] product review', event.spu_name, e.message); }
    return;
  }
  // After answering: only an order change moves stock.
  if (!dbConfigured() || !event.orderNo) { if (code) console.log(`[shein/webhook] ${code} (no order)`); return; }
  try {
    const sync = await readSync();
    if (sync.orders !== 'on') return;
    const r = await processOrders([event.orderNo]);
    console.log(`[shein/webhook] ${code || 'order'} ${event.orderNo} status ${event.orderStatus ?? '?'} → ${r.deducted} off Shopify, ${r.restocked} back, ${r.failed} failed`);
  } catch (e) {
    console.error('[shein/webhook]', event.orderNo, e.message);
  }
}
