// POST /api/batches/commit
//   { batch:{buyer,supplier,tracking,dateReceived,defaultCost,notes,specialRules},
//     items:[{name,sku,size,upc,image,cost,source,notes,withBox}],
//     issues:[{type,description,expectedCount,receivedCount}] }
//   -> { ok, batchCode, count, vins }
//
// Persists a whole receiving batch to the database (one VIN per item, atomic
// inserts) and records shipment issues. The database is the single source of
// truth (V5 — Google Sheets removed). Each item's history starts with
// "Scanned by <user>" then "Received into inventory".

import {
  getJsonBody, send, applySecurity, rateLimit, requireRole, cleanSku,
} from '../_lib/util.js';
import {
  createBatch, insertItems, insertIntakeEvents, insertIssues, dbConfigured,
} from '../_lib/db.js';

const MAX_ITEMS = 2000;

const cleanName = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 200);
const toCost = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const normSku = (s) => {
  const c = cleanSku(s);
  return c ? c.replace(/\s+/g, '-') : null;
};

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 30 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded. Slow down a moment.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const header = body.batch || {};
  const rawItems = Array.isArray(body.items) ? body.items : [];
  const kind = body.kind === 'rescale' ? 'rescale' : 'receiving';
  // Rescale has no shipment, so it carries no shipment issues.
  const issues = kind === 'rescale' ? [] : (Array.isArray(body.issues) ? body.issues : []);

  if (!rawItems.length)
    return send(res, 400, { ok: false, error: 'Add at least one item before committing the batch.' });
  if (rawItems.length > MAX_ITEMS)
    return send(res, 400, { ok: false, error: `Too many items (max ${MAX_ITEMS}).` });

  const createdBy = user.name || user.username || '';
  const defaultCost = toCost(header.defaultCost);

  // Normalize items. "With Box" unchecked → status 'no_box' + with_box=false.
  const items = rawItems.map((it) => {
    const withBox = it.withBox !== false;
    return {
      name: cleanName(it.name) || 'Unknown',
      sku: normSku(it.sku),
      size: String(it.size ?? '').trim().slice(0, 24),
      upc: String(it.upc ?? '').replace(/\D/g, '').slice(0, 14) || null,
      image: it.image || null,
      cost: toCost(it.cost) ?? defaultCost,
      source: ['stockx', 'alias', 'kicksdb', 'manual'].includes(it.source) ? it.source : 'manual',
      gender: ['Men', 'Women', 'Youth', 'Toddler', 'Unisex'].includes(it.gender) ? it.gender : null,
      notes: String(it.notes ?? '').trim().slice(0, 500) || null,
      withBox,
      status: withBox ? 'needs_shelf' : 'no_box',
      // Reserved VIN (assigned during receiving). Validated; else server generates.
      vin: /^SBM-\d{6}-\d{6}$/.test(String(it.vin || '')) ? it.vin : null,
    };
  });

  // Rescale carries no shipment — buyer/supplier/tracking are dropped.
  const bh = {
    buyer: kind === 'rescale' ? null : cleanName(header.buyer),
    supplier: kind === 'rescale' ? null : cleanName(header.supplier),
    tracking: kind === 'rescale' ? null : (String(header.tracking ?? '').trim().slice(0, 120) || null),
    dateReceived: header.dateReceived || null,
    defaultCost,
    notes: String(header.notes ?? '').trim().slice(0, 2000) || null,
    specialRules: String(header.specialRules ?? '').trim().slice(0, 2000) || null,
    kind,
    origin: kind === 'rescale' ? (String(header.origin ?? '').trim().slice(0, 80) || null) : null,
  };

  try {
    const batch = await createBatch(bh, createdBy);
    const created = await insertItems(batch.id, items, createdBy, bh.dateReceived);
    // First history per item: "Scanned by <user>" then received / rescaled.
    await insertIntakeEvents(created.map((r) => r.id), createdBy, kind);
    await insertIssues(batch.id, issues, createdBy);

    return send(res, 200, {
      ok: true,
      batchCode: batch.batch_code,
      count: created.length,
      vins: created.map((r) => r.vin),
    });
  } catch (e) {
    console.error('[batches/commit]', e.message);
    return send(res, 500, { ok: false, error: 'Could not save the batch. Please try again.' });
  }
}
