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
  - **The SKU IS editable**, with a **Search** button that re-fills the name and the
    shoe's code set (user's explicit call, 2026-08-27 — it had shipped read-only that
    morning). It genuinely **retargets** the request: the warehouse's queue entry
    changes shoe, and the New Inventory `⟳ Rescale requested` chip moves to whichever
    row carries the new code. That is the point — a typo caught before anyone has
    counted is cheaper to fix than to cancel and re-raise.
    - **`sku_all` is rewritten with it**, always. Leave it behind and the code picker
      offers the OLD shoe's codes for the new SKU — a request neither team can read.
    - The selection must still be a **subset of the code set submitted with it** (same
      check as `create.js`), which is what keeps `sku` and `sku_all` from drifting apart.
    - Sending no `sku` at all leaves both columns untouched, so an edit that only fixes
      a quantity can't disturb the shoe.

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

## The Rescale tab on New Inventory (2026-08-27)
A fourth tab beside Pending / In-Progress / Done, in the **`requests` violet** rather
than the listing blue — it is a different KIND of bucket, not a fourth stage of listing.

- **`phListingStatus` stays three-valued.** A fourth value would silently kill the
  ✓ Listed / ◐ Part-listed / • Not listed split chip on exactly the rows that need it.
  The tab keys on **`phTabOf(g, byVin)`** (`src/lib/ph.js`), which returns `'rescale'`
  when `rescaleRequestFor` matches and otherwise falls through to the listing state.
  Rescale **outranks** the listing state: a pair whose count is in question is not work
  PH can finish.
- **Counts on all four tabs**, off the same function the filter uses. The page defaults
  to `?st=pending`, so without them these rows would simply vanish with nothing on
  screen saying where they went.
- **`rescale_request_items (request_id, item_id)`** — `items.id`, not vin (the primary
  key, so no question about sticker formats can reach it), and a join table not JSONB
  (the grid asks item→request on every load). `ON DELETE CASCADE` both ways: removing a
  pair HARD deletes its row (`inventory.md`), which must not strand a link.
  Written by `create.js` from the VINs the **row modal** sends; a request typed on the
  standalone form names no pairs and stays unlinked, so it chips but moves nothing.
- **ALL-OR-NOTHING.** A row moves only when EVERY pair on it is linked to the same
  request. A partly-linked row would drag pairs nobody asked about out of Pending, and
  splitting the row by linked-vs-not would add a fourth dimension to a group key that
  already carries three split rules plus the edit-lock freeze. A row is all-linked by
  construction when raised off the grid; rule 2 can make it partial later (a new
  delivery of the same SKU merges in), and then it stays put and keeps the chip.
- Two states, one tab: **⟳ Awaiting count · Nd** (nothing to do yet — the day count is
  the only thing on screen saying a request nobody audits has parked its pairs) and
  **✓ Counted** (+ `N short` / `N extra`), which IS the work.
- **`status = 'closed'`** (+ `closed_by`/`closed_at`) is the terminal state the loop
  never had. `audited` was terminal, so the green home badge counted up forever and the
  linked pairs never left the tab. `POST /api/rescale-requests/close`, PH-only, from
  `audited` only.

### The listing worksheet — the count IS the guide
After an audit, what PH must list is the **warehouse's count, not ours**: the shelf held
9×4 / 9.5×5 / 10×3 while `items` knew about one pair of 9. So the pricing and the store
ticks live on the audit table (`Size · On file · Reported · Actual · Δ · Global
indicator ↻ · Final price · II · AL · SX · SH`), and the per-size table below drops them
(`guideModeFor`), keeping Qty / Cost / Note / History — the fields that still describe
the pairs we hold.

**Save writes BOTH**, which is the whole point:
- every counted size → the request's `listing` blob, documented and visible to both
  teams on Rescale Requests;
- the sizes we actually hold → the real `items` rows through the same `phUpdateGroup`
  every other row uses, so the flags land on stock and PH never ticks a shoe twice.

A size the shelf has and we don't is tagged **not on file** and can only be documented —
there is no inventory row to write to until the warehouse counts it in.

**↻ consumes `{ configured, results:[{ size, global_indicator, price, basis }] }` — an
ARRAY**, the same shape `fetchGi` on the Rescale Requests page reads; the two must not
drift. Use the server's `price` (it rounds through the configured markup) rather than
recomputing. A size Alias has no price for is simply ABSENT from `results`, so the fill
reports "2 of 3" instead of leaving blank boxes that look like a dead button.

**Layout:** `.ph-detail` is a flex ROW, so its children size to content — which left the
panel in a quarter of the drawer with a field of empty space. The count panel and the
size table are `flex: 1 0 100%`; the worksheet scrolls inside `.ph-audit-scroll` so the
row never scrolls sideways.

## Notes
- **`api/items/rescale.js` rejects an in-store VIN (409)** — rescaling sets
  `restock_pending`, which would leak an in-store pair onto the PH Rescale grid;
  in-store bypasses PH entirely (`in-store.md`).
- The two halves loop: PH request → warehouse audits/rescans → restock worklist
  → PH re-lists. Reasons may be revised after team confirmation.
- `db:reset` clears `rescale_requests` along with inventory.
