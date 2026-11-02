# StockX Listings + Reprice (`/ph/stockx-listings`, admin `/stockx-listings`)

Built 2026-11-03. Our ~1,750 StockX listings are all **Direct** (0 Flex/consignment, ~15
Standard — probed 2026-11-03). Alex was lowering them one by one in StockX Pro → Direct Active
(36 pages); the **Direct** lowest ask can sit far above the **Standard** (Ship to Verify) one
($170 vs $48 on a slow shoe) and nobody pays that premium. He asked StockX for a bulk tool; this
is ours. Default rule (user's call): **match the Standard lowest ask**, never under the profit
floor (default **$5** after StockX's 10 % fee), and **only ever lower**.

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
| `e2e/stockx-reprice.spec.js` | rules, server queueing, locks, the page |

## Tables (db:setup; all three in `LIVE_TABLES`)
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
- No scheduled re-run (a person presses Pull and Reprice).
- Standard listings (~15) aren't pulled — Direct only.
- Sales history is still not in StockX's API; the log's **Ended** column is the proxy.
- **"Listed ≥ days" is the StockX LISTING's age, not the stock's**: on the real pull most listings
  were 1–3 days old even where the ask was months stale (listings get re-created), so *Over
  Standard ≥ %* is the reliable way to find over-priced ones.
