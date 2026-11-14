// SHEIN Listings (docs/context/shein-listings.md, docs/shein-listings-plan.md Appendix B.5).
// PH + admin. Phase 0/1: nothing here writes to SHEIN.
//
// GET  /api/shein/listings?status=&blocker=&q=&brand=&page=1&pageSize=50&sort=worst|title|updated|coverage
//        -> { ok, connected, configured, canWrite, isAdmin, summary, products, total, page, pageSize }
//        &shopify=active|inactive  (2026-10-28) active = ACTIVE on Shopify with stock > 0; inactive = the rest;
//        the answer carries shopifyCounts { active, inactive } for the same filters
// GET  /api/shein/listings?product=<gid>   -> { ok, product, variants, jobItems, log, canWrite, isAdmin }
// GET  /api/shein/listings?publishSetup=<gid,gid,…>  (≤ 100; PH ok; DB only) bulk edit before publishing ->
//        { ok, products:[{ productId, title, titleOverride, style, vendor, productType, imageUrl, shopifyStatus, inStock,
//          syncable, sizeGroups, category, productTypeId, skcValueId, usePhPhotos, titleMax, checklist, blocking, ready }],
//          skipped:[{ productId, title, why }], canWrite, isAdmin }
// GET  /api/shein/listings?photos=<gid>   (PH ok; Shopify + DB reads) the photos a publish would send, each with
//      skipped → { ok, source, usePhPhotos, shopify:[{url,key,width,height,skipped}], ph:[{url,key,angle,skipped}], sent, max, stale }
//      + (2026-11-14) source 'clean', cleanPhotos (null auto | true | false), clean:[{url,key,angle,how,skipped}], each Shopify photo's
//        phCopy { angle, slide 'spec'|'welcome'|null } when it is a copy of the PH set (checked: false = not all read in time)
// GET  /api/shein/listings?probe=1         -> { ok, probe, job }   the last Ask-SHEIN answer
// POST /api/shein/listings { action }:
//   snapshot                          re-read Shopify + SHEIN (a server job)          -> { ok, job }
//   stop { jobId? }                   stop the running job after the current batch   -> { ok, job }   (a RUN job: admin or Connect integrations, 403)
//   resume { jobId }                  an interrupted / stopped job carries on         -> { ok, job }   (a RUN job: admin or Connect integrations, 403;
//                                     its confirmed_by is kept, the resumer goes in resumed_by)
//   exclude | include { productIds?, variantKeys? }   "don't list on SHEIN" (DB only) -> { ok, n }
//   probe { spu? }                    Phase 0 (admin or Connect integrations)         -> { ok, job }
//   webhooks                          register Shopify products/* webhooks (admin or Connect integrations) -> { ok, hooks }
//   Phase 2 — add missing sizes to shoes already on SHEIN (docs/context/shein-listings.md → Phase 2):
//   preview { productIds | filter:{status,blocker,q,brand} }   the DRY RUN (PH ok; reads only)  -> { ok, job }
//   run { previewJobId, acceptChanges? }   admin or Connect integrations (403); no id → 400   -> { ok, job }
//   Phase 3 — Needs update → Synced: preview { …, ops: ['price','edit'] } (or one of them) — price via
//   product/price/save, edit = ONE partialEdit (sizes back on, SKU relinks, title on OUR products only);
//   auto_price { on }  admin or Connect integrations: D8's "auto re-sync price" switch (default OFF) -> { ok, autoPrice }
//   2026-11-11 — replace the photos of shoes ON SHEIN: preview { productIds, ops:['photos'] } (alone) → ONE partialEdit each → SHEIN review.
//   2026-11-14 — fix the Product Model of shoes ON SHEIN: preview { productIds, ops:['model'] } (alone) → ONE partialEdit each (the current
//     details, only 1000546 swapped) → SHEIN review; GET ?modelFix=1 (PH, DB only) → { rows, candidates, setup, checked } (the shoes to fix).
//   Phase 4 — publish brand-new products: preview { …, ops:['publish'] } (never mixed; filter = products NOT on SHEIN);
//     photos are converted (R2 + transform-pic) only when the starter is an admin / Connect integrations holder (security H2);
//   publish_choices { productId, titleOverride?, skcValueId?, usePhPhotos?, photoSkip?: [url] } (PH, DB only) -> { ok, product };
//     + categoryPick: { categoryId } | null (THIS shoe's SHEIN category, a leaf; only a shoe never live on SHEIN — 409 else)
//     + attr: { attributeId, valueIds?, extraValues? } | { attributeId, clear: true } (THIS shoe's own SHEIN detail, e.g. Product Model;
//       checked against the template of the shoe's category) — 2026-11-11
//     + photoSource: 'clean' | 'ph_edited' | 'shopify' | 'auto' (2026-11-14; usePhPhotos alone also switches the clean photos off)
//   find_clean_photos { productId }  (PH, R2 list + reads; writes product_cutouts only) the style's cutouts made by the brand tool
//     before they were recorded, matched to its uploaded angles -> { ok, found, recorded, cutouts, confidence }
//   publish_choices_bulk { productIds (≤ 100), patch: { skcValueId?, usePhPhotos?, cleanPhotos?: true|false|null, skipCover?, skipSlides?: true }, productTypeId?, titles?: { [productId]: title | null } }
//     skipSlides = leave out every Shopify photo that is a copy of the PH spec / welcome slide (checked by picture, ≤ 25 s) -> + slides { shoes, photos, unchecked }
//     (PH, DB only; the same validation as publish_choices; a colour needs productTypeId and every product must be
//     mapped to that SHEIN product type) -> { ok, updated, missing };
//   publish_again { productIds }  admin or Connect integrations: re-publish after SHEIN rejected the first one -> { ok, products }
//   look_again { itemIds }  (PH, read-only) a publish SHEIN didn't confirm: looked up (seller SKUs / document state) -> { ok, results:[{id, found, sendAgainOk, looks}] }
//   send_again { itemIds }  admin or Connect integrations: only after a second look ≥ 30 min after the send found nothing -> { ok, results }
// GET ?product= also returns `checklist` — the 18 publish requirement lines from the SERVER planner
//   (the last dry run's, else the stored readiness with the unread lines as null).
//   retry { itemIds }                      admin or Connect integrations: an item that got no
//                                          answer, or is waiting, tries again now             -> { ok, retried, refused, job }
// Gates: applySecurity → requireRole(['ph_team']) (admin auto) → the privilege (read fresh from the
// DB, enforced for probe / webhooks) → rateLimit → getJsonBody.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import {
  dbConfigured, listListingProducts, listingSummary, getListingProduct, listingItemsForProduct, listSheinApiLog, getListingCache, getListingJob,
  activeListingJob, latestListingJob, markStaleListingJobs, requestListingStop, cancelQueuedListingJob, setListingExcluded, listingVariantProductIds,
  getSetting, setSetting, getListingItems, updateListingItem, requeueListingJob, resumeListingJob,
  lastPreviewItem, markPublishAgain, setListingPublishChoices, setListingCategoryPick, setListingAttrOverride, lastPublishRunItem,
  listingShopifyCounts, getListingProductsMany, setListingPublishChoicesMany, listCategoryMaps, listListingCache, setListingCoverSkip, productPhotosForSku,
  cleanPhotoKeys, addListingPhotoSkips, sheinModelReportData,
} from '../_lib/db.js';
import { cleanPhotosFor, findCleanPhotos, shopifyPhCopies } from '../_lib/shein-clean-photos.js';
import { modelReportFrom } from '../_lib/shein-model-report.js';
import { photoSourceOf, isSlideAngle, SLIDE_ANGLES } from '../../src/lib/sheinCleanPhotos.js';
import { publishChecklist, cleanTitle, sizeGroupOf, templateParts, photoKey, keepPhotos, isShopifyPhoto, PHOTO_SKIP_MAX, shoeCategory, attrValueProblem } from '../../src/lib/sheinPublish.js';
import { treeLeaves } from '../_lib/shein-publish.js';
import { sheinStatus } from '../_lib/shein.js';
import { shopifyAdminStore, shopifyEnsureWebhooks, shopifyListingProduct } from '../_lib/shopify.js';
import { startListingJob, startRunJob, resumeJob, recomputeStored, kickListingJobs, PREVIEW_OPS, readAutoPrice, setAutoPrice, lookAgainPublish, sendAgainPublish, readinessChecklist, readinessMany, userThrottle } from '../_lib/shein-listing.js';
import { hasPrivilege } from '../_lib/buycart.js';
import { renderBlocker, STATUS_CODES, STATUS_ORDER, TILE_STATUSES, BLOCKERS, summarizePlan, rowSyncable } from '../../src/lib/sheinListings.js';

const isAdminRole = (u) => u?.role === 'admin' || u?.role === 'superadmin';
const PRIV_ACTIONS = new Set(['probe', 'webhooks', 'run', 'retry', 'auto_price', 'publish_again', 'send_again']);
const PREVIEW_MAX = 300;
const BULK_MAX = 100;   // bulk edit before publishing: products per read / save
const SHOP_FILTERS = ['active', 'inactive'];
const blockingLines = (list) => (list || []).filter((l) => l.ok === false).map((l) => l.key);
// The size groups the drawer maps a category by (its Shopify sizes not left off) — productGroups() on the page.
const groupsOf = (variants) => [...new Set(variants.filter((v) => v.shopify_variant_id && !v.excluded).map((v) => sizeGroupOf(v.shopify_size)).filter(Boolean))];
// The SHEIN category a product goes to: the shoe's own pick (2026-11-11), else its product type's map
// (one size group only), else null. typeOf = its SHEIN product type.
const categoryOf = (row, variants, maps) => {
  const g = groupsOf(variants);
  const m = g.length === 1 ? maps.find((x) => x.shopify_product_type === String(row.product_type || '') && x.size_group === g[0]) : null;
  return shoeCategory(row, m);
};
const typeOf = (row, variants, maps) => categoryOf(row, variants, maps)?.productTypeId ?? null;
// Never live on SHEIN (not on it, or our publish was rejected): its category can still change.
const neverLive = (d) => !String(d.product.shopify_product_id).startsWith('shein:') && !d.variants.some((v) => v.shein_sku);
const idList = (v) => [...new Set(String(v || '').split(',').map((x) => x.trim()).filter(Boolean))];
const HOOK_TOPICS = ['PRODUCTS_CREATE', 'PRODUCTS_UPDATE', 'PRODUCTS_DELETE'];
const HOOKS_KEY = 'shein_listing_hooks';
const baseUrl = (req) => String(process.env.APP_URL || process.env.PUBLIC_URL || `https://${req.headers['x-forwarded-host'] || req.headers.host}`).replace(/\/+$/, '');
const t = (v, n) => (v == null ? null : String(v).trim().slice(0, n) || null);
const ids = (a, n = 500) => (Array.isArray(a) ? a : []).map((x) => t(x, 200)).filter(Boolean).slice(0, n);

const adminUrl = (gid) => {
  const id = String(gid || '').split('/').pop();
  return /^\d+$/.test(id) && shopifyAdminStore() ? `https://admin.shopify.com/store/${shopifyAdminStore()}/products/${id}` : null;
};
const render = (list) => (Array.isArray(list) ? list : []).map((b) => ({ ...renderBlocker(b), sizes: b.sizes ?? undefined }));
function productOut(p) {
  const blockers = render(p.blockers);
  const worst = blockers.find((b) => !['note', 'review'].includes(b.level)) || blockers[0] || null;
  const { shopify_json, search_text, computed_hash, ...rest } = p;
  return { ...rest, blockers, worst, shopifyUrl: adminUrl(p.shopify_product_id) };
}
const variantOut = (v) => ({ ...v, blockers: render(v.blockers), notes: render(v.notes) });
const jobOut = (j) => (j ? { ...j, lease_owner: undefined } : null);

async function summaryOut() {
  const s = await listingSummary();
  const byStatus = Object.fromEntries(STATUS_CODES.map((c) => [c, { products: 0, sizes: 0, inStock: 0 }]));
  for (const r of s.products) if (byStatus[r.status]) byStatus[r.status].products = r.n;
  for (const r of s.sizes) if (byStatus[r.status]) { byStatus[r.status].sizes = r.n; byStatus[r.status].inStock = r.in_stock; }
  // A product counts under EVERY status one of its in-stock sizes has, so the tiles can add up to more
  // than All; each tile's count is the length of its filtered list (2026-10-27 decision).
  const all = s.all;
  const [lastSnapshot, active, probe, hooks, autoPrice] = await Promise.all([
    latestListingJob('snapshot', 'done'), activeListingJob(), getListingCache('probe', 'last'), getSetting(HOOKS_KEY).catch(() => null), readAutoPrice(),
  ]);
  const latestSnap = await latestListingJob('snapshot');
  return {
    all, off: s.off, byStatus, tiles: TILE_STATUSES, order: STATUS_ORDER,
    topBlockers: s.blockers.map((b) => ({ code: b.code, sizes: b.sizes, products: b.products, level: BLOCKERS[b.code]?.level || 'error', title: renderBlocker({ code: b.code, params: {} }).title })),
    brands: s.brands.map((b) => ({ brand: b.vendor, products: b.n })),
    lastSnapshot: jobOut(lastSnapshot), latestSnapshot: jobOut(latestSnap), activeJob: jobOut(active),
    probe: probe ? { askedAt: probe.payload?.askedAt || probe.fetched_at, jobId: probe.payload?.jobId || null, categories: probe.payload?.categories?.length || 0 } : null,
    hooks: hooks ? JSON.parse(hooks) : null, autoPrice,
  };
}

// A publish choice (title / colour / PH photos) changes a new shoe's stored readiness: recount at once, not
// at the next Re-read. DB only — no SHEIN call; a failure never fails the save.
async function recountAfterChoices() {
  if (!(await latestListingJob('snapshot', 'done').catch(() => null))) return;
  await recomputeStored().catch((e) => console.error('[shein-listing] recompute after publish choices', e.message));
}

export default async function handler(req, res) {
  applySecurity(req, res);
  const user = requireRole(req, res, ['ph_team']);
  if (!user) return;
  const isAdmin = isAdminRole(user);
  const canWrite = isAdmin || await hasPrivilege(user, 'connect_integrations');   // fresh from the DB every call
  if (!rateLimit(req, { windowMs: 60_000, max: 120 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const by = user.name || user.username || '';

  if (req.method === 'GET') {
    const qs = new URL(req.url, 'http://x').searchParams;
    await markStaleListingJobs();
    if (qs.get('probe') === '1') {
      const c = await getListingCache('probe', 'last');
      return send(res, 200, { ok: true, probe: c?.payload || null, savedAt: c?.fetched_at || null, job: c?.payload?.jobId ? jobOut(await getListingJob(c.payload.jobId)) : null, canWrite });
    }
    if (qs.has('publishSetup')) {
      const want = idList(qs.get('publishSetup'));
      if (!want.length) return send(res, 400, { ok: false, error: 'Which products? (publishSetup=<id,id,…>)' });
      if (want.length > BULK_MAX) return send(res, 400, { ok: false, error: `At most ${BULK_MAX} products at a time — tick fewer.` });
      if (want.some((x) => x.length > 200)) return send(res, 400, { ok: false, error: 'That isn’t a product id.' });
      const rows = await getListingProductsMany(want);
      const found = new Set(rows.map((r) => r.product.shopify_product_id));
      const skipped = want.filter((x) => !found.has(x)).map((x) => ({ productId: x, title: null, why: 'not in SHEIN Listings (re-read Shopify + SHEIN)' }));
      const todo = [];
      for (const r of rows) {
        const p = r.product;
        if (String(p.shopify_product_id).startsWith('shein:')) skipped.push({ productId: p.shopify_product_id, title: p.title, why: 'only on SHEIN — not a Shopify product' });
        else if (p.spu) skipped.push({ productId: p.shopify_product_id, title: p.title, why: 'already on SHEIN — use Add missing sizes / Update' });
        else if (p.excluded) skipped.push({ productId: p.shopify_product_id, title: p.title, why: 'marked “Don’t list on SHEIN”' });
        else todo.push(r);
      }
      const ready = await readinessMany(todo);
      const cleanKeys = await cleanPhotoKeys().catch(() => new Map());
      const products = todo.map(({ product: p, variants }) => {
        const cleanCount = (cleanKeys.get(String(p.style || '').trim().toUpperCase()) || new Set()).size;
        const x = ready.get(p.shopify_product_id) || null;
        const checklist = x?.checklist || publishChecklist(p.blockers || [], { unknown: ['store', 'quota', 'shelf', 'site', 'brand', 'title', 'fields', 'colour', 'attributes', 'size_chart', 'sizes', 'prices', 'photos', 'skus'] });
        const blocking = blockingLines(checklist);
        const inStock = variants.filter((v) => v.shopify_variant_id && !v.excluded && Number(v.shopify_qty) > 0).length;
        const syncable = rowSyncable(p);
        return { productId: p.shopify_product_id, title: p.title, titleOverride: p.title_override || null, style: p.style, vendor: p.vendor, productType: p.product_type || '',
          imageUrl: p.image_url, shopifyStatus: p.shopify_status, inStock, sizes: variants.filter((v) => v.shopify_variant_id && !v.excluded).length, syncable,
          sizeGroups: groupsOf(variants), category: x?.category || null, productTypeId: x?.category?.productTypeId ?? null, skcValueId: p.skc_value_id == null ? null : Number(p.skc_value_id),
          usePhPhotos: !!p.use_ph_photos, cleanPhotos: p.clean_photos ?? null, cleanCount, cleanOn: p.clean_photos !== false && cleanCount > 0, photoSkip: (p.photo_skip || []).length, coverSkipped: !!p.image_url && (p.photo_skip || []).includes(photoKey(p.image_url)), titleMax: x?.titleMax ?? null, checklist, blocking, ready: syncable && !blocking.length, shopifyUrl: adminUrl(p.shopify_product_id) };
      });
      // the shoes that need fixing first (most ✕ first), then the ready ones
      products.sort((a, b) => Number(a.ready) - Number(b.ready) || b.blocking.length - a.blocking.length || String(a.title || '').localeCompare(String(b.title || '')));
      return send(res, 200, { ok: true, products, skipped, canWrite, isAdmin });
    }
    if (qs.has('modelFix')) {
      // 2026-11-14: live shoes whose Product Model on SHEIN isn't theirs (a Setup default went out with them) — DB only,
      // read-only. `candidates` = what "Fix the Product Model" previews (op 'model'); a fix already sent shows its status.
      const r = modelReportFrom(...await sheinModelReportData());
      return send(res, 200, { ok: true, ...r, canWrite });
    }
    if (qs.has('photos')) {
      // The photos a publish would send (2026-11-11) — Shopify's (live read) and the PH team's edited ones for the
      // style — each with skipped: true when a person left it out. Reads only (Shopify + our DB), never SHEIN.
      const ppid = t(qs.get('photos'), 200);
      if (!ppid || ppid.startsWith('shein:')) return send(res, 400, { ok: false, error: 'Which Shopify product? (photos=<id>)' });
      const d = await getListingProduct(ppid);
      if (!d) return send(res, 404, { ok: false, error: 'That product isn’t in SHEIN Listings (yet) — re-read Shopify + SHEIN.' });
      const shop = await shopifyListingProduct(ppid).catch((e) => ({ error: e.message }));
      if (shop?.error) return send(res, 503, { ok: false, error: `Shopify didn’t answer: ${shop.error}` });
      const style = shop?.product?.style || d.product.style || '';
      // the spec / welcome slides are never sent (2026-11-14) — not offered either
      const phAll = style ? await productPhotosForSku(style).catch(() => []) : [];
      const ph = phAll.filter((x) => !isSlideAngle(x.angle));
      const cleanRows = await cleanPhotosFor(style);
      const skip = new Set(d.product.photo_skip || []);
      const phList = ph.map((x) => ({ url: x.url, key: photoKey(x.url), angle: x.angle || null, skipped: skip.has(photoKey(x.url)) }));
      const clean = cleanRows.map((x) => ({ url: x.url, key: photoKey(x.url), angle: x.angle, how: x.how, origin: x.origin, skipped: skip.has(photoKey(x.url)) }));
      const source = photoSourceOf({ cleanPhotos: d.product.clean_photos ?? null, usePhPhotos: !!d.product.use_ph_photos, cleanCount: clean.length, phCount: phList.length });
      // when Shopify's photos are the ones sent: which are copies of the PH set (by picture; cached per photo; ≤ 6 s here,
      // the rest next time) — the branded ones and the spec / welcome slides get named
      const shopUrls = (shop?.product?.images || []).map((i) => i.url);
      const copies = source === 'shopify' && phAll.length && shopUrls.length ? await shopifyPhCopies(shopUrls, phAll, { deadline: Date.now() + 6000 }).catch(() => null) : null;
      const shopify = (shop?.product?.images || []).map((i) => {
        const c = copies?.byKey.get(photoKey(i.url)) || null;
        return { url: i.url, key: photoKey(i.url), width: i.width ?? null, height: i.height ?? null, skipped: skip.has(photoKey(i.url)), phCopy: c ? { angle: c.angle, slide: c.slide } : null };
      });
      const used = source === 'clean' ? clean : source === 'ph_edited' ? phList : shopify;
      const kept = keepPhotos(used.map((x) => x.url), [...skip]);
      // a left-out photo no longer on Shopify / the PH list / the clean list (stale) — shown so it can be put back
      const known = new Set([...shopify, ...phList, ...clean].map((x) => x.key));
      return send(res, 200, { ok: true, productId: ppid, style, usePhPhotos: !!d.product.use_ph_photos, cleanPhotos: d.product.clean_photos ?? null, source,
        shopify, ph: phList, clean, slidesOnFile: phAll.filter((x) => isSlideAngle(x.angle)).length, copiesChecked: source !== 'shopify' || !phAll.length || !shopify.length ? null : !!copies && copies.checked === shopify.length && copies.phRead === phAll.length,
        sent: Math.min(kept.urls.length, 11), max: 11, stale: [...skip].filter((k) => !known.has(k)).map((k) => ({ key: k, shopify: isShopifyPhoto(k) })) });
    }
    const pid = t(qs.get('product'), 200);
    if (pid) {
      const d = await getListingProduct(pid);
      if (!d) return send(res, 404, { ok: false, error: 'That product isn’t in SHEIN Listings (yet) — re-read Shopify + SHEIN.' });
      const [items, log, pubRun] = await Promise.all([listingItemsForProduct(pid, d.product.spu, 5), d.product.spu ? listSheinApiLog({ spu: d.product.spu, limit: 20 }) : [], lastPublishRunItem(pid)]);
      let checklist = null; let checklistFrom = null;
      // + a shoe SHEIN rejected (never live): fixing it (category, details, photos) happens before Publish again (2026-11-11)
      if (!String(pid).startsWith('shein:') && (!d.product.spu || neverLive(d))) {
        const last = await lastPreviewItem(pid, 'publish');
        // a preview from BEFORE the last send judged the rejected publish — read the readiness instead
        const sentAt = pubRun ? new Date(pubRun.sent_at || pubRun.updated_at || 0).getTime() : 0;
        // Bug 4 (2026-11-14): a size left off SINCE that preview ("Don't list on SHEIN") — the preview still judged it, so
        // its ✕ would stay on the checklist; read the readiness (which leaves it out) until the next preview
        const offNow = new Set(d.variants.filter((v) => v.excluded).map((v) => v.shopify_variant_id));
        const judged = [...(last?.plan?.sizes || []), ...(last?.plan?.skipped || [])].map((z) => z.variantId);
        const staleExclude = judged.some((id) => offNow.has(id));
        if (last?.plan?.checklist && new Date(last.updated_at).getTime() > sentAt && !staleExclude) { checklist = last.plan.checklist; checklistFrom = { jobId: Number(last.job_id), at: last.updated_at }; }
        else {
          // the readiness from the cache — a line SHEIN's rules weren't read for is null ("not read yet"), never ✓
          checklist = await readinessChecklist(d.product, d.variants).catch(() => null)
            || publishChecklist(d.product.blockers || [], { unknown: ['store', 'quota', 'shelf', 'site', 'brand', 'title', 'fields', 'colour', 'attributes', 'size_chart', 'sizes', 'prices', 'photos', 'skus'] });
          checklistFrom = { readiness: true };
        }
      }
      const itemOut = (i) => ({ ...(isAdmin ? i : { ...i, body: undefined, response: undefined }), summary: summarizePlan(i.plan) || i.error || null });
      // + how many clean photos the style has (2026-11-14) — the drawer says which set SHEIN gets
      const cleanCount = !String(pid).startsWith('shein:') && d.product.style ? (await cleanPhotosFor(d.product.style)).length : 0;
      return send(res, 200, { ok: true, product: { ...productOut(d.product), clean_count: cleanCount }, variants: d.variants.map(variantOut), canWrite, isAdmin, checklist, checklistFrom,
        // never live on SHEIN (not on it, or our publish was rejected) → no live-shoe tools (add sizes, photo swap…)
        neverLive: !String(pid).startsWith('shein:') && neverLive(d), lastPublishRun: pubRun ? itemOut(pubRun) : null,
        jobItems: items.map((i) => ({ ...(isAdmin ? i : { ...i, body: undefined, response: undefined }), summary: summarizePlan(i.plan) || i.error || null })),
        log: log.map((l) => (isAdmin ? l : { ...l, request: undefined, response: undefined })) });
    }
    const status = t(qs.get('status'), 20) || '';
    if (status && status !== 'all' && !STATUS_CODES.includes(status)) return send(res, 400, { ok: false, error: 'Unknown status.' });
    const blocker = t(qs.get('blocker'), 40);
    if (blocker && !/^[a-z_]+$/.test(blocker)) return send(res, 400, { ok: false, error: 'Unknown blocker.' });
    const sort = ['worst', 'title', 'updated', 'coverage'].includes(qs.get('sort')) ? qs.get('sort') : 'worst';
    const shopify = t(qs.get('shopify'), 20) || '';
    if (shopify && !SHOP_FILTERS.includes(shopify)) return send(res, 400, { ok: false, error: 'shopify: active or inactive.' });
    const f = { status, blocker, q: t(qs.get('q'), 120), brand: t(qs.get('brand'), 120) };
    const [st, list, summary, shopifyCounts] = await Promise.all([
      sheinStatus().catch(() => null),
      listListingProducts({ ...f, shopify: shopify || null, page: Number(qs.get('page')) || 1, pageSize: Number(qs.get('pageSize')) || 50, sort }),
      summaryOut(),
      listingShopifyCounts(f),
    ]);
    return send(res, 200, { ok: true, connected: !!st?.connected, configured: !!st?.configured, canWrite, isAdmin, summary, shopifyCounts,
      products: list.rows.map(productOut), total: list.total, page: list.page, pageSize: list.pageSize });
  }

  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const b = await getJsonBody(req);
  const action = String(b?.action || '');
  if (PRIV_ACTIONS.has(action) && !canWrite) return send(res, 403, { ok: false, error: 'This needs an admin, or the “Connect integrations” privilege.' });
  try {
    switch (action) {
      case 'snapshot': return send(res, 200, { ok: true, job: jobOut(await startListingJob({ kind: 'snapshot', by })) });
      case 'probe': {
        const spu = t(b.spu, 60);
        if (spu && !/^[A-Za-z0-9_-]+$/.test(spu)) return send(res, 400, { ok: false, error: 'That isn’t a SHEIN SPU code.' });
        return send(res, 200, { ok: true, job: jobOut(await startListingJob({ kind: 'probe', by, scope: spu ? { spu } : {} })) });
      }
      case 'stop': {
        const job = b.jobId ? await getListingJob(Number(b.jobId)) : await activeListingJob();
        if (!job || !['queued', 'running'].includes(job.status)) return send(res, 400, { ok: false, error: 'No job is running.' });
        if (job.kind === 'run' && !canWrite) return send(res, 403, { ok: false, error: 'Stopping a run that writes to SHEIN needs an admin, or the “Connect integrations” privilege.' });
        const out = job.status === 'queued' ? await cancelQueuedListingJob(job.id) : await requestListingStop(job.id);
        return send(res, 200, { ok: true, job: jobOut(out || job) });
      }
      case 'resume': {
        const id = Number(b.jobId);
        if (!Number.isInteger(id) || id < 1) return send(res, 400, { ok: false, error: 'Which job?' });
        // security H1: resuming a RUN re-starts SHEIN writes — the same gate as run; snapshot / preview / probe stay PH
        const job = await getListingJob(id);
        if (!job) return send(res, 404, { ok: false, error: 'No such job.' });
        if (job.kind === 'run' && !canWrite) return send(res, 403, { ok: false, error: 'Resuming a run that writes to SHEIN needs an admin, or the “Connect integrations” privilege.' });
        return send(res, 200, { ok: true, job: jobOut(await resumeJob(id, { by })) });
      }
      case 'exclude': case 'include': {
        const productIds = ids(b.productIds); const variantKeys = ids(b.variantKeys, 2000);
        if (!productIds.length && !variantKeys.length) return send(res, 400, { ok: false, error: 'Nothing picked.' });
        const n = await setListingExcluded({ productIds, variantKeys, excluded: action === 'exclude', by });
        if (await latestListingJob('snapshot', 'done')) await recomputeStored();   // DB only — no SHEIN call
        return send(res, 200, { ok: true, n, products: [...new Set([...productIds, ...await listingVariantProductIds(variantKeys)])] });
      }
      case 'preview': {
        let productIds = ids(b.productIds, PREVIEW_MAX);
        if (!productIds.length && b.filter && typeof b.filter === 'object') {
          const f = b.filter;
          const status = t(f.status, 20) || '';
          if (status && status !== 'all' && !STATUS_CODES.includes(status)) return send(res, 400, { ok: false, error: 'Unknown status.' });
          const blocker = t(f.blocker, 40);
          if (blocker && !/^[a-z_]+$/.test(blocker)) return send(res, 400, { ok: false, error: 'Unknown blocker.' });
          const forPublish = Array.isArray(b.ops) && b.ops.includes('publish');
          for (let page = 1; productIds.length < PREVIEW_MAX && page <= 10; page++) {
            const r = await listListingProducts({ status, blocker, q: t(f.q, 120), brand: t(f.brand, 120), page, pageSize: 200, sort: 'title' });
            productIds.push(...r.rows.filter((p) => (forPublish ? !p.spu : !!p.spu) && !String(p.shopify_product_id).startsWith('shein:')).map((p) => p.shopify_product_id));
            if (r.rows.length < 200) break;
          }
          productIds = [...new Set(productIds)].slice(0, PREVIEW_MAX);
        }
        if (!productIds.length) return send(res, 400, { ok: false, error: 'Pick the products to dry-run (none of these is on SHEIN yet).' });
        const ops = b.ops == null ? ['add_sku'] : (Array.isArray(b.ops) ? [...new Set(b.ops.map(String))] : []);
        if (!ops.length || ops.some((o) => !PREVIEW_OPS.includes(o)) || (ops.includes('add_sku') && ops.length > 1) || (ops.includes('publish') && ops.length > 1) || (ops.includes('photos') && ops.length > 1) || (ops.includes('model') && ops.length > 1)) return send(res, 400, { ok: false, error: 'ops: ["add_sku"], "price" and/or "edit", ["publish"], ["photos"] or ["model"] — never mixed.' });
        // endSpecials: a person chose to END live SHEIN specials on these sizes (sent without specialPrice)
        return send(res, 200, { ok: true, job: jobOut(await startListingJob({ kind: 'preview', by, scope: { productIds, ops, filter: b.filter || null, endSpecials: b.endSpecials === true, convertPhotos: canWrite } })) });
      }
      case 'run': {
        const previewJobId = Number(b.previewJobId);
        if (!Number.isInteger(previewJobId) || previewJobId < 1) return send(res, 400, { ok: false, error: 'Run needs the dry run it sends (previewJobId) — dry run first.' });
        return send(res, 200, { ok: true, job: jobOut(await startRunJob({ previewJobId, acceptChanges: b.acceptChanges === true, by })) });
      }
      case 'retry': {
        const itemIds = (Array.isArray(b.itemIds) ? b.itemIds : []).map(Number).filter((x) => Number.isInteger(x) && x > 0).slice(0, 500);
        if (!itemIds.length) return send(res, 400, { ok: false, error: 'Which items?' });
        const items = await getListingItems(itemIds);
        const jobs = new Map(); const refused = []; let retried = 0;
        for (const it of items) {
          const job = jobs.get(it.job_id) || await getListingJob(it.job_id); jobs.set(it.job_id, job);
          const codes = (it.blockers || []).map((x) => x.code);
          const noAnswer = it.status === 'failed' && codes.includes('api_error') && it.op !== 'publish';   // F1: a publish is looked again, never retried
          if (job?.kind !== 'run' || !(noAnswer || it.status === 'deferred')) {
            refused.push({ id: it.id, why: it.status === 'failed' ? 'SHEIN refused it — fix it, then dry run again' : it.status === 'changed' ? 'Shopify changed — dry run again' : `it is ${it.status}` });
            continue;
          }
          await updateListingItem(it.id, { status: 'deferred', nextInSec: 0, ...(noAnswer ? { retries: 0 } : {}), error: `Retry asked by ${by}` });
          retried += 1;
        }
        let job = null;
        for (const j of jobs.values()) {
          if (!retried || !j || j.kind !== 'run') continue;
          job = j.status === 'done' || j.status === 'interrupted' ? await requeueListingJob(j.id, 'queued (retry)') : ['stopped', 'failed'].includes(j.status) ? await resumeListingJob(j.id, by).catch(() => null) : j;
          if (job) break;
        }
        if (retried) await kickListingJobs();
        return send(res, 200, { ok: true, retried, refused, job: jobOut(job) });
      }
      case 'publish_choices': {
        const pid = t(b.productId, 200);
        if (!pid) return send(res, 400, { ok: false, error: 'Which product?' });
        const patch = {};
        if (b.titleOverride !== undefined) {
          const title = b.titleOverride == null || b.titleOverride === '' ? null : cleanTitle(b.titleOverride).slice(0, 1000);
          if (title != null && title.length < 2) return send(res, 400, { ok: false, error: 'A SHEIN title needs at least 2 characters.' });
          patch.titleOverride = title;
        }
        if (b.skcValueId !== undefined) { const v = b.skcValueId == null || b.skcValueId === '' ? null : Number(b.skcValueId); if (v != null && !Number.isSafeInteger(v)) return send(res, 400, { ok: false, error: 'That isn’t a SHEIN value id.' }); patch.skcValueId = v; }
        if (b.usePhPhotos !== undefined) { patch.usePhPhotos = b.usePhPhotos === true; patch.cleanPhotos = false; }   // an explicit PH / Shopify choice
        if (b.photoSource !== undefined) {
          const ps = { clean: { cleanPhotos: true }, auto: { cleanPhotos: null }, ph_edited: { cleanPhotos: false, usePhPhotos: true }, shopify: { cleanPhotos: false, usePhPhotos: false } }[b.photoSource];
          if (!ps) return send(res, 400, { ok: false, error: 'photoSource: clean, ph_edited, shopify or auto.' });
          Object.assign(patch, ps);
        }
        // Per shoe (2026-11-11): THIS shoe's SHEIN category, and its own value for a SHEIN detail (Product Model)
        if (b.categoryPick !== undefined || b.attr !== undefined) {
          const cur = await getListingProduct(pid);
          if (!cur) return send(res, 404, { ok: false, error: 'That product isn’t in SHEIN Listings.' });
          if (b.categoryPick !== undefined) {
            if (!neverLive(cur)) return send(res, 409, { ok: false, error: 'This shoe is already live on SHEIN — its category can’t be changed from here (SHEIN keeps a live product in its category).' });
            if (b.categoryPick == null) { await setListingCategoryPick(pid, null, by); }
            else {
              const tree = (await getListingCache('category_tree', 'store'))?.payload || null;
              if (!tree) return send(res, 409, { ok: false, error: 'SHEIN’s category list hasn’t been read yet — read it first (Choose category → Read SHEIN’s categories).' });
              const leaf = treeLeaves(tree).find((l) => l.categoryId === Number(b.categoryPick?.categoryId));
              if (!leaf || leaf.productTypeId == null) return send(res, 400, { ok: false, error: 'That isn’t a last-level SHEIN category (SHEIN only takes products in a leaf).' });
              await setListingCategoryPick(pid, { categoryId: leaf.categoryId, productTypeId: leaf.productTypeId, path: leaf.path }, by);
            }
          }
          if (b.attr !== undefined) {
            const a0 = b.attr && typeof b.attr === 'object' && !Array.isArray(b.attr) ? b.attr : null;
            const attributeId = Number(a0?.attributeId);
            if (!Number.isSafeInteger(attributeId) || attributeId < 1) return send(res, 400, { ok: false, error: 'Which SHEIN detail? (attr.attributeId)' });
            if (a0.clear === true) await setListingAttrOverride(pid, attributeId, null);
            else {
              const fresh = await getListingProduct(pid);
              // a shoe live on SHEIN: the product type SHEIN has it in (what its edits are checked against); else ours
              const ptid = !neverLive(fresh) && fresh.product.product_type_id ? Number(fresh.product.product_type_id) : typeOf(fresh.product, fresh.variants, await listCategoryMaps());
              if (!ptid) return send(res, 409, { ok: false, error: 'Choose this shoe’s SHEIN category first — the details SHEIN asks for depend on it.' });
              const tpl = (await getListingCache('attr_template', ptid))?.payload || null;
              const a = tpl ? templateParts(tpl).product.find((x) => Number(x.attribute_id) === attributeId) : null;
              if (!tpl) return send(res, 409, { ok: false, error: 'SHEIN’s list of details for this category hasn’t been read yet — read it first (a publish preview reads it).' });
              if (!a) return send(res, 400, { ok: false, error: 'That isn’t a SHEIN detail of this shoe’s category.' });
              const valueIds = (Array.isArray(a0.valueIds) ? a0.valueIds : []).map(Number).filter(Number.isSafeInteger).slice(0, 50);
              const extraValues = (Array.isArray(a0.extraValues) ? a0.extraValues : []).map((x) => String(x ?? '').replace(/\s+/g, ' ').trim().slice(0, 100)).filter(Boolean).slice(0, 50);
              const bad = attrValueProblem(a, valueIds, extraValues);
              if (bad) return send(res, 400, { ok: false, error: bad });
              await setListingAttrOverride(pid, attributeId, { ptid, valueIds, extraValues, by, at: new Date().toISOString() });
            }
          }
          if (!Object.keys(patch).length && b.photoSkip === undefined) {
            const row = (await getListingProduct(pid)).product;
            await recountAfterChoices();
            return send(res, 200, { ok: true, product: productOut(row) });
          }
        }
        if (b.photoSkip !== undefined) {
          const list = b.photoSkip == null ? [] : b.photoSkip;
          if (!Array.isArray(list) || list.length > PHOTO_SKIP_MAX) return send(res, 400, { ok: false, error: `photoSkip: a list of at most ${PHOTO_SKIP_MAX} photo links.` });
          const keys = [...new Set(list.map((u) => (typeof u === 'string' && u.length <= 1000 && /^https:\/\//i.test(u) ? photoKey(u) : null)))];
          if (keys.some((k) => !k)) return send(res, 400, { ok: false, error: 'That isn’t a photo link (https).' });
          patch.photoSkip = keys;
        }
        const row = await setListingPublishChoices(pid, patch);
        if (!row) return send(res, 404, { ok: false, error: 'That product isn’t in SHEIN Listings.' });
        await recountAfterChoices();
        return send(res, 200, { ok: true, product: productOut(row) });
      }
      case 'publish_choices_bulk': {
        // the same gate + validation as publish_choices, for many products at once; DB only
        const raw = Array.isArray(b.productIds) ? b.productIds : [];
        if (raw.length > BULK_MAX) return send(res, 400, { ok: false, error: `At most ${BULK_MAX} products at a time.` });
        const productIds = ids(raw, BULK_MAX);
        const titlesIn = b.titles && typeof b.titles === 'object' && !Array.isArray(b.titles) ? Object.entries(b.titles) : [];
        if (titlesIn.length > BULK_MAX) return send(res, 400, { ok: false, error: `At most ${BULK_MAX} titles at a time.` });
        const patch = {}; const pa = b.patch && typeof b.patch === 'object' ? b.patch : {};
        if (pa.titleOverride !== undefined) return send(res, 400, { ok: false, error: 'A title is per shoe — send titles: { productId: title }.' });
        if (pa.skcValueId !== undefined) { const v = pa.skcValueId == null || pa.skcValueId === '' ? null : Number(pa.skcValueId); if (v != null && !Number.isSafeInteger(v)) return send(res, 400, { ok: false, error: 'That isn’t a SHEIN value id.' }); patch.skcValueId = v; }
        if (pa.usePhPhotos !== undefined) { patch.usePhPhotos = pa.usePhPhotos === true; patch.cleanPhotos = false; }   // an explicit PH / Shopify choice
        if (pa.cleanPhotos !== undefined) {
          if (![true, false, null].includes(pa.cleanPhotos)) return send(res, 400, { ok: false, error: 'cleanPhotos: true, false or null.' });
          patch.cleanPhotos = pa.cleanPhotos;
        }
        if (pa.skipCover !== undefined && typeof pa.skipCover !== 'boolean') return send(res, 400, { ok: false, error: 'skipCover: true or false.' });
        if (pa.skipSlides !== undefined && pa.skipSlides !== true) return send(res, 400, { ok: false, error: 'skipSlides: true (put a slide back photo by photo).' });
        const titles = [];
        for (const [id, raw2] of titlesIn) {
          const pid2 = t(id, 200); if (!pid2) return send(res, 400, { ok: false, error: 'Which product is that title for?' });
          const title = raw2 == null || raw2 === '' ? null : cleanTitle(raw2).slice(0, 1000);
          if (title != null && title.length < 2) return send(res, 400, { ok: false, error: 'A SHEIN title needs at least 2 characters.' });
          titles.push([pid2, title]);
        }
        const cover = pa.skipCover;   // "leave out the cover photo" on all of them (true) / put it back (false)
        const slides = pa.skipSlides === true;   // leave out Shopify's copies of the PH spec / welcome slide (2026-11-14)
        const hasPatch = Object.keys(patch).length > 0 || cover !== undefined || slides;
        if (!titles.length && !(hasPatch && productIds.length)) return send(res, 400, { ok: false, error: 'Nothing to save — pick the products and what to set.' });
        if (hasPatch && !productIds.length) return send(res, 400, { ok: false, error: 'Which products?' });
        const all = [...new Set([...productIds, ...titles.map((x) => x[0])])];
        const rows = await getListingProductsMany(all);
        const have = new Set(rows.map((r) => r.product.shopify_product_id));
        const missing = all.filter((x) => !have.has(x));
        if (patch.skcValueId != null) {
          // a colour value belongs to ONE SHEIN product type: every product must be mapped to it
          const ptid = Number(b.productTypeId);
          if (!Number.isSafeInteger(ptid) || ptid < 1) return send(res, 400, { ok: false, error: 'A colour needs the SHEIN product type it comes from (productTypeId).' });
          const maps = await listCategoryMaps();
          const off = rows.filter((r) => productIds.includes(r.product.shopify_product_id) && typeOf(r.product, r.variants, maps) !== ptid);
          if (off.length) return send(res, 400, { ok: false, error: `${off.length} of these shoe${off.length === 1 ? ' isn’t' : 's aren’t'} in that SHEIN product type (or ${off.length === 1 ? 'has' : 'have'} no category yet) — a colour is set per product type: ${off.slice(0, 3).map((r) => r.product.title || r.product.shopify_product_id).join('; ')}${off.length > 3 ? ' …' : ''}` });
          const tpl = (await listListingCache('attr_template', [ptid]))[0]?.payload || null;
          const vals = tpl ? (templateParts(tpl).main?.attribute_value_info_list || []) : null;
          if (vals && !vals.some((v) => Number(v.attribute_value_id) === patch.skcValueId)) return send(res, 400, { ok: false, error: 'That colour isn’t in SHEIN’s list for this product type.' });
        }
        const picked = hasPatch ? productIds.filter((x) => have.has(x)) : [];
        const updated = await setListingPublishChoicesMany(Object.keys(patch).length ? picked : [], patch, titles.filter((x) => have.has(x[0])));
        if (cover !== undefined) for (const x of await setListingCoverSkip(picked, cover)) if (!updated.includes(x)) updated.push(x);
        let slideOut = null;
        if (slides) {
          // Shopify's photos as last read (shopify_json), compared by picture with each style's PH spec + welcome slides
          const th = userThrottle(user, 'skip_slides', { windowMs: 60_000, max: 4 });
          if (!th.ok) return send(res, 429, { ok: false, error: `Checked a lot of photos just now — try again in ${th.retryInSec} s.` });
          const deadline = Date.now() + 25_000;
          const pairs = []; slideOut = { shoes: 0, photos: 0, unchecked: 0, noSlides: 0 };
          for (const r of rows.filter((x) => picked.includes(x.product.shopify_product_id))) {
            const p = r.product;
            const urls = (p.shopify_json?.images || []).map((i) => i.url).filter(Boolean);
            const extras = p.style ? (await productPhotosForSku(p.style).catch(() => [])).filter((x) => SLIDE_ANGLES.includes(x.angle)) : [];
            if (!extras.length || !urls.length) { slideOut.noSlides += 1; continue; }
            const m = await shopifyPhCopies(urls, extras, { deadline }).catch(() => null);
            if (!m || m.checked < urls.length || m.phRead < extras.length) slideOut.unchecked += 1;
            const keys = [...(m?.byKey || new Map()).entries()].filter(([, v]) => v.slide).map(([k]) => k);
            if (keys.length) { pairs.push([p.shopify_product_id, keys]); slideOut.photos += keys.length; }
          }
          const done = await addListingPhotoSkips(pairs);
          slideOut.shoes = done.length;
          for (const x of done) if (!updated.includes(x)) updated.push(x);
        }
        if (updated) await recountAfterChoices();
        return send(res, 200, { ok: true, updated, missing, ...(slideOut ? { slides: slideOut } : {}) });
      }
      case 'find_clean_photos': {
        // the brand tool's cutouts for this shoe's style that were never recorded (R2 list + picture match; our DB only)
        const pid = t(b.productId, 200);
        if (!pid || pid.startsWith('shein:')) return send(res, 400, { ok: false, error: 'Which Shopify product?' });
        const th = userThrottle(user, 'find_clean', { windowMs: 60_000, max: 6 });
        if (!th.ok) return send(res, 429, { ok: false, error: `Looked a lot just now — try again in ${th.retryInSec} s.` });
        const d = await getListingProduct(pid);
        if (!d) return send(res, 404, { ok: false, error: 'That product isn’t in SHEIN Listings (yet) — re-read Shopify + SHEIN.' });
        if (!d.product.style) return send(res, 409, { ok: false, error: 'This shoe has no style code — no clean photos can be matched to it.' });
        const r = await findCleanPhotos(d.product.style, { write: true, by });
        if (r.recorded) await recountAfterChoices();
        return send(res, 200, { ok: true, style: r.sku, cutouts: r.cutouts, angles: r.angles || 0, found: r.found.length, recorded: r.recorded, confidence: r.confidence });
      }
      case 'look_again': {
        const itemIds = (Array.isArray(b.itemIds) ? b.itemIds : []).map(Number).filter((x) => Number.isInteger(x) && x > 0).slice(0, 50);
        if (!itemIds.length) return send(res, 400, { ok: false, error: 'Which items?' });
        const th = userThrottle(user, 'look_again', { windowMs: 60_000, max: 10 });   // security M3: SHEIN reads, per user
        if (!th.ok) return send(res, 429, { ok: false, error: `Looked a lot just now — try again in ${th.retryInSec} s.` });
        return send(res, 200, { ok: true, results: await lookAgainPublish(itemIds, { by }) });
      }
      case 'send_again': {
        const itemIds = (Array.isArray(b.itemIds) ? b.itemIds : []).map(Number).filter((x) => Number.isInteger(x) && x > 0).slice(0, 50);
        if (!itemIds.length) return send(res, 400, { ok: false, error: 'Which items?' });
        return send(res, 200, { ok: true, results: await sendAgainPublish(itemIds, { by }) });
      }
      case 'publish_again': {
        const productIds = ids(b.productIds, 100);
        if (!productIds.length) return send(res, 400, { ok: false, error: 'Which products?' });
        return send(res, 200, { ok: true, products: await markPublishAgain(productIds, by) });
      }
      case 'auto_price': {
        if (typeof b.on !== 'boolean') return send(res, 400, { ok: false, error: 'on: true or false.' });
        return send(res, 200, { ok: true, autoPrice: await setAutoPrice(b.on, by) });
      }
      case 'webhooks': {
        const hook = await shopifyEnsureWebhooks(`${baseUrl(req)}/api/shopify/webhook`, HOOK_TOPICS);
        if (hook.error) return send(res, 502, { ok: false, error: `Shopify didn’t accept the product webhooks: ${hook.error}` });
        const hooks = { on: true, ids: hook.ids, created: hook.created, by, at: new Date().toISOString() };
        await setSetting(HOOKS_KEY, JSON.stringify(hooks), by);
        return send(res, 200, { ok: true, hooks });
      }
      default: return send(res, 400, { ok: false, error: 'Unknown action.' });
    }
  } catch (e) {
    return send(res, e.status || 500, { ok: false, error: e.message, job: e.job ? jobOut(e.job) : undefined });
  }
}
