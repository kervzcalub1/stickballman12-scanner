# Deploying to Vercel — Full Guide

End-to-end instructions to take the **Stickballman12 Shoe Scanner** from a
local folder to a live `*.vercel.app` site, including the Google Sheets setup.

Work top to bottom the first time:

1. [Prerequisites](#1-prerequisites)
2. [Set up the Google Sheet + service account](#2-set-up-the-google-sheet--service-account)
3. [Gather your environment variables](#3-gather-your-environment-variables)
4. [Deploy — Path A (GitHub) or Path B (CLI)](#4-deploy)
5. [Verify the live site](#5-verify-the-live-site)
6. [Updating, custom domain, troubleshooting](#6-updating-later)

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

Quick local sanity check before deploying:

```bash
cd /Users/kervz/Stickballman12
npm install
npm run build      # should finish with "✓ built"
```

---

## 2. Set up the Google Sheet + service account

"Send to Sheet" writes directly to Google Sheets using a **service account**
(a robot Google account). You do this once.

### 2.1 Create / prepare the spreadsheet

1. Create a Google Sheet (or open the existing monitoring sheet).
2. Make **row 1** the header, in this exact column order (**9 columns, A–I**):

   | A | B | C | D | E | F | G | H | I |
   |---|---|---|---|---|---|---|---|---|
   | unique_id | Product Name | SKU | Size | Quantity | Price | Remarks | Status | Added by |

   The app appends one row per size as
   `[unique_id, Name, SKU, Size, Quantity, "", "", "Not Added", ""]` — Price,
   Remarks, and Added by are left blank and **Status** is set to `Not Added`.
3. **`unique_id` column (A) — hide + protect it.** The app writes a short id
   here and uses it to detect/repair rows that get overwritten when two people
   submit at the same instant (see §2.5). Set it up so the **app can write it
   but people can't**:
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

### 2.5 How `unique_id` keeps concurrent writes safe (FYI)

Google's append can silently overwrite a row when two people submit at the
exact same moment. To prevent lost data, the server writes a short unique id in
column **A**, then reads it back and re-writes any row that got overwritten
(bounded retries). You don't configure anything beyond §2.1 step 3 — just keep
column A present, hidden, and protected with the service account as an editor.

---

## 3. Gather your environment variables

Your secrets live in `.env`, which is **gitignored** — it is never pushed or
deployed. You re-enter these in Vercel (Step 4). Have these ready:

| Variable | What it is | Source |
|---|---|---|
| `ALIAS_EMAIL` | Alias account email | `api.rtf` (`teamstickballman12llc@gmail.com`) |
| `ALIAS_PASSWORD` | Alias account password | `api.rtf` |
| `KICKSDB_KEY` | KicksDB API key | `api.rtf` (`KICKS-…`) |
| `APP_PASSWORD` | Password users type to enter the app | **choose a strong one** |
| `SESSION_SECRET` | Signs login sessions (min 16 chars) | **generate** (below) |
| `GOOGLE_SHEET_ID` | Spreadsheet ID from its URL | Step 2.1 |
| `GOOGLE_SHEET_TAB` | Tab name (optional, defaults to `Sheet1`) | Step 2.1 |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Service account `client_email` | Step 2.3 |
| `GOOGLE_PRIVATE_KEY` | Service account `private_key` (PEM, `\n` escaped) | Step 2.3 |

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

## 4. Deploy

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

Add every row from the Step 3 table, with **Production, Preview, and
Development** all checked:

```
ALIAS_EMAIL                   teamstickballman12llc@gmail.com
ALIAS_PASSWORD                <your alias password>
KICKSDB_KEY                   <your kicksdb key>
APP_PASSWORD                  <strong password>
SESSION_SECRET                <generated 64-char hex>
GOOGLE_SHEET_ID               <spreadsheet id>
GOOGLE_SHEET_TAB              Sheet1
GOOGLE_SERVICE_ACCOUNT_EMAIL  <…@….iam.gserviceaccount.com>
GOOGLE_PRIVATE_KEY            "-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----\n"
```

**4. Deploy** → first build takes ~1–2 min → you get a URL like
`https://stickballman-scanner.vercel.app`.

### Path B — Vercel CLI (no GitHub)

```bash
npm i -g vercel
cd /Users/kervz/Stickballman12
vercel login                 # opens browser to sign in

vercel                       # first deploy; accept the Vite detection

# Add each secret (run once per variable; choose Production + Preview + Dev):
vercel env add ALIAS_EMAIL
vercel env add ALIAS_PASSWORD
vercel env add KICKSDB_KEY
vercel env add APP_PASSWORD
vercel env add SESSION_SECRET
vercel env add GOOGLE_SHEET_ID
vercel env add GOOGLE_SHEET_TAB
vercel env add GOOGLE_SERVICE_ACCOUNT_EMAIL
vercel env add GOOGLE_PRIVATE_KEY

vercel --prod                # promote to production with env vars applied
```

---

## 5. Verify the live site

1. Open the `*.vercel.app` URL. The tab **favicon** and the **login/top-bar
   logo** should show the circular Stickballman12 logo. (Favicons cache hard —
   open a fresh tab if it looks stale.)
2. Sign in with your `APP_PASSWORD`.
3. **Enter SKU** → search `AR3565-012` → confirm Name, SKU, an image, and the
   **size/quantity table** listing the full size run in numeric order
   (1, 1.5, 2 … or 5W, 5.5W …).
4. **Scan / Enter Barcode (UPC)** → type `196608067795` → Enter → confirm a
   result. (UPC tries **StockX** first and falls back to **Alias**; a StockX hit
   shows the single resolved size + quantity box, an Alias hit shows the table.)
5. Set quantities with the − / + steppers; optionally add a manual size in the
   blank row (＋ adds more rows).
6. **Send to Sheet** → a green success dialog (*"Added N size(s)…"*) and new
   rows appear across columns **A–I**, each with a value in `unique_id` (col A)
   and **Status = Not Added** (col H).
7. On a phone, try the **Camera** tab — it works because Vercel serves HTTPS
   (camera access requires HTTPS or localhost). The ⚙ **Settings** menu (and the
   in-camera 1×/2× toggle) controls camera zoom.

> Doing real test sends? Delete the test rows from your sheet afterward.

---

## 6. Updating later

See **[UPDATE_VERSION.md](./UPDATE_VERSION.md)** for the full push-an-update
checklist (including any sheet-layout migrations). In short:

- **GitHub path:** `git push origin main` — Vercel auto-builds and redeploys
  `main`; pull requests get their own preview URLs automatically.
- **CLI path:** run `vercel --prod` again.
- **Changed an env var?** Edit it in **Settings → Environment Variables**, then
  **redeploy** — env changes only apply to a new build.

---

## 7. Custom domain (optional)

**Project → Settings → Domains → Add** your domain and follow the DNS
instructions. HTTPS is provisioned automatically.

---

## 8. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| "Server auth is misconfigured (SESSION_SECRET)" on login | `SESSION_SECRET` missing or under 16 chars → add it, redeploy. |
| Login always says wrong password | `APP_PASSWORD` not set in Vercel, or you typed a different value. |
| Anyone gets in without a password | `APP_PASSWORD` is **empty** → the gate is disabled by design. Set it. |
| "Server is missing Alias credentials / KicksDB key" | `ALIAS_*` / `KICKSDB_KEY` not set for that environment → add + redeploy. |
| UPC search fails after working a while | Alias token expired — the app auto-relogins and retries; if it persists, check `ALIAS_EMAIL`/`ALIAS_PASSWORD`. |
| Send to Sheet says "not configured yet" (stub) | One of `GOOGLE_SHEET_ID` / `GOOGLE_SERVICE_ACCOUNT_EMAIL` / `GOOGLE_PRIVATE_KEY` not set → add + redeploy. |
| Send to Sheet fails with 403 / permission error | Share the spreadsheet with the service account email as **Editor** (Step 2.4). If only some columns fail, the service account isn't an editor of the protected `unique_id` column — add it to that protection's allowed editors (Step 2.1.3). |
| Send to Sheet fails with "Unable to parse range" | `GOOGLE_SHEET_TAB` doesn't match a real tab name. |
| Send to Sheet fails with an auth/key error | `GOOGLE_PRIVATE_KEY` lost its `\n` escapes or quotes → re-paste it. |
| Data written to the wrong columns / `unique_id` empty | The sheet is still the old 7-column layout. Update row 1 to the **9-column A–I** order (Step 2.1). |
| "Sheet write could not be confirmed … concurrent writes" | A burst exceeded Google's per-user write quota (~60/min). It's safe (no silent loss) — retry; if it's routine, reduce simultaneous submitters. |
| New rows copy the header's bold/shading | Append uses OVERWRITE by design. Make sure rows below the header are empty/unstyled. |
| Camera tab won't start | Must be HTTPS (Vercel is) and the user must grant camera permission. |
| Env var change didn't take effect | Redeploy — env vars apply at build time. |

---

## 9. Security checklist before going public

- [ ] `APP_PASSWORD` is set and strong (the only thing between the public and
      your Alias/KicksDB usage).
- [ ] `SESSION_SECRET` is a fresh 32-byte random value, not the local dev one.
- [ ] The Google service account email is shared as **Editor** on the sheet.
- [ ] Column **A (`unique_id`)** is hidden and protected, with the service
      account in its allowed editors (Step 2.1.3).
- [ ] The service account **JSON key file** is stored securely and not committed.
- [ ] `.env` was never committed (`git ls-files | grep -E '^\.env$'` is empty).
- [ ] Rotated the local dev `APP_PASSWORD` (`stickball2026`) — don't reuse it.
