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
**Which box** (2026-10-24, `presell-listings.md` → By box): the API adds each row's `boxes`; an
order left **in transit** gets `box` = the box its pair comes in — the not-yet-received boxes in
landing order (`transitBoxes`), most urgent order first. Shown on the order ("📦 1Z…6782 · in
transit · exp 10/27"), in the pick list PDF note and the CSV **Box** column.

## The tab
To ship / Shipped / Cancelled (counts), search (SKU, name, order #, tracking). Totals: to ship,
late, due < 24 h, and the four "where" chips (tap = filter; the pick list follows the filter).
One card per **SKU + size**, most urgent first; per order: platform, order # (copy), ship by +
time left (red late, amber < 24 h), where, UPS tracking link, **🏷 Label** (StockX label-only
PDF, else PNG; Alias PDF), StockX **Instructions 4×6 / Letter**; a warning when StockX needs
extra documents or the platform status is unusual.

## Labels by platform — one PDF, all on screen or only the ticked orders (2026-11-16)
Owner's ask: download the shipping labels from this tab as a PDF, **Alias and StockX apart**, and
choose which orders go in.
- **Platform** switch under the bar: **Both / Alias / StockX** with counts (`?plat=`). It narrows the
  list, the totals and the pick list (file name gets `-alias` / `-stockx`). "Where is the pair" is
  still worked out over both platforms first — they share the set-aside pairs.
- **🏷 Alias labels PDF (n)** and **🏷 StockX labels PDF (n)** (To ship view): ONE PDF per platform,
  one label after the other, in the pick list's order. On Both, both buttons show.
- **Tick boxes** on every order that has a label, plus **Tick all** / **Clear (n)**. Something
  ticked → the PDFs hold only the ticked orders (`(n ticked)`); nothing ticked → every order on
  screen. Ticks are page state, not in the URL.
- `POST /api/presell-listings/labels { platform, ids }` (warehouse, PH, admin; 12 a minute; 300
  orders a call) → `mergeLabels` (`api/_lib/presell-labels.js`): the files are fetched **on our
  server** (other origins the browser can't read), 6 at a time. A PDF's pages are copied as they
  are (the barcode stays UPS's own); a PNG/JPG label gets its own 4 x 6 in page. The links are read
  from OUR rows by sale id, never taken from the request; https only, no IP / localhost.
- **Never an empty or silently short file:** no label fetched → 502 with the reason; some missing →
  the PDF plus `X-Labels-Missing`, and the tab names those order numbers to open one by one.
  StockX orders needing extra documents are counted in the message (print their full instructions).
- No schema change. Checked 2026-11-16 on real links from a prod copy: 4 Alias (288 x 450 pt pages)
  and 4 StockX (label-only PDFs, 812 x 1218 pt = 4 x 6 ratio) merged in 2–3 s. **Not checked: a real
  print on the thermal printer** (StockX pages are large; print "fit to page").

## Pick list (`pickListPdf` / `pickListCsv` in `src/lib/presellReport.js`)
Letter **portrait**, ASCII only: totals box, then a bar per SKU + size ("3 to ship: 2 set aside,
1 in transit") and a row per order with a **tick box**, ship by (EST), time left, platform,
order #, WHERE, tracking; platform status / shipment note under it when worth saying. CSV has the
same rows plus the label link, supplier and PO.

## Not built yet
- Scan-to-pack (scan the pair → the order it fills → print its label), à la Mark Shipped.
- Regular (non-pre-sell) orders — the same reads would work for every Alias/StockX order.
- Telegram nudge for orders close to their ship-by.
