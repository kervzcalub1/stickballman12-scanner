# eBay Listings (PH, read-only) — `/ph/ebay-listings`

Phase 1 of the listings hub (`docs/listings-hub-plan.md`): connect the company eBay
account once, pull every live listing and size, and show it next to our stock.
**Nothing here writes to eBay.** Today **DPL** (Digital Product Labs' Shopify → eBay app)
owns eBay price, quantity and create/end, and brings eBay orders into Shopify. Until that
ownership is settled (plan doc: one owner per field), we only look.

PH team + admin can view and pull; only **admin / superadmin** can connect or disconnect
(it links the company account). Card in the PH home's Pricing & Listing section; route
`ebaylistings` in `PH_PATHS`.

## Files
| | |
|---|---|
| `api/_lib/ebay.js` | OAuth (consent URL, code → refresh token, access-token refresh), Trading `GetMyeBaySelling`, `rowsFromItem`, Inventory-API item count |
| `api/ebay/status.js` | GET: configured / connected / as whom / token expiry / last pull. Never a token. |
| `api/ebay/connect.js` | POST (admin): eBay's consent URL · `{disconnect:true}` forgets the token |
| `api/ebay/callback.js` | GET: eBay's redirect after approval → back to the page with the outcome |
| `api/ebay/pull.js` | POST: pull in the background · GET: the rows + our stock |
| `src/screens/EbayListings.jsx` | the page |
| `e2e/ebay-listings.spec.js` | XML → rows, the callback's nonce, the page (eBay mocked) |

## Setup (once)
1. developer.ebay.com → create the account → **Application Keys** → production keyset:
   App ID → `EBAY_CLIENT_ID`, Cert ID → `EBAY_CLIENT_SECRET`.
2. **User Tokens** → add an **RuName** whose *auth accepted URL* is
   `https://stickballman12.com/api/ebay/callback` → `EBAY_RUNAME`. (`EBAY_ENV=sandbox` for
   eBay's sandbox.)
3. Set the three on Railway; `BUY_GC_KEY` must already be set (the token is stored with it).
4. `db:setup` (table `ebay_listings`).
5. As superadmin: PH → eBay Listings → **Connect eBay** → sign in as the **seller
   account** → Agree. Back on the page: "Connected as …".

## How it works
- **Auth**: authorization-code grant. Scopes are read-only: `api_scope`,
  `sell.inventory.readonly`, `commerce.identity.readonly`. Writing later needs
  `sell.inventory`, and the owner approves again then.
- **The callback has no app login** (a plain redirect from eBay), so `/connect` stores a
  one-time nonce (`app_settings.ebay_oauth_state`, 15 min). The callback checks it in
  constant time, burns it, then trades the code.
- **Refresh token** (18 months) → `app_settings.ebay_auth.refresh`, encrypted
  (`secrets.js`, fails closed). The page shows when it runs out. `invalid_grant` (revoked or
  expired) → "an admin presses Connect eBay again". Access tokens (2 h) live in memory.
- **Pull**: `GetMyeBaySelling` ActiveList, 200 per page, `DetailLevel=ReturnAll`. One row
  per **variation** (size from the specific whose name contains "size"; available =
  Quantity − QuantitySold; key = the variation SKU, else its specifics), or one row for a
  single listing. Style code from the title (`styleFromTitle`, as eBay Reprice). Rows
  upserted with the pull's start time, then rows older than that are deleted: they ended
  on eBay. Runs in the background; progress lives in `app_settings.ebay_pull` (the page
  watches it live), and a pull "running" for over 15 min counts as dead.
- **Listing model**: the pull also counts the account's Inventory-API items. 0 = classic
  (Trading API) listings, so price/qty changes later go through Trading calls. Listings
  made one way can't be revised the other way (plan doc).
- **Ours**: pairs on hand (`items` not sold / shipped / missing / issue) of the same style,
  sizes compared on digits. Flags: *eBay shows N, we hold M* (oversell risk), *Listed — we
  hold none*, *We hold N, eBay shows 0*, *No style code in the title*.

## Not built (next phases, see the plan)
Price/qty updates, list, delist. Each needs the DPL decision first.
