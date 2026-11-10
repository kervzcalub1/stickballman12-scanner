// Order cancellations — the rules both sides use (docs/context/cancellations.md).
// Pure: the server runs these on what the AI read, and the review page runs them on
// what a person typed, so "is this row ready to verify?" can't mean two things.
//
// THE AI IS A READER, NOT A DECIDER (same rule as the receipt reader). It returns the
// platform and the number it sees; these checks decide what gets flagged, and nothing is
// cancelled until a person has compared the row to the photo and verified it.
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

export const STATUSES = {
  to_review: 'To review',
  verified: 'Verified — to cancel',
  submitted: 'Cancelled on platform',
  rejected: 'Rejected',
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
// the order number(s) out of that text. Same rule as the AI: a READER, never a decider —
// every row is still compared with the photo by a person before anything is cancelled.
// What counts as an order number, strongest first:
//   1. the platform's own shape where we know it (StockX 12345678-12345678, eBay 12-34567-89012);
//   2. a number after "Order #", "Order No.", "Order number", "Order ID" (same line or the next);
//   3. an Alias packing label: the order number is printed large on a line of its OWN, 9-10
//      digits, while the "ORDER #" caption above it is too small to read. Taken only when the
//      picture is a packing label (a style code on it, "alias"/"goat" in it, or /alias sent).
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
      const t = fixDigits(line.replace(/[|.,;:'"`]+$/g, '').replace(/^[|.,;:'"`]+/g, '').trim()).replace(/\s/g, '');
      if (/^\d{9,10}$/.test(t)) add(t, null, 'label');
    }
  }
  const orders = [...found.values()].map((o) => ({ ...o, platform: hint || o.platform || null }));
  // A style code and a size belong to the order only when the picture shows ONE order.
  let sku = null; let size = null;
  if (orders.length === 1) {
    const s = STYLE_CODE.exec(all.toUpperCase());
    sku = s ? cleanSku(`${s[1]}-${s[2]}`) : null;
    const z = SIZE_RE.exec(all);
    size = z ? `US ${z[1] ? `${z[1].toUpperCase()} ` : ''}${fixSize(z[2])}${z[3] ? z[3].toUpperCase() : ''}` : null;
  }
  return orders.map((o) => ({ ...o, sku, size }));
}

/** Guess the platform from the number's shape alone — for a number typed to the bot. */
export function platformFromNumber(v) {
  const n = cleanOrderNo(v);
  return PLATFORMS.find((p) => p.pattern && p.pattern.test(n))?.key || null;
}

// The reviewers' export: what they paste into each platform, in order.
const when = (t) => (t ? `${estDate(t)} ${estTime(t)}` : '');
const CSV_COLS = [
  ['id', 'ID'], ['status', 'Status'], ['platform', 'Platform'], ['order_number', 'Order number'], ['sku', 'SKU'],
  ['size', 'Size'], ['product', 'Product'], ['reason', 'Reason'], ['sent_by', 'Sent by'], ['sent', 'Sent (EST)'],
  ['verified_by', 'Verified by'], ['submitted_by', 'Cancelled by'], ['submitted', 'Cancelled (EST)'],
  ['platform_ref', 'Platform ref'], ['flags', 'Flags'], ['note', 'Note'],
];
export function cancellationsCsv(rows) {
  return toCsv(CSV_COLS, (rows || []).map((r) => ({
    ...r, status: STATUSES[r.status] || r.status, platform: platformLabel(r.platform),
    sent: when(r.created_at), submitted: when(r.submitted_at), flags: (r.flags || []).join(' '),
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
