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
// Order Cancellations get their OWN group too (docs/context/cancellations.md): photos +
// /alias … sent there are filed exactly like in a private chat with the bot.
export const cancelChatId = () => env('TELEGRAM_CANCEL_CHAT_ID');
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
// `tip` = a premium pair's proposed tip per pair: one more row, approve it / decline it
// (docs/context/buy-cart.md "Premium shoes"). A different amount is the request page's.
export function cardKeyboard(cartId, lineId, envName, { tip = null } = {}) {
  const tail = `${cartId}:${lineId}`;
  return {
    inline_keyboard: [
      [
        { text: '✓ Buy 1', callback_data: `approve:${tail}:1:${envName}` },
        { text: '✓ Buy 2', callback_data: `approve:${tail}:2:${envName}` },
        { text: '✓ Buy 3', callback_data: `approve:${tail}:3:${envName}` },
        { text: 'More…', callback_data: `more:${tail}:${envName}` },
      ],
      ...(tip > 0 ? [[
        { text: `💵 Approve $${Number(tip).toFixed(2)} tip`, callback_data: `tipok:${tail}:${envName}` },
        { text: '✕ Decline tip', callback_data: `tipno:${tail}:${envName}` },
      ]] : []),
      [{ text: '✕ Turn it down', callback_data: `reject:${tail}:${envName}` }],
    ],
  };
}

// The one-card-per-shoe card is answered by a REPLY ("9 x 5" lines), so its only button is
// the one thing a reply can't say briefly: none of them. `grp…` also marks the card as a
// group card to the webhook, and carries the env like every other button.
export function groupCardKeyboard(cardId, envName) {
  return { inline_keyboard: [[{ text: '✕ Turn them all down', callback_data: `grpreject:${cardId}:${envName}` }]] };
}

// Telegram's own photo id per shoe photo, so the second size of a burst sends the picture
// by reference instead of uploading it again (Make kept this in a data store). In memory:
// losing it on a restart costs one re-upload, nothing more.
const photoCache = new Map();
const CAPTION_MAX = 1024; // Telegram's limit on a photo caption

// "⚠️ Photo unavailable (fetch failed)" — 2026-11-12, Andrew's premium group. `fetch failed`
// is Node's own TypeError for a connection that broke before any answer came back: not R2
// saying no, not Telegram saying no. It came from ONE of two calls (read the photo from R2,
// upload it to Telegram), the code that said which (`e.cause.code`) was thrown away, and
// nothing tried again, so one dropped connection cost the card its picture for good.
//
// Now: the step and the low-level code are named, and a SHORT-LIVED drop is tried again —
//   · the R2 READ on a drop/reset/timeout (a read twice is harmless);
//   · the Telegram UPLOAD only when the connection never opened (temporary DNS, refused,
//     connect timeout). A drop mid-upload may have landed, and a second copy is a second
//     card with live buttons, so that one still falls back to text — now saying exactly why.
// Only the codes listed, never an unknown one: a TLS refusal or a host that doesn't exist
// will say the same thing three times. And the waits are short, because this runs INSIDE
// the one Telegram queue — every card and every bot reply waits behind it (CI, #401: TLS
// errors retried for 4.5 s a card starved the cancellations bot's replies past 15 s).
const NEVER_SENT = new Set(['EAI_AGAIN', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT', 'ENETUNREACH', 'EHOSTUNREACH']);
const DROPPED = new Set([...NEVER_SENT, 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNABORTED', 'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'timeout']);
const PHOTO_TRIES = 3;
export function netCode(e) {
  const c = e?.cause;
  return c?.code || c?.errno || (c?.name && c.name !== 'Error' ? c.name : null) || (e?.name === 'TimeoutError' ? 'timeout' : null);
}
// A network failure, not an answer: a reply with a status (R2 403, Telegram 400) is never one.
export function isNetDrop(e) {
  if (!e || e.status) return false;
  return (e.name === 'TypeError' && /fetch failed/i.test(e.message)) || e.name === 'TimeoutError' || e.name === 'AbortError';
}
export function mayRetryPhoto(step, e) {
  if (!isNetDrop(e)) return false;
  return (step === 'read' ? DROPPED : NEVER_SENT).has(netCode(e));
}
export function photoWhy(step, e) {
  const where = step === 'read' ? 'reading it from storage' : 'uploading it to Telegram';
  const code = netCode(e);
  return `${e?.message || 'failed'}${code && !String(e?.message).includes(code) ? ` · ${code}` : ''} — ${where}`;
}
async function photoStep(step, fn, { tries = PHOTO_TRIES, waitMs = 400 } = {}) {
  for (let i = 1; ; i += 1) {
    try { return await fn(); } catch (e) {
      e.photoStep = step;
      if (i >= tries || !mayRetryPhoto(step, e)) throw e;
      console.warn(`[telegram] card photo: ${photoWhy(step, e)} — try ${i + 1} of ${tries}`);
      await new Promise((r) => setTimeout(r, waitMs * i));
    }
  }
}

/**
 * Send one approval card. With a photo when we have one; when the photo cannot be read,
 * the card still goes — as text, saying why — because the decision matters more than
 * the picture (the Make scenario did the same).
 */
// Links laid over whole LINES of the text (`{ line, url }`): the SKU line becomes a tap to
// the shoe on StockX. Entities, not HTML, so nothing else in the card needs escaping;
// offsets are UTF-16 like JS strings. Worked out on the text actually sent, so the
// "Photo unavailable" prefix can't shift them.
export function lineLinks(text, links = []) {
  const out = [];
  for (const { line, url } of links) {
    if (!line || !url) continue;
    // Where the line STARTS: first line, a middle line, or the last line.
    let offset = -1;
    if (text === line || text.startsWith(`${line}\n`)) offset = 0;
    else if (text.includes(`\n${line}\n`)) offset = text.indexOf(`\n${line}\n`) + 1;
    else if (text.endsWith(`\n${line}`)) offset = text.length - line.length;
    if (offset < 0) continue;
    out.push({ type: 'text_link', offset, length: line.length, url });
  }
  return out;
}

// A MENTION by Telegram user id (a `text_mention` entity) on each person's name inside the
// given line — so it works for people with no public @username, and pings them. Offsets are
// UTF-16 code units, which is what a JS string index already is.
//   mentions: [{ line, people: [{ name, telegramUserId }] }]
export function lineMentions(text, mentions = []) {
  const out = [];
  for (const { line, people } of mentions) {
    if (!line || !people?.length) continue;
    let at = -1;
    if (text === line || text.startsWith(`${line}\n`)) at = 0;
    else if (text.includes(`\n${line}\n`)) at = text.indexOf(`\n${line}\n`) + 1;
    else if (text.endsWith(`\n${line}`)) at = text.length - line.length;
    if (at < 0) continue;
    let from = 0;
    for (const p of people) {
      const i = line.indexOf(p.name, from);
      if (i < 0 || !p.telegramUserId) continue;
      out.push({ type: 'text_mention', offset: at + i, length: p.name.length, user: { id: Number(p.telegramUserId) } });
      from = i + p.name.length;
    }
  }
  return out;
}

// `chatId` = where the card goes: the main approval group unless a buyer's premium group
// is passed (notify.js routes it).
export async function sendApprovalCard({ caption, keyboard, photoFileId = null, links = [], mentions = [], chatId = telegramChatId() }) {
  const reply_markup = JSON.stringify(keyboard);
  const ents = (text) => {
    const e = [...lineLinks(text, links), ...lineMentions(text, mentions)].sort((a, b) => a.offset - b.offset);
    return e.length ? e : undefined;
  };
  // A card past Telegram's caption limit can't sit on its photo, so the photo goes first on
  // its own and the card follows with the buttons. It used to drop the picture and say nothing.
  const long = caption.length > CAPTION_MAX;
  const cardOnPhoto = long ? {} : { caption, caption_entities: ents(caption), reply_markup: keyboard };
  // Outside the job: a 429 on the card re-runs it, and that must not post the photo twice.
  let pictureSent = false;
  let why = null;
  return enqueue(async () => {
    if (photoFileId && !pictureSent && !why) {
      const cached = photoCache.get(Number(photoFileId));
      if (cached) {
        try {
          const msg = await tg('sendPhoto', { chat_id: chatId, photo: cached, ...cardOnPhoto });
          if (!long) return msg;
          pictureSent = true;
        } catch (e) {
          if (e.status === 429) throw e;
          photoCache.delete(Number(photoFileId)); // a stale id — upload it fresh below
        }
      }
      if (!pictureSent) {
        try {
          const file = await getBuyCartFileById(Number(photoFileId));
          if (!file || file.kind !== 'shoe') throw new Error('no shoe photo with that id');
          const { bytes, contentType } = await imageForCard(await photoStep('read', () => getObject(file.r2_key)));
          const form = new FormData();
          form.set('chat_id', chatId);
          if (!long) {
            form.set('caption', caption);
            if (ents(caption)) form.set('caption_entities', JSON.stringify(ents(caption)));
            form.set('reply_markup', reply_markup);
          }
          const name = `${String(file.sku || 'shoe').replace(/[^A-Za-z0-9._-]/g, '_')}.jpg`;
          form.set('photo', new Blob([bytes], { type: contentType || 'image/jpeg' }), name);
          const msg = await photoStep('upload', () => tg('sendPhoto', {}, { form, timeoutMs: 60_000 }));
          const sizes = msg?.photo || [];
          if (sizes.length) photoCache.set(Number(photoFileId), sizes[sizes.length - 1].file_id);
          if (!long) return msg;
          pictureSent = true;
        } catch (e) {
          if (e.status === 429) throw e;
          why = e.photoStep ? photoWhy(e.photoStep, e) : e.message;
          console.warn(`[telegram] card photo dropped (file ${photoFileId}): ${why}`, e.cause || '');
        }
      }
    }
    const text = why ? `⚠️ Photo unavailable (${why})\n\n${caption}` : caption;
    return tg('sendMessage', { chat_id: chatId, text, entities: ents(text), reply_markup: keyboard });
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
export function sendNote(text, chatId = telegramChatId()) {
  return enqueue(() => tg('sendMessage', { chat_id: chatId, text }));
}

// A Pre-sell sale → the pre-sell group. HTML, so the shoe name can be bold; every value
// that came from outside is escaped. Throws on failure — the caller records why.
const escHtml = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// A line is plain text, or { b, t } = bold then (optional) plain text.
const htmlLines = (lines) => lines.map((l) => (typeof l === 'string' ? escHtml(l) : `<b>${escHtml(l.b)}</b>${l.t ? escHtml(l.t) : ''}`)).join('\n');
export function sendPresellSale(lines) {
  if (!env('TELEGRAM_BOT_TOKEN') || !presellChatId()) return Promise.reject(new Error('TELEGRAM_PRESELL_CHAT_ID is not set'));
  return enqueue(() => tg('sendMessage', { chat_id: presellChatId(), text: htmlLines(lines), parse_mode: 'HTML', disable_web_page_preview: true }));
}
// Pre-sell price moves (market competition + 🔒 lock) → their own group (owner, 2026-10-11).
export const priceAlertChatId = () => env('PRICE_ALERT_CHAT_ID');
export function sendPriceAlert(lines) {
  if (!env('TELEGRAM_BOT_TOKEN') || !priceAlertChatId()) return Promise.reject(new Error('PRICE_ALERT_CHAT_ID is not set'));
  return enqueue(() => tg('sendMessage', { chat_id: priceAlertChatId(), text: htmlLines(lines), parse_mode: 'HTML', disable_web_page_preview: true }));
}
