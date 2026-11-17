# Online Orders — shoes the PH team buys online

Screen `src/screens/OnlineOrders.jsx` at **`/ph/online-orders`** (PH home → On the
Way) and **`/online-orders`** (warehouse home → On the Way). Endpoints
`api/online-orders/{list,get,save,line,receive,delete}.js` (+ `_shared.js`, not a route).
Cost maths + stage: `src/lib/onlineOrders.js` (pure, used by the form AND the server).
Queries: the "Online orders" section at the end of `api/_lib/db.js`. E2E:
`e2e/online-orders.spec.js`. Added 2026-10-01.

## Why it exists
Three things, in the owner's words: the **warehouse knows what to expect** from online
buys, we **keep track of what each pair cost**, and it is **easy to audit** later.

**Deliberately its own list, not a purchase order** (owner's call when offered both).
Receiving matches it by tracking number instead (see "Receive New reads it").

## The scenarios it was built from (owner, 2026-10-01)
| Scenario | What the page does |
|---|---|
| ordered → shipped → tracking → delivered | saved without tracking = **Ordered**; tracking added = **Shipped** (on the warehouse's **Expected** tab); counted in = **Delivered** |
| ordered → cancelled | tracking is OPTIONAL for exactly this: cancel the lines, the refund is still traced; every line cancelled = **Cancelled** |
| ordered → shipped (± tracking) → cancelled | cancel per line (OOT / other), refund traced |
| ordered 5 → delivered 3 | the warehouse's count splits the 2 off as **not delivered**, refund to chase |

The stage is **derived, never stored** (`orderStage`): `received_at` → delivered; every
line cancelled → cancelled; tracking → shipped; else ordered.

## Actual cost per pair (`orderCosts`)
`(price − coupon each + tax share + shipping share) × (1 − gift card %) − (price − coupon each) × cashback %`
- **coupon** split evenly per unit ordered (owner); **tax + shipping** split by PRICE
  (owner picked "by price"); **gift card** a % off everything paid (owner picked %).
- **cashback** — a **PERCENTAGE** (`online_orders.cashback_pct`, since 2026-10-07; was a
  dollar amount `cashback` from 2026-10-05). It's % of each pair's price **after the
  coupon, pre-tax and pre-shipping** (what Rakuten/card portals pay on; same base as the
  Payout Calculator's cashback), netted off after the gift card discount. Save refuses
  > 100% or a combination that would take a pair below $0. `db:setup` converted any
  dollar cashback already typed into the equivalent % once and zeroed `cashback`
  (legacy, unread).
- **Cancelled / not-delivered lines are left out** of the split — the pairs that come
  carry the order's money. (So a short delivery raises the survivors' cost; that is the
  honest number until a refund lands.)
- Never stored: worked out on every read from the order's money, so editing the tax can't
  leave a stale cost on a line. Blank coupon/tax/shipping = 0 (genuinely none).

## Tables (`scripts/db-setup.mjs`; all three in `LIVE_TABLES`)
- `online_orders` — store, order_number, tracking_number (nullable), ordered_on (DATE),
  coupon, tax, shipping, gc_pct, cashback_pct (cashback = legacy $), note, created/updated by+at, **received_at/_by**.
  Expression index on the whitespace-stripped upper tracking number (`[[:space:]]`, NOT
  `'\s'` — see the template-literal note in db.js).
- `online_order_lines` — sku, name, size, qty, unit_price; cancellation (`cancelled_at/_by`,
  `cancel_reason` oot|other|**not_delivered**, `cancel_note`) and the refund trail.
- `online_order_events` — the history: created · edited (with what changed) · cancelled ·
  restored · received · refund_requested · refund_refunded · refund_needs_request.

## Cancelling and the refund trail
- **Per line, and partial**: cancelling 1 of 2 SPLITS the line — the cancelled pairs get
  their own row, so the refund belongs to exactly those pairs (`cancelOnlineLine`).
- At cancellation: **refunded** (with the amount) or **needs follow-up**. Then
  `needs_request` → **requested** (how it was asked; the row shows "requested N days ago")
  → **refunded** (amount REQUIRED — it's what the audit checks). "Not actually back" returns
  it to follow-up. The **Refund follow-up** tab + the row's "N refunds to chase" chip are
  the chase list.
- **Filter chips** (2026-10-21): **Partly cancelled** = the store cancelled some pairs (any
  reason but `not_delivered`) and the rest are still coming/here; **Cancelled** = EVERY pair
  cancelled (was: any cancelled pair, which mixed the two). A warehouse shortage is not a
  store cancel, so 5-ordered-3-delivered is in neither. Rows say **"3 of 5 cancelled"** and
  **"N missing"** as separate chips (`listOnlineOrders` view `partial` / `cancelled`).
- **Undo cancel** for a mistake (not for `not_delivered` — that's the warehouse's count).
- Pairs on an order already counted in can't be cancelled (they arrived).

## Rules added after QA (2026-10-01)
- **A refused action writes nothing.** Cancel / refund / restore are ONE statement each,
  with the history row (and a partial cancel's split row) selected FROM the guarded UPDATE —
  two racing cancels used to leave two "cancelled" rows for one cancellation.
- **Refund moves are fixed**: needs_request → requested; needs_request|requested →
  refunded (amount > 0); requested|refunded → needs_request (amount cleared). Anything else
  is a 409 — enforced in the handler AND the WHERE.
- **Nothing is cancelled or restored once counted in** (a restored line would be a pair
  nobody counted on a Delivered order). Refunds can still be chased.
- **Stale form**: the edit form sends `baseLineIds` (the active lines it was built from);
  if they changed since (a cancel, a count), save is a 409 instead of resurrecting a
  cancelled line. The form lives in `?e=new|<id>`, so Back leaves it.
- **Coupon ≤ what the coming shoes cost**; money capped at $1,000,000; `ordered_on` must be
  a real date; ids past safe-integer range are a 400; a blank count in receive is a 400
  (it used to read as 0 = the whole line not delivered).
- **Count it in** is offered on Ordered too — a parcel can land before its tracking # is typed.
- Each line carries `lineTotal` (rounded from the exact per-pair figure) so a line never
  drifts a cent from the order total; the cancel dialog's refund default uses it.

## Receiving (warehouse)
"Count it in…" on a Shipped order: per line, how many arrived (default = ordered). Short →
split off as `not_delivered` + `needs_request`. One transaction; a second count of the
same order aborts the whole transaction (the guarded claim divides by zero when it
matched nothing → 409), so two benches can't both split the lines.

## Roles
PH records, edits, cancels, chases refunds, deletes; the **warehouse reads + counts in**
(`receive` allows warehouse + PH); admin/superadmin auto-allowed. **Delete** only for an
order recorded by mistake: refused once counted in or once a refund was requested/received.
Duplicate tracking number → 409 naming the other order, "Save anyway" for one parcel
holding two orders.

## Receive New reads it (2026-10-01)
Every tracking number on a receive (the shipment's, each box's; ≥ 8 chars, spaces/case
ignored) is looked up with `GET /api/online-orders/by-tracking?t=` (warehouse + PH; newest
order wins if two share a number; before `db:setup` it answers "none", never an error).
A match shows `OnlineOrderBanner` (Step 1 and above the scanned pairs: what it should
hold, "already counted in" if so), and each pair's cost resolves **typed → PO → online
order → batch default** — the order's line `each` (`onlineLineFor`, same SKU/size matching
as a PO line) IS the landed cost, no preset on top; the card says "from online order
OO-…". The price paid is saved as `items.shelf_price`. Never on a PO receive, rescale or a
no-shipment receive. Counting the order in stays on the Online Orders page (that is where
a short count becomes a refund to chase). E2E: `e2e/receiving-online-order.spec.js`.
- **Per box, not per receive** (QA pass #2): the cost and the scan-step banner use only the
  order of the parcel BEING SCANNED — the active box's tracking (else the shipment's).
  Box 1 = order A and box 2 = order B used to cost a box-2 pair off order A whenever both
  carried that SKU + size. Step 1 still names every order the receive touches.
- Box mode (adding a box to an existing batch) names the box's order under its header.
- Answers are remembered per number for a minute, so editing one box's tracking doesn't
  re-ask about the others.
- **The box against its order** (Brent, 2026-10-21 — "like inbounding against a supplier's
  manifest"): `onlineOrderCheck(order, cartItems)` (src/lib/onlineOrders.js) builds the
  expected rows from the order's NON-cancelled lines (same code/numeric-size matching) and
  feeds `manifestSummary`, so it reads exactly like a PO label:
  - **Review** shows "Box against online order OO-… · store" — expected · received ·
    missing · extra / not on order, row by row (`ManifestSummary` with `against` /
    `notOn` / `showHow=false`; a plain receive has no scanned-vs-ticked record).
  - **At commit**, if it's off, an automatic **`online_order` shipment issue** is added
    ("Doesn't match the online order", description = every row that differs, expected /
    received counts) → the ⚠ on Recent and the batch's issue list.
  - **The "saved" window** repeats it (`OnlineMismatchAlert`, like `ReconcileAlert`) with a
    link to the order on Online Orders. Counting in is still done there — that's what
    turns a missing pair into a refund to chase.
  - Not once the order is already counted in, never on a PO receive / rescale.

## The receipt links itself (2026-11-18)
Owner: *"automatically grab the receipts based on the order id that was set by the user"*, with
**SP2515272** as the example: a Shoe Palace order of 10 pairs that shipped in 4 parcels, entered as
four online orders with the same order number.

- **When the order # is saved** (new order, or the number changed), the ordering mailbox is asked for
  that number in the background and the store's confirmation email is filed as a receipt
  (`email_receipts`, so it is on the Receipts page too). Code: `api/_lib/online-order-receipts.js`.
- **Nothing is stored on the order.** An order and a receipt with the same number (`upper(btrim())`)
  belong together, joined at read time (`receipt`, `receipt_check`, `same_order` on `listOnlineOrders` /
  `getOnlineOrder`; `receiptLink` in `src/lib/onlineOrders.js` → `receipt_link`). A receipt filed any
  other way (a mailbox check) links the same.
- **One number on several online orders = one receipt, shown on all of them.** The receipt's pairs are
  compared with every parcel of that number together: "entered as 4 parcels: OO-0204 (3) + … = 10 pairs,
  matches the receipt", or "the receipt says 10". Cancelled pairs count: the receipt is what was ordered.
  The list row carries **Receipt linked** / **Receipt differs**.
- **How the mailbox is asked:** the same Make scenario the buying requests use (6282792,
  `MAKE_RECEIPT_PARSER_URL`, POST `{ transaction_id }`). It returns the OLDEST email with that text, which
  for an order number is the confirmation. The email must carry the number as a whole word
  (`mentionsOrder`), or it is not this order's.
- **Shopify stores** (Shoe Palace): the Make parser knows the in-store receipts and returns no items for
  these, so `parseShopifyOrderEmail` reads them here ("Name × qty", the variant line = size, the last
  `$` line = the line total, then Subtotal / Shipping / Taxes / Total). No style code is in that email,
  only the shoe's name.
- **`online_order_receipt_checks`** (one row per order number; **needs db:setup**; in `LIVE_TABLES`):
  `pending` → `found` | `not_found` | `error` | `unconfigured`. Not found is asked again after 15 min,
  2 h and 1 day (`RETRY_MIN`), then it stops until someone presses **Check again**
  (`POST /api/online-orders/receipt`, PH + admin). Re-saving an order never asks twice.
- **Worker** (production only; `OO_RECEIPT_WATCH=on|off`, `OO_RECEIPT_MIN` default 5): each tick queues
  3 orders from the last 60 days that were never asked about, and runs what is due. So the orders
  recorded before this shipped catch up over a few hours rather than in one burst of Make runs.
- E2E: `e2e/online-order-receipts.spec.js`.

## Tracking numbers fill themselves (2026-11-18)
Owner: fill the tracking number on online orders automatically. A store that ships one order in several
parcels sends one "A shipment from order #… is on the way" email per parcel, with its tracking number and
"Items in this shipment" (name, `4 of 10`, size). SP2515272: three parcels, 4 + 2 + 4 pairs.

- **The mailbox:** a second Make scenario, **7082222 "Order emails"** (webhook 3078668, Cherry's team):
  POST `{ order }` → Gmail All Mail search for `"<order>"` (≤ 60, oldest first) → a text aggregator →
  the plain text of every email, `@@SUBJECT@@ / @@FROM@@ / @@DATE@@ / @@TEXT@@` blocks split by
  `@@SBM-EMAIL-END@@`. No code module, no stored secret. Env **`MAKE_ORDER_EMAILS_URL`** (the URL is the
  secret; unset = this part is off). Gmail only: Yahoo and the Spam folder are not searched.
- **Reading** (`api/_lib/online-order-shipments.js`): `parseShopifyShipmentEmail` → `{ tracking, carrier,
  status, items }`. On the way / out for delivery / delivered are three emails for ONE parcel
  (`parcelsFromEmails`, keyed by tracking number, furthest status kept). Kept in
  **`online_order_shipments`** (order number + tracking number; **needs db:setup**; in `LIVE_TABLES`).
- **Placing** (`planParcels`, pure, `src/lib/onlineOrderParcels.js`), one step at a time, re-planned from
  the database after each:
  - the number is already on an entry of that order number → nothing;
  - an entry with **no tracking number** holds exactly the parcel's pairs (by size) → **fill** the number in;
  - exactly one entry has no tracking number and the parcel is part of it → **carve**: those pairs become
    their own online order with the number, and coupon (per pair), tax and shipping (by price) move with
    them, so no pair's actual cost changes. When what is left IS the last parcel, it is a fill.
  - anything else is **not placed** and shown as "not on an order yet": two open entries and a parcel
    that is neither, more pairs than the entry has, two shoes in one size and a name that picks neither.
  - Never touched: an entry counted in, one that already has a tracking number, cancelled pairs, a
    number that is on another order number's entry.
- **Guarded on what the plan read** (`carveOnlineOrder`, one statement): the active line ids AND their
  quantities must still be the same (a partial cancel keeps the id and lowers the qty), or nothing is
  written. History says it on both entries; the actor is "Store email". Placed numbers go to 17TRACK
  like a typed one.
- **When:** on saving an order number with no tracking number; the **Check the emails now** button
  (`POST /api/online-orders/receipt`, which also looks for the receipt); and a worker (production only,
  `OO_SHIP_WATCH=on|off`): every order number with an entry still waiting for a tracking number (not
  counted in, ≤ 30 days old) is asked about again every `OO_SHIP_HOURS` (4), 4 numbers per 5-minute tick
  (`online_order_ship_checks`). A number whose emails are not a Shopify store's is marked `skip` on the
  first answer and not asked about again. `OO_SHIP_APPLY=off` reads and shows parcels, changes nothing.
- **The page:** a **Parcels** box on the order: each tracking number (courier link), pairs, status, and
  the entry it is on.
- **Only Shopify stores' shipping emails are read** (Shoe Palace). Nike, Foot Locker and Champs ship
  with emails in other shapes; their tracking numbers are still typed.

## Short or wrong parcels: found, told, documented (2026-11-18)
Owner: a parcel that arrives with fewer pairs than its online order has to reach the team and be
documented well enough to claim from the store (example: tracking 1Z16G27K0320615996, 4 ordered,
3 in the batch).

- **At the bench** (the order's number is known when the box is received): `onlineOrderCheck`
  already says "N missing" / "not on order" on Review. Now, when pairs are **missing OR pairs in
  the parcel are not on the order** (wrong shoe, wrong size, one too many — owner, same day), Step 4
  shows **Parcel doesn’t match its order: photos for the claim (required)** — `CLAIM_PHOTOS` (`src/lib/onlineOrders.js`): the shipping label
  with the tracking number, every shoe box that arrived in one picture, the packing slip / manifest
  ("There was no packing slip in the parcel" is the one way past that third photo). The box cannot be
  saved without them. They ride on the automatic `online_order` shipment issue (`photos`, and the
  description says how many of each), so they are on the batch and on the PH team's case.
- **WhatsApp:** the same card, and the "saved" alert, say **Tell the PH team on WhatsApp now** with a
  ready message (store, order #, OO code, tracking, ordered / received / short by) and **Copy the
  message**. The app does not send WhatsApp; the person does, with the photos they just took.
- **Telegram:** the issue opens an inbound-issues case as before (`inbound.issue_reported`); its
  headline now reads **"Online order parcel SHORT by N (expected 4, got 3)"**, **"… has WRONG pairs"**,
  or both (`issueHeadline`; wrong is read off the description's "not on the order" / "extra (").
- **Found later** (`api/_lib/online-order-received.js`): a parcel is often received BEFORE its number
  reaches the order (the store's email fills it in afterwards). `compareOrderWithReceived(orderId)`:
  the delivery with that tracking number (`receivedForTracking`: a received box's own number first,
  then a committed batch's; supplier deliveries only) → pairs received vs pairs still expected.
  **Short is by COUNT** (fewer pairs out than ordered). **Wrong is by shoe**: the count is there but
  a pair is not the code + size ordered, the bench's own rule (dashes/spaces dropped, numeric size) —
  so an order whose SKU was typed differently from the box reads as wrong pairs here, as it does at
  the bench. Either →
  one `online_order` shipment issue + case (source `online_order`, "Short by 1: 3 of 4 pairs…"),
  Telegram to PH, and a **warehouse job on the case** asking for the three claim photos and the
  WhatsApp message (`PHOTO_TASK`, the Warehouse to-do tab + `inbound.warehouse_task`).
  - One flag per delivery (`onlineOrderIssueOnBatch`): the bench's own issue, or an earlier compare,
    stops a twin. Not when the order was already counted in or has nothing still expected.
  - Runs when a number is placed from an email, when one is typed on an order, and from a worker
    (production only, `OO_RECEIVED_WATCH=on|off`, every 10 min) over orders never compared whose
    parcel is in (`online_orders.received_check_at`, **needs db:setup**; cleared when the number changes).
- E2E: `e2e/receiving-online-order.spec.js`.

## Counted in by itself, and told on Telegram (2026-11-18)
Owner, looking at three Foot Locker orders (OO-0083/84/85) still "Shipped" and on the delayed list
17 days after the warehouse received them: the order only became Delivered when someone pressed
**Count it in…**, and nobody had. Now the warehouse's scan IS the count.

- `compareOrderWithReceived` (above) also **counts the order in** (`receiveOnlineOrder`, the button's
  own write; `received_by` = `Auto · batch B-…`, the history says which batch):
  - every pair there → **Delivered**;
  - pairs missing, nothing wrong in the parcel → counted in with what arrived, the missing pairs
    split off as `not_delivered` + `needs_request` (the **Refund follow-up** tab), and the case;
  - wrong pairs → **not** counted in: which ordered pair a wrong one stands for is a judgement.
  Counting in is what takes an order off Expected and off the "Shipments delayed" message, so a
  courier feed that never updates no longer keeps a received parcel on the chase list.
- **The same shoe said two ways is not a wrong pair** (`underOrderCodes`, found on the real data:
  10 of 69 orders read as wrong before this): codes compare on letters and digits only (`bareCode`:
  `IV2867/100` = `IV2867-100`); a code ONE character off at the same size is the order's typing slip
  (`nearCode`: `Q0400-100` for `IQ0400-100`); a box in women's sizing (`11.5W`) is the men's size
  ordered (10). Each only when exactly one order line fits.
- **Telegram, once per order** (`online.order_arrived`, "Online order arrived", PH + admins, in the
  bell panel under Shipments): merchant · order # · tracking · batch · what came out · the finding
  (✅ all arrived / ⚠️ SHORT by N / WRONG pairs, whether it was counted in, the case #). A parcel
  that matched and landed more than 3 days ago is counted in **quietly**, so the catch-up over old
  orders is not a hundred "all arrived" messages; a discrepancy is always told.
- **Catch-up:** the worker clears `received_check_at` once (`app_settings.oo_autocount_reset`) for
  orders it compared before it could count, then works through them 20 per 10 min.
- A batch-level tracking number no longer counts pairs from a box that came under another number.
- **"Did it land at all?"** is the pages that already exist, now without the received ones in them:
  Online Orders → **Expected**, **Undelivered Tracking**, and the daily "Shipments delayed" message.

## Not yet
- No home badge for "Expected" / follow-ups (the page's tab counts only).
- (Until 2026-11-06) no 17TRACK registration of the tracking numbers. They appeared on **Undelivered Tracking** as "No courier feed" with a link to the courier's site (`docs/context/undelivered.md`).

## Expected This Week (2026-11-06)
`/expected` (`src/screens/Expected.jsx`, `api/expected.js`, sums in `src/lib/expected.js`): the warehouse's
view of what is coming, **one table per supplier and one per online store**, with Today, Rest of the week,
Later, No date yet, Overdue and Here-not-counted-in columns, in boxes or parcels and pairs. A row opens to
its orders with a link to the courier. Home's **Expected today** adds online parcels and opens this screen.
- **The week is a plan, not a timetable:** today plus the next 7 days, one column, no date per parcel.
- **Days come from the carrier's estimate**, through the same `arrivalBucket` as Inbound. `shipment_tracking`
  gained `eta_from`/`eta_to` (**needs db:setup**), written by the webhook and refresh.
- **Online numbers now go to 17TRACK** (owner, 2026-11-06, reversing the earlier quota call): on save, and
  `tracking-delay-worker` works through open orders from the last 60 days, 40 at a time. Claimed first, so a
  number is only paid for once.
- **Left out:** supplier boxes already received, and online orders counted in or wholly cancelled. An online
  order with no tracking number shows under No date yet.

## Delayed shipments (2026-11-06)
A tracking number with **no movement in 7 days** is **Delayed** on Expected This Week (its own column, ahead of
any estimate), and the team hears about it on Telegram (`tracking.delayed`, `tracking-delay-worker.js`).
- **Who:** warehouse, PH and admins with Telegram connected, on by default and switchable in the bell panel.
  PH's link opens PH's own copy of the screen (`/ph/expected`, 2026-11-06).
- **When:** one message from 10:00 EST. A stall is announced once and reminded every 7 days. A parcel that moves
  and stops again is a new delay (`tracking_delay_alerts`, **needs db:setup**).
- **What it says:** supplier or store, order, box, pairs, carrier and number, days, last location, and who to chase
  (`delayFollowUp`): never scanned → the sender; carrier exception → call the carrier; stopped → ask for a trace.
- **Not alerted:** no tracking number, delivered, received, or stopped over 60 days ago. Those last still show
  as Delayed on the screen. Inbound uses the same 7 for Delayed (`STALL_DAYS`, 2026-11-06, was 4) and 8 days for Investigate.
