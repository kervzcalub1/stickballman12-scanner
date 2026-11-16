# StockX Listings + Reprice (`/ph/stockx-listings`, admin `/stockx-listings`)

Built 2026-11-03. Our ~1,750 StockX listings are all **Direct** (0 Flex/consignment, ~15
Standard — probed 2026-11-03). Alex was lowering them one by one in StockX Pro → Direct Active
(36 pages); the **Direct** lowest ask can sit far above the **Standard** (Ship to Verify) one
($170 vs $48 on a slow shoe) and nobody pays that premium. He asked StockX for a bulk tool; this
is ours. Default rule (user's call): **match the Standard lowest ask**, never under the profit
floor (default **$5** after StockX's 10 % fee), and **only ever lower**.

## Daily, automatic (2026-11-16 — task T-1334, "consignment price is not equal to lowest ask")
"Consignment" in the task = our **Direct** asks (we have no Flex/consignment stock). Alex's ask,
repeated in meetings: the price update must happen **by itself every day**, by rules the team can
**teach** it. What the first build got wrong (local copy of prod, 11-13): **no price had ever been
sent from this page** — 87 % of the listings had no cost on file, so the tool refused 624 of the
731 over-priced ones, and nothing ran unless a person remembered to press Pull and Reprice.

- **The daily run** (`api/_lib/stockx-daily-worker.js`, started by `server.mjs`, **production
  only**; `STOCKX_DAILY=on|off` overrides): at the set EST hour (default **9**, before the PH
  shift) → the same pull as the button (~15 min) → the day's picture saved (`stockx_daily.stats`,
  `dailyStats`) → **when the switch is ON**, every price the rules lower is queued
  (`requested_by = 'auto (daily)'`, rule text starts "Daily auto ·") and the reprice worker sends
  them → a summary in the price-alert Telegram group (`PRICE_ALERT_CHAT_ID`). A failed or
  incomplete market read (pull error, or > 10 % of sizes with no answer) changes **no price**; it is
  tried again after 30 min, three times, then reported. With the switch OFF the read and the
  record still happen (read-only) — the analysis is there every morning either way.
- **The switch + the rules** = `app_settings.stockx_auto` `{ on, rule, offset, minProfit,
  maxCutNoCost, hour }` (`api/_lib/stockx-daily.js` `readAuto` / `writeAuto` / `cleanAuto`).
  **Ships OFF; only an admin turns it on or changes the rules** (`POST /api/stockx/daily
  { settings }`, also `{ run: true }` = don't wait for the hour — refused off production).
- **No cost on file → the size of the cut is the guard** (`planListing` `maxCutNoCost`, default
  `MAX_CUT_NO_COST` = 30): a cut of ≤ 30 % of today's ask follows the market (`noCost: true`, "no
  cost" in the log's rule text); a bigger one is state **`no_cost`** = "to look at" and waits.
  `maxCutNoCost: 0` (what `planListing` and the reprice endpoint default to when it isn't sent) is
  the old rule: every no-cost listing waits. Cost itself now also falls back to the **average of
  the style's other sizes** (`cost_source = 'style'`, shown "(other sizes)").
- **Teaching** (`stockx_teach`, keyed by **variant** = the size — a listing id changes whenever the
  listing is re-made, a size doesn't; PH + admin, `POST /api/stockx/daily { teach }`): on a waiting
  row **✓ OK → $X** (`big_cut_ok`: this big cut is fine — it goes with the next run and keeps
  following the market) or **Lowest price…** (`min_price`: never ask less — a floor of its own, the
  higher of it and the cost floor wins, and it makes a missing cost safe to act on); **×** on the
  chip forgets it. 🔒 Keep is still per listing.
- **The card** (top of the page, `DailyCard`): ON/OFF, the rule in words, today's status, four
  tiles from the live rows (over Standard + bands · go down with the next run · to look at ·
  stopped by the floor — the last three filter the list) and the last 14 days (`listStockxDaily`:
  live, over Standard, $ over, **lowered / $ cut** from the log, to look at, left StockX, how the
  day ran). A pull by hand also refreshes today's picture.
- **Known limits:** only ever lowers — when the market goes back up our ask stays down (raise by
  hand in StockX Pro); it follows whatever the Standard lowest ask is, so one seller's lowball
  drags a no-cost pair down by up to the cap per day (a pair WITH a cost or a taught lowest price
  stops at its floor); Pre-sell listings are never touched (their own lock on the Pre-sell page).

## Files
| | |
|---|---|
| `src/screens/StockxListings.jsx` | the page: pull, rule, filters, picks, 🔒, reprice, queue, log, CSVs |
| `src/lib/stockxReprice.js` | THE rules (pure) — `planListing`, `floorPrice`, `rulePrice`, `gapPct`, `daysListed`; the screen previews with them, the server enforces with them |
| `api/stockx/listings.js` | GET rows + pull state + queue · POST `{pull:true}` → `runStockxPull` in the background |
| `api/stockx/reprice.js` | POST `{listingIds, rule, offset?, minProfit?, allowNoCost?}` → server plans + queues · POST `{cancel:true}` · GET the log |
| `api/stockx/lock.js` | POST `{listingIds, lock, note?}` — 🔒 Keep price (≤ 1,000) |
| `api/_lib/stockx-reprice-worker.js` | sends the queue (started by `server.mjs`) |
| `api/_lib/stockx.js` | `stockxActiveListingsPage` (100/page, StockX's cap), `stockxMarketByProgramme` |
| `api/stockx/daily.js` | GET settings + the last 14 days · POST `{settings}` / `{run:true}` (admin) · POST `{teach}` (PH + admin) |
| `api/_lib/stockx-daily.js` | the switch + rules (`stockx_auto`), `recordStockxDay`, `autoEdits`, `queueStockxAuto` |
| `api/_lib/stockx-daily-worker.js` | the once-a-day run (`runStockxDaily`, `dailyDue`), production only |
| `e2e/stockx-reprice.spec.js` | rules, server queueing, locks, the page, the daily update + teaching |

## Tables (db:setup; all five in `LIVE_TABLES`)
- **`stockx_teach`** (variant_id PK: `min_price`, `big_cut_ok`, note, who/when) and **`stockx_daily`**
  (day PK EST: `stats`, `auto`, `pulled_at`) — the daily update, above.
- **`stockx_listings`** — what the last pull saw: our `amount`, `sx_created_at` (days listed),
  and the market for that size: `standard_lowest`, `direct_lowest`, `flex_lowest`,
  `highest_bid`, `market_at`. A listing missing from a pull keeps its row with **`ended_at`**
  (sold or taken down) — the follow-up check ("did the cut move it?").
- **`stockx_price_locks`** — 🔒 Keep price per listing.
- **`stockx_price_edits`** — the QUEUE and the log: `queued → sent (operation_id) → done | failed`,
  or `cancelled`; old/new amount, the market at the time, the rule text, who.

## Pull
Every ACTIVE **Direct** listing (`GET /selling/listings`, pages of 100), saved; then the market
for each distinct size once (`GET …/variants/{id}/market-data` → `standardMarketData.lowestAsk`,
`directMarketData.lowestAsk`, `flexMarketData.lowestAsk`, `highestBidAmount`). All on the shared
StockX pace (one call per 400 ms, 429 back-off — `sxFetch`), three market reads in flight (one
at a time ran ~40 min on the real 1,736 sizes — each answer takes ~1 s), so ~12–15 min.
Progress in `app_settings.stockx_pull` (the page watches it live); a "running" pull older than
30 min counts as dead. In-process, like the eBay pull — a redeploy mid-pull means press it again.

## The rules (`planListing`)
- Price = the rule's (`standard` = Standard lowest ask · `standard_minus` = that − $X · `bid` =
  the highest bid, "sell now"), raised to the **floor** = ⌈(cost + min profit) ÷ 0.9⌉.
- **Only lower.** At/under it → `kept`; the floor ≥ today's ask → `below_floor`; held above the
  rule by the floor → `floored` (still a cut).
- **Cost**: the Pre-sell stock row's `unit_cost` for a Pre-sell listing, else the **average cost
  of our pairs of that style + size** (sizes compared by their numbers: "7.5W" = "7.5"). No cost →
  `no_cost`, not repriced unless *Reprice ones with no cost (no floor)* is ticked.
- **Skipped**: 🔒 locked, **Pre-sell** listings (their own price lock would put a change back —
  set them on the Pre-sell page), no market, a change already in flight (`busy`).
- The SERVER re-plans every listing from its own rows with the posted rule; the browser never
  sends a price.

## Worker (`stockx-reprice-worker.js`)
Every 5 s: ≤ 10 `queued` → `PATCH /selling/listings/{id} {amount}` → `sent` + operation id;
≤ 25 `sent` → read the operation: SUCCEEDED → `done` (and `stockx_listings.amount` follows),
FAILED → `failed` + StockX's reason; pending > 10 min → the listing's own amount decides. A 429
ends the pass. **Started by `server.mjs` only** (not the Vite dev server), wherever StockX is
configured; **`STOCKX_REPRICE_WORKER=off`** stops it — set by `playwright.config` because dev and
prod share ONE StockX account. Each environment only works its own database's queue.

## Page
Pull button + progress · Rule / − $X / Min profit / allow-no-cost · search + **Over Standard ≥ %**,
**Listed ≥ days**, **Ask $ range**, *Only ones that would drop* (default on), *🔒 Locked only* ·
counts by outcome · per row: ours, Standard (+gap %), Direct, bid, cost (pre-sell marked), the
call (→ price, or why not) and 🔒 · **🔒 Keep / 🔓 Unlock all in view** · **CSV of this view**
(the dated snapshot) · select all that would drop → **Reprice N on StockX** (confirm says the total
cut) · queue strip (waiting / confirming / done today / failed, **Stop the rest**) · log with
**Ended** (✓ date the listing left StockX) + CSV for the follow-up review.

## Not yet
- Raising a price back up when the market recovers (the run only lowers).
- Cost from PO lines / online orders for the pairs with none in stock (would lift cost coverage
  from ~21 % to ~31 % of listings — measured on the 11-13 copy).
- Standard listings (~15) aren't pulled — Direct only.
- Sales history is still not in StockX's API; the log's **Ended** column is the proxy.
- **"Listed ≥ days" is the StockX LISTING's age, not the stock's**: on the real pull most listings
  were 1–3 days old even where the ask was months stale (listings get re-created), so *Over
  Standard ≥ %* is the reliable way to find over-priced ones.
