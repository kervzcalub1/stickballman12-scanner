// Two short texts a buying request is run on (docs/context/buy-cart.md → "One card per shoe").
//
// 1. WHAT THE SUPPLIER SENDS, pasted into "Add a pair":
//
//      100000317
//      Sizes 8-12 $50
//
//    → { sku: '100000317', sizes: ['8','8.5', … '12'], price: 50 }. A range takes EVERY
//    half size (the owner's call, 2026-10-24); a list ("8, 9, 10.5") takes exactly those;
//    "9 x 2" is a size with 2 on the shop's shelf. It only FILLS THE FORM — the buyer checks
//    the sizes and the price there, and nothing is asked until they press Ask.
//
// 2. WHAT AN APPROVER REPLIES to the shoe's Telegram card:
//
//      11 x 3
//      10.5 x 4
//
//    → approve 11 ×3 and 10.5 ×4; every other size on the card is turned down. A size with
//    no quantity ("8", "8, 9", "8-10") is one pair, and the answer says so. Strict on
//    purpose — this spends money, so a line that can't be read refuses the whole reply
//    rather than approving the part that could.

// A size as people type it: 8, 8.5, 10.5W, 5Y, 4.5C. Two digits at most, so a style code's
// digits never read as one.
const SIZE = '(\\d{1,2}(?:\\.5)?)\\s?([MWYCK])?';
const SIZE_RE = new RegExp(`^${SIZE}$`, 'i');
const RANGE_RE = new RegExp(`${SIZE}\\s*(?:-|–|—|to)\\s*${SIZE}`, 'gi');
// "$1,050" is 1050, not 1 (the comma used to end the number).
const AMOUNT = '((?:\\d{1,3}(?:,\\d{3})+|\\d{1,5})(?:\\.\\d{1,2})?)';
const PRICE_RE = new RegExp(`(?:\\$|@|usd\\s*)\\s*${AMOUNT}|${AMOUNT}\\s*(?:usd|dollars?)\\b`, 'i');
// A style code: has a digit, 5+ characters, optionally one split — a dash (DZ5485-201) or
// a space before exactly three characters (DZ5485 201). The space form never takes a size:
// "100000317 10-12" and "IB4025100 10.5" are a code and then sizes, not "100000317-10".
const SKU_RE = /\b(?:sku[:#\s]*)?((?=[A-Z0-9-]*\d)[A-Z0-9]{2,}(?:-[A-Z0-9]{2,4}|\s[A-Z0-9]{3}(?![.\d]|\s*(?:-|–|—|to)\s*\d))?)\b/gi;
const amount = (s) => Number(String(s).replace(/,/g, ''));

const label = (n, suffix) => `${Number(n)}${suffix ? suffix.toUpperCase() : ''}`;

/** Expand "8-12" (or "5Y-7Y") into every half size, both ends included. Null if silly. */
export function expandRange(lo, hi, suffix = '') {
  const a = Number(lo); const b = Number(hi);
  // 22 is the top of any size run we buy; "40-44" is EU sizing, not nine US sizes.
  if (!(a > 0) || !(b > a) || b - a > 12 || b > 22) return null;
  const out = [];
  for (let x = a; x <= b + 1e-9; x += 0.5) out.push(label(Math.round(x * 2) / 2, suffix));
  return out;
}

export function parseBuyPaste(text) {
  // `price` is the run's price; `sizePrice` the sizes a line priced differently
  // ("8-10 $50" / "11-12 $60" → 11–12 at $60, not quietly at $50).
  const out = { sku: null, sizes: [], price: null, sizePrice: {}, available: {}, unread: [], warnings: [] };
  const linePrice = {};   // size → the price on the line it was read from
  let general = null;     // a price on a line with no sizes ("$50" alone, or on the SKU line)
  const add = (sz, lp) => {
    if (!out.sizes.includes(sz)) out.sizes.push(sz);
    if (lp != null && linePrice[sz] == null) linePrice[sz] = lp;
  };
  for (const raw of String(text || '').split(/\r?\n/)) {
    let line = raw.replace(/[​ ]/g, ' ').trim();
    if (!line) continue;
    let used = false;

    let lp = null;
    const p = PRICE_RE.exec(line);
    if (p) {
      lp = amount(p[1] ?? p[2]);
      line = line.replace(p[0], ' ').trim();
      used = true;
      // Two prices on one line can't be told apart by size — say so rather than guess.
      const p2 = PRICE_RE.exec(line);
      if (p2) {
        out.warnings.push(`Two prices on one line ("${raw.trim()}") — only ${p[0].trim()} was used; check each size's price.`);
        line = line.replace(p2[0], ' ').trim();
      }
    }
    // The style code: only before any size has been read, and only a token that can't be
    // a size itself ("10.5" is never a SKU).
    if (!out.sku) {
      const m = [...line.matchAll(SKU_RE)].find((x) => x[1].replace(/[-\s]/g, '').length >= 5 && !SIZE_RE.test(x[1]));
      if (m) {
        out.sku = m[1].toUpperCase().replace(/\s+/, '-');
        line = line.replace(m[0], ' ').trim();
        used = true;
      }
    }
    const keyword = /\b(?:sizes?|sz)\b/i.test(line);
    line = line.replace(/^(?:sizes?|sz|us)\b[:\s]*/i, '').replace(/\b(?:sizes?|sz)\b[:\s]*/gi, ' ').trim();

    // "9 x 2" — a size, and how many the shop has of it.
    const sx = new RegExp(`^${SIZE}\\s*[x×*]\\s*(\\d{1,3})$`, 'i').exec(line);
    if (sx) {
      const sz = label(sx[1], sx[2]);
      add(sz, lp);
      if (Number(sx[3]) > 0) out.available[sz] = Number(sx[3]);
      continue;
    }

    // Ranges first, then whatever single sizes are left on the line.
    const found = [];
    let ranged = false;
    const rest = line.replace(RANGE_RE, (whole, lo, s1, hi, s2) => {
      const run = expandRange(lo, hi, s2 || s1 || '');
      if (!run) return ` ${whole} `;   // left in place, so it is reported as unread
      found.push(...run); ranged = true;
      return ' ';
    });
    const leftover = [];
    for (const t of rest.split(/[\s,;/|&+]+|\band\b/i).map((x) => x.trim()).filter(Boolean)) {
      const m = SIZE_RE.exec(t);
      if (m && Number(m[1]) > 0 && Number(m[1]) <= 22) found.push(label(m[1], m[2])); else leftover.push(t);
    }
    // A line of words with a number in it ("Club C 85 Vintage") is the shoe's NAME, not a
    // size list — its numbers are only sizes when the line says so or is nothing else.
    if (leftover.length && !keyword && !ranged) {
      if (!used) out.unread.push(raw.trim());
      if (lp != null && general == null) general = lp;
      continue;
    }
    if (!found.length && lp != null && general == null) general = lp;
    found.forEach((sz) => add(sz, lp));
    if (leftover.length) out.unread.push(leftover.join(' '));
  }
  // The run's price: one given on its own, else the one most sizes carry. Every size priced
  // otherwise keeps its own.
  if (general != null) out.price = general;
  else {
    const n = new Map();
    for (const v of Object.values(linePrice)) n.set(v, (n.get(v) || 0) + 1);
    out.price = n.size ? [...n.entries()].sort((a, b) => b[1] - a[1])[0][0] : null;
  }
  for (const [sz, v] of Object.entries(linePrice)) if (v !== out.price) out.sizePrice[sz] = v;
  out.sizes.sort((a, b) => parseFloat(a) - parseFloat(b) || a.localeCompare(b));
  return out;
}

// Size labels compare loosely only in the obvious ways: case, spaces, a leading "US".
// "7.5" and "7.5W" stay different shoes (api/_lib/buyingStock.js says the same).
export const sizeKey = (v) => String(v ?? '').trim().toUpperCase().replace(/^US\s*/, '').replace(/\s+/g, '');

/**
 * Read an approver's reply against the sizes on the card.
 * @param {string} text
 * @param {Array<{id:number, size:string}>} lines  the card's lines
 * @returns {{ ok:true, approve:Array<{line, qty}>, reject:Array<line> } | { ok:false, error:string }}
 */
// "two" → 2 … "twelve" → 12, so "two each" reads like "2 each".
const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, a: 1, an: 1 };
const wordsToDigits = (t) => t.replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/gi, (w) => String(NUMBER_WORDS[w.toLowerCase()]));

/**
 * HOW PEOPLE ACTUALLY ANSWER A CARD (floor feedback, 2026-11-02 — Alex replied "take all",
 * "Yes", "Two each size max" and got three errors). A whole-card answer in plain words:
 *   take all · yes · ok · all · approve · 👍  → every size, as many as were COUNTED in store
 *                                               (1 where nobody counted — said in the note)
 *   2 each · two each size max · max 2 each   → that many per size, never more than counted
 *   no · pass · none · nah · 👎               → every size turned down
 * ("take all except 8.5" is read by `readExceptReply`, which calls this for the first half.)
 * Returns null when the text isn't one of these (the size-by-size grammar takes over).
 */
export function readWholeCardReply(text, lines, { said = String(text ?? '').trim(), but = '' } = {}) {
  const t = wordsToDigits(String(text || '').trim().toLowerCase())
    .replace(/[.!?]+$/g, '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const counted = (l) => (Number(l.available_qty) > 0 ? Number(l.available_qty) : null);
  const ALL = /^(?:yes|yep|yeah|ya|yup|ok|okay|sure|approve(?:d)?(?: all| them| them all| it)?|all|all of (?:them|it|em)|(?:take|get|buy|grab|cop)(?: them| em| 'em| it)?(?: all)?|(?:take|get|buy|grab|cop) all(?: of (?:them|it|em))?(?: sizes)?|send it|go|go ahead|do it|👍|✅|💯)$/u;
  const NONE = /^(?:no|nope|nah|n|pass|none|no thanks|nothing|reject(?:ed)?(?: all| them| them all)?|decline(?:d)?(?: all| them)?|turn (?:them|it|em) (?:all )?down|skip(?: it| them| all)?|👎|❌)$/u;
  if (ALL.test(t)) {
    const uncounted = lines.filter((l) => counted(l) == null).map((l) => l.size);
    return {
      ok: true,
      approve: lines.map((l) => ({ line: l, qty: counted(l) ?? 1 })),
      reject: [],
      note: `Read "${said}" as every size${but}, as many as were counted in store`
        + `${uncounted.length ? ` (1 of ${uncounted.join(', ')} — not counted)` : ''}.`,
    };
  }
  if (NONE.test(t)) return { ok: true, approve: [], reject: [...lines], note: null };
  // "2 each", "take 2 each", "2 of each", "2 per size", "2 each size max", "max 2 each", "up to 2 each".
  const m = /^(?:(?:take|get|buy|grab|approve)\s+)?(?:(max(?:imum)?|up to|at most)\s+)?(\d{1,3})\s*(?:x\s*)?(?:each|of each|per size|a size|each size|of every size|every size)(?:\s+size)?(?:\s+(max(?:imum)?))?$/.exec(t);
  if (m) {
    const n = Number(m[2]);
    if (!(n > 0)) return { ok: true, approve: [], reject: [...lines], note: null };
    const capped = [];
    const approve = lines.map((l) => {
      const c = counted(l);
      if (c != null && c < n) { capped.push(`${l.size} ×${c}`); return { line: l, qty: c }; }
      return { line: l, qty: n };
    });
    return {
      ok: true, approve, reject: [],
      note: `Read "${said}" as ${n} of every size${but}${capped.length ? `, fewer where the store has fewer: ${capped.join(', ')}` : ''}.`,
    };
  }
  return null;
}

/**
 * "Take all except 8.5" (also: "take all except 8.5 and 9", "8.5 9", "8.5, 9"; "all but 8.5",
 * "2 each except 8.5"). The sizes named are turned down; the rest are read exactly as the
 * words before "except" would read on their own, so "take all" still means what's in store.
 * Strict, because a misread spends money: a size that isn't on the card, a word that isn't a
 * size, or a first half that doesn't say to buy ("no except 9") records nothing.
 * Returns null when the reply has no "except" in it.
 */
const EXCEPT_RE = /^(.*?)[\s,:;–—-]*\b(?:except(?:\s+for)?|excluding|without|minus|other\s+than|but(?:\s+not)?)\b[\s:]*(.*)$/;
function readExceptReply(text, lines, findLine) {
  const said = String(text || '').replace(/\s+/g, ' ').trim();
  const m = EXCEPT_RE.exec(wordsToDigits(said.toLowerCase()).replace(/[.!?]+$/g, ''));
  if (!m) return null;
  const example = `Reply like "take all except ${lines[0]?.size || 9}".`;
  const named = m[2].replace(/\b(?:sizes?|sz)\b/g, ' ').split(/[\s,;/&+]+|\band\b/).filter(Boolean);
  if (!named.length) return { ok: false, error: `Which sizes should be left out? ${example} Nothing was recorded.` };
  const unread = named.filter((n) => !SIZE_RE.test(n));
  if (unread.length) return { ok: false, error: `Couldn't read ${unread.map((n) => `"${n}"`).join(', ')} as a size. ${example} Nothing was recorded.` };
  const unknown = named.filter((n) => !findLine(n));
  if (unknown.length)
    return { ok: false, error: `${unknown.join(', ')} ${unknown.length === 1 ? 'isn’t' : 'aren’t'} on this card (sizes: ${lines.map((l) => l.size).join(', ')}). Nothing was recorded.` };
  const left = new Set(named.map((n) => findLine(n).id));
  const reject = lines.filter((l) => left.has(l.id));
  const take = lines.filter((l) => !left.has(l.id));
  if (!take.length) return { ok: false, error: 'That leaves no sizes to take. Reply "no" to turn them all down. Nothing was recorded.' };
  const first = m[1].replace(/\beverything\b/, 'all');
  const read = readWholeCardReply(first, take, { said, but: ` except ${reject.map((l) => l.size).join(', ')}` });
  if (!read?.approve.length) return { ok: false, error: `Couldn't read "${said}". ${example} Nothing was recorded.` };
  return { ok: true, approve: read.approve, reject, note: read.note };
}

export function parseApprovalReply(text, lines) {
  const bySize = new Map(lines.map((l) => [sizeKey(l.size), l]));
  // Two lines of one size on a card can't be told apart by a reply — the second would be
  // turned down as "left out" without anyone having said so.
  if (bySize.size < lines.length)
    return { ok: false, error: 'This card has the same size twice, so a reply can’t say which — decide it on the request’s page.' };
  // "9" for the card's "9W" (or "5" for "5Y") when it is the only 9 on the card.
  const byNumber = (t) => {
    const n = parseFloat(sizeKey(t));
    if (!/^\d{1,2}(\.5)?$/.test(sizeKey(t))) return null;
    const hits = lines.filter((l) => parseFloat(sizeKey(l.size)) === n);
    return hits.length === 1 ? hits[0] : null;
  };
  const except = readExceptReply(text, lines, (n) => bySize.get(sizeKey(n)) || byNumber(n));
  if (except) return except;
  // A plain-words answer for the whole card first ("take all", "2 each", "no").
  const whole = readWholeCardReply(text, lines);
  if (whole) return whole;
  const qty = new Map();
  const bad = []; const unknown = []; const twice = []; const assumed = [];
  let all = null;
  // No quantity said: one pair (approvers' feedback, 2026-11-06). The answer names these sizes.
  const takeOne = (line) => {
    if (qty.has(line.id)) twice.push(line.size);
    qty.set(line.id, 1);
    assumed.push(line.size);
  };
  for (const raw of String(text || '').split(/[\r\n,;]+/)) {
    // "size 14 x two" reads as "14 x 2".
    const t = wordsToDigits(raw.trim()).replace(/^(?:size|sz)\s+/i, '');
    if (!t) continue;
    // A RANGE of sizes, one quantity each: "10.5-11.5 x 2" = 10.5, 11 and 11.5, two of each —
    // the sizes ON THE CARD between the two, inclusive (2026-10-27).
    const rg = /^(\d{1,2}(?:\.5)?)([a-z]?)\s*(?:-|–|to)\s*(\d{1,2}(?:\.5)?)([a-z]?)(?:\s*[x×*:=]\s*(\d{1,3})\s*(?:pairs?|prs?)?)?$/i.exec(t);
    // With no quantity the ends must climb: "8-10" is a range at one pair each, while "9-3"
    // stays size 9, three pairs, as it always read.
    if (rg && (rg[5] != null || Number(rg[3]) > Number(rg[1]))) {
      const [a, b] = [Number(rg[1]), Number(rg[3])].sort((x, y) => x - y);
      const suffix = (rg[2] || rg[4] || '').toUpperCase();
      const hit = lines.filter((l) => {
        const k = sizeKey(l.size); const v = parseFloat(k);
        return v >= a && v <= b && (!suffix || k.endsWith(suffix));
      });
      if (!hit.length) { unknown.push(`${rg[1]}${rg[2]}-${rg[3]}${rg[4]}`); continue; }
      if (rg[5] == null) { hit.forEach(takeOne); continue; }
      for (const line of hit) { if (qty.has(line.id)) twice.push(line.size); qty.set(line.id, Number(rg[5])); }
      continue;
    }
    // Sizes alone: "8", "8 9", "8 and 9", "10.5W".
    const named = t.replace(/\s*(?:&|\band\b)\s*/gi, ' ').trim().split(/\s+/);
    if (named.every((n) => SIZE_RE.test(n))) {
      for (const n of named) {
        const line = bySize.get(sizeKey(n)) || byNumber(n);
        if (line) takeOne(line); else unknown.push(n);
      }
      continue;
    }
    const m = /^(\S+?)\s*(?:[x×*:=]|-(?=\s*\d+\s*$))\s*(\d{1,3})\s*(?:pairs?|prs?)?$/i.exec(t);
    if (!m) { bad.push(t); continue; }
    const n = Number(m[2]);
    if (/^all$/i.test(m[1])) { all = n; continue; }
    const line = bySize.get(sizeKey(m[1])) || byNumber(m[1]);
    if (!line) { unknown.push(m[1]); continue; }
    if (qty.has(line.id)) twice.push(line.size);
    qty.set(line.id, n);
  }
  if (bad.length)
    return { ok: false, error: `Couldn't read ${bad.map((b) => `"${b}"`).join(', ')} — nothing was recorded. Reply "take all", "2 each", "no", or one size per line like "${lines[0]?.size || 9} x 2" (sizes you leave out are turned down).` };
  if (unknown.length)
    return { ok: false, error: `${unknown.join(', ')} ${unknown.length === 1 ? 'isn’t' : 'aren’t'} on this card (sizes: ${lines.map((l) => l.size).join(', ')}). Nothing was recorded.` };
  if (twice.length)
    return { ok: false, error: `Size ${[...new Set(twice)].join(', ')} is in the reply twice — say each size once. Nothing was recorded.` };
  if (all == null && !qty.size) return { ok: false, error: 'Reply with the sizes to buy, one per line, like "9 x 5".' };
  const approve = []; const reject = [];
  for (const l of lines) {
    const n = qty.has(l.id) ? qty.get(l.id) : all;
    if (n > 0) approve.push({ line: l, qty: n }); else reject.push(l);
  }
  return {
    ok: true, approve, reject,
    note: assumed.length ? `No quantity on ${assumed.join(', ')}, so 1 ${assumed.length === 1 ? 'pair' : 'pair each'}.` : null,
  };
}

/**
 * Pull the TIP answer out of a reply to a premium shoe's card (docs/context/buy-cart.md
 * "Premium shoes"), leaving the "size x qty" lines for `parseApprovalReply`.
 *   "tip ok" / "tip yes" / "approve tip" / "approved tip request" → approve the amount proposed
 *   "tip 5" / "tip $7.50"                                         → approve that amount instead
 *   "tip no" / "decline tip" / "no tip"                           → decline
 * A line that starts with "tip" but says none of those is an error — this pays money.
 * @returns {{ tip: null | { action:'approve'|'decline', amount:number|null }, rest: string, error?: string }}
 */
export function splitTipReply(text) {
  const keep = []; let tip = null; let error = null;
  // Same separators as parseApprovalReply, so "9 x 2, tip ok" on one line works too.
  for (const raw of String(text || '').split(/[\r\n,;]+/)) {
    const t = raw.trim().toLowerCase().replace(/[.!]+$/, '');
    if (!/\btip\b/.test(t)) { keep.push(raw); continue; }
    let found = null;
    if (/^(?:(?:approve|approved|ok|okay|yes)\s+(?:the\s+)?tip(?:\s+request)?|tip\s+(?:ok|okay|yes|approve|approved|✅|👍)(?:\s+request)?)$/.test(t)) found = { action: 'approve', amount: null };
    else if (/^(?:(?:decline|declined|deny|denied|reject|rejected|no)\s+(?:the\s+)?tip(?:\s+request)?|tip\s+(?:no|decline|declined|deny|denied|reject|rejected|❌|👎)(?:\s+request)?)$/.test(t)) found = { action: 'decline', amount: null };
    else {
      const m = /^(?:approve(?:d)?\s+)?tip\s*(?:of\s*|is\s*)?\$?\s*(\d{1,3}(?:\.\d{1,2})?)\s*\$?\s*(?:dollars?\s*)?(?:per\s+pair|\/\s*pair|each|ea)?$/.exec(t)
        // "$5 tip" / "5 tip" / "5$ tip" / "5 dollar tip" — the amount first (Alex, 2026-11-02).
        || /^(?:ok\s+|approve\s+)?\$?\s*(\d{1,3}(?:\.\d{1,2})?)\s*\$?\s*(?:dollars?\s+)?tip(?:\s+(?:per\s+pair|each|ea|is fine|ok))?$/.exec(t);
      if (m && Number(m[1]) > 0) found = { action: 'approve', amount: Math.round(Number(m[1]) * 100) / 100 };
      else if (m) found = { action: 'decline', amount: null };   // "tip 0" = no tip
    }
    if (!found) { error = `Couldn't read "${raw.trim()}". For the tip, reply "tip ok", "tip no", or "tip 5" for $5 a pair.`; continue; }
    if (tip) { error = 'The tip is in the reply twice — say it once. Nothing was recorded.'; continue; }
    tip = found;
  }
  return { tip, rest: keep.join('\n'), ...(error ? { error } : {}) };
}
