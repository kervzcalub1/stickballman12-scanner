# Purchase Orders — supplier scan-out → reconciled receiving

Full product plan: `docs/po-scanout-plan.md`. This file tracks what's **built**.

## What it is
Inbound receiving that starts **before the box arrives**. The **PH team** opens an order
(the "Form / Batch"), an external **supplier** signs in and scans what they're shipping,
the courier carries it, and the **warehouse** receives it back **against the same order** —
reconciling what was promised vs. what actually arrived. A batch spans **multiple shipping
labels** (one tracking number each); it closes only when every label is shipped.

## Link an already-received batch to its PO (+ delete a PO)
"Receive against a purchase order" is a **step-1 choice**, so when PH opens the order
*while the warehouse is already scanning the box* — it arrived before the paperwork —
the two could not be joined afterwards. The order read as still-outstanding forever and
its reconciliation showed nothing arriving, while the stock was on the shelf.

**In the app (the normal way):** PH Purchase Orders (`/ph/po-status`) → open the order →
**"Link a received shipment"** (`PoLinkBatchModal`, `src/components/PoLinkBatch.jsx`).
Pick the batch from the candidates, confirm which received box is which label
(pre-matched by tracking #), and link. The open order then shows a **"Received into"**
panel with an **Unlink** per batch, and — while nothing is linked — **"Delete this
purchase order"**.
- Endpoints: `po/link-candidates` (GET, list + per-batch preview), `po/link-batch`,
  `po/unlink-batch` (all warehouse/ph_team) and `po/delete` (ph_team/admin).
  db: `listPoLinkCandidates`, `getPoLinkPreview`, `linkBatchToPo`, `unlinkBatchFromPo`,
  `deletePo`. `getPoFull` now also returns `batches` (stripped for suppliers).
- **Linking is per BATCH, not per box** — `batches.po_id` is the join and reconciliation
  counts every unit under it. The box→label matching only fills in tracking numbers and
  picks which labels `shipLabels` may touch. Unmatched boxes still count, and the modal
  says so.
- **Delete is refused while a batch is linked** (server 409; `batches.po_id` has no
  ON DELETE rule, so the DB would refuse too). The PO code must be typed back, checked
  **server-side**. Labels/lines/resolution/comments cascade away — no undo.
- Unlink rolls `received_batch_id` to whatever batch is still linked, and an order left
  with none drops back to `shipped` (if any label has left the supplier) or `draft`.
- Both actions leave a **`system` comment** on the order — otherwise a late order with a
  fully-received batch against it is unexplainable later. Build the author as
  `Number(user.uid) || null`: the env admin/superadmin uid is **not numeric** and
  `po_comments.author_id` is a BIGINT, so passing it through kills the note silently.

**From the terminal (bulk / no UI):** `node scripts/link-batch-to-po.mjs --po <PO code>
--batch <batch code>` (dry run; add `--apply`). Same three writes, reusing the same
`markPoReceiving` / `getPoReconcileState` / `autoReconcileIfClean`. Run with `--po` alone
to list candidate batches. Two traps both paths handle explicitly:
- **Labels the supplier never marked shipped** (`shipLabels` / `--ship-labels`): a
  per-label manifest counts only lines on labels whose status is `shipped`/`in_transit`/
  `delivered`. A supplier who never scanned out (the box beat the paperwork) leaves them
  `pending`, so `expected` is 0 and a fully-delivered order reads **"received blind"**
  with every pair an overage. Both paths offer to record the **matched** labels as
  shipped — they physically did — and only those.
- **Boxes with no tracking # entered** (`boxMap` / `--map <boxNumber>=<tracking>`): with
  nothing to match on, no box lines up with a label and the per-box evidence trail
  (`getPoReceivedBoxes`) stays empty. Only tracking numbers already on that PO are
  accepted, and an already-scanned one is never overwritten — a wrong value invents a
  shipment.
A supplier-name mismatch **stops the script** (`--force` to override) — a wrong link
writes a false receipt against a real order. The in-app path scopes its candidate list to
the order's own supplier instead, so the mismatch can't arise.

## The courier's labels PDF (R2)
The sheet PH buys from the courier used to be read for its tracking numbers and thrown
away — the upload box said so — which left the supplier hunting through email for the
label belonging to the box in front of them. It's now stored and downloadable.

- **One object per order**, exactly as uploaded (`purchase_orders.labels_key/_name/_pages/
  _uploaded_at/_uploaded_by`). A per-box download **extracts that page on demand**
  (`pdf-lib`, `po_boxes.label_page`) rather than storing N split files — the page keeps
  its vectors, so the barcode prints as the courier made it, and a wrong mapping is a data
  fix rather than a re-upload.
- **The page↔label map is keyed on the TRACKING NUMBER read off each page**, never page
  order: rows get reordered, edited, or typed by hand before the order is created, and a
  label pointing at someone else's page is worse than none. Pages that matched nothing
  stay in the full sheet only, and the UI says how many matched.
- **Sheets interleave a packing slip after every label.** A 9-label request bought from
  UPS CampusShip arrives as **17 pages** — label, slip, label, slip… The slips are
  image-only with no barcode, so they used to import as blank label rows somebody deleted
  by hand every time. `labelPagesOnly` (`src/trackingOcr.js`) drops them: **a page that
  yielded no tracking number is not a label**. The one exception is a sheet where NOTHING
  decoded — then a slip can't be told from a label whose barcode simply failed to read, so
  every page comes back for a human (`undecidable`); losing a label silently is far worse
  than showing a blank row.
- **A label owns the pages up to the NEXT label** (`label_page` → `label_page_end`,
  computed in `attachPoLabels`), so a per-box download is the label *and its packing
  slip* — which is the point of interleaving them. The last label runs to the end of the
  file. The download clamps the range to the real page count, so a stale mapping can't 500.
- **Downloads are proxied and authorised** (`api/po/label-download.js`), never a public
  bucket URL like listing photos: a label carries the ship-to address and a live courier
  barcode. `Cache-Control: private, no-store`; a supplier reaches only their own order;
  `labels_key` is stripped from their `po/get`.
- **The upload key is minted server-side** from the PO code and validated on attach
  (`/^po-labels\/[A-Za-z0-9._-]+\.pdf$/`) — a client-chosen key could overwrite another
  order's labels. Replacing a sheet deletes the previous object.
- **Archiving the order deletes the file** (`po/close` → `clearPoLabels` + `deleteObject`,
  best-effort): by then every box has landed and the label is spent, so old addresses
  don't accumulate.
- Uploaded at PO creation (`CreatePO`) or later from the order (`PoLabelsFile`); the
  supplier's portal offers the whole sheet plus their own box's label while filling and
  once packed. Covered by `e2e/po-labels-file.spec.js`.

## Who may write a manifest, and when (`manifestEditBlock`)
One rule, three lifecycles — get this wrong and a supplier is locked out of their own
order (it happened live 2026-08-14, twice in one day).

- **The supplier**, writing their own label: open while the parcel is **still with them**
  — `STILL_WITH_SUPPLIER = ['pending', 'pre_transit']`. **`pre_transit` is the trap**:
  tracking is registered when the PO is *created*, so the carrier acknowledges the label
  within minutes, 17TRACK reports `InfoReceived` and the box leaves `pending` before
  anything is packed. Keyed on `pending` alone, that one automatic move took away Add
  items, Review & close **and** Ship, on a parcel still on their floor. `close-box` and
  `ship` accept the same pair; `packed` still asks to be reopened.
- **Staff on the supplier's behalf** (`onBehalf`, i.e. any non-supplier role): **not
  bound by where the parcel is** — per-box *or* whole-order, before or after the box
  lands. That path exists for a supplier who doesn't use the portal and sends their list
  by message, routinely after delivery. Every line is stamped `entered_on_behalf` with
  the staff member's name, so a late manifest still says who wrote it. PoOverview's
  `canFill` mirrors this and flags "label already sent" on a box that's out.
- **A replacement label**: open until the order is archived (it's created already
  `shipped`, and its lines are excluded from `expected`).

The only order-level bar is that the count is **frozen** — `reconciled` or `closed`.
Keying it on `draft` was wrong: a multi-label order flips to `receiving` when the first
box lands, which locked every label still at the supplier, including one added afterwards
for the rest of the shipment.

Covered by `e2e/po-manifest-window.spec.js`.

## Status
- **Phase 0 (done, merged):** schema + `supplier` role.
- **Phase 1 (built, on branch `feat/po-phase1-scanout` — not deployed):** PH create-batch
  form + supplier scan-out portal + subdomain gating. Endpoints under `api/po/*`, client
  methods `api.po*`, screens `CreatePO.jsx` (PH) + `SupplierApp.jsx` (supplier).
- **Phase 2 (built, on branch `feat/po-phase2-receive` — not deployed):** receive a shipment
  against a PO. `GET /api/po/open` (open shipments) + `GET /api/po/lookup?q=` (by PO code OR a
  label's tracking #). Receiving Step 1 gains a "Receive against a purchase order" picker
  (`PoPickerModal`) that pre-fills supplier/tag and maps each label → a box slot; commit
  (`commit.js` / `create-open.js`) accepts `poId`, sets `batches.po_id`, and `markPoReceiving`
  flips the PO **`draft`/`shipped` → `receiving`** (+ `received_batch_id`, idempotent). box-commit
  needs no change (the batch already carries `po_id`). **Receiving is allowed against a `draft` or
  `shipped` PO** — boxes arrive one at a time, often before the supplier marks every label shipped
  (a multi-label PO stays `draft` until ALL labels ship), so `commit.js`/`create-open.js` block only
  a `reconciled`/`closed` PO ("already … — can't be received against again"), not `draft`.
- **PH "Purchase Orders" overview (`PoOverview.jsx`, `/ph/po-status`):** read-only list of every PO
  the team opened — status chip + `shipped/box` label count + `delivered_count` (added to `listPos`)
  + units; tap to expand per-label tracking (status/carrier/checkpoint) with **Refresh all** +
  per-label refresh. Fixes "PH reconciliation page is blank" — Reconciliation only lists POs already
  in `receiving`/`reconciled`, so shipped/draft POs (with tracking) had nowhere to show.
- **Phase 2b (in progress) — receive by MANIFEST, not blind re-scan (2026-07-09 decision):**
  When a box is received against a PO, its expected lines (from `po_lines` for that label)
  populate a **checklist**: one row per SKU+size with a **present checkbox + editable
  "received" count**. Each row has **add issue** (defect/no-box/etc. per shoe). Staff can
  **add an unexpected item** (scan/type) → received + flagged **overage / not-on-PO**. On
  confirm, the checklist builds the same `items[]` + `unitIssues[]` the scan flow produces
  and reuses **box-commit** (mints VINs).
  - **Every row starts UNCHECKED at qty 0** (`buildManifestItems`), so the list is the guide
    for what's being pulled out of the box — tick a size as the pair comes out, and whatever
    stays unticked is the shortage. Pre-filling at the expected qty made "I received
    everything" the default and turned the screen into something to skim past; a shortage
    only got caught if someone remembered to untick it. Supporting bits: an **"x of y
    checked"** progress chip in the card header, a **ticked row gets the done wash** (the
    `.off` fade is gone — unchecked is the full-strength "still to pull" state), the red
    `short N` flag is reserved for a **partial** (`0 < got < exp`) with an untouched row
    reading a neutral `to pull N`, and **Review** on a fully-unchecked PO box warns once
    before letting it through (`emptyBoxAck`) — an all-short label is legitimate, just never
    silent. Nothing changed downstream: qty 0 already expanded to 0 units in `doCommit`, and
    the shortage is still inferred server-side by `getPoReconciliation`.
  Reconciliation (received-vs-expected per SKU+size: shortage/overage/wrong-SKU) falls out of
  this at receipt; the full PO-level snapshot + PO→`reconciled` is Phase 3.
- **Phase 3 (built, on branch `feat/po-phase3-reconcile` — not deployed):** reconciliation.
  `GET /api/po/reconciliation?poId=` computes expected (po_lines) vs received (items under
  `received_batch_id`) grouped by (sku,size), flagging **match / shortage / overage /
  wrong_size (SKU expected, size not) / wrong_sku (SKU not on PO)**. `GET /api/po/reconcile-list`
  lists received/reconciled POs. `POST /api/po/reconcile` snapshots the table to
  `purchase_orders.reconciliation` (JSONB) + `reconciled_at` and flips status → `reconciled`
  (only from `receiving`; 409 otherwise). UI: `Reconciliation.jsx` screen (list → report table
  + summary + **Copy discrepancy report** for the group chat + **Reconcile & close**). Reachable
  from the main Home ("PO Reconciliation", warehouse/admin — full) and PHTeamApp
  (`/ph/reconciliation`). **PH can reconcile + archive too** (`canReconcile` on both routes;
  `po/reconcile` and `po/close` accept `['warehouse','ph_team']`) — PH is the side chasing the
  supplier over a shortage, so gating the close on warehouse just parked POs in the queue.
  - **Auto-reconcile (a clean PO closes itself).** `autoReconcileIfClean(poId)` snapshots + flips
    `receiving`→`reconciled` with **no human tap** when *every* guard holds: PO is still
    `receiving`; its `received_batch_id` batch is **`committed`**; **no `po_boxes` row is
    `pending`/`packed`** (nothing left at the supplier); and the reconciliation is
    `clean` + `!no_manifest` + `expected_units > 0` + `received == expected`. Anything short/over/
    blind/mid-intake stays in the manual queue. Called (best-effort, never blocks the response)
    from `batches/commit`, `batches/box-commit` (on `autoCompleted`), `batches/set-status`
    (manual "done"), and as a **self-heal sweep in `po/reconcile-list`** so POs received before
    this existed clear themselves on the next page load. Without it, a no-discrepancy PO sat in
    the queue forever and the supplier read the `receiving` chip as still-outstanding.
  - **The chip says what's actually true** (`poChip()` in `Reconciliation.jsx`), because
    "To reconcile" on a 13-of-13 all-matched PO reads as a chore when there's nothing to decide:
    `Reconciled` / `Receiving` (intake unfinished) / `Received blind` / `N discrepancies` /
    `Boxes still out` / `Matched · ready to close`. Fed by **`getPoReconcileState(poId)`**
    (`{ po, rows, summary, intakeDone, awaitingBoxes }`) — the *same* helper the auto-close guard
    uses, so a badge can never contradict it. `reconcile-list` attaches it per open PO as `rc`
    (closed POs reuse their frozen `reconciliation->'summary'`); `po/reconciliation` returns
    `intake_done`/`awaiting_boxes` for the detail header. New `.po-chip.bad`/`.warn` variants.
    **The Home badge is split in two** so narrowing it never hides a live PO:
    `pendingCounts.po_to_reconcile` (amber, intake `committed` — a human must decide) +
    **`po_receiving`** (neutral `info`, batch not committed — arrived, still being scanned in).
    They partition the old single `status='receiving'` count exactly. `homeCardBadges('reconcile')`
    returns both (PHTeam's card now calls it instead of hand-rolling its own badge array); only
    the amber one feeds Home's "Needs attention" strip.
    Closing mid-intake still works but shows a "closing now freezes the count" note.
  - **Reconciliation note** — the *why* behind the counts ("size 10.5 ships Thursday", "short
    pair credited"). **One editable free-text field per PO**, `POST /api/po/note {poId, note}`
    (warehouse/ph_team, 2000 chars, blank clears all three columns) → `setPoReconcileNote`.
    Writable at **any status including `reconciled`/`closed`** — the resolution usually lands
    days after the count. Appended to the **Copy report** text so the group-chat message already
    carries the explanation. Shown as a one-line italic preview on the reconcile list card.
    **The supplier sees it read-only** in their portal (card preview + a bordered block on the
    PO), attributed to the business — `po/get` and `po/list` **strip `reconcile_note_by`** for
    supplier scope, exactly like the on-behalf line attribution; the timestamp is kept.
    **Schema-touch: `purchase_orders.reconcile_note` + `_by` + `_at` → run `db:setup`.**
  - **The warehouse is told at the moment of intake, not just by a badge.** Reconciliation is
    shared between warehouse and PH (whoever gets to the supplier first), so discovery can't
    rely on someone wandering back to Home. `reconcileOutcomeForIntake(poId)` = auto-close if
    clean, else describe what's wrong; `batches/commit`, `box-commit` (on `autoCompleted`) and
    `set-status` ('done') **await it before responding** and return it as `reconcile`. The
    "batch saved" modal then renders a red **`<ReconcileAlert>`** — "PO-100037 doesn't match the
    manifest · 1 short" + a **Review & copy the report** button that deep-links to
    `/reconcile?po=<id>` (`onOpenReconcile` → `App.jsx`'s `openReconcile`). Returns null (silent)
    when the PO auto-closed, when intake isn't finished, or when there's no PO at all.
    Class prefix is **`po-mismatch`**, deliberately not `rc-*` (see the collision above).
  - **Archiving is reversible.** `GET /api/po/archived` (its own endpoint, `LIMIT 100`, **not**
    a flag on `reconcile-list` — the archive only grows and is opened rarely, so the active
    queue must never pay to load it) + `POST /api/po/unarchive {poId}` → `closed`→`reconciled`
    (warehouse/ph_team; 409 with the actual status if it isn't archived, 404 if missing).
    Lands on `reconciled`, **not** `receiving`: the frozen count still stands, this only makes
    the order workable again. UI: an **Active / Archived** switch on the list (`?tab=archived`,
    fetched lazily on first visit) and a **Bring back** button — rendered *outside* the card
    `<button>`, since nested buttons are invalid and swallow the tap on mobile. Archived cards
    read their numbers from the **frozen `reconciliation->'summary'`**, never recomputed, so
    history can't shift under later data changes.
- **Discrepancy resolution (what happens AFTER an order comes up short).** Two shapes on
  purpose: **`po_resolutions` is STATE** (four known steps → fixed columns, one row per PO,
  so "how many refunds are outstanding" is one indexed query with no join) and
  **`po_comments` is a LOG** (append-only, never read by a list screen). Folding the
  checklist into the log would turn every "is step 3 done?" into a scan. Three denormalised
  columns on `purchase_orders` — **`resolution_state`** (`none|open|settled`),
  `comment_count`, `last_comment_at` — keep list screens single-table; they're written by
  the same endpoints, in the same request, never recomputed on read.
  - **Steps:** `contacted → outcome → reference → settled`, via
    `POST /api/po/resolution {poId, step, undo?, outcome?, value?, amount?, carrierKey?}`.
    Every step accepts **`undo`** — a refund that never lands has to be re-openable — and
    clearing the outcome cascades (a credit ref is meaningless once you switch to a reship).
    `outcome='writeoff'` **drops the reference step** (`stepsFor()`), so the UI never shows a
    box that can't be ticked. Each write posts a **`kind='system'` comment**, which is what
    makes the thread the audit trail — there is no separate history table.
  - **Refund = expected vs actual**, mirroring the reconciliation itself: `ref_amount` (agreed,
    step 3) vs `settled_amount` (arrived, step 4); `refundShortfall()` surfaces a short-paid
    credit instead of letting it close green. `NUMERIC(12,2)`, not float — this gets totalled.
  - **Replacement = a real label on the ORIGINAL PO.** `addReplacementBox()` inserts a
    `po_boxes` row (`kind='replacement'`, next `box_number`, status `shipped`) and registers
    it with 17TRACK. Logging it calls **`reopenPoForReceiving()`**
    (`reconciled|closed → receiving`), because receiving against a finished PO is blocked;
    that reopen is announced in the thread, never silent. When the reship is scanned in the
    order goes clean, auto-reconcile fires, and **`settleReplacementIfArrived()` ticks
    "Replacement received" by itself** — the count *is* the proof it arrived.
  - **A replacement label CAN be manifested — its lines just never reach `expected`.**
    (Reverses the original "a reship carries no `po_lines`" rule, which left the warehouse
    re-scanning a reship blind with nothing to check it against.) The **supplier** declares it
    in their portal ("List what you're sending"), or **PH enters it on their behalf** from
    `PoOverview`, both through the ordinary `po/scan` + `po/line` endpoints. The reason the
    old rule existed is still true and is now enforced in the arithmetic instead of by
    forbidding the data: **`getPoReconciliation` excludes `b.kind = 'replacement'` from the
    box-scope `expected` query** (and the `'po'`-scope query is pinned to `po_box_id IS NULL`,
    which excludes them too), and `listPos`'s `unit_count` excludes them the same way. Those
    units were already declared on the ORIGINAL manifest and already counted short — count
    them twice and `expected` rises by exactly the shortage, so the order reads short forever
    even after the reship lands. The reship manifest is a **checklist for the warehouse**
    (Receiving builds one from it like any other label, and the per-box manifest PDF gives it
    a *Replacement shipment* page), never a second claim.
  - **The reship manifest's edit window is the mirror of a normal label's.**
    `api/_lib/po-manifest.js` → **`manifestEditBlock({ po, box })`**, shared by `po/scan` and
    `po/line`. A supplier's own label: PO still `draft` **and** label still `pending`. A
    replacement: created already-`shipped` on a `receiving`/`reconciled` PO, so it could never
    pass that test — it stays editable until the order is **archived** (`closed`). `po/scan`
    also skips the whole-order-scope guard for a reship: it's one specific label whatever
    shape the original purchase was declared in, and it can't pollute the roll-up.
  - **Thread is INTERNAL** (`POST /api/po/comment`, warehouse/ph_team). The supplier reads the
    single `reconcile_note`, written on purpose for them. `po_comments.audience` exists from
    the first migration (default `internal`) so opening it up later is a flag, not a migration.
    `po/get` and `po/reconciliation` are separate endpoints, so the thread and the resolution
    are never in a supplier-facing payload at all — verified, not just hidden in the UI.
  - **Keeping the two channels from swallowing each other.** A supplier-visible field and an
    internal thread on one screen is a trap — people type in the internal one and the supplier
    is told nothing (observed on a real PO: resolution settled, 5 internal notes,
    `reconcile_note` still NULL). Two guards: the card is titled **"Note to the supplier"** and
    shows an amber **nudge** ("The supplier hasn't been told anything yet") whenever a
    resolution has started and the note is still empty; and every internal comment carries
    **Send to supplier**, which promotes that line into the note (confirms first if it would
    replace a different one, and flips to "✓ This is what the supplier sees" once it matches).
  - **What the SUPPLIER sees of all this:** the note (read-only, attributed to the business)
    and the replacement label. A reship lands in their portal as a box on their order, so it
    must not read as one they forgot to pack — `SupplierApp`/`PoOverview` title it
    **"Replacement shipment"** instead of `Label N`, tint it with a blue rail
    (`.po-box.replacement`), and explain whose it is. It's the one box they can still fill
    after the order left draft (`canDeclare`), with editable line rows + **Add items** but
    **no close/ship** — the warehouse already created it as a shipped label with its tracking
    on it. `PoScanModal` names the target *the replacement shipment* rather than `Label 4`,
    and so does Receiving's box-slot header (`kind` rides on the slot). **`listPos` excludes
    `kind='replacement'` from `box_count`/`shipped_count`** (and adds `replacement_count`):
    "1 of 1 labels shipped" describes the *supplier's packing job*, and a reship they didn't
    create must not turn that into "1 of 2".
  - **Reads:** resolution + the latest 50 comments ride along on `po/reconciliation` (no extra
    round trips) and are **never** loaded by a list. No new Home badge — resolution shows as
    "3 of 4" on the order's own card.
  - **`getPoReconciliation` now counts received items across EVERY batch with
    `batches.po_id = poId`**, not just `received_batch_id` — an order can be received in more
    than one batch (most obviously a reship weeks later) and keying off the first silently
    undercounted the rest. `intakeDone` likewise means "≥1 batch and none still open".
  - **Schema-touch: `po_resolutions` + `po_comments` tables, `purchase_orders.resolution_state`
    / `comment_count` / `last_comment_at`, `po_boxes.kind` → run `db:setup`.**
  - **Report table UI.** Classes are prefixed **`rcn-`, not `rc-`** — `RescaleRequests.jsx` owns
    `rc-*` and `.rc-item` there paints a bordered card, which drew a stray pill around every SKU
    cell. Rows are two-line (SKU · size, then product name), qty is one `got/exp` cell, and a chip
    shows only on problem rows (matched get a green ✓ + a fold: **"N lines matched ✓ — Show"**).
    A **By size / By SKU** switch groups the lines one-per-SKU with a chip per size; grouping runs
    **before** the problem/matched split so a SKU that's short in one size isn't torn across both
    sections (it inherits its worst flag). Duplicate `tag_code`/`supplier_name` is suppressed.
- **Phase 4 (built, on branch `feat/po-phase4-tracking` — not deployed):** shipment tracking
  via **17TRACK**, behind a thin adapter (`api/_lib/tracking.js`) that **no-ops unless
  `TRACKING_API_KEY` is set**. On ship, `po/ship` registers the label's number; status lands
  either by **webhook push** (`POST /api/po/tracking-webhook?secret=…`, gated by
  `TRACKING_WEBHOOK_SECRET`) or an **on-demand pull** (`POST /api/po/track-refresh`
  `{poId, poBoxId?}`, warehouse/ph/supplier). Omit `poBoxId` → refresh **every** label
  (one lookup per tracking number); pass it → refresh just **that one** label (fewer
  tracking-API credits). Supplier portal has **Refresh all tracking** + a per-label
  **Refresh this label** button on each shipped label. Both write `carrier` / `tracking_status` / `last_checkpoint` / `checked_at`
  and advance `po_boxes.status` (17TRACK status → shipped/in_transit/delivered via
  `mapBoxStatus`). Supplier portal shows per-label status + a "Refresh tracking" button.
  Env: `TRACKING_API_KEY`, `TRACKING_WEBHOOK_SECRET` (see `.env.example`). Live register/
  gettrackinfo calls need a real key to validate; mapper/parser/DB-update verified locally.
- **Phase 5 (built, on branch `feat/po-phase5-polish` — not deployed):** polish.
  **Reconcile badge** — `pendingCounts` gains `po_to_reconcile` (count of `receiving` POs);
  the "PO Reconciliation" Home card + PH card show a "To reconcile" badge, and it appears in
  Home "Needs attention" when > 0. **Archive** — `POST /api/po/close` (warehouse) flips a
  `reconciled` PO → `closed` (409 otherwise); an **Archive** button on the reconciled report
  removes it from the reconcile list (which only shows receiving/reconciled). Supplier-account
  admin is already covered by **Check Access** (approve / set role / reset password / delete),
  so no new admin UI. Feature complete through Phase 5.

## Importing a supplier's manifest PDF (bulk on-behalf entry)
- **`PoManifestImport`** on the PO detail (above the labels) → parses the PDF in the
  browser (`src/lib/manifestImport.js` — the **inverse of `manifestPdf.js`**, which
  prints one) → preview → **`POST /api/po/manifest-import`** (`ph_team`/admin).
  Typing 18 boxes into the per-box modal by hand is the thing this replaces.
- **One page = one box.** Reads `Box Number: n/N`, `Tracking Number: …` and the
  `Product Name | SKU | Size | Qty` table between the header and `Total`. It also
  accepts **our own** sheet's wording (`ITEM | SKU | SIZE | PAIRS`, `TOTAL PAIRS`), so
  a manifest this app printed can be re-imported.
- **The colon is not reliable.** The same document prints `Box Number: 1/18` on some
  pages and `Box Number 4/18` on others (and `Tracking Number:1Z…` with no space).
  Requiring it lost the box number on 10 of 18 pages of the first real file — invisible
  until tracking fails to match and the fallback is all that's left.
- **SKUs are normalised `IM6673 100` → `IM6673-100`.** The sheet prints style codes with
  a space; our items carry the dashed form and `rcSku` (reconciliation) upper-cases but
  does **NOT** strip separators — importing verbatim would leave every line unmatched
  and report a perfect shipment as `wrong_sku`. This is what makes an imported manifest
  reconcilable at all.
- **Matched to a label by TRACKING NUMBER**, box number as the fallback — the same rule
  as the labels PDF and the received-batch link (a box *is* its tracking number).
- **Only labels with NOTHING declared are filled.** A label the supplier already scanned
  (or PH typed) is reported as skipped, never merged into or doubled. Enforced
  server-side as well as in the preview, so re-importing the same file is a no-op.
- **One request, not a loop.** `po/scan` is rate-limited to 120/min and a real manifest
  is ~200 lines: looping it from the client would 429 halfway and leave the order
  half-declared. Every line still goes through `addPoScan` stamped `entered_by` +
  `entered_on_behalf`, so a supplier reading their own order sees "entered by their
  staff" exactly as with hand entry.
- Rows whose parsed count disagrees with the sheet's own printed `Total` are flagged in
  the preview (⚠) rather than imported silently — a mismatch means the page didn't
  fully parse, and the box would land under-declared.
- Refused: a **whole-order-manifest** PO (409 — mixing scopes double-counts at
  reconciliation) and any settled order (`manifestEditBlock`).
- Verified against a real 18-page supplier file: 233 pairs, every page matching its
  printed total; 17 labels filled with 1 skipped as already-declared, and a second
  import of the same file writing nothing.

## Reconciliation matching — the two notations that faked 154 short pairs
`getPoReconciliation` used to compare `sku`/`size` as literal text (upper-cased,
nothing else). On PO-100005 that reported a **fully-correct 233-pair shipment as 88
lines / 154 pairs wrong**. Two notations cause it, and each shows up TWICE — a phantom
`shortage` against their spelling and a phantom `wrong_sku` against ours:
- **Women's sizes** — the supplier writes `7.5`, we store `7.5W` (27 lines on that order).
- **Dual style codes** — the supplier writes one code, our UPC lookup gives both
  (10 lines): their `CW2290-111` vs our `315121-115/CW2290-111`, and
  `HV9918-301-/-HV9919-301` — the hyphens around the slash are `normSku` turning the
  spaces into dashes on the way in.

So matching is now on **any style code in common + the numeric part of the size**
(`rcCodes` / `rcSizeNum`). Codes are grouped **transitively** (union-find): a line
listing `A/B` makes A and B one shoe, and a later `B/C` pulls C in, with the
alphabetically-first code as the group's stable key. Both sides are then *aggregated*
by that key before comparing, so two spellings on the same side fold together too.
- The row still reports **what each side actually wrote**; `sku_ours`/`size_ours` carry
  our spelling when it differs, so a report can show `7.5 → 7.5W` rather than quietly
  normalising the difference away.
- Verified by rebuilding PO-100005 from both PDFs: **88 flagged lines / 154 pairs → 12
  lines / 12 pairs**, matching an independent comparison of the two documents exactly.
- Consequence worth knowing: orders that were falsely dirty can now auto-close
  (`autoReconcileIfClean`), which is the intended behaviour.

## Manifest PDFs — continuation pages carry a one-line header
A table spilling to a new page used to reprint the **whole** page header: supplier
block, ship-to box and every tracking number on the order. On an 18-box order that
made the reconciliation 20 pages, mostly the same 18 tracking numbers over and over.
`drawContinuedHeader` replaces it with one line — business · PO · title · "continued" —
and the **table head repeats** instead. PO-100005's received sheet went **38 pages →
24** (its reconciliation section, 20 → 6). Applies to every paginating table: per-box,
whole-order, received and reconciliation.

## Supplier non-compliance — on-behalf manifest entry + no-manifest receiving
Two escape hatches for when a supplier won't use the scan-out portal:

- **Option 1 — supplier hands over a manual list → PH enters it on their behalf.**
  `scan`/`line` now accept **`ph_team`** (not just `supplier`); admin/superadmin auto-allowed.
  A supplier is still scoped to their own POs, but PH/admin may fill **any** PO the team
  owns (only while it's `draft` + label `pending`, the same window a supplier scan uses).
  Every write stamps `po_lines.entered_by` (the staff user's id) + `entered_on_behalf=true`.
  **Attribution is dual-visibility:** `getPoFull` joins `entered_by_name`; `po/get` **strips
  `entered_by`/`entered_by_name` from a supplier's response** (keeps `entered_on_behalf`),
  so the **supplier sees only "{business}'s Staff"** while **warehouse/PH see the real
  person**. Business name = `app_settings.business_display_name` (default `Stickballman12 LLC`),
  returned as `businessName` on `po/get` and via `getBusinessName()`. If a supplier later edits
  a PH-entered line, `onBehalf` becomes false and `entered_by` clears (they take ownership).
  Env admin/superadmin have a non-numeric `uid`, so their writes set the flag but leave
  `entered_by` NULL (no real `users` row to reference).
  **UI:** the shared **`src/components/PoScanModal.jsx`** (extracted from `SupplierApp` — exports
  `PoScanModal` + `PoLineRow` + `PoLineHeader`, used by both sides) is opened from **`PoOverview`**
  per draft/pending label ("Add items on their behalf"), which also renders each line's internal
  attribution. `SupplierApp` shows "Entered for you by {business}'s Staff" on flagged lines.
  **Staff can EDIT and REMOVE lines too, not only add them** (2026-08-15). `PoOverview` renders the
  same editable `PoLineRow` the supplier portal uses — size, qty, cost, tip, and a remove ✕ — on
  per-label *and* whole-order lines. A manifest typed off a WhatsApp message gets a size or a qty
  wrong, or carries a pair the supplier later says isn't in the box; being able to add a line but
  never fix or drop one left deleting the whole order as the only correction. The client gate
  (`canEditLines`) mirrors the server's `manifestEditBlock(onBehalf)` exactly: open until the
  order's count is FROZEN (`reconciled`/`closed`; a replacement label until `closed`) — where the
  parcel is doesn't bind staff. **A removal goes through a confirm dialog on the staff side only**:
  here the row is somebody else's declaration, often for a box that has already shipped, and
  dropping it changes what the order is owed. The supplier's own portal keeps the immediate ✕ —
  they're fixing their own scan with the box open in front of them. No new endpoint: `po/line`
  with `qty: 0` has always been the removal.

- **Option 2 — no list at all → warehouse receives blind.** Already works (receive against a
  `draft`/`shipped` PO, scan the actual items). `getPoReconciliation` now sets
  **`summary.no_manifest`** (received PO with 0 expected units + >0 received). `Reconciliation.jsx`
  then shows a **"No manifest provided — received blind"** banner, labels every row **"Received"**
  instead of "Not on PO", and the copy-report says so — no wall of phantom overages.

- **Option 3 (Path C) — supplier gives ONE list for the whole purchase, not per box.** PH enters it
  against the **PO itself** (a `po_lines` row with **`po_box_id` NULL**), not a label —
  `POST /api/po/scan-order` (ph_team; always on-behalf) via `addPoOrderScan` (conflict target =
  partial unique index `(po_id, sku, size) WHERE po_box_id IS NULL`), which flips
  **`purchase_orders.manifest_scope` `box`→`po`** (`setPoManifestScope`). **A PO is one scope
  or the other** — `scan-order` 409s if the PO already has per-box lines (`poHasBoxLines`), and the
  per-box `scan` 409s if `manifest_scope='po'`. **Reconciliation branches on scope:** `'po'` counts
  the **entire** manifest order-wide (no shipped-label filter — the lines have no label); `'box'`
  keeps the shipped-labels-only filter. **Receiving is unchanged — still per box, exactly like a
  blind receive** (the manifest just isn't per-box, so there's no per-label checklist). `updatePoLine`
  branches its size-merge sibling lookup for null-box lines (match within the PO, not the label).
  **Enterable while the PO is `draft` OR `receiving`** — not draft-only. The whole premise of
  Path C is a supplier who doesn't use the portal, so their list routinely arrives *after*
  the boxes: draft-only meant a list that turned up an hour late could never be entered at
  all, and the order reconciled "received blind" with every pair reading as an overage.
  These lines only feed `expected`; the warehouse's count is recorded independently, so a
  late manifest can't rewrite what was received.
  **UI:** shared `PoScanModal` gains an order mode (`po` prop instead of `box`) → `api.poScanOrder`;
  `PoOverview` shows a **"Whole-order manifest"** block with an **"Add whole-order manifest"** button
  (draft PO, no per-box lines) + internal attribution; `SupplierApp` shows a read-only **"Order
  manifest"** card with the "…'s Staff" note. **Schema-touch: `po_box_id` nullable + `manifest_scope`
  + partial index → run `db:setup`.**

## The order's chip says where the ORDER is, not what `status` says
`purchase_orders.status` only ever advances as far as `receiving` on its own, and an order
received with nothing declared **never auto-reconciles** (`maybeAutoReconcile` bails on
`no_manifest` / `expected_units === 0` — that call belongs to a person). So PO-100003 sat
reading **"Receiving"** with all nine labels delivered and 54 pairs counted, contradicting
the line right underneath it. The same bug one stage earlier: a `draft` order whose labels
had all shipped read **"Filling"**, as if the supplier were still packing.

`poChipOf` (PoOverview) derives the chip from the label counts the list already returns:
every label delivered → **"Delivered · to reconcile"** (or "All delivered" with nothing
received yet); else `receiving` → Receiving; else any label shipped → Shipped; else the raw
status. `SupplierApp` has the mirror of it (**"On its way to us"**, "2 of 3 shipped"),
derived from the labels on the detail and from `shipped_count`/`box_count` on the list —
a supplier must never be told their order is "Filling" when the boxes are with the courier.
The chip is a **statement about reality, not a workflow state**; the reconciliation queue
(`poChip` in `Reconciliation.jsx`) still owns what happens next.

## The PO screen's layout (PoOverview + SupplierApp)
Reworked 2026-08-15 — the detail had grown into one long column of text and controls.
- **A label is a card**, not a hairline separator: `.po-ov-label` has a border, radius and its
  own background, so an order with four labels reads as four things.
- **A manifest is a table, once you have room for one.** `PoLineRow` renders every control as a
  labelled cell; at **≥720px** the per-row labels give way to a single `PoLineHeader`
  (ITEM · SIZE · QTY · COST EA · TIP EA) and the rows snap to shared columns, with the SKU under
  the product name. Below 720px each cell keeps its own label and the rows stack — six controls
  never fit across a phone. **Both sides use it**, so a supplier on a laptop gets the same table;
  if you add `PoLineRow` anywhere new, render `PoLineHeader` above it or the columns lose their
  headings on desktop.
- **Remove (✕) sits on the item's line**, top-right, not trailing the tip field — it deletes the
  whole item, and the flex wrap used to park it under "Tip ea" where it pointed at the wrong thing.
- **The label header no longer repeats itself**: the carrier shows once (again only if tracking
  reports a *different* one than the label claims), and 17TRACK's checkpoint text is suppressed
  when it merely restates the status — that's what produced "UPS · Delivered / Delivered, DELIVERED".

## Receiving a whole-order (Path C) PO, and our own per-box count
Receiving is per box on a Path C order exactly as it is on any other — the manifest just
isn't broken out per label, so there's no per-label checklist to tick.

- **The receiving screen knows the difference.** `ManifestChecklist` takes `wholeOrder`
  (from `po.manifest_scope`) plus `orderSkus` (the SKUs on the order-level list). Without
  it, every label showed "This label had no expected items", the progress read
  **"0 of 0 checked"**, and **every pair the warehouse scanned was chipped "Overage · not
  on PO"** — for the entire job, on stock that *was* on the supplier's list. Now the header
  reads "Box N · contents — X counted", the button is "+ Add item" (not "+ Add
  unexpected"), a banner says the order was manifested as one whole-order list, and a SKU
  on that list is chipped **"On the order list"**. A SKU that genuinely isn't still reads
  "Overage · not on PO" — that distinction is the whole point.
- **A received box is identified by its TRACKING NUMBER, not by the number someone typed**
  (2026-08-15). PO-100003 shipped nine labels; eight boxes were received one day and label
  6's box the next, where `+ Add box`'s `max+1` filed it as **"box 10"** — so the evidence
  sheet read 1,2,3,4,5,7,8,9,10 against an order that only ever had nine labels. The number
  a person picks while unpacking is a guess; the tracking number on the carton is not.
  `getPoReceivedBoxes` now matches each `batch_boxes` row to a `po_boxes` label on
  normalised tracking and reports **that** label's number, sorting by it, so the list (and
  the "What we received" PDF, which reads the same field) lines up with the labels the
  supplier printed. `recorded_box_number` carries what was typed **only when it differs** —
  the Reconciliation row then says "matched to this label by tracking; recorded while
  unpacking as box 10", so this can never read as us quietly renumbering their box. No
  tracking, or one that matches nothing, keeps the warehouse's own number
  (`matched_label: false`). This is a READ-side correction: it fixes every order already in
  the database, including ones received before the fix. The stored `batch_boxes.box_number`
  is corrected separately, by hand, with the ✎ on the Batch page (`docs/context/receiving.md`).
- **`getPoReceivedBoxes(poId)` = what WE counted, box by box.** Built from `items.box_id`
  (receiving already sets it per box) across **every** batch linked to the PO. Units with a
  NULL `box_id` — a single-box or pre-multi-box receive never set one — come back as a
  box-less group rather than vanishing, so the totals still add up. Served on
  `po/reconciliation` as `received_boxes`.
- **"What we received" (PDF, `mode: 'received'`).** One page per box we opened, with that
  box's tracking number and what came out of it, then **one** reconciliation page: their
  list vs our count, per SKU+size, with a plain-word verdict ("Match", "Short 1",
  "Not on their list") and totals. This is the sheet you send a supplier when a shipment is
  short. Deliberately **not** expected-vs-received *per box*: on a whole-order manifest
  there is no per-box expectation, and inventing one would be us fabricating a claim the
  supplier never made. Per box we state only what we counted; the comparison happens once,
  at the order level, where their list actually lives. Offered on `Reconciliation` next to
  the supplier's manifest, and it's the one printable that **is** offered on a blind
  receipt — there's no manifest to print, but our count is the only record of the shipment.
- **Each label card on `PoOverview` shows both numbers** (2026-08-14): `N declared`
  (`po_lines` for that label — 0 on a whole-order or blind order, legitimately) and, beside
  it, `N received` — what the warehouse counted into that label's box. A card reading a bare
  "0 units" over a box with twelve pairs already scanned out of it reads as *this box is
  empty*, which is the opposite of the truth; it's the same fix the PO list got ("0 declared
  · 48 received"). `getPoFull` computes `boxes[].received_units` by joining on the
  **tracking number** — `batch_boxes` has no `po_box_id`, so that string is the only thing
  tying a received box to a label (`getPoLinkPreview` matches the same way), plus a second
  arm for items with a NULL `box_id` in a batch whose own tracking matches. Units the
  warehouse recorded under no matching tracking are named under the labels ("N received
  units … aren't counted against any label above"), never silently dropped from the
  arithmetic. **Staff-only**: `hideReceivedUnits` strips the field on every response a
  supplier can reach (`po/get`, `ship`, `close-box`, `reopen-box`, `track-refresh`) — they
  must not read our count before the reconciliation is settled with them.
- **Known friction:** `listOpenPos` (the Receiving "Open shipments" picker) lists only
  `shipped`/`receiving` POs. A supplier who never touches the portal leaves the PO `draft`,
  so it is NOT in that list — the warehouse pulls it up by **scanning a label** or typing
  the PO code (`po/lookup` has no status filter). That's the intended flow, but it means
  the picker looks empty for exactly these suppliers.

## What the shipment cost the supplier (cost + tip, both per pair per size)
- **Both are per pair, on the line** — `po_lines.unit_cost` (the column pre-dated any UI)
  and `po_lines.tip`. A `po_line` is one **SKU + SIZE**, so both are *per size*: the same
  shoe can cost, and be tipped, differently in a 9 than in an 11. The tip is kept as its
  own column rather than folded into the cost so the two stay separately reportable.
  **Schema-touch: `po_lines.tip` → run `db:setup`.**
- **Entered in two places, both optional.** **Cost** and **Tip** boxes sit on each size row
  of the `PoScanModal` draft, and again as **"Cost ea" / "Tip ea"** on each `PoLineRow`
  afterwards. A newly added size row **inherits the money typed on the previous row**,
  because the common case is still a run of sizes bought at one price — type it once,
  change only the size that differs. Both ride the existing endpoints (`po/scan`,
  `po/scan-order`, `po/line`), so the edit window is exactly the manifest's
  (`manifestEditBlock`) — a closed label is reopened to correct a number, same as any
  other fix.
- **Blank is not zero, anywhere.** An emptied cost or tip writes **NULL** ("never
  declared"), not `0.00` ("this was free") — different claims, and the totals treat them
  differently: pairs with nothing declared are excluded from the subtotal and **counted out
  loud** ("3 pairs with nothing entered"), so a partial total is never passed off as the
  whole number. `api/_lib/po-manifest.js` → **`parseMoney`** is the one parser for both
  fields and keeps the three outcomes distinct (`undefined` = not sent, `null` = clear,
  `NaN` = unusable); **`money()`** is the scan-time variant that ignores junk rather than
  failing a scan, while `po/line` rejects it — there the edit *is* the request. Two write
  paths protect declared money: `addPoScan`'s upsert `COALESCE`s both fields so a re-scan
  carrying none can't wipe them, and a **size-change merge keeps both** (the edited line's,
  else the sibling's).
- **Where it shows.** Supplier: `Cost $X + tips $Y = $Z` per box, on the card and in the
  close-box review. PH: read-only on `PoOverview` — per line (`$95.00 ea · tip $10.00 ea`)
  and the same per-box total, the only place staff can see what a supplier declared.

## Tracking pushes (17TRACK webhook) — works for the non-compliant paths too
For the pushes to actually fire when a supplier never uses the portal:
- **Register at PO creation.** `create.js` calls `registerTracking()` on the labels' numbers right
  after `createPo` (best-effort, no-ops without `TRACKING_API_KEY`) — not only at `po/ship` (which
  non-compliant suppliers never hit). Registration is what makes 17TRACK watch the box + push.
  **Consumes 1 quota/number** at register time.
- **Webhook auth = the `?secret=` on the configured URL.** 17TRACK posts to the EXACT URL set in its
  dashboard (`api.17track.net/admin/settings` — dashboard-only, no API to set it), query string
  included, so configure `https://<host>/api/po/tracking-webhook?secret=<TRACKING_WEBHOOK_SECRET>`.
  17TRACK also sends a `sign` header (SHA256 of body + API key) we could additionally verify later.
- **`pre_transit` box status** (schema: added to the `po_boxes` status CHECK). `mapBoxStatus` maps
  17TRACK **`InfoReceived` → `pre_transit`** ("label made, still with the supplier"), distinct from
  `in_transit` ("courier has it"). UI shows it as a slate "With supplier · label made" chip.
  `setPoBoxTracking` is now **forward-only** (rank pending<packed<pre_transit<shipped<in_transit<
  delivered) so a late lower push never moves a box backwards. **Schema-touch: run `db:setup`.**
- **Google Sheets mirror** (optional): `forwardTrackingToSheet` (env `GOOGLE_SHEETS_TRACKING_URL`)
  posts every update to a Google Apps Script Web App from BOTH the webhook and `track-refresh`
  (best-effort, env-gated). Setup + Apps Script in `docs/google-sheets-tracking.md`.
  **The env var takes a comma-separated LIST** (`sheetsTrackingUrls`) — each sheet is posted
  independently with its own timeout, so one slow/broken sheet can't starve the others, and a
  failure is logged with a short tail of the deployment ID (`[tracking sheet] …abcXYZ failed:`).
  It was a single slot until 2026-08-17, so adding a sheet meant silently killing the old one.
  Both callers fire-and-forget, which is why the function logs rather than throws.
- **Sub-status** — 17TRACK's `latest_status` carries `{ status, sub_status, sub_status_descr }`.
  `status` is the coarse stage we map onto `po_boxes.status` and it's too blunt to act on:
  "Exception" doesn't say whether customs is holding the parcel or the courier already sent it
  back. `parseTrackEntry` now pulls `sub_status`/`sub_status_descr` (tolerating the older
  payloads where `latest_status` is a bare string) into **`po_boxes.tracking_sub_status` +
  `tracking_sub_status_descr`**.
  - **Not COALESCEd like the other fields.** Sub-status describes the CURRENT state, so it's
    written whenever a push carries a status — including to NULL. COALESCE would leave
    "Held — security" pinned to a box that has since cleared customs and is moving fine. A push
    with no status at all (a bare checkpoint) leaves both columns alone.
  - **`src/lib/trackstatus.js`** is the shared vocabulary (imported by the API *and* the UI, same
    as `carriers.js`): `subStatusLabel()` turns `Exception_Returning` into "Being returned to
    sender" and de-camel-cases anything unmapped so a new 17TRACK code still reads as words;
    `subStatusTone()` returns **bad** (stuck / returning / lost / failed delivery), **warn**
    (customs, delayed) or **info**. Shown as a toned chip on the supplier portal and PoOverview.
  - **The Sheets payload gained four keys** — `subStatus` (raw, for filtering/pivots),
    `subStatusLabel` (readable), `subStatusDetail` (17TRACK's own text) and `needsAction`
    (boolean). **The Apps Script must be updated to write the new columns** or they're silently
    dropped — the existing columns are unaffected either way.
  - **Schema-touch: `po_boxes.tracking_sub_status` + `_descr` → run `db:setup`.**

## Manifest PDF (printable packing slip)
`src/components/ManifestPrint.jsx` renders **"Manifest PDF: [Per box] [Whole order]"** and
`src/lib/manifestPdf.js` builds it (Letter-size document pages, jsPDF lazy-loaded; the
component downloads the blob rather than printing it inline). Two shapes: **`perbox`** = one
page per shipping label, carrying that label's tracking # + carrier and its expected items;
**`whole`** = one table for the entire order with every tracking number in the header.

**Whole-order (Path C) lines are order-level, not box-level, and `perbox` must not drop
them.** Those lines carry `po_box_id = NULL`, so a strict box match excludes every one of
them; the per-box PDF appends **a final "Whole order — not broken out by box" page** with
the full list, and a box page with no lines of its own says so ("the full item list is on
the last page") instead of "No items recorded for this box". Before this, a warehouse that
linked a Path-C PO in Receiving and hit **Per box** — the sheet the banner tells them to
carry to the pallet — got nothing but empty pages. Two related rules in `linesForBox`:
box ids are compared as **null-or-number** (`Number(null)` is `0`, which used to make every
order-level line "match" a null/0-id box), and **replacement labels** are excluded from the
"Box N of M" count and titled *Replacement shipment* (they're the warehouse's reship, not
the supplier's packing job). Everything the PDF draws is **plain ASCII** — jsPDF's built-in
Helvetica silently drops em-dashes, which is why "Tag / Code —" printed as a blank cell.

**SHIP TO block.** Every page carries the address the boxes are sent to, boxed under the
meta grid — a page separated from the stack still has to be routable. It comes from
`app_settings` (`ship_to_name` / `_street` / `_city` / `_state` / `_zip` / `_phone` /
`_email`) via **`getShipTo()`**, whose **defaults are the live address**, so it prints
correctly with nothing configured; **`po/get` returns `shipTo`** so the PDF and the
supplier portal both get it from a fetch they already make. A *missing* key falls back to
the default but an explicitly **blank saved value stays blank** — otherwise clearing a line
you don't want would undo itself on every read. Admin edits it in **Settings → Shipping
address** (`POST /api/settings { shipTo }`, admin-only; name/street/city/state/ZIP are
required — a name over a blank address is worse than no block at all). The supplier portal
shows the same address as a card, and only while a label is still `pending`/`packed` —
keyed on the LABELS, not `po.status`, since an order can be part-received while one box is
still being filled.

**Money never prints on the manifest.** Costs and tips are on-screen only. The sheet is a
packing slip that travels taped to a box through a courier's hands; what the supplier paid
is nobody's business along that route.

**A third shape: ONE box.** `buildManifestPdf({ mode: 'perbox', boxId })` renders just that
label's page — the sheet the SUPPLIER tapes to the box they've packed. The `Box N of M`
denominator still counts every supplier label on the order, so a loose single sheet still
says which box of the shipment it is. Path C order-level lines still get their back page
(the box page points at it), so a single-box print of a whole-order manifest isn't empty.
`ManifestPrint` takes `boxId`/`boxNumber` and collapses to one button; the file is named
`manifest-<po_code>-box-<n>.pdf`.

**The supplier's pack-out loop:** scan items in → **Review & close box** (`pending → packed`)
→ the close puts a **"Label N is closed"** step in front of them — *print the manifest
(Letter) → attach it to the box → seal it* — with the print button right there. Closing is
the only moment the sheet is guaranteed to match the contents, which is why the step is
attached to it rather than left to be remembered; the modal says so, because **reopening the
label to edit invalidates a printed sheet**. A packed box also carries a standalone **Print
manifest** button (reprints — torn, soaked, or printed before a late edit) and a shipped one
keeps **Print manifest copy** as a record of what went out. Replacement labels don't get it:
the warehouse raised those, the supplier never packed them.

**Available on four surfaces, one component:**
- **PH** — `PoOverview` (`/ph/po-status`), per expanded PO.
- **Warehouse** — `Reconciliation` (`/reconcile`) detail header, and the **Receiving PO
  banner** (Step 1, once a PO is linked) so the sheet can be printed *before* unpacking and
  pairs ticked off on paper.
- **Supplier** — `SupplierApp`, per box, single-box mode (see the pack-out loop above).
  `po/get` already allows the `supplier` role (scoped to their own POs) and returns
  `businessName`, so the letterhead is right with no new endpoint.

**It re-fetches `po/get` on every click** — no caching — rather than using a `detail` the
caller already holds. `po/get` is the only endpoint returning **`businessName`** (the PDF
letterhead) — `po/open` and `po/lookup` omit it, so Receiving's copy would print a generic
header; the caller's lines can also be stale after an on-behalf manifest edit; and the
component stays mounted across `poId` changes (Reconciliation drives the open PO off a
query param), so a per-mount cache could hand back the *previous* PO's manifest. One code
path, callers pass only an id. Cost is one request per print, on an explicit user action.

Hidden on a **blind receipt** in Reconciliation (`summary.no_manifest`): there is nothing to
print, and an empty slip reads as "the supplier declared nothing" rather than "nobody ever
entered a manifest". `po/get` is `requireRole(['ph_team','warehouse','supplier'])` (admin
auto), so no server change was needed to open this to the warehouse.

## Note — circular FK
`batches.po_id → purchase_orders(id)` and `purchase_orders.received_batch_id → batches(id)`
form a cycle. Creation order is fine (PO → batch(po_id) → set received_batch_id). Deletion of
either row is blocked until one link is nulled — the app never deletes these, so it only
matters for manual test-data cleanup (null `received_batch_id` first).

## Phase 1 — endpoints & flow
`api/po/*` (house order: `applySecurity → requireRole → rateLimit → getJsonBody`; supplier
scoped to own POs on every one; admin/superadmin auto-allowed):
- `create` (ph_team) — PO shell + one `po_boxes` row per label.
- `suppliers` (ph_team) — approved supplier accounts for the create picker.
- `list` / `get` — ph_team/warehouse/admin see all; supplier only their own.
- `scan` (supplier) — add/increment a `po_lines` row under a label; **only** while the PO is
  `draft` and the label `pending`. Writes po tables only — never the receiving commit path.
- `line` (supplier) — edit an already-scanned line's **size and/or qty** (`{ lineId, size?, qty? }`;
  qty ≤ 0 removes it), only while the PO is `draft` and the label is `pending`. Changing the size
  into an existing SKU+size line on the same label **merges** them (`updatePoLine`, respecting the
  unique `(po_box_id, sku, size)`). Surfaced as inline size input + qty stepper + remove on each
  line of a still-filling box in `SupplierApp` (`PoLineRow`); read-only once packed/shipped.
- `close-box` (supplier) — review then close a label for shipment: `pending` → `packed`
  (needs ≥1 item). Editing (scan/line) is blocked while `packed`.
- `reopen-box` (supplier) — `packed` → `pending`, to keep editing before shipping.
- `ship` (supplier) — ship a **`packed`** label; PO flips to `shipped` only when no label is
  still `pending` or `packed` (all shipped).

**Box lifecycle:** `pending` (filling — scan items) → `packed` (reviewed & closed, ready to
ship; reopenable) → `shipped` → `in_transit`/`delivered` (tracking). The supplier `ScanModal`
mirrors the warehouse Add-Item dialog (inline continuous camera, 1.2s de-dup, auto-filled size
+ size chips + "+ Custom", re-scan bumps qty, different-shoe switch prompt). "Review & close
box" opens a contents review before closing.

**UI:** PH `CreatePO` lives in PHTeamApp (`/ph/purchase-orders`). Supplier `SupplierApp`
renders for `role === 'supplier'` (any host) and on the `supplier.` subdomain
(`App.jsx` `SUPPLIER_HOST`); the hostname is UX-only — the server scoping is the boundary.

**PDF label import (`CreatePO`):** the Shipping-labels card has an **Upload labels PDF**
button (one shipping label per page). `decodeTrackingPdf` in `src/trackingOcr.js`
(lazy-loads `pdfjs-dist`) reads each page's tracking number — embedded PDF text first
(`pickTrackingFromItems`, carrier-aware: UPS `1Z…`, USPS/FedEx grouped digits, FedEx `96…`),
falling back to rendering the page and reusing the barcode/OCR image path. **Parses each
positioned text item separately** — joining the whole page merges the tracking number into
the adjacent zip / FedEx ASTRA form line and yields bogus numbers; it prefers an item that
is a tracking number on its own, then the most-repeated candidate. It appends one editable
label row per page; blanks are left for manual entry. All client-side.

**PH home (PHTeamApp):** cards are grouped **Pricing & Listing** (New Inventory, Rescale
Stock, Edited Photos, Price Inquiry) · **Purchase Orders** (New Batch, PO Reconciliation) ·
**Requests & Tracking** (No Box, Request Rescale).

## Schema (in `scripts/db-setup.mjs`)
Two entities, deliberately separate so **expected** (supplier) and **actual** (warehouse)
stay independent, and so **supplier scan-out never runs the receiving commit** (which mints
VINs + inserts `items` = phantom stock).

- **`purchase_orders`** — the order shell. `po_code` (`PO-<po_seq>`, from `po_seq` START
  100001), `supplier_name`, `supplier_user_id` → `users(id)` (the supplier account that
  fills it), `status` ∈ `draft | shipped | receiving | reconciled | closed`, `tag_code` +
  `date_of_purchase` (from the PH form), `expected_boxes` (how many shipping labels),
  `received_batch_id` → `batches(id)`, `reconciled_at`, `reconciliation JSONB` (snapshot),
  **`reconcile_note` + `reconcile_note_by` + `reconcile_note_at`** (one editable note per PO;
  `_by` holds the staff display name and is stripped from every supplier-facing response).
- **`po_boxes`** — one row per **shipping label** (outbound mirror of `batch_boxes`).
  `po_id`, `box_number`, `tracking_number` (PH pre-assigns the real courier number),
  **`carrier_key`** (the 17TRACK numeric carrier code chosen in the New Batch dropdown or
  auto-detected from the labels PDF; passed to 17TRACK register/gettrackinfo so it pulls
  from the RIGHT courier), `carrier` (display NAME the aggregator returns), `tracking_status`
  / **`tracking_sub_status`** / **`tracking_sub_status_descr`** / `last_checkpoint` /
  `checked_at`, `status` ∈ `pending | shipped | in_transit | delivered`, `shipped_at`,
  **`kind`** (`original | replacement` — a reship's `po_lines` are excluded from `expected`,
  not forbidden). **Carrier UX:** `src/lib/carriers.js` = curated 17TRACK carriers (UPS/FedEx/
  USPS/… keyed by code) + `carrierName(code|name)` + `detectCarrierKey({text,number})`
  (label-text keyword first, then number format — 1Z→UPS, 96…→FedEx, 9x→USPS, etc.).
  `decodeTrackingPdf` returns `carrierKey` per page; `CreatePO` shows a per-label courier
  `<select>` (— Select courier — · UPS · FedEx · USPS · …) preselected from the PDF; the key
  flows create → `po_boxes.carrier_key` → `registerTracking`/`fetchTrackInfo` (items are
  `{number, carrier}`). `parseTrackEntry` prefers the provider name / maps the code so a
  label shows "UPS" not "100002". **Schema-touch: run `db:setup` (adds `carrier_key`).**
  The PO flips to `shipped` only when **all** its labels are shipped.
- **`po_lines`** — the "what the supplier says he shipped." `po_id`, `po_box_id` (which
  label — **NOT NULL**), `sku`, `size`, `name/upc/colorway/gender`, `qty_expected`,
  `unit_cost`, **`entered_by`** → `users(id)` (staff who entered/last-edited an on-behalf
  line; NULL when the supplier scanned it), **`entered_on_behalf`** bool. **Unique
  `(po_box_id, sku, size)`** — one line per SKU+size **per label**, so the same SKU+size can
  appear under different labels; a re-scan increments `qty_expected` (and re-stamps the actor).
  **Schema-touch: run `db:setup`** (adds `entered_by`/`entered_on_behalf` + seeds the
  `business_display_name` app_setting).
- **`batches.po_id`** → `purchase_orders(id)` — set on scan-in. Reconciliation joins
  `po_lines` (expected) against `items` under that batch (actual), grouped by `(sku, size)`.

## Roles
- **`supplier`** — DB role (`users.role` CHECK includes it). **Self-signup on the
  `supplier.` subdomain, admin-approved**: `signup.js` forces role `supplier` when the
  request `Host` is `supplier.*` (pending until an admin approves); the main host stays
  `warehouse | ph_team` and can't be tricked into `supplier`. Admin can also set it via
  Check Access. Per-PO scoping on every endpoint. See `auth-roles.md`.

## Gotchas
- Schema-drift trap: run `npm run db:setup` on **local and prod** after this lands
  (additive/idempotent — `deploy.md`).
- BIGINT ids come back as **strings** from `pg` — coerce `Number(row.id)` before `===`
  (same trap that caused the multi-box "Box not found" bug).
- Supplier scan-out must write **only** `purchase_orders` / `po_boxes` / `po_lines` — never
  the receiving `commit` path.
