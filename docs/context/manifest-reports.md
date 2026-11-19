# Manifest Discrepancies (the paper in the parcel doesn't match the box)

Screen `src/screens/ManifestReports.jsx` at **`/manifest-reports`** (warehouse/admin home →
Receiving) and **`/ph/manifest-reports`** (PH home → Queues & Requests). Added 2026-11-20.

## Why
Owner, 2026-11-20: *"the manifest says we have 4 of them, but we only have 2"*. Mostly online
orders (the packing slip in the box), sometimes a supplier who sent us no manifest but slipped
one inside. The warehouse must be able to flag it with a **photo of the boxes** and a **photo
of the manifest**, the PH team must hear on Telegram, it is **always urgent**, and it has its
own page.

What already existed: a parcel received against an online order **that is on file** is compared
by the app (`online_order` issue, `docs/context/online-orders.md`). This page is for what that
cannot see: the order is not recorded, the tracking number is not on it yet, the parcel is not
received yet, or the paper is a supplier's.

## The report (anyone in warehouse / PH / admin; the floor's job)
**+ Report a discrepancy** (the form is in the URL, `?new=1`) → `POST /api/inbound-issues/manifest-report`:
- **Online order / Supplier**, tracking # (optional: "leave empty if there is none"), store or
  supplier (required unless the tracking number is on an online order, which fills store + order #
  and offers **Fill in its shoes**), order #.
- **Manifest lists N pairs / In the box M pairs** (required). Optional shoe rows (shoe or SKU,
  size, manifest, in box); once rows are typed the totals add up from them.
- **Photo of the boxes + photo of the manifest: both required**, up to 6 each (R2, the
  inbound-issues `photo-sign`). No escape hatch: without the paper it is not this report.
- Same count on both sides needs a note saying what differs (wrong shoe / size).
- Rules shared by the form and the server: `src/lib/manifestReports.js`
  (`manifestReportProblem`, `manifestTotals`, `cleanManifestLines`, `manifestDescription`).

## What it becomes
An **inbound-issues case**: `scope='shipment'`, `type='manifest'`, `source='manifest'`,
`expected_count` = manifest, `received_count` = box, `photos` = boxes then manifest,
`description` = the whole report in words (so Inbound Issues, its CSV and Copy for supplier
need to know nothing new), and **`inbound_issues.manifest` JSONB** = `{ origin, store,
orderNumber, lines, boxPhotos, manifestPhotos, note }` (**needs db:setup**).
- **No batch needed.** `openInboundIssues` takes the report's own `supplier` / `trackingNumber`
  when there is no batch to copy from. If the tracking number IS a received supplier delivery
  (`findShipmentForIssue`, `kind` receiving only, never in-store / existing), the case is linked
  to that batch / box.
- **One parcel, one case**: an open `manifest` or `online_order` case with the same tracking
  number (letters and digits only) → 409 `{caseId}` (`findOpenManifestCase`). The automatic
  online-order compare asks the same question before opening its own, so a hand report is not
  twinned later.

## Telegram (urgent)
Event **`inbound.manifest_discrepancy`** ("URGENT: manifest doesn't match the box", 🚨, group
Inbound issues): **on by default for PH and admins**, switchable in the bell panel. One message
per report: store / order # / tracking, manifest vs box and the gap, the rows that differ, the
note, and each photo as a link; the button opens the report on the reader's own copy of the page.
It does NOT also fire `inbound.issue_reported`.
- **Re-ping after 1 h** if nobody took it (`MANIFEST_REMIND_HOURS`, the inbound-issues worker,
  production only, once per case). Other cases keep their 4 h.
- It is in the daily inbound-issues summary like any open case.

## The page
Tabs **Not taken · Being worked · Resolved · All** (`GET /api/inbound-issues/manifests?view=`),
search, `?id=` opens one report. A card shows manifest vs box with **SHORT by N** / **N EXTRA** /
"same count, different pairs", store, order #, tracking (courier link), batch if received, the
rows (the ones that differ in red), the two photo groups, who reported and who owns it.
- Lists **both** `manifest` and `online_order` cases: the app's own finds are the same problem.
- PH / admin: **Take it** here (the normal `claim`); everything after that (waiting on the store,
  ask the warehouse, resolve with the refund) is on the case: **Open the case →** Inbound Issues.
- Home: card badge + "Manifest discrepancies not taken" (admins), PH home "Manifest discrepancies
  to take" (`manifest_reports_new` in `pendingCounts`). The same case also counts in the Inbound
  Issues numbers.
- Live through `inbound_issues` (already in `LIVE_TABLES`).

## Tests
`e2e/manifest-reports.spec.js`: both photos required, a real difference required, supplier role
403, the case's fields, duplicate → 409 with the case id, no-tracking report, list + PH claim,
badge count, the page and the form's messages, PH's copy of the page.

## Not yet
- The alert links the photos; it does not attach them as Telegram pictures.
- No "report it" shortcut inside Receive New (the page is one tap from Home).
- Reporting does not change an online order (count in / refund follow-up stay on Online Orders).
