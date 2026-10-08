// Waitlist worker (docs/context/waitlist.md) — the two things about the waitlist that are
// about TIME rather than about somebody pressing a button:
//
//   1. "Back from the waitlist": a pair's hold ends by itself on its date (phListItems reads
//      waitlist_until — nothing has to run for the pair to reappear). This tells the person
//      who lists, once, so a pair held a month doesn't come back to nobody. The owner's
//      ask: "don't involve me, I'll forget" — so it is automatic, not a reminder to set.
//   2. The daily report: everything on hold as a CSV, at the end of the PH shift, for the
//      review (Alex + Kyleen) — sent as a file on Telegram to whoever has it switched on.
//
// Runs only where it should: dev and prod share ONE Telegram bot, and a laptop's copy of
// the app must never DM real people. On by default on Railway's production environment
// (RAILWAY_ENVIRONMENT_NAME, set by Railway itself), off everywhere else; WAITLIST_WORKER
// =on / =off overrides either way. `npm run dev` never starts it (server.mjs only).
import { claimWaitlistReturns, listWaitlist } from './db.js';
import { alertWaitlistBack, alertWaitlistDaily } from './alerts.js';
import { waitlistCsv, waitlistCsvName } from '../../src/lib/waitlist.js';
import { estToday } from '../../src/lib/format.js';

const TICK_MS = 5 * 60 * 1000;
// End of the PH night shift (~6–7am Manila) is ~6pm EST. Overridable, in EST hours.
const reportHour = () => {
  const h = Number(process.env.WAITLIST_REPORT_HOUR_EST);
  return Number.isInteger(h) && h >= 0 && h <= 23 ? h : 18;
};
const estHour = (d = new Date()) => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(d));

export function waitlistWorkerEnabled(env = process.env) {
  const flag = String(env.WAITLIST_WORKER || '').trim().toLowerCase();
  if (flag === 'on') return true;
  if (flag === 'off') return false;
  return String(env.RAILWAY_ENVIRONMENT_NAME || '').trim().toLowerCase() === 'production';
}

let lastDailyDay = null;

export async function waitlistTick(now = new Date()) {
  const back = await claimWaitlistReturns();
  if (back.length) await alertWaitlistBack(back);

  const day = estToday();
  if (lastDailyDay !== day && estHour(now) >= reportHour()) {
    lastDailyDay = day;   // set first: a failed send is not retried every 5 minutes
    const rows = await listWaitlist();
    // An empty waitlist is not a report — nothing to review, so nothing is sent.
    if (rows.length) await alertWaitlistDaily({ day, rows, csv: waitlistCsv(rows), filename: waitlistCsvName(day) });
  }
  return { back: back.length };
}

let started = false;
export function startWaitlistWorker() {
  if (started) return;
  if (!waitlistWorkerEnabled()) {
    console.log('[waitlist-worker] off (production only; WAITLIST_WORKER=on to force)');
    return;
  }
  started = true;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { await waitlistTick(); } catch (e) { console.error('[waitlist-worker]', e.message); } finally { busy = false; }
  };
  setTimeout(tick, 15_000);
  setInterval(tick, TICK_MS);
  console.log(`[waitlist-worker] on — returns every 5 min, daily report from ${reportHour()}:00 EST`);
}
