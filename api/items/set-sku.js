// GET  /api/items/set-sku?vin=…                          -> { ok, item, siblings }
// POST /api/items/set-sku { vin, sku, scope, product?, reason? } -> { ok, updated, listed, item, events }
//
// Correct the STYLE CODE on a pair that was scanned in under the wrong one.
//
// Why this exists: a box's UPC does not always name one style code for ever. Jordan
// re-coded 553558-100 to 553558-136 in 2022 for some sizes and kept the same UPC on
// the box (196149780863, size 10.5), so a scan of that barcode resolves to -100 through
// the catalogue while the shoe in the box is -136. The warehouse can see the code on the
// box label; the API cannot. Nothing else on the unit is wrong — the VIN, the UPC, the
// size, the cost, where it sits — so the fix is one field, not a re-receive.
//
// `scope`: 'one' fixes this VIN; 'same_upc' fixes every unit that was scanned in under
// the same wrong code AND the same size AND the same box UPC (that is the set the
// catalogue got wrong the same way — six pairs of one size in one delivery), never a
// different size, which may genuinely still be -100. 'same_box' fixes every pair of this
// code in this box, every size — the Edit box scope, for a carton whose one shoe went in
// under the wrong code. GET reports how many each would be before anyone commits to it.
//
// The name / colorway / image travel with the code when the caller looked the new one
// up (`product`), because a -136 under a -100's name is half a fix. A unit already
// LISTED to a store under the old code is corrected here too — our record has to be
// right — but the response counts them (`listed`), because the listing on the store
// still carries the old code and PH has to fix that by hand.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { getItemByVin, findSkuSiblings, findSkuBoxSiblings, setItemsSku, dbConfigured } from '../_lib/db.js';

const SKU_RE = /^[A-Z0-9][A-Z0-9 \-./]{1,39}$/;
const clean = (v, n) => String(v ?? '').trim().slice(0, n) || null;

export default async function handler(req, res) {
  applySecurity(req, res);
  if (!['GET', 'POST'].includes(req.method)) return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse', 'ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = req.method === 'POST' ? await getJsonBody(req) : {};
  const vin = String(req.method === 'GET'
    ? new URL(req.url, 'http://x').searchParams.get('vin') || ''
    : body.vin || '').trim().toUpperCase();
  if (!vin) return send(res, 400, { ok: false, error: 'Missing VIN.' });

  try {
    const found = await getItemByVin(vin);
    if (!found) return send(res, 404, { ok: false, error: `No item found for ${vin}.` });
    const item = found.item;
    const siblings = await findSkuSiblings(item);
    const boxSiblings = await findSkuBoxSiblings(item);

    if (req.method === 'GET') {
      return send(res, 200, {
        ok: true,
        item: { vin: item.vin, sku: item.sku, size: item.size, upc: item.upc },
        siblings: siblings.filter((s) => s.vin !== item.vin).map((s) => ({ vin: s.vin, status: s.status, listed: s.listed })),
        boxSiblings: boxSiblings.filter((s) => s.vin !== item.vin).map((s) => ({ vin: s.vin, status: s.status, listed: s.listed })),
      });
    }

    const sku = String(body.sku || '').trim().toUpperCase();
    if (!SKU_RE.test(sku)) return send(res, 400, { ok: false, error: 'Enter the style code as it appears on the box (e.g. 553558-136).' });
    if (sku === String(item.sku || '').toUpperCase())
      return send(res, 400, { ok: false, error: `This pair is already ${sku}.` });
    const scope = ['same_upc', 'same_box'].includes(body.scope) ? body.scope : 'one';
    const targets = scope === 'same_upc' ? siblings
      : scope === 'same_box' ? (boxSiblings.length ? boxSiblings : siblings.filter((s) => s.vin === item.vin))
        : siblings.filter((s) => s.vin === item.vin);

    const p = body.product && typeof body.product === 'object' ? body.product : null;
    const product = p ? {
      name: clean(p.name, 200),
      colorway: clean(p.colorway, 120),
      gender: clean(p.gender, 20),
      image_url: clean(p.image, 500) || clean(p.image_url, 500),
    } : null;

    const rows = await setItemsSku(
      targets.map((t) => t.id), { from: item.sku, to: sku, product, reason: clean(body.reason, 300) },
      user.name || user.username || '',
    );
    const updated = await getItemByVin(vin);
    return send(res, 200, {
      ok: true,
      updated: rows.length,
      listed: targets.filter((t) => t.listed).length,
      ...updated,
    });
  } catch (e) {
    console.error('[items/set-sku]', e.message);
    return send(res, 500, { ok: false, error: 'Could not change the style code.' });
  }
}
