# Deployment & ops (Railway)

Production runs on **Railway** (Express `server.mjs`, `npm start`), Postgres
add-on. Full guide: `RAILWAY.md`. Hosting overview: `DEPLOYMENT.md`.

## Build/run
- Nixpacks: `npm install` → `npm run build` → `npm start` (`node server.mjs`).
- `server.mjs` serves `dist/` + mounts `api/**/*.js`, sets security headers/CSP,
  and (optionally) an HTTPS listener + redirect via `TLS_KEY/TLS_CERT/TLS_CA`,
  `PORT`/`HTTPS_PORT`.

## Env vars (Railway → service → Variables)
`DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (internal). `SESSION_SECRET` (≥16),
`ADMIN_PASSWORD`, `ALIAS_EMAIL`, `ALIAS_PASSWORD`, **`ALIAS_API_KEY`**.
- **`TRUST_PROXY_HOPS=1`** (required in prod): number of trusted proxies in front
  of the app. `clientIp()` ignores the client-spoofable `X-Forwarded-For` unless
  this is set — Railway fronts the app with **1** proxy, so `1`. If unset in prod
  every request looks like it comes from the proxy IP → all traffic shares one
  rate-limit bucket and per-IP login throttling stops isolating attackers. Leave
  **unset** (0) in local dev. See `api/_lib/util.js`.
- `ALIAS_API_KEY` = the GOAT/Alias key for the **official `api.alias.org`** API
  (Global Indicator pricing + SKU catalog search). Without it, GI stays null and
  SKU search fails — see `integrations.md`.
- `KICKSDB_KEY` is **still required for imagery/spec copy** (Image Finder's GOAT/StockX
  fallback + the spec slide + the eBay listing) — SKU *search* moved to Alias, but the key
  is **not** safe to remove. It's the only **metered** source, so calls are gated (brand
  feeds first) and cached 12 h — see `integrations.md`.
- `KICKSDB_KEY_2` (optional) = **backup KicksDB key**. A key that hits its plan limit is
  deactivated and returns **401 "Key is not active"** (not 429), so the server fails over to
  the backup automatically and cools the spent key down for 30 min. Set it on Railway too —
  with only the primary set, a spent key means no GOAT/StockX imagery at all.
- **Cloudflare R2** (V6 listing/defect photos) — `R2_ACCOUNT_ID`,
  `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` (all four required for
  `r2Configured()` → photo upload/display) + `R2_PUBLIC_BASE_URL` (the read URL,
  needed for photos to display). Optional `R2_ENDPOINT` overrides the default
  `<account>.r2.cloudflarestorage.com`. **Configured in prod** (Railway) and local
  `.env` as of 2026-06-29. Note: the app does **not** read `R2_API_TOKEN` or
  `S3_API` even if present — only the keys above. Details: `integrations.md`,
  `.env.example`, `api/_lib/r2.js`.
- Railway mangles special chars ($, #, quotes) → use the single-variable field,
  keep passwords alphanumeric, verify with `node -e` JSON.stringify.

## ⚠️ #1 trap: schema drift
The code and the DB schema can diverge — deploying code that uses a new column
before migrating the DB throws `column "…" does not exist` at runtime. **Always
run the migration after schema changes, on every environment.**

> **Pending (in-store + PH photos):** `batches_kind_check` now allows `'instore'`;
> `items` gained `instore_listed_alias/_stockx/_shopify/_at/_by`; `product_photos`
> gained `source` (default `'warehouse'`) with the unique index widened to
> `(sku, angle, source)`. **Run `db:setup` on Railway BEFORE deploying** this code, or
> in-store commits fail the CHECK and PH edited-photo uploads collide on the old
> unique. (Applied to local already.)

### Migrate the Railway DB (idempotent, keeps data)
- **Data tab**: paste the `ALTER TABLE … ADD COLUMN IF NOT EXISTS …` block
  (mirror of `scripts/db-setup.mjs`), or
- `railway ssh` into the app container → `npm run db:setup`, or
- locally with the **public** URL:
  `DATABASE_URL='<DATABASE_PUBLIC_URL>' npm run db:setup`.
- Note: internal `postgres.railway.internal` only resolves inside Railway; from
  a laptop use `DATABASE_PUBLIC_URL` (host `*.proxy.rlwy.net`); add
  `?sslmode=require` if SSL errors.
- Consider auto-running `db:setup` on boot in `server.mjs` to prevent drift.
- **Shelf locations:** after `db:setup`, seed Manheim's 253 shelves once with
  `npm run db:seed-manheim` (idempotent). Other sites are added in the Locations
  UI. See `locations.md`.

### Reset the DB (wipe inventory, KEEP accounts)
- `npm run db:reset` (script `scripts/db-reset.mjs`) — truncates
  items/events/issues/sales/batches + rescale_requests, rewinds vin/batch seqs.
- On Railway: Data-tab `TRUNCATE … RESTART IDENTITY CASCADE` SQL, or
  `railway ssh` → `npm run db:reset`.

### Go-live reset (end of beta → production)
- `npm run db:go-live` (script `scripts/db-go-live.mjs`) — the wider reset:
  everything `db:reset` clears **plus** `batch_boxes`, `edit_locks` and the whole
  PO side (`purchase_orders`, `po_boxes`, `po_lines`, `po_resolutions`,
  `po_comments`); rewinds vin/batch/**po** sequences.
- Keeps `users`, `product_photos` (the team's shots + PH edits), `locations`,
  `suppliers`, `products` (cached UPC catalogue), `app_settings`.
- Flags: `--dry-run` (report only), `--yes` (skip the typed `GO LIVE` prompt —
  needed when stdin isn't a TTY), `--catalog` / `--photos` to also drop those.
- Runs in one transaction, and **aborts** if a kept table has an FK into a wiped
  one (a `CASCADE` would silently empty it). Prints the target host first —
  check it says the prod DB before typing `GO LIVE`.
- On Railway: `railway ssh` → `npm run db:go-live`, or locally against
  `DATABASE_PUBLIC_URL`. Snapshot the DB first; there is no undo.

## Notes
- Railway CLI is not installed locally by default: `npm i -g @railway/cli`,
  `railway login`, `railway link`, then `railway ssh`.
- After deploys, hard-refresh the browser (cached bundle shows stale UI).
- Backfill colorway by SKU: `scripts/backfill-upc.mjs`.

## Maintenance scripts (run with `.env` present, or `DATABASE_URL=… node …`)
- `scripts/backfill-gi.mjs [--apply]` — fill Global Indicator (+ Final price =
  GI×1.2) for existing items missing it, resolving catalog_id by UPC or SKU and
  caching catalog rows. Dry-run by default. Needs `ALIAS_API_KEY`.
- `scripts/probe-apis.mjs [SKU] [UPC]` — diagnostic: dumps StockX / Alias-proxy /
  official-Alias fields for a shoe (handy when a lookup misbehaves).
