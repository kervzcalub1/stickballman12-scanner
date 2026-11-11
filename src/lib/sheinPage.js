// The one SHEIN page (src/screens/Shein.jsx): which sections a person may see, and where the old
// separate pages' URLs land. Pure, so the routers in constants.js and ph.js can use it and a spec can
// test it without a browser. `section` values are URL keys; the words are in sheinWords.js.
export const SHEIN_SECTION_KEYS = ['today', 'listings', 'orders', 'check', 'reprice', 'live'];

// The page's own paths and the old pages'. A path listed here always opens the SHEIN page, in whichever
// workspace the person is in, so an old bookmark, a Telegram link or a SOP link keeps working.
const NEW_PATHS = new Set(['/shein', '/ph/shein']);
const OLD_PATHS = {
  '/ph/shein-listings': 'listings', '/shein-listings': 'listings',
  '/ph/shein-check': 'check', '/shein-check': 'check',
  '/ph/shein-reprice': 'reprice',
};
const clean = (p) => String(p || '/').replace(/\/+$/, '') || '/';
export const isSheinPath = (p) => NEW_PATHS.has(clean(p)) || !!OLD_PATHS[clean(p)];

// Same access as the old pages, enforced again by each endpoint.
//   PH or admin: everything (the Prices endpoint and template allow admins too; Orders = /api/shein/orders, PH + admin).
//   A warehouse account holding "Connect integrations": what the old check page gave it, nothing else.
export function sheinSectionsFor(user) {
  const role = user?.role;
  if (role === 'admin' || role === 'superadmin' || role === 'ph_team') return SHEIN_SECTION_KEYS;
  if (Array.isArray(user?.privileges) && user.privileges.includes('connect_integrations')) return ['check', 'live'];
  return [];
}

// The URL this address should really be, or null if it already is. `base` is the mounted workspace's
// path ('/ph/shein' or '/shein').
export function canonicalSheinUrl(pathname, search, base) {
  const path = clean(pathname);
  if (!isSheinPath(path)) return null;
  const p = new URLSearchParams(search || '');
  const old = OLD_PATHS[path] || '';
  // The old check page never read ?tab= (its tabs were in memory), but SHEIN Listings' blocker link wrote
  // ?tab=match. On this page `tab` belongs to the Listings section, so it can't be left there.
  if (old === 'check' && p.has('tab')) {
    if (['match', 'fix'].includes(p.get('tab'))) p.set('chk', p.get('tab'));
    p.delete('tab');
  }
  // Back from SHEIN's approval page: the result is shown beside the Connect button.
  const back = p.has('shein') || p.has('shein_error');
  const section = back ? 'live' : p.get('section') || old;
  p.delete('section');
  const rest = p.toString();
  const qs = [section ? `section=${encodeURIComponent(section)}` : '', rest].filter(Boolean).join('&');
  const next = `${base}${qs ? `?${qs}` : ''}`;
  return next === `${pathname}${search || ''}` ? null : next;
}
