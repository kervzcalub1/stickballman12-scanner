# Rescale (restock + request/audit)

Two connected flows: warehouse rescales stock; PH requests a rescale (audit).

## Warehouse rescale → PH restock worklist
- Rescale intake (Receiving `mode='rescale'`) or a VIN re-scan (`api/items/rescale.js`
  → `rescaleItem`) sets `items.restock_pending = true` and logs a `rescaled` event.
- PH **Rescale Stock** (`PHGrid kind='rescale'`) is a worklist of
  `restock_pending` units (dated by the latest `rescaled` event), excluding no_box.
- PH re-lists (price + II/AL/SX/SH) and clicks **✓ Restocked** →
  `api/items/restock-done.js` (`markRestocked`) clears the flag → the unit drops
  off the worklist and behaves as normal inventory.

## PH request rescale → warehouse audit (reported vs actual)
- **PH** submits via `RescaleRequestForm`: SKU (with **Search** → auto-fill name),
  sizes + qty (reported), current price, reason (mismatch | quantity | recount |
  returned | relisting | other), note. → `api/rescale-requests/create.js`
  (`createRescaleRequest`). Status `open`.
- **Warehouse** opens **Rescale Requests** (`RescaleRequestsReport` with
  `canAudit`), clicks **🔍 Audit shelf**, enters the **actual** qty per size
  (pre-filled from reported; can add sizes / set 0) + audit note →
  `api/rescale-requests/audit.js` (`auditRescaleRequest`). Status → `audited`.
- **Shared report** (both roles): `RescaleCompare` renders a grid —
  **Reported (top) / Actual (bottom)** per size. Cell highlight: **red** =
  mismatch (`rcmp-diff`), **green** = match (`rcmp-match`). Filter Open /
  Audited / All + date. PH can `+ New request` (passes `canCreate`).
- **PH listing after audit** (`canCreate`, i.e. PH team): once a request is
  `audited`, PH sets **GI + Final price + II/AL/SX/SH per size** right on the
  request — a per-size table seeded from the audited **actual** counts.
  **↻ Get GI from Alias** (`POST /api/rescale-requests/fetch-gi` → `giForSkuSizes`)
  fills GI per size by the request's SKU; Final auto-calcs GI + 20% (`calcFinalPrice`),
  both editable. Save → `POST /api/rescale-requests/list-update` →
  `updateRescaleRequestListing` stores it on the request (`listing` JSONB +
  `listed_by/at`); **requests aren't tied to VINs, so this is a self-contained
  listing record** (it does NOT flip inventory sync flags — that's the Rescale
  Stock worklist's job). A read-only listing table shows once saved. **GI/Final
  are hidden from warehouse** (`showPricing` prop, false for the warehouse role).
- Home badges: 🟡 Pending audit (open) + 🟢 Audited (done) — `pendingCounts`
  returns `rescale_requests` (open) and `rescale_requests_audited`.

## Notes
- The two halves loop: PH request → warehouse audits/rescans → restock worklist
  → PH re-lists. Reasons may be revised after team confirmation.
- `db:reset` clears `rescale_requests` along with inventory.
