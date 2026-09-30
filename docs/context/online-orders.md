# Online Orders — shoes the PH team buys online

Screen `src/screens/OnlineOrders.jsx` at **`/ph/online-orders`** (PH home → Purchase
Orders) and **`/online-orders`** (warehouse home → Receiving Shipment Orders). Endpoints
`api/online-orders/{list,get,save,line,receive,delete}.js` (+ `_shared.js`, not a route).
Cost maths + stage: `src/lib/onlineOrders.js` (pure, used by the form AND the server).
Queries: the "Online orders" section at the end of `api/_lib/db.js`. E2E:
`e2e/online-orders.spec.js`. Added 2026-10-01.

## Why it exists
Three things, in the owner's words: the **warehouse knows what to expect** from online
buys, we **keep track of what each pair cost**, and it is **easy to audit** later.

**Deliberately its own list, not a purchase order** (owner's call when offered both).
Consequence: receiving does NOT yet match an online order by tracking number, so a pair
received off one doesn't pick up its cost automatically — see "Not yet".

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
`(price − coupon each + tax share + shipping share) × (1 − gift card %)`
- **coupon** split evenly per unit ordered (owner); **tax + shipping** split by PRICE
  (owner picked "by price"); **gift card** a % off everything paid (owner picked %).
- **Cancelled / not-delivered lines are left out** of the split — the pairs that come
  carry the order's money. (So a short delivery raises the survivors' cost; that is the
  honest number until a refund lands.)
- Never stored: worked out on every read from the order's money, so editing the tax can't
  leave a stale cost on a line. Blank coupon/tax/shipping = 0 (genuinely none).

## Tables (`scripts/db-setup.mjs`; all three in `LIVE_TABLES`)
- `online_orders` — store, order_number, tracking_number (nullable), ordered_on (DATE),
  coupon, tax, shipping, gc_pct, note, created/updated by+at, **received_at/_by**.
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

## Not yet
- No home badge for "Expected" / follow-ups (the page's tab counts only).
- No 17TRACK registration of the tracking numbers.
