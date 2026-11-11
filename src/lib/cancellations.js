// Order cancellations — the rules both sides use (docs/context/cancellations.md).
// Pure: the server runs these on what was read off a photo, and the page runs them on what
// a person typed, so the two can't mean different things.
//
// Since 2026-11-12 (owner: "no verification anymore — just record it") a row is simply
// RECORDED: order number + platform + the shoe (name, SKU, size). The reader is still a
// READER, not a decider — it never guesses a number it didn't see, and a detail it can't
// find stays blank. What makes a number certain is OUR OWN order records: a number that
// matches one of our eBay / SHEIN / pre-sell orders is confirmed, and the shoe comes from
// that order (matchOurOrder, detailsFromOrder).
import { toCsv } from './manifestCsv.js';
import { estDate, estTime } from './format.js';

// `pattern` only where we KNOW the platform's order-number shape — a wrong pattern would
// flag every real number, so an unknown shape is simply not checked.
// `cmd` = the Telegram command that names it (/alias + the photo) — the owner's list,
// 2026-10-20: Stadium Goods is /sg and Kicks Crew is /kc, nothing longer.
export const PLATFORMS = [
  { key: 'alias', label: 'Alias', cmd: 'alias' },
  { key: 'stockx', label: 'StockX', cmd: 'stockx', pattern: /^\d{8}-\d{8}$/, shape: '12345678-12345678' },
  { key: 'ebay', label: 'eBay', cmd: 'ebay', pattern: /^\d{2}-\d{5}-\d{5}$/, shape: '12-34567-89012' },
  { key: 'temu', label: 'Temu', cmd: 'temu' },
  { key: 'tiktok', label: 'TikTok Shop', cmd: 'tiktok' },
  { key: 'shein', label: 'SHEIN', cmd: 'shein' },
  { key: 'sg', label: 'Stadium Goods', cmd: 'sg' },
  { key: 'kc', label: 'Kicks Crew', cmd: 'kc' },
];
/** "/alias", "/SG@StickballBot" → its platform key; anything else → null. */
export function platformFromCommand(word) {
  const m = /^\/([a-z]+)(?:@\w+)?$/i.exec(String(word || '').trim());
  return m ? PLATFORMS.find((p) => p.cmd === m[1].toLowerCase())?.key || null : null;
}
const BY_KEY = Object.fromEntries(PLATFORMS.map((p) => [p.key, p]));
export const platformLabel = (k) => BY_KEY[k]?.label || (k ? String(k) : '');
export const isPlatform = (k) => !!BY_KEY[k];

// The status column no longer drives anything (2026-11-12): new rows keep 'to_review', the
// old rows keep what review gave them, and 'rejected' is a row someone REMOVED (not an
// order to cancel) — never listed, never in a message.
export const STATUSES = {
  to_review: 'Recorded',
  verified: 'Verified — to cancel',
  submitted: 'Cancelled on platform',
  rejected: 'Removed',
};

// What each flag means, said the way the reviewer acts on it.
export const FLAGS = {
  unreadable: 'Photo could not be read — type the number from the picture',
  no_number: 'No order number',
  short_number: 'Order number looks too short',
  format: 'Number does not look like this platform’s order numbers',
  no_platform: 'Platform not recognised',
  low_confidence: 'The reader was not sure — compare with the photo',
  reads_disagree: 'Two reads of the photo gave different numbers — check every digit',
  unchecked: 'Only one read of the photo worked — check every digit',
  unclear: 'The order number was hard to read on the photo',
  submit_failed: 'Cancelling on the platform failed — see the note',
};
// Hard flags block Verify; the rest are "look closely", and verifying is that look.
export const BLOCKING = ['unreadable', 'no_number', 'short_number', 'no_platform'];

/** The order number as written, tidied: trimmed, upper-cased, inner spaces and a leading # dropped. */
export function cleanOrderNo(v) {
  return String(v ?? '').trim().toUpperCase().replace(/^#+/, '').replace(/\s+/g, '').slice(0, 60);
}
/** The duplicate key: letters and digits only. "12-34567-89012" and "123456789012" are one order. */
export function orderKey(v) {
  const k = cleanOrderNo(v).replace(/[^A-Z0-9]/g, '');
  return k || null;
}

/**
 * The flags a row's CURRENT fields earn. `ai` adds the reader's own doubts (confidence,
 * fields it said were unclear) — those are dropped as soon as a person edits the row.
 */
export function flagsFor(row, ai = null) {
  const f = [];
  const num = cleanOrderNo(row?.order_number);
  const key = orderKey(num);
  if (!key) f.push('no_number');
  else if (key.length < 6) f.push('short_number');
  if (!isPlatform(row?.platform)) f.push('no_platform');
  const p = BY_KEY[row?.platform];
  if (key && p?.pattern && !p.pattern.test(num)) f.push('format');
  if (ai) {
    if (ai.unreadable) f.push('unreadable');
    if (Number(ai.confidence) < 0.95 && key) f.push('low_confidence');
    // readTwice: the second, independent read did not find this same number.
    if (key && ai.agreed === false) f.push('reads_disagree');
    if (key && ai.agreed === null) f.push('unchecked');
    // Only a doubt about what gets CANCELLED counts — a blurred SKU or size on a clear
    // order number is not a reason to make someone re-check the number.
    if (key && Array.isArray(ai.unclear) && ai.unclear.some((x) => /order|number|platform/i.test(x))) f.push('unclear');
  }
  return [...new Set(f)];
}
export const blockingFlags = (flags) => (flags || []).filter((x) => BLOCKING.includes(x));

/** A style code as printed → the usual form: "CZ1884 010" → "CZ1884-010". Anything else, upper-cased. */
export function cleanSku(v) {
  const s = String(v ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
  if (!s) return null;
  const m = /^([A-Z0-9]{5,7})[\s-]+([A-Z0-9]{3})$/.exec(s);
  return (m ? `${m[1]}-${m[2]}` : s).slice(0, 40);
}

// ── Reading a photo WITHOUT AI (owner, 2026-11-10) ───────────────────────────────────
// tesseract (api/_lib/cancelOcr.js) turns the picture into lines of text; these rules pick
// the order number(s) out of that text. A READER, never a decider: what it didn't see stays
// blank, and the strongest check comes after — the number against OUR orders (matchOurOrder).
// What counts as an order number, strongest first:
//   1. the platform's own shape where we know it (StockX 12345678-12345678, eBay 12-34567-89012,
//      SHEIN GS + 11-15 letters/digits — read only, never used to flag a typed number);
//   2. a number after "Order #", "Order No.", "Order number", "Order ID" (same line or the next);
//   3. an Alias packing label: the order number is printed large on a line of its OWN, 9-10
//      digits, while the "ORDER #" caption above it is too small to read. Taken only when the
//      picture is a packing label (a style code on it, "alias"/"goat" in it, or /alias sent).
//      A "/" inside that line is a 7 (measured: two of eight preparations of the real label
//      of 2026-10-20 read 176889923 as "1/6889923").
// Never a tracking number (1Z…, 92/93/94… USPS, a "TRK#" or "TRACKING" line), a phone or a ZIP.
const ORDER_WORD = /\b(?:order|ord)\s*(?:#|no\.?|number|num|id)?\s*[:#]?\s*/i;
const TRACKING_LINE = /\b(?:trk|tracking|track(?:ing)?\s*#|ups|usps|fedex)\b/i;
const looksLikeTracking = (k) => /^1Z[0-9A-Z]{14,16}$/.test(k) || /^9[2-5]\d{18,24}$/.test(k) || /^\d{20,}$/.test(k);
// OCR's usual misreads INSIDE a number: O→0, I/l/|→1, S→5, B→8 — applied only to a token
// that is already mostly digits, so a word never turns into a number.
function fixDigits(tok) {
  const t = String(tok || '').replace(/[‐-―]/g, '-');
  const digits = (t.match(/\d/g) || []).length;
  if (digits < Math.max(4, t.replace(/-/g, '').length - 2)) return t;
  // A letter prefix ("PO-211-…", "GSH…") is part of the number: only what follows is fixed.
  const pre = /^[A-Za-z]+-?/.exec(t)?.[0] || '';
  return pre + t.slice(pre.length).replace(/[Oo]/g, '0').replace(/[Il|]/g, '1').replace(/S/g, '5').replace(/B/g, '8');
}
const STYLE_CODE = /\b([A-Z]{1,3}\d{3,5})[\s-]?(\d{3})\b/;
const SIZE_RE = /\bUS\s*([MW])?\s*(\d{1,3}(?:[.,]5)?)\s*([MWY])?\b/i;
// OCR drops the point in "9.5" often; no shoe is a size 95, so 95 → 9.5 and 105 → 10.5.
const fixSize = (v) => {
  const t = String(v).replace(',', '.');
  return !t.includes('.') && Number(t) > 22 && t.endsWith('5') ? `${t.slice(0, -1)}.5` : t;
};
// Every token that is mostly digits, fixed (fixDigits) — the words around it left alone.
const fixLine = (line) => line.split(' ').map(fixDigits).join(' ');
// A SHEIN order number: "GS" + 11-15 letters and digits (GSON8F44T00000N, GSHNMD35M00HHAC).
// Letters are part of it, so fixDigits never touches it; an OCR "G5" for "GS" is put back.
const SHEIN_NO = /\bG[S5][A-Z0-9]{11,15}\b/g;
const sheinLike = (t) => (t.match(/\d/g) || []).length >= 4 && (t.match(/[A-Z]/g) || []).length >= 3;

// The shoe's NAME on an Alias packing label is the line under the small "ITEM" caption
// ("Nike Free Run 5.0 'Phantom Sail'"). It is the smallest print on the label and a phone
// photo often cuts it ("ke Air Max 90 A"), so a line is taken only when it reads whole:
// right under "ITEM", or carrying a quoted colourway — and starting with a capital, ≥ 3
// words, nothing but name characters. Anything less stays blank (never a half name).
const NAME_CHARS = /^[A-Z][A-Za-z0-9 .'‘’"“”()&/+-]{8,90}$/;
const QUOTED = /['‘’"“”][A-Za-z0-9][^'‘’"“”]{1,40}['‘’"“”]\s*$/;
// Every quote mark → the plain ' Nike writes a colourway in. OCR reads the same ' as ’, ‘ or
// even " depending on the font (Linux CI read 'Anthracite Team Red' as "Anthracite Team Red").
const plainQuotes = (s) => s.replace(/[‘’"“”]/g, "'");
export function labelProduct(lines) {
  const ok = (l) => !!l && NAME_CHARS.test(l) && l.split(' ').length >= 3 && !TRACKING_LINE.test(l) && !/\d{6,}/.test(l);
  for (let i = 0; i < lines.length; i++) {
    const m = /^ITEM\b[:\s]*(.*)$/i.exec(lines[i]);
    if (!m) continue;
    const cand = (m[1] || lines[i + 1] || '').trim();
    if (ok(cand)) return plainQuotes(cand);
  }
  const q = lines.find((l) => ok(l) && QUOTED.test(l));
  return q ? plainQuotes(q) : null;
}

/**
 * Tracking numbers printed on a label → digits/letters only. The order is found by it when
 * the label prints no order number (an eBay FedEx label prints only "TRK# 8790 6081 3551" —
 * eBay keeps that number on the order). UPS 1Z…, a "TRK#" line (FedEx), USPS 92-95….
 */
export function trackingFromText(text) {
  const out = new Set();
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.toUpperCase();
    for (const m of line.replace(/\s+/g, ' ').matchAll(/\b[1I]Z\s?([0-9A-Z]{16})\b/g)) out.add(`1Z${m[1]}`);
    const trk = /\bTRK\s*#?\s*:?\s*((?:\d\s?){12,22})/.exec(line);
    if (trk) out.add(trk[1].replace(/\s/g, ''));
    for (const m of line.matchAll(/\b(9[2-5](?:\s?\d){18,24})\b/g)) out.add(m[1].replace(/\s/g, ''));
  }
  return [...out];
}

/**
 * OCR text → [{ platform, order_number, sku, size, why }]. `hint` = the platform the sender
 * named. Pure, so the rules are tested without a picture (e2e/cancellations.spec.js).
 */
export function ordersFromText(text, hint = null) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const all = lines.join('\n');
  const found = new Map();   // key → { order_number, platform, why }
  const add = (num, platform, why) => {
    const n = cleanOrderNo(num);
    const k = orderKey(n);
    if (!k || (k.match(/\d/g) || []).length < 6 || looksLikeTracking(k)) return;
    if (!found.has(k)) found.set(k, { order_number: n, platform, why });
  };
  for (const line of lines) {
    if (TRACKING_LINE.test(line)) continue;
    for (const m of line.toUpperCase().matchAll(SHEIN_NO)) {
      const n = `GS${m[0].slice(2)}`;
      if (sheinLike(n)) add(n, 'shein', 'shape');
    }
  }
  for (const p of PLATFORMS.filter((x) => x.pattern)) {
    const loose = new RegExp(p.pattern.source.replace(/^\^|\$$/g, '').replace(/-/g, '\\s?-\\s?'), 'g');
    for (const line of lines) {
      if (TRACKING_LINE.test(line)) continue;
      for (const m of fixLine(line).matchAll(loose)) add(m[0].replace(/\s/g, ''), p.key, 'shape');
    }
  }
  lines.forEach((line, i) => {
    const m = ORDER_WORD.exec(line);
    if (!m || TRACKING_LINE.test(line)) return;
    const after = line.slice(m.index + m[0].length).trim();
    const tok = (after || lines[i + 1] || '').split(' ')[0];
    const n = fixDigits(tok).replace(/[^A-Za-z0-9-]/g, '');
    // Already found whole by its shape ("12345678-12345678" with a space in it): not a second order.
    const k = orderKey(n);
    if (k && ![...found.keys()].some((f) => f.includes(k))) add(n, null, 'order #');
  });
  const packingLabel = hint === 'alias' || STYLE_CODE.test(all) || /\b(alias|goat)\b/i.test(all);
  if (packingLabel) {
    for (const line of lines) {
      let t = fixDigits(line.replace(/[|.,;:'"`]+$/g, '').replace(/^[|.,;:'"`]+/g, '').trim()).replace(/\s/g, '');
      if (/^\d+\/\d+$/.test(t) && t.length >= 9 && t.length <= 10) t = t.replace('/', '7');
      if (/^\d{9,10}$/.test(t)) add(t, null, 'label');
    }
  }
  const orders = [...found.values()].map((o) => ({ ...o, platform: hint || o.platform || null }));
  // A style code, size and name belong to the order only when the picture shows ONE order.
  let sku = null; let size = null; let product = null;
  if (orders.length === 1) {
    const s = STYLE_CODE.exec(all.toUpperCase());
    sku = s ? cleanSku(`${s[1]}-${s[2]}`) : null;
    const z = SIZE_RE.exec(all);
    size = z ? `US ${z[1] ? `${z[1].toUpperCase()} ` : ''}${fixSize(z[2])}${z[3] ? z[3].toUpperCase() : ''}` : null;
    product = labelProduct(lines);
  }
  return orders.map((o) => ({ ...o, sku, size, product }));
}

/** Guess the platform from the number's shape alone — for a number typed to the bot. */
export function platformFromNumber(v) {
  const n = cleanOrderNo(v);
  return PLATFORMS.find((p) => p.pattern && p.pattern.test(n))?.key || null;
}

// ── Matching a read number to OUR orders (2026-11-12) ────────────────────────────────
// eBay orders (ebay_orders), SHEIN orders (shein_order_units) and pre-sell Alias / StockX
// sales (presell_sales) are ours, number and shoe. A number that matches one is CERTAIN, and
// the shoe comes from it. One that is a single OCR slip away from exactly one of them is put
// right — but only a LETTER read for a DIGIT or back (0/O, 1/I, 1/L, 5/S, 8/B, 2/Z, 6/G).
// Never digit for digit (1/7, 3/8): most Alias orders are not in our records, so a CORRECT
// read of one of those could otherwise be "corrected" onto a neighbouring real order — and
// the wrong order cancelled.
const CONFUSABLE = [['0', 'O'], ['1', 'I'], ['1', 'L'], ['5', 'S'], ['8', 'B'], ['2', 'Z'], ['6', 'G']];
const SWAP = new Map();
for (const [a, b] of CONFUSABLE) { SWAP.set(a, [...(SWAP.get(a) || []), b]); SWAP.set(b, [...(SWAP.get(b) || []), a]); }
/** Every key one confusable character away from this one (the key itself not included). */
export function confusableKeys(v) {
  const k = orderKey(v);
  if (!k) return [];
  const out = new Set();
  for (let i = 0; i < k.length; i++) for (const c of SWAP.get(k[i]) || []) out.add(k.slice(0, i) + c + k.slice(i + 1));
  out.delete(k);
  return [...out];
}

/**
 * The read number against our orders. `known` = [{ key, order_id, platform, source, lines }]
 * (whatever the lookup found for this number and its confusable neighbours). A platform the
 * sender named limits it to that platform's orders. → { order, corrected } or null.
 * Exact beats near; near only when exactly ONE order is that close.
 */
export function matchOurOrder(read, platform, known) {
  const k = orderKey(read);
  if (!k) return null;
  const mine = (known || []).filter((o) => !platform || o.platform === platform);
  const exact = mine.find((o) => o.key === k);
  if (exact) return { order: exact, corrected: false };
  const near = new Set(confusableKeys(k));
  const close = [...new Map(mine.filter((o) => near.has(o.key)).map((o) => [o.key, o])).values()];
  return close.length === 1 ? { order: close[0], corrected: true } : null;
}

const sizeNum = (v) => { const m = /(\d{1,2}(?:\.5)?)/.exec(String(v ?? '').replace(/^US\s*[MW]?\s*/i, '')); return m ? m[1] : ''; };
/**
 * The shoe from one of our orders. One line → that line. Several (an eBay order of two
 * pairs) → the line the photo's SKU / size points at; else every line, joined — never a
 * guess at which one.
 */
export function detailsFromOrder(order, read = {}) {
  const lines = (order?.lines || []).filter((l) => l && (l.name || l.sku || l.size));
  if (!lines.length) return null;
  const pick = (l) => ({ product: l.name || null, sku: l.sku || null, size: l.size || null });
  if (lines.length === 1) return pick(lines[0]);
  const rk = orderKey(read.sku); const rs = sizeNum(read.size);
  const hit = lines.filter((l) => (!rk || orderKey(l.sku) === rk) && (!rs || sizeNum(l.size) === rs));
  if ((rk || rs) && hit.length === 1) return pick(hit[0]);
  const join = (k) => [...new Set(lines.map((l) => l[k]).filter(Boolean))].join(' + ') || null;
  return { product: join('name'), sku: join('sku'), size: join('size') };
}

/** The style code in a SKU or a title ("DD1391-100", "CZ1884 010") → "DD1391-100", else null. */
export function styleIn(v) {
  const s = STYLE_CODE.exec(String(v ?? '').toUpperCase());
  return s ? cleanSku(`${s[1]}-${s[2]}`) : null;
}

/**
 * What follows a typed number: "/alias 206557037 DD1391-100 9.5 customer asked" →
 * { sku: 'DD1391-100', size: '9.5', reason: 'customer asked' }. A size is taken only after a
 * style code, written "size 9.5" / "US 9.5", or standing first ("206557037 9.5") — "called 2
 * times" is not a size 2.
 */
export function typedDetails(rest) {
  let t = ` ${String(rest ?? '').trim()} `;
  let sku = null; let size = null;
  const s = STYLE_CODE.exec(t.toUpperCase());
  if (s) { sku = cleanSku(`${s[1]}-${s[2]}`); t = `${t.slice(0, s.index)} ${t.slice(s.index + s[0].length)}`; }
  const sizeRe = sku || /^\s\d{1,2}(?:\.5)?[MWYC]?(?=[\s,;]|$)/i.test(t)
    ? /\s(?:size\s*)?(?:US\s*)?([MW]\s*)?(\d{1,2}(?:\.5)?)([MWYC])?(?=[\s,;]|$)/i
    : /\s(?:size\s*|US\s*)([MW]\s*)?(\d{1,2}(?:\.5)?)([MWYC])?(?=[\s,;]|$)/i;
  const z = sizeRe.exec(t);
  if (z && Number(z[2]) >= 1 && Number(z[2]) <= 22) {
    size = `${z[1] ? `${z[1].trim().toUpperCase()} ` : ''}${z[2]}${z[3] ? z[3].toUpperCase() : ''}`;
    t = `${t.slice(0, z.index)} ${t.slice(z.index + z[0].length)}`;
  }
  const reason = t.replace(/\s+/g, ' ').trim().replace(/^[-–:,]\s*/, '').replace(/[\s,;:–-]+$/, '').trim() || null;
  return { sku, size, reason };
}

// Where a row's shoe details came from (cancellations.details_from, comma-separated).
export const DETAILS_FROM = {
  ebay: 'our eBay order', shein: 'our SHEIN order', presell: 'our pre-sell sale',
  label: 'the photo', catalogue: 'our catalogue (by SKU)', typed: 'typed', edited: 'edited by hand',
};
export const detailsFromLabel = (v) => String(v || '').split(',').map((k) => DETAILS_FROM[k.trim()] || k.trim()).filter(Boolean).join(' + ');

// ── The bot's answer: ONE message per batch of photos, as a reply to the first ─────────
// e.g.
//   Alias · 2 orders recorded
//   1. #206557037 — Nike Free Run 5.0 'Phantom Sail' · CZ1884-010 · size 8.5
//   2. #176889923 — DQ4071-001 · size 9.5
//
//   ⚠️ Photo 3: no order number found — it's kept with the photo. Type it: /alias 123456789 (it fills that photo's row)
//   ↩️ #206557037 is already logged as #12 by Karon — not added again
const sizeWord = (v) => (v ? `size ${shortSize(v)}` : null);
export function orderLine(r) {
  const what = [r.product, r.sku, sizeWord(r.size)].filter(Boolean).join(' · ');
  const read = r.read_as ? ` (read as ${r.read_as})` : '';
  const how = r.by_tracking ? ' (found by its tracking number)' : '';
  return `#${String(r.order_number).replace(/^#+/, '')} — ${what || 'no shoe details found'}${read}${how}`;
}
const cmdOf = (k) => `/${BY_KEY[k]?.cmd || 'alias'}`;
/**
 * `photos` = [{ n, rows, dupes:[{ order_number, existing:{ id, sent_by } }], error, why }] in the
 * order they were sent (n = 1-based position; null for a typed number). Rows with an order
 * number are listed per platform; a row without one is that photo's "no order number" line.
 */
export function batchReplyText(photos) {
  const listed = []; const warn = []; const dup = [];
  for (const p of photos || []) {
    const where = p.n ? `Photo ${p.n}` : 'This photo';
    if (p.error) { warn.push(`⚠️ ${where}: not saved (${p.error}) — send it again.`); continue; }
    for (const r of p.rows || []) {
      if (r.order_number) listed.push(r);
      else warn.push(`⚠️ ${where}: no order number found${p.why ? ` (${p.why})` : ''} — it's kept with the photo. Type it: ${cmdOf(r.platform)} 123456789 (it fills that photo's row)`);
    }
    for (const d of p.dupes || []) {
      dup.push(`↩️ #${d.order_number} is already logged as #${d.existing?.id}${d.existing?.sent_by ? ` by ${d.existing.sent_by}` : ''} — not added again`);
    }
  }
  const out = [];
  for (const k of [...PLATFORMS.map((p) => p.key), null]) {
    const mine = listed.filter((r) => (k == null ? !isPlatform(r.platform) : r.platform === k));
    if (!mine.length) continue;
    if (out.length) out.push('');
    out.push(`${k ? platformLabel(k) : 'No platform'} · ${mine.length} order${mine.length === 1 ? '' : 's'} recorded`);
    mine.forEach((r, i) => out.push(`${i + 1}. ${orderLine(r)}`));
  }
  if (!listed.length) out.push(dup.length && !warn.length ? 'Nothing new recorded.' : 'No orders recorded yet.');
  if (warn.length || dup.length) out.push('', ...warn, ...dup);
  if (listed.some((r) => !isPlatform(r.platform))) out.push('', 'Tip: send the platform first — e.g. /alias, then the photos.');
  const text = out.join('\n');
  return text.length > 4000 ? `${text.slice(0, 3990)}\n…` : text;
}

// ── The page: EST days ───────────────────────────────────────────────────────────────
const addDaysYmd = (d, n) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
export const CX_PERIODS = [['today', 'Today'], ['yesterday', 'Yesterday'], ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['day', 'Pick a day'], ['range', 'Date range'], ['all', 'All time']];
const isYmd = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
/** A period on the page → the EST days it covers, { from, to } (null = open). `today` = estToday(). */
export function periodDays(period, today, a = '', b = '') {
  if (period === 'yesterday') { const y = addDaysYmd(today, -1); return { from: y, to: y }; }
  if (period === '7' || period === '30') return { from: addDaysYmd(today, -(Number(period) - 1)), to: today };
  if (period === 'day') return isYmd(a) ? { from: a, to: a } : { from: today, to: today };
  if (period === 'range') {
    const f = isYmd(a) ? a : null; const t = isYmd(b) ? b : null;
    return f && t && f > t ? { from: t, to: f } : { from: f, to: t };
  }
  if (period === 'all') return { from: null, to: null };
  return { from: today, to: today };
}

// The export: what was recorded, in the order it was sent.
const when = (t) => (t ? `${estDate(t)} ${estTime(t)}` : '');
const CSV_COLS = [
  ['sent', 'Sent (EST)'], ['platform', 'Platform'], ['order_number', 'Order number'], ['product', 'Shoe'], ['sku', 'SKU'],
  ['size', 'Size'], ['sent_by', 'Sent by'], ['reason', 'Reason'], ['details', 'Details from'], ['note', 'Note'], ['id', 'ID'],
];
export function cancellationsCsv(rows) {
  return toCsv(CSV_COLS, (rows || []).map((r) => ({
    ...r, platform: platformLabel(r.platform), sent: when(r.created_at), details: detailsFromLabel(r.details_from),
  })));
}

// ── The end-of-shift message (Telegram /msg, /msgall) ────────────────────────────────
// What gets pasted to each platform:
//   Alias
//   Please cancel the following order(s):
//   #206557037 - CZ1884-010 size 8.5
// A row with no order number can't be asked for — it's counted, not listed.
const shortSize = (v) => String(v ?? '').trim().replace(/^US\s*/i, '').replace(/^M\s+/i, '').trim();
export function cancelLine(r) {
  const what = [r.sku, r.size ? `size ${shortSize(r.size)}` : ''].filter(Boolean).join(' ');
  return `#${String(r.order_number).replace(/^#+/, '')}${what ? ` - ${what}` : ''}`;
}
export function cancelMessage(platform, rows) {
  const mine = (rows || []).filter((r) => r.platform === platform && r.order_number);
  if (!mine.length) return null;
  return [platformLabel(platform), 'Please cancel the following order(s):', ...mine.map(cancelLine)].join('\n');
}
/** Every platform with rows, in PLATFORMS order, one block each. */
export function cancelMessageAll(rows) {
  return PLATFORMS.map((p) => cancelMessage(p.key, rows)).filter(Boolean).join('\n\n') || null;
}
/** Per platform: how many can be listed, and how many still have no number / no platform. */
export function dayCounts(rows) {
  const by = {};
  for (const p of PLATFORMS) by[p.key] = 0;
  let noNumber = 0; let noPlatform = 0;
  for (const r of rows || []) {
    if (!r.order_number) noNumber += 1;
    else if (!by[r.platform] && by[r.platform] !== 0) noPlatform += 1;
    else by[r.platform] += 1;
  }
  return { by, noNumber, noPlatform };
}
