// POST /api/receipts/ingest-raw   header: x-api-key: <RECEIPT_INGEST_KEY>
//   form-urlencoded: mailbox, folder, from, subject, date, text, html, to, cc, delivered_to,
//                    original_to, message_id
//   -> 200 { ok, queued: true }                 stored; read and filed in the background
//      · 200 { ok, duplicate: true, id? }       filed already, or already waiting to be read
//      · 400 · 401 bad key · 413 too big · 503 not configured
//
// One RAW email from the "Check mailboxes" run (Make scenario 6534162, started by the button
// on the Receipts page — api/receipts/sweep.js). Make only fetches the mail now; the parsing
// happens on OUR server (api/_lib/receipt-parser), because Make billed its code step by running
// time and the old sweep spent ~710 credits a run parsing in Make (docs/context/receipts.md).
//
// It is NOT parsed in this request (2026-11-24). Make posts one email at a time and waits for
// the answer, and parsing also runs the style-code lookups (20–25 s each when slow): a check ran
// for 45 minutes and Make cut it off. The email is stored (receipt_raw_queue) and answered at
// once; api/_lib/receipt-queue.js reads it. If it cannot be stored (the table is not there yet
// on a server that has not run db:setup), it is read here, the old way, rather than lost.
//
// Form fields, not JSON: Make builds a form body from mapped fields safely, while a JSON body
// assembled from an email's quotes and newlines by string templating breaks on the first one.
import { send, applySecurity, rateLimit } from '../_lib/util.js';
import { dbConfigured, emailReceiptIdByKey, queueRawReceipt, getSetting, setSetting, noteSweepEmail, moveSweepOutcome } from '../_lib/db.js';
import { ingestKeyOk, ingestConfigured, rawMessageKey } from '../_lib/receipt-ingest.js';
import { kickReceiptQueue, readRawReceipt } from '../_lib/receipt-queue.js';

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
  if (!ingestKeyOk(req.headers['x-api-key'])) {
    // Kept, because Make's run history says SUCCESS whatever we answer: a check where every
    // email bounced here would otherwise look exactly like one that found no receipts. Only the
    // LENGTH of a wrong key is kept — never any of it.
    const given = String(req.headers['x-api-key'] || '');
    setSetting('receipt_ingest_rejected', JSON.stringify({ at: new Date().toISOString(), key_length: given.length }), 'ingest-raw').catch(() => {});
    return send(res, 401, { ok: false, error: 'Bad or missing API key.' });
  }
  if (!rateLimit(req, { windowMs: 60_000, max: 600 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const form = await readForm(req);
  if (!form) return send(res, 413, { ok: false, error: 'Email too large.' });
  // No NUL characters: Postgres takes them in neither JSONB (the queue) nor TEXT (the receipt).
  const email = Object.fromEntries(FIELDS.map((k) => [k, String(form[k] ?? '').replace(/\u0000/g, '')]));
  if (!email.mailbox) return send(res, 400, { ok: false, error: 'mailbox is required.' });

  // Every email is counted against the run it came from, receipt or not (receipt_sweep_folders):
  // that's how the next check knows a folder hit Make's cap and where to resume — and what became
  // of each email, since Make's run history shows none of our answers. Never blocks the filing.
  let runAt = null;
  try { runAt = JSON.parse((await getSetting('receipt_sweep_last')) || 'null')?.at || null; } catch { /* not counted */ }
  const where = { mailbox: email.mailbox, folder: email.folder, runAt };
  const count = (outcome) => noteSweepEmail({ ...where, date: email.date, outcome, empty: !email.text.trim() && !email.html.trim() })
    .catch((e) => console.error('[receipts/ingest-raw] count', e.message));
  const recount = (to) => moveSweepOutcome({ ...where, to }).catch((e) => console.error('[receipts/ingest-raw] count', e.message));

  let counted = false;
  try {
    // Filed already (every check overlaps the last by an hour, a catch-up re-reads days):
    // answered without storing or reading anything.
    const key = rawMessageKey(email);
    const filedId = await emailReceiptIdByKey(key);
    if (filedId) {
      send(res, 200, { ok: true, id: filedId, duplicate: true });
      return void count('duplicate');
    }

    // Counted as 'queued' BEFORE it is stored: the reader moves that count to what became of
    // the email, and it may get to it the moment it is in the table.
    await count('queued');
    counted = true;
    let stored;
    try {
      stored = await queueRawReceipt({ messageKey: key, email, runAt });
    } catch (e) {
      // Could not be stored: read it here, as before the queue, rather than lose it.
      console.error('[receipts/ingest-raw] queue unavailable, reading inline:', e.message);
      const outcome = await readRawReceipt(email);
      await recount(outcome);
      return send(res, 200, { ok: true, inline: true, outcome });
    }
    if (!stored) {
      // The same email twice in one run (or before the first copy was read).
      await recount('duplicate');
      return send(res, 200, { ok: true, duplicate: true, queued: true });
    }
    send(res, 200, { ok: true, queued: true });
    kickReceiptQueue();
  } catch (e) {
    console.error('[receipts/ingest-raw]', e.message);
    await (counted ? recount('error') : count('error'));
    if (!res.headersSent) return send(res, 500, { ok: false, error: 'Could not file the receipt.' });
  }
}
