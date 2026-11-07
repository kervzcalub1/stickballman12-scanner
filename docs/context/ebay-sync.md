# eBay Sync (server side)

Our own replacement for what DPL does on eBay: **stock, price, content (title / description / photos / new sizes), new
listings, ending**. **Orders are NOT part of it: DPL keeps handling eBay orders.** Plan: `docs/ebay-sync-plan.md`.

- **Switches** (`app_settings` key `ebay_sync`): `stock price content create end`, each `off | shadow | live` (default
  `shadow`), `kill`, `blastPct` (10). A write happens ONLY when the switch is `live` and `kill` is off; in shadow the
  intended action is a row in `ebay_sync_log` (mode `shadow`). All writers sit under `io.write` in `api/_lib/ebay-sync.js`
  and are reached only through `shadowOrDo` (`e2e/ebay-sync.spec.js` proves it).
- **Passes** (`ebay-sync-worker.js`, production only, `EBAY_SYNC_WORKER=on|off`): `queue` 30 s (Shopify webhook -> `ebay_sync_queue`
  -> stock / end, live only), `reconcile` 30 min (full live read of both sides -> `ebay_sync_links`, `ebay_sync_products`, drift,
  stock / price / end), `content` 30 min (40 `GetItem` rolling), `create` 30 min (precheck + `VerifyAddFixedPriceItem`, live add
  capped 25 a day; a product must be missing from eBay for 60 min first so DPL's own upload wins).
- **Safety**: the reconcile aborts (alert, nothing touched) if the Shopify read errors / is truncated / shrank >10 %, or the eBay read
  shrank >10 %. Drift counts only after it persisted 10 min (across passes). Blast limit stops a live stock / price / end / content batch
  and alerts (`ebay_sync` event). Trading budget per eBay day (08:00 UTC): sync reads stop at 3,000, writes at 4,500; other tools are
  counted but never blocked.
- **Price**: a size with an `ebay_price_locks` lock or a successful `ebay_price_edits` row is kept (`price_rule` `kept_lock` /
  `kept_repriced`), otherwise `follows_shopify` x profile uplift. The sync never writes `ebay_price_edits`.
- **End**: only a Shopify product that went draft / archived / deleted (re-read live first), through `endEbayItem` + `ebay_listing_ends`.
  SKUs that simply left Shopify stay with the eBay Listings "Not in Shopify" tab (`no_shopify` here, never ended by the sync).
- **Tables**: `ebay_sync_profiles` (seeded `STICKBALLMAN12`), `_products`, `_links`, `_log` (60 d, shadow 14 d), `_queue`.
- **Endpoints** `api/ebay-sync/{status,settings,run,products,listings,inventory,profiles,log}.js`; writes need admin or `connect_integrations`.
- **Quantity (eBay's docs, read 2026-11-08):** `ReviseInventoryStatus` and `ReviseFixedPriceItem` both take the quantity AVAILABLE; eBay adds what sold itself. `GetItem` returns the total including sold, so it is never sent back: a revise only carries new sizes. A 0 on an unsold size may drop it, and with out-of-stock control off (this account) the last size at 0 ends the listing. Still to prove live: the first change of each kind, read back on eBay.

## Review fixes (D1 to D18)
- **State**: pass state + the Trading counter live in `ebay_sync_state` (NOT a live table; counter flushed at most once a minute; an idle queue pass writes nothing). Settings stay in `app_settings` and are merged atomically (`ebaySyncPatchSettings`).
- **Writes need a server that may write**: `EBAY_SYNC_WRITES=on` or `RAILWAY_ENVIRONMENT_NAME=production`; the switches (kill included) are re-read before every write and between chunks of 20.
- **Blast limit** is a sliding hour per domain (live log rows + the batch); `end` and `content` divide by the listing count. A stock push that takes a listing's last size to 0 ends it on eBay (out-of-stock control is off) and is logged and counted as an end.
- **Price rule** (`price_rule`): `kept_lock`, `kept_repriced`, `kept_manual` (eBay differs and the sync was not tracking it), `follows_shopify`.
- **Content** revises send ONLY new sizes (existing ones would gain their sold count), `InvocationID` per revise, GetItem right before; checked when the product's `shopify_key` changed, plus a sweep of 100 a day; stops at 2,000 calls used.
- **Create**: `Item.UUID` (md5 hex, 32) on add and relist; "UUID already used" = success; a fresh eBay read first (SKU or style already there = skip); relist only for a listing the sync saw eBay end (not one ended through the app), keeps prices we don't own, moves locks / reprice history to the new id, counts in the daily 25.
- **Reads**: Shopify reads are paced (1 s between pages, throttle waited out then abort); an empty 200 is an error; the shrink guard stores why and an admin can run `reconcile` with `acceptCounts`.

## Where it lives
One **Sync** tab on the eBay page (`?tab=sync`, sections `?sync=`), `src/screens/EbaySync.jsx`. Owner: no new pages or dashboard cards. Reprice and Not in Shopify stay as they are; Sync links to them.
