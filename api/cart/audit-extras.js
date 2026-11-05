// POST /api/cart/audit-extras
//   { cartId, action:'add_card', card:{ code, spent, remark, personal } } -> a card the auditor adds
//   { cartId, action:'remove_card', id, reason? }                         -> take a personal card off
//   { cartId, action:'note', note }                                       -> a note for the record
//
// The audit has to account for all the money the till took. When the buyer rang their own shoes up
// with ours and paid for them with their own cards, those cards are part of that sum and none of
// our money, so the auditor can put them on the record, marked as such and saying why.
//
// A personal card never counts toward what was funded, never prints on the cards PDF and can't be
// read back. Its number is still encrypted: a card number is a card number. Same audit privilege,
// and same "you approved it, you can't audit it" rule as the audit itself. Suppliers see none of it.
import { getJsonBody, send, applySecurity, rateLimit } from '../_lib/util.js';
import { getBuyCart, getBuyCartFull, addAuditGiftCard, removeAuditGiftCard, logCartEvent, dbConfigured } from '../_lib/db.js';
import { encryptSecret, maskTail, secretsConfigured } from '../_lib/secrets.js';
import { requireAuditPrivilege, cartCloseChecks, redactCartForViewer } from '../_lib/buycart.js';

const money = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null; };

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const body = await getJsonBody(req);
  const cartId = Number(body.cartId);
  if (!Number.isInteger(cartId)) return send(res, 400, { ok: false, error: 'A valid cartId is required.' });
  const cart = await getBuyCart(cartId);
  if (!cart) return send(res, 404, { ok: false, error: 'That buying request does not exist.' });
  const user = await requireAuditPrivilege(req, res, cart);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });

  const answer = async () => {
    const full = await getBuyCartFull(cartId);
    return send(res, 200, { ok: true, cart: redactCartForViewer(full, user), checks: await cartCloseChecks(full) });
  };

  try {
    if (body.action === 'note') {
      const note = String(body.note ?? '').trim().slice(0, 2000);
      if (note.length < 3) return send(res, 400, { ok: false, error: 'Write the note first.' });
      await logCartEvent({ cartId, kind: 'audit_note', actor: user, body: note });
      return answer();
    }

    if (!['receipted', 'audited'].includes(cart.status))
      return send(res, 409, { ok: false, error: 'There is nothing to audit until the receipt has been read in.' });

    if (body.action === 'remove_card') {
      const gone = await removeAuditGiftCard({ cartId, gcId: Number(body.id), reason: String(body.reason ?? '').trim().slice(0, 300) || null, actor: user });
      if (!gone) return send(res, 404, { ok: false, error: 'That isn’t a personal card on this request. The gift card desk withdraws company cards.' });
      return answer();
    }

    if (body.action === 'add_card') {
      if (!secretsConfigured())
        return send(res, 503, { ok: false, error: 'Gift card numbers can’t be stored securely on this server yet (BUY_GC_KEY is not set).' });
      const c = body.card || {};
      const code = String(c.code ?? '').trim().slice(0, 120);
      const spent = money(c.spent);
      const remark = String(c.remark ?? '').trim().slice(0, 300);
      if (code.replace(/\D/g, '').length < 4) return send(res, 400, { ok: false, error: 'Enter the card number, or at least its last 4 digits.' });
      if (spent == null) return send(res, 400, { ok: false, error: 'Enter how much this card paid at the till.' });
      if (remark.length < 3) return send(res, 400, { ok: false, error: 'Say whose card this is and why it is here. It stays on the record.' });
      await addAuditGiftCard({
        cartId, codeEnc: encryptSecret(code), codeLast4: maskTail(code), spent,
        personal: c.personal !== false, remark, actor: user,
      });
      return answer();
    }

    return send(res, 400, { ok: false, error: 'Unknown action.' });
  } catch (e) {
    // The shape of the failure, never the statement: it could carry a card number.
    console.error('[cart/audit-extras]', e.message);
    return send(res, 500, { ok: false, error: 'Could not save that.' });
  }
}
