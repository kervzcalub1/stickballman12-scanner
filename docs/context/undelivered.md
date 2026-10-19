# Undelivered Tracking + courier links

Screen `src/screens/Undelivered.jsx` at **`/undelivered`** (warehouse home → Receiving
Shipment Orders) and **`/ph/undelivered`** (PH home → Purchase Orders). Endpoint
`GET /api/undelivered?days=30|90|180|365|all` (`api/undelivered.js`, warehouse + PH; admin
auto-allowed) → `listUndeliveredTracking` (end of `api/_lib/db.js`). Rules / CSV / PDF:
`src/lib/undelivered.js` (pure; PDF reuses `tablePdf` exported from `presellReport.js`).
Added 2026-10-19. No schema change.

## Why
Packages went missing, and finding them meant opening every PO and online order to read
its tracking. The page lists every number still outstanding, and exports the ones to chase.

## What counts as undelivered
One row per number, from both places a number lives:
- **PO label** (`po_boxes` with a tracking #, `status <> 'delivered'`), any PO status
  (drafts included — a label made but never handed over is exactly a parcel to ask about).
- **Online order** with a tracking #, not counted in (`received_at IS NULL`), with at
  least one line not cancelled.

…and in both cases: the courier status (`shipment_tracking`, else `po_boxes`) is not
`Delivered` (whole word — `Undelivered` contains it), and **the warehouse has not
received the number** (no `batch_boxes` / `batches` row with it, case/punctuation
ignored). `days` limits to numbers ADDED in the period (po_boxes/online_orders
`created_at`). Capped at 2000 rows.

Online-order numbers are mostly **not registered with 17TRACK**, so they read
"No courier feed" — the courier link is the only status for them.

## The "it's just new" problem (owner's ask)
A number added two days ago is undelivered too, and isn't missing:
- **Every row has a tick box**, all ticked to start; the header box ticks/unticks all shown.
- **Sort newest → oldest** (default) or oldest first, by date added (`?sort=new|old`).
- **"Skip added in the last N days"** (3/7/14/30, `?skip=`) hides the newest in one go.
- Rows under 7 days old show their age in amber.
- **Only the ticked, shown rows** go into the CSV, the PDF, the pairs total and the bulk
  courier links. Ticks are page state (reset when the period changes), not saved.

Filters live in the URL (`days`, `skip`, `sort`, `src=all|po|online`, `q`).

## Courier links (`src/lib/carriers.js` + `src/components/TrackingLink.jsx`)
17TRACK is a relay and can lag the courier. Every tracking number on the PO detail,
Inbound, Online Order detail, Reconciliation, Duplicate Tracking and Undelivered pages is a
link to the **courier's own tracking page** with the number filled in.
- Courier = stored 17TRACK key / feed name (`courierKeyFor`), else the number's format
  (`detectCarrierKey`); unknown → 17TRACK's public page.
- `courierBulkLinks` groups many numbers per courier into one URL, split at the courier's
  own limit (UPS 25 newline-joined, FedEx 30, USPS 35, DHL 10, comma-joined; the rest one
  per page). The Undelivered page shows them as "UPS (8) ↗" for the ticked rows.
- Never put `TrackingLink` inside a `<button>` (the Online Orders LIST row is one, so it
  stays plain text there; the order detail has the link).
- The CSV carries the courier URL per row.

## Not yet
- Online-order numbers aren't registered with 17TRACK (quota) — see online-orders.md.
- No "marked as lost / claim filed" state; the export is the hand-off.
