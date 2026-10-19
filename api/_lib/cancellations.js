// Order cancellations: photo in, rows out (docs/context/cancellations.md).
//
// Karon (warehouse) used to type every 10–15-digit order number to cancel at the end of
// the day. Now anyone on the floor sends the bot a picture (a label, a packing slip, a
// screenshot of the order) in their private chat; this reads it, files one row per order
// on the Cancellations page, and answers in the chat with what it read — or what it
// couldn't. PH/admin check each row against the photo before anything is cancelled.
//
// THE MODEL IS A READER, NOT A DECIDER. It says which platform and which number it sees,
// and how sure it is; the rules in src/lib/cancellations.js decide the flags, and a person
// verifies every row. A photo it can't read still files a row WITH the photo, flagged, so a
// reviewer can type the number off the picture — a failed read never loses the request.
import { tg, enqueue, sendAlertDocument } from './telegram.js';
import { r2Configured, presignPutUrl } from './r2.js';
import {
  createCancellationPhoto, setCancellationPhotoRead, createCancellation, findLiveCancellation, listCancellationsForDay,
} from './db.js';
import { estToday } from '../../src/lib/format.js';
import { cancelMessage, cancelMessageAll, dayCounts, cancellationsCsv } from '../../src/lib/cancellations.js';
import { PLATFORMS, cleanSku, cleanOrderNo, orderKey, flagsFor, platformFromNumber, platformLabel, FLAGS, BLOCKING } from '../../src/lib/cancellations.js';

// What the bot's "/" menu lists (scripts/telegram-webhook.mjs → setMyCommands).
export const BOT_COMMANDS = [
  ...PLATFORMS.map((p) => ({ command: p.cmd, description: `${p.label} — then send the photo(s) of the order to cancel` })),
  { command: 'msg', description: "Today's cancel message for one platform (pick it)" },
  { command: 'msgall', description: "Today's cancel messages for every platform" },
  { command: 'report', description: "Today's cancellations as a CSV file" },
];
export const HOW_TO = 'To log an order to cancel: send the platform, then the photo(s) — e.g. /alias and the picture (or put /alias in the photo\'s caption).\n'
  + `Platforms: ${PLATFORMS.map((p) => `/${p.cmd} ${p.label}`).join(' · ')}\n`
  + 'Or type the number: /stockx 12345678-12345678 - wrong size\n\n'
  + "End of shift (today, EST): /msg — pick a platform for its cancel message · /msgall — every platform · /report — a CSV file. "
  + 'Another day: add the date, e.g. /msgall yesterday or /report 2026-10-19';

const OPENAI_URL = () => process.env.CANCEL_AI_URL || 'https://api.openai.com/v1/chat/completions';
const MODEL = () => process.env.CANCEL_AI_MODEL || process.env.RECEIPT_AI_MODEL || 'gpt-5.4-mini';
export const cancelAiConfigured = () => !!(process.env.OPENAI_API_KEY || process.env.CANCEL_AI_URL);
// An order number is short text; 1600px on the long edge reads any label or screenshot,
// and every extra pixel is billed.
const MAX_EDGE = 1600;
const env = (k) => String(process.env[k] || '').trim();
// Tests keep the pictures in the database even where R2 is configured from .env, so a
// run never writes into the real bucket.
const useR2 = () => r2Configured() && env('CANCEL_PHOTOS_IN_DB') !== '1';

const PROMPT = `You read photos sent by a sneaker warehouse of ORDERS THAT MUST BE CANCELLED. A photo can be a shipping label, a packing slip, a phone screenshot of a marketplace order, or a screen. One photo may show several orders.

For every order you can see, return:
- platform: one of ${PLATFORMS.map((p) => `"${p.key}" (${p.label})`).join(', ')}, or null if you can't tell. Clues: logos and wording. Alias is GOAT's seller app; an Alias packing label says "alias" and may name another sales channel (e.g. Sneakers.com) — it is still "alias".
  StockX order numbers look like 12345678-12345678. eBay order numbers look like 12-34567-89012.
- order_number: the ORDER number exactly as printed (digits, letters and dashes). NOT a tracking number (1Z…, 9400…, long courier barcodes), NOT a SKU/style code, NOT a phone number, NOT a price.
- sku: the style code if shown (e.g. DD1391-100), else null. size: the shoe size as printed, else null. product: the shoe name, else null.
- confidence: 0..1 that the order_number is exactly right, digit for digit.
- unclear: the fields you could not read clearly (e.g. ["order_number"]), else [].

Copy digits exactly. If a digit is blurred or cut off, still give your best reading but lower the confidence and list the field in "unclear" — never silently guess. If the photo shows no order at all, return no orders and say what it shows in "what".`;

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['orders', 'what'],
  properties: {
    what: { type: 'string' },
    orders: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['platform', 'order_number', 'sku', 'size', 'product', 'confidence', 'unclear'],
        properties: {
          platform: { type: ['string', 'null'] }, order_number: { type: ['string', 'null'] },
          sku: { type: ['string', 'null'] }, size: { type: ['string', 'null'] }, product: { type: ['string', 'null'] },
          confidence: { type: 'number' }, unclear: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
};

/** Shrink to a JPEG the reader and the review page both need — never the camera original. */
export async function shrinkImage(buf) {
  try {
    const sharp = (await import('sharp')).default;
    return await sharp(buf).rotate()
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 }).toBuffer();
  } catch {
    return buf;
  }
}

// The second, independent read: same picture, told to go character by character. The
// reader's own confidence is not a check — on a blurred test photo it returned a wrong
// digit at 0.88 with nothing "unclear" — but two reads that disagree are.
const SECOND = `\n\nRead every order number ONE CHARACTER AT A TIME, left to right, before writing it. Do not reuse anything you think the number "should" be.`;

/** Ask the reader. -> { orders:[…], what } ; throws on a failed call. */
export async function readCancellationImage(jpeg, { second = false, platform = null } = {}) {
  // The sender named the platform (/alias + the photo): say so, so the reader looks for
  // THAT platform's order number instead of guessing which marketplace this is.
  const told = platform ? `\n\nThe sender says these orders are from ${platformLabel(platform)} ("${platform}"). Use that platform.` : '';
  const r = await fetch(OPENAI_URL(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY || 'local'}` },
    body: JSON.stringify({
      model: MODEL(),
      response_format: { type: 'json_schema', json_schema: { name: 'cancellations', strict: true, schema: SCHEMA } },
      messages: [{ role: 'user', content: [
        { type: 'text', text: PROMPT + told + (second ? SECOND : '') },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpeg.toString('base64')}` } },
      ] }],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const data = await r.json().catch(() => null);
  if (!r.ok) {
    console.error('[cancellations] reader', r.status, JSON.stringify(data?.error || data).slice(0, 300));
    throw new Error(r.status === 429 ? 'the reader is busy (rate-limited)' : `the reader did not answer (HTTP ${r.status})`);
  }
  let out;
  try { out = JSON.parse(data?.choices?.[0]?.message?.content || '{}'); } catch { throw new Error('the reader answered with something unreadable'); }
  const s = (v, n) => (v == null ? null : String(v).trim().slice(0, n) || null);
  return {
    what: s(out.what, 300) || '',
    orders: (Array.isArray(out.orders) ? out.orders : []).slice(0, 12).map((o) => ({
      platform: PLATFORMS.some((p) => p.key === o.platform) ? o.platform : null,
      order_number: s(o.order_number, 60), sku: s(o.sku, 40), size: s(o.size, 20), product: s(o.product, 200),
      confidence: Math.max(0, Math.min(1, Number(o.confidence) || 0)),
      unclear: (Array.isArray(o.unclear) ? o.unclear : []).map((x) => String(x).slice(0, 30)).slice(0, 6),
    })),
  };
}

/**
 * Both reads, compared. Each order of the first read gets `agreed`: true when the second
 * read found the same number (by key), false when it read that order differently or not
 * at all. A second read that fails outright leaves `agreed` null — flagged too, as unchecked.
 */
export async function readTwice(jpeg, platform = null) {
  const [a, b] = await Promise.allSettled([readCancellationImage(jpeg, { platform }), readCancellationImage(jpeg, { second: true, platform })]);
  if (a.status === 'rejected') {
    if (b.status === 'rejected') throw a.reason;
    return { ...b.value, orders: b.value.orders.map((o) => ({ ...o, agreed: null })) };
  }
  if (b.status === 'rejected') return { ...a.value, orders: a.value.orders.map((o) => ({ ...o, agreed: null })) };
  const keys = new Set(b.value.orders.map((o) => orderKey(o.order_number)).filter(Boolean));
  const seconds = b.value.orders.map((o) => cleanOrderNo(o.order_number)).filter(Boolean);
  return {
    ...a.value,
    orders: a.value.orders.map((o) => {
      const k = orderKey(o.order_number);
      const agreed = !!k && keys.has(k);
      return { ...o, agreed, other: agreed ? null : seconds.find((x) => orderKey(x) !== k) || null };
    }),
  };
}

async function storePhoto(photoId, jpeg) {
  if (useR2()) {
    const key = `cancellations/${photoId}.jpg`;
    const put = await fetch(presignPutUrl({ key }), { method: 'PUT', body: jpeg, headers: { 'content-type': 'image/jpeg' } });
    if (put.ok) return setCancellationPhotoRead(photoId, { r2Key: key, bytes: null });
    console.warn('[cancellations] R2 put failed', put.status, '— keeping the bytes in the database');
  }
  return setCancellationPhotoRead(photoId, { r2Key: null, bytes: jpeg });
}

/**
 * One picture → rows. `who` = { id, name } (the linked app account). Returns what to say
 * back: { filed:[row], dupes:[{order_number, existing}], unreadable:bool, error }.
 */
//
// `platform` = what the sender named (/alias in the caption), or `resolvePlatform()` — asked
// AFTER the read, because an album's other photos arrive with no caption at the same moment
// as the one that carries "/alias", and the read is what gives that one time to be noted.
// The sender's word beats the reader's guess.
export async function fileCancellationPhoto(buf, { who, caption = null, platform = null, resolvePlatform = null, tgChatId = null, tgMessageId = null }) {
  const reason = caption ? String(caption).trim().slice(0, 300) || null : null;
  const photoId = await createCancellationPhoto({ caption: reason, tgChatId, tgMessageId, sentByUserId: who.id, sentBy: who.name });
  if (photoId == null) return { already: true };   // Telegram re-sent a message we have
  const jpeg = await shrinkImage(buf);
  await storePhoto(photoId, jpeg);

  let read = null; let error = null;
  if (!cancelAiConfigured()) error = 'reading photos is not set up on this server';
  else {
    try { read = await readTwice(jpeg, platform); } catch (e) { error = e.message; }
  }
  const named = platform || (resolvePlatform ? await resolvePlatform().catch(() => null) : null);
  await setCancellationPhotoRead(photoId, { status: error ? 'failed' : read.orders.length ? 'read' : 'nothing', error });

  const base = { photo_id: photoId, reason, sent_by_user_id: who.id, sent_by: who.name, tg_chat_id: tgChatId, tg_message_id: tgMessageId, source: 'telegram' };
  // Nothing usable: still one row with the photo, so the request reaches a person.
  if (error || !read.orders.length) {
    const flags = ['unreadable', 'no_number', ...(named ? [] : ['no_platform'])];
    const { row } = await createCancellation({ ...base, platform: named, flags, ai_raw: read || { error },
      note: error ? `Could not read the photo: ${error}` : (read.what ? `Reader: ${read.what}` : null) });
    return { filed: row ? [row] : [], dupes: [], unreadable: true, error, what: read?.what || '' };
  }
  const filed = []; const dupes = [];
  for (const o of read.orders) {
    const order_number = o.order_number ? cleanOrderNo(o.order_number) : null;
    const key = orderKey(order_number);
    const row = { platform: named || o.platform || platformFromNumber(order_number), order_number, sku: cleanSku(o.sku), size: o.size, product: o.product };
    const flags = flagsFor(row, o);
    const note = o.agreed === false ? (o.other ? `Second read said ${o.other}` : 'The second read did not find this number') : null;
    const out = await createCancellation({ ...base, ...row, order_key: key, flags, note, ai_confidence: o.confidence, ai_raw: o });
    if (out.duplicate) dupes.push({ order_number, existing: out.duplicate });
    else filed.push(out.row);
  }
  return { filed, dupes, unreadable: false };
}

/** A number TYPED to the bot (the photo failed, or there was no photo). */
export async function fileTypedCancellation(text, { who, platform: given = null, tgChatId = null, tgMessageId = null }) {
  // [platform] number [ - reason]. A space continues the number only before another digit
  // group ("1234 5678 9012"), so "12345678-12345678 - customer asked" keeps its reason apart.
  const m = /^\s*(?:([A-Za-z]+)\s+)?#?([A-Za-z0-9](?:[A-Za-z0-9-]|\s(?=\d)){4,40}[A-Za-z0-9])(?:\s*[-–:]\s*|\s+)?(.*?)\s*$/s.exec(String(text || ''));
  if (!m) return null;
  const order_number = cleanOrderNo(m[2]);
  const named = m[1] ? PLATFORMS.find((p) => p.key === m[1].toLowerCase() || p.label.toLowerCase() === m[1].toLowerCase())?.key : null;
  const platform = given || named || platformFromNumber(order_number);
  const key = orderKey(order_number);
  // An order number is mostly digits; "hello world123" is not a request to cancel anything.
  if (!key || (key.match(/\d/g) || []).length < 6) return null;
  const row = { platform, order_number };
  const existing = await findLiveCancellation(key);
  if (existing) return { filed: [], dupes: [{ order_number, existing }] };
  const out = await createCancellation({ ...row, order_key: key, flags: flagsFor(row), reason: m[3]?.trim().replace(/^[-–:]\s*/, '').slice(0, 300) || null,
    source: 'typed', sent_by_user_id: who.id, sent_by: who.name, tg_chat_id: tgChatId, tg_message_id: tgMessageId });
  return out.duplicate ? { filed: [], dupes: [{ order_number, existing: out.duplicate }] } : { filed: [out.row], dupes: [] };
}

// ── Telegram ─────────────────────────────────────────────────────────────────────────
const tgFileUrl = (path) => `${env('TELEGRAM_API_BASE') || 'https://api.telegram.org'}/file/bot${env('TELEGRAM_BOT_TOKEN')}/${path}`;

export async function downloadTelegramFile(fileId) {
  const f = await tg('getFile', { file_id: fileId });
  if (!f?.file_path) throw new Error('Telegram gave no file path');
  if (Number(f.file_size) > 20 * 1024 * 1024) throw new Error('the picture is too big');
  const r = await fetch(tgFileUrl(f.file_path), { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`could not download the picture (HTTP ${r.status})`);
  return Buffer.from(await r.arrayBuffer());
}

const line = (r) => {
  const hard = (r.flags || []).filter((f) => BLOCKING.includes(f));
  const soft = (r.flags || []).filter((f) => !BLOCKING.includes(f));
  const what = [platformLabel(r.platform) || 'Platform ?', r.order_number || 'no number', [r.sku, r.size].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
  const tail = hard.length ? `\n   ⚠️ ${hard.map((f) => FLAGS[f]).join('; ')}` : soft.length ? `\n   🔎 ${soft.map((f) => FLAGS[f]).join('; ')}` : '';
  return `#${r.id} ${what}${tail}`;
};

/** What the bot says back after a photo or a typed number. */
export function replyText(out) {
  if (out.already) return null;
  const parts = [];
  if (out.unreadable) {
    parts.push(`⚠️ I couldn't read an order number on this picture${out.error ? ` (${out.error})` : out.what ? ` — it looks like: ${out.what}` : ''}.`);
    parts.push(`It's saved as #${out.filed[0]?.id} for review with the photo, so nothing is lost.`);
    parts.push('If you can, send a clearer photo, or type the number with its platform, e.g. /stockx 12345678-12345678');
    return parts.join('\n');
  }
  if (out.filed.length) parts.push(`✅ Logged ${out.filed.length} for review:\n${out.filed.map(line).join('\n')}`);
  for (const d of out.dupes) {
    parts.push(`🔁 ${d.order_number} is already logged as #${d.existing.id}${d.existing.sent_by ? ` (by ${d.existing.sent_by})` : ''} — not added twice.`);
  }
  if (out.filed.some((r) => (r.flags || []).some((f) => BLOCKING.includes(f))))
    parts.push('Rows marked ⚠️ will be fixed from the photo by the reviewer — or send a clearer picture.');
  return parts.join('\n\n') || 'Nothing new to log.';
}

export const sayTo = (chatId, text, replyTo = null) => enqueue(() => tg('sendMessage', {
  chat_id: chatId, text,
  ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
}));

// ── End of shift: /msg, /msgall, /report ─────────────────────────────────────────────
// All by ONE EST day — the warehouse runs these at the end of their shift, and "today"
// has to be the server's Eastern day, never the phone's.
const addDaysYmd = (ymd, n) => {
  const d = new Date(`${ymd}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
/** "", "today", "yesterday", "2026-10-19" → an EST day, or null when it isn't one. */
export function dayFrom(arg) {
  const a = String(arg || '').trim().toLowerCase().replace(/^-?all\b\s*/, '');
  const today = estToday();
  if (!a || a === 'today') return today;
  if (a === 'yesterday') return addDaysYmd(today, -1);
  if (/^\d{4}-\d{2}-\d{2}$/.test(a) && !Number.isNaN(Date.parse(`${a}T12:00:00Z`)) && a <= today) return a;
  return null;
}
const dayName = (ymd) => (ymd === estToday() ? `today (${ymd} EST)` : `${ymd} (EST)`);

/** The footnote for rows that can't go in a message yet. */
function leftOut(rows) {
  const c = dayCounts(rows);
  const bits = [];
  if (c.noNumber) bits.push(`${c.noNumber} with no order number yet`);
  if (c.noPlatform) bits.push(`${c.noPlatform} with no platform yet`);
  return bits.length ? `\n\n⚠️ Not listed: ${bits.join(', ')} — fix them on the Cancellations page, then ask again.` : '';
}

/** /msg → the picker: one button per platform that has orders that day. */
export async function msgPicker(ymd) {
  const rows = await listCancellationsForDay(ymd);
  const c = dayCounts(rows);
  const buttons = PLATFORMS.filter((p) => c.by[p.key]).map((p) => ({ text: `${p.label} (${c.by[p.key]})`, callback_data: `cxmsg:${p.key}:${ymd}` }));
  if (!buttons.length) return { text: `No orders to cancel ${dayName(ymd)}.${leftOut(rows)}` };
  const keyboard = [];
  for (let i = 0; i < buttons.length; i += 2) keyboard.push(buttons.slice(i, i + 2));
  return { text: `Which platform? Orders sent ${dayName(ymd)}:${leftOut(rows)}`, keyboard };
}
/** A picker tap / one platform's message. */
export async function msgFor(platform, ymd) {
  const rows = await listCancellationsForDay(ymd);
  return cancelMessage(platform, rows) || `No ${platformLabel(platform)} orders to cancel ${dayName(ymd)}.`;
}
/** /msgall */
export async function msgAll(ymd) {
  const rows = await listCancellationsForDay(ymd);
  return (cancelMessageAll(rows) || `No orders to cancel ${dayName(ymd)}.`) + leftOut(rows);
}
/** /report → the day's rows as a CSV, rejected ones included (it's the record). */
export async function sendDayReport(chatId, ymd) {
  const rows = await listCancellationsForDay(ymd, { withRejected: true });
  if (!rows.length) return false;
  const c = dayCounts(rows.filter((r) => r.status !== 'rejected'));
  const per = PLATFORMS.filter((p) => c.by[p.key]).map((p) => `${p.label} ${c.by[p.key]}`).join(' · ');
  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  await sendAlertDocument(chatId, {
    html: esc(`Cancellations ${dayName(ymd)}: ${rows.length} row${rows.length === 1 ? '' : 's'}${per ? ` — ${per}` : ''}`),
    filename: `cancellations-${ymd}.csv`, content: cancellationsCsv(rows), type: 'text/csv',
  });
  return true;
}
