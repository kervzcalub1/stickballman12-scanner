// SHEIN Listings — the server jobs (docs/shein-listings-plan.md Phase 0/1, Appendix B.4;
// docs/context/shein-listings.md). READ-ONLY in Phase 1: nothing here changes anything on SHEIN.
//
//   probe     Phase 0. One product per SHEIN category: its size attribute, whether the store may
//             add custom sizes there (has_permission), SHEIN's own size list and every custom size
//             already in the store. Saved to shein_listing_cache (kind 'probe').
//   snapshot  Phase 1. Every Shopify product + every SHEIN product (spu-info + searchProduct +
//             query-document-state, 10 at a time) → match → readiness → shein_listing_products /
//             _variants. Nightly at 03:00 EST (prod, behind SHEIN_SYNC_WATCH) and on demand.
//
// Both are SERVER JOBS: a shein_listing_jobs row claimed with a 3-minute lease + heartbeat, so a
// closed tab never stops one and a restart leaves it `interrupted`; Resume carries on from the
// first unfinished SHEIN product (shein_listing_job_items). One job at a time (a partial unique
// index), and never alongside the live stock walk. Every SHEIN call is logged (shein_api_log).
//
// Shopify products/create|update|delete webhooks (api/shopify/webhook.js) land in
// listingProductChanged / listingProductDeleted: coalesced 1.5 s, hashed WITHOUT stock, and only
// a real listing change is re-read from Shopify and recomputed — from the STORED SHEIN rows, with
// no SHEIN call.
import crypto from 'node:crypto';
import {
  sheinStatus, sheinAllSpusLogged, sheinSearchProducts, sheinSpuInfoLogged, sheinDocStates, sheinCustomPermissions, sheinAttributeTemplates,
  sheinSkusTakenLogged, sheinFillStandardLogged, sheinWarehousesLogged, sheinPartialEditLogged, sheinPriceSaveLogged,
  sheinPublishPermissionLogged, sheinPublishQuotaLogged, sheinShelfQuotaLogged, sheinSiteListLogged, sheinBrandListLogged, sheinCategoryTreeLogged,
  sheinAssocRulesLogged, sheinCategorySuggestLogged, sheinComplianceLogged, sheinTransformPicLogged, sheinPublishLogged,
} from './shein.js';
import { buildPublish, publishGates, readPublishAnswer, publishApproved, readBoxDefaults, fetchImage, hostOnR2 } from './shein-publish.js';
import { publishReadiness } from '../../src/lib/sheinPublish.js';
import { shopifyListingCatalogue, shopifyListingProduct, shopifyConfigured, styleFromTitle } from './shopify.js';
import {
  createListingJob, getListingJob, activeListingJob, claimListingJob, touchListingJob, finishListingJob, markStaleListingJobs, resumeListingJob,
  latestListingJob, latestListingJobBy, addListingJobItems, pendingListingItems, markListingItems, listingItemCounts, listingItemSpus,
  getListingCache, listListingCache, setListingCache, pruneListingCache, loadListingPrev, saveListingProducts, deleteListingProductsExcept,
  markListingProductDeleted, markListingSnapshotAt, listSizeMaps, listSheinLinks, sheinLastWalkStock, latestSheinLiveRun, markStaleSheinRuns, pruneSheinApiLog,
  countSheinApiLog, getSetting, setSetting,
  getListingProduct, listListingProducts, updateListingItem, markListingItemSending, dueRunItems, runJobsWithDueItems, requeueListingJob,
  setListingJobStatus, listingInflight, markVariantsPublished, setVariantsLastError, verifySizeMap, verifySizeMapById, getPlatformQuotes, listListingJobItems,
  createRunJob, getListingItems, sheinShelfRecords, markVariantsSynced, listingPriceOffProducts, listCategoryMaps, listBrandMaps, setListingPublished, listAttrDefaults,
  listPublishUnconfirmed, resumeListingJob as resumeJobRow,
} from './db.js';
import { walkActive, pushSpus } from './shein-live.js';
import {
  spuPayload, templateSizes, computeListings, normalizeWebhookProduct, listingHash, STATUS_ORDER, planAddSizes, summarizePlan, reviewVerdict, stableJson, blocker,
  planPrice, planEdit, sheinNewSizePrice,
  sizeKey,
} from '../../src/lib/sheinListings.js';
import { parseSize } from '../../src/lib/sheinCheck.js';
import { estDate, PH_DATETIME } from '../../src/lib/format.js';

export const PROC_ID = `${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
export const NIGHTLY = 'auto (nightly 03:00 EST)';
const DAY_MS = 24 * 3600_000;
const BATCH = 10;   // searchProduct / query-document-state take 10 SPUs a call

// Everything a job touches outside itself — swappable in tests (e2e/shein-listings.spec.js).
export const IO = {
  sheinStatus, sheinAllSpus: sheinAllSpusLogged, sheinSearchProducts, sheinSpuInfo: sheinSpuInfoLogged, sheinDocStates,
  sheinCustomPermissions, sheinAttributeTemplates,
  shopifyListingCatalogue, shopifyListingProduct, shopifyConfigured,
  // A walk in this process, or a fresh 'running' row (a dead walk's row is called interrupted first).
  walkBusy: async () => !!walkActive() || (await markStaleSheinRuns().then(latestSheinLiveRun).catch(() => null))?.status === 'running',
  lastWalkStock: sheinLastWalkStock, links: listSheinLinks,
  wait: (ms) => new Promise((ok) => setTimeout(ok, ms)), walkWaitMs: 30_000, coalesceMs: 1500,
  // Phase 2 (add sizes): the dry run's reads, the ONE write, market prices, the stock step.
  sheinSkusTaken: sheinSkusTakenLogged, sheinFillStandard: sheinFillStandardLogged, sheinWarehouses: sheinWarehousesLogged,
  sheinPartialEdit: sheinPartialEditLogged,
  sheinPriceSave: sheinPriceSaveLogged,   // Phase 3's price write (product/price/save)
  // Phase 4 (publish): store gates, category tree + suggestion, rules, brands, compliance (reads);
  // transform-pic (ASSET); publishOrEdit (the write); our photos: fetch → pad → host on R2.
  sheinPublishPermission: sheinPublishPermissionLogged, sheinPublishQuota: sheinPublishQuotaLogged, sheinShelfQuota: sheinShelfQuotaLogged,
  sheinSiteList: sheinSiteListLogged, sheinBrandList: sheinBrandListLogged, sheinCategoryTree: sheinCategoryTreeLogged, sheinAssocRules: sheinAssocRulesLogged,
  sheinCategorySuggest: sheinCategorySuggestLogged, sheinCompliance: sheinComplianceLogged, sheinTransformPic: sheinTransformPicLogged, sheinPublish: sheinPublishLogged,
  fetchImage, hostImage: hostOnR2,
  // SKCs whose shelf state the live fix changed < 20 min ago (SHEIN refuses a 2nd change in 20 min).
  recentShelf: async (skcs) => new Set([...(await sheinShelfRecords(skcs).catch(() => new Map())).values()]
    .filter((r) => r.shelf_at && Date.now() - new Date(r.shelf_at).getTime() < 20 * 60_000).map((r) => String(r.skc))),
  // D4's market price: the Alias price we already hold (platform_quotes, ≤ 12 h) — never an outbound
  // call. ONE lookup (Map variantId → cents) for the readiness AND every dry run (review S9).
  marketTargets: marketTargetsFromQuotes,
  stockStep: (spu) => pushSpus([spu]),
};

// The connection itself is refused (not this request): the job STOPS, nothing is marked refused —
// not connected, signature / auth, 401 / 403, and SHEIN's IP whitelist (only Railway's IP is let in).
const fatal = (e) => {
  if (e?.notConnected || [401, 403].includes(Number(e?.httpStatus))) return true;
  const t = `${e?.message || ''} ${e?.sheinMsg || ''}`;
  // "IP" alone is NOT enough: SHEIN validation messages name the product IP field (ip_character_list).
  // Not a bare "unauthorized": SHEIN's product re-check says "brand unauthorized" (品牌未授权) — that is an Error (S8).
  return /not connected|signature|HTTP 401|unauthori[sz]ed (request|access|app|call)|white ?list|白名单|签名|鉴权|openKeyId|invalid app ?id/i.test(t) || /\bIP\b.{0,40}(not allowed|forbidden|denied|白名单)/i.test(t);
};
export const isFatal = fatal;
class LeaseLost extends Error {}

/* --------------------------------- starting --------------------------------- */

// POST /api/shein/listings {action:'snapshot'|'probe'} — and the nightly. Refused (409) while a
// job is queued/running or the live walk runs; 503 when SHEIN / Shopify isn't there.
export async function startListingJob({ kind, by, scope = {}, io = IO }) {
  if (!['snapshot', 'probe', 'preview'].includes(kind)) throw Object.assign(new Error('Unknown job.'), { status: 400 });
  await markStaleListingJobs();
  const cur = await activeListingJob();
  if (cur) throw Object.assign(new Error(`A SHEIN listing job is already ${cur.status} (#${cur.id}).`), { status: 409, job: cur });
  if (await io.walkBusy()) throw Object.assign(new Error('The live stock walk is running — try again when it finishes (we never read SHEIN alongside it).'), { status: 409 });
  if (['snapshot', 'preview'].includes(kind) && !io.shopifyConfigured()) throw Object.assign(new Error('Shopify is not configured on the server.'), { status: 503 });
  if (kind === 'preview') {
    if (!(await latestListingJob('snapshot', 'done'))) throw Object.assign(new Error('Re-read Shopify + SHEIN first — a dry run starts from the last read.'), { status: 409 });
    if (!Array.isArray(scope.productIds) || !scope.productIds.length) throw Object.assign(new Error('Pick the products to dry-run.'), { status: 400 });
    const ops = scope.ops || ['add_sku'];
    if (!ops.length || ops.some((o) => !PREVIEW_OPS.includes(o)) || (ops.includes('add_sku') && ops.length > 1) || (ops.includes('publish') && ops.length > 1)) {
      throw Object.assign(new Error('A dry run is either “add sizes”, “update” (price and/or edit), or “publish” — never mixed.'), { status: 400 });
    }
  }
  const st = await io.sheinStatus().catch(() => null);
  if (!st?.connected) throw Object.assign(new Error('SHEIN is not connected.'), { status: 503 });
  const job = await createListingJob({ kind, mode: 'dry', scope, by });
  await kickListingJobs({ io });   // claimed now; it runs on in the background
  return job;
}
export async function resumeJob(id, { by, io = IO } = {}) {
  await markStaleListingJobs();
  const cur = await activeListingJob();
  if (cur) throw Object.assign(new Error(`A SHEIN listing job is already ${cur.status} (#${cur.id}).`), { status: 409, job: cur });
  if (await io.walkBusy()) throw Object.assign(new Error('The live stock walk is running — resume when it finishes.'), { status: 409 });
  const job = await resumeListingJob(id, by);
  if (!job) throw Object.assign(new Error('Only an interrupted, stopped or failed job can be resumed.'), { status: 400 });
  await kickListingJobs({ io });
  return job;
}

// Security M3: a per-USER throttle for the PH-reachable SHEIN reads (suggest=, look_again) — on top of the
// per-(ip, route) rateLimit, and NOT switched off by E2E_NO_RATE_LIMIT. In-process (one web process).
const throttles = new Map();
export function userThrottle(user, name, { windowMs = 60_000, max = 10, now = Date.now() } = {}) {
  const key = `${name}|${user?.id ?? user?.username ?? user?.name ?? '?'}`;
  const hits = (throttles.get(key) || []).filter((t) => now - t < windowMs);
  if (hits.length >= max) { throttles.set(key, hits); return { ok: false, retryInSec: Math.max(1, Math.ceil((windowMs - (now - hits[0])) / 1000)) }; }
  hits.push(now); throttles.set(key, hits);
  if (throttles.size > 5000) throttles.clear();
  return { ok: true };
}

/* --------------------------------- the runner --------------------------------- */

let running = null;   // { jobId, promise } — one job per process
export const listingJobRunning = () => running?.jobId || null;
export const listingJobPromise = () => running?.promise || null;

// Claim the queued job (if any) and run it in this process.
export async function kickListingJobs({ io = IO } = {}) {
  if (running) return running.jobId;
  try {
    await markStaleListingJobs();
    const job = await claimListingJob(PROC_ID);
    if (!job) return null;
    const promise = runJob(job, io).finally(() => { running = null; setImmediate(() => { kickListingJobs({ io }); }); });   // a job queued meanwhile goes next
    running = { jobId: job.id, promise };
    return job.id;
  } catch (e) { console.error('[shein-listing] kick', e.message); return null; }
}

async function runJob(job, io) {
  try {
    if (job.kind === 'snapshot') await runSnapshot(job, io);
    else if (job.kind === 'probe') await runProbe(job, io);
    else if (job.kind === 'preview') await runPreview(job, io);
    else if (job.kind === 'run') await runRun(job, io);
    else await finishListingJob(job.id, PROC_ID, { status: 'failed', error: `No runner for ${job.kind} jobs in this phase.` });
  } catch (e) {
    if (e instanceof LeaseLost) { console.error('[shein-listing] lease lost on job', job.id); return; }
    console.error('[shein-listing] job failed', job.id, e.message);
    const why = fatal(e)
      ? `Stopped: SHEIN refused the connection (${e.sheinMsg || e.message}). SHEIN only answers our server (Railway, its whitelisted IP) with a working connection. Nothing was marked refused — Resume once that’s fixed (anything mid-send is looked up first).`
      : String(e.message);
    await finishListingJob(job.id, PROC_ID, { status: 'failed', phase: fatal(e) ? 'Stopped — SHEIN refused the connection' : 'Failed', error: why.slice(0, 500) }).catch(() => {});
  }
}

const toucher = (job) => async (patch = {}) => {
  const r = await touchListingJob(job.id, PROC_ID, patch);
  if (!r) throw new LeaseLost();
  return r;
};
const logFor = (job, source) => (extra = {}) => ({ source, jobId: job.id, by: job.started_by || null, dry: true, ...extra });

/* --------------------------------- snapshot --------------------------------- */

async function runSnapshot(job, io) {
  const touch = toucher(job);
  const log = logFor(job, 'snapshot');
  const st = await io.sheinStatus().catch(() => null);
  if (!st?.connected) throw new Error('SHEIN is not connected.');

  await touch({ phase: 'Reading Shopify (every product)' });
  const cat = await io.shopifyListingCatalogue();
  if (cat.error) throw new Error(cat.error);

  // The SHEIN product list, once per job — a resumed job keeps its own list and order.
  if (!Object.keys(await listingItemCounts(job.id)).length) {
    await touch({ phase: 'Listing SHEIN products' });
    const spus = await io.sheinAllSpus(log());
    await addListingJobItems(job.id, spus.map((spu, i) => ({ seq: i + 1, spu, op: 'read', product: null })));
    await touch({ total: spus.length, done: 0 });
  }
  const stock = await io.lastWalkStock();

  // Each SHEIN product, 10 at a time; an item is `done` only once its answer is saved, so a
  // restart re-reads at most one batch (reads are harmless to repeat).
  for (;;) {
    const row = await touch({ phase: 'Reading SHEIN products (read-only)' });
    if (row.stop_requested) {
      await finishListingJob(job.id, PROC_ID, { status: 'stopped', phase: 'Stopped — Resume carries on from the first unfinished product' });
      return;
    }
    if (await io.walkBusy()) { await touch({ phase: 'Waiting: the live stock walk is running (never read alongside it)' }); await io.wait(io.walkWaitMs); continue; }
    const batch = await pendingListingItems(job.id, BATCH);
    if (!batch.length) break;
    const names = batch.map((b) => b.spu);
    const search = new Map(); let docs = new Map();
    try { for (const d of (await io.sheinSearchProducts({ spuNameList: names }, log())).data) search.set(String(d.spuName), d); } catch (e) { if (fatal(e)) throw e; }
    try { docs = await io.sheinDocStates(names, log()); } catch (e) { if (fatal(e)) throw e; }
    for (const it of batch) {
      try {
        const info = await io.sheinSpuInfo(it.spu, log({ spu: it.spu, itemId: it.id }));
        await touch({ current: it.spu });   // still ours? A process that lost its lease writes nothing more
        const p = spuPayload(info, { search: search.get(it.spu), docState: docs.get(it.spu), stock });
        if (p) { await setListingCache('spu', it.spu, p, `job ${job.id}`); await markListingItems([it.id], 'done'); }
        else await markListingItems([it.id], 'skipped', { error: 'SHEIN returned no product for this SPU' });
      } catch (e) {
        if (fatal(e) || e instanceof LeaseLost) throw e;
        await markListingItems([it.id], 'failed', { error: String(e.message).slice(0, 500) });
      }
    }
    const c = await listingItemCounts(job.id);
    await touch({ done: (c.done || 0) + (c.skipped || 0) + (c.failed || 0), current: names[names.length - 1] });
  }

  // SHEIN's size lists + custom-size permissions for the categories we're in (24 h cache).
  await touch({ phase: 'Reading SHEIN size lists + custom-size permissions', current: '' });
  const keep = [...await listingItemSpus(job.id, 'done'), ...await listingItemSpus(job.id, 'failed')];   // a failed read keeps its last answer
  const payloads = (await listListingCache('spu', keep)).map((r) => r.payload).filter(Boolean);
  const sizes = await readSizeLists(payloads, { io, log: log(), fetch: true });

  await touch({ phase: 'Matching Shopify ↔ SHEIN' });
  const rows = await computeAndSave({ products: cat.products, payloads, sizes, io, snapshot: true, prune: !cat.truncated });
  await setListingCache('spu_list', 'current', keep, `job ${job.id}`);
  await pruneListingCache('spu', keep);
  const counts = await listingItemCounts(job.id);
  const byStatus = {};
  for (const p of rows) byStatus[p.status] = (byStatus[p.status] || 0) + 1;
  const calls = await countSheinApiLog(job.id);
  await finishListingJob(job.id, PROC_ID, { status: 'done', phase: 'Finished', counts: {
    shopify_products: cat.products.length, shein_products: keep.length, read: counts.done || 0, read_failed: counts.failed || 0, skipped: counts.skipped || 0,
    products: rows.length, by_status: byStatus, shein_calls: calls.n, shein_writes: calls.writes, truncated: !!cat.truncated,
  } });
}

// payloads → { templates: Map(productTypeId → sizes), permissions: Map(`${categoryId}|${attributeId}` → 0|1), customValues }.
// fetch=false (a webhook's recompute) reads the cache only — no SHEIN call.
export async function readSizeLists(payloads, { io = IO, log = null, fetch = false, maxAgeMs = DAY_MS } = {}) {
  const types = [...new Set(payloads.map((p) => p.productTypeId).filter((x) => x != null).map(Number))];
  const cats = [...new Set(payloads.map((p) => p.categoryId).filter((x) => x != null).map(Number))];
  const fresh = (r) => r && Date.now() - new Date(r.fetched_at).getTime() < maxAgeMs;
  const tplRows = new Map((await listListingCache('attr_template', types)).map((r) => [Number(r.key), r]));
  const permRows = new Map((await listListingCache('custom_perm', cats)).map((r) => [Number(r.key), r]));
  if (fetch) {
    const needT = types.filter((t) => !fresh(tplRows.get(t)));
    if (needT.length) {
      try {
        const data = await io.sheinAttributeTemplates(needT, log);
        for (const t of needT) {
          const d = data.find((x) => Number(x.product_type_id) === t) || null;
          await setListingCache('attr_template', t, d, 'snapshot');
          tplRows.set(t, { payload: d, fetched_at: new Date().toISOString() });
        }
      } catch (e) { if (fatal(e)) throw e; console.error('[shein-listing] attribute template', e.message); }
    }
    const needC = cats.filter((c) => !fresh(permRows.get(c)));
    if (needC.length) {
      try {
        const data = await io.sheinCustomPermissions(needC, log);
        for (const c of needC) {
          const list = data.filter((x) => Number(x.last_category_id) === c).map((x) => ({ attribute_id: Number(x.attribute_id), has_permission: Number(x.has_permission) }));
          await setListingCache('custom_perm', c, list, 'snapshot');
          permRows.set(c, { payload: list, fetched_at: new Date().toISOString() });
        }
      } catch (e) { if (fatal(e)) throw e; console.error('[shein-listing] custom permission', e.message); }
    }
  }
  const sizeAttrOf = new Map();
  for (const p of payloads) if (p.productTypeId != null && p.sizeAttrId != null && !sizeAttrOf.has(Number(p.productTypeId))) sizeAttrOf.set(Number(p.productTypeId), p.sizeAttrId);
  const templates = new Map(); const customValues = new Set();
  for (const [t, r] of tplRows) {
    if (!r?.payload) continue;
    const s = templateSizes([r.payload], t, sizeAttrOf.get(t) ?? null);
    if (s) { templates.set(t, s); for (const v of s.values) if (v.custom) customValues.add(v.label); }
  }
  const permissions = new Map();
  for (const [c, r] of permRows) for (const x of r?.payload || []) permissions.set(`${c}|${x.attribute_id}`, x.has_permission);
  return { templates, permissions, customValues: [...customValues] };
}

// The whole store → rows; only products whose computed_hash changed are written.
async function computeAndSave({ products, payloads, sizes, io, snapshot = false, prune = false }) {
  const [links, maps, prev, flight] = await Promise.all([io.links(), listSizeMaps(), loadListingPrev(), listingInflight()]);
  const inflight = new Map();
  for (const f of flight) for (const v of f.variant_ids || []) inflight.set(v, { jobId: Number(f.job_id), itemId: Number(f.id), sentAt: f.sent_at ? PH_DATETIME.format(new Date(f.sent_at)) : null });
  const market = await io.marketTargets(products).catch((e) => { console.error('[shein-listing] market', e.message); return new Map(); });
  const publish = await publishContext(maps, market).catch((e) => { console.error('[shein-listing] publish readiness', e.message); return null; });
  const rows = computeListings({ products, spus: payloads, links, maps, ...sizes, prev, inflight, market, publish });
  const changed = rows.filter((r) => prev.products.get(r.shopify_product_id)?.computed_hash !== r.computed_hash);
  await saveListingProducts(changed, { snapshotAt: snapshot });
  if (prune) await deleteListingProductsExcept(rows.map((r) => r.shopify_product_id));
  if (snapshot) await markListingSnapshotAt();
  return rows;
}

// Phase 4's readiness for products not on SHEIN — from what is CACHED (no SHEIN call): category maps,
// SHEIN's rules / templates / permissions for the mapped categories, brand maps + list, attr defaults, D6.
async function publishContext(maps, market) {
  const [categoryMaps, brandMaps, attrDefaults, box, brandsRow, unconf] = await Promise.all([listCategoryMaps(), listBrandMaps(), listAttrDefaults(), readBoxDefaults(), getListingCache('brands', 'store'), listPublishUnconfirmed()]);
  // re-review G1: a product with a publish SHEIN never confirmed shows publish_unconfirmed (no new publish)
  const unconfirmed = new Map(); for (const x of unconf) if (!unconfirmed.has(x.shopify_product_id)) unconfirmed.set(x.shopify_product_id, { itemId: Number(x.id), jobId: Number(x.job_id) });
  const cats = [...new Set(categoryMaps.map((m) => Number(m.category_id)))]; const types = [...new Set(categoryMaps.map((m) => Number(m.product_type_id)))];
  const [fillRows, tplRows, permRows] = await Promise.all([listListingCache('fill_standard', cats), listListingCache('attr_template', types), listListingCache('custom_perm', cats)]);
  const fills = new Map(fillRows.map((r) => [Number(r.key), r.payload]));
  const templates = new Map(tplRows.filter((r) => r.payload && r.payload.attribute_infos).map((r) => [Number(r.key), r.payload]));
  const permissions = new Map();
  for (const r of permRows) for (const x of r.payload || []) permissions.set(`${r.key}|${x.attribute_id}`, x.has_permission);
  const ctx = { categoryMaps, brandMaps, attrDefaults, box, brands: brandsRow?.payload || null, fills, templates, permissions, maps, unconfirmed };
  return (p, pv, excludedVariants) => publishReadiness(p, { ...ctx, productRow: pv, excludedVariants, market });
}

// The drawer's checklist for a product not on SHEIN, from what is cached (no SHEIN call): lines SHEIN's
// rules haven't been read for are null ("not read yet"), never ✓.
export async function readinessChecklist(row, variants = [], io = IO) {
  const p = row?.shopify_json; if (!p) return null;
  const market = await io.marketTargets([p]).catch(() => new Map());
  const fn = await publishContext(await listSizeMaps(), market);
  return fn(p, row, new Set(variants.filter((v) => v.excluded).map((v) => v.shopify_variant_id))).checklist;
}

// Recompute from what's stored (a size mapping saved, an exclude, a Shopify webhook): Shopify as
// last read (shopify_json) with `replace` swapped in, SHEIN as the last snapshot read it. No SHEIN call.
export async function recomputeStored({ replace = [], io = IO } = {}) {
  const prev = await loadListingPrev();
  const byId = new Map([...prev.products.values()].filter((r) => r.shopify_json).map((r) => [r.shopify_product_id, r.shopify_json]));
  for (const p of replace) byId.set(p.productId, p);
  const keep = (await getListingCache('spu_list', 'current'))?.payload || [];
  const payloads = (await listListingCache('spu', keep)).map((r) => r.payload).filter(Boolean);
  const sizes = await readSizeLists(payloads, { io, fetch: false });
  const rows = await computeAndSave({ products: [...byId.values()], payloads, sizes, io });
  return { products: rows.length };
}

/* ---------------------------------- probe ---------------------------------- */

// Phase 0: answer §2's unproven points from our own store, read-only. searchProduct (10 SPUs a
// page) is the one call that gives every SPU's categoryId in bulk; then spu-info on ONE product
// per category (+ the one a person named), the custom-size permission per category, and SHEIN's
// size list per product type. ~60 calls for ~420 SPUs.
async function runProbe(job, io) {
  const touch = toucher(job);
  const log = logFor(job, 'probe');
  const scope = job.scope || {};
  const errors = [];
  await touch({ phase: 'Listing SHEIN products by category (searchProduct)' });
  const cats = new Map();
  let spuTotal = 0;
  for (let page = 1; page <= (Number(scope.maxPages) || 100); page++) {
    const row = await touch({ done: page - 1, current: `page ${page}` });
    if (row.stop_requested) { await finishListingJob(job.id, PROC_ID, { status: 'stopped', phase: 'Stopped' }); return; }
    const r = await io.sheinSearchProducts({}, log(), { pageNum: page });
    if (page === 1 && r.count) await touch({ total: Math.ceil(r.count / 10) });
    for (const d of r.data) {
      spuTotal += 1;
      const c = String(d.categoryId ?? '');
      if (!c) continue;
      const e = cats.get(c) || { categoryId: Number(c), spuCount: 0, samples: [] };
      e.spuCount += 1; if (e.samples.length < 3) e.samples.push(String(d.spuName)); cats.set(c, e);
    }
    if (r.data.length < 10) break;
  }

  await touch({ phase: 'Reading one product per category (spu-info)' });
  const readSpu = async (spu) => {
    try { return spuPayload(await io.sheinSpuInfo(spu, log({ spu })), {}); } catch (e) { if (fatal(e)) throw e; errors.push({ spu, error: String(e.message).slice(0, 300) }); return null; }
  };
  for (const e of cats.values()) {
    for (const spu of e.samples) { e.sample = await readSpu(spu); if (e.sample) break; }
  }
  const named = scope.spu ? await readSpu(String(scope.spu)) : null;

  await touch({ phase: 'Custom-size permission per category' });
  const catIds = [...cats.values()].map((e) => e.categoryId);
  if (named?.categoryId && !catIds.includes(named.categoryId)) catIds.push(named.categoryId);
  let perms = [];
  try { perms = catIds.length ? await io.sheinCustomPermissions(catIds, log()) : []; } catch (e) { if (fatal(e)) throw e; errors.push({ call: 'get-custom-attribute-permission-config', error: e.message }); }
  for (const c of catIds) await setListingCache('custom_perm', c, perms.filter((x) => Number(x.last_category_id) === c).map((x) => ({ attribute_id: Number(x.attribute_id), has_permission: Number(x.has_permission) })), `probe ${job.id}`);

  await touch({ phase: 'SHEIN size lists (query-attribute-template)' });
  const samples = [...[...cats.values()].map((e) => e.sample), named].filter(Boolean);
  const types = [...new Set(samples.map((s) => s.productTypeId).filter((x) => x != null))];
  let tpl = [];
  try { tpl = types.length ? await io.sheinAttributeTemplates(types, log()) : []; } catch (e) { if (fatal(e)) throw e; errors.push({ call: 'query-attribute-template', error: e.message }); }
  for (const t of types) await setListingCache('attr_template', t, tpl.find((x) => Number(x.product_type_id) === Number(t)) || null, `probe ${job.id}`);

  const describe = (e) => {
    const s = e.sample;
    const sizes = s ? templateSizes(tpl, s.productTypeId, s.sizeAttrId) : null;
    const attr = s?.sizeAttrId ?? sizes?.attributeId ?? null;
    const perm = perms.find((x) => Number(x.last_category_id) === Number(e.categoryId) && Number(x.attribute_id) === Number(attr));
    return {
      categoryId: e.categoryId, spuCount: e.spuCount, sampleSpu: s?.spu || e.samples[0] || null, sampleName: s?.name || null,
      productTypeId: s?.productTypeId ?? null, sizeAttributeId: attr, sizeAttributeName: sizes?.name || null,
      hasPermission: perm ? Number(perm.has_permission) : null, hasSizeTable: s ? !!s.hasSizeTable : null, sizeFieldStatus: sizes?.status ?? null,
      sheinSizes: (sizes?.values || []).filter((v) => !v.custom).map((v) => ({ id: v.id, label: v.label })),
      customValues: (sizes?.values || []).filter((v) => v.custom).map((v) => v.label),
      sampleSizes: (s?.rows || []).map((r) => r.size).filter(Boolean),
      allPermissions: perms.filter((x) => Number(x.last_category_id) === Number(e.categoryId)).map((x) => ({ attributeId: Number(x.attribute_id), hasPermission: Number(x.has_permission) })),
    };
  };
  const categories = [...cats.values()].map(describe).sort((a, b) => b.spuCount - a.spuCount);
  const customValues = [...new Set(categories.flatMap((c) => c.customValues))];
  let spuChecked = null;
  if (named) {
    const nsz = templateSizes(tpl, named.productTypeId, named.sizeAttrId);
    const byId = new Map((nsz?.values || []).map((v) => [v.id, v]));
    spuChecked = { spu: named.spu, name: named.name, categoryId: named.categoryId, productTypeId: named.productTypeId, hasSizeTable: named.hasSizeTable,
      sizes: named.rows.map((r) => ({ size: r.size, valueId: r.sizeValueId, custom: byId.get(r.sizeValueId)?.custom ?? null, sellerSku: r.sellerSku })) };
    for (const z of spuChecked.sizes) if (z.custom && !customValues.includes(z.size)) customValues.push(z.size);
  } else if (scope.spu) errors.push({ spu: scope.spu, error: 'SHEIN returned nothing for that SPU (only approved products can be read).' });
  const calls = await countSheinApiLog(job.id);
  const probe = { askedAt: new Date().toISOString(), by: job.started_by || null, jobId: job.id, store: { spus: spuTotal, categories: categories.length },
    categories, customValues, spuChecked, errors, calls: calls.n, writes: calls.writes };
  await setListingCache('probe', 'last', probe, job.started_by || null);
  await finishListingJob(job.id, PROC_ID, { status: 'done', phase: 'Finished', counts: { categories: categories.length, spus: spuTotal, shein_calls: calls.n, shein_writes: calls.writes, errors: errors.length } });
}

/* ------------------------- Phase 2: add sizes (preview / run) ------------------------- */
// docs/shein-listings-plan.md §3 Phase 2, Appendix A.2 + B.4; docs/context/shein-listings.md → Phase 2.
//   preview  (a dry run, PH ok) per product: live Shopify read, fresh spu-info, SHEIN's size list
//            + custom permission, query-publish-fill-in-standard (may sizes be sorted?),
//            query-document-state, check-supplierSku-repeated → planAddSizes() → the EXACT
//            partialEdit body + its hash. Reads only → awaiting_confirm.
//   run      (admin / Connect integrations) the dry run's items, each REBUILT the same way: a body
//            whose hash differs is skipped ('changed') unless acceptChanges; SHEIN reviewing the
//            product → 'deferred' (+30 min); else 'sending' + the idempotency key (UNIQUE) → ONE
//            partialEdit (logged whole, with SHEIN's answer + traceId) → 'in_review' with SHEIN's
//            version + new SKU codes. A refusal → 'failed' with SHEIN's words, never retried; no
//            answer / 5xx / rate limit → retried 1 / 5 / 30 min, at most 5 times. An item found
//            'sending' (a crash) or retried after no answer is LOOKED UP first
//            (check-supplierSku-repeated + spu-info): it is never sent twice.
//   follow-up (the tick, every 5 min per item) query-document-state + SHEIN's audit webhooks:
//            approved → done, sizes 'published', size map verified (a custom value's id read back),
//            one stock-only step; rejected → failed (review_rejected, SHEIN's failedReason).

const PREVIEW_MAX = 300;
export const PREVIEW_OPS = ['add_sku', 'price', 'edit', 'publish'];   // Phase 2: add_sku · Phase 3: price, edit · Phase 4: publish (alone)
const DEFER_SEC = 30 * 60;                 // SHEIN is reviewing an earlier edit → try again in 30 min
// No answer: first look after 5 min (SHEIN receives a partialEdit asynchronously, so the seller-SKU
// check may lag — review S2), then 15 and 30 min.
const RETRY_SEC = [5 * 60, 15 * 60, 30 * 60];
const MAX_RETRIES = 5;
const POLL_SEC = 5 * 60;
const APPROVED_WAIT_H = 24;   // approved but the sizes don't show → Error after this
export const PHASE2 = { DEFER_SEC, RETRY_SEC, MAX_RETRIES, POLL_SEC, APPROVED_WAIT_H };

export const bodyHash = (body) => crypto.createHash('sha256').update(stableJson(body)).digest('hex');
// The idempotency key = product + op + the body AND what SHEIN showed before the send (review P1): a
// retry of the same intent (same state) can never send twice, yet the same body later — after SHEIN's
// state moved (the price went up and is coming down again, a size stopped a second time) — is a new send.
export const idemKey = (productId, op, hash, state = null) => `${productId}|${op}|${hash}${state == null ? '' : `|${bodyHash(state).slice(0, 16)}`}`;
export function sendState(op, plan) {
  if (op === 'price') return (plan?.prices || []).map((x) => [x.skuCode, x.site, x.base ?? x.from, x.endsSpecial ?? null]);
  if (op === 'edit') return { v: plan?.preVersion || null, on: (plan?.mallOn || []).map((x) => [x.skuCode, 2]), sku: (plan?.relinks || []).map((x) => [x.skuCode, x.from]) };
  if (op === 'publish') return (plan?.sizes || []).map((z) => z.sku).sort();   // spec 4.2: productId|publish|bodyHash|sha(skus)
  return null;   // add_sku: a new seller SKU is never added twice anyway
}
const est = (d) => `${PH_DATETIME.format(d instanceof Date ? d : new Date(d))} EST`;
// No answer worth retrying: the network, SHEIN's 5xx, a rate limit. Anything else SHEIN said is a refusal.
export const isTransport = (e) => (e?.notConnected || fatal(e)) ? false
  : !!e?.unknownAnswer || (!e?.httpStatus && !e?.sheinCode) || Number(e.httpStatus) >= 500 || Number(e.httpStatus) === 429
    || /rate.?limit|too many|frequen|频繁|限流|timed? ?out|busy|繁忙|稍后|try again/i.test(`${e?.sheinMsg || ''} ${e?.message || ''}`);

// Every product's market price per variant, in two queries (consigned first, then with-you).
export async function marketTargetsFromQuotes(products) {
  const out = new Map();
  const styles = [...new Set((products || []).map((p) => p.style).filter(Boolean))];
  if (!styles.length) return out;
  const [con, you] = await Promise.all([getPlatformQuotes(styles, true, 12).catch(() => []), getPlatformQuotes(styles, false, 12).catch(() => [])]);
  const index = (rows) => { const m = new Map(); for (const q of rows) if (Number(q.alias_ask) > 0) { const a = m.get(q.sku) || []; a.push(q); m.set(q.sku, a); } return m; };
  const ci = index(con); const yi = index(you);
  for (const p of products || []) {
    const st = String(p.style || '').toUpperCase(); if (!st) continue;
    for (const v of p.variants || []) {
      const k = sizeKey(v.size); const n = parseSize(v.size).n;
      const hit = (rows) => (rows || []).find((q) => q.size === v.size || (k && sizeKey(q.size) === k) || (n != null && String(q.size) === String(n)));
      const q = hit(ci.get(st)) || hit(yi.get(st));
      if (q) out.set(v.variantId, Math.round(Number(q.alias_ask) * 100));
    }
  }
  return out;
}

// POST {action:'run'}: the dry run's sendable items, copied into a run job in one statement.
export async function startRunJob({ previewJobId, acceptChanges = false, by, io = IO }) {
  await markStaleListingJobs();
  const prev = await getListingJob(previewJobId);
  if (!prev || prev.kind !== 'preview') throw Object.assign(new Error('That isn’t a dry run.'), { status: 400 });
  if (prev.status !== 'awaiting_confirm') {
    throw Object.assign(new Error(prev.status === 'done' && /sent as job/.test(prev.phase || '') ? `That dry run was already run (${prev.phase.replace(/^Confirmed — /, '')}).`
      : `That dry run isn’t ready to run (it is ${prev.status}).`), { status: 409, job: prev });
  }
  const cur = await activeListingJob();
  if (cur) throw Object.assign(new Error(`A SHEIN listing job is already ${cur.status} (#${cur.id}).`), { status: 409, job: cur });
  if (await io.walkBusy()) throw Object.assign(new Error('The live stock walk is running — run when it finishes.'), { status: 409 });
  const st = await io.sheinStatus().catch(() => null);
  if (!st?.connected) throw Object.assign(new Error('SHEIN is not connected.'), { status: 503 });
  // The run rebuilds every body exactly as the dry run did — so it carries the dry run's ops and options
  // (publish gates, Phase 3's endSpecials / D8a auto caps), else a rebuild would differ and read "changed".
  const p = prev.scope || {};
  const job = await createRunJob({ previewJobId, by, scope: { previewJobId, acceptChanges: !!acceptChanges, ops: p.ops || ['add_sku'], ...(p.endSpecials ? { endSpecials: true } : {}), ...(p.auto ? { auto: true } : {}) } });
  if (!job) throw Object.assign(new Error('That dry run was just run by someone else.'), { status: 409 });
  await kickListingJobs({ io });
  return job;
}

// Everything one product's plan needs that is the same for the whole job.
async function jobContext(job, io, log) {
  const wh = (await io.sheinWarehouses(log()).catch((e) => { if (fatal(e)) throw e; return []; })).filter((w) => String(w.warehouseType) === '1');
  const def = wh.find((w) => [].concat(w.countrySiteDefaultList || []).some((d) => Number(d.defaultFlag) === 1 && /us/i.test(d.countrySiteCode || ''))) || (wh.length === 1 ? wh[0] : null);
  const out = { warehouse: { count: wh.length, code: def?.warehouseCode || null, name: def?.warehouseName || null }, maps: await listSizeMaps(), scope: job.scope || {} };
  // Security H2: a run always converts photos (it is gated); a dry run only when the starter may write to SHEIN
  out.convertPhotos = job.kind === 'run' || job.scope?.convertPhotos === true;
  if ((job.scope?.ops || []).includes('publish')) {
    // Phase 4: the store gates once per job — read FRESH right before a run (spec 1A); quotas count SKCs = items.
    const c = await listingItemCounts(job.id);
    // S4: a dry run judges each product alone (1 SKC); the run needs every item it carries
    const need = job.kind === 'run' ? Math.max(1, Object.values(c).reduce((a, b) => a + b, 0)) : 1;
    out.gates = await publishGates({ io, log: log(), fresh: job.kind === 'run', need });
    out.categoryMaps = await listCategoryMaps(); out.brandMaps = await listBrandMaps(); out.sizeMaps = out.maps; out.box = await readBoxDefaults();
  }
  return out;
}
const fillCache = async (categoryId, io, log) => {
  if (!categoryId) return null;
  const c = await getListingCache('fill_standard', categoryId);
  if (c && Date.now() - new Date(c.fetched_at).getTime() < DAY_MS) return c.payload;
  const info = await io.sheinFillStandard(categoryId, log);
  await setListingCache('fill_standard', categoryId, info, 'phase 2');
  return info;
};

// Read everything fresh and build ONE product's plan + body (the dry run and the run share it).
async function buildItem(it, jctx, io, log) {
  if (it.op === 'publish') {   // Phase 4: a product NOT on SHEIN yet
    const r = await buildPublish(it, { jctx, io, log, fatal });
    return { ...r, hash: r.body ? bodyHash(r.body) : null, spuName: null };
  }
  const d = await getListingProduct(it.shopify_product_id);
  if (!d) return { body: null, plan: { blockers: [blocker('not_on_shein_product')], sizes: [], relinks: [], skipped: [], notes: [] } };
  const spuName = d.product.spu;
  if (!spuName || String(d.product.shopify_product_id).startsWith('shein:')) return { body: null, plan: { spu: spuName || null, blockers: [blocker('not_on_shein_product')], sizes: [], relinks: [], skipped: [], notes: [] } };
  const shop = await io.shopifyListingProduct(d.product.shopify_product_id);
  if (shop?.error) throw Object.assign(new Error(`Shopify didn’t answer: ${shop.error}`), { httpStatus: 503 });
  if (!shop?.product) return { body: null, plan: { spu: spuName, blockers: [blocker('shopify_inactive', { status: 'DELETED' })], sizes: [], relinks: [], skipped: [], notes: [] } };
  const product = { ...shop.product, style: shop.product.style || d.product.style || styleFromTitle(shop.product.title) };
  const lg = log({ spu: spuName, itemId: it.id });
  const spu = await io.sheinSpuInfo(spuName, lg);
  const payload = spuPayload(spu);
  if (!payload) return { body: null, plan: { spu: spuName, blockers: [blocker('not_on_shein_product')], sizes: [], relinks: [], skipped: [], notes: [] } };
  if (it.op === 'price' || it.op === 'edit') return buildResync(it, { d, product, spu, payload, spuName, lg, io, jctx });
  const sizes = await readSizeLists([payload], { io, log: lg, fetch: true });
  const tpl = payload.productTypeId != null ? sizes.templates.get(Number(payload.productTypeId)) || null : null;
  const attr = tpl?.attributeId ?? null;   // the template's size attribute (M2) — the permission is for THAT one
  const perm = sizes.permissions.get(`${payload.categoryId}|${attr}`);
  const fill = await fillCache(payload.categoryId, io, lg).catch((e) => { if (fatal(e)) throw e; return null; });
  const fillUnread = !fill;   // re-review N1: rules unread → we can't tell what an edit would clear → blocked
  const docs = await io.sheinDocStates([spuName], lg);
  const reviewOpen = (docs.get(spuName)?.skcList || []).some((x) => [1, 5].includes(Number(x.documentState)));
  const live = new Map((product.variants || []).map((v) => [v.variantId, v]));
  const cands = d.variants.filter((v) => v.shopify_variant_id && !v.excluded && ['none', 'link'].includes(v.match));
  const skus = [...new Set(cands.map((v) => String(live.get(v.shopify_variant_id)?.sku || v.seller_sku || '').trim()).filter(Boolean))];
  const taken = skus.length ? await io.sheinSkusTaken(skus, lg) : new Set();
  const market = await io.marketTargets([product]).catch(() => new Map());   // the same lookup as the readiness (S9)
  const { body, plan } = planAddSizes({ spu, product, stored: d.variants, maps: jctx.maps, sizes: tpl, permission: perm == null ? null : Number(perm), customValues: sizes.customValues,
    sortSupported: fill?.support_sale_attribute_sort === true, fill, fillUnread, taken, market, warehouse: jctx.warehouse });
  plan.reviewOpen = reviewOpen;
  plan.preVersion = docs.get(spuName)?.version || null;   // what SHEIN showed before we sent — a new version later = it arrived (S2)
  plan.title = d.product.title || null;
  return { body, plan, hash: body ? bodyHash(body) : null, variantIds: [...plan.sizes, ...plan.relinks].map((x) => x.variantId), spuName, product: d.product };
}

/* dry run */
async function runPreview(job, io) {
  const touch = toucher(job);
  const log = logFor(job, 'preview');
  if (!Object.keys(await listingItemCounts(job.id)).length) {
    await touch({ phase: 'Picking the products' });
    const ids = [...new Set((job.scope?.productIds || []).map(String))].slice(0, PREVIEW_MAX);
    // Phase 3: one item per product per op — price BEFORE edit (an edit opens a document review) — S11
    const ops = [...(job.scope?.ops || ['add_sku'])].sort((a, b) => PREVIEW_OPS.indexOf(a) - PREVIEW_OPS.indexOf(b));
    await addListingJobItems(job.id, ids.flatMap((product, i) => ops.map((op, j) => ({ seq: i * ops.length + j + 1, spu: null, op, product }))));
    await touch({ total: ids.length * ops.length, done: 0 });
  }
  const jctx = await jobContext(job, io, log);
  for (;;) {
    const row = await touch({ phase: 'Dry run: reading Shopify + SHEIN, building each request (nothing is sent)' });
    if (row.stop_requested) { await finishListingJob(job.id, PROC_ID, { status: 'stopped', phase: 'Stopped — Resume carries on from the first unfinished product' }); return; }
    if (await io.walkBusy()) { await touch({ phase: 'Waiting: the live stock walk is running' }); await io.wait(io.walkWaitMs); continue; }
    const [it] = await pendingListingItems(job.id, 1);
    if (!it) break;
    await touch({ current: it.shopify_product_id });
    try {
      const b = await buildItem(it, jctx, io, log);
      const summary = summarizePlan(b.plan);
      await updateListingItem(it.id, { status: b.body ? 'done' : 'skipped', spu: b.plan.spu || null, variantIds: b.variantIds || [], body: b.body, bodyHash: b.hash, plan: b.plan,
        blockers: [...(b.plan.blockers || []), ...(b.plan.notes || [])], error: b.body ? null : summary, attempt: true });
    } catch (e) {
      if (fatal(e) || e instanceof LeaseLost) throw e;
      await updateListingItem(it.id, { status: 'skipped', error: String(e.message).slice(0, 500), blockers: [blocker('api_error', { message: e.sheinMsg || e.message, traceId: e.traceId || null })], attempt: true });
    }
    const c = await listingItemCounts(job.id);
    await touch({ done: (c.done || 0) + (c.skipped || 0) });
  }
  const items = await listListingJobItems(job.id, { limit: 1_000_000 });
  const ok = items.filter((i) => i.status === 'done');
  const counts = {
    products: items.length, sendable: ok.length, skipped: items.length - ok.length,
    sizes: ok.reduce((n, i) => n + (i.plan?.sizes?.length || 0), 0),
    custom_sizes: ok.reduce((n, i) => n + (i.plan?.sizes || []).filter((z) => z.kind === 'custom').length, 0),
    new_custom_values: [...new Set(ok.flatMap((i) => (i.plan?.sizes || []).filter((z) => z.isNew).map((z) => z.sheinSize)))].length,
    relinks: ok.reduce((n, i) => n + (i.plan?.relinks?.length || 0), 0),
    prices: ok.reduce((n, i) => n + (i.plan?.prices?.length || 0), 0),
    price_rises: ok.reduce((n, i) => n + (i.plan?.prices || []).filter((x) => x.rise).length, 0),
    sizes_on: ok.reduce((n, i) => n + (i.plan?.mallOn?.length || 0), 0),
    titles: ok.filter((i) => i.op === 'edit' && i.plan?.title).length,
    publishable: ok.filter((i) => i.op === 'publish').length,
    publish_sizes: ok.filter((i) => i.op === 'publish').reduce((n, i) => n + (i.plan?.sizes?.length || 0), 0),
    quota_uses: ok.filter((i) => i.op === 'publish').length,
    quota_available: ok.find((i) => i.op === 'publish' && i.plan?.quota)?.plan.quota.available ?? null,
    sizes_skipped: items.reduce((n, i) => n + (i.plan?.skipped?.length || 0), 0),
    review_open: ok.filter((i) => i.plan?.reviewOpen).length,
    ...await countSheinApiLog(job.id).then((c) => ({ shein_calls: c.n, shein_writes: c.writes })),
  };
  await finishListingJob(job.id, PROC_ID, ok.length
    ? { status: 'awaiting_confirm', phase: (job.scope?.ops || ['add_sku']).includes('add_sku')
      ? `Dry run ready — ${ok.length} product${ok.length === 1 ? '' : 's'}, ${counts.sizes} size${counts.sizes === 1 ? '' : 's'} to add. Nothing was sent.`
      : `Dry run ready — ${ok.length} change${ok.length === 1 ? '' : 's'}: ${counts.prices} price${counts.prices === 1 ? '' : 's'}, ${counts.sizes_on} size${counts.sizes_on === 1 ? '' : 's'} back on, ${counts.relinks} SKU fix${counts.relinks === 1 ? '' : 'es'}, ${counts.titles} title${counts.titles === 1 ? '' : 's'}. Nothing was sent.`, counts }
    : { status: 'done', phase: 'Dry run finished — nothing to send', counts });
}

/* the run */
async function runRun(job, io) {
  const touch = toucher(job);
  const total = Object.values(await listingItemCounts(job.id)).reduce((a, b) => a + b, 0);
  await touch({ total });
  const jctx = await jobContext(job, io, logFor(job, 'run'));
  for (;;) {
    const row = await touch({ phase: 'Sending to SHEIN — one product at a time' });
    if (row.stop_requested) { await finishListingJob(job.id, PROC_ID, { status: 'stopped', phase: 'Stopped — Resume carries on from the first unsent product', counts: await runCounts(job.id) }); return; }
    if (await io.walkBusy()) { await touch({ phase: 'Waiting: the live stock walk is running (never alongside it)' }); await io.wait(io.walkWaitMs); continue; }
    const [it] = await dueRunItems(job.id, 1);
    if (!it) break;
    await touch({ current: it.shopify_product_id });
    await runItem(it, job, jctx, io, touch);
    const c = await listingItemCounts(job.id);
    await touch({ done: total - (c.pending || 0) - (c.sending || 0) - (c.deferred || 0) });
  }
  const counts = await runCounts(job.id);
  const wait = await listListingJobItems(job.id, { limit: 1000, status: 'deferred' });
  const next = wait.map((i) => i.next_attempt_at).filter(Boolean).sort()[0];
  await finishListingJob(job.id, PROC_ID, { status: 'done', counts,
    phase: wait.length ? `Finished for now — ${wait.length} waiting, next try ${est(next)}` : counts.in_review ? `Sent — ${counts.in_review} waiting for SHEIN’s review` : 'Finished' });
}
async function runCounts(jobId) {
  const c = await listingItemCounts(jobId);
  return { ...c, ...await countSheinApiLog(jobId).then((x) => ({ shein_calls: x.n, shein_writes: x.writes })) };
}

// One run item. Never sends the same thing twice: a possibly-sent item is looked up first, and the
// send itself is claimed with the UNIQUE idempotency key.
async function runItem(it, job, jctx, io, touch) {
  let sendStarted = false;
  const log = (extra = {}) => ({ source: 'run', jobId: job.id, itemId: it.id, spu: it.spu, by: job.confirmed_by || job.started_by || null, dry: false, ...extra });
  try {
    if (it.status === 'sending' || (it.status === 'deferred' && it.idem_key)) {
      const found = await didItArrive(it, io, log);
      // F1: a publish caught mid-send is NEVER sent again by itself — not found → a person looks again
      if (it.op === 'publish' && it.status === 'sending' && !found.arrived) return await publishUnconfirmed(it, 'The server stopped while sending it.', io);
      if (it.op === 'price' && (found.arrived || found.risesPending)) {
        // A rise SHEIN may be reviewing is NEVER sent again (doc 3001940: only after its result) — it waits
        // In review for the webhook / the poll / the 7-day limit. Cuts not yet shown are left for a new dry run.
        const codes = found.codes;
        const pending = codes.filter((c) => c.status === 2);
        await updateListingItem(it.id, { status: pending.length ? 'in_review' : 'done', skuCodes: codes, sentNow: !it.sent_at,
          error: pending.length ? `Looked again: ${pending.length} price rise${pending.length === 1 ? '' : 's'} may be with SHEIN’s review — not sent again; we wait for SHEIN.`
            : 'Found on SHEIN when we looked again — not sent twice.', blockers: [] });
        if (!pending.length) await afterApplied({ ...it, variant_ids: codes.filter((c) => c.status === 1).map((c) => c.variantId) }, io);
        else await recomputeAfter(io);
        return;
      }
      if (found.arrived) {
        await updateListingItem(it.id, { status: 'in_review', version: found.version || it.version || null, skuCodes: found.skuCodes, documentState: found.state ?? 1, sentNow: !it.sent_at,
          error: 'Found on SHEIN when we looked again (after a restart / no answer) — not sent twice.', blockers: [] });
        await recomputeAfter(io);
        return;
      }
    }
    const b = await buildItem(it, jctx, io, log);
    if (!b.body) {
      await updateListingItem(it.id, { status: 'skipped', plan: b.plan, blockers: [...(b.plan.blockers || []), ...(b.plan.notes || [])], error: summarizePlan(b.plan) || 'Nothing to send any more.' });
      return;
    }
    const priceOnly = (x) => bodyHash(JSON.parse(JSON.stringify(x || {}), (k, v) => (k === 'price_info_list' ? undefined : v)));
    if (b.hash !== it.body_hash && !(job.scope?.acceptChanges && it.body && priceOnly(b.body) === priceOnly(it.body))) {
      await updateListingItem(it.id, { status: 'changed', plan: b.plan, blockers: [blocker('shopify_changed')], error: 'Shopify changed since the dry run — dry run again. Nothing was sent.' });
      return;
    }
    if (b.plan.reviewOpen) {
      await updateListingItem(it.id, { status: 'deferred', nextInSec: DEFER_SEC, plan: b.plan, blockers: [blocker('review_open', {})],
        error: `SHEIN is reviewing an earlier edit of this product — we try again at ${est(new Date(Date.now() + DEFER_SEC * 1000))}.` });
      return;
    }
    const key = idemKey(it.shopify_product_id, it.op, b.hash, sendState(it.op, b.plan));
    const claim = await markListingItemSending(it.id, key, { body: b.body, bodyHash: b.hash, plan: b.plan });
    if (claim.conflict) {
      const c = claim.conflict;
      await updateListingItem(it.id, { status: 'skipped', blockers: [blocker('already_sent', { jobId: c.job_id, itemId: c.id, refused: c.status === 'failed' })],
        error: c.status === 'failed' ? `SHEIN refused exactly this request in job #${c.job_id} — fix the listing, then dry run again. Not sent twice.`
          : `This exact request was already sent (job #${c.job_id}). Not sent twice.` });
      return;
    }
    await touch();   // still ours, right before the write
    const lg = log();
    let info; sendStarted = true;
    try { info = await (it.op === 'price' ? io.sheinPriceSave(b.body, lg) : it.op === 'publish' ? io.sheinPublish(b.body, lg) : io.sheinPartialEdit(b.body, lg)); } catch (e) {
      // Not connected / whitelist / signature / 403: SHEIN didn't take it. The job stops; the item goes
      // back to waiting (its key kept, so Resume still looks first) — never left 'sending' (re-review N2).
      if (fatal(e)) { await touch(); /* a process that lost its lease writes nothing (a real crash leaves 'sending') */ await updateListingItem(it.id, { status: 'deferred', nextInSec: 0, error: `Not sent: SHEIN refused the connection (${e.sheinMsg || e.message}). Resume sends it — looked up first.` }); throw e; }
      if (isTransport(e)) return it.op === 'publish' ? await publishUnconfirmed(it, `No answer (${e.sheinMsg || e.message}).`, io) : await retryLater(it, e, io);
      const said = preValidMessages(e.info);   // a coded refusal names the reason in info.pre_valid_result (S4)
      // re-review G2: a coded "system error" on a publish (no validation message) may have been taken — unconfirmed, key kept
      if (it.op === 'publish' && !said.length && isSystemError(e)) return await publishUnconfirmed(it, `SHEIN answered with a system error (${e.sheinMsg || e.message}) — it may have taken the product.`, io);
      return await refused(it, b, { message: said.length ? said.map((x) => x.message).join(' | ') : (e.sheinMsg || e.message), module: said[0]?.module || null,
        code: e.sheinCode, traceId: e.traceId || lg.traceId || null, response: e.info ? { code: e.sheinCode, msg: e.sheinMsg, info: e.info } : null }, io);
    }
    if (it.op === 'price') return await priceAnswered(it, b, info, lg, io);
    if (it.op === 'publish') return await publishAnswered(it, b, info, lg, io);
    const a = readSendAnswer(info, b.plan);
    if (a.kind === 'refused') return await refused(it, b, { message: a.message, module: a.module, traceId: lg.traceId || null, response: info }, io);
    if (a.kind === 'unknown') return await retryLater(it, Object.assign(new Error(a.message), { unknownAnswer: true, traceId: lg.traceId || null }), io);
    const { notes, skuCodes } = a;
    await updateListingItem(it.id, { status: 'in_review', version: String(info.version), skuCodes, response: info, traceId: lg.traceId || null, documentState: 1, sentNow: true, error: null, blockers: notes });
    await setVariantsLastError(b.variantIds, null);
    await recomputeAfter(io);
  } catch (e) {
    if (fatal(e) || e instanceof LeaseLost) throw e;
    if (isTransport(e)) return it.op === 'publish' && sendStarted ? publishUnconfirmed(it, `No answer (${e.sheinMsg || e.message}).`, io) : retryLater(it, e, io);
    if (it.op === 'publish' && sendStarted) return publishUnconfirmed(it, `Something failed after the send started (${String(e.message).slice(0, 200)}).`, io);
    await updateListingItem(it.id, { status: 'failed', error: String(e.message).slice(0, 500), blockers: [blocker('api_error', { message: e.sheinMsg || e.message, traceId: e.traceId || null })] });
  }
}
// A coded SHEIN answer that says "something broke on our side", not "your request is wrong".
export const SYSTEM_ERROR_RE = /系统异常|系统错误|系统繁忙|服务异常|服务错误|内部错误|超时|system (error|exception|busy)|internal|unknown error|service (error|exception|unavailable)|server error/i;
export const isSystemError = (e) => SYSTEM_ERROR_RE.test(`${e?.sheinMsg || ''} ${e?.message || ''}`);
async function retryLater(it, e, io) {
  const retries = Number(it.retries || 0) + 1;
  const msg = e.sheinMsg || e.message || 'no answer';
  if (retries >= MAX_RETRIES) {
    await updateListingItem(it.id, { status: 'failed', retries, traceId: e.traceId || null, error: `SHEIN didn’t answer after ${retries} tries: ${msg}`, blockers: [blocker('api_error', { message: msg, traceId: e.traceId || null })] });
    await setVariantsLastError(it.variant_ids || [], { code: 'api_error', params: { message: msg, traceId: e.traceId || null } });
    await recomputeAfter(io);
    return;
  }
  const sec = RETRY_SEC[Math.min(retries - 1, RETRY_SEC.length - 1)];
  await updateListingItem(it.id, { status: 'deferred', retries, nextInSec: sec, traceId: e.traceId || null, blockers: [blocker('api_error', { message: msg, traceId: e.traceId || null })],
    error: `SHEIN didn’t answer (${msg}) — try ${retries + 1} of ${MAX_RETRIES} at ${est(new Date(Date.now() + sec * 1000))}; we look it up first, so it is never sent twice.` });
}
// partialEdit's answer (code 0) → what happened (doc 3002047 + its official examples; review M6/S5/S6):
//   success !== true            → 'refused' with SHEIN's reasons (pre_valid_result / mcc_valid_result)
//   success true, no version    → 'unknown' (can't be followed: looked up later, never sent twice)
//   success true + version      → 'sent'; SHEIN's warnings + filtered_result kept as notes; skuCodes =
//                                 only the sizes WE added (the answer lists every SKU, others with supplier_sku "").
export function readSendAnswer(info, plan) {
  const said = preValidMessages(info);
  if (info?.success !== true) return { kind: 'refused', message: said.map((x) => x.message).join(' | ') || 'SHEIN refused the edit (success: false)', module: said[0]?.module || null };
  if (!info.version) return { kind: 'unknown', message: 'SHEIN said success but gave no version to follow' };
  const notes = said.map((x) => blocker('shein_note', { sheinMessage: x.message, module: x.module }));
  const f = info.filtered_result;
  if (f != null && !(Array.isArray(f) && !f.length) && !(typeof f === 'object' && !Array.isArray(f) && !Object.keys(f).length)) {
    notes.push(blocker('shein_note', { sheinMessage: `fields SHEIN filtered out: ${JSON.stringify(f).slice(0, 300)}`, module: 'filtered_result' }));
  }
  const mine = new Set((plan?.sizes || []).map((z) => z.sku));
  const skuCodes = (info.skc_list || []).flatMap((c) => (c.sku_list || []).filter((x) => mine.has(x.supplier_sku)).map((x) => ({ skc: c.skc_name, skuCode: x.sku_code, sellerSku: x.supplier_sku })));
  return { kind: 'sent', version: String(info.version), notes, skuCodes };
}
// F1 (Phase 4 review): SHEIN didn't confirm a publish (no answer / an unreadable answer / a crash
// mid-send). A second publish = a duplicate SPU and quota spent for good, so it is NEVER resent by
// itself: failed + `publish_unconfirmed`, the key KEPT. A person presses Look again (read-only);
// Send again (admin) unlocks only after a SECOND look, ≥ 30 min after the send, found nothing.
export const LOOK_AGAIN_MIN = 30;
async function publishUnconfirmed(it, why, io) {
  await updateListingItem(it.id, { status: 'failed', sentNow: !it.sent_at, response: { ...(it.response || {}), looks: [], send_again_ok: false },
    error: `${why} SHEIN didn’t confirm it — it is never sent again by itself. Press Look again in 15 min.`, blockers: [blocker('publish_unconfirmed', { reason: why })] });
  await recomputeAfter(io);
}
// Look again (PH ok — reads only): our seller SKUs in the store (incl. in review), else the receive
// notice already moved it. → [{ id, found, sendAgainOk, looks }]
export async function lookAgainPublish(itemIds, { io = IO, by = null } = {}) {
  const out = [];
  for (const it of await getListingItems(itemIds)) {
    if (!(it.op === 'publish' && it.status === 'failed' && (it.blockers || []).some((b) => b.code === 'publish_unconfirmed'))) { out.push({ id: it.id, refused: `it is ${it.status}` }); continue; }
    const log = { source: 'look again', jobId: it.job_id, itemId: it.id, spu: it.spu, by, dry: true };
    const skus = (it.plan?.sizes || []).map((z) => z.sku).filter(Boolean);
    const taken = skus.length ? await io.sheinSkusTaken(skus, log) : new Set();
    let doc = null;
    if (it.spu) doc = (await io.sheinDocStates([it.version ? { spuName: it.spu, version: it.version } : it.spu], log).catch(() => new Map())).get(it.spu) || null;
    if (skus.some((x) => taken.has(x)) || doc) {
      await updateListingItem(it.id, { status: 'in_review', blockers: [], error: `Found on SHEIN when ${by || 'a person'} looked again — not sent twice.` });
      out.push({ id: it.id, found: true });
      continue;
    }
    const looks = [...(it.response?.looks || []), { at: new Date().toISOString(), by, found: false }];
    const since = it.sent_at ? (Date.now() - new Date(it.sent_at).getTime()) / 60000 : 0;
    const ok = looks.length >= 2 && since >= LOOK_AGAIN_MIN;
    await updateListingItem(it.id, { response: { ...(it.response || {}), looks, send_again_ok: ok }, blockers: [blocker('publish_unconfirmed', { reason: it.blockers?.[0]?.params?.reason || null, sendAgainOk: ok, looks: looks.length })],
      error: ok ? `Not on SHEIN after ${looks.length} looks (${Math.round(since)} min after the send) — an admin may Send again.`
        : `Not found yet (${looks.length} look${looks.length === 1 ? '' : 's'}, ${Math.round(since)} min after the send). Look again${since < LOOK_AGAIN_MIN ? ` after ${LOOK_AGAIN_MIN} min` : ''} — a second look with nothing found unlocks Send again.` });
    out.push({ id: it.id, found: false, sendAgainOk: ok, looks: looks.length });
  }
  return out;
}
// Send again (admin / Connect integrations): only what two looks proved isn't on SHEIN. The key is
// released and the item goes back through the run (rebuilt, hash-checked, SKUs re-checked first).
export async function sendAgainPublish(itemIds, { io = IO, by = null } = {}) {
  const out = []; const jobs = new Set();
  for (const it of await getListingItems(itemIds)) {
    if (!(it.op === 'publish' && it.status === 'failed' && it.response?.send_again_ok === true)) { out.push({ id: it.id, refused: 'Look again first — Send again unlocks after a second look (≥ 30 min after the send) finds nothing' }); continue; }
    await updateListingItem(it.id, { status: 'deferred', nextInSec: 0, idemKey: null, retries: 0, blockers: [], error: `Sent again by ${by || 'an admin'} after two looks found nothing on SHEIN.`,
      response: { ...(it.response || {}), send_again_by: by, send_again_at: new Date().toISOString() } });
    out.push({ id: it.id, sent: true }); jobs.add(Number(it.job_id));
  }
  for (const id of jobs) {
    const j = await getListingJob(id);
    if (j?.status === 'done' || j?.status === 'interrupted') await requeueListingJob(id, 'queued (send again)');
    else if (['stopped', 'failed'].includes(j?.status)) await resumeJobRow(id, by).catch(() => null);
  }
  if (jobs.size) await kickListingJobs({ io });
  return out;
}

// Phase 4: publishOrEdit's answer. Sent → spu_name + version saved AT ONCE (spu-info shows nothing until
// SHEIN's first approval) → In review. Refused → Error with SHEIN's words (mapped to a better blocker).
async function publishAnswered(it, b, info, lg, io) {
  const a = readPublishAnswer(info, b.plan);
  if (a.kind === 'unknown') return publishUnconfirmed(it, a.message, io);   // F1: never retried by itself
  if (a.kind === 'refused') {
    const params = { sheinMessage: a.message, module: a.module, traceId: lg.traceId || null };
    await updateListingItem(it.id, { status: 'failed', error: a.message, traceId: lg.traceId || null, response: info, idemKey: null,
      blockers: [blocker('shein_prevalid', params), ...(a.mapped && a.mapped !== 'shein_prevalid' ? [blocker(a.mapped, params)] : [])] });
    await setVariantsLastError(b.variantIds, { code: 'shein_prevalid', params });
    await recomputeAfter(io);
    return;
  }
  await updateListingItem(it.id, { status: 'in_review', spu: a.spu, version: a.version, skuCodes: a.skuCodes, response: info, traceId: lg.traceId || null, documentState: 1, sentNow: true, error: null, blockers: a.notes });
  await setListingPublished(it.shopify_product_id, { spu: a.spu, version: a.version });
  await setVariantsLastError(b.variantIds, null);
  await recomputeAfter(io);
}
// SHEIN's reasons, from pre_valid_result (+ mcc_valid_result), with their module.
function preValidMessages(info) {
  const pre = (info?.pre_valid_result || []).flatMap((x) => (x.messages || []).map((m) => ({ module: x.module || x.form_name || x.form || null, message: m })));
  const mcc = (info?.mcc_valid_result || []).filter((x) => x?.message).map((x) => ({ module: Number(x.type) === 2 ? 'mcc (blocked)' : 'mcc (warning)', message: x.message }));
  return [...pre, ...mcc];
}
// SHEIN said no (a pre-check / a non-zero code): Error with SHEIN's words, never retried. The
// idempotency key is RELEASED (M7): it only guards against a second send of something SHEIN may have
// taken; a refused body may go again after a new dry run (a person fixed something, or not).
async function refused(it, b, { message, module = null, code = null, traceId = null, response = null }, io = IO) {
  const params = { sheinMessage: message, module, code, traceId };
  await updateListingItem(it.id, { status: 'failed', error: message, traceId, response, idemKey: null, blockers: [blocker('shein_prevalid', params)] });
  await setVariantsLastError(b.variantIds, { code: 'shein_prevalid', params });
  await recomputeAfter(io);
}
// Did a send we can't be sure about reach SHEIN? Its new seller SKUs exist in the store (incl.
// products in review), or spu-info already shows them → yes. Reads only.
async function didItArrive(it, io, log) {
  const lg = log({ source: 'run (look before resending)' });
  if (it.op === 'publish') {   // no spu_name yet: our seller SKUs in the store (incl. in review) are the only proof (spec 4.2)
    const skus = (it.plan?.sizes || []).map((z) => z.sku).filter(Boolean);
    const taken = skus.length ? await io.sheinSkusTaken(skus, lg) : new Set();
    return skus.some((s) => taken.has(s)) ? { arrived: true, version: it.version || null, state: 1, skuCodes: [] } : { arrived: false };
  }
  if (it.op === 'price') {   // a price SHEIN took shows in spu-info (or sits in its price review — resending the same price is harmless)
    const info = await io.sheinSpuInfo(it.spu, lg).catch((e) => { if (fatal(e)) throw e; return null; });
    const rows = new Map((spuPayload(info)?.rows || []).map((r) => [r.sheinSku, r]));
    const prices = it.plan?.prices || [];
    const shown = (x) => Math.abs(Number(rows.get(x.skuCode)?.basePrice) - x.to) < 0.005;
    // per size: shown → 1 (done) · a RISE not shown → 2 (maybe in SHEIN's review: never resent) · a cut not shown → 0 (not applied)
    const codes = prices.map((x) => ({ skuCode: x.skuCode, site: x.site, to: x.to, variantId: x.variantId, status: shown(x) ? 1 : x.rise ? 2 : 0 }));
    return { arrived: !!prices.length && codes.every((c) => c.status === 1), risesPending: codes.some((c) => c.status === 2), codes };
  }
  if (it.op === 'edit') {   // a partialEdit we can't see: a NEW document version in review since the dry run, or our relink targets now in the store
    const doc = (await io.sheinDocStates([it.spu], lg)).get(it.spu);
    const fresh = doc?.version && doc.version !== it.plan?.preVersion && (doc.skcList || []).some((x) => [1, 5].includes(Number(x.documentState)));
    const to = (it.plan?.relinks || []).map((l) => l.to);
    const taken = to.length ? await io.sheinSkusTaken(to, lg) : new Set();
    return fresh || to.some((x) => taken.has(x)) ? { arrived: true, version: doc?.version || null, state: (doc?.skcList || [])[0]?.documentState ?? null, skuCodes: [] } : { arrived: false };
  }
  const skus = (it.plan?.sizes || []).map((z) => z.sku).filter(Boolean);
  if (!skus.length || !it.spu) return { arrived: false };
  const taken = await io.sheinSkusTaken(skus, lg);
  const info = await io.sheinSpuInfo(it.spu, lg).catch((e) => { if (fatal(e)) throw e; return null; });
  const rows = spuPayload(info)?.rows || [];
  const shown = rows.filter((r) => skus.includes(r.sellerSku));
  const doc = (await io.sheinDocStates([it.spu], lg)).get(it.spu);
  // The seller-SKU check can lag behind a send; a NEW document version in review since our dry run
  // read (plan.preVersion) means SHEIN received an edit — ours — too (S2).
  const fresh = doc?.version && doc.version !== it.plan?.preVersion && (doc.skcList || []).some((x) => [1, 5].includes(Number(x.documentState)));
  if (!skus.some((s) => taken.has(s)) && !shown.length && !fresh) return { arrived: false };
  return { arrived: true, version: doc?.version || null, state: (doc?.skcList || [])[0]?.documentState ?? null,
    skuCodes: shown.map((r) => ({ skc: r.skc, skuCode: r.sheinSku, sellerSku: r.sellerSku })) };
}
async function recomputeAfter(io = IO) {
  if (await latestListingJob('snapshot', 'done')) await recomputeStored({ io }).catch((e) => console.error('[shein-listing] recompute', e.message));
}

/* ---------------------- Phase 3: re-sync Needs update (price · edit) ---------------------- */
// docs/shein-listings-plan.md §3 Phase 3; docs/context/shein-listings.md → Phase 3. The SAME dry run →
// run → review flow, gates and idempotency as Phase 2, with two more ops per product:
//   price  product/price/save (never publishOrEdit): sizes whose SHEIN price is off the D4 target by
//          more than $0.50; specialPrice always sent when the size has one; a promotion lock
//          (priceLockType 1) skips a RISE; a rise SHEIN reviews (status 2) waits for the price-audit
//          webhook / the spu-info poll.
//   edit   ONE partialEdit: stopped sizes Shopify sells back on (mall_state 1, not within 20 min of a
//          shelf change), seller-SKU relinks, the title only on a product we published (synced_hash).

const PRICE_REVIEW_MAX_D = 7;   // a price review SHEIN never answers → Error after this
export const AUTO_PRICE_KEY = 'shein_listing_auto_price';
export const AUTO_PRICE_BY = 'auto (price re-sync)';

async function buildResync(it, { d, product, spu, payload, spuName, lg, io, jctx = {} }) {
  const stored = d.variants;
  const scope = jctx.scope || {};
  if (it.op === 'price') {
    const live = new Map((product.variants || []).map((v) => [v.variantId, v]));
    const onShein = stored.filter((v) => v.shopify_variant_id && ['sku', 'link', 'published'].includes(v.match));
    const market = await io.marketTargets([product]).catch(() => new Map());   // the readiness's lookup (S9)
    const targets = new Map(); const shopifyFloor = new Map();
    for (const v of onShein) {
      const lv = live.get(v.shopify_variant_id); if (!lv) continue;
      // D8a: the automatic re-sync uses MARKET targets only (no Shopify fallback)
      const t = sheinNewSizePrice({ marketCents: market.get(v.shopify_variant_id) ?? null, shopifyPrice: lv.price, marketOnly: !!scope.auto });
      if (t) targets.set(v.shopify_variant_id, t);
      if (Number(lv.price) > 0) shopifyFloor.set(v.shopify_variant_id, Number(lv.price));
    }
    let locksUnread = false;
    const search = (await io.sheinSearchProducts({ spuNameList: [spuName] }, lg).catch((e) => { if (fatal(e)) throw e; locksUnread = true; return { data: [] }; })).data.find((x) => String(x.spuName) === spuName);
    if (!search) locksUnread = true;   // no answer for this product → no rise goes (S3)
    const locks = new Map((search?.skcList || []).map((c) => {
      const us = (c.activityLockList || []).find((x) => /shein-us/i.test(x.site || '')) || (c.activityLockList || [])[0] || {};
      return [String(c.skcName), { price: Number(us.priceLockType) === 1, warn: Number(us.priceLockType) === 2 }];
    }));
    const inflightSkus = new Set((await listingInflight()).filter((x) => x.op === 'price' && x.spu === spuName && x.id !== it.id)
      .flatMap((x) => (x.sku_codes || []).filter((c) => Number(c.status) === 2).map((c) => String(c.skuCode))));
    const { body, plan } = planPrice({ spu, stored, targets, locks, locksUnread, inflightSkus, endSpecials: !!scope.endSpecials, auto: !!scope.auto, shopifyFloor });
    plan.productTitle = d.product.title || null;
    return { body, plan, hash: body ? bodyHash(body) : null, variantIds: [...new Set(plan.prices.map((x) => x.variantId))], spuName };
  }
  const fill = await fillCache(payload.categoryId, io, lg).catch((e) => { if (fatal(e)) throw e; return null; });
  const docs = await io.sheinDocStates([spuName], lg);
  const reviewOpen = (docs.get(spuName)?.skcList || []).some((x) => [1, 5].includes(Number(x.documentState)));
  const to = stored.filter((v) => v.match === 'link' && v.shopify_variant_id).map((v) => String((product.variants || []).find((x) => x.variantId === v.shopify_variant_id)?.sku || v.seller_sku || '').trim()).filter(Boolean);
  const taken = to.length ? await io.sheinSkusTaken(to, lg) : new Set();
  const recentShelf = await io.recentShelf((spu.skcInfoList || []).map((c) => String(c.skcName))).catch(() => new Set());
  // A title is sent only as the WHOLE multi-language list (doc 3002047 rule 3): read the SPU name in every
  // language the store's rules list (S6) — only for a product we published (D11).
  let names = null;
  if (d.product.synced_hash && fill) {
    const langs = [...new Set([fill.default_language || 'en', ...(fill.language_title_max_length_list || []).map((x) => x.language).filter(Boolean)])].slice(0, 5);
    const all = await io.sheinSpuInfo(spuName, lg, langs).catch((e) => { if (fatal(e)) throw e; return null; });
    names = (all?.productMultiNameList || []).filter((x) => x?.language && String(x.productName || "").trim()).map((x) => ({ language: x.language, name: String(x.productName).trim() }));
    if (!langs.every((l) => names.some((n) => n.language === l))) names = null;   // a language missing → no title (never drop one)
  }
  const { body, plan } = planEdit({ spu, product, stored, productRow: d.product, fill, fillUnread: !fill, taken, recentShelf, names });
  plan.reviewOpen = reviewOpen;
  plan.preVersion = docs.get(spuName)?.version || null;
  plan.productTitle = d.product.title || null;
  return { body, plan, hash: body ? bodyHash(body) : null, variantIds: [...new Set([...plan.mallOn, ...plan.relinks].map((x) => x.variantId))], spuName };
}

// price/save's answer → per size: 1 done · 2 SHEIN reviews the rise · 0 / success false refused.
export function readPriceAnswer(info, plan) {
  const data = Array.isArray(info) ? info : (info?.data || []);
  const by = new Map(data.map((x) => [`${x.productCode}|${x.site || ''}`, x]));
  const accepted = []; const refusedList = [];
  for (const p of plan?.prices || []) {
    const r = by.get(`${p.skuCode}|${p.site}`) || data.find((x) => String(x.productCode) === p.skuCode);
    const st = Number(r?.status);
    if (r && r.success !== false && (st === 1 || st === 2)) accepted.push({ skuCode: p.skuCode, site: p.site, status: st, to: p.to, variantId: p.variantId });
    else refusedList.push({ skuCode: p.skuCode, site: p.site, variantId: p.variantId, size: p.size, message: r?.message || (r ? `status ${r.status}` : 'SHEIN didn’t answer for this size') });
  }
  return { accepted, refused: refusedList };
}
async function priceAnswered(it, b, info, lg, io) {
  const a = readPriceAnswer(info, b.plan);
  if (!a.accepted.length) {
    return refused(it, b, { message: a.refused.map((x) => `${x.size}: ${x.message}`).join(' | ') || 'SHEIN refused the prices', module: 'price', traceId: lg.traceId || null, response: info }, io);
  }
  const notes = a.refused.map((x) => blocker('shein_note', { sheinMessage: `${x.size}: ${x.message}`, module: 'price' }));
  for (const x of a.refused) await setVariantsLastError([x.variantId], { code: 'shein_prevalid', params: { sheinMessage: x.message, module: 'price' } });
  const pending = a.accepted.filter((x) => x.status === 2);
  await updateListingItem(it.id, { status: pending.length ? 'in_review' : 'done', skuCodes: a.accepted, response: info, traceId: lg.traceId || null, sentNow: true,
    error: pending.length ? `${pending.length} price rise${pending.length === 1 ? '' : 's'} with SHEIN’s price review.` : null, blockers: notes });
  if (!pending.length) await afterApplied({ ...it, variant_ids: a.accepted.map((x) => x.variantId) }, io);
  else await recomputeAfter(io);
}
// SHEIN took it (price done / edit approved): re-read the product, refresh our copy, its sizes are in step.
async function afterApplied(item, io) {
  const info = await io.sheinSpuInfo(item.spu, { source: 'review', jobId: item.job_id, itemId: item.id, spu: item.spu, by: 'SHEIN review', dry: false }).catch(() => null);
  const payload = info ? spuPayload(info, { stock: await io.lastWalkStock().catch(() => new Map()) }) : null;
  if (payload) await setListingCache('spu', item.spu, payload, `phase 3 ${item.job_id}`);
  await markVariantsSynced(item.variant_ids || []);
  await recomputeAfter(io);
}
// A price item in SHEIN's price review: spu-info shows the new price → that size is approved.
async function pollPrice(item, io) {
  const info = await io.sheinSpuInfo(item.spu, { source: 'review', jobId: item.job_id, itemId: item.id, spu: item.spu, by: 'review follow-up', dry: true }).catch(() => null);
  const rows = new Map((spuPayload(info)?.rows || []).map((r) => [r.sheinSku, r]));
  const codes = (item.sku_codes || []).map((c) => (Number(c.status) === 2 && Math.abs(Number(rows.get(c.skuCode)?.basePrice) - Number(c.to)) < 0.005 ? { ...c, status: 1 } : c));
  return settlePrice(item, codes, io, { via: 'poll' });
}
async function settlePrice(item, codes, io, { via }) {
  const pending = codes.filter((c) => Number(c.status) === 2);
  if (pending.length) {
    const old = item.sent_at && Date.now() - new Date(item.sent_at).getTime() > PRICE_REVIEW_MAX_D * 86400_000;
    if (!old) { await updateListingItem(item.id, { skuCodes: codes, checkedNow: true }); return { item: item.id, verdict: 'waiting', via }; }
    const msg = `SHEIN never answered the price review in ${PRICE_REVIEW_MAX_D} days — check the price in Seller Center.`;
    // its own code: NOT retryable (a retry would resend a rise SHEIN may still be reviewing) — S4
    await updateListingItem(item.id, { status: 'failed', skuCodes: codes, checkedNow: true, error: msg, idemKey: null, blockers: [blocker('price_review_stuck', { message: msg })] });
    return { item: item.id, verdict: 'stuck', via };
  }
  const ok = codes.filter((c) => Number(c.status) === 1); const no = codes.filter((c) => Number(c.status) === 3);
  for (const c of no) await setVariantsLastError([c.variantId], { code: 'review_rejected', params: { failedReason: c.reason || 'no reason given' } });
  if (!ok.length) {
    await updateListingItem(item.id, { status: 'failed', skuCodes: codes, checkedNow: true, error: no.map((c) => c.reason).filter(Boolean).join(' | ') || 'SHEIN rejected the price',
      blockers: [blocker('review_rejected', { failedReason: no.map((c) => c.reason).filter(Boolean).join(' | ') || 'no reason given' })] });
    await recomputeAfter(io);
    return { item: item.id, verdict: 'rejected', via };
  }
  await updateListingItem(item.id, { status: 'done', skuCodes: codes, checkedNow: true, error: no.length ? `${no.length} price rise${no.length === 1 ? '' : 's'} rejected by SHEIN` : null });
  await afterApplied({ ...item, variant_ids: ok.map((c) => c.variantId) }, io);
  return { item: item.id, verdict: 'approved', via };
}
// SHEIN's product_price_audit_status_notice { spu_name, skc_name, sku_code, site, audit_state 1 pass / 2 reject, audit_reason }.
export async function listingPriceAuditEvent(event, { io = IO } = {}) {
  const sku = String(event?.sku_code || '');
  if (!sku) return { handled: 0 };
  // doc 3000912: audit_state 1 = passed, 2 = rejected — anything else is logged and ignored (S2)
  const st = Number(event.audit_state);
  if (st !== 1 && st !== 2) { console.warn(`[shein-listing] price audit with audit_state ${event.audit_state} for ${sku} — ignored`); return { handled: 0, why: `audit_state ${event.audit_state}` }; }
  const items = (await listingInflight()).filter((i) => i.op === 'price' && i.status === 'in_review' && (i.sku_codes || []).some((c) => c.skuCode === sku && Number(c.status) === 2));
  const out = [];
  for (const it of items) {
    const full = (await getListingItems([it.id]))[0];
    const codes = full.sku_codes.map((c) => (c.skuCode === sku && (!event.site || !c.site || c.site === event.site) && Number(c.status) === 2
      ? { ...c, status: st === 1 ? 1 : 3, reason: event.audit_reason || null } : c));
    out.push(await settlePrice(full, codes, io, { via: 'webhook' }));
  }
  return { handled: out.length, verdicts: out };
}

// D8: "auto re-sync price" — an admin switch, OFF by default. Even ON it sends nothing by itself: once
// per EST day it STARTS a dry run (ops price) of the products whose price is off, and when that dry run
// is ready the next tick RUNS it — the same preview → run path, hash checks and gates a person uses.
export async function readAutoPrice() {
  try { const v = await getSetting(AUTO_PRICE_KEY); return v ? JSON.parse(v) : { on: false }; } catch { return { on: false }; }
}
export async function setAutoPrice(on, by) {
  const v = { on: !!on, by, at: new Date().toISOString() };
  await setSetting(AUTO_PRICE_KEY, JSON.stringify(v), by);
  return v;
}
export async function autoPriceTick({ io = IO, now = new Date() } = {}) {
  const cfg = await readAutoPrice();
  if (!cfg.on) return { why: 'off' };
  if (await activeListingJob()) return { why: 'a job is running' };
  if (await io.walkBusy()) return { why: 'the walk is running' };
  const last = await latestListingJobBy('preview', AUTO_PRICE_BY);
  if (last?.status === 'awaiting_confirm') return { ran: (await startRunJob({ previewJobId: last.id, by: AUTO_PRICE_BY, io })).id, preview: last.id };
  if (last && estDate(last.created_at) === estDate(now)) return { why: 'already ran today' };
  const productIds = await listingPriceOffProducts({ marketOnly: true });   // D8a: market targets only
  if (!productIds.length) return { why: 'no price is off' };
  const job = await startListingJob({ kind: 'preview', by: AUTO_PRICE_BY, scope: { productIds, ops: ['price'], auto: true }, io });   // auto → market only, ≤ 15 % a day, ≥ Shopify
  return { previewed: job.id };
}

/* SHEIN's review: poll + webhooks */
// approved → done + 'published' + size map verified + one stock-only step; rejected → failed.
export async function applyReview(item, verdict, { failedReason = null, code = 'review_rejected', state = null, io = IO } = {}) {
  if (verdict === 'waiting') { await updateListingItem(item.id, { checkedNow: true, documentState: state ?? item.document_state ?? 1 }); return { item: item.id, verdict }; }
  if (verdict === 'rejected') {
    const params = code === 'review_rejected' ? { failedReason: failedReason || 'no reason given' } : { sheinMessage: failedReason || 'SHEIN did not receive it' };
    await updateListingItem(item.id, { status: 'failed', checkedNow: true, documentState: state, error: failedReason || 'SHEIN rejected it', blockers: [blocker(code, params)] });
    await setVariantsLastError(item.variant_ids || [], { code, params });
    await recomputeAfter(io);
    return { item: item.id, verdict };
  }
  if (item.op === 'publish') {   // Phase 4: our new product is approved
    const r = await publishApproved(item, { io, recompute: () => recomputeAfter(io) });
    if (r.waiting) {
      // S5: not for ever — after APPROVED_WAIT_H it is an Error a person looks at
      const seen = item.response?.approved_seen_at ? new Date(item.response.approved_seen_at) : new Date();
      if (Date.now() - seen.getTime() > APPROVED_WAIT_H * 3600_000) {
        const msg = `SHEIN said approved, but the product never showed on SHEIN in ${APPROVED_WAIT_H} h — check it in Seller Center.`;
        await updateListingItem(item.id, { status: 'failed', checkedNow: true, documentState: 2, error: msg, blockers: [blocker('api_error', { message: msg })] });
        return { item: item.id, verdict: 'stuck' };
      }
      await updateListingItem(item.id, { checkedNow: true, documentState: 2, response: { ...(item.response || {}), approved_seen_at: seen.toISOString() }, error: 'SHEIN approved it; waiting for SHEIN to show the product (we look again in 5 min).' });
      return { item: item.id, verdict: 'waiting' };
    }
    return { item: item.id, verdict, ...r };
  }
  if (item.op === 'edit' || item.op === 'price') {   // Phase 3: SHEIN took it — refresh what we know, the sizes are in step
    await updateListingItem(item.id, { status: 'done', checkedNow: true, documentState: state ?? 2, error: null, blockers: item.blockers || [] });
    await afterApplied(item, io);
    // A stopped SKU keeps no stock on SHEIN (doc 3002047 mall_state) — a size back on sale gets one stock step (S5).
    if ((item.plan?.mallOn || []).length) {
      let stock = null;
      try { stock = await io.stockStep(item.spu); } catch (e) { stock = { error: e.message }; }
      await updateListingItem(item.id, { response: { ...(item.response || {}), stock_step: stock } });
    }
    return { item: item.id, verdict };
  }
  // approved: read what SHEIN now has, match our new sizes by seller SKU.
  const log = { source: 'review', jobId: item.job_id, itemId: item.id, spu: item.spu, by: 'SHEIN review', dry: false };
  const info = await io.sheinSpuInfo(item.spu, log);
  const payload = spuPayload(info, { stock: await io.lastWalkStock().catch(() => new Map()) });
  const plan = item.plan || {};
  const rows = payload?.rows || [];
  const sizes = (plan.sizes || []).map((z) => ({ z, row: rows.find((r) => r.sellerSku === z.sku) }));
  if (sizes.some((x) => !x.row)) {
    // Approved but spu-info doesn't show our sizes: wait, but not for ever (re-review N4) — after
    // APPROVED_WAIT_H it is an Error a person looks at (a different edit's approval, or SHEIN lagging).
    const seen = item.response?.approved_seen_at ? new Date(item.response.approved_seen_at) : new Date();
    if (Date.now() - seen.getTime() > APPROVED_WAIT_H * 3600_000) {
      const msg = `SHEIN said approved, but the new sizes never showed on SHEIN in ${APPROVED_WAIT_H} h — check the product in Seller Center.`;
      await updateListingItem(item.id, { status: 'failed', checkedNow: true, documentState: 2, error: msg, blockers: [blocker('api_error', { message: msg })] });
      await setVariantsLastError(item.variant_ids || [], { code: 'api_error', params: { message: msg } });
      await recomputeAfter(io);
      return { item: item.id, verdict: 'stuck' };
    }
    await updateListingItem(item.id, { checkedNow: true, documentState: 2, response: { ...(item.response || {}), approved_seen_at: seen.toISOString() },
      error: 'SHEIN approved it; waiting for SHEIN to show the new sizes (we look again in 5 min).' });
    return { item: item.id, verdict: 'waiting' };
  }
  await markVariantsPublished(sizes.map(({ z, row }) => ({ variantId: z.variantId, spu: item.spu, skc: row.skc, shein_sku: row.sheinSku, seller_sku: row.sellerSku, shein_size: row.size, value_id: row.sizeValueId })));
  for (const { z, row } of sizes) {
    if (z.mapId) await verifySizeMapById(z.mapId, z.kind === 'custom' ? row.sizeValueId : null);
    else await verifySizeMap({ category_id: Number(plan.categoryId) || 0, attribute_id: Number(plan.sizeAttributeId) || 0, size_key: z.sizeKey, attribute_value_id: row.sizeValueId ?? z.valueId, shein_label: row.size || z.sheinSize }, 'SHEIN approval');
  }
  await setVariantsLastError(item.variant_ids || [], null);
  if (payload) await setListingCache('spu', item.spu, payload, `review ${item.job_id}`);
  await updateListingItem(item.id, { status: 'done', checkedNow: true, documentState: 2, error: null, blockers: [] });
  await recomputeAfter(io);
  // New sizes went up at 0: one stock-only step so SHEIN gets the live-fix sellable number now.
  let stock = null;
  try { stock = await io.stockStep(item.spu); } catch (e) { stock = { error: e.message }; console.error('[shein-listing] stock step', item.spu, e.message); }
  await updateListingItem(item.id, { response: { ...(item.response || {}), stock_step: stock } });
  return { item: item.id, verdict, stock };
}

// The tick: poll SHEIN's review for every item sent ≥ 5 min ago (or never checked), then re-queue a
// run whose deferred items are due / that a restart cut off. Reads + DB only; sends happen in the job.
export async function listingFollowUp({ io = IO, force = false } = {}) {
  const out = { polled: 0, verdicts: [], requeued: [] };
  // Phase 3 price reviews have no document: poll spu-info for the price (+ SHEIN's price-audit webhook).
  const allFlight = (await listingInflight()).filter((i) => ['sent', 'in_review'].includes(i.status) && i.spu
    && (force || !i.review_checked_at || Date.now() - new Date(i.review_checked_at).getTime() >= POLL_SEC * 1000));
  for (const it of allFlight.filter((i) => i.op === 'price')) out.verdicts.push(await pollPrice((await getListingItems([it.id]))[0], io));
  const flight = allFlight.filter((i) => i.op !== 'price' && ['sent', 'in_review'].includes(i.status) && i.spu
    && (force || !i.review_checked_at || Date.now() - new Date(i.review_checked_at).getTime() >= POLL_SEC * 1000));
  if (flight.length) {
    const log = { source: 'review', by: 'review follow-up', dry: true };
    const docs = await io.sheinDocStates(flight.map((i) => (i.version ? { spuName: i.spu, version: i.version } : i.spu)), log);
    out.polled = flight.length;
    for (const it of flight) {
      const d = docs.get(it.spu);
      const skcs = (d?.skcList || []).filter((x) => !it.plan?.skc || String(x.skcName) === String(it.plan.skc));
      const list = skcs.length ? skcs : (d?.skcList || []);
      // The answer must be about OUR submission: asked by version, and a different version back is ignored (M6).
      const ours = d && (!it.version || !d.version || String(d.version) === String(it.version));
      let verdict = ours ? reviewVerdict(list.map((x) => x.documentState)) : 'waiting';
      if (verdict === 'rejected' && !it.version) verdict = 'waiting';   // no version to tie a rejection to — never guess
      const notReceived = list.some((x) => Number(x.documentState) === -1);   // -1 = SHEIN didn't receive it (S9)
      const reason = list.flatMap((x) => (x.failedReason || []).map((f) => f.content)).filter(Boolean).join(' | ') || (notReceived ? 'SHEIN didn’t receive it' : null);
      const full = (await getListingItems([it.id]))[0];
      out.verdicts.push(await applyReview(full, verdict, { failedReason: reason, code: notReceived ? 'shein_prevalid' : 'review_rejected', state: list[0]?.documentState ?? null, io }));
    }
  }
  if (!(await activeListingJob()) && !(await io.walkBusy())) {
    for (const j of await runJobsWithDueItems()) {
      const r = await requeueListingJob(j.id, j.status === 'interrupted' ? 'queued (resumed after a restart)' : 'queued (retrying waiting items)');
      if (r) { out.requeued.push(j.id); break; }   // one job at a time
    }
  }
  if (out.requeued.length) await kickListingJobs({ io });
  return out;
}

// SHEIN's product webhooks (api/shein/webhook.js, verified there): the audit result
// (product_document_audit_status_notice) and the receive result (…_receive_status_notice).
export async function listingReviewEvent(event, code = '', { io = IO } = {}) {
  const spu = String(event?.spu_name || '');
  if (!spu) return { handled: 0 };
  // Phase 4: a publish whose answer was lost has no spu yet — the receive notice names our seller SKUs.
  const sellers = new Set((event.document_details || []).flatMap((d) => (d.sku_list || []).map((x) => String(x.seller_sku || ''))).filter(Boolean));
  if (sellers.size) {
    const cands = [...(await listingInflight()).filter((x) => x.op === 'publish' && !x.spu), ...await listPublishUnconfirmed()];
    for (const i of cands.filter((x) => (x.plan?.sizes || []).some((z) => sellers.has(z.sku)))) {
      await updateListingItem(i.id, { spu, version: event.version || null, status: event.received_success === false ? 'failed' : 'in_review', blockers: [], error: null });
      await setListingPublished(i.shopify_product_id, { spu, version: event.version || null });
    }
  }
  // Only a push about OUR submission: same version when both carry one (M6).
  const items = (await listingInflight()).filter((i) => i.op !== 'price' && ['sent', 'in_review'].includes(i.status) && i.spu === spu && (!event.version || !i.version || String(i.version) === String(event.version)));
  if (!items.length) return { handled: 0, why: 'no listing edit of ours in flight for this product' };
  const reason = (event.failed_reason || []).map((f) => f?.content).filter(Boolean).join(' | ') || null;
  let verdict = 'waiting'; let kind = 'review_rejected';
  if (event.received_success === false) { verdict = 'rejected'; kind = 'shein_prevalid'; }
  else if (event.audit_state != null) verdict = reviewVerdict([event.audit_state]);
  if (verdict === 'rejected' && !event.version && kind === 'review_rejected') return { handled: 0, why: 'a rejection without a version — the 5-minute poll decides' };
  else if (event.received_success === true) verdict = 'waiting';
  const out = [];
  for (const it of items) {
    if (event.skc_name && it.plan?.skc && String(event.skc_name) !== String(it.plan.skc)) continue;
    const full = (await getListingItems([it.id]))[0];
    out.push(await applyReview(full, verdict, { failedReason: reason, code: kind, state: event.audit_state ?? null, io }));
  }
  return { handled: out.length, verdicts: out, code };
}

/* --------------------------- Shopify webhooks → recheck --------------------------- */

const pending = new Map(); let timer = null; let draining = null;
// products/create|update — the REST payload. Coalesced; stock-only changes do nothing.
export function listingProductChanged(payload, { io = IO } = {}) {
  const n = normalizeWebhookProduct(payload);
  if (!n) return;
  n.style = styleFromTitle(n.title);
  pending.set(n.productId, n);
  if (!timer) timer = setTimeout(() => { timer = null; draining = drainRechecks(io).finally(() => { draining = null; }); }, io.coalesceMs);
}
export async function listingProductDeleted(payload) {
  const id = payload?.admin_graphql_api_id || (payload?.id != null ? `gid://shopify/Product/${payload.id}` : null);
  if (id) await markListingProductDeleted(String(id));
}
// Tests: wait for the coalesced recheck to finish.
export async function flushRechecks(io = IO) {
  if (timer) { clearTimeout(timer); timer = null; draining = drainRechecks(io).finally(() => { draining = null; }); }
  if (draining) await draining;
}
async function drainRechecks(io) {
  const list = [...pending.values()]; pending.clear();
  if (!list.length) return { rechecked: 0 };
  try { return await recheckProducts(list, { io }); } catch (e) { console.error('[shein-listing] recheck', e.message); return { error: e.message }; }
}
// → { rechecked, skipped } — a product is recomputed only if its LISTING (not stock) changed.
export async function recheckProducts(list, { io = IO } = {}) {
  if (!(await latestListingJob('snapshot', 'done'))) return { rechecked: 0, skipped: list.length, why: 'no snapshot yet' };
  const prev = await loadListingPrev();
  const differs = (p) => prev.products.get(p.productId)?.shopify_hash !== listingHash(p);
  const live = [];
  for (const n of list.filter(differs)) {
    const r = await io.shopifyListingProduct(n.productId);
    if (r?.error) live.push(n);                 // Shopify didn't answer: the payload is the best we have
    else if (r?.product) live.push({ ...r.product, style: r.product.style || styleFromTitle(r.product.title) });
  }
  const changed = live.filter(differs);
  if (!changed.length) return { rechecked: 0, skipped: list.length };
  await recomputeStored({ replace: changed, io });
  return { rechecked: changed.length, skipped: list.length - changed.length };
}

/* ------------------------------ tick + nightly ------------------------------ */

// Nightly at 03:00 EST: due in the 03:00–03:59 EST hour when no nightly ran this EST day.
const EST_HOUR = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' });
export function nightlyDue(last, now = new Date()) {
  if (Number(EST_HOUR.format(now)) !== 3) return false;
  if (!last) return true;
  return estDate(last.created_at) !== estDate(now);
}
// From sheinTick() (production only, SHEIN_SYNC_WATCH): leases, the nightly, Phase 2's review
// follow-up + deferred retries, the 90-day log prune.
export async function listingTick({ now = new Date(), io = IO } = {}) {
  await markStaleListingJobs();
  const last = await latestListingJobBy('snapshot', NIGHTLY);
  if (nightlyDue(last, now) && !(await activeListingJob())) {
    const cut = await latestListingJob('snapshot');
    if (cut && cut.status === 'interrupted' && cut.started_by === NIGHTLY) await resumeListingJob(cut.id, NIGHTLY).catch((e) => console.error('[shein-listing] nightly resume', e.message));
    else await startListingJob({ kind: 'snapshot', by: NIGHTLY, io }).catch((e) => console.error('[shein-listing] nightly', e.message));
  }
  await listingFollowUp({ io }).catch((e) => console.error('[shein-listing] follow-up', e.message));
  await autoPriceTick({ io, now }).catch((e) => console.error('[shein-listing] auto price', e.message));
  await kickListingJobs({ io });
  const pruned = await getSetting('shein_api_log_pruned').catch(() => null);
  const today = estDate(now);
  if (pruned !== today) { await pruneSheinApiLog(90).catch(() => {}); await setSetting('shein_api_log_pruned', today, 'shein-listing').catch(() => {}); }
}

export { getListingJob, STATUS_ORDER };
