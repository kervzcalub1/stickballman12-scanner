# Inbound feed (what is coming, and what has stopped moving)

`/inbound`, `src/screens/Inbound.jsx`, warehouse + ph_team (admin auto). Home card in
**Receiving Shipment Orders**. Endpoint `api/inbound.js` → `listInboundBoxes()`.
Classification: `src/lib/inbound.js`. Tests: `e2e/inbound.spec.js`.

## What it is
Every box on an order that is **not yet reconciled or closed**, with the carrier's
last word on it, grouped into shipments and sorted **worst first**. It answers the
question the warehouse opens the day with, which until now meant opening purchase
orders one at a time and reading each label's tracking.

The case that prompted it: a 169-pair shipment arrived 8 short, the supplier expected
paying, and nobody could say where the rest was without a manual hunt. On the day this
shipped that same order was still open on prod and the feed put it at the top —
`14/15 boxes · 158/169 pairs · −11 outstanding`, with box 3 sitting Expired in Chicago.

## Nothing is fetched
`listInboundBoxes` reads what the **17TRACK webhook has already written** to
`po_boxes`. Opening the screen costs one query and **no tracking quota**. There is no
new column and no schema change — the raw `tracking_status` already retains detail
that `mapBoxStatus` throws away (it folds **Out for Delivery** into In Transit, which
is right for a box's own status and wrong for a daily feed).

## The seven states (`INBOUND_STATES`, worst first)
| State | Means | Keyed on |
|---|---|---|
| **Investigate** | nobody is watching this and somebody must | `Expired`/`NotFound`, or ≥ `INVESTIGATE_DAYS` (8) of silence |
| **Delayed** | carrier reports a problem, or it has stopped | `Exception*`, or ≥ `STALL_DAYS` (4) of silence |
| **No tracking** | expected, with no number to follow | no `tracking_number` |
| **With supplier** | a label exists, the parcel was never scanned | `InfoReceived` |
| **Out for delivery** | on the truck — arriving today | `OutForDelivery` |
| **In transit** | moving normally | `InTransit` / pickup |
| **Delivered** | arrived | `Delivered` |

⚠️ **Silence is measured from the CARRIER's last checkpoint** (`tracking_events -> 0 ->>
'time'`), never from `checked_at`. `checked_at` moves whenever anyone hits Refresh, so
a stalled parcel would look freshly alive every time somebody looked at it. `checked_at`
is the fallback only when a box has no event history at all.

⚠️ **`InfoReceived` is called out separately on purpose.** It means the supplier printed
a label and never handed the parcel over — chasing the courier about it wastes
everyone's time, and it is a different conversation to a delay.

## Rules that carry a decision
- **A shipment is as healthy as its unhealthiest box.** Seven boxes landing and one
  stuck is not a delivered order — that is exactly how the 169 case read as fine.
- **Outstanding is withheld until something has been received.** Before that,
  "expected 169, outstanding 169" is the order restating itself. Over-receipt shows as
  `+N over` rather than a negative shortfall (it happens — see
  `po-reconciliation-notation-matching`).
- **Expected vs received reuse `listPos`'s own expressions** (replacements excluded
  from expected). Two answers to "how many were we promised" is worse than none; the
  row links into PO Reconciliation for the per-size detail rather than recomputing it.
- **Delivered boxes fold away**, inside an open shipment and in the list. On the order
  above, twelve landed boxes sat above the one that mattered.
- Classification lives in **one pure module** so the screen, its summary strip and any
  later Home tile or alert cannot disagree about whether a shipment is in trouble.

## Filters
**Supplier** and a **raised-date window** (`from`/`to`), both held in the URL like the
other filtered pages — a narrowed feed is something you send to somebody ("look at
Eric's week") and it has to survive the refresh you do after chasing a carrier.

⚠️ **The summary strip counts the FILTERED set.** A strip that kept counting the whole
warehouse while the list below showed one supplier is a strip that lies. When a filter
is on, the screen also says how many of the total it is showing, so a narrowed view
can never be mistaken for the whole picture. Dates are read in **EST** (`estDate` on
the order's `created_at`), like every other date in this app.

## Not on Home, deliberately
Home is a chore list — things somebody must go and do. This is a feed of things
happening to us, most needing watching rather than doing. Folding it in is how it
stops being read.

## Courier state is keyed by NUMBER (`shipment_tracking`)
Registration used to happen only for boxes on a purchase order, and the webhook wrote
only to `po_boxes` — so a number typed in at receiving had no feed behind it *and*
nowhere for an answer to land. Registering those numbers without somewhere to put the
result would have pushed status into a void.

**`shipment_tracking` is one row per parcel, keyed on the tracking number.** The
webhook and `track-refresh` write it on every push (`upsertShipmentTracking`,
COALESCE per field so a later push that omits a field cannot blank an earlier one),
`po_boxes` keeps its own copy so nothing on the PO side changed, and `listBatchBoxes`
reads from it — which is what lets a warehouse box show status at all.

**Registration now happens wherever the warehouse first writes a number**:
`batches/commit` (the shipment header), `batches/add-box`, `batches/sync-boxes`. All
go through `registerWarehouseTracking`, which **claims in the database before
spending**: `claimForTracking` stamps `registered_at` in the same statement that
inserts the row, so the same parcel scanned twice, or a slot list re-synced on every
blur, cannot pay for it twice. Fire-and-forget — receiving must never wait on, or
fail because of, a third-party account — and the `APP_ENV=dev` guard inside
`registerTracking` still applies, so a dev server cannot touch the live account
(`tracking-dev-register-leak`).

**Backfill:** `scripts/register-inbound-tracking.mjs`, dry-run by default. It refuses
values that do not look like tracking numbers — a **shape** check, not a prefix
blocklist (the runtime guard is `APP_ENV`, and blocklisting prefixes *there* would be
fragile). On prod that caught exactly two of 419: `NA`, and a 60-character run of
concatenated UPCs from a mis-scan. Both are listed rather than silently dropped.

⚠️ **`shipment_tracking` is a new table — run `db:setup` on prod BEFORE this code
deploys**, or `listBatchBoxes` throws on every batch page.

Carrier ETAs are still not captured; "arriving today" is `OutForDelivery`, which is
the honest version of it. Storing 17TRACK's estimated delivery date would need a
column and would be empty until new pushes arrive.
