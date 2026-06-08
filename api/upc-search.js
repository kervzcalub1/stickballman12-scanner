// POST /api/upc-search  { upc }  ->  { ok, product }
// Logs in to Alias (server-side credentials), searches the UPC, and returns
// a normalized product object. Credentials never reach the browser.

import {
  getJsonBody, send, applySecurity, rateLimit, requireAuth, cleanUpc,
} from './_lib/util.js';

const ALIAS_BASE = 'https://bypass-alias-host-railway-alias.up.railway.app';

// Cache the Alias access token across warm invocations (expires in ~1h).
let tokenCache = { value: null, expires: 0 };

async function getAliasToken(email, password) {
  if (tokenCache.value && Date.now() < tokenCache.expires) return tokenCache.value;

  const r = await fetch(`${ALIAS_BASE}/alias-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!r.ok) throw new Error(`Alias login failed (${r.status})`);
  const data = await r.json();
  const token = data?.auth_token?.access_token;
  if (!token) throw new Error('Alias login returned no access_token');

  // Refresh a little early.
  tokenCache = { value: token, expires: Date.now() + 50 * 60 * 1000 };
  return token;
}

function normalize(product, upc) {
  if (!product) return null;
  return {
    name: product.name || product.nickname || 'Unknown product',
    sku: product.sku || null,
    upc: upc || null,
    image: product.main_picture_url || product.grid_picture_url || null,
    brand: product.brand || null,
    colorway: product.colorway || null,
    sizes: Array.isArray(product.size_options)
      ? product.size_options.map((s) => String(s.name ?? s.value)).filter(Boolean)
      : [],
    source: 'alias',
  };
}

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireAuth(req, res)) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 40 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded. Slow down a moment.' });

  const email = process.env.ALIAS_EMAIL;
  const password = process.env.ALIAS_PASSWORD;
  if (!email || !password)
    return send(res, 500, { ok: false, error: 'Server is missing Alias credentials.' });

  const body = await getJsonBody(req);
  const upc = cleanUpc(body.upc);
  if (!upc) return send(res, 400, { ok: false, error: 'Invalid UPC. Expected 8–14 digits.' });

  try {
    let token = await getAliasToken(email, password);

    const doSearch = (authToken) =>
      fetch(`${ALIAS_BASE}/alias-upc-search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, authorization_token: authToken, upc }),
      });

    let r = await doSearch(token);
    // If the token expired, refresh once and retry.
    if (r.status === 401 || r.status === 403) {
      tokenCache = { value: null, expires: 0 };
      token = await getAliasToken(email, password);
      r = await doSearch(token);
    }
    if (!r.ok) return send(res, 502, { ok: false, error: `Alias search failed (${r.status})` });

    const data = await r.json();
    const product = data?.result?.results?.[0]?.product;
    const normalized = normalize(product, upc);
    if (!normalized)
      return send(res, 404, { ok: false, error: 'No product found for that UPC.' });

    return send(res, 200, { ok: true, product: normalized });
  } catch (e) {
    return send(res, 502, { ok: false, error: e.message || 'Upstream error.' });
  }
}
