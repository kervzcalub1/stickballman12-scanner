# Receiving (intake)

Component: `Receiving` in `src/App.jsx` (also reused for rescale intake via
`mode`). List of past batches: `BatchList`. Endpoints under `api/batches/*`,
`api/vins/reserve.js`, `api/items/lookup.js`.

## 4-step wizard (receiving) / 2-step (rescale)
1. **Shipment details** — buyer defaults to `stickballman12`; supplier + date
   required. The **supplier dropdown is loaded from `GET /api/suppliers`** (seeded
   list + auto-saved custom names); picking "Custom…" and typing a new vendor
   auto-saves it on commit (`addSupplier`, V6 Feature 1). Tracking typed /
   camera-scanned / OCR'd from a label photo (`src/trackingOcr.js`: zxing →
   Tesseract.js, lazy-loaded). As the tracking # is entered it's checked against
   past batches/boxes (`GET /api/batches/check-tracking`, debounced); a repeat
   shows a **non-blocking duplicate warning** and, if committed, sets
   `batches.duplicate_of` (V6 Feature 8).
   **Multi-box (Boxes expected > 1):** the single Tracking field is hidden and
   **"Start batch"** creates the OPEN batch immediately (persisted → resumable
   from the Batches page), then shows an in-receiving **box list**: one row per
   expected box with its **own tracking #** (type / camera-scan) + **"Add items"**.
   Boxes are scanned **in any order**; "Add items" runs that box through
   Items → Review → Issues → **Submit box** (`batchAddBox` with an explicit
   `boxNumber` = slot so out-of-order boxes keep their number, then `boxCommit`),
   then returns to the box list. **Finish batch** closes it (or it auto-completes
   when received == expected). "Save & exit" leaves it open to resume later.
   Single-box (=1) keeps the original one-shot `batchCommit`; "Add box" from the
   Batches page still drives box-mode (`batchContext`).
2. **Items** — `+ Add Item` opens the scanning modal. Field auto-focuses so a
   **HID scanner gun types straight in**. Auto-detects UPC vs SKU. Re-scanning a
   shoe's boxes **auto-increments qty by size**. A **With Box** checkbox sets
   `with_box` (off → status `no_box`). "Complete item" adds it to the cart.
   **Newest scanned shoe shows on top** of the cart; **sizes sort smallest→largest**
   in both the cart and the scanning modal (`compareSizes`, V6 Features 3 & 6).
   ⚠️ Scan **no-box pairs separately** so their VINs/labels don't get mixed with
   with-box pairs (see SOP-WAREHOUSE.md).
3. **Review** (V6 Feature 4) — the dedicated review-before-submit screen, size-sorted.
   Per shoe: toggle **box status**, **±qty per size** (＋ reserves a VIN, − drops the
   trailing one), remove a size, or delete the whole line. Expand a size to see its
   units; **"＋ Issue" per VIN** opens a defect editor — add one or more defects, each
   a **type** (`DEFECT_TYPES` dropdown — flagging **`no_box` also forces the unit's
   status to `no_box`** on commit, same as the box toggle) + optional note + photos
   (`src/components/DefectPhotos.jsx`, uploaded to R2 keyed by VIN via
   `api/photos/sign-issue`). Flagged units show "⚠ N issues". On commit each defect
   becomes an `item_events(type='issue')` with `{defectType, note, photos}` (see
   `commit.js` `unitIssues` → `insertIssueEvents`). Defect photos are per-VIN,
   separate from the per-SKU listing photos.
4. **Issues** — shipment-level: no-box pairs auto-listed; manual issues addable.
   Finish commits.

## VINs & commit
- On commit (`api/batches/commit.js`): `createBatch` → `reserveVins` (atomic
  `nextval('vin_seq')`) → `insertItems` → `insertIntakeEvents`.
- Each unit gets its own **VIN** (`SBM-YYMMDD-######`), visible before submit so
  staff can label. Consolidation merges identical lines but each unit keeps a VIN.
- Gaps in VIN numbering are harmless and expected; **never reuse a number**.
- First event chain: "Scanned by <user>" → "Received into inventory".
- Rescale intake (`mode='rescale'`) sets `kind='rescale'` + `restock_pending=true`
  (see `rescale.md`).
- **Global indicator price**: after responding, `enrichGlobalIndicators`
  best-effort resolves each unit's Alias `catalog_id` — **by UPC** (Alias UPC
  search) or, for SKU-only scans, **by SKU** (official catalog search) — caching it
  in `products`, then fetches the global indicator (official `api.alias.org`,
  `ALIAS_API_KEY`, region 3) per catalog_id + size and stores `global_indicator`
  (+ seeds `price` = GI×1.2). Never blocks the commit; failure leaves GI null for
  PH to fill. See `integrations.md` / `ph-report.md`.

## Listing photos (V6 Feature 5)
In the Add Item modal, a per-**SKU** photo block (`src/components/ListingPhotos.jsx`)
shows the 5 angle slots (side · diagonal · outsole · top · rear; icons in
`ShoeAngleIcons.jsx`) as an at-a-glance review and opens a **full-screen custom
camera** (`src/components/PhotoCamera.jsx`): live preview + a bottom **angle strip**
(tap an angle, hit the shutter) + a **Gallery** picker fallback; already-shot angles
show their thumbnail and can be replaced/removed. Already-photographed SKUs load
their photos in (dedupe — no re-shoot). The button reads "Add listing photos" when
empty, "View / replace photos" when the SKU already has some. Each capture is
compressed client-side (`src/lib/image.js`) and uploaded straight to **Cloudflare
R2** via a presigned PUT (`api/_lib/r2.js`, dependency-free SigV4), then recorded in
`product_photos`. Endpoints: `api/photos/{list,sign,attach,remove}.js`. Config via
`R2_*` env (see `.env.example`); unset → block hidden + endpoints return "not
configured". Bucket needs a CORS policy allowing PUT, and `R2_PUBLIC_BASE_URL` for
reads. Defect photos (Feature 4) are separate (per-VIN), not here.

`PhotoCamera` and the barcode `CameraScanner` both acquire the camera once with an
explicit `play()` + a loading/Retry overlay and stop **every** MediaStreamTrack on
close — `CameraScanner` no longer calls `setDeviceId` mid-effect (that double-start
race caused the black/stalled preview).

## Product lookup (fills name/sku/image/sizes/gender/colorway)
`searchUpc` / `searchSku` — see `integrations.md`.
