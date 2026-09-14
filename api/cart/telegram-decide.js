// POST /api/cart/telegram-decide   header: x-api-key: <BUYING_API_KEY>
//   { telegramUserId, cartId, lineIds:[…], action:'approve'|'reject', qty?, reason? }
//
// A tap in the Telegram group becomes a decision here. Make.com holds the key and posts
// this when somebody presses a button on the approval card.
//
// ── A BUTTON IS NOT AN IDENTITY ──────────────────────────────────────────────
// This is the whole reason the endpoint is more than a thin wrapper. Everyone in a
// Telegram group can press a button, and the API key proves only that the request came
// from the scenario — not who tapped. So the decision is recorded under the person whose
// `users.telegram_user_id` matches, and an unrecognised Telegram account is REFUSED.
//
// Checked here rather than in Make: a control that lives in a scenario is a control
// anyone with the Make login can edit. And the privilege is re-read from the database on
// this call like every other privileged act, so revoking `approve_buying` this morning
// stops them this morning — including from Telegram.
//
// The key alone must never be able to approve anything. It is a credential Make holds
// in a keychain its own warning says the requester can read.
import { getJsonBody, send, applySecurity, rateLimit } from '../_lib/util.js';
import { getBuyCart, userByTelegramId, noteTelegramLinkRequest, dbConfigured } from '../_lib/db.js';
import { hasPrivilege, decideLines } from '../_lib/buycart.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });

  const expected = String(process.env.BUYING_API_KEY || '').trim();
  if (!expected)
    return send(res, 503, { ok: false, error: 'The buying API is not configured (BUYING_API_KEY missing on the server).' });
  if (String(req.headers['x-api-key'] || '').trim() !== expected)
    return send(res, 401, { ok: false, error: 'Bad or missing API key.' });

  if (!rateLimit(req, { windowMs: 60_000, max: 120 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const cartId = Number(body.cartId);
  const tgId = Number(body.telegramUserId);
  // ONE LINE PER TAP, always, before anything can refuse it. "The button does nothing"
  // is unanswerable while the only evidence is a side effect — a refused tap writes no
  // decision and, for a linked account, no link request either, so silence looked
  // identical to the request never arriving. It is not identical, and this is the line
  // that tells the two apart.
  console.log(`[telegram-decide] tap from tg:${tgId || '?'} cart:${cartId || '?'} lines:${JSON.stringify(body.lineIds || [])} ${body.action || '?'} qty:${body.qty ?? '—'}`);
  const action = body.action === 'reject' ? 'reject' : 'approve';
  if (!Number.isInteger(cartId)) return send(res, 400, { ok: false, error: 'A valid cartId is required.' });
  if (!Number.isInteger(tgId) || tgId <= 0)
    return send(res, 400, { ok: false, error: 'telegramUserId is required — a decision has to have a person against it.' });

  try {
    // WHO TAPPED. Answered from our own table, never from anything the scenario asserts
    // about them: a display name in the callback payload is whatever Telegram was told.
    const actor = await userByTelegramId(tgId);
    if (!actor) {
      // THE FIRST TAP CAPTURES ITSELF. Nobody can read their own numeric Telegram id off
      // their phone, and an admin cannot link an account they cannot identify — so
      // refusing and saying "go find your id" was a dead end for both of them. The
      // number lands in `telegram_link_requests` and Check Access offers it as one
      // click.
      //
      // The decision is STILL refused. Group membership is enforced by Telegram, not by
      // us, and the API key proves only that the request came from the scenario — so an
      // unlinked tap is a decision with no one to record against, and recording it under
      // a Telegram display name would put a changeable string where the audit trail
      // needs a person.
      await noteTelegramLinkRequest({
        telegramUserId: tgId,
        // Whatever Telegram said. Untrusted, and only ever shown to an admin choosing
        // which account this is.
        name: String(body.telegramName ?? '').trim().slice(0, 120) || null,
        username: String(body.telegramUsername ?? '').trim().slice(0, 60) || null,
      }).catch(() => { /* the refusal matters more than the note */ });
      return send(res, 403, {
        ok: false,
        telegramUserId: tgId,
        needsLink: true,
        error: `Telegram account ${tgId} isn’t linked to anyone here yet, so this decision has nobody to record against. It has been noted — an admin links it in one click on Check Access, and the next tap will go through.`,
      });
    }
    if (actor.status !== 'approved')
      return send(res, 403, { ok: false, error: `${actor.name}’s account is not active here.` });
    // The same database read every privileged act does — not a cached list, not the key.
    if (!(await hasPrivilege(actor, 'approve_buying')))
      return send(res, 403, { ok: false, error: `${actor.name} cannot approve buying requests.` });

    const cart = await getBuyCart(cartId);
    if (!cart) return send(res, 404, { ok: false, error: 'That buying request does not exist.' });

    const lineIds = (Array.isArray(body.lineIds) ? body.lineIds : []).map(Number).filter(Number.isInteger);
    // One tap, one line, one quantity — the shape `callback_data` can carry. `qty` is
    // accepted as a bare number for that case, or as the { lineId: n } map the screen
    // sends, so both front doors speak the same language underneath.
    const qtyById = {};
    if (body.qty && typeof body.qty === 'object') {
      for (const [k, v] of Object.entries(body.qty)) {
        const id = Number(k); const n = Number(v);
        if (Number.isInteger(id) && Number.isInteger(n) && n > 0 && n <= 999) qtyById[id] = n;
      }
    }
    const flatQty = Number.isInteger(Number(body.qty)) && Number(body.qty) > 0
      ? Math.min(Number(body.qty), 999) : null;
    if (flatQty && lineIds.length === 1) qtyById[lineIds[0]] = flatQty;

    const out = await decideLines({
      cart, action, lineIds, all: false, qtyById, qtyAll: null,
      reason: body.reason, actor,
    });
    if (out.error) return send(res, out.code, { ok: false, error: out.error });

    // Enough for Make to EDIT the original message rather than send a new one — a group
    // where every decision leaves a live button behind is a group where somebody taps
    // yesterday's.
    return send(res, 200, {
      ok: true,
      decided: out.decided,
      by: actor.name || actor.username,
      action,
      qty: flatQty ?? null,
      // One line, already worded, for the edited Telegram message.
      outcome: action === 'approve'
        ? `${actor.name || actor.username} approved${flatQty ? ` · ${flatQty} pair${flatQty === 1 ? '' : 's'}` : ''}`
        : `${actor.name || actor.username} turned it down${String(body.reason || '').trim() ? ` · ${String(body.reason).trim()}` : ''}`,
      // The reaction to stamp on the card (`setMessageReaction`). Decided here rather
      // than in the scenario for the same reason the caption is written here: what the
      // group SEES and what the ledger RECORDS must be one decision. A scenario that
      // picks its own emoji can put a thumbs-up on a rejection, and the group believes
      // the emoji — it is the thing you can read from across a warehouse without opening
      // anything.
      //
      // Telegram only accepts reactions from its own fixed set on most chats; 👍 and 👎
      // are in it everywhere.
      reaction: action === 'approve' ? '👍' : '👎',
      request_status: out.cart?.status || null,
    });
  } catch (e) {
    console.error('[cart/telegram-decide]', e.message);
    return send(res, 500, { ok: false, error: 'Could not record that decision.' });
  }
}
