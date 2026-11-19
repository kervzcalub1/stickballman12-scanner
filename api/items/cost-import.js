// POST /api/items/cost-import
//   { rows: [{ sku, supplier?, cost }], bySupplier?, from?, to?, supplier?, mode?: 'zero', apply?: true }
//   -> { ok, applied, skus, pairs, matched: [{ sku, supplier, cost, pairs }], unmatched: [{ sku, supplier }] }
// bySupplier: each row's cost goes only to the pairs from the row's supplier ('' = pairs
// with no supplier). Without it a SKU is filled whoever it came from.
// The Costs export, filled in and uploaded back (docs/context/costs.md). One cost per SKU,
// written to every pair of it that the SAME filters as the list hold (dates, supplier, the
// blank / $0 tab). Without `apply` it is a preview and writes nothing. Only a blank cost is
// filled (or a $0 on that tab); a cost already on file is never overwritten.
// Same people as set-cost: admin + warehouse + PH.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { costImport, dbConfigured } from '../_lib/db.js';
import { skuKey, COST_IMPORT_MAX } from '../../src/lib/costs.js';

const ymd = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse', 'ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 30 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const list = Array.isArray(body.rows) ? body.rows : [];
  if (!list.length) return send(res, 400, { ok: false, error: 'No costs in that file.' });
  if (list.length > COST_IMPORT_MAX) return send(res, 400, { ok: false, error: `At most ${COST_IMPORT_MAX} SKUs at a time.` });
  // The browser already read the file with the same rules; nothing it sends is trusted.
  const bySupplier = body.bySupplier === true;
  const byKey = new Map();
  for (const r of list) {
    const bare = skuKey(r?.sku);
    const supplier = bySupplier ? String(r?.supplier ?? '').trim().slice(0, 200) : '';
    const key = `${bare}|${supplier.toLowerCase()}`;
    const cost = Math.round(Number(r?.cost) * 100) / 100;
    if (!bare || !Number.isFinite(cost) || cost <= 0 || cost > 100000)
      return send(res, 400, { ok: false, error: `“${String(r?.sku ?? '').slice(0, 60)}” has no usable cost.` });
    if (byKey.has(key) && byKey.get(key).cost !== cost)
      return send(res, 400, { ok: false, error: `${String(r.sku).slice(0, 60)} is in the file twice with two different costs.` });
    byKey.set(key, { sku: String(r.sku).trim().slice(0, 80), supplier, bare, cost });
  }
  const keys = [...byKey.keys()];
  const apply = body.apply === true;
  try {
    const hit = await costImport({
      keys: keys.map((k) => byKey.get(k).bare), costs: keys.map((k) => byKey.get(k).cost),
      sups: bySupplier ? keys.map((k) => byKey.get(k).supplier.toLowerCase()) : null,
      from: ymd(body.from), to: ymd(body.to), zero: body.mode === 'zero',
      supplier: String(body.supplier || '').trim().slice(0, 200) || null,
      apply, by: user.name || user.username || '',
    });
    const pairsOf = new Map(hit.map((r) => [`${r.key}|${r.sup || ''}`, Number(r.pairs)]));
    const out = (k) => ({ sku: byKey.get(k).sku, supplier: byKey.get(k).supplier, cost: byKey.get(k).cost });
    const matched = keys.filter((k) => pairsOf.get(k)).map((k) => ({ ...out(k), pairs: pairsOf.get(k) }));
    const unmatched = keys.filter((k) => !pairsOf.get(k)).map((k) => ({ sku: byKey.get(k).sku, supplier: byKey.get(k).supplier }));
    return send(res, 200, { ok: true, applied: apply, skus: new Set(matched.map((m) => skuKey(m.sku))).size, pairs: matched.reduce((n, m) => n + m.pairs, 0), matched, unmatched });
  } catch (e) {
    console.error('[items/cost-import]', e.message);
    return send(res, 500, { ok: false, error: 'Could not read the costs.' });
  }
}
