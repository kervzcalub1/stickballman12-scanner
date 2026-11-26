// Shared by the api/buy-log/* handlers (docs/context/buy-log.md). A file starting with "_"
// is not mounted as a route.
//
// WHO: a SUPPLIER switched on for it (`log_buys`, read fresh from the database like every
// privilege) sees and edits only their own orders. PH / admin see every supplier's, enter
// one on a supplier's behalf, and are the only ones who record PAYMENTS — the supplier does
// not sign for money sent to them. The warehouse reads (what is coming, what was declared).
import { send, requireRole, isPrivileged } from '../_lib/util.js';
import { hasPrivilege } from '../_lib/buycart.js';

export const actorOf = (user) => user?.name || user?.username || null;
export const idOf = (v) => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : null; };
export const MAX_MONEY = 1_000_000;
// A real calendar date, not just the right shape — Feb 30 is refused, not a 500.
export const realDate = (v) => {
  const s = String(v || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : null;
};

/** The signed-in user if they may use the Buy Log, else null after answering. */
export async function buyLogUser(req, res) {
  const user = requireRole(req, res, ['ph_team', 'warehouse', 'supplier']); // admin/superadmin auto-allowed
  if (!user) return null;
  if (user.role === 'supplier' && !(await hasPrivilege(user, 'log_buys'))) {
    send(res, 403, { ok: false, error: 'The buy log isn’t switched on for your account. Ask an admin to enable “Keep a buy log”.' });
    return null;
  }
  return user;
}
export const isSupplier = (user) => user.role === 'supplier';
// Staff who may change an order or record a payment (the warehouse only reads).
export const canManage = (user) => isPrivileged(user.role) || user.role === 'ph_team';
// Does this user own (or oversee) the order? → true, or false after answering.
export function ownsBuy(res, user, buy) {
  if (!buy) { send(res, 404, { ok: false, error: 'That order no longer exists.' }); return false; }
  if (isSupplier(user) && Number(buy.supplier_user_id) !== Number(user.uid)) { send(res, 404, { ok: false, error: 'That order no longer exists.' }); return false; }
  return true;
}
