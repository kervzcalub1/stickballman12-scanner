# In-Store Mode — Implementation Plan

> Source: voice note (2026-06-23). Admin buys shoes at retail stores all day,
> walking pairs out to the car across 50–200 trips, and wants to **scan each
> pair as it's bought** to build a running log — instead of dumping everything
> in the car and rescaling the whole pile at the warehouse at end of day.

## Constraints (REVISED 2026-07-03 — supersedes the original voice note)
1. **Admin + warehouse.** Usable by `admin` and `warehouse` (not `ph_team`).
2. **PH team is OUT.** In-store buys must **never** enter the PH Team's world —
   not New Inventory, not the admin PH Report, not the II/Alias/StockX/Shopify
   cascade, and they must not inflate the PH store-sync badges. They are listed
   to **Alias by hand** by admin/warehouse (tracked via `items.instore_listed_at`).
   > Original note said "PH still lists to II" — the user reversed this: in-store
   > pairs are entered into Alias manually, skipping Intelligent Inventory.
3. **All other functions apply.** In-store pairs still shelve (needs_shelf),
   locate, print labels, resolve No-Box, and go sold/shipped like any stock.
   They are the same `items`/`batches` rows tagged `kind='instore'` — no separate
   table (a split would force re-implementing every one of those features).

## Status — Step 1 SHIPPED & verified (2026-07-03)
Schema (`kind='instore'` + `instore_listed_at/_by`), server (`commit`/`createBatch`
accept instore; excluded from `phListItems` and the PH badge counts; GI enrichment
skipped), and client (In-Store Home card + `/instore` route + `Receiving` `isInstore`
mode; in-store chip + intake filter in Inventory) are done. Verified end-to-end via
HTTP: an in-store commit lands in Inventory (chip, `kind=instore`), is absent from
PH New Inventory + admin Report, counts for `needs_shelf`, and doesn't touch the PH
sync badges. **Step 2 (still TODO):** the admin/warehouse **In-Store Listing** page
(worklist toggling `instore_listed_at`) + running day-session persistence.

## Core design decision — reuse Receiving, add `kind='instore'`
In-store buying is a receiving flow **without a shipment** — exactly the shape
rescale already has (`mode='rescale'` reuses the `Receiving` component and drops
buyer/supplier/tracking). We do the same:

- New batch **`kind='instore'`**, committed through the existing
  `/api/batches/commit` → `createBatch` → `reserveVins` → `insertItems` →
  `insertIntakeEvents` pipeline. One VIN per pair, same `item_events` audit trail
  ("Scanned by … → Received into inventory").
- Items land at status `needs_shelf` (boxed) / `no_box` (unboxed) — identical to
  normal receiving, so the rest of the app (Inventory, No Box, labels, sold/
  shipped) works with zero changes.
- Optional **`origin`** = store name/location (column already exists), so a
  day's buys are attributable to a store.

This is the smallest change that fits the existing architecture and satisfies
constraint #2 for free (see below).

### Why this satisfies "PH still lists to II"
`phListItems(kind='receiving')` — the PH **New Inventory** page — selects
`b.kind = 'receiving' OR b.kind IS NULL` and excludes `no_box`. We extend that
one predicate to include `'instore'`. In-store buys then appear in PH New
Inventory automatically; PH edits the row, toggles **II**, and the existing
cascade syncs AL/SX/SH. No new listing UI, no auto-sync.

## ⚠️ Schema migration (the #1 trap — do this first)
`scripts/db-setup.mjs:104-105` pins the kind constraint:

```js
await sql(`ALTER TABLE batches DROP CONSTRAINT IF EXISTS batches_kind_check`);
await sql(`ALTER TABLE batches ADD CONSTRAINT batches_kind_check CHECK (kind IN ('receiving','rescale'))`);
```

Change the whitelist to include `'instore'`:

```js
await sql(`ALTER TABLE batches ADD CONSTRAINT batches_kind_check CHECK (kind IN ('receiving','rescale','instore'))`);
```

Then **run `npm run db:setup` on every environment** (local + Railway) before
deploying code that writes `kind='instore'`, or commits will throw a CHECK
violation. No new columns needed — `kind` and `origin` already exist.

## File-by-file changes

### Server
- **`scripts/db-setup.mjs`** — add `'instore'` to `batches_kind_check` (above).
- **`api/batches/commit.js`**
  - Accept the new kind:
    `const kind = body.kind === 'rescale' ? 'rescale' : body.kind === 'instore' ? 'instore' : 'receiving';`
  - **Admin gate:** `requireRole(req,res,['warehouse'])` auto-allows admin but
    also allows warehouse. Add, right after the auth line:
    `if (kind === 'instore' && user.role !== 'admin') return send(res, 403, { ok:false, error:'In-store buying is admin-only.' });`
  - Treat `instore` like `rescale` for the header: drop buyer/supplier/tracking,
    keep `origin` (store name). Adjust the `kind === 'rescale'` ternaries in `bh`
    to `kind !== 'receiving'` where shipment fields are nulled, and allow
    `origin` for both non-receiving kinds.
  - Issues: in-store has no shipment → `issues = []` (same as rescale).
- **`api/_lib/db.js`**
  - `createBatch` (line ~214): the kind is hard-narrowed to
    `h.kind === 'rescale' ? 'rescale' : 'receiving'`. Replace with a whitelist:
    `['receiving','rescale','instore'].includes(h.kind) ? h.kind : 'receiving'`.
  - `insertIntakeEvents`: `intakeType` stays `'received'` for instore (only
    rescale uses `'rescaled'` + `restock_pending`). No change needed beyond
    confirming instore falls into the `received` branch — it does.
  - `phListItems` (receiving branch, line ~384): change
    `b.kind = 'receiving' OR b.kind IS NULL`
    → `b.kind IN ('receiving','instore') OR b.kind IS NULL`. **This is the
    change that surfaces in-store buys to PH for II listing.**
- **`api/vins/reserve.js`** — no change (admin auto-allowed by the warehouse
  gate; in-store admin reserves VINs the same way).
- `pendingCounts` / badges — no change; they count by status/flags regardless of
  kind, so needs_shelf / not-II badges already include in-store units.

### Client (`src/App.jsx` + `src/api.js`)
- **`ROUTES`** (line 79) — add `'instore'`.
- **App routing** (near line 154) — add
  `if (view === 'instore') return <Receiving mode="instore" user={user} navBack={navBack} onOpenItem={openItem} onHome={() => go('home')} onSignOut={signOut} />;`
- **Admin-only route guard** — non-admin hitting `/instore` should fall back
  home. Either filter the route or guard in App: if `view==='instore' &&
  user.role!=='admin'` → render Home. (PH never reaches this — `ph_team` short-
  circuits to `PHTeamApp` at line 147.)
- **`HOME_SECTIONS`** — add an admin-only card. The section filter currently
  only honors section-level `adminOnly`; add per-card support:
  - In the Home render (line ~339), also filter cards:
    `section.cards.filter((c) => !c.adminOnly || isAdmin)`.
  - Add to the "Intake" section (Home is now grouped by lifecycle: Intake →
    Put-away → Rescale → Sell & Ship → Browse & Reports → Administration):
    `{ key: 'instore', adminOnly: true, icon: '🛍️', title: 'In-Store Buying', sub: 'Scan pairs as you buy them at the store' }`.
- **`Receiving` component** — add an `isInstore = mode === 'instore'` flag
  alongside `isRescale`:
  - Title → "In-Store Buying"; commit payload `kind:'instore'`.
  - **Skip Step 1** (shipment details) — go straight to scanning. Replace the
    supplier/tracking/buyer fields with a single optional **Store / location**
    field that maps to `header.origin`. `dateReceived` defaults to today.
  - Keep Step 2 (scan modal, HID-gun autofocus, UPC/SKU detect, qty-by-size,
    With Box checkbox, VIN reservation) **unchanged** — this is the core scan
    loop and already mobile-friendly.
  - Step 3 (Issues) is shipment-only → hide for instore (as it effectively is
    for rescale).
- **`src/api.js`** — `batchCommit` already forwards the whole payload incl.
  `kind`; no change. (Optionally add a thin `inStoreCommit` alias for clarity.)

### Docs
- New `docs/context/in-store.md` (intake variant; link from CLAUDE.md context
  map). Update `docs/context/receiving.md` ("reused for rescale **and instore**
  via `mode`") and `docs/context/ph-report.md` (New Inventory now includes
  in-store buys).

## UX notes for the scan screen (MVP)
- One-screen, one-handed: big **Scan** button → camera or HID gun; each accepted
  scan adds a pair and flashes "✓ <name>" (the existing `setFlash` + haptics).
- Running cart of today's buys with running count + total cost.
- **Commit cadence:** MVP commits the cart on demand ("Save trip"), so he can
  save after a carload and keep going; each save = one `instore` batch for the
  day/store. Reuses the existing commit + unsaved-changes guard.

## Phasing
- **Phase 1 (MVP, this plan):** admin-only In-Store screen → `kind='instore'`
  batches → appears in Inventory + PH New Inventory (II → cascade). ~½ day.
- **Phase 2 (later, from the note):** offline scan queue (parking-lot signal),
  a single persistent "day session" he appends to all day with one EOD commit,
  and store/location reporting. Larger — needs client-side queue + sync.

## Verification
- `npm run db:setup` (local) → confirm constraint allows `instore`.
- Commit an in-store batch as **admin** → item appears in Inventory and in **PH
  New Inventory**; PH toggles **II** → AL/SX/SH cascade fires.
- Confirm **warehouse** and **ph_team** cannot see the card or POST
  `kind:'instore'` (403).
- `npm run build` clean; hard-refresh after rebuild.

## Open questions
1. **Commit cadence** — per-trip saves (MVP) vs. one running day-session
   (Phase 2)? The note leans toward a day-long running log.
2. **Store/location** — capture `origin` per batch, or per pair?
3. Should in-store buys be visually flagged in Inventory/Report (an "in-store"
   chip via `b.kind`), or blend in with received stock?
