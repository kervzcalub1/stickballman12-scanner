// POST /api/online-orders/receipt  { id }  -> { ok, state, receiptId? }
// "Find the receipt" / "Check again" on an online order: ask the ordering mailbox for this
// order's number NOW and file the email as its receipt. The same thing happens by itself when
// the order number is saved (api/_lib/online-order-receipts.js); this is for the email that
// arrived later than the retries, or a number that was typed wrong and fixed.
import { send, applySecurity, rateLimit, requireRole, getJsonBody } from '../_lib/util.js';
import { dbConfigured, getOnlineOrder } from '../_lib/db.js';
import { checkOrderReceiptNow, receiptLookupConfigured } from '../_lib/online-order-receipts.js';
import { actorOf, idOf } from './_shared.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['ph_team']);
  if (!user) return;
  // Every press is a mailbox search on the Make side.
  if (!rateLimit(req, { windowMs: 60_000, max: 12 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded — wait a minute before searching again.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const id = idOf((await getJsonBody(req)).id);
  if (!id) return send(res, 400, { ok: false, error: 'Which order?' });
  try {
    const o = await getOnlineOrder(id);
    if (!o) return send(res, 404, { ok: false, error: 'That order no longer exists.' });
    if (String(o.order_number || '').trim().length < 4) return send(res, 400, { ok: false, error: 'Add the order number first — the receipt is found by it.' });
    const out = await checkOrderReceiptNow(o.order_number, actorOf(user));
    if (out.state === 'unconfigured') return send(res, 503, { ok: false, error: 'Searching the mailbox is not set up on this server.', configured: receiptLookupConfigured() });
    if (out.state === 'error') return send(res, 502, { ok: false, error: 'The mailbox search did not answer. Try again in a minute.' });
    return send(res, 200, { ok: true, ...out });
  } catch (e) {
    console.error('[online-orders/receipt]', e.message);
    return send(res, 500, { ok: false, error: 'Could not search for the receipt.' });
  }
}
