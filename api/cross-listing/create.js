// POST /api/cross-listing/create
//   { groupId? | name, skus:[{ catalogId, sku, name?, image? }],
//     activate, lines:[{ size, qty, cost?, skus:[{ catalogId, price }] }] }   (skus carry sizes:[{label,value}] on a new group)
//   -> { ok, groupId, lines:[{ size, poolId, skus:[{ sku, wanted, created, errors }] }], created, failed }
// Alias Cross-Listing (docs/context/alias-cross-listing.md): `qty` pairs are ADDED to the
// group's pool for that size, then each priced SKU is listed up to the pairs left. Prices
// are whole US dollars; the cost is per pair, for the net on the sale post.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { dbConfigured, createCrossGroup, crossGroupExists, getCrossGroupSkus, upsertCrossPool } from '../_lib/db.js';
import { aliasListingKey } from '../_lib/alias.js';
import { topUpSku } from '../_lib/cross.js';
import { priceCents, costValue, skuText, MAX_SKUS, MAX_PAIRS, MAX_NEW_LISTINGS } from '../../src/lib/crossListing.js';

const text = (v, max) => { const t = String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max); return t || null; };

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse', 'ph_team']); // admin auto-allowed
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 20 })) return send(res, 429, { ok: false, error: 'Please wait a moment before listing again.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const b = await getJsonBody(req);
  const actor = user.name || user.username || null;

  // The group: an existing one (adding pairs / sizes), or the SKUs just ticked.
  let groupId = Number(b.groupId) > 0 ? Number(b.groupId) : null;
  let picked = null;
  if (groupId) {
    if (!(await crossGroupExists(groupId))) return send(res, 404, { ok: false, error: 'That shoe group no longer exists.' });
  } else {
    picked = [];
    const seen = new Set();
    for (const k of Array.isArray(b.skus) ? b.skus : []) {
      const catalogId = text(k?.catalogId, 200); const sku = skuText(k?.sku).slice(0, 60);
      if (!catalogId || !sku || seen.has(catalogId)) continue;
      seen.add(catalogId);
      // label → the number Alias wants on a listing ("5Y" → 5), kept so a size can be listed later.
      const sizes = {};
      for (const z of Array.isArray(k?.sizes) ? k.sizes.slice(0, 80) : []) {
        const label = text(z?.label, 12); const value = Number(z?.value);
        if (label && Number.isFinite(value) && value > 0) sizes[label] = value;
      }
      picked.push({ catalogId, sku, name: text(k?.name, 200), image: text(k?.image, 500), sizes });
    }
    if (picked.length < 2) return send(res, 400, { ok: false, error: 'Pick at least 2 SKUs of the same shoe — one SKU is a normal listing.' });
    if (picked.length > MAX_SKUS) return send(res, 400, { ok: false, error: `At most ${MAX_SKUS} SKUs in one group.` });
    if (!text(b.name, 120)) return send(res, 400, { ok: false, error: 'Give the shoe group a name.' });
  }

  const lines = [];
  const sizes = new Set();
  let listings = 0;
  for (const l of Array.isArray(b.lines) ? b.lines : []) {
    const size = text(l?.size, 12);
    const qty = Number(l?.qty);
    if (!size) return send(res, 400, { ok: false, error: 'Every line needs a size.' });
    if (sizes.has(size)) return send(res, 400, { ok: false, error: `Size ${size} is in the list twice.` });
    sizes.add(size);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_PAIRS) return send(res, 400, { ok: false, error: `Size ${size}: pairs has to be a whole number from 1 to ${MAX_PAIRS}.` });
    const cost = costValue(l?.cost);
    if (Number.isNaN(cost)) return send(res, 400, { ok: false, error: `Size ${size}: the cost is not an amount.` });
    const skus = [];
    for (const k of Array.isArray(l?.skus) ? l.skus : []) {
      const catalogId = text(k?.catalogId, 200);
      const cents = priceCents(k?.price);
      if (!catalogId) continue;
      if (Number.isNaN(cents)) return send(res, 400, { ok: false, error: `Size ${size}: every SKU you list needs a price from $1 to $100,000.` });
      skus.push({ catalogId, cents });
    }
    if (skus.length < 2) return send(res, 400, { ok: false, error: `Size ${size}: price at least 2 SKUs — cross-listing needs the pair on more than one.` });
    listings += qty * skus.length;
    lines.push({ size, qty, cost, skus });
  }
  if (!lines.length) return send(res, 400, { ok: false, error: 'Add pairs for at least one size.' });
  if (listings > MAX_NEW_LISTINGS) return send(res, 400, { ok: false, error: `That is ${listings} Alias listings — at most ${MAX_NEW_LISTINGS} at a time. List fewer sizes, then add the rest.` });
  if (!aliasListingKey()) return send(res, 503, { ok: false, error: 'Alias listing is not configured on the server.' });

  const out = [];
  try {
    if (!groupId) groupId = await createCrossGroup({ name: text(b.name, 120), skus: picked }, actor);
    const groupSkus = await getCrossGroupSkus(groupId);
    const byCat = new Map(groupSkus.map((k) => [k.catalog_id, k]));
    for (const l of lines) {
      for (const k of l.skus) {
        const g = byCat.get(k.catalogId);
        if (!g) return send(res, 400, { ok: false, error: `Size ${l.size}: a SKU that is not in this group.`, groupId, lines: out });
        k.sizeValue = Number(g.sizes?.[l.size]);
        if (!Number.isFinite(k.sizeValue) || k.sizeValue <= 0) return send(res, 400, { ok: false, error: `${g.sku} is not made in size ${l.size} on Alias — clear its price for that size.`, groupId, lines: out });
      }
    }
    for (const l of lines) {
      const pool = await upsertCrossPool({ groupId, size: l.size, addQty: l.qty, unitCost: l.cost }, actor);
      const row = { size: l.size, poolId: Number(pool.id), skus: [] };
      out.push(row);
      for (const k of l.skus) {
        const g = byCat.get(k.catalogId);
        const r = await topUpSku(pool, g, { sizeValue: k.sizeValue, priceCents: k.cents, active: b.activate !== false }, actor);
        row.skus.push({ sku: g.sku, ...r });
      }
    }
  } catch (e) {
    console.error('[cross-listing/create]', e.message);
    return send(res, 500, { ok: false, error: 'Could not finish listing — check the Listed tab for what went through.', groupId, lines: out });
  }
  const all = out.flatMap((r) => r.skus);
  return send(res, 200, { ok: true, groupId, lines: out, created: all.reduce((n, k) => n + k.created, 0), failed: all.reduce((n, k) => n + k.errors.length, 0) });
}
