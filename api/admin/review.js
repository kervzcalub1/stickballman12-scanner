// POST /api/admin/review  (admin only)
//   { userId, decision: 'approve' | 'reject' | 'role' | 'privileges' | 'telegram' | 'delete',
//     role?, privileges?, telegramUserId? }
// Approves/rejects a pending account, changes its role or its PRIVILEGES, or deletes it.
//
// Role and privileges are separate on purpose. A role is the one job somebody does; a
// privilege is a permission on top of it — the gift-card duties are held by a PH team
// member or an admin who ALSO does that, not instead of it. See docs/context/buy-cart.md.

import { getJsonBody, send, applySecurity, requireAdmin } from '../_lib/util.js';
import { reviewUser, setUserRole, setUserPrivileges, deleteUser, dbConfigured, setUserTelegramId, getUserById, clearTelegramLinkRequest } from '../_lib/db.js';
import { PRIVILEGE_KEYS, BUYER_PRIVILEGE_KEYS } from '../_lib/buycart.js';

// `supplier` = external scan-out partner (PO feature); admin-assignable, never at signup.
const ROLES = ['warehouse', 'ph_team', 'admin', 'supplier'];

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const admin = requireAdmin(req, res);
  if (!admin) return;
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Accounts are not configured.' });

  const body = await getJsonBody(req);
  const userId = parseInt(body.userId, 10);
  const decision = body.decision;
  if (!Number.isInteger(userId)) return send(res, 400, { ok: false, error: 'Provide a userId.' });

  try {
    if (decision === 'delete') {
      const ok = await deleteUser(userId);
      if (!ok) return send(res, 404, { ok: false, error: 'Account not found.' });
      return send(res, 200, { ok: true, deleted: userId });
    }
    if (decision === 'privileges') {
      const wanted = Array.isArray(body.privileges) ? body.privileges : [];
      // Only privileges this server knows about, deduped. An unknown string in the
      // column would sit there forever looking like a permission somebody has.
      const clean = [...new Set(wanted.filter((k) => PRIVILEGE_KEYS.includes(k)))];
      const updated = await setUserPrivileges(userId, clean);
      if (!updated) return send(res, 404, { ok: false, error: 'Account not found.' });
      // A supplier is external and holds none of the staff duties — setUserPrivileges
      // strips them, so say so rather than letting the checkboxes silently spring back.
      // (`request_buying` is theirs to hold; it is the only one that survives.)
      if (updated.role === 'supplier' && clean.some((k) => !BUYER_PRIVILEGE_KEYS.includes(k)))
        return send(res, 200, { ok: true, user: updated, note: 'Buyers can only hold “Raise buying requests” — the other duties would have them approving their own requests.' });
      return send(res, 200, { ok: true, user: updated });
    }
    // Linking a Telegram account, so a button tap in the approval group can be recorded
    // against a real person. A blank value UNLINKS — the same shape as unticking a
    // privilege, and revoking has to be as ordinary as granting.
    if (decision === 'telegram') {
      const raw = String(body.telegramUserId ?? '').trim();
      const tgId = raw === '' ? null : Number(raw);
      if (tgId !== null && (!Number.isInteger(tgId) || tgId <= 0))
        return send(res, 400, { ok: false, error: 'A Telegram user id is a positive number — @userinfobot in Telegram gives it.' });
      // A BUYER must never hold one. They cannot approve anything anyway, but a linked
      // supplier account is a tap away from looking like an approver in the group, and
      // the whole point of this map is that a decision names the right person.
      const target = await getUserById(userId);
      if (!target) return send(res, 404, { ok: false, error: 'Account not found.' });
      if (tgId !== null && target.role === 'supplier')
        return send(res, 400, { ok: false, error: 'Buyers can’t be linked — they would be approving their own requests.' });
      try {
        const updated = await setUserTelegramId(userId, tgId);
        // Dealt with — drop it off the waiting list rather than leaving a row somebody
        // has to dismiss. Linking IS the dismissal.
        if (tgId !== null) await clearTelegramLinkRequest(tgId).catch(() => {});
        return send(res, 200, { ok: true, user: updated });
      } catch (e) {
        // The unique index. Two accounts on one Telegram id would make the attribution
        // ambiguous in exactly the place it must not be.
        if (String(e.message).includes('users_telegram_id_idx'))
          return send(res, 409, { ok: false, error: 'That Telegram account is already linked to somebody else.' });
        throw e;
      }
    }
    if (decision === 'role') {
      if (!ROLES.includes(body.role)) return send(res, 400, { ok: false, error: 'Invalid role.' });
      const updated = await setUserRole(userId, body.role, admin.name || 'admin');
      if (!updated) return send(res, 404, { ok: false, error: 'Account not found.' });
      return send(res, 200, { ok: true, user: updated });
    }
    const status = decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : null;
    if (!status) return send(res, 400, { ok: false, error: 'Provide a valid decision (approve/reject/role/privileges/delete).' });
    const updated = await reviewUser(userId, status, admin.name || 'admin');
    if (!updated) return send(res, 404, { ok: false, error: 'Account not found.' });
    return send(res, 200, { ok: true, user: updated });
  } catch (e) {
    console.error('[admin/review]', e.message);
    return send(res, 500, { ok: false, error: 'Could not update the account.' });
  }
}
