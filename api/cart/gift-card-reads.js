// POST /api/cart/gift-card-reads  { cartId, action }
//   action: 'queue'   -> read every card file with no reading yet  -> { ok, queued }
//           'cancel'  -> take waiting files back out of the queue  -> { ok }
//           'results' -> everything read, as one review table      -> { ok, cards, files, unread, mangled }
//           'clear'   -> forget the readings (they've been recorded) -> { ok }
//
// The server reads card files by itself (api/_lib/gc-read-worker.js). This is how the desk asks
// for them. Same rule as `gift-card-read`: issuing desk only, and nothing recorded here. The
// digits leave the database only on `results`, a deliberate press, and that writes who asked.
import { getJsonBody, send, applySecurity, rateLimit } from '../_lib/util.js';
import {
  getBuyCart, listBuyCartCardTails, logCartEvent, dbConfigured, queueCardRead, listCardFilesToRead,
  listDoneCardReads, clearCardReads, cancelCardReads,
} from '../_lib/db.js';
import { requirePrivilege } from '../_lib/buycart.js';
import { decryptSecret } from '../_lib/secrets.js';
import { mergeCardReads } from '../_lib/gcCards.js';
import { kickCardReads } from '../_lib/gc-read-worker.js';

const FINISHED = ['closed', 'cancelled', 'written_off'];

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = await requirePrivilege(req, res, 'issue_gift_cards');
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 30 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded — wait a minute.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const cartId = Number(body.cartId);
  if (!Number.isInteger(cartId)) return send(res, 400, { ok: false, error: 'A valid cartId is required.' });

  try {
    const cart = await getBuyCart(cartId);
    if (!cart) return send(res, 404, { ok: false, error: 'That buying request does not exist.' });

    if (body.action === 'queue') {
      if (FINISHED.includes(cart.status)) return send(res, 409, { ok: false, error: 'This request is finished.' });
      let queued = 0;
      for (const id of await listCardFilesToRead(cartId)) if (await queueCardRead(cartId, id, user)) queued++;
      kickCardReads();
      return send(res, 200, { ok: true, queued });
    }
    if (body.action === 'cancel') {
      await cancelCardReads(cartId);
      return send(res, 200, { ok: true });
    }
    if (body.action === 'clear') {
      await clearCardReads(cartId);
      return send(res, 200, { ok: true });
    }
    if (body.action !== 'results') return send(res, 400, { ok: false, error: 'Which action?' });

    const rows = await listDoneCardReads(cartId);
    const reads = rows.filter((r) => r.enc).map((r) => ({
      fileId: Number(r.file_id), fileName: r.name || '', cards: JSON.parse(decryptSecret(r.enc)),
    }));
    const cards = mergeCardReads(reads, await listBuyCartCardTails(cartId));
    // On the trail: who opened how many. Never a digit.
    await logCartEvent({
      cartId, kind: 'gc_read_all', actor: user,
      body: `${cards.length} card${cards.length === 1 ? '' : 's'} opened for review from ${reads.length} file${reads.length === 1 ? '' : 's'}`,
    });
    return send(res, 200, {
      ok: true, cards, files: reads.length,
      unread: rows.reduce((n, r) => n + Number(r.unread || 0), 0),
      mangled: rows.reduce((n, r) => n + Number(r.mangled || 0), 0),
    });
  } catch (e) {
    if (e.notConfigured) return send(res, 503, { ok: false, error: e.message });
    console.error('[cart/gift-card-reads]', e.message);   // the message only: never what was read
    return send(res, 500, { ok: false, error: 'Could not do that with the card readings.' });
  }
}
