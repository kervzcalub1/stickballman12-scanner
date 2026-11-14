# eBay Sync (server side)

Our own replacement for what DPL does on eBay: **stock, price, content (title / description / photos / new sizes), new
listings, ending**. **Orders are NOT part of it: DPL keeps handling eBay orders.** Plan: `docs/ebay-sync-plan.md`.

- **Switches** (`app_settings` key `ebay_sync`): `stock price content create end`, each `off | shadow | live` (default
  `shadow`), `kill`, `blastPct` (10). A write happens ONLY when the switch is `live` and `kill` is off; in shadow the
  intended action is a row in `ebay_sync_log` (mode `shadow`). All writers sit under `io.write` in `api/_lib/ebay-sync.js`
  and are reached only through `shadowOrDo` (`e2e/ebay-sync.spec.js` proves it). **The one exception: a person's button for one
  listing** (List on eBay, End the extra listing) goes through `manualDo` and may write while the part is in Test mode; kill,
  not-production and Off still stop it (see "eBay-only edits" below).
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
- **Endpoints** `api/ebay-sync/{status,settings,run,products,listings,inventory,profiles,log,edit,duplicates}.js`; writes need admin or `connect_integrations`.
- **Quantity (eBay's docs, read 2026-11-08):** `ReviseInventoryStatus` and `ReviseFixedPriceItem` both take the quantity AVAILABLE; eBay adds what sold itself. `GetItem` returns the total including sold, so it is never sent back: a revise only carries new sizes. A 0 on an unsold size may drop it, and with out-of-stock control off (this account) the last size at 0 ends the listing. Still to prove live: the first change of each kind, read back on eBay.

## Review fixes (D1 to D18)
- **State**: pass state + the Trading counter live in `ebay_sync_state` (NOT a live table; counter flushed at most once a minute; an idle queue pass writes nothing). Settings stay in `app_settings` and are merged atomically (`ebaySyncPatchSettings`).
- **Writes need a server that may write**: `EBAY_SYNC_WRITES=on` or `RAILWAY_ENVIRONMENT_NAME=production`; the switches (kill included) are re-read before every write and between chunks of 20.
- **Blast limit** is a sliding hour per domain (live log rows + the batch); `end` and `content` divide by the listing count. A stock push that takes a listing's last size to 0 ends it on eBay (out-of-stock control is off) and is logged and counted as an end.
- **Price rule** (`price_rule`): `kept_lock`, `kept_repriced`, `kept_manual` (eBay differs and the sync was not tracking it), `follows_shopify`.
- **Content** revises send ONLY new sizes (existing ones would gain their sold count), `InvocationID` per revise, GetItem right before; checked when the product's `shopify_key` changed, plus a sweep of 100 a day; stops at 2,000 calls used.
- **Create**: `Item.UUID` (md5 hex, 32) on add and relist; "UUID already used" = success; a fresh eBay read first (SKU or style already there = skip); relist only for a listing the sync saw eBay end (not one ended through the app), keeps prices we don't own, moves locks / reprice history to the new id, counts in the daily 25.
- **Reads**: Shopify reads are paced (1 s between pages, throttle waited out then abort); an empty 200 is an error; the shrink guard stores why and an admin can run `reconcile` with `acceptCounts`.

## eBay-only edits, List on eBay by hand, End the extra listing (2026-11-15)
For shoes eBay refuses as they are in Shopify (prod 11-14: 11 `title_long` 81-97 chars, 4 `no_photo`, 1 `photo_small`,
1 `no_description`, 1 `duplicate_sku`). **Shopify is never written** by any of this (`e2e/ebay-sync-edits.spec.js` pins it).
- **Table `ebay_sync_overrides`** (`shopify_product_id` PK, `title`, `description_html`, `pictures` jsonb `[url]`, `updated_by/at`;
  live table). NULL / `[]` = use Shopify's. Needs `db:setup`.
- **`buildListing(product, profile, override)`**: the override's title / description / photos replace Shopify's. The **style code
  still comes from the Shopify title** (the override's only if Shopify has none), so a short title that drops it keeps the
  Style Code specific and the "already on eBay" check. `precheck` judges the values actually SENT (`listing.title`,
  `listing.description`, `listing.photos`): a short title clears `title_long`, eBay photos clear `no_photo` / `photo_small`
  (a bare URL has no size, so it is never "small"), an eBay description clears `no_description`.
- **Every caller passes the override**: createPass verify + add, `productAction`, contentPass (so the content pass never "fixes"
  the eBay title back to the long Shopify one). `productKey(updatedAt, skus, overrideKey)` folds the override in (no override =
  the same key as before), and saving one also clears `verify_key` + `content_key`, so both passes look again.
- **UI**: Shopify Products -> Needs Attention / Not Uploaded rows -> **Edit for eBay** (admin or `connect_integrations`, server
  enforced: `POST /api/ebay-sync/edit`). Title (live /80 counter, starts as `shorterTitle()`), description (starts as
  "<title>. Brand new with original box. Style code X."; plain text becomes `<p>` lines; scripts / frames / handlers refused),
  photos (https URLs, up to 12; **Use Image Finder photos** = the style code's `product_photos` `source='ph_edited'` rows that
  `/ph/image-finder` uploaded to R2, shoe angles then the spec / welcome slides; none = the button says "No Image Finder photos
  for X"). Save runs **Check with eBay** (VerifyAddFixedPriceItem, no listing) at once. "Use Shopify's own again" deletes it.
  A row with an edit shows "eBay only: ..." under the title. Log: `ebay_sync_log` content / `ebay_edit_saved` | `ebay_edit_cleared`.
- **List on eBay** (per row, admin / `connect_integrations`) works while New listings is in **Test** mode: a person's one-off never
  needs the global switch flipped. `manualWriteBlock`: the kill switch, a server that may not write (not production) and New
  listings switched **Off** still stop it, re-read right before the write. Same path as before otherwise: precheck, fresh eBay
  look (SKU / style already there = no), lock per product, `Item.UUID`. Logged live with `after.manual = true`; counts in the 25 a day.
- **End the extra listing** (Needs Attention row with `duplicate_sku`): `GET /api/ebay-sync/duplicates` lists every one of OUR
  listings that carries a SKU of this shoe found on two or more listings, each with its sizes; price, start date and **watchers
  come from a read-only GetItem per listing at panel open** (`IncludeWatchCount`; watchers "—" when eBay does not return them,
  start date falls back to the eBay Listings pull). The person picks which to end; **nothing is ended automatically**. Before the
  `EndItem` both listings are read live again: the kept one must be Active and still carry the SKU; a size with stock only on the
  ended one is refused unless the person ticks "I understand". Same gate as List (kill / not production / End switched Off; Test
  mode is fine). Logged to `ebay_listing_ends` (`logEbayEnd`, so a relist never brings it back) and `ebay_sync_log` end /
  `end_duplicate`; dropped from `ebay_listings` + `ebay_sync_links`. The row moves on after the next full check.
- **Risk: DPL syncs Title Shopify -> eBay.** If DPL links one of our new listings by SKU, it may push the long Shopify title; eBay
  refuses it, and **DPL's stock update for that listing may fail with it** (one revise carries both). After the first override
  listings go up, check DPL's error list (`docs/context/dpl.md`) for those item ids; if they show title errors, turn DPL's title
  sync off for them or keep the Shopify title short enough.

## Where it lives
One **Sync** tab on the eBay page (`?tab=sync`, sections `?sync=`), `src/screens/EbaySync.jsx`. Owner: no new pages or dashboard cards. Reprice and Not in Shopify stay as they are; Sync links to them.

## Stock is live for the listings we created (per-item rule)
DPL owns stock for the other listings, so the global **Stock** switch stays Test. But a listing OUR sync created
(DPL is not linked to it) would get no stock updates at all, so **stock writes go live per item for those only**:
`pushStock` splits each batch; items in the created set go through the normal live path (live re-read of Shopify,
same reconcile/queue passes, same blast limit, `ebay_sync_log` domain `stock` mode `live`), everything else stays a
shadow row. No new write path, no schema change.
- **Created by us** = `ebaySyncCreatedItemIds()` in `api/_lib/db.js`: `ebay_sync_products.item_id` where a `ebay_sync_log`
  row exists with `domain='create' AND action IN ('add','relist') AND mode='live' AND ok` and `item_id` = that product's
  Shopify id (the create log keys on the Shopify product id). New creates and relists join automatically. (Log rows
  older than 60 days are pruned; a listing created that long ago would fall back to the global switch.)
- Blocked exactly like any live write: kill switch, Stock = Off, or a server that may not write.
- If DPL later links one of these by SKU it stays in our set: two writers of the same Shopify number, harmless.
- A created listing eBay ends at 0 is never relisted by the stock path; only the create pass relists.
- Shown on the Stock row of the eBay Sync screen: "Live for the N listings we created" (`counts.created_stock_live`).
- Orders stay DPL's; Shopify is never written.
