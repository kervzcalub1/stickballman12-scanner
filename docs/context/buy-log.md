# Buy Log — what a supplier bought from a store that gives no receipt

Alex, 2026-11-26 ("Nike Store Orders – Order Tracking and Organization"): Joey orders through a
Nike store that pulls stock from Nike's warehouse, ships it to the store, and **wants paying up
front**. There is no receipt and no order email — the store grabs the shoes for him. Alex wants
"full transparency and accountability for every dollar spent" from the first order: order date +
number, SKU, sizes and quantities, cost per pair and total, payment status, tracking, receiving.

This is **not** a Buying Request (`buy-cart.md`): nobody approves it and no gift cards move. It is
a **declaration** — what he bought and what it cost — plus the payments made against it, compared
with what the warehouse received. Decisions taken with the owner the same day:
- **Joey and staff enter orders** (every line shows who typed it).
- **A payment log**, not a paid flag.
- **Receiving goes through his purchase orders** (he already ships on POs — 26 at the time).
- **A page + Excel / CSV download** is "the spreadsheet"; no Google Sheet sync.

## Who
| | Sees | May |
|---|---|---|
| **Supplier with `log_buys`** (`/buy-log` in the supplier portal) | only their own orders | create / edit their orders and lines, link / unlink their own POs, delete an order with no payment and no PO on it |
| **PH team, admin** (`/ph/buy-log`, `/buy-log`) | every supplier's | all of that for any supplier, enter an order **for** a supplier, **record and remove payments**, delete any order |
| **Warehouse** (`/buy-log`) | every supplier's | read only |

- **`log_buys`** ("Keep a buy log") is the SECOND privilege a supplier can hold (`BUYER_PRIVILEGE_KEYS`
  in `api/_lib/buycart.js`, the `buyer: true` list in `src/lib/constants.js`, the filter in
  `setUserPrivileges`, and the strip in `db-setup`). Ticked on Check Access, read fresh from the
  database on every call (`buyLogUser`, `api/buy-log/_shared.js`). Without it the portal has no
  Buy Log card and every `api/buy-log/*` call answers 403.
- **The supplier never records a payment** — they do not sign for money that was sent to them.
- Another supplier's order answers **404**, not 403 (it does not exist for them).

## Data (`scripts/db-setup.mjs`, all four in `LIVE_TABLES`)
- `buy_logs` — `supplier_user_id`, `supplier_name`, `store`, `order_number`, `ordered_on` (DATE),
  `tracking_numbers TEXT[]`, `note`, created / updated by + at. Shown as **`BL-<id>`**.
- `buy_log_lines` — `sku`, `name`, **`size` (NULL = sizes not known)**, `qty`, `unit_cost`,
  `entered_by` (kept across a save unless the line's SKU / size / pairs / cost changed).
- `buy_log_payments` — one row per payment: `paid_on`, `amount`, `method`, `paid_by`, `note`,
  `created_by`.
- `buy_log_pos` — `(buy_id, po_id)`: the purchase orders the order ships on. Only that supplier's
  own shoe POs can be linked (`listPosForBuyLog`: by `supplier_user_id`, or the name on the PO).

## The maths (`src/lib/buyLog.js`, pure — server, screen and download share it)
- **Money** (`buyMoney`): total = Σ pairs × cost; paid = Σ payments → `unpaid` · `part` · `paid` · `over`.
- **Receiving** (`buyCompare`): per SKU, **ordered** (the lines) vs **shipped** (the linked POs'
  `po_lines.qty_expected`) vs **received** (`items` on batches whose `po_id` is a linked PO).
  - A SKU is compared **by size only when every ordered line of it has a size**; with any blank
    size the sizes are "whatever the store picked" and only the pair count is checked.
  - Shipped / received shoes that are not on the order are shown apart (`extra`, "not on this
    order") and never count toward its status — a PO can carry another order's shoes.
  - State: `no_po` · `not_shipped` · `shipped` · `part` · `received` · `over`. A right total in the
    wrong sizes (when sizes were declared) is `part`, not `received`.
  - "10W" and "10" are one size (`sizeKey`), like a PO line match.

## API (`api/buy-log/`)
- `GET list?q=&from=&to=` → `{ buys, can:{ edit, pay, all }, suppliers? }` (500 newest; 2,000 with a
  filter; dates are the order date, EST). `GET list?id=` → `{ buy, can, pos }` (the POs it can link).
- `POST save` — create / update the order + lines (≤ 400 lines; SKU, whole pairs 1–5,000, a cost).
  Staff creating pass `supplier_user_id` — a supplier with `log_buys`.
- `POST action` — `pay` / `unpay` (PH, admin) · `link` / `unlink` (`po_id`) · `delete`.

## The screen (`src/screens/BuyLog.jsx`, one for all three apps)
List: search (SKU, order #, store, tracking, `BL-n`), order-date range, totals (orders, pairs,
ordered, paid, balance), a Payment chip and a Receiving chip per order, **⬇ Excel / ⬇ CSV** of what
is listed — one row per line (`BUY_COLS`). `?id=` is the open order, `?new=1` the blank form.
Order: the declaration, then Payments, then Shipped and received (link POs, the comparison with
"by size (ordered → received)"). Phone: the tables become cards under 768 px.

## Scan, name autofill, no tracking field (2026-11-26, owner, same day)
- **Scan or type a code** above the lines (`resolve` in `BuyOrder`): a box barcode (UPC) →
  `api.searchUpc` → the SKU, the name **and the size**, **+1 pair per scan** on that SKU + size
  line; a typed SKU → `api.searchSku` → its line with the name, pairs left blank. The camera button
  opens `CameraScanner` (continuous, 2.5 s re-fire gap). Not found says so and adds nothing.
- **A SKU typed straight into the table fills the shoe name when the field is left** (`nameFor`,
  one lookup per SKU per open order, never over a name somebody typed). Both use the app's one
  product lookup (`sku-search` / `upc-search`: Alias → StockX → Nike), already open to suppliers.
- **The tracking-number field is gone** — "not relevant": the tracking numbers are the linked POs'
  labels (`pos[].tracking`, from `po_boxes`), shown on the PO chip and in the download's Tracking #
  column; the search matches them too. `buy_logs.tracking_numbers` stays (unused by the form; a
  save that does not send it leaves it alone).

## Not built (said to the owner)
- Proof photo on a payment.
- Filling the cost of received pairs from the order's lines (Joey had 1,865 pairs with no cost on
  2026-11-26 — the declared cost per SKU is exactly what would fill them).
- Telegram alerts, an order's history of edits.

Tests: `e2e/buy-log.spec.js`. Needs **`db:setup`** (four tables + the supplier privilege strip).
