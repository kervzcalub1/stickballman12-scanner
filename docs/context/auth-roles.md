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
  Edited on the **Settings** screen (Admin section).
- **On change, unlisted items are re-priced immediately** (`recomputeUnlistedPrices`,
  called from the settings POST): `price = GI × newMult` for items that are **off
  Intelligent Inventory AND off every store** (alias/stockx/shopify), excluding
  in-store and sold/shipped, and **preserving manual overrides** (only rows whose
  price is null or still equals `GI × oldMult`). Already-listed items keep their price
  until re-priced. The Settings screen reports the re-priced count.

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
  per SKU — `source='ph_edited'` only; see `ph-report.md`), **Inventory browse**
  (`/ph/inventory` — the warehouse page, read-only over stock: no status edits, no
  shelving, no notes; `items/query` + `items/lookup` accept `ph_team`, the write
  endpoints don't — `inventory.md`). Logs into a card home
  (`PHTeamApp`); its pages are URL-routed under `/ph/*` (refresh/Back/deep-link work).
  **Cannot touch in-store** — the intake commit, `instore-list`/`instore-listed`, and
  every PH surface exclude `kind='instore'` (`in-store.md`).
- **supplier** — external scan-out partner for the Purchase Order feature (an order
  is created by PH; the supplier signs in and scans out what they ship). DB role.
  **Onboarding: self-signup on the `supplier.` subdomain, admin-approved.**
  `api/auth/signup.js` inspects the request `Host`: on `supplier.*` every self-signup
  is forced to role `supplier` (still lands `pending` → admin approves in Check
  Access); on the main host signup only offers `warehouse | ph_team` and can't be
  tricked into `supplier` (Host-gated server-side, not client-trusted). Admin can also
  set the role manually. Scoped to their own POs on every PO endpoint. See
  `purchase-orders.md`.
  **Two screens, behind a home chooser** (2026-08-26): Purchase Orders and the
  **Payout Calculator**. On the calculator they can READ their own cost stack — scoped
  by `payout_presets.supplier_user_id`, so Andrew sees Andrew — and **never write it**:
  that stack is an input to our buy call, so `payout/presets` answers 403 to every
  supplier POST. They also gained `payout/quote` (live market prices) and a **narrowed
  advisor** — three tools, its own prompt, results projected to counts (`advisor.md`).
  See `payout-calculator.md`.
  **Login portal gate (`api/auth/login.js`, Host-based):** a `supplier` account can
  authenticate **only** on `supplier.*`, and the `supplier.` subdomain accepts **only**
  suppliers (staff get a 403 pointing them to the main site). admin/superadmin (env
  accounts) are exempt; `localhost`/`*.localhost` is exempt so local/dev testing isn't
  blocked. Enforced server-side; a wrong-portal login is a clean 403, not a failed attempt.
- `requireRole(req,res,[...])` returns the user or sends 401/403; **admin is
  auto-allowed**. `sku-search` allows `warehouse` + `ph_team` + `supplier`.
  **`isPrivileged` is never the right check for a supplier scope** — role `supplier` is
  never privileged, and an admin isn't scoped to a supplier id, so scoping code branches
  on `role === 'supplier'` directly (`po/list`, `payout/presets`).

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

## Password reset (self-request → admin issues temp → forced change)
- `users.reset_requested_at` (self-request stamp) + `users.must_change_password`
  (temp-password issued, change required). Both added idempotently in `db-setup`.
- **Flow:** user taps "Forgot password?" on sign-in → `POST /api/auth/request-reset`
  (public, rate-limited, ALWAYS a generic reply — no enumeration) stamps
  `reset_requested_at` on the approved account. It surfaces in Check Access as a
  "reset requested" badge. Admin clicks Reset password → `admin/reset-password`
  (`adminResetPassword`) sets a temp hash, `must_change_password=true`, clears the
  request, and returns the temp password once. User signs in with it → login puts
  `mustChange` in the **signed token** → client shows `ForcedPasswordChange` (blocks the
  app) and `requireRole`/`requireAdmin` reject every gated call with **428** until
  `POST /api/auth/change-password` sets a new hash, clears the flag, and returns a fresh
  token. `requireAuth` stays open so change-password itself works.
- Env `admin`/`superadmin` have no DB row — not resettable here; their passwords live in
  Railway env.
