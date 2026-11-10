# Shopify Listings (PH) — `/ph/shopify-listings`

The Shopify store as a searchable table the PH team works from: reprice to market,
edit price / compare-at / title / status, save live. (Shipped first as "Shopify
Reprice", a 3-step page; `/ph/shopify-reprice` still opens this one.)

PH team only (admin auto-allowed server-side). Card in the PH home's Pricing & Listing
section; route `shopifylistings` in `PH_PATHS`.

## Needs the `write_products` scope — granted 2026-10-08
Without it, Save comes back `code: 'denied'` and nothing changes. Releasing the app version
was not enough: the store only took the scope once the owner opened the app's
`/admin/oauth/install?client_id=…` link and approved (`docs/context/shopify.md` →
*Getting a token*). Tokens carry the scopes they were minted with, and they now renew
themselves on a 401, so no token needs pasting after a scope change — the next refusal
mints one with the new scopes (or restart the server to drop the old one).

## Files
| | |
|---|---|
| `src/screens/ShopifyListings.jsx` | the page: toolbar, product rows, size panel, save bar, recent changes |
| `src/lib/shopifyListings.js` | PURE: grouping, search, `suggestion`, drafts, `savePayloads` |
| `src/components/MarketPrices.jsx` | `useMarketPrices` (shared with eBay Reprice); `run(list)` prices just those jobs |
| `api/shopify-listings/variants.js` | GET every variant + `adminStore` (for admin links) |
| `api/shopify-listings/save.js` | POST ≤ 100 sizes + ≤ 50 products → re-read, write, audit |
| `api/shopify-listings/history.js` | GET the latest 200 `shopify_listing_edits` |
| `api/_lib/shopify.js` | `shopifyAllVariants`, `shopifyListingState`, `shopifyUpdateVariants`, `shopifyUpdateProduct` |
| `e2e/shopify-listings.spec.js` | rules + the page with EVERY endpoint mocked + save guards |

## Kept fresh by the server (owner, 2026-11-10)
"Check the listings all the time, not only when I open the page — a new product or a stock change
should update the record." The page no longer reads Shopify on open; it reads the server's COPY.
- **`shopify_listing_variants`** (one row per variant, the `shopifyAllVariants` shape) — written by
  `api/_lib/listings-watch.js`:
  - **Full re-read every 30 min** (`api/_lib/listings-watch-worker.js`, `LISTINGS_WATCH_MIN`), paced.
    Saves only rows that changed (no write → no live notice), prunes variants Shopify no longer has —
    never on a truncated read, and never when Shopify suddenly returns under half of what we hold
    (a hiccup, not a mass delete → `failed`, copy kept). State: `app_settings.shopify_listings_check`
    (`running` / `done` / `failed` + `lastGood`).
  - **Shopify webhooks** (`api/shopify/webhook.js`, beside SHEIN's and eBay Sync's paths — an error
    here never reaches them): products/create|update → that product re-read live
    (`shopifyProductListingVariants`); inventory_levels/update → its product
    (`shopifyProductForInventoryItem`) re-read; products/delete → its rows dropped. Coalesced 2 s, one
    product at a time, in memory (a restart drops what's pending; the next full re-read catches it).
  - **A save from this page** queues its products for a re-read too (webhooks can be late).
- **`listing_market_prices`** (style code + size → Alias answer): after each full re-read,
  `marketPass` looks up every IN-STOCK ACTIVE size whose answer is missing or older than
  `LISTINGS_MARKET_HOURS` (default 6), oldest first, ≤ 600 per pass, 4 at a time (the same
  `priceStyleSize` the browser used). An `error` is never stored — asked again next pass.
  State: `app_settings.shopify_listings_market`.
- **Production only by default** (dev shares the store and the eBay account): `LISTINGS_WATCH=on|off`.
- `GET /api/shopify-listings/variants` → the copy + `market` + `check` (`source: 'stored'`). Until the
  first full re-read has EVER finished it reads Shopify live as before (`source: 'live'`) and starts one.
  `POST` = **Check now** (a full re-read + market pass in the background; 409 while one runs).
- The page: a line under the search says when the server last checked; the market prices come with the
  list (server answers win over this browser's own cache); it re-reads the copy live
  (`useLive` on the two tables + `app_settings`, ≥ 30 s apart) — **never while there are unsaved edits**.

## The page
- **Opens on the server's copy** (above). Before: `productVariants` paged 250 at a time live on every
  open (~3,900 variants, ~14 s), market prices fetched from the browser.
  Style = `styleFromTitle(product title)` (the sales feed's parser); the variant `sku` is
  an internal number here. One row per product (thumbnail, title, style code or "no style
  code", status, sizes · pairs, price range, ↓/↑ chips once priced, ↗ Shopify admin).
- **Filters:** search (every word in title / style / SKU), status (default Active), In
  stock (default on — also hides out-of-stock sizes inside a product), "Price off market".
- **Market prices on demand** — opening a product prices its sizes; "Get market prices
  for N sizes" prices everything the filters show (~110/min). Cached per EST day in
  `localStorage` (`reprice:prices:<ymd>`, shared with eBay Reprice).
- **Suggested = round_half_up(market × (1 + markup))**, whole dollars, BOTH directions;
  a multi-code style uses its cheapest code. Over 50 % from the current price either way =
  "big swing" (usually a wrong style code): shown, never included by "Use suggested".
- **Edits are drafts** (amber outline; the product row gets an "edited" chip). Editing a
  field back to Shopify's value drops the draft. A sticky save bar counts them (prices with
  $ cut / $ raised, compare-at, titles, statuses) → Review & save → confirm → chunks.
- **Recent changes made here** — collapsible, from `shopify_listing_edits`.

## Save (`api/shopify-listings/save.js`)
- Every field carries the value the person SAW (`oldPrice`, `oldCompareAt`, `oldTitle`,
  `oldStatus`). Shopify's current value is re-read first; a field that moved since the
  page loaded is skipped as `conflict` (the page then shows Shopify's value and keeps the
  draft for review) — never overwritten blind.
- A price with `source: 'market'` must equal market × markup, recomputed server-side, so
  the audit's "market" claim is always true. Manual prices: $1–$100,000.
- `productVariantsBulkUpdate` per product (price, `compareAtPrice` — null clears it);
  `productUpdate(product: {id, title, status})`. Stops after a `denied`/`unauthorized`.
- **`shopify_listing_edits`**: one row per field changed (target, ref id, field, old,
  new, source, market, markup, who, when) — Shopify keeps no history of its own.
  (`shopify_price_changes`, from the first version, never got a row and is not written.)

## Known gaps
- Titles with no parseable code ("Nike Zoom Vomero Roam Triple Black (Women's)") and some
  BAPE codes ("(1K80191303 WHT)") can't be priced — fix the title from the panel.
- No undo — `shopify_listing_edits` holds every old value.
- Whether a Shopify change flows on to GOAT / StockX / eBay is each channel app's setting.
