# Shopify Reprice (PH) — `/ph/shopify-reprice`

Pull every Shopify variant, price it off the Alias market, and set it to **market +
markup in BOTH directions** — cut if above, raise if below (owner's call, 2026-10-07;
eBay Reprice only cuts). Written **straight to Shopify** via the Admin API.

PH team only (admin auto-allowed server-side). Card in the PH home's Pricing & Listing
section; route `shopifyreprice` in `PH_PATHS`.

## ⚠ Needs the `write_products` scope
The token ("Stickballman12 AI" Dev Dashboard app) was granted read scopes only
(`read_products`, `read_inventory`, `read_orders`, …). Until `write_products` is added —
new **Release** in the Dev Dashboard, then **approve on the store** — Apply comes back
`code: 'denied'` with that instruction on screen, and nothing is changed. Pulling and
planning work without it. (`shopify.md` → "Getting a token" for the release flow.)

## Files
| | |
|---|---|
| `src/screens/ShopifyReprice.jsx` | the page: pull, prices, plan table, Apply, Recent changes |
| `src/lib/shopifyReprice.js` | PURE: jobs, `planChanges`, `defaultSelected`, change-log CSV |
| `src/components/MarketPrices.jsx` | the price step SHARED with eBay Reprice (`useMarketPrices` + `MarketPricesStep`) |
| `api/shopify-reprice/variants.js` | GET every variant (`shopifyAllVariants`) |
| `api/shopify-reprice/apply.js` | POST ≤ 100 changes → re-read, write, audit |
| `api/shopify-reprice/history.js` | GET the latest 200 `shopify_price_changes` |
| `api/_lib/shopify.js` | `shopifyAllVariants`, `shopifyVariantPrices`, `shopifyUpdateVariantPrices` |
| `e2e/shopify-reprice.spec.js` | plan rules + the page with EVERY endpoint mocked |

## How it works
1. **Pull** — `productVariants` paged 250 at a time (≈ 3,900 variants, ~16 pages, ~14 s).
   Style = `styleFromTitle(product title)` (the sales feed's parser); the variant `sku` is
   an internal number here and only counts if it looks like a style code. Size = the
   `Size` option. "In-stock sizes only" (default on) filters `inventoryQuantity > 0`.
   Measured 2026-10-07: 1,791 in-stock sizes, 1,675 with a code, 116 without (titles
   like "Nike Zoom Vomero Roam Triple Black (Women's)") — those are left alone; apparel
   (S/M/L/XL) has no number to price.
2. **Prices** — the shared step: batches to `api/ebay-reprice/prices` (strict Alias, see
   `ebay-reprice.md`), cached per EST day in `localStorage` under `reprice:prices:<ymd>`,
   which BOTH pages share. ~1,650 lookups ≈ 12–15 min.
3. **Plan** — per variant: `lower` / `raise` / `same` / `no_data` / `no_style`.
   `next = round_half_up(market × (1 + pct/100))` whole dollars (integer math); a
   multi-code style uses its cheapest code. A change over **50 % either way** is flagged
   "big swing" and starts **unticked** — it's usually a wrong style code.
4. **Apply** — confirm modal (counts, $ cut, $ raised, "changes on any channel that
   takes its price from Shopify"), then chunks of 100. The server:
   - recomputes the new price from `marketCents` + `markupPctH` (the browser never sends
     a price to write);
   - re-reads each variant's CURRENT price and skips any that moved since the pull
     (`conflict`) — never overwrites blind;
   - `productVariantsBulkUpdate` per product; stops after a `denied`/`unauthorized`;
   - logs each confirmed change to **`shopify_price_changes`** (old, new, market, markup,
     who, when) — Shopify keeps no price history of its own.
   Results: updated / conflict / same / missing / failed, plus a change-log CSV download.

## Not built / open
- Products with no code in the title are skipped, not looked up any other way.
- No undo button — `shopify_price_changes` has every old price if one is ever needed.
- Whether a Shopify price change flows on to GOAT / StockX / eBay depends on each
  channel app's own settings, not on this page.
