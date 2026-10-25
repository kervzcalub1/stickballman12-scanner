# Pre-sell Listings — list straight to Alias + StockX, with its own stock

Built 2026-10-07. Screen `src/screens/PresellListings.jsx` at **`/presell-listings`** (staff
home → In-Store Mode) and **`/ph/presell-listings`** (PH home). Warehouse, PH, admin.
E2E: `e2e/presell-listings.spec.js` (never reaches a marketplace).

**Not the Pre-sell screen** (`pre-sell.md`, `items.pre_sell`, `api.presellList`…), which
holds back units of a shipment we own. Here a pair is **never an inventory unit** and
**never goes through Shopify** — the point is listing without Nikki entering it.
(Client methods are `api.presellListings*` — `api.presellList` was already taken.)

## The model — its own stock
- `presell_stock` — one row per **SKU + size**: `qty` (pairs we have, incl. sold), `sold`.
- `presell_listings` — one row per marketplace listing: `platform` alias|stockx,
  `external_id` (the platform's listing id — the handle for EVERY later call and for
  matching a sale), our `status` pending|live|off|sold|deleted|failed, the platform's own
  `platform_status`, `pending_op`/`pending_action` while StockX works.
- `presell_sales` — one row per sale, **unique (platform, order_id)**: the watcher sees
  the same order every poll and it lands once.
- **Never oversell** (`reconcileStock`): a platform may hold at most `qty − sold` open
  listings for a size. After every sale (or a pair-count cut) the newest extras come down
  on BOTH platforms. Activating is refused once a size is sold out.
- New pairs: the cart ADDS `qty` to the stock row, then each ticked platform is listed up
  to what's left (`topUp`, `api/_lib/presell-create.js`). A failed listing stays as pairs
  in Stock → retry with **List N** there (re-sending the cart would add the qty twice).

## Screen
- **List new**: scan a box UPC / type a SKU → tap sizes (a box scan adds its size). Per
  line: pairs, ☑ Alias + price, ☑ StockX (Direct) + price, each with that platform's
  market — tap a number to use it. "Go live now" (default on). Confirm → create.
- **Stock**: per SKU+size pairs / sold / left, live+other per platform, **List N**
  (top up a platform), **Pairs…** (set the count; can't go below sold; cuts take down extras).
- **Listings**: Both/Alias/StockX × Open/Live/Not live/Pending/Sold/Deleted, search by
  SKU/name/listing id. **One row per PAIR** (owner's sheet layout, 2026-10-08): a stock
  row's StockX and Alias listings are matched oldest-first (pair 1 = first listing on
  each), so a size with 2 pairs is 2 rows. Platform column = two pills, "StockX (ON)" /
  "Alias (OFF)" (green/red; PENDING blue, SOLD violet, "(—)" = not listed on it), each
  a menu: Go live / Switch off, **Edit** (price; size on Alias only — the pair moves to
  that size's stock row), re-read, copy id, Delete. **More…** = the row: switch both
  on/off, re-read both, delete both. Grouping is client-side (`ListingsTab` `pairs`).
- **Sales**: every sale, price, payout, order #, whether the Telegram post went out.
- **📦 Fulfill**: the sold orders still to ship — label, tracking, ship-by, where the pair is, pick list → `presell-fulfillment.md`.

## In transit — list it before it lands (Alex, 2026-10-10; BY THE PAIR since 2026-10-11)
For a hyped shoe still on the truck: list it now; as the real pairs arrive and PH lists them,
the pre-sell listings come down one for one.
- **List new → ☑ 🚚 In transit** (+ note, expected date, supplier/PO/tracking) → `presell_stock.in_transit`.
- ⚠️ **2026-10-11 incident:** the first build took ANY receive of the SKU + size as "arrived" and
  DELETED every unsold listing. Brent received the first 37 of 213 IQ5495-005 pairs (B-101354,
  supplier Joey) and 162 pairs' listings (×2 platforms) came down. Repaired with
  `scripts/presell-repair-arrival.mjs --sku … --batch … [--apply]` + Stock → **↺ Restore**.
- **Arrival = a COUNT** (`presell-arrival.js` `onItemsReceived` → `countArrival`, from
  `insertItems`, fire-and-forget; any batch except Existing Stock): `arrivalSplit` — the pairs
  received first cover pairs SOLD in transit (**set aside** for those buyers), the rest are
  **released** to PH. `presell_stock.arrived_qty` / `released_qty`; `arrived_at` only once EVERY
  pair has arrived; `presell_arrivals` = one row per counted receive. Guarded on the arrived count
  (racing commits retry). **Nothing is deleted on arrival.** Post: 📦 N PAIRS ARRIVED — arrived so
  far A of Q, set aside / inbound and list, still owed to buyers.
- **PH takes over** (owner, 2026-10-11 — "delist them when Nikki / PH is done listing them"): a
  pre-sell listing comes down on a platform when PH lists a released pair there — the PH grid's
  **AL / SX** flag (`items.synced_alias/stockx`) on an item of that SKU + size in a counted batch,
  or that pair sold. `listableOn(s, p) = qty − sold − min(released, ph_<p>_n)`; `reconcileStock`
  and `topUp` both use it (`presellListable`). Triggered after every PH save (`api/ph/update.js`
  `afterPhSave` → `onPhSaved`) and every 15 min (`checkReleased`); post 🔄 PH LISTED ARRIVED PAIRS.
- Sale posts: owed-to-buyers once some pairs arrived ("set aside from the next arrivals").
- **Delete reasons** (`presell_listings.delete_reason`, backfilled): user · sold_other · qty_cut ·
  arrived (old rule) · ph_listed · platform — shown under the pill on the Listings tab.
- **↺ Restore** (Stock tab, per shoe): every short size × platform in one go, prices pre-filled with
  the last price (⚠️ Alias's can be stale — "Use current lowest ask"), sequential, Stop.
- Only where `PRESELL_WATCH=on`. Tests: `e2e/presell-in-transit.spec.js`.

## The PO guard — never pre-sell more than the order has (2026-10-23, store-orders-plan §4.9)
Joey's manifests were wrong, so pairs that never existed were pre-sold. `presell_stock` is one
row per SKU + size across every purchase, so `presell_stock_po (stock_id, po_id, qty)` records
how many of a row's pairs were listed against EACH order.
- **The cap:** `create` (with a `poId`) and the Stock tab's `qty` raise refuse (409
  `over_po`) when pairs listed against the order for that SKU + size would pass what the order
  lists: "PO-1234 lists 5 of DZ5485-612 size 10 — 3 already pre-listed, you're adding 4."
  "What the order lists" = its order-level lines (receipt / store list / whole-order
  manifest), else its non-replacement labels' lines; matched like the reconciliation
  (`rcCodes` / `rcSizeNum`, so `9W` = `9`; a GS `7Y` and men's `7` collide — shared limit).
  An order with no list yet is allowed with a warning. Lowering is always allowed. The
  refusal happens BEFORE any marketplace call. `qty` changes are booked against the row's
  CURRENT PO. Pairs listed with NO order picked onto a row that is already linked to one
  count against that order (`presellStockBySkuSize`) — they used to slip past its cap.
  Re-pointing a row (`details`) MOVES its count to the new order (`movePresellStockPo`;
  allowed even over the new cap, shown as over) and resets its at-risk marker (review
  2026-10-25 — it used to move nothing, so a row listed with no PO and linked later counted
  against nothing).
- **Sales remember their PO:** `presell_sales.po_id` = the row's PO at the sale (an older
  sale with none counts for the PO its row points at).
- **At risk** (`presellPoStatus`): once the order has LANDED (`getPoLanded`, or it is
  reconciled/closed), `sold against it − received on ITS batches` — cancelled sales
  (`ship_state='cancelled'`) don't count, and never more than the sales still waiting to ship
  (a shipped sale found its pair) — (not "arrived on any
  shipment", shown beside it). Stock tab: "PO lists N · pre-listed M" (amber when over) and
  "sold X, arrived on PO Y → Z orders at risk" (red); Inbound's pre-listed rows say the same.
  `checkAtRisk` (watcher, every 15 min, `PRESELL_WATCH=on` only) posts to the pre-sell group
  when a row's number changes, and again when it clears (`presell_stock.at_risk_alerted`).
- Tests: `e2e/po-presell-guard.spec.js`.

## Paste a message (2026-10-10)
**📋 Paste message** next to Find: Alex's shape (`src/lib/presellPaste.js`) = a style code
line, an optional name line, then `size x pairs` lines (`8x 12`, `8.5 x 14`, `10 × 26`,
`9*19`, `7W x 3`). No name is fine; several shoes in one message too (each style code starts
one). The same size twice adds up. Anything else (`8-9 x 2`, chat text) is listed as *not
understood* and left out, never guessed. Preview → **Add N pairs** fills the cart (name/photo
from our SKU lookup when we have one), ticks Alias + StockX and **🚚 In transit**.
**Batches:** the create endpoint takes ≤ 100 listings a call, so the cart is sent in batches
of WHOLE lines (Alex's 145 pairs = 290 listings → 3 calls) with progress on the button. A
line is never split (re-sending a line adds its pairs again). A failure mid-way names what
already went. One size over 50 pairs is flagged in the preview (the per-line limit).

## Listings tab: one card per SKU + size (owner, 2026-10-10)
26 rows of the same size was overwhelming, and the team is on phones. Now one **card per
stock row (SKU + size)**: photo, SKU · size, name, **N pairs**, and per platform a summary
(`StockX 5 ON · 4 PENDING · 17 —`, where "—" = pairs with no listing on that platform;
`Alias 26 ON`), plus "N with a problem". Shoes by latest activity, sizes smallest first.
**Tap** → the pairs (#1, #2…), each with its StockX + Alias pills and a "⋯" menu (switch
both on/off, re-read, delete) as before. Phone layout: pills share the row and shrink, no
sideways scroll (checked in the test).

## The "listed" post (Alex, 2026-10-10)
After a listing run (one paste can be several create calls), the page calls
`POST /api/presell-listings/announce { stockIds, since }` once. The server builds ONE post to
the pre-sell group from OUR rows (listings created since the run started, not failed/deleted):
**🚚 LISTED — IN-TRANSIT PRE-SELL** or **📝 LISTED — PRE-SELL**, total pairs + who, per shoe:
shipment note/expected, `size × pairs`, and per platform the count and price range ("(N not
live yet)" while StockX confirms). Best effort: a Telegram failure never undoes a listing.
The arrival post reads **📦 INBOUNDED — in-transit pre-sell arrived, listings taken down**.

## Cost for the purchase (2026-10-10)
Cart → **Supplier preset (costs)** (the Payout Calculator presets) → **✎ Edit for this
purchase** (tax, gift card, store, promo, cashback %, tip and shipping $). Edits apply to
THIS purchase only; the saved preset is never written (*edited for this purchase* chip,
*Reset to the preset*). Per line **Shelf $** (+ *Shelf price for all*) → **Cost** = landed
cost (`landedFromShelf`, the same formula as receiving and Costs). Under each platform's
price: **Payout** (default fee: Alias 9.9 %, StockX 10 %) and **profit**.
**Shelf price is a cost on its own (owner, 2026-10-25 — replaces "no preset → no cost"):** the
fees are added ON TOP of it. No preset → cost = shelf price, net = payout − shelf, labelled
**"shelf only"** (Stock tooltip, sale post `(shelf $110 · shelf only)`, report Preset column).
No shelf price → no cost (blank, never $0). **Our own fees** (menu option `own`, for a supplier
with no preset): the same 7 fields from zero, for THIS purchase, never saved as a preset →
`cost_stack.own = true` (preset/presetId null), shown as "own fees". One formula,
`presellUnitCost(shelf, stack)` + `costBasis(stack)` (`src/lib/presellDetails.js`), used by
create, ✎ details, the screen. A re-list with a shelf but no fees uses the row's saved fees
(so the cost agrees with the kept `cost_stack`). `db:setup` backfills rows with a shelf price,
no fees and no cost → cost = shelf. **Pre-sell only:** receiving / Costs still leave a cost blank
without a preset (`landedFromShelf`, cost-is-shelf-plus-preset).
Saved on `presell_stock`: `shelf_price`, `unit_cost` (the SERVER recomputes it from the
stack, not trusting the browser) and `cost_stack` (JSONB snapshot: preset name/id, edited,
the numbers). A re-list without a cost keeps the one already there.

## Cost & shipment after listing · net on the sale post · reports (owner, 2026-10-10)
- **Where it's from** (List new, under the cost; and the editor below): **Supplier** (typed, or
  suggested from preset/PO supplier names; picking a preset fills it when blank), **PO** (picker of
  POs not closed — `list?tab=pos`, with each PO's label tracking numbers), **Tracking numbers**
  pasted many at once (`parseTrackingList` in `src/lib/presellDetails.js`: any separator, words
  dropped, 8–40 chars with ≥ 6 digits, de-duped, ≤ 200). Columns on `presell_stock`: `supplier`,
  `po_id` (→ purchase_orders, ON DELETE SET NULL), `tracking_numbers TEXT[]`. A re-list adds
  tracking numbers (union) and keeps supplier/PO unless new ones are given.
- **Stock → ✎ Cost & shipment** (per SKU; every size ticked to start, each keeps its own shelf
  price): Cost (preset + edit for this purchase + shelf per size → landed cost), Where it's from,
  In transit (note/expected; ticking it on a row that wasn't re-arms arrival). `POST action
  {action:'details', stockIds, cost?:{costStack, shelf:{id:price}}, supplier?, poId?,
  trackingNumbers?, inTransit?, transitNote?, expectedOn?}` — only the sections touched are sent,
  so a cost fix never wipes tracking. The server recomputes `unit_cost`; shelf without fees →
  cost = shelf ("shelf only"). Stock table: Cost column, "supplier · PO · N tracking" line, a count of
  sizes with no cost.
- **Sale post layout** (owner, 2026-10-10: too compressed): title, blank line, shoe + SKU/size,
  then sections split by a `━━━` rule — **💵 MONEY** (Price / Payout / Cost / ✅ NET, one per line,
  bold labels), **🧾 ORDER** (order, supplier, PO, shipment, tracking), **📦 WAREHOUSE** or
  **⚠️ SOURCE IT** (what to do). Lines are strings or `{ b, t }` (bold label + plain text) in
  `sendPresellSale`. The INBOUNDED post uses the same rules.
- **Sale post NET** (`handleSale`): `Price: $175 → payout $162.75` (the platform's own payout; "(est.)"
  = price less the default fee when it gave none) then `Cost: $X (shelf $Y · preset) → NET $Z`, or
  "Cost: not entered — no net figure". Plus supplier · PO · tracking. One function, `saleNet`, for
  the post, the Sales tab (Cost / Net columns + totals) and the report. Cost is read from the stock
  row at the time, so a cost entered after a sale shows in the Sales tab / report (not the old post).
- **📄 Report — one per tab** (owner, 2026-10-10), from/to dates (EST) → **⬇ PDF / ⬇ CSV**, built
  client-side from one fresh read (`src/lib/presellReport.js`, jsPDF lazy, ASCII-only in the PDF):
  - **Stock** (day first listed; list filtered too): the pairs we have — pairs / sold / left, In
    transit / Arrived / Pre-sell, supplier, PO, tracking (all in CSV), shelf, preset, cost,
    left-at-cost; PDF has a bold subtotal per SKU.
  - **Listings** (day the listing was created; the tab's platform + status filter apply, named on
    the report): every listing — platform, status, price, est. payout (default fee), est. net (only
    with a cost), listing id, listed by, last problem.
  - **Sales** (day sold; list filtered too): price, payout (* est.), cost, net, supplier/PO, kind;
    totals count net only over sales with a cost.
- **Inbound**: `/api/inbound` returns `presell` (rows linked to the listed POs, `presellByPo`); a
  shipment shows "🏷 Pre-listed N · sold M" and, opened, the sizes with "set M aside, inbound the
  rest". The LISTED and INBOUNDED posts carry supplier · PO (· N tracking numbers).
- Tests: `e2e/presell-cost-shipment.spec.js`.

## Sales report: cost of every sale + why none, SKU filter (owner, 2026-10-25)
"The Sales report says no cost but we set the shelf price." The report read only the cost SAVED
on the stock row (`unit_cost`) — read live, never stamped at sale time. Now `withPresellCost`
(db.js) resolves it at READ time with the pre-sell rule (`presellUnitCost`: shelf IS the cost,
fees on top when picked), nothing written:
1. saved cost → `cost_source 'entered'`;
2. shelf on the row, no cost saved (a row from before e6d56ab whose db:setup backfill hasn't run)
   → `'shelf'`;
3. no shelf on the row → the **shelf price on the PO line** for that SKU + size (order-level line
   first; reconciliation matching) through the row's fees → `'po'` ("from the PO");
4. else blank with `cost_reason 'no_shelf'`.
Used by the Sales tab, the Stock tab and the sale post. The Sales tab shows the reason under "—",
"Without a cost: N no shelf price", how many were costed from the PO; CSV column "Cost from / why
none" (`costNote` in presellDetails.js). **SKU filter** next to the dates: `?sku=` (urlstate),
part of a SKU, any case (`listPresellSales({ sku })`, ILIKE); it filters the totals, the list,
the PDF (named in the scope line) and the CSV. Tests: `e2e/presell-sales-cost.spec.js`.

## 📦 By box — tracking numbers per BOX, not per size (owner, 2026-10-24)
Plan + reasoning: `docs/presell-box-tracking-plan.md`. **We hand the supplier every tracking
number** (our labels on the PO); they buy and pack, often MIXING sizes in a box (3 × 8, 3 × 9,
3 × 10). So a size's boxes are DERIVED from what each box holds — never typed against the size.
- **Source of a box's contents** (`presellBoxesFor` in db.js), per label (`po_boxes`, reships
  excluded) of every PO the row is on (`presell_stock_po` ∪ `po_id`):
  1. the supplier's per-box list — `po_lines` with a `po_box_id` (scanned, or typed on their
     behalf) — **always wins** for a box that has one;
  2. else **`presell_box_lines`** (`po_box_id`, sku, size, `qty` — NULL = "some, count
     unknown"), typed here. For a WHOLE-ORDER manifest, where `po_lines` can't carry a box (an
     order can't mix the two). It **never** feeds the PO's expected / reconciliation.
  Matching is the reconciliation's (dual style codes, `rcSizeNum`: supplier 10 = our 10W).
  `received` = a receiving box tied to the label (`batch_boxes.po_box_id`, or same tracking #).
- **A box count = PHYSICAL pairs** (review 2026-10-25): the supplier's list counts every pair of
  the order in the box, not only pre-sold ones. So each ORDER is judged on its own
  (`presellBoxesFor` → `{ boxes, pos }`, `boxSummary(row)`): **not in a box yet** = pairs
  pre-listed on the order − counted pairs in its boxes; **over** = counted pairs in its boxes −
  the order's own ORDER-LEVEL list for the size (`po_lines` with no box) — only when it has one.
  (Comparing boxes with pre-sold pairs called a 20-pair order with 10 pre-sold "10 too many".)
  Per-box declarations are never a cap (an undeclared label would always read "over").
- **One label, nobody declared it** → everything is in that box (`source: 'only_box'`), nothing
  to type; the grid says so.
- **Stock tab**: under each size, one line per box in LANDING order (`boxOrder`: received →
  delivered → soonest ETA): "3 in 1Z…4784 🚚 in transit · exp 10/27", then "N not in a box yet"
  / "not in a counted box" (amber, a to-do) or "⚠ N more in boxes than the order lists". Rows
  with boxes drop the old "N tracking" count. Helpers: `src/lib/presellBoxes.js` (pure, shared).
- **📦 Boxes** (row button, PO-linked rows) → grid for one SKU on one PO: a row per label, a
  column per size pre-listed against that PO; a number or **?**; supplier-declared boxes are
  read-only (and says so when it replaced something typed here earlier — `replaced`); type ALL
  pairs in the box, not only pre-sold ones; "same as last box", "fill the rest" (up to the order's
  count, else the pre-listed pairs), footer "in boxes / order" (or "/ pre-listed" with no order
  list). Saves per box: `POST action {action:'boxContents', poId, boxId, sku, lines:[{size,
  qty|null}]}` (replaces that SKU in that box; 409 `over_boxes` when the order's boxes would hold
  more of a size than its order list; 409 on a declared/reship box; 400 on a size not pre-listed
  against the PO). Read: `GET list?tab=boxgrid&po=&sku=` (sizes carry `pairs` + `expected`).
- **Tick rows → 📦 In boxes (count unknown)…** — "these sizes are somewhere in these boxes":
  `action:'boxUnknown', stockIds, boxIds` adds a `qty NULL` line per (size, box) that has none
  (a counted line is never overwritten); one PO at a time, rows must be on it (current PO or
  pairs listed against it).
- **✎ Cost & shipment → ＋ Make a PO for this buy** (rows on no PO; PH/admin): opens a PO for the
  typed supplier with ONE LABEL PER TRACKING NUMBER (registered with 17TRACK like `po/create`),
  NO lines (the supplier still scans per box, or PH fills 📦 Boxes), links the rows (`po_id` +
  `presell_stock_po` = qty). 409 if a tracking # is already on an order (link to that one).
  Races (double click, two people): the link takes only rows still on no order, and a PO that
  linked nothing — or whose tracking #s turned up on another order meanwhile — is deleted again
  (`deleteEmptyPo`); 17TRACK is registered only after a successful link.
  `action:'makePo', stockIds, supplierName, trackingNumbers`.
- **Uses**: the IN-TRANSIT SALE post shows **Box:** (`boxForSale`: the OWED-th pair among the
  boxes NOT received yet — arrived pairs were already split by the arrival, so a received box is
  never named; no box line once every pair is here) instead of the tracking list; the ARRIVED post names the box(es) the pairs came
  out of (`trackingForBatchBoxes`); Fulfill gives each in-transit order its box
  (`presell-fulfillment.md`); the Stock CSV has a **Boxes** column, the pick list a **Box** one.
- Live: `presell_box_lines` is in `LIVE_TABLES`; the Stock tab also listens to `po_lines` /
  `po_boxes`. Tests: `e2e/presell-boxes.spec.js`.

## ⚔ Market competition + 🔒 price lock (owner, 2026-10-11)
Tab **⚔ Compete**. Engine `api/_lib/presell-compete.js`, from the worker every
`PRESELL_COMP_EVERY_MIN` (default **15**) — only where `PRESELL_WATCH=on`.
- **🔒 Lock** (`app_settings presell_lock`, ON unless 'off'): every LIVE pre-sell size, competing
  or not. `presell_stock.lock_<platform>_cents` = the price THIS APP last set; NULL → adopt the
  live price at the next check (shipping it never pushed Alex's $161 back to the stale $284). A
  live price ≠ lock (Alex's Alias bulk reprice — it can't be kept off our listings: same account)
  → put back (`restore`). Lock off → the outside price is kept and logged `drift`. Set by: every
  engine move, a price edit in the app (action.js update), adoption. Only ONE listing per size is
  read back each check (a change to only some listings of a size goes unseen until the next move).
- **Competition**: Undercut $1 / Match lowest ask; never more than **$5 under the price we set**
  (`comp_base_<platform>_cents`, = the lock when the size first competes; reset by an in-app price
  edit or "reset floor"); market **up** → follow it (undercut $1 under, no cap); lowest ask = our
  price → hold (the platform's lowest ask may include OUR listings — then we can't see a rise while
  we're the lowest). Decision is from the LOCKED price, so an outside change never moves the floor.
- **2-hour rule** (`compFarCheck`): market under our floor for 2 h straight (`comp_state.far_since`)
  → the market becomes the new price we set (base), the mode applies from there (`rebase`).
- **Who takes part** (`compEffective`): master (`presell_comp_master`, off by default) → size
  override (`comp_override` on/off/NULL) → shoe (`presell_comp_sku`) → All shoes
  (`presell_comp_all` + `_all_mode`).
- Per size × platform with live listings and nothing pending: read our listing back, lock check,
  market (Alias: lower of With You / consigned lowest; StockX: Direct lowest ask), decide, update
  every live listing one at a time (a 429 ends the pass). `comp_state` JSONB for the screen,
  `presell_comp_log` = every move / floor / rebase / restore / drift / error.
- **Telegram**: ONE post per pass with every change (↓ ↑ ⛔ floor ↻ re-based 🔒 put back), grouped
  by SKU, to the **Pricing Alert (Pre-Sell)** group, `PRICE_ALERT_CHAT_ID` (same bot; split under
  4096 chars). Unset → logged only, the tab says so.
- Endpoint `api/presell-listings/compete.js` (GET overview; POST master/lock/all/sku/size/base/run;
  run = 409 off the live server). Tests: `e2e/presell-compete.spec.js` (fake marketplaces + Telegram).

## Market prices — each platform's OWN words (owner, 2026-10-07)
`POST /api/presell-listings/prices { platform, sku, sizes, consigned }`
- **Alias**: Global Indicator · Lowest Listing · Last Sold · Highest Offer, toggle
  **Consigned / With You** (browser-remembered). Alias's `"0"` = none → "—", never $0.
- **StockX** (the **Direct** market, since we list DIRECT): Lowest Ask · Highest Bid ·
  Sell Faster · Earn More (· Beat US when given). **No last-sold** in StockX's API.
- Shown to the warehouse too on this screen (they price these); elsewhere pricing stays PH/admin.

## Platform APIs
**Alias** (`api/_lib/alias.js`, official host, `ALIAS_LISTING_API_KEY` → `ALIAS_API_KEY`;
same account as the owner's Postman). Synchronous.
| | |
|---|---|
| create | `POST /api/v1/listings?catalog_id&price_cents&condition=CONDITION_NEW&packaging_condition=PACKAGING_CONDITION_GOOD_CONDITION&size&size_unit=SIZE_UNIT_US&activate` |
| read · update | `GET /api/v1/listings/{id}` · `POST /api/v1/listings/{id}?price_cents&size&size_unit` (only what changes) |
| on / off · delete | `POST …/{id}/activate` · `/deactivate` · `DELETE …/{id}` → `LISTING_STATUS_DELETED` |
| **sales** | `GET /api/v1/orders?page_size=50` — **newest first**, each order carries `listing_id`, `price_cents`, `price_cents_after_take`, `sold_at` |
- ⚠️ `activate=true` = LIVE. The gateway 415s anything without `content-type: application/json`.

**StockX** (`api/_lib/stockx.js`, official Public API, the app's existing seller
connection — it sees the account's ~25k listings, all `DIRECT`). **Asynchronous**: writes
answer `{ listingId, operationId, operationStatus }`.
| | |
|---|---|
| create | `POST /selling/listings { variantId, amount:"170", currencyCode, active, inventoryType:"DIRECT" }` |
| update price | `PATCH /selling/listings/{id} { amount }` — **size can't change** (it's the variant) |
| on / off · delete | `PUT …/{id}/activate { amount }` · `PUT …/deactivate` · `DELETE …/{id}` |
| operation | `GET /selling/listings/{id}/operations/{operationId}` → PENDING / SUCCEEDED / FAILED |
| **sales** | `GET /selling/orders/active` — each order carries `listingId`, `orderNumber`, `amount` |
- Amounts are whole-dollar **strings**; Alias's are cents. Variant from UPC (one call) or
  exact SKU match + size — an inexact catalogue hit is refused.
- Often SUCCEEDED on the spot → we read the listing back at once (`sxSettle`). Calls can
  stall past 20 s → 30 s timeout, and a timeout is reported as "may still have gone
  through — press ↻", never "nothing changed" (seen 2026-10-07: the change HAD landed).
- "Deactivate" on an inactive listing is refused by StockX ("already inactive").

## StockX rate limit (2026-10-10)
The first big run (145 pairs) got **429 Too Many Requests** from StockX: 69 StockX listings
were never made and 28 were made but left `pending` (the read-back after create was the call
that got the 429, so there was no operation to poll and the worker never looked at them).
Now: **every StockX call goes through one queue** (`sxFetch` in `api/_lib/stockx.js`) at most
one per `STOCKX_MIN_GAP_MS` (default 400 ms), and a 429 waits (Retry-After, else 2/4/8/16/32 s)
and retries before giving up; the wait holds every other StockX call too. The worker stops a
pass at the first 429, and re-reads pending rows that have a listing id but no operation
(one minute after their last touch). Missing listings are topped up from **Stock → List N**.
Better later: StockX's batch listing endpoint (one call for many listings).

## The watcher (`api/_lib/presell-worker.js`, started by `server.mjs`)
**Opt-in: `PRESELL_WATCH=on` on ONE environment** — dev and prod share both marketplace
accounts; two watchers would both act on a sale. Off by default (and in e2e).
- every **12 s**: StockX listings still `pending` → poll the operation; done → read the
  listing back; failed → a create becomes `failed`, any other change keeps its state +
  the reason. Stuck > 10 min → read back anyway.
- every **60 s** (only while anything is open): Alias orders + StockX active orders →
  match `listing_id` to ours → `handleSale` (record once → deduct → take down extras →
  Telegram). Cancelled Alias orders are ignored.

## Telegram — the pre-sell group
`TELEGRAM_PRESELL_CHAT_ID` (same bot). **Two kinds of sale post** (owner, 2026-10-10; they ask
for opposite actions):
- **💰 PRE-SELL SALE — <platform> — SOURCE IT**: a row NOT in transit. We don't own the pair;
  "Alex / supplier: find 1 pair of size N".
- **🚚 IN-TRANSIT SALE — <platform>**: the supplier already bought it. Shipment note +
  expected date, "Warehouse: when it arrives, set N pairs aside, don't inbound them; inbound
  the other M", sold in transit so far. If the row has already ARRIVED (a sale racing the
  take-down): "pull 1 pair from the shelf for this order".

Both carry: 💰 SOLD on <platform> · shoe · SKU ·
size · price (payout) · order · stock left · what was taken down (and ⚠️ anything that
couldn't be). To find a new group's id: add the bot, type **`/chatid`** in the group — the
webhook answers with it (works wherever the webhook points, i.e. prod). Unset → the sale is
still recorded; Sales shows "Not sent" with the reason.

## Regular-sale alerts — a TEST switch (owner, 2026-10-07)
Sales tab → **"Also alert regular Alias + StockX sales (testing)"** (admins flip it;
`POST /api/presell-listings/settings`). Stored as `app_settings.sales_alert_all_since` =
the moment it went on ('' = off). While on, the same 60 s poll posts every NON-pre-sell
order placed after that moment to the pre-sell group as "🛒 SOLD on <platform> — regular
stock (test alert)" (shoe, SKU, size, price, payout when given, order #). Message only —
no stock, no listings touched. Once per order: `marketplace_sales_seen` (platform,
order_id). StockX active orders carry no payout; size = `variant.variantValue`. While on,
the order polls run even with nothing pre-sell listed.

## Verified live 2026-10-07 (all with listings created switched OFF, then deleted)
Alias create/read/update price+size/deactivate/delete; StockX create (DIRECT,
`active:false`), price update, read; a simulated Alias sale → recorded, stock 1/1 sold, the
StockX copy auto-deleted (StockX: `DELETED`), the same order again ignored.
**Not exercised: going LIVE** on either platform, a real order, the Telegram post.
