# eBay Reprice through the API — eBay Listings → **Reprice** tab (`/ph/ebay-listings?tab=reprice`)

Pick eBay sizes (one, a listing, or **Select all in view**), fetch today's market price, and
send **market + markup** (default **12 %**, whole dollars, half-up — `repriceDollars`) to
eBay at once. Example: market $100 at 12 % → **$112**. Built 2026-10-13. The CSV tool
(`/ph/ebay-reprice`, `ebay-reprice.md`) is kept for file-based runs.

PH team + admin. Rows come from the last **Pull listings** (`ebay_listings`), so pull first.

## Files
| | |
|---|---|
| `src/screens/EbayApiReprice.jsx` | the tab: filters, selection, market fetch, confirm, run, log |
| `api/ebay/reprice.js` | POST ≤ 20 sizes → eBay · GET the log |
| `api/_lib/ebay.js` | `reviseEbayPrices` — Trading `ReviseInventoryStatus`, 4 per call |
| `ebay_price_edits` | one row per size sent: before/after, market, markup, who, eBay's answer |
| `e2e/ebay-coupons-reprice.spec.js` | the tab with eBay mocked |

## Rules
- **Market** = the shared Alias lookup (`MarketPrices.jsx` → `api/ebay-reprice/prices`), cached
  per EST day in the browser and shared with eBay Reprice + Shopify Listings. **Suggestion maths
  = Shopify Listings'** (`suggestion()` in `src/lib/shopifyListings.js`): multi-code style →
  cheapest code; style from the listing title.
- **Both directions by default** (the user's ask: "price 100 + 12 % → 112"). **Only lower prices**
  keeps any size the market would raise (the CSV tool's rule).
- **Big swings** (> 50 % from today's price, `BIG_SWING`) are left out unless *Include big
  swings* is ticked — usually a wrong style code. The server refuses them too without `allowBig`.
- Can't be repriced (not selectable): a multi-size listing's size with **no Custom label** (eBay
  addresses a variation only by SKU), auctions, no style code / size.
- **Price only.** `ReviseInventoryStatus` is sent ItemID (+ SKU for a variation) + StartPrice —
  never Quantity, so DPL's stock sync is untouched. A refused batch of 4 is retried one by one
  so every size gets its own answer. Auth/scope refusal → "Connect eBay again".
- Server re-checks every size against the last pull (exists, fixed-price, label) before sending,
  and on success writes the new price into `ebay_listings` so the page shows it without a pull.
- **DPL caveat:** if DPL is ever set to sync PRICE Shopify → eBay, its next sync would overwrite
  these prices. Today DPL is used for quantity/listing; the CSV tool has the same exposure.
