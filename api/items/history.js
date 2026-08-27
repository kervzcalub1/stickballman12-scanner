// GET /api/items/history?vins=SBM-...,SBM-...  ->  { ok, events, provenance }
// Combined change history for one PH grid size line (its VINs). Visible to the
// PH team, warehouse, and admin so anyone can see who changed what, when.
import { send, applySecurity, requireRole } from '../_lib/util.js';
import { getEventsWithProvenance, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireRole(req, res, ['warehouse', 'ph_team'])) return; // admin auto-allowed
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const raw = new URL(req.url, 'http://x').searchParams.get('vins') || '';
  const vins = raw.split(',').map((v) => v.trim().toUpperCase()).filter(Boolean).slice(0, 1000);
  if (!vins.length) return send(res, 400, { ok: false, error: 'Provide vins.' });

  try {
    // Provenance rides along: which batch, which parcel, and whether that shipment came
    // in against a purchase order — the questions this view could never answer.
    const { events, provenance } = await getEventsWithProvenance(vins);
    return send(res, 200, { ok: true, events, provenance });
  } catch (e) {
    console.error('[items/history]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load history.' });
  }
}
