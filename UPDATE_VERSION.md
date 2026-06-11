# Pushing an Update to the Live App

The first version is already live on Vercel and the repo is connected to GitHub
(`origin` → `github.com/kervzcalub1/stickballman12-scanner`). Because of that
link, **Vercel auto-deploys every push to the `main` branch** — so shipping an
update is mostly "commit + push." This guide is the short, repeatable checklist
for that. For the original from-scratch setup, see
[DEPLOYMENT.md](./DEPLOYMENT.md).

---

## TL;DR

```bash
cd /Users/kervz/Stickballman12
npm run build          # 1. sanity check it builds
git add -A             # 2. stage changes
git commit -m "…"      # 3. commit
git push origin main   # 4. push → Vercel auto-builds & deploys
```

Then watch the deployment in the Vercel dashboard and [verify the live
site](#5-verify-after-deploy).

---

## 0. One-time data migration for THIS release ⚠️

**Version 3** adds accounts (database) + Rapid Scan and changed the sheet layout.
Do all of this **before/as you deploy** or it will break.

**a) Database (Neon Postgres).** In Vercel, attach the **Neon** integration to the
project (Storage → it adds `DATABASE_URL` automatically). Then create the tables
once — locally against the same DB, or via any environment that has
`DATABASE_URL`:
```bash
npm run db:setup     # creates users, login_attempts, locks (idempotent)
```

**b) New environment variables** (Vercel → Settings → Environment Variables):

| Variable | Value |
|---|---|
| `DATABASE_URL` | added automatically by the Neon integration |
| `ADMIN_PASSWORD` | **strong** password for the `admin` account (name "Alex") |
| `SESSION_SECRET` | already set (still used to sign sessions) |

`APP_PASSWORD` (the old shared gate) is no longer used and can be removed.

**c) Sheet layout — now 10 columns (A–J)** with this header in row 1:

| A | B | C | D | E | F | G | H | I | J |
|---|---|---|---|---|---|---|---|---|---|
| unique_id | Scanned by | Product Name | SKU | Size | Quantity | Price | Status | Remarks | Added by |

- **Column A (`unique_id`)**: keep **hidden** and **protected** (`A:A`) with the
  **service account** granted edit access (used to repair concurrent overwrites).
- **Column B (`Scanned by`)**: written by the app with the signed-in user's name.
- **Status** is on column **H**, **Remarks** on **I**. Status dropdown options:
  `Not Added`, `Added`, `With Remarks`.

---

## 1. Pre-flight checks (local)

```bash
cd /Users/kervz/Stickballman12
npm install        # only if package.json changed
npm run build      # must finish with "✓ built"
```

Optionally smoke-test locally against the real APIs:

```bash
npm run dev        # http://localhost:5173
```

Sign in, run a barcode/UPC scan, a SKU search, set quantities, and **Send to
Sheet** once to confirm rows land in columns A–I.

---

## 2. Commit your changes

Use the default `main` branch (the production branch Vercel builds from).

```bash
git status                       # review what changed
git add -A
git commit -m "Update: <short summary of the change>"
```

> The build output (`dist/`), `node_modules`, `.env`, and `api.rtf` are
> git-ignored and must **not** be committed. `public/` (logo + favicon) and
> `asset/` **are** committed.

---

## 3. Deploy

### Path A — GitHub push (recommended, matches the current setup)

```bash
git push origin main
```

Vercel detects the push and starts a **Production** deployment automatically.
Track it at <https://vercel.com/dashboard> → your project → **Deployments**.
A typical build takes ~1–2 minutes.

> **Preview first (optional, safer):** push to a different branch instead of
> `main` to get a throwaway Preview URL, verify it, then merge to `main` for
> production:
> ```bash
> git checkout -b update/<name>
> git push origin update/<name>     # Vercel posts a Preview URL
> # ...verify the preview, then:
> git checkout main && git merge update/<name> && git push origin main
> ```

### Path B — Vercel CLI (no Git push)

```bash
npm i -g vercel        # once
vercel login           # once
vercel link            # once — link this folder to the existing project
vercel --prod          # build & deploy straight to production
```

(Omit `--prod` to get a Preview deployment URL instead.)

---

## 4. If you changed environment variables

Not needed for this release. In general, when a change introduces a new env var:

1. Vercel dashboard → project → **Settings → Environment Variables**.
2. Add/edit the key for the **Production** environment (and Preview if used).
3. **Redeploy** — env changes only take effect on a new deployment
   (Deployments → ⋯ → **Redeploy**, or push again).

`GOOGLE_PRIVATE_KEY` must keep its `\n` escapes and be wrapped in quotes.

---

## 5. Verify after deploy

On the live `*.vercel.app` URL:

1. Hard-refresh (Cmd/Ctrl+Shift+R) so the new assets load.
2. **Favicon + logo** show the new circular image (tab icon + login screen +
   top bar). If the favicon looks stale, favicons cache aggressively — try a new
   tab or clear site data.
3. Sign in with `APP_PASSWORD`.
4. **UPC scan** (StockX primary → Alias fallback) and a **SKU search** both
   return a product with the size/quantity table.
5. Set a quantity (including a manually-added size row) and **Send to Sheet** →
   confirm a new row appears in columns **A–I**, with a value in `unique_id`.
6. Camera zoom toggle (⚙ Settings / in-camera 1×/2×) still works.

---

## 6. Rollback (if something's wrong)

Vercel keeps every previous deployment. To revert instantly:

- Dashboard → project → **Deployments** → pick the last good one → ⋯ →
  **Promote to Production** (a.k.a. *Rollback*). No rebuild needed.

Or revert in Git and push:

```bash
git revert <bad-commit-sha>
git push origin main
```

---

## Quick reference

| Task | Command |
|---|---|
| Build locally | `npm run build` |
| Ship to production | `git push origin main` |
| Preview deploy (CLI) | `vercel` |
| Production deploy (CLI) | `vercel --prod` |
| Roll back | Vercel → Deployments → Promote previous |
