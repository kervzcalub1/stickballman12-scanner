# Receiving (intake)

Component: `Receiving` in `src/App.jsx` (also reused for **rescale** and **in-store**
intake via `mode`). List of past batches: `BatchList`. Endpoints under `api/batches/*`,
`api/vins/reserve.js`, `api/items/lookup.js`.

**In-store buying** (`mode="instore"`) is a full 4-step wizard like receiving but with a
shipment-less header (Store/location only). Flag split: `noShipment = isRescale ||
isInstore` gates the header; the Review + Issues steps are gated on `isRescale` alone so
in-store keeps all 4. In-store is fresh stock scanned like receiving (NOT VIN-rescan).
Full detail: `in-store.md`.

## 4-step wizard (receiving / in-store) / 2-step (rescale)
1. **Shipment details** — buyer defaults to `stickballman12`; supplier + date
   required. **`api/batches/commit` now enforces supplier AND tracking # server-side**
   for a receiving batch (400 if either is blank) — a batch must be traceable to its
   shipment; rescale is exempt.
   **"No tracking number" checkbox** (`batches.no_tracking`, `header.noTracking`) is the
   only way past the tracking half: some inbounds genuinely arrive without one
   (hand-delivered, local pickup, a supplier who never sent one). It's a **stated fact,
   stored on the batch** — deliberately distinct from `tracking_number IS NULL`, which is
   just an empty field. Ticking it **clears and disables** the field, and the server
   **nulls any tracking sent alongside the flag**, so the two can never disagree. Also
   enforced client-side at step 1 (`goStep2`) so the refusal lands before every shoe has
   been scanned, not at commit. In **multi-box** it hides the per-box tracking inputs
   (rows read "No tracking number") and rides along to `createOpenBatch`; **hidden while
   receiving against a PO**, whose numbers come from the labels. It **resets after each
   commit** — left sticky, the next shipment would quietly commit as untracked. **A negative cost is rejected** (400, not silently
   nulled). The **supplier dropdown is loaded from `GET /api/suppliers`** (seeded
   list + auto-saved custom names); picking "Custom…" and typing a new vendor
   auto-saves it on commit (`addSupplier`, V6 Feature 1). Tracking typed /
   camera-scanned / OCR'd from a label photo (`src/trackingOcr.js`: zxing →
   Tesseract.js, lazy-loaded). The decoded string is normalized by
   `parseTrackingNumber` (`src/lib/codes.js`): **UPS** = a *standalone* `1Z`+16
   token; **FedEx 2D** labels decode to ISO-15434 `[)>` MH10 data whose `31Z`
   element holds the 34-digit Ground "96" barcode → **last 12 digits = tracking**
   (a bare `96…` Code-128 works too). The UPS match must be standalone so the
   field code in `…3(1Z9632…)` inside a FedEx blob can't false-match as UPS.
   As the tracking # is entered it's checked against
   past batches/boxes (`GET /api/batches/check-tracking`, debounced); a repeat
   shows a **non-blocking duplicate warning** and, if committed, sets
   `batches.duplicate_of` (V6 Feature 8).
   **Multi-box (Boxes expected > 1):** the single Tracking field is hidden and a
   **box list renders inline on this page** (`boxSlots`, synced to the count): one
   row per box with its **own tracking #** (type / camera-scan) + **"Add items"**.
   Boxes are scanned **in any order**; "Add items" runs that box through
   Items → Review → Issues → **Submit box**, then returns here. The OPEN batch is
   created **lazily on the first box commit** (`ensureBatch` → `createOpenBatch`),
   then each box is `batchAddBox` (explicit `boxNumber` = slot, so out-of-order
   boxes keep their number) + `boxCommit`. **`commitBoxItems` claims the box with an
   atomic compare-and-swap** (`UPDATE … WHERE status <> 'received' RETURNING id`)
   **before** inserting items, so two concurrent commits can't both insert →
   duplicates (TOCTOU); the loser 409s ("already submitted"). **Finish batch** closes it (or it
   auto-completes when received == expected); leaving via Home keeps it open to
   resume from the Batches page. Single-box (=1) keeps the original one-shot
   `batchCommit`; "Add box" from the Batches page still drives box-mode
   (`batchContext`).
   **Box slots with a tracking # persist even before items are added**
   (`persistBoxSlots` → `POST /api/batches/sync-boxes` → `syncBatchBoxes`, called
   after the batch is created, on tracking blur/scan, and at Finish). So a box
   whose tracking was scanned but got **0 items** still shows on the Batch page
   (with a red 0-item count) instead of disappearing. Only **tracking-bearing**
   slots are materialized (blank slots are left out so the "Add box" next-number
   logic isn't thrown off); `addBatchBox` is now **find-or-create by box number**,
   so committing a pre-materialized slot re-uses its row instead of duplicating.
   The Batch page (`getBatchWithBoxes` now also returns `items`) lets each box row
   **expand to its shoes** — VIN → full detail/history via `onOpenItem`.
   **Continuing a pending box** (`onAddBox(batch, box)` → `batchContext.box` →
   `boxTarget`): each non-received row has its own **"Add items"**, which opens
   Receiving in box-mode **aimed at that box** — its tracking prefills the header and
   the commit passes `boxNumber = box.box_number`, so `addBatchBox`'s find-or-create
   **reuses that row**. `+ Add box` (no `box`) still means a box that isn't listed at
   all — using it to continue a pending box is what left staff with an empty box
   beside the one they meant to fill. Received boxes get no button (the box-commit
   CAS would refuse them anyway).
   **Which number a new box gets is staff's call, not a counter's** (2026-08-14).
   `+ Add box` used to hard-code max+1, which is only right while boxes arrive in
   order: box 6 of 9 turning up a day after the rest was filed as **box 10** and
   stopped matching the label on the carton. Box-mode step 1 now shows a **Box
   number** field — pre-filled with the next free number, listing what's already
   recorded, warning when the number is a box already **received** (blocked on Next)
   and saying so when it's an existing **pending** slot (which it then fills, via
   find-or-create). Receiving against a PO takes each slot's number from the
   **label's own `box_number`**, not its position in the list.
   **When the batch is being received against a PO, the tracking number picks the number
   for you** (2026-08-15): box mode loads that order's labels and, the moment the tracking
   entered matches one, sets the field to that label's number and says so in the affirmative
   ("Tracking matches Label 6 — recording it as box 6"). Not locked — a parcel can be
   re-taped with the wrong label, and the person holding it can see that. This is the fix at
   source; the reconciliation view corrects the *reading* of boxes recorded before it
   (`docs/context/purchase-orders.md`).
   **Renumbering a box already recorded**: pencil on any Batch-page box row →
   `POST /api/batches/renumber-box` → `renumberBatchBox`. Available on **received**
   boxes too (that's when the mismatch is noticed). A collision with a box that holds
   stock is refused (nothing else would stop two box 6s — there's no unique index on
   `(batch_id, box_number)`); an **empty pending** row at the target number is
   absorbed instead, and the moving box **inherits its tracking number** if it has
   none of its own — that slot is often the only place the label's tracking was
   ever written, and an empty tracking field is what breaks the PO label match.
2. **Items — rapid scan** (`rapidScan`, replaced the Add Item modal 2026-08-14).
   The scan field lives **inline on the step** (`.scanbar`, sticky) — no dialog
   between scans, because the warehouse scans box after box and every stop cost
   time. Field auto-focuses so a **HID scanner gun types straight in** (only on a
   `(pointer: fine)` device — a programmatic focus on a phone pops/traps the
   keyboard, see the iOS note below). Auto-detects UPC vs SKU. Re-scanning a shoe's
   boxes **auto-increments qty by size**; a different SKU just starts its own line
   (the old "Different shoe detected" prompt is gone with the modal).
   - **Each scan is optimistic**: the line is prepended as `pending` and the
     catalogue lookup + `reserveVins(1)` resolve behind it, so the next scan never
     waits. On resolve it either replaces the placeholder or **merges** into the
     same shoe already in the cart (same SKU + same box/GOAT status).
   - **Nothing a scan produced is ever dropped.** A failed lookup becomes a red
     line carrying the raw code with typeable name/SKU; a product with no size from
     the catalogue gets a red **`size?`** row. Both are `isUnresolved` → they block
     Review/Issues/commit (`unresolvedMsg`) until filled in, and being blocked
     **puts the cursor in the first missing field** (`focusFirstUnresolved`) — the
     error line sits above the sticky footer, far below the fold on a long cart.
     The `size?` field renders on the row's **`needsSize` flag, never on the live
     value**: keyed on the value it unmounted on the first keystroke, so a size like
     "10" could not be typed past the "1". Two sizeless scans of one shoe stay as
     two rows (two unknown sizes aren't one size scanned twice) and **fold together
     on blur** once both are typed to the same size (`mergeSizeRow`, carrying the
     units' VINs across) — on blur, not per keystroke, or "1" en route to "10" would
     dissolve into a real size-1 row mid-type.
   - **`scanBoxMode`** ("Scanning as: With box / No box") is **sticky** and applied
     to every scan — the SOP already says to scan no-box pairs separately. Per-shoe
     box status and **GOAT only** (`goat_only` → PH lists to Alias(GOAT)+II only;
     StockX/Shopify N/A) are now chips **on the cart row**, not in a draft.
   - **Undo last scan** removes that unit only (by its VIN, or the whole line if it
     hadn't merged yet). One-shot, and it outlives the flash message.
   - The **1200 ms re-read cooldown applies to the camera only** (`fromCamera` →
     `isCameraReread` in `src/lib/codes.js`, pure + unit-tested because a headless
     browser has no camera to drive). A live camera re-reads one barcode many times
     a second; a gun/typed submit is a deliberate act, and six identical boxes
     scanned back-to-back are six pairs — silently dropping the fast ones is the one
     failure this flow can't afford. The manual-add modal's `addCode` is scoped the
     same way.
   - **`+ Add manually`** opens the old modal (draft + size chips + "Complete
     item ✓") for a code the catalogue can't resolve at all; it's also what PO
     receive's "+ Add unexpected" opens.
   **Newest scanned shoe shows on top** of the cart; **sizes sort smallest→largest**
   (`compareSizes`, V6 Features 3 & 6).
   ⚠️ Scan **no-box pairs separately** so their VINs/labels don't get mixed with
   with-box pairs (see SOP-WAREHOUSE.md).
3. **Review** (V6 Feature 4) — the dedicated review-before-submit screen, size-sorted.
   With scanning no longer interrupted, **this is where a wrong catalogue answer
   gets caught** (a Nike scan that resolved to an adidas): **name and SKU are
   editable per shoe**, and **`+ Add size`** fills a missing one (reserving its VIN).
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
Photos hang off **each shoe in the cart**, not off the scan flow (moved 2026-08-14):
every row on Items + Review carries a **`PhotoCountButton`** (`n/5`, amber at 0,
green at ≥3) that opens the photo **modal**. The count is cached per SKU for the
session and invalidated when the modal closes (`invalidatePhotoCount`). Inside the
modal, a per-**SKU** photo block (`src/components/ListingPhotos.jsx`)
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
