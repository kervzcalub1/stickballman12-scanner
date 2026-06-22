# Deploying to Railway — Step-by-Step

A focused guide to get **Stickballman12 Shoe Scanner** live on
[Railway](https://railway.app) with a managed PostgreSQL database, automatic
HTTPS, and git-push deploys. ~15 minutes the first time.

> **Why Railway fits this app:** it runs a **persistent Node process** (so the
> Postgres connection pool, the in-memory lookup cache, and the burst
> rate-limiter all work as designed), gives you **managed Postgres**, **automatic
> HTTPS**, and **deploys on every `git push`** — the Vercel-like workflow without
> the serverless/cold-start downsides. See `DEPLOYMENT.md` for the full host
> comparison.

---

## 0. Prerequisites

- The repo on **GitHub** (already pushed to `origin/main`).
- A **Railway account** — sign in with GitHub at <https://railway.app>.
- The credentials this app needs (kept server-side, set in Railway — never in git):
  `ALIAS_EMAIL`, `ALIAS_PASSWORD`, `KICKSDB_KEY`, `ADMIN_PASSWORD`,
  `SESSION_SECRET`. (`DATABASE_URL` comes from Railway's Postgres.)

Generate a strong session secret locally:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## 1. Create the project from GitHub

1. Railway → **New Project** → **Deploy from GitHub repo**.
2. Authorize Railway to read the repo, then pick **`stickballman12-scanner`**.
3. Railway creates a **service** and starts the first build. It auto-detects
   Node (Nixpacks) and will run `npm install` → `npm run build` → `npm start`
   (it picks up the `build` script automatically — no config file needed).
   - `npm start` runs `server.mjs`, which serves the built SPA from `dist/` and
     mounts every `api/**/*.js` route.

> The first build may "succeed" but the app will crash-loop until the database
> and env vars exist — that's expected; finish the next steps.

---

## 2. Add the PostgreSQL database

1. In the project canvas → **New** → **Database** → **Add PostgreSQL**.
2. Railway provisions it and exposes connection variables on the Postgres
   service (e.g. `DATABASE_URL`).

---

## 3. Set environment variables on the app service

Open the **app service** (not the database) → **Variables** tab → add:

| Variable | Value |
|---|---|
| `DATABASE_URL` | Reference the DB: type `${{Postgres.DATABASE_URL}}` (Railway substitutes the internal URL). Use it **as-is** — Railway's private network does **not** need `?sslmode=require`. |
| `SESSION_SECRET` | the long random string from step 0 (≥16 chars) |
| `ADMIN_PASSWORD` | a strong password for the `admin` account (username `admin`, name "Alex") |
| `ALIAS_EMAIL` | Alias account email (UPC search fallback) |
| `ALIAS_PASSWORD` | Alias account password |
| `KICKSDB_KEY` | KicksDB API key (SKU search) |

Notes:
- **Do not set** `PORT` — Railway injects it and `server.mjs` reads it.
- **Do not set** `TLS_CERT`/`TLS_KEY` — Railway terminates HTTPS at its edge; the
  app runs plain HTTP behind it (HSTS is still sent, so HTTPS is enforced).
- Saving variables triggers a redeploy.

---

## 4. Create the database tables (once)

The schema migration must run once against the new database.

**Option A — Railway shell (simplest):** app service → the **⋮ / Command**
menu → run:

```bash
npm run db:setup
```

**Option B — Railway CLI from your machine:**

```bash
npm i -g @railway/cli
railway login
railway link        # pick the project
railway run npm run db:setup
```

`db:setup` is **idempotent** — safe to re-run after future schema changes
(e.g. pulling code that adds a column).

---

## 5. Expose a public URL

1. App service → **Settings** → **Networking** → **Generate Domain**.
2. Railway gives you `https://<app>.up.railway.app` with TLS already set up.
3. Open it — you should see the sign-in screen.

---

## 6. First sign-in & smoke test

1. Sign in as **`admin`** with your `ADMIN_PASSWORD`.
2. Create a warehouse account (Create account → role **Warehouse**), then
   approve it from **Check Access**.
3. **Receive New** → scan/enter a UPC or SKU, add a size, finish the batch.
4. Confirm it appears in **Inventory** and the **Report**.
5. **Mark Sold** → scan that unit's VIN → Save → confirm it delists (II/Alias/
   StockX/Shopify cleared) and the history shows the actor + the
   "(system-generated)" cascade line.
6. Refresh on `/inventory` — it should stay on the page (path routing works).

---

## 7. Ongoing: deploys, schema changes, domain

- **Deploys:** every `git push` to `main` auto-builds and redeploys. Watch the
  **Deployments** tab; use **Rollback** on a bad deploy.
- **Schema changes:** after pushing code that adds tables/columns, run
  `npm run db:setup` again (step 4).
- **Custom domain:** app service → **Settings → Networking → Custom Domain**,
  then add the CNAME record Railway shows at your DNS provider (TLS issues
  automatically).
- **Logs:** the service **Deployments → View Logs** (or `railway logs`).

---

## 8. Important notes & gotchas

- **Run a single instance.** The burst rate-limiter and lookup cache are
  in-memory (per process); the login brute-force throttle and the PH edit-locks
  are DB-backed and safe across restarts. Don't scale the service to multiple
  replicas without first moving the in-memory limiter to the DB.
- **Keep the DB and app in the same Railway region** for low query latency.
- **Secrets live only in Railway Variables** — `.env` is git-ignored and never
  deployed; set everything in the dashboard.
- **TLS:** Railway's internal `DATABASE_URL` connects without `sslmode=require`
  (private network) — use it as provided. The app only forces TLS when the URL
  contains `sslmode=require` or is a Neon host, so that flag is for *external*
  managed Postgres (Neon/Supabase), not Railway.
- **Connecting from your laptop** (DB GUI, `railway run` from outside) uses
  `DATABASE_PUBLIC_URL` (the `*.proxy.rlwy.net` address) — `railway.internal`
  only resolves inside Railway.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| App crash-loops on boot | Check Variables — `SESSION_SECRET` missing/under 16 chars, or `DATABASE_URL` not set. |
| `500 Database is not configured` | `DATABASE_URL` missing, or `npm run db:setup` never ran. |
| `relation "items" does not exist` | Run `npm run db:setup` (step 4). |
| DB connection errors / SSL | On Railway use the internal `${{Postgres.DATABASE_URL}}` **without** `sslmode`. (Only external Neon/Supabase needs `?sslmode=require`.) |
| Login fails for everyone | `SESSION_SECRET` missing or too short. |
| UPC/SKU lookups fail | Verify `ALIAS_EMAIL` / `ALIAS_PASSWORD` / `KICKSDB_KEY`. |
| Build fails on `npm run build` | Check the build logs; reproduce locally with `npm ci && npm run build`. |
