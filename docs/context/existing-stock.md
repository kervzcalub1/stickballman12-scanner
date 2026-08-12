# Existing Stock (old stock counted in)

Stock that predates this system: already sitting on the shelves, and **already
listed to II and the stores** long before the app existed. Counted in so the
warehouse can locate / label / sell-and-ship it like anything else — but it is
**invisible to the PH team**, who have nothing to do with it. Tagged
`batches.kind='existing'`; same `items`/`batches` model as everything else (a split
table would mean re-implementing shelve/locate/labels/no-box/sold-shipped). See also
`in-store.md`, `locations.md`, `statuses.md`, `data-model.md`.

> The **Box Labels** tool (`no-box.md`) is the other producer of `kind='existing'`
> units — one at a time, sending `noShelf: true` with no `locationCode`, for a pair
> being re-boxed in hand. It's the only caller allowed to skip the shelf; the
> shelf-by-shelf count below still requires one.

## The surface
**Count Existing Stock** (`/existing-stock`, `src/screens/ExistingStock.jsx`) —
Home → its own *Existing Stock* section. **admin + warehouse only** (`ph_team`
short-circuits to `PHTeamApp` and never reaches this router).

Deliberately **not** the receiving wizard: these pairs have no shipment, supplier,
tracking or cost to capture, and there can be thousands of them. It's a continuous
loop, closer to Shelve/Put-away than to intake:

1. **Scan the shelf** you're standing at (`isLocationCode` → `api.locationLookup`,
   or the `ShelfPicker`). It stays pinned across pairs.
2. **Scan each box UPC** (or type a SKU) → `searchUpc`/`searchSku` fills
   name/image/sizes. Same SKU + same size **bumps the qty** instead of stacking
   rows. A code the catalogue can't size lands with an empty size and is flagged —
   **Save is blocked until every row has one**.
3. **Save shelf** → commit, then **Next shelf**.

Switching shelves with un-saved rows is refused (save or clear first), so a count
can't silently land on the wrong shelf.

## Commit (`POST /api/batches/commit { kind:'existing', locationCode, … }`)
- The shelf is resolved **before `createBatch`** — a bad/inactive shelf 404/409s with
  nothing written, rather than leaving a committed batch of unshelved pairs behind.
- After `insertItems` + `insertIntakeEvents`, the same request calls
  **`shelveItems`** — the normal put-away path — so `status='in_stock'`,
  `location_id`, `location_code` and the `shelved` event all match a hand put-away.
  **No `needs_shelf` round-trip:** the pairs are already physically on the shelf.
- **No-box pairs are refused by `shelveItems`** (a boxless shoe isn't sellable) and
  stay `no_box` → the warehouse **No-Box queue**. The count is returned as
  `shelved.noBoxBlocked` so the screen can say so.
- **GI enrichment is skipped** (`PH_EXCLUDED_KINDS`) — a PH concern, and these are
  already priced on the stores.
- `insertIntakeEvents` writes a distinct **`counted`** event ("Counted into existing
  stock"), not `received` — nothing was ever delivered.
- It also sets `added_to_intel_inv / synced_alias / synced_stockx / synced_shopify
  = true`. That's the truth, and it doubles as a **backstop**: even if a PH query
  ever missed the exclusion, these read as fully synced and can't inflate a badge.
- Response carries `shelved: { updated, noBoxBlocked, location }`. The pairs have **no
  VIN stickers yet**, so the screen goes straight to the **`LabelSheet`** print dialog
  — the one part of this that can't fix itself later. The "counted in" summary is held
  back until that dialog closes, so two modals never stack.

## PH exclusion (the hard invariant)
`api/_lib/db.js` exports **`PH_EXCLUDED_KINDS = ['instore','existing']`** — one list,
because the exclusion must hold at *every* PH read/write path. Guarding only the
obvious one is how in-store leaked onto the PH Rescale grid before (`in-store.md`).

Used as `(b.kind IS NULL OR b.kind <> ALL(${PH_EXCLUDED_KINDS}))`. **The `IS NULL`
half is required** — these are `LEFT JOIN`s and `NULL <> ALL(...)` is `NULL`, which
would silently drop every batchless row.

| Path | What it would leak |
|---|---|
| `phListItems` (receiving/admin **and** rescale branches) | the pairs on PH New Inventory / the admin Report |
| `pendingCounts` | inflated `not_ii/alias/stockx/shopify` badges |
| `phUpdateGroup` | a PH write landing on old stock (row is skipped) |
| `getItemsForGiRefresh` | "Refresh prices" re-pricing it |
| `recomputeUnlistedPrices` | a margin change re-pricing it |
| `rescaleItem` / `POST /api/items/rescale` | **409** — rescale sets `restock_pending`, which surfaces on PH's Rescale grid |

⚠️ **`pendingCounts` keeps `is_instore` separate from `ph_managed`.** The In-Store
Listing badge means *specifically* in-store; keying it on "everything PH ignores"
would pour every counted old pair into Brent's In-Store Listing worklist.

Re-shelving existing stock is **"Move to shelf"** (a transfer), which stays allowed —
only *Rescale* is refused.

## De-listing
**None.** When an existing pair sells, marking it sold/shipped here is inventory
truth only; its store listings are managed wherever they are today. There is
deliberately no worklist (unlike In-Store Listing).

## Where it's flagged in the UI
`IntakeChip` (`components/common.jsx`) is the one place the chip is defined — it
renders for `existing` and `instore` only, and **nothing for ordinary received /
rescaled stock**. No chip = normal stock: tagging the 95% case would be noise on
every row. `mixed` renders "Part existing" for a grouped row where only some units
are that kind.

- **Inventory** — the chip replaces the PH sync badges (they'd always read the same
  for this stock) via `intakeChip()`; filterable via **Intake → Existing stock**;
  item detail reads "Intake: Existing stock (origin)".
- **Locate Shoe** (`locations.md`) — this is the one that matters operationally:
  someone pulling a pair needs to know it's pre-system stock **before** they pull it.
  Flagged in three places: the **SKU group header** (groups collapse when there are
  several hits, so a chip only on the rows would be invisible exactly when scanning
  the list), each **unit row**, and the **shelf contents** view.
  ⚠️ In the unit row the chip is **stacked under the VIN, not inline** — inline it
  ellipsed the VIN to zero width at 390px, and losing the number you actually scan
  is worse than losing the chip. An e2e assertion pins the VIN's rendered width.
  `listItemsAtLocation` had to gain `b.kind` (+ a `LEFT JOIN batches`) for the shelf
  view; the tile drill-down is the only path through it.

`queryItems` / `api/items/query` / `api/batches/list` accept `kind='existing'`.

## Columns
No new columns. `batches.kind='existing'`, `batches.origin` = the shelf it was
counted from. The `batches_kind_check` CHECK allows
`('receiving','rescale','instore','existing')`.

## ⚠️ Deploy
The CHECK change means **`db:setup` must run on prod BEFORE this code deploys**, or
every count throws a CHECK violation (`deploy.md`).

## Tests
`e2e/existing-stock.spec.js` — renders/gates the shelf step, commit lands
shelved + already-synced, a bad shelf leaves no orphan batch, the SKU never appears
on PH New Inventory, and a rescale rescan 409s. A second describe puts the **same
SKU on one shelf in both kinds** so the Locate views have to actually tell them
apart (header + unit row + shelf contents), and asserts the VIN stays legible.
