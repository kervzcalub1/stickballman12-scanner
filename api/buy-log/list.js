// GET /api/buy-log/list?q=&from=&to=          -> { ok, buys:[shapeBuy], can:{ edit, pay }, suppliers? }
// GET /api/buy-log/list?id=                   -> { ok, buy, pos:[the supplier's POs it can link to] }
// The Buy Log (docs/context/buy-log.md): what a supplier bought from a store that gives no
// receipt — declared lines, payments, linked POs, ordered vs shipped vs received. Read-only.
import { send, applySecurity, rateLimit } from '../_lib/util.js';
import { dbConfigured, listBuyLogs, listPosForBuyLog, listBuyLogSuppliers } from '../_lib/db.js';
import { shapeBuy } from '../../src/lib/buyLog.js';
import { buyLogUser, isSupplier, canManage, idOf, realDate } from './_shared.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = await buyLogUser(req, res);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const p = new URL(req.url, 'http://x').searchParams;
  const scope = isSupplier(user) ? Number(user.uid) : null;
  const can = { edit: isSupplier(user) || canManage(user), pay: canManage(user), all: !isSupplier(user) };
  try {
    const id = idOf(p.get('id'));
    if (p.has('id')) {
      if (!id) return send(res, 400, { ok: false, error: 'Which order?' });
      const rows = await listBuyLogs({ supplierUserId: scope, id, limit: 1 });
      if (!rows[0]) return send(res, 404, { ok: false, error: 'That order no longer exists.' });
      const buy = shapeBuy(rows[0]);
      const pos = await listPosForBuyLog({ supplierUserId: buy.supplier_user_id, supplierName: buy.supplier_name });
      return send(res, 200, { ok: true, buy, can, pos: pos.map((o) => ({ ...o, po_id: Number(o.po_id) })) });
    }
    const q = String(p.get('q') || '').trim().slice(0, 80);
    const filtered = q || p.get('from') || p.get('to');
    const rows = await listBuyLogs({ supplierUserId: scope, q, from: realDate(p.get('from')), to: realDate(p.get('to')), limit: filtered ? 2000 : 500 });
    const suppliers = can.all && can.edit ? (await listBuyLogSuppliers()).map((s) => ({ id: Number(s.id), name: s.name })) : undefined;
    return send(res, 200, { ok: true, buys: rows.map(shapeBuy), can, suppliers });
  } catch (e) {
    console.error('[buy-log/list]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load the buy log.' });
  }
}
