// Shared by api/cancellations/* (docs/context/cancellations.md). "_" = not mounted.
// The warehouse SENDS orders to cancel (Telegram, or by hand here); only PH and admin
// REVIEW them — verify against the photo, reject, mark cancelled on the platform.
import { isPrivileged } from '../_lib/util.js';

export const VIEW_ROLES = ['warehouse', 'ph_team'];
export const canReview = (user) => user?.role === 'ph_team' || isPrivileged(user?.role);
export const actorOf = (user) => user?.name || user?.username || null;
export const idOf = (v) => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : null; };
export const text = (v, n) => { const s = String(v ?? '').trim(); return s ? s.slice(0, n) : null; };
