# eBay Sync: our own DPL (plan)

**Goal (owner, 2026-11-08):** build into this system what the DPL app does for eBay **listings**:
stock, price, content, new listings, ending. The owner approved every decision in advance; the
reasoning for each one is written here so it can be checked later.

**Out of scope (owner, same night): orders.** "I don't have any plans to replace the ebay integration
DPL in handling orders. So do not build anything that relates to the handling of orders." DPL keeps
bringing eBay orders into Shopify, permanently. Nothing here reads, writes, fulfils or cancels an
order, and DPL stays installed.

**What exists today:** `docs/context/dpl.md` (DPL's settings), `ebay-listings.md` (pull, orphans,
end), `ebay-api-reprice.md` (price writes), `ebay-orders.md` (order read), `shein-live-fix.md`
(the same pattern for SHEIN).

## The rule that shapes everything: one writer per field
DPL is live on 1,159 listings. Two systems writing the same field fight silently, and a mistake
here oversells live stock.
So every part ships with its own switch, and DPL keeps running until the evidence says otherwise.

| Switch | `off` | `shadow` (default) | `live` |
|---|---|---|---|
| Stock Shopify → eBay | nothing | record the drift | send the quantity |
| Price Shopify → eBay | nothing | record the drift | send the price |
| Content (title, description, photos, sizes) | nothing | record the drift | revise the listing |
| New listings | nothing | `VerifyAddFixedPriceItem`: eBay's own dry run, no listing, no fee | list it |
| End listings | nothing | record what we would end | end it |

Plus one **kill switch** that stops every eBay write from this feature at once.

## What DPL does → what we build
| DPL | Ours |
|---|---|
| Links by SKU only | `ebay_sync_links`: Shopify variant ↔ eBay item + variation, by exact SKU. Shared and duplicate SKUs are shown, never guessed |
| Profile: category, condition, specifics, policies, package, location | `ebay_sync_profiles`, seeded from `STICKBALLMAN12` and read back from real listings |
| Auto upload for the `Footwear` collection | New-listing step, driven by the `products/create` webhook plus a sweep |
| Syncs price, title, description, variations, images | Per-field drift check, then `ReviseFixedPriceItem` / `ReviseInventoryStatus` |
| Stock from all Shopify locations to eBay | `inventory_levels/update` webhook → queue → `ReviseInventoryStatus` (4 sizes a call) |
| Product draft, archived or deleted → listing ends | `products/update|delete` webhook, then a **live re-read** before ending (the guard in `api/ebay/end.js`) |
| Needs Attention with eBay's error | Per-product status, eBay's error, and **the fix in plain words** (for example "title is 87 characters, eBay's limit is 80") |
| Screens | One **Sync** tab on the existing eBay page (owner: no new pages or dashboard cards), with sub-tabs: Overview · Shopify Products · eBay Products · Linked Inventory · Profiles · Settings + Log |

**Better than DPL, on purpose:** per-listing price rules that respect `ebay_price_locks` and the
reprice tools (the open DPL problem); plain-word errors; a one-click photo fix path; a full audit
log of every write.

## Shape (same as SHEIN live sync)
- `src/lib/ebaySync.js`: pure logic, fully unit-tested. Link, stock decision, price decision, content diff,
  listing builder, error translator.
- `api/_lib/ebay.js`: new Trading calls (`Verify/AddFixedPriceItem`, `ReviseFixedPriceItem`, quantity
  on `ReviseInventoryStatus`, `GetUserPreferences`).
- `api/_lib/ebay-sync.js` + `ebay-sync-worker.js`: the server job (standing rule: a closed tab or
  restart never stops it). Queue in the DB, so a deploy replays it.
- `api/shopify/webhook.js`: add routes **beside** SHEIN's, whose path stays exactly as pinned by its tests.
- `api/ebay-sync/*`: tab endpoints. `src/screens/EbaySync.jsx`: the Sync tab inside `EbayListings.jsx`, phone-first.
- Tables: `ebay_sync_links`, `ebay_sync_products`, `ebay_sync_profiles`,
  `ebay_sync_queue`, `ebay_sync_log` (added to `LIVE_TABLES` where a screen reads them).

## Safety rails
1. Worker runs in production only. Dev and prod share one eBay account (`EBAY_SYNC_WORKER=off` in tests).
2. Tests never reach eBay or Shopify: every call goes through a swappable `IO`, as in `shein-orders.js`.
4. Blast limit: if one pass would change more than a set share of listings, it stops and alerts on
   Telegram. A bad read must never look like "everything is out of stock".
5. "Couldn't read" is never treated as zero. Stock only goes to eBay from a complete, live Shopify read.
6. Ending re-checks live. Locked prices are never written.
7. Every write gets an audit row: who or what, before, after, eBay's answer.

## Phases and how each is proven
| # | What | Proof before moving on |
|---|---|---|
| 0 | Read real data (below) | Facts written into this doc |
| 1 | Schema, switches, links, read-only screens | Tests, deployed, all switches `shadow` |
| 2 | Stock in shadow, then live | Drift list understood. Same source as DPL, so both send the same number |
| 3 | Price: owner's rule replaces DPL's overwrite | Overwrite measured (`ebay_price_edits` vs live). Needs DPL's `Sync Price Changes` unticked, otherwise the two fight |
| 4 | Content + new listings | `VerifyAddFixedPriceItem` passes on real products. First live listings are a handful, checked on eBay |
| 5 | Hand over listings from DPL | Per the criteria below |

### Phase 0: facts we need from production (read-only)
1. Scopes the eBay token was approved with, and Trading API call limits (`GetApiAccessRules`).
2. 20 DPL listings by `GetItem`: category, specifics, condition, policy IDs, description template,
   picture handling, how the size specific is named.
3. Drift today: eBay quantity and price vs Shopify, per SKU. Price overwrite vs `ebay_price_edits`.

## Handing over from DPL
Not a date: a measured condition. All must hold for 7 straight days in shadow or backstop:
- stock and price drift explained to the listing;
- content revise and new listing tested live on a small set.

Order: DPL `Automatic Product Upload` off → price sync off → content → stock. **DPL's order sync stays on, for good.**
**Check first, in DPL's Order & Inventory settings:** whether orders can keep syncing with its inventory sync off (today: `Enable both order & inventory sync`), and that DPL still imports orders for a listing it didn't create (it links by SKU, so it should; prove it on the first small live set). If orders can't run without its inventory sync, stock stays with DPL, because it is already 99.8 % right.
**Removing DPL or its profile is never done automatically.**

## Decisions made (owner delegated them)
- Default for every switch is `shadow`. A deploy changes no live behaviour.
- DPL stays on until the conditions above are met.
- eBay price after hand-over: reprice tools and locks own it; new listings start at Shopify price + a
  profile uplift. Shopify price changes stop overwriting eBay.
- eBay Trading API, because the listings are Trading-model (`ebay-listings.md`).

## Phase 0 results (measured live, 2026-11-08, read-only)
**Listings (20 sampled by `GetItem`), DPL's actual output:**
- Category `15709` (Men's Athletic Shoes), `ConditionID 1000`, `FixedPriceItem`, `GTC`, `DispatchTimeMax 1`,
  Location `Manheim, Pennsylvania`, postal `17545`, Site US, USD. No best offer. Listing-level SKU empty.
- Business policies: shipping `325744987021`, return `325744597021`, payment `325744328021`.
- Package: 16 × 12 × 6 in, 4 lb 0 oz (`ShippingPackage PackageThickEnvelope`). Variant weight in Shopify is also 4 lb.
- Item specifics, fixed: Brand = Shopify vendor (`Adidas` capitalised), Color=Multicolor, Department=Unisex Adults,
  Style=Sneaker, Upper Material=Leather, Type=Sneaker, Style Code = style from the title.
- Variation: specific name `Size`, value = Shopify option value; `SKU` = Shopify SKU; `UPC` = Shopify barcode (equals the SKU).
- Title and description are the Shopify product's, verbatim. Title differs on only 11 of 2,330 rows.
- Pictures: Shopify's media, 7 or 1; no variation pictures.

**Orders, for the record only; we don't build on this (428 DPL orders vs 459 in `ebay_orders`):**
- Shopify order: `name` = eBay order id, `processedAt` = sale time, `sourceName` `eBay`, `sourceIdentifier` = order id, tags
  `<order id>, ebay, ebay integration & importer`, `paymentGatewayNames ["EBAY"]`, PAID, tax as `Sales Tax` line with rate,
  shipping line title = eBay's service, `taxesIncluded false`. Shipped → fulfilled + closed.
- Totals equal eBay's on **185 of 185** matched orders in the last 120 days.
- Lag from sale to Shopify order: normally 2 to 5 min. **September outage: 27 orders over an hour, worst 8 days.** Nothing else above an hour since May.
- Of 25 eBay orders with no Shopify order, **21 were cancelled** and **4 shipped** with no Shopify order
  (`12-15269-07645`, `06-15204-51988`, `12-15184-99765`, `18-15169-44929`). So the real Not Synced gap is 4, not 21-30.
- Tracking flows eBay → Shopify: all 120 compared have the same number, and Shopify's fulfilment comes seconds to minutes after eBay's.

**Stock:** live eBay vs live Shopify: **2,326 of 2,330 equal**. 4 differ, 2 of them offering a pair Shopify has at 0 or less.
DPL's stock sync is good, so ours must match that bar. 1,371 zero-stock Shopify sizes are absent from eBay (DPL removes them), 46 rows
stay at qty 0 (eBay keeps a variation with sales), 1 in-stock size missing.

**Price: DPL's overwrite is confirmed.** Of the latest reprice per size still on eBay (1,597), 787 still hold our price and
**810 changed, every one of them to exactly the Shopify price**, mostly within days. So half of eBay Reprice's work has been undone.
Sizes never repriced: 704 equal Shopify, 29 differ.

**Coverage:** 1,014 active in-stock Shopify products, 23 not on eBay. 992 eBay listings, 2,330 rows. 4 duplicate Shopify SKUs, 32 variants with no SKU, 1 SKU on two listings.

**Limits:** Trading API **5,000 calls a day across all calls for our app**, reset 08:00 UTC. Must be budgeted (see below).

**Shopify main app scopes:** has `read_orders read_all_orders read_products write_products read_inventory write_inventory`.
No `write_orders`, `read_customers` or `read_locations`. eBay token approved 2026-10-13, valid to 2028-04, has `sell.inventory`, `sell.fulfillment.readonly`.

## Build contract
**Trading budget:** counter per eBay day (reset 08:00 UTC) in `app_settings`; the sync stops reads at 3,000 and writes at 4,500, leaving room for the existing tools.
- Reconcile (full listing read + Shopify variants): every 30 min = ~6 calls × 48 = under 300 a day.
- Content check: rolling, up to 40 `GetItem` per pass (under 2,000 a day).
- Verify new listings: up to 10 per pass, only when the product changed or 24 h have passed.

**Passes (`api/_lib/ebay-sync-worker.js`, production only, `EBAY_SYNC_WORKER=on|off` overrides):**
| Pass | Every | Does |
|---|---|---|
| `queue` | 30 s | Coalesced SKUs/products from the Shopify webhook → stock, end (live only; shadow leaves it to reconcile) |
| `reconcile` | 30 min | Full live read both sides → `ebay_sync_links`, drift, blast check, stock/price decisions |
| `content` | 30 min | Rolling content compare |
| `create` | 30 min | Eligible products not on eBay → precheck + `VerifyAddFixedPriceItem` → status/issues; live: `AddFixedPriceItem`, capped per day |

**Decisions in `src/lib/ebaySync.js` (pure):**
- Stock: eBay qty = max(0, Shopify available) when the Shopify read is complete. A size on eBay with no Shopify variant is reported, never zeroed by itself.
- Price: a size with a `ebay_price_locks` lock or a successful `ebay_price_edits` row is **kept**. Otherwise it follows Shopify price × profile uplift.
- New size in stock → `ReviseFixedPriceItem` with every variation + the new one. Never delete a variation; 0 is enough.
- Listing with all sizes at 0 ended by eBay + stock returns → `RelistFixedPriceItem` by the stored item id.
- Blast limit: stop a pass if it would change more than `blastPct` (default 10 %) of links, or if the Shopify read shrank by over 10 %.

**Endpoints (all under `/api/ebay-sync/`, `requireRole ph_team`; writes marked ★ need admin or `connect_integrations`):**
| Route | Shape |
|---|---|
| `GET status` | `{ ok, settings:{switches:{stock,price,content,create,end},kill,blastPct}, counts:{...}, passes:{orders:{at,ok,note},...}, budget:{used,limit,resetAt}, ebay:{connected,user}, facts:{...}, handover:[{key,label,ok,detail}] }` |
| `POST settings` ★ | `{ switches?, kill?, blastPct? }` → `{ ok, settings }`, logged |
| `POST run` ★ | `{ pass }` → `{ ok, started }`, runs a pass now in the background |
| `GET products?tab=uploaded\|not_uploaded\|needs_attention&q=&offset=` | `{ ok, rows:[{shopify_product_id,title,style,status,item_id,view_url,image,sizes,qty,issues:[{code,message,fix}],checked_at}], total, tabs:{uploaded,not_uploaded,needs_attention} }` |
| `POST products` ★ | `{ productId, action:'verify'\|'list'\|'relist' }` |
| `GET listings?filter=all\|qty_drift\|price_kept\|price_drift\|no_shopify&q=&offset=` | `{ ok, rows:[{item_id,title,view_url,sku,size,ebay_qty,shopify_qty,ebay_price,shopify_price,price_rule,state,drift_since}], total, tabs }` |
| `GET inventory?q=&offset=` | SKU → stock, listings sharing it, duplicates |
| `GET profiles` / `POST profiles` ★ | `{ ok, profiles:[{id,name,is_default,config}] }` |
| `GET log?domain=&mode=&offset=` | `{ ok, rows:[{id,at,domain,action,mode,item_id,sku,before,after,ok,error,by}], total }` |

## Existing tools stay (owner, 2026-11-08)
The owner really likes eBay **Reprice** and **Not in Shopify — end**. They keep working exactly as they do, and eBay Sync links to them
instead of copying them. Repriced or locked sizes are never written by the sync. SKUs missing from Shopify are only reported here and ended from that tab.
