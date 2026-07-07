// PH grid domain logic: SKU+status grouping (flat + per-size), pricing,
// frozen-column geometry, /ph/* routing, and edit-lock timings.
import { sizeNum } from './codes.js';
import { getMarkupMult } from './config.js';

// Frozen columns and their fixed widths (px): Date, Title, SKU, Qty.
// Rows are merged per SKU+status; the size breakdown is a scrolling column.
export const PH_FROZEN_W = [86, 210, 120, 54];
const PH_LEFTS = PH_FROZEN_W.reduce((a, _w, i) => { a.push(i ? a[i - 1] + PH_FROZEN_W[i - 1] : 0); return a; }, []);
export const frozenStyle = (i) => ({ position: 'sticky', left: PH_LEFTS[i], minWidth: PH_FROZEN_W[i], width: PH_FROZEN_W[i] });
// Right-frozen columns: only Action stays sticky-right. "Added by" used to be
// frozen too (~254px of combined frozen-right width), which at typical desktop
// widths painted over the StockX sync badge and the "Scanned by" column. Added
// by now scrolls with the rest of the row — only Action (the narrower, more
// frequently-needed column) stays pinned.
const PH_ACTION_W = 104;
export const rightStyle = (which) => (which === 'addedby'
  ? {}
  : { position: 'sticky', right: 0, minWidth: PH_ACTION_W, width: PH_ACTION_W });

export const PH_FLAGS = [
  ['added_to_intel_inv', 'Intelligent Inv.'], ['synced_alias', 'Alias'],
  ['synced_stockx', 'StockX'], ['synced_shopify', 'Shopify'],
];
export const FLAG_KEYS = ['added_to_intel_inv', 'synced_alias', 'synced_stockx', 'synced_shopify'];

// Final price auto-derives from the global indicator: entered amount × markup
// (the configurable price margin, default +20%; see src/lib/config.js).
// Empty/non-numeric global indicator clears the final price.
export function calcFinalPrice(globalIndicator) {
  if (globalIndicator === '' || globalIndicator == null) return '';
  const n = Number(globalIndicator);
  if (!Number.isFinite(n)) return '';
  return (Math.round(n * getMarkupMult() * 100) / 100).toFixed(2);
}

// Merge into ONE row per SKU + status (regardless of size), because the PH team
// encodes a SKU to Intelligent Inventory once for all its sizes. The row lists
// each size with its quantity; Price + II/AL/SX/SH + Note are set once for the
// whole SKU and applied to every member VIN. A sync flag reads "Yes" only when
// ALL units have it (so a partially-synced SKU shows as not-done).
export function groupPhRows(list) {
  const map = new Map();
  for (const r of list) {
    const key = `${r.sku || ''}|#|${r.status || ''}`;
    let g = map.get(key);
    if (!g) {
      g = {
        ...r, key, vins: [], qty: 0, _mixedBy: false, _sizeMap: {}, _prices: new Set(), _globals: new Set(), _costs: new Set(),
        _flags: { added_to_intel_inv: true, synced_alias: true, synced_stockx: true, synced_shopify: true },
      };
      map.set(key, g);
    }
    g.vins.push(r.vin);
    g.qty += 1;
    const sz = r.size || '—';
    g._sizeMap[sz] = (g._sizeMap[sz] || 0) + 1;
    g._prices.add(r.price == null ? '' : String(r.price));
    g._globals.add(r.global_indicator == null ? '' : String(r.global_indicator));
    g._costs.add(r.cost == null ? '' : String(r.cost));
    for (const f of ['added_to_intel_inv', 'synced_alias', 'synced_stockx', 'synced_shopify']) g._flags[f] = g._flags[f] && !!r[f];
    if (r.created_by !== g.created_by) g._mixedBy = true;
    if (r.created_at < g.created_at) g.created_at = r.created_at; // earliest scan
    if (r.last_edit_at && (!g.last_edit_at || r.last_edit_at > g.last_edit_at)) {
      g.last_edit_at = r.last_edit_at; g.last_edit_by = r.last_edit_by;
    }
  }
  return [...map.values()].map((g) => ({
    ...g,
    ...g._flags, // representative flags = all-units-true
    priceMixed: g._prices.size > 1,
    globalMixed: g._globals.size > 1,
    costMixed: g._costs.size > 1,
    sizes: Object.entries(g._sizeMap).sort((a, b) => (sizeNum(a[0]) - sizeNum(b[0])) || String(a[0]).localeCompare(b[0])).map(([size, qty]) => ({ size, qty })),
  }));
}

// Like groupPhRows, but keeps a per-SIZE breakdown inside each SKU+status group
// (the PH grid's expandable detail). Cost / global indicator / final price are
// tracked PER SIZE (each can differ); II/AL/SX/SH + Note stay per-SKU (set once,
// applied to all sizes). `sizes[]` carries each size's vins, qty and its own
// cost/global_indicator/price (+ *Mixed flags when units within a size differ).
export function groupPhSized(list) {
  const map = new Map();
  for (const r of list) {
    const key = `${r.sku || ''}|#|${r.status || ''}`;
    let g = map.get(key);
    if (!g) {
      g = {
        key, sku: r.sku, name: r.name, status: r.status, gender: r.gender,
        photo_count: r.photo_count || 0, // per-SKU listing-photo count (all rows share it)
        photo_url: r.photo_url || null,  // preferred (side) listing photo for the thumbnail
        created_at: r.created_at, created_by: r.created_by, _mixedBy: false,
        vins: [], qty: 0,
        first_edit_at: null, first_edit_by: null, _hasSubsequent: false, _drift: false,
        last_edit_at: r.last_edit_at, last_edit_by: r.last_edit_by,
        _flags: { added_to_intel_inv: true, synced_alias: true, synced_stockx: true, synced_shopify: true },
        _sizes: new Map(),
      };
      map.set(key, g);
    }
    g.vins.push(r.vin); g.qty += 1;
    if (r.created_by !== g.created_by) g._mixedBy = true;
    if (r.created_at < g.created_at) g.created_at = r.created_at;
    if (r.last_edit_at && (!g.last_edit_at || r.last_edit_at > g.last_edit_at)) { g.last_edit_at = r.last_edit_at; g.last_edit_by = r.last_edit_by; }
    // First editor = earliest first_edit_at across the group ("Added by").
    if (r.first_edit_at && (!g.first_edit_at || r.first_edit_at < g.first_edit_at)) { g.first_edit_at = r.first_edit_at; g.first_edit_by = r.first_edit_by; }
    // A unit edited more than once has last_edit_at strictly after its own
    // first_edit_at (per-VIN, same-submit edits share now()) → subsequent edits exist.
    if (r.first_edit_at && r.last_edit_at && new Date(r.last_edit_at) > new Date(r.first_edit_at)) g._hasSubsequent = true;
    for (const f of FLAG_KEYS) g._flags[f] = g._flags[f] && !!r[f]; // group badge = all units true
    const sz = r.size || '—';
    let s = g._sizes.get(sz);
    if (!s) {
      s = { size: sz, vins: [], qty: 0, cost: null, global_indicator: null, gi_basis: null, price: null, listed_price: null, note: null, _drift: false, _costs: new Set(), _globals: new Set(), _prices: new Set(),
        _flags: { added_to_intel_inv: true, synced_alias: true, synced_stockx: true, synced_shopify: true } };
      g._sizes.set(sz, s);
    }
    s.vins.push(r.vin); s.qty += 1;
    s._costs.add(r.cost == null ? '' : String(r.cost));
    s._globals.add(r.global_indicator == null ? '' : String(r.global_indicator));
    s._prices.add(r.price == null ? '' : String(r.price));
    if (s.cost == null && r.cost != null) s.cost = r.cost;
    if (s.global_indicator == null && r.global_indicator != null) s.global_indicator = r.global_indicator;
    if (s.gi_basis == null && r.gi_basis != null) s.gi_basis = r.gi_basis; // basis follows the GI
    if (s.price == null && r.price != null) s.price = r.price;
    if (!(s.note || '') && (r.ph_note || '')) s.note = r.ph_note; // per-size note (first non-empty)
    if (s.listed_price == null && r.listed_price != null) s.listed_price = r.listed_price; // price it was listed at
    // Price drift: a unit that's on II whose current Final price no longer matches the
    // price it was listed at (a GI "Refresh prices" moved it) → ⚠ "Price changed".
    if (r.added_to_intel_inv && r.price != null && r.listed_price != null
        && Math.abs(Number(r.price) - Number(r.listed_price)) >= 0.005) { s._drift = true; g._drift = true; }
    for (const f of FLAG_KEYS) s._flags[f] = s._flags[f] && !!r[f]; // per-size flag = all units of that size true
  }
  return [...map.values()].map((g) => ({
    ...g, ...g._flags, priceChanged: g._drift,
    sizes: [...g._sizes.values()]
      .sort((a, b) => (sizeNum(a.size) - sizeNum(b.size)) || String(a.size).localeCompare(b.size))
      .map((s) => ({
        size: s.size, vins: s.vins, qty: s.qty,
        cost: s.cost, costMixed: s._costs.size > 1,
        global_indicator: s.global_indicator, globalMixed: s._globals.size > 1, gi_basis: s.gi_basis,
        price: s.price, priceMixed: s._prices.size > 1,
        listed_price: s.listed_price, priceChanged: s._drift,
        note: s.note,
        ...s._flags,
      })),
  }));
}

// PH pages are URL-routed under /ph/* (their own namespace, separate from the
// warehouse/admin ROUTES) so a refresh restores the page and Back/Forward work.
export const PH_PATHS = { receiving: '/ph/new-inventory', rescale: '/ph/rescale', nobox: '/ph/nobox', request: '/ph/request', photos: '/ph/edited-photos', inquiry: '/ph/price-inquiry' };
export const phPathForPage = (page) => (page && PH_PATHS[page]) || '/';
export const phPageForPath = (p) => {
  const path = String(p || '/').replace(/\/+$/, '') || '/';
  return Object.keys(PH_PATHS).find((k) => PH_PATHS[k] === path) || null;
};

// PH edit-lock (B2) timings — heartbeat keeps a lock alive (silent), TTL frees a
// crashed/closed editor server-side, idle auto-releases a forgotten-open edit.
export const HEARTBEAT_MS = 10_000;       // keep MY lock alive (well under the 30s server TTL)
export const PRESENCE_POLL_MS = 2_000;    // how fast OTHERS see a lock appear/clear — kept snappy
export const IDLE_RELEASE_MS = 60 * 60 * 1000; // 1 hour — PH needs time to process the upload
export const LIST_POLL_MS = 15_000;       // quietly re-fetch the list (new shoes / others' saved edits)
