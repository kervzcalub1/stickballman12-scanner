# eBay coupons — eBay Listings → **Coupons** tab (`/ph/ebay-listings?tab=coupons`)

Coded coupons on eBay (Marketing API `item_promotion`, type `CODED_COUPON`): a code buyers type
at checkout for **$X off each item** on the listings you pick, limited to **N uses per buyer**
(default **1** — `maxCouponRedemptionPerUser`). Built 2026-10-13. PH team + admin.

## Files
| | |
|---|---|
| `src/screens/EbayCoupons.jsx` | list (with each coupon's listings, searchable), New coupon form + listing picker, pause/resume/delete |
| `src/lib/ebayCoupons.js` | PURE: eBay's limits, `buildCoupon` (form → request), `couponTerms`, EST day → UTC |
| `api/ebay/coupons.js` | GET list (+ log) · POST create / pause / resume / delete |
| `api/_lib/ebay.js` | `listEbayCoupons`, `createEbayCoupon`, `ebayCouponAction` (Marketing REST) |
| `ebay_coupon_log` | who made / paused / deleted what, with the exact create request |

## eBay's rules (from the Marketing API spec — enforced before eBay sees the request)
- Code: 8–15 letters/digits, ≤ 2 dashes, **unique across all of eBay** (Generate = `SBM` + 8).
- $ off: only **5–10, 15, 20 … 100, 110, 120, 125, 150, 200, 250** (`AMOUNTS`). Per buyer 1–10.
- Private (code not posted; you share it) or Public (eBay shows it). Optional min. spend (eBay's
  fixed list) and total budget ($100+). Listing IDs ≤ 500 per coupon.
- Needs an image ≥ 500×500: the first picked listing's eBay photo, rewritten to `s-l1600.jpg`,
  taken from OUR pull server-side.
- Dates are EST days: start = that midnight EST (or now + 5 min if today); end = 23:59:59 EST.
- No `discountSpecification` choice in the UI: `minQuantity: 1` (or `minAmount` with a min spend).

## Permission
Needs scope `sell.marketing` (added to `SCOPES` 2026-10-13). A token approved before that
keeps working for everything else (the refresh asks only for the scopes it was approved
with; `ebayStatus().canMarket` says which); the tab asks an admin to **Connect eBay again**.

## Not built
Redemption counts / sales per coupon (`promotion_report`), editing a coupon (`PUT item_promotion`),
% off coupons.
