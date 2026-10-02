// POST /api/me/telegram { action: 'link' | 'test' | 'disconnect' }
//
//   link        -> { ok, url }  a t.me deep link that opens the bot and sends
//                  `/start <token>`; the webhook (api/telegram/webhook.js) spends the token
//                  and connects the Telegram account that pressed Start to THIS account.
//                  One use, 15 minutes, and minting a new one retires the old.
//   test        -> sends "Test alert" to the connected chat
//   disconnect  -> says goodbye in the chat (best-effort) and clears the connection
//
// Connecting is self-service now (it used to be an admin pasting a numeric id on Check
// Access, which still works). That id is also WHO a tap in the approval group is, so the
// token is the whole guarantee: only the signed-in person can mint theirs, it dies on
// first use, and both the bot's reply and the panel name the account that was attached.
import crypto from 'node:crypto';
import { getJsonBody, send, applySecurity, rateLimit, requireAuth, blockIfMustChange } from '../_lib/util.js';
import { dbConfigured, getAlertAccount, createTelegramLinkToken, unlinkTelegram, setTelegramBroken, logAlert } from '../_lib/db.js';
import { telegramConfigured, sendAlertMessage, getBotUsername } from '../_lib/telegram.js';
import { alertHtml } from '../_lib/alerts.js';
import { ownAccountId } from './alerts.js';

const appEnv = () => (process.env.APP_ENV === 'dev' ? 'dev' : 'prod');

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireAuth(req, res);
  if (!user) return;
  if (blockIfMustChange(user, res)) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 20 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded. Slow down a moment.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  if (!telegramConfigured()) return send(res, 503, { ok: false, error: 'Telegram is not set up on this server.' });
  const uid = ownAccountId(user);
  if (!uid) return send(res, 409, { ok: false, error: 'This is a shared login — sign in with your own account to connect Telegram.' });

  const body = await getJsonBody(req);
  const row = await getAlertAccount(uid);
  if (!row) return send(res, 404, { ok: false, error: 'Your account was not found.' });

  try {
    if (body.action === 'link') {
      // First character = the server that minted it, so prod can hand a dev token's
      // /start on to the dev server (one bot, one webhook — see the webhook).
      const token = `${appEnv() === 'dev' ? 'd' : 'p'}${crypto.randomBytes(18).toString('base64url')}`;
      await createTelegramLinkToken({ userId: uid, token, env: appEnv() });
      const bot = await getBotUsername();
      if (!bot) return send(res, 503, { ok: false, error: 'Could not read the bot’s name from Telegram.' });
      return send(res, 200, { ok: true, url: `https://t.me/${bot}?start=${token}`, bot });
    }

    if (body.action === 'test') {
      if (!row.telegram_user_id) return send(res, 409, { ok: false, error: 'Connect Telegram first.' });
      try {
        await sendAlertMessage(row.telegram_user_id, {
          html: alertHtml({ emoji: '📣', title: 'Test alert', body: 'Telegram alerts are working.' }),
        });
      } catch (e) {
        if (e.status === 403) {
          await setTelegramBroken(uid, true);
          await logAlert({ userId: uid, eventKey: 'test', status: 'failed', reason: e.message.slice(0, 300) }).catch(() => {});
          return send(res, 409, { ok: false, error: 'Telegram refused — the chat with the bot was blocked or deleted. Tap Reconnect.' });
        }
        throw e;
      }
      await setTelegramBroken(uid, false);
      await logAlert({ userId: uid, eventKey: 'test', status: 'sent' }).catch(() => {});
      return send(res, 200, { ok: true });
    }

    if (body.action === 'disconnect') {
      if (row.telegram_user_id) {
        await sendAlertMessage(row.telegram_user_id, {
          html: alertHtml({ emoji: '👋', title: 'Disconnected', body: `${row.name}'s alerts will no longer come here. Connect again any time from Alerts in the app.` }),
        }).catch(() => null);
      }
      await unlinkTelegram(uid);
      return send(res, 200, { ok: true });
    }

    return send(res, 400, { ok: false, error: 'Unknown action.' });
  } catch (e) {
    console.error('[me/telegram]', e.message);
    return send(res, 502, { ok: false, error: `Telegram didn’t answer (${e.message}).` });
  }
}
