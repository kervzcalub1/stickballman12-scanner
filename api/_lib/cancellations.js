// Order cancellations: photo in, rows out (docs/context/cancellations.md).
//
// Karon (warehouse) used to type every 10–15-digit order number to cancel at the end of
// the day. Now anyone on the floor sends the bot a picture (a label, a packing slip, a
// screenshot of the order) with the platform command (/alias …); this reads it, RECORDS one
// row per order (number + shoe name, SKU, size), and answers ONCE per batch of photos, as a
// reply to the first, with the list of what it recorded. No review step since 2026-11-12
// (owner: "no verification anymore — just record it").
//
// THE READER IS A READER, NOT A DECIDER. It never invents a number or a detail it didn't
// see; what makes a number certain is OUR OWN orders (fillDetails). A photo it can't read
// still records a row WITH the photo, marked "no order # read", so a person can type the
// number off the picture — a failed read never loses the request.
import { tg, enqueue, sendAlertDocument } from './telegram.js';
import { r2Configured, presignPutUrl } from './r2.js';
import {
  createCancellationPhoto, setCancellationPhotoRead, createCancellation, findLiveCancellation, listCancellationsForDay,
  knownOrdersFor, catalogueNamesBySku, getCancellation, getCancellationsByIds, updateCancellationFields, openUnreadCancellation,
  claimCancellationPhotoReplies, releaseCancellationPhotoReplies, cancellationPhotosForReply, strandedCancellationPhotos,
  cancellationIdsForPhoto, setCancellationAskMessage, cancellationPhotoByAskMessage, cancellationRowsOfPhoto, heldCancellationPhotos, setCancellationPrompt, expireHeldCancellationPhotos, setCancellationReplyMessage,
} from './db.js';
import { estToday } from '../../src/lib/format.js';
import { notifyEnv } from './notify.js';
import { alertCancellationsLogged } from './alerts.js';
import { readCancellationLocally, canOpenImage } from './cancelOcr.js';
import { decodeSlipBarcode } from './cancelBarcode.js';
import { shopifyIndexFresh } from './shopify-order-index.js';
import { platformFromText, slipDetails, splitCommand } from '../../src/lib/cancellations.js';
import { cancelMessage, cancelMessageAll, dayCounts, cancellationsCsv, batchReplyText, batchReplyNeedsLook, typedDetails, pickerKeyboard } from '../../src/lib/cancellations.js';
import {
  PLATFORMS, cleanSku, cleanOrderNo, orderKey, flagsFor, platformFromNumber, platformLabel,
  confusableKeys, matchOurOrder, detailsFromOrder, trackingFromText, canonKey,
} from '../../src/lib/cancellations.js';

// What the bot's "/" menu lists (scripts/telegram-webhook.mjs → setMyCommands).
export const BOT_COMMANDS = [
  ...PLATFORMS.map((p) => ({ command: p.cmd, description: `${p.label} — then send the photo(s) of the order to cancel` })),
  { command: 'msg', description: "Today's cancel message for one platform (pick it)" },
  { command: 'msgall', description: "Today's cancel messages for every platform" },
  { command: 'report', description: "Today's cancellations as a CSV file" },
];
// The "/" menu, set by the server itself when it starts (so a phone offers /alias … as soon
// as someone types "/") and by `npm run telegram:webhook -- commands`. Private chats, and the
// cancellations group when there is one — never the approval groups.
export const botCommandScopes = () => {
  const group = env('TELEGRAM_CANCEL_CHAT_ID');
  return [{ type: 'all_private_chats' }, ...(group ? [{ type: 'chat', chat_id: Number(group) }] : [])];
};
export async function registerBotCommands(call = tg) {
  const commands = [...BOT_COMMANDS, { command: 'help', description: 'How to log an order to cancel' }];
  const done = [];
  for (const scope of botCommandScopes()) {
    await call('setMyCommands', { commands, scope });
    done.push(scope.type === 'chat' ? `chat ${scope.chat_id}` : scope.type);
  }
  return { commands: commands.map((c) => `/${c.command}`), scopes: done };
}
export const HOW_TO = 'To record orders to cancel: send the platform, then the photo(s) — e.g. /alias and the pictures (or put /alias in the caption). '
  + 'Photos with no platform get buttons to pick it. Anything after the command is kept as the note (/ebay wrong size shipped). '
  + 'I record each order and answer once with the list: order number + shoe, SKU, size.\n'
  + `Platforms: ${PLATFORMS.map((p) => `/${p.cmd} ${p.label}`).join(' · ')}\n`
  + 'Or type it: /stockx 12345678-12345678 · /alias 206557037 DD1391-100 9.5 - wrong size\n\n'
  + "End of shift (today, EST): /msg — pick a platform for its cancel message · /msgall — every platform · /report — a CSV file. "
  + 'Another day: add the date, e.g. /msgall yesterday or /report 2026-10-19';

const env = (k) => String(process.env[k] || '').trim();
const OPENAI_URL = () => process.env.CANCEL_AI_URL || 'https://api.openai.com/v1/chat/completions';
const MODEL = () => process.env.CANCEL_AI_MODEL || process.env.RECEIPT_AI_MODEL || 'gpt-5.4-mini';
// NO AI by default (owner, 2026-11-10: "deploy it, keep the AI off"): tesseract on our own
// server reads every photo; a photo it can't read is filed for a person to type in. The AI
// fallback exists but runs only with CANCEL_AI=on (the e2e suite turns it on for its fake).
export const cancelAiConfigured = () => env('CANCEL_AI').toLowerCase() === 'on' && !!(process.env.OPENAI_API_KEY || process.env.CANCEL_AI_URL);
// An order number is short text; 1600px on the long edge reads any label or screenshot,
// and every extra pixel is billed.
const MAX_EDGE = 1600;
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
    // OpenAI answers an EMPTY ACCOUNT with 429 too (insufficient_quota) — that is not "busy",
    // and waiting won't fix it: say so, so an admin tops it up.
    const code = `${data?.error?.code || ''} ${data?.error?.type || ''}`;
    if (/insufficient_quota|credit_balance|billing/i.test(code)) throw new Error('the AI reader is out of credit (OpenAI billing) — tell an admin');
    if (r.status === 401) throw new Error('the AI reader key is not valid — tell an admin');
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
  const firstKeys = new Set(a.value.orders.map((o) => orderKey(o.order_number)).filter(Boolean));
  // The second read's numbers the first read did NOT have: the candidates for "Second read
  // said …" — never a number that belongs to another order on the same photo.
  const unmatched = b.value.orders.filter((o) => { const k = orderKey(o.order_number); return k && !firstKeys.has(k); });
  const used = new Set();
  const firstOrders = a.value.orders.map((o) => {
    const k = orderKey(o.order_number);
    const agreed = !!k && keys.has(k);
    if (agreed) return { ...o, agreed, other: null };
    // The closest in length is most likely the same number read differently.
    const near = unmatched.filter((x) => !used.has(x))
      .sort((x, y) => Math.abs(orderKey(x.order_number).length - (k || '').length) - Math.abs(orderKey(y.order_number).length - (k || '').length))[0];
    if (near) used.add(near);
    return { ...o, agreed, other: near ? cleanOrderNo(near.order_number) : null };
  });
  // An order ONLY the second read found (the first missed it, not misread it) is filed too,
  // flagged — a photo of three orders must never quietly become two.
  const extra = unmatched.filter((x) => !used.has(x)).map((o) => ({ ...o, agreed: false, onlySecond: true }));
  return { ...a.value, orders: [...firstOrders, ...extra] };
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

// ── The shoe: our orders first, then the label, then our catalogue ───────────────────
// Order of trust (owner, 2026-11-12: "order number + shoe name, SKU, size"):
//   1. OUR order with that number (eBay / SHEIN / pre-sell) — it confirms the number too; a
//      number one OCR letter-for-digit slip away from exactly one of them is put right
//      (matchOurOrder). A label with no order number but a tracking number that one of our
//      orders shipped under → that order.
//   2. what the label says (style code, size, the name line).
//   3. a name for that style code from our own catalogue (products / items / pre-sell stock).
// Never invented: a detail none of them has stays blank. No paid lookups.
async function lookupKnown({ keys, tracks, canon = [] }) {
  try { return await knownOrdersFor({ keys, tracks, canon }); } catch (e) {
    console.warn('[cancellations] order lookup failed:', e.message);
    return [];
  }
}
/**
 * `orders` = what the reader found ([{ order_number, platform, sku, size, product }]);
 * `named` = the platform the sender named; `opts.text` = the text read (for tracking numbers);
 * `opts.typed` = a person typed it (no correction — they typed what they meant).
 * → the same orders with platform / number / shoe filled, plus details_from, order_match,
 *   read_as (the number as read, when it was put right), by_tracking, note.
 */
// The platforms whose every order is in the Shopify order index, number and all — so a number
// that matches none of them is most likely misread. Not Stadium Goods (the number its slip
// prints is not in Shopify) and not TikTok (where its number sits was seen on one order only).
// NOT Alias either (2026-11-25): four Alias labels read cleanly — both reads agreed, the number
// right under "ORDER #" — matched nothing, and a scan of Shopify back to July (8,600 GOAT orders)
// did not hold them. Some real Alias orders never reach Shopify, so "not found" says nothing
// about the read there; 4 of 7 Alias photos were tagged [CHECK] for it.
const INDEXED = new Set(['stockx', 'temu', 'kc', 'ebay', 'shein']);
/**
 * … `opts.guess` = the platform the slip itself names (platformFromText) or the AI reader's —
 * used only when nothing better says: the sender, our own order, the number's shape.
 * Each order also gets `extra_flags`: 'platform_guess' (it came from that guess) and
 * 'not_in_shopify' (the index is complete and current, the platform is one it covers, and
 * the number is in it nowhere) — both make the summary line [CHECK].
 */
export async function fillDetails(orders, named, { text = '', typed = false, guess = null } = {}) {
  const keys = orders.flatMap((o) => {
    const k = orderKey(o.order_number);
    if (!k) return [];
    // The other reading of a number the reads disagreed on is looked up too: whichever of the
    // two is one of OUR orders is the number.
    const alt = !typed && o.other ? orderKey(o.other) : null;
    return typed ? [k] : [k, ...confusableKeys(k), ...(alt ? [alt] : [])];
  });
  const tracks = typed ? [] : trackingFromText(text);
  // A long letters-and-digits number (SHEIN, StockX) misread in several look-alikes at once.
  const canon = typed ? [] : orders.map((o) => orderKey(o.order_number)).filter((k) => k && /[A-Z]/.test(k)).map((k) => canonKey(k));
  const known = keys.length || tracks.length ? await lookupKnown({ keys, tracks, canon }) : [];
  const fresh = orders.some((o) => orderKey(o.order_number)) ? await shopifyIndexFresh().catch(() => false) : false;
  let list = orders;
  // No order number on the label, but a tracking number one of OUR orders shipped under.
  if (!orders.some((o) => orderKey(o.order_number)) && tracks.length) {
    const byTrack = [...new Map(known.filter((k) => k.tracking && (!named || k.platform === named)).map((k) => [k.key, k])).values()];
    if (byTrack.length === 1) {
      const o = orders[0] || {};
      list = [{ ...o, order_number: byTrack[0].order_id, platform: byTrack[0].platform, by_tracking: true }];
    }
  }
  const out = list.map((o) => {
    const order_number = o.order_number ? cleanOrderNo(o.order_number) : null;
    let m = order_number ? matchOurOrder(order_number, named || o.platform || null, known) : null;
    // The two reads disagreed, and it is the OTHER reading that is exactly one of our orders.
    let other = null;
    if ((!m || m.corrected) && !typed && o.other) {
      const alt = matchOurOrder(cleanOrderNo(o.other), named || o.platform || null, known);
      if (alt && !alt.corrected) { m = alt; other = order_number; }
    }
    const f = { ...o, order_number, platform: named || o.platform || platformFromNumber(order_number) || null, from: [], extra_flags: [] };
    if (m && (!m.corrected || !typed)) {
      const d = detailsFromOrder(m.order, o) || {};
      f.platform = named || m.order.platform;
      if (m.corrected) {
        f.read_as = order_number;
        f.note = `Read as ${order_number} on the photo; one character off our ${platformLabel(m.order.platform)} order ${m.order.order_id} (or its look-alike characters misread), so recorded as that.`;
      } else if (other) {
        f.note = `The reads disagreed (${other} / ${cleanOrderNo(o.other)}); ${cleanOrderNo(o.other)} is our ${platformLabel(m.order.platform)} order, so recorded as that.`;
      }
      f.order_number = cleanOrderNo(m.order.order_id);
      f.order_match = m.order.source;
      if (d.product || d.sku || d.size) f.from.push(m.order.source);
      f.product = d.product || o.product || null;
      f.sku = d.sku || cleanSku(o.sku) || null;
      f.size = d.size || o.size || null;
      if ((!d.product && o.product) || (!d.sku && o.sku) || (!d.size && o.size)) f.from.push(typed ? 'typed' : 'label');
    } else {
      f.sku = cleanSku(o.sku) || null;
      if (o.product || f.sku || o.size) f.from.push(typed ? 'typed' : 'label');
      // Nobody named the platform and the number's shape doesn't: what the slip says, flagged.
      if (!f.platform && guess) { f.platform = guess; f.extra_flags.push('platform_guess'); }
      if (order_number && fresh && INDEXED.has(f.platform)) f.extra_flags.push('not_in_shopify');
    }
    return f;
  });
  // 3. A name for a style code, from our own catalogue.
  const need = [...new Set(out.filter((o) => !o.product && o.sku).map((o) => o.sku))];
  if (need.length) {
    let names = new Map();
    try { names = await catalogueNamesBySku(need); } catch (e) { console.warn('[cancellations] catalogue lookup failed:', e.message); }
    for (const o of out) {
      const n = !o.product && o.sku ? names.get(orderKey(o.sku)) : null;
      if (n) { o.product = n; o.from.push('catalogue'); }
    }
  }
  return out.map(({ from, ...o }) => ({ ...o, details_from: [...new Set(from)].join(',') || null }));
}

/**
 * One picture → rows. The photo row already exists (the webhook writes it before answering
 * Telegram); `photoId` null = make one (tests / a caller without the webhook). `who` = the
 * linked app account. Returns { photoId, rows:[row], dupes:[…], error, already } and keeps
 * the same summary on the photo (`result`), which is what the batch reply is built from.
 */
//
// `platform` = what the sender named (/alias in the caption), or `resolvePlatform()` — asked
// AFTER the read, because an album's other photos arrive with no caption at the same moment
// as the one that carries "/alias", and the read is what gives that one time to be noted.
// The sender's word beats the reader's guess.
//
// `requirePlatform` (a photo sent with NO platform, 2026-11-21): read it first — the number may
// be one of our Shopify orders, or its shape or the slip's own words may say whose it is. Only
// when none of those names a platform does this return { needsPlatform: true } WITHOUT
// recording anything, and the caller asks with the buttons.
export async function fileCancellationPhoto(buf, { photoId = null, who, caption = null, platform = null, resolvePlatform = null, tgChatId = null, tgMessageId = null, requirePlatform = false }) {
  const reason = caption ? String(caption).trim().slice(0, 300) || null : null;
  if (photoId == null) {
    photoId = await createCancellationPhoto({ caption: reason, tgChatId, tgMessageId, sentByUserId: who.id, sentBy: who.name });
    if (photoId == null) return { already: true };   // Telegram re-sent a message we have
  }
  // A picture we can't even open (an iPhone HEIC sent "as a file"): keep it, record the row,
  // and say how to send it so it can be read.
  const opens = await canOpenImage(buf);
  const jpeg = opens ? await shrinkImage(buf) : buf;
  await storePhoto(photoId, jpeg);

  let read = null; let error = null; let byTracking = null;
  let worded = null;      // the platform the slip itself names ("STADIUM GOODS", "GOAT" …)
  let hintLine = null;    // said next to a [MISSED] line: how to send it so it CAN be read
  if (!opens) error = "this picture's format can't be opened — send it as a photo (not as a file)";
  else {
    // 1. Our own server, no AI: tesseract on the ORIGINAL picture (more pixels than the copy we keep).
    const hint = platform || (resolvePlatform ? await resolvePlatform().catch(() => null) : null);
    let local = null;
    try {
      local = await readCancellationLocally(buf, hint);
      if (local.orders.length) read = { ...local, by: 'ocr' };
    } catch (e) {
      console.warn('[cancellations] local read failed:', e.message);
    }
    worded = local?.text ? platformFromText(local.text) : null;
    // A Stadium Goods slip prints no order number in words: it is the BARCODE (and the small
    // print under it, which doesn't read reliably). Exact or nothing.
    if (!read && (hint || worded) === 'sg') {
      const code = await decodeSlipBarcode(buf);
      if (code) {
        read = { what: '', text: local?.text || '', by: 'barcode',
          orders: [{ platform: 'sg', order_number: code, ...slipDetails(local?.text || ''), confidence: 0.99, unclear: [], agreed: true, why: 'barcode' }] };
      } else {
        hintLine = "a Stadium Goods order number is its barcode, and it can't be read at this size — send the photo as a FILE (not compressed), or take it closer";
      }
    }
    // No order number, but a tracking number one of OUR orders shipped under (an eBay FedEx
    // label prints only the tracking number): that order — before any AI.
    if (!read && local?.text) {
      const t = await fillDetails([], hint, { text: local.text });
      if (t.length) { byTracking = t; read = { ...local, by: 'ocr' }; }
    }
    // 2. Only when that found no order number: the AI, if it is switched on.
    if (!read && cancelAiConfigured()) {
      try { read = { ...(await readTwice(jpeg, hint)), by: 'ai' }; } catch (e) { error = e.message; }
    }
    if (!read && !error) read = { orders: [], what: '', by: 'ocr', text: local?.text || '' };
    if (read && !read.text && local?.text) read.text = local.text;
  }
  const named = platform || (resolvePlatform ? await resolvePlatform().catch(() => null) : null);
  const base = { photo_id: photoId, reason, sent_by_user_id: who.id, sent_by: who.name, tg_chat_id: tgChatId, tg_message_id: tgMessageId, source: 'telegram' };

  // Our orders / the label / the catalogue: number confirmed and the shoe filled. A label
  // with only a tracking number can still name one of our orders here.
  // What the slip itself says the platform is (`worded`) is a fallback only, and flagged.
  const found = byTracking || (read && !error ? await fillDetails(read.orders, named, { text: read.text || '', guess: worded }) : []);
  // Nobody named a platform. Is there one for every order on the photo — from our own order,
  // the number's shape, or the slip's words? If not, nothing is recorded: the sender is asked.
  if (requirePlatform && !named && !error) {
    const numbered = found.filter((o) => o.order_number);
    const known = numbered.length ? numbered.every((o) => o.platform) : !!worded;
    if (!known) return { photoId, needsPlatform: true };
  }
  const finish = async (rows, dupes, extra = {}) => {
    const result = { rows: rows.map((r) => ({ id: r.id, ...(r.read_as ? { read_as: r.read_as } : {}), ...(r.by_tracking ? { by_tracking: true } : {}) })),
      dupes: dupes.map((d) => ({ order_number: d.order_number, existing: { id: d.existing?.id, sent_by: d.existing?.sent_by || null } })), ...extra };
    await setCancellationPhotoRead(photoId, { status: error ? 'failed' : rows.some((r) => r.order_number) || dupes.length ? 'read' : 'nothing', error, result });
    return { photoId, rows, dupes, error };
  };
  // Nothing usable: still one row with the photo, so the request reaches a person.
  if (error || !found.some((o) => o.order_number)) {
    // The platform the slip names and the shoe it prints are kept even with no number: a
    // Stadium Goods slip whose barcode didn't read still says STADIUM GOODS, SKU and SIZE.
    const where = named || (error ? null : worded);
    const shoe = !error && read?.text ? slipDetails(read.text) : { sku: null, size: null, product: null };
    const flags = ['unreadable', 'no_number', ...(where ? [] : ['no_platform']), ...(where && !named ? ['platform_guess'] : [])];
    const { row } = await createCancellation({ ...base, platform: where, flags, sku: shoe.sku, size: shoe.size, product: shoe.product,
      details_from: shoe.sku || shoe.size || shoe.product ? 'label' : null,
      ai_raw: read ? { by: read.by, what: read.what, ...(read.text ? { text: read.text } : {}) } : { error },
      note: error ? `Could not read the photo: ${error}` : (read.what ? `Reader: ${read.what}` : null) });
    return finish(row ? [row] : [], [], hintLine ? { hint: hintLine } : {});
  }
  const rows = []; const dupes = []; const seen = new Set();
  const raws = new Map(read.orders.map((o) => [orderKey(o.order_number), o]));
  for (const o of found) {
    const key = orderKey(o.order_number);
    if (!key) continue;
    // The same number twice on one picture is one order, not "already logged by you".
    if (seen.has(key)) continue;
    seen.add(key);
    const ai = raws.get(orderKey(o.read_as || o.order_number)) || o;
    const row = { platform: o.platform, order_number: o.order_number, sku: o.sku, size: o.size, product: o.product };
    // Our own order matched = certain: the reader's own doubts don't apply.
    const flags = [...new Set([...flagsFor(row, o.order_match ? null : ai), ...(o.extra_flags || [])])];
    const note = [o.note, ai.agreed !== false || o.order_match ? null
      : ai.onlySecond ? 'Only one of the two reads found this number'
        : ai.other ? `Second read said ${ai.other}` : 'The second read did not find this number',
    o.by_tracking ? 'No order number on the photo — found by the tracking number on it.' : null].filter(Boolean).join(' ') || null;
    // What read it, and (no AI) the text it read — so a miss can be turned into a new rule.
    const raw = { ...ai, by: read.by, ...(read.text ? { text: read.text } : {}) };
    const out = await createCancellation({ ...base, ...row, order_key: key, flags, note, ai_confidence: ai.confidence ?? null, ai_raw: raw,
      details_from: o.details_from, order_match: o.order_match || null });
    if (out.duplicate) dupes.push({ order_number: o.order_number, existing: out.duplicate });
    else rows.push({ ...out.row, read_as: o.read_as || null, by_tracking: !!o.by_tracking });
  }
  return finish(rows, dupes);
}

/** A number TYPED to the bot (the photo failed, or there was no photo). */
// `fillRowId` = the row this number is FOR (a reply to the copy of a photo no number was read
// off): it fills that row, whoever sent the photo and however many others are still open.
export async function fileTypedCancellation(text, { who, platform: given = null, tgChatId = null, tgMessageId = null, fillRowId = null }) {
  // [platform] number [SKU] [size] [ - reason]. A space continues the number only before
  // another digit group ("1234 5678 9012"), so "12345678-12345678 - customer asked" keeps its reason apart.
  const m = /^\s*(?:([A-Za-z]+)\s+)?#?([A-Za-z0-9](?:[A-Za-z0-9-]|\s(?=\d)){4,40}[A-Za-z0-9])(?:\s*[-–:]\s*|\s+)?(.*?)\s*$/s.exec(String(text || ''));
  if (!m) return null;
  let num = m[2]; let rest = m[3] || '';
  // "206557037 9.5": a space continues the number before a digit, so the size's "9" got glued on.
  const glued = /^(.*\d)\s+(\d{1,2})$/.exec(num);
  if (glued && (glued[1].match(/\d/g) || []).length >= 6) {
    num = glued[1]; rest = `${glued[2]}${rest.startsWith('.') ? '' : ' '}${rest}`.trim();
  }
  const order_number = cleanOrderNo(num);
  const named = m[1] ? PLATFORMS.find((p) => p.key === m[1].toLowerCase() || p.label.toLowerCase() === m[1].toLowerCase())?.key : null;
  const platform = given || named || platformFromNumber(order_number);
  const key = orderKey(order_number);
  // An order number is mostly digits; "hello world123" is not a request to cancel anything.
  // …unless its shape is a platform's own (StockX "06-LZQ93WHGEL" has four digits).
  if (!key || ((key.match(/\d/g) || []).length < 6 && !platformFromNumber(order_number))) return null;
  const existing = await findLiveCancellation(key);
  if (existing) return { rows: [], dupes: [{ order_number, existing }] };
  const t = typedDetails(rest);
  const [o] = await fillDetails([{ order_number, platform, sku: t.sku, size: t.size, product: null }], platform, { typed: true });
  const row = { platform: o.platform, order_number: o.order_number, sku: o.sku, size: o.size, product: o.product };
  const f = { ...row, order_key: orderKey(o.order_number), flags: [...new Set([...flagsFor(row), ...(o.extra_flags || [])])],
    details_from: o.details_from, order_match: o.order_match || null };
  // "Photo 4: no order number found — type it": the number fills that photo's row.
  const open = fillRowId ? { id: fillRowId } : await openUnreadCancellation(who.id, platform);
  if (open) {
    const cur = await getCancellation(open.id);
    // The row keeps the shoe it already has. Live 2026-11-25: seven Stadium Goods rows carried
    // the SKU and size read off their slips; the number replied onto each (a bare number, no
    // shoe in it — and one in none of our orders) blanked both. What the typed text or our own
    // order says still wins; only a field they leave empty falls back to the row's.
    const kept = ['sku', 'size', 'product'].filter((k) => !f[k] && cur[k]);
    const shoe = Object.fromEntries(kept.map((k) => [k, cur[k]]));
    const from = [...new Set([...String(f.details_from || '').split(','), ...(kept.length ? String(cur.details_from || 'label').split(',') : [])]
      .map((x) => x.trim()).filter(Boolean))].join(',') || null;
    const out = await updateCancellationFields(open.id, { ...f, ...shoe, details_from: from, platform: f.platform || cur.platform, reason: t.reason || cur.reason, note: cur.note,
      changed: `order number typed to the bot: ${o.order_number}` }, who.name);
    if (out.duplicate) return { rows: [], dupes: [{ order_number, existing: out.duplicate }] };
    return { rows: [{ ...out.row, filled: true }], dupes: [] };
  }
  const out = await createCancellation({ ...f, reason: t.reason, source: 'typed', sent_by_user_id: who.id, sent_by: who.name, tg_chat_id: tgChatId, tg_message_id: tgMessageId });
  return out.duplicate ? { rows: [], dupes: [{ order_number, existing: out.duplicate }] } : { rows: [out.row], dupes: [] };
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

export const sayTo = (chatId, text, replyTo = null) => enqueue(() => tg('sendMessage', {
  chat_id: chatId, text,
  ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
}));
const devTag = () => (notifyEnv() === 'dev' ? '[dev] ' : '');

/** What the bot says back after a typed number. */
export function typedReplyText(out) {
  const filled = out.rows.find((r) => r.filled);
  const text = batchReplyText([{ n: null, rows: out.rows, dupes: out.dupes }]);
  return filled ? `${text}\n\n(Filled the photo row #${filled.id} that had no order number.)` : text;
}

// ── ONE reply per batch of photos (2026-11-12) ───────────────────────────────────────
// A batch = every photo one person sends in one chat close together: an album (Telegram
// delivers it as separate updates within ~1 s) AND separate photos sent one after another.
// The reads run one at a time (cancelOcr's queue), so a photo that arrives while the batch
// is still being read simply joins it. Once the last photo is read, the batch waits QUIET_MS
// for another; then ONE message goes out, as a reply to the batch's first photo.
//
// 4 s: an album's photos all arrive within ~1 s, and someone tapping "send" on photos one by
// one is 2–3 s apart — while each read takes 1–2.5 s, so the window only has to cover the gap
// AFTER the last read. Longer just makes everyone wait for the answer. CANCEL_BATCH_QUIET_MS
// overrides it.
//
// The batch lives in memory; what survives a restart is on the photo rows (replied_at,
// result). The sweep (cancellations-worker.js) answers anything left unanswered — worst case
// per person rather than per batch, never twice (replied_at is claimed compare-and-set).
const QUIET_MS = () => {
  const n = Number(env('CANCEL_BATCH_QUIET_MS'));
  return Number.isFinite(n) && n >= 200 && n <= 60_000 ? n : 4000;
};
const batches = new Map();       // `${chat}:${sender}` → { chatId, ids, pending, timer }
const inFlight = new Set();      // photo ids this process is reading or holding for a reply
export function cancelBatchStart(key, chatId, photoId) {
  let b = batches.get(key);
  if (!b) { b = { chatId, ids: [], pending: 0, timer: null }; batches.set(key, b); }
  clearTimeout(b.timer); b.timer = null;
  b.ids.push(photoId); b.pending += 1; inFlight.add(photoId);
}
/** A photo that turned out NOT to be this batch's (it is held for a platform): take it back out. */
export function cancelBatchDrop(key, photoId) {
  const b = batches.get(key);
  inFlight.delete(photoId);
  if (!b) return;
  b.ids = b.ids.filter((id) => id !== photoId);
  if (!b.ids.length && b.pending <= 1) { clearTimeout(b.timer); batches.delete(key); return; }
  cancelBatchDone(key);
}
export function cancelBatchDone(key) {
  const b = batches.get(key);
  if (!b) return;
  b.pending -= 1;
  if (b.pending > 0) return;
  b.timer = setTimeout(() => {
    if (batches.get(key) !== b || b.pending > 0) return;
    batches.delete(key);
    sendBatchReply(b.chatId, b.ids)
      .catch((e) => console.error('[cancellations] batch reply:', e.message))
      .finally(() => { for (const id of b.ids) inFlight.delete(id); });
  }, QUIET_MS());
}
export const photoInFlight = (id) => inFlight.has(id);

/** Answer for these photos — the ones not answered yet — in one message, under the first. */
export async function sendBatchReply(chatId, photoIds) {
  const claimed = await claimCancellationPhotoReplies(photoIds);
  if (!claimed.length) return false;
  try {
    const photos = await cancellationPhotosForReply(claimed);
    const refs = photos.flatMap((p) => p.result?.rows || []);
    const rows = new Map((await getCancellationsByIds(refs.map((r) => r.id))).map((r) => [r.id, r]));
    const items = photos.map((p, i) => ({
      n: photos.length > 1 ? i + 1 : null,
      error: !p.result?.rows?.length && p.read_status === 'failed' ? (p.read_error || 'it could not be read') : null,
      why: p.read_status === 'failed' ? p.read_error || null : p.result?.hint || null,
      rows: (p.result?.rows || []).map((r) => rows.get(r.id) && { ...rows.get(r.id), ...r }).filter(Boolean),
      dupes: p.result?.dupes || [],
    }));
    const first = photos.find((p) => p.tg_message_id)?.tg_message_id || null;
    const chat = chatId ?? photos[0].tg_chat_id;
    const recorded = items.flatMap((x) => x.rows);
    const text = `${devTag()}${batchReplyText(items, { link: batchReplyNeedsLook(items) ? cancellationsLink() : null })}`;
    // "Void Batch" only when this batch put rows on the record — there is nothing to void otherwise.
    const markup = recorded.length ? { reply_markup: { inline_keyboard: [[{ text: 'Void Batch', callback_data: 'cxvoid' }]] } } : {};
    const quiet = { link_preview_options: { is_disabled: true } };
    // Photos that waited for a platform: the "Which platform?" message BECOMES the summary.
    const promptId = photos.find((p) => p.prompt_message_id)?.prompt_message_id || null;
    let messageId = null;
    if (promptId) {
      messageId = await enqueue(() => tg('editMessageText', { chat_id: chat, message_id: promptId, text, ...quiet,
        reply_markup: markup.reply_markup || { inline_keyboard: [] } }))
        .then(() => promptId, (e) => { console.warn('[cancellations] could not edit the picker into the summary:', e.message); return null; });
    }
    if (!messageId) {
      const m = await enqueue(() => tg('sendMessage', { chat_id: chat, text, ...quiet, ...markup,
        ...(first ? { reply_parameters: { message_id: first, allow_sending_without_reply: true } } : {}) }));
      messageId = Number(m?.message_id) || null;
    }
    // Which photos this message answered — what a tap on "Void Batch" voids.
    await setCancellationReplyMessage(claimed, messageId).catch((e) => console.warn('[cancellations] reply message not noted:', e.message));
    if (recorded.length) alertCancellationsLogged(recorded, { id: photos[0].sent_by_user_id, name: photos[0].sent_by });
    // Every photo no number was read off goes back, so its number can be replied onto IT.
    await sendMissedCopies(chat, photos, items).catch((e) => console.warn('[cancellations] missed copies:', e.message));
    return true;
  } catch (e) {
    await releaseCancellationPhotoReplies(claimed).catch(() => {});
    throw e;
  }
}

// ── A photo no number was read off: sent back, and answered by a reply (2026-11-26) ──
// "Type it: /sg 123456789" filled that person's OLDEST row without a number — fine for one
// missed photo, a guess for seven (the Stadium Goods slips of 2026-11-25: every barcode missed).
// So each such photo is sent back, on its own, right after the summary, and a reply TO THAT
// COPY with the number fills that photo's row: which photo is never in doubt. The whole photo,
// not a crop, and every one of them, not the first few (owner, 2026-11-26).
// The copy is the same Telegram file (its file id — nothing is uploaded again); an image that
// came "as a file" goes back as a file. A copy that can't be sent is logged, never fatal: the
// row is on the page either way.
const shoeOf = (r) => [platformLabel(r.platform), r.sku, r.size ? `size ${String(r.size).replace(/^US\s*/i, '')}` : null].filter(Boolean).join(' · ');
export async function sendMissedCopies(chatId, photos, items) {
  let sent = 0;
  for (let i = 0; i < photos.length; i += 1) {
    const p = photos[i]; const it = items[i];
    const open = (it.rows || []).find((r) => !r.order_number);
    if (!open || it.error || !p.tg_file_id) continue;
    const what = shoeOf(open);
    const caption = `${devTag()}[MISSED] ${it.n ? `Photo ${it.n}` : 'This photo'}: no order number read${what ? ` (${what})` : ''}.\nReply to this message with the order number.`;
    const body = { chat_id: chatId, caption,
      ...(p.tg_message_id ? { reply_parameters: { message_id: p.tg_message_id, allow_sending_without_reply: true } } : {}) };
    try {
      const m = await enqueue(() => (p.as_file ? tg('sendDocument', { ...body, document: p.tg_file_id }) : tg('sendPhoto', { ...body, photo: p.tg_file_id })));
      const id = Number(m?.message_id) || null;
      if (id) { await setCancellationAskMessage(p.id, id); sent += 1; }
    } catch (e) {
      console.warn(`[cancellations] photo ${p.id} could not be sent back:`, e.message);
    }
  }
  return sent;
}
/**
 * A text message that REPLIES to one of those copies → what to answer, or null when the
 * message it replies to is not a copy (the caller carries on as before). The number is taken
 * as typed — never corrected — checked for a duplicate, and matched against our orders for
 * the shoe, like any typed number; it fills THAT photo's row.
 * → { text, filled }: `filled` = the number is on the row now (the caller marks the reply and
 * the copy with a 👍, so a list of copies shows at a glance which are done).
 */
export async function fileMissedReply({ chatId, replyTo, text, who, tgMessageId = null }) {
  const photo = await cancellationPhotoByAskMessage(chatId, replyTo);
  if (!photo) return null;
  const { open, filled } = await cancellationRowsOfPhoto(photo.id);
  if (!open) {
    return { filled: false, text: filled
      ? `That photo already has its order number: #${filled.order_number} (row #${filled.id}). To change it, edit the row on the Cancellations page.`
      : "That photo's row was removed. Send the photo again if the order still has to be cancelled." };
  }
  // "/sg AMA00386134" is taken too; the platform is the row's own unless it had none.
  const words = splitCommand(text);
  const out = await fileTypedCancellation(words.rest, { who, platform: open.platform || words.platform || null, fillRowId: open.id, tgChatId: chatId, tgMessageId });
  if (!out) return { filled: false, text: "I couldn't find an order number in that. Reply to the photo with just the number." };
  return { filled: out.rows.some((r) => r.filled), text: typedReplyText(out) };
}

/** Where the page is, for the summary's "check them" line (APP_BASE_URL; null = no link, just the words). */
export const cancellationsLink = () => {
  const base = env('APP_BASE_URL').replace(/\/+$/, '');
  return /^https?:\/\//.test(base) ? `${base}/cancellations` : null;
};

// ── A photo with NO platform: ask once, with buttons (2026-11-20) ────────────────────
// The photo row is already written and HELD (held_at) — that is what survives a restart.
// What lives in memory is only the short wait that turns "three photos in three seconds"
// into ONE question: each new photo restarts the timer, and when it fires the question is
// sent (or, if that person already has one open, updated with the new count). Per person
// per chat, one at a time (`chain`), so two timers can never both send a question. Entries
// delete themselves when they fire; nothing is left behind.
//
// Nobody taps: after HOLD_SEC the sweep lets the photos go and reads them with no platform
// (what happened to every such photo before) — a request is never lost to an unanswered question.
const ASK_MS = () => {
  const n = Number(env('CANCEL_ASK_MS'));
  return Number.isFinite(n) && n >= 100 && n <= 30_000 ? n : 1200;
};
export const HOLD_SEC = () => {
  const n = Number(env('CANCEL_HOLD_SEC'));
  return Number.isFinite(n) && n >= 30 && n <= 6 * 3600 ? n : 600;
};
const asks = new Map();          // `${chat}:${app user}` → { timer, chain }
// Since 2026-11-21 a photo with no platform is READ first (our Shopify orders, the number's
// shape and the slip's words usually say whose it is) and asked about only when that fails.
// While more of that person's photos are still being read the question waits, so five photos
// are one question about the ones that need it — not one per photo as each read finishes.
const reading = new Map();       // `${chat}:${app user}` → photos of theirs being read now
export function cancelReading(chatId, userId, delta) {
  const key = `${chatId}:${userId}`;
  const n = Math.max(0, (reading.get(key) || 0) + delta);
  if (n) reading.set(key, n); else reading.delete(key);
}
export const askText = (n, name) => `${n === 1 ? '1 photo' : `${n} photos`}${name ? ` from ${name}` : ''} — I couldn't tell the platform. Which is it?\n`
  + 'Tap one (or send the command, e.g. /alias). Nothing is recorded until then.';
export function askPlatformSoon(chatId, userId) {
  const key = `${chatId}:${userId}`;
  let a = asks.get(key);
  if (!a) { a = { timer: null, chain: Promise.resolve() }; asks.set(key, a); }
  clearTimeout(a.timer);
  a.timer = setTimeout(() => {
    a.timer = null;
    if (reading.get(key)) return askPlatformSoon(chatId, userId);   // more of theirs still being read
    a.chain = a.chain.then(() => askPlatform(chatId, userId))
      .catch((e) => console.error('[cancellations] platform question:', e.message))
      .finally(() => { if (asks.get(key) === a && !a.timer) asks.delete(key); });
  }, ASK_MS());
  a.timer.unref?.();
}
/** Send (or update) the "Which platform?" question for what this person has waiting. */
export async function askPlatform(chatId, userId) {
  const held = await heldCancellationPhotos(chatId, userId);
  if (!held.length) return null;               // a command or a tap got there first
  const text = `${devTag()}${askText(held.length, held[0].sent_by)}`;
  const keyboard = { inline_keyboard: pickerKeyboard() };
  const open = held.find((p) => p.prompt_message_id)?.prompt_message_id || null;
  const fresh = held.filter((p) => !p.prompt_message_id).map((p) => p.id);
  if (open) {
    if (!fresh.length) return open;
    await setCancellationPrompt(fresh, open);
    // "message is not modified" and a deleted question are both fine: the photos are attached.
    await enqueue(() => tg('editMessageText', { chat_id: chatId, message_id: open, text, reply_markup: keyboard })).catch(() => null);
    return open;
  }
  const m = await enqueue(() => tg('sendMessage', { chat_id: chatId, text, reply_markup: keyboard,
    ...(held[0].tg_message_id ? { reply_parameters: { message_id: held[0].tg_message_id, allow_sending_without_reply: true } } : {}) }));
  const id = Number(m?.message_id) || null;
  if (id) await setCancellationPrompt(held.map((p) => p.id), id);
  return id;
}
/**
 * Photos just released with a platform (a tap, or a command after the photos): read them as
 * ONE batch. `rows` = what the release returned. Returns at once; the reads run behind.
 */
export function readReleasedPhotos(rows, platform, batchKey) {
  if (!rows.length) return;
  const chatId = rows[0].tg_chat_id;
  for (const p of rows) cancelBatchStart(batchKey, chatId, p.id);
  setImmediate(async () => {
    for (const p of rows) {
      try {
        await readTelegramPhoto({ id: p.id, fileId: p.tg_file_id, chatId, messageId: p.tg_message_id, caption: p.caption || null,
          platform, who: { id: p.sent_by_user_id, name: p.sent_by } });
      } finally {
        cancelBatchDone(batchKey);
      }
    }
  });
}

/** Read one photo that came in on Telegram (its row already written) — the live path and the sweep. */
export async function readTelegramPhoto(p, { resolvePlatform = null, requirePlatform = false } = {}) {
  inFlight.add(p.id);
  try {
    const buf = await downloadTelegramFile(p.fileId);
    return await fileCancellationPhoto(buf, { photoId: p.id, who: p.who, caption: p.caption || null, platform: p.platform || null,
      resolvePlatform, requirePlatform, tgChatId: p.chatId, tgMessageId: p.messageId });
  } catch (e) {
    console.error('[cancellations] photo:', e.message);
    await setCancellationPhotoRead(p.id, { status: 'failed', error: e.message.slice(0, 300), result: { rows: [], dupes: [], error: e.message.slice(0, 300) } }).catch(() => {});
    return { photoId: p.id, rows: [], dupes: [], error: e.message };
  }
}

/**
 * After a restart (or anything that dropped a batch): re-read photos whose read never
 * finished, then answer every photo still unanswered, one message per person per chat.
 */
export async function sweepCancellationPhotos(opts = {}) {
  // A "Which platform?" nobody answered: let those photos go — they are read below with no
  // platform, and the question is rewritten into their summary.
  await expireHeldCancellationPhotos(opts.holdSec ?? HOLD_SEC()).catch((e) => console.warn('[cancellations] held photos:', e.message));
  const { stuck } = await strandedCancellationPhotos(opts);
  let reread = 0;
  for (const p of stuck.filter((x) => !inFlight.has(x.id))) {
    try {
      // Rows already recorded for it (the crash came after): just mark it read.
      const ids = await cancellationIdsForPhoto(p.id);
      if (ids.length) {
        await setCancellationPhotoRead(p.id, { status: 'read', result: { rows: ids.map((id) => ({ id })), dupes: [] } });
      } else {
        await readTelegramPhoto({ id: p.id, fileId: p.tg_file_id, chatId: p.tg_chat_id, messageId: p.tg_message_id, caption: p.caption,
          platform: p.platform, who: { id: p.sent_by_user_id, name: p.sent_by } });
      }
      reread += 1;
    } finally { inFlight.delete(p.id); }
  }
  const { unanswered } = await strandedCancellationPhotos(opts);
  const groups = new Map();
  for (const p of unanswered.filter((x) => !inFlight.has(x.id))) {
    const k = `${p.tg_chat_id}:${p.sent_by_user_id}`;
    if (!groups.has(k)) groups.set(k, { chatId: p.tg_chat_id, ids: [] });
    groups.get(k).ids.push(p.id);
  }
  let answered = 0;
  for (const g of groups.values()) {
    try { if (await sendBatchReply(g.chatId, g.ids)) answered += 1; } catch (e) { console.error('[cancellations] sweep reply:', e.message); }
  }
  return { reread, answered };
}

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
/** /report → the day's recorded rows as a CSV (what the page lists for that day). */
export async function sendDayReport(chatId, ymd) {
  const rows = await listCancellationsForDay(ymd);
  if (!rows.length) return false;
  const c = dayCounts(rows);
  const per = PLATFORMS.filter((p) => c.by[p.key]).map((p) => `${p.label} ${c.by[p.key]}`).join(' · ');
  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  await sendAlertDocument(chatId, {
    html: esc(`Cancellations ${dayName(ymd)}: ${rows.length} row${rows.length === 1 ? '' : 's'}${per ? ` — ${per}` : ''}`),
    filename: `cancellations-${ymd}.csv`, content: cancellationsCsv(rows), type: 'text/csv',
  });
  return true;
}
