# SHEIN Reprice (PH) — `/ph/shein-reprice`

Cut every SHEIN listing priced above today's market down to market + markup. **Never
raises a price.** Same job as eBay Reprice (`ebay-reprice.md`), different files: SHEIN
works in `.xlsx` both ways. Spec: the PH team's narrated walkthrough, 2026-10-10.

PH team only (admin auto-allowed server-side). Card in the PH home's Pricing & Listing
section; route `sheinreprice` in `PH_PATHS`.

## Files
| | |
|---|---|
| `src/screens/SheinReprice.jsx` | the page: 3 steps, downloads |
| `src/lib/sheinReprice.js` | PURE: xlsx reader, export rows, style + size, jobs, markup, apply, template fill, verify, outputs |
| `public/templates/shein-edit-price.xlsx` | SHEIN's blank **Edit+Price** template, shipped with the app |
| `src/components/MarketPrices.jsx` | the price step, SHARED with eBay Reprice + Shopify Listings |
| `api/ebay-reprice/prices.js` | the same strict Alias lookup (why strict: `ebay-reprice.md`) |
| `e2e/shein-reprice.spec.js` | the rules + the page with the endpoint mocked |

## The steps
1. **Files.** SHEIN Seller Center → Products → **Export Products** (`.xlsx`, sheet
   *Product Information*). Columns are found **by header name**: `SKU`, `Secondary
   Specification Value1` (size), `Default product description(en)`, `Default Product
   Name(en)`, `Original Price(…)`, `Special Offer(…)`. Missing → hard fail naming them.
   The template is built in; a newer one can be dropped in (row 1 of `sheet1` must read
   Field Code · SKU · Currency · Original Price · Special Offer).
2. **Market prices.** The shared step: same jobs `{sku: style, size}`, same per-EST-day
   cache in this browser, so a style + size priced on eBay Reprice today is free here.
3. **Reprice.** Markup default **15 %** (never remembered). Build → verify → download
   `SHEIN reprice (M.D.YYYY).xlsx` (date from the export's filename) + an audit CSV
   covering every row of the export.

## Rules that must not drift
- **Style code** = the first token of the description's first line (the listing
  template puts it there, before the store blurb). Else a code in that line ("… –
  IB4025-100"), else one in the product name ("… (HM6469-301)"), read the way eBay
  Reprice reads a title. None → skipped, named in the report. `A / B` → one job per
  code, lowest wins.
- **Size**: `US10.5` → `10.5`, `US9.5W` → `9.5` (US and letters dropped, the
  walkthrough). Blank, EUR/CN, "7 Toddler", ranges (`US7-8`), `MX-…` → **skipped, not
  guessed**.
- `new = ceil(market × (1 + pct/100))` to whole dollars, in integers (BigInt). **Always
  UP** (owner: "round up always"): 120.0025 → 121.
- **Only lower**: new < current Original Price → in the file; ≥ → kept, never raised.
- **Special offer**: SHEIN rejects an original price ≤ the special offer, so such a row
  is **not sent** (report says why). A live special offer (> 0) on a row that IS cut is
  **carried over** rather than blanked: a blank might end the promo. Zero special = blank.
- **Only the cuts go in the upload**, one row per SHEIN SKU, from row 4 of `sheet1`:
  A Field Code blank · B SKU · C `USD` · D price · E special. Written as text cells like
  SHEIN's own example row. Every other part of the zip is copied **byte for byte**.
- **Verify gate** (download disabled unless all pass): every other template part is
  identical, rows 1–3 identical, one row per cut, each row's SKU is in the export once,
  USD, a whole-dollar price below today's, and any special under it.

## Not built
- Uploading to SHEIN for you: there's no API in use; the file goes up by hand
  (Products → Batch edit → Edit+Price).
