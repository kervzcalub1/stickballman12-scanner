# Deploying to Vercel

A step-by-step guide to put the Stickballman12 Shoe Scanner live on
`*.vercel.app`. Two paths are covered — **GitHub import (recommended)** and
the **Vercel CLI**. Pick one.

---

## 0. Before you start — what won't be uploaded

Your secrets live in `.env`, which is **gitignored** and will NOT be pushed or
deployed. You re-enter them in Vercel's dashboard as Environment Variables
(Step 3). This is by design — secrets never sit in the repo or the browser.

The values you'll need handy:

| Variable | What it is | Source |
|---|---|---|
| `ALIAS_EMAIL` | Alias account email | `teamstickballman12llc@gmail.com` |
| `ALIAS_PASSWORD` | Alias account password | (from `api.rtf`) |
| `KICKSDB_KEY` | KicksDB API key | `KICKS-…` (from `api.rtf`) |
| `APP_PASSWORD` | Password users type to enter the app | **choose a strong one** |
| `SESSION_SECRET` | Signs login sessions (min 16 chars) | **generate one** (below) |
| `SHEET_WEBHOOK_URL` | n8n **production** webhook | your n8n workflow |

**Generate a fresh `SESSION_SECRET`** (don't reuse the local one):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Ready-to-use values generated for you (you may use these or make your own):

```
SESSION_SECRET = 03dc9de9e4b958f9d7e9428bfe09b57f88ba4da05bda25f23754b088445fc01d
APP_PASSWORD   = tWHu_qKWKspK     (or pick something you'll remember)
```

> ⚠️ The n8n URL in your `.env` is the **test** webhook. For production, make
> sure the n8n workflow is **Active** and use its **Production** webhook URL.

---

## Path A — GitHub import (recommended)

### 1. Put the project on GitHub

From the project folder (`/Users/kervz/Stickballman12`):

```bash
git init
git add .
git commit -m "Stickballman12 shoe scanner"
```

Create an empty repo on GitHub (e.g. `stickballman-scanner`), then:

```bash
git remote add origin https://github.com/<you>/stickballman-scanner.git
git branch -M main
git push -u origin main
```

> Double-check `.env` is **not** in the push: `git status` should not list it,
> and `git ls-files | grep .env` should return nothing (only `.env.example`).

### 2. Import into Vercel

1. Go to <https://vercel.com/new> and sign in (use "Continue with GitHub").
2. Click **Import** next to your `stickballman-scanner` repo.
3. Vercel auto-detects the framework as **Vite** — leave the build settings
   as-is (Build Command `vite build` / `npm run build`, Output `dist`).
4. **Do not deploy yet** — open **Environment Variables** first (Step 3).

### 3. Add Environment Variables

In the import screen (or later under **Project → Settings → Environment
Variables**), add each row from the table in Step 0. For each one, leave all
three environments checked (**Production**, **Preview**, **Development**):

```
ALIAS_EMAIL         teamstickballman12llc@gmail.com
ALIAS_PASSWORD      <your alias password>
KICKSDB_KEY         <your kicksdb key>
APP_PASSWORD        <strong password>
SESSION_SECRET      <generated 64-char hex>
SHEET_WEBHOOK_URL   <n8n PRODUCTION webhook url>
```

### 4. Deploy

Click **Deploy**. First build takes ~1–2 minutes. When it finishes you'll get
a URL like `https://stickballman-scanner.vercel.app`.

---

## Path B — Vercel CLI (no GitHub)

```bash
npm i -g vercel          # install the CLI
cd /Users/kervz/Stickballman12
vercel login             # opens browser to sign in

# First deploy (creates the project). Accept the Vite detection.
vercel

# Add each secret (run once per variable; choose Production + Preview + Dev):
vercel env add ALIAS_EMAIL
vercel env add ALIAS_PASSWORD
vercel env add KICKSDB_KEY
vercel env add APP_PASSWORD
vercel env add SESSION_SECRET
vercel env add SHEET_WEBHOOK_URL

# Promote to production with the env vars applied:
vercel --prod
```

---

## 5. Verify the live site

1. Open the `*.vercel.app` URL.
2. Sign in with your `APP_PASSWORD`.
3. **Enter SKU** → search `AR3565-012` → confirm Name, SKU, and one image.
4. **Scan / Enter Barcode (UPC)** → type `196608067795` → Enter → confirm result.
5. Add a size + quantity, click **Send to Sheet** → expect
   *"Product successfully added to monitoring sheet."* and a new row in your
   Google Sheet.
6. Try the **Camera** tab on a phone — it works because Vercel serves HTTPS
   (camera access requires HTTPS or localhost).

> Doing real test sends? Delete the test rows from your sheet afterward.

---

## Updating later

- **GitHub path:** just `git push` — Vercel auto-builds and redeploys `main`.
  Pull requests get their own preview URLs automatically.
- **CLI path:** `vercel --prod` again.
- **Changed an env var?** Edit it in **Settings → Environment Variables**, then
  **redeploy** (env changes don't apply to existing deployments until a new build).

---

## Custom domain (optional)

**Project → Settings → Domains → Add** your domain and follow the DNS
instructions. HTTPS is provisioned automatically.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| "Server auth is misconfigured (SESSION_SECRET)" on login | `SESSION_SECRET` missing or under 16 chars in Vercel → add it, redeploy. |
| Login always says wrong password | `APP_PASSWORD` not set in Vercel, or set but you typed a different value. |
| Anyone gets in without a password | `APP_PASSWORD` is **empty** in Vercel → the gate is disabled by design. Set it. |
| "Server is missing Alias credentials / KicksDB key" | `ALIAS_*` / `KICKSDB_KEY` not set for that environment → add + redeploy. |
| Send to Sheet says "not configured yet" (stub) | `SHEET_WEBHOOK_URL` not set → add the production n8n URL + redeploy. |
| Send to Sheet times out / fails | n8n workflow not **Active**, or wrong (test vs production) URL. |
| Camera tab won't start | Must be HTTPS (Vercel is) and the user must grant camera permission. |
| Env var change didn't take effect | Redeploy — env vars apply at build time. |

---

## Security checklist before going public

- [ ] `APP_PASSWORD` is set and strong (this is the only thing standing between
      the public and your Alias/KicksDB usage).
- [ ] `SESSION_SECRET` is a fresh 32-byte random value, not the local dev one.
- [ ] `SHEET_WEBHOOK_URL` points at the **production** n8n webhook.
- [ ] `.env` was never committed (`git ls-files | grep '^\.env$'` returns nothing).
- [ ] Rotated the local dev `APP_PASSWORD` (`stickball2026`) — don't reuse it in prod.
