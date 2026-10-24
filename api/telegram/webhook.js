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
//     PH / admin account → an order to cancel: read, filed on the Cancellations page, and
//     answered in the chat; a typed order number does the same (api/_lib/cancellations.js)
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
import { dbConfigured, askTelegramQty, takeTelegramQty, getTelegramGroupCard, claimTelegramGroupReply, getBuyCartLine, redeemTelegramLinkToken, userNameByTelegramId, telegramSender, setCancellationCtx, getCancellationCtx } from '../_lib/db.js';
import { telegramConfigured, telegramChatId, cancelChatId, tg, enqueue } from '../_lib/telegram.js';
import { decideFromTelegram } from '../_lib/telegramDecide.js';
import { notifyEnv } from '../_lib/notify.js';
import { alertCancellationsLogged } from '../_lib/alerts.js';
import { downloadTelegramFile, fileCancellationPhoto, fileTypedCancellation, replyText, sayTo, HOW_TO, dayFrom, msgPicker, msgFor, msgAll, sendDayReport } from '../_lib/cancellations.js';
import { platformFromCommand, platformLabel, PLATFORMS } from '../../src/lib/cancellations.js';
import { parseApprovalReply } from '../../src/lib/buyPaste.js';
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

// Only the approval group. The identity check would refuse a stranger anyway; this keeps
// the bot from answering in chats it was added to by mistake.
const inOurChat = (chatId) => String(chatId) === telegramChatId();

async function handleTap(update, cq) {
  // Stop the spinner on the tapper's button first, whatever happens next. Best-effort.
  tg('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});
  if (String(cq.data || '').startsWith('cxmsg:')) return handleCancelMsgTap(cq);
  const chatId = cq.message?.chat?.id;
  // The CARD this tap is about. A tap on the card itself is the card; a tap on the
  // quantity picker "More…" posts is on a message that replies to the card — the answer
  // and the 👍 belong on the card, not on the picker.
  const tappedId = cq.message?.message_id;
  const messageId = cq.message?.reply_to_message?.message_id || tappedId;
  if (!inOurChat(chatId) || !messageId) {
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
    return answerOnCard(chatId, messageId, out, cardEnv);
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
  if (grpData && inOurChat(msg.chat?.id) && msg.text) {
    const cardEnv = grpData.endsWith(':dev') ? 'dev' : 'prod';
    if (cardEnv !== notifyEnv()) return forwardToOtherEnv(update, cardEnv);
    return handleGroupReply(msg, card0, cardEnv);
  }
  // Same card, should a client ever deliver the reply without the card's buttons: a card
  // in THIS server's table is ours by definition.
  if (card0 && inOurChat(msg.chat?.id) && msg.text
      && await getTelegramGroupCard({ chatId: msg.chat.id, messageId: card0.message_id }).catch(() => null)) {
    return handleGroupReply(msg, card0, notifyEnv());
  }
  if (!/^\s*\d{1,3}\s*$/.test(String(msg.text || ''))) return null;
  if (!inOurChat(msg.chat?.id)) return null;
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
  return answerOnCard(msg.chat.id, Number(pending.card_message_id), out, pending.env);
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
    const read = parseApprovalReply(msg.text, lines);
    if (!read.ok) return say(`⚠️ ${read.error}`);
    // Telegram redelivers an update it didn't get a 200 for; the second copy is a no-op.
    if (!(await claimTelegramGroupReply(card.id, msg.message_id))) return null;
    return decideGroup({
      from: msg.from || {}, card, chatId, messageId: cardMsg.message_id, cardEnv, lines,
      approve: read.approve.map((a) => ({ id: Number(a.line.id), size: a.line.size, qty: a.qty })),
      reject: read.reject.map((l) => ({ id: Number(l.id), size: l.size })),
    });
  });
}

const cardLines = async (card) =>
  (await Promise.all(card.line_ids.map((id) => getBuyCartLine(card.cart_id, id)))).filter(Boolean);

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
async function decideGroup({ from, card, chatId, messageId, cardEnv, lines, approve, reject }) {
  const who = { telegramUserId: from.id, telegramName: from.first_name, telegramUsername: from.username, cartId: card.cart_id };
  let name = null;
  if (approve.length) {
    const out = await decideFromTelegram({
      ...who, action: 'approve',
      lineIds: approve.map((a) => a.id),
      qty: Object.fromEntries(approve.map((a) => [a.id, a.qty])),
    });
    // Nothing turned down either when the approval was refused — half a decision is worse.
    if (!out.body?.ok) return answerOnCard(chatId, messageId, out, cardEnv);
    name = out.body.by;
  }
  if (reject.length) {
    const out = await decideFromTelegram({ ...who, action: 'reject', lineIds: reject.map((r) => r.id) });
    // A 409 here after approvals went through = those sizes were already settled; fine.
    if (!out.body?.ok && !(approve.length && out.code === 409)) return answerOnCard(chatId, messageId, out, cardEnv);
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
//   /alias, then photos                                    → every photo for the next 10 minutes
//   /stockx 12345678-12345678 - wrong size                 → a typed number
// The read takes several seconds, so it runs AFTER the webhook has answered Telegram (an
// update not answered in time is sent again; the photo row is keyed on the message, so a
// re-send is ignored rather than filed twice).
const CAN_FILE = ['warehouse', 'ph_team', 'admin', 'superadmin'];
const CTX_MIN = 10;
// "/alias wrong size" → { cmd:'/alias', platform:'alias', rest:'wrong size' }; no command → cmd null.
function splitCommand(text) {
  const m = /^\s*(\/[A-Za-z]+(?:@\w+)?)\s*([\s\S]*)$/.exec(String(text || ''));
  if (!m) return { cmd: null, platform: null, rest: String(text || '').trim() };
  return { cmd: m[1].replace(/@\w+$/, '').toLowerCase(), platform: platformFromCommand(m[1]), rest: m[2].trim() };
}
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
  const image = msg.photo?.length ? msg.photo[msg.photo.length - 1].file_id
    : /^image\//.test(String(msg.document?.mime_type || '')) ? msg.document.file_id : null;
  const words = splitCommand(image ? msg.caption : msg.text);
  if (!image && !words.cmd && !words.rest) return null;
  if (group && !image && !words.cmd) return null;
  const tag = notifyEnv() === 'dev' ? '[dev] ' : '';
  const say = (text, reply = true) => sayTo(chatId, `${tag}${text}`, reply ? msg.message_id : null);
  const who = await telegramSender(msg.from?.id);
  if (!who) return say('To send orders to cancel, connect this chat first: open Stickballman12 Inventory, tap 🔔 Alerts, then Connect Telegram.', false);
  if (!CAN_FILE.includes(who.role)) return say("Your account can't log cancellations.", false);
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
  if (words.platform) {
    await setCancellationCtx(mine, words.platform);
    if (album) await setCancellationCtx(album, words.platform);
  }

  if (!image) {
    if (!words.rest && words.platform) {
      return say(`📸 ${platformLabel(words.platform)} — send the photo(s) now. Every photo in the next ${CTX_MIN} minutes is logged as ${platformLabel(words.platform)}.`);
    }
    const platform = words.platform || await getCancellationCtx(mine, CTX_MIN);
    const out = await fileTypedCancellation(words.rest, { ...ctx, platform });
    if (!out) return say(HOW_TO, false);
    if (out.filed.length) alertCancellationsLogged(out.filed, who);
    return say(replyText(out));
  }
  setImmediate(async () => {
    try {
      // An album's photos arrive together and only ONE carries the caption: give that one
      // a moment to be noted before reading the others.
      if (album && !words.platform) await new Promise((r) => setTimeout(r, 1500));
      const resolvePlatform = async () => (album && await getCancellationCtx(album, CTX_MIN))
        || getCancellationCtx(mine, CTX_MIN);
      const platform = words.platform || await resolvePlatform();
      const buf = await downloadTelegramFile(image);
      const out = await fileCancellationPhoto(buf, { ...ctx, caption: words.rest || null, platform, resolvePlatform });
      if (out.filed?.length) alertCancellationsLogged(out.filed, who);
      let text = replyText(out);
      if (text && out.filed?.some((r) => !r.platform)) text += `\n\nTip: start with the platform — e.g. /alias and the photo.`;
      if (text) await say(text);
    } catch (e) {
      console.error('[telegram/webhook] cancellation photo:', e.message);
      await say(`⚠️ Something went wrong saving that picture (${e.message}). Please send it again, or type the order number.`).catch(() => {});
    }
  });
  return null;
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
  if (!out.body?.ok) return reply(`⚠️ ${out.body?.error || 'Not recorded'} · HTTP ${out.code}${tag}`);
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
