// GET /api/items/my-scans?from=YYYY-MM-DD&to=YYYY-MM-DD[&user=<username>|all]
//   -> { ok, scans, counts, users?, who }
// My Scans (docs/context/inventory.md "Stock Check"): what someone scanned on Stock Check
// and the counts they ran, for an EST date range. Everyone sees their OWN; an admin can
// pick anyone, or everyone (`users` lists who has scanned).
import { send, applySecurity, rateLimit, requireRole, isPrivileged } from '../_lib/util.js';
import { dbConfigured, listStockScans, listStockCounts, listStockScanUsers } from '../_lib/db.js';

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse', 'ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 })) return send(res, 429, { ok: false, error: 'Please wait a moment.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const sp = new URL(req.url, 'http://x').searchParams;
  const from = sp.get('from'); const to = sp.get('to');
  if (!YMD.test(from || '') || !YMD.test(to || '')) return send(res, 400, { ok: false, error: 'Pick a date range.' });
  const me = user.username || String(user.uid || '');
  const admin = isPrivileged(user.role);
  const asked = String(sp.get('user') || '').trim();
  // Not an admin: always yourself, whatever was asked.
  const who = admin ? (asked === 'all' ? null : (asked || me)) : me;

  try {
    const [scans, counts, users] = await Promise.all([
      listStockScans({ username: who, from, to }),
      listStockCounts({ username: who, from, to }),
      admin ? listStockScanUsers() : Promise.resolve(undefined),
    ]);
    return send(res, 200, { ok: true, scans, counts, users, who: who || 'all' });
  } catch (e) {
    console.error('[items/my-scans]', e.message);
    return send(res, 500, { ok: false, error: 'Could not read the scans.' });
  }
}
