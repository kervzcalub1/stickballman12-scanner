# Alias Cross-Listing — one pair on Alias under several SKUs of the same shoe

Screen `src/screens/AliasCross.jsx` at **`/alias-cross`** (staff home, next to Pre-sell
Listings) and **`/ph/alias-cross`** (PH home). Warehouse, PH, admin. Built 2026-11-20.

## Why (owner, 2026-11-20)
A shoe re-released under a new style code is the same design with two (or more) SKUs on
Alias, and each SKU has its own market. List the pairs we have under EVERY one of those
SKUs and take whichever price sells. "We list 5 pairs of that size; whichever SKU makes a
sale, we delist one from the other SKUs, so every SKU now has 4."

**Alias only.** Separate from Pre-sell Listings (`presell-listings.md`): its own tables, its
own page, its own Telegram chat. Nothing here touches inventory, Shopify or StockX.

## The model
- `cross_groups` — one per shoe family, put together BY HAND (never suggested).
- `cross_group_skus` — the Alias catalogue entries in it: `sku`, `catalog_id`, name, picture,
  `sizes` JSONB (`{ "<size label>": <the number Alias wants on a listing> }`).
- `cross_pool` — one row per **group + size**: `qty` (pairs we have, incl. sold), `sold`,
  `unit_cost` (per pair, typed — for the net on the sale).
- `cross_listings` — one row per Alias listing: `external_id` (Alias's id — the handle for
  every later call and for matching a sale), `status` live|off|sold|deleted, `delete_reason`
  sold_other · qty_cut · user.
- `cross_sales` — one row per Alias order, **unique `order_id`**; keeps the cost at the sale.
- **The rule** (`src/lib/crossListing.js`, pure): each SKU of a group may hold at most
  `qty − sold` open listings for a size. `takeDownPlan` = the NEWEST extras per SKU;
  `roomFor` = how many more a SKU may get. 5 pairs × 3 SKUs = 15 listings; one sale → 4 + 4 + 4.

## The page
- **New** — (1) search Alias **by name** (`GET search?q=`, Alias's catalogue search, 40
  results: photo, name, SKU, gender, release date); tick 2–8 entries that are the same shoe;
  picks survive a new search. (2) every size (union of the SKUs' sizes; "not made" where a
  SKU lacks one) with each SKU's market (`POST prices`, **With You** lowest ask + last sold,
  one SKU at a time); per size: **Pairs**, **Cost / pair**, a **price per SKU** (whole
  dollars; tap an ask to use it, *Price blanks at the lowest ask*). A size needs ≥ 2 priced
  SKUs. *Go live now* (default on). Sent in batches of whole sizes (≤ 120 listings a call);
  sizes that went through are cleared so a second press can't add their pairs twice.
- **Listed** — per group, per size: pairs / sold / left / cost and per SKU "N live @ $price"
  ("short by N" when a SKU holds fewer than the pairs left). **Edit**: pairs (not below sold;
  a cut takes extras down), cost, per SKU change price / **List N more** / take down, take
  every listing of the size down. **＋ Add pairs** re-opens New with the group's SKUs.
- **Sales** — sold as which SKU, size, price, payout, cost, net, order, whether Telegram went out.
- **Settings** (admin, or `manage_access`) — the Telegram chat id, Save, Send a test.

## A sale
`presell-worker.js` `checkSales` (prod only, `PRESELL_WATCH=on`, every 60 s) reads Alias's
newest orders; an order whose `listing_id` is a cross listing goes to `handleCrossSale`
(`api/_lib/cross.js`) and never reaches the pre-sell / regular-sale paths:
1. `recordCrossSale` — the sale row is the lock (unique order id) → listing `sold`, pool `sold + 1`.
2. `reconcilePool` — the other SKUs' newest extras are deleted on Alias (`sold_other`). A
   listing Alias no longer has (404) counts as down. A failure stays open with `last_error`
   and is named in the post.
3. Telegram post to the cross-listing chat (`saleLines`): **sold as which SKU** (ship the
   pair whose box matches it — Alias verifies against that SKU), price, payout (Alias's own,
   else price − 9.9 %), cost, NET, pairs left, what came down.

## Telegram chat
`app_settings.cross_listing_chat_id`, set on the page (not an env var — no deploy to change
it). `sendToChat` in `telegram.js`. No chat set → the sale is still recorded and the listings
still come down; `cross_sales.notify_error` says why, and the page shows a banner.

## Known risks (told to the owner)
- **Authentication:** Alias checks the pair against the SKU it sold under. Only group SKUs
  whose physical pair passes as either.
- **The gap:** up to ~60 s between a sale and the take-down. Two SKUs can sell the last pair
  in that window; the second order has to be cancelled by hand. Nothing holds back the last pair.
- A Create that times out is "don't know": the run stops for that SKU and says to check Alias.

## API (`api/cross-listing/*`, roles warehouse + ph_team, admin auto)
`GET search?q=` · `POST prices {catalogId, sizes:[{label,value}]}` · `POST create {groupId? |
name, skus:[{catalogId, sku, name, image, sizes}], activate, lines:[{size, qty, cost?,
skus:[{catalogId, price}]}]}` · `GET list` · `POST action {action: qty|cost|price|list|down,
poolId, …}` · `GET/POST settings {chatId} | {test:true}`. Tables in `LIVE_TABLES`:
`cross_pool`, `cross_listings`, `cross_sales`.

## Tests
`e2e/alias-cross.spec.js` — never reaches Alias or Telegram: the rules; a sale against our
own tables with the Alias calls faked (5 pairs × 3 SKUs → 4/4/4, the order lands once, the
post's text); refusals before any marketplace call; the page with its API mocked.

## Not built
- StockX. Holding back the last pair. Suggesting which SKUs are the same shoe.
- Fulfilment (label / tracking / ship-by) for these orders — pre-sell's Fulfill tab doesn't list them.
- Different size numbering across SKUs (a women's or GS version of the shoe).
