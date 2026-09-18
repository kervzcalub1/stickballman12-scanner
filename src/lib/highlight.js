// Marking WHERE a search matched, so a result can show the person the part of it they
// were looking for. Pure: text in, `[{ text, hit }]` segments out — the screen wraps
// the hits in <mark> and nothing else.
//
// Two ways to match, mirroring `poMatchesSearch` (postatus.js), because a highlight
// that disagrees with the filter is a lie in yellow:
//   · words: case-insensitive substring of the text as written.
//   · codes: the SAME punctuation-blind comparison the filter uses (`trackKey`) — so a
//     search for `5485-612` lights up `DZ5485-612` and `2345 6784` lights up the tail of
//     `1Z999AA10123456784`. The match is found on the stripped key and mapped BACK to
//     the original characters, punctuation between them included, so the mark covers
//     what the eye reads rather than a string the person never typed.
import { trackKey } from './postatus.js';

const merge = (ranges) => {
  const out = [];
  for (const r of [...ranges].sort((a, b) => a[0] - b[0])) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
};

const toSegments = (text, ranges) => {
  const segs = [];
  let at = 0;
  for (const [a, b] of merge(ranges)) {
    if (a > at) segs.push({ text: text.slice(at, a), hit: false });
    segs.push({ text: text.slice(a, b), hit: true });
    at = b;
  }
  if (at < text.length) segs.push({ text: text.slice(at), hit: false });
  return segs.length ? segs : [{ text, hit: false }];
};

const allIndexes = (hay, needle) => {
  const out = [];
  if (!needle) return out;
  let i = hay.indexOf(needle);
  while (i !== -1) { out.push(i); i = hay.indexOf(needle, i + 1); }
  return out;
};

/**
 * @param {string} text        what is on screen
 * @param {string[]} words     the search, already split into words (and, for codes, the
 *                             whole query too — a spaced tracking number is one code)
 * @param {{ code?: boolean }} opts  `code` = compare through trackKey
 */
export function segmentsFor(text, words, { code = false } = {}) {
  const t = String(text ?? '');
  if (!t || !words?.length) return [{ text: t, hit: false }];
  const ranges = [];
  if (code) {
    // Positions of the characters that survive trackKey, in order, so an index on the
    // key maps back to an index on the text.
    const pos = [];
    for (let i = 0; i < t.length; i++) if (/[A-Za-z0-9]/.test(t[i])) pos.push(i);
    const key = trackKey(t);
    for (const w of words) {
      const k = trackKey(w);
      if (!k) continue;
      for (const i of allIndexes(key, k)) ranges.push([pos[i], pos[i + k.length - 1] + 1]);
    }
  } else {
    const low = t.toLowerCase();
    for (const w of words) {
      const l = String(w || '').toLowerCase();
      if (!l) continue;
      for (const i of allIndexes(low, l)) ranges.push([i, i + l.length]);
    }
  }
  return toSegments(t, ranges);
}

export const hasHit = (segs) => segs.some((s) => s.hit);
