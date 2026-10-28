// SHEIN Listings — the pure engine (docs/shein-listings-plan.md §4, Appendix B.1/B.3;
// docs/context/shein-listings.md). ONE module, imported by the server (api/_lib/shein-listing.js)
// and by the page, the same way src/lib/sheinLive.js is. It holds:
//   · STATUSES — the 8 statuses (+ internal `unknown`), their labels, chips and roll-up order;
//   · BLOCKERS — every stuck reason, rendered from the stored { code, field, params } (rows never
//     store text, so wording changes never need a migration);
//   · sizeKey / resolveSize — our size → SHEIN's size value, a person's mapping, or a blocker.
//     NEVER the nearest size (that was 4seller's bug: 15.5W went up as 15W);
//   · matchStore — Shopify variant ↔ SHEIN SKU: SHEIN supplierSku == variant.sku, then
//     shein_links.link_sku. NEVER the SPU/SKC supplier_code (the 4seller parent-SKU trap: that code
//     is a borrowed size SKU) and never the title;
//   · variantReadiness / productReadiness / rollup — what status each size and product is in;
//   · listingHash — what counts as "Shopify changed" (stock excluded: the live sync owns stock).
// No I/O, no clock, no crypto import — it runs in the browser too.
import { parseSize, compareSize } from './sheinCheck.js';
import { PH_DATE } from './format.js';

/* -------------------------------- statuses -------------------------------- */

// Roll-up order = worst first (plan §4.1). `unknown` = a row that exists but was never
// snapshotted; it is not a tile.
export const STATUS_ORDER = ['blocked', 'error', 'out_of_date', 'not_on_shein', 'shein_only', 'in_review', 'synced', 'excluded'];
export const STATUSES = {
  blocked: { label: 'Blocked', chip: 'ebo-chip bad', meaning: 'Can’t be sent until something is fixed. The row says what and has the button.' },
  error: { label: 'Error', chip: 'ebo-chip warn', meaning: 'We tried; SHEIN refused, rejected it in review, or didn’t answer. Shows SHEIN’s message.' },
  out_of_date: { label: 'Needs update', chip: 'ebo-chip info', meaning: 'On SHEIN, but differs from Shopify (price, SHEIN has the wrong SKU, stopped size, our listing changed).' },
  not_on_shein: { label: 'Not on SHEIN', chip: 'ebo-chip', meaning: 'Ready to list. Nothing is wrong.' },
  shein_only: { label: 'Not in Shopify', chip: 'ebo-chip warn shl-outline', meaning: 'A SHEIN size whose seller SKU Shopify doesn’t have (the live fix holds it at 0).' },
  in_review: { label: 'In review', chip: 'ebo-chip violet', meaning: 'Sent; SHEIN is reviewing it.' },
  synced: { label: 'Synced', chip: 'ebo-chip ok', meaning: 'On SHEIN and approved; size, SKU and price match Shopify.' },
  excluded: { label: 'Not listing', chip: 'ebo-chip shl-off', meaning: 'A Shopify draft, or marked “Don’t list on SHEIN” by a person. Not in the tile counts.' },
  unknown: { label: 'Not checked yet', chip: 'ebo-chip', meaning: 'Never snapshotted.' },
};
export const STATUS_CODES = [...STATUS_ORDER, 'unknown'];
// The tiles (filters). `excluded` is the "Off (n)" link, not a tile.
export const TILE_STATUSES = STATUS_ORDER.filter((s) => s !== 'excluded');
const rank = (s) => { const i = STATUS_ORDER.indexOf(s); return i < 0 ? STATUS_ORDER.length : i; };

/* -------------------------------- blockers -------------------------------- */

const sz = (p) => p?.size || 'this size';
const cat = (p) => p?.categoryName || (p?.categoryId ? `SHEIN category ${p.categoryId}` : 'this category');
const said = (p) => (p?.sheinMessage ? ` SHEIN said: “${p.sheinMessage}”` : '');
const shopifyLink = { kind: 'open_shopify', label: 'Open in Shopify ↗' };

// BLOCKERS[code] = { level: blocked|error|review|note, scope: store|product|variant,
//   applies: [publish|edit|add_sizes|always], title(params), fix(params), action }.
// `action` is { kind, label, href? } or a function of params returning one (null = no button).
// Rows store only { code, field, params }; renderBlocker() turns that into words.
export const BLOCKERS = {
  // 1–4 · sizes
  size_needs_map: { level: 'blocked', scope: 'variant', applies: ['publish', 'add_sizes'],
    title: (p) => `${sz(p)} isn’t a SHEIN size yet.`,
    fix: (p) => `SHEIN allows custom sizes in ${cat(p)}. Confirm the spelling once${p?.suggestion ? ` (we suggest “${p.suggestion}”)` : ''} — it is store-wide and permanent.`,
    action: (p) => ({ kind: 'add_custom_size', label: `Add ${p?.size || 'it'} as a custom size` }) },
  size_not_on_shein: { level: 'blocked', scope: 'variant', applies: ['publish', 'add_sizes'],
    title: (p) => `This size can’t be listed on SHEIN: SHEIN has no ${sz(p)} and won’t take a custom size in ${cat(p)}.`,
    fix: () => 'It’s SHEIN’s rule, not our choice. Ask SHEIN support to allow custom sizes in this category, or stop showing it here. We never pick a different size.',
    action: { kind: 'leave_off', label: 'Don’t list on SHEIN' } },
  size_unreadable: { level: 'blocked', scope: 'variant', applies: ['always'],
    title: (p) => `“${p?.size ?? ''}” isn’t a US size we can read.`,
    fix: () => 'Fix the size on Shopify (e.g. 9.5, 7W, 5Y, 4C).', action: shopifyLink },
  custom_text_invalid: { level: 'blocked', scope: 'variant', applies: ['publish', 'add_sizes'],
    title: (p) => `Size name not allowed${p?.text ? `: “${p.text}”` : ''}.`,
    fix: (p) => `${p?.why || 'Over 50 characters, full-width characters or emoji'} — fix the spelling on the Sizes tab.`,
    action: { kind: 'edit_size_map', label: 'Fix the spelling' } },
  // 5–9 · seller SKUs and links
  no_seller_sku: { level: 'blocked', scope: 'variant', applies: ['always'],
    title: () => 'This size has no SKU on Shopify.', fix: () => 'Give the variant a SKU on Shopify.', action: shopifyLink },
  dup_seller_sku: { level: 'blocked', scope: 'variant', applies: ['always'],
    title: (p) => `SKU ${p?.sku || ''} is on ${p?.count || 2} Shopify variants.`, fix: () => 'Make each variant’s SKU unique on Shopify.', action: shopifyLink },
  seller_sku_taken: { level: 'blocked', scope: 'variant', applies: ['publish', 'add_sizes'],
    title: (p) => `SKU ${p?.sku || ''} is already on another SHEIN product${p?.spu ? ` (${p.spu})` : ''}.`,
    fix: () => 'Fix that SHEIN product first (Match sizes), then add this size.',
    action: { kind: 'open_match', label: 'Show the other product', href: '/ph/shein-check?tab=match' } },
  wrong_link: { level: 'blocked', scope: 'variant', applies: ['always'],
    title: (p) => `SHEIN ${p?.sheinSize || 'size'} carries this SKU${p?.size ? ` (Shopify size ${p.size})` : ''}.`,
    fix: () => 'The live fix holds it at 0. Pick the SKU it should carry (Match sizes), then dry run this shoe.', action: { kind: 'open_match', label: 'Match sizes', here: true } },
  spu_spans_products: { level: 'blocked', scope: 'variant', applies: ['always'],
    title: (p) => `SHEIN product ${p?.spu || ''} carries sizes of ${p?.count || 2} Shopify products.`,
    fix: () => 'Decide which Shopify product it belongs to on Match sizes.', action: { kind: 'open_match', label: 'Match sizes', here: true } },
  // 10–19 · what a listing needs
  no_size_table_value: { level: 'blocked', scope: 'variant', applies: ['publish', 'add_sizes'],
    title: (p) => `No foot length for ${sz(p)} (SHEIN’s size chart needs one).`, fix: () => 'Add it on the Sizes tab.',
    action: { kind: 'edit_size_map', label: 'Add foot length' } },
  missing_attr: { level: 'blocked', scope: 'product', applies: ['publish', 'edit', 'add_sizes'],
    title: (p) => `Missing SHEIN detail: ${p?.attribute || 'a required attribute'}.`, fix: () => 'Set it once for the product type.', action: { kind: 'set_attr', label: 'Set it' } },
  no_category: { level: 'blocked', scope: 'product', applies: ['publish'],
    title: (p) => `No SHEIN category picked.${p?.suggestion ? ` We suggest ${p.suggestion}.` : ''}`, fix: () => 'Choose the SHEIN category.', action: { kind: 'choose_category', label: 'Choose category' } },
  brand_not_authorized: { level: 'blocked', scope: 'product', applies: ['publish'],
    title: (p) => `${p?.brand || 'This brand'} isn’t an authorised brand on our SHEIN store.`, fix: () => 'An admin applies for it in Seller Center.',
    action: { kind: 'open_seller_center', label: 'Seller Center ↗' } },
  no_image: { level: 'blocked', scope: 'product', applies: ['publish'],
    // ph: null = Shopify's photos counted · 0 = "Use PH edited photos" is on but the PH team has none for the style · n = PH photos counted
    title: (p) => `Only ${p?.count ?? 0} ${Number(p?.ph) > 0 ? 'PH edited ' : ''}photo${Number(p?.count) === 1 ? '' : 's'}, SHEIN needs ${p?.need ?? 3}.`,
    fix: (p) => (p?.ph === 0 ? `“Use PH edited photos” is on, but the PH team has no edited photos for ${p?.style || 'this style'} yet — upload them (or add photos on Shopify).`
      : Number(p?.ph) > 0 ? `Upload more PH edited photos for ${p?.style || 'this style'}, or switch back to Shopify’s photos.` : 'Use the PH edited photos, or add photos on Shopify.'),
    action: (p) => (p?.ph == null ? { kind: 'use_ph_photos', label: 'Use PH edited photos' } : null) },
  image_rejected: { level: 'blocked', scope: 'product', applies: ['publish'],
    title: (p) => `Photo rejected: ${p?.reason || p?.sheinMessage || 'no reason given'}.`, fix: () => 'Replace the photo.', action: shopifyLink },
  title_too_long: { level: 'blocked', scope: 'product', applies: ['publish'],
    title: (p) => (p?.why === 'too_short' ? 'The title is too short for SHEIN (at least 2 characters).' : `Title is ${p?.length ?? '?'} characters, SHEIN allows ${p?.max ?? '?'}.`),
    fix: () => 'Shorten it for SHEIN in the drawer (Review title) — Shopify is not changed.', action: { kind: 'review_title', label: 'Review title' } },
  // Phase 4 (publish brand-new products)
  fill_required: { level: 'blocked', scope: 'product', applies: ['publish'],
    title: (p) => `SHEIN requires “${p?.field || 'a field'}” in this category, which we can’t fill yet.`, fix: () => 'Tell an admin — it needs a decision (or list it in Seller Center).', action: null },
  mixed_size_groups: { level: 'blocked', scope: 'product', applies: ['publish'],
    title: (p) => `This Shopify product mixes size groups (${(p?.groups || []).join(', ')}).`, fix: () => 'SHEIN lists one size group per product — split it on Shopify.', action: { kind: 'open_shopify', label: 'Open in Shopify ↗' } },
  no_warehouse: { level: 'blocked', scope: 'store', applies: ['publish'],
    title: () => 'SHEIN shows no US default merchant warehouse for the store.', fix: () => 'Set one in Seller Center.', action: null },
  photos_need_priv: { level: 'note', scope: 'product', applies: ['publish'],
    title: () => 'Photos weren’t converted for this dry run.', fix: () => 'Photos are converted when an admin or Connect integrations holder runs the dry run.', action: null },
  photo_cap_reached: { level: 'blocked', scope: 'store', applies: ['publish'],
    title: (p) => `Today’s photo-conversion limit is used up (${p?.used ?? '?'} of ${p?.cap ?? '?'} SHEIN conversions, EST day).`,
    fix: () => 'Dry run again tomorrow (EST) — or an admin raises the daily limit (setting shein_transform_cap).', action: null },
  brand_list_unread: { level: 'note', scope: 'product', applies: ['publish'],
    title: (p) => `SHEIN’s brand list couldn’t be read, so ${p?.brand || 'the brand'} isn’t confirmed as authorised.`, fix: () => 'Dry run again in a few minutes — nothing is sent until the list is read.', action: null },
  language_not_en: { level: 'blocked', scope: 'store', applies: ['publish'],
    title: (p) => `SHEIN’s default language for this category is “${p?.language || '?'}”, not English.`, fix: () => 'We only write English titles — check the store’s language in Seller Center before publishing.', action: null },
  brand_unset: { level: 'blocked', scope: 'product', applies: ['publish'],
    title: (p) => (p?.why === 'title_brand' ? `${p?.brand || 'This vendor'} is marked “no brand”, but the title names ${p?.titleBrand || 'a known brand'}.` : `${p?.brand || 'This vendor'} isn’t mapped to a SHEIN brand.`),
    fix: (p) => (p?.known ? 'Map it to the brand on the Setup tab — a known brand never goes up unbranded (an admin applies for it in Seller Center if SHEIN doesn’t list it).'
      : 'Map it to a SHEIN brand on the Setup tab — or, for a real generic product, mark the vendor “no brand”.'), action: { kind: 'map_brand', label: 'Map the brand' } },
  brand_none: { level: 'note', scope: 'product', applies: ['publish'],
    title: (p) => `${p?.brand || 'This vendor'} is marked “no brand” — it goes up without one.`, fix: () => '', action: null },
  unit_unverified: { level: 'note', scope: 'product', applies: ['publish'],
    title: () => 'SHEIN’s weight / size units for this category couldn’t be read — we send cm and grams.', fix: () => 'Check the first approved product’s box size on SHEIN.', action: null },
  publish_unconfirmed: { level: 'error', scope: 'product', applies: ['publish'],
    title: () => 'SHEIN didn’t confirm the new product.', fix: (p) => (p?.sendAgainOk ? 'Two looks found nothing on SHEIN — an admin may Send again.'
      : 'It is never sent again by itself (a second product would use quota for good). Press Look again in 15 min.'), action: { kind: 'look_again', label: 'Look again' } },
  compliance_missing: { level: 'note', scope: 'product', applies: ['publish'],
    title: (p) => `SHEIN asks for compliance: ${p?.name || 'a certificate'}.`, fix: () => 'Upload it in Seller Center.', action: null },
  publish_rejected: { level: 'blocked', scope: 'product', applies: ['publish'],
    title: (p) => `SHEIN rejected the first publish${p?.failedReason ? `: “${p.failedReason}”` : ''}.`, fix: () => 'Fix it, then an admin presses “Publish again” (SHEIN may still count the old SKUs).', action: { kind: 'publish_again', label: 'Publish again' } },
  publish_in_flight: { level: 'review', scope: 'product', applies: ['publish'],
    title: () => 'Already sent to SHEIN — waiting for its review.', fix: () => '', action: null },
  box_unconfirmed: { level: 'blocked', scope: 'store', applies: ['publish'],
    title: () => 'The default box size and weight are placeholders nobody confirmed.', fix: () => 'An admin checks and saves them once (SHEIN needs L × W × H + grams per size).', action: { kind: 'set_defaults', label: 'Confirm box sizes' } },
  no_price: { level: 'blocked', scope: 'variant', applies: ['publish', 'add_sizes'],
    title: (p) => `No price for size ${p?.size || ''}.`.replace(' .', '.'), fix: () => 'Set the price on Shopify.',
    action: { kind: 'open_shopify_listings', label: 'Open in Shopify Listings', href: '/ph/shopify-listings' } },
  no_weight: { level: 'blocked', scope: 'product', applies: ['publish'],
    title: () => 'No box size / weight and no default for this type.', fix: () => 'Set the default box size and weight for the type.', action: { kind: 'set_defaults', label: 'Set the default' } },
  store_cannot_publish: { level: 'blocked', scope: 'store', applies: ['publish'],
    title: (p) => `SHEIN won’t take new listings: ${p?.reason || p?.sheinMessage || 'no reason given'}.`, fix: () => 'A person sorts it out in Seller Center.', action: null },
  publish_quota_used: { level: 'blocked', scope: 'store', applies: ['publish'],
    title: () => 'This month’s SHEIN publish quota is used up.', fix: () => 'Wait for next month, or ask SHEIN for more.', action: null },
  shelf_quota_full: { level: 'blocked', scope: 'store', applies: ['publish'],
    title: () => 'SHEIN’s shelf limit for the store is reached.', fix: () => 'Take something off the shelf, or ask SHEIN for more.', action: null },
  multi_skc_size: { level: 'blocked', scope: 'variant', applies: ['add_sizes'],
    title: () => 'Add this size to every colour of this SHEIN product.', fix: () => 'SHEIN needs the same sizes on every colour. Add to all, or skip.', action: { kind: 'skip', label: 'Skip' } },
  // 20–25 · what SHEIN answered
  size_field_retired: { level: 'error', scope: 'product', applies: ['add_sizes'],
    title: () => 'SHEIN retired this product’s size field; sizes can’t be added.', fix: () => 'Re-list it as a new product (next phases).', action: null },
  review_open: { level: 'review', scope: 'product', applies: ['edit', 'add_sizes'],
    title: (p) => `SHEIN is reviewing an earlier edit${p?.sentAt ? ` (sent ${p.sentAt} EST)` : ''}.`, fix: () => 'We retry after the review closes.', action: { kind: 'check_review', label: 'Check now' } },
  review_rejected: { level: 'error', scope: 'product', applies: ['publish', 'edit', 'add_sizes'],
    title: (p) => `SHEIN rejected it: “${p?.failedReason || p?.sheinMessage || 'no reason given'}”.`, fix: () => 'Fix it, then send again.', action: { kind: 'send_again', label: 'Send again' } },
  shein_prevalid: { level: 'error', scope: 'product', applies: ['publish', 'edit', 'add_sizes'],
    title: (p) => `SHEIN pre-check: ${p?.module ? `${p.module}: ` : ''}${p?.sheinMessage || 'refused'}.`, fix: () => 'Usually a person has to fix the listing.', action: null },
  price_locked: { level: 'note', scope: 'variant', applies: ['edit'],
    title: () => 'In a SHEIN promotion: price can’t go up.', fix: () => 'Wait for the promotion to end.', action: null },
  shelf_locked: { level: 'note', scope: 'variant', applies: ['edit'],
    title: () => 'In a SHEIN promotion: can’t come off the shelf.', fix: () => 'Wait for the promotion to end.', action: null },
  api_error: { level: 'error', scope: 'variant', applies: ['always'],
    title: (p) => `Last call failed: ${p?.sheinMessage || p?.message || 'no answer'}${p?.traceId ? ` (trace ${p.traceId})` : ''}.`, fix: () => 'Retry.', action: { kind: 'retry', label: 'Retry' } },
  // notes (not blockers)
  custom_size: { level: 'note', scope: 'variant', applies: ['publish', 'add_sizes'],
    title: (p) => `Will add ${p?.text || 'a custom size'} as a new size.`, fix: () => '', action: null },
  shopify_inactive: { level: 'note', scope: 'product', applies: ['always'],
    title: (p) => (!p?.status || p.status === 'DRAFT' ? 'Not listing — draft on Shopify.' : `Not listing — ${p.status[0]}${p.status.slice(1).toLowerCase()} on Shopify. Only active products are listed.`), fix: () => '', action: shopifyLink },
  // 2026-10-28 (user): a Shopify shoe with NO stock (0 pairs across its listed sizes) is never sent by
  // the LISTING syncs (publish / add sizes / update prices & sizes) — the dry run skips it with this.
  // The STOCK sync is untouched: a shoe going to 0 still has SHEIN set to 0 (shein-live.js).
  no_shopify_stock: { level: 'blocked', scope: 'product', applies: ['publish', 'edit', 'add_sizes'],
    title: () => 'No Shopify stock — not sent to SHEIN.',
    fix: () => 'Nothing to do: the listing syncs skip a shoe with 0 pairs on Shopify. Once it has stock, dry run it again. (The stock sync still keeps SHEIN at 0.)', action: null },
  // Added in the build (docs/shein-listings-plan.md → Build log).
  size_unchecked: { level: 'note', scope: 'variant', applies: ['publish', 'add_sizes'],
    title: (p) => (p?.reason === 'no_category' ? 'No SHEIN category yet, so this size can’t be checked against SHEIN’s list.' : `SHEIN’s size list for ${cat(p)} hasn’t been read yet.`),
    fix: (p) => (p?.reason === 'no_category' ? 'Comes with publishing new products (a later phase).' : 'Run “Re-read Shopify + SHEIN” (or Ask SHEIN).'), action: null },
  dup_on_shein: { level: 'note', scope: 'variant', applies: ['always'],
    title: (p) => `Another SHEIN size${p?.sheinSize ? ` (${p.sheinSize})` : ''} carries the same seller SKU.`, fix: () => 'The live fix sells it from one of them only.', action: null },
  excluded_by_person: { level: 'note', scope: 'variant', applies: ['always'],
    title: (p) => `Not listing — ${p?.by || 'a person'} chose not to list it on SHEIN${p?.at && !Number.isNaN(new Date(p.at).getTime()) ? ` (${PH_DATE.format(new Date(p.at))} EST)` : ''}.`, fix: () => '', action: { kind: 'include', label: 'List on SHEIN again' } },
  // Added in Phase 2 (add sizes — docs/shein-listings-plan.md → Build log).
  size_already_on_shein: { level: 'blocked', scope: 'variant', applies: ['add_sizes'],
    title: (p) => `SHEIN already has ${p?.sheinSize || 'this size'}${p?.sellerSku ? ` (seller SKU ${p.sellerSku})` : ''}.`,
    fix: () => 'Change the SKU on that SHEIN size to this one (Match sizes) instead of adding a second one.', action: { kind: 'open_match', label: 'Match sizes', here: true } },
  not_on_shein_product: { level: 'note', scope: 'product', applies: ['add_sizes'],
    title: () => 'This shoe isn’t on SHEIN yet, so there is no SHEIN product to add sizes to.', fix: () => 'Publishing new shoes comes in a later phase.', action: null },
  nothing_to_add: { level: 'note', scope: 'product', applies: ['add_sizes'],
    title: () => 'No size to add: every Shopify size is on SHEIN, not listing, or blocked.', fix: () => '', action: null },
  custom_unconfirmed: { level: 'blocked', scope: 'variant', applies: ['add_sizes', 'publish'],
    title: (p) => `The spelling “${p?.text || ''}” for ${sz(p)} wasn’t confirmed by a person.`,
    fix: () => 'Confirm the spelling on the Sizes tab (a custom size is store-wide and permanent).', action: { kind: 'edit_size_map', label: 'Confirm the spelling' } },
  shopify_changed: { level: 'note', scope: 'product', applies: ['add_sizes', 'edit', 'publish'],
    title: () => 'Shopify (or SHEIN) changed since the dry run — nothing was sent.', fix: () => 'Dry run again, check it, then run.', action: { kind: 'dry_run', label: 'Dry run again' } },
  size_field_unclear: { level: 'blocked', scope: 'product', applies: ['add_sizes'],
    title: (p) => (p?.why === 'two_attrs' ? 'This SHEIN product’s sizes carry more than one sale attribute (e.g. size + width), so a size can’t be added safely.'
      : 'We can’t tell which SHEIN field is this product’s size, so a size can’t be added safely.'),
    fix: () => 'Add it in Seller Center by hand, or ask us to support this product shape.', action: null },
  size_table_not_yet: { level: 'blocked', scope: 'product', applies: ['add_sizes'],
    title: () => 'This SHEIN product has a size chart — adding sizes to it isn’t supported yet.',
    fix: () => 'SHEIN needs the whole chart re-sent with every new size; that comes after the pilot. Add it in Seller Center for now.', action: null },
  skc_field_uncopyable: { level: 'blocked', scope: 'product', applies: ['add_sizes'],
    title: (p) => (p?.why === 'fill_unread' ? 'We couldn’t read SHEIN’s listing rules for this category, so we can’t tell what an edit would clear.'
      : p?.field === 'competing_product_link' ? 'SHEIN wants a reference link on this store’s SKUs, which we can’t read back — sending would clear it.'
        : 'SHEIN wants a colour title on this product that we can’t read back — sending would clear it.'),
    fix: () => 'Add the size in Seller Center for now.', action: null },
  shein_note: { level: 'note', scope: 'product', applies: ['add_sizes'],
    title: (p) => `SHEIN noted: ${p?.sheinMessage || 'a warning'}.`, fix: () => '', action: null },
  // Phase 3 (re-sync out-of-date listings).
  special_price_conflict: { level: 'blocked', scope: 'variant', applies: ['edit'],
    title: (p) => `SHEIN’s special price $${p?.special ?? '?'} is at or above the new price $${p?.to ?? '?'}.`,
    fix: () => 'SHEIN needs the original price above the special price — end the special price in Seller Center first.', action: null },
  special_live: { level: 'note', scope: 'variant', applies: ['edit'],
    title: (p) => `SHEIN special $${p?.special ?? '?'} is live (original $${p?.base ?? '?'}) — the target is $${p?.to ?? '?'}.`,
    fix: () => 'We don’t change a price under a live special by ourselves. Change it in Seller Center, or dry run with “end the special”.', action: null },
  price_lock_unread: { level: 'blocked', scope: 'variant', applies: ['edit'],
    title: () => 'We couldn’t read SHEIN’s promotion locks, so no price goes UP for this product.', fix: () => 'Dry run again later (price cuts still go).', action: null },
  price_lock_warn: { level: 'note', scope: 'variant', applies: ['edit'],
    title: () => 'In a SHEIN promotion that only warns about price changes — changing it may affect the promotion.', fix: () => '', action: null },
  price_review_stuck: { level: 'error', scope: 'variant', applies: ['edit'],
    title: () => 'SHEIN never answered the price review.', fix: () => 'Check the price in Seller Center — we don’t send it again while SHEIN may still be reviewing it.', action: null },
  shein_title_too_long: { level: 'blocked', scope: 'product', applies: ['edit', 'add_sizes'],
    title: (p) => `SHEIN’s title is ${p?.length ?? '?'} characters; SHEIN now allows ${p?.max ?? '?'}.`,
    fix: () => 'SHEIN re-checks the whole product on every edit — shorten the title in Seller Center first.', action: null },
  auto_capped: { level: 'note', scope: 'variant', applies: ['edit'],
    title: () => 'Automatic re-sync: cut limited to 15 % a day and never below the Shopify price.', fix: () => '', action: null },
  shelf_wait: { level: 'note', scope: 'variant', applies: ['edit'],
    title: () => 'This shoe was put on / taken off SHEIN’s shelf less than 20 minutes ago.', fix: () => 'SHEIN refuses a second change within 20 minutes — dry run again later.', action: null },
  nothing_to_edit: { level: 'note', scope: 'product', applies: ['edit'],
    title: () => 'Nothing to change on SHEIN for this product.', fix: () => '', action: null },
  title_not_ours: { level: 'note', scope: 'product', applies: ['edit'],
    title: () => 'The title differs from Shopify, but 4seller listed this product — we don’t change its title or photos.', fix: () => '', action: null },
  images_later: { level: 'note', scope: 'product', applies: ['edit'],
    title: () => 'Photo changes go up with publishing (a later phase).', fix: () => '', action: null },
  too_many_prices: { level: 'blocked', scope: 'product', applies: ['edit'],
    title: () => 'More than 100 prices on one product.', fix: () => 'SHEIN takes 100 a call — change it in Seller Center.', action: null },
  already_sent: { level: 'note', scope: 'product', applies: ['add_sizes'],
    title: (p) => `This exact change was already sent${p?.jobId ? ` (job #${p.jobId})` : ''}.`, fix: () => 'Nothing to do — it is with SHEIN.', action: null },
};

// A stored { code, field, params } → the words and the button.
export function renderBlocker(b) {
  const code = b?.code || 'api_error';
  const def = BLOCKERS[code];
  const params = b?.params || {};
  if (!def) return { code, field: b?.field || null, params, level: 'error', scope: 'variant', title: `Unknown problem (${code}).`, fix: '', action: null, sheinSaid: params.sheinMessage || null };
  const action = typeof def.action === 'function' ? def.action(params) : def.action;
  return { code, field: b?.field || null, params, level: def.level, scope: def.scope, applies: def.applies,
    title: def.title(params), fix: def.fix(params), action: action || null, sheinSaid: params.sheinMessage || null };
}
export const blocker = (code, params = {}, field = null) => ({ code, field, params });
const isNote = (b) => ['note', 'review'].includes(BLOCKERS[b.code]?.level);

// The LISTING syncs' gate (2026-10-28): a product is sent to SHEIN (publish, add sizes, update prices &
// sizes) only when Shopify has it ACTIVE with stock > 0 across its sizes a person didn't leave off.
// `product` = the live / stored Shopify product ({ status, variants:[{ variantId, qty }] }) → null (OK)
// or the blocker that skips it: shopify_inactive (draft / archived / deleted) · no_shopify_stock.
// The STOCK sync never calls this — a shoe at 0 must still be set to 0 on SHEIN.
export function listingSyncGate(product, excluded = new Set()) {
  if (!product) return blocker('shopify_inactive', { status: 'DELETED' });
  const st = String(product.status || '').toUpperCase();
  if (st !== 'ACTIVE') return blocker('shopify_inactive', { status: st || null });
  const live = (product.variants || []).filter((v) => !excluded.has(v.variantId));
  const total = live.reduce((n, v) => n + Math.max(0, Number(v.qty) || 0), 0);
  return total > 0 ? null : blocker('no_shopify_stock', { sizes: live.length });
}
// The same rule on a stored list row (shopify_status + counts.sizes = in-stock sizes not left off):
// what the page's "Active (in stock)" filter and the ticked-products bar use. SHEIN-only rows → false.
export const rowSyncable = (p) => !!p && !String(p.shopify_product_id || '').startsWith('shein:')
  && String(p.shopify_status || '').toUpperCase() === 'ACTIVE' && Number(p.counts?.sizes || 0) > 0;
export const rowSyncWhy = (p) => (String(p?.shopify_status || '').toUpperCase() !== 'ACTIVE' ? 'not active on Shopify' : 'no Shopify stock');

/* ---------------------------------- sizes ---------------------------------- */

const GROUP_CODE = { adult: 'M', women: 'W', youth: 'Y', child: 'C' };
// "9.5W" → "9.5|W"; "10" → "10|M"; "5Y" → "5|Y"; "4C" → "4|C". null = not a US size we can read.
export function sizeKey(raw) {
  const p = parseSize(raw);
  if (p.system !== 'US' || !GROUP_CODE[p.group]) return null;
  return `${p.n}|${GROUP_CODE[p.group]}`;
}
// Numeric sort key for a size (TD < PS < GS < adult, then the number).
export function sizeSort(raw) {
  const p = parseSize(raw);
  if (p.system !== 'US') return 9_000;
  const g = { child: 0, youth: 1, women: 2, adult: 3 }[p.group] ?? 4;
  return g * 1000 + p.n * 10;
}

// SHEIN's custom value rules (doc 3002047, "custom sizes, new scheme"): ≤ 50 characters, half-width
// symbols only, "不支持unicode", no emoji (SHEIN's own pattern [\uD83C-\uDBFF\uDC00-\uDFFF\u2600-\u27ff]).
// A custom value is permanent and de-duplicated store-wide by EXACT text, so a look-alike (a
// non-breaking or zero-width space, a curly quote, "½", "Ü", two spaces) would be a second, dead
// size: only printable ASCII with single spaces is accepted (review M3).
const EMOJI = /[\uD83C-\uDBFF\uDC00-\uDFFF\u2600-\u27FF]/;
const FULL_WIDTH = /[\u3000-\u303F\uFF01-\uFFEF]/;
const PLAIN = /^[\x21-\x7E](?:[\x21-\x7E]| (?! ))*$/;
export function validateCustomText(text) {
  const t = String(text ?? '');
  if (!t.trim()) return 'Type the size name.';
  if (t !== t.trim()) return 'No spaces at the start or end.';
  if (t.length > 50) return `Too long: ${t.length} characters, SHEIN allows 50.`;
  if (FULL_WIDTH.test(t)) return 'Full-width characters aren’t allowed (use plain half-width letters, digits and symbols).';
  if (EMOJI.test(t)) return 'Emoji and symbols like ★ aren’t allowed.';
  if (/[\u0000-\u001F\u007F]/.test(t)) return 'Control characters aren’t allowed.';
  if (/ {2}/.test(t)) return 'One space at a time.';
  if (!PLAIN.test(t)) return 'Only plain keyboard characters (A–Z, 0–9, . - / and single spaces) — no accents, curly quotes, ½ or invisible spaces.';
  return null;
}
// A spelling that would clash with what SHEIN / the store already has (review M3):
//   · the same text as an existing store custom value but for case or spacing ("us 9.5w" vs
//     "US 9.5W") — SHEIN would create a second value; use the existing one exactly;
//   · one of SHEIN's OWN sizes for the category (compareSize 'ok') — pick that size instead.
// `values` = SHEIN's template [{ id, label, custom }]; `customValues` = store-wide custom texts.
const squash = (t) => String(t ?? '').toLowerCase().replace(/\s+/g, '');
export function customTextConflict(text, { values = [], customValues = [] } = {}) {
  const t = String(text ?? '');
  const store = [...new Set([...(customValues || []), ...(values || []).filter((v) => v.custom).map((v) => v.label)])];
  const like = store.find((c) => c !== t && squash(c) === squash(t));
  if (like) return `The store already has “${like}” — use that exact spelling (SHEIN would make “${t}” a second size).`;
  const own = (values || []).find((v) => !v.custom && (squash(v.label) === squash(t) || compareSize(v.label, t) === 'ok'));
  if (own) return `SHEIN has this size: “${own.label}” — pick it instead of a custom size.`;
  return null;
}

// D1: copy SHEIN's own pattern for the category. If SHEIN writes "US7W" ours is "US14.5W";
// "US 7W" → "US 14.5W". A custom value already in the store for the same size wins as typed.
export function suggestCustomSpelling(shopifySize, labels = [], existingCustom = []) {
  const p = parseSize(shopifySize);
  if (p.system !== 'US' || !GROUP_CODE[p.group]) return null;
  const same = existingCustom.find((t) => compareSize(t, shopifySize) === 'ok');
  if (same) return same;
  // The store's own custom values set the pattern once one exists ("use the same pattern for all
  // others"); else SHEIN's standard sizes for the category.
  const customUs = existingCustom.filter((l) => parseSize(l).system === 'US');
  const us = customUs.length ? customUs : labels.filter((l) => parseSize(l).system === 'US');
  const spaced = us.some((l) => /^US\s+\d/i.test(String(l).trim()));
  const mark = p.group === 'women' ? 'W' : p.group === 'youth' ? 'Y' : p.group === 'child' ? 'C' : '';
  const peer = us.find((l) => parseSize(l).group === p.group && mark && new RegExp(`\\d\\s+${mark}$`, 'i').test(String(l).trim()));
  return `US${spaced ? ' ' : ''}${p.n}${peer ? ' ' : ''}${mark}`;
}

// Our size → what SHEIN gets. ctx:
//   categoryId, attributeId (the size attribute), values [{ id, label, custom }] (SHEIN's
//   template for the category's product type), permission 1|0|null (custom values allowed for
//   store + category + size attribute; null = not read yet), maps (shein_size_map rows),
//   sizeTable (the SHEIN product has a size chart), customValues (store-wide custom texts).
// → { key, kind: 'value'|'custom'|null, valueId, label, source, blocker, note }
// Never the nearest size: only an EXACT compareSize 'ok' is taken automatically.
export function resolveSize(shopifySize, ctx = {}) {
  const key = sizeKey(shopifySize);
  const out = { key, kind: null, valueId: null, label: null, source: null, blocker: null, note: null };
  if (!key) { out.blocker = blocker('size_unreadable', { size: String(shopifySize ?? '') }, 'size'); return out; }
  const category = Number(ctx.categoryId) || 0;
  const attr = Number(ctx.attributeId) || 0;
  const maps = ctx.maps || [];
  const map = maps.find((m) => Number(m.category_id) === category && Number(m.attribute_id) === attr && m.size_key === key)
    || maps.find((m) => Number(m.category_id) === 0 && (Number(m.attribute_id) === attr || Number(m.attribute_id) === 0) && m.size_key === key);
  const needFoot = (m) => (ctx.sizeTable && !(m && m.foot_length != null && m.foot_length !== '') ? blocker('no_size_table_value', { size: String(shopifySize) }, 'size') : null);
  out.map = map || null;   // Phase 2 reads who confirmed it (set_by) and its foot length
  if (map?.attribute_value_id) {
    Object.assign(out, { kind: 'value', valueId: Number(map.attribute_value_id), label: map.shein_label || null, source: map.source || 'person' });
    out.blocker = needFoot(map);
    return out;
  }
  if (map?.custom_value) {
    const bad = validateCustomText(map.custom_value);
    if (bad) { out.blocker = blocker('custom_text_invalid', { size: String(shopifySize), text: map.custom_value, why: bad }, 'size'); return out; }
    // Custom values are allowed per store + category + size attribute (has_permission 1) — a
    // spelling confirmed somewhere else is never sent where SHEIN doesn't allow it (review M1).
    if (ctx.permission !== 1 && category) {
      if (ctx.permission === 0) out.blocker = blocker('size_not_on_shein', { size: String(shopifySize), categoryId: category, categoryName: ctx.categoryName || null }, 'size');
      else out.note = blocker('size_unchecked', { size: String(shopifySize), categoryId: category });
      return out;
    }
    Object.assign(out, { kind: 'custom', label: map.custom_value, source: map.source || 'custom' });
    out.note = blocker('custom_size', { size: String(shopifySize), text: map.custom_value });
    out.blocker = needFoot(map);
    return out;
  }
  if (!category) { out.note = blocker('size_unchecked', { size: String(shopifySize), reason: 'no_category' }); return out; }
  const values = ctx.values || null;
  const hit = (values || []).find((v) => !v.custom && compareSize(v.label, shopifySize) === 'ok');
  if (hit) {
    Object.assign(out, { kind: 'value', valueId: Number(hit.id), label: hit.label, source: 'exact' });
    out.blocker = needFoot(null);
    return out;
  }
  const params = { size: String(shopifySize), categoryId: category, categoryName: ctx.categoryName || null };
  if (ctx.permission === 1) {
    const customs = [...new Set([...(ctx.customValues || []), ...(values || []).filter((v) => v.custom).map((v) => v.label)])];
    out.blocker = blocker('size_needs_map', { ...params, suggestion: suggestCustomSpelling(shopifySize, (values || []).filter((v) => !v.custom).map((v) => v.label), customs) }, 'size');
    return out;
  }
  if (ctx.permission === 0) { out.blocker = blocker('size_not_on_shein', params, 'size'); return out; }
  out.note = blocker('size_unchecked', params);
  return out;
}

/* ------------------------------ Shopify shape ------------------------------ */

const money = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v).toFixed(2));
const numId = (gid) => String(gid ?? '').split('/').pop();
const trim = (v) => String(v ?? '').trim();

// One normalized Shopify product, from the GraphQL catalogue (shopifyListingCatalogue) —
// already in this shape — or from a REST webhook payload (products/create|update).
export function normalizeWebhookProduct(p) {
  if (!p || p.id == null) return null;
  const optionNames = (p.options || []).map((o) => ({ name: String(o.name || ''), position: Number(o.position) || 0 }));
  const sizePos = (optionNames.find((o) => /size/i.test(o.name)) || {}).position || 1;
  return {
    productId: String(p.admin_graphql_api_id || `gid://shopify/Product/${p.id}`),
    title: trim(p.title), handle: p.handle || null, vendor: trim(p.vendor) || null, productType: trim(p.product_type) || null,
    tags: String(p.tags || '').split(',').map((t) => t.trim()).filter(Boolean),
    status: String(p.status || '').toUpperCase() || null, updatedAt: p.updated_at || null,
    image: p.image?.src || (p.images || [])[0]?.src || null, imageCount: Array.isArray(p.images) ? p.images.length : null,
    variants: (p.variants || []).map((v) => ({
      variantId: String(v.admin_graphql_api_id || `gid://shopify/ProductVariant/${v.id}`),
      sku: trim(v.sku), size: trim(v[`option${sizePos}`] ?? v.title), price: v.price ?? null, compareAt: v.compare_at_price ?? null,
      qty: v.inventory_quantity == null ? null : Number(v.inventory_quantity), barcode: trim(v.barcode) || null,
      weightG: v.grams == null ? null : Number(v.grams),
    })),
  };
}

// What the listing is made of, WITHOUT stock (a stock change must never flip a size to Out of
// date — the live sync owns stock) and without photos/weight (a REST payload and the GraphQL read
// describe those differently; photos only matter for products we publish, a later phase).
export function variantFields(v) {
  return { sku: trim(v?.sku), size: trim(v?.size), price: money(v?.price), compareAt: money(v?.compareAt), barcode: trim(v?.barcode) || null };
}
export function listingFields(p) {
  return {
    title: trim(p?.title), vendor: trim(p?.vendor) || null, productType: trim(p?.productType) || null,
    tags: [...(p?.tags || [])].map(trim).filter(Boolean).sort(), status: String(p?.status || '').toUpperCase() || null,
    variants: [...(p?.variants || [])].map((v) => ({ id: numId(v.variantId), ...variantFields(v) })).sort((a, b) => a.id.localeCompare(b.id)),
  };
}
// A stable JSON string (sorted keys) → cyrb53, hex. Not cryptographic; only "did it change".
export function stableJson(v) {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}
export function hashString(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed; let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) { const ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}
export const listingHash = (p) => hashString(stableJson(listingFields(p)));
export const variantHash = (v) => hashString(stableJson(variantFields(v)));

/* --------------------------------- matching --------------------------------- */

// sheinRows: one per SHEIN SKU { spu, skc, sheinSku, sellerSku, size, ... } (from spu-info).
// links: shein_links rows. → {
//   byVariant: Map(variantId → { row, match: 'sku'|'link' }),
//   sheinOnly: [{ row, why }]  — SHEIN sizes no Shopify variant has (or a second SHEIN size on one SKU),
//   skuCount: Map(sku → number of Shopify variants carrying it), spuOwner, spuProducts }
// A SHEIN size is matched to a Shopify variant ONLY by its own seller SKU (supplierSku) — or, when a
// person / the rules relinked it (shein_links) and SHEIN doesn't show the new SKU yet, by that
// link_sku. The SPU's / SKC's supplierCode is never read: 4seller filled it with a borrowed size SKU.
export function matchStore({ products = [], sheinRows = [], links = [] }) {
  const linkBy = new Map((links || []).map((l) => [String(l.shein_sku), l]));
  const skuIndex = new Map();
  for (const p of products) for (const v of p.variants || []) {
    const k = trim(v.sku); if (!k) continue;
    const a = skuIndex.get(k) || []; a.push({ v, p }); skuIndex.set(k, a);
  }
  const skuCount = new Map([...skuIndex].map(([k, a]) => [k, a.length]));
  const byVariant = new Map(); const sheinOnly = []; const pending = [];
  const pick = (hits, row) => (hits.find((h) => ['ok', 'ok_suffix', 'check_group'].includes(compareSize(row.size, h.v.size))) || hits[0]);
  for (const row of sheinRows) {
    const l = linkBy.get(String(row.sheinSku));
    if (l?.decision === 'delist') { sheinOnly.push({ row, why: 'parked' }); continue; }
    if (l?.decision === 'link' && l.link_sku && trim(l.link_sku) !== row.sellerSku) { pending.push({ row, to: trim(l.link_sku) }); continue; }
    const hits = row.sellerSku ? skuIndex.get(row.sellerSku) : null;
    if (!hits?.length) { sheinOnly.push({ row, why: row.sellerSku ? 'not_on_shopify' : 'no_seller_sku' }); continue; }
    const h = pick(hits, row);
    if (byVariant.has(h.v.variantId)) { sheinOnly.push({ row, why: 'duplicate', dupOf: h.v.variantId }); continue; }
    byVariant.set(h.v.variantId, { row, match: 'sku', productId: h.p.productId });
  }
  for (const { row, to } of pending) {
    const hits = skuIndex.get(to);
    if (!hits?.length) { sheinOnly.push({ row, why: 'link_gone' }); continue; }
    const h = pick(hits, row);
    if (byVariant.has(h.v.variantId)) { sheinOnly.push({ row, why: 'duplicate', dupOf: h.v.variantId }); continue; }
    byVariant.set(h.v.variantId, { row, match: 'link', productId: h.p.productId });
  }
  const perSpu = new Map();
  for (const m of byVariant.values()) {
    const c = perSpu.get(m.row.spu) || new Map(); c.set(m.productId, (c.get(m.productId) || 0) + 1); perSpu.set(m.row.spu, c);
  }
  const spuOwner = new Map(); const spuProducts = new Map();
  for (const [spu, c] of perSpu) {
    spuProducts.set(spu, new Set(c.keys()));
    spuOwner.set(spu, [...c].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0][0]);
  }
  return { byVariant, sheinOnly, skuCount, spuOwner, spuProducts };
}

/* -------------------------------- readiness -------------------------------- */

// One size. v = {
//   shopify: { variantId, sku, size, price, compareAt, qty } | null (null = a SHEIN-only size),
//   shein: the matched SHEIN row | null, match: 'sku'|'link'|'published'|null,
//   product: { excluded, shopifyStatus, onShein (the product has an SPU), skcCount, reviewState, sizeTableRetired },
//   excluded, excludedBy, skuCount, spans: { spu, count } | null, size: resolveSize() (not-on-SHEIN sizes),
//   lastError: { code, params, hash } | null, targetHash, syncedHash, syncedFields, locks: { price, shelf },
//   inflight: { jobId, itemId, sentAt } | null — a Phase 2 run item carrying this size is sending / in SHEIN's review,
//   targetPrice: { price, from } | null — D4's SHEIN price for this size (Phase 3) }
// → { status, blockers, notes, diffs }   (plan Appendix B.3, in this order)
export function variantReadiness(v) {
  const blockers = []; const notes = []; const diffs = [];
  const done = (status) => ({ status, blockers, notes, diffs });
  const s = v.shopify;
  const prod = v.product || {};
  // 1 · off
  if (prod.excluded || v.excluded || (s && prod.shopifyStatus && prod.shopifyStatus !== 'ACTIVE')) {
    if (s && prod.shopifyStatus && prod.shopifyStatus !== 'ACTIVE') notes.push(blocker('shopify_inactive', { status: prod.shopifyStatus }));
    else if (v.excluded) notes.push(blocker('excluded_by_person', { by: v.excludedBy || null, at: v.excludedAt || null }));
    return done('excluded');
  }
  // 2 · a SHEIN size Shopify doesn't have
  if (!s) {
    if (v.dupOf) notes.push(blocker('dup_on_shein', { sheinSize: v.shein?.size || null }));
    return done('shein_only');
  }
  // 3 · always-blockers
  const sku = trim(s.sku);
  if (!sku) blockers.push(blocker('no_seller_sku', { size: s.size }, 'sku'));
  else if ((v.skuCount || 1) > 1) blockers.push(blocker('dup_seller_sku', { sku, count: v.skuCount }, 'sku'));
  if (v.shein && ['wrong_size', 'wrong_group'].includes(compareSize(v.shein.size, s.size))) {
    blockers.push(blocker('wrong_link', { sheinSize: v.shein.size, size: s.size, sku: v.shein.sellerSku, spu: v.shein.spu }, 'size'));
  }
  if (v.spans) blockers.push(blocker('spu_spans_products', v.spans, 'spu'));
  if (blockers.length) return done('blocked');
  // 3½ · Phase 2: we sent this size (or its relink) and SHEIN hasn't answered the review yet
  if (v.inflight) { notes.push(blocker('review_open', { sentAt: v.inflight.sentAt || null, jobId: v.inflight.jobId || null })); return done('in_review'); }
  // 4 · our last attempt was refused, and nothing changed since
  if (v.lastError && (!v.lastError.hash || v.lastError.hash === v.targetHash)) {
    blockers.push(blocker(v.lastError.code || 'api_error', v.lastError.params || {}, v.lastError.field || null));
    return done('error');
  }
  const inStock = Number(s.qty) > 0;
  // 5 · on SHEIN
  if (v.shein) {
    if (v.locks?.price) notes.push(blocker('price_locked'));
    if (v.locks?.shelf) notes.push(blocker('shelf_locked'));
    if ([1, 5].includes(Number(prod.reviewState))) { notes.push(blocker('review_open', {})); return done('in_review'); }
    if (v.match === 'link') diffs.push({ field: 'seller_sku', from: v.shein.sellerSku || null, to: sku, why: 'SHEIN has the wrong SKU' });
    if (Number(v.shein.mallState) === 2 && inStock) diffs.push({ field: 'mall_state', from: 'stopped', to: 'on sale', why: 'stopped on SHEIN while Shopify sells it' });
    // D4 (Phase 3): the price a shopper PAYS (the special when one is live, else the original) vs the
    // target — market + 15 % rounded up, else the Shopify price — more than $0.50 apart → Needs update.
    // Under a live special we never touch the price by ourselves (sending without specialPrice ENDS the
    // special): a note says so, the size isn't flagged (review P2).
    const base = v.shein.basePrice != null ? Number(v.shein.basePrice) : null;
    const special = Number(v.shein.specialPrice) > 0 ? Number(v.shein.specialPrice) : null;
    const pays = special ?? base;
    if (v.targetPrice && pays != null && Math.abs(Number(v.targetPrice.price) - pays) > 0.5) {
      // R2: Needs update (not Synced) with its own diff field — the auto re-sync only picks `shein_price`
      if (special != null) {
        notes.push(blocker('special_live', { special, base, to: Number(v.targetPrice.price) }));
        diffs.push({ field: 'shein_special', from: money(pays), to: money(v.targetPrice.price), special: money(special), base: money(base), source: v.targetPrice.from,
          why: `SHEIN special ${money(special)} is live — only a dry run that ends the special changes it` });
      }
      else diffs.push({ field: 'shein_price', from: money(pays), to: money(v.targetPrice.price), source: v.targetPrice.from, why: v.targetPrice.from === 'market' ? 'market + 15 %, rounded up' : 'the Shopify price (no recent market price)' });
    }
    if (v.syncedHash && v.targetHash && v.syncedHash !== v.targetHash) {
      const was = v.syncedFields || {}; const now = variantFields(s);
      for (const f of ['price', 'compareAt', 'size', 'sku', 'barcode']) if ((was[f] ?? null) !== (now[f] ?? null)) diffs.push({ field: f, from: was[f] ?? null, to: now[f] ?? null, why: 'changed on Shopify' });
      if (!diffs.length) diffs.push({ field: 'listing', from: null, to: null, why: 'changed on Shopify' });
    }
    return done(diffs.length ? 'out_of_date' : 'synced');
  }
  // 6 · not on SHEIN (a size to add to a SHEIN product, or a product to publish)
  if (prod.onShein && [1, 5].includes(Number(prod.reviewState))) notes.push(blocker('review_open', {}));
  if (prod.onShein && prod.sizeFieldRetired) { blockers.push(blocker('size_field_retired', {})); return done('error'); }
  if (prod.onShein && prod.sizeTable) blockers.push(blocker('size_table_not_yet'));
  // Phase 4: a product not on SHEIN — what publishing it needs (category, brand, title, box, photos, …)
  for (const b of v.publishBlockers || []) (isNote(b) ? notes : blockers).push(b);
  if (v.size?.blocker) blockers.push(v.size.blocker);
  if (v.size?.note) notes.push(v.size.note);
  if (!(Number(s.price) > 0)) blockers.push(blocker('no_price', { size: s.size }, 'price'));
  if (prod.onShein && Number(prod.skcCount) > 1) blockers.push(blocker('multi_skc_size', { size: s.size, skcCount: prod.skcCount }));
  return done(blockers.some((b) => !isNote(b)) ? 'blocked' : 'not_on_shein');
}

// The product's status = the worst of its IN-STOCK sizes (D10: a zero-stock size is listed,
// greyed, and doesn't count). SHEIN-only sizes count (they're SHEIN's stock, not Shopify's).
// A product with nothing in stock rolls up over all its sizes. All sizes off → off.
export function rollup(variants) {
  const live = (variants || []).filter((v) => v.status !== 'excluded');
  if (!live.length) return (variants || []).length ? 'excluded' : 'unknown';
  const counted = live.filter((v) => v.status === 'shein_only' || Number(v.qty) > 0);
  const pool = counted.length ? counted : live;
  return pool.reduce((w, v) => (rank(v.status) < rank(w) ? v.status : w), 'excluded');
}

// variants: [{ status, qty, match, blockers, shopifyVariantId }] → { status, counts, blockers }.
// counts: sizes (Shopify sizes in stock), on_shein (of those, on SHEIN), all (every Shopify size),
// shein_only, by: { status: n } over every row. Product blockers = product-level ones + each
// distinct variant blocker code once (worst first), for the one-liner.
export function productReadiness(product, variants) {
  const by = {};
  for (const v of variants) by[v.status] = (by[v.status] || 0) + 1;
  const shopifyRows = variants.filter((v) => v.shopifyVariantId);
  const inStock = shopifyRows.filter((v) => v.status !== 'excluded' && Number(v.qty) > 0);
  const counts = {
    all: shopifyRows.length, sizes: inStock.length,
    on_shein: inStock.filter((v) => ['sku', 'link', 'published'].includes(v.match)).length,
    shein_only: variants.filter((v) => v.status === 'shein_only').length, by,
  };
  const status = product?.excluded || (product?.shopifyStatus && product.shopifyStatus !== 'ACTIVE' && shopifyRows.length) ? 'excluded' : rollup(variants);
  // The tiles / ?status= filter: a product counts under EVERY status one of its counted sizes has (the
  // same pool the roll-up reads: in-stock + SHEIN-only sizes, else all) — not only its worst one.
  const liveV = variants.filter((v) => v.status !== 'excluded');
  const counted = liveV.filter((v) => v.status === 'shein_only' || Number(v.qty) > 0);
  const sizeStatuses = status === 'excluded' ? [] : [...new Set((counted.length ? counted : liveV).map((v) => v.status))];
  const blockers = [];
  if (product?.shopifyStatus && product.shopifyStatus !== 'ACTIVE') blockers.push(blocker('shopify_inactive', { status: product.shopifyStatus }));
  const seen = new Set();
  const ordered = [...variants].sort((a, b) => rank(a.status) - rank(b.status));
  for (const v of ordered) for (const b of v.blockers || []) {
    if (seen.has(b.code)) continue;
    seen.add(b.code); blockers.push({ ...b, sizes: variants.filter((x) => (x.blockers || []).some((y) => y.code === b.code)).length });
  }
  return { status, counts, blockers, sizeStatuses };
}

/* ------------------------------ the read-only list ------------------------------ */

// SHEIN API paths this project may call without changing anything on SHEIN. Everything else is
// a WRITE (the e2e fake SHEIN throws on it; Phase 1 sends none; shein_api_log marks it).
export const SHEIN_READ_PATHS = new Set([
  '/open-api/openapi-business-backend/product/query', '/open-api/goods/searchProduct', '/open-api/goods/spu-info',
  '/open-api/goods/query-document-state', '/open-api/goods/get-custom-attribute-permission-config',
  '/open-api/goods/query-attribute-template', '/open-api/goods/query-publish-fill-in-standard', '/open-api/goods/query-category-tree',
  '/open-api/goods/get-associated-attribute-rules', '/open-api/goods/query-brand-list', '/open-api/goods/query-shelf-quota',
  '/open-api/goods-publish-quotas/detail', '/open-api/goods/product/check-publish-permission', '/open-api/goods/product/check-supplierSku-repeated',
  '/open-api/goods/query-site-list', '/open-api/stock/stock-query', '/open-api/msc/warehouse/list', '/open-api/goods-specs/check-modify-permission',
  '/open-api/goods/check-deletable', '/open-api/goods-delete-logs/search', '/open-api/order/order-list', '/open-api/order/order-detail',
  // Phase 4 reads (spec §4.4)
  '/open-api/goods/image-category-suggestion', '/open-api/goods-compliance-requirements/list',
]);
// Image conversion makes a SHEIN-hosted URL and changes NO product: an "asset" call, not a write
// (the dry-run proof stays "0 SHEIN writes · n photos converted").
export const SHEIN_ASSET_PATHS = new Set(['/open-api/goods/transform-pic', '/open-api/goods/upload-pic']);
const pathOf = (path) => String(path || '').split('?')[0];
export const isSheinAsset = (path) => SHEIN_ASSET_PATHS.has(pathOf(path));
export const isSheinWrite = (path) => !SHEIN_READ_PATHS.has(pathOf(path)) && !SHEIN_ASSET_PATHS.has(pathOf(path));

// The SHEIN side of one SPU, from spu-info (+ searchProduct's locks, + query-document-state):
// the compact payload the snapshot stores (shein_listing_cache kind 'spu') and recomputes from.
const en = (list, key) => {
  const a = Array.isArray(list) ? list : [];
  const hit = a.find((x) => /^en/i.test(x?.language || '')) || a[0];
  return hit ? trim(hit[key]) : '';
};
export function spuPayload(spu, { search = null, docState = null, stock = new Map() } = {}) {
  if (!spu?.spuName) return null;
  const locks = new Map();
  for (const skc of search?.skcList || []) {
    const us = (skc.activityLockList || []).find((x) => /shein-us/i.test(x.site || '')) || (skc.activityLockList || [])[0] || {};
    locks.set(String(skc.skcName), { price: Number(us.priceLockType) === 1, shelf: Number(us.shelfLockType) === 1 });
  }
  const rows = []; let sizeAttrId = null;
  for (const skc of spu.skcInfoList || []) {
    const lock = locks.get(String(skc.skcName)) || { price: false, shelf: false };
    const shelf = (skc.shelfStatusInfoList || []).filter((x) => Number(x.shelfStatus) === 1).map((x) => String(x.siteAbbr));
    for (const sku of skc.skuInfoList || []) {
      const a = (sku.saleAttributeList || [])[0] || null;
      if (a?.attributeId != null && sizeAttrId == null) sizeAttrId = Number(a.attributeId);
      const price = (sku.priceInfoList || []).find((p) => /shein-us/i.test(p.site || p.subSite || '')) || (sku.priceInfoList || [])[0] || null;
      rows.push({
        spu: spu.spuName, skc: String(skc.skcName), sheinSku: String(sku.skuCode || ''), sellerSku: trim(sku.supplierSku),
        size: a ? (en(a.attributeValueMultiList, 'attributeValueName') || trim(a.attributeValue ?? a.customAttributeValue)) : '',
        sizeValueId: a?.attributeValueId == null ? null : Number(a.attributeValueId),
        price: price ? (price.specialPrice != null && Number(price.specialPrice) > 0 ? Number(price.specialPrice) : price.basePrice ?? null) : null,
        basePrice: price?.basePrice ?? null, specialPrice: price?.specialPrice ?? null,
        mallState: sku.mallState == null ? null : Number(sku.mallState), shelf, locks: lock,
        qty: stock.has(String(sku.skuCode)) ? stock.get(String(sku.skuCode)) : null,
      });
    }
  }
  const skcStates = (docState?.skcList || []).map((x) => Number(x.documentState));
  const reviewState = skcStates.find((x) => x === 1 || x === 5) ?? (skcStates.includes(3) ? 3 : skcStates.length ? skcStates[0] : null);
  return {
    spu: spu.spuName, name: en(spu.productMultiNameList, 'productName'), categoryId: spu.categoryId == null ? null : Number(spu.categoryId),
    productTypeId: spu.productTypeId == null ? null : Number(spu.productTypeId), brandCode: spu.brandCode || null,
    sizeAttrId, hasSizeTable: Array.isArray(spu.dimensionAttributeInfoList) && spu.dimensionAttributeInfoList.length > 0,
    skcCount: (spu.skcInfoList || []).length, reviewState, reviewReason: (docState?.skcList || []).flatMap((x) => (x.failedReason || []).map((f) => f.content)).filter(Boolean).join(' | ') || null,
    rows,
  };
}

// query-attribute-template → per product type: the size attribute's values. `sizeAttrId` from
// spu-info when we have it; else the SKU-level sale attribute named like a size.
export function templateSizes(templateInfo, productTypeId, sizeAttrId = null) {
  const data = (Array.isArray(templateInfo) ? templateInfo : templateInfo?.data || []).find((d) => Number(d.product_type_id) === Number(productTypeId));
  if (!data) return null;
  const attrs = data.attribute_infos || [];
  // The SKU-level sale attribute (attribute_type 1, attribute_label ≠ 1) named like a size; spu-info's
  // first sale attribute only breaks a tie — it can be another attribute (e.g. a width) (review M2).
  const skuLevel = (x) => Number(x.attribute_type) === 1 && Number(x.attribute_label) !== 1;
  const named = attrs.filter((x) => skuLevel(x) && /size|尺码|尺寸|码/i.test(`${x.attribute_name_en || ''} ${x.attribute_name || ''}`));
  const a = named.find((x) => sizeAttrId && Number(x.attribute_id) === Number(sizeAttrId)) || named[0]
    || (sizeAttrId && attrs.find((x) => skuLevel(x) && Number(x.attribute_id) === Number(sizeAttrId)));
  if (!a) return null;
  return {
    attributeId: Number(a.attribute_id), name: a.attribute_name_en || a.attribute_name || null, status: a.attribute_status == null ? null : Number(a.attribute_status),
    type: a.attribute_type == null ? null : Number(a.attribute_type), label: a.attribute_label == null ? null : Number(a.attribute_label),
    values: (a.attribute_value_info_list || []).map((v) => ({ id: Number(v.attribute_value_id), label: trim(v.attribute_value_en || v.attribute_value), custom: v.is_custom_attribute_value === true })).filter((v) => v.label),
  };
}

/* ---------------------------- the whole store, at once ---------------------------- */

// Everything the snapshot (and a Shopify webhook's recompute, from STORED SHEIN rows) needs, in,
// and the rows for shein_listing_products / shein_listing_variants, out. Pure.
//   products     normalized Shopify products (shopifyListingCatalogue / normalizeWebhookProduct)
//   spus         spuPayload() per SHEIN product
//   links        shein_links rows · maps: shein_size_map rows
//   templates    Map(productTypeId → templateSizes()) · permissions: Map(`${categoryId}|${attributeId}` → 0|1)
//   customValues every custom size text the store already has (SHEIN's template, is_custom)
//   prev         { products: Map(id → stored row), variants: Map(row_key → stored row) } — person
//                exclusions, the "accepted" baseline (synced_hash / synced_fields) and last errors
//                carry over.
//   inflight     Map(variantId → { jobId, itemId, sentAt }) — Phase 2 run items sending / in review
//   market       Map(variantId → market cents) — D4's target price (Phase 3); none → the Shopify price
//   publish      (product, prevRow, excludedVariants) → { productBlockers, sizeFor } — Phase 4's readiness for a
//                product NOT on SHEIN (src/lib/sheinPublish.js publishReadiness, cache only); absent = Phase 1's note
export function computeListings({ products = [], spus = [], links = [], maps = [], templates = new Map(), permissions = new Map(), customValues = [], prev = {}, inflight = new Map(), market = new Map(), publish = null }) {
  const prevP = prev.products || new Map(); const prevV = prev.variants || new Map();
  const sheinRows = spus.flatMap((s) => s.rows || []);
  const bySpu = new Map(spus.map((s) => [s.spu, s]));
  const m = matchStore({ products, sheinRows, links });
  const outP = []; const outV = [];
  const productIdsBySpu = new Map();

  const sizeCtxFor = (payload) => {
    if (!payload) return { categoryId: 0 };
    const tpl = payload.productTypeId != null ? templates.get(Number(payload.productTypeId)) : null;
    const attributeId = tpl?.attributeId ?? payload.sizeAttrId ?? null;
    const perm = permissions.get(`${payload.categoryId}|${attributeId}`);
    return { categoryId: payload.categoryId, attributeId, values: tpl?.values || null, permission: perm == null ? null : Number(perm), sizeTable: payload.hasSizeTable, customValues, maps,
      retired: tpl?.status === 1 };
  };
  const sheinCols = (row) => ({
    spu: row?.spu || null, skc: row?.skc || null, shein_sku: row?.sheinSku || null, shein_seller_sku: row?.sellerSku || null, shein_size: row?.size || null,
    shein_size_value_id: row?.sizeValueId ?? null, shein_size_custom: null, shein_price: row?.price ?? null, shein_mall_state: row?.mallState ?? null,
    shein_shelf_status: row ? (row.shelf?.length ? 'on' : 'off') : null, shein_qty: row?.qty ?? null,
  });

  for (const p of products) {
    const pv = prevP.get(p.productId) || {};
    const matched = (p.variants || []).map((v) => m.byVariant.get(v.variantId)).filter(Boolean);
    const spuCounts = new Map();
    for (const x of matched) spuCounts.set(x.row.spu, (spuCounts.get(x.row.spu) || 0) + 1);
    const spu = [...spuCounts].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0]?.[0] || null;
    const payload = spu ? bySpu.get(spu) : null;
    if (spu) { const a = productIdsBySpu.get(spu) || []; a.push(p.productId); productIdsBySpu.set(spu, a); }
    const ctx = sizeCtxFor(payload);
    const prodCtx = { excluded: !!pv.excluded, shopifyStatus: p.status || null, onShein: !!payload, skcCount: payload?.skcCount || 0, reviewState: payload?.reviewState ?? null, sizeFieldRetired: !!ctx.retired,
      sizeTable: !!payload?.hasSizeTable };
    const vrows = [];
    const excludedVariants = new Set((p.variants || []).filter((v) => prevV.get(v.variantId)?.excluded).map((v) => v.variantId));
    const pub = !payload && publish && !pv.excluded && String(p.status || '').toUpperCase() === 'ACTIVE' ? publish(p, pv, excludedVariants) : null;
    for (const v of p.variants || []) {
      const hit = m.byVariant.get(v.variantId) || null;
      const row = hit?.row || null;
      const key = v.variantId;
      const before = prevV.get(key) || {};
      const targetHash = variantHash(v);
      const onShein = !!row;
      const syncedHash = onShein ? (before.synced_hash && before.shein_sku === row.sheinSku ? before.synced_hash : targetHash) : null;
      const syncedFields = onShein ? (before.synced_hash && before.shein_sku === row.sheinSku ? before.synced_fields : variantFields(v)) : null;
      const spanSet = row ? m.spuProducts.get(row.spu) : null;
      const size = onShein ? null : pub ? (pub.sizeFor.get(v.variantId) || { key: sizeKey(v.size), kind: null, note: blocker('size_unchecked', { size: String(v.size), reason: 'no_category' }) }) : resolveSize(v.size, ctx);
      const r = variantReadiness({
        shopify: v, shein: row, match: hit?.match || null, product: prodCtx, excluded: !!before.excluded, excludedBy: before.excluded_by || null, excludedAt: before.excluded_at || null,
        skuCount: m.skuCount.get(trim(v.sku)) || 0, spans: spanSet && spanSet.size > 1 ? { spu: row.spu, count: spanSet.size } : null,
        size, lastError: before.last_error || null, targetHash, syncedHash, syncedFields, locks: row?.locks || null,
        inflight: inflight.get(v.variantId) || null, publishBlockers: !onShein && pub ? pub.productBlockers : null,
        targetPrice: row ? sheinNewSizePrice({ marketCents: market.get(v.variantId) ?? null, shopifyPrice: v.price }) : null,
      });
      // A size we added (Phase 2) stays 'published' once SHEIN shows it under its own seller SKU —
      // sheinLastWalkFacts() reads those rows so the live stock push reaches it before the next walk.
      const match = hit?.match === 'sku' && before.match === 'published' && before.shein_sku === row?.sheinSku ? 'published' : hit?.match || 'none';
      vrows.push({
        row_key: key, shopify_variant_id: v.variantId, shopify_product_id: p.productId, seller_sku: trim(v.sku) || null, shopify_size: trim(v.size) || null,
        size_key: sizeKey(v.size), shopify_price: money(v.price), shopify_compare_at: money(v.compareAt), shopify_qty: v.qty == null ? null : Number(v.qty),
        shopify_barcode: trim(v.barcode) || null, shopify_weight_g: v.weightG ?? null,
        ...sheinCols(row), match, status: r.status, blockers: r.blockers, diffs: r.diffs, notes: r.notes,
        size_plan: size && size.kind ? { kind: size.kind, valueId: size.valueId, label: size.label, source: size.source } : null,
        target_hash: targetHash, synced_hash: syncedHash, synced_fields: syncedFields, review_state: row ? (payload?.reviewState ?? null) : null,
        excluded: !!before.excluded, excluded_by: before.excluded_by || null, excluded_at: before.excluded_at || null, last_error: before.last_error || null,
        sort: sizeSort(v.size),
      });
    }
    // SHEIN sizes of this product's SPU that no Shopify variant has.
    outP.push({ p, pv, spu, spuCount: spuCounts.size, payload, vrows });
  }

  // SHEIN-only sizes → the product that owns their SPU, else a SHEIN-only product row (key shein:<spu>).
  const byProduct = new Map(outP.map((x) => [x.p.productId, x]));
  const orphans = new Map();
  for (const o of m.sheinOnly) {
    const owner = m.spuOwner.get(o.row.spu);
    const r = variantReadiness({ shopify: null, shein: o.row, dupOf: o.dupOf || null });
    const vrow = {
      row_key: `shein:${o.row.sheinSku}`, shopify_variant_id: null, shopify_product_id: owner || `shein:${o.row.spu}`, seller_sku: null, shopify_size: null,
      size_key: sizeKey(o.row.size), shopify_price: null, shopify_compare_at: null, shopify_qty: null, shopify_barcode: null, shopify_weight_g: null,
      ...sheinCols(o.row), match: 'none', status: r.status, blockers: r.blockers, diffs: [], notes: [...r.notes, ...(o.why === 'parked' ? [blocker('excluded_by_person', { by: 'a person on Match sizes' })] : [])],
      size_plan: null, target_hash: null, synced_hash: null, synced_fields: null, review_state: bySpu.get(o.row.spu)?.reviewState ?? null,
      excluded: false, excluded_by: null, excluded_at: null, last_error: null, sort: sizeSort(o.row.size),
    };
    if (owner && byProduct.has(owner)) byProduct.get(owner).vrows.push(vrow);
    else { const a = orphans.get(o.row.spu) || []; a.push(vrow); orphans.set(o.row.spu, a); }
  }

  for (const x of outP) {
    const { p, pv, spu, payload, vrows } = x;
    vrows.sort((a, b) => a.sort - b.sort || String(a.row_key).localeCompare(String(b.row_key)));
    const pr = productReadiness({ excluded: !!pv.excluded, shopifyStatus: p.status }, vrows.map((v) => ({ status: v.status, qty: v.shopify_qty, match: v.match, blockers: v.blockers, shopifyVariantId: v.shopify_variant_id })));
    const search = [p.title, p.style, p.handle, p.vendor, p.productId, spu, ...vrows.flatMap((v) => [v.seller_sku, v.shein_sku, v.shein_seller_sku, v.skc, v.spu])].filter(Boolean).join(' ').toLowerCase();
    outP.splice(outP.indexOf(x), 1, {
      shopify_product_id: p.productId, title: p.title || null, handle: p.handle || null, vendor: p.vendor || null, product_type: p.productType || null,
      tags: p.tags || [], style: p.style || null, shopify_status: p.status || null, image_url: p.image || null, image_count: p.imageCount ?? null,
      // Phase 4: a product WE published keeps its new SPU while SHEIN reviews it (spu-info shows nothing until approved)
      shopify_hash: listingHash(p), shopify_updated_at: p.updatedAt || null, spu: spu || (pv.review_version && pv.spu ? pv.spu : null), spu_count: x.spuCount,
      spu_source: spu ? 'match' : pv.review_version && pv.spu ? 'published' : null,
      category_id: payload?.categoryId ?? null, product_type_id: payload?.productTypeId ?? null, category_source: payload ? 'spu' : null, brand_code: payload?.brandCode || null,
      excluded: !!pv.excluded, excluded_by: pv.excluded_by || null, excluded_at: pv.excluded_at || null,
      status: pr.status, counts: pr.counts, blockers: pr.blockers, review_state: payload?.reviewState ?? null, review_reason: payload?.reviewReason || null,
      shopify_json: p, search_text: search, variants: vrows, size_statuses: pr.sizeStatuses,
    });
  }
  for (const [spu, vrows] of orphans) {
    const payload = bySpu.get(spu);
    vrows.sort((a, b) => a.sort - b.sort);
    const pr = productReadiness({}, vrows.map((v) => ({ status: v.status, qty: null, match: v.match, blockers: v.blockers, shopifyVariantId: null })));
    outP.push({
      shopify_product_id: `shein:${spu}`, title: payload?.name || spu, handle: null, vendor: null, product_type: null, tags: [], style: null, shopify_status: null,
      image_url: null, image_count: null, shopify_hash: null, shopify_updated_at: null, spu, spu_count: 1, spu_source: 'shein_only',
      category_id: payload?.categoryId ?? null, product_type_id: payload?.productTypeId ?? null, category_source: payload ? 'spu' : null, brand_code: payload?.brandCode || null,
      excluded: false, excluded_by: null, excluded_at: null, status: pr.status, counts: pr.counts, blockers: pr.blockers, size_statuses: pr.sizeStatuses,
      review_state: payload?.reviewState ?? null, review_reason: payload?.reviewReason || null, shopify_json: null,
      search_text: [payload?.name, spu, ...vrows.flatMap((v) => [v.shein_sku, v.shein_seller_sku, v.skc])].filter(Boolean).join(' ').toLowerCase(), variants: vrows,
    });
  }
  for (const p of outP) p.computed_hash = hashString(stableJson({ ...p, shopify_json: null, computed_hash: null }));
  return outP;
}

/* ------------------------ Phase 2: add sizes to a SHEIN shoe ------------------------ */
// docs/shein-listings-plan.md §3 Phase 2, Appendix A.1/A.2; docs/shein-listing-api-reference.md
// (partialEdit, doc 3002047). ONE partialEdit per SHEIN product carries every size we add AND the
// seller-SKU relinks pending for it (one SHEIN review per product). The dry run and the run build
// the body with this same function from fresh reads, so "what the dry run showed" and "what is
// sent" can be compared by hash.

export const PARTIAL_EDIT_PATH = '/open-api/goods/product/partialEdit';
export const MARKUP_H = 1500;   // D4: market + 15 %, the SHEIN Reprice rule (src/lib/sheinReprice.js)
const PERSON_SOURCES = new Set(['person', 'custom_created']);
const cents = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 100));
const dollars = (c) => (c == null ? null : Math.round(c) / 100);

// D4 — ONE target price for a size, new (Phase 2) or re-synced (Phase 3): market + 15 % rounded UP to
// a whole dollar (sheinRepriceDollars' integer arithmetic) when we have a market price, else the
// Shopify price (`marketOnly`: no fallback — D8a's automatic re-sync). No sibling rule (decided
// 2026-10-27: it made a new size read Needs update the moment SHEIN approved it). → { price, from } | null.
export function sheinNewSizePrice({ marketCents = null, shopifyPrice = null, pctH = MARKUP_H, marketOnly = false } = {}) {
  let c = null; let from = null;
  if (Number(marketCents) > 0) {
    const p = BigInt(Math.round(Number(marketCents))) * BigInt(10000 + pctH);
    c = Number((p + 999999n) / 1000000n) * 100; from = 'market';
  } else if (!marketOnly && cents(shopifyPrice) > 0) { c = cents(shopifyPrice); from = 'shopify'; }
  return c > 0 ? { price: dollars(c), from } : null;
}

// Foot length (cm, shein_size_map.foot_length) in the unit the product's size chart already
// uses: siblings written in mm (≥ 100) → whole mm; else cm as typed (SHEIN's docs disagree on
// integers vs 2 decimals — the pilot settles it; Build log).
export function footLengthValue(cm, siblingValues = []) {
  const n = Number(cm);
  if (!(n > 0)) return null;
  const mm = siblingValues.map(Number).filter((x) => x > 0).some((x) => x >= 100);
  return mm ? String(Math.round(n * 10)) : String(Math.round(n * 100) / 100);
}

const rawSkus = (spu) => (spu?.skcInfoList || []).flatMap((c) => (c.skuInfoList || []).map((s) => ({ skc: String(c.skcName), raw: s })));
const hasDims = (s) => ['length', 'width', 'height'].every((k) => Number(s?.[k]) > 0) && Number(s?.weight) > 0;
const usdSites = (s) => {
  const list = (s?.priceInfoList || []).filter((p) => /usd/i.test(p.currency || 'USD')).map((p) => ({ site: p.site || p.subSite || 'shein-us', currency: 'USD', base: p.basePrice ?? null }));
  return list.length ? list : [{ site: 'shein-us', currency: 'USD', base: null }];
};
const imageOf = (s) => {
  const i = Array.isArray(s?.skuImageInfoList) ? s.skuImageInfoList[0] : s?.skuImageInfoList;
  return i?.imageUrl || null;
};

// The plan for ONE product. In:
//   spu        fresh spu-info answer (raw)
//   product    { productId, title, style, variants } — Shopify, read LIVE (normalized)
//   stored     shein_listing_variants rows of the product (status, match, blockers, excluded, shein_*)
//   maps       shein_size_map rows · sizes: { attributeId, values, status } (SHEIN's template for the
//              product type) · permission 1|0|null · customValues (store-wide custom texts)
//   sortSupported  query-publish-fill-in-standard.support_sale_attribute_sort === true
//   taken      Set of seller SKUs check-supplierSku-repeated says exist anywhere in the store
//   fill       query-publish-fill-in-standard answer (skc_title / reference_product_link rules)
//   market     Map(variantId → market cents) · warehouse { code, name, count } (merchant warehouses;
//              `code` = the US default type-1 warehouseCode → stock_info_list.supplier_warehouse_id)
// Out: { body | null, plan } — body is EXACTLY what partialEdit gets; plan is what a person reads.
export function planAddSizes({ spu, product, stored = [], maps = [], sizes = null, permission = null, customValues = [], sortSupported = false, fill = null, fillUnread = false, taken = new Set(), market = new Map(), warehouse = null }) {
  const plan = { spu: spu?.spuName || null, skc: null, sizes: [], relinks: [], skipped: [], blockers: [], notes: [], sortSent: false, sizeTable: false, sibling: null };
  if (!spu?.spuName) { plan.blockers.push(blocker('not_on_shein_product')); return { body: null, plan }; }
  const payload = spuPayload(spu);
  const skcs = spu.skcInfoList || [];
  if (skcs.length !== 1) { plan.blockers.push(blocker('multi_skc_size', { skcCount: skcs.length })); }
  if (sizes?.status === 1) plan.blockers.push(blocker('size_field_retired', {}));
  // The size attribute = the TEMPLATE's SKU-level size attribute, and every SKU must carry exactly
  // that one sale attribute — else a new SKU would have a different shape than its siblings (M2).
  const sizeAttr = sizes?.attributeId ?? null;
  if (sizeAttr == null) plan.blockers.push(blocker('size_unchecked', { reason: 'no_size_attribute' }));
  else if (sizes.type != null && !(sizes.type === 1 && sizes.label !== 1)) plan.blockers.push(blocker('size_field_unclear', { why: 'not_sku_level' }));
  else {
    const attrs = (skcs[0]?.skuInfoList || []).map((k) => (k.saleAttributeList || []).map((a) => Number(a.attributeId)));
    if (attrs.some((a) => a.length !== 1)) plan.blockers.push(blocker('size_field_unclear', { why: 'two_attrs' }));
    else if (attrs.some((a) => a[0] !== Number(sizeAttr))) plan.blockers.push(blocker('size_field_unclear', { why: 'mismatch', spu: payload.sizeAttrId, template: sizeAttr }));
  }
  // A size chart must be re-sent whole with every new size; not supported yet (M4) — never a ""/null row.
  if (payload.hasSizeTable) plan.blockers.push(blocker('size_table_not_yet'));
  // Fields SHEIN's edit CLEARS when left out (doc 3002047: skc_title / competing_product_link "编辑时不传字段代表清空数据").
  if (fillUnread) plan.blockers.push(blocker('skc_field_uncopyable', { why: 'fill_unread' }));   // re-review N1
  const rule = (k) => (fill?.fill_in_standard_list || []).find((x) => x.field_key === k) || null;
  const skcNames = ((skcs[0]?.productMultiNameList) || []).filter((x) => trim(x?.productName)).map((x) => ({ language: x.language || 'en', name: trim(x.productName) }));
  const titleRule = rule('skc_title');
  if (titleRule?.show === true && titleRule.required === true && !skcNames.length) plan.blockers.push(blocker('skc_field_uncopyable', { field: 'skc_title' }));
  const linkRule = rule('reference_product_link');
  if (linkRule?.show === true && linkRule.required === true) plan.blockers.push(blocker('skc_field_uncopyable', { field: 'competing_product_link' }));
  if (plan.blockers.length) return { body: null, plan };
  plan.skc = String(skcs[0].skcName);
  plan.categoryId = payload.categoryId; plan.sizeAttributeId = Number(sizeAttr);
  plan.sizeTable = payload.hasSizeTable;
  const rows = payload.rows.filter((r) => r.skc === plan.skc);
  const raw = new Map(rawSkus(spu).map((x) => [String(x.raw.skuCode), x.raw]));
  const onShein = new Set(rows.map((r) => r.sellerSku).filter(Boolean));
  const live = new Map((product?.variants || []).map((v) => [v.variantId, v]));
  const ctx = { categoryId: payload.categoryId, attributeId: sizeAttr, values: sizes?.values || null, permission, sizeTable: false, customValues, maps };
  const templateCustom = new Set([...(customValues || []), ...(sizes?.values || []).filter((v) => v.custom).map((v) => v.label)].map((t) => String(t).toLowerCase()));
  const skip = (r, v, b) => plan.skipped.push({ variantId: r.shopify_variant_id || r.row_key, size: v?.size ?? r.shopify_size ?? null, sku: v?.sku ?? r.seller_sku ?? null, blocker: b });

  // Relinks pending for this product (shein_links → stored match 'link'): ride in the same call.
  const relinkAway = new Set();
  for (const r of stored.filter((x) => x.match === 'link' && x.shopify_variant_id && !x.excluded)) {
    const v = live.get(r.shopify_variant_id); const to = trim(v?.sku || r.seller_sku);
    const row = rows.find((x) => x.sheinSku === r.shein_sku);
    if (!row || !to || row.sellerSku === to) continue;   // gone from SHEIN, or SHEIN already shows it
    plan.relinks.push({ variantId: r.shopify_variant_id, skuCode: row.sheinSku, size: row.size, from: row.sellerSku || null, to });
    if (row.sellerSku) relinkAway.add(row.sellerSku);
  }
  // SHEIN asks for a reference link on SKUs here, which spu-info doesn't return: editing a SKU would clear it (M5).
  if (plan.relinks.length && linkRule?.show === true) { plan.blockers.push(blocker('skc_field_uncopyable', { field: 'competing_product_link' })); return { body: null, plan }; }
  plan.relinks = plan.relinks.filter((l) => {
    if (taken.has(l.to) && !relinkAway.has(l.to)) { skip({ shopify_variant_id: l.variantId }, { size: l.size, sku: l.to }, blocker('seller_sku_taken', { sku: l.to }, 'sku')); return false; }
    return true;
  });

  // Sizes to add: Shopify sizes not on SHEIN, picked by the readiness (Not on SHEIN), re-checked fresh.
  // Every size already on the product, by value id AND by text (a custom value has both) — S3.
  const used = new Map();
  for (const r of rows) { if (r.sizeValueId != null) used.set(`id:${r.sizeValueId}`, r); if (r.size) used.set(`t:${squash(r.size)}`, r); }
  for (const r of stored) {
    if (!r.shopify_variant_id || r.excluded || r.status === 'excluded' || r.match !== 'none') continue;
    const v = live.get(r.shopify_variant_id);
    if (!v) { skip(r, null, blocker('no_seller_sku', { size: r.shopify_size })); continue; }
    const sku = trim(v.sku);
    if (onShein.has(sku)) continue;   // SHEIN has it now (the snapshot is older than this read)
    const retry = r.status === 'error' && (r.blockers || []).every((b) => ['review_rejected', 'shein_prevalid', 'api_error'].includes(b.code));
    if (r.status !== 'not_on_shein' && !retry) {
      const b = (r.blockers || []).find((x) => !isNote(x)) || blocker('size_unchecked', { size: v.size });
      skip(r, v, b); continue;
    }
    const res = resolveSize(v.size, ctx);
    if (res.blocker) { skip(r, v, res.blocker); continue; }
    if (!res.kind) { skip(r, v, res.note || blocker('size_unchecked', { size: v.size })); continue; }
    // A custom value is permanent and store-wide: only a spelling a PERSON confirmed is ever sent.
    if (res.kind === 'custom') {
      if (permission !== 1) { skip(r, v, blocker('size_not_on_shein', { size: v.size, categoryId: payload.categoryId }, 'size')); continue; }   // M1
      const bad = validateCustomText(res.label) || customTextConflict(res.label, { values: sizes?.values || [], customValues });
      if (bad) { skip(r, v, blocker('custom_text_invalid', { size: v.size, text: res.label, why: bad }, 'size')); continue; }
      if (!res.map?.set_by || !PERSON_SOURCES.has(res.map.source)) { skip(r, v, blocker('custom_unconfirmed', { size: v.size, text: res.label }, 'size')); continue; }
    }
    if (!sku) { skip(r, v, blocker('no_seller_sku', { size: v.size }, 'sku')); continue; }
    if (taken.has(sku)) { skip(r, v, blocker('seller_sku_taken', { sku }, 'sku')); continue; }
    const key = res.kind === 'value' ? `id:${res.valueId}` : `t:${squash(res.label)}`;
    const dupe = used.get(key) || (res.label ? used.get(`t:${squash(res.label)}`) : null);
    if (dupe) { skip(r, v, blocker('size_already_on_shein', { size: v.size, sheinSize: dupe.size || res.label, sellerSku: dupe.sellerSku || null }, 'size')); continue; }
    // The nearest sibling (by size) that has box dims + weight: dims, weight, sites, image, pieces.
    const sort = sizeSort(v.size);
    const sib = rows.map((x) => ({ x, s: raw.get(x.sheinSku) })).filter((y) => hasDims(y.s))
      .sort((a, b) => Math.abs(sizeSort(a.x.size) - sort) - Math.abs(sizeSort(b.x.size) - sort) || sizeSort(a.x.size) - sizeSort(b.x.size))[0];
    if (!sib) { skip(r, v, blocker('no_weight', { size: v.size, why: 'no size of this SHEIN product has a box size + weight to copy' })); continue; }
    const sites = usdSites(sib.s);
    const price = sheinNewSizePrice({ marketCents: market.get(r.shopify_variant_id) ?? null, shopifyPrice: v.price });
    if (!price) { skip(r, v, blocker('no_price', { size: v.size }, 'price')); continue; }
    used.set(key, { size: res.label, sellerSku: sku }); if (res.label) used.set(`t:${squash(res.label)}`, { size: res.label, sellerSku: sku });
    plan.sizes.push({
      variantId: r.shopify_variant_id, size: v.size, sizeKey: res.key, sku, sheinSize: res.label, kind: res.kind, valueId: res.valueId ?? null, source: res.source, mapId: res.map?.id ?? null,
      isNew: res.kind === 'custom' && !templateCustom.has(String(res.label).toLowerCase()),
      customExisting: res.kind === 'value' && !!(sizes?.values || []).find((x) => Number(x.id) === Number(res.valueId))?.custom,
      price: price.price, priceFrom: price.from, qty: v.qty ?? null,
      sibling: sib.x.sheinSku, sites: sites.map((x) => x.site), raw: sib.s,
    });
  }
  if (!plan.sizes.length) { plan.notes.push(blocker('nothing_to_add')); return { body: null, plan: tidy(plan) }; }

  // The body (Appendix A.2). Fields left out keep their value on SHEIN.
  const newSku = (z) => {
    const s = z.raw;
    const sku = {
      sale_attribute_list: [z.kind === 'value' ? { attribute_id: Number(sizeAttr), attribute_value_id: Number(z.valueId) } : { attribute_id: Number(sizeAttr), custom_attribute_value: z.sheinSize, language: 'en' }],
      supplier_sku: z.sku,
      length: String(s.length), width: String(s.width), height: String(s.height), weight: Number(s.weight),
      mall_state: 1,
      price_info_list: z.sites.map((site) => ({ base_price: z.price, currency: 'USD', sub_site: site })),
      // doc 3002047's own examples send supplier_warehouse_id = the msc/warehouse/list warehouseCode ("PS…") — S1
      stock_info_list: [{ inventory_num: 0, ...(warehouse?.code ? { supplier_warehouse_id: warehouse.code } : {}) }],
    };
    if (s.quantity != null && s.quantityType != null && s.quantityUnit != null) sku.quantity_info = { quantity: Number(s.quantity), quantity_type: Number(s.quantityType), quantity_unit: Number(s.quantityUnit) };
    if (Number(s.packageType) > 0) sku.package_type = Number(s.packageType);
    if (imageOf(s)) sku.image_info = { image_info_list: [{ image_sort: 1, image_type: 1, image_url: imageOf(s) }] };
    return sku;
  };
  const skc = { skc_name: plan.skc, sku_list: [...plan.relinks.map((l) => ({ sku_code: l.skuCode, supplier_sku: l.to })), ...plan.sizes.map(newSku)] };
  // The SKC title is re-sent as SHEIN has it whenever the store may carry one (left out = cleared).
  if (titleRule?.show === true && skcNames.length) {
    skc.skc_title = (skcNames.find((x) => /^en/i.test(x.language)) || skcNames[0]).name;
    skc.skc_multi_language_name_list = skcNames;
    plan.skcTitleCopied = true;
  }
  const body = { spu_name: spu.spuName, skc_list: [skc] };
  // spu-info doesn't return a custom order, so the FULL list goes in numeric size order — only when
  // SHEIN says the store may sort sizes, and only when every existing size has its value id.
  if (sortSupported && rows.every((r) => r.sizeValueId != null)) {
    const list = [...new Map(rows.map((r) => [r.sizeValueId, { label: r.size, item: { attribute_value_id: Number(r.sizeValueId) } }])).values(),
      ...plan.sizes.map((z) => ({ label: z.sheinSize, item: z.kind === 'value' ? { attribute_value_id: Number(z.valueId) } : { custom_attribute_value: z.sheinSize } }))];
    list.sort((a, b) => sizeSort(a.label) - sizeSort(b.label) || String(a.label).localeCompare(String(b.label)));
    body.sale_attribute_sort_list = [{ attribute_id: Number(sizeAttr), in_order_attribute_value_list: list.map((x) => x.item) }];
    plan.sortSent = true;
  }
  plan.sibling = plan.sizes[0]?.sibling || null;
  return { body, plan: tidy(plan) };
}
/* ------------------- Phase 3: re-sync Needs update (price · sizes on · SKUs · title) ------------------- */
// docs/shein-listings-plan.md §3 Phase 3. Two kinds of item per product: `price` (product/price/save —
// never publishOrEdit) and `edit` (ONE partialEdit: stopped sizes back on, seller-SKU relinks, and
// the title ONLY on a product we published — products.synced_hash; never a 4seller product, D11).

export const PRICE_SAVE_PATH = '/open-api/openapi-business-backend/product/price/save';
export const PRICE_RISE_REASON = '4';   // price/save riseReason enum: 4 = other
const onSheinMatch = new Set(['sku', 'link', 'published']);
const usable = (r) => r.shopify_variant_id && !r.excluded && onSheinMatch.has(r.match) && !['blocked', 'excluded'].includes(r.status) && r.shein_sku;

// price/save body for one product. In: spu (raw spu-info), stored variant rows, targets Map(variantId →
// { price, from }) (D4), locks Map(skc → { price (priceLockType 1: no rise), warn (type 2) }) and
// locksUnread (searchProduct failed → no RISE goes), inflightSkus (SHEIN still reviewing an earlier
// price of that SKU), endSpecials (a person chose to END live specials), auto + shopifyFloor
// Map(variantId → Shopify price) (D8a: a cut ≤ 15 % a day, never below the Shopify price).
// Compared with the price a shopper PAYS (special when > 0). Under a live special nothing is sent
// unless endSpecials — then shopPrice = target WITHOUT specialPrice (that is what ends a special).
// Out: { body: { productPriceList } | null, plan: { op:'price', prices, skipped, blockers, notes } }.
export function planPrice({ spu, stored = [], targets = new Map(), locks = new Map(), locksUnread = false, inflightSkus = new Set(), endSpecials = false, auto = false, shopifyFloor = new Map() }) {
  const plan = { op: 'price', spu: spu?.spuName || null, prices: [], skipped: [], blockers: [], notes: [], auto: !!auto, endSpecials: !!endSpecials };
  if (!spu?.spuName) { plan.blockers.push(blocker('not_on_shein_product')); return { body: null, plan }; }
  const raw = new Map(rawSkus(spu).map((x) => [String(x.raw.skuCode), x]));
  const list = [];
  for (const r of stored.filter(usable)) {
    const x = raw.get(String(r.shein_sku)); const t0 = targets.get(r.shopify_variant_id);
    if (!x || !t0) continue;
    for (const p of (x.raw.priceInfoList || []).filter((q) => /usd/i.test(q.currency || 'USD'))) {
      const base = Number(p.basePrice); const special = Number(p.specialPrice) > 0 ? Number(p.specialPrice) : null; const site = p.site || p.subSite || 'shein-us';
      const pays = special ?? base;
      let to = t0.price; let capped = false;
      if (auto && to < pays) {   // D8a: at most 15 % off what the shopper pays now, never below the Shopify price — whole dollars, rounded UP
        const floor = Math.ceil(Math.max(pays * 0.85, Number(shopifyFloor.get(r.shopify_variant_id)) || 0) - 1e-9);
        if (to < floor) { to = floor; capped = true; }
      }
      if (auto && to > pays) {   // R3: and at most 15 % UP a day (rounded up to a whole dollar)
        const ceil = Math.ceil(pays * 1.15 - 1e-9);
        if (to > ceil) { to = ceil; capped = true; }
      }
      if (!(Math.abs(to - pays) > 0.5)) continue;
      const size = r.shein_size || r.shopify_size;
      const skip = (b) => plan.skipped.push({ variantId: r.shopify_variant_id, size, sku: r.seller_sku, blocker: b });
      if (special != null && !endSpecials) { skip(blocker('special_live', { special, base, to })); continue; }
      // R1: a rise = the SHOPPER pays more. Ending a special (base 200 / special 150 → 165) is a rise even
      // though 165 < the original — it takes the lock checks, riseReason and may go to SHEIN's review.
      const rise = to > pays;
      if (inflightSkus.has(String(r.shein_sku))) { skip(blocker('review_open', {})); continue; }
      if (rise && locksUnread) { skip(blocker('price_lock_unread', { size })); continue; }
      if (rise && locks.get(x.skc)?.price) { skip(blocker('price_locked', { size })); continue; }
      const warn = !!locks.get(x.skc)?.warn;
      plan.prices.push({ variantId: r.shopify_variant_id, skuCode: String(r.shein_sku), skc: x.skc, size, site, currency: 'USD', from: pays, base, to, special: null,
        endsSpecial: special, rise, priceFrom: t0.from, capped, lockWarn: warn });
      if (capped) plan.notes.push(blocker('auto_capped', { size }));
      if (warn) plan.notes.push(blocker('price_lock_warn', { size }));
      list.push({ productCode: String(r.shein_sku), currencyCode: 'USD', shopPrice: to, site, ...(rise ? { riseReason: PRICE_RISE_REASON } : {}) });
    }
  }
  if (list.length > 100) { plan.blockers.push(blocker('too_many_prices')); return { body: null, plan }; }
  if (!list.length) { plan.notes.push(blocker('nothing_to_edit')); return { body: null, plan }; }
  return { body: { productPriceList: list }, plan };
}

// ONE partialEdit for one product's edits. In: spu (raw), product (Shopify LIVE), stored rows, productRow
// (shein_listing_products: synced_hash = we published it), fill / fillUnread (fill-in-standard), taken
// (seller SKUs already in the store), recentShelf (SKCs whose shelf changed < 20 min ago).
// Out: { body | null, plan: { op:'edit', mallOn, relinks, title, skipped, blockers, notes } }.
//   names: the SPU name in EVERY language SHEIN keeps (spu-info read with fill-in-standard's
//   language_title_max_length_list) — an object[] is replaced whole (doc 3002047 rule 3), so without
//   it no title is sent.
export function planEdit({ spu, product, stored = [], productRow = null, fill = null, fillUnread = false, taken = new Set(), recentShelf = new Set(), names = null }) {
  const plan = { op: 'edit', spu: spu?.spuName || null, mallOn: [], relinks: [], title: null, skipped: [], blockers: [], notes: [] };
  if (!spu?.spuName) { plan.blockers.push(blocker('not_on_shein_product')); return { body: null, plan }; }
  if (fillUnread) { plan.blockers.push(blocker('skc_field_uncopyable', { why: 'fill_unread' })); return { body: null, plan }; }
  // SHEIN re-checks the WHOLE product on every edit; a title over today's limit fails every edit (S7).
  const max = Number(fill?.default_language_title_max_length) || null;
  const curName = en(spu.productMultiNameList, 'productName');
  if (max && curName.length > max) { plan.blockers.push(blocker('shein_title_too_long', { length: curName.length, max })); return { body: null, plan }; }
  const raw = new Map(rawSkus(spu).map((x) => [String(x.raw.skuCode), x]));
  const live = new Map((product?.variants || []).map((v) => [v.variantId, v]));
  const rule = (k) => (fill?.fill_in_standard_list || []).find((x) => x.field_key === k) || null;
  const skip = (r, b) => plan.skipped.push({ variantId: r.shopify_variant_id, size: r.shein_size || r.shopify_size, sku: r.seller_sku, blocker: b });
  const away = new Set();
  for (const r of stored.filter(usable)) {
    const x = raw.get(String(r.shein_sku)); if (!x) continue;
    const v = live.get(r.shopify_variant_id);
    if (Number(x.raw.mallState) === 2 && Number(v?.qty) > 0) {
      if (recentShelf.has(x.skc)) skip(r, blocker('shelf_wait'));
      else plan.mallOn.push({ variantId: r.shopify_variant_id, skuCode: String(r.shein_sku), skc: x.skc, size: r.shein_size || r.shopify_size });
    }
    if (r.match === 'link') {
      const to = trim(v?.sku || r.seller_sku); const from = trim(x.raw.supplierSku);
      if (to && from !== to) { plan.relinks.push({ variantId: r.shopify_variant_id, skuCode: String(r.shein_sku), skc: x.skc, size: r.shein_size, from: from || null, to }); if (from) away.add(from); }
    }
  }
  plan.relinks = plan.relinks.filter((l) => { if (taken.has(l.to) && !away.has(l.to)) { skip(l, blocker('seller_sku_taken', { sku: l.to }, 'sku')); return false; } return true; });
  // Title (and photos) only on a product WE published (D11); a 4seller product never gets one.
  const sheinName = en(spu.productMultiNameList, 'productName'); const shopTitle = trim(product?.title);
  if (shopTitle && sheinName && shopTitle !== sheinName) {
    if (!productRow?.synced_hash) plan.notes.push(blocker('title_not_ours'));
    else if (Array.isArray(names) && names.length) {
      const lim = max || 1000; const lang = fill?.default_language || 'en';
      let name = shopTitle;
      if (name.length > lim) { const cut = name.slice(0, lim); const sp = cut.lastIndexOf(' '); name = (sp > lim * 0.6 ? cut.slice(0, sp) : cut).trim(); }   // at a word boundary
      if (name.length >= 2) {
        const list = names.filter((n) => n.language !== lang).map((n) => ({ language: n.language, name: n.name }));
        list.unshift({ language: lang, name });
        plan.title = { from: sheinName, to: name, language: lang, cut: name !== shopTitle, languages: list.map((n) => n.language), list };
      }
      plan.notes.push(blocker('images_later'));
    }
  }
  const skcsTouched = [...new Set([...plan.mallOn, ...plan.relinks].map((x) => x.skc))];
  if (skcsTouched.length && rule('reference_product_link')?.show === true) { plan.blockers.push(blocker('skc_field_uncopyable', { field: 'competing_product_link' })); return { body: null, plan }; }
  if (!skcsTouched.length && !plan.title) { plan.notes.push(blocker('nothing_to_edit')); return { body: null, plan }; }
  const body = { spu_name: spu.spuName };
  if (plan.title) body.multi_language_name_list = plan.title.list;   // the WHOLE list, the default language replaced
  if (skcsTouched.length) {
    const titleRule = rule('skc_title');
    body.skc_list = [];
    for (const skcName of skcsTouched) {
      const c = (spu.skcInfoList || []).find((k) => String(k.skcName) === skcName);
      const names = ((c?.productMultiNameList) || []).filter((y) => trim(y?.productName)).map((y) => ({ language: y.language || 'en', name: trim(y.productName) }));
      if (titleRule?.show === true && titleRule.required === true && !names.length) { plan.blockers.push(blocker('skc_field_uncopyable', { field: 'skc_title' })); return { body: null, plan }; }
      const bySku = new Map();
      for (const m of plan.mallOn.filter((y) => y.skc === skcName)) bySku.set(m.skuCode, { ...(bySku.get(m.skuCode) || { sku_code: m.skuCode }), mall_state: 1 });
      for (const l of plan.relinks.filter((y) => y.skc === skcName)) bySku.set(l.skuCode, { ...(bySku.get(l.skuCode) || { sku_code: l.skuCode }), supplier_sku: l.to });
      const skc = { skc_name: skcName, sku_list: [...bySku.values()] };
      if (titleRule?.show === true && names.length) { skc.skc_title = (names.find((y) => /^en/i.test(y.language)) || names[0]).name; skc.skc_multi_language_name_list = names; }
      body.skc_list.push(skc);
    }
  }
  return { body, plan };
}

// The plan as stored (no raw SHEIN objects).
function tidy(plan) { return { ...plan, sizes: plan.sizes.map(({ raw, ...z }) => z) }; }

// One line for a person (the dry-run sheet, the job item list):
// "Will add 2 sizes: US14.5W (custom, new), US15 (SHEIN size) · relink 1 seller SKU: OLD10 → A10 · 1 skipped: 3.5C (…)".
const usd = (n) => `$${Number(n).toFixed(2).replace(/\.00$/, '')}`;
export function summarizePlan(plan) {
  if (!plan) return '';
  const parts = [];
  const skippedPart = (sk) => `${sk.length} size${sk.length === 1 ? '' : 's'} skipped: ${sk.map((x) => `${x.size || x.sku || '?'} (${renderBlocker(x.blocker).title.replace(/\.$/, '')})`).join('; ')}`;
  const lead = (pb) => (pb.length ? renderBlocker(pb[0]).title.replace(/\.$/, '') : '');
  if (plan.op === 'publish') {   // Phase 4
    const sz = plan.sizes || [];
    const hard = (plan.blockers || []).filter((b) => !isNote(b) || b.code === 'shopify_inactive');   // inactive never publishes
    if (hard.length) return `Can’t publish yet: ${renderBlocker(hard[0]).title.replace(/\.$/, '')}${hard.length > 1 ? ` (+${hard.length - 1} more)` : ''}`;
    if (!sz.length) return lead([...(plan.blockers || []), ...(plan.notes || [])]) || 'Nothing to publish.';
    return [`Will publish “${plan.title?.text || ''}” with ${sz.length} size${sz.length === 1 ? '' : 's'}: ${sz.map((z) => `${z.sheinSize}${z.kind === 'custom' ? ' (custom)' : ''} ${usd(z.price)}`).join(', ')}`,
      `${(plan.images || []).length} photo${(plan.images || []).length === 1 ? '' : 's'}`, plan.quota?.controlled ? `uses ${plan.quota.uses} of ${plan.quota.available} publish quota` : ''].filter(Boolean).join(' · ');
  }
  if (plan.op === 'price') {
    const pr = plan.prices || [];
    if (pr.length) parts.push(`Will change ${pr.length} price${pr.length === 1 ? '' : 's'}: ${pr.map((x) => `${x.size} ${usd(x.from)} → ${usd(x.to)}${x.endsSpecial ? ` (ends the ${usd(x.endsSpecial)} special: shoppers pay ${usd(x.to)}${x.rise ? ', SHEIN may review it' : ''})` : x.rise ? ' (up: SHEIN may review it)' : ''}${x.capped ? ' (capped: 15 % a day)' : ''}`).join(', ')}`);
    if ((plan.skipped || []).length) parts.push(skippedPart(plan.skipped));
    if (!pr.length) parts.unshift((plan.skipped || []).length && !(plan.blockers || []).length ? 'Nothing to send' : lead([...(plan.blockers || []), ...(plan.notes || [])]));
    return parts.filter(Boolean).join(' · ');
  }
  if (plan.op === 'edit') {
    const on = plan.mallOn || []; const rl = plan.relinks || [];
    if (on.length) parts.push(`Will turn ${on.length} size${on.length === 1 ? '' : 's'} back on: ${on.map((x) => x.size).join(', ')}`);
    if (rl.length) parts.push(`change ${rl.length} SKU${rl.length === 1 ? '' : 's'} SHEIN has wrong: ${rl.map((l) => `${l.from || '—'} → ${l.to}`).join(', ')}`);
    if (plan.title) parts.push(`title → “${plan.title.to}”`);
    if ((plan.skipped || []).length) parts.push(skippedPart(plan.skipped));
    if (!on.length && !rl.length && !plan.title) parts.unshift((plan.skipped || []).length && !(plan.blockers || []).length ? 'Nothing to send' : lead([...(plan.blockers || []), ...(plan.notes || [])]));
    return parts.filter(Boolean).join(' · ');
  }
  const sz = plan.sizes || [];
  if (sz.length) parts.push(`Will add ${sz.length} size${sz.length === 1 ? '' : 's'}: ${sz.map((z) => `${z.sheinSize} (${z.kind === 'custom' ? (z.isNew ? 'custom, new' : 'custom') : z.customExisting ? 'custom' : 'SHEIN size'})`).join(', ')}`);
  const rl = plan.relinks || [];
  if (rl.length) parts.push(`change ${rl.length} SKU${rl.length === 1 ? '' : 's'} SHEIN has wrong: ${rl.map((l) => `${l.from || '—'} → ${l.to}`).join(', ')}`);
  const sk = plan.skipped || [];
  if (sk.length) parts.push(`${sk.length} size${sk.length === 1 ? '' : 's'} skipped: ${sk.map((x) => `${x.size || x.sku || '?'} (${renderBlocker(x.blocker).title.replace(/\.$/, '')})`).join('; ')}`);
  const pb = (plan.blockers || []).concat(plan.notes || []);
  if (!sz.length && pb.length) parts.unshift(renderBlocker(pb[0]).title.replace(/\.$/, ''));
  return parts.join(' · ');
}

// What a person reads for one item of a dry run / a send (the review sheet, the job card, the
// drawer's history). The same status means different things in the two kinds: a dry-run item
// that is `done` is ready to send; a sent item that is `done` is on SHEIN, approved.
export const ITEM_STATUSES = {
  preview: {
    pending: { label: 'Checking', chip: 'ebo-chip', tone: 'muted' },
    done: { label: 'Ready to send', chip: 'ebo-chip info', tone: 'info' },
    skipped: { label: 'Nothing to send', chip: 'ebo-chip', tone: 'muted' },
    failed: { label: 'Couldn’t check', chip: 'ebo-chip warn', tone: 'warn' },
  },
  run: {
    pending: { label: 'Waiting to send', chip: 'ebo-chip', tone: 'muted' },
    sending: { label: 'Sending', chip: 'ebo-chip info', tone: 'info' },
    sent: { label: 'Sent', chip: 'ebo-chip info', tone: 'info' },
    in_review: { label: 'In review', chip: 'ebo-chip violet', tone: 'violet', say: 'Sent. SHEIN is reviewing it — the new sizes show as In review until SHEIN approves.' },
    done: { label: 'Done', chip: 'ebo-chip ok', tone: 'ok', say: 'SHEIN approved it. The live sync now keeps its stock in step.' },
    deferred: { label: 'Waiting', chip: 'ebo-chip warn', tone: 'warn', say: 'Not sent yet — it goes by itself at the next try.' },
    changed: { label: 'Not sent', chip: 'ebo-chip warn', tone: 'warn', say: 'Shopify changed since the dry run — dry run again. Nothing was sent.' },
    skipped: { label: 'Skipped', chip: 'ebo-chip', tone: 'muted' },
    failed: { label: 'Error', chip: 'ebo-chip bad', tone: 'bad', say: 'SHEIN refused it. Fix what it says, then dry run again.' },
  },
};
export const itemStatus = (kind, status) => (ITEM_STATUSES[kind === 'run' ? 'run' : 'preview'][status]) || { label: status, chip: 'ebo-chip', tone: 'muted' };
// Phase 3 — what each op of a dry run / send is (the sheet's tag), and the run words that differ by op.
export const OP_LABEL = { add_sku: 'Add sizes', price: 'Prices', edit: 'Sizes & SKUs', publish: 'Publish' };
export const isUpdateOps = (ops) => (ops || []).some((o) => o === 'price' || o === 'edit');
// Phase 4 — a dry run / send of brand-new products (op 'publish', never mixed with the others).
export const isPublishOps = (ops) => (ops || []).includes('publish');
// A publish item's chip word where it reads better than the shared one (the sheet / job card).
export const PUBLISH_WORD = {
  preview: { done: 'Ready to publish', skipped: 'Can’t publish yet' },
  run: { done: 'Approved', in_review: 'In review', failed: 'Error' },
};
export const OP_SAY = {
  price: {
    in_review: 'Sent. A price that goes UP waits for SHEIN’s price review — it shows In review until SHEIN approves it. Cuts apply at once.',
    done: 'Done — SHEIN shows the new price.',
  },
  edit: {
    in_review: 'Sent. SHEIN is reviewing the edit — sizes turned back on and SKU changes show once SHEIN approves.',
    done: 'SHEIN approved it — sizes and SKUs are in step.',
  },
  publish: {
    in_review: 'Sent. SHEIN is reviewing the new product (hours to days) — it shows In review until SHEIN approves it. It went up at stock 0.',
    done: 'SHEIN approved it — the product is live on SHEIN and the live sync now sets its stock.',
    failed: 'SHEIN refused it. Fix what it says, then dry run again.',
  },
};
// price/save's answer per size (item.sku_codes[].status): 1 applied · 2 SHEIN's price review · 3 refused in review · 0 refused.
export const PRICE_CODE = {
  1: { label: 'Approved', chip: 'ebo-chip ok' },
  2: { label: 'In review', chip: 'ebo-chip violet' },
  3: { label: 'Refused', chip: 'ebo-chip bad' },
  0: { label: 'Refused', chip: 'ebo-chip bad' },
};
// Where a new size's SHEIN price came from (D4).
export const PRICE_FROM = {
  market: 'market + 15 %, rounded up',
  shopify: 'Shopify price (no recent market price)',
};
// A failed run item a person may send again now (no answer from SHEIN), vs one SHEIN refused
// (fix it, then dry run again) — the server's retry action applies the same rule.
export const ITEM_NO_ANSWER = 'SHEIN didn’t answer. Retry sends it again — it is looked up on SHEIN first, so it is never sent twice.';
export const itemRetryable = (it) => it?.status === 'deferred' || (it?.status === 'failed' && (it.blockers || []).some((b) => b.code === 'api_error'));
// Phase 4 (review F1): a publish SHEIN didn't confirm is NEVER resent by itself — a person Looks again
// (PH ok, read-only); Send again unlocks only after a SECOND look ≥ 30 min after the send found nothing.
export const itemUnconfirmed = (it) => it?.op === 'publish' && it?.status === 'failed' && (it.blockers || []).some((b) => b.code === 'publish_unconfirmed');
export const itemCanSendAgain = (it) => itemUnconfirmed(it) && it?.response?.send_again_ok === true;

// The SHEIN review answer for one SKC (query-document-state / the audit webhook) → what we do.
//   2 approved → 'approved' · 3 rejected / 4 withdrawn / -1 not received → 'rejected' · 1 / 5 → 'waiting'.
export function reviewVerdict(states = []) {
  const s = states.map(Number).filter((x) => Number.isFinite(x));
  if (!s.length) return 'waiting';
  if (s.some((x) => x === 3 || x === 4 || x === -1)) return 'rejected';
  if (s.some((x) => x === 1 || x === 5)) return 'waiting';
  return s.every((x) => x === 2) ? 'approved' : 'waiting';
}
