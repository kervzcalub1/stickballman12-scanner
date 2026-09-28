// POST /api/cart/telegram-decide   header: x-api-key: <BUYING_API_KEY>
//   { telegramUserId, cartId, lineIds:[…], action:'approve'|'reject', qty?, reason? }
//
// A tap in the Telegram group becomes a decision here. Make.com held the key and posted
// this when somebody pressed a button on the approval card. Since 2026-09-29 the bot's
// taps arrive at api/telegram/webhook.js instead; this stays for the way back, and both
// run the same `decideFromTelegram` (api/_lib/telegramDecide.js).
//
// ── A BUTTON IS NOT AN IDENTITY ──────────────────────────────────────────────
// This is the whole reason the endpoint is more than a thin wrapper. Everyone in a
// Telegram group can press a button, and the API key proves only that the request came
// from the scenario — not who tapped. So the decision is recorded under the person whose
// `users.telegram_user_id` matches, and an unrecognised Telegram account is REFUSED.
//
// Checked here rather than in Make: a control that lives in a scenario is a control
// anyone with the Make login can edit. And the privilege is re-read from the database on
// this call like every other privileged act, so revoking `approve_buying` this morning
// stops them this morning — including from Telegram.
//
// The key alone must never be able to approve anything. It is a credential Make holds
// in a keychain its own warning says the requester can read.
import { getJsonBody, send, applySecurity, rateLimit } from '../_lib/util.js';
import { dbConfigured } from '../_lib/db.js';
import { decideFromTelegram } from '../_lib/telegramDecide.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });

  const expected = String(process.env.BUYING_API_KEY || '').trim();
  if (!expected)
    return send(res, 503, { ok: false, error: 'The buying API is not configured (BUYING_API_KEY missing on the server).' });
  if (String(req.headers['x-api-key'] || '').trim() !== expected)
    return send(res, 401, { ok: false, error: 'Bad or missing API key.' });

  if (!rateLimit(req, { windowMs: 60_000, max: 120 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const out = await decideFromTelegram(body);
  return send(res, out.code, out.body);
}
