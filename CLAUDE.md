# Stickballman12 · Inventory — Project Context

**Read this file first, then open ONLY the context chunk(s) for the feature you're
touching** (under `docs/context/`). The chunks keep deep detail out of every
session — don't read the whole codebase up front.

## What it is
React (Vite) SPA + Express + PostgreSQL for a shoe-inventory team. Sign in
(admin-approved accounts), scan a barcode (UPC) / enter a SKU / scan a VIN, then
receive, buy in-store, shelve, rescale, list to stores, and mark sold/shipped. **V5 reality:
local/managed Postgres via `pg` (no Google Sheets), runs on Express (`npm start`),
deployed on Railway.** Older notes in `version-4.md`/`DEPLOYMENT.md` may predate this.

## Stack (one line)
React 18 + Vite — UI split into `src/screens/*` (one per page), shared
`src/components/common.jsx`, pure helpers in `src/lib/*` + `src/hooks.js`;
`src/App.jsx` is just the shell/router. Node handlers in `api/**/*.js` served by
`server.mjs` (Express) + Vite dev middleware; Postgres via the `sql` shim in
`api/_lib/db.js`. Details → `docs/context/architecture.md`.

## Commands
```
npm run dev   # localhost:5173 (app + /api)      npm run build  # -> dist/
npm start     # node server.mjs (prod)           npm run db:setup  # migrate (idempotent)
npm run db:reset  # wipe inventory, KEEP accounts (destructive)
npm run db:go-live  # beta→prod reset: inventory + PO side, KEEP accounts/photos/locations
npm run sop:shots # re-capture the SOP screenshots (needs dev on :5189 + local data)
npm run mobile    # test on a real phone: plain LAN URL, no camera — architecture.md
npm run mobile:https   # HTTPS on the LAN IP (camera works; trust the CA on the phone once)
npm run mobile:ca      # serve just the CA cert on :8081 for the phone to install
npm run mobile:tunnel  # public HTTPS URL (camera works; publishes the app while it runs)
```
Admin login: username `admin`, password `ADMIN_PASSWORD` (.env).

## Context map — open what you need
| Area | File |
|---|---|
| Stack, server, routing, App.jsx component map, conventions | `docs/context/architecture.md` |
| DB tables/columns, db.js functions, shim gotchas | `docs/context/data-model.md` |
| Login/signup, roles, sessions, security/throttling | `docs/context/auth-roles.md` |
| Receiving wizard, VINs, batches, intake; **GS received as men's** (`items.original_sku/size`) | `docs/context/receiving.md` |
| Pre-printed 1ID stickers (`SBM-R-…` roll stock, printer-free intake) | `docs/context/vin-stock.md` |
| In-Store buying + In-Store Listing (kind='instore', PH-excluded, manual store listing) | `docs/context/in-store.md` |
| Payout Calculator: store cost stack → Alias/StockX payout, profit, ROI, buy call, **supplier presets**; **best platform per size** (calculator, PH grid, Platform Profit report, **New Inventory chip + `platform_quotes` price cache**); **PO shelf price → landed cost** | `docs/context/payout-calculator.md` |
| **eBay Reprice** (PH): revise-price CSV + inventory report → cut listings above market + markup (default 12 %), never up; strict Alias pricing endpoint, verify-gated download | `docs/context/ebay-reprice.md` |
| **eBay Listings** (PH, READ-ONLY): connect the seller account once (OAuth, refresh token encrypted), pull every live listing + size into `ebay_listings`, next to our stock; DPL still owns eBay. Phase 1 of `docs/listings-hub-plan.md` | `docs/context/ebay-listings.md` |
| **eBay Reprice via API** (eBay Listings → Reprice tab): pick sizes / all → market + markup (default 12 %) straight to eBay (`ReviseInventoryStatus`, price only), both ways or Only lower; `ebay_price_edits` log | `docs/context/ebay-api-reprice.md` |
| **eBay Orders + Sales report** (eBay page; admins at `/ebay`): every order — buyer, shoe/SKU/size/photo, tracking (17TRACK), **late / ship-today flags**; sync every 30 min (prod); **sales report / statement for any period (YTD default) + CSVs**, admin only | `docs/context/ebay-orders.md` |
| **eBay Coupons** (eBay Listings → Coupons tab): coded coupons, $ off each item on picked listings, N uses per buyer (default 1); needs `sell.marketing` (Connect eBay again) | `docs/context/ebay-coupons.md` |
| **SHEIN Reprice** (PH): SHEIN Export Products .xlsx → market + markup (default 15 %, **rounded UP**), never up → SHEIN's own Edit+Price template filled from row 4 (built in, byte-for-byte), verify-gated | `docs/context/shein-reprice.md` |
| **SHEIN ↔ Shopify check** (PH `/ph/shein-check`, admin `/shein-check`): SHEIN export vs live Shopify by seller SKU — wrong size / age group, more stock on SHEIN, SKU gone from Shopify; fix-list CSV; read-only. Groundwork for the SHEIN API sync (replaces 4seller) | `docs/context/shein-check.md` |
| **SHEIN listing fix** (tabs on the SHEIN check; **Match sizes** = search a shoe, pick the same-size Shopify SKU per SHEIN size, saved in `shein_links`; SHEIN API client ready, waiting for `SHEIN_APP_ID/SECRET`): hard-coded rules → SHEIN stock = same-size Shopify stock − unshipped SHEIN orders; wrong/swapped/dead links → 0 + the exact seller-SKU change; sizes to add; fills SHEIN's inventory template (verified); **AI helper (gpt-5.5) only suggests relinks, rules verify** | `docs/context/shein-fix.md` |
| **SHEIN live sync + fix** (top of the SHEIN check page): **SHEIN sale → Shopify −1 within seconds** (webhook + 1-min poll, per goodsId, compare-and-set + idempotent), Shopify stock → SHEIN (Shopify webhook), **walk every SHEIN product one at a time** (live Shopify read → rules → write → read back; dry / stock / full); **a shoe with every size at 0 is delisted (re-listed when stock is back), one whose SKUs are all gone from Shopify is deleted** (`shein_skc_shelf`); `shein_order_units`, `shein_live_runs/items`; API ref `docs/shein-api-reference.md` | `docs/context/shein-live-fix.md` |
| **Shopify Listings** (PH): every Shopify listing as a searchable table — reprice to market + markup (both ways), edit price / compare-at / title / status, save live (**needs `write_products`**); re-read before write, `shopify_listing_edits` audit | `docs/context/shopify-listings.md` |
| The app-wide advisor: floating button, screen context, its nine read-only tools | `docs/context/advisor.md` |
| Shopify: the all-channel sales + inventory feed (`api/_lib/shopify.js`) | `docs/context/shopify.md` |
| Existing Stock: counting old stock in shelf-by-shelf (kind='existing', PH-excluded) | `docs/context/existing-stock.md` |
| Inventory browse, SKU-merge, bulk status, labels, **removing pairs + Deleted archive** | `docs/context/inventory.md` |
| Costs: **per-shoe cost at receiving** (typed → PO line → batch default), the Costs page backfill, Inventory ✎, blank-vs-$0 | `docs/context/costs.md` |
| PH report/grid, SKU-merge, edit locks, sync flags, badges | `docs/context/ph-report.md` |
| Rescale: restock worklist + request/audit (reported vs actual) | `docs/context/rescale.md` |
| Pre-sell: shipments sold before they landed (held out of listing, then released) | `docs/context/pre-sell.md` |
| **Waitlist** (New Inventory ⏸ tab): hold a losing size off listing until a date (1 month default), back by itself + Telegram; **daily Excel report** at 18:00 EST (`src/lib/xlsx.js`) (`waitlist-worker`, prod only) | `docs/context/waitlist.md` |
| **Pre-sell Listings**: scan/SKU → list straight to Alias + StockX (no inventory, no Shopify); own stock (sales deduct, oversell guard), StockX async ops + sales watcher (`PRESELL_WATCH`), Telegram sale posts (**net = payout − cost**); **✎ cost & shipment (supplier, PO, many tracking #s) after listing; date-filtered PDF/CSV reports**; **📦 by box: a size's tracking #s derived from what each PO label holds (supplier's per-box list, else `presell_box_lines` grid / "?" count unknown), Make a PO for this buy**; PO link shows on Inbound; **PO guard**: can't pre-list more than the order lists, sold-but-never-arrived = at risk once it lands (`presell_stock_po`); **⚔ market competition** + 🔒 price lock (undercut $1 / match, $5 floor, follows up, 2-h re-base; puts back outside reprices; posts to PRICE_ALERT_CHAT_ID) | `docs/context/presell-listings.md` |
| **Pre-sell Fulfilment** (Pre-sell Listings → 📦 Fulfill): both platforms make the UPS label AT the sale; read each order back (status, label, tracking, **ship-by**) until it ships, where-is-the-pair, printable **pick list** PDF/CSV | `docs/context/presell-fulfillment.md` |
| No Box queue, Box-found, UPC box labels, Box Labels tool (`/box-labels`) | `docs/context/no-box.md` |
| Shelf locations: put-away/shelve, locate, Locations page, labels, seed | `docs/context/locations.md` |
| Status keys, transitions, sold/shipped cascade | `docs/context/statuses.md` |
| Purchase Orders: supplier scan-out, PO/label schema, `supplier` role, **shoes vs empty-shoe-box orders**; **📋 Paste a list** (`SKU` + `size x qty` lines, many shoes → `po/scan-bulk`); **store orders** (one supplier, many stores: list by store = the invoice, boxes per store, supplier strip-list `po-supplier-view.js`; **every received box tied to its label = its store** (`batch_boxes.po_box_id`, one shared matcher, alphanumeric tracking); **Kevin's audit** per store (`po/audit`, `getPoStoreVariance`, landed, charges/receipts read twice, Mark audited = `audit_po` privilege); plan `docs/store-orders-plan.md`) | `docs/context/purchase-orders.md` |
| Empty shoe boxes end to end: order → declare → receive → shelve → put on a pair | `docs/context/empty-boxes.md` |
| Buying requests (was "gift-card buying"): request → approve → cards → receipt → audit → reconciled; **`users.privileges`**; **Telegram approval cards, direct to the Bot API**; **paste `SKU` / `Sizes 8-12 $50` → review → ONE card per shoe, approved by replying `size x qty`** (`telegram_group_cards`) | `docs/context/buy-cart.md` |
| **Email receipts**: **"Check mailboxes" button** → Make fetches mail since the last check → `POST /api/receipts/ingest-raw` (parsed on OUR server) → `email_receipts`; buyer by registered purchase email (`user_purchase_emails`), store location, Receipts page | `docs/context/receipts.md` |
| **Online Orders**: PH's online buys — tracking, actual cost per pair (coupon/tax/shipping/gift card), per-line cancel + **refund trail**, warehouse "Expected" + count-in (its own list, not a PO) | `docs/context/online-orders.md` |
| **Undelivered Tracking** (`/undelivered`, `/ph/undelivered`): PO labels + online orders not delivered AND not received — tick/untick, newest↔oldest, skip the newest N days, CSV/PDF of the ticked; **every tracking # links to the courier's own site** (`TrackingLink`, bulk "Open on UPS (n)"); **✓ Mark delivered by hand** when 17TRACK lags (name + day recorded, Undo tab) | `docs/context/undelivered.md` |
| **Order Cancellations** (`/cancellations`, `/ph/cancellations`): warehouse sends the bot `/alias` (`/stockx` `/ebay` `/temu` `/tiktok` `/shein` `/sg` `/kc`) + a PHOTO (or types the #) in their private chat → read TWICE by gpt-5.4-mini (disagreement = flag) → one row per order, duplicate guard on the number → PH/admin verify against the photo → cancel on the platform → mark Cancelled; unreadable photo still files a flagged row; **end of shift `/msg` (platform buttons) · `/msgall` · `/report` (CSV)**, by EST day | `docs/context/cancellations.md` |
| Merging duplicates (superadmin): one supplier typed twice, one inbound received as two batches | `docs/context/merge-tools.md` |
| StockX / Alias / KicksDB, Alias auto-relogin, proxies | `docs/context/integrations.md` |
| Railway deploy, env vars, db:setup/reset, schema-drift trap | `docs/context/deploy.md` |
| In-app SOP & Help: article/FAQ data model, search, SVG schematics, screenshot capture | `docs/context/sop.md` |
| Failed scans: what a bad scan SAYS, and the `scan_failures` record behind it | `docs/context/scan-failures.md` |
| **Alerts on Telegram**: 🔔 panel in TopBar, self-service connect (`/start <token>`), per-event prefs, `alert_log`, the one sender `alertUsers` | `docs/context/alerts.md` |
| **Live updates**: DB triggers → `/api/live` stream → `useLive` re-reads; no refresh needed | `docs/context/live-updates.md` |

Current work log / next steps: `june22-progress.md`. Full feature history:
`version-5.md`. Team SOPs: `SOP-WAREHOUSE.md`, `SOP-PH-TEAM.md`.

## Always-on gotchas (don't relearn these each session)
- **Schema drift is the #1 trap:** code using a new column before the DB is
  migrated → `column "…" does not exist`. Run `db:setup` on every env after
  schema changes (`docs/context/deploy.md`).
- `api/_lib/db.js` shim **can't nest `sql` fragments** — branch with if/else.
- Endpoint order: `applySecurity` → `requireAuth/Role/Admin` (admin auto-allowed)
  → `rateLimit` → `getJsonBody` (256 KB cap). 401 → client logs out; 409 → conflict.
- Secrets are server-side only; `.env` is git-ignored — **never commit it**.
- **Gift card codes are the one thing here encrypted at rest** (`BUY_GC_KEY`,
  `api/_lib/secrets.js`). It fails CLOSED: no key → pasting a card is refused, never
  stored in the clear (`docs/context/buy-cart.md`).
- **Roles vs PRIVILEGES.** `users.role` is the one job someone does (warehouse · ph_team ·
  admin · supplier). `users.privileges` is a set of permissions on top — the gift-card
  duties, `audit_po` (store-order audit), plus `request_buying` — the only one a **supplier** can hold, and the switch
  that turns the buying screens on for that account (most suppliers only ship boxes).
  Privileges are read from the DB on every call, NOT from the token, so revoking one
  takes effect at once. Never add a "role" for something one person could hold
  alongside their real job.
- Alias has **auto-relogin on 401; StockX does NOT**.
- VINs (`SBM-YYMMDD-######`) are never reused; numbering gaps are fine.
- **Everything is EST (`America/New_York`) — never the viewer's or the host's clock.**
  SQL filters with `AT TIME ZONE 'America/New_York'`; the UI formats through
  `src/lib/format.js` (`estToday`, `estDate`, `estCivilFromYmd`, `PH_DATE(TIME)`,
  `estTime`) and prints a literal "EST"; the process is pinned in `server.mjs` **and**
  `vite.config.js`. `new Date().toISOString().slice(0,10)`, a bare `toLocale*()`, and
  `new Date('YYYY-MM-DDT00:00:00')` are all bugs here — the PH team works a night shift
  from Manila, so their clock is a day ahead of the EST day the server is filtering by.
  DATE columns come back as `'YYYY-MM-DD'` strings (`docs/context/data-model.md`).
  Guarded by `e2e/est-timezone.spec.js`, which runs the browser in `Asia/Manila`.
- **`PH_EXCLUDED_KINDS` (`instore` + `existing`) must NEVER touch the PH team** —
  guard every PH path (phListItems both branches, pendingCounts badges, rescaleItem,
  phUpdateGroup, getItemsForGiRefresh, recomputeUnlistedPrices), not just the New
  Inventory query. Use `(b.kind IS NULL OR b.kind <> ALL(${PH_EXCLUDED_KINDS}))` —
  the `IS NULL` half matters on the LEFT JOINs. Adding a kind to that list is NOT
  enough on its own: check anything keyed on the *inverse* of the flag too (the
  In-Store Listing badge is keyed on `is_instore`, deliberately)
  (`docs/context/in-store.md`, `docs/context/existing-stock.md`).
  **`items.pre_sell` is a second, parallel exclusion on the same paths** — a *unit*
  state rather than a batch kind, so it must be guarded alongside the kind check,
  not instead of it (`docs/context/pre-sell.md`). **`items.waitlist_until > now()`** is a
  THIRD one on the same paths (`docs/context/waitlist.md`).
- **A failed scan must say what to do, and leave a row.** "No item found" is a dead end
  on a warehouse floor; the sticker's real state is one call away (`stickerState`), and
  every failure writes to `scan_failures` so "it keeps failing" is answerable from data
  rather than from a phone video (`docs/context/scan-failures.md`).
- **Screens update live** (`useLive` in `src/hooks.js`). A NEW table a screen reads must
  be added to `LIVE_TABLES` in `scripts/db-setup.mjs` (+ `db:setup`), or that screen
  only catches up on the 60 s fallback (`docs/context/live-updates.md`).
- After a rebuild, hard-refresh the browser (stale cached bundle).

## Working agreements
- Match the surrounding code's style; put new pages in `src/screens/*`, shared
  UI in `src/components/`, and pure helpers in `src/lib/*` (keep `App.jsx` a thin
  router). Run `npm run build` to verify before declaring done.
- Update the relevant `docs/context/*.md` when a feature's behavior changes, and
  add an `ADD COLUMN IF NOT EXISTS` to `scripts/db-setup.mjs` for new columns.
- Commit/push only when asked.
