// GET  /api/ebay-sync/profiles -> { ok, profiles:[{ id, name, is_default, config }] }
// POST /api/ebay-sync/profiles { id?, name, config, is_default? } -> { ok, profiles }   (admin / Connect integrations; logged)
import { send, applySecurity, rateLimit, requireRole, getJsonBody } from '../_lib/util.js';
import { requirePrivilege } from '../_lib/buycart.js';
import { dbConfigured } from '../_lib/db.js';
import { validateProfile } from '../../src/lib/ebaySync.js';
import { ebaySyncProfiles, ebaySyncSaveProfile, ebaySyncLogAdd } from '../_lib/db.js';

const view = (rows) => rows.map(({ id, name, is_default, config }) => ({ id, name, is_default, config }));
export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method === 'GET') {
    const user = requireRole(req, res, ['ph_team']);
    if (!user) return;
    if (!rateLimit(req, { windowMs: 60_000, max: 60 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
    if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
    return send(res, 200, { ok: true, profiles: view(await ebaySyncProfiles()) });
  }
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = await requirePrivilege(req, res, 'connect_integrations', 'Editing a listing profile needs an admin, or the “Connect integrations” privilege.');
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 20 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const b = await getJsonBody(req);
  const name = String(b.name || '').trim().slice(0, 80);
  if (!name) return send(res, 400, { ok: false, error: 'The profile needs a name.' });
  if (!b.config || typeof b.config !== 'object' || Array.isArray(b.config)) return send(res, 400, { ok: false, error: 'The profile needs its settings.' });
  const bad = validateProfile(b.config);
  if (bad) return send(res, 400, { ok: false, error: bad });
  const by = user.name || user.username || '';
  const row = await ebaySyncSaveProfile({ id: b.id ? Number(b.id) : null, name, isDefault: b.is_default === true, config: b.config }, by);
  await ebaySyncLogAdd({ domain: 'profile', action: 'save_profile', mode: 'live', after: { name, id: row?.id, config: b.config }, by });
  return send(res, 200, { ok: true, profiles: view(await ebaySyncProfiles()) });
}
