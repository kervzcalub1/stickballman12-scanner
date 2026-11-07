# eBay Sync: our own DPL (plan)

**Goal (owner, 2026-11-08):** build into this system what the DPL app does for eBay, so we can
stop depending on it. The owner approved every decision in advance; the reasoning for each one is
written here so it can be checked later.

**What exists today:** `docs/context/dpl.md` (DPL's settings), `ebay-listings.md` (pull, orphans,
end), `ebay-api-reprice.md` (price writes), `ebay-orders.md` (order read), `shein-live-fix.md`
(the same pattern for SHEIN, including how DPL's orders behave with Intelligent Inventory).

## The rule that shapes everything: one writer per field
DPL is live on 1,159 listings and is the only thing bringing eBay sales into Shopify. Two systems
writing the same field fight silently, and a mistake here oversells live stock or doubles an order.
So every part ships with its own switch, and DPL keeps running until the evidence says otherwise.

| Switch | `off` | `shadow` (default) | `live` |
|---|---|---|---|
| Orders eBay → Shopify | nothing | record what we would write, and whether DPL did | write the order |
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
| eBay order → Shopify order with the order ID as a tag | Same tags, `DECREMENT_IGNORING_POLICY`, no customer emails (`shein-orders.js` is the template). Needs its own Shopify app so the Channel column reads eBay |
| Product draft, archived or deleted → listing ends | `products/update|delete` webhook, then a **live re-read** before ending (the guard in `api/ebay/end.js`) |
| Needs Attention with eBay's error | Per-product status, eBay's error, and **the fix in plain words** (for example "title is 87 characters, eBay's limit is 80") |
| Not Synced orders | Orders tab with the reason, and Retry |
| Screens | New **eBay Sync** page: Overview · Shopify Products · eBay Products · Orders · Linked Inventory · Profiles · Settings + Log |

**Better than DPL, on purpose:** per-listing price rules that respect `ebay_price_locks` and the
reprice tools (the open DPL problem); plain-word errors; a one-click photo fix path; a full audit
log of every write.

## Shape (same as SHEIN live sync)
- `src/lib/ebaySync.js`: pure logic, fully unit-tested. Link, stock decision, price decision, content diff,
  listing builder, order mapper, error translator.
- `api/_lib/ebay.js`: new Trading calls (`Verify/AddFixedPriceItem`, `ReviseFixedPriceItem`, quantity
  on `ReviseInventoryStatus`, `GetUserPreferences`).
- `api/_lib/ebay-sync.js` + `ebay-sync-worker.js`: the server job (standing rule: a closed tab or
  restart never stops it). Queue in the DB, so a deploy replays it.
- `api/shopify/webhook.js`: add routes **beside** SHEIN's, whose path stays exactly as pinned by its tests.
- `api/ebay-sync/*`: page endpoints. `src/screens/EbaySync.jsx`: the page, phone-first.
- Tables: `ebay_sync_links`, `ebay_sync_products`, `ebay_sync_orders`, `ebay_sync_profiles`,
  `ebay_sync_queue`, `ebay_sync_log` (added to `LIVE_TABLES` where a screen reads them).

## Safety rails
1. Worker runs in production only. Dev and prod share one eBay account (`EBAY_SYNC_WORKER=off` in tests).
2. Tests never reach eBay or Shopify: every call goes through a swappable `IO`, as in `shein-orders.js`.
3. Orders: DB claim → look for the order-ID tag in Shopify → create. A lost answer waits and looks before
   retrying, never blind. A watcher flags any eBay order with two Shopify orders.
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
| 2 | Orders in shadow, then live as DPL's backstop | Our computed order equals DPL's on real orders. Backstop writes only what DPL still hasn't after a delay measured from real lag |
| 3 | Stock in shadow, then live | Drift list understood. Same source as DPL, so both send the same number |
| 4 | Price: owner's rule replaces DPL's overwrite | Overwrite measured (`ebay_price_edits` vs live). Needs DPL's `Sync Price Changes` unticked, otherwise the two fight |
| 5 | Content + new listings | `VerifyAddFixedPriceItem` passes on real products. First live listings are a handful, checked on eBay |
| 6 | Hand over from DPL | Per the criteria below |

### Phase 0: facts we need from production (read-only)
1. Scopes the eBay token was approved with, and Trading API call limits (`GetApiAccessRules`).
2. 20 DPL listings by `GetItem`: category, specifics, condition, policy IDs, description template,
   picture handling, how the size specific is named.
3. 30 DPL orders in Shopify against `ebay_orders`: line mapping, tax, shipping, customer, tags, channel
   name, **lag from sale to Shopify order**.
4. Drift today: eBay quantity and price vs Shopify, per SKU. Price overwrite vs `ebay_price_edits`.
5. The Not Synced orders and why.
6. Who sends tracking to eBay today. If it has to come from us, the token needs `sell.fulfillment`
   (write), meaning the seller approves again on eBay.

## Handing over from DPL
Not a date: a measured condition. All must hold for 7 straight days in shadow or backstop:
- every eBay order matched, zero duplicates, zero lines we couldn't map except ones with a stated reason;
- stock and price drift explained to the listing;
- content revise and new listing tested live on a small set.

Order: DPL `Automatic Product Upload` off → price sync off → stock → orders last, because orders are
what feed the sales report. DPL stays installed but idle for 30 days before anyone removes it, so
going back is one setting. **Removing DPL or its profile is never done automatically.**

## Decisions made (owner delegated them)
- Default for every switch is `shadow`. A deploy changes no live behaviour.
- DPL stays on until the conditions above are met.
- A separate Shopify app for orders, so the Channel column stays accurate.
- eBay price after hand-over: reprice tools and locks own it; new listings start at Shopify price + a
  profile uplift. Shopify price changes stop overwriting eBay.
- eBay Trading API, because the listings are Trading-model (`ebay-listings.md`).
