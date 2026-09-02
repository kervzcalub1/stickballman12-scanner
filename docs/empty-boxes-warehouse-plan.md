# Empty shoe boxes — the warehouse side (SHIPPED)

**This plan was built on 2026-09-03. The living documentation is
`docs/context/empty-boxes.md`** — read that, not this.

Kept for the two decisions it argued out, which the context doc states rather than
defends:

**An empty box is an `items` row, not a quantity ledger.** The alternative was a
`box_stock(sku, size, dimensions, qty_on_hand, location_id)` table — no VINs, no per-unit
rows, no PH-exclusion work. It was rejected because it is a second, parallel stock model:
history, locations, costs, search and labels would each need their own version and the two
would drift, and it could never answer "what did THIS box cost". Choosing `items` made
every existing screen work on boxes for free, at the price of one entry in
`PH_EXCLUDED_KINDS` and one in `COST_EXCLUDED_KINDS`.

**Intake is quantity-first, not scan-per-unit.** Nobody scans two hundred identical
cartons. The plan called for the PO's own manifest as a counting checklist — which turned
out to be exactly what PO receiving already was, so the work was adding the carton to each
row rather than building a screen.

**What the plan got wrong, worth remembering:** it assumed Phase W2 (reconciliation) would
need a rewrite to key on dimensions. It didn't — requiring a SIZE on a box line, which the
user insisted on *after* the plan was written, made the existing `(sku, numeric size)`
matcher correct as-is. The plan's biggest phase became its smallest.
