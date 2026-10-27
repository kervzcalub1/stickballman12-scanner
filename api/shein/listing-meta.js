// GET /api/shein/listing-meta — SHEIN's publishing rules as we last read them (SHEIN Listings Phase 4,
// docs/context/shein-listings.md → Phase 4). PH + admin read the cache; `refresh=1` (admin / Connect
// integrations) re-reads from SHEIN. Every call here is a SHEIN READ (logged); nothing is written.
//   ?category=<leaf id>  -> { ok, category: {categoryId, productTypeId, path} | null, fill, template, permissions, readAt }
//   ?tree=1              -> { ok, leaves: [{categoryId, productTypeId, path}] | null, readAt }
//   ?brands=1            -> { ok, brands: [{brand_code, brand_name}] | null, readAt }
//   ?gates=1             -> { ok, gates: {perm, quota, shelf, site, warehouse} }   (refresh=1 → fresh)
//   ?suggest=<productId> -> { ok, suggestions: [{categoryId, order, vote, path}] }  (image-category-suggestion, a read;
//                           cached per product 10 min, ≤ 10 SHEIN asks a minute per user → 429)
import { send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { dbConfigured, getListingCache, setListingCache, getListingProduct } from '../_lib/db.js';
import { hasPrivilege } from '../_lib/buycart.js';
import { IO, userThrottle } from '../_lib/shein-listing.js';
import { treeLeaves, categoryTree, brandList, fillFor, templateFor, publishGates } from '../_lib/shein-publish.js';
import { templateParts } from '../../src/lib/sheinPublish.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  const user = requireRole(req, res, ['ph_team']);
  if (!user) return;
  const qs = new URL(req.url, 'http://x').searchParams;
  const refresh = qs.get('refresh') === '1';
  const admin = user.role === 'admin' || user.role === 'superadmin';
  if (refresh && !admin && !(await hasPrivilege(user, 'connect_integrations'))) return send(res, 403, { ok: false, error: 'Re-reading SHEIN needs an admin, or the “Connect integrations” privilege.' });
  if (!rateLimit(req, { windowMs: 60_000, max: 60 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const by = user.name || user.username || '';
  const log = { source: 'listing-meta', by, dry: true };
  const readAt = async (kind, key) => (await getListingCache(kind, key))?.fetched_at || null;
  try {
    if (qs.get('tree') === '1') {
      const tree = refresh ? await categoryTree(IO, log, true) : (await getListingCache('category_tree', 'store'))?.payload || null;
      return send(res, 200, { ok: true, leaves: tree ? treeLeaves(tree) : null, readAt: await readAt('category_tree', 'store') });
    }
    if (qs.get('brands') === '1') {
      const brands = refresh ? await brandList(IO, log, true) : (await getListingCache('brands', 'store'))?.payload || null;
      return send(res, 200, { ok: true, brands, readAt: await readAt('brands', 'store') });
    }
    if (qs.get('gates') === '1') {
      if (!refresh) {
        const [perm, quota, shelf, site] = await Promise.all(['publish_perm', 'publish_quota', 'shelf_quota', 'site_list'].map((k) => getListingCache(k, 'store')));
        return send(res, 200, { ok: true, gates: { perm: perm?.payload ?? null, quota: quota?.payload ?? null, shelf: shelf?.payload ?? null, sites: site?.payload ?? null }, readAt: perm?.fetched_at || null });
      }
      return send(res, 200, { ok: true, gates: await publishGates({ io: IO, log, fresh: true }) });
    }
    if (qs.get('suggest')) {
      const d = await getListingProduct(String(qs.get('suggest')).slice(0, 200));
      if (!d) return send(res, 404, { ok: false, error: 'That product isn’t in SHEIN Listings.' });
      const img = d.product.image_url;
      if (!img) return send(res, 400, { ok: false, error: 'This product has no photo for SHEIN to look at.' });
      // security M3: one SHEIN suggestion per product per 10 min (cached, shared with the dry run's cat_suggest) and ≤ 10 a minute per user
      const pid = d.product.shopify_product_id;
      const hit = await getListingCache('cat_suggest', pid);
      let s;
      if (hit && Date.now() - new Date(hit.fetched_at).getTime() < 10 * 60_000) s = hit.payload;
      else {
        const th = userThrottle(user, 'suggest', { windowMs: 60_000, max: 10 });
        if (!th.ok) return send(res, 429, { ok: false, error: `Asked SHEIN a lot just now — try again in ${th.retryInSec} s.` });
        s = await IO.sheinCategorySuggest(img, String(d.product.title || '').slice(0, 1000), log);
        await setListingCache('cat_suggest', pid, s || [], 'listing-meta');
      }
      const tree = (await getListingCache('category_tree', 'store'))?.payload || null;
      const leaves = tree ? new Map(treeLeaves(tree).map((l) => [l.categoryId, l])) : new Map();
      return send(res, 200, { ok: true, suggestions: (s || []).sort((a, b) => (a.order ?? 9) - (b.order ?? 9)).map((x) => ({ categoryId: Number(x.categoryId), order: x.order ?? null, vote: x.vote ?? null, path: leaves.get(Number(x.categoryId))?.path || null })) });
    }
    const categoryId = Number(qs.get('category'));
    if (!Number.isSafeInteger(categoryId) || categoryId < 1) return send(res, 400, { ok: false, error: 'category=<SHEIN leaf id>, or tree=1 / brands=1 / gates=1 / suggest=<productId>.' });
    const tree = refresh ? await categoryTree(IO, log, true) : (await getListingCache('category_tree', 'store'))?.payload || null;
    const leaf = tree ? treeLeaves(tree).find((l) => l.categoryId === categoryId) || null : null;
    const fill = refresh ? await fillFor(categoryId, IO, log, true) : (await getListingCache('fill_standard', categoryId))?.payload || null;
    const ptid = leaf?.productTypeId ?? null;
    const template = ptid ? (refresh ? await templateFor(ptid, IO, log, true) : (await getListingCache('attr_template', ptid))?.payload || null) : null;
    const perms = (await getListingCache('custom_perm', categoryId))?.payload || null;
    const parts = template ? templateParts(template) : null;
    return send(res, 200, { ok: true, category: leaf, fill, template, parts: parts ? { mainStatus: parts.mainStatus, sizeAttributeId: parts.size?.attributeId ?? null, required: parts.product.filter((a) => Number(a.attribute_status) === 3).map((a) => Number(a.attribute_id)), sizeTable: parts.sizeTable.length } : null,
      permissions: perms, readAt: { fill: await readAt('fill_standard', categoryId), template: ptid ? await readAt('attr_template', ptid) : null } });
  } catch (e) {
    return send(res, e.notConnected ? 503 : 502, { ok: false, error: `SHEIN: ${e.message}` });
  }
}
