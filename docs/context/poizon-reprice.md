# POIZON Reprice — section **Prices** of the POIZON page: `/ph/poizon?section=reprice` · `/poizon?section=reprice`

Cut every POIZON listing priced above today's market down to market + markup. **Never
raises a price.** Same job as eBay / SHEIN / Temu Reprice (`ebay-reprice.md`,
`shein-reprice.md`, `temu-reprice.md`), in POIZON's files. Spec: POIZON's own walkthrough
(their account manager's screenshots, 2026-11-20) + the owner's "same as eBay, SHEIN, Temu".

PH team (admin auto-allowed server-side). One POIZON page, two sections (owner's rule: one
page per marketplace): **Orders** (`poizon-orders.md`) and **Prices**. The shell with the
tabs is `PoizonOrders` in `src/screens/PoizonOrders.jsx`; the home card is "POIZON".

## Files
| | |
|---|---|
| `src/screens/PoizonReprice.jsx` | the section: 3 steps, downloads |
| `src/lib/poizonReprice.js` | PURE: export reader, size, style, jobs, markup, apply, template fill, verify, outputs |
| `public/templates/poizon-price-inventory.xlsx` | POIZON's blank **Price & Inventory Template**, shipped with the app |
| `src/lib/sheinReprice.js` · `src/lib/ebayReprice.js` | `openWorkbook` / `readSheet` / `priceCents` · `readInventoryFile`, `styleFromTitle`, `cacheKey`, `parseMarkup` |
| `src/components/MarketPrices.jsx` + `api/ebay-reprice/prices.js` | the shared price step and strict Alias lookup |
| `e2e/poizon-reprice.spec.js` | the rules + the page with the endpoint mocked |

## The steps
1. **Files.** (a) POIZON Seller Dashboard → Listing → Smart Listing → **Export All**
   (`Export Smart Listing20261118.xlsx`, one sheet, 48 columns). Columns found **by header
   name**: Seller SPU ID, Seller SKU ID, Status, Reason for Unready to List, Article
   Number/Style ID, Size, Currency, Expected Price (Tax-Exclusive), Item Name, Barcode,
   Price Update Method. (b) The store inventory report CSV (`SKU`, `Style ID`) — **its SKU
   is the export's Barcode**. (c) The template is built in; a newer one can be dropped in
   under More options (row 2 of sheet `Template` must be the nine column names).
2. **Market prices.** The shared step: jobs `{sku: style, size}`, per-EST-day cache in this
   browser, shared with the other three reprice tools.
3. **Reprice.** Markup default **15 %** (never remembered, 0–100). Build → verify →
   download `POIZON reprice (M.D.YYYY).xlsx` (date from the export's filename, else today
   EST) + an audit CSV of every listing. Uploaded by hand: Smart Listing → Batch Import →
   **Import Updated Price & Inventory**.

## Rules that must not drift
- **Style ID** (`resolveStyles`): the inventory report by **Barcode** → else the export's
  own style column when it is ONE clean code (`articleCode`: upper-cased, a trailing
  2-digit year or dash dropped — `AR3565-101 24`, `IX1852-100-`; the column is typed by hand
  and sometimes holds the store blurb) → else a code in the item name → else skipped. The
  report wins: on the 11-18 export it disagreed with POIZON's column on 25 of 2,048 rows,
  every one a bad POIZON value. The report only lists stock on hand (3 of 482 sold-out
  listings), so the fallbacks matter.
- **Size** (`poizonSize`): `10`, `6.5W`, `5.5Y`, `10C` → the number; the letter is dropped
  (the style code picks the catalogue). Clothing sizes (S, 2XL) → skipped, not guessed.
- **Skipped**: Status `Unmatched` / `Matching in Progress` (not on POIZON yet), no SPU ID,
  not USD, no size, no style, no price. `Sold Out` listings ARE repriced unless the box is
  unticked (the price is then right when stock returns). `Unable to List` is repriced —
  most of those are "price too high".
- `new = ceil(market × (1 + pct/100))` to **whole dollars**, BigInt. Always UP.
- **Only lower**: new < Expected Price (Tax-Exclusive) → in the file; ≥ → kept.
- **POIZON's own limit**: a reason like "Listing price exceeds the limit. Set it to $171.00
  or below" is parsed (`limitCents`). We do NOT go under market + markup to meet it; a cut
  that still sits above it is counted on the page and noted in the report.
- **Only the cuts go in the upload**, one row per SKU ID from row 3 of `Template`:
  A SPU ID · B SKU ID (text cells, as in the export — 14 digits must never become
  4.97E+13) · C Expected Price (Tax-Exclusive) (a number) · I `Manual update`. D–F and H
  (Inventory) stay **blank** — the walkthrough fills only C and I, and stock must not move.
  G (Discount) is blank too; the template's Data Definition calls it Required, so More
  options has **Put 0 in the Discount column** in case an import is refused for it.
- **`Manual update` is the point**: listings are normally `Update via API` (the Shopify
  app pushes prices). POIZON: "in this way the price will only follow the one you upload
  manually". So a listing we cut stops following the API price from then on.
- Every other part of the zip (Data Definition tab, styles) is copied **byte for byte**.
- **Verify gate** (download disabled unless all pass): other parts identical; rows 1–2
  identical; one row per cut; each row is a SPU + SKU pair from the export, once, with a
  whole-dollar price below today's, D–F and H blank, G blank (or 0 with the switch),
  I = `Manual update`.

## Not known yet (first real upload will tell)
- Whether POIZON accepts an empty Discount, and whether a blank Inventory truly leaves
  stock alone — both follow POIZON's walkthrough, neither has been uploaded by us. **Try a
  file of 2–3 rows first.**
- POIZON's row limit per import (the template states only 30 MB). No splitting is done.

## Not built
- Uploading to POIZON (no API in use), and reading the import's result.
- Raising prices, or going back to `API update`.
