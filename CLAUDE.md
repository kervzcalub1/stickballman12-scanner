# Stickballman12 · Shoe Scanner — Project Context

Quick-reference context for this repo. For the user-facing overview see
[README.md](./README.md); for hosting/env setup see [DEPLOYMENT.md](./DEPLOYMENT.md).

## What it is

A React (Vite) web app that scans a shoe barcode (UPC) or takes a SKU, looks it
up, shows the shoe details + one reference image, then captures sizes &
quantities and appends them to a Google Sheet. A small set of Vercel serverless
functions under `/api` proxy all third-party calls so credentials never reach
the browser.

## Stack

- **Frontend:** React 18 + Vite. Source in `src/`.
- **Barcode camera:** `@zxing/browser` + `@zxing/library` (lazy-loaded).
- **Backend:** Vercel serverless functions in `api/` (Node). Locally they run
  through Vite middleware, so `npm run dev` serves both the app and `/api/*`.
- **Sheets:** `google-auth-library` (service account) appends rows.

## Commands

```bash
npm install        # install deps
npm run dev        # http://localhost:5173 — app + /api via Vite middleware
npm run build      # production build
npm run preview    # preview the production build
```

Local access password defaults to `stickball2026` (set in `.env`; see
`.env.example`).

## Layout

```
src/
  App.jsx                 # whole UI: Login, Scanner, size/qty table, modals
  api.js                  # frontend API client (token storage + fetch wrappers)
  prefs.js                # user preferences (localStorage): camera zoom, …
  styles.css              # all styles (dark theme, responsive)
  main.jsx                # React entry
  components/
    CameraScanner.jsx     # @zxing camera barcode scanner
api/
  auth.js                 # POST /api/auth — password -> signed session token
  upc-search.js           # POST /api/upc-search — StockX (primary) -> Alias (fallback)
  sku-search.js           # POST /api/sku-search — KicksDB/StockX SKU lookup
  send-to-sheet.js        # POST /api/send-to-sheet — append rows to Google Sheet
  _lib/
    util.js               # auth, rate limiting, security headers, body parsing
    sheets.js             # Google Sheets append helper
```

## Data flow

1. **Login** — user enters `APP_PASSWORD`; server returns an HMAC-signed,
   expiring session token (`SESSION_SECRET`). The client stores it in
   `sessionStorage` (`sb_session_token`) and sends it as `Authorization: Bearer`
   on every API call.
2. **Lookup** — `searchUpc` / `searchSku` return a normalized product:
   `{ name, sku, upc, image, brand, colorway, sizes[], source }`.
   - **UPC** rotates providers server-side in `api/upc-search.js`:
     **StockX UPC Search is primary** (Railway bypass host `/stockx-upc-search`,
     POST `{upc}`, no key); if it returns null or errors, it falls back to
     **Alias**. StockX resolves the exact size for the scanned barcode from
     `result.data.variants[0]` (title + styleId + traits.size/sizeChart.baseSize)
     → `source: 'stockx'`, `sizes: [theSize]`. Alias returns the full size list
     → `source: 'alias'`.
   - **SKU** (KicksDB) returns the size run via `display[variants]=true`
     (mapping `variants[].size`) → `source: 'kicksdb'`, `sizes: [...]`.
3. **Sizes & quantities** — the UI layout depends on `source`:
   - `stockx` → the single resolved size + one **quantity text box**.
   - `alias` / `kicksdb` → the two-column **size/quantity table** (Size |
     Quantity) with − / + steppers, one fixed row per known size, **plus a blank
     manual-entry row** at the end. Manual rows show ＋ (add another row) and ×
     (remove); at least one blank manual row is always kept.
   - no sizes (any source returning an empty list) → just editable manual rows
     (same ＋ / × controls).
4. **Send to Sheet** — posts `{ product, rows: [{ size, quantity }] }`. Each
   variant becomes a sheet row across columns **A–I**:
   `[ unique_id, name, sku, size, quantity, "", "", "Not Added", "" ]`
   (unique_id, Product Name, SKU, Size, Quantity, Price, Remarks, Status, Added by).
   - **Concurrency:** `values.append`+`OVERWRITE` can silently clobber rows under
     simultaneous writes. `_lib/sheets.js` mitigates this with verify-and-retry:
     each row gets a short, time-ordered unique id in column A (base36 timestamp
     + per-submission salt + row index — no read-before-write, so it's safe
     under concurrency), and after appending it reads those cells back and
     re-appends any that were overwritten (bounded retries,
     backoff + jitter). Column A is hidden + protected in the sheet (service
     account has edit access). This is best-effort, not a hard guarantee.

## Security model

All credentials/keys live server-side only (Vercel env vars), never shipped to
the browser. The frontend only calls same-origin `/api/*`. There's input
validation (UPC digits, SKU charset), per-IP rate limiting, and hardened
HTTP/CSP headers (`vercel.json`).

## Conventions / gotchas

- `api/_lib/util.js` is the shared gate for every endpoint: call
  `applySecurity`, `requireAuth`, and `rateLimit` at the top of each handler.
- A 401 from any API means an expired/invalid token — the client clears the
  token and the app drops back to the login screen (`err.unauthorized`).
- **Sheets write quota:** Google enforces ~60 write requests/min **per user**
  (per service account). Verify-and-retry multiplies write calls, so a very
  large simultaneous burst surfaces as `429` errors (explicit, not silent loss).
  Realistic concurrency (a handful of users) stays well under it.
- The barcode-scanner input stays auto-focused so a HID scanner gun "types"
  straight in and searches on Enter.
- **Camera zoom** (1×/2×) lives in `prefs.js` (localStorage), editable via the
  ⚙ Settings modal or an in-camera toggle. It uses the `MediaStreamTrack` `zoom`
  capability when available (real zoom the decoder also sees); otherwise it
  falls back to a CSS `transform: scale()` that magnifies the preview only.
</content>
</invoke>
