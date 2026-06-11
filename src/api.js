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
    throw new Error(data.error || `Request failed (${res.status})`);
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
  // Product search + sheet
  searchUpc: (upc) => post('/api/upc-search', { upc }),
  searchSku: (sku) => post('/api/sku-search', { sku }),
  sendToSheet: (product, rows) => post('/api/send-to-sheet', { product, rows }),
  rapidSend: (product, size) => post('/api/rapid-send', { product, size }),
};
