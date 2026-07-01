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

export const api = {
  // Auth
  login: (username, password) => post('/api/auth/login', { username, password }, { auth: false }),
  signup: (payload) => post('/api/auth/signup', payload, { auth: false }),
  // Admin
  adminListUsers: () => get('/api/admin/users'),
  adminReview: (userId, decision) => post('/api/admin/review', { userId, decision }),
  adminSetRole: (userId, role) => post('/api/admin/review', { userId, decision: 'role', role }),
  adminDeleteUser: (userId) => post('/api/admin/review', { userId, decision: 'delete' }),
  // Product search + sheet
  searchUpc: (upc) => post('/api/upc-search', { upc }),
  searchSku: (sku) => post('/api/sku-search', { sku }),
  // v4 — receiving / batches
  suppliers: () => get('/api/suppliers'),
  checkTracking: (tracking) => get(`/api/batches/check-tracking?tracking=${encodeURIComponent(tracking)}`),
  batchCommit: (payload) => post('/api/batches/commit', payload),
  // v6 — multi-box batches (Feature 7)
  createOpenBatch: (batch) => post('/api/batches/create-open', { batch }),
  batchAddBox: (batchId, trackingNumber, boxNumber = null) => post('/api/batches/add-box', { batchId, trackingNumber, boxNumber }),
  batchSyncBoxes: (batchId, boxes) => post('/api/batches/sync-boxes', { batchId, boxes }),
  boxCommit: (payload) => post('/api/batches/box-commit', payload),
  openBatches: () => get('/api/batches/open-list'),
  batchFull: (id) => get(`/api/batches/full?id=${encodeURIComponent(id)}`),
  batchSetStatus: (id, status) => post('/api/batches/set-status', { id, status }),
  // v6 — listing photos (per SKU, stored in Cloudflare R2)
  photoList: (sku) => get(`/api/photos/list?sku=${encodeURIComponent(sku)}`),
  photoSign: (sku, angle, contentType) => post('/api/photos/sign', { sku, angle, contentType }),
  photoSignIssue: (vin, contentType) => post('/api/photos/sign-issue', { vin, contentType }),
  photoAttach: (sku, angle, url) => post('/api/photos/attach', { sku, angle, url }),
  photoRemove: (sku, angle) => post('/api/photos/remove', { sku, angle }),
  reserveVins: (count, dateReceived) => post('/api/vins/reserve', { count, dateReceived }),
  batchList: (kind) => get(`/api/batches/list${kind ? `?kind=${kind}` : ''}`),
  batchGet: (id) => get(`/api/batches/get?id=${encodeURIComponent(id)}`),
  itemLookup: (code) => get(`/api/items/lookup?code=${encodeURIComponent(code)}`),
  itemHistory: (vins) => get(`/api/items/history?vins=${encodeURIComponent((vins || []).join(','))}`),
  itemEvent: (vin, type, details) => post('/api/items/event', { vin, type, details }),
  rescaleItem: (vin, status, note, reason) => post('/api/items/rescale', { vin, status, note, reason }),
  itemsQuery: (params) => get(`/api/items/query?${new URLSearchParams(params).toString()}`),
  noBoxList: (from, to) => get(`/api/items/no-box?${new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) }).toString()}`),
  pendingCounts: () => get('/api/items/pending-counts'),
  boxFound: (vin) => post('/api/items/box-found', { vin }),
  restockDone: (vins) => post('/api/items/restock-done', { vins }),
  // PH-requested rescales
  rescaleRequestCreate: (payload) => post('/api/rescale-requests/create', payload),
  rescaleRequestList: (status, from, to) => get(`/api/rescale-requests/list?${new URLSearchParams({ ...(status ? { status } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}) }).toString()}`),
  rescaleRequestAudit: (id, actualSizes, note) => post('/api/rescale-requests/audit', { id, actualSizes, note }),
  rescaleRequestListUpdate: (id, listing) => post('/api/rescale-requests/list-update', { id, listing }),
  rescaleRequestFetchGi: (sku, sizes) => post('/api/rescale-requests/fetch-gi', { sku, sizes }),
  bulkStatus: (vins, status) => post('/api/items/bulk-status', { vins, status }),
  // v5 — PH Team monthly grid
  phList: (from, to, kind) => get(`/api/ph/list?${new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}), ...(kind ? { kind } : {}) }).toString()}`),
  phUpdateMany: (vins, fields, baseEditedAt) => post('/api/ph/update', { vins, fields, baseEditedAt }),
  phRefreshGi: (vins) => post('/api/ph/refresh-gi', { vins }),
  // PH edit locks (presence)
  lockList: () => get('/api/ph/locks'),
  lockClaim: (vins, holderId) => post('/api/ph/locks', { action: 'claim', vins, holderId }),
  lockHeartbeat: (vins, holderId) => post('/api/ph/locks', { action: 'heartbeat', vins, holderId }),
  lockRelease: (vins, holderId) => post('/api/ph/locks', { action: 'release', vins, holderId }),
};
