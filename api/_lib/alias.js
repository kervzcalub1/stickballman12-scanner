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

/* ------------------------- Pricing insights --------------------------- */
// Global indicator price comes ONLY from the official Alias pricing API
// (api.alias.org — never the bypass proxy or any other host, by request):
//   GET /api/v1/pricing_insights/availability
//   ?catalog_id&size&product_condition&packaging_condition  (bearer auth)
//   -> { availability: { global_indicator_price_cents, ... } }
// The catalog_id is the Alias product `id` (resolved from a UPC search, cached in
// the products table). All callers treat failures as "no GI" (best-effort).
// Auth here is the static GOAT/Alias API key ALIAS_API_KEY (Bearer) — NOT the
// bypass-login access_token, which this host rejects (401).
export const ALIAS_API_BASE = 'https://api.alias.org';
const DEFAULT_PRODUCT_CONDITION = 'PRODUCT_CONDITION_NEW';
const DEFAULT_PACKAGING_CONDITION = 'PACKAGING_CONDITION_GOOD_CONDITION';

// Authenticated GET against the official Alias API. Returns { status, ok, data }.
export async function aliasApiGet(path, { token, query } = {}) {
  const qs = query ? `?${new URLSearchParams(query).toString()}` : '';
  const resp = await fetchWithTimeout(`${ALIAS_API_BASE}${path}${qs}`, {
    method: 'GET',
    headers: { accept: 'application/json', Authorization: `Bearer ${token}` },
  });
  let data = null;
  try { data = await resp.json(); } catch { /* may not be JSON */ }
  return { status: resp.status, ok: resp.ok, data };
}

// Look a UPC up on Alias and return the normalized shoe details we cache in the
// products table — including the `catalog_id` (= Alias product `id`), the field
// only Alias provides. null if not found. (Catalog resolution still goes through
// the bypass UPC-search proxy; only GI pricing is pinned to api.alias.org.)
export async function aliasProductByUpc(upc) {
  const email = process.env.ALIAS_EMAIL;
  const password = process.env.ALIAS_PASSWORD;
  if (!upc || !email || !password) return null;
  const r = await aliasAuthed((token) => aliasPost('/alias-upc-search', { email, password, authorization_token: token, upc }));
  if (!r.ok) return null;
  const p = r.data?.result?.results?.[0]?.product;
  if (!p) return null;
  return {
    upc,
    catalogId: p.id ?? p.catalog_id ?? null,
    name: p.name || p.nickname || null,
    sku: p.sku || null,
    colorway: p.colorway || null,
    gender: p.gender || (Array.isArray(p.genders) ? p.genders.join(' ') : null),
    brand: p.brand || null,
    image: p.main_picture_url || p.grid_picture_url || null,
    source: 'alias',
  };
}

// Resolve a UPC to its Alias catalog_id (the product `id`). null if not found.
export async function aliasCatalogId(upc) {
  const p = await aliasProductByUpc(upc);
  return p?.catalogId ?? null;
}

// Search the official Alias catalog (`GET api.alias.org/api/v1/catalog?query=<q>`,
// ALIAS_API_KEY bearer) and return the top match's normalized details — including
// the `catalogId` (for GI pricing) and the full size run. This is BOTH the SKU
// product lookup (replacing KicksDB — Alias has canonical titles) and how
// SKU-scanned units resolve a catalog_id. Match is fuzzy on the SKU (dash or
// space both work). null if not found / no key.
export async function aliasCatalogBySku(query) {
  const apiKey = process.env.ALIAS_API_KEY;
  if (!apiKey || !query) return null;
  const r = await aliasApiGet('/api/v1/catalog', { token: apiKey, query: { query: String(query), limit: '1' } });
  if (!r.ok) return null;
  const c = r.data?.catalog_items?.[0];
  if (!c?.catalog_id) return null;
  return {
    catalogId: c.catalog_id,
    name: c.name || c.nickname || null,
    sku: c.sku || null,
    brand: c.brand || null,
    gender: c.gender || null,
    colorway: c.colorway || null,
    image: c.main_picture_url || null,
    sizes: (Array.isArray(c.allowed_sizes) ? c.allowed_sizes : [])
      .map((s) => String(s.display_name ?? s.value ?? '').trim())
      .filter(Boolean),
    source: 'alias',
  };
}

// Global indicator price (in dollars) for one catalog_id + size, or null.
// Conditions default to New / Good box (the Alias UI defaults); region_id 3 is
// the pricing region we sell in. Auth is the static GOAT/Alias API key
// (ALIAS_API_KEY) as a Bearer token — the login access_token is NOT accepted here.
const GI_REGION_ID = '3';
export async function aliasGlobalIndicator({ catalogId, size, productCondition = DEFAULT_PRODUCT_CONDITION, packagingCondition = DEFAULT_PACKAGING_CONDITION }) {
  const apiKey = process.env.ALIAS_API_KEY;
  // The API's `size` is a number (TYPE_DOUBLE) — strip any gender/age suffix
  // ("9W", "5.5Y" → "9", "5.5"). Alias women's/youth sizes are plain US numbers.
  const sizeNum = size == null ? '' : (String(size).match(/[\d.]+/)?.[0] ?? '');
  if (!apiKey || !catalogId || sizeNum === '') return null;
  const r = await aliasApiGet('/api/v1/pricing_insights/availability', {
    token: apiKey,
    query: {
      catalog_id: String(catalogId),
      size: sizeNum,
      product_condition: productCondition,
      packaging_condition: packagingCondition,
      region_id: GI_REGION_ID,
    },
  });
  if (!r.ok) return null;
  const cents = r.data?.availability?.global_indicator_price_cents;
  const n = cents == null || cents === '' ? NaN : Number(cents);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n) / 100; // cents -> dollars
}
