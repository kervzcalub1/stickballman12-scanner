// GET  /api/me/alerts                       -> { ok, ...state }
// POST /api/me/alerts { muted?, prefs? }     -> { ok, ...state }
//
// The signed-in person's own alert settings (the Alerts panel): their Telegram
// connection, the master switch, and one row per event that applies to their job.
// `prefs` is { eventKey: bool }; a required event, or one this account can't receive,
// is ignored rather than stored (api/_lib/alerts.js `cleanPrefs`).
//
// The env logins (`admin`, `superadmin`) have no account row — a shared login can't
// carry one person's Telegram — so they get `{ account: 'shared' }` and the panel says so.
import { getJsonBody, send, applySecurity, rateLimit, requireAuth, blockIfMustChange } from '../_lib/util.js';
import { dbConfigured, getAlertAccount, setAlertPrefs } from '../_lib/db.js';
import { telegramConfigured } from '../_lib/telegram.js';
import { catalogueFor, cleanPrefs } from '../_lib/alerts.js';

export function alertState(row) {
  return {
    account: 'own',
    configured: telegramConfigured(),
    telegram: {
      connected: !!row.telegram_user_id,
      name: row.telegram_name || null,
      username: row.telegram_username || null,
      linkedAt: row.telegram_linked_at || null,
      broken: !!row.telegram_broken_at,
    },
    muted: !!row.alerts_muted,
    events: catalogueFor(row),
  };
}

export const ownAccountId = (user) => (Number.isInteger(Number(user?.uid)) && Number(user.uid) > 0 ? Number(user.uid) : null);

export default async function handler(req, res) {
  applySecurity(req, res);
  const user = requireAuth(req, res);
  if (!user) return;
  if (blockIfMustChange(user, res)) return;
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const uid = ownAccountId(user);
  if (!uid) return send(res, 200, { ok: true, account: 'shared', configured: telegramConfigured() });

  if (req.method === 'GET') {
    const row = await getAlertAccount(uid);
    if (!row) return send(res, 404, { ok: false, error: 'Your account was not found.' });
    return send(res, 200, { ok: true, ...alertState(row) });
  }

  if (req.method === 'POST') {
    if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
      return send(res, 429, { ok: false, error: 'Rate limit exceeded. Slow down a moment.' });
    const body = await getJsonBody(req);
    const row = await getAlertAccount(uid);
    if (!row) return send(res, 404, { ok: false, error: 'Your account was not found.' });
    const muted = typeof body.muted === 'boolean' ? body.muted : null;
    const prefs = body.prefs && typeof body.prefs === 'object' && !Array.isArray(body.prefs) ? body.prefs : {};
    await setAlertPrefs(uid, { muted, prefs: cleanPrefs(row, prefs) });
    return send(res, 200, { ok: true, ...alertState(await getAlertAccount(uid)) });
  }

  return send(res, 405, { ok: false, error: 'Method not allowed' });
}
