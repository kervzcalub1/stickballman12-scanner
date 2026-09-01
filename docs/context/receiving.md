# Receiving (intake)

Component: `Receiving` in `src/App.jsx` (also reused for **rescale** and **in-store**
intake via `mode`). List of past batches: `BatchList`. Endpoints under `api/batches/*`,
`api/vins/reserve.js`, `api/items/lookup.js`.

**In-store buying** (`mode="instore"`) is a full 4-step wizard like receiving but with a
shipment-less header (Store/location only). Flag split: `noShipment = isRescale ||
isInstore` gates the header; the Review + Issues steps are gated on `isRescale` alone so
in-store keeps all 4. In-store is fresh stock scanned like receiving (NOT VIN-rescan).
Full detail: `in-store.md`.

**Raw 1ID mode** (`prefs.rawVins`, per person): instead of minting a VIN to print, the
warehouse scans a **pre-printed sticker** onto each pair — scan the shoe, scan the
sticker. Nothing is minted, and a pair without one can't be committed (it rides the same
`isUnresolved` machinery as a missing size). **Receiving against a PO** works the same way
with one beat instead of two — ticking the manifest row is the "scan the shoe" half, and a
sticker bar sits above the checklist. Full rules: `docs/context/vin-stock.md`.

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
   nulled). **A BLANK cost saves as NULL ("not known"), never as $0** — `toCost` in
   `api/_lib/intake.js`, the single copy all four intake paths now import. It used to be
   `Number(v)` guarded only by `isFinite && >= 0`, and `Number('')` is 0, so every
   skipped cost box was quietly recorded as a free shoe. A deliberate zero still works
   (type `0`). Blanks are backfilled later on the Costs page (`costs.md`). The **supplier dropdown is loaded from `GET /api/suppliers`** (seeded
   list + auto-saved custom names + every name already on a batch — the same
   list the Inventory supplier filter uses, see `inventory.md`); picking "Custom…" and typing a new vendor
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
     box status and **GOAT only** (`goat_only` → PH lists to Alias(GOAT) ALONE;
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

## The PO banner says whose manifest it is (2026-09-02)
Once a PO is linked at step 1, the banner has always carried **Print manifest** (Per box /
Whole order, PDF or CSV) — the sheet the warehouse prints and ticks pairs off as they
unpack, for the very common case where the supplier never taped one inside the parcel.

What it now also says is **where that list came from**. `manifestSource()` /
`manifestSourceNote()` (`src/lib/manifestSource.js`) render `.po-manifest-src` under the
banner in the two cases that need saying: **entered on the supplier's behalf** (amber —
"the supplier did not scan this order", named to the PH member who typed it) and **no
manifest at all** (red — receiving blind). A supplier-scanned manifest shows nothing,
on purpose. The same judgement is stamped on the printed sheet, so the caveat survives
the walk to the pallet — full rules in `docs/context/purchase-orders.md`.

Nothing about *which* list is used changed: PH's on-behalf lines were always the order's
expected count and still are. Guarded by `e2e/receiving-manifest-source.spec.js`, which
covers all four kinds and asserts the supplier case stays silent.

## One shoe, several style codes (2026-08-27)
A re-released shoe is sold under more than one style code, and StockX writes them all
on a single `styleId` (`315122-111/CW2288-111`). The Alias catalog only ever knows ONE
code at a time (`aliasCatalogBySku` searches on `primarySku`), so taking its reply
verbatim silently threw the rest away — the box declared two codes and the app filed
the pair under one, picked by nobody.

`skuCodes()` (`api/_lib/util.js`, beside `primarySku`, same `[/,|]` separators) returns
every code. `upc-search` / `sku-search` now return **`skuOptions`**, and resolve in this
order:
1. **One code** → unchanged.
2. **Several, but we already hold stock under one of them** → `knownSkuAmong(codes)`
   (`db.js`, ordered by unit count so one mis-keyed pair can't outvote a shelf) resolves
   it silently. **No question is asked.** Same principle as the Box Labels tool: our own
   stock before the catalogue. This runs OUTSIDE the response cache deliberately — a
   resolution baked into a cached entry would keep asking long after it was answered.
3. **Several, never received before** → the client asks.

**The ask is never a dialog.** Rapid scan's whole trade is that nothing interrupts a
scan, so a multi-code line rides the exact machinery an unknown size does: it lands in
the cart, shows an amber *"sold under N style codes — pick the one printed on the box"*
panel, is answerable in the Items list **or** on Review, and blocks Review + commit
(`needsSku` → `isUnresolved`) until it is answered.

**Asked once per shoe, not per pair:** `pickSku` writes the answer to every cart line
sharing that **option set**, and `pickedCodeFor` makes later scans of the same shoe
inherit it — so no second line is created and `sameSku` folds them together. Across
sessions, rule 2 takes over the moment the first pair commits.

Why it blocks the commit: filing a pair under the wrong code splits the SKU in the PH
grid (`groupPhSized` keys on the raw sku string) and hides it from anyone searching the
other code — the same class of silent wrong data as a missing size.

**Not covered:** `PoScanModal.jsx` (supplier PO scan-out) has its own scan loop and no
picker yet; a dual code landing on a PO line is low-stakes because reconciliation
already matches on code groups (`purchase-orders.md`).

## Finding a batch by the number on the parcel (2026-08-27)
`BatchPage.jsx` (warehouse `/batches`, PH `/ph/batches`) has a search box above the two
lists. What a person actually has in hand when they go looking is a **tracking number** —
it's on the carton, in the courier's email, in the supplier's message — and it was the one
identifier this page couldn't find a batch by.

**A batch carries tracking in two places and both are real cartons:** `batches.tracking_number`
(a single-box shipment, or whatever was typed at intake) and one per box in
`batch_boxes.tracking_number`. Searching only the first finds nothing for the multi-box
shipments, which are most of them. Both list queries now return `box_tracking_numbers`
(a `text[]` aggregate), and the matched number is printed on the row — otherwise the answer
is "some batch" rather than "this parcel's batch".

**The search runs in SQL, not over the list on screen.** `searchBatches(q, {phSafe})` in
`api/_lib/db.js`, reached as `GET /api/batches/list?q=…`. This is the point of it: the lists
show one page (25 rows) and the box in someone's hand is as likely to be from
March. Filtering the window would answer *"no such batch"* for a batch that exists, which is
the worst answer available. While the server answer is in flight the page filters what it
already has (`batchMatchesSearch`), so it reacts as you type, then widens.

**Matching is loose in the same three ways as the PO search**, through the same
`trackKey` (`src/lib/postatus.js`, imported into `db.js` as `searchTrackKey`): substring,
because people quote the last 4–6 digits; punctuation and spaces stripped, because a
number pasted from an email is `1Z 999 AA1 01 2345 6784` and a scanner types it clean; and
the **batch code** too, since that's the other thing printed on the carton. Stripping to
`A-Z0-9` also means no `%` or `_` can reach `LIKE` — the wildcards are ours. A query that
normalises to nothing (`"----"`) matches **nothing**, not everything.

⚠️ `db.js` has a *second* `trackKey` further down (whitespace-only) used to match a label to
a box. Different job, stricter rule — don't merge them.

### ⚠️ Most batches have NO boxes, and that is normal (2026-08-27)
`batch_boxes` rows exist only for a **multi-box** batch or one **received against a PO**.
The ordinary receiving wizard commits its pairs straight to the batch with `box_id` NULL
and creates no box row at all. On prod that is **165 of 190 batches — 984 pairs**,
including ones received yesterday. It is not old data.

The Batch detail page grouped every item under its box, so for all of those it rendered
*"Boxes (0) · No boxes yet"* and **none of the shoes** — over a batch whose list row said
"13 items" and showed a tracking number. Reported from the floor as *"why no boxes?"*.

Now: items with no `box_id` are listed in their own card, and the page adapts.
- **No boxes at all** → an **Items (N)** card with every pair, and the header counts
  *items* instead of showing "0 boxes" (which reads like something went missing).
- **Boxes and loose pairs** → the box list, plus a **Not in a box (N)** section, so a pair
  scanned into the batch before its boxes were recorded can't quietly disappear.
- The Boxes card itself is hidden when there is nothing to say — no boxes, none expected,
  and no way to add one.

The rule to keep: **a pair in this batch appears on this page**, whatever the box column
says. Guarded by `e2e/batch-unboxed-items.spec.js`, which seeds both shapes.

### The batch's own manifest report — PDF or CSV (2026-08-28)
`src/lib/batchReport.js` (`buildBatchReportPdf`, `buildBatchReportCsv`,
`batchReportFacts`, `batchReportRows`), offered on the Batch **detail** for any batch, PH
included — they are the ones asked "when did this land and against which order".
E2E: `e2e/batch-report.spec.js`.

**The four facts that identify a shipment on paper**, in a labelled grid across the head
of every page: **DATE ORDER** (`purchase_orders.date_of_purchase`, so it comes from the
order, not the batch), **DATE DELIVERED** (`date_received` — the day it was received here,
which is what "delivered" means to the reader), **BATCH NO.** and **PO NUMBER**. Beneath
them, every pair counted in, folded to **one line per SKU + size** — a manifest is read
against a carton, not pair by pair.

- **Where a fact is missing it is stated, not left blank**: "no purchase order", "not
  recorded", and a delivered date falling back to the creation day is marked `(created)`
  rather than passed off as a stated delivery.
- **Both formats are built from ONE input**, like the PO manifests, so a CSV can never
  disagree with the PDF of the same report. The CSV writes `loose` in the Box column for
  an unboxed pair, matching the PDF — Box is an identifier, not a quantity, so nothing
  arithmetic is lost and an empty cell reads as "missing data".
- **The four facts repeat on every CSV row.** A CSV gets sorted, filtered and pasted into
  someone else's sheet; a header block would be lost the first time that happens.
- Built client-side, jsPDF lazy-loaded, and **downloaded rather than auto-printed** —
  navigating a popup to a blob PDF is flaky across browsers (`manifestPdf.js`). A failed
  lazy import surfaces as an error, never a dead button (`label-print-csp-and-stale-chunks`).
- ⚠️ Everything DRAWN is plain ASCII: jsPDF's built-in Helvetica silently drops em-dashes
  and middots, so "—" prints as an empty cell. The page-break path repeats the header on
  every page, guarded by a 260-line test.

### Filters: date, supplier, purchase order (2026-08-28)
A bar above the search on the Batch page (warehouse and `/ph/batches` alike), using the
same markup as the PO list's so the two pages filter the same way. All four live in the
URL (`?from=&to=&supplier=&po=`) beside `?q=` and `?p=`, so a narrowed list is something
you can send someone.

- **Dates filter the day the row DISPLAYS** — `date_received` when set, else the creation
  day — and are read in **EST** (`coalesce(date_received, (created_at AT TIME ZONE
  'America/New_York')::date)`). A `created_at` is an instant, and the host's clock is not
  the one this business runs on (`CLAUDE.md`).
- **`po=none` is its own answer**, not the absence of a choice: *"what did we receive that
  no purchase order accounts for?"* is worth asking now that a batch says whether it came
  in against one.
- **Filters reach the SEARCH too.** Narrowing the list and then searching would otherwise
  quietly widen it again.
- **The open-batches card is filtered client-side** with the same criteria — it arrives
  whole from its own endpoint, and leaving it alone would show a card full of batches the
  filter excludes directly above one that honours it. It has no PO code, only whether it
  has an order, which is enough for `none`.
- **Changing a filter returns to page 1.** Narrowing while on page 4 of a 2-page result
  shows an empty list that reads as "nothing matches".
- `GET /api/batches/filter-options` fills the two pickers from what is actually ON a batch
  (suppliers that appear on one; orders with a batch linked) — a dropdown entry that
  returns nothing is a dead end. PH-filtered the same way the list is, or the options
  would leak the existence of in-store stock.
- ⚠️ A blank filter must be **no filter**: the date inputs send `''` when cleared, and
  `''::date` is an error rather than a no-op — the endpoint maps blanks to NULL.

Guarded by `e2e/batch-filters.spec.js`.

### Paging, and what Back does here (2026-08-27)
**Every batch list is paged, 25 a page, server-side** (`PAGE_SIZE` in `api/batches/list.js`,
returned with the rows so the client never guesses). `count(*) OVER ()` rides along on each
row, so one query answers both *this page* and *how many there are* — a separate count query
is a second round trip that can disagree with the page it labels. The shared `Pager`
(`components/common.jsx`) says **"26–50 of 466"**, not "page 2 of 19": the number people
check against is how many batches there ARE.

Three lists, three pagers: **Recent** (server, `?p=`), **Open batches** (client-side — that
endpoint returns them all, `?op=`), and **search results** (server, shares `?p=`).
Receiving's own **Recent** tab is paged too, with local page state rather than a URL param —
it's a panel inside the wizard, not a page you link someone to. That one is not optional
polish: once the endpoint paged, an unpagered list would have silently stopped at 25.

⚠️ **`excludeOpen=1`, and why the client no longer de-duplicates.** The Batch page lists open
batches in their own card, so it asks the query to leave them out. It used to filter them out
on the client instead — which made a page of 25 render **21 rows under a pager that said
"1–25 of 466"**. Two cards, two disjoint sets, two honest counts. Receiving's per-kind list
does *not* pass it: it shows every batch of that kind, open included.

⚠️ **An empty page is not an empty list.** The window count rides on the rows, so paging past
the end returns `total: 0` — there is no row to carry it. Both lists say *"Nothing on page N"*
with a way back to the first page, because "No batches yet" there would be a lie about the
whole list.

**Back button.** The complaint that prompted this: searching, or opening a batch, then
pressing Back walked out to the home page. Both are URL state now — `?q=` and `?b=` — and each
**pushes exactly one history entry**: opening a batch pushes one, and *starting* a search
pushes one (refining it replaces, so twenty keystrokes are still one entry). So Back closes the
batch and returns to the list **with the search still in it**, Back again clears the search,
and Back a third time leaves the page. The in-page **← Batches** button calls `history.back()`
when it was the one that pushed (tracked in a `pushedDetail` ref), so it undoes its own entry
rather than leaving a dead one for the next Back press to land on; a deep link straight to
`?b=` has no entry of ours to pop, so that clears the param instead.

This is URL state, not a `navBack` handler, which is why it works identically on the PH shell —
`PHTeamApp` routes on `pathname` and never sees the query. Guarded by
`e2e/batch-paging-and-back.spec.js`.

### The PH team can now see batches (2026-08-27)
`/ph/batches`, a **Batches** card on the PH home, rendering the same `BatchPage` with
`readOnly` — the same pattern as `/ph/inventory`. PH prices what the warehouse receives, so
*"which batch did this parcel become, and what was in it"* is their question too. Adding a
box, finishing, reopening and renumbering are warehouse work and stay hidden; those
endpoints are warehouse-only server-side, so the buttons would 403 anyway — hiding them is
honesty, not decoration.

**`PH_EXCLUDED_KINDS` is enforced server-side, from the session role, never from a query
parameter.** `list.js` passes `phSafe` into both `listBatches` and `searchBatches`; `full.js`
404s a PH request for an in-store or existing batch (404 rather than 403 — whether such a
batch exists is itself not theirs to see). `open-list.js` needs no guard because
`listOpenBatches` is `kind = 'receiving'` in its WHERE clause; if that ever widens, it needs
the same treatment. Guarded by `e2e/batch-tracking-search.spec.js`, which seeds an in-store
batch whose number *would* match and proves PH can't find it.

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
