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
  cancellationIdsForPhoto,
} from './db.js';
import { estToday } from '../../src/lib/format.js';
import { notifyEnv } from './notify.js';
import { alertCancellationsLogged } from './alerts.js';
import { readCancellationLocally, canOpenImage } from './cancelOcr.js';
import { cancelMessage, cancelMessageAll, dayCounts, cancellationsCsv, batchReplyText, typedDetails } from '../../src/lib/cancellations.js';
import {
  PLATFORMS, cleanSku, cleanOrderNo, orderKey, flagsFor, platformFromNumber, platformLabel,
  confusableKeys, matchOurOrder, detailsFromOrder, trackingFromText,
} from '../../src/lib/cancellations.js';

// What the bot's "/" menu lists (scripts/telegram-webhook.mjs → setMyCommands).
export const BOT_COMMANDS = [
  ...PLATFORMS.map((p) => ({ command: p.cmd, description: `${p.label} — then send the photo(s) of the order to cancel` })),
  { command: 'msg', description: "Today's cancel message for one platform (pick it)" },
  { command: 'msgall', description: "Today's cancel messages for every platform" },
  { command: 'report', description: "Today's cancellations as a CSV file" },
];
export const HOW_TO = 'To record orders to cancel: send the platform, then the photo(s) — e.g. /alias and the pictures (or put /alias in the caption). '
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
async function lookupKnown({ keys, tracks }) {
  try { return await knownOrdersFor({ keys, tracks }); } catch (e) {
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
export async function fillDetails(orders, named, { text = '', typed = false } = {}) {
  const keys = orders.flatMap((o) => { const k = orderKey(o.order_number); return !k ? [] : typed ? [k] : [k, ...confusableKeys(k)]; });
  const tracks = typed ? [] : trackingFromText(text);
  const known = keys.length || tracks.length ? await lookupKnown({ keys, tracks }) : [];
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
    const m = order_number ? matchOurOrder(order_number, named || o.platform || null, known) : null;
    const f = { ...o, order_number, platform: named || o.platform || platformFromNumber(order_number) || null, from: [] };
    if (m && (!m.corrected || !typed)) {
      const d = detailsFromOrder(m.order, o) || {};
      f.platform = named || m.order.platform;
      if (m.corrected) {
        f.read_as = order_number;
        f.note = `Read as ${order_number} on the photo; one character off our ${platformLabel(m.order.platform)} order ${m.order.order_id}, so recorded as that.`;
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
export async function fileCancellationPhoto(buf, { photoId = null, who, caption = null, platform = null, resolvePlatform = null, tgChatId = null, tgMessageId = null }) {
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
  const found = byTracking || (read && !error ? await fillDetails(read.orders, named, { text: read.text || '' }) : []);
  const finish = async (rows, dupes, extra = {}) => {
    const result = { rows: rows.map((r) => ({ id: r.id, ...(r.read_as ? { read_as: r.read_as } : {}), ...(r.by_tracking ? { by_tracking: true } : {}) })),
      dupes: dupes.map((d) => ({ order_number: d.order_number, existing: { id: d.existing?.id, sent_by: d.existing?.sent_by || null } })), ...extra };
    await setCancellationPhotoRead(photoId, { status: error ? 'failed' : rows.some((r) => r.order_number) || dupes.length ? 'read' : 'nothing', error, result });
    return { photoId, rows, dupes, error };
  };
  // Nothing usable: still one row with the photo, so the request reaches a person.
  if (error || !found.some((o) => o.order_number)) {
    const flags = ['unreadable', 'no_number', ...(named ? [] : ['no_platform'])];
    const { row } = await createCancellation({ ...base, platform: named, flags,
      ai_raw: read ? { by: read.by, what: read.what, ...(read.text ? { text: read.text } : {}) } : { error },
      note: error ? `Could not read the photo: ${error}` : (read.what ? `Reader: ${read.what}` : null) });
    return finish(row ? [row] : [], []);
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
    const flags = flagsFor(row, o.order_match ? null : ai);
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
export async function fileTypedCancellation(text, { who, platform: given = null, tgChatId = null, tgMessageId = null }) {
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
  if (!key || (key.match(/\d/g) || []).length < 6) return null;
  const existing = await findLiveCancellation(key);
  if (existing) return { rows: [], dupes: [{ order_number, existing }] };
  const t = typedDetails(rest);
  const [o] = await fillDetails([{ order_number, platform, sku: t.sku, size: t.size, product: null }], platform, { typed: true });
  const row = { platform: o.platform, order_number: o.order_number, sku: o.sku, size: o.size, product: o.product };
  const f = { ...row, order_key: orderKey(o.order_number), flags: flagsFor(row), details_from: o.details_from, order_match: o.order_match || null };
  // "Photo 4: no order number found — type it": the number fills that photo's row.
  const open = await openUnreadCancellation(who.id, platform);
  if (open) {
    const cur = await getCancellation(open.id);
    const out = await updateCancellationFields(open.id, { ...f, platform: f.platform || cur.platform, reason: t.reason || cur.reason, note: cur.note,
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
      why: p.read_status === 'failed' ? p.read_error || null : null,
      rows: (p.result?.rows || []).map((r) => rows.get(r.id) && { ...rows.get(r.id), ...r }).filter(Boolean),
      dupes: p.result?.dupes || [],
    }));
    const first = photos.find((p) => p.tg_message_id)?.tg_message_id || null;
    await sayTo(chatId ?? photos[0].tg_chat_id, `${devTag()}${batchReplyText(items)}`, first);
    const recorded = items.flatMap((x) => x.rows);
    if (recorded.length) alertCancellationsLogged(recorded, { id: photos[0].sent_by_user_id, name: photos[0].sent_by });
    return true;
  } catch (e) {
    await releaseCancellationPhotoReplies(claimed).catch(() => {});
    throw e;
  }
}

/** Read one photo that came in on Telegram (its row already written) — the live path and the sweep. */
export async function readTelegramPhoto(p, { resolvePlatform = null } = {}) {
  inFlight.add(p.id);
  try {
    const buf = await downloadTelegramFile(p.fileId);
    return await fileCancellationPhoto(buf, { photoId: p.id, who: p.who, caption: p.caption || null, platform: p.platform || null,
      resolvePlatform, tgChatId: p.chatId, tgMessageId: p.messageId });
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
