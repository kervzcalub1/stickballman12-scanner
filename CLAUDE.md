# Stickballman12 · Inventory — Project Context

**Read this file first, then open ONLY the context chunk(s) for the feature you're
touching** (under `docs/context/`). The chunks keep deep detail out of every
session — don't read the whole codebase up front.

## What it is
React (Vite) SPA + Express + PostgreSQL for a shoe-inventory team. Sign in
(admin-approved accounts), scan a barcode (UPC) / enter a SKU / scan a VIN, then
receive, buy in-store, shelve, rescale, list to stores, and mark sold/shipped. **V5 reality:
local/managed Postgres via `pg` (no Google Sheets), runs on Express (`npm start`),
deployed on Railway.** Older notes in `version-4.md`/`DEPLOYMENT.md` may predate this.

## Stack (one line)
React 18 + Vite — UI split into `src/screens/*` (one per page), shared
`src/components/common.jsx`, pure helpers in `src/lib/*` + `src/hooks.js`;
`src/App.jsx` is just the shell/router. Node handlers in `api/**/*.js` served by
`server.mjs` (Express) + Vite dev middleware; Postgres via the `sql` shim in
`api/_lib/db.js`. Details → `docs/context/architecture.md`.

## Commands
```
npm run dev   # localhost:5173 (app + /api)      npm run build  # -> dist/
npm start     # node server.mjs (prod)           npm run db:setup  # migrate (idempotent)
npm run db:reset  # wipe inventory, KEEP accounts (destructive)
npm run db:go-live  # beta→prod reset: inventory + PO side, KEEP accounts/photos/locations
npm run sop:shots # re-capture the SOP screenshots (needs dev on :5189 + local data)
```
Admin login: username `admin`, password `ADMIN_PASSWORD` (.env).

## Context map — open what you need
| Area | File |
|---|---|
| Stack, server, routing, App.jsx component map, conventions | `docs/context/architecture.md` |
| DB tables/columns, db.js functions, shim gotchas | `docs/context/data-model.md` |
| Login/signup, roles, sessions, security/throttling | `docs/context/auth-roles.md` |
| Receiving wizard, VINs, batches, intake | `docs/context/receiving.md` |
| In-Store buying + In-Store Listing (kind='instore', PH-excluded, manual store listing) | `docs/context/in-store.md` |
| Existing Stock: counting old stock in shelf-by-shelf (kind='existing', PH-excluded) | `docs/context/existing-stock.md` |
| Inventory browse, SKU-merge, bulk status, labels | `docs/context/inventory.md` |
| PH report/grid, SKU-merge, edit locks, sync flags, badges | `docs/context/ph-report.md` |
| Rescale: restock worklist + request/audit (reported vs actual) | `docs/context/rescale.md` |
| No Box queue, Box-found, UPC box labels, Box Labels tool (`/box-labels`) | `docs/context/no-box.md` |
| Shelf locations: put-away/shelve, locate, Locations page, labels, seed | `docs/context/locations.md` |
| Status keys, transitions, sold/shipped cascade | `docs/context/statuses.md` |
| Purchase Orders: supplier scan-out, PO/label schema, `supplier` role (Phase 0) | `docs/context/purchase-orders.md` |
| StockX / Alias / KicksDB, Alias auto-relogin, proxies | `docs/context/integrations.md` |
| Railway deploy, env vars, db:setup/reset, schema-drift trap | `docs/context/deploy.md` |
| In-app SOP & Help: article/FAQ data model, search, SVG schematics, screenshot capture | `docs/context/sop.md` |

Current work log / next steps: `june22-progress.md`. Full feature history:
`version-5.md`. Team SOPs: `SOP-WAREHOUSE.md`, `SOP-PH-TEAM.md`.

## Always-on gotchas (don't relearn these each session)
- **Schema drift is the #1 trap:** code using a new column before the DB is
  migrated → `column "…" does not exist`. Run `db:setup` on every env after
  schema changes (`docs/context/deploy.md`).
- `api/_lib/db.js` shim **can't nest `sql` fragments** — branch with if/else.
- Endpoint order: `applySecurity` → `requireAuth/Role/Admin` (admin auto-allowed)
  → `rateLimit` → `getJsonBody` (256 KB cap). 401 → client logs out; 409 → conflict.
- Secrets are server-side only; `.env` is git-ignored — **never commit it**.
- Alias has **auto-relogin on 401; StockX does NOT**.
- VINs (`SBM-YYMMDD-######`) are never reused; numbering gaps are fine.
- Times/filters are EST (`AT TIME ZONE 'America/New_York'`).
- **`PH_EXCLUDED_KINDS` (`instore` + `existing`) must NEVER touch the PH team** —
  guard every PH path (phListItems both branches, pendingCounts badges, rescaleItem,
  phUpdateGroup, getItemsForGiRefresh, recomputeUnlistedPrices), not just the New
  Inventory query. Use `(b.kind IS NULL OR b.kind <> ALL(${PH_EXCLUDED_KINDS}))` —
  the `IS NULL` half matters on the LEFT JOINs. Adding a kind to that list is NOT
  enough on its own: check anything keyed on the *inverse* of the flag too (the
  In-Store Listing badge is keyed on `is_instore`, deliberately)
  (`docs/context/in-store.md`, `docs/context/existing-stock.md`).
- After a rebuild, hard-refresh the browser (stale cached bundle).

## Working agreements
- Match the surrounding code's style; put new pages in `src/screens/*`, shared
  UI in `src/components/`, and pure helpers in `src/lib/*` (keep `App.jsx` a thin
  router). Run `npm run build` to verify before declaring done.
- Update the relevant `docs/context/*.md` when a feature's behavior changes, and
  add an `ADD COLUMN IF NOT EXISTS` to `scripts/db-setup.mjs` for new columns.
- Commit/push only when asked.
