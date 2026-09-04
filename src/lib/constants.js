// App-wide constants: top-level routing, role labels, receiving domain lists,
// sync/home-card config, and small shared helpers.

// Top-level pages are reflected in the URL path so a refresh restores the page
// (and pages are linkable). Sub-state (open item, wizard step) stays in memory.
export const ROUTES = ['receiving', 'inbound', 'presell', 'rescale', 'instore', 'instore-listing', 'existing-stock', 'batches', 'inventory', 'report', 'access', 'settings', 'nobox', 'box-labels', 'box-stock', 'costs', 'payout', 'sold', 'shipped', 'rescalereq', 'shelve', 'locations', 'reconcile', 'sop', 'deleted', 'vin-stock', 'merge'];
export const pathForView = (v) => (v && v !== 'home' ? `/${v}` : '/');
export const viewForPath = (p) => {
  const seg = String(p || '/').replace(/^\/+|\/+$/g, '').split('/')[0];
  return ROUTES.includes(seg) ? seg : 'home';
};

export const ROLE_LABEL = { admin: 'Admin', superadmin: 'Super Admin', warehouse: 'Warehouse', ph_team: 'PH Team' };
export const roleLabel = (r) => ROLE_LABEL[r] || r;
// Admin-level roles: the env `admin` and env `superadmin` accounts. Superadmin
// additionally sees the PH-team workspace (see App.jsx / Home.jsx).
export const isAdminRole = (r) => r === 'admin' || r === 'superadmin';

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
// Store-sync backlog. Toned `info` (neutral) rather than amber: these are a standing
// workload that's essentially never zero, and four permanent amber chips drown out the
// episodic queues (No box / To reconcile) that actually want a response today.
export const SYNC_BADGES = (c) => [
  ['II', c.not_ii, 'info'], ['AL', c.not_alias, 'info'],
  ['SX', c.not_stockx, 'info'], ['SH', c.not_shopify, 'info'],
];
export function homeCardBadges(key, c) {
  if (!c) return [];
  if (key === 'report') return SYNC_BADGES(c);
  if (key === 'inventory') return [['Needs shelf', c.needs_shelf]];
  if (key === 'nobox') return [['No box', c.no_box]];
  if (key === 'costs') return [['No cost', c.missing_cost]];
  if (key === 'rescale') return [['Restock', c.restock_pending]];
  // Pre-sell units still waiting for somebody to say which orders they cover. Amber:
  // nothing on that shipment can be listed until the question is answered.
  if (key === 'presell') return [['To work', c.presell_pending]];
  if (key === 'instore-listing') return [['Not listed', c.instore_unlisted]];
  if (key === 'rescalereq') return [['Pending', c.rescale_requests], ['Done', c.rescale_requests_audited, 'ok']];
  // Two states, two tones: 'To reconcile' (amber) = intake finished and a human has to
  // decide something; 'Receiving' (neutral info) = arrived, still being scanned in. Both
  // hide at 0, so the card still tells you a PO is in flight without dressing it as a chore.
  if (key === 'reconcile') return [['To reconcile', c.po_to_reconcile], ['Receiving', c.po_receiving, 'info']];
  // A supplier is packed and waiting on us to buy labels — nothing on their side moves
  // until somebody here acts, so it belongs on the order list's own card.
  if (key === 'po') return [['Labels requested', c.po_labels_requested]];
  // Empty shoe boxes. "On hand" is stock, not a chore, so it reads as neutral info; only
  // the ones still to put away are amber. Both hide at 0, which is most days.
  if (key === 'box-stock') return [['On hand', c.boxes_on_hand, 'info'], ['To shelve', c.boxes_needs_shelf]];
  return [];
}

// Home is grouped by the shoe's lifecycle through the warehouse: Intake →
// Put-away → Rescale → Sell & Ship → Browse & Reports, with Admin last.
// `adminOnly` sections show for admin + superadmin; `superOnly` for superadmin only.
// `accent` picks the section's colour token (see [data-accent] in styles.css) — it only
// affects the card rail + icon hue, so an unknown/absent value just falls back to blue.
export const HOME_SECTIONS = [
  { title: 'Receiving Shipment Orders', accent: 'shipping', cards: [
    { key: 'receiving', icon: '📥', title: 'Receive New', sub: 'Scan a new shipment into a batch' },
    { key: 'inbound', icon: '🚚', title: 'Inbound', sub: 'What is coming, from whom, and what has stopped moving — every box still on its way' },
    { key: 'vin-stock', icon: '🏷️', title: '1ID Stickers', sub: 'Print blank 1ID stickers in bulk so intake never waits on a printer' },
    { key: 'batches', icon: '🗃️', title: 'Batches', sub: 'Open & past batches — add boxes, track progress' },
    { key: 'presell', icon: '🔖', title: 'Pre-sell', sub: 'Shipments sold before they landed — say how many each order covers, then send the rest for rescale' },
    { key: 'reconcile', icon: '✅', title: 'PO Reconciliation', sub: 'Received vs. supplier manifest — flag & report discrepancies' },
    { key: 'costs', icon: '💵', title: 'Costs', sub: 'Fill in what a pair cost when the supplier left it off the manifest' },
  ] },
  { title: 'In-Store Mode', accent: 'inventory', cards: [
    { key: 'instore', icon: '🛍️', title: 'In-Store Buying', sub: 'Scan pairs as you buy them at the store' },
    { key: 'instore-listing', icon: '🏷️', title: 'In-Store Listing', sub: 'Mark in-store buys listed to Alias/StockX/Shopify' },
    { key: 'payout', icon: '🧮', title: 'Payout Calculator', sub: 'Cost after discounts vs. what Alias/StockX pay out — is this pair a buy?' },
  ] },
  // A one-off migration mode, not part of the daily loop — its own section so it
  // reads as "the project of getting old stock into the system", not as receiving.
  { title: 'Existing Stock', accent: 'existing', cards: [
    { key: 'existing-stock', icon: '📦', title: 'Count Existing Stock', sub: 'Scan a shelf, then the pairs already on it (never reaches the PH team)' },
  ] },
  { title: 'Put-away', accent: 'orders', cards: [
    { key: 'shelve', icon: '📍', title: 'Shelve / Put-away', sub: 'Scan a shelf, then scan shoes onto it' },
    { key: 'nobox', icon: '🚫', title: 'No Box / Not Ready', sub: 'Resolve units bought without a box' },
    { key: 'box-labels', icon: '🏷️', title: 'Box Labels', sub: 'Replacement box label for a pair with no box — by VIN, UPC or SKU' },
    // Sits beside No Box on purpose: "is there a box for this?" is the question you ask
    // while standing over a pair that hasn't got one.
    { key: 'box-stock', icon: '🗃️', title: 'Empty Box Stock', sub: 'Spare shoe boxes on hand — find one that fits a pair' },
  ] },
  { title: 'Rescale', accent: 'requests', cards: [
    { key: 'rescale', icon: '♻️', title: 'Rescale Stock', sub: 'Re-scan in-hand stock (no shipment)' },
    { key: 'rescalereq', icon: '📨', title: 'Rescale Requests', sub: 'PH-flagged SKUs to recount / rescan' },
  ] },
  { title: 'Sell & Ship', accent: 'shipping', cards: [
    { key: 'sold', icon: '💰', title: 'Mark Sold', sub: 'Scan VINs to mark sold (delists from all stores)' },
    { key: 'shipped', icon: '📦', title: 'Mark Shipped', sub: 'Scan VINs to mark shipped' },
  ] },
  { title: 'Browse & Listings', accent: 'listing', cards: [
    { key: 'inventory', icon: '🔎', title: 'Inventory', sub: 'Search, scan & print labels' },
    { key: 'locations', icon: '🗺️', title: 'Locate Shoe', sub: 'Find which shelf a shoe is on' },
    { key: 'report', icon: '📊', title: 'Listings & Sync', sub: 'Store listings & sync status' },
    { key: 'deleted', icon: '🗑️', title: 'Deleted', sub: 'Pairs removed from inventory — search by SKU, history kept' },
  ] },
  { title: 'PH Team', superOnly: true, accent: 'requests', cards: [
    { key: 'ph', icon: '🧾', title: 'PH Team Workspace', sub: 'Open the PH pricing / listing pages (New Inventory, Rescale, Photos…)' },
  ] },
  // Last, and for everyone: the written procedures are a reference you go to
  // deliberately, not a queue — so it sits below the work rather than competing
  // with it. No badge, ever.
  { title: 'Help', accent: 'help', cards: [
    { key: 'sop', icon: '📖', title: 'SOP & Help', sub: 'Step-by-step procedures for every screen, searchable, plus FAQ' },
  ] },
  { title: 'Administration', adminOnly: true, accent: 'orders', cards: [
    { key: 'access', icon: '🔑', title: 'Check Access', sub: 'Approve, change role, reset password, or remove accounts' },
    { key: 'settings', icon: '⚙️', title: 'Settings', sub: 'Price margin % and other app-wide settings' },
  ] },
  // Superadmin only: both tools rewrite records other people rely on and neither can be
  // undone from the screen, so they sit a notch above the rest of Administration.
  { title: 'Superadmin', superOnly: true, accent: 'orders', cards: [
    { key: 'merge', icon: '🔗', title: 'Merge duplicates', sub: 'One supplier entered twice, or one inbound received as two batches — fold them together' },
  ] },
];

// "Needs attention" strip on Home — a card only appears when its pending count is
// >0, linking to the screen that clears that queue. (from usePendingCounts)
export const HOME_ATTENTION = [
  { key: 'nobox', label: 'No box', count: 'no_box' },
  { key: 'costs', label: 'No cost on file', count: 'missing_cost' },
  { key: 'shelve', label: 'Needs shelf', count: 'needs_shelf' },
  { key: 'rescalereq', label: 'Rescale requests', count: 'rescale_requests' },
  { key: 'rescale', label: 'Restock', count: 'restock_pending' },
  { key: 'presell', label: 'Pre-sell to work', count: 'presell_pending' },
  { key: 'reconcile', label: 'PO reconcile', count: 'po_to_reconcile' },
];

// Total quantity across a [{qty}] size array (rescale reported vs actual).
export const sumQty = (arr) => (Array.isArray(arr) ? arr : []).reduce((n, s) => n + (Number(s.qty) || 0), 0);
