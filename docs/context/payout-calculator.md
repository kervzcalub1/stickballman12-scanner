# Payout Calculator

Screen: `src/screens/PayoutCalculator.jsx`. Maths: `src/lib/payout.js` (pure).
Endpoint: `api/payout/quote.js`. Routes: **`/payout`** (admin + warehouse home,
In-Store Mode section) and **`/ph/payout`** (PH home, Pricing & Listing section).
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
than no screen. Their inventory intake, barcode scanner, product search, bulk/batch
analyser and AI advisor were **not** ported: we already have all of those, or don't
want them.

## The steps down the page
1. **Shoe** (optional) — SKU → Alias catalogue (`api/sku-search.js`, shared with PH's
   Price Inquiry) → tap the size you're holding → **one call** (`api/payout/quote.js`)
   returns that size's live market on **both** platforms, as two tappable strips:
   **Alias** (lowest ask / highest offer / last sold / Global Indicator) and **StockX**
   (lowest ask / highest bid / earn more / sell faster, via the official Public API —
   `api/_lib/stockx.js`, see `integrations.md`). Each cell fills **its own** platform's
   sale price. Note the asymmetry: **StockX has no last sale** — no such field exists in
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
   cost** + **Saved off sticker**, with a collapsible line-by-line breakdown.
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
4. **Expected payouts → The call** — per-platform fees → payout / profit / ROI, then a
   **Buy / Watch / Pass** verdict with risk and platform spread.

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

## The payout maths (`calcPayout`)
`payout = sale − sale × fee%` · `profit = payout − finalCost` ·
`roi = profit / finalCost` · `margin = profit / sale`

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
  ends up in a buy call.
- **Per-pair amounts never persist**: shelf price, coupon, tip, shipping, both sale
  prices, both fee overrides, liquidity. They start empty for every shoe, on purpose.
- **The URL carries the shoe only** (`?sku=`, `?size=`), so a refresh or a link to
  whoever asked comes back to the same pair. The money is deliberately **not** in the
  URL: a shared link that carries someone's cost basis around is a leak, not a
  convenience.
