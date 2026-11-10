// Listings kept fresh by the server every 30 min (owner, 2026-11-10; docs/context/shopify-listings.md
// "Kept fresh by the server", docs/context/ebay-listings.md "Pulled every 30 min").
//   • Shopify Listings: full re-read of every variant, then market prices for in-stock sizes.
//   • eBay Listings: the same pull as the "Pull listings" button.
// SHEIN Listings runs its own re-read (api/_lib/shein-listing.js listingTick, every 30 min).
// Production only by default: dev and prod share one Shopify store and one eBay account, and each
// pass spends API calls. LISTINGS_WATCH=on|off overrides; LISTINGS_WATCH_MIN sets the period.
import { dbConfigured } from './db.js';
import { shopifyFullCheck, marketPass } from './listings-watch.js';

export function listingsWatchEnabled(env = process.env) {
  const flag = String(env.LISTINGS_WATCH || '').trim().toLowerCase();
  if (flag === 'on') return true;
  if (flag === 'off') return false;
  return String(env.RAILWAY_ENVIRONMENT_NAME || '').trim().toLowerCase() === 'production';
}
const everyMs = () => Math.max(5, Number(process.env.LISTINGS_WATCH_MIN) || 30) * 60_000;

async function shopifyTick() {
  if (!dbConfigured()) return;
  const r = await shopifyFullCheck('auto (every 30 min)');
  if (r.error || r.skipped) return;
  await marketPass().catch((e) => console.error('[listings-watch] market', e.message));
}
async function ebayTick() {
  if (!dbConfigured()) return;
  const { autoPull } = await import('../ebay/pull.js');
  const r = await autoPull('auto (every 30 min)');
  if (r.skipped) console.log(`[listings-watch] eBay pull skipped: ${r.skipped}`);
}

export function startListingsWatchWorker() {
  if (!listingsWatchEnabled()) return;
  const every = everyMs();
  console.log(`[listings-watch] on: Shopify + eBay listings every ${every / 60_000} min`);
  const run = (name, fn) => () => fn().catch((e) => console.error(`[listings-watch] ${name}`, e.message));
  // Staggered: Shopify 90 s after start, eBay 5 min after (the eBay Sync worker's own passes start at 1 and 6 min).
  setTimeout(() => { run('shopify', shopifyTick)(); setInterval(run('shopify', shopifyTick), every); }, 90_000);
  setTimeout(() => { run('ebay', ebayTick)(); setInterval(run('ebay', ebayTick), every); }, 5 * 60_000);
}
