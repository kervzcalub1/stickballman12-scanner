# Deploying to Vercel — Full Guide

End-to-end instructions to take the **Stickballman12 Shoe Scanner** from a
local folder to a live `*.vercel.app` site, including the Google Sheets setup.

Work top to bottom the first time:

1. [Prerequisites](#1-prerequisites)
2. [Set up the Google Sheet + service account](#2-set-up-the-google-sheet--service-account)
3. [Set up the database (Neon Postgres)](#3-set-up-the-database-neon-postgres)
4. [Gather your environment variables](#4-gather-your-environment-variables)
5. [Deploy — Path A (GitHub) or Path B (CLI)](#5-deploy)
6. [Verify the live site](#6-verify-the-live-site)
7. [Updating, custom domain, troubleshooting](#7-updating-later)

---

## 1. Prerequisites

- **Node.js 18+** installed locally (`node -v`).
- A **Vercel account** — <https://vercel.com/signup> (free Hobby plan is fine).
- A **GitHub account** (for Path A, recommended).
- The API credentials this app depends on, from `api.rtf`:
  - **Alias** account email + password (UPC search **fallback**).
  - **KicksDB** API key (SKU search + StockX product data).
  - *(The primary StockX UPC search is a keyless Railway endpoint — nothing to
    configure.)*
- A **Google account** that owns (or can edit) the target spreadsheet.
- A **Neon Postgres** database (free tier) for user accounts — easiest via the
  Vercel **Neon integration** (§3).
- A strong **`ADMIN_PASSWORD`** you choose (for the `admin` account, name "Alex").

Quick local sanity check before deploying:

```bash
cd /Users/kervz/Stickballman12
npm install
npm run db:setup   # creates the Postgres tables (needs DATABASE_URL in .env)
npm run build      # should finish with "✓ built"
```

---

## 2. Set up the Google Sheet + service account

"Send to Sheet" writes directly to Google Sheets using a **service account**
(a robot Google account). You do this once.

### 2.1 Create / prepare the spreadsheet

1. Create a Google Sheet (or open the existing monitoring sheet).
2. Make **row 1** the header, in this exact column order (**10 columns, A–J**):

   | A | B | C | D | E | F | G | H | I | J |
   |---|---|---|---|---|---|---|---|---|---|
   | unique_id | Scanned by | Product Name | SKU | Size | Quantity | Price | Status | Remarks | Added by |

   The app writes one row per size as
   `[unique_id, ScannedBy, Name, SKU, Size, Quantity, "", "Not Added", "", ""]`.
   **Scanned by** is the signed-in user's name; Price/Remarks/Added by are blank;
   **Status** is set to `Not Added`.
3. **`unique_id` column (A) — hide + protect it.** Set it up so the **app can
   write it but people can't**:
   - Right-click column **A → Hide column**.
   - **Data → Protect sheets and ranges** → range `A:A` → **Set permissions →
     Restrict who can edit → Custom** → add the **service account email**
     (from Step 2.3) so it keeps edit access; everyone else is blocked.
4. **Status dropdown:** select column **H** (below the header) → **Data → Data
   validation** → *Dropdown* with the three options `Not Added`, `Added`,
   `With Remarks`. The app writes the literal text `Not Added`, which matches
   the first option so the dropdown stays valid.
5. Copy the **Spreadsheet ID** from the URL — it's the long string between
   `/d/` and `/edit`:
   `https://docs.google.com/spreadsheets/d/`**`<THIS-IS-THE-ID>`**`/edit`
6. Note the **tab name** (bottom-left, e.g. `Sheet1`). This is `GOOGLE_SHEET_TAB`.

### 2.2 Create a Google Cloud project + enable the Sheets API

1. Go to <https://console.cloud.google.com/> and create a project (any name).
2. With the project selected, open **APIs & Services → Library**.
3. Search for **Google Sheets API** → open it → **Enable**.

### 2.3 Create the service account + key

1. **APIs & Services → Credentials → Create credentials → Service account**.
2. Give it a name (e.g. `stickball-sheets`) → **Create and continue** → you can
   skip the optional role/permission steps → **Done**.
3. Open the new service account → **Keys** tab → **Add key → Create new key →
   JSON** → a `.json` file downloads. **Keep it safe — it's a secret.**
4. Open that JSON file. You need two fields from it:
   - `client_email` → this is `GOOGLE_SERVICE_ACCOUNT_EMAIL`
     (looks like `something@your-project.iam.gserviceaccount.com`).
   - `private_key` → this is `GOOGLE_PRIVATE_KEY`
     (a long `-----BEGIN PRIVATE KEY-----\n…` string).

### 2.4 Share the sheet with the service account ⚠️ (most-missed step)

In the spreadsheet, click **Share** and add the service account's
`client_email` as an **Editor**. Without this, every append fails with a
`403 / permission` error. (This Editor access is also what lets the service
account write the protected `unique_id` column from §2.1 step 3.)

### 2.5 How writes stay correct (FYI)

The app **consolidates**: for each size, if a row with the same **SKU + Size +
Status `Not Added` + same scanner** already exists, its quantity is increased;
otherwise a new row is appended. A *different* scanner always gets their own row.
All sheet writes are serialized by a **global lock in the database**, so
simultaneous scans can't lose a quantity. You don't configure anything beyond
§2.1 step 3 (keep column A hidden + protected with the service account as editor).

---

## 3. Set up the database (Neon Postgres)

User accounts live in Postgres. The easiest path is Vercel's Neon integration.

1. In the Vercel dashboard → your project → **Storage → Create Database →
   Neon (Postgres)** → create it and **connect it to the project**. Vercel adds
   **`DATABASE_URL`** (and `POSTGRES_*` variants) to the project env automatically.
2. **Match regions** for speed: create the database in the **same region** as
   your Vercel functions (Project → Settings → Functions → Region). The app takes
   a DB lock on every sheet write, so a co-located DB keeps writes fast.
3. **Create the tables** (once). Locally, put `DATABASE_URL` in `.env` (copy it
   from `vercel.env` after `vercel env pull`, or from the Neon dashboard), then:

   ```bash
   npm run db:setup     # creates users, login_attempts, locks — idempotent
   ```

   (Any environment with `DATABASE_URL` set can run this; it's safe to re-run.)

> **Cold starts:** Neon's free tier auto-suspends after ~5 min idle, so the first
> scan after a quiet period can take a second or two to wake the DB, then it's
> fast. A paid Neon plan can disable autosuspend.

---

## 4. Gather your environment variables

Your secrets live in `.env`, which is **gitignored** — it is never pushed or
deployed. You re-enter these in Vercel (Step 4). Have these ready:

| Variable | What it is | Source |
|---|---|---|
| `DATABASE_URL` | Neon Postgres connection string | added by the Neon integration (§3) |
| `ADMIN_PASSWORD` | Password for the `admin` account (name "Alex") | **choose a strong one** |
| `SESSION_SECRET` | Signs login sessions (min 16 chars) | **generate** (below) |
| `ALIAS_EMAIL` | Alias account email | `api.rtf` (`teamstickballman12llc@gmail.com`) |
| `ALIAS_PASSWORD` | Alias account password | `api.rtf` |
| `KICKSDB_KEY` | KicksDB API key | `api.rtf` (`KICKS-…`) |
| `GOOGLE_SHEET_ID` | Spreadsheet ID from its URL | Step 2.1 |
| `GOOGLE_SHEET_TAB` | Tab name (optional, defaults to `Sheet1`) | Step 2.1 |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Service account `client_email` | Step 2.3 |
| `GOOGLE_PRIVATE_KEY` | Service account `private_key` (PEM, `\n` escaped) | Step 2.3 |

> `APP_PASSWORD` from v1/v2 (a single shared gate) is **no longer used** —
> username/password accounts replace it.

**Generate a fresh `SESSION_SECRET`** (don't reuse the local dev one):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> ⚠️ **`GOOGLE_PRIVATE_KEY` formatting:** paste it as a **single line** with the
> literal `\n` sequences kept intact, wrapped in **double quotes**:
> `"-----BEGIN PRIVATE KEY-----\nMIIE…\n-----END PRIVATE KEY-----\n"`.
> The code converts `\n` back into real newlines at runtime. In the Vercel
> dashboard you can also paste the real multi-line key — both work.

---

## 5. Deploy

Pick **Path A** (GitHub — auto-deploys on every push) or **Path B** (CLI).

### Path A — GitHub import (recommended)

**1. Push the project to GitHub**

```bash
cd /Users/kervz/Stickballman12
git add .
git commit -m "Deploy: Google Sheets integration"
```

Create an empty repo on GitHub (e.g. `stickballman-scanner`), then:

```bash
git remote add origin https://github.com/<you>/stickballman-scanner.git
git branch -M main
git push -u origin main
```

> Confirm `.env` was **not** pushed: `git ls-files | grep -E '^\.env$'` should
> return nothing (only `.env.example` is tracked).

**2. Import into Vercel**

1. Go to <https://vercel.com/new> → **Continue with GitHub**.
2. Click **Import** next to your repo.
3. Vercel auto-detects **Vite** — leave the build settings (Build Command
   `npm run build`, Output Directory `dist`).
4. **Don't deploy yet** — expand **Environment Variables** first.

**3. Add Environment Variables**

Add every row from the Step 4 table, with **Production, Preview, and
Development** all checked. (`DATABASE_URL` is usually already there from the Neon
integration — if so, leave it.)

```
DATABASE_URL                  <added by the Neon integration>
ADMIN_PASSWORD                <strong admin password>
SESSION_SECRET                <generated 64-char hex>
ALIAS_EMAIL                   teamstickballman12llc@gmail.com
ALIAS_PASSWORD                <your alias password>
KICKSDB_KEY                   <your kicksdb key>
GOOGLE_SHEET_ID               <spreadsheet id>
GOOGLE_SHEET_TAB              Sheet1
GOOGLE_SERVICE_ACCOUNT_EMAIL  <…@….iam.gserviceaccount.com>
GOOGLE_PRIVATE_KEY            "-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----\n"
```

**4. Deploy** → first build takes ~1–2 min → you get a URL like
`https://stickballman-scanner.vercel.app`.

**5. Create the DB tables** (once) — if you haven't already run `npm run db:setup`
against this database locally (§3), do it now from any machine with the project
and `DATABASE_URL` set.

### Path B — Vercel CLI (no GitHub)

```bash
npm i -g vercel
cd /Users/kervz/Stickballman12
vercel login                 # opens browser to sign in

vercel                       # first deploy; accept the Vite detection

# Add each secret (run once per variable; choose Production + Preview + Dev).
# DATABASE_URL is usually added by the Neon integration — skip it if present.
vercel env add ADMIN_PASSWORD
vercel env add SESSION_SECRET
vercel env add ALIAS_EMAIL
vercel env add ALIAS_PASSWORD
vercel env add KICKSDB_KEY
vercel env add GOOGLE_SHEET_ID
vercel env add GOOGLE_SHEET_TAB
vercel env add GOOGLE_SERVICE_ACCOUNT_EMAIL
vercel env add GOOGLE_PRIVATE_KEY

vercel --prod                # promote to production with env vars applied
```

---

## 6. Verify the live site

1. Open the `*.vercel.app` URL — the **favicon** and **logo** show the circular
   Stickballman12 logo. (Favicons cache hard — open a fresh tab if stale.)
2. **Sign in as `admin`** with your `ADMIN_PASSWORD` → the homepage shows
   **Check Access · Bulk Scan · Rapid Scan**.
3. **Accounts:** in another browser, **Create account** (name/username/password)
   → "wait for approval". Back as admin → **Check Access** → **Approve** → the
   new employee can now sign in (sees Bulk + Rapid only).
4. **Bulk Scan:** search SKU `AR3565-012` (or scan a UPC) → set sizes/quantities
   → **Send to Sheet** → confirm dialog (image, **emphasized SKU**, size×qty) →
   **Yes** → rows appear across **A–J** with your name in **Scanned by** (col B)
   and **Status = Not Added** (col H).
5. **Rapid Scan:** scan a UPC → confirm → records **qty 1**. Re-scan the same
   SKU+size as the same user → the quantity **increments** on that row.
6. On a phone, try the **Camera** tab (works over Vercel HTTPS) — including a
   **vertically-held** barcode. The ⚙ **Settings** toggle controls 1×/2× zoom.

> Doing real test sends? Delete the test rows from your sheet afterward.

---

## 7. Updating later

See **[UPDATE_VERSION.md](./UPDATE_VERSION.md)** for the full push-an-update
checklist (including any sheet-layout migrations). In short:

- **GitHub path:** `git push origin main` — Vercel auto-builds and redeploys
  `main`; pull requests get their own preview URLs automatically.
- **CLI path:** run `vercel --prod` again.
- **Changed an env var?** Edit it in **Settings → Environment Variables**, then
  **redeploy** — env changes only apply to a new build.

---

## 8. Custom domain (optional)

**Project → Settings → Domains → Add** your domain and follow the DNS
instructions. HTTPS is provisioned automatically.

---

## 9. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Login/signup returns 500 ("Accounts are not configured") | `DATABASE_URL` not set for that environment, or tables not created → set it + run `npm run db:setup`. |
| Admin login returns 500 ("Admin login is not configured") | `ADMIN_PASSWORD` not set in Vercel → add it, redeploy. |
| "Server auth is misconfigured (SESSION_SECRET)" | `SESSION_SECRET` missing or under 16 chars → add it, redeploy. |
| Employee can't sign in ("awaiting admin approval") | Expected — an admin must Approve them in **Check Access**. |
| "Too many failed attempts" (429) | Brute-force lockout (5 wrong tries / username) — wait ~15 min. |
| First scan after idle is slow (~1–3s) | Neon free tier woke from auto-suspend; subsequent writes are fast. |
| "Server is missing Alias credentials / KicksDB key" | `ALIAS_*` / `KICKSDB_KEY` not set for that environment → add + redeploy. |
| Send to Sheet says "not configured yet" (stub) | One of `GOOGLE_SHEET_ID` / `GOOGLE_SERVICE_ACCOUNT_EMAIL` / `GOOGLE_PRIVATE_KEY` not set → add + redeploy. |
| Send to Sheet fails with 403 / permission error | Share the spreadsheet with the service account email as **Editor** (Step 2.4). If only column A fails, add the service account to the `unique_id` protection's allowed editors (Step 2.1.3). |
| Send to Sheet fails with "Unable to parse range" | `GOOGLE_SHEET_TAB` doesn't match a real tab name. |
| Data written to the wrong columns / `Scanned by` empty | The sheet isn't the **A–J** layout — fix row 1 (Step 2.1). |
| "Busy — another scan of this product is in progress" (409) | The global write lock was held longer than the wait window (e.g. DB cold start). Retry. |
| Camera tab won't start | Must be HTTPS (Vercel is) and the user must grant camera permission. |
| Env var change didn't take effect | Redeploy — env vars apply at build time. |

---

## 10. Security checklist before going public

- [ ] `ADMIN_PASSWORD` is strong (it's the admin into account approvals) and
      different from any local-dev value.
- [ ] `SESSION_SECRET` is a fresh 32-byte random value, not the local dev one.
- [ ] `DATABASE_URL` is set and the tables exist (`npm run db:setup` ran).
- [ ] The Google service account email is shared as **Editor** on the sheet.
- [ ] Column **A (`unique_id`)** is hidden and protected, with the service
      account in its allowed editors (Step 2.1.3).
- [ ] The service account **JSON key file** is stored securely and not committed.
- [ ] No secrets committed (`.env`, `vercel.env`, the SA key — all gitignored).
- [ ] Signups are admin-approved (employees can't sign in until you approve).
