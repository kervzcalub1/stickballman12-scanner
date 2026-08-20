# Architecture

React (Vite) SPA + Express server + local/managed PostgreSQL. No Google Sheets.

## Stack
- **Frontend:** React 18 + Vite, organized into modules (no longer one file):
  - `src/App.jsx` — thin shell + top-level router only (~90 lines).
  - `src/screens/*.jsx` — one file per page (Auth, Home, CheckAccess, Receiving,
    Inventory, PHTeam [PHTeamApp + PHGrid], NoBoxReport, StatusScanPage,
    RescaleRequests).
  - `src/components/common.jsx` — shared presentational components (TopBar,
    StatusPill, SyncBadges, Modal, HistoryModal, CardBadges, DateRangeBar,
    SizesQty, YesNo, LabelSheet (label print dialog), PreferencesModal, RescaleCompare,
    EstClock). Camera scanner: `src/components/CameraScanner.jsx` (lazy, zxing).
  - `src/lib/*.js` — pure helpers: `format` (dates), `codes` (VIN/UPC/size),
    `ph` (PH grid grouping/pricing/constants), `history` (event labels),
    `csv`, `constants` (routing/roles/domain lists). `src/hooks.js` — shared hooks.
  - Styles in `src/styles.css`. API client in `src/api.js`.
- **Backend:** plain Node handlers in `api/**/*.js`, each `export default
  (req,res)`. `server.mjs` (Express) serves built `dist/` + mounts every
  `api/**/*.js` at its path. Vite dev middleware mirrors this for `npm run dev`.
  The history fallback serves `index.html` for extensionless app routes but
  **404s anything under `/assets/`** — handing a stale hashed chunk the HTML
  shell makes the browser fail on MIME type instead of on the real cause
  (`docs/context/locations.md` "Labels").
- **DB:** PostgreSQL via `pg` Pool behind a tagged-template shim in
  `api/_lib/db.js` (`` sql`… ${v} …` `` → `$1,$2…`; `sql.transaction([…])`).
  Shim has **no nested-fragment support** — branch with if/else, not nested `sql`.

## Commands
```
npm run dev        # http://localhost:5173 — app + /api (Vite middleware)
npm run build      # production build to dist/
npm start          # node server.mjs (serves dist/ + /api)
npm run db:setup   # idempotent schema migrate (CREATE/ALTER IF NOT EXISTS)
npm run db:reset   # wipe inventory data, KEEP accounts (destructive)
npm run db:go-live # beta→prod reset: inventory + PO side (see deploy.md)
npm run e2e        # Playwright E2E (auto-starts dev on :5189); npm run e2e:ui for the UI
npm run mobile        # serve the built app to a phone on this Wi-Fi (see below)
npm run mobile:https  # …over HTTPS on the LAN IP — camera works, nothing published
npm run mobile:ca     # serve just the CA cert for the phone to install (port 8081)
npm run mobile:tunnel # …over public HTTPS from anywhere — camera works, IS published
```

## Testing on a real phone (`scripts/mobile-preview.mjs`)
Warehouse staff live on phones, so device testing is a first-class step. Two modes:

| | URL | Camera (scanner + photos) | Reach | Setup |
|---|---|---|---|---|
| `npm run mobile` | `http://<lan-ip>:3000` | **No** | same Wi-Fi | none |
| `npm run mobile:https` | `https://<mac>.local:8443` | **Yes** | same Wi-Fi | trust a CA on the phone, once |
| `npm run mobile:tunnel` | `https://<random>.trycloudflare.com` | **Yes** | anywhere, public while it runs | none |

- **Never `vite --host`.** The Vite DEV server binds to localhost *on purpose* —
  it can serve project source via path traversal (the note in `vite.config.js`).
  Both modes here build to `dist/` and serve through **`server.mjs`**, which has
  the traversal guard and the production security headers. Verified: `/api/../
  server.mjs` and `/api/../../.env` over the LAN IP return the SPA shell, not source.
- **Why the tunnel exists:** `getUserMedia` needs a secure context. iOS Safari
  counts `https://` and `localhost` — a plain `http://192.168.x.x` LAN URL is not,
  so the barcode scanner and photo camera are simply dead there while everything
  else works. Layout/flows → LAN. An actual on-device scan → tunnel.
- `--watch` runs `vite build --watch`, so a save rebuilds `dist/` and a
  pull-to-refresh on the phone picks it up. `--port=N`, `--no-build`, `--verbose`.

### `mobile:https` — a real certificate for the LAN address (`scripts/local-cert.mjs`)
The private, no-tunnel way to get a secure context. Creates a small CA, issues a
leaf for this Mac, and starts `server.mjs` with `TLS_CERT`/`TLS_KEY` (support that
was already in the server). Everything lands in **`certs/` — git-ignored**; only
`certs/rootCA.pem` ever goes to a device.
- The CA is **never added to this Mac's keychain** — no sudo, nothing to uninstall
  later. Only the devices you explicitly trust it on are affected.
- **Phone setup, once:** open `http://<lan-ip>:8081` — a page with a Download
  button (the CA is served over plain HTTP because it's the one file that has to
  travel *before* the phone trusts anything, so it can't come over the https URL it's
  the prerequisite for) → tap Allow → Settings → Profile Downloaded → Install →
  **General → About → Certificate Trust Settings → full trust**. That last toggle is
  the step everyone misses; without it Safari still refuses the cert.
- **Three things iOS needs, each of which fails silently on its own** (learned the
  hard way — the first version of this served the CA and the download did nothing):
  **(1)** serve the cert **inline** — `Content-Disposition: attachment` routes it to
  the Files download manager instead of the profile installer, and a `.pem` sitting in
  Files is a dead end; **(2)** the URL needs a certificate extension — `.cer` carrying
  **DER** is what iOS takes without argument (`.crt`/PEM is served too); **(3)** `/` is
  a real HTML page, because landing on a bare IP that answers with a raw download is
  indistinguishable from "the server isn't running".
- **`npm run mobile:ca`** serves *only* the CA (`local-cert.mjs --serve`) — for when
  the phone needs the certificate and the app server isn't running. Note the CA page
  lives only as long as the command does; a phone visiting `:8081` after Ctrl-C gets
  nothing, which reads exactly like a broken download.
- **A busy port steps aside instead of crashing:** `serveCa` catches `EADDRINUSE`,
  says so, and binds the next port (the printed instructions follow the real one). It
  used to throw an unhandled `error` event *after* the banner had already printed the
  old port — the run died while the screen still said "open :8081".
- **Apple's rules, all of which the leaf satisfies** (get one wrong and iOS rejects
  it with no useful error): RSA ≥2048, SHA-256, `extendedKeyUsage=serverAuth`, a SAN
  covering the address (CN is not consulted), and validity ≤825 days. The leaf gets
  **397 days** — the stricter 2020 cap exempts user-installed roots, but there's no
  upside to betting on the exemption.
- **DHCP-proof:** the cert covers the Bonjour name (`<mac>.local`) *and* the current
  IP, and prefers the name in the printed URL. When the IP changes, re-running
  re-issues the leaf **from the same CA** — the phone is never re-trusted. Same for
  expiry (auto-reissues within 14 days of it).
- Ports move above 1024 (`8443` TLS, `8080` → 301 redirect, `8081` CA) because
  `server.mjs` defaults to 443/80, which need root.
- The tunnel **publishes this machine's app, pointed at your LOCAL database**, for
  as long as the command runs (random hostname, dead on Ctrl-C). Login-gated pages
  stay login-gated; the by-design public endpoints (`/api/track`, `/api/get-price`)
  are public there too.
- **Supplier accounts can't sign in** over any of these URLs: the portal gate in
  `api/auth/login.js` only relaxes for `localhost`, so a supplier hits "please sign
  in at supplier.stickballman12.com". Staff/admin are unaffected (`auth-roles.md`).

## Testing (Playwright E2E)
- Specs in `e2e/*.spec.js`; config `playwright.config.js` (chromium, auto-starts
  `npm run dev` on a fixed port). The only tests in the repo — there's no unit suite.
- **Auth without passwords:** `e2e/helpers/auth.js` `loginAs(page, role)` mints a
  signed session with the server's own `signToken` (`verifyToken` trusts the
  signed payload — no DB lookup) and injects it into `sessionStorage`. One smoke
  test does a *real* admin UI login (needs `ADMIN_PASSWORD`); it **skips** (not
  fails) on a 429 from the login rate-limiter during rapid re-runs.
- Screen-render assertions target chrome that survives an **empty DB**; data-
  dependent PH-grid tests `test.skip` when the range has no rows.
- CI: `.github/workflows/e2e.yml` — hermetic (ephemeral Postgres + throwaway test
  secrets), runs `db:setup` then the suite. No production credentials.
- Local run reads `.env` (same `SESSION_SECRET` the dev server uses). The login
  route is rate-limited (20 req/IP/60s, in-memory); rapid re-runs trip it, so the
  real-login test skips — wait ~60s or restart the dev server to reset.

## Routing (SPA, History API)
`ROUTES` array in `src/lib/constants.js` → `pathForView` / `viewForPath`. Views:
receiving, rescale, instore, instore-listing, batches, inventory, report, access,
nobox, sold, shipped, rescalereq, shelve, locations (+ home). Refresh restores the
view from the URL. (`instore`/`instore-listing` are admin/warehouse; `ph_team` can't
reach them — it short-circuits to `PHTeamApp` before this router.) Global unsaved-changes guard via
`useUnsavedGuard(isDirty)` in `src/hooks.js` (module-level dirty flag exposed to
App as `isUnsavedDirty()` + beforeunload/popstate).
PH-team users route separately under `/ph/*` inside `PHTeamApp` (its own
`PH_PATHS` map + `phPageForPath`/`phPathForPage` + pushState/popstate), since
`ph_team` short-circuits before the warehouse/admin `view` routing. `onAuthed`
skips the URL rewrite for `ph_team` so a `/ph/...` deep link survives login.

## Screens (entry points; `src/screens/*`)
- `Home` / `PHTeam` (`PHTeamApp`) — role-based home screens (cards). The
  admin/warehouse `Home` is grouped **by lifecycle** (Intake → Stock/Locate →
  Listings → Fulfilment → Admin) rather than a flat card wall, with a
  **"needs attention" strip** at top surfacing counts that need action (e.g.
  items needing a shelf, no-box queue). Page/label renames: **"Report" →
  "Listings & Sync"** (the PH grid, `ph-report.md`); `Inventory`, `Locate Shoe`
  (formerly "Locations"), and `Shelve` each have a **unique nav icon**
  (`NavIcons.jsx`).
- `Receiving` (+ `BatchList`) — intake (also `mode="rescale"` / `mode="instore"`).
  `Inventory` — stock browse. `InstoreListing` — the In-Store Listing worklist
  (per-store manual-listing toggles; admin/warehouse; `in-store.md`).
- `PHTeam` (`PHGrid`) — the per-size report/grid (kind: null | receiving | rescale);
  `PHGrid` is also App's admin/warehouse Report view.
- `NoBoxReport`, `StatusScanPage` (sold/shipped), `RescaleRequests`
  (`RescaleRequestForm` + `RescaleRequestsReport`).
- `PoOverview` (`/ph/po-status`) — the purchase-order LIST; tapping one sets `?po=<id>`
  and hands off to `PoDetail`, the order's own full-screen page (one card per label,
  add/edit/remove/move labels, edit the order). Shared status vocabulary in
  `src/lib/postatus.js`; see `purchase-orders.md`.
- `PhEditedPhotos` (`/ph/edited-photos`, PH+admin) — PH uploads edited listing
  images per SKU (`source='ph_edited'`, precedence over warehouse; `ph-report.md`).
- `Sop` (`/sop`, `/ph/sop`, + a supplier top-bar toggle) — the in-app SOP & Help
  centre: role-filtered procedures, keyword search, FAQ, inline SVG schematics
  (`SopDiagram.jsx`) and Playwright-captured annotated screenshots
  (`SopShot.jsx`). Static data, no API. See `sop.md`.
- Shared (`src/components/common.jsx`): `TopBar`, `StatusPill`, `SyncBadges`,
  `CardBadges`, `DateRangeBar`, `SizesQty`, `YesNo`, `Modal`, `HistoryModal`,
  `LabelSheet`/`ShelfLabelSheet` (the label print dialog — stock picker + Print, no
  on-screen label preview), `PreferencesModal`, `RescaleCompare`, `EstClock`.

## Conventions
- **`<Modal>` children all land in `.modal-actions`, which is a flex ROW.** So a
  preview list (or any non-button node) passed alongside Confirm/Cancel becomes a
  *column* next to the buttons — that's how "Confirm — Mark Sold" ended up wrapped
  mid-word in three squeezed columns. CSS now stacks the row automatically when it
  holds a **non-button child** or **3+ items** (`:has()` in `styles.css`), so a
  plain button pair keeps sitting side by side and everything else goes one per
  line, full width. Nothing to remember per-modal — but don't fight it by adding
  widths to children. Affects: bulk Sold/Shipped + Shelve + Existing-Stock
  confirms, their 3-button success modals, the temp-password modal, the Receiving
  result when a PO is short (`ReconcileAlert` + buttons), and the shelf-tile edit
  modal (whose Delete stays last when stacked).
- Every endpoint: `applySecurity` → `requireAuth`/`requireRole`/`requireAdmin`
  → `rateLimit` → `getJsonBody` (256 KB cap). Helpers in `api/_lib/util.js`.
- A 401 from any API → client clears session, returns to login (`err.unauthorized`).
- 409 → `err.conflict` (optimistic-concurrency / lock conflicts).
- **Timezone: EST (`America/New_York`) everywhere, never the viewer's or the host's
  clock.** The warehouse day is an EST day and the PH team works a night shift from
  Manila — 10am–6pm EST is 10pm–7am the *next* PH date — so a screen that follows the
  viewer's clock asks the server for a different day than the one it's printing. The
  three layers:
  1. **Process** — `process.env.TZ` is pinned in `server.mjs` and `vite.config.js`
     (dev runs the API handlers inside Vite), so a server-side `new Date()` can't
     inherit Railway's UTC or a developer's own zone.
  2. **Transport** — `DATE` columns are handed back as `'YYYY-MM-DD'` strings
     (`pg.types.setTypeParser(1082, …)` in db.js); see `data-model.md` for why the
     driver's default lost a day.
  3. **Render** — everything goes through `src/lib/format.js`: `estToday`, `estDate`,
     `estCivil`/`estCivilFromYmd` (the URL-anchor round trip), `PH_DATE`,
     `PH_DATETIME`, `estTime`, `EST_FMT`. Times print a literal "EST".

  Banned as a result: `new Date().toISOString().slice(0,10)` (UTC), a bare
  `toLocale*()` (viewer's zone), and `new Date('YYYY-MM-DDT00:00:00')` (local
  midnight — a Manila viewer's anchor came back a day earlier on every round trip).
  `e2e/est-timezone.spec.js` guards it with the browser pinned to `Asia/Manila`; on an
  EST machine the same assertions pass no matter what the code does.
- Times shown in EST; dates filtered by EST calendar day (`AT TIME ZONE 'America/New_York'`).
  The **client Day/Week/Month picker also computes in EST** (`src/lib/format.js`
  `estCivil` normalizes any instant to the EST calendar day, then period math runs
  on a noon-UTC "civil date" — so a PH user in PH time picking "Today" gets the EST
  day, matching the server filter). `rangeOf`/`periodRange`/`shiftAnchor`/`periodLabel`.
- **Checkboxes**: bare native checkboxes are invisible on the dark theme, so a global
  `input[type="checkbox"]` style (`styles.css`) renders every one as a bright bordered
  box → accent-fill + check when ticked (the PH grid's `.ph-yn-check` is excluded).
  Essential filter/status toggles use the `.check-pill` class (a highlighted pill).
- See `data-model.md`, and the per-feature files for specifics.
