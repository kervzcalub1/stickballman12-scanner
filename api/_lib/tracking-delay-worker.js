// Tracking delay worker (docs/context/online-orders.md "Expected This Week").
//
// Two jobs, every 10 minutes:
//   · gives 17TRACK any open online order's number it hasn't had yet, so those parcels get a
//     status and a date. Claimed first, so each number is only ever paid for once;
//   · at 10:00 EST (the start of the PH shift), tells the team which tracking numbers haven't
//     moved in a week and who to chase. A stall is announced once, then reminded weekly, and a
//     parcel that moves and stops again is a new delay.
//
// Production only by default, since dev and prod share one bot and one 17TRACK account.
// TRACKING_DELAY_WORKER=on / =off overrides, TRACKING_DELAY_HOUR_EST moves the hour.
import { listExpectedShipments, listUnregisteredOnlineTracking, claimForTracking, trackingDelayState, markTrackingDelayAlerted } from './db.js';
import { registerWarehouseTracking, normalizeTrackingNumber } from './tracking.js';
import { alertTrackingDelayed } from './alerts.js';
import { delayedShipments } from '../../src/lib/expected.js';
import { estToday } from '../../src/lib/format.js';

const TICK_MS = 10 * 60 * 1000;
const REMIND_DAYS = 7;
const digestHour = () => {
  const h = Number(process.env.TRACKING_DELAY_HOUR_EST);
  return Number.isInteger(h) && h >= 0 && h <= 23 ? h : 10;
};
const estHour = (d = new Date()) => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(d));

export function trackingDelayWorkerEnabled(env = process.env) {
  const flag = String(env.TRACKING_DELAY_WORKER || '').trim().toLowerCase();
  if (flag === 'on') return true;
  if (flag === 'off') return false;
  return String(env.RAILWAY_ENVIRONMENT_NAME || '').trim().toLowerCase() === 'production';
}

// Which delayed parcels are news today. Pure, so the once-then-weekly rule can be tested.
export function splitDelayAlerts(rows, state, now = Date.now()) {
  const fresh = [];
  const reminders = [];
  for (const r of rows) {
    const was = state[r.number];
    const sameStall = was && new Date(was.last_move_at || 0).getTime() === new Date(r.last_move_at || 0).getTime();
    if (!sameStall) fresh.push(r);
    else if (now - new Date(was.last_alerted_at).getTime() >= REMIND_DAYS * 86400000) reminders.push(r);
  }
  return { fresh, reminders };
}

let lastDay = null;
export async function trackingDelayTick({ now = new Date(), force = false } = {}) {
  const backlog = await listUnregisteredOnlineTracking();
  if (backlog.length) {
    await registerWarehouseTracking(backlog.map(normalizeTrackingNumber), { claim: claimForTracking, label: 'tracking-delay-worker' });
  }
  const day = estToday();
  if (!force && (lastDay === day || estHour(now) < digestHour())) return { sent: false };
  lastDay = day; // set first: a failed send is not retried every 10 minutes
  const rows = delayedShipments(await listExpectedShipments(), now.getTime());
  const { fresh, reminders } = splitDelayAlerts(rows, await trackingDelayState(rows.map((r) => r.number)), now.getTime());
  if (!fresh.length && !reminders.length) return { sent: false, delayed: rows.length };
  const out = await alertTrackingDelayed({ day, fresh, reminders });
  // Only what really went out counts as told. After a restart the day's message has already
  // gone ("already sent"), or Telegram may be off: those parcels wait for the next run.
  if (out?.reason) return { sent: false, reason: out.reason };
  await markTrackingDelayAlerted([...fresh, ...reminders]);
  return { sent: true, fresh: fresh.length, reminders: reminders.length };
}

let started = false;
export function startTrackingDelayWorker() {
  if (started) return;
  if (!trackingDelayWorkerEnabled()) {
    console.log('[tracking-delay-worker] off (production only; TRACKING_DELAY_WORKER=on to force)');
    return;
  }
  started = true;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { await trackingDelayTick(); } catch (e) { console.error('[tracking-delay-worker]', e.message); } finally { busy = false; }
  };
  setTimeout(tick, 30_000);
  setInterval(tick, TICK_MS);
  console.log(`[tracking-delay-worker] on — delayed shipments from ${digestHour()}:00 EST`);
}
