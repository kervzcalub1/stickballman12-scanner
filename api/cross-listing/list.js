// GET /api/cross-listing/list -> { ok, groups:[{ id, name, skus, pools:[{ …, listings }] }], sales, chatSet, canSettings }
// Everything the Alias Cross-Listing page shows, from our own tables.
import { send, applySecurity, rateLimit, requireRole, isPrivileged } from '../_lib/util.js';
import { dbConfigured, listCrossAll, userHasPrivilege } from '../_lib/db.js';
import { crossChatId } from '../_lib/cross.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse', 'ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const d = await listCrossAll();
  const groups = d.groups.map((g) => ({
    id: Number(g.id), name: g.name, created_by: g.created_by, created_at: g.created_at,
    skus: d.skus.filter((k) => Number(k.group_id) === Number(g.id)).map((k) => ({ id: Number(k.id), sku: k.sku, catalogId: k.catalog_id, name: k.name, image: k.image, sizes: k.sizes || {} })),
    pools: d.pools.filter((p) => Number(p.group_id) === Number(g.id)).map((p) => ({
      id: Number(p.id), size: p.size, qty: Number(p.qty), sold: Number(p.sold), unit_cost: p.unit_cost == null ? null : Number(p.unit_cost),
      listings: d.listings.filter((l) => Number(l.pool_id) === Number(p.id)).map((l) => ({ id: Number(l.id), groupSkuId: Number(l.group_sku_id), price_cents: Number(l.price_cents), status: l.status, last_error: l.last_error })),
    })),
  }));
  const canSettings = isPrivileged(user.role) || await userHasPrivilege(user.uid, 'manage_access').catch(() => false);
  return send(res, 200, { ok: true, groups, sales: d.sales, chatSet: !!(await crossChatId()), canSettings });
}
