// GET /api/items/query?q=&from=&to=&supplier=&status=  ->  { ok, rows, totals }
// Unified inventory list for the merged Inventory page (search + date/supplier/
// status filters + totals for the daily-report view).
import { send, applySecurity, requireRole } from '../_lib/util.js';
import { queryItems, dbConfigured } from '../_lib/db.js';

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireRole(req, res, ['warehouse'])) return;
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const p = new URL(req.url, 'http://x').searchParams;
  const q = (p.get('q') || '').trim() || null;
  const from = isDate(p.get('from')) ? p.get('from') : null;
  const to = isDate(p.get('to')) ? p.get('to') : null;
  const supplier = p.get('supplier') || null;
  const status = p.get('status') || null;

  try {
    const rows = await queryItems({ q, from, to, supplier, status });
    const totals = { count: rows.length, totalCost: 0, byStatus: {} };
    for (const r of rows) {
      totals.totalCost += Number(r.cost) || 0;
      totals.byStatus[r.status] = (totals.byStatus[r.status] || 0) + 1;
    }
    return send(res, 200, { ok: true, rows, totals });
  } catch (e) {
    console.error('[items/query]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load inventory.' });
  }
}
