# Version 6 Plan — Receiving/Intake Upgrade

**Source:** Team call (`call-summary.txt`) + Alex's shipping-label video.
**Target:** Early July (1st–2nd week), quality over speed.
**Scope:** Almost everything touches the **Receiving** flow
(`src/screens/Receiving.jsx`, `api/batches/*`, `api/_lib/db.js`,
`scripts/db-setup.mjs`). Rescale reuses this screen — keep changes `isRescale`-aware.

Decisions below are **locked from the follow-up**. ✅ = confirmed.

---

## 1. Custom vendor names, auto-saved ✅

Type a new supplier (e.g. "JD Sports") → it's **auto-saved** to the dropdown for
next time. No "save" button.

- New `suppliers` table (`name UNIQUE`), seeded with current `SUPPLIERS` + "JD Sports".
- `GET /api/suppliers` loads the dropdown; commit upserts any typed name.
- Any warehouse user can add (it auto-saves on use).

## 2. Default buyer = "stickballman12" ✅

Already done. No work.

## 3. Newest scanned **shoe** on top ✅

In the batch's item list, the most recently scanned/merged shoe shows at the
**top**. (This is shoe/line ordering — sizes *within* a shoe sort by size, see #6.)

## 4. Batch Review screen ✅

Before submitting a box, a review pass to:
- Edit a line (name/SKU/size/qty/box status), or delete it.
- Add a **per-unit (VIN) issue**: note + optional defect photos.

Per-unit issues stored as `item_events` (`type='issue'`, photo URLs in `details`
JSONB) — no schema churn. Review list is size-sorted (#6).

## 5. Photos — listing + defect ✅

**Storage: Cloudflare R2** (S3-compatible, no egress fees). Presigned uploads;
keys server-side in `.env`.

**Listing photos — per SKU, shot by warehouse during scanning** (inside the
floating Add-Item modal). Instead of a generic "3–5", use **5 angle slots** with
icons; staff fill them in any order:

| Slot | Icon |
|---|---|
| Side | 👟 |
| Diagonal | ◰ |
| Outsole | 👣 |
| Top view | ⬓ |
| Rear view | ◗ |

- **Min 3, max 5** angles. Each slot = capture/replace independently.
- **Dedupe by SKU:** if the SKU already has photos in the DB, show "✓ Has photos"
  and skip the prompt (reuse existing). Only prompt for new SKUs.
- Schema: `product_photos` (`sku, angle, url, created_by, created_at`).
- Endpoints: `POST /api/photos/sign` (presigned PUT) + `POST /api/photos/attach`.

**Defect photos — per VIN**, attached to the per-unit issue (#4), not the SKU.

## 6. Sort sizes smallest → largest ✅

Sizes auto-arrange **ascending regardless of scan order**, in **both** places:
- the batch item's size list, **and**
- the scanning floating modal's size rows.

Example: scanned `8, 5, 9, 7` → displays `5, 7, 8, 9`. Numeric-aware (handles
Y/W suffixes via existing size-kind detection).

## 7. Multiple boxes per batch + tag ✅

**Confirmed by the label video:** each label shows "X **OF 20**" (total boxes),
its own **tracking #** (1 tracking = 1 box), and a handwritten **tag** the staff
type in (e.g. "Joey JP23 AJ40 & BOGO ATF Tyler").

**Schema**
- `batches`: add `batch_tag TEXT` (free text, staff-entered), `expected_boxes INT`,
  and let a batch stay **open** across days (`status='open'` until closed).
- `batch_boxes`: `id, batch_id, box_number, tracking_number,
  status(pending|received), received_by, received_at`.
- `items`: add `box_id` → links each unit to its box (and that box's tracking).

**Flow — Batch Page hub** (your proposed flow, made resumable):
1. **Enter batch details** (supplier, tag, expected boxes, date, cost).
2. Land on the **Batch Page** — shows all boxes + progress (e.g. `3 / 20 received`).
3. **Select / add a box** (enter its tracking #) → scan shoes into that box.
4. **Review** that box's shoes → **submit the box** (mints VINs for it).
5. Return to the **Batch Page** for the next box — including **next-day** arrivals.
6. Close the batch when done (or leave open for late boxes).

**Recent batches list:** sort **newest batch first**. Each opens its Batch Page so
staff can view every box, review each box's shoes, and add boxes that arrive later.

**Batch completion:** a batch **auto-completes** when boxes received == expected
boxes (e.g. all 20 scanned) → it drops off the "in progress" view. Staff can also
**manually mark done** as a fallback (e.g. only 18 of 20 ever arrived), and can
**change the status anytime** (reopen a done batch to add a late box, or mark an
incomplete one done). No one has to remember a step in the normal case.

Concurrency: per-box commits + append-only items → multiple staff can work the
same batch without overwriting.

## 8. Duplicate tracking-number alert ✅

On entering/scanning a tracking # (and at commit), check existing tracking #s
(`batches` + `batch_boxes`). If matched → non-blocking warning ("⚠ Already received
in B-1023"); proceeding creates a separate box/batch flagged as duplicate
(`duplicate_of` reference + badge). Low priority.

---

## Schema summary (all `IF NOT EXISTS` in `db-setup.mjs`, run `db:setup` everywhere)

- **New tables:** `suppliers`, `batch_boxes`, `product_photos`.
- **`batches`:** `+ batch_tag, expected_boxes, status(open), duplicate_of`.
- **`items`:** `+ box_id`.
- Per-unit issues + photos ride existing `item_events` (`type='issue'`).

## Build order (toward early July)

**Phase A — quick wins:** #2 (done), #3 newest-on-top, #6 size sort, #1 vendors,
#8 duplicate warning.

**Phase B — photos:** R2 + presigned endpoints → #5 angle-slot listing photos
(per SKU, dedupe) + defect photos → #4 review screen with edit/delete + per-unit
issues/photos.

**Phase C — boxes (biggest):** #7 multi-box batches, tag, expected boxes, Batch
Page hub, resume, concurrency.

## Notes
- Update `docs/context/receiving.md` + `data-model.md` as features land.
- $100 max-plan upgrade approved (Alex) — not a code task.
