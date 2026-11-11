// Shared by api/cancellations/* (docs/context/cancellations.md). "_" = not mounted.
// Warehouse, PH and admin all see the record and may fix a row (type a misread number, add a
// missing SKU) — there is no review step since 2026-11-12. Removing a row (a wrong photo,
// not an order) is PH / admin, or whoever sent it.
import { isPrivileged } from '../_lib/util.js';

export const VIEW_ROLES = ['warehouse', 'ph_team'];
export const canRemove = (user, row) => user?.role === 'ph_team' || isPrivileged(user?.role)
  || (row?.sent_by_user_id != null && Number(user?.uid) === Number(row.sent_by_user_id));
export const actorOf = (user) => user?.name || user?.username || null;
export const idOf = (v) => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : null; };
export const text = (v, n) => { const s = String(v ?? '').trim(); return s ? s.slice(0, n) : null; };
export const isYmd = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(Date.parse(`${v}T12:00:00Z`));
