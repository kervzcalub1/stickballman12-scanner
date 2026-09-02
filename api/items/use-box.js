// POST /api/items/use-box  (warehouse / admin)  { vin, boxVin? , boxId? }
//   -> { ok, boxVin, pairVin }
// Put an EMPTY SHOE BOX from stock onto a pair that arrived without one (or with a
// crushed one). The pair becomes sellable exactly as "Box found" already made it; the
// box row is spent and marked `used`, terminal, with the link recorded on BOTH rows.
//
// This is the whole reason empty boxes are bought, and the reason they are `items` rows
// rather than a quantity: "what happened to the 40 boxes we ordered" has an answer.
//
// GET /api/items/use-box?sku=&size=  -> { ok, boxes } — what's on the shelf that fits.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { getItemByVin, findAvailableBoxes, useBoxOnItem, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  const user = requireRole(req, res, ['warehouse']);
  if (!user) return;
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  // Which boxes on the shelf fit this pair.
  if (req.method === 'GET') {
    if (!rateLimit(req, { windowMs: 60_000, max: 120 }))
      return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
    const url = new URL(req.url, 'http://x');
    const sku = String(url.searchParams.get('sku') || '').trim() || null;
    const size = String(url.searchParams.get('size') || '').trim() || null;
    try {
      return send(res, 200, { ok: true, boxes: await findAvailableBoxes({ sku, size }) });
    } catch (e) {
      console.error('[items/use-box:list]', e.message);
      return send(res, 500, { ok: false, error: 'Could not look up the box stock.' });
    }
  }

  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!rateLimit(req, { windowMs: 60_000, max: 120 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });

  const body = await getJsonBody(req);
  const vin = String(body.vin || '').trim().toUpperCase();
  const boxVin = String(body.boxVin || '').trim().toUpperCase();
  const boxId = Number.isInteger(Number(body.boxId)) && Number(body.boxId) > 0 ? Number(body.boxId) : null;
  if (!vin) return send(res, 400, { ok: false, error: 'Which pair is getting the box?' });
  if (!boxVin && !boxId) return send(res, 400, { ok: false, error: 'Pick a box from stock.' });

  try {
    const pair = await getItemByVin(vin);
    if (!pair) return send(res, 404, { ok: false, error: `No item found for ${vin}.` });
    let id = boxId;
    if (!id) {
      const box = await getItemByVin(boxVin);
      if (!box) return send(res, 404, { ok: false, error: `No empty box found for ${boxVin}.` });
      id = Number(box.item.id);
    }
    // Guard the obvious mis-scan: the two barcodes look identical, and a shoe boxed
    // "with itself" would silently spend nothing and mark the pair sellable.
    if (Number(pair.item.id) === id)
      return send(res, 400, { ok: false, error: 'That is the same unit scanned twice — scan the pair, then the box.' });

    const r = await useBoxOnItem({ boxId: id, itemId: Number(pair.item.id), createdBy: user.name || user.username || '' });
    if (r.error) return send(res, 409, { ok: false, error: r.error });
    return send(res, 200, { ok: true, ...r, ...(await getItemByVin(vin)) });
  } catch (e) {
    console.error('[items/use-box]', e.message);
    return send(res, 500, { ok: false, error: 'Could not put that box on the pair.' });
  }
}
