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
