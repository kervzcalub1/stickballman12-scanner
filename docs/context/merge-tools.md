# Merging duplicates — superadmin only

Screen: `src/screens/MergeTools.jsx` at `/merge`. Endpoints:
`api/admin/merge-suppliers.js`, `api/admin/merge-batches.js`. Logic:
`previewSupplierMerge` / `mergeSuppliers` / `previewBatchMerge` / `mergeBatches` in
`api/_lib/db.js`. E2E: `e2e/merge-tools.spec.js`. Added 2026-08-28.

Two tools for the same class of mess: **one real thing entered twice.** "Erick" and
"Erick lujano" are one person; a shipment received as two batches is one inbound.

## Preview, then confirm — both tools, always
Neither merge can be fired from a name alone. The preview counts exactly what would move
(*"1 batch holding 123 pairs, 1 purchase order"*) because **"Erick" carrying 123 units is a
different decision from "Erick" carrying none**, and nothing on the screen would otherwise
tell you which one you are looking at. Both are irreversible from the UI.

## Superadmin, and `requireRole` cannot express that
⚠️ `requireRole(req, res, [...])` **auto-passes anything privileged** — `isPrivileged`
covers `admin` — so a role list can never exclude an admin. Both endpoints use
**`requireSuperadmin`** (`api/_lib/util.js`), which checks `role === 'superadmin'`
outright. The route is gated client-side too: an admin who types `/merge` gets Home, not a
tool whose buttons would 403 halfway through. Guarded by a test that asserts **admin gets
403**, not just that warehouse does.

## Merging suppliers — names only
The dropdown is a UNION of the `suppliers` table and the distinct `supplier_name` values on
batches (`listSuppliers`), so a name can live in either, both, or only on old stock. The
merge rewrites `batches.supplier_name` and `purchase_orders.supplier_name`, ensures the
surviving name exists in `suppliers` (it may only ever have lived on batches), then deletes
the losing row.

**What it deliberately does NOT touch, and why the preview says so out loud:**
- the supplier's **login account** — a credential, not a label;
- their **payout preset** — scoped by `supplier_user_id`, so renaming by name could point
  one person's cost stack at another's money.

The preview lists any account or preset carrying the losing name under *"Left untouched"*.
Silence there would read as "handled".

## Merging batches — the loser is emptied, never deleted
Boxes move first (renumbered on from the target's highest — box numbers are per batch and
nothing enforces uniqueness, so a straight move would put two "box 1"s in one batch; the
**tracking number** is what identifies a parcel anyway, see `purchase-orders.md`), then the
items.

**The loose case is the point of the tool.** The ordinary receive keeps tracking on the
BATCH and leaves `items.box_id` NULL. On merge, those units join the target box whose
tracking number matches; if none matches they become a new box carrying that number; and if
the source has **no** tracking they stay unboxed — inventing a box there would invent a
parcel. That is the PO-100010 shape (`B-100069` + `B-100070`) fixed structurally rather
than at read time.

**Refusals** (all in `previewBatchMerge`, so the UI never offers an impossible merge):
different purchase orders (moving stock across an order boundary silently rewrites two
reconciliations), different `kind` (stock would land in the wrong workflow), a source
already merged, and a target that is itself a tombstone.

### The tombstone, and why the Batch page follows it
`merged_into_batch_id` + `merged_at` + `merged_by` on `batches` (**needs `db:setup`**). The
losing batch keeps its code and holds nothing, because **a batch code is printed on labels
and quoted in PO history** — a code that stops resolving is a dead end for whoever is
holding the paper.

So the Batch page has to handle it, or scanning that code lands you on an empty page —
which is exactly the confusion the "Boxes (0) over thirteen shoes" bug caused the same day
(`receiving.md`). Opening a merged batch **follows the pointer** to the batch that absorbed
it and says *"B-100069 was merged into this batch"*; the list rows show a
`merged into B-…` badge instead of the `Empty` one.

## What QA and the pentest changed before this shipped (2026-08-28)
Both agents ran against the local build before deploy. Nothing was exploitable and nothing
lost stock, but five things were wrong enough to fix first — kept here because each one is
a rule, not a one-off:

- **The tool refused the two duplicate shapes it exists to fix.** Trimming and lower-casing
  the names before comparing them made "Erick"/"erick" and `"Trail Ws "`/`"Trail Ws"` read
  as the same name. `listSuppliers` UNIONs case-sensitively and doesn't `btrim` the
  `suppliers` half, so both really are two rows. Names are now compared **exactly as
  stored**, and the dropdown row is deleted by its raw value — trimming first would delete
  the wrong one.
- **Box renumbering carried a collision in.** The old formula numbered each box by "how
  many source boxes have a lower number", so a source holding two "box 1"s gave both the
  same new number. `row_number()` gives each row its own. Nothing enforces uniqueness on
  `(batch_id, box_number)` — `renumberBatchBox` says so too.
- **A concurrent second apply claimed the first one's work.** The tombstone is now a
  compare-and-swap (`AND merged_into_batch_id IS NULL`); a racer that loses gets told so
  instead of reporting the pairs as its own. Same pattern as `commitBoxItems`.
- **`units` was reported from the preview**, so a call that moved nothing still said "123
  pairs". It now reports what actually moved.
- **Non-string names and oversized ids.** `String()` turns `["Erick"]` into `"Erick"` — a
  malformed request would have run a real merge the UI could never have asked for. Both are
  refused up front now.

⚠️ **Still true, and deliberately not changed:** the merges are **not wrapped in a
transaction** (the shim's `sql.transaction` takes a list of queries, and the loose-box step
needs an id returned mid-sequence). A raced double-apply was tested and lost no stock; a
mid-statement connection failure is **untested**. The compare-and-swap bounds the damage to
"rows moved, tombstone unset", which re-running the merge resolves.
