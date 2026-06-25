// GET /api/suppliers -> { ok, suppliers:[name,...] }
// Vendor names for the receiving supplier dropdown (seeded + auto-saved custom
// names). Readable by warehouse + PH staff.
import { send, applySecurity, rateLimit, requireRole } from './_lib/util.js';
import { listSuppliers, dbConfigured } from './_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireRole(req, res, ['warehouse', 'ph_team'])) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  try {
    const suppliers = await listSuppliers();
    return send(res, 200, { ok: true, suppliers });
  } catch (e) {
    console.error('[suppliers]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load suppliers.' });
  }
}
