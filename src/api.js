// Tiny frontend API client. Attaches the session token and unwraps errors.

const TOKEN_KEY = 'sb_session_token';
const USER_KEY = 'sb_user';

export function getToken() {
  return sessionStorage.getItem(TOKEN_KEY) || '';
}
export function setToken(t) {
  if (t) sessionStorage.setItem(TOKEN_KEY, t);
}
export function getUser() {
  try { return JSON.parse(sessionStorage.getItem(USER_KEY) || 'null'); }
  catch { return null; }
}
export function setUser(u) {
  if (u) sessionStorage.setItem(USER_KEY, JSON.stringify(u));
}
export function clearAuth() {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(USER_KEY);
}
// Back-compat alias used by older call sites.
export const clearToken = clearAuth;

async function request(method, path, body, { auth = true } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth) {
    const t = getToken();
    if (t) headers.Authorization = `Bearer ${t}`;
  }
  const res = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  let data = {};
  try { data = await res.json(); } catch { /* ignore */ }

  if (res.status === 401) {
    clearAuth();
    const err = new Error(data.error || 'Session expired. Please sign in again.');
    err.unauthorized = true;
    throw err;
  }
  if (!res.ok || data.ok === false) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    if (res.status === 409) err.conflict = true;
    throw err;
  }
  return data;
}

const post = (path, body, opts) => request('POST', path, body ?? {}, opts);
const get = (path, opts) => request('GET', path, undefined, opts);

// Authenticated binary download → { blob, filename }. Parses the filename from
// Content-Disposition; falls back to the last path segment.
async function downloadBlob(path) {
  const t = getToken();
  const res = await fetch(path, { headers: t ? { Authorization: `Bearer ${t}` } : {} });
  if (res.status === 401) { clearAuth(); const err = new Error('Session expired. Please sign in again.'); err.unauthorized = true; throw err; }
  if (!res.ok) {
    let msg = `Download failed (${res.status})`;
    try { const d = await res.json(); if (d.error) msg = d.error; } catch { /* not json */ }
    throw new Error(msg);
  }
  const cd = res.headers.get('Content-Disposition') || '';
  const m = /filename="?([^"]+)"?/.exec(cd);
  const filename = m ? m[1] : path.split('/').pop();
  return { blob: await res.blob(), filename };
}

export const api = {
  // Auth
  login: (username, password) => post('/api/auth/login', { username, password }, { auth: false }),
  signup: (payload) => post('/api/auth/signup', payload, { auth: false }),
  requestReset: (username) => post('/api/auth/request-reset', { username }, { auth: false }),
  changePassword: (newPassword) => post('/api/auth/change-password', { newPassword }),
  // Admin
  adminListUsers: () => get('/api/admin/users'),
  adminReview: (userId, decision) => post('/api/admin/review', { userId, decision }),
  adminSetRole: (userId, role) => post('/api/admin/review', { userId, decision: 'role', role }),
  adminDeleteUser: (userId) => post('/api/admin/review', { userId, decision: 'delete' }),
  adminResetPassword: (userId) => post('/api/admin/reset-password', { userId }),
  // App settings (price margin, …). GET is any authed user; POST is admin/superadmin.
  getSettings: () => get('/api/settings'),
  setPriceMarkup: (priceMarkupPct) => post('/api/settings', { priceMarkupPct }),
  // Where suppliers send their boxes (also printed on the manifest). Admin-only write.
  setShipTo: (shipTo) => post('/api/settings', { shipTo }),
  // Product search + sheet
  searchUpc: (upc) => post('/api/upc-search', { upc }),
  setItemUpc: (vin, upc) => post('/api/items/set-upc', { vin, upc }),
  searchSku: (sku) => post('/api/sku-search', { sku }),
  // v4 — receiving / batches
  suppliers: () => get('/api/suppliers'),
  checkTracking: (tracking) => get(`/api/batches/check-tracking?tracking=${encodeURIComponent(tracking)}`),
  batchCommit: (payload) => post('/api/batches/commit', payload),
  // v6 — multi-box batches (Feature 7)
  createOpenBatch: (batch) => post('/api/batches/create-open', { batch }),
  batchAddBox: (batchId, trackingNumber, boxNumber = null) => post('/api/batches/add-box', { batchId, trackingNumber, boxNumber }),
  batchSyncBoxes: (batchId, boxes) => post('/api/batches/sync-boxes', { batchId, boxes }),
  batchRenumberBox: (batchId, boxId, boxNumber) => post('/api/batches/renumber-box', { batchId, boxId, boxNumber }),
  boxCommit: (payload) => post('/api/batches/box-commit', payload),
  openBatches: () => get('/api/batches/open-list'),
  batchFull: (id) => get(`/api/batches/full?id=${encodeURIComponent(id)}`),
  batchSetStatus: (id, status) => post('/api/batches/set-status', { id, status }),
  // v6 — listing photos (per SKU, stored in Cloudflare R2)
  photoList: (sku) => get(`/api/photos/list?sku=${encodeURIComponent(sku)}`),
  // `source` (optional) = 'warehouse' (default) | 'ph_edited'. Omit for warehouse capture.
  photoDownload: (sku, source) => downloadBlob(`/api/photos/download?sku=${encodeURIComponent(sku)}${source ? `&source=${source}` : ''}`),
  photoSign: (sku, angle, contentType, source) => post('/api/photos/sign', { sku, angle, contentType, source }),
  photoSignIssue: (vin, contentType) => post('/api/photos/sign-issue', { vin, contentType }),
  photoAttach: (sku, angle, url, source) => post('/api/photos/attach', { sku, angle, url, source }),
  photoRemove: (sku, angle, source) => post('/api/photos/remove', { sku, angle, source }),
  // Image Finder — source StockX renders (hero + 360° spin) for a SKU, then import
  // the picked angles into R2 as ph_edited listing photos.
  // `all` = also query the metered GOAT/StockX catalogue even when a brand feed answered
  // (the "Also search GOAT/StockX" button). The default search skips it to save calls.
  imageFinderSearch: (sku, all = false) =>
    get(`/api/images/search?sku=${encodeURIComponent(sku)}${all ? '&all=1' : ''}`),
  imageFinderImport: (sku, picks) => post('/api/images/import', { sku, picks }),
  // Cut a shoe out for the live position/resize editor → { cutoutUrl, bbox, width, height }.
  imageFinderCutout: (sku, url) => post('/api/images/cutout', { sku, url }),
  // Brand & Fill — composite picks onto the template with name+SKU, + spec + welcome.
  // `size` = output resolution (1600 default, or 1400 for eBay's recommendation).
  // `mode` = 'preview' (data-URI results, nothing saved) or 'commit' (persist to R2).
  imageFinderBrand: (sku, title, picks, includeSpec, includeWelcome, size, mode = 'preview') =>
    post('/api/images/brand', { sku, title, picks, includeSpec, includeWelcome, size, mode }),
  reserveVins: (count, dateReceived) => post('/api/vins/reserve', { count, dateReceived }),
  // Pre-printed 1ID roll stock ("VIN Project").
  mintVins: (count) => post('/api/vins/mint', { count }),
  vinStock: () => get('/api/vins/stock'),
  vinRun: (run) => get(`/api/vins/stock?run=${encodeURIComponent(run)}`),
  checkVin: (vin) => get(`/api/vins/check?vin=${encodeURIComponent(vin)}`),
  voidVins: (vins) => post('/api/vins/void', { vins }),
  batchList: (kind) => get(`/api/batches/list${kind ? `?kind=${kind}` : ''}`),
  batchGet: (id) => get(`/api/batches/get?id=${encodeURIComponent(id)}`),
  itemLookup: (code) => get(`/api/items/lookup?code=${encodeURIComponent(code)}`),
  // Exact UPC/SKU match against our own stock (Box Labels asks this before the catalogue).
  itemsFind: (code) => get(`/api/items/find?code=${encodeURIComponent(code)}`),
  // Shelf locations (put-away + management)
  locationLookup: (code) => get(`/api/locations/lookup?code=${encodeURIComponent(code)}`),
  shelveItems: (locationCode, units) => post('/api/items/shelve', { locationCode, units }),
  locationList: (p = {}) => get(`/api/locations?${new URLSearchParams(Object.fromEntries(Object.entries(p).filter(([, v]) => v != null && v !== ''))).toString()}`),
  locationItems: (id) => get(`/api/locations/items?id=${encodeURIComponent(id)}`),
  locationCreate: (payload) => post('/api/locations/create', payload),
  locationBulk: (payload) => post('/api/locations/bulk', payload),
  locationUpdate: (id, patch) => post('/api/locations/update', { id, ...patch }),
  locationDelete: (id) => post('/api/locations/delete', { id }),
  // Rename/move a whole node of the tree (site | area | row | bay). dryRun previews the
  // barcode changes without writing.
  locationRenameGroup: (payload) => post('/api/locations/rename-group', payload),
  // Delete a whole node of the tree (site | area | row | bay) — every shelf under it.
  // dryRun counts what would go without writing; live stock 409s and deletes nothing.
  locationDeleteGroup: (payload) => post('/api/locations/delete-group', payload),
  itemHistory: (vins) => get(`/api/items/history?vins=${encodeURIComponent((vins || []).join(','))}`),
  itemEvent: (vin, type, details) => post('/api/items/event', { vin, type, details }),
  rescaleItem: (vin, status, note, reason) => post('/api/items/rescale', { vin, status, note, reason }),
  itemsQuery: (params) => get(`/api/items/query?${new URLSearchParams(params).toString()}`),
  noBoxList: (from, to) => get(`/api/items/no-box?${new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) }).toString()}`),
  // In-Store Listing worklist + per-store (Alias/StockX/Shopify) flag updates.
  instoreList: (from, to) => get(`/api/items/instore-list?${new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) }).toString()}`),
  instoreListed: (vins, flags) => post('/api/items/instore-listed', { vins, ...flags }),
  // Costs page: the "no cost on file" backlog, a SKU lookup for fixing one that's
  // already there, and the save. Blank cost clears to unknown, never to $0.
  costsList: (from, to, mode) => get(`/api/items/costs?${new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}), ...(mode ? { mode } : {}) }).toString()}`),
  costsSearch: (q) => get(`/api/items/costs?q=${encodeURIComponent(q)}`),
  setItemsCost: (vins, cost) => post('/api/items/set-cost', { vins, cost }),
  pendingCounts: () => get('/api/items/pending-counts'),
  boxFound: (vin) => post('/api/items/box-found', { vin }),
  restockDone: (vins) => post('/api/items/restock-done', { vins }),
  // PH-requested rescales
  rescaleRequestCreate: (payload) => post('/api/rescale-requests/create', payload),
  rescaleRequestList: (status, from, to) => get(`/api/rescale-requests/list?${new URLSearchParams({ ...(status ? { status } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}) }).toString()}`),
  rescaleRequestAudit: (id, actualSizes, note) => post('/api/rescale-requests/audit', { id, actualSizes, note }),
  rescaleRequestListUpdate: (id, listing, baseListedAt) => post('/api/rescale-requests/list-update', { id, listing, baseListedAt }),
  // PH-only (the server refuses anyone else, admin included).
  rescaleRequestCancel: (id, note) => post('/api/rescale-requests/cancel', { id, note }),
  // Generic Alias GI lookup (no save) — used by the PH grid + rescale listing editor.
  phGiLookup: (sku, sizes) => post('/api/ph/gi-lookup', { sku, sizes }),
  // Read-only price inquiry (no save) — GI + Final + lowest/highest/last-sold, PH Price Inquiry page.
  phPriceInquiry: (sku, sizes, consigned = true) => post('/api/ph/price-inquiry', { sku, sizes, consigned }),
  bulkStatus: (vins, status) => post('/api/items/bulk-status', { vins, status }),
  // Remove pairs outright (miscount fix). Archived to deleted_items first; the
  // server refuses sold/shipped and returns them as `blocked`.
  deleteItems: (vins, reason) => post('/api/items/delete', { vins, reason }),
  deletedItems: (q, from, to) => get(`/api/items/deleted?${new URLSearchParams(
    Object.entries({ q, from, to }).filter(([, v]) => v),
  )}`),
  // v5 — PH Team monthly grid
  phList: (from, to, kind) => get(`/api/ph/list?${new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}), ...(kind ? { kind } : {}) }).toString()}`),
  phUpdateMany: (vins, fields, baseEditedAt) => post('/api/ph/update', { vins, fields, baseEditedAt }),
  // Atomic multi-size group save — one entry per size, all-or-nothing (see phUpdateGroup).
  phUpdateGroup: (sizes, baseEditedAt) => post('/api/ph/update', { sizes, baseEditedAt }),
  phSetGoat: (vins, goatOnly) => post('/api/ph/set-goat', { vins, goatOnly }),
  phRefreshGi: (vins) => post('/api/ph/refresh-gi', { vins }),
  // Purchase Orders — supplier scan-out (Phase 1). PH creates the PO shell + labels;
  // supplier lists/opens their own, scans items under each label, ships per label.
  poSuppliers: () => get('/api/po/suppliers'),
  // Bulk on-behalf manifest import (a parsed supplier PDF) — staff only.
  poManifestImport: (poId, boxes) => post('/api/po/manifest-import', { poId, boxes }),
  poCreate: (payload) => post('/api/po/create', payload),
  poList: () => get('/api/po/list'),
  poGet: (id) => get(`/api/po/get?id=${encodeURIComponent(id)}`),
  poScan: (payload) => post('/api/po/scan', payload),
  // Whole-order manifest (Path C): add a line against the PO itself (no label).
  poScanOrder: (payload) => post('/api/po/scan-order', payload),
  poLine: (lineId, patch) => post('/api/po/line', { lineId, ...patch }),
  poCloseBox: (poBoxId) => post('/api/po/close-box', { poBoxId }),
  poReopenBox: (poBoxId) => post('/api/po/reopen-box', { poBoxId }),
  poShip: (poBoxId) => post('/api/po/ship', { poBoxId }),
  // Phase 2 — receive a shipment against a PO (warehouse side).
  poOpen: () => get('/api/po/open'),
  poLookup: (q) => get(`/api/po/lookup?q=${encodeURIComponent(q)}`),
  // Phase 3 — reconciliation (received vs expected).
  poReconcileList: () => get('/api/po/reconcile-list'),
  poReconciliation: (poId) => get(`/api/po/reconciliation?poId=${encodeURIComponent(poId)}`),
  poReconcile: (poId) => post('/api/po/reconcile', { poId }),
  poClose: (poId) => post('/api/po/close', { poId }),
  // Archive is reversible: its own list (loaded only when the tab is opened) + undo.
  // Repair path for an order opened after the warehouse had already started scanning:
  // attach that batch to the order (see docs/context/purchase-orders.md).
  poLinkCandidates: (poId, batchId) => get(`/api/po/link-candidates?poId=${encodeURIComponent(poId)}`
    + (batchId ? `&batchId=${encodeURIComponent(batchId)}` : '')),
  poLinkBatch: (payload) => post('/api/po/link-batch', payload),
  poUnlinkBatch: (poId, batchId) => post('/api/po/unlink-batch', { poId, batchId }),
  poDelete: (poId, confirm) => post('/api/po/delete', { poId, confirm }),

  // The courier's labels PDF: uploaded straight to R2, then downloaded back through the
  // server (never a public URL — these carry an address and a live barcode).
  poLabelsSign: (poId) => post('/api/po/labels-sign', { poId }),
  poLabelsAttach: (payload) => post('/api/po/labels-attach', payload),
  poLabelDownload: (poId, poBoxId) => downloadBlob(`/api/po/label-download?poId=${encodeURIComponent(poId)}`
    + (poBoxId ? `&poBoxId=${encodeURIComponent(poBoxId)}` : '')),

  poArchived: () => get('/api/po/archived'),
  poUnarchive: (poId) => post('/api/po/unarchive', { poId }),
  // Discrepancy resolution: one step per call (all reversible via `undo`), plus the
  // internal thread. Both ride along on poReconciliation() when a PO is opened.
  poResolutionStep: (payload) => post('/api/po/resolution', payload),
  poComment: (poId, body) => post('/api/po/comment', { poId, body }),
  // Reconciliation note — one editable field per PO, saved at any status. Blank clears it.
  poSaveNote: (poId, note) => post('/api/po/note', { poId, note }),
  // Phase 4 — shipment tracking (17TRACK). Pull the latest status for a PO's labels.
  // Omit poBoxId to refresh every label on the PO; pass it to refresh just one (saves credits).
  poTrackRefresh: (poId, poBoxId) => post('/api/po/track-refresh', poBoxId != null ? { poId, poBoxId } : { poId }),
  // PH edit locks (presence)
  lockList: () => get('/api/ph/locks'),
  lockClaim: (vins, holderId) => post('/api/ph/locks', { action: 'claim', vins, holderId }),
  lockHeartbeat: (vins, holderId) => post('/api/ph/locks', { action: 'heartbeat', vins, holderId }),
  lockRelease: (vins, holderId) => post('/api/ph/locks', { action: 'release', vins, holderId }),
};
