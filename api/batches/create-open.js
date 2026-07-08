// POST /api/batches/create-open
//   { batch:{ buyer, supplier, dateReceived, defaultCost, notes, specialRules,
//             batchTag, expectedBoxes } } -> { ok, batchCode, id }
// Starts an OPEN multi-box receiving batch (no items yet). Boxes are added and
// committed one at a time from the Batch Page (V6 Feature 7).
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { createOpenBatch, addSupplier, getPo, markPoReceiving, dbConfigured } from '../_lib/db.js';

const cleanName = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 200);
const toCost = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null; };

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 30 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded. Slow down a moment.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const h = body.batch || {};
  const supplier = cleanName(h.supplier);
  if (!supplier) return send(res, 400, { ok: false, error: 'Select a supplier.' });
  const expected = Number(h.expectedBoxes);
  const createdBy = user.name || user.username || '';

  // Optional: this open batch is being received against a purchase order.
  const poId = Number.isInteger(Number(h.poId)) && Number(h.poId) > 0 ? Number(h.poId) : null;
  if (poId) {
    const po = await getPo(poId);
    if (!po) return send(res, 404, { ok: false, error: 'That purchase order was not found.' });
    if (!['shipped', 'receiving'].includes(po.status))
      return send(res, 409, { ok: false, error: `PO ${po.po_code} is ${po.status} — it can't be received against.` });
  }

  const header = {
    buyer: cleanName(h.buyer) || null,
    supplier,
    dateReceived: h.dateReceived || null,
    defaultCost: toCost(h.defaultCost),
    notes: String(h.notes ?? '').trim().slice(0, 2000) || null,
    specialRules: String(h.specialRules ?? '').trim().slice(0, 2000) || null,
    batchTag: String(h.batchTag ?? '').trim().slice(0, 120) || null,
    expectedBoxes: Number.isInteger(expected) && expected > 0 ? Math.min(expected, 999) : null,
    poId,
  };

  try {
    const batch = await createOpenBatch(header, createdBy);
    if (poId) markPoReceiving(poId, batch.id).catch((e) => console.warn('[create-open] markPoReceiving:', e.message));
    addSupplier(supplier, createdBy).catch(() => {});
    return send(res, 200, { ok: true, batchCode: batch.batch_code, id: batch.id });
  } catch (e) {
    console.error('[batches/create-open]', e.message);
    return send(res, 500, { ok: false, error: 'Could not start the batch.' });
  }
}
