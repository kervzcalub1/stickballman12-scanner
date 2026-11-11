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

## Pick list (PH + admin; built 2026-11-12)
Tick orders in the table (a tick per row; the header box = every order shown; **Select awaiting
shipment** = every Late / Ship today / To ship order, whatever the filter shows; a cancelled order
can't be ticked) → **Download pick list (n)**. The PDF is built **in the browser** from the ticked
rows (`src/lib/pickList.js`, jsPDF lazy-loaded) and saved — no print dialog. File
`pick-list-ebay-<EST day>.pdf` (`pickListFileName`, EST via `estDate`, never the browser's date).
Shared strip: `src/components/PickListBar.jsx`; the SHEIN page has the same (`shein-live-fix.md`).
- **One entry per PAIR** (a line of qty 2 = 2 entries; an order of 2 pairs shows "1 of 2"/"2 of 2"):
  `#order number` · shoe name (max 2 lines, then "...") · `SKU <style code>` + `Size <size>`.
- **SKU = the style code** the warehouse picks by (the box label), not eBay's Custom label (Shopify's
  internal number): `GET /api/ebay/orders` adds `style` (+ `shopify_size`) per line from Shopify's copy
  (`shopify_listing_variants` by SKU, `shopifyCopyForSkus`), else `styleFromTitle(title)`, else the
  listing SKU.
- **The page: 4 x 6 in = 288 x 432 pt** (direct-thermal label printer), Helvetica-Bold only, pure black.
  Body 14 pt, header/footer 10 pt, leading 1.3x (18.2 pt), margins 0.2 in, 7 pt white + 2 pt rule + 7 pt
  white between entries. **At most 4 entries a page**, and the pager measures each one (a SKU too long
  to share its line pushes the size to a 5th line) and breaks early rather than spill.
- **Thermal numbers** (203 dpi: 1 pt = 2.82 dots; Helvetica-Bold AFM StdHW 118 / StdVW 140 / cap 718):
  14 pt → thinnest stroke 4.7 dots, stem 5.5, cap height 28.3 dots; the order number's 12 pt floor →
  4.0 dots; 10 pt header → 3.3 dots (plain Helvetica at 10 pt would be 2.1 — why nothing is regular);
  2 pt rules = 5.6 dots. Lines: 5.2 pt (14.7 dots) of white between one line's descenders and the next
  line's capitals. Worst 4-line entry 72.8 pt; 4 + 3 separators = 339.2 pt of the 357.2 pt available.
- **The order number is never cut or wrapped**: 14 pt, shrinks in 0.5 pt steps only if it must, never
  under 12 pt (real eBay / SHEIN numbers are 14–15 characters, 110–150 pt wide at 14 pt).
- All drawn text is folded to ASCII (`ascii`): jsPDF's Helvetica silently drops anything else.
Tests: `e2e/pick-list.spec.js` (layout numbers, entries, the real SQL, both tabs' download read back with
pdf-lib + pdf.js, file named by the EST day with the browser in Manila).

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
A pick list printed straight to the printer (download only, by the owner's choice); Telegram alert for late shipments; returns/cases; the eBay "Payouts" report.
