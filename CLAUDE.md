# Stickballman12 · Shoe Scanner — Project Context

Quick-reference context for this repo. For the user-facing overview see
[README.md](./README.md); for hosting/env setup see [DEPLOYMENT.md](./DEPLOYMENT.md)
and [UPDATE_VERSION.md](./UPDATE_VERSION.md).

> **V5 (current) supersedes parts of the notes below — see
> [version-5.md](./version-5.md).** Key changes: **Google Sheets removed**, data
> lives in **local PostgreSQL via the standard `pg` driver** (tagged-template
> shim in `api/_lib/db.js`); production runs on **Express (`server.mjs`,
> `npm start`)**, not Vercel. Receiving is a **3-step wizard** with an Add-Item
> scanning modal; new **`ph_team`** role + monthly grid (`api/ph/*`); statuses
> expanded (keys in `api/_lib/statuses.js` / `src/statuses.js`); bulk status
> change (`api/items/bulk-status.js`); EST top-bar clock. Where this file says
> "Sheets", read "Postgres".

## What it is

A React (Vite) web app for a shoe-inventory team. Users sign in (admin-approved
accounts), scan a barcode (UPC) or enter a SKU, look up the shoe, and record
sizes & quantities into a Google Sheet. Vercel serverless functions under `/api`
proxy all third-party calls; **user accounts live in Neon Postgres**.

## Stack

- **Frontend:** React 18 + Vite (`src/`).
- **Barcode camera:** `@zxing/browser` + `@zxing/library` (lazy-loaded;
  `TRY_HARDER` enables vertical-barcode reading).
- **Backend:** Vercel serverless functions in `api/` (Node). Locally they run
  through Vite middleware, so `npm run dev` serves the app and `/api/*`.
- **Database:** Neon Postgres via `@neondatabase/serverless` (`DATABASE_URL`).
- **Sheets:** `google-auth-library` (service account).

## Commands

```bash
npm install        # install deps
npm run db:setup   # create Postgres tables (users, login_attempts, locks) — idempotent
npm run dev        # http://localhost:5173 — app + /api via Vite middleware
npm run build      # production build
```

Admin login: username `admin`, password = `ADMIN_PASSWORD` (in `.env`).

## Layout

```
src/
  App.jsx                 # all UI: Auth (login/signup), Home, CheckAccess,
                          #         BulkScan, RapidScan, ConfirmSend, modals
  api.js                  # frontend API client (token+user storage, fetch wrappers)
  prefs.js                # user prefs (localStorage): camera zoom
  styles.css              # all styles (dark theme, responsive)
  components/CameraScanner.jsx
api/
  auth/login.js           # POST — username/password (DB or env admin) -> session
  auth/signup.js          # POST — create a pending employee account
  admin/users.js          # GET  — list accounts (admin only)
  admin/review.js         # POST — approve/reject an account (admin only)
  upc-search.js           # POST — StockX (primary) -> Alias (fallback)
  sku-search.js           # POST — KicksDB/StockX SKU lookup (full size run)
  send-to-sheet.js        # POST — Bulk Scan write (consolidating)
  rapid-send.js           # POST — Rapid Scan write (qty 1, consolidating)
  _lib/
    util.js               # auth (requireAuth/requireAdmin), scrypt, sessions,
                          # rate limiting, security headers, body parsing (256KB cap)
    db.js                 # Neon access: users, login_attempts, distributed lock
    sheets.js             # Sheets read/append/update + upsertVariants
scripts/db-setup.mjs      # schema migration
```

## Auth & accounts

- **Login** (`api/auth/login.js`): `admin` is an env account (username `admin`,
  name `Alex`, `ADMIN_PASSWORD`); everyone else is a DB row. Passwords hashed
  with **scrypt**. On success the server returns `{ token, user }`; the client
  stores both in `sessionStorage` (`sb_session_token`, `sb_user`) and sends the
  token as `Authorization: Bearer` on every call.
- **Signup** (`api/auth/signup.js`): creates a `pending` `employee`; can't log
  in until approved.
- **Approval**: admin `Check Access` screen → `api/admin/*` (gated by
  `requireAdmin`) sets status `approved`/`rejected`.
- **Brute force**: `login_attempts` table; per-username and per-IP failure counts
  in a 15-min window trigger a 429 lockout. Generic auth errors (no enumeration).
- `users(id, name, username UNIQUE, pass_hash, role, status, …)`.

## Data flow

1. **Lookup** — `searchUpc`/`searchSku` return
   `{ name, sku, upc, image, brand, colorway, sizes[], source }`.
   - **UPC**: StockX primary (Railway `/stockx-upc-search`, no key) → Alias
     fallback. StockX → `source:'stockx'`, single `sizes:[size]`. Alias →
     `source:'alias'`, full list.
   - **SKU**: KicksDB `?display[variants]=true` → `source:'kicksdb'`, full list.
2. **Scan modes**
   - **Bulk** (`BulkScan`): size/quantity table (steppers + a blank manual row);
     `prepareSend` validates → `ConfirmSend` → `api.sendToSheet`.
   - **Rapid** (`RapidScan`): scan → StockX size auto / Alias size grid (`+W` for
     women's) → `ConfirmSend` → `api.rapidSend` (qty 1) → re-arm.
   - **ConfirmSend**: image + name + **emphasized SKU** + size (+qty for Bulk);
     dismissable only via Yes/No.
3. **Sheet write** (cols **A–J**: unique_id, **Scanned by**, name, sku, size,
   qty, price, **status**, **remarks**, added_by):
   - Both modes call `sheets.upsertVariants` under a **global Postgres write
     lock** (`acquireLock('sheet:write')`). For each size, if a row with the same
     **SKU + Size + Status 'Not Added' + same Scanned-by** exists, its quantity
     is increased; otherwise a new row is appended. Different scanner → own row.
     `Added`/`WITH REMARKS` rows are never merged.
   - The lock serializes all writes, so appends use a plain (non-verify) append.
     Column A still gets a short unique id.

## Security model

Credentials/keys (Alias, KicksDB, Google SA, `DATABASE_URL`, `ADMIN_PASSWORD`)
are server-side only; the browser only calls same-origin `/api/*`. scrypt
hashing, HMAC bearer sessions (role-checked server-side), DB-backed login
throttling, parameterized SQL, 256 KB body cap, per-IP rate limiting, CSP/headers
in `vercel.json`.

## Conventions / gotchas

- Every endpoint starts with `applySecurity`, then `requireAuth`/`requireAdmin`
  (returns the user object or sends 401/403), then `rateLimit`.
- A 401 from any API → client clears the session and returns to login
  (`err.unauthorized`).
- **Neon free tier auto-suspends (~5 min idle)** → the first DB query (the lock)
  after idle can take ~1–5s, then it's warm. For low latency, **match the Vercel
  function region to the Neon region**.
- The global `sheet:write` lock serializes all sheet writes — simple and correct,
  but caps write throughput; if heavy multi-device load needs more parallelism,
  split into per-SKU locks (which would reintroduce verify-on-append).
- **Camera zoom** (1×/2×) in `prefs.js` (localStorage); uses the
  `MediaStreamTrack` `zoom` capability, else a CSS `transform: scale()` fallback.
- The scanner-gun input stays auto-focused so a HID scanner "types" straight in.
