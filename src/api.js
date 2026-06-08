// Tiny frontend API client. Attaches the session token and unwraps errors.

const TOKEN_KEY = 'sb_session_token';

export function getToken() {
  return sessionStorage.getItem(TOKEN_KEY) || '';
}
export function setToken(t) {
  if (t) sessionStorage.setItem(TOKEN_KEY, t);
}
export function clearToken() {
  sessionStorage.removeItem(TOKEN_KEY);
}

async function post(path, body, { auth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) {
    const t = getToken();
    if (t) headers.Authorization = `Bearer ${t}`;
  }
  const res = await fetch(path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body || {}),
  });

  let data = {};
  try { data = await res.json(); } catch { /* ignore */ }

  if (res.status === 401) {
    clearToken();
    const err = new Error(data.error || 'Session expired. Please sign in again.');
    err.unauthorized = true;
    throw err;
  }
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

export const api = {
  login: (password) => post('/api/auth', { password }, { auth: false }),
  searchUpc: (upc) => post('/api/upc-search', { upc }),
  searchSku: (sku) => post('/api/sku-search', { sku }),
  sendToSheet: (product, rows) => post('/api/send-to-sheet', { product, rows }),
};
