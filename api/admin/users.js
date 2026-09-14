// GET /api/admin/users  ->  { ok, users, telegramWaiting }   (admin only)
// Lists accounts for the "Check Access" screen (pending first), plus any Telegram
// account that has tapped an approval and is not linked to anybody yet — captured on
// the first tap so linking is one click rather than a hunt for a number nobody knows
// about themselves (docs/context/buy-cart.md).

import { send, applySecurity, requireAdmin } from '../_lib/util.js';
import { listUsers, listTelegramLinkRequests, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireAdmin(req, res)) return;
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Accounts are not configured.' });

  try {
    const [users, telegramWaiting] = await Promise.all([
      listUsers(),
      // Never fatal: the account list is the point of this screen, and a missing
      // waiting-list is a smaller loss than a screen that will not load.
      listTelegramLinkRequests().catch(() => []),
    ]);
    return send(res, 200, { ok: true, users, telegramWaiting });
  } catch (e) {
    console.error('[admin/users]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load accounts.' });
  }
}
