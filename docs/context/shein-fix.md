# SHEIN listing fix — tabs **Match sizes** + **Fix & download** on `/ph/shein-check` · `/shein-check`

Built 2026-10-13. Fixes the SHEIN listings 4seller broke, from Shopify, with HARD-CODED rules
(`src/lib/sheinFix.js`). The AI (OpenAI) is only a helper for one narrow job, and every answer
it gives is re-checked by the rules. Nothing is written to SHEIN or Shopify from the app: the
output is SHEIN's own inventory upload file + a list of changes to make in Seller Center.
(When SHEIN API access exists, the same rules drive the API writes.)

## What 4seller did (10/9 export vs Shopify, 10/13)
- Shopify sizes missing from SHEIN's size list were pushed onto the NEAREST SHEIN size —
  Shopify 4 / 4.5 / 5 → SHEIN US7 / 7.5 / 8; 5W → US7W; 15.5W → US15W (49 of 58 wrong sizes).
- Swaps inside one product: SHEIN US8 carries Shopify 9's SKU, Shopify 8's SKU sits on US7 (9).
- SHEIN stock above Shopify's; SHEIN sales never taken off Shopify; 418 SHEIN sizes on SKUs
  Shopify no longer has (most = product re-created in Shopify with new SKUs).
Every SHEIN product maps to exactly ONE Shopify product (0 of 421 span two).

## The rules (per SHEIN size → new stock)
The warehouse ships whatever SELLER SKU a SHEIN order carries, so:
| Case | Stock | Action written to the fix list |
|---|---|---|
| seller SKU = a Shopify variant of the SAME size (number + age group; W/M marker may differ; Y vs adult allowed) | Shopify qty − SHEIN orders not shipped yet (≥ 0) | — |
| linked to another size, and the right size's SKU exists in that Shopify product (**swap**) | 0 | change seller SKU to X |
| linked to another size, no such size in Shopify | 0 | remove the SKU; add size `US…` (or "moves to SHEIN US8" if a swap takes it) |
| seller SKU not in Shopify | 0 | relink: same style code (from SHEIN name) + same size, exact single match → "change seller SKU to X"; else AI; else delist |
| same seller SKU on two SHEIN sizes | 2nd+ get 0 | remove it from that size |
| blank / EUR / CN / range size | 0 | set SHEIN size to Shopify's (`US…`) |
| Shopify product not ACTIVE | 0 | — |
A relinked / swapped size stays 0 until the seller SKU is actually changed on SHEIN; the next
export + fix gives it stock. **Sizes to add**: Shopify sizes in stock that no SHEIN size sells
(add as a custom size value on SHEIN — never the nearest size).

## Inputs / outputs
- SHEIN Export Products (required, the check's upload). SHEIN Export Order (optional): lines
  whose status isn't delivered/shipped/refunded/cancelled/returned are held back per seller SKU.
- SHEIN inventory template (optional): any sheet whose row 1 has `SKU` + an inventory/stock
  column (+ warehouse column filled from the export's `Warehouse ID`); rows after SHEIN's
  guide/example rows replaced; every other zip part byte-identical; read back and verified
  before download. None loaded → a plain sheet (SHEIN SKU · seller SKU · size · warehouse ·
  now · new · why). Only CHANGED SKUs are in the file.
- Fix list CSV: every action + every size to add.

## AI helper (`api/shein-fix/ai.js`)
For SHEIN sizes still offered whose seller SKU Shopify no longer has and the rule couldn't
place: grouped per SHEIN product, up to 6 Shopify candidates each (`candidatesFor`: shared
title words, style code ×3), 6 products per call. Model `SHEIN_FIX_AI_MODEL`, default
**gpt-5.5** (`reasoning_effort: medium`, strict JSON schema). The system prompt carries the
findings above (exact size or nothing, never nearest; age groups). The server drops any
answer naming a product/SKU it wasn't given; the page keeps a link only if confidence ≥ 0.6
AND `verifyAiLink` passes (variant exists, in that product, same size). It never sets stock.
Real run 10/13: correctly relinked Supreme × AF1 Box Logo (rule missed: style not parsed from
the Shopify title) and declined 5 shoes truly gone from Shopify.

## First real numbers (10/9 export + 10/5 orders vs Shopify 10/13)
424 SHEIN sizes change stock, 375 set to 0, pairs offered 2,008 → 1,292, 122 seller SKUs to
change (9 swaps + 113 relinked by rule), 179 Shopify sizes to add, 9 open orders held back.

**Before uploading: pause 4seller's SHEIN inventory sync**, or it writes the wrong numbers back.

## Match screen (tab "Match sizes", `src/screens/SheinMatch.jsx`)
Search a shoe (SHEIN name, style code, seller SKU, SHEIN SKU); "Needs a match" lists SHEIN
products with a size the fix can't sell (swap, wrong size, dead SKU, blank/EUR, duplicate, or
a saved match SHEIN doesn't show yet). Open one: its SHEIN sizes beside the Shopify product
(guessed from what its sizes point at; "Find another Shopify product" to change it). Each SHEIN
size → a dropdown of **same-size** variants only (a blank/EUR/CN SHEIN size shows all sizes,
marked "check the size!") + "Stop selling (delist)". Suggestions (swap / same style + size / AI)
come pre-filled. **Save** → `shein_links` (keyed by SHEIN's SKU code; shared, live):
- `link` to SKU X ≠ what SHEIN carries → fix gives **0** + "change the seller SKU to X";
- SHEIN's export now shows X → normal rules (stock flows); a blank/EUR size a person matched
  this way counts as checked;
- `delist` → 0 + "delist this size".
A match never gives stock early: SHEIN orders carry the seller SKU and the warehouse ships it.
**Save to SHEIN** is drawn but disabled until the API is connected.

## SHEIN API (ready, waiting for keys — `api/_lib/shein.js`, `api/shein/*`)
Env `SHEIN_APP_ID`, `SHEIN_APP_SECRET` (local `.env` has empty slots + notes; also Railway),
optional `SHEIN_API_HOST`, `SHEIN_AUTH_URL`. App callback URL:
`https://stickballman12.com/api/shein/callback`. Admin → **Connect SHEIN** (page header) →
SHEIN's empower page (appid, base64 callback, one-time state) → callback with tempToken →
`/open-api/auth/get-by-token` signed with appid/secret → openKeyId + AES-encrypted secretKey
(decrypted per SDK) → stored encrypted (`app_settings.shein_auth`, BUY_GC_KEY). `sheinCall`
signs every request exactly like SHEIN's SDK (tests pin the signature + AES). `sheinBrands()`
= `/open-api/goods/query-brand-list`. Not built yet (needs SHEIN's docs behind the developer
login): write calls for seller SKU / inventory / custom size values / listing.
