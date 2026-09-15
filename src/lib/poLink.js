// Where "the order" lives for whoever is looking. The same purchase order is opened on
// three different screens depending on who you are — the supplier's Outbound Shipments,
// PH's Purchase Orders, the warehouse's Reconciliation — and each of them reads `?po=`.
// A buying request links to its order from the same component on all three shells, so
// the shell is decided here, once, off the role rather than the hostname (the hostname
// is branding; the role is what the server actually scopes by).
import { PH_PATHS } from './ph.js';

export function poHref(user, poId) {
  if (!poId) return '';
  const role = user?.role;
  if (role === 'supplier') return `/orders?po=${poId}`;
  // `postatus` (PoOverview) is the screen that reads ?po=. `po` is the create-an-order
  // form — a link there opened a blank "New batch" with the id silently ignored.
  if (role === 'ph_team') return `${PH_PATHS.postatus}?po=${poId}`;
  return `/reconcile?po=${poId}`;
}
