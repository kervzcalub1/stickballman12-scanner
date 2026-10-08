// Shared by the two ways a receipt reaches us (docs/context/receipts.md):
//   POST /api/receipts/ingest      — an already-parsed receipt (the old Make sweep contract)
//   POST /api/receipts/ingest-raw  — a raw email from "Check mailboxes", parsed on our server
// Both check the same key and file through the same normaliser, so a receipt reads the same
// whichever way it came in.
import crypto from 'node:crypto';

const str = (v, max) => { const s = String(v ?? '').trim(); return s ? s.slice(0, max) : null; };
const money = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) && Math.abs(n) < 1e7 ? Math.round(n * 100) / 100 : null; };
const EMAIL_RE = /[A-Z0-9._%+'-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// "Joey <JOEY@x.com>", ["a@x.com"], "a@x.com, b@y.com" — every address in it, lower-cased.
const addrs = (v) => (Array.isArray(v) ? v.join(' ') : String(v ?? '')).match(EMAIL_RE)?.map((a) => a.toLowerCase()) || [];

export const ingestKeyOk = (given) => {
  const want = String(process.env.RECEIPT_INGEST_KEY || '').trim();
  if (!want || !given) return false;
  const a = crypto.createHash('sha256').update(String(given).trim()).digest();
  const b = crypto.createHash('sha256').update(want).digest();
  return crypto.timingSafeEqual(a, b);
};


export const ingestConfigured = () => !!String(process.env.RECEIPT_INGEST_KEY || '').trim();

// The ingest body → the row ingestEmailReceipt files. null when it has no message_key.
export function normalizeReceiptBody(b) {
  const messageKey = str(b.message_key, 500);
  if (!messageKey) return null;
  const receivedAt = b.received_at && !Number.isNaN(Date.parse(b.received_at)) ? new Date(b.received_at).toISOString() : null;
  const rc = b.recipients && typeof b.recipients === 'object' ? b.recipients : {};
  const recipients = { to: addrs(rc.to), cc: addrs(rc.cc), delivered_to: addrs(rc.delivered_to)[0] || null, original_to: addrs(rc.original_to)[0] || null };
  const loc = b.store_location && typeof b.store_location === 'object' ? b.store_location : {};
  const t = b.totals && typeof b.totals === 'object' ? b.totals : {};
  const items = (Array.isArray(b.items) ? b.items : []).slice(0, 200).map((it) => ({
    name: str(it?.name, 200), style_id: str(it?.style_id, 60), sku: str(it?.sku, 60), upc: str(it?.upc, 20),
    size: str(it?.size, 20), qty: Number.isInteger(Number(it?.qty)) && Number(it.qty) > 0 ? Number(it.qty) : 1,
    final_price: money(it?.final_price),
  }));
  const state = str(loc.state, 20);
  const r = {
    message_key: messageKey, mailbox: str(b.mailbox, 200), folder: str(b.folder, 200), received_at: receivedAt,
    from_addr: str(b.from, 300), subject: str(b.subject, 500), recipients,
    recipient_addrs: [...new Set([...recipients.to, ...recipients.cc, recipients.delivered_to, recipients.original_to].filter(Boolean))],
    store: str(b.store, 40)?.toLowerCase() || null,
    store_name: str(loc.name, 200), store_number: str(loc.store_number, 40), address: str(loc.address, 300),
    city: str(loc.city, 120), state: state ? state.toUpperCase() : null, zip: str(loc.zip, 20),
    order_number: str(b.order_number, 80),
    subtotal: money(t.subtotal), tax: money(t.tax), shipping: money(t.shipping), total: money(t.total),
    items, warnings: (Array.isArray(b.warnings) ? b.warnings : []).map((w) => str(w, 200)).filter(Boolean).slice(0, 20),
    body_text: str(b.text, 64 * 1024),
  };
  return r;
}
