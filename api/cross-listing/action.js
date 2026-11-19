// POST /api/cross-listing/action
//   { action: 'qty',   poolId, qty }                 set the pairs of a size (not below sold); a cut takes extras down
//   { action: 'cost',  poolId, cost }                the cost of a pair ('' clears it)
//   { action: 'price', poolId, groupSkuId, price }   reprice one SKU's open listings for a size
//   { action: 'list',  poolId, groupSkuId, price, activate }   list a SKU up to the pairs left
//   { action: 'down',  poolId, groupSkuId? }         take down every open listing of a size (or of one SKU)
// docs/context/alias-cross-listing.md.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { dbConfigured, getCrossPool, setCrossPool, getCrossGroupSkus } from '../_lib/db.js';
import { aliasListingKey } from '../_lib/alias.js';
import { topUpSku, reconcilePool, repriceSku } from '../_lib/cross.js';
import { priceCents, costValue, MAX_PAIRS } from '../../src/lib/crossListing.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse', 'ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const b = await getJsonBody(req);
  const actor = user.name || user.username || null;
  const action = String(b.action || '');
  const poolId = Number(b.poolId);
  if (!Number.isInteger(poolId) || poolId < 1) return send(res, 400, { ok: false, error: 'Which size?' });
  const pool = await getCrossPool(poolId);
  if (!pool) return send(res, 404, { ok: false, error: 'That size is no longer in the group.' });

  if (action === 'cost') {
    const cost = costValue(b.cost);
    if (Number.isNaN(cost)) return send(res, 400, { ok: false, error: 'The cost is not an amount.' });
    await setCrossPool(poolId, { unitCost: cost }, actor);
    return send(res, 200, { ok: true });
  }
  if (action === 'qty') {
    const qty = Number(b.qty);
    if (!Number.isInteger(qty) || qty < 0 || qty > MAX_PAIRS) return send(res, 400, { ok: false, error: `Pairs has to be a whole number from 0 to ${MAX_PAIRS}.` });
    if (qty < Number(pool.sold)) return send(res, 409, { ok: false, error: `${pool.sold} already sold — the pairs can't go below that.` });
    if (!(await setCrossPool(poolId, { qty }, actor))) return send(res, 409, { ok: false, error: 'A sale just came in for this size — reload and try again.' });
    const removed = qty < Number(pool.qty) ? await reconcilePool(poolId, actor, 'qty_cut') : [];
    return send(res, 200, { ok: true, removed });
  }
  if (action === 'down') {
    const groupSkuId = Number(b.groupSkuId) > 0 ? Number(b.groupSkuId) : null;
    const removed = await reconcilePool(poolId, actor, 'user', undefined, { all: true, groupSkuId });
    return send(res, 200, { ok: true, removed });
  }
  const groupSku = (await getCrossGroupSkus(pool.group_id)).find((k) => Number(k.id) === Number(b.groupSkuId));
  if (!groupSku) return send(res, 400, { ok: false, error: 'Which SKU?' });
  const cents = priceCents(b.price);
  if (Number.isNaN(cents)) return send(res, 400, { ok: false, error: 'The price has to be from $1 to $100,000.' });
  if (!aliasListingKey()) return send(res, 503, { ok: false, error: 'Alias listing is not configured on the server.' });
  if (action === 'price') return send(res, 200, { ok: true, ...(await repriceSku(poolId, groupSku.id, cents, actor)) });
  if (action === 'list') {
    const sizeValue = Number(groupSku.sizes?.[pool.size]);
    if (!Number.isFinite(sizeValue) || sizeValue <= 0) return send(res, 400, { ok: false, error: `${groupSku.sku} is not made in size ${pool.size} on Alias.` });
    return send(res, 200, { ok: true, ...(await topUpSku(pool, groupSku, { sizeValue, priceCents: cents, active: b.activate !== false }, actor)) });
  }
  return send(res, 400, { ok: false, error: 'Unknown action.' });
}
