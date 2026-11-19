# Receiving evidence — the claim photos, taken while the parcel is on the bench

Added 2026-11-20. Rules `src/lib/receivingEvidence.js` (pure); the gate is Step 4 of Receive
New (`src/screens/Receiving.jsx`); display `src/components/ReceivingEvidence.jsx`.

## Why (Alex, 2026-11-20, after talking to Brent)
"We receive a package, inbound it, and later discover the shipment was short. By then the
shipping box, tracking label and packaging have been thrown away." Shoe Palace asks for a
picture of the original shipping label before it looks at a claim, and at 300–600 pairs a
day nobody can find a carton days later (the Saucony shipment). He asked for: (1) a prompt
to photograph the label during receiving, (2) more photos required whenever a shipment is
short, damaged, missing a manifest or otherwise wrong, (3) attached to the PO / shipment /
receiving record, (4) Hyacinth sees them at once, (5) before the packaging is discarded.

**Not built, on purpose:** recreating or editing a label image. A missing label is said in
words ("no longer available"), never reconstructed.

## What was already there
Only ONE discrepancy forced photos: a parcel that didn't match its **online order** at the
bench (`CLAIM_PHOTOS`: shipping label · every box · packing slip, `online-orders.md`). A
problem typed on the Issues step had optional photos; a short box on a PO and a parcel
received with no manifest asked for nothing. The Manifest Discrepancies report asked for the
boxes and the manifest, not the label. And the photos lived on one issue, not on the delivery.

## The rule now
On every **supplier-delivery receive** (not rescale, not in-store), Step 4 asks:

| Situation | What Step 4 shows |
|---|---|
| Nothing is off | **Photo of the shipping label (recommended)** — one optional photo |
| Short / wrong against the **online order** | the three claim photos, **required** |
| Short / wrong against the **PO's own list** for this box (`manifestSummary`, not clean) | required |
| A problem **typed on the Issues step** (any type except `box_missing` / `box_no_lid`) | required |
| **"Did this package come with a manifest?" → No** | label + boxes required; the slip only "if there is one in the box" |

`evidenceReasons()` builds the reasons (shown on the card, saved with the photos);
`evidenceLeft()` says which photos are still missing. The three: **shipping label** (tracking
number readable) · **every shoe box that arrived, in one picture** · **packing slip /
manifest** ("There was no packing slip in the parcel" is the one way past the third).
*Finish batch / Submit box* is refused until they are taken. The gate is in the page, like
the online-order one it grew from; the endpoints accept a commit without photos (the API
tests, and nothing on the floor can skip the page).

## Where the photos live
On the **receiving record itself**: `batches.evidence` JSONB, or `batch_boxes.evidence` when
the receive was one box of a multi-box batch (**needs db:setup**):
`{ label:[url], pairs:[url], slip:[url], noSlip, reasons:[…], by, at }`. Sent as `evidence`
on `POST /api/batches/commit` and `/box-commit` → `cleanEvidence` (https links only) →
`saveReceivingEvidence` (a re-opened box ADDS photos, never drops earlier ones). Uploads use
the inbound-issues `photo-sign` (R2 `inbound-issues/<EST day>/…`).

Because a case already joins its batch and box, **every case about that delivery shows them**
(`INBOUND_ISSUE_COLS`: `coalesce(bx.evidence, b.evidence) AS evidence`) — the ones opened at
that submit AND one opened days later:
- **Inbound Issues** case and **Manifest Discrepancies** card: "Photos taken at receiving",
  grouped Shipping label / Boxes that arrived / Packing slip, who and when, why they were
  asked for. **Copy for supplier** lists each link under its kind.
- **Batch page**: the same block, per batch and per box.
- **Telegram** (`inbound.issue_reported`): "📷 Taken at receiving: label ×1, boxes ×2, …".
- **Found later** (`online-order-received.js`): when the delivery already has the label and
  the boxes (`evidenceCoversClaim`), the case says so and the warehouse is NOT sent the
  "photos needed for the claim" job — the carton it would ask for is gone anyway.

The automatic `online_order` shipment issue still carries the photos in its own `photos`, as before.

## Manifest Discrepancies report
The form (and `manifestReportProblem`, shared with the server) now asks first for a **photo
of the shipping label**, or the tick **"The carton is already thrown away — there is no
label to photograph"** (`manifest.noLabel`, written into the case's description and the
alert). `manifest.labelPhotos` leads the case's photos and the Telegram message.

## Tests
`e2e/receiving-evidence.spec.js` (the rules; a clean receive is asked, not blocked; a later
case shows the label), plus the gate walked in `receiving-issues-notes` (typed problem),
`receiving-manifest-audit` (no manifest), `receiving-online-order` (online order) and
`manifest-reports` (label or "carton gone"). `e2e/helpers/claimPhotos.js` stubs the uploads.

## Not built
- The label photo on a clean receive is recommended, not required (one switch:
  `claimNeeded` in `Receiving.jsx`).
- Box mode does not re-ask the manifest question, so "no manifest" gates only the first box.
- Photos are not attached to the PO page or sent as Telegram pictures (links / counts only).
- Existing batches have no evidence; nothing is backfilled.
