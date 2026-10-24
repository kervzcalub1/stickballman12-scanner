// SHEIN live sync, kept running by itself (docs/context/shein-live-fix.md):
//   · every minute — SHEIN orders changed since the last look → their pairs off Shopify
//     (the backstop behind SHEIN's webhook), and any unit that failed is retried;
//   · every 3 hours, when "Shopify → SHEIN" is on — a stock-only walk of every SHEIN
//     product (the backstop behind Shopify's webhook, which Shopify doesn't guarantee).
// Production only by default: dev and prod share the SHEIN and Shopify accounts, and only one
// of them may take a sale off Shopify. SHEIN_SYNC_WATCH=on|off overrides.
import { dbConfigured, latestSheinLiveRun } from './db.js';
import { sheinStatus, sheinConfigured } from './shein.js';
import { pollOrders, actOnUnits, readSync } from './shein-orders.js';
import { heartbeat, startWalk, walkActive, resumePushes } from './shein-live.js';

const EVERY_MS = 60 * 1000;
const REWALK_MS = 3 * 3600 * 1000;
export const AFTER_RESTART = 'auto (after a restart)';

// Start the stock walk now? Every 3 h — and at once when the last walk was cut off by a
// deploy/restart (it used to wait 3 h from the dead walk's START). Only once in a row, so a
// walk that itself kills the process can't loop.
export function walkDue(last, now = Date.now()) {
  if (!last) return true;
  if (last.status === 'running') return false;
  if (last.status === 'interrupted' && last.started_by !== AFTER_RESTART) return true;
  return now - new Date(last.started_at).getTime() > REWALK_MS;
}

export function sheinWorkerEnabled(env = process.env) {
  const flag = String(env.SHEIN_SYNC_WATCH || '').trim().toLowerCase();
  if (flag === 'on') return true;
  if (flag === 'off') return false;
  return String(env.RAILWAY_ENVIRONMENT_NAME || '').trim().toLowerCase() === 'production';
}

let busy = false;
export async function sheinTick() {
  if (busy || !dbConfigured() || !sheinConfigured()) return;
  busy = true;
  try {
    await heartbeat();
    const st = await sheinStatus().catch(() => null);
    if (!st?.connected) return;
    const sync = await readSync();
    if (sync.orders === 'on') await pollOrders();
    else await actOnUnits();   // put-backs of earlier sales still apply
    if (sync.push === 'on' && !walkActive()) {
      const last = await latestSheinLiveRun();
      if (walkDue(last)) {
        const by = last?.status === 'interrupted' ? AFTER_RESTART : 'auto (every 3 h)';
        await startWalk({ mode: 'stock', by, ai: false }).catch((e) => console.error('[shein-sync] rewalk', e.message));
      }
    }
  } catch (e) {
    console.error('[shein-sync] tick', e.message);
  } finally { busy = false; }
}

export function startSheinWorker() {
  if (!sheinWorkerEnabled()) return;
  console.log('[shein-sync] worker on — SHEIN orders → Shopify every minute');
  resumePushes();
  setInterval(() => { sheinTick(); }, EVERY_MS);
}
