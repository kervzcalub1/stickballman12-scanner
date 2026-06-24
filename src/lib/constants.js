// App-wide constants: top-level routing, role labels, receiving domain lists,
// sync/home-card config, and small shared helpers.

// Top-level pages are reflected in the URL path so a refresh restores the page
// (and pages are linkable). Sub-state (open item, wizard step) stays in memory.
export const ROUTES = ['receiving', 'rescale', 'inventory', 'report', 'access', 'nobox', 'sold', 'shipped', 'rescalereq'];
export const pathForView = (v) => (v && v !== 'home' ? `/${v}` : '/');
export const viewForPath = (p) => {
  const seg = String(p || '/').replace(/^\/+|\/+$/g, '').split('/')[0];
  return ROUTES.includes(seg) ? seg : 'home';
};

export const ROLE_LABEL = { admin: 'Admin', warehouse: 'Warehouse', ph_team: 'PH Team' };
export const roleLabel = (r) => ROLE_LABEL[r] || r;

export const SUPPLIERS = ['Sunny', 'Nike', 'Foot Locker', 'DTLR', 'Snipes', 'Champs', 'Finish Line', 'Shoe Palace'];

// Why in-hand stock is being re-scaled (no shipment). Stored on the batch.
export const RESCALE_REASONS = [
  ['returned', 'Returned'],
  ['relisting', 'Re-listing'],
  ['recount', 'Recount / found stock'],
  ['transfer', 'Transfer'],
  ['other', 'Other'],
];

export const ISSUE_TYPES = [
  ['mismatched', 'Mismatched shoe'],
  ['stolen', 'Stolen package'],
  ['ripped', 'Package ripped open'],
  ['improperly_packed', 'Improperly packed'],
  ['missing_boxes', 'Missing boxes'],
  ['shortfall', 'Short count (expected vs received)'],
  ['other', 'Other'],
];

// Reasons PH flags a SKU for the warehouse to recount / rescan.
export const REQUEST_REASONS = [['mismatch', 'Mismatch'], ['quantity', 'Quantity mismatch'], ['recount', 'Recount'], ['returned', 'Returned'], ['relisting', 'Re-listing'], ['other', 'Other']];

// PH-Team sync indicators (Intelligent Inventory + Alias / StockX / Shopify).
export const SYNC_FIELDS = [
  ['added_to_intel_inv', 'II', 'Intelligent Inventory'],
  ['synced_alias', 'AL', 'Alias'],
  ['synced_stockx', 'SX', 'StockX'],
  ['synced_shopify', 'SH', 'Shopify'],
];

// Which badges a given home-card key shows. The four store badges (II/AL/SX/SH)
// go on the listing card; the others on their matching card.
export const SYNC_BADGES = (c) => [['II', c.not_ii], ['AL', c.not_alias], ['SX', c.not_stockx], ['SH', c.not_shopify]];
export function homeCardBadges(key, c) {
  if (!c) return [];
  if (key === 'report') return SYNC_BADGES(c);
  if (key === 'inventory') return [['Needs shelf', c.needs_shelf]];
  if (key === 'nobox') return [['No box', c.no_box]];
  if (key === 'rescale') return [['Restock', c.restock_pending]];
  if (key === 'rescalereq') return [['Pending', c.rescale_requests], ['Done', c.rescale_requests_audited, 'ok']];
  return [];
}

// Home is grouped into categories. `adminOnly` cards/sections show for admin only.
export const HOME_SECTIONS = [
  { title: 'Administration', adminOnly: true, cards: [
    { key: 'access', icon: '🔑', title: 'Check Access', sub: 'Approve, change role, or remove accounts' },
  ] },
  { title: 'Receiving & Stock', cards: [
    { key: 'receiving', icon: '📥', title: 'Receive New', sub: 'Scan a new shipment into a batch' },
    { key: 'rescale', icon: '♻️', title: 'Rescale Stock', sub: 'Re-scan in-hand stock (no shipment)' },
    { key: 'rescalereq', icon: '📨', title: 'Rescale Requests', sub: 'PH-flagged SKUs to recount / rescan' },
    { key: 'nobox', icon: '🚫', title: 'No Box / Not Ready', sub: 'Resolve units bought without a box' },
  ] },
  { title: 'Sales & Shipment', cards: [
    { key: 'sold', icon: '💰', title: 'Mark Sold', sub: 'Scan VINs to mark sold (delists from all stores)' },
    { key: 'shipped', icon: '📦', title: 'Mark Shipped', sub: 'Scan VINs to mark shipped' },
  ] },
  { title: 'Reports & Lookup', cards: [
    { key: 'inventory', icon: '🔎', title: 'Inventory', sub: 'Search, scan & print labels' },
    { key: 'report', icon: '📊', title: 'Report', sub: 'Monthly listing & store sync' },
  ] },
];

// Total quantity across a [{qty}] size array (rescale reported vs actual).
export const sumQty = (arr) => (Array.isArray(arr) ? arr : []).reduce((n, s) => n + (Number(s.qty) || 0), 0);
