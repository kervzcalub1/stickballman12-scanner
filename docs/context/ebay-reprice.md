# eBay Reprice (PH) — `/ph/ebay-reprice`

Cut every eBay listing priced above today's market down to market + markup. **Never
raises a price.** Ported from the `ebay-reprice` Claude Code skill
(`~/.claude/skills/ebay-reprice/` — the scripts there are the reference; don't edit them
from here). Checked byte-for-byte against the skill's output for the 9.1.2026 run: same
upload file, same audit report, 1,668 / 357 / 14 / 3.

PH team only (admin auto-allowed server-side). Card in the PH home's Pricing & Listing
section; route `ebayreprice` in `PH_PATHS`.

## Files
| | |
|---|---|
| `src/screens/EbayReprice.jsx` | the page: 4 steps, downloads |
| `src/components/MarketPrices.jsx` | the step-3 fetch loop + card, SHARED with Shopify Listings (`shopify-listings.md`) |
| `src/lib/ebayReprice.js` | PURE: raw-line CSV, both readers, StyleID resolution, jobs, markup math, apply, finalize, verify, outputs |
| `api/ebay-reprice/prices.js` | `POST { jobs:[{sku,size}] }` (≤ 25) → per-job status |
| `api/_lib/ebay-reprice.js` | `priceStyleSize` — strict Alias lookup + PRICE_HIERARCHY |
| `api/_lib/alias.js` | `aliasCatalogLookupStrict`, `aliasAvailabilityCentsStrict` (throw on upstream failure) |
| `e2e/ebay-reprice.spec.js` | the rules + the page with the endpoint mocked |

## The steps
1. **Files** — two separate fields. Revise-price export: header = the row whose first
   cell is `Action` in the first 5 lines (line 1 is `#INFO`). Inventory report: `Style
   ID` / `SKU` found **by header name** (order changes month to month); missing → hard
   fail showing the header. Uploads are only read; every output is new text.
2. **Style IDs** — direct SKU → sibling sizes of the listing (only if they agree) →
   style code in the title (needs a digit, ≥ 4 chars; a code the report knows wins).
   Blank / sizes-disagree / SKU-maps-to-two-styles groups BLOCK until a person types a
   Style ID or ticks Skip. Title codes the report doesn't know are listed, not blocking.
3. **Prices** — batches of 20 to `api/ebay-reprice/prices`, one at a time (server runs 4
   lookups concurrently). Cached in `localStorage` per EST day (`reprice:prices:<ymd>`, shared with Shopify Listings)
   so a reload resumes; older days are pruned. Pause / Resume / Retry failed / Clear.
4. **Reprice** — markup % (default **12**, never remembered), dry-run toggle, verify,
   downloads `eBay reprice (M.D.YYYY).csv` (date from the export's filename) and
   `reprice report (M.D.YYYY).csv`.

## Why the server endpoint, not `/api/get-price`
`aliasCatalogBySku` returns null on ANY non-OK Alias response, so the public endpoint
turns "Alias was unhappy" into a **404 "not found"** — the skill's spurious 404s (51 rows
in September). The strict helpers throw instead, so each job comes back as exactly one of
`ok` (valueCents, rank, label) · `null_price` · `not_listed` (honest catalogue miss) ·
`bad_size` · `error` (retryable). Only `error` is retried: 10 tries, 2 s × attempt
apart; a 429 from our own server pauses the whole loop. Unresolved jobs are never cached,
so they can't reach step 4 as "no data" — Build stays disabled until they resolve.
Catalogue ids are cached per style for 30 min (one catalogue call per style, not per size).

Sizes: the availability call strips suffixes (`6W` → `6`) — it always has, which is why
the skill saw identical values for both forms. The style code picks the catalogue (a
women's style is its own catalogue entry), so the suffix is not what disambiguates.

## Rules that must not drift
- Only single-size rows with a SKU, a style and a Start price are priced; a parent's
  `Size=6;6.5;7` is a table of contents.
- Multi-code style (`G57540 / 100252505`) → one job per code, the **lowest** price wins,
  noted in the report.
- `reprice = round_half_up(market × (1 + pct/100))` in integers (BigInt) — no floats.
- Only lower: `<` write, `>` kept (market higher), `=` kept (equal), no price → unchanged.
- Raw-line edits only: split on commas outside quotes keeping quotes; a new price copies
  the old cell's style (quoted stays quoted, `85.0` → `96.0`); BOM + LF kept.
- Output drops **Available quantity** (stale quantities would undo sales). No StyleID
  column is ever added — styles live in memory — so the file is the template's 11 columns.
- **Verify gates the download**: row count, columns = original minus Available quantity,
  no ragged rows, every difference in Start price.

Not built: reading eBay's upload-result report (step 5 in the skill).
