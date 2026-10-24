# Inbound Issues (a delivery problem → a case PH owns until it is resolved)

Screen `src/screens/InboundIssues.jsx` at **`/inbound-issues`** (warehouse/admin home →
Receiving Shipment Orders) and **`/ph/inbound-issues`** (PH home → Queues & Requests).
Added 2026-10-24.

## Why
The owner's task (2026-10-24, for Kervy, Genesis, Brent, Quincy, Ruby, Hyacinth): Brent finds
damaged parcels, missing / wrong pairs, short deliveries; he set them aside and they sat
there until the owner's 1–2 h warehouse visit, almost daily. Goal: *reported and resolved
without the owner's personal involvement.* Brent → photos → Quincy/Ruby/Hyacinth told →
one takes ownership and works it with the supplier → tracked to resolution → Genesis
oversees.

## Reporting (warehouse) — no Telegram, it's in receiving
The two places the floor already recorded problems now OPEN CASES:
- **Review step, per pair:** "＋ Issue" on a VIN (defect type + note + photos, filed per VIN
  via `api/photos/sign-issue`) → `item_events(type='issue')` as before → **a `pair` case**.
- **Step 4 "Shipment issues":** each `+ Add issue` row now has **Take photo / Gallery**
  (`DefectPhotos` with a `sign` prop → `POST /api/inbound-issues/photo-sign`, R2
  `inbound-issues/<EST day>/…`; no batch exists yet) → `shipment_issues` (new `photos
  TEXT[]`) → **a `shipment` case**.
- **One case per ISSUE** (owner's call, 2026-10-24) — five creased pairs = five cases, but
  ONE Telegram message per submit (`alertInboundIssuesReported`).
- **Not a case:** `no_box` (the No Box queue owns it — shipment auto-issue and per-pair
  defect alike) and `note` (Key notes). `opensCase()` in `src/lib/inboundIssues.js`.
- **Only `kind='receiving'`** batches open cases (`commit.js`, `box-commit.js` →
  `openCasesForIntake` in `api/_lib/inbound-issues.js`). In-store trips have no supplier and
  must never reach PH (`PH_EXCLUDED_KINDS`); boxes orders likewise.
- The saved screen says "N problems were sent to the PH team as cases #…" (`inboundIssues`
  ids in both commit responses).
- **Found after receiving:** Inbound Issues → **+ Report a problem** → One pair (VIN) or The
  delivery (tracking # — a box's own first, then the batch's — or batch code) →
  `POST /api/inbound-issues/report`. Writes the same history rows (`item_events` 'issue' /
  `shipment_issues`) and then the case.
- `openCasesForIntake` never throws: the shipment is saved either way; a failure is logged.

## The HOLD (a flagged pair is not listable until its case closes)
A pair case sets **`items.status = 'issue'`** (status_change event, `inboundIssue` id) and
keeps what it was in `inbound_issues.held_from_status` (`holdPairForIssue`). `issue` was
already out of `listable` / pending counts. Added:
- **PH New Inventory** hides `status='issue'` (`phListItems`, same shape as no_box — the
  admin Report still sees it).
- **Shelving refuses it** (`shelveItems` → `reason:'issue'`; ShelvePage says "held by an
  open inbound issue — keep it aside").
- A pair already held by another open case stays held; its ORIGINAL status is the one kept.
- Sold/shipped pairs are never touched.

## Working a case (PH + admin own; warehouse sees, reports, notes, photos, does jobs)
Statuses: `open` (New, nobody owns) → `in_progress` → `waiting` (on the supplier) → `resolved`.
`POST /api/inbound-issues/action {id, action}` — every move a compare-and-set:
| action | who | effect |
|---|---|---|
| `claim` | PH/admin | open → in_progress, owner = you. Second taker → 409 "X already took #N". Env logins (uid not numeric) can't own → 409 |
| `assign {toUid}` | PH/admin | owner = an approved ph_team/admin (`inboundIssueAssignees`); they get `inbound.issue_assigned` |
| `release` | PH/admin | back to New, no owner |
| `waiting {supplierRef?, note?}` / `working` | PH/admin | in_progress ⇄ waiting |
| `ask_warehouse {task}` | PH/admin | `warehouse_task` → Warehouse to-do tab + `inbound.warehouse_task` |
| `warehouse_done {note?}` | anyone | the floor did it |
| `resolve {outcome, refundAmount?, disposition?, note?}` | PH/admin | outcomes `OUTCOMES`; refund/partial/credit REQUIRE an amount; a pair case REQUIRES `keep` or `returned` |
| `reopen {why}` | PH/admin | resolved → in_progress; the pair is NOT re-held |
| `note {text, supplierRef?}`, `photos {photos}` | anyone | trail / more pictures |
**Resolve, pair:** `keep` → status back to `held_from_status` unless another open case holds
it (`pair.stillHeld`); `returned` → `deleteItems` (Deleted archive, reason "Returned to the
supplier — inbound issue #N"), `item_id` goes NULL by FK, the case keeps its VIN/SKU copy.
The reporter gets `inbound.issue_resolved` saying which.

**The claim facts.** Each case COPIES the shipment facts at report time (supplier, tracking,
PO id+code, batch code, box #, pair SKU/size/name/cost) so it still answers "who do we claim
from?" after a merge or a removal; reads take the live row first (`coalesce`). The online
order is matched by tracking number. **Copy for supplier** on the page puts all of it + the
photo links on the clipboard. CSV export of the shown rows (`inboundIssuesCsv`).

## Oversight (Genesis)
- `inbound.issue_daily` — `api/_lib/inbound-issues-worker.js`, **10:00 EST**
  (`INBOUND_ISSUES_DIGEST_HOUR_EST`), production only (`INBOUND_ISSUES_WORKER=on/off`),
  `once` per EST day. Open count by owner, ⏰ unclaimed 24 h+ (`UNCLAIMED_HOURS`), 🐢 no update
  3+ days (`STALE_DAYS`), resolved yesterday. Admins on by default, PH can switch it on.
- The page flags the same two as red chips (`ageFlags`). "Last activity" = any action/note.
- Home → Needs attention: "Inbound issues not taken" (admins, `adminOnly`), "Inbound issue
  jobs" (warehouse to-do); PH home: "Inbound issues to take". Counts `inbound_issues_new /
  _open / _warehouse` in `pendingCounts`.

## Alerts (`api/_lib/alerts.js`, group "Inbound issues")
`inbound.issue_reported` (PH on, admins shown off) · `inbound.issue_assigned` (the new owner)
· `inbound.warehouse_task` (warehouse on) · `inbound.issue_resolved` (the reporter) ·
`inbound.issue_daily` (admins on). Links land per reader (`at('inboundissues', 'id=N')`).

## API
`GET /api/inbound-issues/list?view=open|in_progress|waiting|mine|warehouse|resolved|all&days=`
(→ rows, counts, canWork, me, assignees) · `GET …/get?id=` (+ events) · `POST …/action` ·
`POST …/report` · `POST …/photo-sign {contentType, id?}`. Roles: warehouse + ph_team (admin
auto). Photos are public R2 URLs like the per-VIN defect photos.

## Tables (db-setup; both in `LIVE_TABLES`)
`inbound_issues` (one row per case; unique on `shipment_issue_id` so a retried commit can't
open it twice), `inbound_issue_events` (the trail). `shipment_issues.photos TEXT[]`.

## Tests
`e2e/inbound-issues.spec.js` — commit with a shortfall + 3 per-pair flags (one no_box) →
3 cases, pairs held, warehouse 403 on claim, double-claim 409, waiting/ask/done, refund needs
an amount, keep → needs_shelf, returned → removed, trail order, page renders the claim facts;
report-by-VIN and report-by-tracking after receiving.

## Not yet
- No backfill: issues recorded before 2026-10-24 stay plain records on their batches.
- No return-label upload (paste the label link / tracking in the warehouse task or a note).
- No courier-claim path (damaged in transit vs supplier's fault) — use the outcome note.
