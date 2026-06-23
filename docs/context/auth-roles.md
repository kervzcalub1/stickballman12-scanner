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

## Roles
- **admin** — full access; manages accounts; sees everything.
- **warehouse** — Receiving, Inventory, No Box, Rescale, Mark Sold/Shipped,
  Reports, Rescale Requests (audits them).
- **ph_team** — Report (New Inventory), Rescale Stock, No Box (view), Request
  Rescale (creates + views audit). Logs into a card home (`PHTeamApp`); its
  pages are URL-routed under `/ph/*` (refresh/Back/deep-link work).
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
