// eBay Sync, kept running by itself (docs/context/ebay-sync.md). Staggered timers, one pass at a time
// each, never blocking the server. Production only by default: dev and prod share ONE eBay account
// and one Shopify store. EBAY_SYNC_WORKER=on|off overrides. Missing EBAY_ / SHOPIFY_ env is fine:
// a pass just records "not connected".
import { runPass } from './ebay-sync.js';
import { dbConfigured } from './db.js';

export const EVERY = { queue: 30_000, reconcile: 30 * 60_000, content: 30 * 60_000, create: 30 * 60_000 };
// Start-up offsets so the heavy passes don't land together.
export const FIRST = { queue: 20_000, reconcile: 60_000, content: 6 * 60_000, create: 12 * 60_000 };

export function ebaySyncWorkerEnabled(env = process.env) {
  const flag = String(env.EBAY_SYNC_WORKER || '').trim().toLowerCase();
  if (flag === 'on') return true;
  if (flag === 'off') return false;
  return String(env.RAILWAY_ENVIRONMENT_NAME || '').trim().toLowerCase() === 'production';
}

export function startEbaySyncWorker() {
  if (!ebaySyncWorkerEnabled()) return;
  console.log('[ebay-sync] worker on: queue 30 s, reconcile / content / create 30 min');
  for (const name of Object.keys(EVERY)) {
    const tick = () => { if (dbConfigured()) runPass(name).catch((e) => console.error(`[ebay-sync] ${name}`, e.message)); };
    setTimeout(() => { tick(); setInterval(tick, EVERY[name]); }, FIRST[name]);
  }
}
