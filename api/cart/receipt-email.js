// POST /api/cart/receipt-email  { cartId, transactionId }  -> { ok, found, rows, email, … }
//
// The receipt is usually already in a mailbox: the shop emailed it to the ordering
// account the moment the buyer paid. Asking the buyer to screenshot that email and
// upload it, then paying a model to read the screenshot, is two lossy steps around a
// document we can fetch exactly. So the buyer types the transaction / order number off
// the email and a Make.com scenario ("Receipt parser — API → email → JSON", id 6282792)
// searches the ordering mailboxes for it and answers with the lines it parsed.
//
// THE SCENARIO IS A READER, NOT A DECIDER — the same rule `receipt-read` lives by.
// Its rows land in the same editable review table, the same arithmetic check runs
// against the receipt's own printed totals, and nothing is committed until a person
// has looked. A short numeric id can substring-match an unrelated email (a tracking
// number, say), and the scenario then answers 200 with no store and no items — that is
// why `email` (subject / from / date) is returned alongside the rows: the buyer is shown
// WHICH email was read and can say "that's not it".
//
// The webhook URL is the only secret (a bearer credential — anyone holding it can run
// the scenario against the mailboxes), so it lives in MAKE_RECEIPT_PARSER_URL and is
// only ever called from here. The response is synchronous; Make's ceiling for a
// synchronous webhook answer is 40 s, so the client timeout sits above it.
//
// When the scenario includes the email's plain text, that text is filed on the request
// as the receipt itself (`buy-carts/<code>/receipt-<ts>.txt`), which is what stamps
// `receipt_at` — "a receipt was received" is a closing condition and the auditor reads
// that file, so an email found by number must leave the same evidence a photo would.
import { getJsonBody, send, applySecurity, rateLimit, requireRole, isPrivileged } from '../_lib/util.js';
import { getBuyCart, addBuyCartFile, logCartEvent, dbConfigured } from '../_lib/db.js';
import { cartVisibleTo, requireBuyerAccess } from '../_lib/buycart.js';
import { presignPutUrl, r2Configured } from '../_lib/r2.js';
import { checkReceiptRead } from '../../src/lib/receiptCheck.js';

const TIMEOUT_MS = 45_000;
// The scenario caps its own text at ~64 KB; this is a belt for the braces.
const MAX_TEXT = 128 * 1024;

export const receiptEmailConfigured = () => !!process.env.MAKE_RECEIPT_PARSER_URL;

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) / 100 : null; };
const str = (v, max) => { const s = String(v ?? '').trim(); return s ? s.slice(0, max) : null; };

/**
 * One parsed item from the scenario → one row of the review table, the shape
 * `receipt-read` and `parseReceipt` both produce. Exported for the test.
 *
 * `style_id` is the manufacturer code the rest of the app keys on (FJ6245-106, IH8223);
 * `sku` is the store's own code (an adidas article number, the first twelve digits of a
 * Champs code — NOT a UPC). The style id is preferred and the store code is the
 * fallback, never a UPC: a row keyed on a UPC would match nothing downstream.
 * `final_price` is the line total after discounts, so the unit price is derived from it
 * and the quantity rather than taken from the pre-discount `list_price`.
 */
export function rowFromItem(it) {
  const qty = Math.min(Math.max(parseInt(it?.qty, 10) || 1, 1), 999);
  const totalPrice = num(it?.final_price);
  const sku = String(it?.style_id || it?.sku || '').trim().toUpperCase().slice(0, 40);
  return {
    sku,
    size: str(it?.size, 20),
    qty,
    totalPrice,
    unitPrice: totalPrice != null && qty > 0 ? Math.round((totalPrice / qty) * 100) / 100 : null,
    name: str(it?.name, 200),
    source: 'email',
  };
}

/** Everything the review step needs, from one scenario answer. Exported for the test. */
export function readingFromPayload(p) {
  const rows = (Array.isArray(p?.items) ? p.items : []).slice(0, 300).map(rowFromItem).filter((r) => r.sku);
  const t = p?.totals || {};
  const subtotal = num(t.subtotal);
  const tax = num(t.tax);
  const statedTotal = num(t.total);
  const itemsSold = Number.isFinite(Number(t.item_count_stated)) ? Number(t.item_count_stated) : null;
  const check = checkReceiptRead({ rows, subtotal, itemsSold, statedTotal, tax });
  const email = {
    subject: str(p?.email?.subject, 300),
    from: str(p?.email?.from, 200),
    date: str(p?.email?.date_iso, 40) || str(p?.email?.date, 80),
    text: str(p?.email?.text, MAX_TEXT),
  };
  return {
    rows, subtotal, tax, statedTotal, itemsSold, check, email,
    store: str(p?.store, 40),
    mailbox: str(p?.mailbox, 20),
    warnings: (Array.isArray(p?.warnings) ? p.warnings : []).map((w) => String(w).slice(0, 200)).slice(0, 20),
  };
}

/** The email as the receipt on file: a text object in our bucket, then the row. */
async function fileEmailAsReceipt({ cart, transactionId, email, actor }) {
  const key = `buy-carts/${cart.cart_code}/receipt-${Date.now()}.txt`;
  const header = [
    `Transaction: ${transactionId}`,
    email.subject ? `Subject: ${email.subject}` : null,
    email.from ? `From: ${email.from}` : null,
    email.date ? `Date: ${email.date}` : null,
    '',
  ].filter((l) => l != null).join('\n');
  const body = Buffer.from(`${header}\n${email.text}`, 'utf8');
  const put = await fetch(presignPutUrl({ key }), {
    method: 'PUT', body, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
  if (!put.ok) throw new Error(`R2 PUT ${key} failed (${put.status})`);
  return addBuyCartFile({
    cartId: cart.id, kind: 'receipt', key,
    name: `Email receipt ${transactionId}.txt`, contentType: 'text/plain', sizeBytes: body.length, actor,
  });
}

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['supplier', 'warehouse', 'ph_team']);
  if (!user) return;
  if (!(await requireBuyerAccess(req, res, user))) return;
  // Every call is two mailbox searches and a handful of catalogue lookups on the Make
  // side; a buyer retrying a mistyped number is fine, a loop is not.
  if (!rateLimit(req, { windowMs: 60_000, max: 12 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded — wait a minute before searching again.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const cartId = Number(body.cartId);
  // Order numbers are whatever the shop prints — digits, dashes, letters. Kept as a
  // string and never coerced: a leading zero is part of the number.
  const transactionId = String(body.transactionId ?? '').trim().slice(0, 80);
  if (!Number.isInteger(cartId)) return send(res, 400, { ok: false, error: 'Which buying request?' });
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._\-#/]*$/.test(transactionId) || transactionId.length < 4)
    return send(res, 400, { ok: false, error: 'Enter the transaction or order number as it appears on the email.' });

  try {
    const cart = await getBuyCart(cartId);
    if (!cart) return send(res, 404, { ok: false, error: 'That buying request does not exist.' });
    if (!cartVisibleTo(user, cart)) return send(res, 403, { ok: false, error: 'You do not have access to this request.' });
    if (user.role === 'supplier' && !isPrivileged(user.role) && Number(cart.buyer_user_id) !== Number(user.uid))
      return send(res, 403, { ok: false, error: 'You do not have access to this request.' });
    if (['closed', 'cancelled', 'written_off'].includes(cart.status))
      return send(res, 409, { ok: false, error: 'This request is finished — its receipt cannot change.' });
    // After the access checks, not before: whether this server can search a mailbox is
    // an answer for somebody allowed to ask, and a stranger gets the same 403 either way.
    if (!receiptEmailConfigured())
      return send(res, 503, { ok: false, error: 'Finding receipts by email is not configured on this server.' });

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    let r; let payload;
    try {
      r = await fetch(process.env.MAKE_RECEIPT_PARSER_URL, {
        method: 'POST',
        signal: ac.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transaction_id: transactionId }),
      });
      payload = await r.json().catch(() => null);
    } finally { clearTimeout(timer); }

    // The scenario's own "no such email" is a 404 with ok:false — an answer, not a fault.
    if (r.status === 404 || (payload && payload.ok === false && payload.error === 'not_found')) {
      await logCartEvent({ cartId, kind: 'receipt_email_read', actor: user, body: `No email found for “${transactionId}”` });
      return send(res, 200, {
        ok: true, found: false, transactionId,
        error: 'No email with that number in the ordering mailboxes. Check the number, or upload the receipt instead.',
      });
    }
    if (!r.ok || !payload || payload.ok !== true) {
      console.error('[cart/receipt-email] make', r.status, JSON.stringify(payload || '').slice(0, 300));
      return send(res, 502, { ok: false, error: 'The mailbox search did not answer. Try again in a moment, or upload the receipt.' });
    }

    const reading = readingFromPayload(payload);
    let file = null;
    // Evidence first, lines second — the same order the upload path follows. A missing
    // bucket is logged and the lines still come back: the buyer can attach a screenshot.
    if (reading.email.text && r2Configured()) {
      try { file = await fileEmailAsReceipt({ cart, transactionId, email: reading.email, actor: user }); }
      catch (e) { console.error('[cart/receipt-email] file', e.message); reading.warnings.push('evidence_not_filed'); }
    }

    await logCartEvent({
      cartId, kind: 'receipt_email_read', actor: user,
      body: `${reading.rows.length} lines read from email “${reading.email.subject || transactionId}”`
        + (reading.store ? ` (${reading.store})` : '')
        + (file ? ' · filed as the receipt' : '')
        + (reading.statedTotal == null ? '' : reading.check.ok ? ' · agrees with the receipt’s own totals' : ` · ${reading.check.problems.length} discrepancy(ies) flagged`)
        + (reading.warnings.length ? ` · warnings: ${reading.warnings.join(', ')}` : ''),
    });

    const { text, ...email } = reading.email;   // the text is on file, not in the answer
    return send(res, 200, { ok: true, found: true, transactionId, ...reading, email, file });
  } catch (e) {
    const aborted = e.name === 'AbortError';
    console.error('[cart/receipt-email]', e.message);
    return send(res, aborted ? 504 : 500, {
      ok: false,
      error: aborted ? 'The mailbox search took too long. Try again, or upload the receipt.' : 'Could not search for that receipt.',
    });
  }
}
