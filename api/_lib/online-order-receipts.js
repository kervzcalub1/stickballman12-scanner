// An online order finds its own receipt (docs/context/online-orders.md → "The receipt links
// itself").
//
// The store emails an order confirmation to the ordering mailbox the moment the order is
// placed. So when someone types the order number on an online order, the mailbox is asked for
// that number and the email is filed as a receipt (email_receipts, the Receipts page). Nothing
// is stored on the order: an order and a receipt carrying the same number belong together, and
// that is read at read time. One order number on four online orders (a parcel each) is one
// receipt, shown on all four.
//
// The mailbox is asked through the same Make scenario the buying requests use (6282792,
// MAKE_RECEIPT_PARSER_URL): POST { transaction_id } -> the oldest email with that text, which
// for an order number is the confirmation. Its parser knows the in-store receipts; an online
// store that runs on Shopify (Shoe Palace) comes back with no items, so those are read here.
import {
  orderKey, emailReceiptByOrderKey, onlineOrderStoreByKey, queueReceiptCheck, seedReceiptChecks,
  dueReceiptChecks, setReceiptCheck, ingestEmailReceipt, dbConfigured,
} from './db.js';
import { normalizeReceiptBody } from './receipt-ingest.js';

const TIMEOUT_MS = 45_000;
// A number not in the mailbox yet is asked for again: the email can be minutes behind the
// order, or the order was typed before it was placed. After these it stops by itself.
export const RETRY_MIN = [15, 120, 1440];

const hookUrl = () => String(process.env.MAKE_RECEIPT_PARSER_URL || '').trim();
export const receiptLookupConfigured = () => { try { return new URL(hookUrl()).protocol === 'https:'; } catch { return false; } };

const cents = (v) => { const n = Number(String(v ?? '').replace(/[$,\s]|USD/gi, '')); return Number.isFinite(n) ? Math.round(n * 100) / 100 : null; };
const MONEY_LINE = /^-?\s*\$\s*[\d,]+(?:\.\d{1,2})?(?:\s*USD)?$/i;

/** Is this number really in the email, as a whole word? A short number can sit inside a
 *  tracking number or a phone number, and the search matches on text. */
export function mentionsOrder(key, ...texts) {
  if (!key) return false;
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Z0-9])${esc}([^A-Z0-9]|$)`).test(texts.map((t) => String(t || '')).join('\n').toUpperCase());
}

/**
 * A Shopify store's order confirmation, as plain text:
 *
 *   Order summary
 *   Speedcat Ballet Lace Womens Lifestyle Shoes (Ruby Shimmer/Frosted Ivory) × 10
 *   7.5
 *   $1,000.00
 *   Subtotal
 *   $1,000.00
 *   …
 *   Total
 *   $1,000.00 USD
 *
 * -> { items:[{ name, size, qty, final_price }], totals, store }. `final_price` is the LINE
 * total, the same meaning the other receipts give it. Anything it cannot read is left out,
 * never guessed: an email in another shape returns no items.
 */
export function parseShopifyOrderEmail(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const start = lines.findIndex((l) => /^order summary$/i.test(l));
  const totalsAt = lines.findIndex((l, i) => i > start && /^subtotal$/i.test(l));
  const items = [];
  if (start >= 0) {
    const end = totalsAt > start ? totalsAt : lines.length;
    let cur = null;
    for (let i = start + 1; i < end; i += 1) {
      const m = lines[i].match(/^(.*\S)\s+[×x]\s+(\d{1,3})$/);
      if (m) { cur = { name: m[1].slice(0, 200), size: null, qty: Number(m[2]), final_price: null }; items.push(cur); continue; }
      if (!cur) continue;
      if (MONEY_LINE.test(lines[i])) cur.final_price = cents(lines[i]);   // the last one: after any discount
      else if (cur.size == null && lines[i].length <= 40) {
        // "7.5", or "Black / 10": the size is the part that is a number.
        const parts = lines[i].split('/').map((p) => p.trim());
        cur.size = parts.find((p) => /^\d{1,2}(?:\.5)?[A-Z]{0,2}$/i.test(p)) || lines[i];
      }
    }
  }
  const after = (re) => {
    const at = lines.findIndex((l, i) => i >= Math.max(totalsAt, 0) && re.test(l));
    return at >= 0 && lines[at + 1] && MONEY_LINE.test(lines[at + 1]) ? cents(lines[at + 1]) : null;
  };
  const totals = totalsAt < 0 ? { subtotal: null, tax: null, shipping: null, total: null } : {
    subtotal: after(/^subtotal$/i), shipping: after(/^shipping$/i),
    tax: after(/^(?:estimated )?tax(?:es)?$/i), total: after(/^total$/i),
  };
  // "…contact us at CustomerService@ShoePalace.com" -> shoepalace
  const dom = String(text || '').match(/contact us at\s+[A-Z0-9._%+-]+@([A-Z0-9-]+)\.[A-Z.]{2,}/i);
  return { items, totals, store: dom ? dom[1].toLowerCase() : null };
}

/** What the lookup answered -> the body the receipt normaliser files. null = not this order. */
export function receiptBodyFromLookup(key, payload, orderStore = null) {
  const email = payload?.email || {};
  const text = String(email.text || '');
  if (!mentionsOrder(key, email.subject, text)) return null;
  let items = Array.isArray(payload.items) ? payload.items : [];
  let totals = payload.totals && typeof payload.totals === 'object' ? { ...payload.totals } : {};
  let store = payload.store || null;
  const warnings = (Array.isArray(payload.warnings) ? payload.warnings : []).filter((w) => w !== 'store_not_detected' && w !== 'no_items_parsed');
  if (!items.length) {
    const shop = parseShopifyOrderEmail(text);
    items = shop.items;
    for (const k of ['subtotal', 'tax', 'shipping', 'total']) if (totals[k] == null && shop.totals[k] != null) totals[k] = shop.totals[k];
    store = store || shop.store;
    if (!items.length) warnings.push('no_items_parsed');
  }
  const slug = String(orderStore || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const date = email.date_iso || email.date || null;
  return {
    // The lookup doesn't hand back the Message-ID, so the key is the order's own: one
    // confirmation per order number per mailbox.
    message_key: `order-lookup|${payload.mailbox || ''}|${email.folder || payload.folder || ''}|${key}`,
    mailbox: payload.mailbox || null, folder: email.folder || payload.folder || null,
    received_at: date, from: email.from || null, subject: email.subject || null,
    store: store || slug || null,
    store_location: orderStore ? { name: `${orderStore} (online)` } : {},
    order_number: key, totals, items, warnings, text,
  };
}

async function askMake(key) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(hookUrl(), {
      method: 'POST', signal: ac.signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transaction_id: key }),
    });
    const payload = await r.json().catch(() => null);
    if (payload && payload.ok === false && payload.error === 'not_found') return { found: false };
    if (!r.ok || !payload || payload.ok !== true) throw new Error(`the mailbox search answered ${r.status}`);
    return { found: true, payload };
  } finally { clearTimeout(timer); }
}

/**
 * One order number: already filed? else ask the mailbox, file what comes back.
 * -> { state: 'found' | 'not_found' | 'error' | 'unconfigured' | 'skipped', receiptId? }
 * `io` swaps the outside world for the tests.
 */
export async function checkOrderReceipt(orderNumber, { tries = 0, io = {} } = {}) {
  const key = orderKey(orderNumber);
  if (key.length < 4) return { state: 'skipped' };
  const x = {
    existing: emailReceiptByOrderKey, storeOf: onlineOrderStoreByKey, ask: askMake, file: ingestEmailReceipt,
    mark: setReceiptCheck, configured: receiptLookupConfigured, ...io,
  };
  const retryIn = RETRY_MIN[tries] ?? null;
  try {
    const have = await x.existing(key);
    if (have) { await x.mark(key, { state: 'found', tried: false }); return { state: 'found', receiptId: Number(have.id) }; }
    // No mailbox search on this server: say so on the row, or the order reads "looking…" for ever.
    if (!x.configured()) { await x.mark(key, { state: 'unconfigured', tried: false }); return { state: 'unconfigured' }; }
    const ans = await x.ask(key);
    const body = ans.found ? receiptBodyFromLookup(key, ans.payload, await x.storeOf(key)) : null;
    if (!body) {
      await x.mark(key, { state: 'not_found', nextInMin: retryIn, note: ans.found ? 'The only email found mentions another number.' : null });
      return { state: 'not_found' };
    }
    const row = normalizeReceiptBody(body);
    const filed = await x.file(row);
    await x.mark(key, { state: 'found' });
    return { state: 'found', receiptId: filed?.id ?? null };
  } catch (e) {
    console.error('[online-order-receipts]', key, e.message);
    await x.mark(key, { state: 'error', nextInMin: retryIn, note: String(e.message || 'failed').slice(0, 200) }).catch(() => {});
    return { state: 'error' };
  }
}

// One at a time, whoever asks (a save, the button, the worker): the searches go through one
// Make scenario, and two answers for one number must not both file.
let chain = Promise.resolve();
const inLine = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

/** Everything that is due now. Called after a save and by the worker. */
export function runDueReceiptChecks({ limit = 3 } = {}) {
  return inLine(async () => {
    if (!dbConfigured()) return 0;
    const due = await dueReceiptChecks(limit);
    for (const d of due) await checkOrderReceipt(d.order_key, { tries: Number(d.tries) || 0 });
    return due.length;
  });
}

/** An order number was typed (or changed) on an online order. Never throws, never waited on. */
export function orderNumberSet(orderNumber, by) {
  const key = orderKey(orderNumber);
  if (key.length < 4) return;
  queueReceiptCheck(key, by).then(() => runDueReceiptChecks())
    .catch((e) => console.warn('[online-order-receipts] queue:', e.message));
}

/** The "Check again" button: ask now, whatever was answered before, and wait for it. */
export async function checkOrderReceiptNow(orderNumber, by) {
  const key = orderKey(orderNumber);
  if (key.length < 4) return { state: 'skipped' };
  await queueReceiptCheck(key, by, true);
  return inLine(() => checkOrderReceipt(key, { tries: 0 }));
}

// ---- Worker: catch up + retries ------------------------------------------------------------
// Production only by default (OO_RECEIPT_WATCH=on|off). Each tick queues a few older orders
// nobody asked about yet, then runs what is due. A dev machine still checks on save and on the
// button, when it has the mailbox search configured.
export function receiptWatchEnabled(env = process.env) {
  const flag = String(env.OO_RECEIPT_WATCH || '').trim().toLowerCase();
  if (flag === 'on') return true;
  if (flag === 'off') return false;
  return String(env.RAILWAY_ENVIRONMENT_NAME || '').trim().toLowerCase() === 'production';
}

export function startOnlineOrderReceiptWorker() {
  if (!receiptWatchEnabled()) return;
  const every = Math.max(2, Number(process.env.OO_RECEIPT_MIN) || 5) * 60_000;
  console.log(`[online-order-receipts] worker on: every ${every / 60_000} min`);
  const run = async () => {
    try {
      if (!dbConfigured() || !receiptLookupConfigured()) return;
      await seedReceiptChecks(3);
      await runDueReceiptChecks({ limit: 3 });
    } catch (e) { console.error('[online-order-receipts] tick', e.message); }
  };
  setTimeout(() => { run(); setInterval(run, every); }, 4 * 60_000);
}
