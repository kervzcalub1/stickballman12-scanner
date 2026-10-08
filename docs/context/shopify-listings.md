# Shopify Listings (PH) — `/ph/shopify-listings`

The Shopify store as a searchable table the PH team works from: reprice to market,
edit price / compare-at / title / status, save live. (Shipped first as "Shopify
Reprice", a 3-step page; `/ph/shopify-reprice` still opens this one.)

PH team only (admin auto-allowed server-side). Card in the PH home's Pricing & Listing
section; route `shopifylistings` in `PH_PATHS`.

## ⚠ Needs the `write_products` scope
The "Stickballman12 AI" Dev Dashboard app's installation has read scopes only. Checked
2026-10-07 after the user approved it: a FRESHLY exchanged token still came back without
`write_products`, so the store's installation hadn't picked the scope up (version not
Released, or the update not approved under Settings → Apps). Until it has, Save comes back
`code: 'denied'` with that instruction and nothing changes. Once it has: re-run
`node scripts/shopify-auth.mjs` (new token into `.env`) and put the new token in Railway —
a token keeps the scopes it was minted with.

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

## The page
- **Loads on open** (`productVariants` paged 250 at a time — ~3,900 variants, ~14 s).
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
