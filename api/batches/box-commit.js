// POST /api/batches/box-commit
//   { batchId, boxId, items:[…], unitIssues:[…] } -> { ok, count, vins, autoCompleted }
// Commits one box of an open multi-box batch: inserts its items (linked to the
// box), records per-unit defect issues, marks the box received, and auto-completes
// the batch when received == expected. (V6 Feature 7)
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import {
  getBatchWithBoxes, commitBoxItems, insertIssueEvents, insertIssues, dbConfigured,
} from '../_lib/db.js';
import { normalizeItems, parseUnitIssues, enrichGlobalIndicators } from '../_lib/intake.js';

const MAX_ITEMS = 2000;
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
  const batchId = Number(body.batchId);
  const boxId = Number(body.boxId);
  const rawItems = Array.isArray(body.items) ? body.items : [];
  if (!Number.isInteger(batchId) || !Number.isInteger(boxId))
    return send(res, 400, { ok: false, error: 'A valid batchId and boxId are required.' });
  if (!rawItems.length) return send(res, 400, { ok: false, error: 'Add at least one item before submitting the box.' });
  if (rawItems.length > MAX_ITEMS) return send(res, 400, { ok: false, error: `Too many items (max ${MAX_ITEMS}).` });

  const createdBy = user.name || user.username || '';
  const unitIssues = parseUnitIssues(body);
  const noBoxVins = new Set(unitIssues.filter((u) => u.type === 'no_box').map((u) => u.vin));

  try {
    const found = await getBatchWithBoxes(batchId);
    if (!found || found.batch.kind !== 'receiving') return send(res, 404, { ok: false, error: 'Batch not found.' });
    const box = found.boxes.find((b) => b.id === boxId);
    if (!box) return send(res, 404, { ok: false, error: 'Box not found in this batch.' });
    if (box.status === 'received') return send(res, 409, { ok: false, error: 'This box was already submitted.' });

    const defaultCost = toCost(found.batch.default_cost);
    const items = normalizeItems(rawItems, { defaultCost, noBoxVins });
    const { created, vins, autoCompleted } = await commitBoxItems({
      batchId, boxId, items, createdBy, dateReceived: found.batch.date_received,
    });

    // Per-unit defect issues → item_events(type='issue') for the matching VINs.
    if (unitIssues.length) {
      const idByVin = new Map(created.map((r) => [r.vin, r.id]));
      const entries = unitIssues.filter((u) => idByVin.has(u.vin))
        .map((u) => ({ itemId: idByVin.get(u.vin), type: u.type, note: u.note, photos: u.photos }));
      if (entries.length) await insertIssueEvents(entries, createdBy);
    }
    // Batch-level shipment issues (no-box auto-list + manual) — recorded on the batch.
    const issues = Array.isArray(body.issues) ? body.issues : [];
    if (issues.length) await insertIssues(batchId, issues, createdBy);

    send(res, 200, { ok: true, count: created.length, vins, autoCompleted });
    enrichGlobalIndicators(created, items).catch((e) => console.warn('[box-commit] GI enrichment failed:', e.message));
    return;
  } catch (e) {
    console.error('[batches/box-commit]', e.message);
    return send(res, 500, { ok: false, error: 'Could not submit the box. Please try again.' });
  }
}
