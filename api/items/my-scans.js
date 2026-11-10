// GET /api/items/my-scans?from=YYYY-MM-DD&to=YYYY-MM-DD[&user=<username>|all]
//   -> { ok, received, scans, counts, users?, who }
// My Scans (docs/context/inventory.md "My Scans"), for an EST date range:
//   received: the pairs this person SCANNED IN at receiving (the owner's meaning of "my
//             scans", 2026-11-10), each with the shipment it came in on;
//   scans / counts: what they scanned on Stock Check and the counts they ran.
// Everyone sees their OWN; an admin can pick anyone, or everyone (`users`).
import { send, applySecurity, rateLimit, requireRole, isPrivileged } from '../_lib/util.js';
import { dbConfigured, listStockScans, listStockCounts, listStockScanUsers, listReceivedItems, listScanPeople } from '../_lib/db.js';

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
    const [people, scanUsers] = await Promise.all([
      listScanPeople(),
      admin ? listStockScanUsers() : Promise.resolve(undefined),
    ]);
    // Receiving files a pair under the person's display NAME (user.name || user.username),
    // so a person's received pairs are matched on every spelling of them we know.
    let names = null;
    if (who) {
      const set = new Set([who]);
      const row = people.find((p) => p.username === who);
      if (row?.name) set.add(row.name);
      const scanned = (scanUsers || []).find((u) => u.username === who);
      if (scanned?.user_name) set.add(scanned.user_name);
      if (who === me && user.name) set.add(user.name);
      names = [...set];
    }
    const [received, scans, counts] = await Promise.all([
      listReceivedItems({ names, from, to }),
      listStockScans({ username: who, from, to }),
      listStockCounts({ username: who, from, to }),
    ]);
    // The admin's pick list: every approved staff account, plus anyone who scanned on Stock
    // Check without one (the env admin), one row per username.
    let users;
    if (admin) {
      const byName = new Map(people.map((p) => [p.username, { username: p.username, user_name: p.name }]));
      for (const u of scanUsers || []) if (!byName.has(u.username)) byName.set(u.username, { username: u.username, user_name: u.user_name });
      users = [...byName.values()];
    }
    return send(res, 200, { ok: true, received, scans, counts, users, who: who || 'all' });
  } catch (e) {
    console.error('[items/my-scans]', e.message);
    return send(res, 500, { ok: false, error: 'Could not read the scans.' });
  }
}
