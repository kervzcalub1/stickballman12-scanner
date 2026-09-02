# Empty shoe boxes

Not every pair arrives with a box worth selling. Some come crushed; some come with none
at all. So we buy **empty shoe boxes** from the same suppliers, on the same paperwork as
the shoes — ordered, manifested, tracked, received, shelved, and finally put onto a pair.

Two halves, both live:
- **PH + supplier** (2026-09-02, PR #167) — raising the order and declaring what's in it.
  The manifest side is documented in `purchase-orders.md` → *"Two kinds of order"*.
- **Warehouse** (2026-09-03) — this file: receiving, reconciling, finding and spending.

## The one rule everything follows from

A box is identified by **SKU + SIZE + DIMENSIONS**, and all three are required. A real
empty shoe box is size-specific — its label prints the SKU, the size and the UPC — so a
size 9 Panda box and a size 10 Panda box are two different things to order, count and pay
for, even where the carton measures the same. The dimensions are the **extra** fact a box
carries, not a replacement for its size.

That decision is why the warehouse half was small: `getPoReconciliation` already groups
both sides on `(sku, numeric size)`, so **reconciliation needed no special case at all**.

## Data model

| | Where | What |
|---|---|---|
| The order is for boxes | `purchase_orders.order_kind = 'boxes'` | Set by PH; editable until the order is settled |
| What was declared | `po_lines.size` + `po_lines.dimensions` | Both required; canonical `L x W x H unit` |
| The shipment | `batches.kind = 'boxes'` | **Derived from the PO server-side**, never from the client |
| A physical carton | one `items` row, real VIN | `items.size` = the shoe size, `items.dimensions` = the carton |
| A spent carton | `items.status = 'used'` + `used_on_item_id` + `used_at` | Terminal (`TERMINAL_STATUSES`) |

An empty box is a **real `items` row**, not a quantity ledger — which is what makes item
history, shelf locations, Inventory search, batch pages and the PO evidence trail all work
on them for free. What it is *not* is stock to sell.

## `kind='boxes'` in the two shared lists

- **`PH_EXCLUDED_KINDS`** (`api/_lib/db.js`) gained `'boxes'`. The PH team must never see
  an empty box — no grid row, no price, no store sync. Adding a kind to that list is
  never enough on its own; see `ph-excluded-batch-kinds.md` for every path it has to hold at.
- **`COST_EXCLUDED_KINDS`** (new) keeps boxes off the **Costs** page. A box's cost is
  settled with the supplier on the purchase order, not chased pair-by-pair on a PH
  worklist. `pendingCounts.costable` and `listItemsMissingCost` read the same list, because
  a badge that counts rows its page won't show is a badge nobody trusts.
- **`SHIPMENT_KINDS`** (new, `['receiving','boxes']`) is the opposite kind of list: the
  multi-box endpoints (`add-box`, `sync-boxes`, `renumber-box`, `set-status`, `box-commit`)
  were each keyed on `'receiving'` alone and refused a boxes batch with **"Batch not
  found"**. A boxes shipment is a shipment in every mechanical sense — courier label,
  supplier, tracking, boxes committed one at a time — so it uses all of it unchanged.

## Receiving (`Receiving.jsx`, `api/batches/*`)

The same wizard, entered the same way: Step 1 picks the PO, and the `PoKindChip` says
which kind it is. Nothing is a separate screen.

- **The batch kind is decided from the ORDER**, in `create-open.js` and `commit.js`, never
  from what the client sent. A boxes shipment landing as `'receiving'` would put empty
  cartons in front of the PH team as sellable stock, which is the one thing this kind
  exists to prevent.
- **Step 2 is the manifest as a counting checklist** — which is what PO receiving already
  was. Each row is a size *and* its carton (`ManifestChecklist`, `boxesOrder`), because
  the same shoe in two cartons is two things to count.
- **"Everything arrived as declared"** fills the counted column in one tap. It appears
  only while *nothing* has been counted yet: the column still starts blank — a prefilled
  count is a count nobody took — but a clean carton of two hundred boxes shouldn't be
  ticked two hundred times.
- **No VIN stickers are printed** for boxes. A box's label is the shoe box label the Box
  Labels tool prints when the carton finally goes on a pair; a second barcode on a carton
  somebody is about to fill is a sticker they have to peel off again.

## Reconciliation

Unchanged code. Expected (`po_lines` on shipped labels) and received (`items` under the
linked batch) both group on `(canonical sku, numeric size)`, and a box line carries a real
size — so a clean boxes shipment reconciles to **no difference** and a short one reads
short by exactly the missing cartons.

The one refinement not built: the same SKU+size arriving in **two different cartons**
folds into one bucket. Adding `dimensions` to the key is a one-line change and needs no
notation-matching (both sides are minted by `normalizeDimensions`) — deliberately deferred
until it's a problem somebody actually has.

## Counting them without distorting the warehouse's chores

`pendingCounts` splits three ways rather than folding boxes into the shoe numbers — one
carton of replacement boxes is a couple of hundred rows, and it would have tripled the
warehouse's headline backlog overnight with work that isn't the same work:

- `needs_shelf` — **shoes** waiting on a shelf (excludes boxes)
- `boxes_needs_shelf` — empty boxes still to put away
- `boxes_on_hand` — empty boxes shelved and available
- `no_box` also excludes boxes: a box can never itself be "bought without a box"

## Finding one, and spending it

**`/box-stock` (Empty Box Stock)** answers the question as it's actually asked — *"is
there a box for a size 10.5 Panda?"* — grouped shoe → size → carton, with where they're
sitting. Read-only by design.

**Spending a box happens in the No Box queue**, next to the pair that needs it, because
that is the only screen that knows it fits. "Use a box from stock" lists boxes matching
that pair's SKU + size; picking one runs `POST /api/items/use-box`:

- the pair becomes `needs_shelf` + `with_box` — the same end state "Box found" already gave —
- the box becomes `used`, terminal, with `used_on_item_id`/`used_at` set and its shelf cleared,
- **both rows get a history event**, so "what happened to the 40 boxes we bought" has an
  answer that isn't a guess.

All of it in **one transaction**: a pair marked boxed with the carton still on the shelf is
worse than neither. `used` is terminal for the same reason `sold` is — otherwise one
physical carton could be handed to two different shoes.

## What deliberately does NOT exist

- **No pricing, listing or GI lookup** for boxes. They're supply, not stock to sell.
- **No `po/manifest-import` on a boxes order** — it parses a sheet of shoe sizes.
- **No per-carton VIN labels** (above).
- **No back-fill** of boxes bought before this existed: inventing rows invents a count
  nobody took.
- **No consumption reporting yet** (boxes used per month, box cost per pair). The link
  now exists to build it from; the report doesn't.

Tests: `e2e/boxes-warehouse.spec.js` (7) and `e2e/po-empty-boxes.spec.js` (12).
Handout: `SOP-EMPTY-BOXES.pdf` (repo root, uncommitted).
