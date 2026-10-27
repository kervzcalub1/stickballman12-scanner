// SHEIN Listings (docs/context/shein-listings.md, docs/shein-listings-plan.md Appendix B.5).
// PH + admin. Phase 0/1: nothing here writes to SHEIN.
//
// GET  /api/shein/listings?status=&blocker=&q=&brand=&page=1&pageSize=50&sort=worst|title|updated|coverage
//        -> { ok, connected, configured, canWrite, isAdmin, summary, products, total, page, pageSize }
// GET  /api/shein/listings?product=<gid>   -> { ok, product, variants, jobItems, log, canWrite, isAdmin }
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
//   Phase 4 — publish brand-new products: preview { …, ops:['publish'] } (never mixed; filter = products NOT on SHEIN);
//     photos are converted (R2 + transform-pic) only when the starter is an admin / Connect integrations holder (security H2);
//   publish_choices { productId, titleOverride?, skcValueId?, usePhPhotos? } (PH, DB only) -> { ok, product };
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
  lastPreviewItem, markPublishAgain, setListingPublishChoices,
} from '../_lib/db.js';
import { publishChecklist, cleanTitle } from '../../src/lib/sheinPublish.js';
import { sheinStatus } from '../_lib/shein.js';
import { shopifyAdminStore, shopifyEnsureWebhooks } from '../_lib/shopify.js';
import { startListingJob, startRunJob, resumeJob, recomputeStored, kickListingJobs, PREVIEW_OPS, readAutoPrice, setAutoPrice, lookAgainPublish, sendAgainPublish, readinessChecklist, userThrottle } from '../_lib/shein-listing.js';
import { hasPrivilege } from '../_lib/buycart.js';
import { renderBlocker, STATUS_CODES, STATUS_ORDER, TILE_STATUSES, BLOCKERS, summarizePlan } from '../../src/lib/sheinListings.js';

const isAdminRole = (u) => u?.role === 'admin' || u?.role === 'superadmin';
const PRIV_ACTIONS = new Set(['probe', 'webhooks', 'run', 'retry', 'auto_price', 'publish_again', 'send_again']);
const PREVIEW_MAX = 300;
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
    const pid = t(qs.get('product'), 200);
    if (pid) {
      const d = await getListingProduct(pid);
      if (!d) return send(res, 404, { ok: false, error: 'That product isn’t in SHEIN Listings (yet) — re-read Shopify + SHEIN.' });
      const [items, log] = await Promise.all([listingItemsForProduct(pid, d.product.spu, 5), d.product.spu ? listSheinApiLog({ spu: d.product.spu, limit: 20 }) : []]);
      let checklist = null; let checklistFrom = null;
      if (!d.product.spu && !String(pid).startsWith('shein:')) {
        const last = await lastPreviewItem(pid, 'publish');
        if (last?.plan?.checklist) { checklist = last.plan.checklist; checklistFrom = { jobId: Number(last.job_id), at: last.updated_at }; }
        else {
          // the readiness from the cache — a line SHEIN's rules weren't read for is null ("not read yet"), never ✓
          checklist = await readinessChecklist(d.product, d.variants).catch(() => null)
            || publishChecklist(d.product.blockers || [], { unknown: ['store', 'quota', 'shelf', 'site', 'brand', 'title', 'fields', 'colour', 'attributes', 'size_chart', 'sizes', 'prices', 'photos', 'skus'] });
          checklistFrom = { readiness: true };
        }
      }
      return send(res, 200, { ok: true, product: productOut(d.product), variants: d.variants.map(variantOut), canWrite, isAdmin, checklist, checklistFrom,
        jobItems: items.map((i) => ({ ...(isAdmin ? i : { ...i, body: undefined, response: undefined }), summary: summarizePlan(i.plan) || i.error || null })),
        log: log.map((l) => (isAdmin ? l : { ...l, request: undefined, response: undefined })) });
    }
    const status = t(qs.get('status'), 20) || '';
    if (status && status !== 'all' && !STATUS_CODES.includes(status)) return send(res, 400, { ok: false, error: 'Unknown status.' });
    const blocker = t(qs.get('blocker'), 40);
    if (blocker && !/^[a-z_]+$/.test(blocker)) return send(res, 400, { ok: false, error: 'Unknown blocker.' });
    const sort = ['worst', 'title', 'updated', 'coverage'].includes(qs.get('sort')) ? qs.get('sort') : 'worst';
    const [st, list, summary] = await Promise.all([
      sheinStatus().catch(() => null),
      listListingProducts({ status, blocker, q: t(qs.get('q'), 120), brand: t(qs.get('brand'), 120), page: Number(qs.get('page')) || 1, pageSize: Number(qs.get('pageSize')) || 50, sort }),
      summaryOut(),
    ]);
    return send(res, 200, { ok: true, connected: !!st?.connected, configured: !!st?.configured, canWrite, isAdmin, summary,
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
        if (!ops.length || ops.some((o) => !PREVIEW_OPS.includes(o)) || (ops.includes('add_sku') && ops.length > 1) || (ops.includes('publish') && ops.length > 1)) return send(res, 400, { ok: false, error: 'ops: ["add_sku"], "price" and/or "edit", or ["publish"] — never mixed.' });
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
        if (b.usePhPhotos !== undefined) patch.usePhPhotos = b.usePhPhotos === true;
        const row = await setListingPublishChoices(pid, patch);
        if (!row) return send(res, 404, { ok: false, error: 'That product isn’t in SHEIN Listings.' });
        return send(res, 200, { ok: true, product: productOut(row) });
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
