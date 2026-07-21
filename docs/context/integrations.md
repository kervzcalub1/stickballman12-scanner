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
- ⚠️ Auto-relogin is **Alias-only — never StockX**.
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
  consigned GI while With You has a real price (e.g. `FN6931-100`). `aliasGiWithBasis`
  tries consigned first and falls back to With You when the GI is empty/0, returning
  `{ globalIndicator, basis }` (`'consigned'|'with_you'|null`). Used by all New-Inventory
  GI paths (`enrichGlobalIndicators`, `refreshGiForItems`, `giForSkuSizes`); the basis
  is persisted on `items.gi_basis` and shown as a "WY" chip on the PH grid. **Price
  Inquiry** uses an EXPLICIT basis (its Consigned/With You toggle) — no fallback.
- `aliasGlobalIndicator` is a thin wrapper → `aliasPriceInsights(...).globalIndicator`.
  The lowest/highest/last-sold fields feed the PH **Price Inquiry** page
  (`priceInquiryForSkuSizes`, `ph-report.md`); receiving/GI-refresh use only the GI.
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
- ⚖️ **Licensing:** this is brand-owned imagery from undocumented endpoints. Nike's ToS grants
  a personal/noncommercial licence only; the adidas set is third-party republished. Compositing
  into Brand & Fill carries the same exposure as direct use. Unresolved — a business decision.

## Railway proxies
- StockX: separate keyless Railway host (no auto-relogin).
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
**no longer used** (SKU search moved to Alias) — safe to remove. Never hardcode;
`.env` is git-ignored.
Railway: use the single-variable field and alphanumeric passwords (special chars
get mangled).
