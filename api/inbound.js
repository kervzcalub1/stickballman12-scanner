// GET /api/inbound  ->  { ok, boxes }
//
// The day's inbound feed: every box on an order that is not yet reconciled or closed,
// with whatever the courier last told us. Read-only, and it fetches nothing from
// 17TRACK — the webhook has already written all of this, so opening the screen costs
// one query and no quota.
//
// Classification (in transit / delayed / investigate / …) deliberately lives in
// src/lib/inbound.js rather than here: the screen, its summary strip and the Home
// tile all have to agree, and the surest way to make them agree is one function.
import { send, applySecurity, rateLimit, requireRole } from './_lib/util.js';
import { listInboundBoxes, dbConfigured } from './_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  // PH raise the orders and field the supplier's "did it arrive?", so they see it too.
  if (!requireRole(req, res, ['warehouse', 'ph_team'])) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  try {
    return send(res, 200, { ok: true, boxes: await listInboundBoxes() });
  } catch (e) {
    console.error('[inbound]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load the inbound feed.' });
  }
}
