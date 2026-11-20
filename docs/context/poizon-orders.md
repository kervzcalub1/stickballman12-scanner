# POIZON Orders — watch the orders, print the pick list

Page: `/ph/poizon` (PH), `/poizon` (admin). Screen `src/screens/PoizonOrders.jsx`. Added 2026-11-17.
Since 2026-11-21 the page is **POIZON** with two sections: **Orders** (this file, the default) and
**Prices** (`?section=reprice`, `poizon-reprice.md`). `PoizonOrders` is the shell with the tabs.
**Read-only**: nothing here writes to Shopify or POIZON. It shows every POIZON order and where it
stands, and makes the same 4 × 6 in pick list eBay and SHEIN use (`src/lib/pickList.js`,
`PickListBar`).

## Where the orders come from
POIZON sales land in **Shopify** as orders made by the **"POIZON" app** (app id `433260920833`).
They have no `channelInformation`; the app name is the only mark. The order `name` is POIZON's own
order number (`21315226930833298`), the line title carries the style code, `variantTitle` is the size.

**Shopify cannot search orders by app** (measured 2026-11-17): `app_id:` is silently ignored and
returns every channel; `source_name:`, `channel:`, `sales_channel:` return nothing. So we keep our
own copy:

- `api/_lib/poizon-orders.js` → `runPoizonOrdersSync`: reads a LIGHT page (250: id, updatedAt, app
  name) of every order **changed since the cursor**, oldest change first, keeps the ones
  `isPoizonOrder` accepts, reads only those in full (`nodes(ids:)`), and upserts `poizon_orders`.
  - First run = the last 30 days (5,278 orders read, 39 s on the live store, 4 were POIZON).
  - After that = from 2 minutes before the cursor; normally one call.
  - At most 60 pages a run; the cursor is saved, so a long catch-up carries on next run (`more`).
  - State: `app_settings.poizon_orders_sync` `{ state, cursor, lastAt, read, found, error, by }`.
- `api/_lib/poizon-orders-worker.js`: every 10 min (`POIZON_ORDERS_MIN`), **production only** by
  default; `POIZON_ORDERS_WATCH=on|off` overrides. On a dev machine, press **Check now**.
- `GET /api/poizon/orders?from&to` → orders sold in the EST range **plus every one still to ship**
  (last 60 days). `POST /api/poizon/orders` → start a read in the background. PH + admin.

## Table
`poizon_orders` — one row per order: `shopify_order_id` (PK), `order_no`, `ordered_at`,
`cancelled_at`, `closed_at`, `fulfillment_status`, `financial_status`, `lines` JSONB
(`{ title, size, sku, qty, current, unfulfilled }`), `tracking` JSONB, `shopify_updated_at`.
A row is rewritten only when Shopify's data moved, so a re-read wakes no screen. In `LIVE_TABLES`.

## States (`poizonOrderState`)
| State | When |
|---|---|
| Cancelled / refunded | `cancelled_at` set (wins over everything: a real order was shipped, then cancelled), or every line refunded |
| Shipped | Shopify says `FULFILLED`, or no pair is left unfulfilled |
| To ship | everything else (the page opens on this filter) |

"Shipped" is **Shopify's** fulfilment state. If POIZON orders are shipped without the Shopify order
being fulfilled, they stay under To ship here.

## Pick list
One entry per pair **still to ship** (`poizonToShip` = unfulfilled, capped by what wasn't refunded);
SKU = the style code out of the title, else Shopify's SKU number; size = the variant title (`8W`).
File: `pick-list-poizon-<EST day>.pdf`.

## Tests
`e2e/poizon-orders.spec.js` — pure rules, the sync with a stand-in Shopify (own settings key), the
real SQL + roles, the page + the PDF with the browser in Manila.
