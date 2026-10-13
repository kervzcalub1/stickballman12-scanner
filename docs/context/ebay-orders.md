# eBay Orders + Sales report — eBay page → **Orders** / **Sales report** tabs

Built 2026-10-13. Same page as eBay Listings (`/ph/ebay-listings` in the PH workspace,
**`/ebay` in the admin app**).

## Orders (PH + admin)
A table of every eBay order: photo · order # (links to Seller Hub) + date + total · buyer
username · the shoe(s): title, **SKU**, **size**, qty · eBay's **ship-by** · **tracking** (number
linked to the carrier, carrier, shipped date, and the carrier's word from 17TRACK) · status.

Status (`shipState`, `src/lib/ebayOrders.js`), judged against eBay's own dates, in EST:
**Late — not shipped** (ship-by passed) · **Ship today** · To ship · Shipped · **Delivery late**
(shipped, past eBay's latest delivery estimate, carrier hasn't said delivered) · Delivered ·
Cancelled. Plus a "shipped late" note when the first shipment came after ship-by. Late ones
sort first; filter chips count each. The list = orders placed in the period (7/30/90 days, this
year) **plus every order still waiting to ship** (last 60 days), so a late one can't hide.

## Sales report (ADMIN only — `requireAdmin`)
Period: Year to date (default) · This month · Last month · Pick a month · Last year · Custom.
Totals from eBay's money records (Finances API, by booking date, EST): orders sold, pairs,
gross (items + shipping, = eBay's fee basis), selling fees, refunds, labels/ads/other, **net**.
By month and by type, with **eBay's own `transaction_summary` totals** beside ours. Sales tax
eBay collects is never ours; WITHDRAWAL / LOAN_REPAYMENT / PURCHASE are listed but kept out
of the net (moving money, not sales). CSVs (built in the browser):
- **Sales by order** — one row per shoe: date, order #, buyer, title, SKU, size, item #, qty,
  item price, shipping, discount, tax (eBay collected), buyer paid, eBay fees (per line from the
  SALE record), net before refunds, refunded, status.
- **Statement** — every transaction as eBay booked it (type, credit/debit, signed amount, gross,
  fees, order #, buyer, memo, payout id).
- **Monthly summary**.
If the period starts before what's loaded, the page offers **Load from <date>** (a backfill sync).

## Sync (`api/_lib/ebay-orders-sync.js`, state `app_settings.ebay_orders_sync`)
1. Orders — first load / backfill by creation date (default Jan 1 EST this year; eBay keeps 2
   years); afterwards only what eBay changed since the last run (−15 min overlap).
2. Tracking — `shipping_fulfillment` per order, only when eBay's fulfillment count differs from ours.
3. Photos — our listings pull first; sold-out items via Trading `GetItem` once (`ebay_item_images`).
4. Tracking numbers shipped in the last 30 days → 17TRACK (`registerWarehouseTracking` +
   `claimForTracking`: once per number, never from the dev server). Status lands in
   `shipment_tracking` via the existing webhook.
5. Money — Finances `getTransactions` for the window (≤ 36 months a query), upserted by
   (transaction_id, type). A finances refusal is recorded (`financeError`) without failing orders.

**Worker** `api/_lib/ebay-orders-worker.js`: incremental sync every 30 min, production only
(`RAILWAY_ENVIRONMENT_NAME=production`; `EBAY_ORDERS_WATCH=on|off` overrides). It never does the
first (YTD) load — a person presses "Load this year's orders".

Tables: `ebay_orders` (lines + fulfillments as JSONB, money in cents), `ebay_transactions`,
`ebay_item_images`. `ebay_orders` is in LIVE_TABLES.

## Permission
Scopes `sell.fulfillment.readonly` + `sell.finances` (added 2026-10-13). An older approval keeps
everything else working; `ebayStatus().canOrders / canFinances` drive the "Connect eBay again"
prompts.

## Not built
Telegram alert for late shipments; returns/cases; the eBay "Payouts" report.
