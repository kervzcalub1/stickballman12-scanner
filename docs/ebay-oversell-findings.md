# eBay listings vs Shopify listings: findings (2026-11-26, EST)

Owner's rule: **Shopify is the verified stock.** Every platform's orders pass through it, so every platform's
listed quantity must never be higher than Shopify's. Overselling is the problem to remove.

Source of the numbers: production, read-only, from the eBay Sync tables (`ebay_sync_links`, `ebay_sync_log`,
`app_settings.ebay_sync`) and the Shopify copy (`shopify_listing_variants`), at the 11:25 AM EST check.

## The count

| | Shopify | eBay |
|---|---|---|
| Shoes (products / listings) | 1,007 with stock | 982 live listings |
| Sizes with stock | 2,240 | 2,236 |
| Pairs on the matched sizes | 5,606 | 5,604 |

Size by size, of the 2,236 sizes on eBay:
- 2,233 match Shopify exactly.
- 1 has more on eBay than Shopify (oversell risk); 2 have fewer (missed sales). All three were under 10 minutes
  old at the check.
- 26 sizes sit on **duplicate listings**: 6 listings carry a SKU that another live listing also carries.
- 0 eBay sizes have a SKU that is gone from Shopify.
- 56 Shopify sizes with stock (120 pairs) are not on eBay (long title, no photo, no description). Lost sales only.

## What was changed today
- eBay Sync **Stock was switched from Test to Live** at 11:20 AM EST (by Kervy, Settings + Log). Before that it was
  live only for the 22 listings our sync created. DPL is still on and writes the same number.
- Evidence it was safe: 19 days in Test, 0 sizes drifting, no failed stock write in 14 days, about 36 live
  corrections on our own listings all OK, one safe abort on Nov 17 (eBay read came back empty).
- In Test, each check found about 2 sizes where eBay was 1 pair higher than Shopify for a while (DPL lagging).

## Where eBay can still oversell (the gaps)
1. **Duplicate listings.** The same SKU on two live listings: each shows Shopify's full quantity, so 1 pair can be
   sold twice. 6 listings / 26 sizes today. Today a person ends the extra one by hand ("End the extra listing").
2. **Shopify quantity below zero.** 22 Shopify variants are negative (lowest −4). Two were linked to eBay
   (SKUs 10111615, 10109778; eBay showed 0). Not verified: that every path treats a negative as 0.
3. **eBay sizes with no Custom label.** They are never judged (`no_sku`). Not counted today.
4. **eBay SKU not in Shopify.** 0 today, but when one appears it stays sellable until a person ends it on the
   "Not in Shopify" tab. A sale there deducts nothing.
5. **No alarm.** If a live stock write fails, or eBay stays higher than Shopify, nothing tells anyone. The
   difference only shows on the Sync tab.
6. **First live run not yet observed.** No live correction on a DPL-linked listing had happened when this was written.
7. **Timing.** Shopify change → webhook → queue pass (30 s) → eBay. Not measured end to end on a real sale.

## Not eBay (context only)
Recorded warehouse cancellations in the last 14 days: Alias 30, Stadium Goods 11, Temu 6, eBay 0. eBay orders in
the last 30 days: 28, with 2 cancelled (who cancelled is not known). So eBay is a small part of the overselling;
the same guard is wanted on the other channels later.
