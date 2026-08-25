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
2. **How far back depends on the scope.** Plain `read_orders` serves 60 days and
   silently returns nothing older (measured: 55–60 back works, 70–75 doesn't). With
   **`read_all_orders`** granted the limit lifts — 180 days confirmed. `MAX_WINDOW_DAYS`
   (90) is *our* cost bound on top: this store does ~1,400 orders a week, so 180 days is
   ~36,000 orders and 140+ pages, which no chat turn should wait for.
3. **Channel names need GraphQL.** REST exposes only a numeric `app_id`;
   `channelInformation.channelDefinition.channelName` gives "GOAT", "StockX", "eBay".

## A dead token and a missing scope are different failures (2026-08-26)
They used to share one name — `not permitted` — and that name points at the scopes
screen, where a **revoked** token looks perfectly fine because the scopes *are* right.
`gql` now separates them:

| | What Shopify answers | What we say | Who fixes it |
|---|---|---|---|
| `unauthorized` | **401** `Invalid API key or access token` | "Shopify rejected our access token — it is revoked or wrong" (+ a server-log line naming `SHOPIFY_ACCESS_TOKEN`) | mint a new Admin API token and reset the env var |
| `denied` | **200** with `Access denied for … field` | "needs the read_products / read_inventory scopes" | re-grant scopes on the existing app |

Symptom that started this: *"what is our best selling last week"* → **"I can't see that
figure right now — the sales feed is unavailable to me."** The advisor was right to
refuse (it must never substitute a zero), but the diagnosis underneath sent you to the
wrong screen. A 401 here takes out `top_sellers`, the velocity on the Payout Calculator
and the Shopify half of `stock_status` **all at once** — if all three go quiet together,
check the token before anything else.

## Shape of the calls
- `shopifySales({days})` — pages the window **once**, aggregates by style, caches 30
  min. Both `shopifyTopSellers` and `shopifyVelocity` read that aggregate, so a per-SKU
  question is free after the first fetch. A 7-day window is ~1,400 orders in ~5s.
- `shopifyVelocity(sku, {days})` — units sold, the **per-channel split**, sizes, average
  price, and the liquidity band the calculator's picker uses.
- `shopifyInventoryForSku(sku)` — quantities by size. Needs `read_products` /
  `read_inventory`, which are **separate grants**. Without them it returns a
  `permission` result and the advisor says the figure is unavailable. **Never a zero** —
  "none left" and "we can't see it" are opposite answers.

## Two rules the prompt enforces
- **Sales totals are real totals** (every channel), but give the split when it changes
  what someone would do: *"44 sold, 24 of them on GOAT"* says where to list next.
- **Stock figures always carry the disclaimer.** Shopify's inventory and our sync flags
  are not a physical count; they can be stale in both directions, and the warehouse is
  the only place to get a number worth acting on.

## Getting a token
Legacy custom apps were retired on 2026-01-01, so this is a **Dev Dashboard** app
("Stickballman12 AI"). Those don't hand you a `shpat_…` token in the UI — you get a
Client ID and secret and exchange them:

```
node scripts/shopify-auth.mjs           # writes SHOPIFY_ACCESS_TOKEN into .env
node scripts/shopify-auth.mjs --print   # show it, for Railway
node scripts/probe-shopify.mjs          # verify the whole chain
```

`SHOPIFY_SECRET_KEY` is accepted as well as `SHOPIFY_CLIENT_SECRET` — the dashboard
calls it one thing and people type the other.

**The app must be INSTALLED on the store before the exchange works**; otherwise Shopify
answers `app_not_installed`, which is a clear error but an easy one to misread as bad
credentials. Scope changes need a new **Release** and then manual approval on the store —
they are not applied automatically.
