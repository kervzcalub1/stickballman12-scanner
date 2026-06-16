// POST /api/batches/commit
//   { batch:{buyer,supplier,tracking,dateReceived,defaultCost,notes,specialRules},
//     items:[{name,sku,size,upc,image,cost,source,notes}],
//     issues:[{type,description,expectedCount,receivedCount}],
//     mirror?:boolean }
//   -> { ok, batchCode, count, vins, mirror }
//
// Persists a whole receiving batch to the DB (one VIN per item, atomic inserts),
// records shipment issues, and (by default) mirrors the items to the Google
// Sheet (consolidated, V3 rules). DB is the source of truth.

import {
  getJsonBody, send, applySecurity, rateLimit, requireAuth, cleanSku,
} from '../_lib/util.js';
import {
  createBatch, insertItems, insertReceivedEvents, insertIssues,
  acquireLock, releaseLock, dbConfigured,
} from '../_lib/db.js';
import { mirrorBatch, writeReceivingSheets, sheetsConfigured } from '../_lib/sheets.js';

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
  const user = requireAuth(req, res);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 30 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded. Slow down a moment.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const header = body.batch || {};
  const rawItems = Array.isArray(body.items) ? body.items : [];
  const issues = Array.isArray(body.issues) ? body.issues : [];
  const doMirror = body.mirror !== false; // default: mirror to the sheet

  if (!rawItems.length)
    return send(res, 400, { ok: false, error: 'Add at least one item before committing the batch.' });
  if (rawItems.length > MAX_ITEMS)
    return send(res, 400, { ok: false, error: `Too many items (max ${MAX_ITEMS}).` });

  const createdBy = user.name || user.username || '';
  const defaultCost = toCost(header.defaultCost);

  // Normalize items.
  const items = rawItems.map((it) => ({
    name: cleanName(it.name) || 'Unknown',
    sku: normSku(it.sku),
    size: String(it.size ?? '').trim().slice(0, 24),
    upc: String(it.upc ?? '').replace(/\D/g, '').slice(0, 14) || null,
    image: it.image || null,
    cost: toCost(it.cost) ?? defaultCost,
    source: ['stockx', 'alias', 'kicksdb', 'manual'].includes(it.source) ? it.source : 'manual',
    notes: String(it.notes ?? '').trim().slice(0, 500) || null,
  }));

  const bh = {
    buyer: cleanName(header.buyer),
    supplier: cleanName(header.supplier),
    tracking: String(header.tracking ?? '').trim().slice(0, 120) || null,
    dateReceived: header.dateReceived || null,
    defaultCost,
    notes: String(header.notes ?? '').trim().slice(0, 2000) || null,
    specialRules: String(header.specialRules ?? '').trim().slice(0, 2000) || null,
  };

  try {
    // 1) DB (source of truth)
    const batch = await createBatch(bh, createdBy);
    const created = await insertItems(batch.id, items, createdBy, bh.dateReceived);
    await insertReceivedEvents(created.map((r) => r.id), createdBy);
    await insertIssues(batch.id, issues, createdBy);
    const itemsWithVin = items.map((it, i) => ({ ...it, vin: created[i].vin }));

    // 2) Sheet mirror (best-effort; DB already committed)
    let mirror = { skipped: true };
    if (doMirror && sheetsConfigured()) {
      // group items by sku|size for consolidation
      const byKey = new Map();
      for (const it of items) {
        if (!it.sku || !it.size) continue;
        const key = `${it.sku}||${it.size}`;
        const g = byKey.get(key) || { name: it.name, sku: it.sku, size: it.size, quantity: 0 };
        g.quantity += 1;
        byKey.set(key, g);
      }
      const lines = [...byKey.values()];
      const locked = await acquireLock('sheet:write', { waitMs: 20000 }).catch(() => false);
      if (locked) {
        try {
          // Consolidated counts (Monitoring) + per-item detail / batch / issues tabs.
          mirror = lines.length ? await mirrorBatch({ scannedBy: createdBy, lines }) : { skipped: true };
          await writeReceivingSheets({ batchCode: batch.batch_code, header: bh, items: itemsWithVin, issues, scannedBy: createdBy });
        } catch (e) {
          mirror = { error: e.message };
        } finally {
          await releaseLock('sheet:write');
        }
      } else {
        mirror = { error: 'Sheet busy — could not mirror (data is saved in the database).' };
      }
    }

    return send(res, 200, {
      ok: true,
      batchCode: batch.batch_code,
      count: created.length,
      vins: created.map((r) => r.vin),
      mirror,
    });
  } catch (e) {
    console.error('[batches/commit]', e.message);
    return send(res, 500, { ok: false, error: 'Could not save the batch. Please try again.' });
  }
}
