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
    SizesQty, YesNo, Barcode, LabelSheet, PreferencesModal, RescaleCompare,
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
```

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
- `PhEditedPhotos` (`/ph/edited-photos`, PH+admin) — PH uploads edited listing
  images per SKU (`source='ph_edited'`, precedence over warehouse; `ph-report.md`).
- `Sop` (`/sop`, `/ph/sop`, + a supplier top-bar toggle) — the in-app SOP & Help
  centre: role-filtered procedures, keyword search, FAQ, inline SVG schematics
  (`SopDiagram.jsx`) and Playwright-captured annotated screenshots
  (`SopShot.jsx`). Static data, no API. See `sop.md`.
- Shared (`src/components/common.jsx`): `TopBar`, `StatusPill`, `SyncBadges`,
  `CardBadges`, `DateRangeBar`, `SizesQty`, `YesNo`, `Modal`, `HistoryModal`,
  `LabelSheet`, `Barcode`, `PreferencesModal`, `RescaleCompare`, `EstClock`.

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
