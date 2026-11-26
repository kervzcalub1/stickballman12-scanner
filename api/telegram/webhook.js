// POST /api/telegram/webhook   header: X-Telegram-Bot-Api-Secret-Token: <TELEGRAM_WEBHOOK_SECRET>
//
// The bot's updates, straight from Telegram (registered with `npm run telegram:webhook`).
// This is what Make's "Telegram tap → decision recorded" scenario did, done here:
//   · a button tap — approve / reject → recorded under the person who tapped
//     (decideFromTelegram), the outcome replied under the card, 👍 / 👎 on the card;
//     "More…" → a force-reply "How many pairs?"
//   · a number typed back to that question (same person, same chat, 10 minutes) →
//     approved at that quantity
//   · `/start <token>` in a PRIVATE chat → connects that Telegram account to the app
//     account that minted the token (the Alerts panel's "Connect Telegram"); a plain
//     `/start` says who this chat is connected as (api/me/telegram.js, api/_lib/alerts.js)
//   · a PHOTO (or an image sent as a file) in a private chat, from a connected warehouse /
//     PH / admin account → an order to cancel: read and recorded on the Cancellations page;
//     ONE answer per batch of photos, as a reply to the first; a typed order number is
//     recorded too (api/_lib/cancellations.js)
//
// ALWAYS ANSWERS 200 once the secret checks out. Telegram re-sends any update it didn't get
// a 2xx for, so a failure here would come back as the same tap again and again; the
// failure is logged and — where there is a card to answer — said in the group instead.
//
// DEV AND PROD SHARE ONE BOT, and a bot has exactly one webhook: production's. Every
// button carries the env of the server that sent the card (`…:dev` / `…:prod`), and prod
// passes a dev card's taps on to TELEGRAM_DEV_FORWARD_URL (the dev tunnel) untouched, so a
// test card is recorded in the dev database and never in the real one.
import { send, applySecurity, getJsonBody } from '../_lib/util.js';
import { dbConfigured, buyerChatIds, recordReplyMiss, askTelegramQty, takeTelegramQty, getTelegramGroupCard, claimTelegramGroupReply, getBuyCartLine, redeemTelegramLinkToken, userNameByTelegramId, telegramSender, setCancellationCtx, useCancellationCtx, createCancellationPhoto, setCancellationPhotoPlatform, holdCancellationPhoto, heldCancellationPhotosByPrompt, releaseHeldCancellationPhotosByPrompt, releaseHeldCancellationPhotosOf, cancellationBatchByReply, voidCancellationBatch, cancellationPhotoByAskMessage } from '../_lib/db.js';
import { telegramConfigured, telegramChatId, cancelChatId, tg, enqueue } from '../_lib/telegram.js';
import { decideFromTelegram, decideTipFromTelegram } from '../_lib/telegramDecide.js';
import { notifyEnv } from '../_lib/notify.js';
import { alertCancellationsLogged } from '../_lib/alerts.js';
import { fileTypedCancellation, typedReplyText, sayTo, HOW_TO, dayFrom, msgPicker, msgFor, msgAll, sendDayReport, cancelBatchStart, cancelBatchDone, cancelBatchDrop, readTelegramPhoto, askPlatformSoon, readReleasedPhotos, cancelReading, fileMissedReply } from '../_lib/cancellations.js';
import { platformLabel, PLATFORMS, splitCommand, extractImageFile } from '../../src/lib/cancellations.js';
import { parseApprovalReply, splitTipReply, sizeKey } from '../../src/lib/buyPaste.js';
const PLATFORM_KEYS = new Set(PLATFORMS.map((p) => p.key));

const env = (k) => String(process.env[k] || '').trim();

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const secret = env('TELEGRAM_WEBHOOK_SECRET');
  // No secret configured = nobody can prove they're Telegram, so nothing is accepted.
  if (!secret) return send(res, 503, { ok: false, error: 'TELEGRAM_WEBHOOK_SECRET is not set on this server.' });
  if (String(req.headers['x-telegram-bot-api-secret-token'] || '') !== secret)
    return send(res, 401, { ok: false, error: 'Bad secret.' });
  if (!telegramConfigured() || !dbConfigured())
    return send(res, 503, { ok: false, error: 'Telegram or the database is not configured on this server.' });

  const update = await getJsonBody(req);
  try {
    await handleUpdate(update);
  } catch (e) {
    console.error('[telegram/webhook]', e.message);
  }
  return send(res, 200, { ok: true });
}

async function handleUpdate(update) {
  if (update?.callback_query) return handleTap(update, update.callback_query);
  if (update?.message) return handleMessage(update, update.message);
  return null;
}

// Only the approval groups: the main one, every buyer's OWN buying group (users.
// buying_chat_id) and every buyer's PREMIUM group (users.premium_chat_id) — Check Access. The identity check would refuse a stranger anyway; this
// keeps the bot from answering in chats it was added to by mistake. Read fresh each time
// (only a message OUTSIDE the main group gets this far — a reply to a card, or a number),
// so a group set on Check Access answers at once.
async function inOurChat(chatId) {
  const id = String(chatId ?? '');
  if (!id) return false;
  if (id === telegramChatId()) return true;
  try { return (await buyerChatIds()).includes(id); } catch { return false; }
}

async function handleTap(update, cq) {
  // Stop the spinner on the tapper's button first, whatever happens next. Best-effort.
  // The cancellation buttons answer the tap THEMSELVES — a tap that can't be honoured (an
  // old button, someone else's photos) says why in a pop-up, and a tap is answered only once.
  if (/^cxpick:|^cxvoid$/.test(String(cq.data || ''))) return handleCancelTap(cq);
  tg('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});
  if (String(cq.data || '').startsWith('cxmsg:')) return handleCancelMsgTap(cq);
  const chatId = cq.message?.chat?.id;
  // The CARD this tap is about. A tap on the card itself is the card; a tap on the
  // quantity picker "More…" posts is on a message that replies to the card — the answer
  // and the 👍 belong on the card, not on the picker.
  const tappedId = cq.message?.message_id;
  const messageId = cq.message?.reply_to_message?.message_id || tappedId;
  if (!(await inOurChat(chatId)) || !messageId) {
    console.log(`[telegram/webhook] tap from chat ${chatId} ignored — not the approval group`);
    return null;
  }
  const parts = String(cq.data || '').split(':');
  const kind = parts[0];
  const cardEnv = parts[parts.length - 1] === 'dev' ? 'dev' : 'prod';
  const from = cq.from || {};
  if (kind === 'grpreject') {
    if (cardEnv !== notifyEnv()) return forwardToOtherEnv(update, cardEnv);
    const card = await getTelegramGroupCard({ id: Number(parts[1]) });
    if (!card) return answerOnCard(chatId, messageId, { code: 404, body: { ok: false, error: 'This card is not on record here' } }, cardEnv);
    return oneCardAtATime(card.id, async () => {
      const lines = await cardLines(card);
      if (!lines.length) return answerOnCard(chatId, messageId, { code: 404, body: { ok: false, error: 'Those sizes are no longer on the request' } }, cardEnv);
      return decideGroup({ from, card, chatId, messageId, cardEnv, lines, approve: [], reject: lines.map((l) => ({ id: Number(l.id), size: l.size })) });
    });
  }
  const cartId = Number(parts[1]);
  const lineId = Number(parts[2]);

  if (cardEnv !== notifyEnv()) {
    if (kind === 'more') {
      // Remembered HERE too (as dev), so the number typed back — which also arrives at
      // this webhook — knows to go to the dev server.
      await askTelegramQty({ telegramUserId: from.id, cartId, lineId, chatId, cardMessageId: messageId, env: cardEnv });
    }
    return forwardToOtherEnv(update, cardEnv);
  }

  if (kind === 'approve' || kind === 'reject') {
    // Answering from the picker spends the open question, so a stray number typed later
    // doesn't decide it a second time.
    if (tappedId !== messageId) await takeTelegramQty(from.id, chatId).catch(() => null);
    const out = await decideFromTelegram({
      telegramUserId: from.id,
      telegramName: from.first_name,
      telegramUsername: from.username,
      cartId,
      lineIds: [lineId],
      action: kind,
      ...(kind === 'approve' ? { qty: Number(parts[3]) } : {}),
    });
    return answerOnCard(chatId, messageId, await alreadyRecorded(out, cartId, lineId, kind, Number(parts[3])), cardEnv);
  }
  // A premium pair's tip buttons (one-size card): the same decision a "tip ok" reply makes.
  if (kind === 'tipok' || kind === 'tipno') {
    const out = await decideTipFromTelegram({
      telegramUserId: from.id, telegramName: from.first_name, telegramUsername: from.username,
      cartId, lineIds: [lineId], action: kind === 'tipok' ? 'approve' : 'decline',
    });
    return enqueue(() => tg('sendMessage', {
      chat_id: chatId,
      text: `${out.body?.ok ? `💵 ${out.body.outcome}` : `⚠️ ${out.body?.error || 'The tip answer was not recorded'}`}${cardEnv === 'dev' ? ' · [dev]' : ''}`,
      reply_parameters: { message_id: messageId, allow_sending_without_reply: true },
    }));
  }
  if (kind === 'more') {
    await askTelegramQty({ telegramUserId: from.id, cartId, lineId, chatId, cardMessageId: messageId, env: cardEnv });
    // A PICKER, not "type a number". Make asked for a typed reply, and in the first live
    // test it never arrived: the bot runs with group privacy ON, so it only sees a group
    // message that REPLIES to one of its own, and the phone sent "10" as a plain message
    // — `force_reply` (even with the tapper mentioned) is a hint a client may ignore. The
    // buttons are ordinary `approve:` taps, so they need no reply, no privacy change, and
    // go through the same identity check as Buy 1/2/3. A typed number that DOES arrive as
    // a reply still counts (handleMessage), for a quantity that isn't on the picker.
    const who = String(from.first_name || from.username || 'You').trim() || 'You';
    const tail = `${cartId}:${lineId}`;
    const b = (n) => ({ text: String(n), callback_data: `approve:${tail}:${n}:${cardEnv}` });
    return enqueue(() => tg('sendMessage', {
      chat_id: chatId,
      text: `${who}, how many pairs? Tap one — or reply to this message with any other number.`,
      entities: [{ type: 'text_mention', offset: 0, length: who.length, user: { id: from.id } }],
      reply_parameters: { message_id: messageId, allow_sending_without_reply: true },
      reply_markup: {
        inline_keyboard: [
          [b(4), b(5), b(6), b(8)],
          [b(10), b(12), b(15), b(20)],
          [{ text: 'Cancel', callback_data: `cancel:${tail}:${cardEnv}` }],
        ],
      },
    }));
  }
  if (kind === 'cancel') {
    // Clears the open question and takes the picker away — nothing was decided.
    await takeTelegramQty(from.id, chatId);
    return enqueue(() => tg('deleteMessage', { chat_id: chatId, message_id: tappedId })).catch(() => null);
  }
  console.log(`[telegram/webhook] unknown button "${cq.data}"`);
  return null;
}

async function handleMessage(update, msg) {
  if (msg.chat?.type === 'private') return handlePrivate(update, msg);
  // The cancellations group (TELEGRAM_CANCEL_CHAT_ID): photos and platform commands only.
  if (cancelChatId() && String(msg.chat?.id) === cancelChatId()) return handleCancellation(msg, { group: true });
  // `/chatid` in ANY group the bot is in → that group's id, so a new group (e.g. the
  // pre-sell sales group, TELEGRAM_PRESELL_CHAT_ID) can be wired up without a developer.
  if (/^\/chatid(@\w+)?\s*$/i.test(String(msg.text || ''))) {
    return tg('sendMessage', { chat_id: msg.chat.id, text: `This chat's id: ${msg.chat.id}` }).catch((e) => console.error('[telegram/webhook] chatid', e.message));
  }
  // A REPLY to a one-card-per-shoe card: "9 x 5" lines (api/_lib/notify.js notifyGroupAsked).
  // Recognised by the card's own button, which also says which server sent it.
  const card0 = msg.reply_to_message;
  const grpData = (card0?.reply_markup?.inline_keyboard || []).flat()
    .map((b) => String(b.callback_data || '')).find((d) => d.startsWith('grpreject:'));
  if (grpData && msg.text && await inOurChat(msg.chat?.id)) {
    const cardEnv = grpData.endsWith(':dev') ? 'dev' : 'prod';
    if (cardEnv !== notifyEnv()) return forwardToOtherEnv(update, cardEnv);
    return handleGroupReply(msg, card0, cardEnv);
  }
  // Same card, should a client ever deliver the reply without the card's buttons: a card
  // in THIS server's table is ours by definition.
  if (card0 && msg.text && await inOurChat(msg.chat?.id)
      && await getTelegramGroupCard({ chatId: msg.chat.id, messageId: card0.message_id }).catch(() => null)) {
    return handleGroupReply(msg, card0, notifyEnv());
  }
  // A REPLY to a ONE-SIZE card (the one with Buy 1/2/3 buttons). Typed answers there used
  // to vanish without a word — "take all", "2", "yes" all recorded nothing and said
  // nothing (floor feedback, 2026-11-02). Same reader as the shoe card, for its one size.
  const lineData = (card0?.reply_markup?.inline_keyboard || []).flat()
    .map((b) => String(b.callback_data || '')).find((d) => /^reject:\d+:\d+:/.test(d));
  if (lineData && msg.text && await inOurChat(msg.chat?.id)) {
    const [, cartId, lineId, env] = lineData.split(':');
    const cardEnv = env === 'dev' ? 'dev' : 'prod';
    if (cardEnv !== notifyEnv()) return forwardToOtherEnv(update, cardEnv);
    await takeTelegramQty((msg.from || {}).id, msg.chat.id).catch(() => null);   // a "More…" left open
    return handleLineReply(msg, card0, cardEnv, Number(cartId), Number(lineId));
  }
  if (!/^\s*\d{1,3}\s*$/.test(String(msg.text || ''))) return null;
  if (!(await inOurChat(msg.chat?.id))) return null;
  const from = msg.from || {};
  const pending = await takeTelegramQty(from.id, msg.chat.id);
  // Just someone typing a number in the group — nothing was asked of them.
  if (!pending) return null;
  if (pending.env !== notifyEnv()) return forwardToOtherEnv(update, pending.env);
  const out = await decideFromTelegram({
    telegramUserId: from.id,
    telegramName: from.first_name,
    telegramUsername: from.username,
    cartId: Number(pending.cart_id),
    lineIds: [Number(pending.line_id)],
    action: 'approve',
    qty: Number(String(msg.text).trim()),
  });
  return answerOnCard(msg.chat.id, Number(pending.card_message_id),
    await alreadyRecorded(out, Number(pending.cart_id), Number(pending.line_id), 'approve', Number(String(msg.text).trim())), pending.env);
}

// A tap (Buy N / Turn it down / a picker number) that asks for what the pair ALREADY says
// changes nothing, and the decide path answers 409 "Nothing was still awaiting a decision —
// someone may have got there first". That read as a conflict or a lost tap, when it was a
// double tap or two approvers agreeing (floor feedback, 2026-11-04). Typed replies got the
// same fix on 11-02 (decideGroup). Checked AFTER the decision path, so the identity rules
// (unlinked tapper, no approve_buying) still answer first; only a 409 whose line now holds
// exactly what was asked is reworded — anything else is passed through untouched.
async function alreadyRecorded(out, cartId, lineId, action, qty) {
  if (out?.body?.ok || out?.code !== 409) return out;
  const line = await getBuyCartLine(cartId, lineId).catch(() => null);
  if (!line) return out;
  const same = action === 'reject'
    ? line.status === 'rejected'
    : line.status === 'approved' && Number(line.qty) === Number(qty);
  if (!same) return out;
  const by = line.decided_by ? ` by ${line.decided_by}` : '';
  const size = line.size ? `size ${line.size}` : 'this pair';
  const said = action === 'reject' ? `${size} turned down${by}` : `${size} ×${line.qty}, approved${by}`;
  return { code: 200, body: { ok: true, outcome: `✅ Already recorded — nothing changed (${said}).`, reaction: action === 'reject' ? '👎' : '👍' } };
}

// "11 x 3 / 10.5 x 4" under a shoe's card → those sizes approved at those quantities, every
// other size on the card turned down. Strict: anything unreadable, or a size that isn't on
// the card, records NOTHING and says why — this spends money (src/lib/buyPaste.js).
async function handleGroupReply(msg, cardMsg, cardEnv) {
  const chatId = msg.chat.id;
  const card = await getTelegramGroupCard({ chatId, messageId: cardMsg.message_id });
  const say = (text) => enqueue(() => tg('sendMessage', {
    chat_id: chatId, text: `${text}${cardEnv === 'dev' ? ' · [dev]' : ''}`,
    reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true },
  }));
  if (!card) return say('⚠️ This card is not on record here, so nothing was recorded.');
  return oneCardAtATime(card.id, async () => {
    const lines = await cardLines(card);
    if (!lines.length) return say('⚠️ Those sizes are no longer on the request, so nothing was recorded.');
    // A premium shoe's TIP answer ("tip ok" / "tip no" / "tip 5") can come alone or beside
    // the sizes. Everything is read before anything is recorded, as before.
    const missed = (error) => logMiss(msg, { cartId: card.cart_id, lines, kind: 'shoe', error, env: cardEnv });
    const split = splitTipReply(msg.text);
    if (split.error) { missed(split.error); return say(`⚠️ ${split.error}`); }
    if (split.tip && !lines.some((l) => l.tip_status != null || l.premium))
      return say('⚠️ This shoe isn’t premium and has no tip proposed, so nothing was recorded.');
    const sizesSaid = !split.tip || split.rest.trim() !== '';
    const read = sizesSaid ? parseApprovalReply(split.tip ? split.rest : msg.text, lines) : null;
    if (read && !read.ok) { missed(read.error); return say(`⚠️ ${read.error}`); }
    // Telegram redelivers an update it didn't get a 200 for; the second copy is a no-op.
    if (!(await claimTelegramGroupReply(card.id, msg.message_id))) return null;
    if (split.tip) {
      const from = msg.from || {};
      const out = await decideTipFromTelegram({
        telegramUserId: from.id, telegramName: from.first_name, telegramUsername: from.username,
        cartId: card.cart_id, lineIds: lines.map((l) => Number(l.id)), ...split.tip,
      });
      await say(out.body?.ok ? `💵 ${out.body.outcome}` : `⚠️ ${out.body?.error || 'The tip answer was not recorded'}`);
    }
    if (!read) return null;
    return decideGroup({
      from: msg.from || {}, card, chatId, messageId: cardMsg.message_id, cardEnv, lines,
      approve: read.approve.map((a) => ({ id: Number(a.line.id), size: a.line.size, qty: a.qty })),
      reject: read.reject.map((l) => ({ id: Number(l.id), size: l.size })),
      note: read.note || null,
    });
  });
}

// A size the buyer X'd out (status 'skipped') is off the card: a reply can't approve it,
// and "the rest are turned down" must not turn their "not buying" into our "no".
// A typed reply to a one-size card: a bare number ("2") is how many to buy; otherwise the
// shoe card's reader with this one size ("take all", "yes", "no", "9 x 2", "$5 tip").
async function handleLineReply(msg, cardMsg, cardEnv, cartId, lineId) {
  const chatId = msg.chat.id;
  const say = (text) => enqueue(() => tg('sendMessage', {
    chat_id: chatId, text: `${text}${cardEnv === 'dev' ? ' · [dev]' : ''}`,
    reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true },
  }));
  const card = { id: `line:${lineId}`, cart_id: cartId, line_ids: [lineId] };
  return oneCardAtATime(card.id, async () => {
    const lines = await cardLines(card);
    if (!lines.length) return say('⚠️ That pair is no longer waiting on the request (removed, or the buyer isn’t buying it), so nothing was recorded.');
    const missed = (error) => logMiss(msg, { cartId, lines, kind: 'line', error, env: cardEnv });
    const split = splitTipReply(msg.text);
    if (split.error) { missed(split.error); return say(`⚠️ ${split.error}`); }
    if (split.tip && !lines.some((l) => l.tip_status != null || l.premium))
      return say('⚠️ This shoe isn’t premium and has no tip proposed, so nothing was recorded.');
    const rest = (split.tip ? split.rest : msg.text).trim();
    let read = null;
    if (rest) {
      const bare = /^(\d{1,3})(?:\s*(?:pairs?|prs?|x))?$/i.exec(rest);
      // "9" on a size 9 card names the size, so it is one pair like any size with no quantity.
      // Reading it as nine pairs would spend nine times what the approver meant.
      const namesItsSize = bare && rest === bare[1] && Number(rest) === parseFloat(sizeKey(lines[0].size));
      read = namesItsSize
        ? parseApprovalReply(rest, lines)
        : bare
        ? (Number(bare[1]) > 0 ? { ok: true, approve: [{ line: lines[0], qty: Number(bare[1]) }], reject: [] } : { ok: true, approve: [], reject: [lines[0]] })
        : parseApprovalReply(rest, lines);
      if (!read.ok) { missed(read.error); return say(`⚠️ ${read.error}`); }
    }
    if (split.tip) {
      const from = msg.from || {};
      const out = await decideTipFromTelegram({
        telegramUserId: from.id, telegramName: from.first_name, telegramUsername: from.username,
        cartId, lineIds: [lineId], ...split.tip,
      });
      await say(out.body?.ok ? `💵 ${out.body.outcome}` : `⚠️ ${out.body?.error || 'The tip answer was not recorded'}`);
    }
    if (!read) return null;
    return decideGroup({
      from: msg.from || {}, card, chatId, messageId: cardMsg.message_id, cardEnv, lines,
      approve: read.approve.map((a) => ({ id: Number(a.line.id), size: a.line.size, qty: a.qty })),
      reject: read.reject.map((l) => ({ id: Number(l.id), size: l.size })),
      note: read.note || null,
    });
  });
}

// A reply the bot couldn't READ (not one it read and refused — an unlinked tapper or a
// funded request is a rule, not a gap in the reader). Kept in telegram_reply_misses so what
// to teach the reader next is answered from data. Never awaited, never fatal.
function logMiss(msg, { cartId, lines, kind, error, env }) {
  const from = msg.from || {};
  console.log(`[telegram] could not read a ${kind} card reply on cart ${cartId}: "${String(msg.text || '').slice(0, 120)}"`);
  recordReplyMiss({
    cartId, lineIds: (lines || []).map((l) => Number(l.id)), cardKind: kind,
    sizes: (lines || []).map((l) => l.size).join(', '), text: msg.text, error,
    telegramUserId: from.id ?? null, fromName: [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || null, env,
  }).catch((e) => console.warn('[telegram] reply miss not logged:', e.message));
}

const cardLines = async (card) =>
  (await Promise.all(card.line_ids.map((id) => getBuyCartLine(card.cart_id, id))))
    .filter((l) => l && l.status !== 'skipped');

// ONE DECISION PER CARD AT A TIME. A reply approves some sizes and turns the rest down in
// two steps, so two approvers answering the same card in the same second could interleave
// — A's approvals, B's approvals, A's rejections, B's rejections — and leave every size
// turned down, which neither of them said. Queued per card, each reply runs whole, in the
// order they arrived (the claim drops an older one that turns up after a newer one).
const cardQueues = new Map();
function oneCardAtATime(cardId, fn) {
  const next = (cardQueues.get(cardId) || Promise.resolve()).catch(() => {}).then(fn);
  cardQueues.set(cardId, next);
  next.finally(() => { if (cardQueues.get(cardId) === next) cardQueues.delete(cardId); }).catch(() => {});
  return next;
}

// One decision for the whole card: the approvals (each with its quantity), then the rest
// turned down — through decideFromTelegram, so the identity and `approve_buying` checks are
// the same as a button tap's. Answered under the card in one message.
async function decideGroup({ from, card, chatId, messageId, cardEnv, lines, approve, reject, note = null }) {
  const who = { telegramUserId: from.id, telegramName: from.first_name, telegramUsername: from.username, cartId: card.cart_id };
  let name = null;
  // ONLY WHAT WOULD CHANGE is sent. A reply that says what the card already says (sent
  // twice, or "take all" after the same answer) used to come back as "Nothing was still
  // awaiting a decision — someone may have got there first · HTTP 409" — an error for a
  // reply that was right (floor feedback, 2026-11-02). Now it's "already recorded".
  const cur = new Map(lines.map((l) => [Number(l.id), l]));
  const approveNow = approve.filter((a) => !(cur.get(a.id)?.status === 'approved' && Number(cur.get(a.id)?.qty) === Number(a.qty)));
  const rejectNow = reject.filter((r) => cur.get(r.id)?.status !== 'rejected');
  if (!approveNow.length && !rejectNow.length) {
    const said = [
      ...approve.map((a) => `${a.size} ×${a.qty}`),
      ...(reject.length ? [`turned down: ${reject.map((r) => r.size).join(', ')}`] : []),
    ].join(', ');
    return answerOnCard(chatId, messageId, { code: 200, body: { ok: true, outcome: `✅ Already recorded — nothing changed (${said}).`, reaction: approve.length ? '👍' : '👎' } }, cardEnv);
  }
  if (approveNow.length) {
    const out = await decideFromTelegram({
      ...who, action: 'approve',
      lineIds: approveNow.map((a) => a.id),
      qty: Object.fromEntries(approveNow.map((a) => [a.id, a.qty])),
    });
    // Nothing turned down either when the approval was refused — half a decision is worse.
    if (!out.body?.ok) return answerOnCard(chatId, messageId, out, cardEnv);
    name = out.body.by;
  }
  if (rejectNow.length) {
    const out = await decideFromTelegram({ ...who, action: 'reject', lineIds: rejectNow.map((r) => r.id) });
    // A 409 here after approvals went through = those sizes were already settled; fine.
    if (!out.body?.ok && !(approveNow.length && out.code === 409)) return answerOnCard(chatId, messageId, out, cardEnv);
    name = name || out.body?.by;
  }
  // The answer says what the lines SAY NOW, not what the reply asked for: on a funded
  // request the approvals are frozen and a "turn down" can't touch them, and saying it did
  // is how the group ends up believing a size wasn't bought when it was.
  const before = new Map(lines.map((l) => [Number(l.id), l]));
  const after = new Map((await cardLines(card)).map((l) => [Number(l.id), l]));
  const now = (id) => after.get(id) || before.get(id);
  const approved = approve.filter((a) => now(a.id).status === 'approved');
  const turnedDown = reject.filter((r) => now(r.id).status === 'rejected');
  const unchanged = reject.filter((r) => now(r.id).status === 'approved');
  const pairs = approved.reduce((n, a) => n + Number(now(a.id).qty || a.qty), 0);
  // An approval this reply reversed or re-counted — a later reply replaces the whole card,
  // so "10 x 1" sent to ADD a size also turns down the 9 someone approved before it.
  const reversed = [...before.values()].filter((b) => b.status === 'approved'
    && (now(Number(b.id)).status !== 'approved' || Number(now(Number(b.id)).qty) !== Number(b.qty)))
    .map((b) => {
      const n = now(Number(b.id));
      return `${b.size} was ×${b.qty}${b.decided_by ? ` (${b.decided_by})` : ''} → ${n.status === 'approved' ? `×${n.qty}` : 'turned down'}`;
    });
  const over = approved.map((a) => before.get(a.id))
    .filter((b) => b?.available_qty != null && Number(now(Number(b.id)).qty) > Number(b.available_qty))
    .map((b) => `${b.size} ×${now(Number(b.id)).qty} is more than the ${b.available_qty} counted in store`);
  const outcome = [
    approved.length
      ? `${name} approved ${approved.map((a) => `${a.size} ×${now(a.id).qty || a.qty}`).join(', ')} (${pairs} pair${pairs === 1 ? '' : 's'})`
      : unchanged.length ? `${name} turned down ${turnedDown.map((r) => r.size).join(', ') || 'nothing new'}`
        : `${name} turned them all down`,
    ...(approved.length && turnedDown.length ? [`Turned down: ${turnedDown.map((r) => r.size).join(', ')}`] : []),
    ...(unchanged.length ? [`Already funded, so still approved: ${unchanged.map((r) => r.size).join(', ')}`] : []),
    ...(reversed.length ? [`↩️ Replaced the earlier decision: ${reversed.join('; ')}`] : []),
    ...(over.length ? [`⚠️ ${over.join('; ')}.`] : []),
    // How a plain-words reply ("take all", "2 each") was read, so nobody has to guess.
    ...(note ? [note] : []),
  ].join('\n');
  return answerOnCard(chatId, messageId, { code: 200, body: { ok: true, outcome, reaction: approved.length ? '👍' : '👎' } }, cardEnv);
}

// A person's own chat with the bot — where their alerts arrive. Only `/start` means
// anything here: with a token it is the second half of "Connect Telegram" in the app
// (the deep link sends it for them); without one it is somebody asking what this chat is.
// Pressing it again just repeats the answer, like the Hub's bot did.
async function handlePrivate(update, msg) {
  const m = /^\/start(?:@\w+)?(?:\s+([A-Za-z0-9_-]{1,64}))?\s*$/.exec(String(msg.text || '').trim());
  if (!m) return handleCancellation(msg);
  const from = msg.from || {};
  const token = m[1] || null;
  if (token) {
    // The first character is the server that minted it; a dev token goes to dev.
    const tokenEnv = token[0] === 'd' ? 'dev' : 'prod';
    if (tokenEnv !== notifyEnv()) return forwardToOtherEnv(update, tokenEnv);
  }
  const tag = notifyEnv() === 'dev' ? '[dev] ' : '';
  const say = (text) => enqueue(() => tg('sendMessage', { chat_id: msg.chat.id, text: `${tag}${text}` }));
  if (!token) {
    const who = await userNameByTelegramId(from.id);
    return say(who
      ? `✅ You're connected to Stickballman12 Inventory as ${who.name}.\nChoose which alerts you get in the app: 🔔 Alerts.`
      : 'To get your alerts here, open Stickballman12 Inventory, tap 🔔 Alerts, then Connect Telegram.');
  }
  const fullName = [from.first_name, from.last_name].filter(Boolean).join(' ').trim() || null;
  const out = await redeemTelegramLinkToken({
    token, telegramUserId: from.id, telegramName: fullName, telegramUsername: from.username || null,
  });
  if (out.ok) {
    console.log(`[telegram/webhook] Telegram ${from.id} (@${from.username || '-'}) connected to ${out.user.username}`);
    return say(`✅ Connected to Stickballman12 Inventory as ${out.user.name}.\nYou'll get your alerts here. Choose which ones in the app: 🔔 Alerts.`);
  }
  if (out.why === 'taken') return say(`This Telegram account is already connected to ${out.other.name}. Disconnect it there first, or ask an admin.`);
  if (out.why === 'account') return say('That account is not active any more.');
  return say('That connect link has expired or was already used. In the app, open 🔔 Alerts and tap Connect Telegram again.');
}

// A picture (or a typed number) of an order to cancel, in someone's own chat with the bot.
// Only a connected, approved warehouse / PH / admin account may file one — the chat id is
// who they are. The platform comes from a command, the owner's way (2026-10-20):
//   /alias + the photo (the command as the caption)        → that photo, and the album it opens
//   /alias, then photos                                    → every photo for the next 90 s (each restarts it)
//   photos with no platform                                → held; the bot asks once, with buttons
//   /stockx 12345678-12345678 - wrong size                 → a typed number
// The read takes several seconds, so it runs AFTER the webhook has answered Telegram. The
// photo ROW is written first, before the answer (keyed on the message — a re-sent update
// finds it and is ignored, never recorded twice; and it carries the file id, so a restart
// mid-read can still fetch the picture). The bot answers once per batch: every photo one
// person sends close together, as a reply to the first (cancelBatchStart / cancelBatchDone).
const CAN_FILE = ['warehouse', 'ph_team', 'admin', 'superadmin'];
// "/stockx, then the photos": how long the platform (and its note) stays on for that person
// in that chat. Every photo that uses it restarts the clock, so a long run of photos never
// falls out of it — and a platform named a few minutes ago is never applied to something new.
const SESSION_SEC = 90;
// An album's photos arrive as separate updates and only ONE carries the caption: the others
// wait this long for it before deciding they have no platform.
const ALBUM_WAIT_MS = 1500;
// "Void Batch" is for the slip you notice at once (the wrong platform tapped). Later than
// this, a row is removed on the page, where the reason is typed.
const VOID_MIN = 60;
//
// THREE WAYS IN, all forgiving (2026-11-20):
//   A  /alias as the caption — of one photo, or of one photo of an album (the whole album
//      takes the platform and the note)
//   B  /alias first, then the photos — on for SESSION_SEC, restarted by each photo
//   C  photos with nothing at all — READ first: our Shopify orders, the number's shape or the
//      slip's own words usually say the platform (2026-11-21). Only what that can't place is
//      HELD, and the bot asks once with buttons; a tap (or the command, sent after) files
//      them and the question becomes the summary
// Text after the command is the note on every row it covers ("/ebay wrong size shipped").
//
// In the CANCELLATIONS GROUP (TELEGRAM_CANCEL_CHAT_ID) people also talk, so only a photo or
// a slash command is acted on — a bare number typed there (a phone, a price) is chat, not
// an order to cancel. "/alias, then photos" is remembered per PERSON in a chat, so two
// people sending for different platforms at once don't take each other's.
async function handleCancellation(msg, opts = {}) {
  // Never silent: a photo that fails before its read even starts (live 2026-10-20 — prod
  // hadn't run db:setup, so noting "/alias" threw and the sender heard nothing) still gets
  // an answer, so they know to send it again.
  try {
    return await fileFromChat(msg, opts);
  } catch (e) {
    console.error('[telegram/webhook] cancellation:', e.message);
    const tag = notifyEnv() === 'dev' ? '[dev] ' : '';
    return sayTo(msg.chat.id, `${tag}⚠️ That wasn't logged — something went wrong on our side (${e.message.slice(0, 120)}). Please send it again in a few minutes, or tell the team.`, msg.message_id).catch(() => null);
  }
}
async function fileFromChat(msg, { group = false } = {}) {
  const chatId = msg.chat.id;
  // A compressed photo, or an image sent "as a file" (uncompressed — small print reads better).
  const file = extractImageFile(msg);
  const image = file?.fileId || null;
  const words = splitCommand(image ? msg.caption : msg.text);
  if (!image && !words.cmd && !words.rest) return null;
  // A text that REPLIES to a message may be the order number for a photo the bot sent back
  // ("Reply to this message with the order number") — in the group too, where other typed
  // text is chatter.
  const replyTo = !image && msg.reply_to_message?.message_id ? msg.reply_to_message.message_id : null;
  if (group && !image && !words.cmd && !replyTo) return null;
  // …but only a reply to one of THOSE copies: people reply to each other and to the bot's
  // summaries all day, and none of that may be answered (or told to "connect this chat").
  if (group && replyTo && !words.cmd && !(await cancellationPhotoByAskMessage(chatId, replyTo))) return null;
  const tag = notifyEnv() === 'dev' ? '[dev] ' : '';
  const say = (text, reply = true) => sayTo(chatId, `${tag}${text}`, reply ? msg.message_id : null);
  const who = await telegramSender(msg.from?.id);
  if (!who) return say('To send orders to cancel, connect this chat first: open Stickballman12 Inventory, tap 🔔 Alerts, then Connect Telegram.', false);
  if (!CAN_FILE.includes(who.role)) return say("Your account can't log cancellations.", false);
  if (replyTo) {
    const answer = await fileMissedReply({ chatId, replyTo, text: msg.text, who: { id: who.id, name: who.name }, tgMessageId: msg.message_id });
    if (answer) return say(answer);
  }
  if (words.cmd === '/help') return say(HOW_TO, false);
  // End of shift — the day's messages and report (EST). "/msg-all" can't be a Telegram
  // command (no dashes), so it arrives as /msg + "-all"; /msgall is the menu's spelling.
  const all = words.cmd === '/msgall' || (words.cmd === '/msg' && /^-?all\b/i.test(words.rest));
  if (words.cmd === '/msg' || words.cmd === '/msgall' || words.cmd === '/report') {
    const day = dayFrom(words.rest);
    if (!day) return say('Which day? Leave it blank for today, or say yesterday, or a date like 2026-10-19 (EST).');
    if (all) return say(await msgAll(day), false);
    if (words.cmd === '/msg') {
      const pick = await msgPicker(day);
      return enqueue(() => tg('sendMessage', { chat_id: chatId, text: `${tag}${pick.text}`,
        reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true },
        ...(pick.keyboard ? { reply_markup: { inline_keyboard: pick.keyboard } } : {}) }));
    }
    const sentFile = await sendDayReport(chatId, day);
    return sentFile ? null : say(`Nothing logged ${day === dayFrom('') ? 'today' : `on ${day}`} (EST).`);
  }
  // A command that isn't a platform: say so and file nothing — a resend with the right
  // command is one tap, a row on the wrong platform is a wrong cancellation.
  if (words.cmd && !words.platform) return say(`"${words.cmd}" isn't one of the platforms.\n\n${HOW_TO}`);
  const ctx = { who: { id: who.id, name: who.name }, tgChatId: chatId, tgMessageId: msg.message_id };
  const mine = `chat:${chatId}:${msg.from?.id}`;
  const album = msg.media_group_id ? `album:${msg.media_group_id}` : null;
  const batch = `${chatId}:${msg.from?.id}`;
  const label = platformLabel(words.platform);
  // Photos this person sent BEFORE naming the platform are waiting for it: a command — typed
  // alone, or as the caption of a later photo — files them too, in the same batch.
  const releaseWaiting = async (note) => {
    const waiting = await releaseHeldCancellationPhotosOf(chatId, who.id, words.platform, note);
    readReleasedPhotos(waiting, words.platform, batch);
    return waiting.length;
  };

  if (!image) {
    if (words.platform) {
      // "/alias 206557037 DD1391-100 9.5" is an order typed in; "/ebay wrong size shipped" is
      // a note for the photos that follow. A number (6+ digits) is what tells them apart.
      const typed = words.rest ? await fileTypedCancellation(words.rest, { ...ctx, platform: words.platform }) : null;
      if (typed) {
        await setCancellationCtx(mine, words.platform, null);
        if (typed.rows.length) alertCancellationsLogged(typed.rows, who);
        return say(typedReplyText(typed));
      }
      const note = words.rest ? words.rest.slice(0, 300) : null;
      await setCancellationCtx(mine, words.platform, note);
      const n = await releaseWaiting(note);
      const noted = note ? `\nNote on each: "${note}"` : '';
      if (n) return say(`📸 ${label} — reading the ${n === 1 ? 'photo' : `${n} photos`} you already sent.${noted}\n${label} stays on for ${SESSION_SEC} s for more.`);
      return say(`📸 ${label} mode on for ${SESSION_SEC} s — send your photos. Each photo restarts the ${SESSION_SEC} s.${noted}`);
    }
    // No command: a bare order number in a private chat, on the platform that is on (if any).
    const on = await useCancellationCtx(mine, SESSION_SEC);
    const out = await fileTypedCancellation(words.rest, { ...ctx, platform: on?.platform || null });
    if (!out) return say(HOW_TO, false);
    if (out.rows.length) alertCancellationsLogged(out.rows, who);
    return say(typedReplyText(out));
  }

  // ── A picture ──
  const captionNote = words.rest ? words.rest.slice(0, 300) : null;
  if (words.platform) {
    // The caption names it: for this photo, for the rest of its album, and for what follows.
    await setCancellationCtx(mine, words.platform, captionNote);
    if (album) await setCancellationCtx(album, words.platform, captionNote);
  }
  // The platform that is ON for this person (B). An album waits for its own caption first.
  const on = (words.platform || album) ? null : await useCancellationCtx(mine, SESSION_SEC);
  const known = words.platform || on?.platform || null;
  const note = captionNote || on?.note || null;
  // The photo row FIRST, before Telegram gets its 200: a re-sent update stops here.
  const photoId = await createCancellationPhoto({ caption: note, tgChatId: chatId, tgMessageId: msg.message_id,
    tgFileId: image, mediaGroupId: msg.media_group_id || null, platform: known, sentByUserId: who.id, sentBy: who.name,
    asFile: file.uncompressed });
  if (photoId == null) return null;
  if (words.platform) await releaseWaiting(captionNote);

  if (known) {
    cancelBatchStart(batch, chatId, photoId);
    setImmediate(async () => {
      try {
        await readTelegramPhoto({ id: photoId, fileId: image, chatId, messageId: msg.message_id, caption: note, platform: known, who: ctx.who });
      } finally {
        cancelBatchDone(batch);
      }
    });
    return null;
  }

  // Nobody has named a platform for this photo (C). Its row is written. An album photo first
  // gives the photo that carries the caption a moment to arrive (then takes the album's
  // platform and note, or what is on for this person). Otherwise the photo is READ: the number
  // may be one of our Shopify orders, or its shape or the slip's own words may say whose it
  // is — and only when none of that names a platform is it held and asked about.
  cancelBatchStart(batch, chatId, photoId);
  cancelReading(chatId, who.id, +1);
  setImmediate(async () => {
    let filed = false;
    try {
      let named = null;
      if (album) {
        await new Promise((r) => setTimeout(r, ALBUM_WAIT_MS));
        named = await useCancellationCtx(album, SESSION_SEC) || await useCancellationCtx(mine, SESSION_SEC);
      }
      if (named) {
        await setCancellationPhotoPlatform(photoId, named.platform, named.note).catch(() => {});
        filed = true;                            // from here it is this batch's, whatever the read gives
        await readTelegramPhoto({ id: photoId, fileId: image, chatId, messageId: msg.message_id, caption: named.note || null,
          platform: named.platform, who: ctx.who });
      } else {
        const out = await readTelegramPhoto({ id: photoId, fileId: image, chatId, messageId: msg.message_id, caption: note, platform: null, who: ctx.who },
          { requirePlatform: true });
        if (!out?.needsPlatform) filed = true;
        else if (await holdCancellationPhoto(photoId)) askPlatformSoon(chatId, who.id);   // it waits for a tap now
      }
    } catch (e) {
      // Left 'pending' with no platform: the restart sweep reads it, so it is never lost.
      console.error('[telegram/webhook] photo with no platform:', e.message);
    } finally {
      cancelReading(chatId, who.id, -1);
      // Not filed here = not answered here: out of the batch, so the batch's reply doesn't
      // mark it answered and hide it from the tap (or the sweep) that will file it.
      if (filed) cancelBatchDone(batch); else cancelBatchDrop(batch, photoId);
    }
  });
  return null;
}

// ── Buttons on the cancellation messages ─────────────────────────────────────────────
//   cxpick:<platform>  on "Which platform?"  → those photos are filed on that platform
//   cxvoid             on a batch summary    → every row that batch recorded is removed
// The MESSAGE that was tapped says which photos (prompt_message_id / reply_message_id), so
// a button carries nothing that could go stale or be forged. Every state change is
// compare-and-set in the database: two people tapping, a double tap, a tap racing the
// time-out — exactly one of them does it, and the other is told what happened.
async function handleCancelTap(cq) {
  const answer = (text, alert = false) => tg('answerCallbackQuery', { callback_query_id: cq.id, ...(text ? { text: text.slice(0, 190) } : {}), show_alert: alert })
    .catch(() => {});
  try {
    const chatId = cq.message?.chat?.id;
    const messageId = cq.message?.message_id;
    const isCancelChat = cq.message?.chat?.type === 'private' || (cancelChatId() && String(chatId) === cancelChatId());
    // A message too old for Telegram to hand back has no chat on it.
    if (!chatId || !messageId || !isCancelChat) return await answer("These buttons don't work here any more. Use the Cancellations page.", true);
    const who = await telegramSender(cq.from?.id);
    if (!who || !CAN_FILE.includes(who.role)) return await answer('Connect this Telegram first: in the app, 🔔 Alerts → Connect Telegram.', true);
    // The same rule as Remove on the page: whoever sent the photos, PH, or an admin.
    const mayAct = (ownerId) => who.role !== 'warehouse' || Number(ownerId) === Number(who.id);
    const tag = notifyEnv() === 'dev' ? '[dev] ' : '';
    const data = String(cq.data || '');

    if (data.startsWith('cxpick:')) {
      const platform = data.slice(7);
      if (!PLATFORM_KEYS.has(platform)) return await answer('That button is not a platform.', true);
      const held = await heldCancellationPhotosByPrompt(chatId, messageId);
      if (!held.length) {
        // Already filed (a tap, a command, or the time-out got there first). If this message
        // never became a summary, its buttons are dead weight: take them off.
        const done = await cancellationBatchByReply(chatId, messageId);
        if (!done.length) tg('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }).catch(() => {});
        return await answer('These photos were already logged — nothing left to pick. Send them again if the platform was wrong.', true);
      }
      if (!mayAct(held[0].sent_by_user_id)) return await answer(`Only ${held[0].sent_by || 'whoever sent these'}, PH or an admin can pick the platform for these photos.`, true);
      const released = await releaseHeldCancellationPhotosByPrompt(chatId, messageId, platform);
      if (!released.length) return await answer('Someone picked just before you — they are being logged.', true);
      const n = released.length;
      await answer(`${platformLabel(platform)} — reading ${n === 1 ? 'the photo' : `${n} photos`}…`);
      // The buttons go at once (no second pick); the summary replaces this text when the reads are done.
      enqueue(() => tg('editMessageText', { chat_id: chatId, message_id: messageId,
        text: `${tag}${platformLabel(platform)} — reading ${n === 1 ? '1 photo' : `${n} photos`}…`, reply_markup: { inline_keyboard: [] } })).catch(() => {});
      readReleasedPhotos(released, platform, `${chatId}:pick:${messageId}`);
      return null;
    }

    if (data === 'cxvoid') {
      const photos = await cancellationBatchByReply(chatId, messageId);
      const off = () => tg('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }).catch(() => {});
      if (!photos.length) { off(); return await answer("This batch isn't on record here any more. Remove the rows on the Cancellations page.", true); }
      if (photos.every((p) => p.voided_at)) { off(); return await answer('This batch was already voided.', true); }
      if (!mayAct(photos[0].sent_by_user_id)) return await answer(`Only ${photos[0].sent_by || 'whoever sent these'}, PH or an admin can void this batch.`, true);
      const at = Math.max(...photos.map((p) => new Date(p.replied_at || 0).getTime()));
      if (Date.now() - at > VOID_MIN * 60_000) {
        off();
        return await answer(`This batch is more than ${VOID_MIN} minutes old. Remove its rows on the Cancellations page instead (it asks for the reason).`, true);
      }
      const removed = await voidCancellationBatch(photos.map((p) => p.id), { actor: who.name, reason: 'Batch voided on Telegram (wrong platform, or sent by mistake)' });
      // 0 rows: someone removed them on the page already, or another tap voided first.
      const n = removed.length;
      await answer(n ? `Voided — ${n} ${n === 1 ? 'row' : 'rows'} removed.` : 'Nothing was left to void.');
      const was = String(cq.message.text || '').replace(/^\[dev\] /, '');
      const head = `🚫 VOIDED by ${who.name} — ${n} ${n === 1 ? 'row' : 'rows'} removed from the record. Send the photos again with the right platform.`;
      enqueue(() => tg('editMessageText', { chat_id: chatId, message_id: messageId, link_preview_options: { is_disabled: true },
        text: `${tag}${head}${was ? `\n\nWhat it said:\n${was}` : ''}`.slice(0, 4090), reply_markup: { inline_keyboard: [] } })).catch(() => off());
      return null;
    }
    return await answer();
  } catch (e) {
    console.error('[telegram/webhook] cancel button:', e.message);
    return answer(`That didn't go through (${e.message.slice(0, 100)}). Try again, or use the Cancellations page.`, true);
  }
}

// A platform tapped on the /msg picker → that platform's message, under the picker. Only
// where the picker can be (the cancellations group or someone's own chat), and only for an
// account that may file cancellations.
async function handleCancelMsgTap(cq) {
  const chatId = cq.message?.chat?.id;
  const isCancelChat = cq.message?.chat?.type === 'private' || (cancelChatId() && String(chatId) === cancelChatId());
  if (!chatId || !isCancelChat) return null;
  const who = await telegramSender(cq.from?.id);
  const tag = notifyEnv() === 'dev' ? '[dev] ' : '';
  const reply = (text) => sayTo(chatId, `${tag}${text}`, cq.message.message_id);
  if (!who || !CAN_FILE.includes(who.role)) return reply('Connect this Telegram first (🔔 Alerts → Connect Telegram) to use these buttons.');
  const [, platform, day] = String(cq.data).split(':');
  if (!PLATFORM_KEYS.has(platform) || !/^\d{4}-\d{2}-\d{2}$/.test(day || '')) return null;
  try {
    return await reply(await msgFor(platform, day));
  } catch (e) {
    console.error('[telegram/webhook] cancel msg:', e.message);
    return reply(`⚠️ Couldn't build that message (${e.message.slice(0, 120)}).`);
  }
}

// What the group sees, worded by the decision itself (`outcome`, `reaction`) — the same
// two things the Make scenario posted: a reply under the card, and 👍 / 👎 on it. A refusal
// is said out loud with its reason; silence reads as "the button is broken".
async function answerOnCard(chatId, messageId, out, cardEnv) {
  const tag = cardEnv === 'dev' ? ' · [dev]' : '';
  const reply = (text) => enqueue(() => tg('sendMessage', {
    chat_id: chatId, text, reply_parameters: { message_id: messageId, allow_sending_without_reply: true },
  }));
  // No "· HTTP 409" in the group — a status code means nothing to the person who replied.
  // It stays in the server log.
  if (!out.body?.ok) {
    console.log(`[telegram] card reply refused (HTTP ${out.code}): ${out.body?.error || 'not recorded'}`);
    return reply(`⚠️ ${out.body?.error || 'Not recorded'}${tag}`);
  }
  await reply(`${out.body.outcome}${tag}`);
  const emoji = out.body.reaction || '👍';
  try {
    await enqueue(() => tg('setMessageReaction', {
      chat_id: chatId, message_id: messageId, reaction: [{ type: 'emoji', emoji }],
    }));
  } catch (e) {
    await reply(`⚠️ Decision recorded, but Telegram refused the ${emoji} reaction on this card (${e.message}). Check Group Settings → Reactions.`);
  }
  return null;
}

// Hand another server's card update on, untouched.
//   · prod → dev: TELEGRAM_DEV_FORWARD_URL (an origin; the dev tunnel). The normal case.
//   · dev → prod: TELEGRAM_PROD_FORWARD_URL (a FULL url). Only while the bot is pointed
//     at a dev server for testing — so a real card tapped meanwhile still reaches
//     something that records it (production's webhook, or Make's hook before the switch)
//     instead of being dropped by a dev database that has never heard of it.
// With neither set, the update is dropped with a log line — never recorded in the wrong DB.
async function forwardToOtherEnv(update, cardEnv) {
  const here = notifyEnv();
  const target = here === 'prod' && cardEnv === 'dev'
    ? (env('TELEGRAM_DEV_FORWARD_URL').replace(/\/+$/, '') ? `${env('TELEGRAM_DEV_FORWARD_URL').replace(/\/+$/, '')}/api/telegram/webhook` : '')
    : here === 'dev' && cardEnv === 'prod' ? env('TELEGRAM_PROD_FORWARD_URL') : '';
  if (!target) {
    console.log(`[telegram/webhook] a ${cardEnv} card's update reached the ${here} server and was dropped`
      + ` (${here === 'prod' ? 'TELEGRAM_DEV_FORWARD_URL' : 'TELEGRAM_PROD_FORWARD_URL'} is not set)`);
    return null;
  }
  try {
    const r = await fetch(target, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': env('TELEGRAM_WEBHOOK_SECRET'),
        'ngrok-skip-browser-warning': '1',
      },
      body: JSON.stringify(update),
      signal: AbortSignal.timeout(20_000),
    });
    console.log(`[telegram/webhook] ${cardEnv} card update forwarded → ${r.status}`);
  } catch (e) {
    console.error(`[telegram/webhook] could not forward a ${cardEnv} card's update: ${e.message}`);
  }
  return null;
}
