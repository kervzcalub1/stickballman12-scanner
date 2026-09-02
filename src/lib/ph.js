// PH grid domain logic: SKU+status grouping (flat + per-size), pricing,
// frozen-column geometry, /ph/* routing, and edit-lock timings.
import { sizeNum } from './codes.js';
import { getMarkupMult } from './config.js';
import { estDate } from './format.js';

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
// New Inventory carries one more action ("Send for rescale"), and at 104px its label
// broke across two lines inside the button. The wider column is asked for by the page
// that needs it rather than given to all of them — every pixel here is painted over
// the scrolling row beneath.
const PH_ACTION_WIDE = 124;
export const rightStyle = (which, wide = false) => {
  if (which === 'addedby') return {};
  const w = wide ? PH_ACTION_WIDE : PH_ACTION_W;
  return { position: 'sticky', right: 0, minWidth: w, width: w };
};

export const PH_FLAGS = [
  ['added_to_intel_inv', 'Intelligent Inv.'], ['synced_alias', 'Alias'],
  ['synced_stockx', 'StockX'], ['synced_shopify', 'Shopify'],
];
export const FLAG_KEYS = ['added_to_intel_inv', 'synced_alias', 'synced_stockx', 'synced_shopify'];

// A pair that has been SOLD (or shipped — sold's only onward transition) is out of
// PH's hands: it left the building, so there is nothing left to list and an edit
// would only rewrite the record of a pair that's gone. **Sold is as good as done** —
// such a unit reads as `done` below, which drops it out of the Pending / In-Progress
// worklist tabs, and the grid offers no Edit / GOAT-only on it. The server enforces
// the same rule (phUpdateGroup + setItemsGoatOnly in api/_lib/db.js), so a stale tab
// can't write to one either. The pricing paths already agreed: getItemsForGiRefresh
// and recomputeUnlistedPrices have always skipped these two statuses.
export const PH_CLOSED_STATUSES = ['sold', 'shipped'];
export const isPhClosed = (r) => !!r && PH_CLOSED_STATUSES.includes(r.status);

// Display mirror of the server's PRICE_HIERARCHY (api/_lib/pricing.js) — keep the
// keys and order in step with it. A size takes the first level Alias has a real
// price for, and `items.gi_basis` records which one, so the grid can say what
// priced it. Rank 1 (the consigned Global Indicator) is the normal case and shows
// no chip; everything below it does. `tone` splits the near fallbacks (still a
// live ask) from the far ones (a past sale or a bid, so worth a second look).
export const PRICE_BASES = {
  consigned:           { rank: 1, label: 'Global Indicator - Consigned', short: null,       tone: null },
  with_you:            { rank: 2, label: 'Global Indicator - With You',  short: 'WY',       tone: 'near' },
  lowest_consigned:    { rank: 3, label: 'Lowest - Consigned',           short: 'LOW',      tone: 'near' },
  lowest_with_you:     { rank: 4, label: 'Lowest - With You',            short: 'LOW·WY',   tone: 'near' },
  last_sold_consigned: { rank: 5, label: 'Last Sold - Consigned',        short: 'LAST',     tone: 'far' },
  last_sold_with_you:  { rank: 6, label: 'Last Sold - With You',         short: 'LAST·WY',  tone: 'far' },
  highest_consigned:   { rank: 7, label: 'Highest - Consigned',          short: 'HIGH',     tone: 'far' },
  highest_with_you:    { rank: 8, label: 'Highest - With You',           short: 'HIGH·WY',  tone: 'far' },
};
// What the chip beside a price should say, or null when nothing should render
// (rank 1, or a hand-typed price with no basis at all).
export function priceBasisChip(basis) {
  const b = PRICE_BASES[basis];
  if (!b || !b.short) return null;
  return { short: b.short, tone: b.tone, title: `Priced off ${b.label} — #${b.rank} in the pricing hierarchy` };
}

// Final price auto-derives from the resolved indicator: entered amount × markup
// (the configurable price margin, default +20%; see src/lib/config.js), rounded
// to the nearest whole dollar. The SAME markup applies at every level of the
// hierarchy. Empty/non-numeric indicator clears it.
export function calcFinalPrice(globalIndicator) {
  if (globalIndicator === '' || globalIndicator == null) return '';
  const n = Number(globalIndicator);
  if (!Number.isFinite(n)) return '';
  return String(Math.round(n * getMarkupMult()));
}

// A group's sync badges roll up as all-units-true, which on its own can't tell
// "nothing listed" from "most of it listed" — and those look identical on a SKU
// that was received in two waves (sizes 7-9 listed, then 10-12 scanned in an hour
// later). So every rollup also carries how MANY units have each flag; the badge
// renders the fraction. Zeroed counters, one per flag.
const zeroCounts = () => ({ added_to_intel_inv: 0, synced_alias: 0, synced_stockx: 0, synced_shopify: 0 });

// Merge into ONE row per SKU + status (regardless of size), because the PH team
// encodes a SKU to Intelligent Inventory once for all its sizes. The row lists
// each size with its quantity; Price + II/AL/SX/SH + Note are set once for the
// whole SKU and applied to every member VIN. A sync flag reads "Yes" only when
// ALL units have it (so a partially-synced SKU shows as not-done), with
// `flagCounts` carrying the partial truth alongside it.
export function groupPhRows(list) {
  const map = new Map();
  for (const r of list) {
    const key = `${r.sku || ''}|#|${r.status || ''}`;
    let g = map.get(key);
    if (!g) {
      g = {
        ...r, key, vins: [], qty: 0, _mixedBy: false, _sizeMap: {}, _prices: new Set(), _globals: new Set(), _costs: new Set(),
        _flags: { added_to_intel_inv: true, synced_alias: true, synced_stockx: true, synced_shopify: true },
        _counts: zeroCounts(),
        // Counted, not inherited from the first row the way `...r` leaves it: a group
        // keys on sku|status, so one pre-sell batch's unreleased pairs can share a group
        // with ordinary stock of the same SKU — the chip would then depend on row order.
        _presell: 0,
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
    for (const f of FLAG_KEYS) { g._flags[f] = g._flags[f] && !!r[f]; if (r[f]) g._counts[f] += 1; }
    if (r.pre_sell) g._presell += 1;
    if (r.created_by !== g.created_by) g._mixedBy = true;
    if (r.created_at < g.created_at) g.created_at = r.created_at; // earliest scan
    if (r.last_edit_at && (!g.last_edit_at || r.last_edit_at > g.last_edit_at)) {
      g.last_edit_at = r.last_edit_at; g.last_edit_by = r.last_edit_by;
    }
  }
  return [...map.values()].map((g) => ({
    ...g,
    ...g._flags, // representative flags = all-units-true
    flagCounts: g._counts, // …with how many of the g.qty units each flag actually covers
    // Same all-units-true rule as the flags, plus a partial state — "some of these are
    // spoken for" is a different and more dangerous fact than "all of them are".
    pre_sell: g._presell > 0 && g._presell === g.qty,
    preSellMixed: g._presell > 0 && g._presell < g.qty,
    preSellCount: g._presell,
    priceMixed: g._prices.size > 1,
    globalMixed: g._globals.size > 1,
    costMixed: g._costs.size > 1,
    sizes: Object.entries(g._sizeMap).sort((a, b) => (sizeNum(a[0]) - sizeNum(b[0])) || String(a[0]).localeCompare(b[0])).map(([size, qty]) => ({ size, qty })),
  }));
}

// Listing state of a SINGLE unit — the same three keys as PH_LISTING_STATUSES,
// judged per pair instead of per group. `goat_only` is a per-unit column, so the
// applicable flags are read off the row (a GOAT-only pair needs Alias alone).
// This is what splits a SKU into separate rows, so it has to be per unit.
export function unitListingStatus(r) {
  if (isPhClosed(r)) return 'done'; // sold/shipped — gone, so nothing is pending on it
  const req = requiredFlags(r);
  if (req.every((f) => r[f])) return 'done';
  return req.some((f) => r[f]) ? 'in_progress' : 'pending';
}

// Like groupPhRows, but keeps a per-SIZE breakdown inside each group (the PH grid's
// expandable detail) — and groups on SKU + item status + **the exact store-flag
// signature**, so a row only ever holds pairs that are at the same point in the
// listing process. `lockTagFor(vin)` is optional: it returns a stable tag for a unit
// currently held by an edit lock (see rule 3 below), and nothing when it isn't.
// Cost / global indicator / final price are tracked PER SIZE (each can differ).
// `sizes[]` carries each size's vins, qty and its own cost/global_indicator/price
// (+ *Mixed flags when units within a size differ).
export function groupPhSized(list, isLocked) {
  const map = new Map();
  // Rule 3 needs to know, BEFORE grouping, which natural keys are being edited —
  // see the note at the key below for why the lock can't just go into the key.
  const naturalKey = (r) => {
    const lstate = unitListingStatus(r);
    const sig = FLAG_KEYS.map((f) => (r[f] ? '1' : '0')).join('') + (r.goat_only ? 'G' : '-');
    return `${r.sku || ''}|#|${r.status || ''}|#|${sig}|#|${lstate === 'pending' ? '' : estDate(r.created_at)}`;
  };
  const lockedKeys = new Set();
  if (isLocked) for (const r of list) if (isLocked(r.vin)) lockedKeys.add(naturalKey(r));
  for (const r of list) {
    // What shares a row, in three rules:
    //
    // 1. The store-flag signature always splits — II, AL, SX, SH, plus goat_only
    //    (which decides whether SX/SH are required at all, so the same four ticks
    //    mean "done" for one pair and "half done" for another). The moment ONE tick
    //    lands on a pair it leaves the row it was sharing, same day or not: list
    //    size 7 out of Monday's 7/8/9 and it splits off, 8 and 9 stay put.
    //    Six pairs listed Monday + one scanned Tuesday used to collapse into a
    //    single row whose all-units-AND badges then spoke for all seven — the SKU
    //    read as unlisted and PH had no way to see which pairs were live.
    //
    // 2. The scan day splits too, but ONLY once a pair has been touched. Untouched
    //    pairs of a SKU merge across days on purpose: PH needs one row saying how
    //    many of this SKU are waiting, not the same SKU pending twice. A pair that's
    //    been listed keys on the day it was SCANNED (never the day it was listed),
    //    so when 8 and 9 are listed on Tuesday they rejoin size 7 in the Monday
    //    batch they arrived with — and a later delivery still can't fold into an
    //    older row, because it carries its own scan day.
    const lstate = unitListingStatus(r);
    const day = estDate(r.created_at);
    const base = naturalKey(r);
    // 3. A row BEING EDITED stops accepting new pairs. A second shipment of the same
    //    SKU minutes after the first folded into the row PH was working on (rule 2 —
    //    both untouched), and the group action they clicked next applied to pairs they
    //    never saw arrive.
    //
    //    The LATE ARRIVAL moves, never the locked row — the edited row must keep the
    //    exact key it had when Edit was clicked. `editing`, `drafts` and `expanded` in
    //    PHTeam.jsx are all keyed on g.key, and claiming the lock is itself what makes
    //    a row locked: putting the lock in every member's key re-keyed the row the
    //    instant editing began, so `editing.has(g.key)` went false and the per-size
    //    editor vanished as it opened. (Caught by the PH grid e2e suite.)
    const key = (isLocked && !isLocked(r.vin) && lockedKeys.has(base)) ? `${base}|#|new` : base;
    let g = map.get(key);
    if (!g) {
      g = {
        key, sku: r.sku, name: r.name, status: r.status, gender: r.gender, listingState: lstate, day,
        closed: isPhClosed(r), // sold/shipped: row is read-only (status is in the key, so this holds for every unit)
        _days: new Set(), // a merged pending row can span scan days — the grid says so
        photo_count: r.photo_count || 0, // per-SKU listing-photo count (all rows share it)
        photo_url: r.photo_url || null,  // preferred (side) listing photo for the thumbnail
        created_at: r.created_at, created_by: r.created_by, _mixedBy: false,
        vins: [], qty: 0,
        first_edit_at: null, first_edit_by: null, _hasSubsequent: false, _drift: false,
        last_edit_at: r.last_edit_at, last_edit_by: r.last_edit_by,
        goat_only: true, // "GOAT only" (Alias+II only) — all-units rollup, set just below
        _flags: { added_to_intel_inv: true, synced_alias: true, synced_stockx: true, synced_shopify: true },
        _counts: zeroCounts(),
        _sizes: new Map(),
      };
      map.set(key, g);
    }
    g.vins.push(r.vin); g.qty += 1;
    g._days.add(day);
    if (r.created_by !== g.created_by) g._mixedBy = true;
    if (r.created_at < g.created_at) g.created_at = r.created_at;
    if (r.last_edit_at && (!g.last_edit_at || r.last_edit_at > g.last_edit_at)) { g.last_edit_at = r.last_edit_at; g.last_edit_by = r.last_edit_by; }
    // First editor = earliest first_edit_at across the group ("Added by").
    if (r.first_edit_at && (!g.first_edit_at || r.first_edit_at < g.first_edit_at)) { g.first_edit_at = r.first_edit_at; g.first_edit_by = r.first_edit_by; }
    // A unit edited more than once has last_edit_at strictly after its own
    // first_edit_at (per-VIN, same-submit edits share now()) → subsequent edits exist.
    if (r.first_edit_at && r.last_edit_at && new Date(r.last_edit_at) > new Date(r.first_edit_at)) g._hasSubsequent = true;
    // Group badge = all units true; the count beside it = how many of them actually are.
    for (const f of FLAG_KEYS) { g._flags[f] = g._flags[f] && !!r[f]; if (r[f]) g._counts[f] += 1; }
    g.goat_only = g.goat_only && !!r.goat_only; // GOAT-only only if every unit is
    const sz = r.size || '—';
    let s = g._sizes.get(sz);
    if (!s) {
      s = { size: sz, vins: [], qty: 0, cost: null, global_indicator: null, gi_basis: null, price: null, listed_price: null, note: null, _drift: false, _costs: new Set(), _globals: new Set(), _prices: new Set(),
        _flags: { added_to_intel_inv: true, synced_alias: true, synced_stockx: true, synced_shopify: true }, _counts: zeroCounts() };
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
    // Per-size flag = all units of that size true (two pairs of a US 9, one listed
    // and one not, reads "No" — `flagCounts` is what says 1 of 2 rather than 0).
    for (const f of FLAG_KEYS) { s._flags[f] = s._flags[f] && !!r[f]; if (r[f]) s._counts[f] += 1; }
  }
  const out = [...map.values()].map((g) => ({
    ...g, ...g._flags, flagCounts: g._counts, priceChanged: g._drift,
    days: [...g._days].sort(), // ≥2 only on a merged pending row; drives the Date cell
    sizes: [...g._sizes.values()]
      .sort((a, b) => (sizeNum(a.size) - sizeNum(b.size)) || String(a.size).localeCompare(b.size))
      .map((s) => ({
        size: s.size, vins: s.vins, qty: s.qty,
        cost: s.cost, costMixed: s._costs.size > 1,
        global_indicator: s.global_indicator, globalMixed: s._globals.size > 1, gi_basis: s.gi_basis,
        price: s.price, priceMixed: s._prices.size > 1,
        listed_price: s.listed_price, priceChanged: s._drift,
        note: s.note,
        ...s._flags, flagCounts: s._counts,
      })),
  }));
  // A SKU can now be on the board twice for two different reasons, and only one of
  // them needs explaining. Rows at DIFFERENT listing states get a chip, because
  // nothing else on the row says why its twin exists. Rows split only by scan day
  // get none — the Date column is the first thing on the row and already says it,
  // so a chip there would just repeat itself.
  const states = new Map();
  const skuKey = (g) => `${g.sku || ''}|#|${g.status || ''}`;
  for (const g of out) {
    const k = skuKey(g);
    if (!states.has(k)) states.set(k, new Set());
    states.get(k).add(g.listingState);
  }
  for (const g of out) g.splitSku = (states.get(skuKey(g))?.size || 0) > 1;
  return out;
}

// Derived listing status of a PH group, from the store-sync flags (II/AL/SX/SH):
//  · 'done'        — every store synced across all units (group rollup all true)
//  · 'pending'     — nothing synced anywhere yet
//  · 'in_progress' — some but not all stores synced (incl. a size partly done)
// A SOLD or shipped pair short-circuits to 'done' whatever its flags say (see
// PH_CLOSED_STATUSES) — it can't be listed any more, so it isn't outstanding work.
// Used by the New Inventory status filter. Keys/labels in PH_LISTING_STATUSES.
export const PH_LISTING_STATUSES = [
  { key: 'pending', label: 'Pending' },
  { key: 'in_progress', label: 'In-Progress' },
  { key: 'done', label: 'Done' },
];
// The New Inventory tabs. Rescale is a FOURTH BUCKET, not a fourth listing status —
// a row under audit is still pending or part-listed, and `phListingStatus` stays
// three-valued so the ✓ Listed / ◐ Part-listed / • Not listed split chip keeps telling
// the truth inside the tab. `phTabOf` is what the filter keys on.
export const PH_TABS = [
  ...PH_LISTING_STATUSES,
  { key: 'rescale', label: '⟳ Rescale' },
];

// Is this row in the Rescale bucket, and which request put it there?
//
// `byVin` maps VIN -> an open/audited request. The rule is deliberately ALL-OR-NOTHING:
// a row moves only when EVERY pair on it is linked to the same request.
//   · A partly-linked row would otherwise drag pairs nobody asked about out of Pending.
//   · The alternative — splitting the row by linked-vs-not — would add a fourth
//     dimension to a group key that already carries three split rules plus the
//     edit-lock freeze, which is the most intricate logic in the app.
// A row raised straight off the grid is all-linked by construction. It can become
// partial later (rule 2 merges a new delivery of the same SKU into a pending row); when
// that happens the row stays where it is and keeps the chip, which is honest — it now
// holds pairs the warehouse isn't counting.
export function rescaleRequestFor(g, byVin) {
  const vins = (g && g.vins) || [];
  if (!byVin || !vins.length) return null;
  const first = byVin[vins[0]];
  if (!first) return null;
  return vins.every((v) => byVin[v] && byVin[v].id === first.id) ? first : null;
}

// Which TAB a row files under.
//
// ONLY AN AUDITED REQUEST MOVES A ROW. An open one — nobody has counted the shelf yet —
// leaves the row exactly where it was, with its chip. That is the difference between a
// tab that holds work and a tab that holds stock nobody is looking at: the grid defaults
// to Pending, so if an un-audited request pulled rows out, a request the warehouse never
// got to would park those pairs somewhere no one had selected, indefinitely. Nothing can
// be done about an open request from this screen anyway — the whole point of the tab is
// the count, and until there is one there is nothing to show.
//
// Once it IS audited the row moves, because now the work is specific to that count:
// what to list is the warehouse's numbers, not ours.
export function phTabOf(g, byVin) {
  const r = rescaleRequestFor(g, byVin);
  return r && r.status === 'audited' ? 'rescale' : phListingStatus(g);
}
// The store flags that actually apply to a group. "GOAT only" shoes list to
// Alias(GOAT) alone — II/StockX/Shopify are N/A, so they don't
// count toward completion or the badges.
// "GOAT only" = **Alias only**. Not II, not StockX, not Shopify — the pair is
// listed to Alias (GOAT) and nowhere else, so Alias's tick alone completes it.
// (Until 2026-08-19 this also required Intelligent Inventory, which left every
// finished GOAT-only row sitting in In-Progress waiting for a tick PH never makes.)
export const GOAT_FLAG_KEYS = ['synced_alias'];
export const requiredFlags = (g) => (g && g.goat_only ? GOAT_FLAG_KEYS : FLAG_KEYS);

// Free-text search for the PH grid — the same keyword rule the Inventory page uses
// server-side (`searchTokens` in api/_lib/db.js): split on whitespace and require
// EVERY token to match somewhere, so "kobe air force" finds a name whose words
// aren't adjacent, word order doesn't matter, and each extra word narrows rather
// than kills the result.
//
// This twin runs in the BROWSER, over the rows already loaded for the date range.
// The grid IS a date window by definition — `phListItems(from,to,kind)`, the
// row-split rules and the listing-status tabs all key off it — so widening the
// period stays the date control's job, not the search box's. Filtering client-side
// also means typing can't refetch, and a refetch can't yank a row out from under an
// open edit lock.
export const phSearchTokens = (q) => String(q || '').trim().toLowerCase().split(/\s+/).filter(Boolean);

// Name / SKU / VIN — the three things PH actually has in hand when they go looking
// (the shoe in front of them, the code on the box, the sticker on the pair).
export function phRowMatches(g, tokens) {
  if (!tokens.length) return true;
  const hay = [g.name, g.sku, ...(g.vins || [])].filter(Boolean).join(' ').toLowerCase();
  return tokens.every((t) => hay.includes(t));
}
export function phListingStatus(g) {
  // Sold/shipped first: a gone pair is done whatever its flags say, and both group
  // shapes key on item status, so a row is never half sold.
  if (isPhClosed(g)) return 'done';
  // groupPhSized rows are homogeneous by construction (listing state is part of the
  // group key), so the row already knows — and the filter tabs then line up 1:1 with
  // what's on screen. The derivation below still serves the merged groupPhRows shape.
  if (g && g.listingState) return g.listingState;
  const req = requiredFlags(g);
  if (req.every((f) => g[f])) return 'done';
  // "Some" has to look at the unit counts too: a size holding two pairs with only
  // one of them listed rolls up false at BOTH levels, so flags alone read pending.
  const c = g.flagCounts || null;
  const anyOn = req.some((f) => g[f] || (c && c[f] > 0)) || (g.sizes || []).some((s) => req.some((f) => s[f]));
  return anyOn ? 'in_progress' : 'pending';
}

// PH pages are URL-routed under /ph/* (their own namespace, separate from the
// warehouse/admin ROUTES) so a refresh restores the page and Back/Forward work.
export const PH_PATHS = { receiving: '/ph/new-inventory', rescale: '/ph/rescale', nobox: '/ph/nobox', costs: '/ph/costs', request: '/ph/request', imagefinder: '/ph/image-finder', inquiry: '/ph/price-inquiry', payout: '/ph/payout', po: '/ph/purchase-orders', postatus: '/ph/po-status', reconcile: '/ph/reconciliation', sop: '/ph/sop', deleted: '/ph/deleted', inventory: '/ph/inventory', batches: '/ph/batches' };
export const phPathForPage = (page) => (page && PH_PATHS[page]) || '/';
export const phPageForPath = (p) => {
  const path = String(p || '/').replace(/\/+$/, '') || '/';
  // The former "Edited Photos" page was merged into "Find Image Listings" (image-finder).
  if (path === '/ph/edited-photos') return 'imagefinder';
  return Object.keys(PH_PATHS).find((k) => PH_PATHS[k] === path) || null;
};

// PH edit-lock (B2) timings — heartbeat keeps a lock alive (silent), TTL frees a
// crashed/closed editor server-side, idle auto-releases a forgotten-open edit.
export const HEARTBEAT_MS = 10_000;       // keep MY lock alive (well under the 30s server TTL)
export const PRESENCE_POLL_MS = 2_000;    // how fast OTHERS see a lock appear/clear — kept snappy
export const IDLE_RELEASE_MS = 60 * 60 * 1000; // 1 hour — PH needs time to process the upload
export const LIST_POLL_MS = 15_000;       // quietly re-fetch the list (new shoes / others' saved edits)
