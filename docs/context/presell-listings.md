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
`TELEGRAM_PRESELL_CHAT_ID` (same bot). A sale posts: 💰 SOLD on <platform> · shoe · SKU ·
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
