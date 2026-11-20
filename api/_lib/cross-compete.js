// Alias Cross-Listing ⚔ PRICE COMPETE — the engine (docs/context/alias-cross-listing.md →
// "Price compete"). Owner, 2026-11-20: "add the price compete like the one we have in
// pre-sell listing". Same rules, same pure decisions (src/lib/presellCompete.js): undercut the
// lowest ask by $1 or match it, never more than $5 under the price we set, follow the market
// UP with no cap, re-base after 2 h under the floor, and a 🔒 lock that puts back a price
// changed outside this app.
//
// What differs from pre-sell: the unit is a size of a group ON ONE SKU. The same pair is
// listed under several SKUs and each SKU has its own market on Alias, so each one is priced
// against its own lowest ask. Alias only.
//
// One pass (from presell-worker.js, so only where PRESELL_WATCH=on — the one environment
// allowed to act on the shared Alias account), per size × SKU with LIVE listings:
//   1. read OUR live price back from Alias (the first listing that is still live)
//   2. 🔒 lock check   3. the market's lowest ask   4. compDecide → move every live listing.
// Every move, floor hit, re-base, put-back, drift and error is written to cross_comp_log.
import {
  crossCompSettings, crossCompRows, liveCrossListings, setCrossComp, saveCrossCompState, insertCrossCompLog,
  updateCrossListing, setSetting,
} from './db.js';
import { sendToChat } from './telegram.js';
import { PLATFORMS } from './presell.js';
import { aliasPriceInsights } from './alias.js';
import { chunks } from './presell-compete.js';
import { crossPriceChatId } from './cross.js';
import { compDecide, compEffective, compFarCheck, compFloor } from '../../src/lib/presellCompete.js';

const cents = (dollars) => (Number(dollars) > 0 ? Math.round(Number(dollars) * 100) : null);
const is429 = (e) => /too many|429/i.test(String(e || ''));
const ACTOR = 'competition';

// The shoe's own switch as compEffective wants it (null = follow "All shoes").
export const groupSetting = (row) => (row.comp_enabled == null ? null : { enabled: row.comp_enabled === true, mode: row.comp_mode || null });

// The market's lowest ask for one size of one SKU, in cents (null = none): the lower of
// With You / consigned, like pre-sell's.
export async function crossMarketLowest(row) {
  const fromSizes = Number(row.sizes?.[row.size]);
  const size = Number.isFinite(fromSizes) && fromSizes > 0 ? fromSizes : Number(row.size_value);
  if (!row.catalog_id || !Number.isFinite(size)) return null;
  const [wy, cn] = await Promise.all([
    aliasPriceInsights({ catalogId: row.catalog_id, size, consigned: false }),
    aliasPriceInsights({ catalogId: row.catalog_id, size, consigned: true }),
  ]);
  const asks = [cents(wy?.lowestListing), cents(cn?.lowestListing)].filter(Boolean);
  return asks.length ? Math.min(...asks) : null;
}

// One size on one SKU. `mode` = 'undercut' | 'match' when it competes, null when only the 🔒
// lock applies. `io` = { refresh(listing), update(listing, { priceCents }) } (Alias; faked in
// tests). Returns the log entry, or null when nothing is live.
export async function competeCrossOne(row, mode, { io = PLATFORMS.alias, market = crossMarketLowest, lock = false, now = Date.now() } = {}) {
  const poolId = Number(row.pool_id); const skuId = Number(row.group_sku_id);
  const all = await liveCrossListings(poolId, skuId);
  if (!all.length) return null;
  const log = { pool_id: poolId, group_sku_id: skuId, mode, sku: row.sku, size: row.size, name: row.group_name };
  // 1. our live price, from Alias — our row can be stale. A listing that is no longer live
  //    there is synced and passed over; the next one is read.
  const live = []; let livePrice = null;
  for (const l of all) {
    if (live.length) { live.push(l); continue; }
    const back = await io.refresh(l);
    if (!back.ok && !back.notFound) {
      await insertCrossCompLog({ ...log, action: 'error', note: `Couldn't read our listing back: ${back.error}`.slice(0, 400) });
      return { ...log, action: 'error', stop: is429(back.error) };
    }
    const st = back.notFound ? 'deleted' : back.status;
    if (st === 'off') { await updateCrossListing(l.id, { status: 'off' }, ACTOR); continue; }
    if (st === 'deleted') { await updateCrossListing(l.id, { status: 'deleted', delete_reason: 'platform' }, ACTOR); continue; }
    if (st === 'sold') continue;   // the sales watcher records it (cross.js handleCrossSale)
    livePrice = back.price_cents ?? Number(l.price_cents);
    if (livePrice !== Number(l.price_cents)) await updateCrossListing(l.id, { price_cents: livePrice }, ACTOR);
    live.push(l);
  }
  if (!live.length) return { ...log, action: 'skip' };
  // 2. 🔒 the price THIS APP last set. First time → adopt the live one (never push an old price up).
  let locked = row.lock_cents;
  if (locked == null) { locked = livePrice; await setCrossComp(poolId, skuId, { lock: locked }); }
  let restore = false;
  if (livePrice !== locked) {
    if (lock) restore = true;   // changed outside the app → put it back (below)
    else {
      await insertCrossCompLog({ ...log, action: 'drift', from_cents: locked, to_cents: livePrice,
        note: `Alias had ${livePrice / 100}, we had ${locked / 100} — changed outside the app; kept (lock is off)` });
      locked = livePrice; await setCrossComp(poolId, skuId, { lock: locked });
    }
  }
  let target = locked;
  let action = restore ? 'restore' : 'hold';
  let mk = null; let floor = null; let base = row.base_cents;
  let farSince = null;
  if (mode) {
    // 3. the market
    try { mk = await market(row); } catch (e) {
      await insertCrossCompLog({ ...log, action: 'error', from_cents: livePrice, note: `Market read failed: ${e.message}`.slice(0, 400) });
      return { ...log, action: 'error', stop: is429(e.message) };
    }
    if (base == null) { base = locked; await setCrossComp(poolId, skuId, { base }); }
    // The 2-hour rule: market under our floor for 2 h straight → the market is the new price we set.
    const far = compFarCheck({ marketCents: mk, floorCents: compFloor(base), farSince: row.state?.far_since, now });
    farSince = far.farSince;
    let rebased = false;
    if (far.rebase) { base = mk; await setCrossComp(poolId, skuId, { base }); farSince = null; rebased = true; }
    const d = compDecide({ mode, marketCents: mk, currentCents: locked, baseCents: base });
    floor = d.floor;
    target = d.target;
    if (rebased) action = 'rebase';
    else if (d.action !== 'hold' && d.action !== 'none') action = d.action;
  }
  const state = { market: mk, price: livePrice, lock: locked, base, floor, action, far_since: farSince, at: new Date(now).toISOString() };
  if (target === livePrice) {
    await saveCrossCompState(poolId, skuId, { ...state, action: action === 'restore' ? 'hold' : action });
    if (action === 'rebase') await insertCrossCompLog({ ...log, action, market_cents: mk, from_cents: livePrice, to_cents: target, floor_cents: floor, note: 'Market under our floor for 2 h — it is the new price we set' });
    return { ...log, action: action === 'rebase' ? 'rebase' : 'hold', market_cents: mk, from_cents: livePrice, to_cents: target, floor_cents: floor };
  }
  // 4. move every live listing of this size on this SKU to the target, one at a time.
  let changed = 0; let failed = 0; let stop = false; const errors = new Set();
  for (const l of live) {
    try {
      const out = await io.update(l, { priceCents: target, sizeValue: null });
      if (!out.ok) {
        failed++; errors.add(out.error);
        await updateCrossListing(l.id, { last_error: `Price change failed: ${out.error}` }, ACTOR);
        if (is429(out.error)) { stop = true; break; }
        continue;
      }
      await updateCrossListing(l.id, { price_cents: target, last_error: null }, ACTOR);
      changed++;
    } catch (e) { failed++; errors.add(e.message); }
  }
  if (changed) await setCrossComp(poolId, skuId, { lock: target });
  await saveCrossCompState(poolId, skuId, { ...state, price: changed ? target : livePrice, lock: changed ? target : locked, moved_from: livePrice, moved_to: target });
  const notes = [];
  if (restore) notes.push(`Alias had ${livePrice / 100} — changed outside the app; locked at ${locked / 100}`);
  if (action === 'rebase') notes.push('Market under our floor for 2 h — it is the new price we set');
  if (errors.size) notes.push([...errors].join(' · '));
  const entry = { ...log, action, market_cents: mk, from_cents: livePrice, to_cents: target, floor_cents: floor, changed, failed,
    restored: restore, note: notes.join(' · ').slice(0, 400) || null };
  await insertCrossCompLog(entry);
  return { ...entry, stop };
}

// One Telegram post per pass: every size × SKU that went up or down, hit the floor, was
// re-based, or was put back by the lock — grouped by shoe.
const usd = (c) => `$${(Number(c) / 100).toLocaleString('en-US', { minimumFractionDigits: Number(c) % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
const WORD = { down: '↓', up: '↑', floor: '⛔ floor', rebase: '↻ re-based', restore: '🔒 put back' };
export function crossPriceLines(moves, at = new Date()) {
  const by = new Map();
  for (const m of moves) { const k = m.name || 'Cross-listed shoe'; if (!by.has(k)) by.set(k, []); by.get(k).push(m); }
  const n = moves.length;
  const lines = [{ b: '⚔ CROSS-LISTING PRICE CHANGES — Alias' }, `${n} change${n === 1 ? '' : 's'} · ${at.toLocaleString('en-US', { timeZone: 'America/New_York', month: '2-digit', day: '2-digit', hour: 'numeric', minute: '2-digit' })} EST`];
  for (const [name, rows] of by) {
    lines.push('━━━━━━━━━━━━━━━━', { b: name });
    for (const m of rows) {
      const bits = [m.market_cents != null && `market ${usd(m.market_cents)}`, m.floor_cents != null && `floor ${usd(m.floor_cents)}`].filter(Boolean).join(' · ');
      lines.push({ b: `US ${m.size} · ${m.sku} ${WORD[m.action] || m.action}`, t: ` ${usd(m.from_cents)} → ${usd(m.to_cents)}${bits ? `  (${bits})` : ''}${m.failed ? ` ⚠️ ${m.failed} failed` : ''}` });
      if (m.restored && m.action !== 'restore') lines.push(`   🔒 had been changed outside the app (${usd(m.from_cents)})`);
      if (m.action === 'rebase') lines.push('   market under our floor 2 h+ — now the price we set');
    }
  }
  return lines;
}
async function sendCrossPriceAlert(lines) {
  const chat = await crossPriceChatId();
  if (!chat) throw new Error('No Telegram chat is set for cross-listing.');
  await sendToChat(chat, lines);
}

// One full pass. `groupId` = one shoe only; `force` = competition even with its master
// switch off (tests only).
let running = false;
export async function runCrossCompetition(opts = {}) {
  if (running) return { ok: false, busy: true };
  running = true;
  const sum = { checked: 0, moved: 0, held: 0, errors: 0, stopped: false, notified: false };
  const moves = [];
  try {
    const cfg = await crossCompSettings();
    const master = cfg.master || !!opts.force;
    if (!master && !cfg.lock) return { ok: true, off: true };
    for (const row of await crossCompRows()) {
      if (opts.groupId && Number(row.group_id) !== Number(opts.groupId)) continue;
      if (!row.live) continue;
      const mode = compEffective({ master, all: cfg.all, sku: groupSetting(row), override: row.comp_override });
      if (!mode && !cfg.lock) continue;
      sum.checked++;
      try {
        const r = await competeCrossOne(row, mode, { ...opts, lock: cfg.lock });
        if (!r) continue;
        if (['down', 'up', 'floor', 'rebase', 'restore'].includes(r.action) && r.from_cents !== r.to_cents) { sum.moved++; moves.push(r); }
        else if (r.action === 'error') sum.errors++; else sum.held++;
        if (r.stop) { sum.stopped = true; break; }
      } catch (e) {
        sum.errors++;
        console.error('[cross-compete]', row.sku, row.size, e.message);
        await insertCrossCompLog({ pool_id: Number(row.pool_id), group_sku_id: Number(row.group_sku_id), mode, action: 'error', note: e.message.slice(0, 400) }).catch(() => {});
      }
    }
    // Also what tells an open Compete tab to re-read (app_settings is a live table).
    await setSetting('cross_comp_last_run', new Date().toISOString(), ACTOR);
    if (moves.length) {
      const notify = opts.notify || sendCrossPriceAlert;
      try { for (const part of chunks(crossPriceLines(moves))) await notify(part); sum.notified = true; }
      catch (e) { console.error('[cross-compete] price alert', e.message); sum.notifyError = e.message; }
    }
    return { ok: true, ...sum };
  } finally { running = false; }
}
export const crossCompetitionRunning = () => running;
