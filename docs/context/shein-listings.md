# SHEIN Listings — Shopify → SHEIN listing sync (retires 4seller)

Plan + decisions: `docs/shein-listings-plan.md` (its **Build log** at the end records what was built
and every deviation). API fields: `docs/shein-listing-api-reference.md` (publish, templates, custom
sizes, review, **searchProduct**) and `docs/shein-api-reference.md` (spu-info, stock, price).

**Built 2026-10-27: Phase 0 (probe) and Phase 1 (read-only dashboard), back end AND page; Phases 2–3
back end + page; Phase 4 (publish new products) back end AND page; Phase 5 (4seller cut-over + go-live checklists, SOP article `ph-shein-listings`) — see "Phase 5"** —
(`/ph/shein-listings`, `/shein-listings`), **and Phase 2's BACK END (add missing sizes to shoes
already on SHEIN — the first SHEIN write, `partialEdit`)**, back end AND page (dry run → review sheet
→ confirm → job card) — see "Phase 2" below — **and Phase 3 (Needs update → Synced: prices, sizes turned
off on SHEIN, wrong SKUs; auto re-sync price), back end AND page** — see "Phase 3". Not merged. **Wording (user, 2026-10-27):** statuses read
Needs update / Not in Shopify / Not listing (codes `out_of_date` / `shein_only` / `excluded` unchanged);
buttons "Don't list on SHEIN" / "List on SHEIN again"; "SHEIN has the wrong SKU: A → will change to B";
"SHEIN size" vs "Custom size".
Related and already live: stock both ways + the walk (`shein-live-fix.md`), seller-SKU links /
Match sizes (`shein-fix.md`).

## Files
| File | What |
|---|---|
| `src/lib/sheinListings.js` | The pure engine, shared by server + page: `STATUSES`/`STATUS_ORDER`/`TILE_STATUSES`, `BLOCKERS` + `renderBlocker`, `sizeKey`, `resolveSize`, `validateCustomText`, `suggestCustomSpelling`, `matchStore`, `variantReadiness`, `productReadiness`, `rollup`, `listingHash`/`variantHash`, `normalizeWebhookProduct`, `spuPayload`, `templateSizes`, `computeListings`, `SHEIN_READ_PATHS`/`isSheinWrite` |
| `api/_lib/shein-listing.js` | The jobs (snapshot, probe), the runner (lease + heartbeat), the Shopify-webhook recheck, `listingTick` (nightly) |
| `api/_lib/shein.js` | `sheinCall(path, body, { log })` hook → `shein_api_log`; read helpers `sheinAllSpusLogged`, `sheinSearchProducts`, `sheinSpuInfoLogged`, `sheinDocStates`, `sheinCustomPermissions`, `sheinAttributeTemplates` |
| `api/_lib/shopify.js` | `shopifyListingCatalogue()` (every product + variants, normalized), `shopifyListingProduct(id)`, `shopifyEnsureWebhooks(uri, topics)` (the old `shopifyEnsureInventoryWebhook` is untouched) |
| `api/shopify/webhook.js` | Branches on `x-shopify-topic`: `inventory_levels/update` → `queuePush` exactly as before; `products/create|update` → `listingProductChanged`; `products/delete` → `listingProductDeleted` (`routeShopifyWebhook`, `HOOK`) |
| `api/shein/listings.js`, `listing-jobs.js`, `listing-maps.js`, `listing-log.js` | The endpoints below |
| `api/_lib/shein-worker.js` | `sheinTick()` also calls `listingTick()` (own try/catch) |
| `e2e/shein-listings.spec.js` | Engine fixtures, the log hook, the snapshot job vs a fake SHEIN, webhooks, the endpoints, **the page**, Phase 2 jobs + **the Phase 2 page** (POST preview/run/retry answered in-process via `page.route`) |
| `src/screens/SheinListings.jsx` | The page shell: connection strip, job banners, status tiles (= `?status=` filters), tabs, the legend; `LISTING_TABLES` for `useLive` |
| `src/screens/SheinListingsProducts.jsx` | Products tab: filters, product rows → size rows (`VariantTable`), the selection bar (Dry run, Don't list on SHEIN), `useFixes` (custom size / don't list / list again), `useInJob` |
| `src/screens/SheinListingsSizes.jsx` | Sizes tab: `ProbePanel` (Ask SHEIN) + our size → SHEIN size per category, "Add as a custom size", Clear |
| `src/screens/SheinListingsJobs.jsx` | Jobs tab: running job, history, Resume, one job's items (`?job=`) + CSV |
| `src/components/SheinProductDrawer.jsx` | Details drawer (`?product=`): requirements checklist, what SHEIN will receive, history (dry runs / sends → Open the sheet), the two dry runs (Add missing sizes · Update prices & sizes), "was …" diffs |
| `src/components/SheinListingsBits.jsx` | `StatusChip`, `BlockerSay`, `FixButton` (live vs "Coming in a later phase"), `CustomSizeModal`, `when` (EST) |
| `src/components/SheinDryRunSheet.jsx` | Phase 2: `DryRunSheet` (the overlay) + `DryRunView` (dry-run review → Confirm → the run's job card; also inline on Jobs `?job=`); Phase 4 `PublishPlan` |
| `src/components/SheinPublishBits.jsx` | Phase 4: `PublishChecklist` (the drawer's 18 lines + inline fixes), `CategoryPicker`, `BrandPicker`, `AttrEditor`, `ColourPicker`, `TitleEditor`, `BoxDefaults` (D6), `useStoreGates` / `StoreGateBanner` |
| `src/screens/SheinListingsSetup.jsx` | Phase 4: the Setup tab (`?tab=setup`, `?pt=`) — store gates, D6 box, category map, brand map, SHEIN details per product type |
| `src/lib/sheinCutover.js`, `api/shein/listing-cutover.js`, `src/components/SheinCutover.jsx` | Phase 5: the cut-over / go-live checks (pure), the endpoint, the two Setup cards + the strip line |

## Tables (`scripts/db-setup.mjs`; live = in `LIVE_TABLES`)
- `shein_listing_cache` (kind, key, payload, fetched_at) — kinds: `probe`/`last` (the Ask-SHEIN answer),
  `spu`/<spuName> (the compact SHEIN side of one SPU, `spuPayload`), `spu_list`/`current` (the SPUs of
  the last snapshot), `attr_template`/<productTypeId>, `custom_perm`/<categoryId> (24 h).
- `shein_api_log` — every listing-side SHEIN call: path, method, `write`, `dry`, SHEIN code / msg /
  `trace_id`, ms, by, job/item/spu. A read stores no body; a write stores request + answer. Pruned at 90
  days (once per EST day, from the tick).
- `shein_listing_products` (live) — one row per Shopify product (`shopify_product_id` = gid) or per
  SHEIN product none of whose sizes Shopify has (`shein:<spu>`). Roll-up `status`, `counts`
  `{ all, sizes (in stock), on_shein, shein_only, by }`, `blockers`, `spu`, `category_id`, `excluded`,
  `shopify_hash` (listing fields, no stock), `shopify_json` (what the recompute reads), `search_text`.
- `shein_listing_variants` (live) — one row per Shopify variant (`row_key` = variant gid) or SHEIN-only
  size (`shein:<skuCode>`): Shopify side, SHEIN side, `match` (sku|link|published|none), `status`,
  `blockers`/`notes`/`diffs` (`{code, field, params}` only — text comes from `BLOCKERS`), `size_plan`
  (what we'd send for a size not on SHEIN), `target_hash`/`synced_hash`/`synced_fields` (the baseline),
  `excluded` (a person's "Don't list on SHEIN").
- `shein_size_map` (live) — (category_id 0 = any, attribute_id, size_key) → `attribute_value_id` OR a
  person-confirmed `custom_value`; `foot_length`, `source` (exact|person|custom_created), `verified`.
- `shein_listing_jobs` (live) — kind (snapshot|probe|preview|run|recheck), status (queued|running|
  awaiting_confirm|done|stopped|failed|interrupted), lease, phase/total/done/current, counts, resumes.
  **At most one queued/running** (partial unique index).
- `shein_listing_job_items` (live) — snapshot: one `read` item per SPU (seq order); Phase 2: one
  `add_sku` item per product (body, body_hash, idem_key UNIQUE, plan, version, sku_codes, retries…).

## Statuses, matching, sizes (the rules)
- 8 statuses + internal `unknown`; roll-up = worst of the IN-STOCK sizes: blocked > error > out_of_date >
  not_on_shein > shein_only > in_review > synced > excluded. Zero-stock sizes don't count (D10).
- Match: SHEIN `supplierSku` == Shopify `variant.sku`; else a pending `shein_links` relink
  (`link_sku` ≠ what SHEIN shows) → **Needs update** (`out_of_date`, diff `seller_sku`: "SHEIN has the wrong SKU"). Never the SPU/SKC
  `supplierCode` (4seller's borrowed parent SKU), never the title. A SHEIN size no variant has →
  **Not in Shopify** (`shein_only`), under the product owning its SPU (most matched sizes), else a `shein:<spu>` row.
- Needs update also: `mallState 2` while Shopify sells it; a listing field changed on Shopify since the
  baseline. **Baseline (Build log):** the first snapshot that sees a size on SHEIN accepts Shopify's
  then-values (`synced_hash`); a later Shopify price/size/SKU/barcode change → Needs update with the
  "was → now" diff. Stock is never part of it.
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
- **Nightly** 03:00–03:59 EST, once per EST day, from `sheinTick` → production only / `SHEIN_SYNC_WATCH`
  (started_by `auto (nightly 03:00 EST)`; an interrupted nightly is resumed instead).
- **Shopify webhooks** products/create|update: 1.5 s coalesce → `listingHash` (no stock) vs stored →
  re-read that product live → recompute from STORED SHEIN rows (no SHEIN call). Nothing before the first
  snapshot. products/delete → Not listing at once. In-memory queue (a restart drops a pending recheck; the
  nightly catches it). Registered by the admin action `webhooks` (same URL + HMAC as the stock webhook).

## Endpoints (gates: applySecurity → requireRole(['ph_team']) (admin auto) → privilege read fresh → rateLimit → getJsonBody)
- `GET /api/shein/listings?status=&blocker=&q=&brand=&page=&pageSize=50&sort=worst|title|updated|coverage`
  → `{ ok, connected, configured, canWrite, isAdmin, summary, products, total, page, pageSize }`.
  `status` '' = all but Off; `excluded` = Off; `all`. `summary` = `{ all, off, byStatus: {code: {products,
  sizes, inStock}}, tiles, order, topBlockers: [{code, sizes, products, level, title}], brands: [{brand,
  products}], lastSnapshot, latestSnapshot, activeJob, probe: {askedAt, jobId, categories} | null, hooks }`.
  Product rows: the table's columns (no `shopify_json`/`search_text`/`computed_hash`) + rendered
  `blockers`, `worst`, `shopifyUrl`.
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
  `probe {spu?}` → `{ok, job}`, `webhooks` → `{ok, hooks}` (403 otherwise).
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

## The page (`/ph/shein-listings` PH card above "SHEIN ↔ Shopify check"; `/shein-listings` admin, Marketplaces)
- **Who:** PH + admin/superadmin (the endpoints refuse anyone else, so the admin card has NO
  `privKey` — a warehouse holder of Connect integrations would land on 403s). **Ask SHEIN** and
  **Register Shopify webhooks** need admin or `connect_integrations`; others see them disabled with
  the reason in the title. SheinCheck carries a one-line link to the page.
- **Layout** (matches `docs/shein-listings-mockup.html`): connection strip (SHEIN connected · last
  read EST — amber after 30 min · counts · webhooks state · Re-read · Register webhooks) → running-job
  banner (phase, n of total, now-on, Stop, View job) or an **interrupted** banner with Resume → status
  tiles (All · Synced · Not on SHEIN · Needs update · In review · Blocked · Error · Not in Shopify when
  > 0 · Not checked yet when > 0; small line = sizes) + "Not listing (n)" link → tabs Products · Sizes (n to
  map) · Jobs (n running) → "What do the statuses mean?" legend.
- **Products:** search (debounced → `?q=`), brand, reason (= `?blocker=`, from `topBlockers`), 25 a
  page (`?p=`). A row: tick, photo, name, style (copy), vendor, Shopify ↗, SHEIN SPU (copy), roll-up
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
- **Drawer** (`?product=`): requirements (✓/✕ per group of blocker codes + review + category),
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
  empty text with "Clear search and filters".
- **Live:** `useLive` on `shein_listing_products/variants/jobs/job_items` + `shein_size_map` (5 s
  fallback while a job runs). Times through `PH_DATETIME` + literal "EST".
- **URL keys:** `tab` (products default | sizes | jobs) · `status` (§4.1 codes, `excluded` = Not listing) ·
  `q` · `brand` · `blocker` · `p` · `product` · `job` · `sz`. Never: ticks, the custom-size draft, the
  dry-run sheet.
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
  `review_open {sentAt, jobId}`); our last refusal → **Error** (variants' `last_error`, until Shopify
  changes that size; an Error size can be dry-run again). `match 'published'` survives later snapshots.
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
  "price isn't compared" deviation is gone.) The Shopify-baseline diffs stay.
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
- **Tiles / `?status=` (decision 2026-10-27):** a product is listed under EVERY status one of its counted
  sizes has (in-stock + SHEIN-only; else all) — `shein_listing_products.size_statuses`; a tile's count is
  its list's length (tiles may add up to more than All). The roll-up chip still shows the WORST status,
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
  `publish_again_by/at`; `shein_api_log.asset`. D6 lives in `app_settings.shein_box_defaults`.
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
  or missed shoes listed, each opens the drawer; (c) a finished nightly snapshot on every EST night after the start
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
