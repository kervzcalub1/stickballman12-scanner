// Talking to Telegram DIRECTLY — the Bot API, from this server.
//
// This used to go through two Make.com scenarios: one built the approval card from our
// webhook payload, the other took the button taps and posted them back to
// `/api/cart/telegram-decide`. Everything those scenarios did is here now, with the same
// wording, the same buttons and the same callback shapes, so a card sent by Make before
// the switch still answers when it is tapped after it:
//   · the card — photo + our caption + Buy 1 / 2 / 3 / More… / Turn it down
//   · the tap — approve / reject recorded under the person who tapped, the outcome
//     replied under the card, 👍 / 👎 stamped on it
//   · "More…" — asks "How many pairs?" as a force-reply; a number typed back by the same
//     person, in the same chat, within 10 minutes approves that many
//
// What going direct removes: the photo no longer needs a PUBLIC url (we upload the bytes
// we already hold, so APP_BASE_URL and the tunnel stop mattering for the picture), and the
// decide callback URL no longer lives inside somebody else's scenario.
//
// Config (all server-side, never in the source):
//   TELEGRAM_BOT_TOKEN       the bot's token from @BotFather — a credential
//   TELEGRAM_CHAT_ID         the approval group (e.g. -5397913241)
//   TELEGRAM_WEBHOOK_SECRET  checked on every inbound update (X-Telegram-Bot-Api-Secret-Token)
//   TELEGRAM_DEV_FORWARD_URL prod only: where taps on DEV cards are passed on to (the dev
//                            tunnel). Dev and prod share one bot, and a bot has one webhook.
//   TELEGRAM_API_BASE        tests only: a fake Bot API
import { getBuyCartFileById } from './db.js';
import { getObject } from './r2.js';
import { imageForCard } from './imgformat.js';

const env = (k) => String(process.env[k] || '').trim();
export const telegramConfigured = () => !!(env('TELEGRAM_BOT_TOKEN') && env('TELEGRAM_CHAT_ID'));
export const telegramChatId = () => env('TELEGRAM_CHAT_ID');
// Pre-sell Listings sales go to their OWN group (docs/context/presell-listings.md).
export const presellChatId = () => env('TELEGRAM_PRESELL_CHAT_ID');
const apiUrl = (method) => `${env('TELEGRAM_API_BASE') || 'https://api.telegram.org'}/bot${env('TELEGRAM_BOT_TOKEN')}/${method}`;

// One Bot API call. Returns Telegram's `result`, or throws an Error carrying Telegram's
// own description (and `retryAfter` on a 429) — "Bad Request: message is not modified" is
// worth more in a log line than "HTTP 400".
export async function tg(method, params = {}, { form = null, timeoutMs = 20_000 } = {}) {
  const res = await fetch(apiUrl(method), form
    ? { method: 'POST', body: form, signal: AbortSignal.timeout(timeoutMs) }
    : {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs),
    });
  let data = null;
  try { data = await res.json(); } catch { /* described below */ }
  if (!data || data.ok !== true) {
    const err = new Error(`${method}: ${data?.description || `HTTP ${res.status}`}`);
    err.status = res.status;
    err.retryAfter = Number(data?.parameters?.retry_after) || null;
    throw err;
  }
  return data.result;
}

// ONE SEND AT A TIME, in order. A request is routinely five to ten sizes at once, and
// Telegram rate-limits a bot per group (eleven in a second came back `429 retry after 5`)
// — the Make scenario was set to sequential for exactly this. Queued here, and a 429 waits
// the time Telegram names and tries again rather than losing the card.
let chain = Promise.resolve();
export function enqueue(job) {
  const run = chain.then(async () => {
    for (let attempt = 0; ; attempt += 1) {
      try { return await job(); } catch (e) {
        if (e.status === 429 && attempt < 3) {
          await new Promise((r) => setTimeout(r, ((e.retryAfter || 3) + 0.5) * 1000));
          continue;
        }
        throw e;
      }
    }
  });
  chain = run.catch(() => {});
  return run;
}

// The buttons. Identical to what the Make scenario built — including the trailing env —
// so cards already in the group keep working across the switch.
export function cardKeyboard(cartId, lineId, envName) {
  const tail = `${cartId}:${lineId}`;
  return {
    inline_keyboard: [
      [
        { text: '✓ Buy 1', callback_data: `approve:${tail}:1:${envName}` },
        { text: '✓ Buy 2', callback_data: `approve:${tail}:2:${envName}` },
        { text: '✓ Buy 3', callback_data: `approve:${tail}:3:${envName}` },
        { text: 'More…', callback_data: `more:${tail}:${envName}` },
      ],
      [{ text: '✕ Turn it down', callback_data: `reject:${tail}:${envName}` }],
    ],
  };
}

// Telegram's own photo id per shoe photo, so the second size of a burst sends the picture
// by reference instead of uploading it again (Make kept this in a data store). In memory:
// losing it on a restart costs one re-upload, nothing more.
const photoCache = new Map();
const CAPTION_MAX = 1024; // Telegram's limit on a photo caption

/**
 * Send one approval card. With a photo when we have one; when the photo cannot be read,
 * the card still goes — as text, saying why — because the decision matters more than
 * the picture (the Make scenario did the same).
 */
export async function sendApprovalCard({ caption, keyboard, photoFileId = null }) {
  const chatId = telegramChatId();
  const reply_markup = JSON.stringify(keyboard);
  return enqueue(async () => {
    if (photoFileId && caption.length <= CAPTION_MAX) {
      const cached = photoCache.get(Number(photoFileId));
      if (cached) {
        try {
          return await tg('sendPhoto', { chat_id: chatId, photo: cached, caption, reply_markup: keyboard });
        } catch (e) {
          if (e.status === 429) throw e;
          photoCache.delete(Number(photoFileId)); // a stale id — upload it fresh below
        }
      }
      let why = null;
      try {
        const file = await getBuyCartFileById(Number(photoFileId));
        if (!file || file.kind !== 'shoe') throw new Error('no shoe photo with that id');
        const { bytes, contentType } = await imageForCard(await getObject(file.r2_key));
        const form = new FormData();
        form.set('chat_id', chatId);
        form.set('caption', caption);
        form.set('reply_markup', reply_markup);
        const name = `${String(file.sku || 'shoe').replace(/[^A-Za-z0-9._-]/g, '_')}.jpg`;
        form.set('photo', new Blob([bytes], { type: contentType || 'image/jpeg' }), name);
        const msg = await tg('sendPhoto', {}, { form, timeoutMs: 60_000 });
        const sizes = msg?.photo || [];
        if (sizes.length) photoCache.set(Number(photoFileId), sizes[sizes.length - 1].file_id);
        return msg;
      } catch (e) {
        if (e.status === 429) throw e;
        why = e.message;
      }
      return tg('sendMessage', { chat_id: chatId, text: `⚠️ Photo unavailable (${why})\n\n${caption}`, reply_markup: keyboard });
    }
    return tg('sendMessage', { chat_id: chatId, text: caption, reply_markup: keyboard });
  });
}

// A plain message straight to one person — their Telegram user id is the chat id of
// their private chat with the bot. Telegram refuses (403 "bot can't initiate
// conversation with a user") until that person has opened the bot and pressed Start
// once; no bot setting can lift that, it is Telegram's anti-spam rule.
export function sendDirect(telegramUserId, text) {
  return enqueue(() => tg('sendMessage', { chat_id: Number(telegramUserId), text }));
}

// One alert to one person (api/_lib/alerts.js): HTML-formatted — the caller escapes —
// with an "Open in Inventory" button when there is a link Telegram will accept. Telegram
// refuses a URL button pointing at localhost or plain http (BUTTON_URL_INVALID), which
// would lose the whole message on a dev server, so there the link rides in the text.
export function sendAlertMessage(telegramUserId, { html, url = null }) {
  const button = url && /^https:\/\//i.test(url) && !/^https:\/\/(localhost|127\.)/i.test(url);
  const text = url && !button ? `${html}\n\n${url}` : html;
  return enqueue(() => tg('sendMessage', {
    chat_id: Number(telegramUserId),
    text,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...(button ? { reply_markup: { inline_keyboard: [[{ text: 'Open in Inventory ↗', url }]] } } : {}),
  }));
}

// A file in a private chat (the daily waitlist report), the caption carrying the same HTML an
// alert does. Multipart, because sendDocument takes the file itself — there is no URL to
// hand Telegram that it could fetch. Same queue as every other send.
export function sendAlertDocument(telegramUserId, { html, filename, content, type = 'application/octet-stream' }) {
  return enqueue(() => {
    const form = new FormData();
    form.append('chat_id', String(Number(telegramUserId)));
    form.append('caption', html);
    form.append('parse_mode', 'HTML');
    form.append('document', new Blob([content], { type }), filename);
    return tg('sendDocument', {}, { form });
  });
}

// The bot's @username, for the t.me deep link. Asked of Telegram once (getMe) and kept —
// TELEGRAM_BOT_USERNAME skips the call where it is set.
let botUsername = null;
export async function getBotUsername() {
  if (env('TELEGRAM_BOT_USERNAME')) return env('TELEGRAM_BOT_USERNAME').replace(/^@/, '');
  if (!botUsername) botUsername = (await tg('getMe'))?.username || null;
  return botUsername;
}

// A plain note to the group — request closed / re-opened. No parse mode, like before:
// a stray `*` in a store name prints rather than formats.
export function sendNote(text) {
  return enqueue(() => tg('sendMessage', { chat_id: telegramChatId(), text }));
}

// A Pre-sell sale → the pre-sell group. HTML, so the shoe name can be bold; every value
// that came from outside is escaped. Throws on failure — the caller records why.
const escHtml = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export function sendPresellSale(lines) {
  if (!env('TELEGRAM_BOT_TOKEN') || !presellChatId()) return Promise.reject(new Error('TELEGRAM_PRESELL_CHAT_ID is not set'));
  const text = lines.map((l) => (typeof l === 'string' ? escHtml(l) : `<b>${escHtml(l.b)}</b>`)).join('\n');
  return enqueue(() => tg('sendMessage', { chat_id: presellChatId(), text, parse_mode: 'HTML', disable_web_page_preview: true }));
}
