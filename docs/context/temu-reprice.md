# Temu Reprice (PH) — `/ph/temu-reprice`

Answer Temu's price recommendations against today's market. Same idea as eBay Reprice
(`ebay-reprice.md`) and SHEIN Reprice (`shein-reprice.md`) — our price for a shoe is
**market + markup**, and a price only ever goes **down** to it — in the shape Temu works
in: Temu sends a list of "pricing opportunities" (a lower base price it recommends per
SKU) and each row takes an answer. Owner's spec, 2026-11-20: *accept when their price is
on or above market + 15 %; if not, put our price; the markup is adjustable.*

PH team only (admin auto-allowed server-side). Card in the PH home's Pricing & Listing
section; route `temureprice` in `PH_PATHS`.

## Files
| | |
|---|---|
| `src/screens/TemuReprice.jsx` | the page: 3 steps, downloads |
| `src/lib/temuReprice.js` | PURE: template reader (+ per-row dropdowns), size, styles, jobs, the answer, fill, verify, outputs |
| `src/lib/sheinReprice.js` | `openWorkbook` / `readSheet` (the xlsx reader), `priceCents` |
| `src/lib/ebayReprice.js` | `readInventoryFile`, `styleFromTitle`, `cacheKey`, `parseMarkup` |
| `src/components/MarketPrices.jsx` + `api/ebay-reprice/prices.js` | the shared price step and strict Alias lookup |
| `e2e/temu-reprice.spec.js`, `e2e/fixtures/temu-pricing-template.xlsx` | the rules + the page; the fixture is Temu's own template cut to 7 made-up SKUs |

## The steps
1. **Files.** (a) Temu Seller Center → Pricing health → the batch template
   (`Traffic boost opportunity_….xlsx`). Sheet **Template**: row 1 headers, row 2 Temu's
   explanations, one SKU per row from row 3. Columns found **by header name**: Product
   name, Goods ID, SKU ID, SKU, Variation, Product status, Current base price, Recommended
   base price, Action, New base price, Reasons. (b) The store inventory report CSV (`SKU`,
   `Style ID`) — the same one eBay Reprice takes.
2. **Market prices.** The shared step: jobs `{sku: style, size}`, per-EST-day cache in this
   browser, shared with eBay / SHEIN Reprice.
3. **Answer Temu.** Markup default **15 %** (never remembered, 0–100). Build → verify →
   download `Temu reprice (M.D.YYYY).xlsx` (today's EST day) + an audit CSV of every row.

## Rules that must not drift
- **Style ID**: the SKU in the inventory report → else the code in the product name
  (`… (HV4403-601)`, read as eBay Reprice reads a title; the report only lists stock on
  hand, so sold-out SKUs come this way) → else skipped. A SKU the report maps to two
  styles uses the name. `A / B` → one job per code, lowest wins.
- **Size** (`temuSize`): Variation is free-form — `8.5W/Pink`, `Grit/6`, `4Y`,
  `Team Red-11.5W/One-size`, `As shown: 6-4Y-One-size/One-size`. The `/` part that IS a
  size; failing that the LAST size inside a dashed part. W / Y / C dropped (the style code
  picks the catalogue). None, or two that disagree → skipped, not guessed.
- `ours = ceil(market × (1 + pct/100))` **to the cent** (Temu takes 2 decimals), BigInt.
- Per row, with Temu's recommended price `R` and today's base price `C` (`R < C`):
  - `R ≥ ours` → **Accept** (New base price and Reasons left blank).
  - `R < ours < C` → **New proposal**, New base price = `ours`, a Reason from Temu's list
    (default `High production cost`, pick on the page). Can be switched off.
  - `ours ≥ C` → **left blank**. Temu refuses a new base price above the current one, and
    we never raise; accepting would go under our price.
- **Each row has its own Action dropdown** (`<dataValidation sqref="M5">`): some offer only
  `Accept`. A row that can't be countered and whose `R` is under ours is left blank. A row
  with no dropdown is treated as Accept-only.
- A row already answered in the file (someone filled it by hand) is left alone.
- **Only the three answer cells of answered rows change.** Every other cell, the per-row
  dropdowns and every other part of the zip are byte-for-byte Temu's.
- **1,000 answered lines per file** (Temu's Instructions tab): more → several files, each
  the whole template with its share of the answers.
- **Verify gate** (download disabled unless all pass, for every part): other zip parts
  identical; every cell outside the answers identical; each answer is one the row's
  dropdown offers, an Accept only where `R ≥ ours`, a counter exactly `ours`, 2 decimals,
  under `C`, above `R`, with a listed reason; ≤ 1,000 answers.
- Option **Only answer Active products** (off by default): inactive rows left blank.

## Not built
- Uploading to Temu (no API in use): Seller Center → Pricing health → Batch processing.
- Reading Temu's result of the upload (which proposals it took).
- The Hyperlink column is left blank.
