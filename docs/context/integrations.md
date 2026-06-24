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
- `aliasApiGet, aliasProductByUpc(upc), aliasCatalogId(upc), aliasGlobalIndicator({catalogId,size,...})`.
- `aliasGlobalIndicator` GETs the **official host ONLY** (`api.alias.org`, hardcoded
  `ALIAS_API_BASE` — never the bypass proxy or any other host, by request):
  `/api/v1/pricing_insights/availability?catalog_id&size&product_condition&
  packaging_condition` → `availability.global_indicator_price_cents` ÷ 100 ($), or null.
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

## Railway proxies
- StockX: separate keyless Railway host (no auto-relogin).
- Alias: the bypass proxy above.

## Env keys (server-side only; see `deploy.md`)
`ALIAS_EMAIL, ALIAS_PASSWORD, ALIAS_API_KEY` (+ `ADMIN_PASSWORD, SESSION_SECRET,
DATABASE_URL`). `ALIAS_API_KEY` is the GOAT/Alias key for the official API
(Global Indicator pricing + SKU catalog search). `KICKSDB_KEY` is **no longer
used** (SKU search moved to Alias) — safe to remove. Never hardcode; `.env` is
git-ignored.
Railway: use the single-variable field and alphanumeric passwords (special chars
get mangled).
