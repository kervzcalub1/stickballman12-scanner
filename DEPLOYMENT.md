# Deployment Guide

End-to-end instructions to take the **Stickballman12 Shoe Scanner** from a local
folder to a live, HTTPS site.

> **Architecture (V5):** this app is a **persistent Node/Express server**
> (`server.mjs`, started with `npm start`) plus a **PostgreSQL** database. It is
> **not** serverless anymore. So you need a host that runs a long-lived Node
> process *and* gives you Postgres. That rules out PHP-style shared hosting and
> makes Vercel a poor fit (its serverless model fights our Express server,
> in-memory rate limiter, and pg connection pool).

Contents:

1. [What you need](#1-what-you-need)
2. [Choosing a host](#2-choosing-a-host)
3. [Path A — Railway (recommended, GitHub auto-deploy)](#3-path-a--railway)
4. [Path B — Render](#4-path-b--render)
5. [Path C — Hostinger VPS (manual)](#5-path-c--hostinger-vps-manual)
6. [Push the repo to GitHub](#6-push-the-repo-to-github)
7. [Verify the live site](#7-verify-the-live-site)
8. [Updating, custom domain, troubleshooting](#8-updating-custom-domain-troubleshooting)

---

## 1. What you need

**Build / run commands** (already in `package.json`):

```bash
npm install        # install deps
npm run build      # build the SPA into dist/
npm run db:setup   # create/upgrade Postgres tables (idempotent) — needs DATABASE_URL
npm start          # start the Express server (serves dist/ + /api)
```

**Environment variables** (server-side only — never sent to the browser):

| Variable         | Required | Notes |
|------------------|----------|-------|
| `DATABASE_URL`   | ✅ | Postgres connection string. Managed hosts: append `?sslmode=require` (the app auto-enables TLS for it). |
| `SESSION_SECRET` | ✅ | ≥16 chars. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `ADMIN_PASSWORD` | ✅ | Password for the `admin` account (username `admin`, name "Alex"). Use a strong value. |
| `ALIAS_EMAIL`    | ✅ | Alias account email — UPC search **fallback**. |
| `ALIAS_PASSWORD` | ✅ | Alias account password. |
| `KICKSDB_KEY`    | ✅ | KicksDB API key — SKU search + StockX product data. |
| `PORT`           | ⛔ optional | Defaults to 3000 (HTTP). On managed hosts the platform sets/proxies this for you. |
| `TLS_CERT`, `TLS_KEY`, `TLS_CA`, `HTTPS_PORT` | ⛔ optional | Only for terminating TLS **inside Node** (see Path C). Leave unset when the platform/proxy handles HTTPS. |

> The primary StockX UPC search is a keyless Railway endpoint — nothing to configure.

**One-time DB setup:** after `DATABASE_URL` is set on the host, run `npm run db:setup`
**once** to create the tables. (Re-running is safe — it's idempotent.)

---

## 2. Choosing a host

| Option | Git push auto-deploy? | Managed Postgres? | HTTPS | Ops effort | Verdict |
|--------|-----------------------|-------------------|-------|------------|---------|
| **Railway** | ✅ built-in | ✅ add-on | ✅ automatic | Low | **Recommended** — closest to the Vercel experience |
| **Render**  | ✅ built-in | ✅ add-on | ✅ automatic | Low | Great alternative |
| **Hostinger VPS** | ⛔ DIY (GitHub Action) | ⛔ install it yourself (or use Neon/Supabase) | DIY (Caddy/certbot) | High | Cheap & flexible, but you manage the box |
| Hostinger shared / Vercel | — | — | — | — | **Not suitable** for a persistent Node server |

**Recommendation:** use **Railway** (or Render) if you want "push to GitHub and it
deploys," with a managed database and automatic HTTPS. Use a **Hostinger VPS** only
if you specifically want a cheap server you control.

---

## 3. Path A — Railway

The closest thing to the Vercel "connect GitHub and it deploys" workflow.

1. [Push the repo to GitHub](#6-push-the-repo-to-github).
2. Go to **railway.app** → **New Project → Deploy from GitHub repo** → select your repo.
3. **Add the database:** in the project, **New → Database → PostgreSQL**. Railway
   provisions it and exposes a connection string variable.
4. **Set variables** on the app service (**Variables** tab): add `SESSION_SECRET`,
   `ADMIN_PASSWORD`, `ALIAS_EMAIL`, `ALIAS_PASSWORD`, `KICKSDB_KEY`, and set
   `DATABASE_URL` to reference the Postgres service — Railway lets you pick
   `${{Postgres.DATABASE_URL}}`. Ensure it ends with `?sslmode=require`.
5. **Build/Start:** Railway (Nixpacks) auto-detects Node and runs
   `npm install` → `npm run build` → `npm start`. No config file needed.
6. **Create the tables (once):** open the service **Shell** (or use the Railway CLI:
   `railway run npm run db:setup`) and run:
   ```bash
   npm run db:setup
   ```
7. Railway assigns an **HTTPS URL** automatically (TLS handled at their edge — leave
   `TLS_*` unset). Open it and sign in as `admin`.
8. Every future `git push` to your default branch auto-builds and redeploys.

---

## 4. Path B — Render

1. [Push the repo to GitHub](#6-push-the-repo-to-github).
2. On **render.com** → **New → Web Service** → connect the repo.
   - **Build Command:** `npm install && npm run build`
   - **Start Command:** `npm start`
3. **New → PostgreSQL** to create a managed database; copy its **Internal**
   connection string.
4. In the web service **Environment**: add `DATABASE_URL` (the Render Postgres URL
   with `?sslmode=require`), plus `SESSION_SECRET`, `ADMIN_PASSWORD`, `ALIAS_EMAIL`,
   `ALIAS_PASSWORD`, `KICKSDB_KEY`.
5. **Create the tables (once):** in the service **Shell**, run `npm run db:setup`.
6. Render serves it over **HTTPS** automatically. Future pushes auto-deploy.

---

## 5. Path C — Hostinger VPS (manual)

Use Hostinger's **VPS (KVM)**, not shared hosting. You manage the server.

1. **Provision:** buy a KVM VPS with **Ubuntu**; note its public IP.
2. **SSH in** and install the toolchain:
   ```bash
   # Node 18+ (via NodeSource), Postgres, git, Caddy (auto-HTTPS)
   sudo apt update
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt install -y nodejs postgresql git
   sudo apt install -y caddy
   sudo npm i -g pm2
   ```
3. **Database:**
   ```bash
   sudo -u postgres createuser --createdb sbm
   sudo -u postgres createdb stickballman -O sbm
   ```
   (Either keep Postgres local, or point `DATABASE_URL` at a managed Neon/Supabase
   database with `?sslmode=require` to avoid running the DB yourself.)
4. **Get the code & configure:**
   ```bash
   git clone https://github.com/<you>/<repo>.git shoe-scanner
   cd shoe-scanner
   npm install
   cp .env.example .env     # then edit .env with the vars from §1
   npm run db:setup
   npm run build
   ```
5. **Run it under a process manager** (survives crashes/reboots):
   ```bash
   pm2 start "npm start" --name shoe-scanner
   pm2 save && pm2 startup     # follow the printed command to enable on boot
   ```
   The app now listens on `http://127.0.0.1:3000`.
6. **HTTPS — choose one:**
   - **Caddy reverse proxy (easiest, auto Let's Encrypt).** Put this in
     `/etc/caddy/Caddyfile`, then `sudo systemctl reload caddy`:
     ```
     your-domain.com {
         reverse_proxy 127.0.0.1:3000
     }
     ```
   - **Or terminate TLS in Node:** get certs (e.g. certbot), set `TLS_CERT`,
     `TLS_KEY` (and `HTTPS_PORT=443`) in `.env`, and restart — the app serves HTTPS
     and 301-redirects HTTP→HTTPS itself.
7. **DNS:** point your domain's **A record** at the VPS IP.
8. **Auto-deploy from GitHub (optional):** add a GitHub Action that SSHes in and
   redeploys on push:
   ```yaml
   # .github/workflows/deploy.yml
   name: Deploy
   on: { push: { branches: [main] } }
   jobs:
     deploy:
       runs-on: ubuntu-latest
       steps:
         - uses: appleboy/ssh-action@v1
           with:
             host: ${{ secrets.VPS_HOST }}
             username: ${{ secrets.VPS_USER }}
             key: ${{ secrets.VPS_SSH_KEY }}
             script: |
               cd ~/shoe-scanner
               git pull
               npm install
               npm run build
               pm2 restart shoe-scanner
   ```
   Add `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY` as repo **Settings → Secrets**.

---

## 6. Push the repo to GitHub

```bash
cd /Users/kervz/Stickballman12
git add -A
git commit -m "Prepare for deployment"
# create an empty repo on github.com first, then:
git remote add origin https://github.com/<you>/<repo>.git
git branch -M main
git push -u origin main
```

> `.env` is git-ignored — secrets are **never** committed. You set them in the
> host's environment settings (or the VPS `.env`).

---

## 7. Verify the live site

1. Open the site URL (HTTPS).
2. Sign in as **`admin`** with your `ADMIN_PASSWORD`.
3. Create a warehouse account (Sign up), approve it from **Check Access**.
4. Receive a test item, confirm it appears in **Inventory** and the **Report**.
5. Refresh on `/inventory` — it should stay on the page (path routing works).

---

## 8. Updating, custom domain, troubleshooting

- **Updating:** Railway/Render redeploy on every `git push`. On the VPS, the GitHub
  Action (or a manual `git pull && npm install && npm run build && pm2 restart`)
  does it.
- **Schema changes:** after pulling code that adds columns/tables, run
  `npm run db:setup` again (idempotent).
- **Custom domain:** Railway/Render → add the domain in the dashboard and set the
  DNS record they show (TLS is issued automatically). VPS → point DNS at the IP;
  Caddy issues the cert on first request.
- **Single instance only:** the burst rate-limiter is **in-memory per process**, so
  run **one** instance. (The login brute-force throttle is DB-backed and works
  across instances.) If you must scale horizontally, move the in-memory limiter to
  the database first.
- **Troubleshooting:**
  - *500 "Database is not configured"* → `DATABASE_URL` missing/wrong, or
    `npm run db:setup` never ran.
  - *Login fails for everyone* → `SESSION_SECRET` missing or under 16 chars.
  - *UPC/SKU lookups fail* → check `ALIAS_EMAIL`/`ALIAS_PASSWORD` and `KICKSDB_KEY`.
  - *Managed Postgres connection errors* → ensure `?sslmode=require` is on the URL.
  - *Logs:* Railway/Render dashboards; VPS → `pm2 logs shoe-scanner`.
