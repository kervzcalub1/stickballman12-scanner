# DPL: the Shopify ↔ eBay app (not our code)

**DPL - eBay Integration** (Digital Product Labs) is a public Shopify app. It keeps Shopify and
eBay in step: Shopify is the master for products, prices and stock, and eBay orders come back
into Shopify. Nothing in this repo calls it; we only live next to it.

Read from the Shopify admin on **2026-11-07** (view only, nothing saved). The settings and
counts are a snapshot, so re-check them in the app before relying on them.

## Where to look
Admin: `https://admin.shopify.com/store/gqmnaa-ks/apps/ebay-app-2` + the path below.

| Page | Path | Shows |
|---|---|---|
| Dashboard | (none) | eBay store, plan, sync limits |
| eBay Products | `/ebay/products` | DPL's view of eBay listings, per size |
| Shopify Products | `/shopify/products` | Shopify products; tabs Uploaded · Not Uploaded · Needs Attention (with eBay's error) |
| Orders | `/orders` | Every eBay order; tabs Synced · Not Synced |
| Linked Inventory | `/inventory` | Per SKU: stock and how many listings share it |
| Profiles | `/profiles` | Listing rules; the main profile is `/profiles/116220` |
| Settings | `/settings` | Tabs Order & Inventory · General · eBay Account · Location · Promotional Image |

**Careful in there:**
- Saving a profile updates its products automatically (the page says so).
- eBay Products rows have `Delete from Shopify`.
- Profile rows have `Remove Product From Profile`.

## How the sync is set up

### Linking
- **By SKU only** (`Automatic link products based on SKUs only` is on). Our system makes the
  SKU, and DPL copies it to eBay's Custom label (`ebay-listings.md`).
- `Automatically generate SKU` is on. The `EB-…` SKUs seen on some products are probably DPL's
  (not confirmed).
- `Sync eBay attributes to Shopify metafields` is on, for imports.

### Shopify → eBay: listings
- **Profile `STICKBALLMAN12`** holds almost everything. It is tied to the `Footwear` collection.
- **New products upload by themselves:** `Automatic Product Upload to eBay` is on for anything
  added to that collection. Counts rose by one during the check (eBay 961→962).
- **Synced changes:** Price, Title, Description, Variations, Images (all five ticked).
- **Price Settings: not configured** (Decrease, 0 %, no rounding), so no uplift: the eBay price
  is meant to equal the Shopify price.
- **Fixed listing details:**
  - Category: Men's Athletic Shoes
  - Condition: New with box
  - Color: `Multicolor`
  - Department: `Unisex Adults`
  - Brand: Shopify Vendor
  - Size: the `US Shoe Size` metafield
  - Package: 16 × 12 × 6 in
  - Location: Manheim 17545
- **Policies:** shipping "We ship within 12-48 hours once payment is completed M-F", returns
  within 14 days.
- **Ending a listing:**
  - Shopify product goes draft, archived or deleted → the listing **ends** (General Settings).
  - Product removed from `Footwear` → the listing does **not** end (that option is off).

### Stock
- Shopify is the source. Both Shopify locations count (`All locations are connected (2)`).
- `Sync inventory to shared SKUs on eBay` is on.
- A quantity typed by hand on eBay does **not** flow back to Shopify (option off).
- No fixed-inventory override, and no default value for untracked stock.
- On the two shoes checked, zero-stock sizes were missing from DPL's eBay view. Whether they
  are removed from the listing or only hidden there was not confirmed.

### eBay → Shopify: orders
- `Enable both order & inventory sync` is on.
- A Shopify order is created carrying the eBay order ID, the tags
  `Ebay,Ebay Integration & Importer,{ebay_order_id}`, the buyer email and the tax eBay collected
  (eBay marked as liable for remitting it).
- The shipping address is copied to billing.
- Failed-order emails are on and go to the Shopify store email (no other address set).

## Open problems

### 1. DPL can overwrite our eBay prices
`Sync Price Changes` is on, so a Shopify price change should overwrite the eBay price, undoing
a markup set by eBay Reprice (`ebay-reprice.md`), Reprice via API (`ebay-api-reprice.md`) or the
Cyber Sale.

**Measured 2026-11-08: it is happening.** Latest reprice per size still on eBay (1,597): 787 still hold
our price, **810 changed, every one to exactly the Shopify price**. Still unknown: which Shopify updates
trigger the push.

The fix, if it is happening, is to untick `Sync Price Changes` on the profile and keep stock and
order sync. That is the owner's call, because eBay prices would then stop following Shopify.

### 2. Orders stuck as Not Synced
21–30 orders (3 pages of 10) on 2026-11-07; the newest is from Oct 24. **Measured 2026-11-08 over 120 days:
25 eBay orders have no Shopify order, 21 of them cancelled on eBay, so 4 are real:** `12-15269-07645`,
`06-15204-51988`, `12-15184-99765`, `18-15169-44929`, all shipped.
- These never became Shopify orders, so the sale may not have reduced Shopify stock. Our own
  eBay Orders page reads eBay directly (`ebay-orders.md`), so it does not show this gap.
- The one opened (`04-15347-45187`, SKU `10089591`) offers `Link product`, which suggests its
  SKU has no Shopify match. The cause was not checked on the others.
- `04-15293-62679` (Oct 12) still shows fulfillment Not Started.

### 3. Products that can't list
- **Needs Attention: 100** (99 in the main profile, 1 in `STICKBALLMAN12 (APPAREL)`). Errors
  seen: no photo, description missing, variation required, quantity not valid for variations,
  price not valid, Color missing (apparel).
- **Not Uploaded: 6**, including Supreme x Jordan apparel with stock (27 and 31 units).

## Numbers on 2026-11-07
| | |
|---|---|
| eBay store / plan | `stickballman12` (US) / Platinum, $69.99 a month |
| Product sync limit | 7,553 of 10,000 |
| Order sync limit | 7,000 a month (5 used) |
| Shopify products | 1,232: 1,126 uploaded, 6 not uploaded, 100 needs attention |
| eBay products | 962 active, all imported |
| Profiles | `STICKBALLMAN12` 1,233 products · `(APPAREL)` 1 · `Size` 3 |
| Orders listed | 46 pages of 10 |
| App installed | March 25, 2026 |

## Our own version
eBay Sync (`ebay-sync.md`) takes over listings over time. DPL keeps orders for good (owner's call, 2026-11-08).
