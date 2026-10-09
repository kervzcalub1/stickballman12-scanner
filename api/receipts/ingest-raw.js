// POST /api/receipts/ingest-raw   header: x-api-key: <RECEIPT_INGEST_KEY>
//   form-urlencoded: mailbox, folder, from, subject, date, text, html, to, cc, delivered_to,
//                    original_to, message_id
//   -> 200 { ok, id, duplicate?, buyerMatched? } · 200 { ok, skipped } (not a receipt)
//      · 400 · 401 bad key · 413 too big · 503 not configured
//
// One RAW email from the "Check mailboxes" run (Make scenario 6534162, started by the button
// on the Receipts page — api/receipts/sweep.js). Make only fetches the mail now; the parsing
// happens HERE (api/_lib/receipt-parser), because Make billed its code step by running time
// and the old sweep spent ~710 credits a run parsing in Make (docs/context/receipts.md).
//
// Form fields, not JSON: Make builds a form body from mapped fields safely, while a JSON body
// assembled from an email's quotes and newlines by string templating breaks on the first one.
import { send, applySecurity, rateLimit } from '../_lib/util.js';
import { dbConfigured, ingestEmailReceipt, getSetting, noteSweepEmail } from '../_lib/db.js';
import { ingestKeyOk, ingestConfigured, normalizeReceiptBody } from '../_lib/receipt-ingest.js';
import { parseReceiptEmail } from '../_lib/receipt-parser/index.js';

// A receipt email's HTML is often 100–300 KB; marketing mail can be far bigger. 4 MB is room
// for any receipt, and anything larger is not one.
const MAX_BYTES = 4 * 1024 * 1024;

async function readForm(req) {
  if (req.body && typeof req.body === 'object' && Object.keys(req.body).length) return req.body;
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BYTES) return null;
    chunks.push(chunk);
  }
  return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
}

const FIELDS = ['mailbox', 'folder', 'from', 'subject', 'date', 'text', 'html', 'to', 'cc', 'delivered_to', 'original_to', 'message_id'];

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!ingestConfigured())
    return send(res, 503, { ok: false, error: 'Receipt ingest is not configured (RECEIPT_INGEST_KEY missing on the server).' });
  if (!ingestKeyOk(req.headers['x-api-key'])) return send(res, 401, { ok: false, error: 'Bad or missing API key.' });
  if (!rateLimit(req, { windowMs: 60_000, max: 600 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const form = await readForm(req);
  if (!form) return send(res, 413, { ok: false, error: 'Email too large.' });
  const email = Object.fromEntries(FIELDS.map((k) => [k, String(form[k] ?? '')]));
  if (!email.mailbox) return send(res, 400, { ok: false, error: 'mailbox is required.' });

  let outcome = 'error';
  try {
    const out = await parseReceiptEmail(email);
    if (!out?.post) { outcome = `skipped:${out?.skip || 'not_a_receipt'}`; return send(res, 200, { ok: true, skipped: out?.skip || 'not_a_receipt' }); }
    const r = normalizeReceiptBody(out.parsed);
    if (!r) { outcome = 'skipped:no_message_key'; return send(res, 200, { ok: true, skipped: 'no_message_key' }); }
    const saved = await ingestEmailReceipt(r);
    outcome = saved.duplicate ? 'duplicate' : 'filed';
    return send(res, 200, { ok: true, id: saved.id, duplicate: saved.duplicate, buyerMatched: !!saved.buyerUserId });
  } catch (e) {
    console.error('[receipts/ingest-raw]', e.message);
    return send(res, 500, { ok: false, error: 'Could not file the receipt.' });
  } finally {
    // Count it against the run it came from, receipt or not (receipt_sweep_folders): that's how
    // the next check knows a folder hit Make's cap and where to resume — and what became of
    // each email, since Make's run history shows none of our answers. Never blocks the filing.
    try {
      const last = JSON.parse((await getSetting('receipt_sweep_last')) || 'null');
      await noteSweepEmail({ mailbox: email.mailbox, folder: email.folder, runAt: last?.at, date: email.date, outcome,
        empty: !email.text.trim() && !email.html.trim() });
    } catch (e) { console.error('[receipts/ingest-raw] count', e.message); }
  }
}
