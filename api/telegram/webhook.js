// POST /api/telegram/webhook   header: X-Telegram-Bot-Api-Secret-Token: <TELEGRAM_WEBHOOK_SECRET>
//
// The bot's updates, straight from Telegram (registered with `npm run telegram:webhook`).
// This is what Make's "Telegram tap → decision recorded" scenario did, done here:
//   · a button tap — approve / reject → recorded under the person who tapped
//     (decideFromTelegram), the outcome replied under the card, 👍 / 👎 on the card;
//     "More…" → a force-reply "How many pairs?"
//   · a number typed back to that question (same person, same chat, 10 minutes) →
//     approved at that quantity
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
import { dbConfigured, askTelegramQty, takeTelegramQty } from '../_lib/db.js';
import { telegramConfigured, telegramChatId, tg, enqueue } from '../_lib/telegram.js';
import { decideFromTelegram } from '../_lib/telegramDecide.js';
import { notifyEnv } from '../_lib/notify.js';

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
