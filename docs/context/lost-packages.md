# Lost Package Tracker Tool

Built 2026-11-14 (owner): the website's own version of **"Stickballman12LLC - Lost Package Tracker
Tool v1.1.0"**, a local Python/Flask tool started with `run.bat` / `run.command` on one computer.
Purpose: track, month by month, the **online orders that may be lost in transit**.

- Staff page **`/lost-packages`** (admin home → On the Way, an `adminOnly` CARD in a section the
  warehouse also sees) and **`/ph/lost-packages`** (PH home → On the Way). Admins + PH only: every
  endpoint is `requireRole(['ph_team'])` (admins pass automatically); `App.jsx` sends anyone else
  home. Screen `src/screens/LostPackages.jsx`. E2E: `e2e/lost-packages.spec.js`.

## Phase 1 — in the browser (`src/lib/lostPackage.js` `scanWorkbookBytes` / `scanSheets`)
Upload the month's **`Make | Order Updates Sheet | <Month Year>.xlsx`** (30+ daily tabs). Read with
the SHEIN Reprice reader (`openWorkbook` / `readSheet`, fflate). Same rules as the original:
- Every tab's header row finds **Tracking Number / Order Number / status** columns (exact names
  first, then loose; "Tracking Courier/Status/…" can never be the tracking column). No header →
  the Make sheet's positions: **F order, K tracking, O status**.
- Each order is keyed by tracking (`T:`) else order number (`O:`); junk ids (`N/A`, `-`, `none`,
  `pending`, `tbd`…) count as blank; a numeric `1234.0` loses its `.0`.
- Status words are searched in the status cell **and the whole row**: **Refunded › Cancelled ›
  Delivered › Lost** ("delivered", "POD", "left at door", "handed to resident"…). **Lost = nothing
  in the workbook says it was delivered.**
- An `O:` order with no tracking takes one from any other row with the same order number
  (`tracking_fallback`) — the original's Phase 2 order→tracking fallback, worked out once here.
- Excel date serials under "Order Date" / "Estimated Date Arrival" print as YYYY-MM-DD.
- **Two fixes vs the original (QA 2026-11-13):** a NEGATED delivery ("not delivered", "never
  delivered", "wasn't / hasn't been delivered") is not a delivery — the phrase is removed before
  the delivered check (`NEGATED_DELIVERED`); and the loose order-column match never takes a
  date or status column ("Order Date" was being read as order numbers when no "Order Number"
  header existed).
- **Kept as the original does it:** an order whose tracking appears only on ANOTHER tab is two
  orders (`O:<order>` with `tracking_fallback`, and `T:<tracking>`), so unique-order and Lost
  totals can be one high per such order. Phase 2 asks the courier only once for that number.

The run is saved: `POST /api/lost-packages/runs` (header + counts) then `POST /api/lost-packages/orders`
in chunks of 400 (the 256 KB body cap; re-sending a chunk is harmless). `uploaded < order_count`
= an interrupted scan (the page says so; Phase 2 refuses to start).

## Phase 2 — on the server (`api/_lib/lostpkg-worker.js` + `lostpkg-carriers.js`)
Asks the couriers about the run's **Lost** orders, one at a time, 0.75 s apart. The standing rule
for long tasks: the queue is `lost_pkg_orders.p2_state` (`queued → checking → done`), so closing
the page or a restart never stops it (`startLostPackageWorker` in `server.mjs` requeues anything
left `checking`; under `npm run dev` the API kicks it, and opening a running run re-kicks it).
- Routing: **FedEx** numbers (courier cell, or 12 digits) → FedEx Track API first, EasyPost
  (`carrier=FedExDefault`) as fallback; **UPS / USPS / DHL / Canada Post** → EasyPost first, FedEx
  fallback; unknown → FedEx first. EasyPost "unknown" re-polled at 3/6/10/15 s; still unknown →
  **Failed to scan** (never quietly Lost). A number already answered in the run isn't asked twice.
- **Deliberate fix vs the original:** it counted any courier text containing "deliv" as delivered,
  so *out for delivery*, *On FedEx vehicle for delivery* and failed deliveries dropped off the lost
  list. Here **delivered = FedEx code DL / an actual-delivery date / EasyPost status `delivered`**
  only (`courierClass`). Also: FedEx "tracking number not found" (a 200 with an error) now falls
  back to EasyPost — the original filed it as still moving → Lost.
- Buttons (`POST /api/lost-packages/phase2 {runId, action}`): **start** (none → running), **pause**,
  **resume** (paused/stopped → running), **stop**, **recheck** (done/stopped → every Lost order
  asked again — the monthly re-check), **delete** (refused while running). 409 = not from here.
- Progress streams live: `lost_pkg_runs` is in `LIVE_TABLES` and moves on every answer.
- A run is closed (`done`) when its last answer lands while running, OR by the worker whenever
  the queue is empty (`finishIdleLostRuns`) — a Pause/Stop while the LAST order was in flight,
  then Resume, otherwise sat at 100% "Checking…" forever (QA 2026-11-13, now an e2e test).

**Keys (env, never in the repo):** `EASYPOST_API_KEY`, `FEDEX_CLIENT_ID`, `FEDEX_CLIENT_SECRET`
(copied from the original tool's `.env`). Missing → the page says Phase 2 isn't set up; Phase 1
still works. **EasyPost bills per tracker created** — every Phase 2 order is one tracker, a recheck
creates them again. Tests point `FEDEX_API_BASE` / `EASYPOST_API_BASE` at a fake on :5193
(`playwright.config.js`) with fake keys; `LOSTPKG_POLL_SCALE` speeds the re-polls there.

## Downloads (built in the browser, `buildXlsxBook` in `src/lib/xlsx.js` — several sheets)
- **Phase 1 Excel:** Summary · Lost · Delivered · Cancelled · Refunded (the original's columns).
- **Phase 2 Excel:** PHASE 2 LOST PACKAGES · PHASE 2 CANCEL · PHASE 2 REFUND · FAILED TO SCAN ·
  (NOT CHECKED YET, when stopped part-way) · SUMMARY, each row + PHASE2_COURIER_USED / PRIMARY /
  FALLBACK / STATUS / RAW / ERROR / CHECKED (EST).

## Phone
Both tables turn into one card per row at ≤760px (label gutter left, the cell's lines stacked
right — like Undelivered); the run's buttons are 44px; the page leaves room at the bottom for the
floating keypad / advisor buttons.

## Tables
`lost_pkg_runs` (one per month's workbook: counts, `p2_status` none|running|paused|stopped|done,
`p2_total` / `p2_checked` / `p2_last`) and `lost_pkg_orders` (`UNIQUE (run_id, key)`, the Phase 1
row + `p2_*` answer). Not carried over from the original: its debug log bundle (.zip) and changelog
modal — every answer's raw courier text and error are on the row and in the Phase 2 Excel instead.
