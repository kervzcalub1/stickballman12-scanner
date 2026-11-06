// Reads gift card files on the server, one at a time, so closing the page never stops it
// (docs/context/buy-cart.md "Card files read on the server"). No AI: tesseract and pdfjs, here.
//
// A finished reading is stored encrypted, the same way a recorded card is, in its own table;
// the desk opens it with a button that writes to the trail. A restart requeues whatever was
// mid-read, and re-reading is harmless because nothing is recorded until a person ticks it.
import {
  claimCardRead, finishCardRead, requeueStuckCardReads, takeCardReadSummary, queueCardRead,
  getBuyCart, getBuyCartFile, addBuyCartFile, deleteBuyCartFile, listBuyCartCardFiles,
  setBuyCartFileCardTail, listDoneCardReads, logCartEvent, dbConfigured,
} from './db.js';
import { getObject, putObject, deleteObject, r2Configured } from './r2.js';
import { encryptSecret, decryptSecret, secretsConfigured } from './secrets.js';
import { cardTailFromFileName } from '../../src/lib/buycartRules.js';
import { cardFilesFromZip, MAX_ZIP_FILES } from './gcCards.js';

const EVERY_MS = 15_000;
const STUCK_MINUTES = 30;   // a 200-page PDF of pictures takes minutes
let busy = false;
let again = false;
let started = false;

const actorOf = (job) => ({ uid: job.actor_id, name: job.actor_name, role: job.actor_role });

// Open the ZIP, file each card as its own file (the all-cards PDF pairs a card with its own
// picture), queue them, drop the ZIP. Keys are fixed per ZIP and entry, so a run cut short by a
// restart carries on instead of filing the same card twice.
async function unpackZip(job, file) {
  let opened;
  try {
    opened = cardFilesFromZip(await getObject(file.r2_key));
  } catch (e) {
    const big = /more than|too large/.test(e.message);
    console.warn(`[gc-read] ZIP on cart ${job.cart_id} refused: ${big ? e.message : 'could not be opened'}`);
    return finishCardRead(job.file_id, {
      status: 'failed',
      error: big
        ? `This ZIP is too big to read here (up to ${MAX_ZIP_FILES} files). Split it and upload the parts.`
        : 'This ZIP could not be opened. It may be damaged or have a password.',
    });
  }
  if (!opened.files.length) {
    return finishCardRead(job.file_id, { status: 'failed', error: 'Nothing in this ZIP looks like a card picture, a PDF or a CSV.' });
  }
  const cart = await getBuyCart(job.cart_id);
  const actor = actorOf(job);
  const filed = new Set((await listBuyCartCardFiles(job.cart_id)).map((f) => f.r2_key));
  for (let i = 0; i < opened.files.length; i++) {
    const f = opened.files[i];
    const key = `buy-carts/${cart.cart_code}/gift_card-${file.id}${String(i).padStart(3, '0')}.${f.ext}`;
    if (filed.has(key)) continue;
    await putObject(key, f.bytes);
    const row = await addBuyCartFile({
      cartId: job.cart_id, kind: 'gift_card', key, name: f.name,
      contentType: f.contentType, sizeBytes: f.bytes.length, actor, quiet: true,
    });
    await queueCardRead(job.cart_id, Number(row.id), actor);
  }
  await logCartEvent({
    cartId: job.cart_id, kind: 'file_added', actor,
    body: `gift_card: “${file.name || 'ZIP'}” unpacked into ${opened.files.length} file${opened.files.length === 1 ? '' : 's'}`
      + `${opened.skipped ? `, ${opened.skipped} skipped (not a card file)` : ''}`,
  });
  // Its reading row goes with it (ON DELETE CASCADE). The bucket copy is best-effort: its
  // contents are already filed one by one.
  await deleteBuyCartFile(job.cart_id, job.file_id);
  await deleteObject(file.r2_key).catch((e) => console.warn('[gc-read] ZIP left in storage:', e.message));
}

// The last four of every card on a CSV this request has read.
async function csvCardTails(cartId) {
  const tails = new Set();
  for (const r of await listDoneCardReads(cartId)) {
    if (r.source !== 'csv' || !r.enc) continue;
    for (const c of JSON.parse(decryptSecret(r.enc))) tails.add(String(c.number).slice(-4));
  }
  return tails;
}

async function readOne(job) {
  const file = await getBuyCartFile(job.cart_id, job.file_id);
  if (!file) return;   // deleted while it waited; its reading row went with it
  if (/\.zip$/i.test(file.r2_key || '')) return unpackZip(job, file);
  // THE CSV HAS THE CARD; THE PICTURE IS FOR THE TILL. A picture named for a card on the CSV
  // needs no OCR: it only has to be tied to that card for the supplier's PDF. A picture of a
  // card the CSV doesn't list is still read, so that card comes up for review, not vanishes.
  const tail = String(file.content_type || '').startsWith('image/') ? cardTailFromFileName(file.name) : null;
  if (tail && (await csvCardTails(job.cart_id)).has(tail)) {
    await setBuyCartFileCardTail(job.cart_id, job.file_id, tail);
    return finishCardRead(job.file_id, { status: 'picture' });
  }
  // Imported here, not above: the reader lives with the endpoint and pulls in the OCR libraries.
  const { readCardFile } = await import('../cart/gift-card-read.js');
  const { cards, source, unread, mangled, single } = await readCardFile(file, await getObject(file.r2_key));
  if (single) await setBuyCartFileCardTail(job.cart_id, job.file_id, cards[0].number.slice(-4)).catch(() => {});
  await finishCardRead(job.file_id, {
    status: 'done', cardCount: cards.length, unread, mangled, source,
    enc: cards.length ? encryptSecret(JSON.stringify(cards)) : null,
  });
}

// On the trail once a request's queue empties: how many, never a digit.
async function logSummary(job) {
  const s = await takeCardReadSummary(job.cart_id);
  if (!s) return;
  await logCartEvent({
    cartId: job.cart_id, kind: 'gc_read_all', actor: actorOf(job),
    body: `${s.cards} card${s.cards === 1 ? '' : 's'} read from ${s.files} file${s.files === 1 ? '' : 's'} on this server`
      + `${s.missed ? `, ${s.missed} file${s.missed === 1 ? '' : 's'} with nothing read` : ''} — nothing recorded until reviewed`,
  });
}

export async function cardReadTick() {
  if (busy) { again = true; return; }
  if (!dbConfigured()) return;
  busy = true;
  try {
    do {
      again = false;
      for (;;) {
        const job = await claimCardRead();
        if (!job) break;
        try {
          if (!r2Configured()) throw new Error('File storage is not configured.');
          if (!secretsConfigured()) throw new Error('BUY_GC_KEY is not set.');
          await readOne(job);
        } catch (e) {
          // The message only, and never shown: it could name a storage key, never a digit, but
          // the screen gets plain words.
          console.error(`[gc-read] file ${job.file_id}:`, e.message);
          await finishCardRead(job.file_id, { status: 'failed', error: 'This file could not be read. Open it and type its cards in.' }).catch(() => {});
        }
        await logSummary(job).catch((e) => console.warn('[gc-read] summary:', e.message));
      }
    } while (again);
  } catch (e) {
    console.error('[gc-read]', e.message);
  } finally {
    busy = false;
  }
}

/** Start reading now rather than at the next tick. Never throws, never waits. */
export function kickCardReads() {
  setImmediate(() => { cardReadTick().catch((e) => console.error('[gc-read]', e.message)); });
}

export function startCardReadWorker() {
  if (started) return;
  started = true;
  // Whatever a previous process was reading when it stopped goes back in the queue.
  requeueStuckCardReads(0).catch((e) => console.warn('[gc-read] requeue:', e.message)).finally(kickCardReads);
  setInterval(() => {
    requeueStuckCardReads(STUCK_MINUTES).catch((e) => console.warn('[gc-read] requeue:', e.message)).finally(kickCardReads);
  }, EVERY_MS).unref?.();
  console.log('[gc-read] worker on');
}
