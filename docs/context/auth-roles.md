# Auth, roles & security

## Accounts & login
- `api/auth/login.js` — `admin` is an env account (username `admin`, name `Alex`,
  password `ADMIN_PASSWORD`); everyone else is a DB row. Passwords hashed with
  **scrypt**. Success → `{ token, user }`; client stores both in `sessionStorage`
  (`sb_session_token`, `sb_user`) and sends `Authorization: Bearer <token>`.
- `api/auth/signup.js` — creates a `pending` account with a **role picker**
  (warehouse | ph_team — never admin). Can't log in until approved.
- Approval: admin **Check Access** screen → `api/admin/users.js` (list),
  `api/admin/review.js` (approve/reject, change role, delete). Gated by `requireAdmin`.
- **Temp-password reset** (admin/superadmin): Check Access → "Reset password" →
  `api/admin/reset-password.js` generates a random 12-char temp password, stores only
  its hash (`setUserPassword` in db.js), and returns the plaintext ONCE (shown in a
  modal, copyable). Plain reset — the user keeps using it; no forced change. Env
  admin/superadmin accounts have no DB row and can't be reset.

## App settings (price margin)
- `app_settings` table (key/value). `price_markup_pct` = the GI→Final markup percent
  (default 20 = +20%), the single source of truth for pricing math + "GI + N%" labels.
- Read: `GET /api/settings` (any authed user) → `{ priceMarkupPct }`. Write:
  `POST /api/settings` (admin/superadmin, 0–200). Server: `getPriceMarkupPct()` /
  `getPriceMarkupMult()` in db.js (30s cache, busted on write). Client: `src/lib/config.js`
  holds it (fetched in App.jsx after auth); `calcFinalPrice` + labels read from there.
  Edited on the **Settings** screen (Admin section). **Forward-only** — changing it
  affects new pricing; existing Final prices update when a SKU is next refreshed/edited.

## Roles
- **admin** — full access; manages accounts; sees everything.
- **superadmin** — env account like admin (`SUPERADMIN_USERNAME` / `SUPERADMIN_PASSWORD`
  in `.env`, name "Super Admin"). Same server privileges as admin (`isPrivileged()`
  in `util.js` treats both as admin in `requireAdmin`/`requireRole`), PLUS the
  **PH-team pages**: the Home shows a "PH Team Workspace" card that opens the reused
  `PHTeamApp` (superadmin toggles in/out via `phMode` in `App.jsx`; ph_team lives in
  it). Superadmin can EDIT the PH grid / refresh GI (client `canEdit`, and the
  `ph/update` + `ph/refresh-gi` role gates include it). Not a DB role — never written
  to `users`, not offered in the Check Access role picker.
- **warehouse** — Receiving, Inventory, No Box, Rescale, Mark Sold/Shipped,
  Reports, Rescale Requests (audits them), **In-Store Buying + In-Store Listing**.
- **ph_team** — Report (New Inventory), Rescale Stock, No Box (view), Request
  Rescale (creates + views audit), **Edited Photos** (upload edited listing images
  per SKU — `source='ph_edited'` only; see `ph-report.md`). Logs into a card home
  (`PHTeamApp`); its pages are URL-routed under `/ph/*` (refresh/Back/deep-link work).
  **Cannot touch in-store** — the intake commit, `instore-list`/`instore-listed`, and
  every PH surface exclude `kind='instore'` (`in-store.md`).
- `requireRole(req,res,[...])` returns the user or sends 401/403; **admin is
  auto-allowed**. `sku-search` allows `warehouse` + `ph_team`.

## Sessions
- HMAC bearer tokens (`SESSION_SECRET`, ≥16 chars, enforced), ~8h TTL.
- **Stateless** → a deleted account / role change only takes effect on next
  login (token stays valid until expiry). Add a per-request DB check if you need
  instant revocation.

## Hardening (in `api/_lib/util.js` + `server.mjs`)
- `applySecurity` sets headers + CSP. `rateLimit` is in-memory per-IP
  (per-instance — move to DB/shared store behind multiple instances).
- DB-backed login throttle: per-username + per-IP failure counts in a 15-min
  window → 429 lockout. Generic auth errors (no user enumeration).
- Parameterized SQL everywhere; 256 KB body cap; field validation/caps on writes.
- All secrets server-side only (`ADMIN_PASSWORD, SESSION_SECRET, DATABASE_URL,
  KICKSDB_KEY, ALIAS_EMAIL, ALIAS_PASSWORD`); browser calls same-origin `/api/*`.
- `.env` is git-ignored — never commit it.
