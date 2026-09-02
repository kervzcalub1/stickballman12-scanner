# Pre-sell (sold before it landed)

Some shipments are already spoken for before they arrive. Those pairs must **not**
be listed to II or the stores — offering them would sell a pair that belongs to
somebody else's order. But not every unit on such a shipment is covered: the
overage is ordinary stock and does need pricing and listing.

So a pre-sell shipment is received exactly like any other, then held out of the PH
listing worklist until PH says, size by size, how many are actually sold. What is
left over is released — and lands on the existing **Rescale Stock** worklist,
which already means "priced and pushed to the stores".

## The flag

- **`batches.pre_sell`** and **`items.pre_sell`** (both `BOOLEAN NOT NULL DEFAULT
  false`), plus `items_pre_sell_idx ON items (batch_id, sku, size) WHERE pre_sell`.
- The batch flag records what the shipment *was*; the item flag is what every query
  reads. They are set together at commit — `insertItems` copies the batch's value
  onto each unit — because a unit's pre-sell state has to be able to end
  independently of its batch's (see **Release**, which clears only the item flag).
- Set at intake. Nothing else in Receiving changes: same scan, same review, same
  boxes. It is a checkbox next to the tracking field
  (`.presell-field` in `src/screens/Receiving.jsx`), carried on the commit body as
  `batch.preSell` through `createBatch` / `createOpenBatch` / `box-commit`.

## What the flag holds back

`pre_sell` is a **second, parallel exclusion to `PH_EXCLUDED_KINDS`** — same idea,
different axis (a *kind* of batch vs. a state a unit can leave). It is guarded at
the same places, and for the same reason: guarding the New Inventory query alone is
never enough.

| Where | Guard |
|---|---|
| `phListItems` (both branches) | `AND NOT i.pre_sell` |
| PH pending-count badges | `ph_managed` = kind-check **AND** `NOT it.pre_sell` |
| `recomputeUnlistedPrices` | `AND NOT items.pre_sell` |
| `getItemsForGiRefresh` | `AND NOT i.pre_sell` |

A pre-sell unit is therefore invisible to PH's New Inventory, contributes to no
listing badge, and is never priced by a GI refresh — while staying perfectly
ordinary everywhere else (Inventory, shelving, labels, locations, costs, the PO).

The pending-counts query also returns **`presell_pending`** — pre-sell units not yet
`sold`/`shipped` — which badges the PH home card.

## The Pre-sell page (`/ph/presell`, `src/screens/PreSell.jsx`)

PH-team + superadmin. Rows are grouped shipment → shoe → size
(`listPreSellGroups`), each showing **arrived / sold / remains**.

Two ways to say a pair is spoken for, both ending in status **`pre_sold`**:

1. **Type the count** per size → `POST /api/presell/mark-sold`
   `{batchId, sku, size, qty}` → `setPreSellSold`. The units are interchangeable
   (same shoe, same size, not yet shelved), so it takes the **oldest ids first**
   for determinism rather than making anyone choose a VIN. **Lowering the number
   hands units back** (→ `needs_shelf`) — a pre-sale that falls through is normal.
2. **Scan a 1ID / VIN** → same endpoint with `{vin}` → `markPreSoldByVin`. Names the
   pair instead of letting the system pick. Rejects a VIN that isn't on a pre-sell
   shipment, or is already `pre_sold`/`sold`/`shipped`, each with its own message.

**`pre_sold`, not `sold`.** The pair is still on our floor and hasn't shipped;
`sold` is terminal and cascades. It reaches `sold`/`shipped` through the normal
scan-out when it actually leaves. Claiming it early would strand the unit if the
order collapsed.

## Release → listing

**Send the N remaining for rescale** → `POST /api/presell/release` →
`releasePreSell` sets `pre_sell = false, restock_pending = true` on every unit of
that batch that is **not** `pre_sold`/`sold`/`shipped`/`missing`/`issue`, and logs a
`rescaled` event.

`restock_pending` is the PH **Rescale Stock** worklist (`docs/context/rescale.md`)
— the existing home for "stock that needs pricing and pushing to the stores".
Nothing new was invented for "subject for upload"; that worklist already is it.

**Units already `pre_sold` are left alone** — they keep `pre_sell = true` and stay
on the Pre-sell page. This is why `phListItems` tests the *item* flag: releasing
frees part of a batch while the rest stays held.

## Endpoints

| Route | Who | Does |
|---|---|---|
| `GET /api/presell/list` | ph_team + **warehouse** (admin auto) | `listPreSellGroups` |
| `POST /api/presell/mark-sold` | ph_team (admin auto) | count path or VIN path |
| `POST /api/presell/release` | ph_team (admin auto) | `releasePreSell` |

All three use `requireRole`, which auto-allows admin — unlike the rescale-request
cancel/edit, which needed an explicit `ph_team || superadmin` check because
withdrawing a request is the requesting team's own call. Nothing here is
withdrawal-shaped, so the ordinary guard is right.

**The warehouse can read the list but not act on it.** They hold the boxes and get
asked "is this one spoken for?", but which pairs an order covers is PH's to say.

## Tests

`e2e/presell.spec.js` — a pre-sell batch stays off PH New Inventory; the badge
counts it; the count path and the scan path both reach `pre_sold`; lowering a count
hands units back; release moves only the remainder onto Rescale Stock.

## Gotchas

- `useEffect(load, [])` where `load` returns a promise crashes the page with
  `TypeError: destroy is not a function` — React reads an effect's return value as
  its cleanup. Wrap it: `useEffect(() => { load(); }, [])`.
- Adding a new PH-facing query means adding `NOT pre_sell` to it, exactly as it
  means adding the `PH_EXCLUDED_KINDS` check (`docs/context/ph-excluded-kinds` /
  `in-store.md`).
- Needs `db:setup` (`batches.pre_sell`, `items.pre_sell`, the partial index).
