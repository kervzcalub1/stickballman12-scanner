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
```

## Routing (SPA, History API)
`ROUTES` array in `src/lib/constants.js` → `pathForView` / `viewForPath`. Views:
receiving, rescale, inventory, report, access, nobox, sold, shipped, rescalereq
(+ home). Refresh restores the view from the URL. Global unsaved-changes guard via
`useUnsavedGuard(isDirty)` in `src/hooks.js` (module-level dirty flag exposed to
App as `isUnsavedDirty()` + beforeunload/popstate).
PH-team users route separately under `/ph/*` inside `PHTeamApp` (its own
`PH_PATHS` map + `phPageForPath`/`phPathForPage` + pushState/popstate), since
`ph_team` short-circuits before the warehouse/admin `view` routing. `onAuthed`
skips the URL rewrite for `ph_team` so a `/ph/...` deep link survives login.

## Screens (entry points; `src/screens/*`)
- `Home` / `PHTeam` (`PHTeamApp`) — role-based home screens (cards).
- `Receiving` (+ `BatchList`) — intake. `Inventory` — stock browse.
- `PHTeam` (`PHGrid`) — the per-size report/grid (kind: null | receiving | rescale);
  `PHGrid` is also App's admin/warehouse Report view.
- `NoBoxReport`, `StatusScanPage` (sold/shipped), `RescaleRequests`
  (`RescaleRequestForm` + `RescaleRequestsReport`).
- Shared (`src/components/common.jsx`): `TopBar`, `StatusPill`, `SyncBadges`,
  `CardBadges`, `DateRangeBar`, `SizesQty`, `YesNo`, `Modal`, `HistoryModal`,
  `LabelSheet`, `Barcode`, `PreferencesModal`, `RescaleCompare`, `EstClock`.

## Conventions
- Every endpoint: `applySecurity` → `requireAuth`/`requireRole`/`requireAdmin`
  → `rateLimit` → `getJsonBody` (256 KB cap). Helpers in `api/_lib/util.js`.
- A 401 from any API → client clears session, returns to login (`err.unauthorized`).
- 409 → `err.conflict` (optimistic-concurrency / lock conflicts).
- Times shown in EST; dates filtered by EST calendar day (`AT TIME ZONE 'America/New_York'`).
- See `data-model.md`, and the per-feature files for specifics.
