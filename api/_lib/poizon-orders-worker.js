// POIZON orders kept current by itself (docs/context/poizon-orders.md): every 10 minutes, read the
// Shopify orders changed since the last run and keep POIZON's. Read-only on Shopify. Production
// only by default; POIZON_ORDERS_WATCH=on|off overrides (a dev machine reads on "Check now").
import { runPoizonOrdersSync, readSync, syncRunning } from './poizon-orders.js';
import { shopifyConfigured } from './shopify.js';
import { dbConfigured } from './db.js';

const everyMs = () => Math.max(2, Number(process.env.POIZON_ORDERS_MIN) || 10) * 60_000;

export function poizonOrdersWorkerEnabled(env = process.env) {
  const flag = String(env.POIZON_ORDERS_WATCH || '').trim().toLowerCase();
  if (flag === 'on') return true;
  if (flag === 'off') return false;
  return String(env.RAILWAY_ENVIRONMENT_NAME || '').trim().toLowerCase() === 'production';
}

export async function poizonOrdersTick() {
  if (!dbConfigured() || !shopifyConfigured()) return;
  if (syncRunning(await readSync())) return;
  await runPoizonOrdersSync({ by: 'auto' });
}

export function startPoizonOrdersWorker() {
  if (!poizonOrdersWorkerEnabled()) return;
  const every = everyMs();
  console.log(`[poizon-orders] worker on: Shopify orders every ${every / 60_000} min`);
  const run = () => poizonOrdersTick().catch((e) => console.error('[poizon-orders] tick', e.message));
  setTimeout(() => { run(); setInterval(run, every); }, 3 * 60_000);
}
