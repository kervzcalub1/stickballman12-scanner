// App-wide constants: top-level routing, role labels, receiving domain lists,
// sync/home-card config, and small shared helpers.

// Top-level pages are reflected in the URL path so a refresh restores the page
// (and pages are linkable). Sub-state (open item, wizard step) stays in memory.
export const ROUTES = ['receiving', 'rescale', 'batches', 'inventory', 'report', 'access', 'nobox', 'sold', 'shipped', 'rescalereq', 'shelve', 'locations'];
export const pathForView = (v) => (v && v !== 'home' ? `/${v}` : '/');
export const viewForPath = (p) => {
  const seg = String(p || '/').replace(/^\/+|\/+$/g, '').split('/')[0];
  return ROUTES.includes(seg) ? seg : 'home';
};

export const ROLE_LABEL = { admin: 'Admin', warehouse: 'Warehouse', ph_team: 'PH Team' };
export const roleLabel = (r) => ROLE_LABEL[r] || r;

export const SUPPLIERS = ['Sunny', 'Nike', 'Foot Locker', 'DTLR', 'Snipes', 'Champs', 'Finish Line', 'Shoe Palace'];

// Shelf-location warehouses + areas (mirrors api/_lib/locations.js prefix maps).
export const WAREHOUSES = ['Manheim Main Shed', 'Mount Joy', "Kready's Farm"];
export const LOCATION_AREAS = ['Warehouse Rows', 'Pods', 'Office Space', 'Basement Space'];

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

// Per-unit defect types flagged on the receiving Review screen (V6 Feature 4).
// Each flagged issue picks one of these; stored on the unit's 'issue' event.
// Flagging 'no_box' also forces the unit's STATUS to no_box on commit (same end
// state as the per-shoe box-status toggle) — see api/batches/commit.js.
export const DEFECT_TYPES = [
  ['crease', 'Crease'],
  ['dirty', 'Dirty / stained'],
  ['yellowing', 'Yellowing'],
  ['glue', 'Glue / factory defect'],
  ['missing_insole', 'Missing insole'],
  ['damaged_box', 'Damaged box'],
  ['no_box', 'No box'],
  ['wrong_item', 'Wrong item / mismatch'],
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
    { key: 'batches', icon: '🗃️', title: 'Batches', sub: 'Open & past batches — add boxes, track progress' },
    { key: 'shelve', icon: '📍', title: 'Shelve / Put-away', sub: 'Scan a shelf, then scan shoes onto it' },
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
    { key: 'locations', icon: '🗺️', title: 'Locations', sub: 'Browse shelves, add & print labels' },
    { key: 'report', icon: '📊', title: 'Report', sub: 'Monthly listing & store sync' },
  ] },
];

// Total quantity across a [{qty}] size array (rescale reported vs actual).
export const sumQty = (arr) => (Array.isArray(arr) ? arr : []).reduce((n, s) => n + (Number(s.qty) || 0), 0);
