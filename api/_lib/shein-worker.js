// SHEIN live sync, kept running by itself (docs/context/shein-live-fix.md):
//   · every 10 seconds — brand-new SHEIN orders → their pairs off Shopify, ahead of the webhook;
//   · every minute — SHEIN orders changed since the last look → their pairs off Shopify
//     (the backstop behind SHEIN's webhook), and any unit that failed is retried;
//   · every 3 hours, when "Shopify → SHEIN" is on — a stock-only walk of every SHEIN
//     product (the backstop behind Shopify's webhook, which Shopify doesn't guarantee);
//   · SHEIN Listings — the nightly listing snapshot at 03:00 EST + its job leases (shein-listing.js).
// Production only by default: dev and prod share the SHEIN and Shopify accounts, and only one
// of them may take a sale off Shopify. SHEIN_SYNC_WATCH=on|off overrides.
import { dbConfigured, latestSheinLiveRun } from './db.js';
import { sheinStatus, sheinConfigured } from './shein.js';
import { pollOrders, actOnUnits, readSync, syncShopifyOrders, fulfilShippedOrders, checkNewOrders } from './shein-orders.js';
import { heartbeat, startWalk, walkActive, resumePushes } from './shein-live.js';
import { listingTick } from './shein-listing.js';

const EVERY_MS = 60 * 1000;
const NEW_ORDERS_MS = 10 * 1000;
const QUIET_ERRORS_MS = 5 * 60 * 1000;
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
    // Shipped SHEIN orders → Shopify orders. Its own catch: it must never stop the stock sync.
    await syncShopifyOrders().catch((e) => console.error('[shein-sync] shopify orders', e.message));
    await fulfilShippedOrders().catch((e) => console.error('[shein-sync] fulfil orders', e.message));
    if (sync.push === 'on' && !walkActive()) {
      const last = await latestSheinLiveRun();
      if (walkDue(last)) {
        const by = last?.status === 'interrupted' ? AFTER_RESTART : 'auto (every 3 h)';
        await startWalk({ mode: 'stock', by, ai: false }).catch((e) => console.error('[shein-sync] rewalk', e.message));
      }
    }
    // SHEIN Listings (docs/context/shein-listings.md): job leases, the 03:00 EST nightly snapshot,
    // the API-log prune. Read-only; its own try so it can never stop the sales sync above.
    await listingTick().catch((e) => console.error('[shein-listing] tick', e.message));
  } catch (e) {
    console.error('[shein-sync] tick', e.message);
  } finally { busy = false; }
}

// SHEIN_FAST_ORDER_CHECK=off stops the 10-second check; the webhook and the minute poll carry on.
export const fastCheckEnabled = (env = process.env) => String(env.SHEIN_FAST_ORDER_CHECK || '').trim().toLowerCase() !== 'off';

// Its own flag, not the minute tick's: a slow tick must not hold up a new order, and this must not
// hold up the tick. If it fails, the webhook and the minute poll still catch the order.
let checking = false;
let lastCheckError = 0;
export async function sheinNewOrderTick() {
  if (checking || !dbConfigured() || !sheinConfigured()) return;
  checking = true;
  try {
    if ((await readSync()).orders !== 'on') return;
    const st = await sheinStatus().catch(() => null);
    if (!st?.connected) return;
    const r = await checkNewOrders();
    if (r) console.log(`[shein-sync] 10-second check: ${r.orders} new order(s) → ${r.deducted} off Shopify, ${r.failed} failed`);
  } catch (e) {
    // Six times a minute: a SHEIN outage shouldn't fill the log.
    if (Date.now() - lastCheckError > QUIET_ERRORS_MS) { lastCheckError = Date.now(); console.error('[shein-sync] 10-second check', e.message); }
  } finally { checking = false; }
}

export function startSheinWorker() {
  if (!sheinWorkerEnabled()) return;
  console.log('[shein-sync] worker on — SHEIN orders → Shopify every minute');
  resumePushes();
  setInterval(() => { sheinTick(); }, EVERY_MS);
  if (fastCheckEnabled()) setInterval(() => { sheinNewOrderTick(); }, NEW_ORDERS_MS);
}
