// POST /api/batches/commit
//   { batch:{buyer,supplier,tracking,noTracking,dateReceived,defaultCost,notes,specialRules},
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
  createBatch, insertItems, insertIntakeEvents, insertIssues, insertIssueEvents,
  addSupplier, getPo, markPoReceiving, reconcileOutcomeForIntake, dbConfigured,
  getLocationByCode, shelveItems, PH_EXCLUDED_KINDS, claimForTracking,
} from '../_lib/db.js';
import { registerWarehouseTracking } from '../_lib/tracking.js';
import { enrichGlobalIndicators, normalizeItems, toCost } from '../_lib/intake.js';
import { normalizeLocationCode } from '../_lib/locations.js';
import { VIN_RE, duplicateVin } from '../_lib/vins.js';

const MAX_ITEMS = 2000;

const cleanName = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 200);
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
  // 'instore' = pairs bought at a retail store: no shipment (like rescale), but
  // it keeps `origin` (store name) and, unlike rescale, lands as fresh received
  // stock. admin/warehouse only — ph_team is already blocked by requireRole below.
  // 'existing' = old stock that predates this system: no shipment, already sitting
  // on a shelf, and already listed to II + the stores. Counted in via the Existing
  // Stock screen, which sends a `locationCode` so each pair is shelved on commit.
  // 'boxes' = a shipment of EMPTY shoe boxes, received against a boxes purchase order.
  // Real stock rows with real VINs (so history, shelves and search all work on them),
  // but never PH's and never listed — `PH_EXCLUDED_KINDS` carries that.
  const KINDS = ['rescale', 'instore', 'existing', 'boxes'];
  let kind = KINDS.includes(body.kind) ? body.kind : 'receiving';
  // Rescale and existing carry no issues; receiving and in-store both can (in-store
  // reuses the full Review + Issues flow — no-box auto-issues, per-unit defect flags).
  const issues = (kind === 'rescale' || kind === 'existing') ? [] : (Array.isArray(body.issues) ? body.issues : []);
  // Per-unit defect issues flagged on the Review screen (V6 Feature 4):
  // [{ vin, type, note, photos:[https…] }]. Mapped to item ids after insert.
  const unitIssues = (Array.isArray(body.unitIssues) ? body.unitIssues : [])
    .map((u) => ({
      vin: String(u?.vin || '').trim().toUpperCase(),
      type: String(u?.type ?? '').trim().slice(0, 40) || 'other',
      note: String(u?.note ?? '').trim().slice(0, 500),
      photos: (Array.isArray(u?.photos) ? u.photos : [])
        .filter((p) => /^https:\/\//.test(String(p))).map((p) => String(p).slice(0, 500)).slice(0, 6),
    }))
    .filter((u) => VIN_RE.test(u.vin));

  if (!rawItems.length)
    return send(res, 400, { ok: false, error: 'Add at least one item before committing the batch.' });
  if (rawItems.length > MAX_ITEMS)
    return send(res, 400, { ok: false, error: `Too many items (max ${MAX_ITEMS}).` });
  // A receiving batch must be traceable to its shipment — require supplier + tracking.
  // (Rescale and in-store carry no shipment, so they're exempt.)
  //
  // `noTracking` is the one way past the tracking half: some inbounds genuinely
  // arrive without a number (hand-delivered, local pickup, a supplier who never
  // sent one), and the old rule left staff with no honest way to record those.
  // It has to be STATED — the flag is stored on the batch, so "there was no
  // tracking number" reads differently from "someone left the field empty".
  const noTracking = header.noTracking === true;
  // A carton of empty boxes arrives on a courier label from a supplier exactly like a
  // carton of shoes does, so it keeps the whole shipment header — supplier, tracking, the
  // PO link. Only what's INSIDE differs. (Rescale and in-store carry no shipment at all.)
  const isShipment = kind === 'receiving' || kind === 'boxes';
  if (isShipment) {
    if (!cleanName(header.supplier)) return send(res, 400, { ok: false, error: 'Supplier is required.' });
    if (!noTracking && !String(header.tracking ?? '').trim())
      return send(res, 400, { ok: false, error: 'Tracking # is required — or tick “No tracking number”.' });
  }
  // Reject a negative cost outright (a typo like "-5") rather than silently nulling it.
  const isNegCost = (v) => v !== '' && v != null && Number.isFinite(Number(v)) && Number(v) < 0;
  if (isNegCost(header.defaultCost) || rawItems.some((it) => isNegCost(it?.cost)))
    return send(res, 400, { ok: false, error: 'Cost can’t be negative.' });

  // Existing stock is counted shelf by shelf — the pairs are already physically on
  // the shelf, so the location is part of the count, not a later put-away chore.
  // Resolve it BEFORE creating the batch: failing afterwards would leave a committed
  // batch of unshelved pairs with no obvious way to tell they never got placed.
  // The Box Labels tool is the one exception: it mints a single old-stock pair that
  // is IN HAND being re-boxed, not standing on a shelf, so it opts out explicitly
  // (`noShelf`) and lands in the normal needs-shelf queue. Everything else counting
  // existing stock is AT the shelf — keep the guard there, so a dropped locationCode
  // fails loudly instead of silently producing a batch of unshelved pairs.
  let existingLocation = null;
  if (kind === 'existing' && !(body.noShelf === true && !body.locationCode)) {
    const code = normalizeLocationCode(body.locationCode);
    if (!code) return send(res, 400, { ok: false, error: 'Scan a shelf before counting existing stock onto it.' });
    existingLocation = await getLocationByCode(code);
    if (!existingLocation) return send(res, 404, { ok: false, error: `Unknown shelf “${code}”.` });
    if (!existingLocation.active) return send(res, 409, { ok: false, error: `Shelf “${code}” is inactive.` });
  }

  const createdBy = user.name || user.username || '';
  const defaultCost = toCost(header.defaultCost);

  // V6 PO Phase 2: a receiving batch may be received against a purchase order —
  // link it and move the PO into 'receiving'. Validate the PO is open first.
  const poId = isShipment && Number.isInteger(Number(body.poId)) && Number(body.poId) > 0
    ? Number(body.poId) : null;
  if (poId) {
    const po = await getPo(poId);
    if (!po) return send(res, 404, { ok: false, error: 'That purchase order was not found.' });
    // Boxes arrive one at a time and often before the supplier marks every label shipped
    // (a multi-label PO stays 'draft' until ALL labels ship), so allow receiving against a
    // draft/shipped/receiving PO — block only already-finished ones.
    if (['reconciled', 'closed'].includes(po.status))
      return send(res, 409, { ok: false, error: `PO ${po.po_code} is already ${po.status} — it can't be received against again.` });
    // What arrived is whatever the ORDER says it is, not whatever the client claimed.
    // A boxes order received as a 'receiving' batch would put empty cartons in front of
    // the PH team as sellable stock, which is the one thing this kind exists to prevent.
    kind = po.order_kind === 'boxes' ? 'boxes' : (kind === 'boxes' ? 'receiving' : kind);
  }

  // A unit flagged with a 'no_box' defect follows the no-box rules too (status
  // no_box / No-Box queue), same end state as the per-shoe box-status toggle.
  const noBoxVins = new Set(unitIssues.filter((u) => u.type === 'no_box').map((u) => u.vin));

  // Normalize items. "With Box" unchecked (toggle) OR a 'no_box' defect → no_box.
  //
  // This used to be a line-for-line COPY of normalizeItems, carrying its own inline
  // VIN pattern — which is how the pre-printed 1ID series got silently dropped here
  // while working everywhere else: an unrecognised VIN is nulled, and insertItems then
  // mints a dated one, so the shoe left the bench wearing a number that wasn't on it.
  // One implementation, shared with box-commit (intake.js).
  // Pre-sell is a property of the SHIPMENT, declared once at intake, and it only makes
  // sense on a real inbound — rescale and in-store are stock we already had.
  const preSell = isShipment && header.preSell === true;
  const items = normalizeItems(rawItems, { defaultCost, noBoxVins, preSell });

  // Only a real shipment (receiving) carries buyer/supplier/tracking. Rescale and
  // in-store drop those; in-store keeps `origin` (the store name) like rescale.
  const bh = {
    buyer: !isShipment ? null : cleanName(header.buyer),
    supplier: !isShipment ? null : cleanName(header.supplier),
    // A stated "no tracking number" wins over anything left in the field, so the
    // flag and the column can never disagree about what this shipment had.
    tracking: !isShipment || noTracking ? null : (String(header.tracking ?? '').trim().slice(0, 120) || null),
    noTracking: isShipment && noTracking,
    dateReceived: header.dateReceived || null,
    defaultCost,
    notes: String(header.notes ?? '').trim().slice(0, 2000) || null,
    specialRules: String(header.specialRules ?? '').trim().slice(0, 2000) || null,
    kind,
    origin: !isShipment ? (String(header.origin ?? '').trim().slice(0, 80) || null) : null,
    // Set by the client when staff proceed past the duplicate-tracking warning.
    duplicateOf: !isShipment ? null : (Number.isInteger(header.duplicateOf) ? header.duplicateOf : null),
    poId,
    preSell,
  };

  try {
    const batch = await createBatch(bh, createdBy);
    // Link + advance the PO (best-effort — the batch is already saved).
    // Kept as a promise (not fire-and-forget) so the auto-reconcile below runs only
    // after the PO is actually on 'receiving' with its batch linked.
    const poMarked = poId
      ? markPoReceiving(poId, batch.id).catch((e) => { console.warn('[commit] markPoReceiving:', e.message); throw e; })
      : null;
    // Auto-save the supplier name so custom vendors (e.g. "JD Sports") show up in
    // the dropdown next time. Best-effort — never fail the commit over this.
    if (isShipment && bh.supplier) addSupplier(bh.supplier, createdBy).catch(() => {});
    // Register the shipment's own tracking number with the courier feed. A batch
    // committed with a number typed straight into the header (no PO, no box slots)
    // was the last path that left one unregistered. Fire-and-forget, claimed once.
    if (isShipment && bh.tracking) {
      registerWarehouseTracking([bh.tracking], { claim: claimForTracking, label: 'batches/commit' })
        .catch((e) => console.warn('[commit] register:', e.message));
    }
    const created = await insertItems(batch.id, items, createdBy, bh.dateReceived);
    // First history per item: "Scanned by <user>" then received / rescaled.
    await insertIntakeEvents(created.map((r) => r.id), createdBy, kind);
    await insertIssues(batch.id, issues, createdBy);

    // Existing stock: place every counted pair on the shelf it was scanned against,
    // reusing the normal put-away path so status/location_id/location_code and the
    // 'shelved' event all stay consistent with a hand put-away. No-box pairs are
    // refused by shelveItems (a boxless shoe isn't sellable) and stay in the No-Box
    // queue — surfaced below so the screen can say how many need a box first.
    let shelved = null;
    if (kind === 'existing' && existingLocation) {
      const placed = await shelveItems({
        location: existingLocation,
        units: created.map((r) => ({ vin: r.vin, nowHasBox: false })),
        createdBy,
      });
      shelved = {
        updated: placed.updated,
        noBoxBlocked: placed.results.filter((r) => r.reason === 'no_box').length,
        location: { code: existingLocation.code, label: existingLocation.label },
      };
    }

    // Per-unit defect issues → an 'issue' event on the matching unit (by VIN).
    if (unitIssues.length) {
      const idByVin = new Map(created.map((r) => [r.vin, r.id]));
      const entries = unitIssues
        .filter((u) => idByVin.has(u.vin))
        .map((u) => ({ itemId: idByVin.get(u.vin), type: u.type, note: u.note, photos: u.photos }));
      if (entries.length) await insertIssueEvents(entries, createdBy);
    }

    // Reconcile BEFORE responding when there's a PO: a clean one closes itself, and a
    // short/over/blind one comes back in the payload so the "batch saved" screen can say
    // so while the person is still standing over the boxes. Best-effort — a failure here
    // must never turn a saved batch into an error.
    const reconcile = poMarked
      ? await poMarked.then(() => reconcileOutcomeForIntake(poId))
        .catch((e) => { console.warn('[commit] reconcile outcome:', e.message); return null; })
      : null;

    send(res, 200, {
      ok: true,
      batchCode: batch.batch_code,
      count: created.length,
      vins: created.map((r) => r.vin),
      reconcile,
      shelved,
    });

    // Best-effort, AFTER responding (slow/flaky Alias must never delay the
    // commit): pull each unit's global indicator price and seed the final price.
    // A failure just leaves GI null for PH to fill in by hand. Skipped for in-store
    // and existing stock — both bypass PH entirely, and existing stock is already
    // priced on the stores, so re-deriving a GI here would be meaningless noise.
    if (!PH_EXCLUDED_KINDS.includes(kind)) {
      enrichGlobalIndicators(created, items)
        .catch((e) => console.warn('[batches/commit] GI enrichment failed:', e.message));
    }
    return;
  } catch (e) {
    // A 1ID sticker already on another shoe. Retrying can't help, so say which one.
    const dupe = duplicateVin(e);
    if (dupe) return send(res, 409, {
      ok: false, vin: dupe,
      error: `1ID ${dupe} is already on another shoe. Pull that sticker, put a fresh one on, and submit again.`,
    });
    console.error('[batches/commit]', e.message);
    return send(res, 500, { ok: false, error: 'Could not save the batch. Please try again.' });
  }
}
