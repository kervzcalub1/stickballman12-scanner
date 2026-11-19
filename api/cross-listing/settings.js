// GET  /api/cross-listing/settings                 -> { ok, chatId, canEdit }
// POST /api/cross-listing/settings { chatId }      save the Telegram chat cross-listing sales post to ('' = none)
// POST /api/cross-listing/settings { test: true }  send a test message to the saved chat
// Admins, and anyone holding `manage_access` (Check Access). The chat is an app setting,
// not an env var, so it can be changed without a deploy (docs/context/alias-cross-listing.md).
import { getJsonBody, send, applySecurity, rateLimit, requireRole, isPrivileged } from '../_lib/util.js';
import { dbConfigured, setSetting, userHasPrivilege } from '../_lib/db.js';
import { sendToChat } from '../_lib/telegram.js';
import { CHAT_KEY, crossChatId } from '../_lib/cross.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  const user = requireRole(req, res, ['warehouse', 'ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 30 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const canEdit = isPrivileged(user.role) || await userHasPrivilege(user.uid, 'manage_access').catch(() => false);
  if (req.method === 'GET') return send(res, 200, { ok: true, chatId: canEdit ? await crossChatId() : null, canEdit });
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!canEdit) return send(res, 403, { ok: false, error: 'Only an admin (or someone with Check Access) can change the Telegram chat.' });
  const b = await getJsonBody(req);
  if (b.test === true) {
    const chat = await crossChatId();
    if (!chat) return send(res, 400, { ok: false, error: 'Save a chat first.' });
    try {
      await sendToChat(chat, [{ b: '🔀 Alias Cross-Listing' }, `Test from ${user.name || user.username || 'the app'} — sales of cross-listed pairs will post here.`]);
      return send(res, 200, { ok: true });
    } catch (e) {
      return send(res, 502, { ok: false, error: `Telegram refused it: ${e.message}. Is the bot a member of that chat?` });
    }
  }
  const chatId = String(b.chatId ?? '').trim();
  // A Telegram chat id is a number (groups are negative, e.g. -1001234567890) or @channelname.
  if (chatId && !/^(-?\d{5,20}|@[A-Za-z0-9_]{5,32})$/.test(chatId)) return send(res, 400, { ok: false, error: 'A chat id looks like -1001234567890 (or @channelname).' });
  await setSetting(CHAT_KEY, chatId, user.name || user.username || null);
  return send(res, 200, { ok: true, chatId: chatId || null });
}
