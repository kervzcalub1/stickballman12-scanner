# Stickballman12 · Shoe Scanner

A React (Vite) web app for a shoe-inventory team to scan barcodes (or enter a
SKU), look up the shoe, and record sizes & quantities into a Google Sheet. It
has real user accounts (admin-approved), two scan modes, and concurrency-safe,
per-user sheet consolidation. Backend runs as Vercel serverless functions; user
accounts live in a Neon Postgres database.

## Accounts & roles (v3)

- **Sign in / sign up** with a username + password. New signups (name, username,
  password) are created **pending** and can't sign in until an admin approves
  them.
- **Admin** is a fixed account: username `admin`, name **Alex**, password from
  the `ADMIN_PASSWORD` env var. The admin's **Check Access** screen approves or
  rejects pending accounts.
- **Homepage** is role-based:
  - **Admin** → Check Access · Bulk Scan · Rapid Scan
  - **Employee** → Bulk Scan · Rapid Scan

## What it does

### Lookup
- **Barcode (UPC)** — **StockX UPC Search is primary**; if it returns nothing or
  errors, it rotates to the **Alias** UPC API. (Scanner-gun input or device
  camera via `@zxing`; the camera also reads **vertically-held** barcodes.)
- **SKU** — KicksDB (StockX products), returns the full size run.

### Bulk Scan
Search a product, fill a **size/quantity table** (− / + steppers; known sizes
pre-listed plus a blank manual row), then **Send to Sheet**. StockX UPC hits
show a single resolved size; Alias/KicksDB show the full table.

### Rapid Scan
Scan a barcode → **confirm** → records **quantity 1**, then re-arms for the next
scan. StockX resolves the size automatically; **Alias** asks for the size first
via selectable boxes (with a `W` suffix when the title is women's, e.g. `8W`).

### Confirm before sending (both modes)
A dialog double-checks the product **image, name, emphasized SKU, and size**
(plus quantities in Bulk). It is dismissable **only** via **Yes/No** — Yes sends,
No discards.

## Google Sheet integration

`/api/send-to-sheet` (Bulk) and `/api/rapid-send` (Rapid) write to a Google Sheet
via a service account. Columns **A–J**:

| A | B | C | D | E | F | G | H | I | J |
|---|---|---|---|---|---|---|---|---|---|
| unique_id | Scanned by | Product Name | SKU | Size | Quantity | Price | Status | Remarks | Added by |

- **Scanned by** (B) = the signed-in user's name.
- **Consolidation:** for each size, if a row with the **same SKU + Size,
  Status `Not Added`, and same scanner** exists, its quantity is increased;
  otherwise a new row is appended. A **different scanner gets their own row**
  (clear per-user tracking). Rows with status `Added` / `WITH REMARKS` are never
  merged.
- **Concurrency:** all sheet writes are serialized by a **global Postgres lock**,
  so simultaneous scans can't lose a quantity. Column **A (`unique_id`)** should
  be **hidden + protected** with the service account granted edit access.

## Security model

- **Accounts:** passwords hashed with **scrypt**; sessions are HMAC-signed,
  expiring tokens (`SESSION_SECRET`) sent as `Authorization: Bearer` on every
  API call (no cookies → no CSRF surface). The token carries the user's role;
  admin endpoints re-check it server-side.
- **Brute force:** DB-backed throttling (per-username and per-IP failure counts →
  temporary 429 lockout). Generic "incorrect username or password" (no
  enumeration). `admin` is a reserved username.
- All third-party keys (Alias, KicksDB, Google service account, `DATABASE_URL`)
  are **server-side only**; the browser only calls same-origin `/api/*`.
- Input validation, parameterized SQL, a 256 KB request-body cap, per-IP rate
  limiting, and hardened HTTP headers / CSP (`vercel.json`).

## Run locally

```bash
npm install
cp .env.example .env      # fill in values (DATABASE_URL, ADMIN_PASSWORD, GOOGLE_*, …)
npm run db:setup          # create the Postgres tables (idempotent)
npm run dev               # http://localhost:5173  (API runs via Vite middleware)
```

Sign in as `admin` with your `ADMIN_PASSWORD` to approve the first accounts.

## Deploy to Vercel

See **[DEPLOYMENT.md](./DEPLOYMENT.md)** for the full first-time guide and
**[UPDATE_VERSION.md](./UPDATE_VERSION.md)** for pushing updates.
