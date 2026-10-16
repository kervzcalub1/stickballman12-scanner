# SHEIN live sync + fix — top of `/ph/shein-check` · `/shein-check`

Built 2026-10-16. Our own Shopify ⇄ SHEIN link, replacing 4seller. Everything goes through
the APIs — no export files, because an export is stale the moment a sale lands on another
channel. Field-level API reference: `docs/shein-api-reference.md` (how to re-pull a page is at
its top). The rules are the export fix's (`docs/context/shein-fix.md`), run per product.

**Shopify is the one stock count every channel sells from.** So:
1. **SHEIN sales → Shopify, at once** (the most important part).
2. **Shopify → SHEIN**: SHEIN shows Shopify's latest number.
3. **Fix every listing**: walk SHEIN one product at a time, fix, read back, next.

## 1. SHEIN sales → Shopify (`api/_lib/shein-orders.js`, table `shein_order_units`)
- **Fast path:** SHEIN's webhook `order-change`. SHEIN's console has ONE callback URL for the
  app — ours is `https://stickballman12.com/api/shein/callback` (approved 2026-10-13; also the
  sign-in return, GET), so `callback.js` hands POSTs to `webhook.js` (`/api/shein/webhook` works
  too). Subscribe the order event ("订单同步通知 / order_push_notice") in the console. An unsigned
  POST (SHEIN's "is this URL alive" check) gets 200 and is ignored; a bad signature gets 401. Signed with the APP
  id + secret over the path, body = form-data `eventData` AES-encrypted with the app secret
  (`sheinOpenWebhook`). It only names the order; we read the order from the API ourselves.
- **Backstop:** every minute (`shein-worker.js`, production only; `SHEIN_SYNC_WATCH=on|off`)
  `order-list` by update time since the last poll (−10 min overlap; SHEIN windows ≤ 48 h,
  **Beijing time UTC+8** both ways — `toSheinTime`/`fromSheinTime`), then `order-detail`.
- **One unit = one pair = one goodsId.** `due` is decided ONCE at first sight: sold after the
  switch-on (`app_settings.shein_sync.since`), or open (status 1/2/7) at switch-on when the
  person ticked "also take off the ones already sold but not shipped".
- Deduct when due, `stockMode = 3` (ships from our warehouse), exchange tag 1/3, not refunded.
  Put back (+1) when SHEIN cancels/refunds (status 6) or swaps it out (tag 2/4) **before it
  shipped**; after shipping it's a return — the warehouse handles it.
- The Shopify write is `inventoryAdjustQuantities` on "available", **compare-and-set**
  (`changeFromQuantity` = what we just read; `CHANGE_FROM_QUANTITY_STALE` → re-read, up to 4×)
  with `@idempotent(key: shein-<goodsId>-<action>-<attempts>-<try>)`: a resend after a lost
  answer reuses the key (Shopify answers it as the original — never twice); a new key only
  after a DEFINITE refusal. Shopify at 0 → still taken off, note says **OVERSOLD**.
- Location: `SHOPIFY_SHEIN_LOCATION` (id), else the only one, else the clear leader; a tie is
  refused, never guessed. The store has ONE location (2026-10-16). Location NAMES need
  `read_locations`, which the app lacks — we use ids only.

## 2. Shopify → SHEIN (`api/shopify/webhook.js`, `pushSkus` in `shein-live.js`)
Admin turns it on → we register Shopify's `INVENTORY_LEVELS_UPDATE` webhook to
`<APP_URL or host>/api/shopify/webhook` (HMAC over the RAW body with `SHOPIFY_SECRET_KEY`;
`server.mjs` keeps `req.rawBody` for that path). The SKU is queued (1.5 s coalesce) and every
SHEIN product carrying it (from the LAST WALK's log, so one walk must have run) gets the
per-product step, **stock only**. Backstop: when push is on, a stock-only walk every 3 h.
No echo loop: our own Shopify deduction changes nothing on SHEIN (see the math below).

## 3. Fix every listing (`api/_lib/shein-live.js`, `src/lib/sheinLive.js`)
Modes: **dry** (decide + log, write nothing) · **stock** · **full** (stock + seller SKUs).
1. Warehouses (`msc/warehouse/list`): stock goes to the US-default merchant warehouse (type 1).
2. Shopify catalogue read once (only to FIND products), every SHEIN SPU (`product/query`).
3. Pass 1, read-only: `spu-info` + `stock-query` for every product → who OWNS a seller SKU
   that several SHEIN sizes carry (the right-size one, else first seen) — store-wide.
4. Pass 2, per product: fresh `spu-info` + stock → the Shopify products it points at read
   **live** (`shopifyProductsLive`; a SKU the catalogue lacks is looked up by itself) →
   `planProduct` (= `checkRows` + `buildFix` + store-wide duplicates) → AI only for dead SKUs
   no rule placed (verified by `verifyAiLink`) → write → read back → `shein_live_items`.

**Stock math.** `sellable = Shopify available − SHEIN sales not yet off Shopify` (sales sync
ON: from `shein_order_units`; OFF: what SHEIN holds, locked + temp-locked). SHEIN's v2 write
(`stock/change-inventory/v2`, `invType VI`, `OVERWRITE`, idempotency key) sets the **TOTAL**
= sellable + what SHEIN already holds for open orders. The old `gsp/goods/change-inventory`
is retired 2026-12-31 — don't use it. A size stopped on SHEIN (`mallState 2`) isn't written.

**Seller SKUs (full mode)** via `goods/product/partialEdit` (spu + skc + sku_code +
supplier_sku). SHEIN reviews every edit, refuses edits while a review is open
(`query-document-state` 1/5 → skipped, next walk), and seller SKUs are unique store-wide
(`check-supplierSku-repeated`). Written only when: a rule proved it (swap / same style + size),
a person confirmed it (Match sizes), or a verified AI match ≥ **0.8** (`AI_WRITE_MIN`; shown
at 0.6). Never onto a SKU another SHEIN product uses, or one a size already sells correctly.
A size losing its SKU to a swap gets `<sku>-off` (parked, 0, saved as `delist`). Every edit
is saved to `shein_links`, so the size stays 0 until SHEIN shows the new SKU, then sells.
A SHEIN size itself can't be changed by API (sale attributes are fixed) — wrong sizes are
relinked or zeroed; **sizes to add** stay a person's job (new SKU via partialEdit, untested).

## Endpoint / page
`GET/POST /api/shein/live` (PH + admin; the two sync switches are admin-only). Panel
`src/screens/SheinLivePanel.jsx`, shown above the export upload when SHEIN is connected.
Live via `useLive` on `shein_live_runs`, `shein_live_items`, `shein_order_units`, `app_settings`.
A run whose process died is marked `interrupted` (no update for 3 min).

## Go-live order
1. In SHEIN's console → Webhook Setting: subscribe the ORDER event (the callback URL
   `/api/shein/callback` is already approved and now takes webhooks).
2. Turn on **SHEIN sales → Shopify** (tick "already sold, not shipped" unless someone took
   those off Shopify by hand).
3. **Dry run** → read "Needs a person" / "Changed".
4. Pause 4seller's SHEIN sync. **Fix stock** (then **Fix stock + seller SKUs**).
5. Turn on **Shopify → SHEIN**.

Tests: `e2e/shein-live.spec.js` (rules, one product end to end with fake SHEIN + Shopify,
the sales → Shopify write incl. a sale elsewhere in between, both webhooks' signatures, the page).
