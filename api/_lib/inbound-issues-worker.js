// Inbound issues worker (docs/context/inbound-issues.md) — the oversight summary.
//
// Every morning (10:00 EST, the start of the PH shift) whoever has "Daily inbound issues
// summary" on (admins by default — Genesis's oversight) gets every open case: who owns
// each, which ones NOBODY has taken (24 h+), and which have stopped moving (3+ days). It is
// the "nothing gets overlooked" half of the owner's ask: a case can't sit quietly the way
// a box on the shelf did, because it is named in a message every day until it is closed.
//
// Also: a case still on New after 4 h (INBOUND_ISSUES_REMIND_HOURS) is sent to PH once more.
//
// Production only by default (dev and prod share one Telegram bot); INBOUND_ISSUES_WORKER
// =on / =off overrides, INBOUND_ISSUES_DIGEST_HOUR_EST moves the hour.
import { listOpenInboundIssues, countInboundIssuesResolvedOn, listUnclaimedInboundIssues } from './db.js';
import { alertInboundIssuesDaily, alertInboundIssueUnclaimed } from './alerts.js';
import { estToday, estCivil, ymd } from '../../src/lib/format.js';

const TICK_MS = 10 * 60 * 1000;
// A case still on New after this many hours is sent to PH once more (INBOUND_ISSUES_REMIND_HOURS).
const remindHours = () => {
  const h = Number(process.env.INBOUND_ISSUES_REMIND_HOURS);
  return Number.isInteger(h) && h > 0 && h <= 72 ? h : 4;
};
const digestHour = () => {
  const h = Number(process.env.INBOUND_ISSUES_DIGEST_HOUR_EST);
  return Number.isInteger(h) && h >= 0 && h <= 23 ? h : 10;
};
const estHour = (d = new Date()) => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(d));
// Yesterday's EST calendar day, as YYYY-MM-DD.
function estYesterday() {
  const d = estCivil(); // noon UTC on today's EST date
  d.setUTCDate(d.getUTCDate() - 1);
  return ymd(d);
}

export function inboundIssuesWorkerEnabled(env = process.env) {
  const flag = String(env.INBOUND_ISSUES_WORKER || '').trim().toLowerCase();
  if (flag === 'on') return true;
  if (flag === 'off') return false;
  return String(env.RAILWAY_ENVIRONMENT_NAME || '').trim().toLowerCase() === 'production';
}

let lastDay = null;
export async function inboundIssuesTick(now = new Date()) {
  // The re-ping first: it is per case and `once`, so a tick that repeats it says nothing.
  for (const r of await listUnclaimedInboundIssues(remindHours())) await alertInboundIssueUnclaimed(r);
  const day = estToday();
  if (lastDay === day || estHour(now) < digestHour()) return { sent: false };
  lastDay = day; // set first: a failed send is not retried every 10 minutes
  const rows = await listOpenInboundIssues();
  const closedYesterday = await countInboundIssuesResolvedOn(estYesterday());
  // Nothing open and nothing closed is not news.
  if (!rows.length && !closedYesterday) return { sent: false };
  await alertInboundIssuesDaily({ day, rows, closedYesterday, now: now.getTime() });
  return { sent: true, open: rows.length };
}

let started = false;
export function startInboundIssuesWorker() {
  if (started) return;
  if (!inboundIssuesWorkerEnabled()) {
    console.log('[inbound-issues-worker] off (production only; INBOUND_ISSUES_WORKER=on to force)');
    return;
  }
  started = true;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { await inboundIssuesTick(); } catch (e) { console.error('[inbound-issues-worker]', e.message); } finally { busy = false; }
  };
  setTimeout(tick, 20_000);
  setInterval(tick, TICK_MS);
  console.log(`[inbound-issues-worker] on — re-ping untaken cases after ${remindHours()} h, daily summary from ${digestHour()}:00 EST`);
}
