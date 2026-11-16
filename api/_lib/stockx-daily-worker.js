// StockX DAILY price update — the once-a-day run (docs/context/stockx-reprice.md → "Daily,
// automatic"). Every day at the set EST hour: read every Direct listing + its market (the same
// pull the page's button does, ~15 min), save the day's picture, and — when an admin has turned
// the automatic update ON — queue every price the rules lower. stockx-reprice-worker.js sends
// them. A summary goes to the price-alert Telegram group.
//
// Production only (RAILWAY_ENVIRONMENT_NAME=production), or STOCKX_DAILY=on; STOCKX_DAILY=off
// stops it anywhere. Dev and prod share ONE StockX account and a dev database is a copy, so a
// dev server must never run this by itself.
import { dbConfigured, getStockxDaily, saveStockxDaily } from './db.js';
import { stockxConfigured } from './stockx.js';
import { sendPriceAlert } from './telegram.js';
import { runStockxPull } from '../stockx/listings.js';
import { readAuto, recordStockxDay, queueStockxAuto, estDay, estHour, AUTO_BY } from './stockx-daily.js';

const EVERY_MS = 5 * 60 * 1000;
const RETRY_MS = 30 * 60 * 1000;
const MAX_TRIES = 3;
const BAD_READ = 0.1;    // more than 10 % of the sizes without a market answer = don't act on it
let running = false;
let started = false;

export function stockxDailyEnabled(env = process.env) {
  const flag = String(env.STOCKX_DAILY || '').trim().toLowerCase();
  if (flag === 'on') return true;
  if (flag === 'off') return false;
  return String(env.RAILWAY_ENVIRONMENT_NAME || '').trim().toLowerCase() === 'production';
}
export const stockxDailyRunning = () => running;

const n = (v) => Number(v || 0).toLocaleString('en-US');
function summaryLines(day, s, stats, auto) {
  const lines = [{ b: `StockX daily price update — ${day}` }];
  if (auto.failed) lines.push(`⚠ ${auto.failed}`);
  else if (auto.off) lines.push(`Automatic update is OFF — nothing was changed. ${n(stats.ready)} listings are ready to lower (−$${n(stats.readyUsd)}).`);
  else lines.push(`Lowering ${n(auto.queued)} listing${auto.queued === 1 ? '' : 's'}${auto.cutUsd != null ? ` (−$${n(auto.cutUsd)} in asks)` : ''} to the Standard lowest ask.`);
  if (stats) {
    lines.push(`${n(stats.active)} live · ${n(stats.over)} over the Standard lowest ask ($${n(stats.overUsd)} over in total).`);
    if (stats.review) lines.push(`${n(stats.review)} need a look — a big cut with no cost on file (−$${n(stats.reviewUsd)}).`);
    if (stats.floorStops) lines.push(`${n(stats.floorStops)} stopped by the floor (the market is under what they cost us).`);
  }
  return lines;
}

/**
 * One full daily pass: market read → the day's record → (when the switch is ON) queue the
 * changes. Also what an admin's "Run today's update now" calls — the switch still decides
 * whether a price moves; the button only means "don't wait for the hour".
 */
export async function runStockxDaily(by = AUTO_BY) {
  if (running) return { ok: false, error: 'The daily update is already running.' };
  running = true;
  const day = estDay();
  const prev = (await getStockxDaily(day).catch(() => null))?.auto || {};
  const tries = Number(prev.tries || 0) + 1;
  try {
    const s = await readAuto();
    const pull = await runStockxPull(by);
    if (!pull.ok) throw new Error(`The market read failed: ${pull.error || 'unknown error'}`);
    const { rows, stats } = await recordStockxDay(s);
    if (pull.sizes > 0 && pull.marketFailed / pull.sizes > BAD_READ)
      throw new Error(`The market read was incomplete (${pull.marketFailed} of ${pull.sizes} sizes had no answer) — no price was changed.`);
    let auto;
    if (!s.on) {
      auto = { at: new Date().toISOString(), by, off: true, tries };
      await saveStockxDaily(day, { auto });
    } else {
      auto = { ...(await queueStockxAuto(rows, s, by)), tries };
      await saveStockxDaily(day, { auto });
    }
    await sendPriceAlert(summaryLines(day, s, stats, auto)).catch(() => {});
    return { ok: true, auto, stats };
  } catch (e) {
    console.error('[stockx-daily]', e.message);
    const auto = { at: new Date().toISOString(), by, failed: e.message, tries };
    await saveStockxDaily(day, { auto }).catch(() => {});
    if (tries >= MAX_TRIES) await sendPriceAlert(summaryLines(day, null, null, auto)).catch(() => {});
    return { ok: false, error: e.message };
  } finally { running = false; }
}

// Is it time? Once the EST hour has come and today has no finished run (a failed one is tried
// again after 30 min, three times at most).
export function dailyDue(settings, todayRow, now = new Date()) {
  if (estHour(now) < settings.hour) return false;
  const a = todayRow?.auto;
  if (!a) return true;
  if (!a.failed) return false;
  return Number(a.tries || 1) < MAX_TRIES && now.getTime() - Date.parse(a.at) >= RETRY_MS;
}

export async function stockxDailyTick() {
  if (running || !dbConfigured() || !stockxConfigured()) return;
  try {
    const s = await readAuto();
    if (dailyDue(s, await getStockxDaily(estDay()))) await runStockxDaily();
  } catch (e) { console.error('[stockx-daily] tick', e.message); }
}

export function startStockxDailyWorker() {
  if (started) return;
  if (!stockxDailyEnabled()) { console.log('[stockx-daily] off here (production only; STOCKX_DAILY=on to force)'); return; }
  if (!stockxConfigured()) { console.log('[stockx-daily] StockX not configured — idle'); return; }
  started = true;
  setInterval(stockxDailyTick, EVERY_MS).unref?.();
  setTimeout(stockxDailyTick, 60_000).unref?.();
  console.log('[stockx-daily] worker on');
}
