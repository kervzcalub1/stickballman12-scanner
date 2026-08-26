# Rescale (restock + request/audit)

Two connected flows: warehouse rescales stock; PH requests a rescale (audit).

## Warehouse rescale → PH restock worklist
- Rescale intake (Receiving `mode='rescale'`) or a VIN re-scan (`api/items/rescale.js`
  → `rescaleItem`) sets `items.restock_pending = true` and logs a `rescaled` event.
- PH **Rescale Stock** (`PHGrid kind='rescale'`) is a worklist of
  `restock_pending` units (dated by the latest `rescaled` event), excluding no_box.
- PH re-lists (price + II/AL/SX/SH) and clicks **✓ Restocked** →
  `api/items/restock-done.js` (`markRestocked`) clears the flag → the unit drops
  off the worklist and behaves as normal inventory.

## PH request rescale → warehouse audit (reported vs actual)
- **PH** submits via `RescaleRequestForm`: SKU (with **Search** → auto-fill name),
  sizes + qty (reported), current price, reason (mismatch | quantity | recount |
  returned | relisting | other), note. → `api/rescale-requests/create.js`
  (`createRescaleRequest`). Status `open`.
- **Warehouse** opens **Rescale Requests** (`RescaleRequestsReport` with
  `canAudit`), clicks **🔍 Audit shelf**, enters the **actual** qty per size
  (pre-filled from reported; can add sizes / set 0) + audit note →
  `api/rescale-requests/audit.js` (`auditRescaleRequest`). Status → `audited`.
- **Shared report** (both roles): `RescaleCompare` renders a grid —
  **Reported (top) / Actual (bottom)** per size. Cell highlight: **red** =
  mismatch (`rcmp-diff`), **green** = match (`rcmp-match`). Filter Open /
  Audited / All + date. PH can `+ New request` (passes `canCreate`).
- **PH listing after audit** (`canCreate`, i.e. PH team): once a request is
  `audited`, its per-size listing table is shown **inline, always** (no reveal
  button) with **GI + Final price + II/AL/SX/SH per size** — a draft per request
  id (`listDrafts`), seeded from the saved `listing` else the audited **actual**
  counts. Editable for PH; read-only for others (GI/Final hidden from warehouse via
  `showPricing`). **↻ beside the Global-indicator header** (`POST /api/ph/gi-lookup`
  → `giForSkuSizes`, a generic no-save Alias lookup) fills GI per size by the SKU;
  Final auto-calcs GI + 20% (`calcFinalPrice`), both editable. **Save listing** →
  `POST /api/rescale-requests/list-update` → `updateRescaleRequestListing` stores it
  on the request (`listing` JSONB + `listed_by/at`). **Requests aren't tied to VINs,
  so this is a self-contained listing record** (it does NOT flip inventory sync
  flags — that's the Rescale Stock worklist's job).
- **PH cancels a request** it raised in error / no longer needs →
  `api/rescale-requests/cancel.js` (`cancelRescaleRequest`). Status → `cancelled`,
  with an optional reason (`cancel_note`, shown to both teams) and
  `resolved_by`/`resolved_at` reused for who ended it and when — `status` says *how*
  it ended, so only the reason needed a new column.
  - **PH team only, and deliberately NOT via `requireRole`** — that auto-allows admin,
    and withdrawing a request is the requesting team's own call. Same explicit
    `ph_team || superadmin` check the other PH-owned writes use (`ph/update.js`,
    `ph/set-goat.js`). Warehouse and admin get 403 and see no button.
  - **Only while `open`.** The `status = 'open'` in the UPDATE's WHERE is the whole
    guard: once the warehouse has audited it, that row carries a count somebody made
    standing at a shelf, and cancelling would throw it away. An audit landing while
    the confirm is open therefore wins, and PH gets a 409 that says so (the client
    reloads to show the count). Already-cancelled and missing rows report their own
    reasons — one message for all three states is wrong two-thirds of the time.
  - A **Cancelled** filter tab (PH only) and a struck-through neutral-grey pill: PH
    withdrawing its own request is a normal outcome, not an error state.
- **PH edits a request it already submitted** (2026-08-27) → `api/rescale-requests/update.js`
  (`updateRescaleRequest`). Shoe name, sizes + quantities, price, reason, note.
  - **PH team only**, via the same explicit `ph_team || superadmin` check as cancel —
    NOT `requireRole`, which auto-allows admin. It is the requesting team's own request.
  - **Only while `open`**, and the `status = 'open'` in the UPDATE's WHERE is the whole
    guard — same rule and same reason as cancelling. After an audit the reported numbers
    are one half of a comparison somebody made standing at a shelf, and editing them
    would rewrite the question their count answered. An audit landing mid-edit wins;
    PH gets a 409 that says so and the client reloads. Missing → 404, cancelled → its
    own message.
  - `edited_by` / `edited_at` are stamped and shown to **both** teams — the warehouse may
    be holding a printed or stale copy of numbers that have since changed. Only who and
    when, not a per-field diff: while a request is open nobody downstream has acted on
    it, so the old values answer no question the current ones don't.
  - **The SKU is not a free-text field here.** A request against the wrong shoe is a
    different request (cancel and re-raise) — rewriting it in place would move the
    "already open for this SKU" chip onto a shelf nobody asked about.

- Home badges: 🟡 Pending audit (open) + 🟢 Audited (done) — `pendingCounts`
  returns `rescale_requests` (open) and `rescale_requests_audited`. A cancelled
  request leaves both counts for free, since they key on `status`.
- **Timestamps render in EST** (`PH_DATETIME` + " EST"), like the rest of the app.
  They were `toLocaleString()` — the viewer's clock — while the Day/Week/Month filter
  above them buckets by the **EST calendar** (the server dates everything `AT TIME
  ZONE 'America/New_York'`). For the PH team (UTC+8) that filed a request under
  "Aug 18" and then stamped it "8/19, 12:18 AM". Fixed here and in the Inventory
  item-history timeline, which had the same `toLocaleString()`.

## Which style code(s) to count (2026-08-27)
A re-released shoe carries several style codes (`315122-111/CW2288-111` — see
`receiving.md`). A rescale request sends somebody to a shelf, and that shelf can hold
pairs filed under either code, so the request has to say which to look for.

- `SkuCodePicker` (`src/components/SkuCodePicker.jsx`) renders **only when there is a
  choice**: one button per code, plus **All N codes**. Offered in all three places a
  request is touched — the `⟳ Rescale…` row modal, the standalone form (after Search,
  from the lookup's `skuOptions`), and the edit form.
- **All codes is the default.** The widest net is the one that cannot miss pairs filed
  under the other code; narrowing to one is the deliberate act.
- **`sku` is the selection; `sku_all` is every code that matched.** Two columns, because
  storing only the selection would throw away the list needed to pick differently later
  — with `sku_all` the choice stays reversible on the edit form.
- **The selection is validated server-side against `sku_all` read from the DATABASE**,
  never against anything the client sent (`create.js` checks it against the submitted
  match set; `update.js` re-reads the request's own). Otherwise "narrow the codes" would
  be a way around the no-retargeting rule above.
- **The `⟳ Rescale requested` chip matches on code OVERLAP, not string equality**
  (`skuCodes` in `src/lib/sku.js`, the client twin of the server helper). A request
  raised against one code of a dual-code shoe is still open against the row carrying
  both; equality would have gone silent there and let PH raise duplicates.

## "Send for rescale" from a New Inventory row (2026-08-25)
PH doesn't have to leave the worklist to raise a request. Every row on **New Inventory**
(`PHGrid kind='receiving'`) carries a **⟳ Rescale…** button beside Edit; it opens
`components/RescaleRequestModal.jsx` and creates **the same `open` `rescale_requests` row**
`create.js` has always created, so everything downstream (warehouse audit → reported-vs-actual
→ PH listing after audit) is untouched. No schema change, no new endpoint.
- **It does NOT set `restock_pending`.** A request is an audit *ask*; the flag is the
  warehouse's to set when it actually rescales. The two halves stay separate.
- **Pre-filled from the row**: every size at the qty we hold, the shoe name, the SKU, and the
  current price — but the price only when every size that has one *agrees*, since the request
  has a single price field and picking one of several would put a number on it nobody chose.
  A size held with no size on file (`'—'`) comes in blank rather than sending the warehouse a
  dash to count.
- **Our count stays on screen** in an "On file" column between the size and PH's own box, and a
  row whose two counts differ goes amber with a `N reported vs M on file` total. That comparison
  is the reason for the request, and retyping it from memory on another screen is where it used
  to get lost.
- **Duplicate guard, not a block.** The grid loads every open request once (`rescale-requests/list?status=open`,
  no date range — a request raised last month is still open work) and keys them by SKU: rows with one
  get a blue **⟳ Rescale requested** chip beside the status, and the modal names who asked and when.
  A second request is still allowed — a later recount can be exactly the point. Re-read on an
  explicit reload (so the chip clears once the warehouse audits) but NOT on the 15s quiet poll.
- **PH only, and only on New Inventory** (`canEdit && kind === 'receiving'`). Admin/warehouse read the
  same component at `/report` (kind=null) where they're read-only; the warehouse doesn't raise
  requests against itself. Guarded by `e2e/ph-send-for-rescale.spec.js`.
- The pinned Action column widens to 124px on this page only (`rightStyle(which, wide)`) — at 104px
  the button's label broke across two lines inside the button.

## Notes
- **`api/items/rescale.js` rejects an in-store VIN (409)** — rescaling sets
  `restock_pending`, which would leak an in-store pair onto the PH Rescale grid;
  in-store bypasses PH entirely (`in-store.md`).
- The two halves loop: PH request → warehouse audits/rescans → restock worklist
  → PH re-lists. Reasons may be revised after team confirmation.
- `db:reset` clears `rescale_requests` along with inventory.
