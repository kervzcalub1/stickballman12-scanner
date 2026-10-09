// eBay — READ-ONLY for now (docs/context/ebay-listings.md). Phase 1 of the listings hub
// (docs/listings-hub-plan.md): connect the seller account once, then pull every active
// listing and size into `ebay_listings`. Nothing here writes to eBay.
//
// Today the listings are DPL's (Shopify → eBay app): it owns price, quantity and
// create/end, and brings eBay orders back into Shopify. Until that ownership is settled,
// we only look.
//
// Auth: eBay OAuth "authorization code" grant. An admin presses Connect, the seller
// account owner approves on eBay, eBay sends the browser back to /api/ebay/callback with
// a code, and we trade it for a REFRESH token (good for 18 months), stored encrypted
// (api/_lib/secrets.js — fails closed without BUY_GC_KEY). Access tokens (2 h) are minted
// from it on demand and kept in memory only.
//
// Env: EBAY_CLIENT_ID (App ID), EBAY_CLIENT_SECRET (Cert ID), EBAY_RUNAME (the RuName
// whose "auth accepted" URL is https://<host>/api/ebay/callback), EBAY_ENV=sandbox for
// eBay's sandbox (default production).
import crypto from 'node:crypto';
import { getSetting, setSetting } from './db.js';
import { encryptSecret, decryptSecret, secretsConfigured } from './secrets.js';

const SANDBOX = () => String(process.env.EBAY_ENV || '').trim().toLowerCase() === 'sandbox';
const HOST = {
  auth: () => (SANDBOX() ? 'https://auth.sandbox.ebay.com' : 'https://auth.ebay.com'),
  api: () => (SANDBOX() ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com'),
  apiz: () => (SANDBOX() ? 'https://apiz.sandbox.ebay.com' : 'https://apiz.ebay.com'),
};
const clientId = () => String(process.env.EBAY_CLIENT_ID || '').trim();
const clientSecret = () => String(process.env.EBAY_CLIENT_SECRET || '').trim();
const ruName = () => String(process.env.EBAY_RUNAME || '').trim();

// Scopes asked for at Connect. Read-only at first; `sell.inventory` (full) added 2026-10-10
// when ending orphaned listings became the first write. A token approved before that still
// works for reading — ending tells the admin to Connect again if eBay refuses it.
export const SCOPES = [
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/sell.inventory.readonly',
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/commerce.identity.readonly',
];

const AUTH_KEY = 'ebay_auth';     // { refresh (encrypted), refreshExpiresAt, user, scopes, connectedBy, connectedAt }
const STATE_KEY = 'ebay_oauth_state';
export const PULL_KEY = 'ebay_pull';
const STATE_TTL_MS = 15 * 60 * 1000;

export function ebayConfigured() {
  return !!(clientId() && clientSecret() && ruName());
}
export function ebayMissing() {
  return [['EBAY_CLIENT_ID', clientId()], ['EBAY_CLIENT_SECRET', clientSecret()], ['EBAY_RUNAME', ruName()]]
    .filter(([, v]) => !v).map(([k]) => k);
}

async function readJson(key) {
  try { const v = await getSetting(key); return v ? JSON.parse(v) : null; } catch { return null; }
}

export async function ebayStatus() {
  const auth = await readJson(AUTH_KEY);
  return {
    configured: ebayConfigured(),
    missing: ebayMissing(),
    secrets: secretsConfigured(),
    sandbox: SANDBOX(),
    connected: !!auth?.refresh,
    user: auth?.user || null,
    connectedBy: auth?.connectedBy || null,
    connectedAt: auth?.connectedAt || null,
    refreshExpiresAt: auth?.refreshExpiresAt || null,
    pull: await readJson(PULL_KEY),
  };
}

/* ---------------------------------- OAuth ---------------------------------- */

// The eBay page the owner approves on. `state` is a one-time nonce we keep server-side:
// the callback arrives as a plain browser redirect (no app login header), so the nonce is
// what proves the code came from a Connect an admin started here, minutes ago.
export async function consentUrl(by) {
  const nonce = crypto.randomBytes(24).toString('hex');
  await setSetting(STATE_KEY, JSON.stringify({ nonce, by, at: Date.now() }), by);
  const q = new URLSearchParams({
    client_id: clientId(), redirect_uri: ruName(), response_type: 'code', scope: SCOPES.join(' '), state: nonce, prompt: 'login',
  });
  return `${HOST.auth()}/oauth2/authorize?${q}`;
}

async function tokenCall(form) {
  const r = await fetch(`${HOST.api()}/identity/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${clientId()}:${clientSecret()}`).toString('base64')}`,
    },
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(20_000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(`eBay token: ${j.error_description || j.error || `HTTP ${r.status}`}`);
    err.ebayError = j.error || null;
    throw err;
  }
  return j;
}

let access = { token: null, expires: 0 };

// The callback: check the nonce, trade the code, keep the refresh token (encrypted).
export async function finishConnect({ code, state }) {
  const st = await readJson(STATE_KEY);
  await setSetting(STATE_KEY, '', 'ebay-callback');   // one use, whatever happens next
  if (!st?.nonce || !state || st.nonce.length !== String(state).length
    || !crypto.timingSafeEqual(Buffer.from(st.nonce), Buffer.from(String(state)))) {
    throw new Error('This eBay approval link was not started here (or was already used). Press Connect eBay again.');
  }
  if (Date.now() - Number(st.at) > STATE_TTL_MS) throw new Error('The eBay approval took too long. Press Connect eBay again.');
  if (!code) throw new Error('eBay sent no approval code.');
  const t = await tokenCall({ grant_type: 'authorization_code', code: String(code), redirect_uri: ruName() });
  access = { token: t.access_token, expires: Date.now() + (Number(t.expires_in) - 120) * 1000 };
  const user = await whoAmI().catch(() => null);
  const auth = {
    refresh: encryptSecret(t.refresh_token),
    refreshExpiresAt: new Date(Date.now() + Number(t.refresh_token_expires_in || 0) * 1000).toISOString(),
    user, scopes: SCOPES, connectedBy: st.by || null, connectedAt: new Date().toISOString(),
  };
  await setSetting(AUTH_KEY, JSON.stringify(auth), st.by || 'ebay-callback');
  return { user };
}

export async function disconnect(by) {
  access = { token: null, expires: 0 };
  await setSetting(AUTH_KEY, '', by);
}

// A 2-hour access token, minted from the stored refresh token when the last one is near
// expiry. `invalid_grant` = the owner revoked us or 18 months passed: say so plainly.
export async function accessToken() {
  if (access.token && Date.now() < access.expires) return access.token;
  const auth = await readJson(AUTH_KEY);
  if (!auth?.refresh) throw Object.assign(new Error('eBay is not connected — an admin presses Connect eBay first.'), { notConnected: true });
  let t;
  try {
    t = await tokenCall({ grant_type: 'refresh_token', refresh_token: decryptSecret(auth.refresh), scope: (auth.scopes || SCOPES).join(' ') });
  } catch (e) {
    if (e.ebayError === 'invalid_grant') throw Object.assign(new Error('eBay access has expired or was revoked — an admin presses Connect eBay again.'), { notConnected: true });
    throw e;
  }
  access = { token: t.access_token, expires: Date.now() + (Number(t.expires_in) - 120) * 1000 };
  return access.token;
}

async function whoAmI() {
  const r = await fetch(`${HOST.apiz()}/commerce/identity/v1/user/`, {
    headers: { Authorization: `Bearer ${await accessToken()}` }, signal: AbortSignal.timeout(15_000),
  });
  const j = await r.json().catch(() => ({}));
  return r.ok ? (j.username || j.userId || null) : null;
}

/* ------------------------------ reading listings ---------------------------- */

const unesc = (s) => String(s ?? '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&amp;/g, '&');
// First / every <name>…</name> (exact name: <Item> never matches <ItemID>).
const tag = (xml, name) => { const m = String(xml).match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`)); return m ? m[1] : null; };
const tags = (xml, name) => [...String(xml).matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'g'))].map((m) => m[1]);
const attr = (xml, name, a) => { const m = String(xml).match(new RegExp(`<${name}\\s[^>]*\\b${a}="([^"]*)"`)); return m ? m[1] : null; };
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

async function trading(call, bodyXml) {
  const r = await fetch(`${HOST.api()}/ws/api.dll`, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml',
      'X-EBAY-API-CALL-NAME': call,
      'X-EBAY-API-SITEID': '0',
      'X-EBAY-API-COMPATIBILITY-LEVEL': '1415',
      'X-EBAY-API-IAF-TOKEN': await accessToken(),
    },
    body: `<?xml version="1.0" encoding="utf-8"?><${call}Request xmlns="urn:ebay:apis:eBLBaseComponents">${bodyXml}<ErrorLanguage>en_US</ErrorLanguage><WarningLevel>High</WarningLevel></${call}Request>`,
    signal: AbortSignal.timeout(60_000),
  });
  const xml = await r.text();
  const ack = tag(xml, 'Ack');
  if (!r.ok || ack === 'Failure' || ack === 'PartialFailure') {
    const msg = unesc(tag(tag(xml, 'Errors') || '', 'LongMessage') || tag(tag(xml, 'Errors') || '', 'ShortMessage') || `HTTP ${r.status}`);
    throw new Error(`eBay ${call}: ${msg}`);
  }
  return xml;
}

// One listing → one row per size. A variation's size is its "size" specific ("US Shoe
// Size", "Size"); available = quantity − sold, as eBay counts a variation.
export function rowsFromItem(itemXml, styleOf) {
  const variations = tags(tag(itemXml, 'Variations') || '', 'Variation');
  const flat = String(itemXml).replace(/<Variations>[\s\S]*<\/Variations>/, '');
  const itemId = unesc(tag(flat, 'ItemID'));
  const title = unesc(tag(flat, 'Title') || '');
  const pics = tag(flat, 'PictureDetails') || '';
  // The listing's photo: the gallery thumbnail, else its first picture. Variation photos
  // (by colour) are under <Variations><Pictures>; the first one fills in when neither exists.
  const image = unesc(tag(pics, 'GalleryURL') || tags(pics, 'PictureURL')[0]
    || tags(tag(itemXml, 'Pictures') || '', 'PictureURL')[0] || '') || null;
  const base = {
    item_id: itemId, title, style: styleOf(title) || null,
    image_url: image ? image.replace(/^http:/, 'https:') : null,
    item_sku: unesc(tag(flat, 'SKU') || '') || null,
    watch_count: num(tag(flat, 'WatchCount')),
    listing_type: tag(flat, 'ListingType') || null,
    currency: attr(flat, 'CurrentPrice', 'currencyID') || attr(flat, 'BuyItNowPrice', 'currencyID') || 'USD',
    start_time: tag(tag(flat, 'ListingDetails') || '', 'StartTime'),
    view_url: unesc(tag(tag(flat, 'ListingDetails') || '', 'ViewItemURL') || '') || null,
  };
  if (!variations.length) {
    const ss = tag(flat, 'SellingStatus') || '';
    return [{
      ...base, variation_key: '', sku: base.item_sku, size: null,
      price: num(tag(ss, 'CurrentPrice') ?? tag(flat, 'BuyItNowPrice') ?? tag(flat, 'StartPrice')),
      qty_available: num(tag(flat, 'QuantityAvailable')) ?? ((num(tag(flat, 'Quantity')) ?? 0) - (num(tag(ss, 'QuantitySold')) ?? 0)),
      qty_sold: num(tag(ss, 'QuantitySold')) ?? 0,
    }];
  }
  return variations.map((v) => {
    const specifics = tags(tag(v, 'VariationSpecifics') || '', 'NameValueList')
      .map((nv) => [unesc(tag(nv, 'Name') || ''), unesc(tag(nv, 'Value') || '')]);
    const size = (specifics.find(([n]) => /size/i.test(n)) || [])[1] || null;
    const sku = unesc(tag(v, 'SKU') || '') || null;
    const sold = num(tag(tag(v, 'SellingStatus') || '', 'QuantitySold')) ?? 0;
    return {
      ...base, sku, size,
      variation_key: sku || specifics.map(([n, val]) => `${n}=${val}`).join(';') || 'variation',
      price: num(tag(v, 'StartPrice')),
      qty_available: (num(tag(v, 'Quantity')) ?? 0) - sold,
      qty_sold: sold,
    };
  });
}

// Every active listing, 200 per page. `onPage(done, total)` reports progress.
export async function fetchActiveListings(styleOf, onPage = () => {}) {
  const rows = [];
  let listings = 0;
  for (let page = 1, pages = 1; page <= pages && page <= 200; page++) {
    const xml = await trading('GetMyeBaySelling',
      `<ActiveList><Include>true</Include><Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination></ActiveList><DetailLevel>ReturnAll</DetailLevel>`);
    const list = tag(xml, 'ActiveList') || '';
    pages = num(tag(tag(list, 'PaginationResult') || '', 'TotalNumberOfPages')) || 1;
    const items = tags(tag(list, 'ItemArray') || '', 'Item');
    listings += items.length;
    for (const it of items) rows.push(...rowsFromItem(it, styleOf));
    onPage(page, pages, listings);
  }
  return { rows, listings };
}

// How many Inventory-API items the account has — the tell for which listing model DPL
// uses (Trading-made listings can't be revised through the Inventory API, and the other
// way round). null = couldn't tell.
// `{ count }`, or `{ count: null, error }` — the reason is kept on the pull so a blank
// answer says WHY instead of looking like "no items".
export async function inventoryItemCount() {
  try {
    const r = await fetch(`${HOST.api()}/sell/inventory/v1/inventory_item?limit=1`, {
      headers: { Authorization: `Bearer ${await accessToken()}`, Accept: 'application/json', 'Accept-Language': 'en-US' },
      signal: AbortSignal.timeout(20_000),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) return { count: Number(j.total ?? 0) };
    const e = (j.errors || [])[0];
    return { count: null, error: `HTTP ${r.status}${e ? ` ${e.errorId || ''}: ${e.longMessage || e.message || ''}` : ''}`.trim() };
  } catch (e) { return { count: null, error: e.message }; }
}

// END a listing on eBay (Trading EndItem) — the whole listing, every size. `reason` is eBay's
// EndingReason. "Already ended" (eBay 1047) counts as done. Auth / scope refusals come back
// flagged so the page can say "Connect eBay again".
export async function endEbayItem(itemId, reason = 'NotAvailable') {
  try {
    await trading('EndItem', `<ItemID>${String(itemId).replace(/[^0-9]/g, '')}</ItemID><EndingReason>${reason}</EndingReason>`);
    return { ok: true };
  } catch (e) {
    const msg = String(e.message || '');
    if (/1047|already (been )?(closed|ended)/i.test(msg)) return { ok: true, already: true };
    const auth = /auth|token|scope|permission|insufficient/i.test(msg);
    return { ok: false, error: msg, auth };
  }
}
