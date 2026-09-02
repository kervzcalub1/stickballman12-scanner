# Empty shoe boxes — the warehouse side

**Status: PLAN. Nothing here is built.** The PH + supplier half shipped
2026-09-02 (`docs/context/purchase-orders.md` → "Two kinds of order"); this is the
path from a delivered carton of empty boxes to a box on a shoe's foot, written so it
can be built in one pass without re-deriving the decisions.

---

## 1. What the warehouse inherits

The half that is live already:

- `purchase_orders.order_kind` = `'shoes' | 'boxes'`. PH sets it on the New Batch form
  and can change it on an existing order ("Edit details") until the order is
  reconciled/closed.
- A boxes manifest line is `po_lines(sku, name, size, dimensions, qty_expected,
  unit_cost, tip)`. **Both size and dimensions are required.** A real empty shoe box is
  size-specific — its label carries the SKU, the size and the UPC — so the carton is the
  extra fact a box has, not a replacement for its size. `dimensions` is the canonical
  `L x W x H unit` (`13 x 9 x 5 in`), normalised server-side by `normalizeDimensions`.
- Dedupe is on `(po_box_id, sku, size, dimensions)`. The shoe-side indexes gained a
  `WHERE dimensions IS NULL` predicate so the two kinds stop overlapping — every row that
  existed before is in that half, so nothing already enforced changed.
- The `PoKindChip` (`Shoes` / `Empty boxes`) already renders on **Receiving's PO picker
  and its "Receiving against …" banner**, and on **Reconciliation's list and order page**.
  The warehouse can already tell the two apart; it just can't do anything different yet.
- `po/manifest-import` is refused on a boxes order (it parses shoe sizes).
- Reconciliation shows a **banner saying the comparison can't work yet**, so nobody
  settles a false shortage with a supplier in the meantime. Removing that banner is the
  last step of Phase W2 below.

**The one honest gap today:** there is no way to receive a carton of empty boxes into
stock. `getPoReconciliation` matches on `(shoe, numeric size)` and a box line now carries
a real size, so **the match itself already works** — there is simply never anything on the
received side to match against, and a boxes PO reads short by its whole contents. That is
what Phase W1 fixes; W2 is then a refinement, not a rescue.

---

## 2. Decide this first: is an empty box a stock row?

Everything below forks on one question, and it should be answered before any code.

### Option A — an empty box is an `items` row (RECOMMENDED)

A new `batches.kind = 'boxes'`, one `items` row per physical carton, using the `size`
column it already has, plus a new `items.dimensions` for the carton.

- **Why it's right:** you asked for "the same character as the shoe being inbounded
  (history, etc.)". Item history, `item_events`, shelf locations, the Costs page, the
  batch page, Inventory search, labels — all of it hangs off `items` and all of it works
  unchanged. There are already **two** precedents for a kind that is real stock the PH
  team never sees (`instore`, `existing`), so this is a road the codebase has driven
  twice, not a new one.
- **What it costs:** a VIN per carton, and every "is this sellable / listable / countable"
  path has to learn about the new kind (§7). Receiving 200 boxes means 200 rows — which is
  exactly what receiving 200 pairs already means, so the intake UI has to be
  quantity-first (§4) rather than pair-at-a-time.
- **It also means reconciliation needs almost nothing** (§5): the box rows carry a `size`,
  which is what the existing matcher already groups on.

### Option B — an empty box is a quantity ledger

A `box_stock(sku, size, dimensions, qty_on_hand, location_id)` table, incremented on
receipt and decremented when a box is used.

- **Why you might:** boxes are fungible supply. Nobody ever asks "which one of these
  identical 13x9x5 Panda boxes is this". No VINs, no per-unit rows, no PH exclusion work.
- **Why not:** it's a second, parallel stock model. History, locations, costs, search and
  labels would all need their own version, and the two models would drift. It also can't
  answer "what did THIS box cost", which is a question you already ask about shoes.

**Recommendation: Option A**, and everything below assumes it. If you'd rather have B, the
phases still hold — only §3's schema and §7's checklist change.

---

## 3. Schema (one migration, additive)

All in `scripts/db-setup.mjs`, all `IF NOT EXISTS` — and **run `db:setup` on every env
before deploying the code that reads them** (the #1 trap in `CLAUDE.md`).

```sql
-- A box shipment is its own kind of batch, like in-store and existing stock.
ALTER TABLE batches DROP CONSTRAINT IF EXISTS batches_kind_check;
ALTER TABLE batches ADD CONSTRAINT batches_kind_check
  CHECK (kind IN ('receiving','rescale','instore','existing','boxes'));

-- How big the carton is. `items.size` already holds the shoe size the box was made for,
-- which is what reconciliation groups on — this is the extra fact. Same column name and
-- same canonical format as po_lines.dimensions, so the two compare as one string shape.
ALTER TABLE items ADD COLUMN IF NOT EXISTS dimensions TEXT;
CREATE INDEX IF NOT EXISTS items_dimensions_idx ON items (sku, size, dimensions)
  WHERE dimensions IS NOT NULL;

-- Which shoe a box was eventually put on (Phase W4). NULL = still on the shelf.
ALTER TABLE items ADD COLUMN IF NOT EXISTS used_on_item_id BIGINT REFERENCES items(id);
ALTER TABLE items ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ;
```

Add `'boxes'` to `PH_EXCLUDED_KINDS` in the **same** commit as the migration — see §7.

No new status keys. A box uses the ones that already exist: `needs_shelf` on receipt,
`in_stock` once shelved, and a new **`used`** tag via `normalizeStatus` when it goes onto
a shoe (`api/_lib/statuses.js` already allows custom tags, so this needs no enum change —
but it DOES need adding to `TERMINAL_STATUSES` so a used box can't be re-shelved).

---

## 4. Phase W1 — receive a boxes PO

The wizard is `src/screens/Receiving.jsx`; the commit is `api/batches/commit.js`.

**Step 1 (pick the PO)** already shows the kind chip. When the picked PO is a boxes
order, the wizard commits `kind: 'boxes'` and switches Step 2 to the box intake form.

**Step 2 is quantity-first, not scan-per-unit.** This is the one place the box flow must
NOT copy the shoe flow: nobody scans 200 identical cartons. The screen is the PO's own
manifest as a **checklist**, one row per `(sku, size, dimensions)`:

```
Dunk Low Panda   DD1391-100   9    13 x 9 x 5 in    declared 6   counted [ 6 ]  ✓
Dunk Low Panda   DD1391-100   12   14 x 9 x 5 in    declared 4   counted [ 4 ]  ✓
AJ1 Shadow 2.0   CT8527-016   10   14 x 9.5 x 5 in  declared 4   counted [ 3 ]  short 1
```

- The counted field defaults **blank, not to the declared number** — a prefilled count is
  a count nobody took, and the whole point of receiving is to disagree with the manifest
  when it's wrong.
- "Everything as declared" fills the column in one tap for the common clean shipment.
- A carton that isn't on the manifest at all is added as a row (SKU + size + dimensions +
  count), and reads as an overage — same as an unexpected pair does today.
- Committing writes N `items` rows per row (`sku`, `name`, **`size`**, `dimensions`,
  `cost` from the line's `unit_cost`, `batch_id`, `box_id` for the carton it came out of),
  mints VINs the way receiving already does, and sets `needs_shelf`. Writing `size` is the
  load-bearing part: it is what makes §5 almost free.

**Reuse, don't fork:** the multi-box/tracking half of Step 1, `batches.po_id` linking,
`po/link-batch`, and the received-box evidence trail all work unchanged — they key on
boxes and batches, not on what's inside them.

---

## 5. Phase W2 — reconciliation (mostly already true)

`getPoReconciliation` buckets both sides on `(canonical sku, numeric size)`. **A box line
carries a real size and W1's `items` rows will too, so this already matches** — grouping,
`autoReconcileIfClean`, the resolution checklist, per-box diffs and the received-count
manifest all work with no change. Requiring the size (rather than keying boxes on
dimensions alone) is what bought that.

The one refinement worth adding, and only once you have seen it happen: the same SKU+size
arriving in **two different cartons** currently folds into one bucket. Add `dimensions` to
the key on a boxes order — `${canon(rcCodes(x.sku))}|${rcSizeNum(x.size)}|${x.dimensions}`
— and because the string is canonical on both sides (both minted by
`normalizeDimensions`), there is no notation-matching to write. Do this *after* W1 is real,
so you can tell whether it's a problem you actually have.

**Last step of this phase: delete the warning banner** in `src/screens/Reconciliation.jsx`
(search for `order_kind`) — it exists only to stop a false shortage being settled while
intake is missing, and leaving it up afterwards would be its own lie.

---

## 6. Phase W3 — where the boxes live

Boxes go on shelves like everything else, so `docs/context/locations.md` applies
unchanged: shelve by scanning the VIN, `location_id`/`location_code` on the item,
"In Stock · A2-04".

The one thing worth adding is **finding a box by what it fits**, which is the question a
person actually has, and they ask it by SIZE: *"I need a box for a 10.5 Panda."* That's
one new filter on Inventory — SKU and/or size in, "6 on shelf A2-04, 13 x 9 x 5 in" out.
Build it as a filter on the Inventory search that already exists rather than a new page.
Dimensions are what you show in the answer, not usually what you search by.

**Do not** print VIN labels for every carton by default. A box's label is the shoe's box
label (the Box Labels tool, `/box-labels`, already prints those); a VIN sticker on a
carton that is about to have a shoe put in it is a sticker somebody has to peel off.
Shelve by the shelf, count by the SKU+dimensions.

---

## 7. Phase W4 — using a box (this is the actual payoff)

The whole reason these are bought: a pair in the **No Box queue** (`no_box` status,
`docs/context/no-box.md`) or one whose box arrived crushed needs a box, and now there is
one on a shelf.

Extend the existing "📦 Box found → With Box" action rather than building a new flow.
Today it flips `with_box=true` + `needs_shelf` and says nothing about where the box came
from. It gains an optional second half: **"…from stock"** → pick/scan the box item →

1. the shoe's `with_box` / status change happens exactly as it does now, and
2. the box item is stamped `used_on_item_id` = the shoe, `used_at` = now, status `used`,

so both rows carry the link, and "what happened to the 40 boxes we bought" has an answer
that isn't a guess. The **Box Labels tool already prints the replacement label** for that
pair — this closes the loop it was built for.

Reporting worth having once the link exists, and not before: boxes on hand by
SKU + dimensions, boxes consumed per month, and the cost of box replacement per pair
(`items.cost` on the box row, against the shoe it went onto).

---

## 8. Guardrails — the ones that WILL bite

1. **`PH_EXCLUDED_KINDS` must gain `'boxes'`, and that is never enough on its own.**
   `CLAUDE.md` and `docs/context/ph-excluded-batch-kinds.md` list every path that has to
   be guarded — `phListItems` (both branches), `pendingCounts`, `rescaleItem`,
   `phUpdateGroup`, `getItemsForGiRefresh`, `recomputeUnlistedPrices` — and, the part
   that has bitten twice, **anything keyed on the INVERSE of the flag**. Empty boxes must
   never appear in the PH grid, in a pending count, in a price refresh, or in a rescale
   worklist.
2. **A box is never listed and never sold.** No `added_to_intel_inv`, no Alias/StockX/
   Shopify sync, not in Mark Sold/Mark Shipped scans. The sync flags are set by PH, so
   guard #1 mostly covers it — but check the bulk status scanner explicitly.
3. **A box is not in "Needs shelf" alongside shoes** unless you want the warehouse's
   headline count to jump by 200 overnight. Either exclude `kind='boxes'` from the home
   card's count or split it into its own card. Decide before the first receive, not after.
4. **`used` must be terminal.** Without it, a box that went onto a shoe can be re-shelved
   and used again — a phantom box, the same class of bug as the anti-double-sell guard
   (`TERMINAL_STATUSES`).
5. **Shopify's feed must not see boxes** (`docs/context/shopify.md`) — they have no SKU
   on any channel and would read as unmatched inventory.
6. **Everything is EST.** Nothing here is new, but the intake date on a box batch is the
   same trap as every other date in this app.

---

## 9. What to test

Extend `e2e/po-empty-boxes.spec.js` (it already covers the PH/supplier half) plus a new
`e2e/boxes-receiving.spec.js`:

- Receiving a boxes PO writes `kind='boxes'` items carrying **both** `size` and
  `dimensions`.
- A clean boxes shipment reconciles to **no difference** — the single most important
  assertion in the file.
- A short shipment reads short by exactly the missing cartons, and an unexpected carton
  reads as an overage.
- Two sizes of the same SKU stay two lines end to end — declared, received and
  reconciled — rather than folding into one.
- **A boxes batch is invisible to PH**: `phListItems`, the pending counts, and the PH grid
  return nothing for it. Assert on the counts, not just the list.
- A `used` box can't be moved back into an active status.
- A shoes PO still receives and reconciles exactly as before (the regression that matters).

---

## 10. What NOT to build

- **No pricing, no listing, no GI lookup for boxes.** They are supply, not stock to sell.
- **No separate "box receiving" screen.** It's Step 2 of the wizard the warehouse already
  knows, behind the kind the order already declares.
- **No per-carton VIN labels by default** (§6).
- **No back-fill of past box purchases.** Whatever was bought before this existed was
  bought outside the system; inventing rows for it invents a count nobody took.

---

## 11. Suggested order of work

| # | Phase | Ships what | Depends on |
|---|---|---|---|
| 1 | §3 schema + §8.1 PH exclusion | nothing user-visible, but nothing else is safe without it | — |
| 2 | W1 receive (§4) | the boxes physically land in the system | 1 |
| 3 | W2 reconciliation (§5) + drop the banner | the supplier can be settled with honestly | 2 |
| 4 | W3 find-a-box filter (§6) | the warehouse can actually locate one | 2 |
| 5 | W4 use-a-box (§7) | the loop closes; the reporting becomes possible | 2, 4 |

Phases 1–3 are the minimum that makes an empty-box order a real order end to end.
4 and 5 are what make it worth having.
