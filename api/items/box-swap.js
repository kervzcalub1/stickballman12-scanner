// GET  /api/items/box-swap?q=<sku|upc>      -> { ok, rows }            the pairs waiting
// POST /api/items/box-swap { itemId? | upc? | sku+size?, vin? }  -> { ok, item, from }
//
// BOX SWAP PENDING (docs/context/no-box.md "Box swap", Brent 2026-11-03). Pairs that came
// in with no box are received as `box_swap` so the order can be checked (Kevin's audit),
// with no sticker and nowhere near the PH team. When the box is ready they come here:
// scan the shoe (UPC) or pick it from the list, then scan the VIN sticker going on it —
// the same two beats as intake. The pair takes that sticker's number, is boxed, and goes
// to Needs Shelf; only then does PH see it. No sticker = keep the system VIN and print it.
// Warehouse/admin only.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { listBoxSwapItems, swapBoxPair, dbConfigured } from '../_lib/db.js';
import { duplicateVin } from '../_lib/vins.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET' && req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 240 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  try {
    if (req.method === 'GET') {
      const q = new URL(req.url, 'http://x').searchParams.get('q') || '';
      return send(res, 200, { ok: true, rows: await listBoxSwapItems(q.slice(0, 60)) });
    }
    const body = await getJsonBody(req);
    const out = await swapBoxPair({
      itemId: Number.isInteger(Number(body.itemId)) && body.itemId != null ? Number(body.itemId) : null,
      upc: String(body.upc || '').replace(/\D/g, '').slice(0, 14) || null,
      sku: String(body.sku || '').trim().slice(0, 60) || null,
      size: body.size == null ? null : String(body.size).trim().slice(0, 24),
      vin: String(body.vin || '').trim().slice(0, 40) || null,
      by: user.name || user.username || null,
    });
    if (out.error) return send(res, out.code || 400, { ok: false, error: out.error });
    return send(res, 200, { ok: true, item: out.item, from: out.from });
  } catch (e) {
    // Two people putting the same sticker on two pairs in the same second: the unique
    // index catches the second.
    if (duplicateVin(e)) return send(res, 409, { ok: false, error: 'That sticker was just put on another pair — use a fresh one.' });
    console.error('[items/box-swap]', e.message);
    return send(res, 500, { ok: false, error: 'Could not record the box swap.' });
  }
}
