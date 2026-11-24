# Costs — filling in what a pair cost

Page: `ItemCosts` (`src/screens/ItemCosts.jsx`), routes `/costs` (admin/warehouse) and
`/ph/costs` (PH). Endpoints `api/items/costs.js` (list/search) + `api/items/set-cost.js`
(save). Grouping helpers in `src/lib/costs.js`. **No schema change** — `items.cost`
already existed.

## Why it exists
`items.cost` is written **once, at intake** (`insertItems` ← `intake.js`: the item's own
cost, else the batch `default_cost`). Suppliers routinely leave cost off a PO manifest,
so pairs land with nothing on file — and until this page there was **no UPDATE of
`items.cost` anywhere in the codebase**, so a blank stayed blank forever.

## Cost per shoe at receiving (2026-09-15)
Until this, the Receive form had **one "Default cost" for the whole batch** and
`doCommit` stamped it on every pair — fifteen SKUs at fifteen prices meant fifteen
corrections here afterwards — and a box received against a PO **ignored the
`po_lines.unit_cost` the supplier had already typed per size**. Now every shoe card
(Items step and Review, both layouts) carries a **"Cost ea"** `PriceInput` bound to
`it.cost` (raw string on the cart item). Resolution per pair, most specific first
(`unitCost` / `poLineCost` / `costOrNull` in `src/lib/costs.js`, applied by `sizeCost`
in `Receiving.jsx`):

1. **typed on the card** (`it.cost`) →
2. **the PO line for that SKU + size** — since 2026-09-29 a **shelf price**, turned into
   the landed cost with the shipment's supplier preset (`landedFromShelf`; full rule in
   `payout-calculator.md` → "Where the cost comes from"), and the shelf itself saved to
   `items.shelf_price` — `receivingPo.lines` on a receive-against-PO,
   or `poCostLines` (fetched alongside the labels) when adding a box to a PO-linked
   batch; matched on bare SKU + **numeric** size (`"10W"` ≡ `"10"`), a line for the
   active label winning over the same SKU+size on another label →
3. (2026-10-01) **the online order's actual cost** when the parcel's tracking number is on
   one of PH's online orders (`onlineLineFor`, `docs/context/online-orders.md`) →
4. **the batch default** — `header.defaultCost`, or in box mode the batch's own
   `default_cost` (sent as `null`; `box-commit.js` fills it server-side).

The line under the box says which will apply (`typed` · `from PO` · `from PO ·
$A–$B by size` when the supplier priced sizes differently · `batch default` ·
`no cost — fill in later on Costs`). Blank at every level stays **NULL**; the commit
confirm prints *"N pairs with no cost — they'll wait on the Costs page"* so a skipped
box is a choice, not a surprise. The header field is now labelled "Default cost ($ per
pair)" and only fills rows left blank. Guarded by `e2e/receiving-per-shoe-cost.spec.js`.

**Getting here from a pair.** Inventory's detail view and SKU-group card show a ✎ beside
the cost (`onOpenCosts` → `go('costs')` + `writeParam('q', sku)`; PH's Inventory does
the same into `/ph/costs`). `ItemCosts` seeds its search from `?q=` on mount and mirrors
it back on every search, so a refresh keeps the shoe. Inventory also now prints
**"no cost"** for a NULL where it used to print `$0.00` (the blank-vs-zero trap, below).

## The two lists (tabs) + search
- **No cost on file** — `cost IS NULL`. The backlog you clear. Drives the home
  card badge (`missing_cost`) and the Needs-attention strip.
- **$0 — check these** — `cost = 0`. A **review** list, kept deliberately OUT of the
  backlog and its badge: a $0 is a *claim already on file*, not a known gap, so folding
  it in would assert something we don't know. See the blank-vs-zero trap below.
- **Search** (`?q=`) — every unit of the SKU behind a VIN / UPC / SKU, costed or not,
  for fixing a cost that's already there but wrong. Scanning one pair's VIN returns the
  **whole SKU** on purpose: you're pricing a shipment, not a box. Same
  digits-end-to-end UPC rule and space/dash-insensitive SKU match as `findStockByCode`.

Both list tabs are month-scoped by default (`DateRangeBar`) — a Day filter would read
"all clear" while the home badge still shows dozens, the same reason No Box uses Month.

## Cost lookup tab (2026-11-11) — "what did this shoe cost us?"
Third tab on the Costs page (`?tab=lookup`, search in `?lq=`, source filter in `?src=`):
`src/components/CostLookup.jsx` → `GET /api/items/cost-lookup?q=` (`api/items/cost-lookup.js`,
same roles as the page: admin/warehouse/PH, never supplier). **Read-only** — a spreadsheet of
every PURCHASE line for a SKU, from both ways we buy:
- **Supplier PO lines** (`listPoCostLines`) — shoes orders only (an empty-box order's "cost"
  is a carton). One row per PO + store + SKU + size + price, so a size spread over three
  labels is one row with the quantities summed. **Actual cost ea** = the shelf price
  (`po_lines.unit_cost`) through `presetForShipment(po, supplier)` + `landedFromShelf` —
  the exact code receiving and the backfill use, so the three can't disagree. **No preset
  → no cost**, never the shelf price (the rule above); the row says why.
- **Online order lines** (`listOnlineOrdersForCost`) — the order's actual cost per pair from
  `orderCosts` (coupon / tax / shipping / gift card % / cashback %), computed over ALL the
  order's lines and then filtered to the matching ones (the split needs the whole order).
  Cancelled and not-delivered lines are left out.
- Match: SKU contains the search with spaces/dashes ignored (`codeMatches`, also in SQL), or
  the name contains it. Blank search = the newest 200 PO lines + 100 online orders; a search
  goes to 1000 / 400 and says "more matches than shown" past that.
- Dates are the EST civil day: `date_of_purchase` / `ordered_on`, else the EST day the row
  was created.
- The screen adds a **Cost by size** summary (`sizeSummary`: latest cost + its date/source,
  lowest–highest, average weighted by pairs, pairs with no cost counted apart — a blank is
  never averaged in as $0), sortable columns (blank money sorts last both ways), the
  All / Supplier POs / Online orders filter, tap a cost for its breakdown, and a **CSV** of
  exactly what's on screen (`costLookupCsv`). Live on `po_lines`, `purchase_orders`,
  `online_orders`, `online_order_lines`. Only the latest request may land (a search typed
  while the opening list loads used to be overwritten by it — caught by the e2e).
- Not in it (yet): in-store buys (`kind='instore'`) and the cost already on received pairs
  (`items.cost`) — those are on the other two tabs' search. E2E: `e2e/cost-lookup.spec.js`.

## Filters + Export CSV (2026-11-20)
Owner: export what still needs a cost, by SKU, and filter by supplier and by a date range.
- **Supplier** (`?sup=`) is filtered **on the server** (`listItemsMissingCost(…, { supplier })`,
  case and outer spaces ignored, `(none)` = the batch names no supplier). Never in the browser:
  the list is the newest 5,000 pairs and the real backlog is larger (13,800 on 2026-11-19), so a
  filter over the loaded rows would silently lose pairs. The dropdown's suppliers and counts come
  from `listCostBacklogSuppliers` (whole range, no cap); the response carries `suppliers` + `total`.
- **Date range** (`?cf=` from, `?ct=` to): typed dates replace the Day / Week / Month bar while
  set. No "To" = until today. EST days, like the bar.
- **Export CSV**: `costExportCsv` (`src/lib/costs.js`), **one row per SKU whatever the size or
  shipment**: SKU, name, colorway, pairs, sizes in one cell (`9 ×2 · 10 ×1`), supplier(s),
  batch(es), first / last received, and an empty "Cost per pair" column to write in. It is what
  the filters match, not what the page loaded: over the cap, the export asks again with `all=1`
  (up to 50,000 pairs). Works on the $0 tab too. Not offered on a search.
- The page says so when the range holds more pairs than it shows.
- E2E: `e2e/costs-export.spec.js`.

## Upload the filled CSV (2026-11-20)
Owner: the exported file should be uploaded back for bulk filling, mapped by supplier.
- **The export is one row per SKU PER SUPPLIER** (was per SKU): the same shoe from two
  suppliers has two costs, and the Supplier column is what the upload maps a cost back by.
- **⬆ Upload filled CSV** (beside Export): the file is read in the browser (`readCostImport`,
  `src/lib/costs.js`: needs a `SKU` and a `Cost per pair` column; `Supplier` optional; `,` or `;`
  separated; `$` and thousands commas accepted) → `POST /api/items/cost-import` **preview**
  (writes nothing) → the page lists each SKU · supplier · cost · pairs, what has no pair waiting,
  what was left out and why → **Fill N pairs** (`apply: true`).
- **Mapping:** SKU on letters and digits only (`skuKey`), supplier case-insensitive. An empty
  Supplier cell = pairs with no supplier. A file with no Supplier column fills the SKU whoever
  it came from. One cost covers every size and shipment of that SKU + supplier.
- **Only inside the filters on screen** (dates, supplier, the blank / $0 tab), the same ones the
  export used; the preview says which.
- **Only a blank cost is filled** (a `$0` on that tab). Re-checked inside the UPDATE, so a cost
  typed between the preview and the click is kept. A cost on file is never overwritten.
- **Left out and named:** not an amount, `$0` (never in bulk), the same SKU + supplier twice
  with two costs. An empty cost cell is simply not filled yet.
- One `item_events` note per pair: "Cost set to $X (CSV upload)", by the person. Up to 3,000
  rows a file. Same roles as `set-cost`. `costImport` in `api/_lib/db.js`, one statement.
- E2E: `e2e/costs-import.spec.js`.

## Granularity: batch + SKU + size
`groupCostRows` makes one card per **batch + SKU**, with a row per size. One amount
covers every pair of that size **in that shipment** — matching `po_lines.unit_cost`
(per pair, per size) and the PH grid's per-size layout. The batch is part of the key
deliberately: the same shoe bought again next month may have cost something different,
and merging batches would silently overwrite the older shipment's price with the newer
one's. `~ mixed` marks a size whose pairs don't currently agree.

Saving a card fires **one request per changed size** (one amount, one set of VINs), so a
rejected amount names the size it came from instead of failing the whole shoe. Rows
update in place rather than refetching — on the backlog a fully-costed card would
otherwise vanish mid-scroll, losing your place and any chance to check what you typed.

## Bulk entry (2026-11-24)
A SKU search returns one card per shipment with a box per size; three shipments × ten sizes
was thirty boxes typed by hand. Two fills, both of which only TYPE into the boxes (drafts) —
nothing is written until a Save:
- **"Same cost for all N shipments"** bar (`.cost-bulk`, **search only** — a search is one shoe,
  the backlog is hundreds of different ones): an amount + **Fill all** puts it in every box of
  every card on screen. **"Only sizes with no cost yet"** leaves a cost already on file alone.
- **"All sizes"** box on each card with 2+ sizes (`.cost-allsizes`, search AND backlog): fills
  that one shipment.
- **Save all (n)** (`.cost-bulk-save`, sticky; shown on a search, and on the backlog once
  anything is typed) saves every changed size on every card; **Undo changes** drops the drafts.
  A box changed by hand after a fill keeps its own amount. A changed size's label turns green.
- Deliberately across batches: the "batch is part of the key" rule above still protects the
  per-card Save; overwriting an older shipment's price is now a visible, chosen act (the boxes
  show it before Save all), not a silent merge.
- One save path, `runSave(busyKey, jobs)` in `ItemCosts.jsx`. The card's Save still sends one
  request per size; Save all groups sizes **by amount** (≤ 400 pairs a request, the endpoint
  takes 500) — same `POST /api/items/set-cost`, same per-pair history note, no new endpoint.
- E2E: `e2e/costs-bulk.spec.js`.

## Gotchas
- **Blank is not $0, and this was a real bug.** `toCost` (now exported from
  `api/_lib/intake.js`, previously copy-pasted into `commit.js` / `box-commit.js` /
  `create-open.js`) used to be `Number(v)` guarded only by `isFinite && >= 0` — and
  `Number('')` / `Number(null)` are **0**. So an empty cost box at receiving was stored
  as *"this shoe was free"*, which no "no cost on file" query can ever find. It now
  returns `null` for blank/whitespace/null/undefined; a deliberate zero still works
  (type `0`). **The $0 tab exists to work off the rows created before that fix.**
- **`kind='existing'` is excluded from both list tabs** (`b.kind IS NULL OR b.kind <>
  'existing'` — the `IS NULL` half matters, it's a LEFT JOIN). Counted-in old stock has
  no cost to capture by design and runs to thousands of pairs (`existing-stock.md`);
  leaving it in would bury the pairs that genuinely need a number. `pendingCounts`
  applies the same rule via its `costable` flag — **the badge and the page must agree
  or the badge counts rows the page won't show.**
- **`missing`/`issue` units are excluded** everywhere here — dead paperwork, not
  something to cost.
- **Terminal units stay editable.** A pair that already sold still needs its cost for
  the margin to mean anything, so `sold`/`shipped` are not blocked.
- Every save writes an `item_events` `note` row ("Cost set to $X" / "Cost cleared")
  attributed to the person's name, like the other per-unit audit lines.
- There is **no way to confirm "$0 is correct"** — the review tab lists them, and a
  genuinely-free pair is simply left alone. Marking one as verified would need a new
  column.

## Fill costs from POs (2026-09-30) — Costs page, admin only
`src/components/CostBackfill.jsx` → `api/items/cost-backfill.js` (GET = preview, writes
nothing; POST `{apply:true}` = fill). Why: `items.cost` is written once, at receiving, and
only on a receive AGAINST the PO — pairs received before their PO carried a shelf price
(or before the shelf-price rule) showed "without a cost" on Platform Profit while the PO
plainly had one (HV6103-300 on PO 49 was the report).
- **Candidates** (`listCostBackfillCandidates`): `cost IS NULL` (never a `$0` claim, never a
  real cost), not an empty-box order, and the pair's PO found one of two ways:
  - its batch is **linked** (`batches.po_id`); or
  - (2026-10-01) its batch was **never linked** but the parcel's tracking number — the
    box's, or the **batch's own for a loose receive** (no box row) — is on exactly **one**
    shoes PO's label, spaces/case ignored. Only `kind` receiving batches (never in-store /
    existing / rescale). A number on two POs is counted as `ambiguous` in the preview and
    never guessed. The history note ends "batch not linked to the PO; matched by tracking
    …" so the match can be checked. E2E: `e2e/cost-backfill-tracking.spec.js`.
  The own-label match now also uses the batch's tracking for loose pairs (it used the box's
  only, so a loose pair never found its own label).
- **Which line:** `poLineMoney` — the pair's OWN label first (its `batch_boxes.tracking_number`
  = the `po_boxes.tracking_number`, case/space-insensitive), any label after that.
- **Landed:** `landedFromShelf` with `presetForShipment(po, batch supplier)` — the same code
  and order receiving uses; always the preset's tip, never the line's (2026-10-08). **No preset → SKIPPED** (owner's
  rule, 2026-09-30: the declared figure is only the shelf price, the actual cost is shelf +
  the supplier's preset), listed in the preview by PO + supplier (`noPreset`) so a preset
  can be linked first; the next check then fills them.
- **Writes** `items.cost` + `items.shelf_price`, re-checking `cost IS NULL` at write time
  (a cost typed between preview and click wins), and one history note per pair:
  "Cost filled from PO-… : $x landed ($y shelf through the "…" preset)".
- **Can't reach:** pairs on a PO with no shelf price for that SKU + size (sampled in the
  preview), and pairs received with no PO — those stay on the manual worklist.
- E2E: `e2e/cost-backfill.spec.js`.

## Fill from emails (2026-11-25) — Costs → "From emails"
Owner: 1,187 Shoe Palace pairs received in November had no cost, and almost none of their orders
were typed on Online Orders. The stores' own emails (the order mailbox) have it all. He wants **the
price PAID**: after the store's discount, **no gift card taken off, no shipping added**. Costs only —
no online order is created.

**The chain, per parcel** (`src/lib/costEmails.js`, pure; `api/_lib/cost-emails.js`, the run):
1. The pairs: no cost, a receiving batch **not on a purchase order**, a tracking number of 10+
   characters on the box (else the batch) — `listCostEmailCandidates`, the Costs list's supplier +
   date filters.
2. **Tracking number → the mailbox** (Make scenario 7082222, `MAKE_ORDER_EMAILS_URL`, the one online
   orders use: every email carrying a text, plain text, ≤ 60, oldest first) → `readParcel`: the
   store, the **order number** (`orderNumberOf`: needs 4 digits in a row), and the pairs in THIS parcel.
3. When the parcel's email has no price: **order number → the mailbox** → `readOrder`: the
   confirmation's lines, `full` (listed) and `each` (**paid** = the line after the discount ÷ pairs).
4. `priceParcel`: a pair takes the price of the parcel's line for its size (and SKU when the email
   prints one). The box in women's sizing (9.5W) is the men's 8 the store sold. Two shoes of one size
   at two prices → settled by the store's name for the SKU, **learned in the same run** from parcels
   that hold one shoe (`learnNames`), else left for a person. A pair not in the parcel's email (two
   parcels scanned under one number) is priced from the order only when that name is known.

**Readers** (each store writes its own way; real emails, sampled 2026-11-25):
| Store | Parcel email | Price from |
|---|---|---|
| Shoe Palace, any Shopify store | "A shipment from order #… is on the way": name, `1 of 10`, size | the confirmation ("Order summary": discount code, listed, paid) |
| DTLR | "Order N Has Been Fulfilled": `SKU Color=…;Size=… … tracking` | its Shopify confirmation |
| Foot Locker / Champs / Kids FL | "Your order is ready to go": name, `Size 08.0`, `Qty`, `$` | that email (the price shown) |
| JD Sports | "ORDER UPDATE": pairs under each `Tracking:` | that email; an ORDER-level discount is spread by price and said in the note |
| Supreme | "online shop order has been shipped": Style / Size / Quantity / Price | that email |

**Not readable, and reported as such, never guessed** (the run's "not priced" reasons):
- **`no_text`** — Nike, Dick's, Puma: the emails are HTML only and the scenario returns plain text.
  Needs the Make scenario to return the HTML (not done).
- **`no_email`** — the tracking number is in no email's text: adidas, Zumiez, Crocs, Academy, Yeezy,
  Oneness, Solefly in the samples (the number is behind a link, or the order went to another
  mailbox: the search is Gmail All Mail only, not Yahoo, not Spam).
- The supplier typed on a batch is not always the store (a "Nike" batch was a Foot Locker order):
  the store shown is the email's.

**The run** — one at a time, on the server (about 9 s a parcel: two mailbox searches):
- `cost_email_runs` (status `running` → `done` → `applied`, or `stopped` / `failed`; progress; the
  preview `rows`; `summary` per store and per reason) and `cost_email_lookups` (`T:<tracking>` /
  `O:<order>` → what it read as; a hit is kept, a miss is asked again after a day). **Needs db:setup.**
- A run touches its row after every parcel. Not touched for 3 minutes = cut off by a restart:
  the page offers **Continue**; what was read is remembered. **Stop** ends it; nothing was written.
- At most 1,500 parcels a run (`MAX_PARCELS`); the page says when it was capped.
- `GET/POST /api/items/cost-emails` (start · continue · stop · apply; warehouse + PH + admin).
- **Apply** fills `cost` and `shelf_price` with the paid price on pairs that STILL have no cost
  (`fillItemsCost`: a cost typed since the preview wins), with a history note: store, order, listed
  price. A run is applied once.
- The page (`src/components/CostsFromEmails.jsx`): the scope (the list's supplier + dates), progress,
  per-store table, reasons, Priced / Not priced tabs (first 300), the whole preview as CSV.
- Measured on real data: Shoe Palace Nov 2–3, **152 of 160 pairs** priced (37 parcels).
- E2E: `e2e/costs-from-emails.spec.js` (the mailbox is handed in, `io.ask`; the suite has no hook URL,
  so Start answers 503 there).

### By SKU and by order number (2026-11-25, same tab)
Owner: pull prices per SKU and supplier; the order number and the tracking number are a bonus when
we have them. Tested on the real mailbox first: **most stores never print the style code** (Shoe
Palace, Foot Locker, Champs, JD: the shoe's name only), so a SKU search cannot be the main way in —
but it is the ONLY way in for adidas, whose receipts print the article number and whose tracking
numbers are in no email. So a run uses **the most exact route each pair has**:
1. **Tracking number** (above). When the number is found in an email we cannot read but that names
   the order (adidas customer-service threads), the order's emails are read and a pair is priced
   only from a line that IS its SKU (`priceFromOrder`).
2. **The order number someone types** (`cost_email_runs.order_number`): its confirmation's lines. A
   line must print the SKU or be the name learned for it; when the run is also narrowed to a SKU the
   person has said "these pairs are that order", so the size decides.
3. **The SKU** (`readSkuLines` → `priceBySku`), one mailbox search per SKU still unpriced (≤ 200 a
   run, `MAX_SKUS`; lookups `S:<sku>`): lines that print the code, from the pair's own store
   (`sameStore`), in its size. **One price → filled. Two or more → "Bought at 3 prices ($30.00,
   $40.00, $59.50) — pick one by hand"** and left blank: without the parcel or the order nothing says
   which purchase a pair came from. Pairs with no tracking number are in the run for routes 2 and 3.
- **Only this SKU** (`cost_email_runs.sku`) narrows any run to one shoe.
- **The search leaves the newsletters out.** A style code is in dozens of GOAT / Alias account
  emails and the scenario returns the OLDEST 60 (JH7834: 60 newsletters, 0 receipts). The scenario
  searches `"<text>"`, so the SKU route sends `SKU" -from:goat.com "SKU` (`skuSearch`).
- **adidas readers:** `readAdidasReceipt` ("Your adidas receipt": `NAME ,9-` / `Article No:` /
  `Selling Price:` = paid, the discounts under it give the listed price; `9-` is 9.5; the text is
  HTML with `<br>` and `&zwnj;`, cleaned by `emailLines`) and `readAdidasOrder` (order updates:
  `$180.00 $45.00 x 4 $120.00` = $30 a pair). adidas.com's confirmation and shipping emails carry no
  items in their text — not readable.
- **Caveat, by design:** a SKU price is "every email that prints this SKU in this size agrees". A
  purchase whose email we cannot read (an adidas.com order) is invisible to it, so a pair from such
  an order takes the receipts' price. The preview says `matched by SKU and size`; check before Apply.
- Measured on real data: adidas KI6956, **94 of 105 pairs** at $59.50; size 8 had three prices.
- **Needs db:setup** (`cost_email_runs.sku`, `.order_number`).

