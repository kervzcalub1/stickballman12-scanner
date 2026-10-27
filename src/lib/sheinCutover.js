// SHEIN Listings Phase 5 — the 4seller cut-over and go-live checklists (docs/shein-listings-plan.md
// §3 Phase 5, D9; docs/context/shein-listings.md → "Phase 5"). PURE: the server reads the facts
// (api/shein/listing-cutover.js → db.js listingCutoverFacts) and this module turns them into
// ✓ / ✕ / … lines, the same on the server and in the page. `now` is always passed in — never a
// defaulted Date.now() deeper in the chain (a pinned test must be able to fix the clock).
//
// What a person ticks (we can't read 4seller or SHEIN's console) is kept in app_settings
// `shein_cutover_ticks` = { <key>: { by, at, date?, note? } } — who, when, and the EST date they
// gave. Everything else is computed from OUR tables.
import { estDate } from './format.js';

export const TICKS_KEY = 'shein_cutover_ticks';
export const WINDOW_DAYS = 30;        // the 4seller-free trial
export const SETTLE_DAYS = 2;         // a new Shopify shoe must be answered within this
export const QUIET_DAYS = 14;         // 4seller's last action on SHEIN must be older than this
// Sizes SHEIN — not us — keeps off SHEIN: the category refuses custom sizes, the brand isn't
// authorised for our store, the store can't take new listings / its quota or shelf is used up.
export const SHEIN_CONTROLLED = ['size_not_on_shein', 'brand_not_authorized', 'store_cannot_publish', 'publish_quota_used', 'shelf_quota_full'];

// Every tick a person can set: which card, what it says, whether it needs a date (and what the date means).
export const TICKS = {
  paused_4seller: { card: 'cutover', label: '4seller’s SHEIN sync is paused (stock and listings)', date: 'Paused on' },
  last_action_4seller: { card: 'cutover', label: '4seller’s last action on SHEIN', date: 'Last 4seller action in Seller Center’s operation log' },
  shein_console_hooks: { card: 'golive', label: 'SHEIN console webhook subscriptions' },
  pilot_phase2: { card: 'golive', label: 'Pilot — Phase 2: one shoe, one custom size', date: 'Done on', note: 'Which shoe' },
  pilot_phase3: { card: 'golive', label: 'Pilot — Phase 3: one cut, one size back on', date: 'Done on', note: 'Which shoe' },
  pilot_phase4: { card: 'golive', label: 'Pilot — Phase 4: one men’s sneaker, SHEIN sizes only', date: 'Done on', note: 'Which shoe' },
};
export const SHEIN_HOOK_TOPICS = ['product_document_audit_status_notice', 'product_document_receive_status_notice', 'product_price_audit_status_notice'];
export const GOLIVE_TABLES = ['shein_listing_products', 'shein_listing_variants', 'shein_listing_jobs', 'shein_listing_job_items', 'shein_listing_cache',
  'shein_size_map', 'shein_api_log', 'shein_category_map', 'shein_attr_defaults', 'shein_brand_map'];

/* ------------------------------- date helpers (EST) ------------------------------- */
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const dayNo = (ymd) => Math.floor(Date.parse(`${ymd}T12:00:00Z`) / 86_400_000);
const fromDayNo = (n) => new Date(n * 86_400_000).toISOString().slice(0, 10);   // a civil-date number back to YYYY-MM-DD (UTC noon maths, not a clock)
export const estDaysBetween = (a, b) => dayNo(b) - dayNo(a);   // whole EST calendar days from a to b (YYYY-MM-DD)
const estHour = (now) => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(now));
// A date a person typed: YYYY-MM-DD, not in the future (EST), not before 2026.
export function validTickDate(s, now) {
  if (!YMD.test(String(s || ''))) return 'Pick a date.';
  if (s > estDate(now)) return 'That date is in the future (EST).';
  if (s < '2026-01-01') return 'That date is too far back.';
  return null;
}

/* ------------------------------- a new shoe answered? ------------------------------- */
// "Reached Synced or a named blocker": a person can say why it isn't on SHEIN from the page alone.
// In review counts (sent, SHEIN is looking at it); so does a person's "Don't list on SHEIN".
// `levels` = BLOCKERS[code].level, passed in so this file needs no engine import.
export function productAnswered(p, levelOf = () => 'blocked') {
  if (!p) return false;
  if (p.status === 'synced' || p.status === 'in_review') return true;
  if (p.status === 'excluded') return !!p.excluded;   // a Shopify draft isn't an answer for an ACTIVE shoe
  if (p.status === 'blocked' || p.status === 'error') return (p.blockers || []).some((b) => b?.code && !['note', 'review'].includes(levelOf(b.code)));
  return false;
}

/* ------------------------------- the cut-over card ------------------------------- */
// facts = { newProducts: [{shopify_product_id, title, style, status, first_seen_at, settled_at}],
//           nightly: [{id, status, created_at, finished_at}], interrupted: [{id, kind, created_at, done, total}],
//           sizes: { snapshot: bool, toAdd, sheinBlocked, leftOff, byCode: [{code, sizes}] } }
export function evaluateCutover({ ticks = {}, facts = {}, now }) {
  const today = estDate(now);
  const paused = ticks.paused_4seller || null;
  const last = ticks.last_action_4seller || null;
  const startDay = paused ? estDate(paused.at) : null;
  const dayN = paused ? Math.max(0, estDaysBetween(startDay, today)) : 0;
  const complete = !!paused && dayN >= WINDOW_DAYS;
  const items = [];

  // (a) 4seller paused + quiet for 14 days — a person ticks both (we can't read 4seller)
  const quietDays = last?.date ? estDaysBetween(last.date, today) : null;
  items.push({
    key: 'a', title: '4seller is paused and has been quiet for 14 days',
    how: 'A person ticks both: we can’t read 4seller. Check 4seller’s SHEIN settings (stock and listings sync off), then Seller Center’s operation log for the last change 4seller made.',
    ok: !paused || !last ? false : quietDays >= QUIET_DAYS ? true : null,
    detail: !paused ? 'Not ticked yet — tick it the day 4seller’s SHEIN sync is paused. The 30 days start then.'
      : !last ? 'Paused. Now check Seller Center’s operation log and tick the date of 4seller’s last action.'
        : quietDays >= QUIET_DAYS ? `4seller’s last action was ${quietDays} days ago (${last.date}).`
          : `4seller’s last action was ${quietDays} day${quietDays === 1 ? '' : 's'} ago (${last.date}) — ${QUIET_DAYS - quietDays} more to go.`,
    ticks: ['paused_4seller', 'last_action_4seller'],
  });

  // (b) every new ACTIVE Shopify shoe answered within 2 days
  const shoes = (facts.newProducts || []).map((p) => {
    const seen = p.first_seen_at; const settled = p.settled_at;
    const tookDays = settled ? (Date.parse(settled) - Date.parse(seen)) / 86_400_000 : null;
    const ageDays = (now.getTime() - Date.parse(seen)) / 86_400_000;
    const state = settled ? (tookDays <= SETTLE_DAYS ? 'ok' : 'late') : ageDays <= SETTLE_DAYS ? 'waiting' : 'missed';
    return { id: p.shopify_product_id, title: p.title, style: p.style, status: p.status, firstSeen: seen, settledAt: settled, state, days: Math.floor(settled ? tookDays : ageDays) };
  });
  const bad = shoes.filter((s) => s.state === 'late' || s.state === 'missed');
  const waiting = shoes.filter((s) => s.state === 'waiting');
  items.push({
    key: 'b', title: `Every new Shopify shoe reached Synced or a named blocker within ${SETTLE_DAYS} days`,
    how: 'From our records: when each ACTIVE Shopify shoe first appeared on this page, and when it first read Synced, In review, Blocked / Error with a reason, or “Don’t list on SHEIN” by a person.',
    ok: !paused ? false : bad.length ? false : complete ? true : null,
    detail: !paused ? 'Starts when 4seller is ticked paused.'
      : bad.length ? `${bad.length} shoe${bad.length === 1 ? '' : 's'} went more than ${SETTLE_DAYS} days with no answer on this page.`
        : shoes.length ? `${shoes.length} new shoe${shoes.length === 1 ? '' : 's'} since the start — all answered in time${waiting.length ? ` (${waiting.length} still inside their ${SETTLE_DAYS} days)` : ''}.`
          : 'No new Shopify shoe since the start yet.',
    shoes: [...bad, ...waiting],
  });

  // (c) the nightly snapshot ran every night (the 03:00 EST read; nights strictly after the start day)
  const doneNights = new Set((facts.nightly || []).filter((j) => j.status === 'done').map((j) => estDate(j.created_at)));
  const nights = [];
  if (paused) {
    const lastNight = Math.min(dayNo(today) - (estHour(now) >= 4 ? 0 : 1), dayNo(startDay) + WINDOW_DAYS);
    for (let n = dayNo(startDay) + 1; n <= lastNight; n++) nights.push(fromDayNo(n));
  }
  const missedNights = nights.filter((d) => !doneNights.has(d));
  items.push({
    key: 'c', title: 'The nightly read ran every night for 30 days',
    how: 'From the Jobs list: one finished “Re-read” started by the 03:00 EST nightly on each EST night since the start (the nightly runs on the live server only).',
    ok: !paused ? false : missedNights.length ? false : complete ? true : null,
    detail: !paused ? 'Starts when 4seller is ticked paused.'
      : missedNights.length ? `Missed ${missedNights.length} night${missedNights.length === 1 ? '' : 's'}: ${missedNights.slice(0, 6).join(', ')}${missedNights.length > 6 ? ' …' : ''} (EST).`
        : `${nights.length} of ${WINDOW_DAYS} nights so far, none missed.`,
    nights: { needed: WINDOW_DAYS, ran: nights.length - missedNights.length, missed: missedNights },
  });

  // (d) no interrupted job left unresolved
  const stuck = facts.interrupted || [];
  items.push({
    key: 'd', title: 'No interrupted job is left unresolved',
    how: 'From the Jobs list: any job the server stopped mid-way (a restart) and nobody resumed.',
    ok: stuck.length === 0,
    detail: stuck.length ? `${stuck.length} interrupted job${stuck.length === 1 ? '' : 's'} — open ${stuck.length === 1 ? 'it' : 'each'} on the Jobs tab and Resume (or stop it on purpose).` : 'None.',
    jobs: stuck,
  });

  // (e) sizes to add ≤ sizes SHEIN keeps off
  const sz = facts.sizes || {};
  items.push({
    key: 'e', title: 'Sizes still to add are only the ones SHEIN won’t take',
    how: 'From the last read: in-stock Shopify sizes of shoes already on SHEIN that SHEIN doesn’t sell (the same rule as “Shopify sizes to add on SHEIN” on the SHEIN ↔ Shopify check), against the ones blocked for a reason SHEIN controls — custom size not allowed, brand not authorised, publish quota / shelf full.',
    ok: !sz.snapshot ? false : sz.toAdd <= sz.sheinBlocked,
    detail: !sz.snapshot ? 'Nothing read yet.'
      : `${sz.toAdd} size${sz.toAdd === 1 ? '' : 's'} to add · ${sz.sheinBlocked} blocked by SHEIN${sz.toAdd > sz.sheinBlocked ? ` — ${sz.toAdd - sz.sheinBlocked} we could still add` : ''}.${sz.leftOff ? ` ${sz.leftOff} more left off on purpose (“Don’t list on SHEIN”), not counted.` : ''}`,
    numbers: { toAdd: sz.toAdd ?? null, sheinBlocked: sz.sheinBlocked ?? null, leftOff: sz.leftOff ?? 0, byCode: sz.byCode || [] },
  });

  const passing = items.filter((i) => i.ok === true).length;
  return {
    started: !!paused, windowStart: paused?.at || null, startDay, dayN: Math.min(dayN, WINDOW_DAYS),
    daysLeft: paused ? Math.max(0, WINDOW_DAYS - dayN) : WINDOW_DAYS, complete,
    items, passing, total: items.length, ready: items.every((i) => i.ok === true),
  };
}

/* ------------------------------- the go-live card ------------------------------- */
// facts = { tables: {name: bool}, columns: {name: bool}, hooks, probe: {at, by}|null, firstSnapshot: {id, finished_at}|null,
//           firstRun: {id, created_at}|null, box: {confirmed, by, at} }
export function evaluateGolive({ ticks = {}, facts = {}, cutover = null }) {
  const tick = (k) => ticks[k] || null;
  const missingTables = GOLIVE_TABLES.filter((t) => !facts.tables?.[t]);
  const missingCols = Object.entries(facts.columns || {}).filter(([, ok]) => !ok).map(([c]) => c);
  const paused = tick('paused_4seller');
  const run = facts.firstRun || null;
  const items = [
    { key: 'db', title: 'Production db:setup done', how: 'Live: the SHEIN Listings tables and columns exist on this database.',
      ok: !missingTables.length && !missingCols.length,
      detail: missingTables.length || missingCols.length ? `Missing: ${[...missingTables, ...missingCols].join(', ')} — run npm run db:setup on this server.` : 'Every table is there.' },
    { key: 'hooks', title: 'Shopify product webhooks registered', how: 'Live: “Register Shopify webhooks” on the strip above was pressed here.',
      ok: !!facts.hooks?.on, at: facts.hooks?.at || null, by: facts.hooks?.by || null,
      detail: facts.hooks?.on ? null : 'Press “Register Shopify webhooks” on the strip above (admin / Connect integrations).' },
    { key: 'probe', title: 'Ask SHEIN done (sizes per category)', how: 'Live: the Sizes tab has an answer from “Ask SHEIN”.',
      ok: !!facts.probe, at: facts.probe?.at || null, by: facts.probe?.by || null,
      detail: facts.probe ? null : 'Sizes tab → Ask SHEIN (reads only).' },
    { key: 'snapshot', title: 'First read of Shopify + SHEIN finished', how: 'Live: a finished Re-read in the Jobs list.',
      ok: !!facts.firstSnapshot, at: facts.firstSnapshot?.finished_at || null, job: facts.firstSnapshot?.id || null,
      detail: facts.firstSnapshot ? null : '“↻ Re-read Shopify + SHEIN” on the strip above.' },
    { key: 'shein_console_hooks', title: 'SHEIN console webhook subscriptions', how: `A person ticks it: in SHEIN’s developer console, subscribe our callback URL to ${SHEIN_HOOK_TOPICS.join(', ')}.`,
      ok: !!tick('shein_console_hooks'), tick: 'shein_console_hooks', topics: SHEIN_HOOK_TOPICS,
      detail: tick('shein_console_hooks') ? null : 'Without them a send stays “In review” until the next read.' },
    { key: 'paused_first', title: '4seller paused before the first Phase-2 run', how: 'Live: the “4seller paused” date on the cut-over card against the first send (any confirmed run) in the Jobs list. 4seller maps to the nearest size and would fight our sizes.',
      ok: !paused ? false : !run ? true : paused.date ? paused.date <= estDate(run.created_at) : false,
      detail: !paused ? (run ? `Send #${run.id} went on ${estDate(run.created_at)} and 4seller isn’t ticked paused.` : 'Tick “4seller paused” on the cut-over card before the first send.')
        : !run ? `Paused ${paused.date || estDate(paused.at)}; nothing sent yet.`
          : paused.date && paused.date <= estDate(run.created_at) ? `Paused ${paused.date}; first send #${run.id} on ${estDate(run.created_at)}.`
            : `First send #${run.id} went on ${estDate(run.created_at)}, before 4seller was paused (${paused.date || estDate(paused.at)}). Check the shoes it touched.` },
    { key: 'box', title: 'Box sizes and weight confirmed (D6)', how: 'Live: the “Box size and weight” card below was confirmed by a person.',
      ok: !!facts.box?.confirmed, at: facts.box?.at || null, by: facts.box?.by || null,
      detail: facts.box?.confirmed ? null : 'Still the placeholders — confirm them below (admin / Connect integrations).' },
    ...['pilot_phase2', 'pilot_phase3', 'pilot_phase4'].map((k) => ({
      key: k, title: TICKS[k].label,
      how: k === 'pilot_phase2' ? 'A person ticks it after the first real add-sizes send: one shoe, one custom size, approved by SHEIN and looked at on SHEIN.'
        : k === 'pilot_phase3' ? 'A person ticks it after one price cut and one size turned back on went through, and SHEIN shows them.'
          : 'A person ticks it after one men’s sneaker was published with SHEIN’s own sizes only, and SHEIN approved it.',
      ok: !!tick(k), tick: k, detail: null,
    })),
  ];
  return { items, passing: items.filter((i) => i.ok).length, total: items.length, ready: items.every((i) => i.ok), cutoverStarted: !!cutover?.started };
}
