# Stickballman12 · Version 5

V5 turns the scanner into a warehouse-grade system and prepares it for real
hosting. **Source of truth moved off Google Sheets to a local PostgreSQL
database**, Receiving became a guided 3-step wizard built around the barcode
gun, a new **PH Team** role gained a monthly audited grid, statuses expanded and
became bulk-editable, and the deployment target is now a portable Node/Express
server (no longer Vercel-specific).

---

## 1. Backend: PostgreSQL (local) + Express, no Google Sheets

- **Driver:** swapped the Neon HTTP driver for the standard `pg` pool behind a
  tagged-template shim in `api/_lib/db.js`. The shim keeps the existing
  `` sql`… ${v} …` `` API (parameterized `$1,$2…`, injection-safe) and
  `sql.transaction([…])` (BEGIN/COMMIT on one client), so all query bodies were
  preserved.
- **Database:** local PostgreSQL 16 (Homebrew). `DATABASE_URL` in `.env` points
  at `postgres://<user>@localhost:5432/stickballman`. The shim auto-enables TLS
  for managed hosts (`sslmode=require` / `*.neon.tech`) and skips it locally, so
  the same code lifts to any real Postgres host later.
- **Schema:** `scripts/db-setup.mjs` (`npm run db:setup`) is idempotent — safe on
  a fresh or existing DB. V5 additions: `users.role` now allows `'ph_team'`;
  `items` gained `with_box`, `price`, `added_to_intel_inv`,
  `synced_alias/stockx/shopify`, `ph_note`, `last_edit_by`, `last_edit_at`; the
  item-status default is now `needs_shelf`.
- **Google Sheets removed entirely:** deleted `api/_lib/sheets.js` +
  `scripts/sheet-setup.mjs`, dropped `google-auth-library` and
  `@neondatabase/serverless` from dependencies, and removed the mirror/sync code
  from `api/batches/commit.js` and `api/items/event.js`. CSV export remains in
  the Inventory page for spreadsheet needs.
- **Production server:** `server.mjs` (Express) serves the built `dist/` SPA and
  mounts every `api/**/*.js` handler at its path (same `(req,res)` contract as
  the Vite dev middleware), with security headers + a CSP. Run with
  `npm run build && npm start` (or `npm run serve`). Local dev is unchanged:
  `npm run dev` (Vite serves the app + `/api`).

## 2. Statuses (central, soft-colored)

Defined once in `src/statuses.js` (labels/colors) and `api/_lib/statuses.js`
(server whitelist). Set: **Needs to be Added to Shelf** (default on receive) ·
In Stock · Pre-Sold · **Bought Without Box** (auto when "With Box" is unchecked)
· **Shipped** · Sold · Returned · Missing · Issue.

## 3. Top bar — live EST clock

Always renders US-Eastern time with a literal `EST` suffix (so the PH team in PH
time is never confused), ticking each second.

## 4. Receiving — 3-step wizard

1. **Shipment details** — Buyer defaults to `stickballman12`; supplier + date
   required. Tracking number can be typed manually (works for UPS/USPS/FedEx/DHL),
   scanned by camera, or read from an **uploaded/snapped label photo** (OCR
   fallback in `src/trackingOcr.js`: zxing barcode decode → Tesseract.js digit
   OCR, both lazy-loaded).
2. **Items** — `+ Add Item` opens a modal that is the scanning workspace. The
   field auto-focuses so a **HID scanner gun types straight in** (fixes the V4
   "gun doesn't work" issue); it auto-detects UPC vs SKU. Re-scanning the same
   shoe's boxes **auto-increments quantity by size**; scanning a different SKU
   prompts to finish the current shoe and start a new one. A **With Box**
   checkbox sets `with_box` (and, when off, status `no_box`). "Complete item"
   adds it to the list (Title — SKU, Size/Qty).
3. **Issues** — shoes received without a box are **auto-listed** as
   `"<SKU> <Size> — No box"`; manual issues can also be added. Finish commits.

On commit, each unit gets its own VIN and its history starts **"Scanned by
&lt;user&gt;"** → "Received into inventory".

## 5. Report / Inventory — status editing + sync indicators

- **Per-item** status change inline in the accordion (logged to history).
- **Bulk** status change: select rows → **Edit status** → pick → applied to all
  via `POST /api/items/bulk-status`, one `status_change` event per VIN.
- **Sync indicators:** each row/detail shows badges — **II** (Intelligent
  Inventory), **AL** (Alias), **SX** (StockX), **SH** (Shopify) — lit once the
  PH Team marks them, plus the price. Visible to admin and warehouse staff.

## 6. Roles, access & the Report

Three roles: **admin** · **warehouse** · **ph_team** (the legacy `employee`
role is migrated to `warehouse`).
- **admin** — full access; manages accounts (approve/reject, **change role**,
  **delete**) on the Check Access screen; sees Receiving, Inventory, Report.
- **warehouse** — Receiving + Inventory only.
- **ph_team** — the **Report** only; logs straight into it (no home screen).
- **Signup** now includes a **role picker** (warehouse / ph_team — never admin).
- Access is enforced **server-side**: warehouse endpoints (search, receiving,
  inventory, status changes) use `requireRole(['warehouse'])` (admin auto-
  allowed); the Report endpoints require `ph_team`/`admin`.

**Report page** (renamed from "PH Team") — monthly listing of every scanned shoe
with editable pricing + cross-store sync flags.
- `GET /api/ph/list?month&year` and `POST /api/ph/update` (gated to
  `ph_team`/`admin`). Month/Year default to the current EST month/year, with a
  **sort-by-scan-date** toggle (oldest/newest).
- Grid: fixed-height (~62vh) scroll box with a sticky header and **frozen
  columns through Quantity** (`position: sticky`), so the many editable columns
  scroll horizontally without chasing the scrollbar down the page.
- Editable per row (Edit ⇄ Submit toggle; Submitted = read-only): **Price**,
  **Added to Intelligent Inventory**, **Synced to Alias / StockX / Shopify**
  (Yes/No — soft **blue = yes**, soft **red = no**), and **Note**.
- **Added by** = the last submitter's name + EST timestamp. Every changed field
  is written as its own `ph_update` history event (audit trail).

## 7. Security

- Credentials/keys server-side only; browser calls same-origin `/api/*`.
- scrypt password hashing; HMAC bearer sessions (`SESSION_SECRET` required, ≥16
  chars, enforced); DB-backed login throttling (per-username/IP, 15-min window).
- Role checks on every privileged endpoint (admin for account review; ph_team/
  admin for PH endpoints).
- Server-side validation + caps on all editable fields (price 0–1,000,000;
  note ≤2000 chars; bulk-status ≤1000 VINs, status whitelisted; 256 KB body cap).
- Full audit trail in `item_events` (scanned, received, status_change, ph_update,
  note, issue).
- Parameterized SQL everywhere (via the shim). Security headers + CSP set in
  `server.mjs` (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`,
  `Permissions-Policy` camera=self, HSTS, CSP allowing blob workers for the lazy
  OCR and `img https:` for product images).

### Residual items for real hosting
- Sessions are stateless HMAC tokens (8 h TTL), so a **deleted account or role
  change takes effect on the user's next login** — an already-issued token stays
  valid until it expires. Add a per-request DB session/role check if immediate
  revocation is needed.
- Serve over **HTTPS** (HSTS already sent); set strong `SESSION_SECRET` and
  `ADMIN_PASSWORD` in the host env.
- The in-memory burst rate-limiter is per-instance; behind multiple instances,
  move it to the DB (login throttle already is) or a shared store.
- `npm audit` shows a **dev-only** esbuild/Vite advisory (dev server only, not in
  the production bundle); upgrading Vite is a separate breaking change.
- Tesseract OCR fetches its WASM/lang assets from a CDN on first use; the CSP
  allows this (`connect-src https:`). Self-host the assets to tighten it.

## 8. Commands

```bash
npm install                 # deps (pg, express, tesseract.js, zxing, react…)
brew services start postgresql@16
createdb stickballman       # once
npm run db:setup            # create/upgrade tables (idempotent)
npm run dev                 # http://localhost:5173 — app + /api (Vite)
npm run build && npm start  # production-style: Express serves dist/ + /api on :3000
```

## 9. Data model note (VIN vs id)

Items keep a numeric primary key **and** a unique `vin` business key
(`SBM-YYMMDD-######`). The numeric id anchors foreign keys/joins so history
links never break even if a VIN is reprinted or corrected; the VIN remains the
human/scan identifier.

## 10. Rescale by VIN · custom tags · staged status save

Three later V5 additions, all centered on a unit's continuous history.

- **Rescale by VIN (re-scan existing stock).** Rescale used to mint a *new* VIN
  for every unit — splitting a returned/relisted shoe's history across two
  records. Now the Rescale wizard **auto-detects the scanned code** before any
  API call (`isVinCode` = `SBM-YYMMDD-…`, `isUpcCode` = 8–14 digits, else SKU):
  - **VIN** → looks the unit up and adds it to a **“Rescanned existing stock”**
    list; on finish, `POST /api/items/rescale` appends a `rescaled` event + a
    `status_change` to **that same item** (no new VIN), so one physical shoe
    keeps one unbroken timeline (`rescaleItem` in `db.js`, atomic).
  - **UPC/SKU** → unchanged: new/unlabeled stock still goes through batch commit
    and gets a fresh VIN.
  - The warehouse **picks the new status per rescanned unit** (no auto-default);
    the rescale reason is recorded on the `rescaled` event. The camera gains a
    `rescale` mode that decodes **both** the VIN (Code128/39, raw text kept) and
    a product UPC/EAN.
- **Custom tags.** The item-detail “Set status / tag” list still offers the 9
  presets but now also takes a **free-text custom tag** (≤40 chars, sanitized by
  `normalizeStatus` in `api/_lib/statuses.js`; the `items.status` column is plain
  TEXT). Presets render with their color; customs render as a plain pill and are
  filterable by exact text.
- **Staged status save (detail view).** Picking a status/tag in the detail view
  no longer saves immediately — it’s **staged** and a **Save / Cancel** row
  appears (mirroring the Inventory list’s draft-then-Save pattern), so nothing is
  written until the user confirms.
- **PH Team home: New Inventory vs Rescale Stock.** The PH Team no longer drops
  straight into one Report — they land on a **home chooser** (`PHTeamApp`) with
  two workflows that share the same listing/sync job (price + Intelligent
  Inventory / Alias / StockX / Shopify / note):
  - **New Inventory** — newly *received* stock for the month (`kind=receiving`:
    items by scan date, rescale batches excluded).
  - **Rescale Stock** — units *rescanned* for the month (`kind=rescale`): items
    that have a `rescaled` event in the month, **dated by that event**, so a unit
    surfaces for re-listing when it’s rescaled (covers both VIN re-scans of
    existing stock and rescale-batch intake; the `Date`/`Scanned by` columns show
    the rescale). `GET /api/ph/list` gained a `kind` param; `phListItems(month,
    year, kind)` branches accordingly. The admin Report (no `kind`) is unchanged
    (everything by scan date).

## 11. Report consolidation · size · gender

- **Size + gender in the Report.** `phListItems` now returns `size`, `gender`
  and `status`; the grid shows a **Size** column (and the mobile cards a size
  line) so PH never has to open an item to see what they're listing. The wide
  table dropped the per-VIN **VIN** column (it's no longer 1 row = 1 VIN — see
  below) in favour of frozen **Date · Title · SKU · Size · Qty**, with Gender /
  Status / Scanned-by as scrolling columns.
- **Consolidated rows.** Identical units now collapse into **one row with a
  `×qty`** instead of one row per VIN (`groupPhRows` groups by every listing-
  relevant detail — name, sku, size, gender, status, cost, price, all four sync
  flags, note — so a group only forms when applying one edit to all of them is
  correct). Editing a group applies the change to **every member VIN** via
  `POST /api/ph/update` with a `vins[]` array (`phUpdateItems`, atomic, one
  `ph_update` event per VIN preserved). The Qty cell tooltips the member VINs.
  This lets PH list "size 9 ×6" in one action instead of counting six rows.
- **Gender for accurate store listing.** The product lookup now captures a
  normalized **gender** (`Men`/`Women`/`Youth`/`Toddler`/`Unisex`) — taken from
  Alias's explicit gender field (the most reliable source) and otherwise derived
  from the StockX size suffix (`W`/`Y`/`C`) or the title. Stored on
  `items.gender` (new column, idempotent migration) and surfaced in the Report.
- **Provider order unchanged.** UPC lookup is still **StockX primary → Alias
  fallback** (`api/upc-search.js`): StockX answers first; Alias is queried only
  when StockX returns null/errors, *plus* opportunistically to enrich the full
  size run and now the gender even on a StockX hit. SKU lookup is KicksDB.
- **Inventory list readability.** The browse list was rebuilt as a real
  **`<table>`** (sticky header: ☐ · VIN · Shoe · **Size** · SKU · Status & sync;
  click a row to expand its detail underneath). The Report table now fills the
  wide window and has a consistent row hover across its frozen columns.

## 12. URL routing + security hardening

- **Path-based routing.** Top-level pages are now reflected in the URL
  (`/inventory`, `/report`, `/receiving`, `/rescale`, `/access`, `/` for home)
  via the History API (`pathForView`/`viewForPath` in `App.jsx`). **Refreshing
  keeps you on the page** (initial `view` is read from `location.pathname`),
  links are shareable, and browser Back/Forward move between pages — while a
  modal or wizard step still consumes Back first (`navBack`). Deep sub-state
  (which item is open, wizard step) stays in memory. Both the Vite dev server and
  Express `server.mjs` already serve the SPA history-fallback, so a hard refresh
  on any path returns `index.html`.
- **Login burst guard.** `api/auth/login.js` now also runs the in-memory
  per-IP `rateLimit` (20/min) in front of the existing DB-backed window throttle
  (5/user, 30/IP per 15 min), so rapid-fire attempts are blocked before they
  accumulate in the DB counter.
- **HTTPS + redirect (`server.mjs`).** Set `TLS_CERT` + `TLS_KEY` (PEM paths;
  optional `TLS_CA`) to terminate TLS in Node: the app serves HTTPS on
  `HTTPS_PORT` (default 443) and a small HTTP listener on `PORT` (default 80)
  **301-redirects all traffic to HTTPS**. Unset → plain HTTP on `PORT`
  (default 3000), unchanged — for reverse-proxy TLS (Caddy/nginx) or local dev.
  HSTS is already sent, so it engages as soon as the app is reached over HTTPS.

## 13. Sold cascade (II → stores)

Selling removes a unit from Intelligent Inventory, which cascades the delist to
every store (the flow is **II → stores**). So setting an item's status to
**`sold`** now auto-clears all four sync flags (II / Alias / StockX / Shopify)
to No and logs a `ph_update` event explaining it. The rule lives in the DB layer
(`addItemEvent` for single edits, `bulkSetStatus` for bulk), so it applies
wherever 'sold' is set — the inventory detail view, the inline list dropdown, and
bulk status change. It's one-way (sold ⇒ flags off; toggling a flag off by hand
does not imply sold). Only `sold` triggers it.

## 14. No-Box worklist (not ready for posting)

Units **bought without a box** (`no_box`) aren't postable, so they're now
**excluded from the PH team's New Inventory and Rescale Stock** views
(`phListItems` filters `status <> 'no_box'` for those two `kind`s; the admin
Report with no `kind` still shows them for oversight). A dedicated **No Box /
Not Ready** page lists every pending `no_box` unit (all batches, not month-
scoped — `GET /api/items/no-box`, readable by `warehouse`/`ph_team`/admin):
- **PH team** gets it as a third home card — **view-only** (so they can see
  what's pending).
- **Admin** gets it as a home card and **resolves** each unit with a status
  dropdown + Save (warehouse can too via the existing Inventory page). The save
  uses the warehouse/admin-gated `POST /api/items/event`, so PH genuinely can't
  change status. Once resolved, the unit leaves this queue and reappears in the
  PH report.

## 15. PH concurrent-edit safety (A + B2)

Two PH users can be logged in at once, so editing the same consolidated row is
guarded two ways:

- **A — optimistic concurrency (save-time check).** Each save sends the group's
  latest `last_edit_at` as a baseline (`phUpdateItems(..., baseEditedAt)`). If
  any unit was edited since, the server returns **409** and the client shows
  *"just updated by X — reload"* and reloads. Prevents silent overwrites even if
  a lock is ever lost. No new column (reuses `last_edit_at`).
- **B2 — hard edit lock + presence (Google-Sheets style).** New `edit_locks`
  table (one row per VIN) + `GET/POST /api/ph/locks` (claim · heartbeat ·
  release · list). Clicking **Edit** claims the row's units; others see a
  **🔒 "being edited by X"** badge with **Edit disabled**, and a **Cancel**
  button now sits next to Submit to release without saving.
  - **Heartbeat** every **10s** (silent) keeps the lock alive; the report polls
    presence every 10s to paint badges.
  - **TTL 30s** — a crashed/closed tab's lock auto-frees server-side (stealable).
  - **Idle auto-release after 1 hour** of no edits (PH needs processing time),
    with a notice; locks also release on Submit/Cancel and on leaving the page.
  - Per-tab `holderId` so one user's two tabs don't fight, and ownership is
    unambiguous. Claiming/heartbeat/release are `ph_team`-gated; presence list is
    viewable by warehouse/admin too.

## 16. Mark Sold / Mark Shipped pages + unsaved-changes guard

- **Mark Sold / Mark Shipped (warehouse).** Two straightforward home cards
  (`StatusScanPage`, also for admin). Scan many **VINs** (VIN only — a UPC is
  rejected with a clear message), each is looked up and listed with its shoe +
  current status, then one **Save** marks them all via the existing
  `POST /api/items/bulk-status` (`sold` cascades the delist; `shipped` doesn't).
  Gun-friendly auto-focus + camera VIN mode + duplicate cooldown.
- **Unsaved-changes guard (global).** `useUnsavedGuard(isDirty)` arms the
  browser's native "Leave site?" prompt on **refresh/reload/close**, and flips a
  shared flag the app's **Back** handler checks to **confirm before leaving**
  (Cancel keeps you put). Applied on every page that holds unsaved state: Mark
  Sold/Shipped (scanned rows), the Report (edit mode), Receiving (cart/draft),
  Inventory (staged status), and No Box (staged resolutions).

## 17. Home pending badges · restock tracking · "Box found"

- **Home pending badges.** Each home card shows live count pills from
  `GET /api/items/pending-counts`: the listing card (Report / New Inventory)
  shows **II · AL · SX · SH** (sellable units not yet synced to each store);
  Inventory shows **Needs shelf**; No Box shows **No box**; Rescale shows
  **Restock**. Counts ignore non-sellable units (sold/shipped/missing/no-box).
- **Restock tracking.** New `items.restock_pending` column — set true when a unit
  is rescaled (VIN re-scan or rescale-batch intake). The PH **Rescale Stock**
  page is now a *pending worklist* (shows `restock_pending` units, not month-
  scoped) with a **✓ Restocked** action per row that clears the flag via
  `POST /api/items/restock-done` — the unit then drops off the list and behaves
  as normal inventory. This is the explicit "rescale processed" indicator.
- **No Box → With Box.** Since no shoe is sold without a box, the No Box page's
  primary action is **"📦 Box found → With Box"** (`POST /api/items/box-found`):
  sets `with_box = true` + status *Needs to be Added to Shelf*, making it
  sellable (it then appears in the PH report). A secondary "Other status…"
  dropdown still covers edge cases (e.g. Missing).

## 18. SKU-merged Report/Inventory · PH-requested rescales

- **Merge by SKU + status.** The PH Report **and** the warehouse Inventory now
  show **one row per SKU + status** (regardless of size). The row lists each
  size with its quantity (e.g. `9 ×2 · 9.5 ×3 · 10 ×1`) and a total Qty, because
  PH encodes a SKU to Intelligent Inventory once for all its sizes. Price /
  II / AL / SX / SH / Note are set **once per SKU** and applied to every member
  VIN; a sync flag reads Yes only when *all* units have it, and a `~` marks a
  mixed price/cost. (`groupPhRows` regroups by `sku|status`.) Inventory's
  expanded row keeps a per-VIN **Units** list (drill into any one for its
  history); checkbox/bulk/labels still operate on the underlying VINs.
- **PH Request Rescale.** PH submits **SKU, sizes + qty, current price, reason**
  (mismatch / quantity / recount / …) via a form → `rescale_requests` table
  (`POST /api/rescale-requests/create`). The **warehouse** gets a **Rescale
  Requests** inbox card (with an open-count badge) listing each request; **Mark
  done** resolves it (`/resolve`). This is the PH→scanner loop from the workflow
  diagram. `db-reset` clears requests along with inventory.

## 19. Sizes as chips · date filter on all report pages

- **Sizes as chips.** The merged SKU rows now render each size as a discrete
  chip (`SizesQty`) — `[8 ×5] [9 ×5] [10 ×5] [11 ×5]` — instead of a run-on
  dotted string, so many sizes read clearly.
- **Calendar date filter everywhere.** Extracted the Inventory Day/Week/Month
  switcher into a reusable `DateRangeBar` (+ `rangeOf(mode,anchor)`), and wired
  it into the **Report**, **Rescale Stock**, **No Box**, and **Rescale Requests**
  pages. Defaults: **Month** for the Report, **Day** for the others. Backend list
  queries (`phListItems`, `listNoBoxItems`, `listRescaleRequests`) now take a
  `from`/`to` EST date range instead of month/year. ‹ / › navigates periods and
  reloads instantly.

## 20. Rescale requests: reported vs actual audit

The rescale request is now a two-way audit:
- **PH** submits the **reported** qty per size (and can look up the SKU to
  auto-fill the shoe name — `sku-search` now allows `ph_team`).
- **Warehouse** opens the request and runs an **audit** ("🔍 Audit shelf"):
  enters the **actual** qty counted per size (pre-filled from the reported sizes;
  can add sizes found that weren't reported, set 0 for none on shelf) + an audit
  note. Saving sets `rescale_requests.actual_sizes` / `audit_note` and flips the
  status `open → audited`.
- A shared **report** (`RescaleRequestsReport`) shows each request as a compact
  **Reported (top) / Actual (bottom)** grid per size, with discrepancies
  highlighted in red. Visible to **both** roles; warehouse audits, PH views +
  creates ("+ New request"). Filter by Open / Audited / All and by date.
- `auditRescaleRequest` replaces the old `resolve`; the open-count home badge
  clears once a request is audited.
