# SHEIN ↔ Shopify check — `/ph/shein-check` (PH) · `/shein-check` (admin)

Built 2026-10-13, while SHEIN API access is pending. 4seller (today's Shopify → SHEIN tool)
maps sizes wrong and lets SHEIN stock drift above Shopify's, so orders get cancelled and
oversold. This page measures it from SHEIN's **Export Products** file against the LIVE Shopify
store. **Read-only** — nothing on SHEIN or Shopify changes. The same rules (`src/lib/sheinCheck.js`)
are meant to gate the future API sync before it writes anything.

PH team + admin (Shopify read = `api/shopify-listings/variants`, PH + admin). PH home card
under Pricing & Listing (`sheincheck`); admin home → **Marketplaces** (route `shein-check`).

## How it matches
Each SHEIN size row → the Shopify variant whose SKU = the row's **`sellerSKU`** (the Shopify
variant SKU 4seller copied over). Columns found by header name: `sellerSKU`,
`Secondary Specification Value1` (size), `Current inventory` (required); SPU, SKC, SKU, name,
brand, main image, mall link (optional).

## Size rule (`compareSize`)
A size = **number + who it fits**: adult (no marker) · women (W) · youth (Y/GS) · child
(C / Toddler / TD / PS / K). Only US sizes compare; "US" prefix ignored.
- number differs → **Wrong size** (bad): `US8` vs `9`, `US15W` vs `15.5W`
- child vs anything else, or youth vs women → **Wrong age group** (bad): `7 Toddler` vs `7Y`
- youth vs adult → **Youth vs adult** (warn): `US6.5` vs `6.5Y`
- women vs adult → OK (only the W marker differs): `US6` vs `6W`
- EUR / CN / UK / a range (`US7-8`) → **EUR / CN / range size** (warn, can't be checked)
- blank on SHEIN → **No size on SHEIN** (bad)

## Other findings
**More on SHEIN than Shopify** (bad, SHEIN qty > max(0, Shopify qty)) · **Not in Shopify** (bad
when SHEIN still offers pairs; warn "0 on SHEIN" otherwise) · **No seller SKU** (bad) · **SKU used
twice on SHEIN** (warn) · **Shopify product not active** (warn) · Less on SHEIN (info).
Products sort worst first (wrong size 100 > oversell 50 > dead SKU still offered 30 > blank 20).
The export's date (from its filename) is shown when it isn't today: sizes don't age, stock does.

**Fix list (CSV)**: every size with a non-info finding — issue, seller SKU, both sizes, both
stocks, Shopify product + status, SPU / SKC / SHEIN SKU, link, export row.

First run (10/9 export vs Shopify 10/13): 1,688 sizes — 55 wrong size, 3 wrong age group,
94 over-stocked, 203 not in Shopify with stock, 103 blank, 20 EUR/CN/range; 1,015 clean.

## Next (the SHEIN API integration — needs SHEIN Open Platform access + Shopify `write_inventory`)
Connect (appid/secret → store authorization → openKeyId/secretKey; HMAC signing per SHEIN's
SDK) · pull listings/orders/authorized brands (`query-brand-list`) · SHEIN sale → deduct Shopify ·
Shopify stock → SHEIN · prices · list from Shopify with this size check as the gate, custom size
values (`add-custom-attribute-value`). 4seller's sync must be switched off the day ours goes live.
