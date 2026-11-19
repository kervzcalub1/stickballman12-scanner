// GET /api/inbound-issues/manifests?view=open|working|resolved|all&days=90
//   -> { ok, rows, counts:{open,working}, canWork, me }
// The Manifest Discrepancies page (docs/context/manifest-reports.md): every case about a
// parcel that does not match its paperwork — reported by hand, or found by the app against
// a recorded online order. Same rows as Inbound Issues, narrowed to those two types.
import { send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { dbConfigured, listManifestReports } from '../_lib/db.js';
import { VIEWS } from '../../src/lib/manifestReports.js';
import { VIEW_ROLES, canWork, uidOf } from './_shared.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, VIEW_ROLES);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 90 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const url = new URL(req.url, 'http://x');
  const view = url.searchParams.get('view') || 'open';
  if (!VIEWS.some(([k]) => k === view)) return send(res, 400, { ok: false, error: 'Unknown view.' });
  const d = Number(url.searchParams.get('days') || 90);
  const days = Number.isInteger(d) && d > 0 && d <= 3650 ? d : 90;
  try {
    const out = await listManifestReports({ view, days });
    return send(res, 200, { ok: true, ...out, canWork: canWork(user), me: uidOf(user) });
  } catch (e) {
    console.error('[inbound-issues/manifests]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load the manifest reports.' });
  }
}
