# Pre-sell (sold before it landed)

Some shipments are already spoken for before they arrive. Those pairs must **not**
be listed to II or the stores — offering them would sell a pair that belongs to
somebody else's order. But not every unit on such a shipment is covered: the
overage is ordinary stock and does need pricing and listing.

So a pre-sell shipment is received exactly like any other, then held out of the PH
listing worklist until **the warehouse** says, size by size, how many are actually
sold. What is left over is released — and lands on the existing **Rescale Stock**
worklist, which already means "priced and pushed to the stores".

**Who does what.** The warehouse owns the whole pre-sell page: they hold the
shipment, so they are the ones who know which pairs an order covers. PH's job
starts *after* release — the freed pairs appear on Rescale Stock and PH lists them
to II and the platforms. PH has no Pre-sell page and cannot mark a pair sold.

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

## The chip (`src/components/PreSellChip.jsx`)

One component, four states, shown anywhere a batch, box or unit is on screen —
because the flag changes what may be done with the stock, and someone standing over
a shelf has no other way to tell. **Only the unusual state is chipped**; chipping
every ordinary shipment teaches people to stop reading chips.

| State | Reads | Keyed on |
|---|---|---|
| held | **Pre-sell** | `items.pre_sell` |
| part held | **N pre-sell** | some units of a group held |
| spoken for | **Pre-sold** | `status = 'pre_sold'` |
| released | **Was pre-sell** | `batches.pre_sell` with no unit still held |

**Why the fourth exists.** `items.pre_sell` is the unit's *current* state and release
clears it, so a freed pair is indistinguishable from ordinary restock the moment it
lands on Rescale Stock — and "why does half this shipment never appear?" becomes
unanswerable. `batches.pre_sell` is what the shipment **was** and never changes, so
it is carried as **`from_pre_sell`** on `queryItems` and both branches of
`phListItems`, and grouped as `wasPreSell` / `wasPreSellCount` in `src/lib/ph.js`.

Where the live chip **replaces** the sync badges (a held pair has no sync state worth
showing), the released chip sits **beside** them and is styled quiet, not amber: the
pair is ordinary stock again and its badges mean something. On the PH grid it only
ever appears on released pairs — a held one is invisible to every PH surface by
design, so there is no row to chip.

⚠️ These queries are JS template literals. **No backticks in their SQL comments** —
one closes the string and the whole module fails to parse.

## The Pre-sell page (`/presell`, `src/screens/PreSell.jsx`)

Warehouse (admin auto-allowed), in the warehouse app — a card in **Receiving
Shipment Orders**, plus a Needs-attention tile keyed on `presell_pending`. Rows are
grouped shipment → shoe → size
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

**Rescale Stock, and only Rescale Stock.** Releasing clears `pre_sell`, which is
what used to let those units back onto **New Inventory** as well — they were
received days ago, so they sit inside its date window, and the moment the warehouse
released a shipment its remainder appeared on *both* PH tabs. `phListItems`'
receiving branch therefore carries `AND (${kind} IS NULL OR NOT i.restock_pending)`:
a unit on the rescale worklist is rescale work. Two lists claiming the same pair is
how it gets listed twice — or left, because each side assumed the other had it. The
admin **Report** (`kind IS NULL`) still sees the released pairs, the same carve-out
no-box has; the ones still spoken for stay hidden there too, because pre-sell hides
a pair from every PH surface until it is released. Pinned by `e2e/presell.spec.js`.

`restock_pending` is the PH **Rescale Stock** worklist (`docs/context/rescale.md`)
— the existing home for "stock that needs pricing and pushing to the stores".
Nothing new was invented for "subject for upload"; that worklist already is it.

**Units already `pre_sold` are left alone** — they keep `pre_sell = true` and stay
on the Pre-sell page. This is why `phListItems` tests the *item* flag: releasing
frees part of a batch while the rest stays held.

## Endpoints

| Route | Who | Does |
|---|---|---|
| `GET /api/presell/list` | warehouse (admin auto) | `listPreSellGroups` |
| `POST /api/presell/mark-sold` | warehouse (admin auto) | count path or VIN path |
| `POST /api/presell/release` | warehouse (admin auto) | `releasePreSell` |

All three use `requireRole`, which auto-allows admin. **PH gets 403 on all three** —
guarded by `e2e/presell.spec.js`, because "PH can still see the rows" and "PH can
declare a pair sold" are different failures and only the second one matters.

## Where you can see the flag

A shipment-wide state that only appeared on its own page would be invisible to
anyone actually handling the stock, so `PreSellChip` (`src/components/PreSellChip.jsx`)
is rendered in four places:

| Where | What it reads | Query that carries it |
|---|---|---|
| Batches list rows (Open, Recent, Search) | `b.pre_sell` | `listBatches`, `searchBatches`, `listOpenBatches` |
| Batch detail header | `b.pre_sell` | `getBatchWithBoxes` (`b.*`) |
| **Each box card** inside a batch | `b.pre_sell` | same — a box is what somebody has open in front of them, and the header is scrolled away by then |
| Receiving → Recent | `b.pre_sell` | `listBatches` |
| Inventory rows | `g.pre_sell` / `g.preSellMixed` | `queryItems` (`i.pre_sell`) |

Only the unusual state gets a chip — unlike `PoKindChip`, where every order is
either shoes or boxes so a missing chip would be ambiguous. Here nearly every
shipment is ordinary, and chipping all of them is noise.

**Inventory needs a rollup, not the raw column.** `groupPhRows` builds a group with
`{...r}` from the *first* row and keys on `sku|status`, so one pre-sell batch's
unreleased pairs can share a group with ordinary stock of the same SKU — the chip
would then depend on row order. It is counted instead: `pre_sell` is all-units-true,
`preSellMixed`/`preSellCount` carry the partial case, and the chip has a dashed
"N pre-sell" variant. In Inventory the chip *replaces* `SyncBadges` (a pre-sell pair
is deliberately listed nowhere, so four greyed badges say nothing), the same call
`IntakeChip` makes for in-store and existing stock.

## Tests

`e2e/presell.spec.js` — 7 tests: the flag lands on every unit; **the multi-box path
inherits it** (that path reads `pre_sell` off the batch row, not its own request
body, so the single-shot test does not cover it); **PH is refused** on mark-sold and
release; a pre-sell batch stays off PH New Inventory and out of its badges; the count
path and the scan path both reach `pre_sold`; lowering a count hands units back;
release moves only the remainder onto Rescale Stock.

## Gotchas

- `useEffect(load, [])` where `load` returns a promise crashes the page with
  `TypeError: destroy is not a function` — React reads an effect's return value as
  its cleanup. Wrap it: `useEffect(() => { load(); }, [])`.
- Adding a new PH-facing query means adding `NOT pre_sell` to it, exactly as it
  means adding the `PH_EXCLUDED_KINDS` check (`docs/context/ph-excluded-kinds` /
  `in-store.md`).
- A new `NavIcon` name that isn't in `PATHS` **silently falls back to the magnifier** —
  `presell` has its own bookmark glyph in `src/components/NavIcons.jsx`.
- The chip borrowed `.no-track-check`'s look at first, which is the class
  `e2e/receiving-no-tracking.spec.js` selects the no-tracking checkbox by; two
  elements then matched and the spec failed in strict mode. Share styling by adding
  to a CSS selector list, never by reusing a class e2e keys on.
- Needs `db:setup` (`batches.pre_sell`, `items.pre_sell`, the partial index).
