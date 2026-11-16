# SHEIN Listings — Shopify → SHEIN listing sync (retires 4seller)

## The one page (`/ph/shein`, `/shein`; `src/screens/Shein.jsx`)
Every SHEIN screen is one page with one home card ("SHEIN"), sections in `?section=` (keys stay, words are in `sheinWords.js`):

| Section | `section=` | What it is | Its own params |
|---|---|---|---|
| Today | `today` | Health line + counts with a button each. Reads `api/shein/listings` + `api/shein/live`, nothing new; a failed read says "couldn't read this", never 0 | none |
| Shoes on SHEIN | `listings` | `SheinListings.jsx` | `tab status any q brand blocker shop sort more p product job sz pt adv sizeadv` |
| Orders | `orders` | `SheinOrders.jsx`: every SHEIN order + its state, tick → Download pick list (`shein-live-fix.md` → 1a). PH + admin only | `odays ostate oq` |
| Fix problems | `check` | `SheinCheck.jsx` (+ Match, Fix) | `chk fixadv` |
| Prices | `reprice` | `SheinReprice.jsx` | `priceadv` |
| Automatic sync | `live` | Connect card + `SheinLivePanel.jsx` | `liveadv`, and `shein` / `shein_error` once on return from SHEIN |

- **Kept mounted, hidden.** A section mounts on first visit and stays, so an uploaded file, a reprice and prices being fetched survive a switch. `LivePausedContext` (`src/hooks.js`) pauses every `useLive` inside a hidden section; it catches up when shown. Drawers and sheets are portalled, so a hidden Listings stops rendering them (`visible`).
- **Moving between sections** is `replaceState` (the app's tab convention), so Back leaves the page. A link passes params through `useSheinNav()`, and `syncQueryParams()` makes the hooks re-read them. It is not a popstate, which would run the routers and the unsaved-changes prompt.
- **Who sees what** (`sheinSectionsFor`, `src/lib/sheinPage.js`): PH and admin all six; a warehouse account holding `connect_integrations` Fix problems + Automatic sync; anyone else never reaches the page. Each endpoint still enforces its own role.
- **Old addresses** (`canonicalSheinUrl`): `/ph/shein-listings`, `/shein-listings`, `/ph/shein-check`, `/shein-check`, `/ph/shein-reprice` land on the right section with their query. `?tab=match` on the old check path becomes `chk=match`. `/shein` and `/ph/shein` move to the person's own workspace, which is why `api/shein/callback.js` can return to `/shein?section=live&…` for every role.
- **Advanced**: `SheinAdvanced` (`src/components/SheinNav.jsx`) keeps its open state in the URL. Under it: Jobs, Setup, Shopify updates, automatic price update (`adv=1`); Ask SHEIN (`sizeadv=1`); sync switches + the full check (`liveadv=1`, opens by itself while a check runs or the sync is off); orders file, template, AI suggestions (`fixadv=1`); the price template (`priceadv=1`).

## Words
**One place:** `src/lib/sheinWords.js` holds section names, status words and meanings, job words and terms. Blocker text is in `BLOCKERS` (`src/lib/sheinListings.js`). Display text only: API fields, database values and URL keys did not change. Text the server writes (a job's phase, a summary, an API error, old rows) goes through `plain()` at the screen; `api/` keeps the old words and SHEIN's own quoted messages are left as they are.

| Old word | New word |
|---|---|
| SHEIN Listings (page) | Shoes on SHEIN |
| SHEIN ↔ Shopify check (page) | Fix problems |
| SHEIN Reprice (page) | Prices |
| Live sync, live fix | Automatic sync |
| Dry run | Preview (changes nothing) |
| Re-read Shopify + SHEIN, snapshot | Refresh from SHEIN |
| Walk, Fix every SHEIN listing | Full check of every SHEIN listing |
| Seller SKU | SKU |
| SPU | Product (`On SHEIN <code>` beside a shoe) |
| SKC value | Colour |
| Blocker (filter) | What's stopping it |
| 4seller cut-over | Switching over from 4seller |
| Go-live checklist | Before going live |
| Pilot — Phase N | First try |
| Publish quota, Shelf quota | Monthly new-product limit, Shelf limit |
| Register Shopify webhooks | Connect Shopify updates |
| Auto re-sync price | Automatic price update |
| Ask SHEIN (read-only) | Ask SHEIN which sizes it allows |
| 0 SHEIN writes | 0 changes on SHEIN |
| Add sizes to N products (confirm) | Send N sizes to SHEIN (N products) |
| Update N products (confirm) | Send changes for N products to SHEIN |
| Publish N products (confirm) | Publish N new products on SHEIN |
| trace | ref |


Plan + decisions: `docs/shein-listings-plan.md` (its **Build log** at the end records what was built
and every deviation). API fields: `docs/shein-listing-api-reference.md` (publish, templates, custom
sizes, review, **searchProduct**) and `docs/shein-api-reference.md` (spu-info, stock, price).

**Built 2026-10-27: Phase 0 (probe) and Phase 1 (read-only dashboard), back end AND page; Phases 2–3
back end + page; Phase 4 (publish new products) back end AND page; Phase 5 (4seller cut-over + go-live checklists, SOP article `ph-shein-listings`) — see "Phase 5"** —
(`/ph/shein-listings`, `/shein-listings`), **and Phase 2's BACK END (add missing sizes to shoes
already on SHEIN — the first SHEIN write, `partialEdit`)**, back end AND page (dry run → review sheet
→ confirm → job card) — see "Phase 2" below — **and Phase 3 (Needs update → Synced: prices, sizes turned
off on SHEIN, wrong SKUs; auto re-sync price), back end AND page** — see "Phase 3". All of it is merged and live; the page fixes of
2026-11-17 are in "The list API", "The status engine (stage 2)" and "The page (stage 3)". **Wording (user, 2026-10-27):** statuses read
Needs update / Not in Shopify / Not listing (codes `out_of_date` / `shein_only` / `excluded` unchanged);
buttons "Don't list on SHEIN" / "List on SHEIN again"; "SHEIN has the wrong SKU: A → will change to B";
"SHEIN size" vs "Custom size".
Related and already live: stock both ways + the walk (`shein-live-fix.md`), seller-SKU links /
Match sizes (`shein-fix.md`). **Match sizes for one shoe is in its Details drawer** ("Fix SHEIN sizes",
2026-10-28): a wrong-link / SPU-spans / SHEIN-already-has-it button (`open_match` with `here: true`)
opens the drawer there, not the check page; the one-shoe dry run / fix is `shein-live-fix.md` §5.

## Files
| File | What |
|---|---|
| `src/lib/sheinListings.js` | The pure engine, shared by server + page: `STATUSES`/`STATUS_ORDER`/`TILE_STATUSES`, `BLOCKERS` + `renderBlocker`, `sizeKey`, `resolveSize`, `validateCustomText`, `suggestCustomSpelling`, `matchStore`, `variantReadiness`, `productReadiness`, `rollup`, `listingHash`/`variantHash`, `normalizeWebhookProduct`, `spuPayload`, `templateSizes`, `computeListings`, `SHEIN_READ_PATHS`/`isSheinWrite` |
| `api/_lib/shein-listing.js` | The jobs (snapshot, probe), the runner (lease + heartbeat), the Shopify-webhook recheck, `listingTick` (re-read every 30 min) |
| `api/_lib/shein.js` | `sheinCall(path, body, { log })` hook → `shein_api_log`; read helpers `sheinAllSpusLogged`, `sheinSearchProducts`, `sheinSpuInfoLogged`, `sheinDocStates`, `sheinCustomPermissions`, `sheinAttributeTemplates` |
| `api/_lib/shopify.js` | `shopifyListingCatalogue()` (every product + variants, normalized), `shopifyListingProduct(id)`, `shopifyEnsureWebhooks(uri, topics)` (the old `shopifyEnsureInventoryWebhook` is untouched) |
| `api/shopify/webhook.js` | Branches on `x-shopify-topic`: `inventory_levels/update` → `queuePush` exactly as before; `products/create|update` → `listingProductChanged`; `products/delete` → `listingProductDeleted` (`routeShopifyWebhook`, `HOOK`) |
| `api/shein/listings.js`, `listing-jobs.js`, `listing-maps.js`, `listing-log.js` | The endpoints below |
| `api/_lib/shein-worker.js` | `sheinTick()` also calls `listingTick()` (own try/catch) |
| `e2e/shein-listings.spec.js` | Engine fixtures, the log hook, the snapshot job vs a fake SHEIN, webhooks, the endpoints, **the page**, Phase 2 jobs + **the Phase 2 page** (POST preview/run/retry answered in-process via `page.route`) |
| `src/screens/SheinListings.jsx` | The page shell: connection strip, job banners, status tiles (= `?status=` filters), tabs, the legend; `LISTING_TABLES` for `useLive` |
| `src/screens/SheinListingsProducts.jsx` | Products tab: filters + `FilterChips` + `useSearchBox`, product rows → size rows (`VariantTable`), the selection bar (previews, Don't list on SHEIN), `useFixes` (custom size / don't list / list again / confirm a price / a rejection's preview), `useInJob` |
| `src/screens/SheinListingsRejected.jsx` | 2026-11-17: the **Rejected** tab (`?tab=rejected`) — `GET ?rejected=1`, one row per shoe + its one button |
| `src/screens/SheinListingsSizes.jsx` | Sizes tab: `ProbePanel` (Ask SHEIN) + our size → SHEIN size per category, "Add as a custom size", Clear |
| `src/screens/SheinListingsJobs.jsx` | Jobs tab: running job, history, Resume, one job's items (`?job=`) + CSV |
| `src/components/SheinProductDrawer.jsx` | Details drawer (`?product=`): **Edit this shoe** (`ShoeEditor`, the same for every shoe — see “One editor for every shoe”), what SHEIN will receive, history (dry runs / sends → Open the sheet), the two dry runs (Add missing sizes · Update prices & sizes), "was …" diffs |
| `src/components/SheinListingsBits.jsx` | `StatusChip`, `BlockerSay`, `FixButton` (live vs "Coming in a later phase"), `CustomSizeModal`, `when` (EST) |
| `src/components/SheinDryRunSheet.jsx` | Phase 2: `DryRunSheet` (the overlay) + `DryRunView` (dry-run review → Confirm → the run's job card; also inline on Jobs `?job=`); Phase 4 `PublishPlan` |
| `src/lib/sheinShoeEdit.js` | Pure: the editor's menu (`EDIT_MENU`), a live shoe's lines (`liveShoeLines`) + why a detail can't change on a live shoe (`LIVE_LOCKS`), “Fix these first” (`fixFirstLines`), SHEIN's review answer for a never-live shoe (`refusedBlockers`) |
| `src/components/SheinPublishBits.jsx` | Phase 4: `ShoeEditor` (was `PublishChecklist`: the drawer's editor — the 18 publishing lines or a live shoe's lines + inline fixes), `CategoryPicker`, `BrandPicker`, `AttrEditor`, `ColourPicker`, `TitleEditor`, `BoxDefaults` (D6), `useStoreGates` / `StoreGateBanner` |
| `src/components/SheinBulkPublish.jsx` | Bulk edit before publishing (2026-10-28): the ticked new shoes, what blocks each, fixes grouped by key, "Dry run publish (n ready)" |
| `src/screens/SheinListingsSetup.jsx` | Phase 4: the Setup tab (`?tab=setup`, `?pt=`) — store gates, D6 box, category map, brand map, SHEIN details per product type |
| `src/lib/sheinCutover.js`, `api/shein/listing-cutover.js`, `src/components/SheinCutover.jsx` | Phase 5: the cut-over / go-live checks (pure), the endpoint, the two Setup cards + the strip line |
| `src/lib/sheinRejected.js` | 2026-11-17: "Rejected by SHEIN" rows + the action that resubmits each (`rejectedList`, `nextFor`; pure) — data from `rejectedListingData` (db.js) |
| `api/_lib/shein-listing-oneoffs.js` | 2026-11-17: SQL the db-setup runs once (idempotent) — `STALE_REJECTIONS_SQL` (stage 2, item 2) |

## Tables (`scripts/db-setup.mjs`; live = in `LIVE_TABLES`)
- `shein_listing_cache` (kind, key, payload, fetched_at) — kinds: `probe`/`last` (the Ask-SHEIN answer),
  `spu`/<spuName> (the compact SHEIN side of one SPU, `spuPayload`), `spu_list`/`current` (the SPUs of
  the last snapshot), `attr_template`/<productTypeId>, `custom_perm`/<categoryId> (24 h).
- `shein_api_log` — every listing-side SHEIN call: path, method, `write`, `dry`, SHEIN code / msg /
  `trace_id`, ms, by, job/item/spu. A read stores no body; a write stores request + answer. Pruned at 90
  days (once per EST day, from the tick).
- `shein_listing_products` (live) — one row per Shopify product (`shopify_product_id` = gid) or per
  SHEIN product none of whose sizes Shopify has (`shein:<spu>`). Roll-up `status`, `counts`
  `{ all, sizes (in stock), on_shein, shein_only, by }`, `blockers` (from the COUNTED sizes — see "The list API"),
  `idle_blockers` (2026-11-17: reasons only zero-stock sizes carry), `spu`, `category_id`, `excluded`,
  `shopify_hash` (listing fields, no stock), `shopify_json` (what the recompute reads), `search_text`, and the
  GENERATED `search_norm` / `search_compact` (2026-11-17, the search; never written by code).
- `shein_listing_variants` (live) — one row per Shopify variant (`row_key` = variant gid) or SHEIN-only
  size (`shein:<skuCode>`): Shopify side, SHEIN side, `match` (sku|link|published|none), `status`,
  `blockers`/`notes`/`diffs` (`{code, field, params}` only — text comes from `BLOCKERS`), `size_plan`
  (what we'd send for a size not on SHEIN), `target_hash`/`synced_hash`/`synced_fields` (the baseline),
  `excluded` (a person's "Don't list on SHEIN"), `last_error` (`{code, params, hash, op, itemId, spu, at}` — `op`/`at`
  since 2026-11-17), `price_ok` (2026-11-17: `{price, by, at}` a person's confirmation of an outlier price).
- `shein_listing_actions` (live, 2026-11-17) — **the listing log**: what a person or a rule changed on OUR side
  (`clear_error`, `auto_clear_error`, `price_ok`, `price_ok_cleared`, the db-setup one-off): `at, by, action,
  shopify_product_id, row_keys, detail`. Never a SHEIN call (those are `shein_api_log`). GET `?product=` → `actions`.
- `shein_size_map` (live) — (category_id 0 = any, attribute_id, size_key) → `attribute_value_id` OR a
  person-confirmed `custom_value`; `foot_length`, `source` (exact|person|custom_created), `verified`.
- `shein_listing_jobs` (live) — kind (snapshot|probe|preview|run|recheck), status (queued|running|
  awaiting_confirm|done|stopped|failed|interrupted|**expired** — a preview not confirmed in 24 h, 2026-11-17), lease,
  phase/total/done/current, counts, resumes. **At most one queued/running** (partial unique index).
- `shein_listing_job_items` (live) — snapshot: one `read` item per SPU (seq order; pruned after 7 days, 2026-11-17);
  Phase 2: one `add_sku` item per product (body, body_hash, idem_key UNIQUE, plan, version, sku_codes, retries…).

## Statuses, matching, sizes (the rules)
- 8 statuses + internal `unknown`; roll-up = worst of the IN-STOCK sizes: blocked > error > out_of_date >
  not_on_shein > shein_only > in_review > synced > excluded. Zero-stock sizes don't count (D10).
  The shoe's `blockers` come from the same counted sizes (2026-11-17); a zero-stock size's reason is an `idle_blockers` entry.
- Match: SHEIN `supplierSku` == Shopify `variant.sku`; else a pending `shein_links` relink
  (`link_sku` ≠ what SHEIN shows) → **Needs update** (`out_of_date`, diff `seller_sku`: "SHEIN has the wrong SKU"). Never the SPU/SKC
  `supplierCode` (4seller's borrowed parent SKU), never the title. A SHEIN size no variant has →
  **Not in Shopify** (`shein_only`), under the product owning its SPU (most matched sizes), else a `shein:<spu>` row.
- Needs update also: `mallState 2` while Shopify sells it; a listing field changed on Shopify since the
  baseline. **Baseline (Build log):** the first snapshot that sees a size on SHEIN accepts Shopify's
  then-values (`synced_hash`); a later Shopify price/size/SKU/barcode change → Needs update with the
  "was → now" diff. Stock is never part of it. **2026-11-17:** a Shopify PRICE change counts only when the size has a
  market price (else it is the `price_no_market` note) — see "The status engine (stage 2)".
- **2026-11-17 (stage 2):** a matched size whose SHEIN size is blank / not a US size → **Blocked** `shein_size_blank`
  (the walk holds it at 0) unless a person linked that exact SKU; a Not-on-SHEIN size SHEIN already sells on the same
  colour under another SKU → **Blocked** `size_already_on_shein`; a size whose price is far from the shoe's other sizes
  → **Blocked** `price_outlier` until a person confirms it. Details: "The status engine (stage 2)".
- Sizes not on SHEIN: a person's map, else SHEIN's own value only on an EXACT `compareSize` 'ok' —
  never the nearest. No value + custom allowed (`has_permission 1`) → `size_needs_map` (blocked until a
  person confirms a spelling); not allowed → `size_not_on_shein`; not read yet / no category →
  `size_unchecked` note. Spelling suggestion (D1): an existing store custom value for that size as is;
  else the store's custom pattern; else SHEIN's pattern for the category (`US7W` → `US14.5W`).

## Jobs
- **Server jobs** (`shein-listing.js`): created queued, claimed by `kickListingJobs` (in the process that
  created it) with a 3-min lease, `touchListingJob` on every SHEIN product (a process that lost its lease
  writes nothing more). Lease ran out → `interrupted` (`markStaleListingJobs`, on every GET + tick).
  **Resume** = same job, re-queued, continues from the first unfinished item. Never alongside the live
  walk (refused 409; a running snapshot waits while a walk runs).
- **Snapshot:** Shopify catalogue → `product/query` (SPU list, once per job) → per 10 SPUs:
  `searchProduct` (locks) + `query-document-state` + `spu-info` each → cache `spu` → templates +
  permissions (24 h cache) → `computeListings` → only products whose `computed_hash` changed are written;
  products no longer seen are removed. SHEIN stock comes from the last walk (`shein_live_items`).
- **Probe (Phase 0):** `searchProduct` over the store (categoryId per SPU) → `spu-info` on one product per
  category (+ an optional SPU a person names) → `get-custom-attribute-permission-config` →
  `query-attribute-template` → cache `probe/last`. Reads only.
- **Every 30 min** (owner, 2026-11-10; was nightly): `snapshotDue` — the newest snapshot (anyone's; a
  person's Re-read counts) is not queued/running and FINISHED ≥ `SHEIN_LISTING_EVERY_MIN` (default 30)
  minutes ago, so two never overlap however long one takes. From `sheinTick` → production only /
  `SHEIN_SYNC_WATCH`; started_by `auto (every 30 min)`; an interrupted auto run is resumed instead.
  Watch the SHEIN API budget (`shein_api_log`); `SHEIN_LISTING_EVERY_MIN=120` slows it,
  `=0` goes back to the **nightly** 03:00–03:59 EST (`nightlyDue`, started_by `auto (nightly 03:00 EST)`).
- **Shopify webhooks** products/create|update: 1.5 s coalesce → `listingHash` (no stock) vs stored →
  re-read that product live → recompute from STORED SHEIN rows (no SHEIN call). Nothing before the first
  snapshot. products/delete → Not listing at once. In-memory queue (a restart drops a pending recheck; the
  next re-read catches it). Registered by the admin action `webhooks` (same URL + HMAC as the stock webhook).

## Endpoints (gates: applySecurity → requireRole(['ph_team']) (admin auto) → privilege read fresh → rateLimit → getJsonBody)
- `GET /api/shein/listings?status=&any=&blocker=&q=&brand=&shopify=&page=&pageSize=50&sort=worst|title|updated|coverage`
  — the list + its summary. **Full contract (2026-11-17): "The list API" below.** `&shopify=active|inactive`
  (2026-10-28, 400 otherwise): active = ACTIVE on Shopify with stock > 0 on a size not left off (`EXISTS` on
  `shein_listing_variants.shopify_qty`, no new column); inactive = the rest (draft / archived / 0 pairs / SHEIN-only rows).
- `GET ?rejected=1[&q=&brand=&off=1]` (PH ok, DB only) — "Rejected by SHEIN", below.
- `GET ?publishSetup=<gid,gid,…>` (≤ 100 → else 400; PH ok; DB only) — bulk edit before publishing, below.
- `GET ?product=<gid>` → `{ ok, product, variants (rendered blockers + notes), jobItems (last 5),
  log (last 20 for its SPU; bodies admin-only), canWrite, isAdmin }`; 404 unknown.
- `GET ?probe=1` → `{ ok, probe, savedAt, job, canWrite }` — `probe = { askedAt, by, jobId, store:{spus,
  categories}, categories:[{categoryId, spuCount, sampleSpu, sampleName, productTypeId, sizeAttributeId,
  sizeAttributeName, hasPermission 0|1|null, hasSizeTable, sizeFieldStatus, sheinSizes:[{id,label}],
  customValues:[…], sampleSizes, allPermissions}], customValues, spuChecked, errors, calls, writes }`.
- `POST {action}`: `snapshot` → `{ok, job}` (409 job/walk running, 503 not connected/configured) ·
  `stop {jobId?}` · `resume {jobId}` → `{ok, job}` (a **run** job: admin or Connect integrations, 403 for
  PH; resuming keeps the run's `confirmed_by`, the resumer goes in `shein_listing_jobs.resumed_by`) · `exclude|include {productIds?, variantKeys?}` →
  `{ok, n:{products, variants}, products}` (recomputed, DB only) · **admin or Connect integrations:**
  `probe {spu?}` → `{ok, job}`, `webhooks` → `{ok, hooks}` (403 otherwise) · (2026-11-17) `clear_error {variantKeys? |
  productIds?, note?}` (admin / Connect integrations) and `price_ok {variantKey, price | null}` (PH ok) — "The status engine (stage 2)".
- `GET /api/shein/listing-jobs[?status=&page=]` → `{ ok, jobs, active, page }`; `?id=&page=&status=` →
  `{ ok, job, items (500/page), itemCounts, page, inThisProcess }`; `?id=&all=1` → the CSV, capped at 20,000 items
  (`truncated`, `cap`; 6 a minute per user).
- `GET /api/shein/listing-maps?type=size` → `{ ok, type, maps, usage:[{category_id, size_key, size,
  sample, sizes, on_shein, needs_map, not_allowed, unreadable, plan, shein_size, attributeId,
  hasPermission, suggestion, map}], categories:[{categoryId, productTypeId, attributeId, hasPermission,
  hasSizeTable, sheinSizes}], customValues }`. `POST {action:'set', categoryId, attributeId, sizeKey,
  attributeValueId | customValue, footLength?, note?}` / `{action:'clear', id}` → `{ok, map|cleared,
  recomputed}`. Custom text: ≤ 50, half-width, no emoji, must read as the same size; a SHEIN value must be
  the same size (`compareSize`) and in the category's list (409 if not read yet). DB only.
- `GET /api/shein/listing-log?job=&spu=&trace=&writes=1&limit=` (admin) → `{ ok, log }`.

## The section (Shoes on SHEIN: `/ph/shein?section=listings`, `/shein?section=listings`)
- **Who:** PH + admin/superadmin (the endpoints refuse anyone else, so the admin card has NO
  `privKey` — a warehouse holder of Connect integrations would land on 403s). **Ask SHEIN** and
  **Register Shopify webhooks** (**Re-register** once done; it only creates what's missing) need admin or `connect_integrations`; others see them disabled with
  the reason in the title. SheinCheck carries a one-line link to the page.
- **Layout** (matches `docs/shein-listings-mockup.html`): connection strip (SHEIN connected · last
  read EST — amber after 30 min · counts · webhooks state · Re-read · Register webhooks) → running-job
  banner (phase, n of total, now-on, Stop, View job) or an **interrupted** banner with Resume → status
  tiles (All · Synced · Not on SHEIN · Needs update · In review · Blocked · Error · Not in Shopify when
  > 0 · Not checked yet when > 0; small line = sizes) + "Not listing (n)" link → tabs Products · Sizes (n to
  map) · Jobs (n running) → "What do the statuses mean?" legend.
- **Products:** search (debounced → `?q=`), brand, reason (= `?blocker=`, from `topBlockers`), 25 a
  page (`?p=`) — see "The page (stage 3)" for the filters as they are now. A row: tick, photo, name, style (copy), vendor, Shopify ↗, SHEIN SPU (copy), roll-up
  chip, "4 of 6 sizes on SHEIN" + a bar coloured by status, the worst blocker one-liner (or a status
  sentence), Details, "▸ n sizes". Expanded: one row per size — Size · Shopify stock · Price · SHEIN
  size (or what we'd send: standard / custom, new) · Seller SKU · SHEIN stock · price · Status · What
  to do (the first blocker's title + fix + its button, diffs "was → now", notes, More ▾ → Don't list
  this size on SHEIN). Zero-stock sizes greyed. A product with sizes in review: a violet "n in review"
  chip; a product in a running dry run / send: tick disabled + "In job #n".
- **Buttons:** live = what touches OUR database or opens a page — Add as a custom size (→
  `listing-maps`), Don't list on SHEIN / List on SHEIN again (`exclude`/`include`), Open in Shopify,
  Match sizes, Shopify Listings (PH) — plus the two dry runs (PH ok) and, on the sheet, Confirm /
  Retry (admin or Connect integrations). Everything that belongs to a later phase (Choose
  category, a variant row's Retry / Send again, …) is drawn **disabled** with "Coming in a later phase".
- **Custom-size form** (`CustomSizeModal`): prefilled with the server's D1 suggestion; checks
  `validateCustomText` (≤ 50, half-width, no emoji) + "reads as the same size" on every keystroke and
  disables Confirm; offers SHEIN's own value when one IS the same size (compareSize ok / ok_suffix /
  check_group — never a different number); foot length when the SHEIN product has a size chart. The
  server checks it all again.
- **Drawer** (`?product=`): **Edit this shoe** — one editor for every shoe (2026-11-15, section below; it replaced the
  requirements list: ✓/✕ per group of blocker codes + review + category),
  "What SHEIN will receive" (new sizes first, highlighted; seller-SKU / price "was → now"; new sizes
  at stock 0), history (this product's dry runs / sends: status chip, summary, SHEIN's words, Open →
  the sheet; SHEIN calls, EST). Footer: Don't list on SHEIN / List on SHEIN again (live), **Dry run
  this product** (needs an SPU, SHEIN connected, no job running). No Send button — Send is on the
  sheet. Full-screen under 768 px, sticky footer (84 px kept clear for the advisor button).
- **Sizes:** the Phase 0 probe panel (Ask SHEIN with an optional SPU; the answer table: category ·
  our products · size field · custom allowed · size chart · SHEIN's sizes · custom sizes in the store;
  "asked at … EST", reads / writes) + our sizes grouped Men's · Women's · GS · Kids & toddler · not a
  US size, filtered `?sz=` (needs mapping default · custom · all).
- **Jobs:** running job card (ProgressBar, Stop after this product), history (#, what, started EST,
  by, status, result, took, Open — "Review →" for a dry run waiting for a person — Resume for
  interrupted/stopped snapshot/probe), `?job=` = its items + "Every item (CSV)"; a dry run / send's
  `?job=` renders the sheet's view inline.
- **States:** first-load skeleton; never read ("Nothing read yet" + Check all listings); not
  connected / not configured notices; refresh error keeps the old data with an amber strip; per-filter
  empty text with "Clear all filters" (stage 3 — whole-shoe sentences).
- **Live:** `useLive` on `shein_listing_products/variants/jobs/job_items` + `shein_size_map` (5 s
  fallback while a job runs). Times through `PH_DATETIME` + literal "EST".
- **URL keys:** `tab` (products default | rejected | sizes | jobs | setup) · `status` (§4.1 codes, `excluded` = Not listing) ·
  `any` · `q` · `brand` · `blocker` · `shop` · `sort` · `more` · `p` · `product` · `job` · `sz`. Never: ticks, the custom-size
  draft, the dry-run sheet.
- **Mobile < 768 px:** tiles 2 columns, product rows and size rows become cards, every small table
  becomes label/value cards (`.shl-rtable`), 44 px tap targets, no horizontal scroll at 390 px (e2e).

## Phase 2 — add missing sizes (back end + page built 2026-10-27)
Plan §3 Phase 2 + Appendix A.2; API: `partialEdit` (doc 3002047) and the review webhooks are in
`docs/shein-listing-api-reference.md` (pulled today).
- **Files:** `src/lib/sheinListings.js` → `planAddSizes` (the body builder), `summarizePlan`,
  `sheinNewSizePrice` (D4), `footLengthValue`, `reviewVerdict`, new blockers `size_already_on_shein`,
  `custom_unconfirmed`, `not_on_shein_product`, `nothing_to_add`, `shopify_changed`, `already_sent`;
  `api/_lib/shein-listing.js` → `runPreview` / `runRun` / `runItem` / `didItArrive`, `startRunJob`,
  `applyReview`, `listingFollowUp` (from the tick), `listingReviewEvent` (webhook), `bodyHash`,
  `idemKey`, `isTransport`, `marketPricesFromQuotes`; `api/_lib/shein.js` → `sheinSkusTakenLogged`,
  `sheinFillStandardLogged`, `sheinWarehousesLogged`, **`sheinPartialEditLogged` (the one write)**;
  `api/_lib/shein-live.js` → `pushSpus` + the walk's in-flight rule; `api/shein/webhook.js` → product
  review pushes (`HOOK`, `isProductReviewEvent`); `api/_lib/db.js` → `createRunJob`, `updateListingItem`,
  `markListingItemSending`, `dueRunItems`, `runJobsWithDueItems`, `requeueListingJob`, `listingInflight(Spus)`,
  `markVariantsPublished`, `setVariantsLastError`, `verifySizeMap(ById)`, `sheinLastWalkFacts` (+ published).
- **Blockers added by the API review:** `size_field_unclear`, `size_table_not_yet`, `skc_field_uncopyable`,
  `shein_note` (code-only; wording in `BLOCKERS`).
- **Columns** (`shein_listing_job_items`, ADD COLUMN IF NOT EXISTS): `plan`, `retries`, `sent_at`,
  `sku_codes`, `document_state`, `review_checked_at` (+ index on open statuses). No new table.
- **SHEIN details on every edit (2026-10-28).** partialEdit re-checks the WHOLE product, so a detail SHEIN
  made required after 4seller listed it refused every edit — live run 10/28: 14 of 75 size adds and 19 Nike
  seller-SKU fixes, all "Reflection: The template attribute under type is required." `editAttrs`
  (`shein-listing.js`; template cached 7 d + `shein_attr_defaults` + the associated rules for the values
  it would carry) → `attributePatch` (`sheinPublish.js`): the product's CURRENT details (spu-info's
  `productAttributeInfoList`, sale attributes dropped) + each missing required one from Setup → SHEIN
  details. `product_attribute_list` REPLACES the list (doc 3002047 rule 3), so it is sent whole, and only
  when something is missing — it is a product-level change: SHEIN reviews EVERY colour of the shoe (note
  `attrs_added`, and "+ SHEIN details…" in the dry-run line). Only PICKED values are filled; a missing
  TYPED one (Product Model — per shoe; from the shoe's typed value or its title, never Setup: see "Product Model from
  the title") blocks: `missing_attr`, why `typed_per_shoe`. A required detail with no default blocks too (SHEIN would refuse). Used by
  `planAddSizes`, `planEdit` and the live fix's seller-SKU edit (`sheinSetSellerSkus(…, { attributes })`).
- **What is sent** — ONE `partialEdit` per SHEIN product: every size to add + every seller-SKU relink
  pending for it (`shein_links` → `match 'link'`). **Products only** with ONE SKC, **no size chart**
  (`dimensionAttributeInfoList` non-empty → `size_table_not_yet`: SHEIN needs the whole chart re-sent;
  not supported yet), and whose every SKU carries exactly ONE sale attribute = the template's SKU-level
  size attribute (`attribute_type 1`, `attribute_label ≠ 1`, named like a size; spu-info's first sale
  attribute only breaks a tie) — else `size_field_unclear`. A size goes only if the last read calls it
  **Not on SHEIN** (or an Error from our last try) and, re-checked fresh: SHEIN's own value
  (`attribute_value_id`) or a custom text (`custom_attribute_value`, `language:'en'`) **only from a map
  row a person confirmed** (`set_by` + source person/custom_created) **AND only where SHEIN said
  `has_permission 1` for this category + that size attribute** (else `size_not_on_shein`); the text
  passes `validateCustomText` (≤ 50, printable ASCII with single spaces — no NBSP / zero-width / curly
  / ½ / accents, no emoji) and `customTextConflict` (not a case/spacing look-alike of a store value,
  not one of SHEIN's own sizes); its seller SKU not in the store (`check-supplierSku-repeated`); SHEIN
  doesn't already have that size on the product (by value id OR text); a sibling with box size + weight;
  a price. New SKU = `mall_state 1`, **stock 0** with `supplier_warehouse_id` = our US default
  merchant `warehouseCode` (as doc 3002047's own examples), the nearest sibling's L/W/H/weight (spu-info's
  SKU `length/width/height/weight`), its USD sites, its SKU image / pieces / package type if it has them.
  **Fields an edit CLEARS when left out** (doc: `skc_title`, `competing_product_link` "编辑时不传字段代表清空
  数据"): where fill-in-standard says `skc_title` show, the SKC's title is re-sent as spu-info has it
  (`skc_title` + `skc_multi_language_name_list`); required but nothing to copy → `skc_field_uncopyable`;
  `reference_product_link` show + a relink (or required) → `skc_field_uncopyable` (spu-info doesn't
  return it). **Price (D4):** market + 15 % rounded UP (the Alias price the app already holds in
  `platform_quotes`, ≤ 12 h, consigned first — no outbound call) else the Shopify price — ONE target for
  new sizes and re-sync (the sibling rule was removed 2026-10-27). `sale_attribute_sort_list` = every size in numeric order, only when
  fill-in-standard's `support_sale_attribute_sort === true`. Multi-SKC → `multi_skc_size` (D12).
- **Jobs.** `preview` (mode dry, PH ok): one item per product (≤ 300), each: live Shopify read, fresh
  `spu-info`, size list + permission (24 h cache), `query-publish-fill-in-standard` (cache
  `fill_standard`, 24 h), `query-document-state` (its version saved as `plan.preVersion`),
  `check-supplierSku-repeated`, warehouses once → item `done` (body + `body_hash` sha256 + `plan`) or
  `skipped` (plan says why). Reads only → job `awaiting_confirm` (none sendable → `done`). `run` (mode
  run): created from the dry run in ONE statement (items copied, the dry run marked used — a dry run is
  run once). Per item: possibly-sent (`sending`, or retried with an idem key) → **looked up first**
  (`check-supplierSku-repeated` + `spu-info` + doc state: a NEW version in review since
  `plan.preVersion` also counts as arrived — the seller-SKU check can lag) → found = `in_review`, never
  resent; rebuild → hash ≠ the dry run's → `changed` ("Shopify changed since the dry run — dry run
  again", nothing sent) — `acceptChanges` only lets a PRICE-only difference through; review open (1/5)
  → `deferred` +30 min; claim `sending` + `idem_key` = `<productId>|add_sku|<hash>` (UNIQUE) → the call
  (90 s timeout; body + answer + traceId in `shein_api_log`). **The answer** (`readSendAnswer`): sent =
  `success === true` AND a `version` → `in_review` with the version + `sku_codes` (only OUR new sizes —
  SHEIN lists every SKU, untouched ones with `supplier_sku ""`); its `pre_valid_result` /
  `mcc_valid_result` / `filtered_result` kept as `shein_note` blockers (notes). `success !== true`, or a
  non-zero code (reasons from `info.pre_valid_result` when SHEIN gives them) → `failed`, `shein_prevalid`
  with SHEIN's words, never retried, and the **idem key is released** (a later dry run may send the same
  body again). `success:true` without a version, an answer with no `code`, no answer, 5xx, 429,
  "too frequent", "system busy" → `deferred` and looked up first, retried 5 / 15 / 30 min, `failed`
  (`api_error`) after 5. **The connection refused** (IP whitelist, signature / auth, 401/403, not
  connected — `isFatal`) → the JOB stops (`failed`, "Stopped — SHEIN refused the connection", message
  names Railway); the item stays `sending`, nothing is marked refused; Resume looks first. A run ends
  `done` while items wait; the tick re-queues it when one is due (and resumes a run a restart cut off).
- **Review follow-up** (`listingFollowUp`, from `listingTick` — prod only): every in-review item
  polled with `query-document-state {spuName, version}` at most every 5 min (an answer about another
  version is ignored; a rejection without a version is never applied; `-1` = "SHEIN didn't receive it",
  `shein_prevalid`); SHEIN's pushes
  `product_document_audit_status_notice` / `_receive_status_notice` (verified like every SHEIN push)
  land in `listingReviewEvent` (only for the item with the SAME version; a no-version rejection is left
  to the poll). **Approved** → re-read `spu-info`; once it shows every new size: variants
  `match 'published'` + SHEIN SKU + `synced_hash`, map rows `verified` (a custom value's
  `attribute_value_id` read back; an exact SHEIN value gets a row `source 'exact'`), the SPU cache
  refreshed, item `done`, then ONE stock-only step (`pushSpus` → `stepProduct` mode stock; obeys the
  "Shopify → SHEIN" switch and waits out a walk). The product's own `synced_hash` is NOT set (that
  marks "we published it" for Phase 3's title/image edits). **Rejected / withdrawn** → item `failed`,
  variants Error `review_rejected` with SHEIN's `failedReason`; not received → `shein_prevalid`.
- **Readiness:** a variant in a `sending`/`sent`/`in_review` run item → **In review** (note
  `review_open {sentAt, jobId}`); our last refusal → **Error** (variants' `last_error`; an Error size can be dry-run
  again). **2026-11-17:** SHEIN's own answer (`review_rejected` / `shein_prevalid`) stays until a send of the size is
  accepted, SHEIN approves a photo / model / edit of the shoe, or a person clears it — a Shopify change no longer hides
  it; `api_error` still expires when Shopify changes that size (`lastErrorShown`). `match 'published'` survives later snapshots.
- **Live sync:** `sheinLastWalkFacts()` also returns published sizes no walk has seen (so a Shopify
  change reaches them); for an SPU with a listing item in ANY state (sending / deferred with a key /
  in review) a full walk only sets stock — stock is never skipped (`walkModeFor`); price items don't
  count (price/save opens no document review). Empty tables → identical behaviour (shein-live spec).
- **Sizes form / `listing-maps` (review M1/M3):** a custom spelling is refused for "any category"
  (category or attribute 0), where SHEIN hasn't said `has_permission 1` for that category's size field,
  for a look-alike of a store value or one of SHEIN's own sizes, and for anything but printable ASCII —
  the same `validateCustomText` + `customTextConflict` run in `CustomSizeModal` and on the server.
- **Endpoints** (`POST /api/shein/listings`): `preview {productIds | filter:{status,blocker,q,brand}}`
  (PH ok; filter = products with an SPU) → `{ok, job}` · `run {previewJobId, acceptChanges?}` → `{ok,
  job}` (**403** without admin / `connect_integrations`, **400** without an id, 409 used / another job /
  a walk) · `retry {itemIds}` (same gate) → `{ok, retried, refused:[{id, why}], job}` (only "no answer"
  failures and waiting items; a refusal → "fix it, then dry run again").
- **Item shape** (`GET /api/shein/listing-jobs?id=` → `items[]`; `?product=` → `jobItems[]`): the
  row + `summary` — `"Will add 2 sizes: US 9.5W (custom), US14.5W (custom, new) · relink 1 seller SKU:
  OLD10 → A10 · 1 size skipped: 14.5 (14.5 isn’t a SHEIN size yet)"` — and `plan = { spu, skc,
  categoryId, sizeAttributeId, sizes:[{variantId, size, sizeKey, sku, sheinSize, kind 'value'|'custom',
  valueId, source, mapId, isNew, customExisting, price, priceFrom 'market'|'shopify'|'sibling', qty,
  sibling, foot, sites}], relinks:[{variantId, skuCode, size, from, to}], skipped:[{variantId, size,
  sku, blocker}], blockers, notes, reviewOpen, sortSent, sizeTable, title }`; `status`, `error` (a
  sentence / SHEIN's words), `blockers`, `version`, `sku_codes`, `document_state`, `retries`,
  `next_attempt_at`, `sent_at`. **`body` (the exact request) and `response` (SHEIN's answer) are
  admin-only.** Job `counts`: preview `{products, sendable, skipped, sizes, custom_sizes,
  new_custom_values, relinks, sizes_skipped, review_open, shein_calls, shein_writes}`; run = item
  counts by status + `shein_calls`, `shein_writes`.
- **Go-live (user steps):** prod `db:setup`; subscribe the two product review webhooks in SHEIN's
  console (same callback URL); 4seller paused (D9); then the **pilot** — one product, one custom size,
  dry run shown to the user, then Run.

### Phase 2 — the page (`src/components/SheinDryRunSheet.jsx`)
- **Start:** tick products → selection bar **Add missing sizes** ("· n blocked (their blocked sizes are
  skipped) · n not on SHEIN yet (skipped)"; renamed in Phase 3), or the drawer's **Add missing sizes** → `preview
  {productIds}` → the sheet opens on that job (drawer closes). Disabled while any job runs.
- **The sheet** (not `Modal`; `.shl-drawer.shl-sheet`, 860 px, full-screen < 768 px, Escape / ✕ /
  backdrop close it — the job keeps running on the server). `useLive` on jobs + job_items (3 s while
  running). A dry run while running: ProgressBar + phase. Then the review: `.er-stats` totals from the
  job's `counts`; the proof line `[data-proof]` "**0 SHEIN writes** — this dry run only read (n SHEIN
  reads)" (red + "tell an admin" if `shein_writes` > 0); one `.shl-ditem` per product (`summary`, chip
  from `ITEM_STATUSES.preview`: Ready to send · Nothing to send · Couldn't check; violet line when SHEIN
  is reviewing an earlier edit) → "What is sent": the plan's sizes (our size → ✓ SHEIN size / ✚ custom
  size (new) / custom size (already in the store), seller SKU, price + `PRICE_FROM`, stock 0), SKUs
  SHEIN has wrong, "Not sent (n)" with the rendered blocker; **admins**: "Exact request to SHEIN"
  (`body`) — others never receive it. Footer: Not now · **Add sizes to N products** (N =
  `counts.sendable`, sends `previewJobId`; disabled + `NEEDS_PRIV` title without admin /
  `connect_integrations`). A dry run already confirmed shows "sent as job #n — Open the send".
- **The job card** (same sheet, after Confirm; also Drawer history → Open, Jobs → Open): item chips,
  phase, writes / calls, per product `ITEM_STATUSES.run` (Waiting to send · Sending · In review · Done ·
  Waiting · Not sent · Skipped · Error) + its sentence; `error` verbatim ("SHEIN said: …" + trace for a
  refusal; `ITEM_NO_ANSWER` for a no-answer failure); **Retry** (failed with `api_error`) / **Try now**
  (deferred) → `retry {itemIds}` (admin / priv, `itemRetryable`); **Dry run again** for `changed` and
  SHEIN refusals → a new `preview` of that product, the sheet follows it; Stop; Retry all (n). A run
  that ended with items waiting reads "Sent · waiting on SHEIN", not "Done".
- **Ids:** BIGINT ids come back as strings — the sheet sends `Number(...)` for `previewJobId`,
  `itemIds`, `jobId`.

## Phase 3 — Needs update → Synced (back end + page built 2026-10-27)

**After the API review (2026-10-27, `scratchpad/plan/phase3-review.md`):**
- **Price compared with what the shopper PAYS** (the special when > 0, else the original). A size whose
  SHEIN special is live and off the target is left alone (note `special_live`, not flagged) — sending
  without `specialPrice` ENDS a special, so only a person's dry run with `endSpecials: true` does that
  (`plan.prices[].endsSpecial`, "ends the $X special"). The readiness diff carries `source`.
- **D8a (the automatic re-sync):** MARKET targets only (no Shopify fallback), a cut ≤ 15 % of what the
  shopper pays per EST day and never below the Shopify price (`plan.prices[].capped`, note
  `auto_capped`); only products whose diff `source` is market. Manual dry runs unchanged.
- **Idempotency:** key = product + op + body + SHEIN's state before the send (`sendState`: price base/
  special per SKU; edit preVersion + touched SKUs), and an item SHEIN APPLIED (`done`) frees its key —
  the same cut later is a new send; the same intent twice still can't be.
- **A lost answer on a RISE:** looked up → still the old price → `in_review` (status 2), never resent;
  webhook / poll / 7 days settle it; 7 days → `price_review_stuck` (not retryable). Cuts not shown are
  left for a new dry run.
- Price-audit webhook: `audit_state` 1 = passed, 2 = rejected, else ignored. Promotion locks unread →
  no rise (`price_lock_unread`); `priceLockType 2` → note `price_lock_warn`. A size turned back on gets
  one stock step after approval. Title: the WHOLE multi-language list (spu-info read in every language
  the rules list; a language missing → no title), cut at a word boundary; SHEIN's current title over
  `default_language_title_max_length` → `shein_title_too_long` blocks edits. One market lookup
  (`io.marketTargets`) for the readiness and every dry run. Ops sorted price → edit. `fatal()` no
  longer matches a bare "unauthorized".
Plan §3 Phase 3. Same dry run → run → review flow, gates (`run`/`retry` admin or Connect integrations),
idempotency and look-before-resend as Phase 2.
- **Readiness (D4):** on a SHEIN size, `|target − SHEIN original price| > $0.50` → **Needs update** with
  diff `{ field: 'shein_price', from, to, why }`; target = market + 15 % rounded UP (`platform_quotes`,
  ≤ 12 h, via `io.marketTargets` — one bulk read per recompute), else the Shopify price. (Phase 1's
  "price isn't compared" deviation is gone.) The Shopify-baseline diffs stay. **Changed 2026-11-17 (stage 2):** only a
  MARKET target is Needs update and only market targets are sent by a person's preview too (`buildResync` →
  `marketOnly`); against the Shopify fallback it is the note `price_no_market` — see "The status engine (stage 2)".
- **Dry run:** `POST {action:'preview', productIds|filter, ops:['price','edit']}` (either or both; never
  mixed with `add_sku` → 400) → one item per product per op.
  - `price` (`planPrice`): every on-SHEIN size whose original price is off → `product/price/save`
    `{ productPriceList: [{ productCode: sku_code, currencyCode:'USD', shopPrice, site, specialPrice
    (ALWAYS when the size has one), riseReason:'4' (rises) }] }`. Skipped: a RISE under a promotion lock
    (searchProduct `priceLockType 1` → `price_locked`; a cut still goes), a special price ≥ the new
    price (`special_price_conflict`), a size whose earlier rise SHEIN is still reviewing. Never publishOrEdit.
  - `edit` (`planEdit`): ONE partialEdit — stopped sizes (`mallState 2`) Shopify sells → `{sku_code,
    mall_state:1}` (not within 20 min of a shelf change on that SKC: `shein_skc_shelf.shelf_at` →
    `shelf_wait`), seller-SKU relinks `{sku_code, supplier_sku}`, and the title
    (`multi_language_name_list`, cut to `default_language_title_max_length`) ONLY when
    `shein_listing_products.synced_hash` is set (we published it) — a 4seller product gets the note
    `title_not_ours` (D11); photos → note `images_later`. The SKC title is re-sent when shown; rules
    unread / reference link shown with SKU edits → `skc_field_uncopyable`.
- **Run:** price → `sheinPriceSaveLogged` (strict code, 60 s); per size `status` 1 = done at once, 2 =
  SHEIN's price review (`in_review`), 0 / success false = refused (all refused → `failed`
  `shein_prevalid`, key released; some → notes). Edit → partialEdit + `readSendAnswer` like Phase 2.
- **Review:** price rises — SHEIN's `product_price_audit_status_notice` (`listingPriceAuditEvent`,
  audit_state 1 pass / 2 reject) and a spu-info poll (the new original price showing = approved);
  7 days without an answer → Error. Edits — query-document-state by version + the audit webhook.
  Done (price applied / edit approved) → spu-info re-read into the cache, the variants' `synced_hash`
  committed (`markVariantsSynced`), recompute → **Synced**.
- **D8 "auto re-sync price"** (setting `shein_listing_auto_price` `{on, by, at}`, **OFF** by default):
  `POST {action:'auto_price', on}` (admin / Connect integrations); `summary.autoPrice`. When ON,
  `autoPriceTick` (from `listingTick`, prod) once per EST day STARTS a dry run (`ops:['price']`, by
  `auto (price re-sync)`) of the products with `shein_price` diffs; the next tick RUNS that dry run via
  `startRunJob` — the same path, hash check and idempotency a person uses. OFF → nothing.
- **Shapes for the page.** Item `op` = `price` | `edit` (plus Phase 2's `add_sku`).
  - price `plan = { op:'price', spu, prices:[{variantId, skuCode, skc, size, site, currency, from, to,
    special, rise, priceFrom 'market'|'shopify'}], skipped:[{variantId, size, sku, blocker}], blockers,
    notes, productTitle }`; `sku_codes` after the send = `[{skuCode, site, status 1|2|3, to, variantId,
    reason?}]` (3 = rejected in review). Summary: `"Will change 2 prices: US7 $160 → $170 (up: SHEIN may
    review it), US10 $160 → $150 · 1 size skipped: US7W (In a SHEIN promotion: price can’t go up)"`.
  - edit `plan = { op:'edit', spu, mallOn:[{variantId, skuCode, skc, size}], relinks:[{variantId, skuCode,
    skc, size, from, to}], title: {from, to, language, cut} | null, skipped, blockers, notes, reviewOpen,
    preVersion, productTitle }`. Summary: `"Will turn 1 size back on: US7 · change 1 SKU SHEIN has wrong:
    OLD10 → A10 · title → “…”"`.
  - Preview job `counts` add `prices, price_rises, sizes_on, titles` (with `relinks`, `sendable`,
    `skipped`, `sizes_skipped`, `shein_calls`, `shein_writes`).
  - New blockers: `special_price_conflict`, `shelf_wait`, `nothing_to_edit`, `title_not_ours`,
    `images_later`, `too_many_prices` (+ existing `price_locked`, `review_open`).
- **Go-live (user steps):** subscribe `product_price_audit_status_notice`; prod `db:setup` (no new
  column for Phase 3).

### Phase 3 — the page
- **Diffs, where a person reads them.** A Needs update size's "What to do" = the server's `diffs`:
  `shein_price` → "SHEIN ~~$160~~ → **$149** · market + 15 %, rounded up" (+ violet "↑ SHEIN may review
  it" on a rise); `mall_state` → "Turned off on SHEIN — will turn back on"; `seller_sku` → "SHEIN has the
  wrong SKU: A → will change to B"; a Shopify-side change → "Shopify price changed: … → …". Button
  **Dry run the update** (that product, ops price + edit). SHEIN stock · price column shows "off" and
  was → new. Amber = what SHEIN has now (`.shl-was`).
- **Tiles / `?status=` (decision 2026-10-27, SUPERSEDED 2026-11-17):** a product was listed under EVERY status one of its
  counted sizes has — `shein_listing_products.size_statuses`. Now a tile = the WHOLE shoe (its roll-up status); the
  old list is `?status=<s>&any=1` (see "The list API"). The roll-up chip still shows the WORST status,
  with the blue side chip **"n need an update"**.
- **Two dry runs, named apart** (selection bar and drawer footer, after "Dry run first — nothing is
  sent:"): **Add missing sizes** (`preview {productIds}`, Phase 2) and **Update prices & sizes**
  (`preview {productIds, ops:['price','edit']}`, only the ticked products that need an update). Each
  shows how many ticked products it applies to and is disabled (with why) at 0; the more relevant one
  is primary. Phone: the pair shares one row, Clear · Don't list below it (clear of the advisor button).
- **The sheet for an update** (`DryRunSheet`, `isUpdateOps(job.scope.ops)` or the items' `op`): subtitle
  "Update prices & sizes — what WOULD be sent"; totals = products checked / to update (distinct
  products), prices to change, price rises · SHEIN may review them (violet), sizes turned back on,
  SKUs SHEIN has wrong, titles, sizes skipped; the "0 SHEIN writes" proof. Items are per product per op,
  sorted by product so a shoe's **PRICES** and **SIZES & SKUS** cards (op tag) sit together. Price plan
  table: Size (+ "special price $55 kept") · SHEIN now (amber) · Will be (↑ up — SHEIN may review it / ↓
  down — applies at once) · where the price came from (`PRICE_FROM`). Edit plan: Turned back on (n),
  SKUs SHEIN has wrong, Title was → will change to (only products we published), notes
  (`title_not_ours`, `images_later`), Not sent (n) with each blocker. Confirm **"Update N products"**
  (N = distinct products with a sendable item) — admin / Connect integrations, else disabled with the
  reason. An auto-started dry run says it is sent by itself at the next check.
- **The job card** for an update: per-op words (`OP_SAY`: a price in review = "a price that goes UP
  waits for SHEIN's price review"; done = "SHEIN shows the new price"); the price table gains a SHEIN
  column from `sku_codes` (`PRICE_CODE`: 1 Approved · 2 In review · 3/0 Refused + SHEIN's reason).
  "Dry run again" on an update item re-runs the update ops.
- **Auto re-sync price** (`AutoPrice` in `SheinListings.jsx`, in the connection card, `summary.autoPrice`):
  "Auto re-sync price: Off/On · turned on by X MM/DD h:mm EST" (or "never turned on"). Admin / Connect
  integrations: **Turn on…** → a confirm (`FormModal`, portalled) explaining once a day EST → a dry run →
  sent at the next check, rises may be reviewed, sizes/SKUs/titles never automatic; **Turn off** is
  immediate. Everyone else: the state + "An admin (or the Connect integrations privilege) can change this."
- **Jobs tab:** a dry run reads "Dry run · add sizes" / "Dry run · update prices & sizes" (`jobLabel`);
  an update's result line counts changes, prices (up), sizes back on, SKUs.
- Copy in `src/lib/sheinListings.js`: `OP_LABEL`, `OP_SAY`, `PRICE_CODE`, `isUpdateOps`; a summary with
  only skipped sizes now leads "Nothing to send · n sizes skipped: …".
- e2e (`shein-listings.spec.js` → "Phase 3 — the page", +4): PH sees the diffs (SHEIN $160 → $149,
  turned off → back on, wrong SKU, ↑ rise) + the drawer's "was …" + auto re-sync read-only; PH update dry
  run → price lines (rise flag, price source, special kept, skipped reasons), totals, Confirm disabled,
  Jobs label; 390 px no horizontal scroll (rows, sheet, drawer); admin toggle round trip (Cancel changes
  nothing, on → who/when, off) + confirm → job card (cut Approved, rise In review per size).

## Phase 4 — publish brand-new products (back end + page built 2026-10-27)
Spec: `scratchpad/plan/phase4-spec.md` (API specialist; raw pages `scratchpad/p4docs/`); plan §3 Phase 4.
- **Files:** `src/lib/sheinPublish.js` (PURE: `planPublish` → `{ body, plan, checklist }`, `publishChecklist`,
  `publishReadiness`, `imagePlan` / `imageConversions`, `templateParts`, `buildAttributes`, `fillRules`,
  `cleanTitle` / `cleanDescription`, `sizeGroupOf`, `BOX_PLACEHOLDERS`, `validateBoxDefaults`);
  `api/_lib/shein-publish.js` (I/O: `publishGates`, `categoryTree` / `treeLeaves`, `fillFor`, `templateFor`,
  `permissionFor`, `assocRequired`, `brandList`, photos `padPhoto` (1500×1500 white, JPEG 88, never cropped,
  < 600 px refused) → `hostOnR2` → transform-pic (`convertPhotos`, cache kind `pic` key
  sha256(source + render version):type), `buildPublish`, `readPublishAnswer`, `mapRefusal`,
  `publishApproved`, D6 `readBoxDefaults` / `saveBoxDefaults`); `api/shein/listing-meta.js` (new);
  `api/shein/listing-maps.js` (`type=category|attr|brand|box`); `api/_lib/shein.js` (the reads, the ASSET
  call `sheinTransformPicLogged`, the write `sheinPublishLogged`); `api/_lib/shopify.js`
  (`shopifyListingProduct` + `descriptionHtml`, `options`, `images[{url,width,height,alt}]`).
- **Tables** (`db-setup.mjs`): `shein_category_map` (Shopify product type + size group adult|women|youth|
  child|toddler → leaf `category_id` + `product_type_id` + path; live), `shein_attr_defaults` (per SHEIN
  product type + attribute: `value_ids`, `extra_values`, `stale`), `shein_brand_map` (lower-cased vendor →
  `brand_code`; live); `shein_listing_products` + `title_override`, `skc_value_id`, `use_ph_photos`,
  `publish_again_by/at`; `shein_api_log.asset`. D6 lives in `app_settings.shein_box_defaults` (stored in cm / g, what SHEIN takes). **Since 2026-10-27 the page shows and takes inches / pounds** (the team's default box: 16 × 12 × 6 in, 4 lb) and converts on save (`boxToImperial` / `boxFromImperial` in `src/lib/sheinPublish.js`); the dry-run sheet shows the box in in / lb too. **Since 2026-10-28: at most 30 in a side / 30 lb** (`BOX_MAX_IN` / `BOX_MAX_LB`, checked on save AND on read — a box saved before the limit, like the prod toddler length typed as 166 in, reads `confirmed:false` + `problem` and blocks publishing); saving the box recounts every product at once (`recomputeStored`, DB only), so `box_unconfirmed` clears without a Re-read.
- **Flow** (op `publish`, alone): dry run = store gates (check-publish-permission, publish quota, shelf
  quota, site list, warehouse; cached 1 h, read FRESH by the run) → category (map + tree leaf check; no map →
  image-category-suggestion) → fill-in-standard + template (7 d) + associated rules (≤ 3 rounds) → brand →
  sizes (Phase 2's resolver; custom only confirmed + permission 1) → check-supplierSku-repeated → D4 price
  (market + 15 % up, else Shopify) → D6 box → photos (only when nothing else blocks) → the body (spec §2).
  The run rebuilds it (hash check), re-checks SKUs, claims the key (`…|publish|hash|sha(skus)`), sends
  publishOrEdit; sent = success + spu_name + version → saved AT ONCE (product `spu`, `review_version`) → In
  review (spu-info shows nothing until approval). Lost answer → deferred ≥ 5 min → our SKUs repeated =
  arrived (never sent twice); the receive webhook fills the SPU. Approved → sizes `published`, product
  `synced_hash` (OURS), size maps verified, one stock step, compliance list → note `compliance_missing`.
  Rejected → `review_rejected`; a new publish needs an admin's **Publish again** (`publish_again`).
- **Readiness (no SHEIN call):** a product not on SHEIN is evaluated from the cache — no category,
  brand, title, colour, attributes, sizes against the mapped category, prices, D6, photos count → its sizes
  read **Blocked** with those reasons (before: "Not on SHEIN" + a note).
- **Endpoints.** `POST /api/shein/listings`:
  - `preview { productIds | filter, ops:['publish'] }` (PH; filter = products NOT on SHEIN; never mixed → 400);
  - `run` / `retry` as before (admin / Connect integrations);
  - `publish_choices { productId, titleOverride?, skcValueId?, usePhPhotos? }` (PH, DB only) → `{ok, product}`;
  - `publish_again { productIds }` (admin / Connect integrations) → `{ok, products}`.
  - `GET ?product=` adds `checklist` (below) + `checklistFrom: { jobId, at } | { readiness: true }`.
  `GET /api/shein/listing-meta`: `?category=<leaf>` → `{category:{categoryId, productTypeId, path}, fill,
  template, parts:{mainStatus, sizeAttributeId, required:[ids], sizeTable}, permissions, readAt}` · `?tree=1`
  → `{leaves:[{categoryId, productTypeId, path}] | null}` · `?brands=1` → `{brands:[{brand_code, brand_name}]}`
  · `?gates=1` · `?suggest=<productId>` → `{suggestions:[{categoryId, order, vote, path}]}`; `refresh=1` =
  admin / Connect integrations (re-reads SHEIN), else the cache.
  `listing-maps`:
  - `?type=category` GET `{maps, leaves, groups, usage:[{productType, products}]}` · POST `{action:'set',
    productType, sizeGroup, categoryId, suggestion?}` (a LEAF of the cached tree; 409 tree unread) | `clear`;
  - `?type=attr&productTypeId=` GET `{defaults, template:{attributes:[{attributeId, name, type, mode, status,
    inputNum, dataDimension, values:[{id,label}]}], main, mainStatus}}` · POST `set {productTypeId, attributeId,
    valueIds?, extraValues?}` (validated against the template: mode 3 one value, mode 1 ≤ input_num, mode 0
    typed, mode 4 pairs / sum 100) | `clear` | `seed {productTypeId, spu}` → `{proposed:[{attributeId, name,
    valueIds, extraValues}], saved:false}` (one of OUR approved SHEIN products, read only);
  - `?type=brand` GET `{maps, brands, vendors:[{vendor, products}]}` · POST `set {vendor, brandCode}` (must be
    in SHEIN's list) | `clear`;
  - `?type=box` GET `{box:{groups:{adult,youth,child,toddler:{length,width,height,weight}}, confirmed, by, at},
    placeholders}` · POST `{groups}` (admin / Connect integrations; saving CONFIRMS — unconfirmed blocks every
    publish with `box_unconfirmed`).
- **Plan** (item `plan`, op `publish`): `{ op, productId, title:{text, max, overridden}, description:{length},
  category:{id, productTypeId, path}, brand:{code, name} | null, skcValue:{id, label}, sizeGroup,
  sizeAttributeId, sizes:[{variantId, size, sku, sheinSize, kind, valueId, source, mapId, sizeKey, price,
  priceFrom, qty}], skipped:[{variantId, size, sku, blocker}], attributes:[product_attribute_list rows],
  box:{group, length, width, height, weight, confirmed}, imagePlan:{newPlan, need, sku}, images:[the SKC
  image_info_list], photos:{source 'shopify'|'ph_edited', count, converted, cached}, quota:{controlled,
  available, uses}, supplierCode, blockers, notes, checklist }`. Summary: "Will publish “…” with 4 sizes:
  US9 $110, … · 4 photos · uses 1 of 5 publish quota" / "Can’t publish yet: <first reason> (+n more)".
- **Checklist** (18 lines, spec §5): `[{ n, key, label, ok: true | false | null (not read yet), blockers:
  [rendered + params] }]`, keys `store quota shelf site shopify category brand title colour attributes
  size_chart sizes skus prices box photos fields flight`. Publish only when all are ✓; 1–4 are store-wide.
- **Counts** (preview job): + `publishable`, `publish_sizes`; `shein_api_log` asset rows count photo
  conversions (`countSheinApiLog` → `assets`) — the proof line "0 SHEIN writes · n photos converted".
- **New blockers:** `fill_required`, `mixed_size_groups`, `no_warehouse`, `brand_unset` (note),
  `compliance_missing` (note), `publish_rejected`, `publish_in_flight`, `box_unconfirmed`; `title_too_long` is
  now BLOCKED (with `why:'too_short'`).
- **After the API review (2026-10-27, `scratchpad/plan/phase4-review.md`):**
  - **A publish is NEVER resent by itself (F1).** No answer / an unreadable answer / a crash mid-send →
    item `failed` + `publish_unconfirmed`, key KEPT, `sent_at` set. **Look again** (`POST {action:'look_again',
    itemIds}`, PH ok, reads only: check-supplierSku-repeated + document state when the SPU is known; the
    receive webhook also attaches) → found = In review. **Send again** (`send_again`, admin / Connect
    integrations) unlocks only after a SECOND look ≥ 30 min after the send found nothing
    (`response.looks`, `response.send_again_ok`); it releases the key and re-queues the run. A whitelist /
    signature stop stays as before (deferred, Resume — the request never reached SHEIN). `retry` refuses
    publish items. Page: Look again / Send again on the item (`itemUnconfirmed`, `itemCanSendAgain`).
  - **Brand (F2, D5):** an unmapped vendor BLOCKS (`brand_unset`, line 7). A person may mark a vendor
    "no brand" (`listing-maps?type=brand {action:'no_brand', vendor}`; `shein_brand_map.no_brand`, brand_code
    NULL) — refused (400) for a known brand (`KNOWN_BRANDS` in `src/lib/sheinPublish.js`, data). A brand
    SHEIN's rules hide (`brand_code.show:false`) → `brand_not_authorized {why:'hidden_by_rules'}`. GET brand
    adds `vendors[].knownBrand`, `knownBrands`. Page: "Mark “no brand”" in the brand picker (generic vendors only).
  - **Checklist:** a line SHEIN's rules haven't been read for is `null` — never ✓ by default; `GET
    ?product=` computes the readiness checklist LIVE from the cache (`readinessChecklist`).
  - S1 no empty `image_info`; S2 `weight_config` units parsed (`unit_unverified` note when unreadable); S3
    SHEIN's emoji range in titles; S4 a dry run judges each product alone (`need` 1; counts `quota_uses`,
    `quota_available`); S5 approved-but-not-shown → Error after 24 h; S6 1Y–3Y = PS (`child`); S7 the brand's
    own quota (exempt → no quota block, `plan.quota.brandExempt`); S8 suggestion cached per product 24 h
    (`cat_suggest`); S9 the SKC title's own per-language limit.
- **Go-live (user steps):** prod `db:setup`; an admin reads the tree / brands (`listing-meta …&refresh=1`),
  maps a category + brand, sets the attribute defaults for the product type, and **confirms the D6 box
  sizes**; then the spec's safe pilot (one men's sneaker, SHEIN sizes only, no size chart).

### Phase 4 — the page
- **Drawer** (`?product=`, a Shopify shoe with no SPU): "What publishing needs" = the server's `checklist`
  (never recomputed in the browser), grouped "The store" (1–4) / "This product" (5–18); chips n ✓ · n to fix
  · n not read yet; source line = `checklistFrom` (dry run #N + EST time, or "From our records"). Each line ✓ /
  ✕ / – (not read yet — the dry run checks it). Fixes inline under the line: **Choose category**
  (`CategoryPicker`: SHEIN's suggestion from `listing-meta?suggest=` first, then the cached leaf tree searched by
  path, shoe leaves by default; saves `listing-maps type=category` for the product's Shopify type + size group;
  tree unread → admin "Read SHEIN's categories (read-only)"), **Map to a SHEIN brand** (`BrandPicker`, SHEIN's
  list only; Seller Center link), **Review title** (`TitleEditor`, counter "n of max", `publish_choices
  titleOverride`, "Use the Shopify title" = null), **Pick the colour** (`ColourPicker`, the template's main
  attribute, `skcValueId`), **Set SHEIN details** (`AttrEditor`, per SHEIN product type: one value / several ≤
  inputNum / typed / value + %, Required first, blocker-named ids marked "Required with your other choices";
  "Copy from this product" = `seed` → drafts marked "Copied from SPU — not saved" → review → Save / Save all
  changes), **Confirm box sizes** (`BoxDefaults`), **Use PH edited photos** (checkbox, `usePhPhotos`), **Publish
  again** on line 18 (admin / priv). Other ✕ lines keep the blocker's own button (custom size, Shopify links). A
  saved fix shows "Saved — checked again by the next dry run" (the checklist only changes with a new dry run /
  re-read). Footer: Don't list on SHEIN · **Publish new product** (dry run, `ops:['publish']`).
  A shoe WE published (SPU, latest publish send in review / refused / rejected) gets a "Published from this page"
  section: In review since …, or SHEIN's reason + **Publish again** (admin / priv: `publish_again` → a fresh dry
  run) + Open the send.
- **Products tab:** the selection bar's third dry run **Publish new products** (count = ticked shoes with no SPU,
  not excluded), separate from Add missing sizes / Update prices & sizes; the largest of the three is primary.
  Row fix buttons of the publish kinds (`PUBLISH_FIX_KINDS`) open the drawer.
- **Setup tab** (`?tab=setup`): store gates as cached (Ask SHEIN again = `gates=1&refresh=1`, admin / priv);
  **Box size and weight** with the banner "UNCONFIRMED — placeholders, publishing is blocked until someone
  confirms" (inputs + "Confirm these box sizes" only for admin / Connect integrations; others read
  `NEEDS_PRIV`); categories per Shopify type × the 5 size groups (Choose / Change / Clear); brands per vendor;
  SHEIN details per mapped product type (`?pt=`).
- **Store-gate banner** (all tabs, `useStoreGates` → `listing-meta?gates=1`, cache): SHEIN refuses new listings /
  publish quota 0 / shelf full → "SHEIN isn't taking new products right now" + SHEIN's words; dry runs still run.
- **Sheet** (op publish): stats products checked · ready to publish (`publishable`) · sizes (`publish_sizes`) ·
  can't publish yet · photos converted · "uses N of M publish quota left this month"; proof **"0 SHEIN writes · n
  photos converted"** (n = Σ item `plan.photos.converted` — the job counts carry no `assets`); per product: the
  summary, chip Ready to publish / Can't publish yet, `PublishPlan` (its ✕ checklist lines, title + length,
  category path, brand, colour, size group, box, details count, quota, `SB12-P…`, the SKC photos with type,
  "n source photos from Shopify / PH edited · n converted · n already converted", sizes: SHEIN size / Custom
  size, seller SKU, price + where from, stock 0). Confirm **"Publish N products"** (admin / priv). Run: In review
  (OP_SAY.publish) → Approved, or **Rejected** + "SHEIN said: …" + **Publish again** (admin / priv). Jobs label
  "Dry run · publish new products". The run's header chip / phase follow the item counts (SHEIN's review answers
  come after the job ended).
- e2e (`shein-listings.spec.js` → "Phase 4 — the page", +8): checklist ✓/✕/not read yet with fixes + category
  pick saved (SHEIN's suggestion); box banner unconfirmed + PH can't save + the blocked dry run ("Can't publish
  yet", ✕ lines); brand + details set in the drawer → full dry run sheet, PH Confirm disabled; admin Publish 1
  product → In review → Rejected with SHEIN's reason; PH can't Publish again / save box (403 too); admin Publish
  again → fresh dry run Ready; store-gate banner; 390 px no horizontal scroll (drawer + picker, Setup, sheet).

## Bulk edit before publishing + the Shopify active filter + the listing syncs' stock gate (built 2026-10-28)

**Photos + "Use PH edited photos" (fixed 2026-10-28):** the readiness counted Shopify's photos only
(`imageCount`), so turning PH photos on never cleared "Only 1 photo, SHEIN needs 2" — while the dry run
does send the style's PH photos (`product_photos`, source `ph_edited`; none → Shopify's). `publishContext`
now loads the PH photo count per style (`phPhotoCounts`) and, with the choice on, counts those; with none
the `no_image` line says the PH team has no edited photos for that style (no "Use PH photos" button).
`loadListingPrev` now carries `title_override` / `skc_value_id` / `use_ph_photos`, so the stored list rows
are judged on the choices too, and `publish_choices(_bulk)` recount at once (DB only).
- **Shopify filter** (Products, `?shop=active|inactive`, refresh-proof; default All): chips "All · Active (in stock) n ·
  Inactive or no stock n" (counts = `shopifyCounts`). Same rule client side: `rowSyncable(row)` (`shopify_status` ACTIVE
  and `counts.sizes` > 0) in `src/lib/sheinListings.js`.
- **The stock gate** (`listingSyncGate(product, excludedIds)` — pure, `src/lib/sheinListings.js`): the LISTING syncs
  never send a shoe Shopify has inactive (`shopify_inactive`) or at 0 pairs across its sizes not left off (new blocker
  **`no_shopify_stock`**, "No Shopify stock — not sent to SHEIN."). Enforced by the server: `buildItem` (Phase 2 add
  sizes + Phase 3 price / edit) checks the LIVE Shopify read before any SHEIN call → the item is skipped;
  `planPublish` puts it on checklist line 5 (now "Active on Shopify, with stock"; `shopify_inactive` now blocks a
  publish too — it was a note, so a draft could pass). `publishReadiness` keeps `no_shopify_stock` OFF the stored
  sizes (a sold-out new shoe is not "Blocked" on the list). The ticked-products bar leaves such shoes out of all three
  dry runs and says "n left out: no Shopify stock / not active on Shopify". **The STOCK sync is untouched**
  (`shein-live.js` walk / push, `shein-orders.js`): a shoe going to 0 still has SHEIN set to 0. Note: Phase 3 relinks
  of a 0-stock shoe wait too (they ride on the same dry run).
- **Bulk edit** (`src/components/SheinBulkPublish.jsx`, in memory, never in the URL): bar → **Bulk edit (n)** = the
  ticked shoes on this page that `canPublish` and `rowSyncable` (≤ 100; the rest listed under "left out — why").
  ONE read: `GET ?publishSetup=` → `{ products:[{ productId, title, titleOverride, style, vendor, productType,
  imageUrl, shopifyStatus, inStock, sizes, syncable, sizeGroups, category{categoryId, productTypeId, path}|null,
  productTypeId, skcValueId, usePhPhotos, titleMax (only when SHEIN's rules were read), checklist (the 18 lines,
  `readinessMany` = the drawer's readiness for many at once), blocking:[line keys ✕], ready, shopifyUrl }] (not
  ready first), skipped:[{productId, title, why}] (on SHEIN already · SHEIN-only · "Don't list" · unknown) }`.
  Table: photo, title (editable inline), style, type · size group, vendor, a chip per ✕ line. **Fix in bulk**, each
  keyed so one decision covers many shoes: Category per (Shopify product type × size group) → `CategoryPicker` once
  ("applies to N"; mixed size groups / no readable size are called out, they can't be mapped) · Brand per vendor
  lacking a map → `BrandPicker` · SHEIN details per SHEIN product type → `AttrEditor` · Colour per SHEIN product type →
  one select, set on every ticked shoe of that type · Photos: PH photos on / off for all · Titles: `tidyTitle`
  preview (cleanTitle + cut at the last whole word within SHEIN's limit when known) → apply · Box: `BoxDefaults`
  (saving still admin / Connect integrations). Every save re-reads (live: category / brand map, products,
  app_settings). Footer **Dry run publish (n ready)** = the same `preview ops:['publish']` for the ready ones only.
- `POST publish_choices_bulk { productIds ≤ 100, patch:{ skcValueId?, usePhPhotos? }, productTypeId?, titles?:{ [id]:
  title|null } ≤ 100 }` (PH, DB only, same gate + validation as `publish_choices`; `patch.titleOverride` → 400 "per
  shoe"; a colour needs `productTypeId`, every product must map to that type, and the value must be in the cached
  template) → `{ ok, updated, missing }`.
- **Safety net (publish never starts on a shoe that needs fixing):** the bar's button reads **Fix & publish (n)**
  when a ticked new shoe is Blocked / Error; on click it reads `?publishSetup=` and goes straight to the dry run only
  when EVERY ticked new shoe is ready, else it opens the bulk sheet on the fix step ("n can't be published yet — fix
  them first", not-ready first). The drawer's button reads **Fix n first** when its LIVE readiness has ✕ lines (not
  the last dry run's checklist, which a fix doesn't change); pressing it scrolls to the checklist with what's left, plus
  "Dry run anyway" (sends nothing). The dry run still refuses blocked ones (the server is the last guard).
- **Category picker favourites:** "Frequently used" on top of every `CategoryPicker` (drawer, Setup, bulk) —
  Men's Casual Athletic Shoes, Women's Casual Athletic Shoes, Kids' Sneakers, found in SHEIN's cached tree by
  `favouriteLeaves(leaves)` (`src/lib/sheinPublish.js`, `FAVOURITE_CATEGORIES`): leaf name words + audience by whole
  path words (Women ≠ men; kids/boys/girls/youth… = kids). Never a hard-coded id; one SHEIN's tree lacks is not shown.
- e2e (`shein-listings.spec.js`): pure (gate, rowSyncable, checklist line 5, favourites, tidyTitle); Phase 4 page
  (publishSetup gates / cap / skipped / DB only; publish_choices_bulk validation + colour type check + DB only; the
  Shopify filter + counts; the gate skips publish / add sizes / update with no SHEIN read for the item; 390 px filter +
  bulk sheet); the box-banner test now goes bar → fix step (no dry run) → drawer "Dry run anyway".

## Leave a photo out before publishing (built 2026-11-11)
**Why:** SHEIN rejected many publishes for the PH-branded photos (brick background, shoe name + style, store logo):
“picture: The image contains watermark information.” and “Banned: … false service promises …”. A person now picks
the photos SHEIN must not get.
- **Column:** `shein_listing_products.photo_skip TEXT[]` (default `{}`) = photo KEYS — `photoKey(url)` = the URL
  without `?query` / `#hash`, host lower-cased (Shopify's `?v=` changes on re-upload). Pure helpers in
  `src/lib/sheinPublish.js`: `photoKey`, `keepPhotos(urls, skip) → {urls, skipped}`, `countAfterSkip(count, skip, ph,
  phKeys)`, `isShopifyPhoto`, `PHOTO_SKIP_MAX` (40).
- **Publish:** `buildPublish` drops left-out photos BEFORE the 11-photo cut and the conversions (never fetched, hosted
  or transform-pic'd); `plan.photos.skipped` = how many (the sheet says “n left out by you”). Photo 1 of what's left is
  the main photo.
- **Readiness:** `publishContext` loads the PH photo keys per style (`phPhotoKeys`, replaced `phPhotoCounts`) and takes
  the left-out photos of the source in use off the count → `no_image` (“Only n photo”) appears at once (saves recount).
- **Endpoints** (`api/shein/listings.js`, PH ok, our DB only):
  - `GET ?photos=<gid>` → `{ source 'shopify'|'ph_edited', usePhPhotos, style, shopify:[{url,key,width,height,skipped}],
    ph:[{url,key,angle,skipped}], sent, max 11, stale:[{key, shopify}] }` — Shopify's photos read LIVE
    (`shopifyListingProduct`) + `product_photos` (ph_edited) for the style; never SHEIN. `shein:` ids → 400, unknown → 404.
  - `publish_choices { productId, photoSkip: [https url] }` (≤ 40; non-https / not a list → 400) — the FULL list, keyed.
  - `publish_choices_bulk { productIds, patch: { skipCover: true|false } }` — adds / removes each shoe's stored cover
    (`image_url` = Shopify's photo 1) on its `photo_skip` (`setListingCoverSkip`); `publishSetup` rows carry
    `photoSkip` (count) + `coverSkipped`.
- **Page:** `src/components/SheinPhotoPicker.jsx` — a grid (photo 1 = main), tap a photo to zoom (`ImageZoomModal`),
  **Leave out / Put back** per photo, “n of m photos go to SHEIN”, a warning under 2, stale left-outs → “Forget
  them”. Where: the drawer checklist's photo line (**Choose photos**, line shows “n photos left out”), the drawer's
  “Published from this page” section of a refused / rejected publish, and the bulk sheet's Photos block (**Leave out
  the cover on all n** / Put the cover back on all).
- e2e (`shein-listings.spec.js`): pure helpers; publish_choices photoSkip validation + the preview never converts the
  left-out photo + readiness `no_image` at once; bulk `skipCover`; the drawer picker (Shopify read stubbed) + 390 px.

## Clean photos — the shoe on white, no text (built 2026-11-14)
**Why (owner, 2026-11-13):** on many shoes EVERY photo — Shopify's and the PH edited set — carries the PH brand
template (brick wall, name + style code, logo), plus the spec list (photo 6) and the welcome card (photo 7). SHEIN
rejects them ("Image contains promotional information", "watermark"); leaving them out left 0–1 photos.
- **Where clean photos come from:** the brand tool (Image Finder → Brand & Fill, `api/images/brand.js`) cuts every
  shoe out of its catalogue photo and stages the transparent PNG on R2 at `listings/<sku>/_cut/<ms>-<rand>.png`.
  Since 2026-11-14 its **Upload** records the cutout behind each angle in **`product_cutouts`** (sku, angle, url,
  origin `brand`, how `upload`, taken_at) — one per (sku, angle), replaced when the angle is re-branded. Kept OUT of
  `product_photos` on purpose: every thumbnail / `photo_count` / receiving query reads that table with no source filter.
- **Older shoes (recovered):** `findCleanPhotos` (`api/_lib/shein-clean-photos.js`) lists the R2 folder (`listObjects`
  in `r2.js`, read only), then matches each cutout to the uploaded branded photo of each angle **by picture**: the cutout
  placed where Brand & Fill puts it by default (`fitShoeBox`), compared over the shoe's own pixels at 200 px (the right
  one scores 2–14, any other angle ≥ 25; `MATCH_MAX` 18) → how `checked`. A shoe PH moved / resized on the canvas
  matches nothing; then the R2 timestamps (`recoverCutouts`, pure: the last session of cutouts before the upload, one
  per uploaded angle in `SHOE_ANGLES` order) fill it — only when that session is exactly one cutout per angle AND agrees
  with every picture match → how `timestamp` (the picker says "angle by order"). Otherwise the angle is left out.
  Measured 2026-11-14 on the 1,086 PH-edited styles: timestamps alone are exact for 1,027 (94.6 %), 53 have extra
  cutouts (re-cuts / re-renders), 6 none; the picture check resolved the extra-cutout ones (where timestamps picked the
  WRONG cutouts for at least 2 of 4 sampled styles).
- **Run it:** per shoe — drawer → Choose photos → **Find clean photos** (`find_clean_photos`, PH ok, writes
  `product_cutouts` only); in bulk — `node scripts/shein-clean-photos.mjs` (dry run; `--apply` records; `--all` = every
  PH-edited style, default = the styles on SHEIN Listings; `--sku X`; `--redo`). ~10 MB of photos read per style. Never
  writes or deletes on R2; a recovered cutout never replaces one the brand tool recorded. **2026-11-17:** skipped when
  `product_cutouts` already covers every uploaded angle (`why: 'already_recorded'`, no R2 call); "nothing found" is
  remembered per style (cache kind `clean_find`, keyed on the newest cutout + newest upload — the second click answers at
  once, `why: 'nothing_found_before', cached: true`); only the LAST session of cutouts before the upload is scored
  (`recoverCutouts` → `session`, ≤ 20) instead of the newest 20 ever staged; `--redo` (`redo: true`) always looks.
- **Which photos SHEIN gets** (`photoSourceOf`, `src/lib/sheinCleanPhotos.js`; shared by `sourcePhotos`, the readiness
  and the picker): `shein_listing_products.clean_photos` NULL = automatic → **clean** whenever the style has any; true =
  on; false = a person switched them off → `use_ph_photos` picks PH edited vs Shopify. An explicit "Use PH photos" /
  "Shopify photos" (`usePhPhotos`) switches clean off. The **spec / welcome slides (`extra1` / `extra2`) are never sent**
  (filtered from the PH source and from `phPhotoKeys`).
- **The render:** a clean photo (`isCutoutUrl`) is trimmed to the shoe and centred on a white 1500 × 1500, the shoe 86 %
  of the long side (`renderClean`, cache key `CLEAN_RENDER_VERSION`); every other photo is padded as before.
- **Shopify's copies of the PH slides:** `imageSig` = a grey 16 × 16 box average (cached per photo, cache kind
  `photo_sig`); a Shopify photo within `SAME_PHOTO_MAX` (2) of a PH photo is a copy of it (measured: copies ~0.7,
  other angles ≥ 3.6). GET `?photos=` marks each Shopify photo `phCopy { angle, slide }` (≤ 6 s of reading, the rest
  next time); bulk `skipSlides` compares Shopify's photos (from `shopify_json`) with each style's extra1 / extra2 (≤ 25 s,
  4 a minute per user) and adds the matches to `photo_skip`.
- **Endpoints:** `publish_choices { photoSource: clean | ph_edited | shopify | auto }`; `publish_choices_bulk { patch:
  { cleanPhotos: true|false|null, skipSlides: true } }` → `slides { shoes, photos, unchecked, noSlides }`;
  `find_clean_photos { productId }`; `publishSetup` rows + `cleanPhotos, cleanCount, cleanOn`; GET `?product=` →
  `product.clean_count`.
- **Readiness:** `publishContext` counts the clean photos when they are the source (`cleanPhotoKeys`); `no_image` params
  `src` / `clean` → "Only n clean photos" or, when clean ones exist but are off, the action **Use clean photos**
  (`use_clean_photos`, in `PUBLISH_FIX_KINDS`; the drawer saves `photoSource: 'clean'`).
- **Page:** `SheinPhotoPicker` — "Photos SHEIN gets": Clean · PH edited · Shopify (with counts), clean photos labelled by
  angle, a warning when the set in use is PH-branded, **Find clean photos** when there are none, Shopify's copies of the
  spec / welcome slides named + **Leave out the spec + welcome slides**. Checklist photo line says which set SHEIN gets
  (the "Use PH edited photos" checkbox is gone — the picker switches). Bulk sheet Photos block: **Use clean photos on all
  n**, **Leave out the spec + welcome slides on all n**, the cover and PH / Shopify buttons as before.
- **The main photo (fixed 2026-11-14, live Nike run):** a cutout's angle is only PH's brand-tool SLOT — PH often fills
  the slots in the catalogue's gallery order (IF1721-300: the "3/4" slot holds the sole, the "sole" slot the inner side;
  IO6253-500 the same; 394055-101: the "side" slot is a 3/4 pair). The picture match only proves which cutout made
  which branded slot, so it copied PH's mistakes. Now each cutout's own outline is measured (`shapeOf` → `shape` JSONB
  on `product_cutouts`: ar, fill, topM, botM, gap; recorded by the brand tool's Upload and by `findCleanPhotos`,
  measured on first use for older rows — `ensureShapes`) and `viewOf` reads it as side / sole / pair (a side profile
  has a low toe and high collar → topM ≥ 0.2, stands on its sole → botM ≤ 0.035, or on studs ≤ 0.06 with topM ≥ 0.25).
  Checked by eye on 66 PH sets: every cutout it calls a side view is one (incl. inner sides filed under other slots);
  it rejects the 3/4 views. **Photo 1** = `cleanOrder`: a person's **Make main photo** (`clean_main`), else PH's side
  slot when confirmed (picture / Upload) AND its outline is a side view, else another confirmed slot showing a side
  view, else one filed only by order whose outline is a side view (`side_view_by_order`, said in the picker). Never a
  slot label alone. None → **`clean_main_unsure`** ("Check the main photo", photo line 16, action `fix_photos`): the
  publish and the photo replace are held before anything is converted. **2026-11-17 (stage 2): ONE rule for the stored
  readiness and the preview** (the readiness used to be lenient for an unmeasured shape while the preview was strict — the
  page said ready, the preview refused; high-tops at ar < 1.45 and a shadow under the sole failed `viewOf`): a confirmed
  "side" slot (picture match or Upload) is photo 1 unless its outline POSITIVELY reads as a sole or a pair (`NOT_A_SIDE`),
  measured or not; `lenient` is ignored. Risk accepted: a single 3/4 shoe filed in a confirmed side slot reads `null` and now
  goes as photo 1 (none in the 53 side slots measured on 2026-11-14). Sample of 66 styles: 64 get a side-view main, 2 are held (no side view uploaded:
  394055-101, FD8315-500). Picker: labels say what a photo shows ("side view", "sole", "pair", else "PH slot: 3/4"),
  a by-order cutout carries an **unconfirmed** badge, **Make main photo** / **Pick automatically**, the "Check the main
  photo" banner. Swapping two non-main slots is not built (SHEIN only treats photo 1 specially). DB: `product_cutouts.shape`,
  `shein_listing_products.clean_main` — **prod needs `db:setup`**. The backfill prints `[S]`/`[o]`/`[p]` + `main=` / `MAIN?`.
- **Fix photos scroll (bug):** on a never-live / rejected shoe the drawer's "Fix photos" now scrolls to and focuses the
  picker that is open (`#shl-pub-photos` in "Published from this page"; `#shl-photos-sec` for a live shoe; else the
  checklist's photo line). It used to scroll only to the live section.
- **DB:** `product_cutouts` (+ `LIVE_TABLES`), `shein_listing_products.clean_photos`. **Prod needs `db:setup`**, then the
  backfill (`--apply`).
- e2e (`shein-listings.spec.js` → "clean photos"): pure (keys, recovery, source, picture match + assign); server with
  every read stubbed (white render, signatures, findCleanPhotos incl. a moved shoe + brand-record precedence,
  sourcePhotos, convertPhotos); endpoints (photoSource, readiness + Use clean photos, bulk cleanPhotos / skipSlides with
  seeded signatures, find_clean_photos 400/404); the drawer picker + 390 px; the rejected shoe's Fix photos scroll.

## Replace the photos of a shoe already on SHEIN — op `photos` (built 2026-11-11)
**Why:** live shoes (4seller's or ours) carry PH-branded photos. partialEdit re-judges the WHOLE colour (SKC) on every
edit, so once SHEIN started rejecting those photos ("watermark", "false service promises") every later edit of the
shoe — new sizes, relinks — was rejected too. Spec + SHEIN doc line refs: session scratchpad `rejected-fix-spec.md`
(shein-api-specialist; edit guide 8ca3c2b9, image guide 4d96fc8f). A never-approved product can't be edited (edit
guide l. 5-8) — that case is Publish again (a NEW publish) with the photos left out.
- **Op `photos`** (alone, like `publish`; `PREVIEW_OPS`; the endpoint 400s a mix). `buildPhotoEdit` (shein-listing.js):
  live Shopify read + the stock gate → spu-info → fill (cached) → doc state (review open → deferred) → `editAttrs` →
  `planPhotoEdit` (pure, `src/lib/sheinPublish.js`). Picture plan of THIS product: SHEIN keeps SPU photos
  (`spuImageInfoList`) → `imagePlan(category fill)`, else the old plan (`imagePlan({})`). Photos = `sourcePhotos`
  (shared with publish: PH edited when on, else Shopify, minus `photo_skip`) → `convertPhotos` (H2: only an admin /
  Connect-integrations preview converts; PH → note `photos_need_priv`, nothing sendable).
- **Body** (ONE partialEdit): `{ spu_name, skc_list:[{ skc_name, image_info:{ image_group_code (spu-info), FULL new
  list }, skc_title + skc_multi_language_name_list as SHEIN has them (when the store shows skc_title — left out =
  cleared), sku_list: every SKU { sku_code, image_info:{ its group code, [new main] } } only when the SKUs carry
  images (all or none) }], image_info (SPU) only when SHEIN keeps SPU photos }` + `product_attribute_list` when
  `editAttrs` adds required details. Every photo NEW (no `image_item_id`). Never: is_spu_pic, prices, stock, sale attrs.
- **Blockers:** `photo_edit_unsupported` (`why` multi_skc · no_group_code · sku_group_code · spu_plan_unclear → Seller
  Center), `skc_field_uncopyable` (rules unread / reference link we'd clear / required skc title missing),
  `no_image` / `image_rejected` / `photo_cap_reached`, the attribute problems.
- **Run / review:** the same rails as edit (idempotency key + `sendState` = preVersion, `didItArrive` = a new doc
  version in review). Approved → `applyReview` → done + `afterApplied` (spu cache refresh). Then the person re-runs
  **Add missing sizes** for sizes SHEIN rejected (`planAddSizes` retries `review_rejected`; `imageOf(sibling)` now
  copies the NEW photo). The old photos stay live during the review.
- **`review_rejected` now routes by SHEIN's reason** (`isPhotoRejection`: picture / image / watermark / false
  service|efficacy / 图片 / 水印): fix text + action `fix_photos` ("Fix photos", opens the drawer's photo section;
  in `PUBLISH_FIX_KINDS`), else `send_again` as before.
- **Page:** drawer **Photos on SHEIN** (shoes on SHEIN): rejection banner with SHEIN's words, the last photo send's
  state, **Choose photos** (`SheinPhotoPicker`) + **Replace SHEIN photos** (preview `ops:['photos']`; primary when
  rejected for photos). Products bar: **Replace SHEIN photos (n)** for ticked shoes on SHEIN (≤ 100, syncable) → a
  dialog with "First leave out Shopify's cover photo on all n" (`publish_choices_bulk skipCover`) → the preview. Sheet:
  `PhotoEditPlan` (On SHEIN now → SHEIN will get, source + left-out count, size photos, SPU photos), stats, Confirm
  "Replace photos of n products on SHEIN" (admin / Connect integrations). Jobs label "replace SHEIN photos".
- **DB:** `shein_listing_job_items_op_check` is now re-applied on every `db:setup` from ONE list (`SHEIN_ITEM_OPS`,
  + `photos`) — it lived only in the CREATE, so existing DBs never got new ops. **Prod needs `db:setup`.**
- **Pilot (unknowns only a live call settles):** one shoe first — diff spu-info before/after (only photos changed;
  `groupCode` kept or new), confirm the shoe stays on shelf during the review, then re-run its rejected sizes.
- e2e (`shein-listings.spec.js` → "replace live photos"): the planner (body, all-or-none size photos, SPU photos, the
  blockers), `isPhotoRejection` + the action; vs the fake SHEIN: PH preview reads only, admin preview body + the
  left-out photo never hosted, endpoint refuses a mix, the run → In review → approved → done; the drawer section.

## Per shoe: category + SHEIN details (Product Model) while fixing (built 2026-11-11)
**Why:** the owner removed Setup's Product Model default ("Dunk Low" — one Nike's model, wrong for adidas and most
Nikes), so the model must be typed per shoe; and a shoe SHEIN rejected needs its category / details fixed before
**Publish again**, but its drawer showed no checklist (it has an SPU from the rejected publish).
- **Columns** (`shein_listing_products`, `db-setup.mjs`): `category_pick_id`, `category_pick_ptid`, `category_pick_path`,
  `category_pick_by`, `category_pick_at`; the shoe's details reuse `attr_overrides` (was unused) =
  `{ "<attributeId>": { ptid, valueIds, extraValues, by, at } }`. **Prod needs `db:setup`.**
- **Pure** (`src/lib/sheinPublish.js`): `shoeCategory(row, mapRow)` (the shoe's pick wins over the type map; a pick
  without its product type is ignored) · `shoeAttrDefaults(defaults, overrides, ptid)` (Setup's defaults + the
  shoe's on top, same attribute → the shoe's; a value saved under ANOTHER product type is ignored; shoe rows carry
  `shoe: true`) · `attrValueProblem(a, valueIds, extraValues)` (the one value check — Setup's `listing-maps type=attr`
  and the per-shoe save share it).
- **Rules:** `buildAttributes` — a REQUIRED TYPED detail (mode 0) with no value → `missing_attr` why `typed_per_shoe`
  ("type it for this shoe"). **Since 2026-11-14 a Setup typed value is never used, for a publish either** (see
  "Product Model from the title"); on an EDIT of a live shoe (`attributePatch`) a typed detail is filled ONLY from the
  shoe's own value (`shoe: true` — typed, or its title when sure).
- **Used by:** `publishReadiness` / `publishContext` (+ `listListingCategoryPicks` so the picked categories' rules and
  templates are in the cache), `buildPublish` (category + tree check, details), `editAttrs` (live edits: add sizes,
  SKU fixes, photo replace — looks the shoe up by SPU, `listingAttrOverridesBySpu`), `typeOf`/`categoryOf` in
  `api/shein/listings.js`, `loadListingPrev` (+ the 4 columns).
- **Endpoint:** `publish_choices` (PH ok, DB only, recount) + `categoryPick: { categoryId } | null` — a LEAF of the cached
  tree (400 not a leaf, 409 tree unread); refused (409) for a shoe already live on SHEIN (`neverLive` = no size has a
  SHEIN SKU) · + `attr: { attributeId, valueIds?, extraValues? } | { attributeId, clear: true }` — checked against the
  template of the shoe's category (409 no category / template unread, 400 not a detail of it / bad value); a live
  shoe's details are saved under the product type SHEIN has it in (`product_type_id`). Typed text is trimmed, spaces
  collapsed, ≤ 100.
- **GET `?product=`:** a shoe never live on SHEIN (incl. a rejected publish) now gets the `checklist`; a preview from
  BEFORE the last send is ignored (it judged the rejected publish) → the readiness instead.
- **Page:** drawer shows the checklist for a rejected shoe too (+ "Fix what SHEIN rejected below … then an admin
  presses Publish again"). **Category** line → `CategoryPicker perShoe`: **Only this shoe** / **For every Shopify “type”
  shoe in group** — default = this shoe when the shoe already has a category, the type when it has none; "Use the
  shared category again" clears the pick; saving for the type also clears this shoe's pick. ✓ line says "· this shoe
  only". **SHEIN details** line → `ShoeAttrEditor` (THIS shoe: needed first, chips Set for this shoe / From Setup / Typed
  per shoe, Save for this shoe / Remove), Setup's `AttrEditor` behind "Set a detail for every shoe of this SHEIN type
  instead (Setup)". Live shoe with a `missing_attr` blocker (sizes / product / its last edits): drawer section **SHEIN
  details for this shoe** (`[data-shoe-details]`) with the same editor.
- **Not built:** changing the category of a shoe already live on SHEIN (SHEIN keeps a live product in its category);
  the bulk sheet has no per-shoe Product Model input (it comes from each title when sure; the rest are typed one by one
  in the drawer).
- e2e (`shein-listings.spec.js`): pure (shoeCategory / shoeAttrDefaults / typed_per_shoe / attributePatch / the value
  check); vs the fake SHEIN (`fake.p4.template` swaps in a required typed Product Model): the pick + the type map
  untouched, the preview blocks then sends the shoe's model, the other shoe still asked, a picked detail wins, Remove;
  the page: Change → Only this shoe → "· this shoe only" → shared again; details panel = the shoe's editor first.

## Product Model from the shoe's TITLE; never a Setup default (built 2026-11-14)
**Why (owner):** "whatever I type in there is being set as default, but every shoe has a different product model". Setup →
SHEIN details still saved a TYPED detail (Product Model, id **1000546**, `attribute_mode 0`) as a default for every shoe
of a SHEIN product type, and `buildAttributes` (publish) used it: prod had 374 = "Dunk Low", 1852 = "Nike Air",
5512 = "ACG Air Max" (set 11-12) — so a LeBron 23, a Kobe 10, an Air Monarch IV… went up as "ACG Air Max".
- **Pure helper** `src/lib/sheinModel.js` (server + page): `modelFromTitle(title) → { model, sure }` — strip the style code /
  parentheses / Wmns / a collab prefix ("LEGO x Nike") / the brand → the LONGEST known model family at the start (≈ 300
  patterns: Air Max 90, Kobe 8 Protro, Gazelle Indoor, 9060, Gel-NYC, Bapesta…) → qualifier words (Low, Mid, High, Retro,
  OG, SE, Premium, LV8, Next Nature, GORE-TEX, RM, Golf, Cleat, Mule, Essential, Pro, Leather…) until the colourway.
  Normalised like the typed values: '07 / Big Bubble / GS / PS / TD / Big Kid / the year dropped; "Jordan 6 Retro" →
  "Air Jordan 6 Retro", a non-numbered Jordan stays "Jordan Stay Loyal"; "Air Flight '89" → "Air Flight 89"; "Ultra Boost
  1.0" → "Ultraboost 1.0"; New Balance = the number alone ("9060", "990v4"). `sure` ONLY when a family matched; else a
  guess (everything before a quoted colourway, else the first two words) that is never sent. Matches all 50 models a
  person typed (`e2e/fixtures/shein-models.tsv`); 1,184 of the 1,208 Shopify titles are sure (the rest: apparel, Jordan
  Mule / Grind, Nike Motive, 24.7, ST Charge…). `shoeModel()` = the same order for the page; `PRODUCT_MODEL_ATTR_ID`.
- **The order** (`shoeAttrDefaults(defaults, overrides, ptid, { title, template })`, `src/lib/sheinPublish.js`): the
  shoe's typed value (`attr_overrides`) → else the title when sure (a row `shoe: true, from: 'title'`, only for 1000546 and
  only when the template lists it) → else nothing ("type it for this shoe", `missing_attr` why `typed_per_shoe`). Setup rows
  for ANY typed detail of the template (`typedAttrIds`: Product Model, Series) are dropped, and `buildAttributes` refuses a
  typed value without `shoe: true` as a second guard. Callers pass the Shopify title: `publishReadiness`, `buildPublish`
  (`shein-publish.js`), `editAttrs` (live edits; `listingShoeBySpu` = the shoe's details + title by SPU — replaced
  `listingAttrOverridesBySpu`).
- **Setup refuses it:** `listing-maps type=attr set` on a typed detail → 400 "… is typed per shoe … Type it on the shoe:
  open the shoe's Details → SHEIN details." (`perShoe: true`). Setup's editor shows a typed detail as "Typed per shoe"
  (no input; "Copy from this product" skips it); an old saved row reads "Old default “…” — not used any more" + Clear.
  **The old rows stay in the table** until the owner OKs deleting them on prod:
  `DELETE FROM shein_attr_defaults WHERE attribute_id = 1000546;` (3 rows: 374, 1852, 5512).
- **Page:** the shoe's editor (`ShoeAttrEditor`) PREFILLS Product Model from the title — chip "From the title" (sure: already
  used, "Read from the title: SHEIN gets “…”", no Save needed) or "From the title — check it" (a guess: Save for this
  shoe). Saving writes ONLY that shoe's `attr_overrides` (never `shein_attr_defaults`). The checklist's SHEIN details line
  says `Product Model “…” · from the title | typed for this shoe` (`plan.model` → the line's `model`); the preview sheet
  has a Product Model row; an edit's note reads "Product Model “…” (from the title)" (`attributePatch` → `added[].from`).
- **Read-only report** of shoes already published with a Setup default that isn't theirs (the correction candidates; no
  SHEIN call, no write — correcting live shoes is the owner's call): `node scripts/shein-model-report.mjs [--csv]`
  (`api/_lib/shein-model-report.js`: the latest DONE publish per shoe, in a READ ONLY transaction → `setupModelCorrections`).
  Local copy of prod 11-13: 132 published shoes checked, 46 sent a Setup default that isn't their model.
- **Bug 4 (same branch):** a size marked "Don't list on SHEIN" still blocked a NEW shoe's publish (Free Metcon 6 5.5W in
  4455): `buildPublish` passed `productRow: d.product` without `excludedVariants`. Fixed (`{ ...d.product,
  excludedVariants }`), and the drawer no longer shows a preview's checklist that judged a size left off since (it reads the
  readiness until the next preview).
- e2e: `e2e/shein-model.spec.js` (pure: the 50, the rules, the order, no store-wide default, attributePatch, the report);
  `shein-listings.spec.js` → "Product Model from the title" (fake SHEIN: two shoes of one type get their own models, Setup
  refuses + its row never sent, typed wins and is saved on that shoe only, unsure blocked, `editAttrs`, the report query),
  the page test (prefill + chips, Setup shows "Typed per shoe" / old default), and "Bug 4".

## Fix the Product Model of shoes already on SHEIN — op `model` (built 2026-11-14, owner approved)
**Why:** the shoes published while Setup held a typed default went out with another shoe's model ("ACG Air Max" on a
LeBron 23), and `attributePatch` never REPLACES a detail a live product already has. **Prod needs `db:setup`** (the
`shein_listing_job_items_op_check` list gains `'model'`) before the first preview — else the job fails on the insert.
- **What is sent:** ONE `partialEdit` per SPU = `{ spu_name, product_attribute_list }` and nothing else. The list = the
  product's CURRENT details as spu-info shows them (`currentAttrRows`: template product attributes only, as `attributePatch`
  keeps them; sale attributes left out; details the template no longer lists dropped) + any missing required detail
  `attributePatch` would add, with ONLY 1000546 swapped to the shoe's own model (typed for the shoe → else its title when
  sure). Pure: `planModelFix` (`src/lib/sheinPublish.js`). SPU level → SHEIN reviews every colour; the old model stays live
  until it approves.
- **Never sent:** no sure model → `model_unsure` (blocked; the guess shown — type it in Details → SHEIN details, preview
  again); SHEIN already shows it (case / spaces aside) → `model_already_right` (note); the type has no Product Model →
  `model_not_in_template`; a required detail we can't fill → its `missing_attr` (SHEIN would refuse the whole edit);
  template unread → `missing_attr` `template_unread`. A sold-out shoe (0 pairs on Shopify) is NOT skipped for this op
  (it is only the description); inactive / deleted on Shopify and never-approved shoes still are.
- **The flow** = the other live ops: preview (PH ok, reads only, `ops: ['model']`, never mixed) → the sheet ("Fix the
  Product Model": shoes checked / to correct / already right / not sent; each item "On SHEIN now “…” → will change to
  “…” (read from the title | typed for this shoe)") → **Correct the Product Model of N shoes on SHEIN** (admin / Connect
  integrations) → `in_review` → SHEIN's review (poll + webhook) → `done`. Idempotent like the rest (key = body + SHEIN's
  version + the model it had); a lost answer is looked up (new document version, or spu-info already shows the model)
  before any resend. Server: `buildModelFix`, `editAttrInputs` (what `editAttrs` reads, shared) in `api/_lib/shein-listing.js`.
- **Which shoes:** `GET /api/shein/listings?modelFix=1` (PH ok, DB only, read-only transaction — `sheinModelReportData` +
  `modelReportFrom`) → `{ rows, candidates, setup, checked, canWrite }`. A row = the latest DONE publish whose Product Model
  isn't the shoe's own: `setup_default_differs` (a value Setup holds today), `sent_differs` (not Setup's value today —
  Setup changed over time: 5512 was "Dunk Low" before it became "ACG Air Max" on 11-12, and the rows may be deleted), or
  `setup_default_no_model` (a Setup value, but no sure model — a person types it). `candidates` = a sure model and no fix
  sent yet (`fix_status` = its latest `model` run item: pending / sending / deferred / in_review / done).
  **Page:** a strip at the top of Shoes on SHEIN → Products (`ModelFixStrip`, `src/components/SheinModelFix.jsx`), only
  when there are any: "N shoes on SHEIN show another shoe's Product Model" + e.g. lines + **Preview the fix (N)** →
  the model preview for exactly the candidates. The script prints the same rows (+ `fix_status`, `fix_job_id`).
  Local copy of prod (11-13): 88 rows (46 Setup value + 42 older "Dunk Low"), all with a sure model.
- e2e: `e2e/shein-model.spec.js` → `planModelFix` (only 1000546 changes, typed wins, a required detail added / blocking,
  unsure / already right / no model / unread) + the report's new reasons; `shein-listings.spec.js` → "fix the Product Model
  of live shoes" (fake SHEIN learns details-only edits: the preview body, 0 writes, never mixed, PH can't confirm (403),
  the candidates, the strip → the sheet, the admin's send = ONE edit with only `spu_name` + the list → In review →
  approved → Done → no longer a candidate → a new preview says already right).

## One editor for every shoe — “Edit this shoe” (built 2026-11-15)
**Why (owner):** opening a shoe from the **Error** tile let them change every detail, even ones already fine; from
**Blocked** only the blocking ones — not the photos, which cause the most rejections. Same menu everywhere, wanted.
- **What was different (before):** the drawer is one component whatever the tile; what it drew depended on the
  shoe. A shoe **never live on SHEIN** (new, or its publish rejected = most of Error) got `PublishChecklist` — 18 lines
  with a Change / Edit / Choose photos button on ✓ lines too. A shoe **live on SHEIN** (most of Blocked: wrong SKU,
  size SHEIN lacks) got a ✓/✕ **Requirements** list whose only buttons fixed a ✕, a **SHEIN details** editor only
  while a required detail was missing, and **Photos on SHEIN** far down, under Fix SHEIN sizes. No server rule
  caused it — `publish_choices` already accepted photos / details for a live shoe; only `categoryPick` is refused (409).
- **Now:** `ShoeEditor` (`SheinPublishBits.jsx`) for every Shopify shoe, at the top of the drawer:
  - **The menu** (`[data-edit-menu]`, `EDIT_MENU`): Photos · SHEIN details · Category · Brand · Colour · SHEIN title — the
    same six on every shoe, photos first; a ✕ is marked; a press opens that line's panel and scrolls/focuses it.
  - **Fix these first** (`[data-fix-first-list]`, red box): every ✕ line, photos / details first, each with the button that
    fixes it (the line's panel, or the blocker's own button: custom size, Match sizes, Fix photos…).
  - **The lines**, one renderer, the SAME panels (`SheinPhotoPicker`, `ShoeAttrEditor`, `CategoryPicker`, `BrandPicker`,
    `ColourPicker`, `TitleEditor`): mode `publish` (never live — the server's 18 lines as before, + a “SHEIN hasn't refused
    anything” line when its sizes carry SHEIN's review answer, `refusedBlockers`; colour now has **Change colour** when ✓) ·
    mode `live` (`liveShoeLines`, `src/lib/sheinShoeEdit.js`: Photos · SHEIN details · sizes · SKUs · prices · SHEIN refused ·
    Shopify · Category · Brand · Colour · SHEIN title · review open). On a live shoe the Photos line carries the rejection
    banner, the last photo send and **Replace SHEIN photos** (preview `ops:['photos']`); SHEIN details carries
    **Send the Product Model** (preview `ops:['model']` for this shoe) — both PH ok, read only, Confirm on the sheet needs an
    admin / Connect integrations, as before.
  - Mode = the server: `GET ?product=` sends `checklist` only for a shoe never live (`!spu || neverLive`) → `publish`; else a
    Shopify shoe with an SPU → `live`; a `shein:<spu>` row has no editor.
- **Still can't change on a live shoe — said on its line (`LIVE_LOCKS`), never hidden:** **Category** — SHEIN keeps a live
  product in its category (the server refuses the pick, 409). **Brand / Colour / SHEIN title** — no live edit sends them
  (brand map + colour + title override are used by a publish only; `planEdit` sends Shopify's title for shoes WE published,
  never 4seller's — D11). **Other SHEIN details** — saved for the shoe; SHEIN gets the Product Model with its preview, a
  required detail SHEIN lacks rides the next edit (`attributePatch`), a detail SHEIN already shows is left as it is.
- **Real SHEIN constraints kept:** a never-approved product can't be edited (Publish again — `never_approved`); one photo
  change at a time (Replace disabled while the last is in review); an edit while a review is open waits (deferred) — the
  review line says so; a live shoe's category (above).
- Gone from the drawer (now lines): Requirements, “SHEIN details for this shoe”, “Photos on SHEIN”, the picker inside
  “Published from this page” (that section keeps the status, **Choose photos** → the Photos line, Open the send, Publish again).
  “Fix photos” anywhere opens the Photos line. No new column, no `db:setup`.
- e2e (`shein-listings.spec.js`): pure — “one editor for every shoe (pure)”; page (Phase 4 page block) — from the **Error**
  tile (a rejected publish) and the **Blocked** tile (a live shoe) the same six-item menu, the photo picker and the details
  editor open in both, the live shoe's ✕ in Fix these first, Leave out a photo, the category lock + the server's 409, 390 px;
  Out of date / Not on SHEIN / In review / Synced open the same menu; “Fix photos” on a rejected shoe → the Photos line.

## A rejected shoe is never treated as live (fixed 2026-11-11)
**Bug (owner's video, Samba OG IH6828):** after a Publish again preview + a Replace photos preview, the drawer showed
the LIVE-shoe tools (Photos on SHEIN → Replace SHEIN photos, Add missing sizes) for a shoe SHEIN never approved —
it found the rejected send only among the last 5 job items, and previews pushed it out. The list bar also counted
it for "Add missing sizes (1)" / "Replace SHEIN photos (1)"; the photo preview then failed with SHEIN's raw
"unable to obtain skc information according to spu".
- `GET ?product=` returns `lastPublishRun` (`lastPublishRunItem` — the latest publish SEND, any age) and `neverLive`
  (no size carries a SHEIN SKU); the checklist's "preview older than the send" check uses it too.
- Drawer: `pubRun` from `lastPublishRun`; the live tools (photo section, details-for-edits, Add missing sizes /
  Update footer) only when `live` = not new, not a rejected publish, and not `neverLive`.
- List bar: `isLiveOnShein(p)` = an SPU AND `counts.on_shein + counts.shein_only > 0`; `canAdd` and the photo rows use it.
- Server: an add-sizes / edit / photos item of a never-live shoe → blocker `never_approved` before any SHEIN call.
- e2e: 5 previews after the rejected send → `lastPublishRun` + `neverLive` + the 18-line checklist; add / photos
  previews → `never_approved`, 0 spu-info calls.

## Photo swap keeps SHEIN's colour-block ("piece") photo (fixed 2026-11-11)
First live run (#380): 5 of 6 swaps went to review; HQ8717 was refused "The number of pieces with sku is incomplete" —
its SKC carried a type-6 colour-block (PIECE) photo and the new list dropped it. `planPhotoEdit` now appends every
PIECE photo SHEIN already has (its own URL, image_type 6, after ours); `plan.piecesKept`. e2e: "replace live photos:
the planner" + the piece test.

## Phase 5 — 4seller cut-over + go-live (built 2026-10-27)
- **Where:** Setup tab, on top: **Go-live checklist** then **4seller cut-over**; once "4seller paused" is ticked the
  connection strip shows "4seller cut-over: day N of 30 · n of 5 pass" (or "Ready to cancel 4seller") → Setup.
  Everyone on the page sees both cards; **Tick / Untick / Start the 30 days again** need admin or Connect integrations
  (others: disabled + `NEEDS_PRIV`).
- **Endpoint** `api/shein/listing-cutover.js` (DB only): `GET` → `{ ok, canWrite, now, ticks, cutover, golive }`;
  `POST {action:'tick', key, date?, note?}` · `{action:'untick', key}` · `{action:'restart'}` (403 without the
  privilege; 400 unknown key, a future / malformed EST date, "last action" before "paused"). Untick "paused" also drops
  "last action" and ends the 30 days.
- **Ticks** (`TICKS` in `src/lib/sheinCutover.js`): `paused_4seller` (date paused), `last_action_4seller` (date of
  4seller's last action in Seller Center's operation log), `shein_console_hooks`, `pilot_phase2|3|4` (date + which
  shoe). Stored in `app_settings.shein_cutover_ticks` = `{key: {by, at, date?, note?}}`.
- **Cut-over lines** (each ✓ / ✕ / … counting, with "How it's checked"): (a) paused + last action ≥ 14 days ago;
  (b) every ACTIVE Shopify shoe with `first_seen_at` ≥ the start reached an answer within 2 days (`settled_at −
  first_seen_at`; answer = Synced / In review / Blocked-Error with a non-note blocker / a person's Don't list) — late
  or missed shoes listed, each opens the drawer; (c) a finished AUTOMATIC snapshot on every EST night after the start
  (2026-11-17: the nightly OR the every-30-min read, `started_by LIKE 'auto (%'`, `isAutoSnapshot`; it counted only
  `auto (nightly%` and could never pass after the switch to every 30 min on 2026-11-10)
  day (tonight counts after 04:00 EST); (d) no `interrupted` job (each → Jobs `?job=`); (e) in-stock sizes of ACTIVE
  shoes on SHEIN without a SHEIN SKU ≤ those blocked for a SHEIN-controlled reason (`SHEIN_CONTROLLED`); a person's
  Don't-list sizes shown, not counted. Window start = the paused tick's time; "Ready to cancel 4seller" only when all
  five pass (which needs the 30 days done).
- **Columns:** `shein_listing_products.first_seen_at` (INSERT only) + `settled_at` (first answer, never moved), set in
  `saveListingProducts` from `productAnswered`. NULL = before Phase 5.
- **Go-live lines:** db:setup (tables + columns via `to_regclass` / information_schema), Shopify webhooks
  (`shein_listing_hooks`), Ask SHEIN (cache `probe/last`), first finished read, SHEIN console webhooks (tick; the three
  topics), 4seller paused before the first Phase-2 run (paused date ≤ the first `run` job's EST date), D6 box confirmed
  (`shein_box_defaults.confirmed`), the three pilots (ticks).
- **SOP:** `ph-shein-listings` in `src/lib/sop/articles.ph.js` (PH + admin + superadmin).
- e2e (`shein-listings.spec.js` → "Phase 5", +10).

## The list API — tiles, counts, search, "Rejected by SHEIN" (built 2026-11-17, stage 1 of the page fixes)
**Why (owner: "the filters are buggy"; audit on the local copy of prod):** "Synced" said 515 while 384 shoes were synced
(a tile matched a shoe with ANY counted size in that status) and its page 1 was red Blocked rows; the counts ignored the
search / brand / Shopify filter, reasons stopped at 12 and brands at 60; a Synced shoe showed (and was filtered by) a red
reason from a size with 0 pairs; "DQ7659101", "bold gazelle", "air force 1 07" and curly quotes found nothing; the reason
dropdown printed blanks ("Only 0 photos…"); cut-over line (c) could never pass; Setup saves left `brand_unset` /
`no_category` until the next re-read; a rejected never-live shoe was refused by the bulk editor as "already on SHEIN".
The page itself is unchanged (stage 3 builds on this); the old query keys keep their names.

**`GET /api/shein/listings`** (PH + admin; DB only except the connection check)
| Param | Values | Meaning |
|---|---|---|
| `status` | '' (default) · `all` · a tile code · `excluded` · `unknown` | '' = every shoe not off; a tile code = shoes whose OVERALL (roll-up) status is it; `excluded` = off; 400 for anything else |
| `any` | `1` / `true` | with a tile code: shoes with at least one COUNTED size in that status (the 2026-10-27 meaning); the ones whose overall status is it come first |
| `q` | text ≤ 120 | every word must match, any order, case-insensitive; quotes (straight, curly, prime) and commas dropped; a word with a digit / dash / underscore also matches with spaces, dashes, underscores removed on both sides; LIKE-safe. Searches title, style, handle, vendor, product gid, SPU, every seller SKU, SHEIN SKU, SKC |
| `brand` | vendor | any case |
| `blocker` | a code `[a-z_]+` | the code is in the shoe's `blockers` (its counted sizes) |
| `shopify` | `active` · `inactive` | as before |
| `sort` | `worst` (default) · `title` · `updated` · `coverage` | worst = status order (blocked → … → synced) then title; title = A→Z; updated = Shopify's updated time, newest first; coverage = share of in-stock sizes on SHEIN, lowest first (a shoe with nothing in stock counts as 100 %); ties → title. Unknown → `worst` (the answer's `sort` says which) |
| `page`, `pageSize` | ≥ 1; 1–200 (default 50) | a page past the end returns the LAST page |

Answer: `{ ok, connected, configured, canWrite, isAdmin, products, total, page (the page actually returned), pages,
pageSize, sort, any, shopifyCounts {active, inactive} (= summary.shopify), summary }`.
- **Product row**: the table's columns (never `shopify_json`, `search_text`, `search_norm`, `search_compact`,
  `computed_hash`) + rendered `blockers` (each `{ code, label, title, fix, level, action, sheinSaid, sizes }` — what the shoe
  is judged on), `idleBlockers` (same shape: reasons that sit ONLY on 0-stock sizes — show greyed "(out of stock)"),
  `worst` (first non-note of `blockers`, or null), `shopifyUrl`, raw `idle_blockers`.
- **`summary`** — every count follows the list's filters EXCEPT its own, so a number is the `total` of the list it opens:
  - `byStatus[code] = { products, anySize, sizes, allSizes, inStock }` — `products` = shoes whose overall status is code
    (the tile; `?status=code`), `anySize` = shoes with a counted size in it (`?status=code&any=1`; "384 synced · 131 more
    have a synced size" = products · anySize − products), `sizes` = counted sizes (in stock or SHEIN-only) in that status,
    `allSizes` = every size, `inStock` = Shopify qty > 0. Follows q + brand + blocker + shopify (not status).
  - `all` / `off` (the "All" tile, "Not listing") — same filters as the tiles; `store: { all, off }` = no filter at all.
  - `brands: [{ brand, products }]` (every vendor, one row per vendor any case, its most used spelling; most first) —
    follows q + status/any + blocker + shopify.
  - `topBlockers: [{ code, label, title (= label), products, sizes, level }]` (every code, most products first) — from the
    shoes' `blockers` (counted sizes), follows q + status/any + brand + shopify. `label` is plain ("Not enough photos").
  - `shopify: { active, inactive }` — follows q + status/any + brand + blocker.
  - `rejected` — how many rows `?rejected=1` has for the same q + brand.
  - `filters` (echo), `tiles`, `order`, `lastSnapshot`, `latestSnapshot`, `activeJob`, `probe`, `hooks`, `autoPrice` as before.
- **Blockers a shoe is judged on** (`productReadiness`, `src/lib/sheinListings.js`): from its counted sizes (in stock +
  SHEIN-only — the roll-up's pool) when it has any; the rest go to `idle_blockers`. No counted size → every size (as before).
  Each blocker's `sizes` = sizes of ITS pool carrying it. Stored rows change on the next recompute: on prod the next
  automatic Refresh (every 30 min) rewrites every product once (the computed hash changes) — nothing to run by hand.
- **Search columns** `search_norm` / `search_compact` are GENERATED from `search_text` (`scripts/db-setup.mjs`; the JS twin
  is `normSearchText` / `compactSearch` / `searchTerms` / `searchMatches` — keep the character sets the same). Filled by
  `db:setup` itself. Measured on the local copy (1,204 shoes): list ≈ 15–25 ms, the summary (one statement) ≈ 20–30 ms warm.
- **Labels**: every `BLOCKERS` entry has `label`; `blockerLabel(code)` (unknown code → "Some new code"); `renderBlocker` adds it.
- `preview {filter}` uses the same list (whole-shoe `status`, `filter.any` honoured) and stops at the real last page.
- `listing-maps` saves (category set / clear, SHEIN details default set / clear, brand set / clear / no brand) now recount at
  once like the box and size maps (`recomputed: true|false` in the answer); `recomputeStored` runs one at a time per process
  (calls meanwhile share ONE follow-up run that starts after the current one; `recomputeBusy()`).
- `?publishSetup=` offers a shoe whose publish SHEIN rejected (it keeps the SPU it was sent as, but `neverLive`); a shoe live
  on SHEIN is still skipped "already on SHEIN". (The preview by `filter` with `ops:['publish']` still picks shoes without
  an SPU only — a rejected never-live shoe goes by `productIds`.)

**"Rejected by SHEIN" — `GET /api/shein/listings?rejected=1[&q=&brand=&off=1]`** (PH + admin, DB only;
`rejectedListingData` in db.js → `rejectedList` in `src/lib/sheinRejected.js`, pure) → `{ ok, rows, total, canWrite, isAdmin }`.
From OUR send records only: the latest RUN item per (shoe, op) that is `failed` with `review_rejected` (SHEIN's review) or
`shein_prevalid` (SHEIN's pre-check refused it) — a later send of the same op supersedes it; a rejected PUBLISH counts only
while the shoe is never live; plus sizes whose `last_error` is one of those and still shown (unchanged since, not left off).
Off shoes (not active on Shopify / "Don't list") only with `off=1`. Newest first. A row:
`{ productId, title, style, vendor, imageUrl, shopifyStatus, shopifyUrl, status, spu, neverLive, live, stock: { pairs,
sizesInStock, sizes }, what ('publish'|'add_sizes'|'photos'|'edit'|'price'|'model'|'sizes'), whatLabel, code, reason (SHEIN's
words), module, isPhoto, at, jobId, itemId, sizes (affected), sizeNames, publishAgain: {by, at} | null (pressed since),
rejections: [{ op, what, whatLabel, code, reason, module, traceId, at, sentAt, jobId, itemId, source 'send'|'size_error',
sizes, next }], next }`. `next = { action, label, who ('ph_team' | 'admin_or_connect_integrations'), confirmNeeds, canPress
(for THIS user), ops, fixFirst ('photos' | null), say }`:
| `next.action` | When | What the button does |
|---|---|---|
| `publish_again` | a never-live shoe's publish rejected, Publish again not pressed since | `POST {action:'publish_again', productIds}` (admin / Connect integrations; 403 else) then `preview {productIds, ops:['publish']}`; photo rejection → fix photos first |
| `preview_publish` | the same, Publish again already pressed | `preview {productIds, ops:['publish']}` (PH ok) → Confirm on the sheet (admin / priv) |
| `preview_photos` | photos op rejected, or add-sizes rejected for its photos with no photo replacement done since | fix photos (Choose photos) → `preview {ops:['photos']}` → Confirm |
| `preview_add_sizes` | add-sizes rejected (not photos, or photos already replaced) | `preview {productIds}` — `planAddSizes` re-tries sizes in Error with review_rejected / shein_prevalid / api_error |
| `preview_update` / `preview_model` | edit / price, model rejected | `preview {ops:['price','edit']}` / `{ops:['model']}` |
| null | the shoe is off | `say` explains (list it again / activate on Shopify) |
What the existing actions do (read, not changed): **`publish_again`** — sets `publish_again_by/at` on the shoes and releases
the idempotency key of their failed publish items; writes nothing to SHEIN, starts no preview, doesn't check the shoe was
rejected; the next publish preview no longer adds `publish_rejected`. **`send_again`** — ONLY a publish item `failed` with
`publish_unconfirmed` whose two looks (≥ 30 min after the send) found nothing (`response.send_again_ok`); refuses everything
else ("Look again first…") — so it never resubmits a rejection. **`retry`** — only run items `deferred`, or `failed` with
`api_error` (not publish); a SHEIN refusal is refused "SHEIN refused it — fix it, then dry run again", `changed` → "dry run
again". ~~The `review_rejected` blocker's own button (`send_again` kind) is drawn disabled~~ — since stage 2 (2026-11-17)
its button is the real next step, `action.next` = one of the `next.action` values above (`rejectionAction`).
**SHEIN's own list of rejected products (not ours, e.g. 4seller's): there is none in the API we have documented.**
`product/query` (doc 3001239) lists only products that PASSED review ("已发布成功"; its insert time = first approval);
`spu-info` answers only approved SPUs; `searchProduct` (doc 3001938) filters by codes, shelf status, category and publish /
update time (publish time = first approval) — no review-state filter or field; `query-document-state` (doc 3001368) gives
`documentState` (-1 not received · 1 pending · 2 approved · 3 rejected · 4 withdrawn · 5 appeal) + `failedReason` per SKC,
but only for SPU names we pass (≤ 10 a call). So: a product SHEIN rejected WITHOUT ever approving is invisible to us unless
we sent it; an APPROVED product whose later edit (by anyone, 4seller included) SHEIN rejected shows up through
`query-document-state`, which the snapshot already calls for every SPU it reads — stored as `review_state` 3 + `review_reason`
on the shoe (0 such shoes on the local copy, 2026-11-17; not yet part of `?rejected=1`). The `…_all_channels` audit
webhook (doc 3001449) fires for Seller Center publishes too but carries no reason.
**Prod after deploy:** `db:setup` (3 columns: `idle_blockers`, generated `search_norm`, `search_compact` — the ALTER rewrites
the 1.2k-row table once); the next automatic Refresh (or any recompute) re-saves every product with counted-size blockers.
e2e (`shein-listings.spec.js` → "the list API fixes (pure)" + "(endpoints)", which run on ANY database: their shoes carry
the word "zqxshl" and the store-wide checks only compare a count with its own list; + two recount tests in "Phase 4 — publish").

## The status engine (stage 2 of the page fixes, 2026-11-17)
**Why (audit on the local copy of prod):** sizes read "Synced" while the walk sold 0 there; Errors nobody could clear (and
some that vanished when a price changed); a dead "Send again" button; "Needs update" that was mostly SHEIN Reprice prices
compared with Shopify; a $766 Shopify price that went straight to SHEIN; a size offered as "Ready" that SHEIN already sold
under another SKU; "Check the main photo" right after a confirmed side view; a 40-s "Find clean photos" that found nothing
every time; previews and interrupted runs that never went away. The page itself is unchanged (stage 3 renders this).

| # | Rule (code) | Where |
|---|---|---|
| 1 | A matched SHEIN SKU whose size is blank, or not a US size (EUR / CN / a range), is **Blocked `shein_size_blank`** ("No size on SHEIN"; params `{sku, sheinSize, size, want, why: 'blank'|'other_system'}`, action `open_match` here) — the walk (`sheinFix.js buildFix`) holds those at 0 (`no_size` / `other_system`). A person's Match-sizes link of that exact SKU (`shein_links.link_sku` = SHEIN's seller SKU) is trusted, as the walk does (`linkConfirmed`). | `variantReadiness`, `computeListings` (`confirmedLinks`) |
| 2a | SHEIN **approving** a change it reviews for the whole shoe — `photos`, `model`, `edit` (`PRODUCT_LEVEL_OPS`) — clears the `review_rejected` / `shein_prevalid` its sizes carry from BEFORE that send (`last_error.at` ≤ the send; an older error without `at`: no failed send of the size after it). Logged `auto_clear_error`. | `applyReview` → `clearAfterApproval` → `clearProductRejections` (db.js) |
| 2b | An error from a send that ADDED the size (`op` publish / add_sku) is moot once the size is on SHEIN (e.g. our duplicate publish was rejected while the shoe is live through another SHEIN product). | `lastErrorShown` (readiness + "Rejected by SHEIN") |
| 2c | **`POST {action:'clear_error', variantKeys? \| productIds?, note?}`** — admin or Connect integrations (403 PH); clears `last_error`, recounts, logs `clear_error` with who / note / what was cleared. → `{ ok, cleared, products }` | `api/shein/listings.js`, `clearVariantErrors` |
| 2d | `review_rejected` / `shein_prevalid` are **sticky** (`STICKY_ERRORS`): a Shopify change no longer hides them; they go when a send of the size is accepted (`in_review` clears `last_error`), by 2a or 2c. `api_error` etc. still expire with the Shopify hash. Every stored error now carries `op, itemId, spu, at` (`setVariantsLastError(ids, err, meta)`). | `lastErrorShown`, `setVariantsLastError` |
| 3 | The `review_rejected` / `shein_prevalid` button = `rejectionAction(params)`: `{kind, label, next, ops, fixFirst}`; `next` ∈ `REJECTION_NEXT` and equals "Rejected by SHEIN"'s `next.action` (`nextFor`) for the same op — publish → `publish_again` (photo reason: kind `fix_photos`, fixFirst photos); photos → `preview_photos`; model → `preview_model`; edit / price → `preview_update`; add_sku → `preview_add_sizes` (photo reason → `fix_photos` / `preview_photos` first). `op` comes from the error; an error from before 2026-11-17 gets it inferred (on SHEIN → edit, shoe on SHEIN → add_sku, else publish). | `BLOCKERS.review_rejected/shein_prevalid` |
| 4 | Only a **market** target makes a price **Needs update** and only market targets are sent by Update prices (a person's preview too: `buildResync` → `marketOnly`). Against the Shopify fallback: the note **`price_no_market`** `{shein, shopify, special?, base?}` ("SHEIN $X · Shopify $Y — no market price to compare"), and a Shopify price change on such a size is not a diff either. A price plan notes `price_no_market {count}` for the sizes it left alone. | `variantReadiness`, `buildResync` |
| 5 | **`PRICE_OUTLIER = { high: 1.5, low: 0.6, minSizes: 3 }`**: a size's target vs the median target of the shoe's OTHER sizes (left-off sizes out), or vs its own market price when it has one; outside → **Blocked `price_outlier`** `{size, price, ref, refFrom 'sizes'|'market', ratio}` (action `{kind:'confirm_price', label:'Confirm $766', price}`) — skipped by add sizes (`planAddSizes`), publish (`planPublish`, an in-stock one holds the shoe; checklist line 14 "Prices") and price updates (`planPrice`). Fewer than 3 priced sizes and no market → not judged. **`POST {action:'price_ok', variantKey, price \| null}`** — **PH ok** (the same gate as the per-size spelling confirmations on the Sizes tab; the send's Confirm still needs admin / Connect integrations): only while the size is held for exactly that price (409 otherwise, 400 bad price), stored `price_ok {price, by, at}`, logged, recount → the size is back with the note **`price_confirmed`**; a different price asks again; `null` withdraws. | `priceOutliers`, `priceTargetsOf`, `priceCheck` (sheinListings.js) |
| 6 | A Not-on-SHEIN size SHEIN already sells on the SAME colour (SKC) under another seller SKU (same value id, or `compareSize` 'ok') is **Blocked `size_already_on_shein`** `{size, sheinSize, sellerSku (SHEIN's), sheinSku, to (ours)}` — "link it instead", action `open_match` here. The add-sizes dry run already refused these (its `used` map), the readiness didn't. | `computeListings` (`sheinHas`) |
| 7 | One main-photo rule for the readiness and the preview (`cleanOrder`, see Clean photos): a confirmed side slot unless its outline reads as a sole or a pair. | `cleanOrder`, `publishContext` |
| 8 | `find_clean_photos` answer + `why`, `cached`, `checkedAt`, `scored` (see Clean photos → Run it). | `findCleanPhotos` |
| 9 | A preview `awaiting_confirm` for 24 h → **`expired`** (`PREVIEW_EXPIRE_H`; phase "Expired — … preview again"; Confirm → 409 "That preview expired…", Resume refuses it). An `interrupted` run whose items all settled → `done` ("Finished — a restart interrupted it after every item had settled"). Both from `markStaleListingJobs` (every GET + tick). Snapshot `read` items of finished snapshots older than 7 days are pruned once per EST day (`pruneSnapshotItems`, with the API-log prune). Index `shein_listing_job_items_product_op (shopify_product_id, op, id) WHERE op <> 'read'` — the rejected list 43 ms → 2 ms locally. | db.js, `listingTick` |

**For the page (stage 3):** new blocker codes / labels — `shein_size_blank` "No size on SHEIN", `price_outlier` "Price looks
wrong" (action kind `confirm_price` + `price`), `price_confirmed` "Price confirmed by a person" (note), `price_no_market` "No
market price to compare" (note); `size_already_on_shein` now also on the readiness (label unchanged, new title / fix, params
`to`, `sheinSku`); `review_rejected` / `shein_prevalid` actions with kinds `fix_photos` · `publish_again` (both drawn today) ·
`preview_photos` · `preview_model` · `preview_update` · `preview_add_sizes` (live buttons since stage 3) and
`next` / `ops` / `fixFirst`. New actions: `clear_error`, `price_ok` (above). GET `?product=` → `actions` (the listing log,
newest 20) and each variant's `price_ok`; job status `expired` (`JOB_WORDS.expired` "Expired"; `listing-jobs?status=expired`
accepted); a price plan's `noMarket` + the `price_no_market {count}` note.

**Measured on the local copy of prod (after `db:setup` + a recompute, 2026-11-17; no market price is fresh there, so every
price target is the Shopify fallback):** Error sizes 37 → 8 (31 cleared by the one-off: 27 on the 5 shoes whose photos SHEIN
approved on 11-13, 4 on HQ8717 that SHEIN sells now; + 2 that had silently expired, back); Needs update shoes 296 → 0
(sizes 952 → 0; 908 sizes now carry `price_no_market`); matched sizes with a blank SHEIN size 68 Synced + 48 Needs update →
all 120 Blocked (+ 21 with an EUR / range size); `size_already_on_shein` 41 sizes on 26 shoes (39 of them read "Ready" before;
33 in stock); `price_outlier` 77 sizes (52 in stock; on prod a fresh market price judges many of these against the market
instead); 13 previews expired; run #282 closed; 12,268 snapshot items pruned.

**Prod after deploy:** `npm run db:setup` (job status `expired`, `shein_listing_variants.price_ok`, table `shein_listing_actions`
(+ LIVE_TABLES), the index, and the one-off — it prints how many stale size errors it cleared); then the next automatic
Refresh (every 30 min) or any recompute re-judges every shoe — nothing else by hand. The first GET / tick expires old previews
and closes settled runs; the first daily prune removes old snapshot items.

**Not built (item 10, report only):** sizes SHEIN has only as a near match (4455 women's "6W" → SHEIN "US6"; 8824 "5Y" →
"US5") — a person can already map one on the Sizes tab (`listing-maps set {attributeValueId}` accepts `ok_suffix` /
`check_group`); nothing maps it automatically. See the stage 2 report for the numbers and the risk.

## The page (stage 3 of the page fixes, 2026-11-17)
**Why (the owner):** (a) "we filter the errors, but we can't remove the filter"; (b) "when we go to all products, the filter
contains the errors … the filters for error should only be seen on the blockers or the with-errors items"; (c) "user should be
able to see the rejected products based on SHEIN status … can a rejected product be fixed and resubmitted?". Plus the audit:
the tiles' meaning changed in stage 1, ticks survived a list change, errors showed as "Couldn't refresh" at the top, stale
drawers / sheets, the search ate a trailing space, the phone bar took 40 % of the screen. Files: `SheinListings.jsx`,
`SheinListingsProducts.jsx`, `SheinListingsRejected.jsx` (new), `SheinProductDrawer.jsx`, `SheinDryRunSheet.jsx`,
`SheinListingsJobs.jsx`, `SheinListingsBits.jsx`, `SheinToday.jsx`, `SheinPhotoPicker.jsx`, `SheinPublishBits.jsx`,
`src/lib/sheinShoeEdit.js` (line groups), `src/api.js` (`sheinListingsRejected`), styles (`shl-` block at the end of
`styles.css`). No engine / API / DB change.

| What | How |
|---|---|
| Filter chips | Under the controls, "Showing only:" one chip per filter that is on — tile (`Status: Blocked`, `Not listing`), any-size (`Has a synced size`), `Search: “…”`, `Brand: …`, `What’s stopping it: <label>`, `Shopify: …`, a non-default `Sort: …` — ✕ takes off that one; **Clear all** takes off every one, the tile included (`FilterChips`, `[data-active-filters] [data-chip=…]`). More filters (brand) opens and closes (`?more=1`). All in the URL. |
| Reason filter | Only when the tile is Blocked or Error (`REASON_STATUSES`); options = `summary.topBlockers` `label (n shoes · n sizes)`. A reason still applied elsewhere (an old link) is a chip, so it can be removed. Leaving Blocked / Error for another tile drops it. Sizes → "Show the products" and Today's reason links land on `status=blocked&blocker=…`; Today's size counts open `any=1`. |
| Tiles | Number = `byStatus[c].products` (= the list total it opens); small line = `inStock` sizes; when `anySize > products` a link under the tile "+n more have a synced size" → `status=c&any=1`. Tooltip says it counts shoes by their own (worst in-stock) status. Same tile again = All; the any link's tile is not "pressed" (the link is). |
| Any-size mode | List head "Shoes with at least one synced size — the chip on each row is the shoe’s own status…"; each row a second chip `n synced` (`[data-any-match]`). |
| Empty states | Whole-shoe sentences (`EMPTY`); a tile with no shoes but `anySize > 0` says "But n shoes have a … size — their own status is worse" + **Show those n** (→ any). Filters on → "No shoes match …" + Clear all filters. |
| Rejected | A **tab** (`?tab=rejected`, count = `summary.rejected`, red) + a line under the tiles. Not a tile: a tile is a status that adds up to All, and a rejected shoe can be Error, Blocked or Synced through other sizes. Rows: photo, title, style, brand, Shopify ↗, Live on SHEIN / Never accepted, "<what> rejected", when (EST) + send #, sizes, SHEIN's words, stock, `next.say`, other rejections; ONE primary button = `next` (`publish_again` → POST publish_again then the publish preview; PH sees it disabled + "Only an admin … can press Publish again"; `preview_*` → `preview {productIds, ops}` exactly as elsewhere, `preview_add_sizes` without ops), **Fix photos** when `fixFirst = photos`, **Details**. Lead: "sent from here and refused … Yes, each one can be fixed and sent again"; the limit: "sent by another tool … SHEIN’s API doesn’t give us its list". Search + brand = the list's `q` / `brand`. |
| Selection | The bar counts and acts on `pickedRows` = ticked rows on screen not in a running job. Any change of page / tile / any / q / brand / reason / Shopify / sort drops the ticks: "n ticks cleared — the list changed." (once, 6 s). Select all skips shoes in a running job (their box is disabled). **Don't list on SHEIN** asks first (FormModal naming the count). |
| Sort | `?sort=` worst (default, not in the URL) · title · updated · coverage, a select in the list head; a chip when not default. |
| Shopify filter | Always visible (not behind More filters). |
| Page | The answer's `page` is used for the range + pager and written back to `?p=` (a stale `?p=9` of 6 shoes → page 1, `p` dropped; not loaded twice). |
| Answers | `act(action, extra, done, where)`; the note `{where, kind, text}` (context `ActNoteContext`) renders by `<ActNote where>`: `top` (strip: Refresh, Resume, Stop), `adv` (webhooks, automatic price), `bar` (+ below the list once the bar is gone), `bulk`, `drawer` (above its footer), `row:<id>` (size rows: Confirm price, custom size, a row's preview), `rej:<id>`, `model`, `sizes`, `jobs`. Errors stay until the next action; successes go after 6 s. "Couldn’t refresh: …" is for failed loads only. |
| Stale views | `<SheinProductDrawer key={product}>`, `<DryRunView key={jobId}>` (sheet + Jobs); a product row re-reads its sizes every time it opens. Drawer / sheet lock the page scroll and restore it on close (`useBodyLock`). |
| Search | `useSearchBox`: the box follows the URL only when the URL changed on its own — "air " keeps its space. Placeholder "Search name, style code, SKU or SHEIN code…". |
| Stage-2 renders | Product row: `idleBlockers` greyed "label (out of stock)" (`[data-idle]`), never the red one-liner on a Synced row; `healthLine` for a Not-on-SHEIN shoe with nothing in stock says so (was "0 in-stock sizes aren’t on SHEIN"). Size row: `price_outlier` → **Confirm $X** (`confirm_price` → `price_ok {variantKey, price}`, PH ok) and the `price_confirmed` note; `price_no_market` a quiet one-line note; `shein_size_blank` / `size_already_on_shein` → Match sizes (opens the drawer AT Fix SHEIN sizes, `focus='match'`). Rejection kinds `preview_photos/model/update/add_sizes` are live buttons (`REJECTION_PREVIEW_OPS`), `fix_photos` opens the drawer at its photos, `publish_again` in the drawer = record + preview. Drawer: the live shoe's editor groups `shein_size_blank`, `size_already_on_shein` under Sizes and `price_outlier`, `price_confirmed` under Prices (`sheinShoeEdit.js`), each line names its size(s); **Errors & what people changed**: Clear this error (admin / Connect integrations; asks a note → `clear_error {variantKeys, note}`; PH disabled with who) + the newest 5 `actions`; "Add missing sizes (n)" counts in-stock, not-blocked sizes. Jobs / sheet: **Expired** chip + "Not confirmed in 24 h"; an expired preview says so with **Preview again**. Find clean photos from memory: "Checked <when> — nothing new since". `diffText` words for `shein_special`, `size`, `sku`, `barcode`. |
| Phone (≤ 768 px) | The selection bar is ONE line (count · the main preview · More ▾), floats 80 px up so the advisor / keypad buttons never cover it; the rest behind More. The section lead is hidden, notices / banners shrink; tiles start ≈ 615–655 px down on the local copy (not connected + an interrupted banner; less on prod). Chips, Select all, the tile links and sort are 44 px targets; drawer footer clear of both floating buttons (`pointer: coarse` for the keypad). |

e2e: `e2e/shein-listings-filters.spec.js` (9 tests, its own shoes "zqflt" 7761–7766; every POST answered by `page.route`;
skips on a database with real SHEIN rows). Changed for the new words / phone bar: `shein-listings.spec.js` ("1 shoe", More ▾
before a hidden bar button at 390 px ×2) and `shein-page.spec.js` (Today's blocked row has reason links — click "See why").

## Security gates (security review + Phase 4 re-review, 2026-10-27)
- **Writes:** every SHEIN write (run, retry, probe, webhooks, auto_price, publish_again, send_again, box sizes,
  listing-meta `refresh=1`) and **stop / resume of a run job** need an admin or `connect_integrations` (read fresh).
- **Photos (H2):** a publish dry run converts photos (R2 upload + SHEIN transform-pic) only when the starter may
  write (`scope.convertPhotos`, set by the endpoint; a run always may). A PH dry run stops before the photos: note
  `photos_need_priv`, the photo line stays "not read yet", nothing is sendable. A store-wide cap,
  `app_settings.shein_transform_cap` (default 500 per EST day, counted from `shein_api_log`) → `photo_cap_reached`.
  `fetchImage`: https only, `cdn.shopify.com` or our R2 public host, redirects followed only on the same host (≤ 3),
  15 MB cap while streaming, 20 s. (`api/images/import.js` + `brand.js` already fetch only from the StockX/GOAT
  CDNs or R2, and store our own R2 URL.)
- **PH reads that reach SHEIN:** `look_again` and listing-meta `suggest=` are throttled per user (10 a minute,
  `userThrottle`, on top of the per-route limit; not switched off in e2e); `suggest=` is cached per product 10 min.
- **Publish twice (G1/G2):** another `publish_unconfirmed` item for the same Shopify product blocks every new
  publish (dry run and readiness, line 18) until it's resolved (Look again / Send again). A coded SHEIN
  "system error" / 系统异常 / internal with no validation message, or any error after the send started, is
  unconfirmed (key kept), never a refusal.
- **Brand / language (N1–N3):** "no brand" is refused when the Shopify title names a known brand (`titleBrand`);
  SHEIN's brand list unread → Brand line "not read yet" + `brand_list_unread`, nothing sendable; a category whose
  `default_language` isn't `en` → `language_not_en` (we only write English).
- `listing-maps` answers 405 for other methods, and stores only `{categoryId, order, vote, path}` of a suggestion.
  `/api/shopify/webhook` alone takes bodies up to 4 MB (`server.mjs`), HMAC over the same raw bytes.

## Running it
- `npm run db:setup` (local) — prod needs it too after merge (the user runs it).
- SHEIN only answers Railway (IP whitelist): probe/snapshot from a laptop fail at the first call.
- Tests: `npx playwright test e2e/shein-listings.spec.js` — a fake SHEIN on 127.0.0.1:5194 (refuses every
  write path, except a STATEFUL `partialEdit` that the Phase 2 tests switch on with `fake.p2`); the test
  server gets `SHEIN_API_HOST` pointing there (`playwright.config.js`). The DB tests skip on a database
  that already holds real SHEIN Listings rows.
- Go-live: prod `db:setup` → admin `webhooks` → **Ask SHEIN** → **Re-read** (snapshot).
