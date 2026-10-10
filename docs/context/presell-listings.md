# Pre-sell Listings — list straight to Alias + StockX, with its own stock

Built 2026-10-07. Screen `src/screens/PresellListings.jsx` at **`/presell-listings`** (staff
home → In-Store Mode) and **`/ph/presell-listings`** (PH home). Warehouse, PH, admin.
E2E: `e2e/presell-listings.spec.js` (never reaches a marketplace).

**Not the Pre-sell screen** (`pre-sell.md`, `items.pre_sell`, `api.presellList`…), which
holds back units of a shipment we own. Here a pair is **never an inventory unit** and
**never goes through Shopify** — the point is listing without Nikki entering it.
(Client methods are `api.presellListings*` — `api.presellList` was already taken.)

## The model — its own stock
- `presell_stock` — one row per **SKU + size**: `qty` (pairs we have, incl. sold), `sold`.
- `presell_listings` — one row per marketplace listing: `platform` alias|stockx,
  `external_id` (the platform's listing id — the handle for EVERY later call and for
  matching a sale), our `status` pending|live|off|sold|deleted|failed, the platform's own
  `platform_status`, `pending_op`/`pending_action` while StockX works.
- `presell_sales` — one row per sale, **unique (platform, order_id)**: the watcher sees
  the same order every poll and it lands once.
- **Never oversell** (`reconcileStock`): a platform may hold at most `qty − sold` open
  listings for a size. After every sale (or a pair-count cut) the newest extras come down
  on BOTH platforms. Activating is refused once a size is sold out.
- New pairs: the cart ADDS `qty` to the stock row, then each ticked platform is listed up
  to what's left (`topUp`, `api/_lib/presell-create.js`). A failed listing stays as pairs
  in Stock → retry with **List N** there (re-sending the cart would add the qty twice).

## Screen
- **List new**: scan a box UPC / type a SKU → tap sizes (a box scan adds its size). Per
  line: pairs, ☑ Alias + price, ☑ StockX (Direct) + price, each with that platform's
  market — tap a number to use it. "Go live now" (default on). Confirm → create.
- **Stock**: per SKU+size pairs / sold / left, live+other per platform, **List N**
  (top up a platform), **Pairs…** (set the count; can't go below sold; cuts take down extras).
- **Listings**: Both/Alias/StockX × Open/Live/Not live/Pending/Sold/Deleted, search by
  SKU/name/listing id. **One row per PAIR** (owner's sheet layout, 2026-10-08): a stock
  row's StockX and Alias listings are matched oldest-first (pair 1 = first listing on
  each), so a size with 2 pairs is 2 rows. Platform column = two pills, "StockX (ON)" /
  "Alias (OFF)" (green/red; PENDING blue, SOLD violet, "(—)" = not listed on it), each
  a menu: Go live / Switch off, **Edit** (price; size on Alias only — the pair moves to
  that size's stock row), re-read, copy id, Delete. **More…** = the row: switch both
  on/off, re-read both, delete both. Grouping is client-side (`ListingsTab` `pairs`).
- **Sales**: every sale, price, payout, order #, whether the Telegram post went out.

## In transit — list it before it lands (Alex, 2026-10-10)
For a hyped shoe still on the truck: list it now, and when it arrives, the listings come
down so PH / Nikki list the real pairs properly.
- **List new → ☑ 🚚 In transit** (+ optional PO/tracking note and expected date) →
  `presell_stock.in_transit`, `transit_note`, `expected_on`. Listing the same SKU + size in
  transit again **re-arms** it (`arrived_at` cleared); listing it plainly leaves the flag.
- **Arrival** = the warehouse receives that SKU + size in any batch except Existing Stock
  (owner's call). `insertItems` → `api/_lib/presell-arrival.js` `onItemsReceived`
  (fire-and-forget, after the commit; a slow marketplace never holds up a receive). SKU
  upper-case, size on its digits. `claimPresellArrival` marks the row once (a racing second
  commit does nothing) → every open listing on both platforms is **DELETED** → one Telegram
  post to the pre-sell group: 📦 ARRIVED, what was deleted, **sold in transit N of M →
  warehouse sets N aside, inbound and list only M−N**, and anything that couldn't be deleted.
- **Pairs sold in transit are NOT held in the system** (owner): the sale post (handleSale)
  gets a 🚚 IN TRANSIT line plus "Warehouse: when it arrives, set N pair(s) aside — don't
  inbound; inbound the other M−N". The warehouse physically sets them aside; only the rest is
  received, so Nikki only ever sees those.
- **Only where `PRESELL_WATCH=on`** (`arrivalsEnabled`), the one environment that acts on the
  shared Alias/StockX accounts. Anywhere else a receive never reaches a marketplace.
- Stock tab chips: 🚚 In transit · exp MM/DD (note in the tooltip) / 📦 Arrived <date>.
- Tests: `e2e/presell-in-transit.spec.js` (fake marketplaces + Telegram).

## Paste a message (2026-10-10)
**📋 Paste message** next to Find: Alex's shape (`src/lib/presellPaste.js`) = a style code
line, an optional name line, then `size x pairs` lines (`8x 12`, `8.5 x 14`, `10 × 26`,
`9*19`, `7W x 3`). No name is fine; several shoes in one message too (each style code starts
one). The same size twice adds up. Anything else (`8-9 x 2`, chat text) is listed as *not
understood* and left out, never guessed. Preview → **Add N pairs** fills the cart (name/photo
from our SKU lookup when we have one), ticks Alias + StockX and **🚚 In transit**.
**Batches:** the create endpoint takes ≤ 100 listings a call, so the cart is sent in batches
of WHOLE lines (Alex's 145 pairs = 290 listings → 3 calls) with progress on the button. A
line is never split (re-sending a line adds its pairs again). A failure mid-way names what
already went. One size over 50 pairs is flagged in the preview (the per-line limit).

## Listings tab: one card per SKU + size (owner, 2026-10-10)
26 rows of the same size was overwhelming, and the team is on phones. Now one **card per
stock row (SKU + size)**: photo, SKU · size, name, **N pairs**, and per platform a summary
(`StockX 5 ON · 4 PENDING · 17 —`, where "—" = pairs with no listing on that platform;
`Alias 26 ON`), plus "N with a problem". Shoes by latest activity, sizes smallest first.
**Tap** → the pairs (#1, #2…), each with its StockX + Alias pills and a "⋯" menu (switch
both on/off, re-read, delete) as before. Phone layout: pills share the row and shrink, no
sideways scroll (checked in the test).

## The "listed" post (Alex, 2026-10-10)
After a listing run (one paste can be several create calls), the page calls
`POST /api/presell-listings/announce { stockIds, since }` once. The server builds ONE post to
the pre-sell group from OUR rows (listings created since the run started, not failed/deleted):
**🚚 LISTED — IN-TRANSIT PRE-SELL** or **📝 LISTED — PRE-SELL**, total pairs + who, per shoe:
shipment note/expected, `size × pairs`, and per platform the count and price range ("(N not
live yet)" while StockX confirms). Best effort: a Telegram failure never undoes a listing.
The arrival post reads **📦 INBOUNDED — in-transit pre-sell arrived, listings taken down**.

## Cost for the purchase (2026-10-10)
Cart → **Supplier preset (costs)** (the Payout Calculator presets) → **✎ Edit for this
purchase** (tax, gift card, store, promo, cashback %, tip and shipping $). Edits apply to
THIS purchase only; the saved preset is never written (*edited for this purchase* chip,
*Reset to the preset*). Per line **Shelf $** (+ *Shelf price for all*) → **Cost** = landed
cost (`landedFromShelf`, the same formula as receiving and Costs). Under each platform's
price: **Payout** (default fee: Alias 9.9 %, StockX 10 %) and **profit**. No preset → no
cost (owner's rule: the shelf price alone isn't the cost); payout still shows.
Saved on `presell_stock`: `shelf_price`, `unit_cost` (the SERVER recomputes it from the
stack, not trusting the browser) and `cost_stack` (JSONB snapshot: preset name/id, edited,
the numbers). A re-list without a cost keeps the one already there.

## Cost & shipment after listing · net on the sale post · reports (owner, 2026-10-10)
- **Where it's from** (List new, under the cost; and the editor below): **Supplier** (typed, or
  suggested from preset/PO supplier names; picking a preset fills it when blank), **PO** (picker of
  POs not closed — `list?tab=pos`, with each PO's label tracking numbers), **Tracking numbers**
  pasted many at once (`parseTrackingList` in `src/lib/presellDetails.js`: any separator, words
  dropped, 8–40 chars with ≥ 6 digits, de-duped, ≤ 200). Columns on `presell_stock`: `supplier`,
  `po_id` (→ purchase_orders, ON DELETE SET NULL), `tracking_numbers TEXT[]`. A re-list adds
  tracking numbers (union) and keeps supplier/PO unless new ones are given.
- **Stock → ✎ Cost & shipment** (per SKU; every size ticked to start, each keeps its own shelf
  price): Cost (preset + edit for this purchase + shelf per size → landed cost), Where it's from,
  In transit (note/expected; ticking it on a row that wasn't re-arms arrival). `POST action
  {action:'details', stockIds, cost?:{costStack, shelf:{id:price}}, supplier?, poId?,
  trackingNumbers?, inTransit?, transitNote?, expectedOn?}` — only the sections touched are sent,
  so a cost fix never wipes tracking. The server recomputes `unit_cost`; shelf without a preset →
  shelf kept, cost NULL. Stock table: Cost column, "supplier · PO · N tracking" line, a count of
  sizes with no cost.
- **Sale post NET** (`handleSale`): `Price: $175 → payout $162.75` (the platform's own payout; "(est.)"
  = price less the default fee when it gave none) then `Cost: $X (shelf $Y · preset) → NET $Z`, or
  "Cost: not entered — no net figure". Plus supplier · PO · tracking. One function, `saleNet`, for
  the post, the Sales tab (Cost / Net columns + totals) and the report. Cost is read from the stock
  row at the time, so a cost entered after a sale shows in the Sales tab / report (not the old post).
- **📄 Report** (Stock + Listings tabs → stock report; Sales tab → sales report): from/to dates (EST;
  stock = day first listed, sales = day sold; on Stock and Sales the list is filtered too) →
  **⬇ PDF / ⬇ CSV**, built client-side from one fresh read (`src/lib/presellReport.js`, jsPDF lazy,
  ASCII-only in the PDF). Stock: pairs / sold / left, In transit / Arrived / Pre-sell, supplier, PO,
  tracking (all in CSV), shelf, preset, cost, left-at-cost, listings + price range per platform.
  Sales: date/time, platform, order, price, payout (* est.), cost, net, supplier/PO, kind; totals
  count net only over sales with a cost.
- **Inbound**: `/api/inbound` returns `presell` (rows linked to the listed POs, `presellByPo`); a
  shipment shows "🏷 Pre-listed N · sold M" and, opened, the sizes with "set M aside, inbound the
  rest". The LISTED and INBOUNDED posts carry supplier · PO (· N tracking numbers).
- Tests: `e2e/presell-cost-shipment.spec.js`.

## Market prices — each platform's OWN words (owner, 2026-10-07)
`POST /api/presell-listings/prices { platform, sku, sizes, consigned }`
- **Alias**: Global Indicator · Lowest Listing · Last Sold · Highest Offer, toggle
  **Consigned / With You** (browser-remembered). Alias's `"0"` = none → "—", never $0.
- **StockX** (the **Direct** market, since we list DIRECT): Lowest Ask · Highest Bid ·
  Sell Faster · Earn More (· Beat US when given). **No last-sold** in StockX's API.
- Shown to the warehouse too on this screen (they price these); elsewhere pricing stays PH/admin.

## Platform APIs
**Alias** (`api/_lib/alias.js`, official host, `ALIAS_LISTING_API_KEY` → `ALIAS_API_KEY`;
same account as the owner's Postman). Synchronous.
| | |
|---|---|
| create | `POST /api/v1/listings?catalog_id&price_cents&condition=CONDITION_NEW&packaging_condition=PACKAGING_CONDITION_GOOD_CONDITION&size&size_unit=SIZE_UNIT_US&activate` |
| read · update | `GET /api/v1/listings/{id}` · `POST /api/v1/listings/{id}?price_cents&size&size_unit` (only what changes) |
| on / off · delete | `POST …/{id}/activate` · `/deactivate` · `DELETE …/{id}` → `LISTING_STATUS_DELETED` |
| **sales** | `GET /api/v1/orders?page_size=50` — **newest first**, each order carries `listing_id`, `price_cents`, `price_cents_after_take`, `sold_at` |
- ⚠️ `activate=true` = LIVE. The gateway 415s anything without `content-type: application/json`.

**StockX** (`api/_lib/stockx.js`, official Public API, the app's existing seller
connection — it sees the account's ~25k listings, all `DIRECT`). **Asynchronous**: writes
answer `{ listingId, operationId, operationStatus }`.
| | |
|---|---|
| create | `POST /selling/listings { variantId, amount:"170", currencyCode, active, inventoryType:"DIRECT" }` |
| update price | `PATCH /selling/listings/{id} { amount }` — **size can't change** (it's the variant) |
| on / off · delete | `PUT …/{id}/activate { amount }` · `PUT …/deactivate` · `DELETE …/{id}` |
| operation | `GET /selling/listings/{id}/operations/{operationId}` → PENDING / SUCCEEDED / FAILED |
| **sales** | `GET /selling/orders/active` — each order carries `listingId`, `orderNumber`, `amount` |
- Amounts are whole-dollar **strings**; Alias's are cents. Variant from UPC (one call) or
  exact SKU match + size — an inexact catalogue hit is refused.
- Often SUCCEEDED on the spot → we read the listing back at once (`sxSettle`). Calls can
  stall past 20 s → 30 s timeout, and a timeout is reported as "may still have gone
  through — press ↻", never "nothing changed" (seen 2026-10-07: the change HAD landed).
- "Deactivate" on an inactive listing is refused by StockX ("already inactive").

## StockX rate limit (2026-10-10)
The first big run (145 pairs) got **429 Too Many Requests** from StockX: 69 StockX listings
were never made and 28 were made but left `pending` (the read-back after create was the call
that got the 429, so there was no operation to poll and the worker never looked at them).
Now: **every StockX call goes through one queue** (`sxFetch` in `api/_lib/stockx.js`) at most
one per `STOCKX_MIN_GAP_MS` (default 400 ms), and a 429 waits (Retry-After, else 2/4/8/16/32 s)
and retries before giving up; the wait holds every other StockX call too. The worker stops a
pass at the first 429, and re-reads pending rows that have a listing id but no operation
(one minute after their last touch). Missing listings are topped up from **Stock → List N**.
Better later: StockX's batch listing endpoint (one call for many listings).

## The watcher (`api/_lib/presell-worker.js`, started by `server.mjs`)
**Opt-in: `PRESELL_WATCH=on` on ONE environment** — dev and prod share both marketplace
accounts; two watchers would both act on a sale. Off by default (and in e2e).
- every **12 s**: StockX listings still `pending` → poll the operation; done → read the
  listing back; failed → a create becomes `failed`, any other change keeps its state +
  the reason. Stuck > 10 min → read back anyway.
- every **60 s** (only while anything is open): Alias orders + StockX active orders →
  match `listing_id` to ours → `handleSale` (record once → deduct → take down extras →
  Telegram). Cancelled Alias orders are ignored.

## Telegram — the pre-sell group
`TELEGRAM_PRESELL_CHAT_ID` (same bot). **Two kinds of sale post** (owner, 2026-10-10; they ask
for opposite actions):
- **💰 PRE-SELL SALE — <platform> — SOURCE IT**: a row NOT in transit. We don't own the pair;
  "Alex / supplier: find 1 pair of size N".
- **🚚 IN-TRANSIT SALE — <platform>**: the supplier already bought it. Shipment note +
  expected date, "Warehouse: when it arrives, set N pairs aside, don't inbound them; inbound
  the other M", sold in transit so far. If the row has already ARRIVED (a sale racing the
  take-down): "pull 1 pair from the shelf for this order".

Both carry: 💰 SOLD on <platform> · shoe · SKU ·
size · price (payout) · order · stock left · what was taken down (and ⚠️ anything that
couldn't be). To find a new group's id: add the bot, type **`/chatid`** in the group — the
webhook answers with it (works wherever the webhook points, i.e. prod). Unset → the sale is
still recorded; Sales shows "Not sent" with the reason.

## Regular-sale alerts — a TEST switch (owner, 2026-10-07)
Sales tab → **"Also alert regular Alias + StockX sales (testing)"** (admins flip it;
`POST /api/presell-listings/settings`). Stored as `app_settings.sales_alert_all_since` =
the moment it went on ('' = off). While on, the same 60 s poll posts every NON-pre-sell
order placed after that moment to the pre-sell group as "🛒 SOLD on <platform> — regular
stock (test alert)" (shoe, SKU, size, price, payout when given, order #). Message only —
no stock, no listings touched. Once per order: `marketplace_sales_seen` (platform,
order_id). StockX active orders carry no payout; size = `variant.variantValue`. While on,
the order polls run even with nothing pre-sell listed.

## Verified live 2026-10-07 (all with listings created switched OFF, then deleted)
Alias create/read/update price+size/deactivate/delete; StockX create (DIRECT,
`active:false`), price update, read; a simulated Alias sale → recorded, stock 1/1 sold, the
StockX copy auto-deleted (StockX: `DELETED`), the same order again ignored.
**Not exercised: going LIVE** on either platform, a real order, the Telegram post.
