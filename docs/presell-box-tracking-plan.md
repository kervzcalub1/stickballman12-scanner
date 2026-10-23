# Pre-sell: tracking numbers by BOX, not by size — plan

Status: BUILT 2026-10-24 (phases 1–4) on `feat/presell-boxes` — how it works now: `docs/context/presell-listings.md` → "📦 By box".
One change from the plan below: on a whole-order PO the grid writes `presell_box_lines`, NOT per-box
`po_lines` — the PO code forbids mixing a whole-order list with per-box lines on one order
(`po/scan-order`, reconciliation's `manifest_scope`), so writing there would have broken that rule.

## The problem
A box (one tracking number) holds up to ~10 pairs, and suppliers mix sizes in a box:
30 pairs ordered (10 × size 8, 10 × 9, 10 × 10) can ship as boxes of 3 + 3 + 3 + 1.
`presell_stock.tracking_numbers` is a flat list per SKU + size row, so it can never say
"3 of my 10 size 9s are in box A". Adding tracking to sizes one by one, or ticking many
sizes and pasting numbers, both lose the count.

## Facts from the owner
- **WE provide every tracking number** (the labels on the PO). The supplier only buys and
  packs. So we always know the boxes; what we don't know is what's inside each one.
- Usually the supplier tells us or **scans per box** (supplier scan-out → per-box
  `po_lines`). Some send only a **whole-order manifest** (no per-box split).
- No pre-sell without a PO has happened yet; support it as preparation, not as the main path.

## The model
A box's contents are the data; a size's tracking numbers are DERIVED from them.
That already exists on the PO side: `po_boxes` (one row per label = one tracking number) and
`po_lines` with a `po_box_id` (SKU + size + qty inside that box). Pre-sell rows link to POs
through `presell_stock_po`. So the PO stays the single source of truth for box contents;
`presell_stock.tracking_numbers` becomes a legacy/fallback list.

Per size: `placed` = Σ qty of that SKU + size across the linked POs' per-box lines;
`not in a box yet` = pairs − placed (a to-do, not an error). Over-placing (Σ > pairs, or >
the PO's ordered qty) is refused. SKU/size matching uses the reconciliation notation rules
(dual SKUs, `7.5W`) — never a raw string compare.

## Where box contents come from
1. **Supplier scanned / declared per box** (the usual case) — read straight from the PO.
   Nothing to type.
2. **Whole-order manifest only** — **📦 Box contents** grid on the pre-sell Stock page (and
   reachable from the PO): pick one of the PO's labels (tracking numbers we gave), type a qty
   per size. "Same as last box" (even packing), "Fill the rest" (last box takes what's left).
   Writes per-box `po_lines` with `entered_on_behalf = true` + `entered_by`, the same way PH's
   on-behalf manifest entry does — so receiving and reconciliation get it too. The
   whole-order lines stay as "the order" (two lists on one order, as for cart POs).
   Only while the box isn't received (respect the PO manifest edit window).
3. **Split unknown** — tick sizes, pick boxes: "these pairs are somewhere in these boxes",
   no counts. Shown as *split unknown*; replaced as soon as real counts exist.
4. **No PO (future)** — recommended: "Make a PO for this buy" from pre-sell (supplier +
   the tracking numbers we're giving them) rather than a parallel pre-sell box table, since
   every box we track is one of OUR labels anyway. Keeps one source of truth.

## What the Stock page shows
Under each size, instead of "N tracking":
> 9 — 19 pairs: 3 in 1Z…A4 ✅ delivered · 3 in 1Z…B7 🚚 exp 10/26 · 10 in 1Z…C2 🚚 · **3 not in a box yet**

Box status/ETA from the 17TRACK fields already on `po_boxes`. Cost & shipment's tracking
section shows the same breakdown; reports/CSV get a per-box column.

## Phases
| # | What | Schema |
|---|---|---|
| 1 | Read per-box `po_lines` for the linked POs → breakdown on Stock + Cost & shipment; "not in a box yet" count | none |
| 2 | 📦 Box contents grid (same as last box, fill the rest) writing on-behalf per-box `po_lines`; split-unknown multi-select | none for the grid; split-unknown needs a small link table |
| 3 | Use it: arrival by box (receiving box B says exactly which sizes came), set-aside from the earliest-ETA box, sale post "ships when 1Z…B7 lands", Fulfill where-is-the-pair names the box | small |
| 4 | No-PO buys: "Make a PO for this buy" from pre-sell | none |

## Open details to settle while building
- A size spread over two POs: breakdown groups by PO, then box.
- Re-list adding pairs after boxes are filled → the new pairs land in "not in a box yet".
- The grid must not fight a supplier who scans later: their scan of a box replaces our
  on-behalf lines for that box (show who entered it).
