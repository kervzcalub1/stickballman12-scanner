// GET /api/cancellations/list?from=YYYY-MM-DD&to=YYYY-MM-DD -> { ok, rows, capped, me }
// The record: every order sent to cancel (not removed), by the EST day it was SENT, newest
// first. from / to may be left out (open). Platform, "no order # read" and search are
// filtered on the page from these rows.
import { send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { dbConfigured, listCancellations } from '../_lib/db.js';
import { VIEW_ROLES, isYmd, canRemove } from './_shared.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, VIEW_ROLES);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 90 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const url = new URL(req.url, 'http://x');
  const from = url.searchParams.get('from') || null;
  const to = url.searchParams.get('to') || null;
  if ((from && !isYmd(from)) || (to && !isYmd(to))) return send(res, 400, { ok: false, error: 'Dates are YYYY-MM-DD (EST).' });
  try {
    const out = await listCancellations({ from, to });
    // `me`: who may remove a row (PH / admin any; the rest only their own).
    return send(res, 200, { ok: true, ...out, me: { uid: Number(user.uid) || null, canRemoveAny: canRemove(user, null) } });
  } catch (e) {
    console.error('[cancellations/list]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load cancellations.' });
  }
}
