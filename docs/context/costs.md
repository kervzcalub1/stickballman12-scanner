# Costs — filling in what a pair cost

Page: `ItemCosts` (`src/screens/ItemCosts.jsx`), routes `/costs` (admin/warehouse) and
`/ph/costs` (PH). Endpoints `api/items/costs.js` (list/search) + `api/items/set-cost.js`
(save). Grouping helpers in `src/lib/costs.js`. **No schema change** — `items.cost`
already existed.

## Why it exists
`items.cost` is written **once, at intake** (`insertItems` ← `intake.js`: the item's own
cost, else the batch `default_cost`). Suppliers routinely leave cost off a PO manifest,
so pairs land with nothing on file — and until this page there was **no UPDATE of
`items.cost` anywhere in the codebase**, so a blank stayed blank forever.

## The two lists (tabs) + search
- **No cost on file** — `cost IS NULL`. The backlog you clear. Drives the home
  card badge (`missing_cost`) and the Needs-attention strip.
- **$0 — check these** — `cost = 0`. A **review** list, kept deliberately OUT of the
  backlog and its badge: a $0 is a *claim already on file*, not a known gap, so folding
  it in would assert something we don't know. See the blank-vs-zero trap below.
- **Search** (`?q=`) — every unit of the SKU behind a VIN / UPC / SKU, costed or not,
  for fixing a cost that's already there but wrong. Scanning one pair's VIN returns the
  **whole SKU** on purpose: you're pricing a shipment, not a box. Same
  digits-end-to-end UPC rule and space/dash-insensitive SKU match as `findStockByCode`.

Both list tabs are month-scoped by default (`DateRangeBar`) — a Day filter would read
"all clear" while the home badge still shows dozens, the same reason No Box uses Month.

## Granularity: batch + SKU + size
`groupCostRows` makes one card per **batch + SKU**, with a row per size. One amount
covers every pair of that size **in that shipment** — matching `po_lines.unit_cost`
(per pair, per size) and the PH grid's per-size layout. The batch is part of the key
deliberately: the same shoe bought again next month may have cost something different,
and merging batches would silently overwrite the older shipment's price with the newer
one's. `~ mixed` marks a size whose pairs don't currently agree.

Saving a card fires **one request per changed size** (one amount, one set of VINs), so a
rejected amount names the size it came from instead of failing the whole shoe. Rows
update in place rather than refetching — on the backlog a fully-costed card would
otherwise vanish mid-scroll, losing your place and any chance to check what you typed.

## Gotchas
- **Blank is not $0, and this was a real bug.** `toCost` (now exported from
  `api/_lib/intake.js`, previously copy-pasted into `commit.js` / `box-commit.js` /
  `create-open.js`) used to be `Number(v)` guarded only by `isFinite && >= 0` — and
  `Number('')` / `Number(null)` are **0**. So an empty cost box at receiving was stored
  as *"this shoe was free"*, which no "no cost on file" query can ever find. It now
  returns `null` for blank/whitespace/null/undefined; a deliberate zero still works
  (type `0`). **The $0 tab exists to work off the rows created before that fix.**
- **`kind='existing'` is excluded from both list tabs** (`b.kind IS NULL OR b.kind <>
  'existing'` — the `IS NULL` half matters, it's a LEFT JOIN). Counted-in old stock has
  no cost to capture by design and runs to thousands of pairs (`existing-stock.md`);
  leaving it in would bury the pairs that genuinely need a number. `pendingCounts`
  applies the same rule via its `costable` flag — **the badge and the page must agree
  or the badge counts rows the page won't show.**
- **`missing`/`issue` units are excluded** everywhere here — dead paperwork, not
  something to cost.
- **Terminal units stay editable.** A pair that already sold still needs its cost for
  the margin to mean anything, so `sold`/`shipped` are not blocked.
- Every save writes an `item_events` `note` row ("Cost set to $X" / "Cost cleared")
  attributed to the person's name, like the other per-unit audit lines.
- There is **no way to confirm "$0 is correct"** — the review tab lists them, and a
  genuinely-free pair is simply left alone. Marking one as verified would need a new
  column.
