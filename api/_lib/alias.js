// Shared Alias client (via the Railway bypass host). Centralizes login + the
// "auto re-login on 401 / auth failure, then retry once" behavior so EVERY Alias
// call gets it — current UPC search and any future endpoints.
//
// Usage for a new Alias call:
//   const r = await aliasAuthed((token) => aliasPost('/alias-some-endpoint', { ...body, authorization_token: token }));
//   if (!r.ok) throw new Error(...); use r.data
//
// Credentials come from env (ALIAS_EMAIL / ALIAS_PASSWORD) — never hardcode them.
import { fetchWithTimeout } from './util.js';

export const ALIAS_BASE = 'https://bypass-alias-host-railway-alias.up.railway.app';

// Cache the access token across warm invocations (Alias tokens last ~1h).
let tokenCache = { value: null, expires: 0 };
export function clearAliasToken() { tokenCache = { value: null, expires: 0 }; }

// Log in and cache a fresh token. POST /alias-login { email, password }.
export async function aliasLogin() {
  const email = process.env.ALIAS_EMAIL;
  const password = process.env.ALIAS_PASSWORD;
  if (!email || !password) throw new Error('Alias credentials are not configured.');
  const r = await fetchWithTimeout(`${ALIAS_BASE}/alias-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!r.ok) throw new Error(`Alias login failed (${r.status})`);
  const data = await r.json();
  const token = data?.auth_token?.access_token;
  if (!token) throw new Error('Alias login returned no access_token');
  tokenCache = { value: token, expires: Date.now() + 50 * 60 * 1000 }; // refresh a little early
  return token;
}

// Current token (cached), logging in if needed.
export async function getAliasToken() {
  if (tokenCache.value && Date.now() < tokenCache.expires) return tokenCache.value;
  return aliasLogin();
}

// True if a response looks like an expired/invalid token — by HTTP status
// (401/403) OR an auth-flavored message in the body (some upstreams return
// 200/500 with an error body instead of a 401).
export function looksLikeAuthFailure(status, data) {
  if (status === 401 || status === 403) return true;
  const text = JSON.stringify(data ?? '').toLowerCase();
  return (
    /unauthor/.test(text) ||
    /forbidden/.test(text) ||
    /\b(token|session)\b[^]*\b(expir|invalid|missing|revok)/.test(text) ||
    /\b(expir|invalid|missing|revok)[^]*\b(token|session)\b/.test(text) ||
    /not\s+authenticated/.test(text) ||
    /authentication\s+(failed|required)/.test(text)
  );
}

// Run an authenticated Alias call. `fn(token)` performs the request and returns
// { status, ok, data }. If it comes back as an auth failure (401 / auth body),
// this clears the token, re-runs /alias-login, and retries the request ONCE.
export async function aliasAuthed(fn) {
  let token = await getAliasToken();
  let r = await fn(token);
  if (looksLikeAuthFailure(r.status, r.data)) {
    clearAliasToken();
    token = await aliasLogin(); // <- "just run this and everything is back"
    r = await fn(token);
  }
  return r;
}

// Convenience POST that returns { status, ok, data } (body read once).
export async function aliasPost(path, body) {
  const resp = await fetchWithTimeout(`${ALIAS_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data = null;
  try { data = await resp.json(); } catch { /* may not be JSON */ }
  return { status: resp.status, ok: resp.ok, data };
}
