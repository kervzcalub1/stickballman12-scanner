# Payout Calculator

Screen: `src/screens/PayoutCalculator.jsx`. Maths: `src/lib/payout.js` (pure).
Batch analysis (bottom of the same screen): `src/components/BatchAnalysis.jsx` +
`src/lib/batchParse.js` + `src/lib/batch.js`. Endpoints: `api/payout/quote.js` (live prices),
`api/payout/batch.js` (a whole list) + `api/payout/presets.js` (supplier presets). Routes: **`/payout`** (admin + warehouse home,
In-Store Mode section), **`/ph/payout`** (PH home, Pricing & Listing section), and
**`/payout` on the supplier portal** (their own home — see "Suppliers get this screen"
below).
E2E: `e2e/payout-calculator.spec.js`.

Answers one question, standing in a store with a shoe in your hand: **should I buy
this pair?** Nothing is saved — it never touches inventory, never writes an item, and
has no batch. It is a scratchpad with the right arithmetic in it.

## Where it came from
Ported from **GemsClean/payout-calculator** ("Payout Engine") — a colleague's repo, and
the work is ours (confirmed 2026-08-23, so there's no licence question to re-raise). It's
Next.js + TypeScript + Tailwind, so this is a re-implementation in our idiom rather than
a copy. The **arithmetic is faithful**,
deliberately — including the two quirks below — because the floor already quotes each
other numbers out of that tool, and a screen that silently disagrees with it is worse
than no screen. Their inventory intake, barcode scanner, product search
and AI advisor were **not** ported: we already have all of those, or don't
want them. Their **bulk/batch analyser** was, on 2026-08-26 — see below.

## The steps down the page
1. **Shoe** (optional) — SKU → Alias catalogue (`api/sku-search.js`, shared with PH's
   Price Inquiry) → tap the size you're holding → **one call** (`api/payout/quote.js`)
   returns that size's live market on **both** platforms, as two tappable strips:
   **Alias** (lowest ask / highest offer / last sold / Global Indicator) and **StockX**
   (lowest ask / highest bid / earn more / sell faster, via the official Public API —
   `api/_lib/stockx.js`, see `integrations.md`). Each cell fills **its own** platform's
   sale price.
   - **The lowest ask fills itself, per platform, without a tap (2026-08-26).** It's the
     first column because it's what the pair actually sells for, and requiring a tap
     before any verdict appeared made the screen look like it had no opinion. The other
     three cells are still one tap away, and typing over the box wins. The cell driving
     the payout is **highlighted**, derived from the sale price rather than remembered —
     so it follows a tap, follows the auto-fill, and disappears the moment someone types
     a price of their own; an auto-filled number must not read as one somebody chose.
     Overwriting on every fetch is deliberate: a fetch only happens on a new **size** or
     a **basis switch**, and both make the previous number a statement about a different
     thing. This also puts the single-pair screen in step with batch mode, which has
     always priced off the lowest ask. Note the asymmetry: **StockX has no last sale** — no such field exists in
   their Public API — so that comparison can only be made on the Alias side. The whole step is skippable: type a sale price and the maths works.
   - The two sources **fail independently** (`Promise.allSettled`): a StockX outage
     can't take the Alias half of the answer down, and the screen distinguishes
     *"StockX has no market for this size"* from *"StockX is unavailable right now"*
     from *"StockX isn't configured on this server"* — three different answers to
     "should I buy this".
   - A StockX catalogue **near-miss** (right shoe, wrong colourway) renders an amber
     warning on the strip rather than quietly pricing the wrong pair.
   - **Alias basis toggle — and this screen defaults differently from the rest of the
     app.** Alias quotes *consigned* (Alias holds your stock) and *"With You"* (you hold
     the pair and ship on sale), and they are not close: FZ9033-102 size 11 asks **$120
     consigned vs $105 With You**, a **$13.51** swing in payout — the gap between a buy
     and a pass. Every other pricing surface here (PH grid, Price Inquiry, the 8-level
     hierarchy) leads with **consigned**. This screen defaults to **`with_you`**,
     because the person using it is standing in a shop deciding whether to buy a pair
     they will then hold and ship themselves, and that is the basis describing what
     actually happens to the shoe. It also matches the numbers the floor already quotes
     each other from the tool this was ported from. The toggle sits with the size chips
     (it governs what a tap fetches), rides in `?basis=`, and **re-prices the size on
     switch** — relabelling a stale number would be worse than showing none. The Alias
     strip names the basis so a screenshot of it can't be misread later.
2. **Store cost** — shelf price, the discount stack, tax, tip, shipping → **Final
   cost** + **Saved off sticker**, with a collapsible line-by-line breakdown. A row of
   **supplier presets** sits on top of it (below).
3. **Liquidity — filled from our own sales, not guessed.** `api/payout/quote.js` returns
   `velocity` for the style alongside the prices (`salesVelocity`, see
   `sales-history.md`), and the picker selects the matching band with the evidence
   beside it: *"from our sales: 16 sold in 30 days, 20 in 90 · 3.7/week"*. A picker that
   fills itself and doesn't say why is a number nobody trusts — and this one drives the
   risk band on the verdict.
   - **A deliberate choice wins.** `liquidityTouched` stops a measurement overwriting a
     buyer who knows something the data doesn't (a shoe about to drop). The note then
     reads *"— you overrode this"*; the sales figures still show, because what the shoe
     did is true either way.
   - **A new lookup starts fresh** — the previous shoe's override is not evidence about
     this one. (Looking up also clears the selected size now: leaving it set left a chip
     highlighted with no market behind it, and tapping it deselected instead of pricing.)
   - **Never sold ≠ sells monthly.** Zero sales leaves the picker empty and says "no
     sales on record"; no export loaded leaves it silent. Filling in "Monthly" for either
     would put a measurement on screen that nothing measured.
4. **Expected payouts → The call** — per-platform **markup** and **fees** → payout /
   profit / ROI, then a **Buy / Watch / Pass** verdict with risk and platform spread.

## Supplier presets — the one thing here that ISN'T per device
Table `payout_presets`, endpoint `api/payout/presets.js` (GET list · POST save · POST
`{deleteId}`), editor in `PresetManager` inside the screen. Seeded from the five
suppliers the floor already buys through: **Andrew, Esteban, Joey** ($5 tip), **Chris**
($7), **Council** (no sales tax) — all $8.25 shipping (box swap fee + labour) and an 8%
gift-card discount.

A "supplier" here is the person who buys the pair at retail for us, and each one comes
with a fixed cost stack. Tapping their chip fills the whole Store cost step; the four
numbers are then just there, instead of being retyped per pair on a phone in a shop.

- **Shared in the database, not in `prefs`.** Everything else on this screen persists
  per device because it's per store *trip*. A supplier's tip fee is a different kind of
  fact — it's about the supplier — so the buyer on the floor and whoever checks the
  maths afterwards have to be reading the same one. One person raising Chris to $7
  raises him for everybody.
- **A preset states the WHOLE stack**, all seven rates, not only the four that differ
  between suppliers. One that left store/promo/cashback alone would quietly carry the
  last trip's discount into the next supplier's cost — and *"Council: no sales tax"* has
  to actually clear the 8.25% the previous supplier left in the box, which is what the
  e2e test asserts.
- **Blank means zero, not "skip this field".** Council's 0% tax is a fact about where
  they shop, and the row says so with a note.
- **Applying is a label, not a lock.** Every field stays editable; the moment one
  diverges the chip stops claiming the supplier and the line reads *"…'s stack, edited
  below — the numbers on screen are the ones being used."* That's derived from the
  values, never a flag, so it can't go stale.
- **Tapping the applied supplier again drops the label but LEAVES the numbers** — they
  are what the pair in your hand is being bought at, and zeroing them mid-decision would
  be worse than a chip that stops highlighting. Same for deleting a preset.
- **Typed rates are quoted back exactly** (`ratePct`, not `pct`): a sales tax of 8.25% is
  not 8.3%, and a chip that rounds the number it just filled in reads as a different one.
  `pct`'s one decimal stays for the things we *calculate* — ROI, margin, fees.
- **Writes are open to warehouse + PH** (and never to the supplier the preset is
  about — see below), like `api/payout/quote.js` and unlike the rest of pricing. Gating edits to admin would mean the person who just agreed a new tip fee with
  a supplier, standing in the store, can't record it — and a preset references nothing
  and saves nothing, so a bad one costs a retype. Duplicate names are refused
  case-insensitively (409), and every rate is validated non-negative and ≤100%.
- **Seeding runs only into an EMPTY table**, never `ON CONFLICT DO NOTHING`: `db:setup`
  runs on every deploy, and a supplier someone deliberately deleted must stay deleted.

## Suppliers get this screen too — with their own stack only (2026-08-26)
A supplier account signs in and sees **two cards** instead of landing straight on the PO
list: **Purchase Orders** and **Payout Calculator** (`SupplierHome` in
`src/screens/SupplierApp.jsx`, its own little router — `/orders`, `/payout`, anything
else = home). They're the person standing in a shop deciding whether a pair is worth
buying, which is the question this screen exists to answer.

- **The scope keys on `payout_presets.supplier_user_id`, never on the preset's name.**
  A name match would break silently the first time either side is renamed, and its
  failure mode is one supplier reading another's cost stack. NULL = staff-only, which is
  every preset until someone links one. **New column → `db:setup` required.**
- **Staff link it** in `PresetManager` → *Supplier sign-in* (a select of approved
  supplier accounts, from `api/po/suppliers.js` — which gained the `warehouse` role for
  this caller, since preset writes were already open to warehouse). Linked presets show
  a **⇄ signs in as …** chip in the manager list. The endpoint re-checks the id against
  the real supplier list rather than trusting it: a bad id would otherwise attach the
  stack to a staff account.
- **Read yes, write never.** A supplier's cost stack is an input to *our* buy call, so
  letting them raise their own tip fee would let them move the verdict. GET is scoped;
  every POST (save **and** delete) answers 403. The screen hides Manage to match, but
  the server refuses on its own.
- **It applies itself.** Their list holds exactly one stack, so there's nothing to pick
  between — it's applied on load and every field stays editable (a one-off promo
  shouldn't need a call to the office). With no preset linked, the bar says so and the
  calculator still works by hand.
- **A uid that isn't a real row id fails CLOSED** (scoped to `-1`, i.e. nothing) rather
  than reaching the query as `supplier_user_id = NaN`.
- **What this shows them, deliberately:** the live Alias/StockX market, our fee
  assumptions, and the profit/ROI/verdict on the pair in their hand — plus the
  liquidity evidence, which is **our own sales history** (`velocity` from
  `payout/quote.js`). That last one is the only figure here they couldn't get
  elsewhere; it's included because it's what drives the risk band on the verdict. Gate
  it for suppliers if that ever stops being wanted.
- Guarded by `e2e/supplier-payout.spec.js`.

## Batch analysis — a whole list at once (2026-08-26)
**"Or price a whole list", at the BOTTOM of the one-pair page**, under the Store cost
step — not behind a mode toggle, and the placement is the feature. Every pasted price is
run through the register that's already on screen, so **one tap on a supplier preset at
the top prices forty rows**. Behind a toggle, every batch meant re-entering a stack that
was right there. (It shipped as a toggle and was moved the same day, for exactly that
reason.)

**Paste → Review → Analyse, and the middle step is not optional.** Parsing a chat message
is guesswork however carefully it's done, so every row lands in an **editable table**
first — you can see what it read, fix a size it misread, and delete the line that was
actually a greeting. Going straight from text to verdicts would let a wrong number decide
a purchase with nobody seeing it happen. (The source falls back to a model when its own
parse looks shaky; this doesn't. A parse you can see and correct beats one that costs
money and can still be wrong in a way nobody notices.)

**Two input shapes** (`src/lib/batchParse.js`), because sellers send two:
- **Grouped** — a header line with the style code (and often a price and a name), then
  `9 x 2` / `9.5 x 1` underneath, groups split by a blank line or a `⸻`. The header's
  price and name carry down to every size under it. `Total: 6 pairs` is a footer, not a
  row.
- **Per line** — a style code, size, qty and price all on one line.

Grouped is tried **first** and only accepted if a header was actually found, because the
per-line parser would happily read `9 x 2` as a nameless row and produce garbage. A line
with no style code is skipped rather than guessed at; a size keeps its letter (`7.5W` is
a different shoe); and a missing cost stays **blank, never 0** — "they didn't say" and
"it's free" produce different verdicts. Capped at 300 rows.

**A style code written with a SPACE counts (`IB8857 141`)** — added 2026-08-26 after a
paste of exactly that came back *"Nothing recognisable"*. It's how people type it, and
failing teaches them the tool is broken rather than that they missed a dash. Whatever the
spelling, it's stored hyphenated and upper-case, so the two forms group together instead
of being priced twice. Two guards keep it honest:
- **Both halves must contain a digit.** Without that, `RM Hemp` out of *"Jordan 4 RM
  Hemp"* reads as a style code and the sizes below it get filed under a shoe that doesn't
  exist. The hyphenated form stays as loose as it was.
- **The size pattern is capped at two digits**, and that cap is load-bearing: an
  all-numeric code like `315121 115` otherwise reads as *"size 315121, quantity 115"* and
  is eaten as a size line before it can be recognised as the header it is. A line that
  parses as a size run is never treated as a header.

**Pricing** is one round trip (`api/payout/batch.js`): rows are grouped by style, and
each style gets the same two lookups `quote.js` does — deliberately the same functions,
so a batch row and a single-pair row can never be priced by two code paths that disagree.
Bounded at **40 styles × 24 sizes, 4 concurrent**, with sizes sequential *within* a style
(they share a cached StockX product; in parallel on a cold cache they'd repeat the same
catalogue calls). One style failing returns an empty result for that style, never a
failed request — and anything past the cap is reported as `skipped` rather than silently
dropped.

**Three deliberate divergences from the source** (`src/lib/batch.js`):
1. **The verdict is ours.** The source calls a Watch on `profit > 0 && roi >= 5`;
   `dealVerdict` says a Buy needs BOTH thresholds and either alone is a Watch. That
   function is what the calculator, the advisor prompt and this all read.
2. **No estimated eBay / Stadium Goods columns.** The source multiplies the Alias ask by
   1.25 and 1.2 and prints them as prices. They're a guess wearing a currency symbol.
3. **The cost stack applies, and the coupon deliberately doesn't.** Two modes on the
   table itself:
   - **Shelf prices** (default) — each pasted price runs through the stack above:
     the three compounding discounts, tax, cashback, and the per-pair tip and shipping.
     A row then shows both numbers, `Cost $115.31 (from $150.00)`, which is the line
     someone checks when a call surprises them.
   - **Already my cost** — the number is the landed cost, exactly as typed. A supplier's
     offer sheet is this: they quote you a price, not a sticker you then discount.

   **The coupon is never applied, in either mode.** It's a flat amount off one
   transaction, not a rate — carrying a $10 coupon into forty rows would quietly take
   $400 off the batch and turn a Pass into a Buy. The line under the table names what the
   stack *will* do in the words of the fields above ("30% store, 8% tax, $5.00 tip…"), and
   says so when the stack is empty; silently applying nothing looks identical to applying
   something. Changing any of it clears the last analysis rather than leaving a stale one
   looking current.

**The gaps are named, and kept out of the totals.** `no_price` (no market for that size)
and `no_cost` (nobody entered one) are counted and printed separately — averaging a blank
into a blended ROI is how a bad batch reads as an acceptable one. Results sort Buy →
Watch → Pass → gaps, and within a status by **line** profit: a $6 margin over forty pairs
outranks $40 over one. Green means "take it", not "the arithmetic came out positive" — an
$11 profit at 11.9% ROI is a Pass and must not read green beside its own red chip.

Suppliers get it too, on their own portal — with their own preset filling the stack
above it. E2E: `e2e/payout-batch.spec.js` (incl. an assertion pinned to $115.31, which is
the number that proves the coupon stayed out — with it, the row would land at $104.51).

## The cost maths (`calcCostBreakdown`) — order is the point
`shelf → store % → promo % → gift card % → coupon → tax → + tip + shipping − cashback`

- **The three percentages compound.** Each comes off what's left, not off the shelf
  price: 30% then 10% on $150 is $94.50, not $90.
- **The coupon is flat and clamped** — a $50 coupon on a $30 balance takes it to zero,
  never negative.
- **Tax applies after the coupon**, to `afterCoupon` only.
- **Two quirks carried over on purpose:**
  1. **Cashback is netted off the total but calculated PRE-tax** (`afterCoupon × %`). A
     real card pays it on the amount actually charged, tax included, so this runs a few
     cents light on a big ticket.
  2. **`totalSaved` is savings off the sticker only** — discounts + coupon + cashback,
     ignoring tax/tip/shipping. It answers "how much did I knock off the shelf price",
     not "shelf minus what I paid". That's why Final cost + Saved ≠ shelf price.

  Both are faithful to the source. Change either one and this screen stops agreeing
  with the numbers people are already trading — so if we *do* change them, say so out
  loud rather than fixing it quietly.

## Markup — listing above the ask (2026-08-26)
A **Markup %** box per platform, beside the fee. The breakdown reads
**`sale + markup − fees = payout`**, with a *Listed at* row for the price the pair is
actually sold at:

```
Sale            $130.00
Markup (10%)    +$13.00
Listed at       $143.00
Fees (9.9%)     −$14.16
Payout          $128.84
Profit           $39.84
ROI               44.8%
```

- **The fee is a cut of the LISTED price, not the ask.** A platform takes its percentage
  of the real sale; charging it against the number you started from would understate the
  fee on every marked-up pair.
- **Per platform, like the fee** — 10% over Alias's ask is a different dollar amount from
  10% over StockX's, and the two are routinely worked differently.
- **Behind an OFF/ON switch in the section header, off by default.** Turning it on
  changes the CALL, so it has to be something someone chose and can see they chose. While
  it's off the markup box isn't rendered at all: a box holding a number that isn't being
  applied reads as though it counts. The number is remembered across a toggle, but only
  applied while the switch is on.
- **With the switch ON the verdict follows the markup** — that's the point of turning it
  on. `marketPayouts` (the same payouts at markup 0) is still computed, because the
  interesting question isn't *"what does the markup pay"* but *"is the markup the only
  reason this is a buy"*, and that needs both.
- **When the markup MOVES the call, the screen interrupts.** An amber
  `.pc-markup-alert` inside the verdict card — flag line **"Markup changed this call"**,
  then both answers named: *"This is a **Buy** because of the markup you set. At the
  market price it's a **Pass** — $6.32 a pair at 6.3% ROI, against $48.85 at 48.8% if it
  sells at your price."* The card's own border goes amber too, so a glance at the big
  green **Buy** can't miss that something qualifies it.
  - It fires on the **call changing**, not on the profit moving — a markup always moves
    the profit, and a note that fires every time is a note nobody reads. A markup that
    leaves the call alone gets one quiet grey line instead.
  - A warning that doesn't say *what* changed just makes people distrust the panel, so it
    quotes the market figures rather than only waving.
- **Blank is 0**, so every number reads exactly as it always has until someone asks for a
  markup. `calcPayout`'s 5th argument defaults to 0, which is why batch analysis and
  every other caller are untouched. `margin` now divides by `listedPrice` (equal to
  `salePrice` with no markup) — that's the price the risk bands should read.

## The payout maths (`calcPayout`)
`listed = sale + sale × markup%` · `payout = listed − listed × fee%` ·
`profit = payout − finalCost` · `roi = profit / finalCost` · `margin = profit / listed`

- **Default fees** (`DEFAULT_FEE_PCT`): **Alias 9.9%** (7% commission + 2.9% ACH),
  **StockX 10%** (7% seller + 3% payment). Defaults, not law — both are overridable
  per calculation for reduced-fee seller programs.
- **A blank fee box means the default, never 0%.** Reading an empty field as zero
  would quietly inflate every payout on the screen; guarded in `feeFor` and covered by
  a test.
- **ROI against a zero cost is 0, not infinity** — a free pair isn't an infinite
  return, it's an unanswered question, and the verdict falls through to "no call".
- **Alias is listed first**, unlike the source, which leads with StockX: Alias is our
  primary market and its prices come from the integration the rest of the app already
  runs on. StockX fills itself too when configured (added 2026-08-22), and stays a
  plain manual box when it isn't.

## The call (`dealVerdict`)
- **Buy** needs **both** ≥ `BUY_MIN_PROFIT` ($15/pair) **and** ≥ `BUY_MIN_ROI` (15%).
  One of the two is a **Watch**; neither is a **Pass**. Their thresholds, kept.
- **No verdict at all** until there's a cost *and* at least one priced platform — an
  empty form must say nothing rather than advise "Pass" on no data.
- **Risk** reads off *margin* (profit ÷ sale), with the bands shifted by **liquidity**:
  the same 15% margin is fine on a pair that sells daily and uncomfortable monthly.
- **Platform spread** only renders with two real quotes. "$120 better on Alias" is a
  lie when the StockX box is simply empty.
- **Best platform = most profit**, counting only platforms with a sale price entered.

## The advisor
The calculator no longer owns a chat panel. The advisor is **app-wide** now — the
floating button on every staff screen (`docs/context/advisor.md`). This screen just
publishes what it's showing via `useAdvisorContext`, so "is this a good buy?" is answered
against the pair in front of you, including what we've paid for that SKU before.

## Roles — and the one deliberate exception
Admin + **warehouse** + PH. Every *other* pricing surface is PH + admin, because the
warehouse doesn't set prices; `api/ph/price-inquiry.js` stays PH + admin. The
calculator is the exception on purpose: it exists to answer "should I buy this",
which is warehouse work, and it's useless to the person actually holding the shoe if
they can't open it. `api/payout/quote.js` is therefore gated
`['warehouse','ph_team']` (admin/superadmin auto-allowed) — it shares Price Inquiry's
engine (`priceInquiryForSkuSizes`), is read-only, and is rate-limited to 30/min with a
20-size cap (the screen only ever asks for one). The StockX side is bounded harder
still by that API's 25,000/day account-wide quota, which is why the client caches the
catalogue for 12 h and market data for 10 min.

## What persists, and what must not
- **Rates persist per device** in `prefs.payoutRates` (`src/prefs.js`): store %, promo
  %, gift card %, cashback %, tax %. They're per store *trip* — the same stack holds
  all afternoon in one shop, and retyping them for every pair is how a wrong number
  ends up in a buy call. A supplier preset writes straight into these,
  so a tap on a chip is also what sticks on the device.
- **Per-pair amounts never persist**: shelf price, coupon, tip, shipping, both sale
  prices, both fee overrides, liquidity. They start empty for every shoe, on purpose.
- **The URL carries the shoe only** (`?sku=`, `?size=`), so a refresh or a link to
  whoever asked comes back to the same pair. The money is deliberately **not** in the
  URL: a shared link that carries someone's cost basis around is a leak, not a
  convenience.
