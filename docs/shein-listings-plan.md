# SHEIN Listings — project plan (Shopify → SHEIN listing sync, retires 4seller)

Status: **Phases 0–5 built 2026-10-27 — back end AND page (Phase 5 = the 4seller cut-over + go-live checklists and the PH SOP article); not merged; pilots pending** — see the
Build log at the end and `docs/context/shein-listings.md`. Written 2026-10-27 by shein-project-lead from three specialist plans
(API, sync engine, dashboard) and the mockup. This file is the hand-off for every agent working on it.
Keep it current: when a phase ships, mark it here and point to its `docs/context/shein-listings.md` chunk.

Related, already LIVE (do not re-plan): stock both ways + walk-every-product fix
(`docs/context/shein-live-fix.md`), seller-SKU links / Match sizes (`docs/context/shein-fix.md`), the
SHEIN-vs-Shopify check (`docs/context/shein-check.md`). API references: `docs/shein-api-reference.md`
(stock/price/orders), `docs/shein-listing-api-reference.md` (publish, templates, custom sizes, review).

---

## 1. Summary

1. We build **SHEIN Listings**: one page that shows every Shopify shoe grouped by product → sizes, with each
   size's SHEIN status (Synced, Not on SHEIN, Out of date, In review, Blocked, Error) and, when it's stuck,
   the reason in plain words plus the button that fixes it.
2. **Sizes like US 14.5W: yes, very likely.** SHEIN's new scheme lets our app send a size SHEIN doesn't have
   as text inside the listing call. It depends on SHEIN allowing custom sizes for our store in each shoe
   category. One read-only check (Phase 0) tells us. The first real write (Phase 2 pilot, one shoe) proves it.
3. Order of work: read-only dashboard first, then add missing sizes to shoes already on SHEIN (the biggest
   gap, 179 sizes as of 10/13), then fix out-of-date listings, then publish brand-new shoes.
4. Nothing writes to SHEIN until the user has seen a dry run. Every write runs as a server job that keeps going
   if the tab closes, and every call SHEIN answers is logged with SHEIN's own message.
5. 4seller is retired once we can do all three of its listing jobs (add sizes, edit, publish new) and a
   month of new Shopify shoes has gone up through our page (Phase 5).

---

## 2. The size question, answered

**Can we add a size SHEIN doesn't have (US 14.5W, 15.5W, 3.5C …)?** Yes, if these conditions hold.

What SHEIN's docs say (and how sure we are):
- Our app was created after 2025-12-01, so it must use the **new scheme**. There is no separate "create a size"
  call: we put the text (`custom_attribute_value`, `language: "en"`) right in the listing call. **[docs]**
- SHEIN allows it **per store + category + attribute**. The same category can allow it for one store and not
  another. `get-custom-attribute-permission-config` answers `has_permission: 1` or 0. **[docs]**
- Text rules: up to 50 characters, half-width symbols only, no emoji. **[docs]**
- A custom value is **store-wide and permanent**. Once "US14.5W" exists it works in every category that allows
  custom sizes. The store can hold at most 30,000 of them. A typo stays forever, so the spelling must be
  exactly right the first time. **[docs]**
- To add a size to a shoe **already on SHEIN**, the right call is `goods/product/partialEdit` ("add a new SKU
  under an existing SKC"). `goods-specs/update` can't add SKUs and isn't allowed for shoes. A full
  `publishOrEdit` edit wipes any field we leave out, so we don't use it on existing shoes. **[docs]**
- Why 4seller couldn't: it pushed every missing Shopify size onto the NEAREST SHEIN size (4 → US7,
  15.5W → US15W). That's what an integration that can't create values does. **[inferred]**

**Still unproven (only a real call from Railway can settle these):**
1. Whether our sneaker categories allow custom sizes on the size attribute (`has_permission: 1`).
2. SHEIN's exact US spelling (`US7W`? `US 7W`?). Our custom text must copy it exactly.
3. Whether a value the user typed by hand in Seller Center last month ("US 14.5W") already exists. If it
   does, that settles the spelling.
4. Whether partialEdit accepts a new SKU on a **4seller-made** product. Permission is per store, not per app,
   so it should **[inferred]**. The live fix already uses partialEdit for seller SKUs on these products.
5. Whether our products have a size table (foot length per size). If they do, every new size needs a foot
   length that we have to supply.

**The one probe that proves it (Phase 0, read-only, ~5 calls):**
`product/query` → `spu-info` on a few of our shoes (gives `categoryId`, `productTypeId`, the size
`attributeId`, whether a size table exists) → `get-custom-attribute-permission-config` for those categories
(the size attribute's `has_permission`) → `query-attribute-template` (SHEIN's own US size list + any
`is_custom_attribute_value: true` entries) → `spu-info` on the product the user listed with US 14.5W.
If the size attribute shows `has_permission: 1`, the answer is yes for that category. The Phase 2 pilot
(one shoe, one size, dry run shown to the user first) is the end-to-end proof.

---

## 3. Phases

Sizes: **S** ≈ 1–2 days · **M** ≈ 3–5 days · **L** ≈ 1–2 weeks of agent work, including tests and review.
Every phase ends with `npm run build`, its e2e spec green in CI, a PR, a merge, and the user running prod
`db:setup` (`docs/context/deploy.md`).

### Phase 0 — Probe (read-only) · **S**
- **Goal:** settle the unproven points in §2 from our own store before building on them.
- **What the user sees:** an admin-only **"Ask SHEIN (read-only)"** button on the SHEIN check page. It shows
  one table: each shoe category we use → SHEIN's US sizes → "custom sizes allowed: yes/no" → whether the
  product has a size table → spelling of any custom size already in the store.
- **Acceptance criteria:**
  - Pressing the button on prod makes only the read calls listed in §2 and no other SHEIN call. The
    `shein_api_log` rows for that run all have read-only paths.
  - The answers are saved (`shein_listing_cache`, kind `probe`) and still show after a reload and a redeploy,
    with "asked at <time> EST".
  - For every distinct `categoryId` among our SHEIN products, the table shows the size `attribute_id` and its
    `has_permission` (0/1).
  - The table lists the exact text of every `is_custom_attribute_value: true` size value SHEIN returns
    (empty list allowed).
  - A non-admin without `connect_integrations` gets 403 from the endpoint.
- **Adds:** `shein_listing_cache` and `shein_api_log` tables (both from Phase 1's design, created now);
  `POST /api/shein/listings {action:'probe'}`; a `{ log }` hook in `api/_lib/shein.js` `sheinCall` that
  surfaces `traceId` (no change for existing callers).
- **Depends on:** SHEIN connected (it is); runs on Railway (IP whitelist). The Railway shell is down, so this
  must be a button, not a script.
- **Risk:** low. Read-only. Worst case it shows custom sizes aren't allowed, and Phase 2 shrinks to platform
  sizes plus "leave off SHEIN" (decision D2).

### Phase 1 — Read-only dashboard · **L**
- **Goal:** answer "what's on SHEIN, what isn't, and why" for every Shopify shoe, without writing to SHEIN.
- **What the user sees:** `/ph/shein-listings` (PH) and `/shein-listings` (admin). The layout is in the mockup
  (§Appendix C): a connection strip, status tiles that act as filters, Products / Sizes / Jobs tabs. Each
  product row expands into its sizes, and each stuck size shows its blocker sentence. A **Details** drawer
  lists the requirements checklist. A **Re-read Shopify + SHEIN** button runs the snapshot as a server job.
  The Sizes tab shows our size → SHEIN size per category (read and confirm only in this phase). Fix buttons
  that would write to SHEIN are shown disabled with "Coming in the next phase".
- **Acceptance criteria:**
  - Re-read starts a job row. Closing the tab mid-run doesn't stop it, and on reopening the Jobs tab shows the
    same job's progress. A server restart mid-run marks it `interrupted` with a Resume button, and Resume
    carries on from the first unfinished product.
  - After a snapshot, every ACTIVE Shopify product appears once. Each variant shows exactly one status from
    §4. The tile counts add up to the "All" count.
  - A SHEIN size whose seller SKU matches a Shopify variant SKU is shown under that variant. One matched only
    through `shein_links` shows **Out of date** (relink pending), never "Not on SHEIN".
  - A 4seller product whose SPU `supplier_code` is a borrowed size SKU (the parent-SKU trap) is NOT matched on
    that code. The fixture test proves it.
  - A SHEIN size with a seller SKU Shopify doesn't have shows as **Only on SHEIN**.
  - Changing a price on Shopify flips that variant to **Out of date** within ~1 min, without a manual
    re-read (products/update webhook). Changing only stock does NOT.
  - Searching an exact seller SKU, SHEIN SKU, SPU or style code finds the product.
  - `?status=`, `?product=`, `?tab=` survive a refresh. Ticked checkboxes don't.
  - Every time on the page reads "EST" and is right with the browser in `Asia/Manila` (e2e).
  - The SHEIN write-call count during Phase 1 is zero. The e2e fake SHEIN throws on any write path, and prod
    `shein_api_log` shows no write paths from listing jobs.
  - Nightly snapshot runs at 03:00 EST (prod only, `SHEIN_SYNC_WATCH`).
  - A 390 px phone viewport has no horizontal scroll, and product rows render as cards.
- **Adds:** tables `shein_listing_products`, `shein_listing_variants`, `shein_size_map`,
  `shein_listing_jobs`, `shein_listing_job_items` (+ `LIVE_TABLES`). Pure engine `src/lib/sheinListings.js`
  (statuses, blockers, readiness, roll-up). Worker `api/_lib/shein-listing.js` (snapshot, ticked from
  `sheinTick()`). `shopifyListingCatalogue()` in `shopify.js`. Shopify webhooks `PRODUCTS_UPDATE/CREATE/DELETE`
  (generalise `shopifyEnsureInventoryWebhook` → `shopifyEnsureWebhooks`). Endpoints `GET /api/shein/listings`
  (list / `?product=`), `POST {action:'snapshot'|'stop'|'exclude'|'include'}`,
  `GET /api/shein/listing-jobs`, `GET/POST /api/shein/listing-maps?type=size`. Screens per Appendix C.
- **Depends on:** Phase 0 (size attribute ids, spelling, permission per category feed the size map and the
  `size_not_on_shein` vs "custom allowed" verdict).
- **Risk:** medium. Shopify webhook registration touches the same webhook route as the live stock push. The
  e2e must prove an `inventory_levels/update` payload still goes to `pushSkus` unchanged. Snapshot takes ~1–6
  min of SHEIN reads and must never run during a live walk.

### Phase 2 — Add missing sizes to shoes already on SHEIN (incl. custom sizes) · **M**
- **Goal:** the highest-value fix, with the smallest blast radius. Shoes already on SHEIN get the Shopify sizes
  they're missing, using SHEIN's own size value when it exists and a custom value (US 14.5W) when it doesn't.
- **What the user sees:** on a blocked/not-on-SHEIN size, **Add 14.5W as a custom size** (Sizes tab, one
  confirm per size spelling, store-wide). Then select products → **Dry run** → a review sheet ("Will add 2
  sizes: US14.5W (custom, new), US15 (SHEIN size)", with the exact request for admins) → **Add sizes to N
  products**. Products then show **In review** until SHEIN approves, then **Synced**, and the live stock sync
  starts selling the new sizes.
- **Acceptance criteria:**
  - **Pilot first:** one product, one custom size, dry run shown to the user, then run. Afterwards
    `spu-info` shows the new size with SHEIN's value id, saved to `shein_size_map.attribute_value_id`, with
    `verified = true`.
  - A dry run writes nothing to SHEIN. Its `shein_api_log` rows are read paths only, and the fake SHEIN in
    e2e records zero write calls.
  - **Run** is refused (403) for anyone who isn't admin and doesn't hold `connect_integrations`. **Run** without
    a dry-run id is refused (400).
  - If Shopify changed a product after its dry run, Run skips that product and marks it "Shopify changed since
    the dry run — dry run again". Nothing is sent for it.
  - All of one product's missing sizes go in **one** partialEdit call (one review per product). Seller-SKU
    relinks pending for that product ride in the same call.
  - New sizes are sent at stock 0. After SHEIN approves, one stock-only `stepProduct` runs, and the size's
    SHEIN stock equals the live-fix sellable number within 5 min of approval.
  - A product whose review is open is `deferred` and retried automatically (+30 min). It is never sent while
    `query-document-state` is 1/5.
  - A SHEIN refusal shows on the size as **Error** with SHEIN's message verbatim, saved in `shein_api_log`
    with its `traceId`.
  - A custom value is never sent unless a person confirmed that spelling on the Sizes tab. Text with
    full-width characters or emoji, or longer than 50 characters, is refused by the form and by the server.
  - Killing the server while an item is `sending` doesn't send it twice. On resume the worker checks
    `check-supplierSku-repeated` + `spu-info` first.
- **Adds:** job kinds `preview` / `run` with op `add_sku`; `POST /api/shein/listings {action:'preview'|'run'|
  'retry'}`; the add-size body builder (Appendix A.2); review follow-up (poll `query-document-state` every 5 min
  + SHEIN's review webhooks routed in `api/shein/webhook.js`); `sheinLastWalkFacts()` UNION with
  `shein_listing_variants` (`match='published'`) so new sizes get stock pushes before the next walk; foot-length
  values on `shein_size_map` (if Phase 0 found size tables).
- **Depends on:** Phase 1; Phase 0 answer on custom permission; decisions D1 (spelling), D3 (who presses Run),
  D4 (price for new sizes), D6 (foot lengths, if needed).
- **Risk:** high, because this is the first SHEIN write from this project. partialEdit re-validates the
  **whole** product, so an old 4seller listing can fail on a rule SHEIN added since. Those land as **Error**
  with SHEIN's message and nothing changes on SHEIN. Custom values are permanent, so a wrong spelling is a
  dead size (mitigated by the confirm-once flow and D1). The open review blocks the live fix's seller-SKU edits
  on that product until it closes (the walk skips products with a listing item `sending`/`in_review`).

### Phase 3 — Edit / re-sync out-of-date listings · **M**
- **Goal:** turn **Out of date** into **Synced**: price, seller-SKU relinks, sizes stopped on SHEIN while
  Shopify sells them, and title/images for products **we** published.
- **What the user sees:** select Out-of-date products → Dry run → each row says what changes ("Price $159 →
  $149 on 3 sizes", "Turn US9 back on") → Run. Price rises SHEIN sends to review show **In review**.
- **Acceptance criteria:**
  - Price changes go through `product/price/save` (never publishOrEdit), and always send `specialPrice` when
    one exists (leaving it out sets it to 0 on SHEIN). After the run, `searchProduct` shows the new price, or
    the size shows **In review** (status 2) until SHEIN's price-audit webhook.
  - A size in a SHEIN promotion (`priceLockType 1`) is skipped with "In a promotion — price can't go up". It
    isn't sent.
  - A stopped size (`mallState 2`) that Shopify sells is turned back on with `mall_state 1` via partialEdit.
  - Title/image changes are sent only for products with a `synced_hash` (ours). 4seller products never get
    title/image edits from this phase.
  - An optional admin switch "auto re-sync price" is OFF by default. Nothing is sent without a dry run the user
    has seen until the user turns it on (decision D8).
- **Adds:** ops `edit`, `price`, `mall_state`; diff rendering in the drawer ("was …"); price-audit + shelf
  webhooks.
- **Depends on:** Phase 2 (job engine, review follow-up); decision D4 (the SHEIN price rule), because
  "price ≠ target" can't be judged without it.
- **Risk:** medium. Price edits can start SHEIN price reviews that lock further price changes. Shelf toggles
  need ≥20 min between changes on the same SKC.

### Phase 4 — Publish brand-new products · **L**
- **Goal:** a Shopify shoe that isn't on SHEIN at all goes up from our page: category, brand, attributes,
  images, sizes, price, stock 0 → approved → live stock sync.
- **What the user sees:** for **Not on SHEIN** products, the drawer's requirements checklist (category ·
  brand authorised · ≥ required photos · title length · every in-stock size mapped · price · seller SKUs unique
  · quotas left · no open review), each ✓ / ✕ with its fix. **Choose category** (with SHEIN's suggestion),
  **Use PH edited photos**, per-type default attributes and box size/weight. Then Dry run → **Publish N
  products**. Quota line: "Uses 2 of 160 remaining".
- **Acceptance criteria:**
  - Publish is refused per product while any checklist line is ✕. The dry run lists it as "skipped — <reason>".
  - Store gates are checked before any write: `check-publish-permission` false, publish quota 0, or shelf quota
    0 disables Publish for everyone, with SHEIN's reason shown.
  - Each published product saves `spu_name` + `version` at once (`shein_listing_products.review_version`). It
    shows **In review** even though `spu-info` returns nothing before the first approval.
  - On approval it flips to **Synced** and gets one stock-only step. On rejection it shows **Error** with
    SHEIN's `failedReason`.
  - Images are converted with `transform-pic` and cached by URL. A rejected image shows "Photo rejected:
    <SHEIN's reason>".
  - SKC `supplier_code` = `SB12-P<numeric Shopify product id>` on everything we publish, so it reverse-maps
    without guessing.
- **Adds:** tables `shein_category_map`, `shein_attr_defaults`; cache kinds `category_tree`, `attr_template`,
  `fill_standard`, `assoc_rules`, `brands`, `publish_perm`, `shelf_quota`, `pic`; op `publish`
  (`publishOrEdit`, no `spu_name`); `GET /api/shein/listing-meta?category=`; category/attribute pickers.
- **Depends on:** Phase 2/3; decisions D5 (brands), D6 (box size/weight), D7 (category mapping), D4 (price).
- **Risk:** high. Brand authorisation: listing Nike/Jordan unauthorised may get rejected or hurt the store.
  The monthly publish quota counts approved SKCs and deleting doesn't refund it. Shopify has none of SHEIN's
  required attributes (upper, sole, closure), so each product type needs a person to set defaults once.

### Phase 5 — 4seller cut-over · **S**
- **Goal:** turn 4seller off for good.
- **What the user sees:** a cut-over checklist card on the page; then 4seller cancelled.
- **Acceptance criteria:**
  - 4seller's SHEIN sync is paused (stock and listings) and its last action on SHEIN is older than 14 days
    (Seller Center operation log).
  - For 30 days: every new ACTIVE Shopify shoe reached Synced or a named blocker on our page within 2 days. A
    person can answer "why isn't X on SHEIN?" from the page alone.
  - The nightly snapshot ran every night for 30 days. No `interrupted` job is left unresolved.
  - The SHEIN check page's "sizes to add" count is ≤ the number of sizes blocked for a reason SHEIN controls
    (custom not allowed, brand, quota).
- **Adds:** nothing new in the DB; docs + SOP article for PH (`docs/context/sop.md` pattern).
- **Depends on:** Phases 2–4 live; decision D9 (all at once vs per product).
- **Risk:** low if the checklist is met. If 4seller is still running anywhere, it fights our sizes (it maps to
  the nearest size), which is why it must be paused before Phase 2's first run, not at Phase 5.

---

## 4. Status set and blocker catalogue (merged)

### 4.1 Statuses — one set, used by server and page
The specialists disagreed (sync engine: 7 incl. `shein_only` / `excluded`, no Error. Dashboard: 6 incl. Error,
plus a non-status "Off"). **Resolution:** 8 statuses plus an internal `unknown` (row exists, never snapshotted,
not shown as a tile). `review_rejected`, SHEIN pre-check refusals and API failures are **Error**, not Blocked:
Blocked = we know before sending; Error = we tried and SHEIN refused or didn't answer.

*Labels changed 2026-10-27 at the user's request (codes unchanged) — see the Build log.*

| Code | Label | Chip | Meaning |
|---|---|---|---|
| `blocked` | Blocked | red `.ebo-chip.bad` | Can't be sent until something is fixed. The row says what and has the button. |
| `error` | Error | amber `.ebo-chip.warn` | We tried; SHEIN refused, rejected in review, or didn't answer. Shows SHEIN's message. |
| `out_of_date` | Needs update | blue `.ebo-chip.info` | On SHEIN, but differs from Shopify (price, SHEIN has the wrong SKU, stopped size, our listing changed). |
| `not_on_shein` | Not on SHEIN | grey `.ebo-chip` | Ready to list. Nothing is wrong. |
| `shein_only` | Not in Shopify | amber outline | SHEIN size whose seller SKU Shopify doesn't have (live fix holds it at 0). |
| `in_review` | In review | violet `.ebo-chip.violet` (new) | Sent; SHEIN is reviewing (documentState 1/5, or price status 2). |
| `synced` | Synced | green `.ebo-chip.ok` | On SHEIN, approved; size, SKU, price match Shopify. |
| `excluded` | Not listing | grey, struck | A Shopify draft ("Not listing — draft on Shopify"), or a person pressed "Don't list on SHEIN" ("Not listing — X chose not to list it on SHEIN (date EST)"; undo = "List on SHEIN again"). Not in the tile counts; a "Not listing (n)" link. |

- **Roll-up (product = worst of its in-stock sizes):** blocked > error > out_of_date > not_on_shein >
  shein_only > in_review > synced > excluded.
- Zero-stock Shopify sizes are listed at 0 and shown greyed. They don't count toward coverage or the roll-up
  (D10).
- **Stock never makes a size Out of date.** The live sync owns stock; SHEIN stock is shown for reference.
- 4seller-made products are never diffed on title/images (no `synced_hash`, too noisy).
- URL `?status=` uses the codes above (the dashboard's short aliases `missing/stale/review/off` are dropped).

### 4.2 Blocker catalogue — ONE file
**Resolution:** the sync engine wanted `src/lib/sheinListing.js`, the dashboard wanted
`src/lib/sheinListings.js`, and the API specialist used `P-`/`E-`/`S-` codes. There is **one pure module,
`src/lib/sheinListings.js`**, imported by both the server and the page (the same way `src/lib/sheinLive.js`
is today). It holds `STATUSES`, `BLOCKERS`, the readiness engine and `rollup`. Codes are snake_case. The API
specialist's codes are mapped below. Rows store `{code, field, params}` only, and the text is rendered from
`BLOCKERS`, so wording changes never need a migration. SHEIN's raw message is kept in `params.sheinMessage`
and shown underneath ("SHEIN said: …"). SHEIN publishes no numeric error list, so we grow `BLOCKERS` from
real answers logged in `shein_api_log`.

Shape: `BLOCKERS[code] = { level: 'blocked'|'error'|'review'|'note', scope: 'store'|'product'|'variant',
applies: ['publish','edit','add_sizes','always'], title(params), fix(params), action: {kind, label, href?} }`.

| # | Code (API code) | Level | Text the user sees | Fix / button |
|---|---|---|---|---|
| 1 | `size_needs_map` (P-CUSTOM-OK) | blocked | **14.5W isn't a SHEIN size yet.** SHEIN allows custom sizes in Women's Sneakers. | `Add 14.5W as a custom size` (confirm spelling once, store-wide) |
| 2 | `size_not_on_shein` (P-SIZEMAP) | blocked | **SHEIN has no 3.5C and won't take a custom size in Toddler Shoes.** | `Leave off SHEIN` · ask SHEIN support. Never auto-pick a different number |
| 3 | `size_unreadable` | blocked | **"<size>" isn't a US size we can read.** | Fix the size on Shopify |
| 4 | `custom_text_invalid` (P-CUSTOM-TXT) | blocked | **Size name not allowed:** over 50 characters, full-width or emoji. | Fix the spelling |
| 5 | `no_seller_sku` (P-NOSKU) | blocked | **This size has no SKU on Shopify.** | `Open in Shopify ↗` |
| 6 | `dup_seller_sku` | blocked | **SKU <sku> is on 2 Shopify variants.** | Fix on Shopify |
| 7 | `seller_sku_taken` (P-DUPSKU) | blocked | **SKU <sku> is already on another SHEIN product** (<spu>). | `Show the other product` / Match sizes |
| 8 | `wrong_link` | blocked | **SHEIN <size> carries this SKU** (live-fix reason). | The live fix's relink / 0 action |
| 9 | `spu_spans_products` | blocked | **SHEIN product <spu> carries sizes of 2 Shopify products.** | Match sizes |
| 10 | `no_size_table_value` (P-SIZETABLE) | blocked | **No foot length for 14.5W** (SHEIN's size chart needs one). | Add it on the Sizes tab |
| 11 | `missing_attr` (P-ATTR, E-ATTR) | blocked | **Missing SHEIN detail: <attribute>.** | Set it once for the product type |
| 12 | `no_category` (P-NOCAT) | blocked | **No SHEIN category picked.** We suggest <x>. | `Choose category` |
| 13 | `brand_not_authorized` (P-NOBRAND) | blocked | **<brand> isn't an authorised brand on our SHEIN store.** | Admin applies in Seller Center ↗ |
| 14 | `no_image` / `image_rejected` (P-IMG) | blocked | **Only 1 photo, SHEIN needs <n>** / **Photo rejected: <reason>.** | `Use PH edited photos (n)` · `Open in Shopify ↗` |
| 15 | `title_too_long` (P-TITLE) | note→blocked if emoji | **Title is 212 characters, SHEIN allows <max>.** We'll send the shortened one. | `Review title` |
| 16 | `no_price` (P-PRICE) | blocked | **No price for size 9.** | `Open in Shopify Listings` |
| 17 | `no_weight` (P-DIM) | blocked | **No box size / weight** and no default for this type. | Set the default (D6) |
| 18 | `store_cannot_publish` / `publish_quota_used` / `shelf_quota_full` (S-PUBLISH, S-QUOTA, S-SHELF) | blocked (store) | **SHEIN won't take new listings: <reason>** / **monthly quota used** / **shelf limit reached.** | Person, in Seller Center |
| 19 | `multi_skc_size` (P-MULTISKC) | blocked | **Add this size to every colour of this SHEIN product.** | Add to all, or skip |
| 20 | `size_field_retired` (E-ATTR-DEAD) | error | **SHEIN retired this product's size field; sizes can't be added.** | Re-list as a new product (Phase 4) |
| 21 | `review_open` (E-REVIEW, E-SPECS) | review | **SHEIN is reviewing an earlier edit** (sent <time> EST). We retry after. | `Check now` |
| 22 | `review_rejected` (E-AUDIT, E-RECV) | error | **SHEIN rejected it:** "<failedReason>". | Fix, then `Send again` |
| 23 | `shein_prevalid` (E-PRE, E-MCC, E-FILTER) | error | **SHEIN pre-check: <module>: <message>.** | Depends; usually a person |
| 24 | `price_locked` / `shelf_locked` (E-PRICELOCK, E-SHELFLOCK) | note | **In a SHEIN promotion: price can't go up / can't come off shelf.** | Wait |
| 25 | `api_error` | error | **Last call failed:** <msg> (trace <id>). | `Retry` |
| — | `custom_size` (note) | note | "Will add US14.5W as a new size." Not a blocker. | — |
| — | `shopify_inactive` (P-SHOPIFY) | → `excluded` | "Draft on Shopify. Only active products are listed." | `Open in Shopify ↗` |

**Resolution, custom sizes:** the sync engine treated `has_permission: 1` as "it will publish" (a note); the
dashboard required a person to click "Add as custom size". We take the dashboard's flow, because a custom
value is permanent and store-wide. With permission = 1 but no confirmed spelling, the size is `size_needs_map`
(blocked, one-click fix). Once a person confirms the spelling, every size blocked only by it flips to Not on
SHEIN with the `custom_size` note.

---

## 5. Data model summary
All in `scripts/db-setup.mjs`: `CREATE TABLE IF NOT EXISTS` + `ADD COLUMN IF NOT EXISTS`, each CHECK defined
**once** (old-enum trap). Full columns are in Appendix B.

| Table | Phase | Purpose | `LIVE_TABLES` |
|---|---|---|---|
| `shein_listing_cache` | 0 | SHEIN template / permission / quota / probe answers (kind, key, payload, fetched_at). A stale entry beats none | no |
| `shein_api_log` | 0 | Every listing-side SHEIN call: path, request (writes: full body), response, traceId, ms, by. 90-day prune | no |
| `shein_listing_products` | 1 | One row per Shopify product: facts, SPU link, category, roll-up status + counts, product blockers, review state | yes |
| `shein_listing_variants` | 1 | One row per Shopify variant (or SHEIN-only size): match, SHEIN side, status, blockers, diffs, hashes | yes |
| `shein_size_map` | 1 | Our size key → SHEIN value id or custom text, per category; who confirmed; verified by SHEIN; foot length | yes |
| `shein_listing_jobs` | 1 | Server job row: kind (snapshot/preview/run/recheck), mode, status, lease, progress, counts | yes |
| `shein_listing_job_items` | 1 | One row per product per job: op, exact body + hash, idem key, response, version, error | yes |
| `shein_category_map` | 4 | Person-set Shopify product/type/tag/vendor → SHEIN category | yes |
| `shein_attr_defaults` | 4 | Person-set default value per product type + required attribute | no (edited on the same screen that refetches) |

Matching key: **SHEIN `supplierSku` == Shopify `variant.sku`** (trimmed, exact), then `shein_links.link_sku`.
Never the parent SKU, never the title. Stable row key = Shopify variant gid. Product ↔ SPU = the product
owning most of the SPU's matched sizes, stored. Products we publish carry SKC `supplier_code =
SB12-P<productId>`.

Integration with the live sync (the only edits to live code): the `sheinCall` log hook; `sheinLastWalkFacts()`
UNION with published variants; the walk skips an SPU with a listing item `sending`/`in_review`; the Shopify
webhook handler branches on `x-shopify-topic`. Each one is behaviour-neutral while the new tables are empty.

---

## 6. Risks and mitigations

| Risk | Mitigation |
|---|---|
| IP whitelist: no SHEIN call works from a laptop; Railway shell down | Probe and every job run on Railway behind buttons. Body shapes rehearsed on SHEIN's test host + e2e fakes |
| A custom-size typo becomes a permanent store-wide junk size | Spelling rule fixed once (D1). A person confirms each spelling once. Server-side validation. Pilot with one size first |
| partialEdit re-validates the whole product: old 4seller listings fail on new rules | Shows as **Error** with SHEIN's message; nothing changes on SHEIN. `missing_attr` lets a person fill the gap; `size_field_retired` routes to re-list |
| One open review per product: our edits collide with the live fix's seller-SKU edits | One partialEdit per product carries all sizes + relinks. The walk skips products we have in flight. Deferred retry +30 min |
| Full publishOrEdit in edit mode wipes omitted fields | Never used on existing products. partialEdit only. publishOrEdit only for brand-new |
| Double send after a crash (no idempotency key on SHEIN's side) | `idem_key` unique per product+op+body hash. A `sending` item is looked up (`check-supplierSku-repeated`, `spu-info`) before any resend |
| A size we add shows stock before a person checked it | New sizes go up at 0. Stock comes from the live sync only after approval |
| Price rises go to SHEIN review and lock price; promotions lock price/shelf | price/save only, never omit `specialPrice`, skip locked sizes with a note, follow the price-audit webhook |
| Quotas: monthly publish quota (not refunded on delete), shelf cap | Pre-flight on every dry run; quota line on the page; publish only what's in stock |
| Brand/IP: unauthorised Nike/Jordan listings rejected or penalised | `query-brand-list` gate; `brand_not_authorized` blocks; D5 |
| 4seller still running fights our sizes (nearest-size mapping) | 4seller paused before Phase 2's first run (go-live step in `shein-live-fix.md`) |
| Shopify products/update fires on stock changes → false Out of date | Hash excludes inventory; e2e proves a stock-only payload changes nothing |
| Products waiting for their FIRST review are invisible to SHEIN's query APIs | Save `spu_name` + `version` from every publish; poll `query-document-state` |
| SHEIN doc contradictions (50 vs 100 chars; size-table integer vs 2 decimals; `attribute_value_id` required vs custom text) | Use the stricter reading (50 chars, integers in mm if allowed); the pilot settles each one; record it here |

---

## 7. Decisions for the user

Each has our recommendation. Items with a sensible default are listed separately at the end and are already
taken.

1. **D1 — Custom size spelling.** SHEIN shows it to shoppers exactly as typed, store-wide, forever.
   *Recommend:* copy SHEIN's own pattern from its size list for that category. If SHEIN has `US7W`, ours is
   `US14.5W`. If the user's hand-made "US 14.5W" from Seller Center already exists, reuse it as is, and use the
   same pattern for all others. Final pick after Phase 0 shows the real values.
2. **D2 — A size SHEIN won't take** (category refuses custom sizes). *Recommend:* leave that size off SHEIN and
   show it as Blocked with the reason. Never round to the nearest size (that's 4seller's bug). Optionally
   ask SHEIN support for permission on that category.
3. **D3 — Who can press Run/Publish (write to SHEIN).** The dashboard plan said all PH; the sync plan and the
   house rule say `connect_integrations`. *Recommend:* everyone on PH can view and run **dry runs**. **Run** and
   **Retry** need admin or the existing `connect_integrations` privilege (PR #335; only a real admin grants it).
   Grant it to the 1–2 PH leads who own SHEIN.
4. **D4 — SHEIN price rule** for new sizes, new products and "price out of date". *Recommend:* the same rule as
   SHEIN Reprice: market + 15 %, rounded UP. Fall back to the Shopify price if there's no market price. New
   sizes on an existing shoe copy the price of the nearest sibling size if that's higher. Price re-sync on
   existing listings stays manual (dry run) in Phase 3.
5. **D5 — Brands.** *Recommend:* Phase 4 publishes only brands `query-brand-list` shows as authorised for our
   store. An admin applies for Nike/Jordan etc. in Seller Center. No workaround.
6. **D6 — Box size and weight** (SHEIN requires L/W/H + grams; Shopify doesn't have them). *Recommend:* one
   default per type: adult shoes 33×21×12 cm, 1,400 g; GS/kids 30×19×11 cm, 1,000 g; toddler 24×16×9 cm,
   600 g. For new sizes on existing shoes, copy the sibling size's values. If Phase 0 finds size tables, use a
   foot-length table we own (standard US → cm), checked by the user once.
7. **D7 — Shopify → SHEIN category.** *Recommend:* products already on SHEIN keep theirs (SHEIN forbids
   changing it). For new ones, map by Shopify product type + size system (men's / women's / GS / PS / TD), with
   SHEIN's image suggestion shown and a person confirming each new mapping once.
8. **D8 — Auto-sync after a Shopify change.** *Recommend:* off. Out of date is a to-do list. Revisit an
   admin-only "auto re-sync price" switch after Phase 3 has run cleanly for 2 weeks.
9. **D9 — 4seller cut-over: per product or all at once.** *Recommend:* pause 4seller's SHEIN sync **entirely**
   before Phase 2's first run (it would otherwise remap our sizes). Cancel the subscription after Phase 5's
   30-day checklist.
10. **D10 — Zero-stock Shopify sizes.** *Recommend:* add them at stock 0 (ready when stock lands), shown greyed
    and not counted toward coverage or status.
11. **D11 — Editing 4seller-made products.** *Recommend:* yes for sizes, seller SKUs, price and mall state.
    Title/images only on products we published, unless a person opts a product in.
12. **D12 — Multi-colour.** One Shopify product = one SHEIN product = one colour (SKC). That holds for 421 of
    421 SPUs today (10/13). *Recommend:* keep it. A multi-SKC product shows `multi_skc_size` and is handled by a
    person.

13. **D8a — automatic price re-sync limits (coordinator decision, 2026-10-27).** The automatic re-sync
    uses MARKET targets only (no Shopify fallback), cuts at most 15 % per size per EST day, and never
    below the Shopify price. Manual dry runs are unchanged.
14. **D4a — one target price (coordinator decision, 2026-10-27).** New sizes (Phase 2) and re-sync
    (Phase 3) use the SAME target: market + 15 % rounded up, else Shopify. The "copy a higher sibling
    price" clause of D4 is dropped (it made a new size read Needs update the moment SHEIN approved it).
15. **Tiles (coordinator decision, 2026-10-27).** A status tile / `?status=` lists every product with
    ANY in-stock size in that status; the roll-up chip still shows the worst; a tile's count = its list.

**Defaults taken (say so, no decision needed):** snapshot nightly 03:00 EST + on demand; one listing job at a
time and never during a live walk; jobs resumable with a 3-min lease; retries 1/5/30 min, max 5, business
refusals never retried; review polled every 5 min + webhooks; new sizes at stock 0; API log kept 90 days;
read-only calls log no body; raw request JSON visible to admins only; the page at `/ph/shein-listings` +
`/shein-listings`, linked from the SHEIN check page; `?status=` uses the status codes; blocker copy lives only
in `src/lib/sheinListings.js`.

---

## 8. Agent roster

| Agent | Owns |
|---|---|
| **shein-project-lead** | This plan, phase gates, decisions log, acceptance sign-off per phase, keeping §2 "unproven" up to date as answers land |
| **shein-api-specialist** | Phase 0 probe calls; every request body (Appendix A); SHEIN webhook event codes + subscription steps; growing `BLOCKERS` from real `shein_api_log` answers; settling doc contradictions |
| **shein-sync-engineer** | Tables, `src/lib/sheinListings.js` engine + unit tests, `api/_lib/shein-listing.js` worker/jobs, endpoints, Shopify webhooks, live-sync integration points |
| **shein-dashboard-engineer** | `src/screens/SheinListings*.jsx`, drawer, dry-run sheet, Sizes tab, mobile cards, URL keys, `shl-` CSS (each class has a rule) |
| **db-migration-guardian** | `scripts/db-setup.mjs` changes, `LIVE_TABLES`, CHECK-once rule, telling the user to run prod `db:setup` |
| **security-auditor** | `connect_integrations` gate on every write path (server-side 403), webhook signatures, no secrets/tokens in `shein_api_log`, raw request admin-only |
| **qa-tester** | `e2e/shein-listings.spec.js` (fake SHEIN throws on unstubbed/write paths in dry mode; kill stale :5189 first; `Asia/Manila`), each phase's acceptance list on localhost before deploy |
| **docs-maintainer** | `docs/context/shein-listings.md` chunk + CLAUDE.md context-map row when Phase 1 ships; `architecture.md` URL keys; SOP article at Phase 5 |

---

## Appendix A — API detail (from the API specialist)

### A.1 Rules that shape every write
- Use SHEIN's own value id when the size exists in the template; custom text only when it doesn't. Send one or
  the other, never both (SHEIN's example sends only `custom_attribute_value`, though its field table marks
  `attribute_value_id` required).
- A custom value's id comes back only via `spu-info` after approval (`saleAttributeList[].attributeValueId`,
  `dimensionAttributeAdditionList[].relateSaleAttributeValueId`). Keep our own copy (`shein_size_map`), because
  the template may stop listing custom values.
- partialEdit: a field left out or null keeps its value; SHEIN re-validates the whole product.
- If the product has a size table (`spu-info.dimensionAttributeInfoList` non-empty), send the **whole** table
  plus the new row.
- `spu-info` doesn't return the custom sort, so always send the full `sale_attribute_sort_list` in numeric size
  order. Check `query-publish-fill-in-standard.support_sale_attribute_sort` first.
- A new SKU needs: `sale_attribute_list`, `supplier_sku` (check `check-supplierSku-repeated` first), L/W/H cm +
  weight g (copy a sibling's `sellerSkuWeight`), `mall_state: 1`, `price_info_list` (required for a new SKU),
  `stock_info_list` (0 allowed; `supplier_warehouse_id` if >1 warehouse); an SKU image if siblings have one.
- "Every SKC must have the same number of sale attribute values": adding a size to one colour of a
  multi-colour product may require it on every colour.
- Since 2026-05-08 one sale price: send only `base_price`.
- The answer gives `success`, `version`, `skc_list[].sku_list[].sku_code`, `pre_valid_result`. Save `version`
  and read the review with `query-document-state {spuName, version}` or the webhook.

### A.2 Exact body — add "US 14.5W" to a shoe already on SHEIN
`POST /open-api/goods/product/partialEdit` (every value from a fresh `spu-info`; spelling per D1):
```json
{
  "spu_name": "<spuName>",
  "skc_list": [{
    "skc_name": "<skcName>",
    "sku_list": [{
      "sale_attribute_list": [
        { "attribute_id": <SIZE_ATTR_ID>, "custom_attribute_value": "US 14.5W", "language": "en" }
      ],
      "supplier_sku": "<Shopify variant SKU — check-supplierSku-repeated first>",
      "length": "<sibling.sellerSkuWeight.length>", "width": "<…width>", "height": "<…height>",
      "weight": <sibling.sellerSkuWeight.weight>,
      "mall_state": 1,
      "price_info_list": [
        { "base_price": <price>, "currency": "USD", "sub_site": "shein-us" }
      ],
      "stock_info_list": [
        { "inventory_num": 0, "supplier_warehouse_id": <our type-1 warehouse id, if >1 warehouse> }
      ]
    }]
  }],
  "size_attribute_list": [
    /* every existing row, copied from spu-info.dimensionAttributeInfoList (attributeId,
       additionValue, relateSaleAttributeId, relateSaleAttributeValueId) — then the new size: */
    { "attribute_id": <FOOT_LEN_ATTR_ID>, "attribute_extra_value": "<foot length for 14.5W>",
      "relate_sale_attribute_id": <SIZE_ATTR_ID>, "relate_sale_attribute_value": "US 14.5W" }
  ],
  "sale_attribute_sort_list": [{
    "attribute_id": <SIZE_ATTR_ID>,
    "in_order_attribute_value_list": [
      { "attribute_value_id": <id of US 14> }, { "custom_attribute_value": "US 14.5W" },
      { "attribute_value_id": <id of US 15> }
    ]
  }]
}
```
- Leave out `size_attribute_list` if the product has no size table.
- For a size SHEIN already has, the SKU's `sale_attribute_list` entry is `{ "attribute_id": <SIZE_ATTR_ID>,
  "attribute_value_id": <id> }` instead.
- Stock 0 here, real stock via `stock/change-inventory/v2` (live sync) after approval.

### A.3 Same thing in a brand-new product (`publishOrEdit`, no `spu_name`)
```json
"skc_list": [{
  "sale_attribute": { "attribute_id": <COLOR_ATTR_ID>, "attribute_value_id": <color id> },
  "supplier_code": "<SB12-P<productId>>",
  "image_info": { "image_info_list": [
    { "image_sort": 1, "image_type": 1, "image_url": "<SHEIN url>" },
    { "image_sort": 2, "image_type": 2, "image_url": "<SHEIN url>" },
    { "image_sort": 3, "image_type": 5, "image_url": "<SHEIN url 1:1>" } ] },
  "sku_list": [
    { "sale_attribute_list": [{ "attribute_id": <SIZE_ATTR_ID>, "attribute_value_id": <id of US 14> }],
      "supplier_sku": "<sku A>", "length": "33", "width": "21", "height": "12", "weight": 1400,
      "mall_state": 1,
      "price_info_list": [{ "base_price": 189, "currency": "USD", "sub_site": "shein-us" }],
      "stock_info_list": [{ "inventory_num": 0 }] },
    { "sale_attribute_list": [{ "attribute_id": <SIZE_ATTR_ID>, "custom_attribute_value": "US 14.5W", "language": "en" }],
      "supplier_sku": "<sku B>", "…": "same fields" }
  ]
}]
```
Plus top-level `size_attribute_list` and `sale_attribute_sort_list` as in A.2.

### A.4 What a brand-new product needs (condensed)
| Field | Where we get it |
|---|---|
| Store can publish | `check-publish-permission`; a false `reason` is a person's job |
| `category_id` + `product_type_id` | Person picks once per type (D7); `image-category-suggestion` helps; `query-category-tree` gives the type |
| `brand_code` (if `fill-in-standard` requires) | `query-brand-list`; vendor → brand map set once (D5) |
| `multi_language_name_list` / `desc_list` | Shopify title (no emoji, cut to `default_language_title_max_length`) / body stripped of HTML, ≤5,000 chars |
| `supplier_code` (unique store-wide) | `SB12-P<productId>` |
| `site_list` | `[{main_site:"shein", sub_site_list:["shein-us"]}]` (`query-site-list`) |
| Constants | `suit_flag "0"`, `source_system "OpenAPI"`, `is_spu_pic false` |
| SKC main attribute (colour) | Template colour value, person confirms; "Default" where `main_attribute_status = 1` |
| `product_attribute_list` (status 3 + linked) | `shein_attr_defaults` per type, or copied from a similar SHEIN product; re-read template weekly |
| `size_attribute_list` (type 2, status 3) | Our foot-length table |
| Images | main 1340×1785 or 1:1 900–2200 px ≤3 MB + detail ≤10 + square 1:1, via `transform-pic` (QPS 60) / `upload-pic` |
| `supplier_sku`, L/W/H/weight, `mall_state`, price, stock 0 | Shopify SKU (checked), D6 defaults, 1, D4, 0 |
| Optional per `fill-in-standard` | barcode (UPC) if `show`; others only if `required` |
| Compliance | `goods-compliance-requirements/list` after publish; likely little for shein-us sneakers, person supplies |
| Quotas | `goods-publish-quotas/detail.availableQuota` > 0; `query-shelf-quota.remain_count` > 0 |

### A.5 Read calls for the snapshot (N ≈ 420 SPUs / ~4,000 sizes)
`product/query` (50/page, ~9 calls) · `searchProduct` (10 SPU/page, QPS 20, ~42: sizes, seller SKUs, shelf per
site, price, stock, promotion locks, category) · `spu-info` (QPS 100, ~420: category, type, size table, dims,
mallState, custom value ids) · `query-document-state` (10/call, ~42) · `get-custom-attribute-permission-config`
(1) · `query-attribute-template` (1–3) · store/quota calls (4) · compliance (~3). ~560 calls, ≈1 min at 5 in
parallel, ~5 min serial. Don't use `product/full-detail` (unmaintained). `updateTimeStart/End` allows
incremental refreshes. Stock comes from the last walk's `shein_live_items`; the listing snapshot doesn't
re-read stock.

### A.6 Webhooks to subscribe (same callback URL, verified like `sheinOpenWebhook`)
`product_document_receive_status_notice`, `product_document_audit_status_notice` (doesn't fire for Seller
Center publishes), `product_shelves_notice`, `product_price_audit_status_notice`, `product_quota_change_notice`,
`product_compliance_change_notice`. Subscribing in SHEIN's console is a user step, done at Phase 2.

---

## Appendix B — Back-end detail (from the sync engineer, with resolutions applied)

### B.1 Matching
- Variant ↔ SHEIN SKU: `supplierSku == variant.sku`, then `shein_links.link_sku` (status Out of date, not "not
  on SHEIN"). Never parent SKU or title.
- Blank or shared Shopify SKU → `no_seller_sku` / `dup_seller_sku`.
- Our own publishes: written from the publish answer (`spu_name`, `sku_code`, `supplier_sku`) with
  `match='published'`.

### B.2 Columns
- **`shein_listing_variants`**: `id`, `shopify_variant_id` (UNIQUE, NULL = SHEIN-only), `shopify_product_id`,
  `seller_sku`, `shopify_size`, `size_key` ("9.5|W"), `shopify_price`, `shopify_qty`, `shopify_barcode`,
  `shopify_weight_g`, `spu`, `skc`, `shein_sku` (UNIQUE), `shein_seller_sku`, `shein_size`,
  `shein_size_value_id`, `shein_size_custom`, `shein_price`, `shein_mall_state`, `shein_shelf_status`,
  `shein_qty`, `match` (sku|link|published|none), `status` CHECK IN (`unknown`, `synced`, `not_on_shein`,
  `out_of_date`, `in_review`, `blocked`, `error`, `shein_only`, `excluded`), `blockers` JSONB, `diffs` JSONB,
  `notes` JSONB, `target_hash`, `synced_hash`, `review_state`, `last_job_item_id`, `computed_at`, `updated_at`.
  Indexes on product, spu, status, seller_sku.
- **`shein_listing_products`**: `shopify_product_id` PK, title/handle/vendor/product_type/tags/style,
  `shopify_status`, image_url/image_count/description_len, `shopify_hash`, `shopify_updated_at`, `spu`,
  `spu_count`, `spu_source`, `category_id`, `product_type_id`, `category_source`, `brand_code`,
  `attr_overrides` JSONB, `excluded` + by/at, `status`, `counts` JSONB, `blockers` JSONB, `review_state`,
  `review_version`, `review_reason`, `review_checked_at`, `synced_hash`, `last_published_at`, `last_job_id`,
  `last_snapshot_at`, `updated_at`. A table, not a view (paged by status index). The roll-up is recomputed in
  the same transaction as its variants.
- **`shein_size_map`**: `category_id` (0 = any), `attribute_id`, `size_key`, `attribute_value_id` or
  `custom_value` (CHECK one present), `shein_label`, `foot_length` (added for size tables), `source`
  (exact|person|custom_created), `verified`, `set_by`, `set_at`, UNIQUE (category, attribute, size_key). Auto
  rows only when `compareSize` is `ok`, **never nearest**.
- **`shein_category_map`** (match_kind product|product_type|tag|vendor, match_value, category_id,
  product_type_id, priority) and **`shein_attr_defaults`** (product_type_id, attribute_id, value_id /
  extra_value). Resolution order: product override → the SPU's own category (must be kept) → type → tag → vendor.
- **`shein_listing_cache`** (kind, key, payload, fetched_at). TTLs: category tree 7 d; template, perms,
  fill-standard, assoc rules, brands 24 h; publish perm, shelf quota 1 h; probe kept until re-asked.
- **`shein_listing_jobs`**: kind (snapshot|preview|run|recheck), mode (dry|run), status (queued|running|
  awaiting_confirm|done|stopped|failed|interrupted), `preview_job_id`, `scope`, started/confirmed by, lease
  owner/until, progress, counts, error, stop_requested.
- **`shein_listing_job_items`**: job, product, spu, op (add_sku|edit|price|mall_state|publish|seller_sku|
  recheck), variant ids, status (pending|sending|sent|in_review|done|skipped|deferred|changed|failed), attempts,
  next_attempt_at, `body`, `body_hash`, `idem_key` UNIQUE, response, version, trace_id, error, blockers.
- **`shein_api_log`**: at, job/item, spu, path, method, dry, request, response, http_status, code, msg, trace_id,
  ms, by. Indexes (job_id,id), (spu,at desc), (at desc).

### B.3 Readiness order (pure, `src/lib/sheinListings.js`)
1. Product excluded / Shopify not ACTIVE → `excluded`.
2. No Shopify variant → `shein_only`.
3. Always-blockers (`no_seller_sku`, `dup_seller_sku`, `wrong_link`, `spu_spans_products`) → `blocked`.
4. Last attempt refused (`review_rejected`, `shein_prevalid`, `api_error`, `size_field_retired`) and nothing
   changed since → `error`.
5. On SHEIN: review 1/5 → `in_review`; edit-blockers → `blocked`; diffs (seller SKU ≠, price ≠ target by
   > $0.50 once D4 is set, `mall_state 2` while Shopify sells, our `synced_hash` ≠ `target_hash`) →
   `out_of_date`; else `synced`.
6. Not on SHEIN: publish/add-size blockers → `blocked`; else `not_on_shein`.

Functions: `sizeKey`, `resolveCategory`, `resolveSize` (value id | custom | blocker), `targetPrice`,
`buildListingBody` (publish / add_sizes / edit), `listingHash` (excludes stock), `productReadiness`,
`variantReadiness`, `rollup`. Unit fixtures must include 14.5W (custom allowed / not), 4Y/5Y, a swap, a SHEIN-only
SKU, an in-review SPU, and a 4seller SPU with a parent-SKU `supplier_code` that must NOT match.

### B.4 Jobs (`api/_lib/shein-listing.js`, ticked from `sheinTick()`, prod-gated by `SHEIN_SYNC_WATCH`)
- Resumable claim with a 3-min lease + heartbeat; restart continues from the first unfinished item. One job at a
  time; never during a live walk (`walkActive()`).
- **Snapshot:** Shopify catalogue → SHEIN SPUs (`searchProduct` + `spu-info`, review state in batches of 10) →
  caches → match → readiness → upsert per product. Checkpoint every 10.
- **Preview (dry):** live Shopify read, fresh `spu-info`, `check-supplierSku-repeated`, rules → builds the exact
  body per item, no writes → `awaiting_confirm`.
- **Run:** needs `previewJobId`; rebuilds each body, `body_hash` ≠ preview → `changed` (skipped). Per item: review
  open → `deferred` +30 min; images (Phase 4) via `transform-pic`; `sending` + log → call → `sent` with version
  and SKU codes; refusals → `failed` with `shein_prevalid` (not retried); transport/5xx/rate limit → retry 1/5/30
  min, max 5.
- **Review follow-up:** poll `query-document-state` every 5 min + webhooks. 2 → `done`, `synced_hash`
  committed, size map verified, custom ids read back, one stock-only `stepProduct`. 3 → `error`
  (`review_rejected`). 5 → stays `in_review`.
- **Shopify recheck:** products/update|create|delete → 1.5 s coalesce → hash listing fields (no inventory) →
  differs → re-read live, rerun readiness from stored SHEIN rows (no SHEIN call). Delete → `excluded`. Never
  auto-publishes.

### B.5 Endpoints (`applySecurity` → `requireRole(['ph_team'])` (admin auto) → write actions additionally
`requirePrivilege(req, res, 'connect_integrations', …)` → `rateLimit` → `getJsonBody`)
| Method + path | Gate | Returns |
|---|---|---|
| `GET /api/shein/listings?status=&blocker=&q=&brand=&page=&pageSize=50&sort=` | PH + admin | summary (byStatus, topBlockers, lastSnapshot, store), product rows, total |
| `GET /api/shein/listings?product=<gid>` | PH + admin | product, variants with rendered blockers, last 5 job items, last 20 log rows |
| `POST /api/shein/listings {action:'snapshot'\|'stop'\|'exclude'\|'include'\|'preview'}` | PH + admin (no SHEIN writes) | `{ok, job}` / `{ok, n}`; 409 if a job runs |
| `POST /api/shein/listings {action:'probe'}` | admin or `connect_integrations` (read-only, but whole-store) | probe table |
| `POST /api/shein/listings {action:'run', previewJobId, acceptChanges?}` / `{action:'retry'}` | **admin or `connect_integrations`** | `{ok, job}` |
| `GET /api/shein/listing-jobs?id=&page=&status=&all=1` | PH + admin | job + items (all = CSV, uncapped) |
| `GET/POST /api/shein/listing-maps?type=size\|category\|attr` | PH + admin (config only, never a SHEIN write) | rows + suggestions / set, clear |
| `GET /api/shein/listing-meta?category=` | PH + admin (`refresh=1` admin) | cached template/perms/fill-standard |
| `GET /api/shein/listing-log?job=&spu=&trace=` | admin | `shein_api_log` rows |

The `?meta=1` endpoint from the sync plan is dropped: the page imports `src/lib/sheinListings.js` directly.
Filters are branched with if/else (the shim can't nest fragments). Dates are filtered in EST.

---

## Appendix C — Front-end detail (from the dashboard engineer; mockup in the planning scratchpad, re-create from this spec)

- **Routes:** `/ph/shein-listings` (`PH_PATHS.sheinlistings`, card above "SHEIN ↔ Shopify check", needs a
  `NavIcons` entry) and `/shein-listings` (admin `ROUTES`, Marketplaces card with `privKey:
  'connect_integrations'` like `shein-check` on main). SheinCheck gets a one-line link.
- **Access (resolved):** PH + admin see the page and run dry runs. Write buttons are shown **disabled with a
  title** ("Needs an admin or Connect integrations") for those without the privilege. The server refuses
  regardless.
- **Layout:** connection strip (SHEIN connected · Shopify/SHEIN read times EST · last job · Re-read) → running-job
  banner → status tiles = filters (`.shc-tiles`, products with sizes in the small line) → tabs Products · Sizes
  (n to map) · Jobs (n running).
- **Product row:** checkbox (disabled while in a job), photo, name, style code (`CopyText`), Shopify ↗ / SHEIN SPU
  ↗, roll-up chip, "8 of 11 sizes on SHEIN" + coverage bar, worst blocker one-liner, Details. Expands to the
  variant table: Size · Shopify stock · Price · SHEIN size · Seller SKU · SHEIN stock/price · Status · What to do
  (one primary fix button; More ▾ for "Leave off SHEIN" / "Copy seller SKU").
- **Drawer (`?product=`):** header; requirements checklist (the server's planner, displayed); "What SHEIN will
  receive" from the server's dry plan (per-SKU: our size → SHEIN size ✓ standard / ✚ custom, seller SKU, price,
  stock; "was …" highlights; raw JSON admin only); history; footer Dry run / Send (Send disabled until a dry run
  of the current Shopify version passed).
- **Sizes tab:** every distinct size we use, grouped Men's · Women's W · GS/Y · PS/C · TD; per category the SHEIN
  size, how (standard auto / person / custom), status; filters Needs mapping · Custom · All. **Add as custom
  size:** check permission → modal with the value prefilled by D1's rule, validated (≤50, no full-width, no
  emoji) → saved as custom "not created yet" → "on SHEIN" after the first approval. Not allowed → Blocked + Leave
  off. Pick-a-SHEIN-size is gated by `compareSize` (a different number is refused).
- **Jobs tab:** running job card (`ProgressBar`, now-on product, tiles, Stop after this product); history (#, EST
  start, by, mode, scope, counts, duration, Open → `?job=`, CSV of every row); interrupted → Resume.
- **Dry run → confirm → progress:** sticky `.batch-bar` ("3 products · 19 sizes · 1 will be skipped") → server
  dry job → review sheet (not `Modal`) with totals + per-product lines + quota use → confirm names the count and
  carries the dry-run id (409 "Shopify changed since the dry run") → the sheet becomes the job card.
- **States:** SHEIN not connected; store can't publish (red banner, dry runs still allowed); first-load
  skeleton; never snapshotted ("Check all listings"); per-filter empty text; refresh error keeps old data with
  an amber strip; SHEIN read > 30 min → amber.
- **URL keys:** `tab`, `status` (§4.1 codes), `q`, `brand`, `blocker`, `p`, `product`, `job`, `sz`. Never in the
  URL: ticks, the dry-run sheet, the custom-size draft. Add new keys to `architecture.md`.
- **Mobile < 768 px:** product/variant rows become cards; tiles 2-column; filters in one sheet; drawer full-screen
  with a sticky footer; primary actions at the bottom; 44 px tap targets.
- **Files:** `src/screens/SheinListings.jsx` (shell), `SheinListingsProducts.jsx`, `SheinListingsSizes.jsx`,
  `SheinListingsJobs.jsx`, `src/components/SheinProductDrawer.jsx`, `SheinDryRunSheet.jsx`; `src/api.js`
  wrappers; lift the duplicated `Thumb` to `common.jsx` as `RemoteThumb`. New CSS (`shl-` prefix + `.ebo-chip.violet`):
  every class must have a rule (missing-class trap).
- **E2E:** empty DB renders; tile sets `?status=` and survives refresh; `?product=` reopens the drawer; selection
  not restored; custom-size modal rejects `１４.５W` and emoji; 390 px no horizontal scroll; `Asia/Manila`.

---

## Contradictions resolved (log)
1. **Blocker catalogue file:** one pure module `src/lib/sheinListings.js` (plural), shared by server + page;
   snake_case codes; the API's P-/E-/S- codes mapped in §4.2; `?meta=1` dropped.
2. **Status set:** 8 + internal `unknown`. Added `error` (backend lacked it); kept `shein_only` (frontend lacked
   it); frontend's "Off" = `excluded`. Roll-up order in §4.1.
3. **Who publishes:** dry runs = PH + admin; Run/Retry/probe = admin or `connect_integrations` (already on main
   via PR #335, admin-level grant, read fresh from the DB). Frontend's "all PH publish" is overruled (D3).
4. **`connect_integrations`:** exists. No plan step adds it; we only call `requirePrivilege` / `hasPrivilege`.
5. **Add-size call:** partialEdit (API specialist), not publishOrEdit with `spu_name` (sync plan). publishOrEdit
   only for brand-new products. Price via `price/save`.
6. **Seller-SKU relinks vs size adds:** merged into one partialEdit per product when a listing job touches it
   (one review per product); the live walk skips products the listing job has in flight.
7. **Custom size "note vs blocker":** blocked (`size_needs_map`) until a person confirms the spelling once, then
   a note.
8. **Snapshot source:** `searchProduct` for the table + `spu-info` for category/size table/dims; stock from the
   last walk.
9. **Phase 1 scope:** the size map is in Phase 1 (read + confirm); category/attribute maps move to Phase 4, where
   they're first needed.

---

## Build log

### 2026-10-27 — Phase 0 + Phase 1, back end (shein-sync-engineer)
**Built** (context chunk: `docs/context/shein-listings.md`, which lists files, tables, endpoints and response
shapes):
- Tables `shein_listing_cache`, `shein_api_log`, `shein_listing_products`, `shein_listing_variants`,
  `shein_size_map`, `shein_listing_jobs`, `shein_listing_job_items` (Phase 2+ columns included, each CHECK
  once); the last five in `LIVE_TABLES`. Local `db:setup` run twice (idempotent).
- `src/lib/sheinListings.js` (statuses, all §4.2 blockers + 3 notes, sizes, matching, readiness, roll-up,
  hashes, the whole-store `computeListings`, the read-path allowlist).
- `sheinCall(path, body, { log })` → `shein_api_log`; existing callers unchanged (no row, same return and
  error text; a thrown error now also carries `traceId`/`sheinCode`/`sheinMsg`/`httpStatus`).
- `api/_lib/shein-listing.js`: snapshot + probe jobs (lease 3 min + heartbeat, resumable, one at a time,
  never alongside the live walk), Shopify-webhook recheck, `listingTick` (nightly 03:00 EST, 90-day log
  prune) called from `sheinTick()`.
- `shopifyListingCatalogue()`, `shopifyListingProduct()`, `shopifyEnsureWebhooks()` in `shopify.js`.
- `api/shopify/webhook.js` branches on `x-shopify-topic` (inventory path unchanged, proven in e2e).
- Endpoints `GET/POST /api/shein/listings`, `GET /api/shein/listing-jobs`, `GET/POST
  /api/shein/listing-maps?type=size`, `GET /api/shein/listing-log`.
- `e2e/shein-listings.spec.js` (22 tests): fake SHEIN on 127.0.0.1:5194 that refuses every write path;
  `playwright.config.js` points the test server's `SHEIN_API_HOST` there (the whole suite can no longer
  reach SHEIN). `docs/shein-listing-api-reference.md` gained `searchProduct` (doc 3001938, pulled today).

**Deviations from the plan, and why**
1. **Probe uses `searchProduct`**, which §2's call list doesn't name: it is the only read call that gives
   every SPU's `categoryId` in bulk (10 per call, ~42 calls). The acceptance asks for *every* category;
   `spu-info` on every SPU would be ~420 calls. `spu-info` then runs on ONE product per category. All
   calls are reads (`SHEIN_READ_PATHS`) and logged.
2. **The probe is a server job** (job kind `probe` added): ~60 calls is too long for one request.
   `POST {action:'probe'}` returns `{ok, job}`; `GET ?probe=1` returns the table (B.5 said POST returns it).
3. **`shein_listing_variants.shein_sku` is indexed, not UNIQUE** (B.2): the compute assigns each SHEIN SKU
   to one row; a DB constraint would trip when a SKU moves between products across upsert batches.
4. **Out of date without D4.** There is no SHEIN price rule yet, so SHEIN's price is NOT compared with
   Shopify's (4seller's prices differ everywhere; it would flag everything). Instead the first snapshot
   that sees a size on SHEIN accepts Shopify's then-values as the baseline (`synced_hash`,
   `synced_fields`); a later Shopify change of price / compare-at / size / SKU / barcode → Out of date with
   the "was → now" diff. This satisfies "a price change flips it within ~1 min, stock doesn't". When D4
   lands, add "SHEIN price ≠ target by > $0.50".
5. **Listing hash** = title, vendor, type, tags, status + per variant sku/size/price/compare-at/barcode.
   Photos, weight and description are left out (a REST webhook payload and the GraphQL read describe them
   differently; they only matter for products we publish, Phase 4). `description_len` and box weight are
   not read yet.
6. **Size keys:** `n|M` adult, `n|W`, `n|Y`, `n|C` (e.g. `10|M`, `9.5|W`). Auto-mapping takes only an exact
   `compareSize` 'ok'; a person may map 'ok_suffix'/'check_group' (e.g. our 9W → SHEIN "US9" in a women's
   category); a different number is refused by the server.
7. **D1 suggestion order:** an existing store custom value for that size as is → the store's own custom
   pattern (e.g. "US 9.5W" ⇒ "US 14.5W") → SHEIN's standard pattern for the category ("US7W" ⇒ "US14.5W").
8. **Publish-only blockers are not evaluated in Phase 1** (`no_category`, brand, photos, title, weight,
   quotas — Phase 4 has the category map). A brand-new product is **Not on SHEIN** with the note
   `size_unchecked {reason:'no_category'}`. Notes added to `BLOCKERS`: `size_unchecked`, `dup_on_shein`,
   `excluded_by_person`.
9. **SHEIN-only shoes** (no size matches any Shopify variant) get a product row keyed `shein:<spu>`.
10. `spu_spans_products` is an always-blocker as planned. 4seller may have put GS + adult sizes in one SPU
    where Shopify has two products — check its count after the first prod snapshot; demote to a note if noisy.
11. `size_field_retired` (template size attribute status 1) makes a size-to-add **Error**;
    `multi_skc_size` blocks sizes-to-add on multi-colour SPUs already in Phase 1.
12. **Webhook registration:** `shopifyEnsureInventoryWebhook` is untouched (the live push's switch still
    uses it); the new `shopifyEnsureWebhooks(uri, topics)` registers PRODUCTS_CREATE/UPDATE/DELETE through an
    admin action `POST {action:'webhooks'}` (not automatically). Recheck queue is in memory (a restart drops a
    pending recheck; the nightly catches it); nothing is rechecked before the first finished snapshot.
13. **Snapshot items are per SHEIN SPU** (the slow I/O); the match/readiness pass at the end is one
    idempotent pass, so "Resume from the first unfinished product" = the first unread SPU. The runner
    re-checks its lease after every SHEIN product, so a process that lost its lease writes nothing more.
14. **Gate order:** the privilege is resolved (fresh from the DB) before `rateLimit` and enforced once the
    body says which action (the action lives in the body).
15. In dev no worker tick runs (`SHEIN_SYNC_WATCH`): an on-demand job runs in the process that created it,
    and every GET marks expired leases `interrupted`.

**Results:** `npm run build` ✓. e2e: `shein-listings` 22/22 (also with the host clock in Asia/Manila);
with `shein-live`, `shein-check`, `shein-fix`, `shopify-listings`, `admin-privileges`, `live-updates`: 87/87.

**Open items**
- ~~The page (Appendix C)~~ — built, see the next entry.
- Prod: the user runs `db:setup` after merge; an admin presses `webhooks`, then **Ask SHEIN**, then
  **Re-read**. Then fill §2 "Still unproven" 1–3 and 5 from the probe answer, and pick D1's spelling.
- D4 (price rule) → the price comparison in `variantReadiness`.
- Phase 2: `preview`/`run` jobs, `sheinLastWalkFacts()` UNION, the walk skipping in-flight SPUs.


### 2026-10-27 — Phase 0 + Phase 1, the page (shein-dashboard-engineer)
**Built** (page section in `docs/context/shein-listings.md`):
- Routes `/ph/shein-listings` (`PH_PATHS.sheinlistings`, PH card above "SHEIN ↔ Shopify check",
  `NavIcons['shein-listings']`) and `/shein-listings` (admin `ROUTES`, Marketplaces card); a one-line
  link on the SHEIN check page.
- `src/screens/SheinListings.jsx` (shell), `SheinListingsProducts.jsx`, `SheinListingsSizes.jsx`
  (incl. the Phase 0 `ProbePanel`), `SheinListingsJobs.jsx`, `src/components/SheinProductDrawer.jsx`,
  `src/components/SheinListingsBits.jsx` (chip, blocker, fix button, `CustomSizeModal`, EST `when`);
  `RemoteThumb` added to `common.jsx`; `src/api.js` wrappers; CSS `shl-*` + `.ebo-chip.violet`
  (class audit: every class used has a rule).
- Connection strip, running-job / interrupted banners (Stop, Resume), tiles = `?status=` filters,
  Products / Sizes / Jobs tabs, search / brand / reason filters, paging, product → size rows with
  status chip + rendered blocker + its button, the drawer (`?product=`), the Sizes tab's custom-size
  form (DB only, validated like the server), Jobs (`?job=`, CSV). Every SHEIN-writing button is
  disabled with "Coming in the next phase". `useLive` on the five live tables; EST everywhere.
- e2e: 9 page tests added to `e2e/shein-listings.spec.js` (31 total: 30 run + 1 screenshot helper
  gated on `SHL_SHOTS`), all green; the 22 API tests unchanged and green.

**Deviations**
1. **Admin Marketplaces card has no `privKey`** (Appendix C said `connect_integrations` like
   shein-check): the endpoints are `requireRole(['ph_team'])` (admin auto), so a non-admin holder
   of the privilege (e.g. warehouse) would land on a page of 403s. The admin route is gated to
   admin/superadmin.
2. **The probe panel lives on the Sizes tab** (not the SHEIN check page, §3 Phase 0): it is about
   categories and sizes, and the Sizes tab is reachable before the first snapshot.
3. **No dry-run sheet** (`SheinDryRunSheet.jsx`) — Phase 2. The selection bar's "Dry run" and the
   drawer's Dry run / Send are disabled; the bar's live action is "Leave off SHEIN" (DB only).
4. **Requirements checklist is derived on the page** from the server's stored blockers, grouped
   by code (shopify, seller SKUs, links, sizes, price, SHEIN refusals) + review + category — there
   is no separate server planner in Phase 1. Publish-only checks (brand, photos, title, box) show
   as "checked when publishing (a later phase)".
5. **No SHEIN product link** (only the SPU, copyable): we have no reliable shopper/Seller Center URL.
   The raw request JSON (admin) comes with the dry run.
6. `?sz=` = the Sizes tab filter (needs mapping default · custom · all); "Fix the spelling" / "Add
   foot length" open the same custom-size form in place.
7. "SHEIN read > 30 min → amber" is applied to the "Last read" time only (with nightly snapshots a
   whole amber strip would be permanent).

**Screenshots** (1320 px + 390 px, seeded fixtures): reviewed against the mockup; fixed the tiles
wrapping, a contradicting "developer app" notice when connected, "—More" placement, SHEIN-only
rows' stock line, null SHEIN stock shown as 0, the Sizes tables' order / column widths.

**Open items**
- Phase 2 UI: the dry-run sheet, Run (admin / `connect_integrations`), retry, review follow-up.
- SHEIN category names (the page shows ids; the probe's sample product name helps).
- `shein_listing_cache` isn't live: the probe panel re-reads on job-table changes (fine: the probe
  is a job).

### 2026-10-27 — Phase 2 (add missing sizes), back end (shein-sync-engineer)
**Built** (context chunk: `docs/context/shein-listings.md` → "Phase 2", with every response shape):
- Pure engine (`src/lib/sheinListings.js`): `planAddSizes` (the Appendix A.2 body + a plan a person
  reads), `summarizePlan`, `sheinNewSizePrice` (D4), `footLengthValue`, `reviewVerdict`; readiness shows
  sizes in a run item as **In review** (`inflight`), keeps `match 'published'`; blockers
  `size_already_on_shein`, `custom_unconfirmed`, `not_on_shein_product`, `nothing_to_add`,
  `shopify_changed`, `already_sent`.
- Jobs (`api/_lib/shein-listing.js`): `preview` (dry, reads only → `awaiting_confirm`) and `run`
  (from the dry run, one statement; rebuild + hash compare → `changed`; review open → `deferred` +30
  min; `sending` + UNIQUE `idem_key` → ONE `partialEdit` per product → `in_review`; refusal → `failed`
  `shein_prevalid` verbatim; no answer → 1/5/30 min, max 5; possibly-sent → looked up with
  `check-supplierSku-repeated` + `spu-info` + doc state before any resend). Review follow-up from the
  tick (poll every 5 min) + SHEIN's audit / receive webhooks (`api/shein/webhook.js`): approved → done,
  published, size map verified (custom id read back), one stock-only step; rejected → `review_rejected`.
- SHEIN client: logged `check-supplierSku-repeated`, `query-publish-fill-in-standard`,
  `msc/warehouse/list`, `partialEdit`; `sheinDocStates` takes `{spuName, version}`.
- Live sync: `sheinLastWalkFacts()` + published sizes; `pushSpus`; the walk's in-flight rule.
- Endpoints: `POST /api/shein/listings {preview | run | retry}`; job items carry `summary` + `plan`,
  `body`/`response` admin-only (also on `?product=`).
- Columns on `shein_listing_job_items`: `plan`, `retries`, `sent_at`, `sku_codes`, `document_state`,
  `review_checked_at` (+ an index). Local `db:setup` run. `docs/shein-listing-api-reference.md` gained
  partialEdit (doc 3002047, pulled today) and the two product review webhooks (3001450, 3000910).
- e2e (`e2e/shein-listings.spec.js`, +15 → 45): the fake SHEIN now has a STATEFUL partialEdit,
  document state, seller-SKU check, fill-in-standard and warehouses; a test per §3 Phase 2 line (dry
  run = zero writes; Run 403 / 400; changed-since-dry-run skipped; one call per product incl. the
  relink; stock 0 → approval → one stock step + published + map verified; review open → deferred, and
  retried by itself; refusal → Error with SHEIN's words + traceId, never retried; custom value never
  sent unconfirmed; bad spelling refused; the server dying mid-send → no second send; 503 → retried,
  looked up first, sent once; the webhook path, signed).

**Deviations from the plan, and why**
1. **No `sellerSkuWeight`**: spu-info carries `length/width/height/weight` on each SKU. We copy them
   from the nearest sibling size that has all four (none → `no_weight`).
2. **D4's market price = the Alias price the app already holds** (`platform_quotes`, ≤ 12 h,
   consigned first — the same hierarchy SHEIN Reprice asks for), matched by size. The job makes no
   outbound Alias call; a size nobody priced in the last 12 h uses the Shopify price (then the
   sibling's, if higher). Same rounding (integer, always UP).
3. **The walk and in-flight products:** it SKIPS an SPU only while its item is `sending`; while SHEIN
   reviews it, a full walk runs it as stock-only (no seller-SKU edit). Skipping stock for the whole
   review (hours–days) would let a Shopify sale oversell on SHEIN. The push path is unchanged.
4. **The approval's stock step obeys the "Shopify → SHEIN" switch** (and waits out a walk), like every
   push: with push off it records `stock_step: {why: 'push is off'}`. "Within 5 min of approval" holds
   with push ON and the poll (5 min) or the webhook (seconds).
5. **The product's `synced_hash` is not set** by an approval — Phase 3 reads it as "we published this
   product" (title/image edits). Only the variants' `synced_hash` is committed.
6. **`sent` is not a resting status**: `sending` → `in_review` in one write (version + SKU codes).
7. **A run ends `done` while items wait** (`deferred`: review open, no retry count; or no answer,
   retries counted); the tick re-queues it when one is due, and resumes a run a restart cut off — a
   person confirmed it, and the look-before-resend makes that safe. In dev nothing ticks: call
   `listingFollowUp`.
8. **Relinks ride only with a size to add**; a product with only relinks is "nothing to add" (the
   live fix keeps doing those).
9. **What gets added** = the stored readiness's Not on SHEIN sizes (plus Error sizes from our last
   try, so a fixed listing can go again), re-checked against fresh reads; zero-stock sizes too (D10).
10. **Warehouse:** SHEIN wants `supplier_warehouse_id` (int64) when there are > 1 warehouses, but
    `msc/warehouse/list` returns only a code + name — we send `supplier_warehouse_name` then (unproven).
11. **Foot length unit** follows the product's own chart (mm if a sibling value ≥ 100, else cm as
    typed); SHEIN's field says "positive integer" — the pilot settles it.
12. **Sort list** only when `support_sale_attribute_sort === true` AND every existing size has a value
    id (else left out — SHEIN keeps its order).
13. **`idem_key` is set at the send claim** (dry-run items have none). Re-sending a body SHEIN refused
    is refused too ("fix the listing, then dry run again").
14. Preview by `filter` takes products with an SPU (≤ 300); `retry` only re-tries "no answer"
    failures and waiting items.

**Results:** `npm run build` ✓. e2e: `shein-listings` 45/45 (also with the host clock in
Asia/Manila); with `shein-live`, `shein-check`, `shein-fix`, `live-updates`, `admin-privileges`:
105 passed, 1 skipped (the screenshot helper) — `shein-live` unchanged and green (behaviour-neutral).

**Open items**
- Phase 2 page: the dry-run sheet (per product `summary` + `plan`, raw `body` for admins), Run (with
  the dry-run id; 409 on a used one), Retry, In review / Error rows (shapes in the context chunk).
- Prod: `db:setup`; subscribe `product_document_audit_status_notice` +
  `product_document_receive_status_notice` in SHEIN's console; 4seller paused (D9); the **pilot**
  (one product, one custom size, dry run shown to the user, then Run) — it settles §2 points 2 and 4,
  the warehouse field (10) and the foot-length unit (11).
- Market-price coverage depends on `platform_quotes` being fresh; a server-side Alias lookup for the
  dry run is the follow-up if too many sizes fall back to the Shopify price.

### 2026-10-27 — wording changed at the user's request (shein-dashboard-engineer)
Only what a person reads; every status **code** is unchanged (`out_of_date`, `shein_only`, `excluded`, …).
- Status labels: Out of date → **Needs update** · Only on SHEIN → **Not in Shopify** · Off → **Not listing**
  (Synced, In review, Blocked unchanged). The §4.1 table above carries the new labels.
- Buttons: Leave off SHEIN → **Don't list on SHEIN**; List it again → **List on SHEIN again**. The
  "Off (n)" link → "Not listing (n) — Shopify drafts, or marked "Don't list on SHEIN"".
- Notes: a person's exclusion reads "Not listing — X chose not to list it on SHEIN (MM/DD/YY EST)"
  (`excluded_by_person` now carries `at` = `excluded_at`); a draft reads "Not listing — draft on Shopify".
- `size_not_on_shein` (SHEIN refuses the size) now says **"This size can't be listed on SHEIN: …"** —
  SHEIN's rule, not our choice; its button is "Don't list on SHEIN" (hides it from the counts).
- Relinks: "Seller SKU OLD10 → A10 (relink pending)" → **"SHEIN has the wrong SKU: OLD10 → will change
  to A10"**; other user-facing "relink" → "change the SKU" (`summarizePlan`: "change 1 SKU SHEIN has
  wrong: OLD10 → A10").
- "Standard" size → **"SHEIN size"**, contrasted with "Custom size".
- Kept on purpose: internal identifiers (`plan.relinks`, `leave_off` action kind, the `fill-in-standard`
  API path); the SHEIN fix / live panels on the SHEIN check page (not SHEIN Listings) keep their own
  words ("seller SKUs to change", the live-sync "Off" switch).

### 2026-10-27 — Phase 2 (add missing sizes), the page (shein-dashboard-engineer)
**Built** (page section in `docs/context/shein-listings.md` → "Phase 2 — the page"):
- `src/components/SheinDryRunSheet.jsx`: `DryRunSheet` (the overlay — not `Modal`; full-screen under
  768 px, sticky footer) + `DryRunView` (its content, also inline on the Jobs tab's `?job=`). A dry run
  while it runs: progress + "closing this doesn't stop it". Then the **review**: totals from the job's
  `counts` (products checked / to send, sizes, custom sizes · new to SHEIN, SKUs SHEIN has wrong,
  skipped products · sizes not sent, waiting for a review) + the proof line **"0 SHEIN writes — this
  dry run only read (n SHEIN reads)"** (red if it were ever > 0); one line per product = the server's
  `summary`, expandable to the plan (our size → ✓ SHEIN size / ✚ custom size (new), seller SKU, price +
  where it came from (`PRICE_FROM`), stock 0; SKUs SHEIN has wrong; skipped sizes with the rendered
  blocker); the exact request + SHEIN's answer for admins only (the server strips `body`/`response` for
  others). Confirm **"Add sizes to N products"** (N = `counts.sendable`, carries `previewJobId`) —
  disabled with "Needs an admin or the Connect integrations privilege" for everyone else.
- After Confirm the sheet switches to the **run** job (the job card): item chips, per-product status
  (`ITEM_STATUSES` in `src/lib/sheinListings.js`: Waiting to send · Sending · In review · Done · Waiting
  · Not sent · Skipped · Error), SHEIN's words verbatim ("SHEIN said: …" + trace), **Retry** / **Try now**
  for no-answer failures and waiting items (admin / priv; `itemRetryable` = the server's rule),
  **Dry run again** for "Shopify changed since the dry run" and SHEIN refusals, Stop, Retry all.
- Selection bar "Dry run N products" and the drawer's "Dry run this product" are live (PH ok); the
  drawer's disabled "Send to SHEIN" is gone (Send lives on the sheet). Products in a running dry run /
  send: tick disabled + "In job #n" chip; a product with some sizes in review shows a violet "n in
  review" chip next to its roll-up. Drawer history = the product's job items (Dry run / Send #, status
  chip, summary, SHEIN's words, Open → the sheet). Jobs tab: preview / run results, "Review →" on a dry
  run waiting for a person, `?job=` of a preview/run renders the same view inline.
- Copy: item statuses, price sources, the no-answer sentence live in `src/lib/sheinListings.js`
  (`ITEM_STATUSES`, `itemStatus`, `PRICE_FROM`, `ITEM_NO_ANSWER`, `itemRetryable`); screen labels in the screens.
- e2e (`e2e/shein-listings.spec.js`, +4): PH dry run → sheet with counts + "0 SHEIN writes", the plan,
  Confirm disabled, no raw request, Jobs tab "Waiting for you"; admin confirms → In review / Not sent
  (Shopify changed, Dry run again) / Waiting → fake approval → Done live, drawer history; SHEIN refusal
  verbatim + Dry run again, no-answer → Retry (request carries the item id), the Jobs tab inline view;
  390 px no horizontal scroll on the sheet (review + job card), PH Retry disabled. The browser's POST
  preview / run / retry are answered by the test process (`page.route`) running the job in-process with
  the fake SHEIN + fake Shopify, so no test-server job can reach a real API. Two Phase 1 assertions
  updated (Dry run is now enabled; the drawer has no Send button).

**Deviations**
1. No "Send" in the drawer (Appendix C: "Send disabled until a dry run passed"): Send exists only on
   the dry run's sheet, which always names the dry run it sends.
2. "In job" for ticks is read from the active job's items on the page (no new server field).
3. The sheet is in memory only (never in the URL, per Appendix C); the way back to a dry run you
   closed is Jobs → "Review →", or the drawer's history → Open.
4. The drawer / sheet footers keep 84 px clear on the right: the app-wide advisor button sat on top
   of the last footer button (found in the screenshots).
5. Quota use (Appendix C) isn't shown: partialEdit of an existing product uses no publish quota.

**Results:** `npm run build` ✓; `shein-listings` spec all green (incl. the screenshot helper).
Screenshots `scratchpad/shots/shein-listings-{desktop,phone}-dryrun*.png` reviewed; fixed the phone
plan cells splitting into a grid per fragment, "SHEIN said" on a no-answer failure, the waiting item's
error in red, the advisor button covering Close, a run that waits on SHEIN reading "Done".

### 2026-10-27 — Phase 2 back end: the API review's fixes (shein-sync-engineer)
Review: `scratchpad/plan/phase2-review.md` (shein-api-specialist). The dashboard agent's wording change
in `src/lib/sheinListings.js` + the screens was kept as is; only codes / logic were touched.
**Must-fix, all done:**
- **M1** custom value only with `has_permission === 1` for THIS category + the template's size attribute
  (`resolveSize` + `planAddSizes`); `listing-maps` refuses category/attribute 0 and categories without
  permission (400), as does the page's form.
- **M2** size attribute = the template's SKU-level size attribute (`templateSizes` no longer trusts
  spu-info's first attribute); every SKU must carry exactly that one → else `size_field_unclear`.
- **M3** `validateCustomText`: printable ASCII, single spaces, ≤ 50; `EMOJI`/`FULL_WIDTH` rewritten with
  escapes; `customTextConflict` refuses case/spacing look-alikes of a store value and SHEIN's own sizes —
  server (`listing-maps`, `planAddSizes`) and `CustomSizeModal`.
- **M4** products with a size chart → `size_table_not_yet` (product blocked, also in the readiness); the
  chart-copying code is gone, so no ""/null row can be sent.
- **M5** `skc_title` (+ `skc_multi_language_name_list`) re-sent from spu-info when fill-in-standard shows
  it; required-but-empty, or `reference_product_link` shown with relinks / required → `skc_field_uncopyable`.
- **M6** write answers must carry `code` (`sheinCall {strict}`); sent = `success === true` + version
  (`readSendAnswer`); success without a version → looked up later; success with warnings / filtered_result
  → notes, not a refusal; poll + webhook only accept the item's own version; a no-version rejection is
  left to the poll.
- **M7** a refusal releases `idem_key`; IP-whitelist / signature / auth / 401 / 403 STOP the job
  (`isFatal`, message names Railway, item left `sending`, nothing marked refused); "system busy" is
  retried as no-answer (per the review; the job does not stop on busy).
**Should-fix done:** S1 `supplier_warehouse_id` = US default warehouseCode (always when known); S2 first
retry after 5 min (5/15/30), a new document version since the dry run counts as "arrived", 90 s write
timeout; S3 size already on the product by text; S4 coded refusals keep `info.pre_valid_result`'s text;
S5 only our new SKU codes; S6 `filtered_result` (and warnings) kept as `shein_note`; S8 `acceptChanges`
only for price-only differences; S9 `-1` → `shein_prevalid` "SHEIN didn't receive it". S7 is moot
(size charts blocked). **Not done:** S10 (show the before/after size order in the plan).
**Fake SHEIN** now validates the body like doc 3002047 (coded refusals), lists every SKU in the answer,
honours `version` on query-document-state, can lag the seller-SKU check, and plays whitelist / busy /
no-version / warnings answers; the webhook test posts multipart. **+12 tests** (6 pure, 5 end to end,
1 form case). **Results:** `npm run build` ✓; `shein-listings` + `shein-live` + `shein-check`: 104
passed, 1 skipped (screenshot helper); `shein-listings` with the host in Asia/Manila 61/61.
**Pilot pick (from the review):** 1 SKC, one sale attribute, no size chart, empty SKC title, no pending
relinks, `has_permission 1`, one confirmed custom size.

### 2026-10-27 — Phase 2: the re-review fixes N1–N4 (shein-sync-engineer)
- **N2** a job stopped by a whitelist / signature / 403 answer sets its item back to `deferred` (key kept →
  looked up before any resend on Resume), guarded by the lease (a dead process writes nothing; a real
  crash still leaves `sending`). The walk **never skips stock** for a product with a listing item in
  any state — it only drops seller-SKU edits (`walkModeFor`: full → stock).
- **N3** `fatal()` no longer matches a bare "IP": only whitelist wording (`white list`, `白名单`, "IP … not
  allowed / forbidden / denied"), signature / auth, 401/403 — an `ip_character_list` refusal is an Error.
- **N4** `listingInflight` counts `deferred` items holding an idem key (in flight: walk stock-only, sizes
  In review); the poll / webhooks only act on `sent`/`in_review`. "Approved, but the new sizes don't
  show" waits at most 24 h (`approved_seen_at`) → Error with a clear message.
- **N1** fill-in-standard unread → product blocked (`skc_field_uncopyable {why:'fill_unread'}`).
- Tests: N1/N2 pure, N2 (whitelist → deferred + in flight), N3 cases, N4 (24 h) end to end.

### 2026-10-27 — Phase 3 (Needs update → Synced), back end (shein-sync-engineer)
**Built** (context chunk → "Phase 3", with the shapes for the page): D4 price comparison in the
readiness (`shein_price` diff, > $0.50; `io.marketTargets`); `planPrice` / `planEdit` / summaries;
preview `ops` (`price`, `edit`); price/save write (`sheinPriceSaveLogged`) and its answer per size;
look-before-resend per op; price review via `product_price_audit_status_notice` + spu-info poll; edits
via doc state; `markVariantsSynced`; D8 switch + `autoPriceTick` (dry run first, then run); endpoint
`preview {ops}` / `auto_price {on}`; webhook routing (`isPriceAuditEvent` before the document events).
The price-audit webhook doc (3000912) is in `docs/shein-listing-api-reference.md`.
**Deviations / decisions**
1. **D4 target for an existing size = market + 15 % (up) else Shopify — no sibling rule.** A new size
   added at a higher sibling price (Phase 2's D4 clause) will then show Needs update (lower). Open: should
   the sibling rule also hold for re-sync? Ask the user.
2. Compared against SHEIN's ORIGINAL price (`basePrice`); a live special price is kept and sent as is.
   A special ≥ the new price blocks that size (SHEIN needs original > special).
3. `riseReason: '4'` (other) on every rise — unproven which reason SHEIN wants (enum API
   `query-change-price-reason` exists; not called).
4. A promotion lock skips only RISES; cuts still go (the doc's lock is about raising).
5. Price review has no query API: approval = SHEIN's webhook or spu-info showing the new original price;
   7 days without either → Error.
6. Title edits only for products with `products.synced_hash` — none exist until Phase 4 publishes, so in
   practice Phase 3 sends prices, sizes back on and relinks. Photos are not edited in this phase.
7. Fixture SHEIN prices now equal the Shopify prices (D4 would otherwise flag every fixture size); the
   Phase 1/2 tests were updated accordingly (sibling-price test uses a cheaper Shopify size).
**Results:** `npm run build` ✓; `shein-listings` + `shein-live` + `shein-check`: 118 passed, 1 skipped;
`shein-listings` in Asia/Manila 75/75.
**Open items:** the Phase 3 page; subscribe the price-audit webhook; decision on deviation 1; images
(Phase 4 with publishing); S10 (sort order shown).

### 2026-10-27 — Phase 3 (Needs update → Synced), the page (shein-dashboard-engineer)
**Built** (page section in `docs/context/shein-listings.md` → "Phase 3 — the page"): the diffs in a size's
"What to do" ("SHEIN $160 → $149 · market + 15 %…", ↑ rise "SHEIN may review it", "Turned off on SHEIN —
will turn back on", "SHEIN has the wrong SKU: A → will change to B") + **Dry run the update**; the two dry
runs named apart on the selection bar and the drawer — **Add missing sizes** vs **Update prices & sizes**
(ops price + edit); the sheet renders price plans (SHEIN now → will be, rise / cut, price source, special
kept, SHEIN's answer per size after the send: Approved / In review / Refused) and edit plans (turned back
on, SKUs, title), update totals, Confirm **"Update N products"**; the drawer's "was …" highlights; the
**Auto re-sync price** switch (admin / priv, confirm dialog; others read-only); Jobs labels.
**Deviations / found**
1. **Needs update hides inside Blocked products.** A product shows its worst status, and every fixture shoe
   with a price diff was also Blocked → the Needs update tile read "0 · 5 sizes" with an empty list. Added
   a side chip "n need an update" on the roll-up and an empty state that explains it + Show all. Worth a
   server decision: should `?status=out_of_date` also return products with ANY out-of-date size?
2. The selection bar's "Dry run N products" became "Add missing sizes" (+ "Update prices & sizes"); three
   Phase 1/2 test selectors updated, and the tile test now reads only the roll-up chip (side chips exist).
3. An update dry run is one item per product per op; the sheet keeps one card per item (op tag, sorted by
   product) instead of merging them, because the two ops get separate statuses once sent.
4. Summaries with only skipped sizes lead "Nothing to send" (was "Nothing to change on SHEIN…", which
   contradicted the skipped list) — `summarizePlan`, wording only.
5. Fixed on the way: the product row printed a stray "0" (`inJob && …` with inJob = 0) since Phase 2.
**Results:** `npm run build` ✓; `shein-listings` + `shein-live` + `shein-check` with the host in Asia/Manila:
122 passed, 1 skipped (screenshot helper). Screenshots `scratchpad/shots/shein-listings-{desktop,phone}-update-*.png`
reviewed; fixed the stray 0, double brackets in the price reason, the confirm dialog clipped by the card
(portalled), a mono-font SKU explanation in the drawer, the phone bar/footer stacking three full-width
buttons and the advisor button covering one.

### 2026-10-27 — Phase 3: the API review's fixes (shein-sync-engineer)
Review `scratchpad/plan/phase3-review.md`. The dashboard agent's Phase 3 page was kept; only its copy for
specials changed (`SheinDryRunSheet.jsx`: "ends the $X special", "capped") and two page tests that
asserted the old worst-status tile and the $55-special toddler scenario.
- **P1** key = body + SHEIN's pre-send state (`sendState`) AND a `done` item frees its key — the state
  alone can't tell "cut → went up → the same cut" apart (SHEIN shows $160 both times).
- **P2** effective price (special when > 0); live special → `special_live` (left alone) unless
  `endSpecials` (sent WITHOUT specialPrice = ends it). Readiness + planner + sheet copy.
- **P3 / D8a** auto: market targets only, ≤ 15 % a day, ≥ Shopify; products with a market-sourced diff.
- **P4 / S4** a rise's lost answer → in review, never resent; 7 days → `price_review_stuck` (not retryable).
- **S1 / D4a** sibling rule removed (`sheinNewSizePrice`, `PRICE_FROM.sibling`, tests).
- **S2** audit_state 1/2 only; **S3** locks unread → no rises, lock type 2 → note; **S5** stock step after a
  size is turned back on; **S6** whole multi-language title list, word-boundary cut (title stays dormant
  until Phase 4 writes `synced_hash`); **S7** `shein_title_too_long`; **S8** narrow `unauthori…`;
  **S9** one market lookup (`io.marketTargets`; `marketPricesFromQuotes` removed); **S10** price items
  don't hold the walk's seller-SKU edits; **S11** ops sorted price → edit; **S12** doc fixed.
- **Tiles** (decision 15): `size_statuses TEXT[]` on `shein_listing_products` (ADD COLUMN IF NOT EXISTS),
  filter + summary counts by it; the Phase 1 "tiles add up to All" test became "each tile = its list".
- **Fake SHEIN:** a missing specialPrice ENDS the special (no error, `endedSpecials`); riseReason optional;
  a second price while a rise is in review is refused; `losePriceAnswer`; specials modelled per SKU.
- Tests: +12 (P1 repeated cut, P2 ×2, P3, P4+S4, S2, S3, S5, S6/S7, S8, S10, S11, tiles).
**Results:** `npm run build` ✓; `shein-listings` + `shein-live` + `shein-check`: 128 passed, 1 skipped;
`shein-listings` in Asia/Manila 85/85. Local `db:setup` run (new column) — prod needs it too.
**Still open (live calls only):** the review's L1–L7 (does spu-info show a pending rise; the price-audit
event code; can a cut be status 2; price/save during a document review; resend answer during review;
counts of live specials / locks / over-long titles).


### 2026-10-27 — Phase 3 re-review R1–R3 (shein-sync-engineer)
- **R1** a rise = the shopper pays more (`to > pays`): ending a special (200/150 → 165) is a rise — lock /
  locks-unread skips + `riseReason '4'`; copy "ends the $150 special: shoppers pay $165, SHEIN may review it".
- **R2** a live special off target reads **Needs update** (diff `shein_special` + note `special_live`), so the
  tile/filter finds it; the auto re-sync never picks it (it reads `shein_price` diffs only).
- **R3** D8a caps rises at +15 % a day too; capped prices are whole dollars rounded UP (cut floor = ⌈max(85 %,
  Shopify)⌉, rise ceiling = ⌈115 %⌉). +3 tests; build ✓; listings + live + check 131 passed, 1 skipped.

### 2026-10-27 — Phase 4 (publish brand-new products), back end (shein-sync-engineer)
**Built** exactly from `scratchpad/plan/phase4-spec.md` (context chunk → "Phase 4", with every shape):
the pure planner `src/lib/sheinPublish.js`, the I/O `api/_lib/shein-publish.js`, op `publish` in the job
engine (gates fresh on the run, look-before-send, key `…|publish|hash|sha(skus)`, receive-webhook SPU,
approval → published + ours + stock step + compliance, rejection → admin "Publish again"), readiness for
products not on SHEIN (cache only), `listing-meta`, `listing-maps type=category|attr|brand|box`, tables
`shein_category_map` / `shein_attr_defaults` / `shein_brand_map`, `shein_api_log.asset`,
`SHEIN_ASSET_PATHS` + two reads in `SHEIN_READ_PATHS`, the Shopify read's description / photos / options.
**Deviations / decisions**
1. **D6 box sizes** live in `app_settings.shein_box_defaults` (not `shein_attr_defaults scope 'box'`): the
   coordinator asked for an editable setting shown "unconfirmed" until a person saves it. Unconfirmed →
   `box_unconfirmed` blocks every publish (placeholders never go to SHEIN). Admin / Connect integrations save.
2. **Size charts** (a required type-2 attribute, or one named by assoc rules) → `size_table_not_yet`
   (blocked), as in Phase 2; `sku_scope` attributes → `missing_attr {why:'sku_scope'}`. Not built.
3. **Not built:** the `upload-pic` fallback; barcodes (`supplier_barcode` required → `fill_required`); the
   colour suggestion from the title; the brand quota exemption (per-brand quota is read but not yet used);
   marking attribute defaults stale on a template change (`markAttrDefaultsStale` exists, not called).
4. Photos are converted only when nothing else blocks (they are SHEIN asset calls); a dry run's proof is
   `shein_writes 0` + `assets n`.
5. **Fixed on the way:** a run job now carries its dry run's `ops` / `endSpecials` / `auto` — without them
   the run's rebuild differed (publish: no gates/warehouse; Phase 3: specials / auto caps) and read
   "changed". A recompute keeps a published-but-unapproved product's SPU (`review_version`).
6. Products not on SHEIN now read **Blocked** with what publishing needs (`no_category`, `box_unconfirmed`, …)
   instead of "Not on SHEIN" + a note — the plan's B.3, deferred in Phase 1.
**Results:** `npm run build` ✓; `shein-listings` + `shein-live` + `shein-check`: 145 passed, 1 skipped;
`shein-listings` in Asia/Manila 102/102; +14 Phase 4 tests (each §3 Phase 4 line: refused while a line is ✕
with the reason; store gates before any write; spu + version saved at once / In review; approval → Synced +
stock step, rejection → Error + admin re-publish; transform-pic cached by URL + type, rejected photo shown;
SKC `supplier_code = SB12-P<id>`; plus maps, D6, lost answer, refusal mapping, ops never mixed, the fake's
validation). Local `db:setup` run.
**Open items:** the Phase 4 page (checklist, maps screens, D6 form, Publish again); the live questions
L1–L10 of the spec; D5 brand authorisations; the pilot.

### 2026-10-27 — Phase 4, the page (shein-dashboard-engineer)
**Built** on the back end's shapes (context chunk → "Phase 4 — the page"): `src/components/SheinPublishBits.jsx`
(checklist + inline fixes: category picker with SHEIN's suggestion, brand, SHEIN details editor with seed →
review → save, colour, title override + counter, PH photos, D6 box form), `src/screens/SheinListingsSetup.jsx`
(new **Setup** tab: gates, box, category map, brand map, details per type), the drawer's checklist + "Published
from this page" section, the bar's **Publish new products**, the sheet's `PublishPlan` / stats / proof /
"Publish N products" / Rejected + **Publish again**, the store-gate banner; API client `sheinListingMeta`,
`sheinPublishMaps`, `sheinPublishMapSave`; copy `OP_LABEL.publish`, `OP_SAY.publish`, `PUBLISH_WORD`,
`isPublishOps` in `src/lib/sheinListings.js`.
**Deviations / found**
1. **"n photos converted"** is summed from the items' `plan.photos.converted`: the preview job's `counts` spread
   only `shein_calls` / `shein_writes` from `countSheinApiLog` (its `assets` isn't copied). Server fix optional.
2. **A saved fix doesn't move the checklist** until a new dry run (or a re-read): the maps endpoints don't
   recompute, and the drawer prefers the last dry run's checklist anyway. The line shows "Saved — checked again by
   the next dry run" instead of pretending ✓.
3. **A rejected publish keeps its SPU**, so its drawer is no longer "not on SHEIN" (no checklist from the
   server). Added a "Published from this page" section there (SHEIN's reason + Publish again → a fresh dry run).
4. The run's header chip / phase came from the job's own counts, written when the send ended — after SHEIN's
   review answered they still read "waiting". They now follow the live item counts.
5. In readiness the brand line reads ✓ (fill-in-standard unread → `brand_unset` note, filed under line 17); it
   turns ✕ only once a dry run has read SHEIN's rules. Server question: should readiness mark brand `null`?
**Results:** `npm run build` ✓; `shein-listings` + `shein-live` + `shein-check` with the host in Asia/Manila and
`SHL_SHOTS` set: 154 passed (shein-listings 110 + the screenshot helper; the 102 before all green).
Screenshots `scratchpad/shots/shein-listings-{desktop,phone}-publish-*.png` reviewed; fixed the summary line
wrapping into the chips, the four repeated store lines (grouped "The store" / "This product"), the PH-photos
checkbox squeezing its hint into a column, a duplicate Seller Center button, the quota stat reading "1 of 5"
without "uses", the stale "Sent · waiting on SHEIN" chip on a rejected send.

### 2026-10-27 — Phase 4: the API review's fixes (shein-sync-engineer)
Review `scratchpad/plan/phase4-review.md`. The dashboard agent's Phase 4 page was kept; added to it: Look
again / Send again on a publish item, "Mark “no brand”" in the brand picker, "not mapped — blocks
publishing" on the Setup brands table, and a "not read yet" checklist line now offers its fix.
- **F1** a publish is never resent automatically: lost / unreadable answer, transport error after the send,
  or a crash mid-send → `failed` + `publish_unconfirmed`, key kept. Look again (PH, reads only) → In review if
  SHEIN has it; Send again (admin / Connect integrations) only after a second look ≥ 30 min after the send.
- **F2** `brand_unset` blocks; "no brand" only for vendors off the known-brand list (data); a hidden brand
  field blocks. Checklist line 7 now carries `brand_unset` / `brand_none` (they had fallen to line 17).
- Unread checklist lines are `null`, never ✓; the drawer's checklist is computed live from the cache.
- S1–S10 done (see the context chunk). The fake SHEIN now validates the new picture plans A/B, a top-level
  `supplier_code`, an optional brand, answers `filtered_result` and an mcc type-2 block, can lag the
  seller-SKU check and drop a request.
- Tests: +11 (3 pure, 5 end to end, the rewritten lost-answer test, 2 page assertions updated).

### 2026-10-27 — Phase 5 (4seller cut-over), page + small server (shein-dashboard-engineer)
**Built** (context chunk → "Phase 5"): `src/lib/sheinCutover.js` (pure: `evaluateCutover`, `evaluateGolive`,
`productAnswered`, `validTickDate`, `TICKS`, `SHEIN_CONTROLLED`), `api/shein/listing-cutover.js` (GET for PH + admin;
POST tick / untick / restart for admin or Connect integrations), `db.js` `listingCutoverFacts` / `listingGoliveFacts`,
`src/components/SheinCutover.jsx` (Go-live card + 4seller cut-over card on the Setup tab, one strip line once
started), SOP article `ph-shein-listings` (`src/lib/sop/articles.ph.js`, PH + admin + superadmin).
**Deviations / decisions**
1. **Two columns after all** (the plan said "nothing new in the DB"): `shein_listing_products.first_seen_at` (set on
   INSERT only) and `settled_at` (the first save that reads as an answer; never moved). No backfill: NULL = seen before
   Phase 5, never counted as new. Needs `db:setup` (local run).
2. **"Answered"** = Synced, **In review**, Blocked / Error with at least one non-note blocker, or a person's "Don't list
   on SHEIN". In review was added (sent; the page says why it isn't live yet). A Shopify draft is not an answer.
3. **(e) is computed, not ticked**: the SHEIN check page's "sizes to add" is built in the browser from an uploaded
   export, so we count the same rule from our last read (in-stock size of an ACTIVE shoe with an SPU and no SHEIN SKU).
   Sizes a person marked "Don't list on SHEIN" are shown but not counted. SHEIN-controlled = `size_not_on_shein`,
   `brand_not_authorized`, `store_cannot_publish`, `publish_quota_used`, `shelf_quota_full`.
4. The 30 days start at the **tick time** of "4seller paused"; the person-entered paused *date* is what "4seller paused
   before the first Phase-2 run" compares with the first `run` job. A miss doesn't reset by itself: "Start the 30 days
   again" (admin / priv) moves the start to now. Nights counted = each EST night after the start day, tonight only after
   04:00 EST; a night = a finished snapshot started by `auto (nightly 03:00 EST)` (production only, so ✕ locally).
5. Ticks live in `app_settings.shein_cutover_ticks` (`{key: {by, at, date?, note?}}`).
**Results:** `npm run build` ✓; `shein-listings` + `shein-live` + `shein-check` + `smoke`: 201 passed, 1 skipped
(+10 Phase 5: 5 pure, settle stamps, endpoint gates, PH page, admin flow, 390 px). Screenshots
`scratchpad/shots/shein-listings-{desktop-cutover-ph,desktop-cutover-admin,phone-cutover,phone-cutover-card}.png`
reviewed; fixed the tick rows repeating their line's title on the go-live card, "seller center" lower-cased, the style
code printed twice, the job kind shown as a code.
**Open (user):** prod `db:setup`; the go-live ticks; the three pilots; then the 30 days.

### 2026-10-27 — Security review + Phase 4 re-review fixes (shein-sync-engineer)
Reviews `scratchpad/plan/security-review.md` and `phase4-review.md` → "Re-review". Phase 5 (dashboard agent) kept.
- **H1** stop / resume of a `run` job → admin or Connect integrations (403); `resumeListingJob` never overwrites a
  run's `confirmed_by`; new column `shein_listing_jobs.resumed_by` (needs `db:setup`).
- **H2** photos are converted only in a dry run started by an admin / Connect-integrations holder (`scope.convertPhotos`);
  a PH dry run → `photos_need_priv` note, photo line null, nothing sendable. Daily cap `shein_transform_cap`
  (default 500 / EST day) → `photo_cap_reached`.
- **M1** the job CSV is capped at 20,000 items (`truncated`), 6 a minute per user. **M2** `fetchImage` allow-list
  (Shopify CDN + R2), same-host redirects only, 15 MB streamed cap. **M3** per-user throttle on `look_again` and
  `suggest=` (+ 10-min cache per product). import.js / brand.js already validate their URLs.
- **L1** listing-maps 405 + suggestion fields whitelisted. **L4** `/api/shopify/webhook` body limit 4 MB (that route only).
- **G1** another unconfirmed publish of the product blocks new publishes (dry run + readiness). **G2** coded system
  errors / any error after the send → unconfirmed. **N1** title brand check before "no brand". **N2** unread brand list →
  "not read yet". **N3** `default_language` ≠ en blocks.
- New blocker codes: `photos_need_priv`, `photo_cap_reached`, `brand_list_unread`, `language_not_en`.
- Tests: +10 (5 pure, 5 end to end); the Phase 4 page test now shows a PH dry run converting nothing, then the admin's.
**Results:** `npm run build` ✓; shein-listings + shein-live + shein-check + smoke 211 passed, 1 skipped; shein-fix +
shein-reprice 15 passed; shein-listings in `TZ=Asia/Manila` 138 passed, 1 skipped. Open (user): `db:setup` for `resumed_by`.
- **2026-10-27 — box sizes in inches / pounds** (user's request): the Setup tab's box card and the dry-run sheet show and take in / lb; saved and sent to SHEIN in cm / g as before. The user's default for every shoe: 16 × 12 × 6 in, 4 lb.
