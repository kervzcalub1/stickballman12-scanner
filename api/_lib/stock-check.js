// Stock Check, server side (docs/context/inventory.md "Stock Check"): what a scanned code
// IS, and what Shopify holds for it. Shared by the scan, count and My Scans endpoints.
import { cleanUpc } from './util.js';
import { getItemByVin, checkVinStock } from './db.js';
import { resolveUpc } from '../upc-search.js';
import { shopifyLiveForStyle } from './shopify.js';
import { shopifyHoldings } from '../../src/lib/shopifyCheck.js';
import { isVinCode } from '../../src/lib/codes.js';
import { pairVerdict } from '../../src/lib/stockCheck.js';

export async function readShopify(sku) {
  const codes = [...new Set(String(sku).split('/').map((c) => c.trim().toUpperCase()).filter(Boolean))].slice(0, 4);
  const shops = await Promise.all(codes.map((c) => shopifyLiveForStyle(c)));
  const checkedAt = new Date().toISOString();
  // Unreadable is never "Shopify has none" — say which it is.
  const failed = shops.find((s) => s.error);
  if (failed) return { checkedAt, products: [], error: failed.error };
  return { checkedAt, products: shopifyHoldings(shops.flatMap((s) => s.variants || [])) };
}

// code -> { kind, shoe, pair, sticker, verdict }
//   VIN -> the pair's record + its status-change events (no pair: the sticker's state)
//   UPC -> which shoe + size (the receiving resolver)
//   else a SKU (`size` narrows it)
export async function resolveStockCode(code, size = '') {
  let kind; let shoe = null; let pair = null; let sticker = null;
  if (isVinCode(code) || /^SB-\d+$/i.test(code)) {
    kind = 'vin';
    const vin = code.toUpperCase();
    const d = await getItemByVin(vin);
    if (d?.item) {
      const it = d.item;
      pair = {
        vin: it.vin, status: it.status,
        events: (d.events || []).filter((e) => e.type === 'status_change')
          .map((e) => ({ type: e.type, details: { status: e.details?.status }, created_at: e.created_at })),
        location_label: it.location_label || null, location_code: it.location_code || null,
      };
      shoe = { sku: it.sku || null, size: it.size || null, name: it.name || null, image: null };
    } else {
      sticker = await checkVinStock(vin).catch(() => null);
      if (!sticker || !sticker.state) sticker = { state: 'unknown' };
    }
  } else if (/^\d[\d\s]*$/.test(code) && cleanUpc(code)) {
    kind = 'upc';
    const hit = await resolveUpc(cleanUpc(code));
    if (hit?.sku) shoe = { sku: hit.sku, size: hit.scannedSize || null, name: hit.fb?.name || null, image: hit.fb?.image || null, ambiguous: !!hit.ambiguous };
  } else {
    kind = 'sku';
    shoe = { sku: code.toUpperCase(), size: String(size || '').trim() || null, name: null, image: null };
  }
  const verdict = pair ? pairVerdict(pair, pair.events) : null;
  return { kind, shoe, pair, sticker, verdict };
}

// The verdict word stored on a scan: in / out / warn, 'gone' for a sticker no pair
// wears, 'unknown' for a code we couldn't place, null for a SKU/UPC (no pair to judge).
export function verdictWord(r) {
  if (r.verdict) return r.verdict.tone;
  if (r.sticker) return 'gone';
  if (!r.shoe) return 'unknown';
  return null;
}

// How the code was entered, as the browser reports it. Only a hint — anything that isn't
// one of these is stored as unknown rather than trusted.
export const cleanVia = (v) => (['scanner', 'camera', 'typed'].includes(v) ? v : null);
