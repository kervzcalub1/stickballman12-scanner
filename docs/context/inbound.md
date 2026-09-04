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

## Not on Home, deliberately
Home is a chore list — things somebody must go and do. This is a feed of things
happening to us, most needing watching rather than doing. Folding it in is how it
stops being read.

## Known limit — coverage
Only boxes that arrive **on a PO** are registered with the courier feed. Tracking
numbers typed in at receiving were never registered, so those boxes read **No
tracking**. Closing that gap means registering warehouse-typed numbers with 17TRACK,
which spends quota per number and needs the `APP_ENV=dev` guard at the registration
chokepoint (`tracking-dev-register-leak`). **That is an open business decision, not an
oversight** — a feed that is largely "unknown" launders "we don't know" into "nothing
is wrong", so it is worth settling before the team leans on this screen.

Carrier ETAs are not captured either; "arriving today" is `OutForDelivery`, which is
the honest version of it. Storing 17TRACK's estimated delivery date would need a
column and would be empty until new pushes arrive.
