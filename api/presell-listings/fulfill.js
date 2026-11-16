// GET  /api/presell-listings/fulfill?view=to_ship|shipped|cancelled&q=
//      -> { ok, rows:[…], counts, lastPass, watching }
// POST /api/presell-listings/fulfill { action: 'sync' }  re-read every open order now
// POST /api/presell-listings/fulfill { action: 'mark', ids, step: 'printed' | 'packed', on }
//      -> { ok, changed }   what the WAREHOUSE did with the order — on our side only, nothing
//      is sent to a marketplace (monitoring, owner 2026-11-17)
// Pre-sell fulfilment (docs/context/presell-fulfillment.md): the orders still to ship, with the
// label each platform made at the sale, tracking and the ship-by deadline — the pick list.
// The sync only READS the marketplaces, so "Check now" works on any environment.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { dbConfigured, listPresellFulfill, presellBoxesFor, markPresellSalesProgress } from '../_lib/db.js';
import { syncFulfillment, fulfillLastPass } from '../_lib/presell-fulfill.js';
import { arrivalsEnabled } from '../_lib/presell-arrival.js';

const VIEWS = new Set(['to_ship', 'shipped', 'cancelled', 'unknown']);
const WAIT_MS = 20_000;   // answer with the result when a pass is quick; else it finishes on its own

export default async function handler(req, res) {
  applySecurity(req, res);
  const user = requireRole(req, res, ['warehouse', 'ph_team']);   // admin auto-allowed
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 90 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  try {
    if (req.method === 'POST') {
      const b = await getJsonBody(req);
      if (b.action === 'mark') {
        const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
        if (!ids.length || ids.length > 500) return send(res, 400, { ok: false, error: 'Pick between 1 and 500 orders.' });
        if (!['printed', 'packed'].includes(b.step)) return send(res, 400, { ok: false, error: 'Printed or packed?' });
        const changed = await markPresellSalesProgress(ids, b.step, b.on !== false, user.name || user.username || null);
        return send(res, 200, { ok: true, changed });
      }
      if (b.action !== 'sync') return send(res, 400, { ok: false, error: 'Unknown action.' });
      const pass = syncFulfillment({ force: true });
      pass.catch((e) => console.error('[presell-fulfill] check now', e.message));
      const done = await Promise.race([pass, new Promise((r) => setTimeout(() => r(null), WAIT_MS))]);
      return send(res, 200, { ok: true, done: !!done, lastPass: done || fulfillLastPass() });
    }
    if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
    const p = new URL(req.url, 'http://x').searchParams;
    const view = VIEWS.has(p.get('view')) ? p.get('view') : 'to_ship';
    const q = String(p.get('q') || '').trim().slice(0, 80) || null;
    const out = await listPresellFulfill({ view, q, limit: view === 'to_ship' ? 2000 : 500 });
    // The boxes each row's pairs are in, so an order waiting on the truck can name its box
    // (docs/presell-box-tracking-plan.md). Best-effort: the pick list works without it.
    if (view === 'to_ship' && out.rows?.length) {
      try {
        const stock = [...new Map(out.rows.filter((x) => x.stock_id != null).map((x) => [Number(x.stock_id), { id: x.stock_id, sku: x.sku, size: x.size }])).values()];
        const boxes = await presellBoxesFor(stock);
        out.rows = out.rows.map((x) => ({ ...x, boxes: boxes.get(Number(x.stock_id))?.boxes || [] }));
      } catch (e) { console.error('[presell-listings/fulfill] boxes:', e.message); }
    }
    return send(res, 200, { ok: true, ...out, lastPass: fulfillLastPass(), watching: arrivalsEnabled() });
  } catch (e) {
    console.error('[presell-listings/fulfill]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load the orders to ship.' });
  }
}
