// GET  /api/presell-listings/fulfill?view=to_ship|shipped|cancelled&q=
//      -> { ok, rows:[…], counts, lastPass, watching }
// POST /api/presell-listings/fulfill { action: 'sync' }  re-read every open order now
// Pre-sell fulfilment (docs/context/presell-fulfillment.md): the orders still to ship, with the
// label each platform made at the sale, tracking and the ship-by deadline — the pick list.
// The sync only READS the marketplaces, so "Check now" works on any environment.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { dbConfigured, listPresellFulfill } from '../_lib/db.js';
import { syncFulfillment, fulfillLastPass } from '../_lib/presell-fulfill.js';
import { arrivalsEnabled } from '../_lib/presell-arrival.js';

const VIEWS = new Set(['to_ship', 'shipped', 'cancelled']);
const WAIT_MS = 20_000;   // answer with the result when a pass is quick; else it finishes on its own

export default async function handler(req, res) {
  applySecurity(req, res);
  if (!requireRole(req, res, ['warehouse', 'ph_team'])) return;   // admin auto-allowed
  if (!rateLimit(req, { windowMs: 60_000, max: 90 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  try {
    if (req.method === 'POST') {
      const b = await getJsonBody(req);
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
    return send(res, 200, { ok: true, ...out, lastPass: fulfillLastPass(), watching: arrivalsEnabled() });
  } catch (e) {
    console.error('[presell-listings/fulfill]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load the orders to ship.' });
  }
}
