# Upgrade Plan — Required Shipment/Condition Photos ("Intelligent Inventory Images")

**Goal:** During receiving, each shoe must have **3–5 photos** captured before the
item can be completed. Photos are **SKU-based** (one set per SKU, not per size/unit).
Since warehouse PCs have no camera, the system supports a **QR hand-off**: scan a
one-time QR with a phone → open a capture-only web page → take/upload the photos →
they appear back on the PC. The QR is **single-use** (cannot be reused once the shoe
is done); a different shoe in the same batch generates a **new** QR.

---

## 0. Decisions to confirm before building

These change the design; pick before coding.

1. **Per-SKU forever, or per-receipt?** "Actual condition when received" sounds
   per-shipment, but you said "SKU-based." Two readings:
   - **(A) Per SKU, reusable:** once a SKU has 3–5 photos, future receipts of the
     same SKU are pre-satisfied (no re-photographing). Best for "Intelligent
     Inventory Images" (catalog imagery).
   - **(B) Per receipt:** every batch/intake of that SKU needs fresh photos
     (true "condition on arrival" evidence).
   - **Recommendation: (A) with a "re-take / add" option.** Store `batch_id` +
     timestamp on each photo so we keep receipt traceability either way, and can
     switch to (B) later without a schema change.

2. **Storage backend.** Plan assumes **Cloudflare R2** (S3-compatible, 10 GB free,
   zero egress) with **direct browser→R2 presigned uploads** (bytes never pass
   through Express, so the 256 KB body cap is irrelevant). Alternative: Postgres
   `bytea` (simpler, no new account, but bloats DB — rejected for photo volume).

3. **Image spec.** Compress client-side to **~1568 px long edge, JPEG q≈0.85
   (~0.8–1.2 MB)** before upload. Good visual quality, optimal for vision models,
   ~20k–35k images in the free tier. Keep one original too? (Doubles storage —
   default: no, single optimized version.)

4. **Does the photo gate apply to no-box and rescale intake too?** Default: gate
   applies to **receiving** (boxed + no-box). Rescale intake of unlabeled stock —
   confirm. Rescanned existing VINs (rescale) are NOT gated.

---

## 1. Architecture overview

```
PC (Add Item modal, no camera)              Phone (capture page, has camera)
 │  open photo session for draft SKU         │
 │  ── POST /api/photos/session ──► server ──┤  GET /capture/<token> (PUBLIC, no login)
 │      ◄── { token, qrUrl, max:5 }          │  ── POST /api/photos/presign (token-auth)
 │  render QR (jsbarcode? no → QR lib)        │      ◄── presigned PUT url + key
 │                                            │  compress in <canvas>, PUT bytes ─► R2
 │  poll GET /api/photos/session?token=…      │  ── POST /api/photos/attach (token-auth)
 │   ◄── { photos:[{key,url}], status }       │      records keys, enforces 3–5
 │  show thumbnails, enable "Complete item"   │  shows ✓ done; token now locked
 ▼                                            ▼
On batch commit: photo keys travel with each cart item →
server writes sku_photos rows (sku + batch_id + r2_key) → session consumed.
```

**Why presigned direct-to-R2:** the existing JSON pipeline caps bodies at 256 KB
(`api/_lib/util.js`), far below a ~1 MB photo. Presigned PUTs let the phone upload
straight to R2 over HTTPS (already allowed by `connect-src 'self' https:` in the
CSP). Server only handles tiny JSON (tokens, keys), so no infra changes to limits.

**Public capture page:** the phone has no app session, so the capture page and its
two endpoints authenticate via the **session token in the QR**, not a Bearer login.
Token = unguessable, single-use, short TTL, scoped to one SKU + photo count.

---

## 2. New dependencies

- `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` — S3-compatible client for
  R2 presigning (server-side only).
- A QR generator for the PC modal — `qrcode` (renders to canvas/dataURL). (We can't
  reuse `jsbarcode`; that's 1-D barcodes.)
- No image-processing dep needed — compression done in-browser via `<canvas>`.

---

## 3. Cloudflare R2 setup (one-time, outside code)

1. Create R2 bucket, e.g. `sbm-inventory-photos`.
2. Create an API token (Access Key ID + Secret) scoped to that bucket.
3. **CORS policy on the bucket** allowing `PUT` from the app origin(s):
   ```json
   [{ "AllowedOrigins": ["https://<railway-app-domain>", "http://localhost:5173"],
      "AllowedMethods": ["PUT","GET"], "AllowedHeaders": ["*"], "MaxAgeSeconds": 3600 }]
   ```
4. Decide read access: **public bucket / custom domain** (simple `<img src>`), or
   keep private and serve via **presigned GET URLs** (more secure, URLs expire).
   - Recommendation: **private + presigned GET**, generated when listing photos.
5. New env vars (server-side only, never committed — `.env` is git-ignored):
   `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`,
   and optionally `R2_PUBLIC_BASE_URL` (if using a public custom domain).
   Add these to Railway env too (see `docs/context/deploy.md`).

---

## 4. Database changes (`scripts/db-setup.mjs` — idempotent)

Per CLAUDE.md: add `CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` and run
`db:setup` on **every** environment (schema-drift is the #1 trap).

```sql
-- Photo capture sessions (the QR hand-off). One row per "photograph this shoe" job.
CREATE TABLE IF NOT EXISTS photo_sessions (
  token        TEXT PRIMARY KEY,            -- crypto-random, lives in the QR URL
  sku          TEXT NOT NULL,
  name         TEXT,
  min_photos   INT  NOT NULL DEFAULT 3,
  max_photos   INT  NOT NULL DEFAULT 5,
  status       TEXT NOT NULL DEFAULT 'open',-- open | complete | consumed | expired
  created_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL         -- e.g. now() + 30 min
);
CREATE INDEX IF NOT EXISTS photo_sessions_open_idx
  ON photo_sessions (status) WHERE status = 'open';

-- Photos uploaded against a session (staging before batch commit).
CREATE TABLE IF NOT EXISTS photo_session_files (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token       TEXT NOT NULL REFERENCES photo_sessions(token) ON DELETE CASCADE,
  r2_key      TEXT NOT NULL,
  bytes       INT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Permanent SKU → photo set, written on batch commit (Intelligent Inventory Images).
CREATE TABLE IF NOT EXISTS sku_photos (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sku         TEXT NOT NULL,
  r2_key      TEXT NOT NULL,
  batch_id    BIGINT REFERENCES batches(id) ON DELETE SET NULL,
  uploaded_by TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sku_photos_sku_idx ON sku_photos (sku);
```

**db.js functions** (follow existing shim style — no nested `sql` fragments):
`createPhotoSession`, `getPhotoSession`, `addSessionFile`, `listSessionFiles`,
`setSessionStatus`, `promoteSessionToSku(token, batchId)` (copy session files →
`sku_photos`, mark session `consumed`), `listSkuPhotos(sku)`, `skuHasPhotos(sku)`.

---

## 5. New API endpoints (`api/photos/*.js`)

All follow the house contract: `applySecurity` → auth → `rateLimit` → `getJsonBody`.

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /api/photos/session` | Bearer (`warehouse`) | Create a session for `{sku,name}`; returns `{token, qrUrl, min, max, expiresAt}`. |
| `GET /api/photos/session?token=` | Bearer (warehouse) | PC poll: `{status, photos:[{key,url}], count}` (urls = presigned GET). |
| `POST /api/photos/presign` | **token** (body `{token, contentType, bytes}`) | Validate session open/not-expired, `image/jpeg` only, size ≤ ~6 MB, count < max → return `{putUrl, key}`. |
| `POST /api/photos/attach` | **token** (body `{token, keys:[…]}`) | Record uploaded keys in `photo_session_files`; when count ≥ min, allow `status='complete'`. Enforce ≤ max. |
| `GET /api/photos/sku?sku=` | Bearer (warehouse/ph_team) | List a SKU's permanent photos (for inventory/PH/condition views). |

**Token auth helper:** add `requirePhotoToken(req, res, token)` to `util.js` — looks
up the session, checks `status==='open'` and `expires_at > now()`, else 401/410.
This is the only non-Bearer auth path; keep it tightly scoped.

**Security hardening (these endpoints are partly public):**
- Token: `crypto.randomBytes(32)` base64url — unguessable, not sequential.
- Single-use: once the shoe is completed/committed → `status='consumed'`; expired or
  consumed tokens reject presign/attach (your "QR can't be reused" requirement).
- TTL ~30 min; a stale QR auto-expires.
- Per-token upload rate limit + hard `max_photos` cap (server-enforced, not just UI).
- R2 keys are random/namespaced (`sku/<sku>/<uuid>.jpg`) to prevent enumeration.
- Presign restricts `Content-Type` and (where supported) content-length.
- Capture page sets `noindex`; no inventory data is exposed on it — only the act of
  uploading to one session.

---

## 6. The capture page (phone, public, camera-only)

Two implementation options:

- **(A) SPA route `/capture/:token`** inside `src/App.jsx` routing. The router must
  let this view render **without a session** (bypass the login gate for this path
  only). Pros: reuse build/styles. Cons: loads the full bundle; must carefully
  exempt it from auth.
- **(B) Standalone minimal page** (separate tiny Vite entry or a static HTML+JS file
  served by `server.mjs`). Pros: tiny, fully decoupled from app auth, fast on
  phones. Cons: a second build artifact / separate styling.
- **Recommendation: (B)** — a dedicated `/capture` page keeps the public surface
  small and avoids entangling the main app's auth gate. Served by adding a route in
  `server.mjs` before the SPA fallback.

Capture page behavior:
1. Read `token` from URL; call a lightweight `GET /api/photos/session-public?token=`
   to fetch `{sku, name, min, max, count, status}` (no Bearer; token only).
2. Show "Photograph: `<name>` (`<sku>`) — `count`/min–max".
3. `<input type="file" accept="image/*" capture="environment" multiple>` (opens the
   phone camera / gallery). For each file: draw to `<canvas>`, downscale to ~1568px,
   export JPEG q0.85 blob → presign → PUT to R2 → attach key.
4. Live thumbnails, delete-before-finalize, enforce 3–5.
5. "Done" → marks session `complete`; page locks ("This shoe is done — return to the
   PC"). Re-opening a consumed/expired token shows an expired notice.

---

## 7. Frontend changes — Add Item modal (`src/App.jsx`)

The draft is already **per shoe model (SKU)** — exactly the right granularity.

State additions on the draft / modal:
- `photoSession` (`{token, qrUrl, min, max}`), `photoCount`, `photos[]`,
  `photoPollTimer`.

UI in the modal (near the With Box toggle, above "Complete item"):
- **Photos section**: `Photos (count/3–5)` with status pill (Required).
- **"Add photos from phone" button** → `POST /api/photos/session` for the draft SKU
  → render QR (qrcode lib) + the capture URL as text fallback. Begin polling
  `GET /api/photos/session?token=` every ~2–3 s; render thumbnails as they arrive.
- **Direct capture (works on phones/tablets running the app itself):** same
  `<input capture>` + compress + presign + attach flow inline, reusing the session —
  so a warehouse tablet with a camera skips the QR entirely. Offer both; no device
  detection needed.
- **Gate:** disable **"Complete item ✓"** until `photoCount` is within **3–5** (and
  show why). Wire into `buildItemFromDraft` / `completeItem` (App.jsx ~line 670–711):
  carry the session `token` (and resolved keys) onto the cart item.
- **Skip case (Decision 1A):** if `GET /api/photos/sku?sku=` says the SKU already has
  ≥3 photos, show "Existing photos ✓ (view / add / replace)" and pre-satisfy the gate.

`addOrMergeItem` (merging same SKU): keep a single photo set per SKU — if both drafts
carried sessions, prefer the completed one; don't double-require.

QR single-use across a batch: each `openAddItem` / new SKU starts a **fresh session**
→ fresh QR. Completing the item consumes the prior token. This satisfies "same
process happens for the next shoe; a new QR is generated for that shoe."

---

## 8. Commit path (`api/batches/commit.js` + `db.js insertItems`)

- Cart items now include `photoToken` (and/or resolved `photoKeys`) per SKU.
- After `createBatch` + `insertItems`, call `promoteSessionToSku(token, batch.id)`
  for each item's session → writes `sku_photos` rows and marks the session
  `consumed`. Wrap so a photo-promotion hiccup doesn't lose the batch (log + soft-fail
  like VIN reservation does today).
- **Server-side enforcement:** reject commit (400) if a receiving item's SKU has
  neither a completed session with 3–5 photos nor existing `sku_photos` (don't trust
  the client gate alone).

---

## 9. Displaying the photos (read side)

- **Inventory** (`Inventory` / item detail in App.jsx) and **PH report grid**
  (`PHGrid`): add a small photo strip / lightbox per SKU via `GET /api/photos/sku`.
- This is where "Intelligent Inventory Images" pays off — the photo set is now
  queryable by SKU for any future vision/condition tooling.

---

## 10. Docs / housekeeping (per CLAUDE.md working agreements)

- Update `docs/context/receiving.md` (photo gate + QR flow), `data-model.md` (3 new
  tables + db.js fns), `architecture.md` (capture page + R2), and add an
  R2/integrations note (likely `docs/context/integrations.md` or `deploy.md` for the
  new env vars + bucket/CORS setup).
- Add the new env vars to the deploy checklist; run `db:setup` on local **and**
  Railway after merging the migration.
- `npm run build` to verify before declaring done; hard-refresh after deploy.

---

## 11. Suggested build order (phased, each independently testable)

1. **Storage spike:** R2 bucket + CORS + env; `presign` endpoint; prove a
   browser→R2 PUT + presigned GET round-trip works. *(De-risks the whole feature.)*
2. **Schema + db.js fns** (`db-setup.mjs`, run migration).
3. **Capture page** (public, token-auth, compress + upload + attach, 3–5 enforce).
4. **Session create + QR + polling** in the Add Item modal; thumbnails.
5. **Gate "Complete item"** on 3–5; carry token to cart.
6. **Commit promotion** to `sku_photos` + server-side enforcement.
7. **Read views** (inventory / PH photo strip), "existing SKU photos" reuse.
8. **Docs + deploy + db:setup on Railway.**

---

## 12. Open risks / watch-items

- **R2 CORS** must list every app origin (prod domain + localhost) or browser PUTs
  silently fail with opaque CORS errors.
- **Public capture endpoints** are the main new attack surface — keep them
  token-scoped, rate-limited, image-only, size-capped, single-use.
- **Phone ↔ PC sync** relies on polling; ~2–3 s interval is fine. (SSE/websockets are
  overkill here and the server is request/response only.)
- **Abandoned sessions** leave orphan R2 objects — add a periodic cleanup (cron or a
  sweep on `db:setup`) deleting `expired` sessions' files. (Cheap; defer if needed.)
- **HTTPS required** for phone camera access — Railway serves HTTPS, but local
  testing of the capture page on a phone needs an HTTPS tunnel (e.g. a dev proxy).
