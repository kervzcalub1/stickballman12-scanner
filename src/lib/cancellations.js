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
  // StockX has two shapes: the older 12345678-12345678 and the one its Shopify orders carry
  // now, 06-B1P9GP5N4H (two digits, then ten letters and digits — at least two letters, which
  // is what keeps a phone or a date from looking like one). Measured on the live store 2026-11-21.
  { key: 'stockx', label: 'StockX', cmd: 'stockx', pattern: /^(?:\d{8}-\d{8}|\d{2}-(?=[A-Z0-9]*[A-Z][A-Z0-9]*[A-Z])[A-Z0-9]{10})$/, shape: '12345678-12345678 or 06-B1P9GP5N4H' },
  { key: 'ebay', label: 'eBay', cmd: 'ebay', pattern: /^\d{2}-\d{5}-\d{5}$/, shape: '12-34567-89012' },
  // Temu's packing slip prints "Purchase Order ID: PO-211-00591237806711370"; the same order's
  // line number is "211-15609680886391006" — either is that order (both are in Shopify).
  { key: 'temu', label: 'Temu', cmd: 'temu', pattern: /^(?:PO-)?\d{3}-\d{15,19}$/, shape: 'PO-211-00591237806711370' },
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
// The picker's buttons (a photo sent with no platform): two rows of four, in the order the
// floor uses them most, with names short enough for four across on a phone.
const SHORT = { tiktok: 'TikTok', sg: 'SG', kc: 'KC' };
export const platformShort = (k) => SHORT[k] || platformLabel(k);
export const PICKER_ROWS = [['alias', 'stockx', 'ebay', 'shein'], ['tiktok', 'temu', 'sg', 'kc']];
/** The "Which platform?" keyboard. One tap = `cxpick:<platform>`; the message tapped says which photos. */
export const pickerKeyboard = () => PICKER_ROWS.map((row) => row.map((k) => ({ text: platformShort(k), callback_data: `cxpick:${k}` })));
/** "/alias wrong size" → { cmd:'/alias', platform:'alias', rest:'wrong size' }; "/alias@Bot" is the same command. No command → cmd null. */
export function splitCommand(text) {
  const m = /^\s*(\/[A-Za-z]+(?:@\w+)?)\s*([\s\S]*)$/.exec(String(text || ''));
  if (!m) return { cmd: null, platform: null, rest: String(text || '').trim() };
  return { cmd: m[1].replace(/@\w+$/, '').toLowerCase(), platform: platformFromCommand(m[1]), rest: m[2].trim() };
}
/**
 * The picture in a Telegram message, at its best: the largest size of a compressed photo, or
 * an image sent with "Send as File" (uncompressed — what the floor uses for small print).
 * → { fileId, uncompressed, width, height, bytes } or null when the message carries no image.
 */
export function extractImageFile(msg) {
  const sizes = Array.isArray(msg?.photo) ? msg.photo.filter((p) => p?.file_id) : [];
  if (sizes.length) {
    // Telegram lists the sizes smallest first; pick by area rather than trust the order.
    const score = (p) => (Number(p.width) || 0) * (Number(p.height) || 0) || Number(p.width) || Number(p.file_size) || 0;
    const best = sizes.reduce((a, b) => (score(b) >= score(a) ? b : a));
    return { fileId: best.file_id, uncompressed: false, width: best.width ?? null, height: best.height ?? null, bytes: best.file_size ?? null };
  }
  const d = msg?.document;
  if (d?.file_id && /^image\//i.test(String(d.mime_type || ''))) {
    return { fileId: d.file_id, uncompressed: true, width: null, height: null, bytes: d.file_size ?? null };
  }
  return null;
}
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
  not_in_shopify: 'This number is in none of our orders — most often a misread character',
  platform_guess: 'The platform was read off the slip, not named by the sender — check it',
  tie_break: 'The first two reads disagreed and a third decided — check every digit',
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
    // settleWithThird: two of three reads agreed — right far more often than not, still a look.
    if (key && ai.byThird) f.push('tie_break');
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
// A Stadium Goods ORDER number is three letters and eight digits (FAR02077818, AMA00386134) —
// which, run together, is also what a style code looks like ("FAR02077" + "818"). Live
// 2026-11-25: two slips were recorded with their own order number as the shoe's SKU. So a
// style code is one found in the text with that run taken out first.
const SG_ORDER_RUN = /\b[A-Z]{3}\d{8}\b/g;
const styleCodeIn = (upper) => STYLE_CODE.exec(String(upper || '').replace(SG_ORDER_RUN, ' '));
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
// A Temu purchase order: "PO-211-00591237806711370" (the O may read as 0, the digits in pieces).
const TEMU_NO = /(?<![A-Z0-9])P[O0]{1,2}\s?-?\s?(\d{3})\s?-\s?((?:[0-9OILSB]\s?){15,20})(?![0-9])/g;

// ── What the slip itself says about the platform, and the shoe ───────────────────────
// Measured on real slips (2026-11-21): an Alias packing label prints "alias", "GOAT" or
// "Sneakers.com" (16 of 18 read); a Stadium Goods slip its wordmark (3 of 3). Temu and SHEIN
// print no name — their NUMBER is the mark (PO-211-…, GS…). Words are read, never logos.
// Only an unambiguous slip names a platform: two different marketplaces on one photo → null.
const PLATFORM_WORDS = [
  ['alias', /\b(?:alias|goat)\b|sneakers\s*\.\s*com/i],
  // The wordmark, or what only its slip prints: "Fulfillment Number" over "SONDSS_CKRS…" (two
  // of eleven real slips came with no wordmark read and needed the buttons, 2026-11-25).
  ['sg', /stadium\s*goods|\bSONDSS|\bfu[a-z]{2,7}ment\s+number\b/i],
  ['stockx', /\bstock\s?x\b/i],
  ['ebay', /\bebay\b/i],
  ['kc', /kicks\s*crew/i],
  ['temu', /\btemu\b/i],
  ['tiktok', /\btik\s?tok\b/i],
  ['shein', /\bshein\b/i],
];
/** The platform the text names — only when it names exactly one. */
export function platformFromText(text) {
  const t = String(text || '');
  const hits = PLATFORM_WORDS.filter(([, re]) => re.test(t)).map(([k]) => k);
  return hits.length === 1 ? hits[0] : null;
}
// "SKU: 151186 003" / "SKU: DH3162-100" and "SIZE: 13C" / "SIZE: 9W" — the big lines a Stadium
// Goods or Temu slip prints. A labelled value beats a style code spotted elsewhere on the page.
const SKU_LINE = /\bSKU\s*[:;.]\s*([A-Z0-9]{5,7})[\s-]{1,2}([A-Z0-9]{3})\b/;
const SIZE_LINE = /\bSIZE\s*[:;.]?\s*(\d{1,2}(?:[.,]5)?)\s?([CYWM]|GS|PS|TD)?(?![A-Z0-9])/;
/** The shoe as the slip prints it → { sku, size, product } (each null when not read). */
export function slipDetails(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const all = lines.join('\n'); const up = all.toUpperCase();
  const labelled = SKU_LINE.exec(up);
  const s = labelled || styleCodeIn(up);
  const sku = s ? cleanSku(`${s[1]}-${s[2]}`) : null;
  const z = SIZE_RE.exec(all);
  const zl = z ? null : SIZE_LINE.exec(up);
  const size = z ? `US ${z[1] ? `${z[1].toUpperCase()} ` : ''}${fixSize(z[2])}${z[3] ? z[3].toUpperCase() : ''}`
    : zl ? `${fixSize(zl[1])}${zl[2] || ''}` : null;
  return { sku, size, product: labelProduct(lines) };
}

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
    // Mostly digits (6 or more) — except a number taken by its platform's own SHAPE, which may
    // be mostly letters (StockX "06-LZQ93WHGEL" has four digits).
    if (!k || (k.match(/\d/g) || []).length < (why === 'shape' ? 2 : 6) || looksLikeTracking(k)) return;
    if (!found.has(k)) found.set(k, { order_number: n, platform, why });
  };
  for (const line of lines) {
    if (TRACKING_LINE.test(line)) continue;
    for (const m of line.toUpperCase().matchAll(SHEIN_NO)) {
      const n = `GS${m[0].slice(2)}`;
      if (sheinLike(n)) add(n, 'shein', 'shape');
    }
  }
  // Temu: "PO-211-" and 15-19 digits. OCR splits the long run ("…394872 563") and reads the O
  // as a zero; both are put back. On a line of its own or after "Purchase Order ID:".
  for (const line of lines) {
    if (TRACKING_LINE.test(line)) continue;
    for (const m of line.toUpperCase().matchAll(TEMU_NO)) {
      // A word after the number ("… 370 ORDER") is not part of it: letters count only inside.
      const digits = fixDigits(m[2].replace(/\s/g, '').replace(/[^0-9]+$/, '')).replace(/\D/g, '');
      if (digits.length >= 15 && digits.length <= 19) add(`PO-${m[1]}-${digits}`, 'temu', 'shape');
    }
  }
  for (const p of PLATFORMS.filter((x) => x.pattern)) {
    // A dash on the label may have a space either side — but not the dash inside "[A-Z0-9]".
    const loose = new RegExp(`(?<![A-Z0-9-])(?:${p.pattern.source.replace(/^\^|\$$/g, '').replace(/-(?![^[]*\])/g, '\\s?-\\s?')})(?![A-Z0-9-])`, 'g');
    for (const line of lines) {
      if (TRACKING_LINE.test(line)) continue;
      for (const m of fixLine(line).toUpperCase().matchAll(loose)) {
        const n = m[0].replace(/\s/g, '');
        // Already taken whole as a Temu "PO-211-…": its "211-…" tail is not a second order.
        if (![...found.keys()].some((f) => f !== orderKey(n) && f.endsWith(orderKey(n)))) add(n, p.key, 'shape');
      }
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
    // A Temu "PO-211-…" after "Purchase Order ID:" was taken by its own rule above, O-for-zero
    // misreads put right ("P00-211-…") — the raw token here is not a second order.
    if (/^P[O0]{1,2}-?\d{3}-?\d{12,}/i.test(n)) return;
    if (k && ![...found.keys()].some((f) => f.includes(k))) add(n, null, 'order #');
  });
  // …and ONLY there. Live 2026-11-25 this rule fired on Stadium Goods slips (they carry a style
  // code too) and recorded four numbers that were no order's: a misread of the slip's small SKU
  // column ("026484 052"), a date and a phone. So: never when the sender — or the slip itself —
  // names another marketplace, and never on a slip laid out with "BRAND:" (Stadium Goods and
  // Temu print it, an Alias label doesn't), unless the label says alias / GOAT / Sneakers.com.
  const said = platformFromText(all);
  const aliasWords = said === 'alias';
  const otherPlatform = (hint && hint !== 'alias') || (said && said !== 'alias');
  const otherLayout = /\bBRAND\s*[:;]/i.test(all);
  const packingLabel = !otherPlatform && (hint === 'alias' || aliasWords || (!otherLayout && !!styleCodeIn(all.toUpperCase())));
  if (packingLabel) {
    for (const line of lines) {
      let t = fixDigits(line.replace(/[|.,;:'"`]+$/g, '').replace(/^[|.,;:'"`]+/g, '').trim()).replace(/\s/g, '');
      if (/^\d+\/\d+$/.test(t) && t.length >= 9 && t.length <= 10) t = t.replace('/', '7');
      if (/^\d{9,10}$/.test(t)) add(t, null, 'label');
    }
  }
  const orders = [...found.values()].map((o) => ({ ...o, platform: hint || o.platform || null }));
  // A style code, size and name belong to the order only when the picture shows ONE order.
  const { sku, size, product } = orders.length === 1 ? slipDetails(all) : { sku: null, size: null, product: null };
  return orders.map((o) => ({ ...o, sku, size, product }));
}

/** Guess the platform from the number's shape alone — for a number typed to the bot. */
export function platformFromNumber(v) {
  const n = cleanOrderNo(v);
  const byPattern = PLATFORMS.find((p) => p.pattern && p.pattern.test(n))?.key;
  if (byPattern) return byPattern;
  // SHEIN has no `pattern` (a typed SHEIN number is never flagged for its shape), but GS + 11-15
  // letters and digits is nobody else's.
  return /^GS[A-Z0-9]{11,15}$/.test(n) && sheinLike(n) ? 'shein' : null;
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

// A LONG LETTERS-AND-DIGITS number (SHEIN "GSU19K45B000Q2R", StockX "06-B1P9GP5N4H") read off a
// phone photo comes back with several look-alikes swapped at once — measured on a real SHEIN
// slip: "GSUT9K45BO00O2R", three characters off, every one a look-alike. `canonKey` folds each
// family of look-alikes onto one character (0 O Q D → 0 · 1 I L T → 1 · 5 S → 5 · 8 B → 8 ·
// 2 Z → 2 · 6 G → 6), so the read and the real number come out the same. Digits are never
// folded onto each other, so a digits-only number (Alias) is its own canon and nothing changes
// for it — the rule above about never correcting digit for digit still holds.
const CANON = { O: '0', Q: '0', D: '0', I: '1', L: '1', T: '1', S: '5', B: '8', Z: '2', G: '6' };
export function canonKey(v) {
  const k = orderKey(v);
  return k ? k.replace(/[OQDILTSBZG]/g, (c) => CANON[c]) : null;
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
  if (close.length === 1) return { order: close[0], corrected: true };
  if (close.length > 1) return null;
  // Several look-alikes off at once: the same number once the look-alikes are folded together.
  // Only a number with letters in it can differ that way; exactly ONE order, or no guess.
  if (!/[A-Z]/.test(k)) return null;
  const ck = canonKey(k);
  const same = [...new Map(mine.filter((o) => canonKey(o.key) === ck).map((o) => [o.key, o])).values()];
  return same.length === 1 ? { order: same[0], corrected: true } : null;
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
  ebay: 'our eBay order', shein: 'our SHEIN order', presell: 'our pre-sell sale', shopify: 'our Shopify order',
  label: 'the photo', catalogue: 'our catalogue (by SKU)', typed: 'typed', edited: 'edited by hand',
};
export const detailsFromLabel = (v) => String(v || '').split(',').map((k) => DETAILS_FROM[k.trim()] || k.trim()).filter(Boolean).join(' + ');

// ── The bot's answer: ONE message per batch of photos, as a reply to the first ─────────
// Every line starts with what a person has to do about it (2026-11-20):
//   [OK]      nothing — both reads agreed, or it is one of OUR orders
//   [CHECK]   compare with the photo — the reads disagreed, a third read decided, only one read
//             worked, a character was put right, or the number doesn't look like the platform's
//   [MISSED]  no order number came off that photo (or the photo wasn't saved)
// e.g.
//   Alias · 2 orders recorded
//   [OK] #206557037 — Nike Free Run 5.0 'Phantom Sail' · CZ1884-010 · size 8.5
//   [CHECK] #176889923 — DQ4071-001 · size 9.5 (reads disagreed)
//
//   [MISSED] Photo 3: no order number found — reply with the number to the copy of this photo below, or re-snap it
//   ↩️ #206557037 is already logged as #12 by Karon — not added again
//
//   Check them: https://…/cancellations
const sizeWord = (v) => (v ? `size ${shortSize(v)}` : null);
const CHECK_WHY = [
  ['reads_disagree', 'reads disagreed'], ['unchecked', 'only one read worked'], ['tie_break', 'a third read decided'],
  ['unclear', 'hard to read'], ['low_confidence', 'the reader was not sure'],
  ['short_number', 'number looks too short'], ['format', "doesn't look like this platform's numbers"],
  // 'platform_guess' is NOT here: a slip that says GOAT or STADIUM GOODS is that marketplace's
  // (the flag stays on the row, for the record). Owner, 2026-11-25: a clean read is [OK].
  ['not_in_shopify', 'not found in our orders'],
];
/**
 * What a recorded row needs from a person → { tag: 'OK' | 'CHECK' | 'MISSED', why }.
 * A row matched to one of our own orders carries no reader flags (flagsFor is called without
 * the read), so it is OK unless a character had to be put right to match it (`read_as`).
 */
export function rowStatus(r) {
  if (!r?.order_number) return { tag: 'MISSED', why: null };
  if (r.read_as) return { tag: 'CHECK', why: `read as ${r.read_as}` };
  const flags = Array.isArray(r.flags) ? r.flags : [];
  const hit = CHECK_WHY.find(([k]) => flags.includes(k));
  return hit ? { tag: 'CHECK', why: hit[1] } : { tag: 'OK', why: null };
}
export function orderLine(r) {
  const what = [r.product, r.sku, sizeWord(r.size)].filter(Boolean).join(' · ');
  const s = rowStatus(r);
  const why = s.why ? ` (${s.why})` : '';
  const how = r.by_tracking ? ' (found by its tracking number)' : '';
  return `[${s.tag}] #${String(r.order_number).replace(/^#+/, '')} — ${what || 'no shoe details found'}${why}${how}`;
}
/**
 * `photos` = [{ n, rows, dupes:[{ order_number, existing:{ id, sent_by } }], error, why }] in the
 * order they were sent (n = 1-based position; null for a typed number). Rows with an order
 * number are listed per platform; a row without one is that photo's [MISSED] line.
 * `link` = where the Cancellations page is; it is added only when something is [CHECK] or
 * [MISSED]. → the text; `batchReplyNeedsLook(photos)` says whether anything needs a person.
 */
export function batchReplyNeedsLook(photos) {
  return (photos || []).some((p) => p.error || (p.rows || []).some((r) => rowStatus(r).tag !== 'OK'));
}
export function batchReplyText(photos, { link = null } = {}) {
  const listed = []; const warn = []; const dup = [];
  for (const p of photos || []) {
    const where = p.n ? `Photo ${p.n}` : 'This photo';
    if (p.error) { warn.push(`[MISSED] ${where}: not saved (${p.error}) — send it again.`); continue; }
    for (const r of p.rows || []) {
      if (r.order_number) listed.push(r);
      else warn.push(`[MISSED] ${where}: no order number found${p.why ? ` (${p.why})` : ''} — reply with the number to the copy of this photo below, or re-snap it`);
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
    mine.forEach((r) => out.push(orderLine(r)));
  }
  if (!listed.length) out.push(dup.length && !warn.length ? 'Nothing new recorded.' : 'No orders recorded yet.');
  if (warn.length || dup.length) out.push('', ...warn, ...dup);
  if (listed.some((r) => !isPlatform(r.platform))) out.push('', 'Tip: send the platform first — e.g. /alias, then the photos.');
  if (batchReplyNeedsLook(photos)) {
    out.push('', link ? `Check them, or + Add by hand: ${link}` : 'Check them, or + Add by hand, on the Cancellations page.');
  }
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
