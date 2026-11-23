// The reader behind POST /api/receipts/ingest-raw (docs/context/receipts.md → "The queue").
//
// Make posts the emails of a mailbox check one at a time and WAITS for each answer. Reading an
// email here also runs the style-code lookups (a Make call per Foot Locker name, a StockX call
// per Nike UPC, 20–25 s when they are slow), so a check ran for 45 minutes and Make cut it off.
// Now ingest-raw stores the email (receipt_raw_queue) and answers at once; this reads it.
//
// It is started two ways, on purpose:
//   · ingest-raw kicks it after every email it stores, so it also runs under `npm run dev`,
//     where server.mjs's workers do not;
//   · server.mjs starts the minute timer, which picks up what a restart left behind.
// Two readers at most at a time: the lookups go to a Make scenario and a small proxy.
import {
  claimRawReceipt, finishRawReceipt, failRawReceipt, requeueStuckRawReceipts,
  ingestEmailReceipt, moveSweepOutcome, dbConfigured,
} from './db.js';
import { normalizeReceiptBody } from './receipt-ingest.js';
import { parseReceiptEmail } from './receipt-parser/index.js';

const READERS = 2;
const MAX_TRIES = 3;
const EVERY_MS = 60_000;
const STUCK_MINUTES = 10;   // one email is seconds; ten minutes means the process died on it
let running = 0;
let started = false;

/** One email → 'filed' | 'duplicate' | 'skipped:<why>'. Throws when it could not be read. */
export async function readRawReceipt(email) {
  const out = await parseReceiptEmail(email);
  if (!out?.post) return `skipped:${out?.skip || 'not_a_receipt'}`;
  const r = normalizeReceiptBody(out.parsed);
  if (!r) return 'skipped:no_message_key';
  const saved = await ingestEmailReceipt(r);
  return saved.duplicate ? 'duplicate' : 'filed';
}

const countAs = (job, to) => moveSweepOutcome({ mailbox: job.email?.mailbox, folder: job.email?.folder, runAt: job.run_at, to })
  .catch((e) => console.error('[receipt-queue] count', e.message));

async function drain() {
  for (;;) {
    const job = await claimRawReceipt();
    if (!job) return;
    try {
      const outcome = await readRawReceipt(job.email || {});
      await finishRawReceipt(job.id);
      await countAs(job, outcome);
    } catch (e) {
      const final = Number(job.attempts) >= MAX_TRIES;
      console.error(`[receipt-queue] ${job.message_key}: ${e.message}${final ? ' (gave up)' : ''}`);
      await failRawReceipt(job.id, e.message, final).catch(() => {});
      if (final) await countAs(job, 'error');
    }
  }
}

/** Start reading, if fewer than READERS are at it. Never throws, never waits. */
export function kickReceiptQueue() {
  if (!dbConfigured()) return;
  while (running < READERS) {
    running += 1;
    drain().catch((e) => console.error('[receipt-queue]', e.message)).finally(() => { running -= 1; });
  }
}

async function sweep(minutes) {
  try {
    // An email that stopped the server three times is given up on, and counted as failed.
    for (const f of await requeueStuckRawReceipts(minutes)) await countAs(f, 'error');
  } catch (e) { console.warn('[receipt-queue] requeue:', e.message); }
  kickReceiptQueue();
}

export function startReceiptQueueWorker() {
  if (started || !dbConfigured()) return;
  started = true;
  sweep(0);   // whatever a previous process was reading when it stopped
  setInterval(() => sweep(STUCK_MINUTES), EVERY_MS).unref?.();
  console.log('[receipt-queue] reader on');
}
