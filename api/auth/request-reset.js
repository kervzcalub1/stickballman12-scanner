// POST /api/auth/request-reset  { username }  ->  { ok }
// Public (no auth) — a user who forgot their password asks for a reset from the sign-in
// screen. Stamps reset_requested_at on the matching APPROVED account so it surfaces in
// the admin's "Check Access" queue; an admin then issues a temp password.
//
// Always answers with the SAME generic success, whether or not the username exists or is
// approved — so this endpoint can't be used to enumerate accounts. Rate-limited to blunt
// abuse (someone spamming reset requests for a known user).
import { getJsonBody, send, applySecurity, rateLimit } from '../_lib/util.js';
import { requestPasswordReset, dbConfigured } from '../_lib/db.js';

const GENERIC = { ok: true, message: 'If that account exists, an admin has been notified to reset it.' };

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!rateLimit(req, { windowMs: 60_000, max: 10 }))
    return send(res, 429, { ok: false, error: 'Too many requests. Try again in a minute.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Accounts are not configured.' });

  const body = await getJsonBody(req);
  const username = String(body.username || '').trim().toLowerCase();
  if (!username) return send(res, 400, { ok: false, error: 'Enter your username.' });

  try {
    await requestPasswordReset(username); // no-op if unknown / not approved
  } catch (e) {
    console.error('[auth/request-reset]', e.message);
    // Still answer generically — don't reveal server-side state to the client.
  }
  return send(res, 200, GENERIC);
}
