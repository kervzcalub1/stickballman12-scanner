// Pre-sell MARKET COMPETITION — the engine (docs/context/presell-listings.md → "Market
// competition"). Owner, 2026-10-11: keep our live listings at the market — undercut the
// lowest ask by $1, or match it — never more than $5 under the price we set, and follow the
// market UP with no cap. Each size on each platform on its own.
//
// One pass (every PRESELL_COMP_EVERY_MIN, default 30, from presell-worker.js — so only where
// PRESELL_WATCH=on, the one environment allowed to act on the shared accounts):
//   for each size that competes (compEffective) × each platform with LIVE listings:
//     1. read OUR live price back from the platform (one listing) — the DB can be stale: on
//        2026-10-11 Alias showed $161 for pairs we had at $284, changed outside this app.
//        A difference is logged as 'drift' and the row synced.
//     2. read the market's lowest ask (Alias: the lower of With You / consigned; StockX: the
//        Direct market we list on).
//     3. compDecide (src/lib/presellCompete.js) → move every live listing of that size to
//        the target, one at a time (StockX through its throttle queue; a 429 ends the pass).
//   A size with a StockX change still pending is skipped until StockX confirms.
// Every move, floor hit, drift and error is written to presell_comp_log.
import {
  presellCompSettings, presellCompSkus, presellCompRows, livePresellListings, setPresellCompBase, setPresellLock,
  savePresellCompState, insertPresellCompLog, setSetting,
} from './db.js';
import { sendPriceAlert } from './telegram.js';
import { PLATFORMS, applyResult } from './presell.js';
import { aliasCatalogBySku, aliasPriceInsights } from './alias.js';
import { stockxDirectMarket, stockxVariantFor } from './stockx.js';
import { compDecide, compEffective, compFarCheck, compFloor } from '../../src/lib/presellCompete.js';

const cents = (dollars) => (Number(dollars) > 0 ? Math.round(Number(dollars) * 100) : null);

// The market's lowest ask for one size, in cents (null = none).
export async function marketLowest(platform, row, cache = {}) {
  if (platform === 'alias') {
    const k = `a|${row.sku}`;
    cache[k] ??= await aliasCatalogBySku(row.sku);
    const cat = cache[k];
    if (!cat?.catalogId) return null;
    const size = Number.isFinite(cat.sizeValues?.[row.size]) ? cat.sizeValues[row.size] : row.size;
    const [wy, cn] = await Promise.all([
      aliasPriceInsights({ catalogId: cat.catalogId, size, consigned: false }),
      aliasPriceInsights({ catalogId: cat.catalogId, size, consigned: true }),
    ]);
    const asks = [cents(wy?.lowestListing), cents(cn?.lowestListing)].filter(Boolean);
    return asks.length ? Math.min(...asks) : null;
  }
  const v = await stockxVariantFor(row.sku, row.size);
  if (!v) return null;
  const m = await stockxDirectMarket(v.productId, v.variantId);
  return cents(m?.lowestAsk);
}

const is429 = (e) => /too many|429/i.test(String(e || ''));
const PLAT = { alias: 'Alias', stockx: 'StockX' };

// One size on one platform. `mode` = 'undercut' | 'match' when it competes, null when only
// the 🔒 lock applies. Returns the log entry (or null when there was nothing live).
export async function competeOne(row, platform, mode, { platforms = PLATFORMS, market = marketLowest, cache = {}, lock = true, now = Date.now() } = {}) {
  const live = await livePresellListings(row.id, platform);
  if (!live.length) return null;
  const log = { stock_id: row.id, platform, mode, sku: row.sku, size: row.size, name: row.name };
  // 1. our live price, from the platform — the DB can be stale.
  const back = await platforms[platform].refresh(live[0]);
  if (!back.ok) {
    await insertPresellCompLog({ ...log, action: 'error', note: `Couldn't read our listing back: ${back.error}` });
    return { ...log, action: 'error', stop: is429(back.error) };
  }
  if (back.status && back.status !== 'live') {
    // Sold / switched off / deleted on the platform since we last looked: sync, don't price it.
    await applyResult(live[0], back, 'competition');
    return { ...log, action: 'skip' };
  }
  const livePrice = back.price_cents ?? Number(live[0].price_cents);
  if (livePrice !== Number(live[0].price_cents)) await applyResult(live[0], back, 'competition');
  // 2. 🔒 the price THIS APP last set. First time → adopt the live one (never push an old price up).
  const lockKey = `lock_${platform}_cents`;
  let locked = row[lockKey];
  if (locked == null) { locked = livePrice; await setPresellLock(row.id, platform, locked); }
  let restore = false;
  if (livePrice !== locked) {
    if (lock) restore = true;   // changed outside the app → put it back (below)
    else {
      await insertPresellCompLog({ ...log, action: 'drift', from_cents: locked, to_cents: livePrice,
        note: `${PLAT[platform]} had ${livePrice / 100}, we had ${locked / 100} — changed outside the app; kept (lock is off)` });
      locked = livePrice; await setPresellLock(row.id, platform, locked);
    }
  }
  let target = locked;
  let action = restore ? 'restore' : 'hold';
  let mk = null; let floor = null; let base = row[`comp_base_${platform}_cents`];
  const prev = row.comp_state?.[platform] || {};
  let farSince = null;
  if (mode) {
    // 3. the market
    try { mk = await market(platform, row, cache); } catch (e) {
      await insertPresellCompLog({ ...log, action: 'error', from_cents: livePrice, note: `Market read failed: ${e.message}` });
      return { ...log, action: 'error', stop: is429(e.message) };
    }
    if (base == null) { base = locked; await setPresellCompBase(row.id, platform, base); }
    // The 2-hour rule: market under our floor for 2 h straight → the market is the new price we set.
    const far = compFarCheck({ marketCents: mk, floorCents: compFloor(base), farSince: prev.far_since, now });
    farSince = far.farSince;
    let rebased = false;
    if (far.rebase) { base = mk; await setPresellCompBase(row.id, platform, base); farSince = null; rebased = true; }
    const d = compDecide({ mode, marketCents: mk, currentCents: locked, baseCents: base });
    floor = d.floor;
    target = d.target;
    if (rebased) action = 'rebase';
    else if (d.action !== 'hold' && d.action !== 'none') action = d.action;
  }
  const state = { market: mk, price: livePrice, lock: locked, base, floor, action, far_since: farSince, at: new Date(now).toISOString() };
  if (target === livePrice) {
    // Nothing to write (a restore whose target equals the live price can't happen).
    await savePresellCompState(row.id, platform, { ...state, action: action === 'restore' ? 'hold' : action });
    if (action === 'rebase') await insertPresellCompLog({ ...log, action, market_cents: mk, from_cents: livePrice, to_cents: target, floor_cents: floor, note: 'Market under our floor for 2 h — it is the new price we set' });
    return { ...log, action: action === 'rebase' ? 'rebase' : 'hold', market_cents: mk, from_cents: livePrice, to_cents: target, floor_cents: floor };
  }
  // 4. move every live listing of this size to the target, one at a time.
  let changed = 0; let failed = 0; let stop = false; const errors = new Set();
  for (const l of live) {
    try {
      const out = await platforms[platform].update(l, { priceCents: target, sizeValue: null });
      if (!out.ok) { failed++; errors.add(out.error); if (is429(out.error)) { stop = true; break; } continue; }
      await applyResult(l, out, 'competition', platform === 'alias' && out.price_cents === undefined ? { price_cents: target } : {});
      changed++;
    } catch (e) { failed++; errors.add(e.message); }
  }
  if (changed) await setPresellLock(row.id, platform, target);
  await savePresellCompState(row.id, platform, { ...state, price: changed ? target : livePrice, lock: changed ? target : locked, moved_from: livePrice, moved_to: target });
  const notes = [];
  if (restore) notes.push(`${PLAT[platform]} had ${livePrice / 100} — changed outside the app; locked at ${locked / 100}`);
  if (action === 'rebase') notes.push(`Market under our floor for 2 h — it is the new price we set`);
  if (errors.size) notes.push([...errors].join(' · '));
  const entry = { ...log, action, market_cents: mk, from_cents: livePrice, to_cents: target, floor_cents: floor, changed, failed,
    restored: restore, note: notes.join(' · ').slice(0, 400) || null };
  await insertPresellCompLog(entry);
  return { ...entry, stop };
}

// One Telegram post per pass to the price-alert group (owner, 2026-10-11): every size that
// went up or down, hit the floor, was re-based, or was put back by the lock.
const usd = (c) => `$${(Number(c) / 100).toLocaleString('en-US', { minimumFractionDigits: Number(c) % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
const WORD = { down: '↓', up: '↑', floor: '⛔ floor', rebase: '↻ re-based', restore: '🔒 put back' };
export function priceAlertLines(moves, at = new Date()) {
  const by = new Map();
  for (const m of moves) { if (!by.has(m.sku)) by.set(m.sku, { name: m.name, rows: [] }); by.get(m.sku).rows.push(m); }
  const n = moves.length;
  const lines = [{ b: '⚔ PRE-SELL PRICE CHANGES' }, `${n} change${n === 1 ? '' : 's'} · ${at.toLocaleString('en-US', { timeZone: 'America/New_York', month: '2-digit', day: '2-digit', hour: 'numeric', minute: '2-digit' })} EST`];
  for (const [sku, g] of by) {
    lines.push('━━━━━━━━━━━━━━━━', { b: sku, t: g.name ? ` · ${g.name}` : '' });
    for (const m of g.rows) {
      const bits = [m.market_cents != null && `market ${usd(m.market_cents)}`, m.floor_cents != null && `floor ${usd(m.floor_cents)}`].filter(Boolean).join(' · ');
      lines.push({ b: `US ${m.size} · ${PLAT[m.platform]} ${WORD[m.action] || m.action}`, t: ` ${usd(m.from_cents)} → ${usd(m.to_cents)}${bits ? `  (${bits})` : ''}${m.failed ? ` ⚠️ ${m.failed} failed` : ''}` });
      if (m.restored && m.action !== 'restore') lines.push(`   🔒 had been changed outside the app (${usd(m.from_cents)})`);
      if (m.action === 'rebase') lines.push('   market under our floor 2 h+ — now the price we set');
    }
  }
  return lines;
}
// Telegram caps a message at 4096 characters — split on SKU boundaries well under that.
function chunks(lines, max = 3500) {
  const out = []; let cur = []; let len = 0;
  for (const l of lines) {
    const n = (typeof l === 'string' ? l : `${l.b}${l.t || ''}`).length + 1;
    if (len + n > max && cur.length) { out.push(cur); cur = []; len = 0; }
    cur.push(l); len += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

// One full pass: every live pre-sell size gets the 🔒 lock check; the ones in competition
// are priced too. `force` = competition even with its master switch off (tests only).
let running = false;
export async function runCompetition(opts = {}) {
  if (running) return { ok: false, busy: true };
  running = true;
  const sum = { sizes: 0, moved: 0, held: 0, errors: 0, stopped: false, notified: false };
  const moves = [];
  try {
    const cfg = await presellCompSettings();
    const master = cfg.master || !!opts.force;
    if (!master && !cfg.lock) return { ok: true, off: true };
    const skus = new Map((await presellCompSkus()).map((s) => [s.sku, s]));
    const cache = {};
    for (const row of await presellCompRows()) {
      if (opts.sku && row.sku !== opts.sku) continue;
      const mode = compEffective({ master, all: cfg.all, sku: skus.get(row.sku) || null, override: row.comp_override });
      if (!mode && !cfg.lock) continue;
      sum.sizes++;
      for (const platform of ['alias', 'stockx']) {
        if (!row[`${platform}_live`] || row[`${platform}_pending`]) continue;
        try {
          const r = await competeOne(row, platform, mode, { ...opts, cache, lock: cfg.lock });
          if (!r) continue;
          if (['down', 'up', 'floor', 'rebase', 'restore'].includes(r.action) && r.from_cents !== r.to_cents) { sum.moved++; moves.push(r); }
          else if (r.action === 'error') sum.errors++; else sum.held++;
          if (r.stop) { sum.stopped = true; break; }
        } catch (e) {
          sum.errors++;
          console.error('[presell-compete]', row.sku, row.size, platform, e.message);
          await insertPresellCompLog({ stock_id: row.id, platform, mode, action: 'error', note: e.message.slice(0, 400) }).catch(() => {});
        }
      }
      if (sum.stopped) break;
    }
    await setSetting('presell_comp_last_run', new Date().toISOString(), 'competition');
    if (moves.length) {
      const notify = opts.notify || sendPriceAlert;
      try { for (const part of chunks(priceAlertLines(moves))) await notify(part); sum.notified = true; }
      catch (e) { console.error('[presell-compete] price alert', e.message); sum.notifyError = e.message; }
    }
    return { ok: true, ...sum };
  } finally { running = false; }
}
export const competitionRunning = () => running;
