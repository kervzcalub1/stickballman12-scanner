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
- `ALIAS_API_KEY` = the GOAT/Alias key for the **official `api.alias.org`** API
  (Global Indicator pricing + SKU catalog search). Without it, GI stays null and
  SKU search fails — see `integrations.md`.
- `KICKSDB_KEY` is **no longer used** (SKU search moved to Alias) — safe to remove.
- Railway mangles special chars ($, #, quotes) → use the single-variable field,
  keep passwords alphanumeric, verify with `node -e` JSON.stringify.

## ⚠️ #1 trap: schema drift
The code and the DB schema can diverge — deploying code that uses a new column
before migrating the DB throws `column "…" does not exist` at runtime. **Always
run the migration after schema changes, on every environment.**

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

### Reset the DB (wipe inventory, KEEP accounts)
- `npm run db:reset` (script `scripts/db-reset.mjs`) — truncates
  items/events/issues/sales/batches + rescale_requests, rewinds vin/batch seqs.
- On Railway: Data-tab `TRUNCATE … RESTART IDENTITY CASCADE` SQL, or
  `railway ssh` → `npm run db:reset`.

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
