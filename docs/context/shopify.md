# Shopify — the all-channel sales & inventory feed

Client: `api/_lib/shopify.js`. Env: `SHOPIFY_STORE_DOMAIN`, `SHOPIFY_ACCESS_TOKEN`
(optional `SHOPIFY_API_VERSION`, default `2026-07`). Used by `api/advisor/ask.js`
(`top_sellers`, `sku_history`, `stock_status`) and `api/payout/quote.js` (liquidity).

**Shopify is the aggregator, not one channel among several.** GOAT, StockX, eBay,
TikTok, SGAPP and Kicks Crew all land here as Shopify orders with the channel attached.
That is why this replaced both the monthly CSV export and the per-platform sales pulls:
one feed, every channel, attributed. Measured on a live 7-day window:

| Channel | Orders |
|---|---|
| GOAT | 575 |
| StockX | 553 |
| SGAPP | 242 |
| eBay | 13 |
| Kicks Crew | 10 |
| TikTok | 3 |

The retired `SalesReport` CSV **was this data** — 18,686 rows against Shopify's 18,710
orders, and the same top sellers to the unit (IQ3920-001 65, IO6256-400 47,
IW3808-400 46).

## Three things that shape the code
1. **The style ID is not in the `sku` field.** That holds an internal code
   (`10101157`); the style lives in the line-item **title**, in four shapes:
   `(FB2599-011)`, `(CI1694-001 2024)`, `- IF4396-103`, and a bare `- JS3931`.
   `styleFromTitle` resolves ~92% of units. The rest genuinely have no code in the
   title (`Nike Air Max 2017 Wolf Grey`) and are returned as **`unmatched_units`** —
   reported, never folded into a style.
2. **`read_orders` reaches 60 days.** Measured, not assumed: 55–60 days back returns
   rows, 70–75 does not. Windows are capped at `MAX_WINDOW_DAYS`. Older history needs
   the **`read_all_orders`** scope from Shopify.
3. **Channel names need GraphQL.** REST exposes only a numeric `app_id`;
   `channelInformation.channelDefinition.channelName` gives "GOAT", "StockX", "eBay".

## Shape of the calls
- `shopifySales({days})` — pages the window **once**, aggregates by style, caches 30
  min. Both `shopifyTopSellers` and `shopifyVelocity` read that aggregate, so a per-SKU
  question is free after the first fetch. A 7-day window is ~1,400 orders in ~5s.
- `shopifyVelocity(sku, {days})` — units sold, the **per-channel split**, sizes, average
  price, and the liquidity band the calculator's picker uses.
- `shopifyInventoryForSku(sku)` — needs `read_products` / `read_inventory`, which are
  **separate grants**. Without them it returns a `permission` result, and the advisor is
  instructed to say the figure is unavailable. **Never a zero** — "none left" and "we
  can't see it" are opposite answers.

## Two rules the prompt enforces
- **Sales totals are real totals** (every channel), but give the split when it changes
  what someone would do: *"44 sold, 24 of them on GOAT"* says where to list next.
- **Stock figures always carry the disclaimer.** Shopify's inventory and our sync flags
  are not a physical count; they can be stale in both directions, and the warehouse is
  the only place to get a number worth acting on.

## Gotcha
Changing a custom app's scopes in Shopify requires reinstalling it, which issues a
**new access token** — updating `SHOPIFY_ACCESS_TOKEN` is part of granting inventory
access, not an afterthought.
