// Shared by api/inbound-issues/* (docs/context/inbound-issues.md). "_" = not mounted.
// The warehouse REPORTS problems (at receiving, or on the page) and does the physical jobs
// a case asks for; the PH team (and admins) OWN the cases — take, work with the supplier,
// resolve.
import { isPrivileged } from '../_lib/util.js';

export const VIEW_ROLES = ['warehouse', 'ph_team'];
export const canWork = (user) => user?.role === 'ph_team' || isPrivileged(user?.role);
export const actorOf = (user) => user?.name || user?.username || null;
// `uid` is the users row id; the env logins (admin / superadmin) carry a word there → null.
export const uidOf = (user) => Number(user?.uid) || null;
export const idOf = (v) => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : null; };
export const text = (v, n) => { const s = String(v ?? '').trim(); return s ? s.slice(0, n) : null; };
