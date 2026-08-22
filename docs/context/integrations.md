# External integrations

All third-party calls are server-side (`api/*`); browser only hits `/api/*`.

## Product lookup
- **UPC** (`api/upc-search.js`): two stages, all results `source:'alias'`.
  1. **Proxy → SKU + scanned size**: **StockX primary** (keyless proxy
     `/stockx-upc-search`) returns the SKU **and the exact scanned size**;
     **Alias proxy fallback** (`aliasProductByUpc`) returns the **SKU only** (no
     per-UPC size → scanned size left blank) when StockX has no match.
  2. **Official Alias catalog (by SKU)** → canonical title, colorway, gender,
     image, full size run (`aliasCatalogBySku`). Proxy details are only a fallback
     if the catalog misses.
  - The **scanned size drives receiving's auto-fill + auto-increment**, so it must
    come from the UPC lookup (only StockX provides it). A `W`/`Y` suffix on the
    scanned size is carried onto the size run so women's/youth runs line up.
- **SKU** (`api/sku-search.js`): **official Alias catalog** (`aliasCatalogBySku` →
  `GET api.alias.org/api/v1/catalog?query=<sku>`, `ALIAS_API_KEY`) →
  `source:'alias'`, canonical title + colorway + image + full size run + the
  `catalog_id`. **KicksDB is retired** (Alias has more accurate titles). `upc` is
  null (catalog is per-SKU). Allowed for warehouse + ph_team.
- Both return `{ name, sku, upc, image, brand, colorway, sizes[], gender, source }`.

## Alias client (`api/_lib/alias.js`)
- Shared: `aliasLogin, getAliasToken, clearAliasToken, looksLikeAuthFailure,
  aliasAuthed(fn), aliasPost(path,body)`.
- **Auto-relogin on 401**: `aliasAuthed` detects an auth failure, calls
  `aliasLogin()` (env `ALIAS_EMAIL` / `ALIAS_PASSWORD`), and retries once.
- ⚠️ Auto-relogin is **Alias-only — never the StockX *UPC proxy***. (The separate
  **official StockX Public API** client added 2026-08-22 *does* re-mint its token on a
  401 — see the section below. Different client, different rule.)
- Login + UPC search use the Railway bypass proxy
  (`bypass-alias-host-railway-alias.up.railway.app`, `/alias-login` +
  `/alias-upc-search`).

## Alias pricing insights → Global indicator
- `aliasApiGet, aliasProductByUpc(upc), aliasCatalogId(upc), aliasPriceInsights({catalogId,size,...}), aliasGlobalIndicator({catalogId,size,...})`.
- `aliasPriceInsights` GETs the **official host ONLY** (`api.alias.org`, hardcoded
  `ALIAS_API_BASE` — never the bypass proxy or any other host, by request):
  `/api/v1/pricing_insights/availability?catalog_id&size&product_condition&
  packaging_condition&region_id=3&consigned`. The `availability` object carries **four**
  price fields (all `_cents` strings, ÷ 100 → $, `"0"`/absent → null):
  `global_indicator_price_cents`, `lowest_listing_price_cents` (lowest ask),
  `highest_offer_price_cents` (highest bid), `last_sold_listing_price_cents`.
  Returns `{ globalIndicator, lowestListing, highestOffer, lastSold }`.
- **Pricing BASIS — `consigned`** (param on `aliasPriceInsights`, default `true`):
  `true` = **consigned** (matches our daily-ops pricing on sell.alias.org);
  `false` = **"With You"** (seller-side non-consigned). Some SKUs return an empty/0
  consigned GI while With You has a real price (e.g. `FN6931-100`).
- **THE PRICING HIERARCHY** (`api/_lib/pricing.js`, `PRICE_HIERARCHY`) — the single
  canonical order every listing path prices by. A size takes the **first** level
  Alias has a real price for (`"0"`/absent = no price):

  | # | `gi_basis` key | Alias field | basis | chip |
  |---|---|---|---|---|
  | 1 | `consigned` | `globalIndicator` | consigned | *(none)* |
  | 2 | `with_you` | `globalIndicator` | With You | `WY` |
  | 3 | `lowest_consigned` | `lowestListing` | consigned | `LOW` |
  | 4 | `lowest_with_you` | `lowestListing` | With You | `LOW·WY` |
  | 5 | `last_sold_consigned` | `lastSold` | consigned | `LAST` |
  | 6 | `last_sold_with_you` | `lastSold` | With You | `LAST·WY` |
  | 7 | `highest_consigned` | `highestOffer` | consigned | `HIGH` |
  | 8 | `highest_with_you` | `highestOffer` | With You | `HIGH·WY` |

  `aliasPriceWithBasis` walks it and returns `{ value, basis, rank }` (all null when
  no level had a price — PH types one by hand). **Costs at most 2 Alias calls per
  size**, same as the old consigned-first GI fallback: one response carries all four
  price fields, so one call covers every consigned level and a second (fired only
  when the consigned GI is empty) covers every With-You level. The pure walk is
  `resolveFromInsights` in `pricing.js` — test it there, not through the network.
- **The same margin applies at EVERY level** — `Final = value × price_markup_pct`.
  Nothing special-cases a fallback level, so a size priced off `highestOffer` (a
  *bid*) is marked up like a GI. ⚠️ That can land well under cost on odd sizes
  (real example: `DQ8426-109` size 15 → `highest_consigned` $25). The chip is the
  only guard — there is no cost floor.
- Ranks 1–2 keep the `'consigned'`/`'with_you'` keys `items.gi_basis` already held,
  so rows priced before the full hierarchy shipped still read correctly — **no
  backfill needed**. `isPriceBasis` gates what the endpoints will persist.
- Used by all New-Inventory pricing paths (`enrichGlobalIndicators`,
  `refreshGiForItems`, `giForSkuSizes`) and by the public `/api/get-price`, which
  returns the whole ranked list. **Price Inquiry** is the exception: it uses an
  EXPLICIT basis (its Consigned/With You toggle) and does not walk the hierarchy.
- `aliasGlobalIndicator` is a thin wrapper → `aliasPriceInsights(...).globalIndicator`.
  The lowest/highest/last-sold fields also feed the PH **Price Inquiry** page
  (`priceInquiryForSkuSizes`, `ph-report.md`) as read-only reference numbers.
- ⚠️ **Auth is the static GOAT/Alias API key `ALIAS_API_KEY` as a Bearer token** —
  the bypass-login `access_token` is **rejected here (401)**. Verified live: key →
  200 with real pricing; GI is `"0"` for low-demand products (a genuine value).
- **catalog_id** = the Alias product `id` (e.g. `wmns-air-zoom-vomero-5-…-im2404-645`),
  **only Alias returns it** (StockX/KicksDB don't). Resolved two ways, cached in the
  `products` table (`getProductByUpc` / `getCatalogIdBySku`):
  - **by UPC** — `aliasProductByUpc` (bypass UPC-search). Preferred when scanned by UPC.
  - **by SKU** — `aliasCatalogBySku` → official `GET api.alias.org/api/v1/catalog?query=<sku>`
    (`ALIAS_API_KEY` bearer), returns `catalog_items[0].catalog_id`. This is how
    **SKU-scanned units (no UPC) still get a GI** (KicksDB returns no UPC). SKU match
    is fuzzy (dash or space). SKU-only catalog rows are stored with `upc = NULL`.
  - **DUAL-CODE SKUs price off the FIRST code.** Some pairs carry two style codes in
    one field — `315121-115/CW2290-111` (re-issued or double-labelled). The catalog
    knows each code and **never the pair**, so the combined string returned nothing and
    those items silently had no price at all. `aliasCatalogBySku` now searches
    `primarySku()` (`util.js`) — split on `/`, `,`, `|`, **never on whitespace**, since
    a lone SKU is sometimes typed with a space (`DD1391 100`) and splitting there would
    truncate it. Done at this one chokepoint on purpose: every SKU-driven price path
    goes through it (receiving `enrichGlobalIndicators`, `giForSkuSizes`, Price
    Inquiry, `refreshGiForItems`, `/api/get-price`, `sku-search`), plus the image and
    eBay-listing lookups. The `products` cache still keys on the item's FULL sku.
    Note the two codes can resolve to *different* catalog rows (`315121-115` → AF1 High
    '07 'White', `CW2290-111` → 'Triple White'), which is why there is no silent
    fallback to the second code — the first is the one the receiver wrote first.
  - Conditions default to NEW / GOOD_CONDITION. Pricing `size` is numeric — `9W`/`5.5Y`
    are stripped to `9`/`5.5` in `aliasGlobalIndicator`.
- **All callers treat failure as "no GI" (best-effort).** Used at **receiving**
  (`api/batches/commit.js` → `enrichGlobalIndicators`): resolve catalog_id (cache →
  Alias), seed `items.global_indicator` (+ `price` = GI×1.2) per unit. See
  `receiving.md` / `ph-report.md` / `data-model.md`.
- `scripts/probe-apis.mjs` — diagnostic that dumps each API's fields for a SKU/UPC.

## Listing imagery (PH Image Finder) — see `ph-report.md` for the UI flow
Three sources, queried **concurrently** by `api/images/search.js`; all best-effort (any
failure resolves to `null` and the others still answer). SSRF allowlist for every
server-side image fetch is unioned in **`api/_lib/imgsources.js`**.
- **Nike / Jordan** (`api/_lib/nike.js`) — `GET api.nike.com/product_feed/threads/v2`,
  **undocumented, no auth**. Filters: `marketplace(US)`, `language(en)`,
  `channelId(d9a5bc42-4b9c-4976-858a-f159cf99c647)` (**mandatory** — 400 without it), and
  `productInfo.merchProduct.styleColor(<SKU>)`. Response gzips. Images are tagged with a
  `view` LETTER (**A** lateral · **B** outsole · **C** medial · **D** top-down · **E** 3/4 ·
  **F** heel) — the only source that labels angles, which is what makes a reliable
  top-down/outsole possible. Renditions: use the NAMED presets
  (`t_PDP_1920_v1` = 1920²); an arbitrary `t_default/w_3000,c_limit` silently returns
  **400×400**. Dropping the background transform (`/a/images/w_1728/<id>/image.png`) yields a
  **pre-cut RGBA PNG** → no Replicate cutout. `productInfo[0].productContent` also carries the
  official `colorDescription`, `subtitle`, `description` and a `colors[]` array with hex
  (`techSpec`/`bestFor`/`widths` are always empty). One cached feed call per SKU serves both.
  Retired products can return a record with **zero images** — treated as a miss.
- **adidas** (`api/_lib/adidas.js`) — no first-party route exists: `assets.adidas.com` URLs
  embed a per-product hash that isn't derivable from the article code, `adidas.com` HTML/APIs
  are **Akamai-WAF'd** from server IPs, and the CDN isn't search-indexed so the hash can't be
  discovered. ⚠️ `m.adidas.com/.../<CODE>_01_standard.jpg` is a **false positive** — HTTP 200
  for *any* code including bogus ones, returning a ~1.2 KB HTML WAF page with a `.jpg`
  extension; validate magic bytes, never status codes. Instead a **cached index** is crawled
  from `asphalt-nyc.com/products.json` (35 pages), which republishes adidas' studio files with
  adidas' **semantic filenames** (`_02`=top-down, `_03`=outsole). Built **in the background**
  (~40 s cold; a request never waits — the first lookup misses and the next is served),
  refreshed daily. The store **429s `local_rate_limited`** on bursts, so pages are fetched
  sequentially with backoff; a truncated crawl is detected (`complete:false`), never allowed to
  overwrite a larger index, and retried in 30 min instead of caching gaps for a day
  (`adidasIndexStats()` reports health). Max **840×840** — Shopify won't upscale past the
  source (`?width=2048` and `_2048x2048` both return 840); ~1.17× into the template box.
  These renders carry a **baked drop shadow**, so they still need the AI cutout.
- **KicksDB** (`api/_lib/kicksdb.js`, `KICKSDB_KEY`) — GOAT curated gallery → StockX 360° spin
  → hero. Covers everything else. **GOAT has no top-down at all** (the asset isn't shot), so
  outside Nike/adidas that angle stays manual.
  **The only METERED source** (Nike + adidas are keyless), so it's called as little as possible:
  - **⚠️ A spent key answers `401 {"detail":"Key is not active"}`, NOT 429.** Hitting the plan
    limit *deactivates* the key, so exhaustion is indistinguishable from a typo'd key — don't
    read a 401 here as "wrong credentials". **`KICKSDB_KEY_2` is an optional backup**:
    `kicksdbKeys()` returns the list, and `fetchProduct` fails over on 401/402/403/429, marks
    the spent key for a **30-min cooldown** (then re-probes, so topping the plan up recovers
    with no redeploy), and `console.warn`s each failover. A 5xx/timeout is **not** treated as a
    key failure — the backup isn't burned on a transient blip. When every key is spent, an
    all-dead state costs **one probe per catalog**, not one per key. `kicksdbKeyHealth()`
    reports which key is live. Both `scripts/probe-apis.mjs` and `scripts/backfill-upc.mjs`
    walk the same list.
  - **Gated, not speculative.** `images/search` runs Nike/adidas/Alias first and calls KicksDB
    **only when neither brand feed answered**. Both brand sources self-gate on the style-code
    pattern *before* any network call, so the test costs nothing — no Alias brand lookup needed.
    PH can still pull the wider gallery on demand: **"Also search GOAT/StockX"** → `?all=1`
    (the response's `more` flag says whether that button is worth showing).
  - **Spec copy is gated too.** `images/brand` + `listing/ebay` only ask KicksDB when Nike's
    prose names no upper material (`MATERIAL_RE` in `branding.js`) or nothing has a colourway —
    those are the only things GOAT reliably adds.
  - **Cached 12 h per catalog+SKU** inside `fetchProduct` (`cacheGet/cacheSet`), so the GOAT hit
    from Image Finder is reused by the spec slide and the eBay listing. One PH session on a SKU
    used to cost up to 4 calls; it's now 1 (0 on a Nike/adidas SKU). Misses are cached too;
    timeouts/5xx are **not** (a transient failure isn't a fact about the SKU).
- ⚖️ **Licensing:** this is brand-owned imagery from undocumented endpoints. Nike's ToS grants
  a personal/noncommercial licence only; the adidas set is third-party republished. Compositing
  into Brand & Fill carries the same exposure as direct use. Unresolved — a business decision.

## StockX Public API — official (`api/_lib/stockx.js`)
Added 2026-08-22 for the **Payout Calculator**'s lowest-ask / highest-bid column.
Entirely separate from the keyless UPC proxy below, and from KicksDB.

- **Base** `https://api.stockx.com/v2` · token endpoint
  `https://accounts.stockx.com/oauth/token` (audience `gateway.stockx.com`).
- **Two credentials on every call**: `x-api-key: STOCKX_API_KEY` **and**
  `Authorization: Bearer <access token>`. The access token (~12 h) is minted here from
  a long-lived `STOCKX_REFRESH_TOKEN`, cached, and renewed 5 min early; a 401 clears
  it and retries **once**. Getting the refresh token the first time is a
  PerimeterX-guarded **browser** flow a human does once in the portal — the server
  never automates that step. `invalid_grant` on refresh = revoked, redo it.
- **Path**: `/catalog/search` (style ID matched EXACTLY afterwards against
  `products[].styleId`, so `DZ5485` can't silently return `DZ5485-400` — an inexact hit
  is returned flagged, and the screen warns) → `/catalog/products/{id}/variants` (a bare
  ARRAY of `ProductVariant`; size = `variantValue`, falling back to a US row of
  `sizeChart.availableConversions[]`) → `/catalog/products/{id}/variants/{variantId}/market-data?currencyCode=USD`.
  ⚠️ **Never send `country`.** The published spec still lists it as optional; the live
  API returns **400 — "not supported anymore. Market data will be based on your
  market."** Found by `probe-stockx.mjs` on the first real call, and pinned by a test.
- **Shortcut when a UPC is in hand**: `/catalog/products/variants/gtins/{gtin}`
  (`stockxVariantByGtin`) returns productId AND variantId in ONE call — no text search,
  no size matching, so it cannot land on the wrong colourway or size. `payout/quote`
  takes an optional `upc` and prefers this path. The screen doesn't send one yet;
  wiring the scanner to it is the obvious next step.
- **Field names come from the OpenAPI spec** (`developer.stockx.com/swagger.json`,
  "StockX Public API" 2.0.0, read 2026-08-22), not from guesswork:
  `lowestAskAmount`, `highestBidAmount`, `sellFasterAmount`, `earnMoreAmount` —
  with `standardMarketData.{lowestAsk,highestBidAmount,earnMore,sellFaster}` as the
  fallback. **Every amount is a decimal STRING** (`"100"`), so parse, but never
  cents-correct: these are whole currency units and a $150,000 grail must survive.
  `flexMarketData` / `directMarketData` are deliberately ignored — different
  fulfilment programmes, prices we can't actually sell at.
- ⚠️ **There is NO last-sale field in the Public API.** stockx.com shows one and the
  Android gateway returns one; the sanctioned API does not (the string `lastSale`
  appears nowhere in the spec). The calculator shows ask, bid, "earn more" and "sell
  faster" for StockX. Don't add a Last-sale column expecting it to fill in.
- **Quota is 25,000 requests / 24 h, account-wide**, so everything caches: catalogue
  12 h, market data 10 min, and a multi-size quote runs **sequentially** to reuse the
  cached product/variant list instead of re-fetching it per size.
- **Optional by design.** `stockxConfigured()` requires all four env vars; without
  them the quote endpoint still answers with Alias prices and the calculator keeps its
  StockX column manual. StockX being down must never cost the buyer their Alias number.
- **`node scripts/probe-stockx.mjs <SKU> <size>`** walks token → search → variants →
  market data and names the link that broke; `--raw` prints the untouched JSON if the
  responses ever drift from the spec.
- 🚫 **What this is not.** Scraper projects reach StockX market data through
  `gateway.stockx.com/api/graphql` using an `x-api-key` extracted from the decompiled
  Android APK, queries decompiled from `BrowseQuery.java`, and a spoofed `okhttp4_android_13`
  TLS fingerprint to defeat bot detection. We deliberately do **not** do that: it's
  circumvention, it dies whenever StockX rotates the key, and it fails by showing
  silently wrong prices on a buy call. If `tlsclientwrapper` or a hardcoded StockX key
  ever appears in this repo, delete it.

## Railway proxies
- StockX **UPC search**: separate keyless Railway host (no auto-relogin). Unrelated to
  the official Public API client above.
- Alias: the bypass proxy above.

## Object storage — Cloudflare R2 (V6 photos)
- **S3-compatible** storage for listing photos (per SKU) + defect photos (per VIN).
  Helper: `api/_lib/r2.js` — dependency-free **SigV4 presigning**, so the phone
  PUTs image bytes **straight to R2** (the Node server never handles the bytes).
- Endpoints: `POST /api/photos/sign` (+ `sign-issue`) returns a presigned PUT URL;
  `POST /api/photos/attach` records the resulting public URL. Reads via `publicUrl()`.
- **Required env** (all four → `r2Configured()` true): `R2_ACCOUNT_ID`,
  `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`. Plus `R2_PUBLIC_BASE_URL`
  (R2.dev or custom domain) for the images to **display**. Optional `R2_ENDPOINT`
  overrides the default `<account>.r2.cloudflarestorage.com`.
- The app does **not** read `R2_API_TOKEN` or `S3_API` (harmless if set in Railway).
- Unconfigured → photo UI hidden + endpoints return a clear "not configured" 503
  (rest of the app unaffected). Bucket needs a **CORS policy allowing PUT** from the
  app origin. **Live in prod + local `.env` as of 2026-06-29.** See `.env.example`,
  `receiving.md`, `data-model.md`.

## Env keys (server-side only; see `deploy.md`)
`ALIAS_EMAIL, ALIAS_PASSWORD, ALIAS_API_KEY` (+ `ADMIN_PASSWORD, SESSION_SECRET,
DATABASE_URL`) and the **R2** keys above. `ALIAS_API_KEY` is the GOAT/Alias key for
the official API (Global Indicator pricing + SKU catalog search). `KICKSDB_KEY` is
**still in use for imagery + spec copy** (SKU *search* moved to Alias, the key did not
go away) — see the metered-source notes above. Never hardcode;
`.env` is git-ignored.
Railway: use the single-variable field and alphanumeric passwords (special chars
get mangled).
