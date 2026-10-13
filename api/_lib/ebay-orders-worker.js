// eBay orders, kept current by itself (docs/context/ebay-orders.md): every 30 minutes, an
// incremental sync (orders eBay changed + their tracking + money), so a late shipment
// shows without anyone pressing Sync. Production only by default (dev and prod share the
// eBay account and 17TRACK); EBAY_ORDERS_WATCH=on|off overrides.
import { runEbayOrdersSync, readSync, syncRunning } from './ebay-orders-sync.js';
import { ebayConfigured, ebayStatus } from './ebay.js';
import { dbConfigured } from './db.js';

const EVERY_MS = 30 * 60 * 1000;

export function ebayOrdersWorkerEnabled(env = process.env) {
  const flag = String(env.EBAY_ORDERS_WATCH || '').trim().toLowerCase();
  if (flag === 'on') return true;
  if (flag === 'off') return false;
  return String(env.RAILWAY_ENVIRONMENT_NAME || '').trim().toLowerCase() === 'production';
}

export async function ebayOrdersTick() {
  if (!dbConfigured() || !ebayConfigured()) return;
  const st = await ebayStatus().catch(() => null);
  if (!st?.connected || !st.canOrders) return;
  const s = await readSync();
  if (syncRunning(s) || !s?.lastOrdersAt) return;   // the first (YTD) load is a person's call
  await runEbayOrdersSync({ by: 'auto' });
}

export function startEbayOrdersWorker() {
  if (!ebayOrdersWorkerEnabled()) return;
  console.log('[ebay-orders] worker on — sync every 30 min');
  setInterval(() => { ebayOrdersTick().catch((e) => console.error('[ebay-orders] tick', e.message)); }, EVERY_MS);
}
