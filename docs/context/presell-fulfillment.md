# Pre-sell Fulfilment — orders to ship, labels, the pick list

Built 2026-10-12. **Pre-sell Listings → 📦 Fulfill** (`?tab=fulfill`, `src/screens/PresellListings.jsx`
`FulfillTab`). Warehouse, PH, admin. Step 1 of a fulfilment feature: read the status; the
scan-to-pack step is not built yet. E2E: `e2e/presell-fulfill.spec.js` (fake marketplaces).

## What the platforms do (checked live 2026-10-12)
**Both make the UPS label AT the sale.** Nothing is "fulfilled" through the API: the warehouse
prints the label, packs, hands the box to UPS, and the platform moves the order on once UPS scans
it. **Miss the ship-by deadline and the platform cancels the sale.**
| | Alias | StockX (Direct) |
|---|---|---|
| read | `GET /api/v1/orders/{id}` → `{ order }` | `GET /selling/orders/{orderNumber}` (the **active list has no shipment**) |
| waiting to ship | `ORDER_STATUS_LABEL_GENERATED` (~9 s after the sale) | `CREATED` (`CCAUTHORIZATIONFAILED` = buyer's card failed, kept on the list) |
| label | `label_url` (public PDF) | `shipment.shippingLabelUrl` (PNG) + `GET …/shipping-document` → 4×6 instructions, letter instructions, **label-only PDF** (preferred), `additionalDocumentsRequired` |
| tracking | `label_tracking_number`, `label_courier` (ups) | `shipment.trackingNumber`, `trackingUrl`, `carrierCode` |
| ship by | `cancels_at` (~2.5 days) | `shipment.shipByDate` (~4 days) |
| after | `UNDER_REVIEW`, `COMPLETED`, `CANCELED_BY_BUYER` | `PAYOUTPENDING/COMPLETED`, `COMPLETED`, `DIDNOTSHIP`, `CANCELED` |
`shipStateOf` (`src/lib/presellFulfill.js`) maps these to **to_ship / shipped / cancelled**. An
unknown status that isn't a cancel counts as moved on (shipped, raw name shown). `PAYOUT*` is
always shipped (a failed payout is not a cancelled sale).

## Data — columns on `presell_sales`
`order_status` (the platform's word), `ship_state` (NULL = not read yet), `ship_by`, `carrier`,
`tracking_number`, `tracking_url`, `label_url`, `ship_docs` JSONB (StockX: thermal / letter /
labelOnly / additionalRequired), `ship_state_at`. Index on the open ones.

## The sync (`api/_lib/presell-fulfill.js` `syncFulfillment`)
- **Read-only GETs**, so safe on any environment. The worker runs it every **2 min** where
  `PRESELL_WATCH=on`: a never-read sale at once, an open one at most every 10 min (in-memory). The
  tab's **↻ Check status now** forces a pass anywhere (waits ≤ 20 s, else finishes on its own).
- Only sales with `ship_state` NULL or `to_ship`; once shipped/cancelled it's never read again.
- StockX: the detail call + the shipping document **once** (while to ship), both through the
  shared rate-limited queue; a 429 ends the pass.
- **Writes only when something changed** (`updatePresellSaleShip`) — `presell_sales` is a live
  table, and a write every pass would re-read every open screen for nothing.
- A sale whose order can't be read (404) stays "not read" and is retried every 10 min.

## Where is the pair (`assignWhere`)
Per stock row (SKU + size): **set aside** = `arrived_qty − released_qty` (pairs the arrivals held
back for in-transit buyers, `presell-listings.md` → In transit), less that row's orders already
**shipped** = pairs on the set-aside shelf now. Orders take them most-urgent ship-by first; the
rest are **in transit** (shipment not all here), **shelf** (all arrived — a sale that raced the
take-down) or **source it** (row was never in transit: we don't own the pair).

## The tab
To ship / Shipped / Cancelled (counts), search (SKU, name, order #, tracking). Totals: to ship,
late, due < 24 h, and the four "where" chips (tap = filter; the pick list follows the filter).
One card per **SKU + size**, most urgent first; per order: platform, order # (copy), ship by +
time left (red late, amber < 24 h), where, UPS tracking link, **🏷 Label** (StockX label-only
PDF, else PNG; Alias PDF), StockX **Instructions 4×6 / Letter**; a warning when StockX needs
extra documents or the platform status is unusual.

## Pick list (`pickListPdf` / `pickListCsv` in `src/lib/presellReport.js`)
Letter **portrait**, ASCII only: totals box, then a bar per SKU + size ("3 to ship: 2 set aside,
1 in transit") and a row per order with a **tick box**, ship by (EST), time left, platform,
order #, WHERE, tracking; platform status / shipment note under it when worth saying. CSV has the
same rows plus the label link, supplier and PO.

## Not built yet
- Scan-to-pack (scan the pair → the order it fills → print its label), à la Mark Shipped.
- Regular (non-pre-sell) orders — the same reads would work for every Alias/StockX order.
- Telegram nudge for orders close to their ship-by.
