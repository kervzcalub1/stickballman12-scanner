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
`po_boxes`. Opening the screen costs one query and **no tracking quota**. The raw `tracking_status` already retains detail
that `mapBoxStatus` throws away (it folds **Out for Delivery** into In Transit, which
is right for a box's own status and wrong for a daily feed).

## The day comes first (2026-09-10)
The feed classified every box by **where** it was and never by **when** it was due, so
"In transit" covered both a parcel on a truck two streets away and one leaving Guangzhou
on Thursday. A floor cannot plan a morning from that. The top of the screen is now the
carrier's own estimated delivery window, in **boxes and pairs**, for today and the days
after it.

- **`po_boxes.eta_from` / `eta_to` / `eta_source`** — 17TRACK sends the estimate in the
  webhook payload we already receive (`track_info.time_metrics.estimated_delivery_date`);
  we simply were not reading it, so this costs no extra call and no quota. Both the
  webhook and `po/track-refresh` populate it, because both hand the whole parsed entry to
  `setPoBoxTracking`. **Needs `db:setup`.**
- **A WINDOW, not a day.** Carriers quote "Tue–Thu" as often as a date, and collapsing
  that to its first day puts a parcel on the warehouse's list two days early. Any day
  inside the window reads as *due today*.
- **Tied to the status that carried it**, like `tracking_sub_status` and for the same
  reason: a window that has passed is not an estimate, it is a stale promise, so a
  COALESCE would leave "arriving Tuesday" on a parcel the carrier has since re-quoted.
- **Existing boxes have no ETA until their next update.** The column is new; nothing is
  backfilled. Each live parcel fills in as the webhook fires, or immediately on a manual
  `po/track-refresh` (which does cost quota).

### The buckets (`ARRIVAL_BUCKETS`, `arrivalBucket`)
`overdue · today · tomorrow · this_week · later · unknown · landed`, in that order.

- **Out for delivery beats the estimate outright.** The parcel is on a truck, so it
  arrives today whatever a three-day window said this morning — the one case where the
  carrier's movement is better evidence than the carrier's own promise.
- **`unknown` is never folded into `later`.** "Not for a while" and "we have no idea" are
  different answers, and only one of them lets somebody stop planning around it. Anything
  the carrier has never scanned (`no_tracking`, `with_supplier`) is `unknown` too — a
  label with no parcel behind it has not earned a date.
- **"Never scanned" is checked on the box's own status, not only on its state**
  (`neverScanned`, 2026-09-11). A label-only box that has sat for `INVESTIGATE_DAYS`
  derives as `investigate` rather than `with_supplier`, and was falling through into the
  day buckets — appearing in *arriving today* off an estimate the carrier never earned.
  `investigate` is deliberately **not** excluded wholesale: a parcel that WAS scanned and
  then went quiet has a real estimate behind it, and `overdue` is the honest answer for
  that one.
- **`arrivalBucket(box, today, state, now)` takes `now`.** It used to default it inside
  and call `inboundState(box)` bare, so a function handed an explicit `today` went and
  read the **wall clock** to derive the state — the same class as the banned
  `toLocale*()` (`est-everywhere`), and it failed the way those do: the pinned test
  passed for eight days, then went red on its own on a commit that touched nothing near
  it. Every real caller passes `state`, so the fallback was the only route in. The specs
  pin `NOW` alongside `TODAY` now (`bucket()` helper in `e2e/inbound.spec.js`).
- Dates are compared as **strings** against `estToday()`. Both sides are `YYYY-MM-DD`, so
  string comparison IS date comparison, and it avoids the `new Date('YYYY-MM-DD')` trap
  that reads a day in the viewer's zone — the PH team's clock is a day ahead of the EST
  day the warehouse works to. `addDays` does the arithmetic in UTC for the same reason.

### Pairs, and the ones it cannot count
`arrivalPlan` returns `{ boxes, units, unknownUnits, shipments }` per bucket. Pairs matter
because they are what cost time: twelve boxes of two is a quiet morning and two boxes of a
hundred and sixty is not. `box_units` (new on `listInboundBoxes`, summed from `po_lines`
per **box**, not per order) is what makes that answerable when three of an order's five
boxes land on Thursday.

**A box with no manifest contributes to `unknownUnits`, never to `units` as a zero.** "No
pairs expected" and "we don't know how many" are different answers, and the strip says
which one it means.

### On Home
`src/components/InboundToday.jsx`, above **Needs attention**. The headline and the
progress bar only — Home is a chore list, and putting the day strip, the state strip and
the shipment list there would turn it into a second Inbound page and bury the chores.

- **Renders nothing when there is no inbound stock**, so a quiet week leaves no permanent
  empty card for people to learn to skip past.
- **Fails silently.** A warehouse hand's home screen must not show an error because a
  summary could not load; the chores under it are the point.
- Same functions as the screen (`arrivalPlan`, `inboundProgress`), because two places
  counting the same boxes differently is worse than one place counting them at all.

### `.page` had no CSS rule
The screen shipped against `<div className="page">` and was the only file in `src/` using
it. Nothing in `styles.css` defines `.page`, so Inbound alone rendered full-bleed — no
max width, no centring, no safe-area padding — while every other screen sat in `.app`'s
gutters. **Third instance of this exact failure** after `.table` (buy-cart) and `.chip`
(size chips): a class that does not exist looks like a deliberate styling choice rather
than a missing one, which is why all three survived review.

### Two strips, two axes
**When it lands** and **How it is travelling** are separate and stay separate — a parcel
can be due today *and* stuck, and a delayed box has no meaningful arrival date to sit
under. Both filter the list below, and they combine. `?due=today` is in the URL like the
other filters, so "look at what lands today" is a link you can send.

`inboundProgress` is the bar under the headline: landed boxes over everything still
inbound, in the current filter scope.

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
