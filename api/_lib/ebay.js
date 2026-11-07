// eBay (docs/context/ebay-listings.md). Phase 1 of the listings hub (docs/listings-hub-plan.md):
// connect the seller account once, then pull every active listing and size into
// `ebay_listings`. The writes: ending orphaned listings, repricing sizes
// (ReviseInventoryStatus — docs/context/ebay-api-reprice.md) and coded coupons
// (Marketing API — docs/context/ebay-coupons.md).
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
import { getSetting, setSetting, ebaySyncStateGet, ebaySyncStateSet } from './db.js';
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
// `sell.marketing` added 2026-10-13 for coded coupons: a token approved before that keeps
// working for everything else (the refresh asks only for the scopes it was approved with),
// and the coupons tab says "Connect eBay again" until it's re-approved.
export const SCOPES = [
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/sell.inventory.readonly',
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.marketing',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly',
  'https://api.ebay.com/oauth/api_scope/sell.finances',
  'https://api.ebay.com/oauth/api_scope/commerce.identity.readonly',
];
const MARKETING_SCOPE = 'https://api.ebay.com/oauth/api_scope/sell.marketing';
// Orders + the sales report (2026-10-13, docs/context/ebay-orders.md): read orders and
// tracking (Fulfillment API) and the money side (Finances API). Same story as marketing:
// a token approved before these keeps everything else working; those tabs ask for Connect.
const ORDERS_SCOPE = 'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly';
const FINANCES_SCOPE = 'https://api.ebay.com/oauth/api_scope/sell.finances';
export const hasScope = (auth, scope) => !!auth?.refresh && (auth.scopes || []).includes(scope);

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
    // Approved before coupons existed → the Marketing API will refuse it until re-connected.
    canMarket: hasScope(auth, MARKETING_SCOPE),
    canOrders: hasScope(auth, ORDERS_SCOPE),
    canFinances: hasScope(auth, FINANCES_SCOPE),
    pull: await readJson(PULL_KEY),
  };
}

/* ---------------------------------- OAuth ---------------------------------- */

// The eBay page the owner approves on. `state` is a one-time nonce we keep server-side:
// the callback arrives as a plain browser redirect (no app login header), so the nonce is
// what proves the code came from a Connect an admin started here, minutes ago.
// `back` = the page that started it (/ph/ebay-listings for the PH workspace, /ebay for the
// admin app); the callback returns there.
export const RETURN_PATHS = ['/ph/ebay-listings', '/ebay'];
export async function consentUrl(by, back) {
  const nonce = crypto.randomBytes(24).toString('hex');
  await setSetting(STATE_KEY, JSON.stringify({ nonce, by, at: Date.now(), back: RETURN_PATHS.includes(back) ? back : RETURN_PATHS[0] }), by);
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
export async function returnPathForState() {
  const st = await readJson(STATE_KEY);
  return RETURN_PATHS.includes(st?.back) ? st.back : RETURN_PATHS[0];
}
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

// Trading API budget (docs/context/ebay-sync.md): eBay allows 5,000 calls a day for our app, counted
// from 08:00 UTC. EVERY call is counted here; only callers that pass `guard` ('read' | 'write', the
// eBay Sync passes) are refused when the day is nearly spent, so the older tools are never blocked.
export const TRADING_BUDGET = { limit: 5000, readStop: 3000, writeStop: 4500 };
const BUDGET_KEY = 'ebay_trading_budget';
export const ebayDayKey = (now = Date.now()) => new Date(now - 8 * 3600_000).toISOString().slice(0, 10);
export const ebayDayResetAt = (now = Date.now()) => {
  const d = new Date(now); d.setUTCHours(8, 0, 0, 0);
  if (d.getTime() <= now) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
};
let budgetMem = null;
let budgetFlushed = 0;
// The counter lives in ebay_sync_state (not a live table) and is written at most once a minute.
async function loadBudget() {
  const day = ebayDayKey();
  if (budgetMem?.day === day) return budgetMem;
  let v = null;
  try { const raw = await ebaySyncStateGet(BUDGET_KEY); v = raw ? JSON.parse(raw) : null; } catch { /* no db: count from 0 */ }
  budgetMem = v?.day === day ? { day, used: Number(v.used) || 0 } : { day, used: 0 };
  return budgetMem;
}
export async function tradingUsage() {
  const b = await loadBudget().catch(() => budgetMem || { day: ebayDayKey(), used: 0 });
  return { used: b.used, ...TRADING_BUDGET, resetAt: ebayDayResetAt() };
}
export const flushBudget = async () => { if (budgetMem) { budgetFlushed = Date.now(); await ebaySyncStateSet(BUDGET_KEY, JSON.stringify(budgetMem)).catch(() => {}); } };
async function spendBudget(guard) {
  const b = await loadBudget().catch(() => (budgetMem?.day === ebayDayKey() ? budgetMem : { day: ebayDayKey(), used: 0 }));
  budgetMem = b;
  if (guard) {
    const stop = guard === 'write' ? TRADING_BUDGET.writeStop : TRADING_BUDGET.readStop;
    if (b.used >= stop) throw Object.assign(new Error(`eBay Trading budget for today is nearly spent (${b.used} of ${TRADING_BUDGET.limit}); it resets at 08:00 UTC.`), { budget: true });
  }
  b.used += 1;
  if (Date.now() - budgetFlushed >= 60_000) flushBudget();
}
// Every <Errors> block: { code, severity, short, long }.
const parseErrors = (xml) => tags(xml, 'Errors').map((e) => ({
  code: unesc(tag(e, 'ErrorCode') || ''), severity: tag(e, 'SeverityCode') || '', params: tags(e, 'ErrorParameters').map((q) => unesc(tag(q, 'Value') || '')),
  short: unesc(tag(e, 'ShortMessage') || ''), long: unesc(tag(e, 'LongMessage') || ''),
}));

async function trading(call, bodyXml, { guard = null } = {}) {
  await spendBudget(guard);
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
    throw Object.assign(new Error(`eBay ${call}: ${msg}`), { errors: parseErrors(xml).filter((e) => e.severity !== 'Warning') });
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
export async function fetchActiveListings(styleOf, onPage = () => {}, { guard = null } = {}) {
  const rows = [];
  let listings = 0;
  let reread = 0;
  for (let page = 1, pages = 1; page <= pages && page <= 200; page++) {
    const xml = await trading('GetMyeBaySelling',
      `<ActiveList><Include>true</Include><Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination></ActiveList><DetailLevel>ReturnAll</DetailLevel>`, { guard });
    const list = tag(xml, 'ActiveList') || '';
    pages = num(tag(tag(list, 'PaginationResult') || '', 'TotalNumberOfPages')) || 1;
    const items = tags(tag(list, 'ItemArray') || '', 'Item');
    listings += items.length;
    for (const it of items) {
      const got = rowsFromItem(it, styleOf);
      // A listing that came back with no sizes AND no Custom label: GetMyeBaySelling left its
      // variations out (seen on prod 2026-11-04 — a 41-pair listing read as one SKU-less
      // row). Read it on its own; if that fails too, the SKU-less row stays and is never
      // judged against Shopify (ebay-orphans.js 'no_sku').
      if (got.length === 1 && !got[0].variation_key && !got[0].sku) {
        const one = await ebayItemRows(got[0].item_id, styleOf, { guard }).catch(() => null);
        if (one?.length && (one.length > 1 || one[0].sku)) {
          rows.push(...one.map((r) => ({ ...r, watch_count: r.watch_count ?? got[0].watch_count, image_url: r.image_url || got[0].image_url })));
          reread++;
          continue;
        }
      }
      rows.push(...got);
    }
    onPage(page, pages, listings);
  }
  return { rows, listings, reread };
}

// One listing, read on its own (Trading GetItem, every variation) → the same rows as the pull.
// Used to fill a listing the pull got without sizes, and LIVE by api/ebay/end.js right before
// ending (ending ends every size eBay has, not just the ones we saved).
export async function ebayItemRows(itemId, styleOf, { guard = null } = {}) {
  const xml = await trading('GetItem', `<ItemID>${String(itemId).replace(/[^0-9]/g, '')}</ItemID><DetailLevel>ReturnAll</DetailLevel>`, { guard });
  const item = tag(xml, 'Item');
  if (!item) throw new Error('eBay GetItem: no item');
  return rowsFromItem(item, styleOf);
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

/* --------------------------- repricing (Trading) ---------------------------- */
// docs/context/ebay-api-reprice.md. ReviseInventoryStatus takes up to 4 sizes per call: a
// variation by ItemID + its SKU (eBay can't address a variation without one), a single
// listing by ItemID alone. Prices only — quantity is never sent, so DPL's stock stays put.
const xmlEsc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const isAuthError = (msg) => /auth|token|scope|permission|insufficient|access denied/i.test(String(msg || ''));

async function reviseCall(list) {
  const body = list.map((c) => `<InventoryStatus><ItemID>${String(c.itemId).replace(/[^0-9]/g, '')}</ItemID>${c.sku ? `<SKU>${xmlEsc(c.sku)}</SKU>` : ''}<StartPrice>${Number(c.price).toFixed(2)}</StartPrice></InventoryStatus>`).join('');
  await trading('ReviseInventoryStatus', body);
}

// [{ key, itemId, sku|null, price }] → [{ key, ok, error?, auth? }]. Four at a time; a
// refused batch is re-sent one by one so each size gets its own answer.
export async function reviseEbayPrices(changes) {
  const out = [];
  for (let i = 0; i < changes.length; i += 4) {
    const batch = changes.slice(i, i + 4);
    try { await reviseCall(batch); batch.forEach((c) => out.push({ key: c.key, ok: true })); continue; } catch (e) {
      if (batch.length === 1) { out.push({ key: batch[0].key, ok: false, error: e.message, auth: isAuthError(e.message) }); continue; }
    }
    for (const c of batch) {
      try { await reviseCall([c]); out.push({ key: c.key, ok: true }); }
      catch (e) { out.push({ key: c.key, ok: false, error: e.message, auth: isAuthError(e.message) }); }
    }
  }
  return out;
}

/* ---------------------------- coupons (Marketing) --------------------------- */
// docs/context/ebay-coupons.md. Coded coupons are Marketing-API "item promotions" of type
// CODED_COUPON. Everything is on the US site.
export const MARKETPLACE = 'EBAY_US';

async function marketing(method, path, body) {
  const r = await fetch(`${HOST.api()}/sell/marketing/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await accessToken()}`, Accept: 'application/json', 'Content-Type': 'application/json',
      'Accept-Language': 'en-US', 'Content-Language': 'en-US', 'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await r.text();
  let j = {};
  try { j = text ? JSON.parse(text) : {}; } catch { /* not JSON */ }
  if (!r.ok) {
    const errs = (j.errors || []).map((e) => `${e.longMessage || e.message || ''}${e.parameters?.length ? ` (${e.parameters.map((p) => `${p.name}=${p.value}`).join(', ')})` : ''}`.trim()).filter(Boolean);
    const err = new Error(`eBay: ${errs.join(' · ') || `HTTP ${r.status}`}`);
    err.status = r.status;
    err.auth = r.status === 401 || r.status === 403 || (j.errors || []).some((e) => Number(e.errorId) === 1100) || isAuthError(errs.join(' '));
    throw err;
  }
  return { json: j, location: r.headers.get('location') || '' };
}

// Every coded coupon on the account (eBay keeps ended ones too), newest first. Coupons
// that can still be redeemed (not ENDED) get their full detail: the listings, the $ off,
// the per-buyer limit. `details` caps how many detail calls one load spends.
export async function listEbayCoupons({ details = 60 } = {}) {
  const promos = [];
  for (let offset = 0; offset < 2000; offset += 200) {
    const { json } = await marketing('GET', `/promotion?marketplace_id=${MARKETPLACE}&promotion_type=CODED_COUPON&limit=200&offset=${offset}`);
    promos.push(...(json.promotions || []));
    if (!json.next || !(json.promotions || []).length) break;
  }
  promos.sort((a, b) => String(b.startDate || '').localeCompare(String(a.startDate || '')));
  let spent = 0;
  for (const p of promos) {
    if (p.promotionStatus === 'ENDED' || spent >= details) continue;
    spent++;
    try {
      const { json } = await marketing('GET', `/item_promotion/${encodeURIComponent(p.promotionId)}`);
      p.listingIds = json.inventoryCriterion?.listingIds || [];
      p.inventoryItems = (json.inventoryCriterion?.inventoryItems || []).map((x) => x.inventoryReferenceId);
      p.discountRules = json.discountRules || [];
      p.couponConfiguration = json.couponConfiguration || null;
      p.budget = json.budget || null;
    } catch (e) { p.detailError = e.message; }
  }
  return promos;
}

// → promotionId (from the Location header eBay answers with).
export async function createEbayCoupon(payload) {
  const { location } = await marketing('POST', '/item_promotion', payload);
  return decodeURIComponent(location.split('/').filter(Boolean).pop() || '') || null;
}
export async function ebayCouponAction(promotionId, action) {
  const id = encodeURIComponent(String(promotionId));
  if (action === 'pause') return marketing('POST', `/promotion/${id}/pause`);
  if (action === 'resume') return marketing('POST', `/promotion/${id}/resume`);
  if (action === 'delete') return marketing('DELETE', `/item_promotion/${id}`);
  throw new Error(`Unknown coupon action ${action}`);
}

/* ------------------------ orders + finances (REST) -------------------------- */
// docs/context/ebay-orders.md. Fulfillment API = orders (2 years back at most) and their
// shipping fulfillments (tracking). Finances API = every money movement (5 years back,
// ≤ 36 months per query) — the sales report is built from it.
async function rest(host, path, { label = 'eBay' } = {}) {
  const r = await fetch(`${host}${path}`, {
    headers: { Authorization: `Bearer ${await accessToken()}`, Accept: 'application/json', 'Accept-Language': 'en-US', 'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE },
    signal: AbortSignal.timeout(45_000),
  });
  const text = await r.text();
  let j = {};
  try { j = text ? JSON.parse(text) : {}; } catch { /* not JSON */ }
  if (!r.ok) {
    const msg = (j.errors || []).map((e) => e.longMessage || e.message).filter(Boolean).join(' · ');
    const err = new Error(`${label}: ${msg || `HTTP ${r.status}`}`);
    err.status = r.status;
    err.auth = r.status === 401 || r.status === 403 || (j.errors || []).some((e) => Number(e.errorId) === 1100) || isAuthError(msg);
    throw err;
  }
  return j;
}
const isoMs = (d) => new Date(d).toISOString();

// Every order created in [from, to) — or, with `modifiedSince`, every order changed since
// then (the incremental sync). 200 per page.
export async function fetchEbayOrders({ from, to, modifiedSince }, onPage = () => {}) {
  const filter = modifiedSince
    ? `lastmodifieddate:[${isoMs(modifiedSince)}..]`
    : `creationdate:[${isoMs(from)}..${to ? isoMs(to) : ''}]`;
  const out = [];
  for (let offset = 0; offset < 50000; offset += 200) {
    const j = await rest(HOST.api(), `/sell/fulfillment/v1/order?filter=${encodeURIComponent(filter)}&limit=200&offset=${offset}&fieldGroups=TAX_BREAKDOWN`, { label: 'eBay orders' });
    out.push(...(j.orders || []));
    onPage(out.length, j.total ?? null);
    if (!j.next || !(j.orders || []).length) break;
  }
  return out;
}
export async function fetchShippingFulfillments(orderId) {
  const j = await rest(HOST.api(), `/sell/fulfillment/v1/order/${encodeURIComponent(orderId)}/shipping_fulfillment`, { label: 'eBay tracking' });
  return j.fulfillments || [];
}

// Every money movement between two instants (≤ 36 months), 1,000 per page.
export async function fetchEbayTransactions({ from, to }, onPage = () => {}) {
  const filter = `transactionDate:[${isoMs(from)}..${isoMs(to)}]`;
  const out = [];
  for (let offset = 0; offset < 200000; offset += 1000) {
    const j = await rest(HOST.apiz(), `/sell/finances/v1/transaction?filter=${encodeURIComponent(filter)}&limit=1000&offset=${offset}`, { label: 'eBay finances' });
    out.push(...(j.transactions || []));
    onPage(out.length, j.total ?? null);
    if (!j.next || !(j.transactions || []).length) break;
  }
  return out;
}
// eBay's own totals for a period — what the report's summary is checked against.
export async function fetchEbayTransactionSummary({ from, to }) {
  const filter = `transactionDate:[${isoMs(from)}..${isoMs(to)}]`;
  return rest(HOST.apiz(), `/sell/finances/v1/transaction_summary?filter=${encodeURIComponent(filter)}`, { label: 'eBay finances' });
}

// A listing's photo when it's no longer in our pull (sold out / ended): Trading GetItem
// still answers for ended items for a while. null when eBay has nothing.
export async function ebayItemPicture(itemId) {
  try {
    const xml = await trading('GetItem', `<ItemID>${String(itemId).replace(/[^0-9]/g, '')}</ItemID><OutputSelector>PictureDetails</OutputSelector><OutputSelector>Variations</OutputSelector>`);
    const pics = tag(xml, 'PictureDetails') || '';
    const url = unesc(tag(pics, 'GalleryURL') || tags(pics, 'PictureURL')[0] || tags(tag(xml, 'Pictures') || '', 'PictureURL')[0] || '');
    return url ? url.replace(/^http:/, 'https:') : null;
  } catch { return null; }
}

/* ------------------------------ eBay Sync (Trading) ------------------------------ */
// docs/context/ebay-sync.md. Everything below is called ONLY by api/_lib/ebay-sync.js, behind its
// switches, and counts against the Trading budget (reads stop at 3,000 a day, writes at 4,500).

const cdata = (s) => `<![CDATA[${String(s ?? '').replace(/\]\]>/g, ']]]]><![CDATA[>')}]]>`;
const nameValue = (n, v) => `<NameValueList><Name>${xmlEsc(n)}</Name><Value>${xmlEsc(v)}</Value></NameValueList>`;

// The listing data from src/lib/ebaySync.js buildListing (or a revise subset of it) -> the Trading <Item>.
// mode 'add' writes every field; 'revise' / 'relist' only the fields present in `d`.
export function itemXml(d, mode = 'add', itemId = null) {
  const add = mode === 'add';
  const x = [];
  if (itemId) x.push(`<ItemID>${String(itemId).replace(/[^0-9]/g, '')}</ItemID>`);
  // One id per listing request: eBay refuses a second Add / Relist carrying the same UUID (add, relist) or InvocationID (revise).
  if (d.uuid) x.push(`<UUID>${xmlEsc(d.uuid)}</UUID>`);
  if (d.invocationId) x.push(`<InvocationID>${xmlEsc(d.invocationId)}</InvocationID>`);
  if (d.title != null) x.push(`<Title>${xmlEsc(d.title)}</Title>`);
  if (d.description != null) x.push(`<Description>${cdata(d.description)}</Description>`);
  if (add) {
    x.push(`<PrimaryCategory><CategoryID>${xmlEsc(d.categoryId)}</CategoryID></PrimaryCategory>`);
    x.push(`<ConditionID>${Number(d.conditionId) || 1000}</ConditionID>`);
    x.push(`<Country>${xmlEsc(d.country)}</Country><Currency>${xmlEsc(d.currency)}</Currency>`);
    x.push(`<DispatchTimeMax>${Number(d.dispatchDays) || 1}</DispatchTimeMax>`);
    x.push(`<ListingDuration>${xmlEsc(d.duration)}</ListingDuration><ListingType>${xmlEsc(d.listingType)}</ListingType>`);
    x.push(`<Location>${xmlEsc(d.location)}</Location><PostalCode>${xmlEsc(d.postalCode)}</PostalCode>`);
  }
  if (d.pictures) x.push(`<PictureDetails>${d.pictures.map((u) => `<PictureURL>${xmlEsc(u)}</PictureURL>`).join('')}</PictureDetails>`);
  if (add) {
    if (d.specifics?.length) x.push(`<ItemSpecifics>${d.specifics.map(([n, v]) => nameValue(n, v)).join('')}</ItemSpecifics>`);
    const p = d.policies || {};
    x.push(`<SellerProfiles><SellerShippingProfile><ShippingProfileID>${xmlEsc(p.shipping)}</ShippingProfileID></SellerShippingProfile>`
      + `<SellerReturnProfile><ReturnProfileID>${xmlEsc(p.return)}</ReturnProfileID></SellerReturnProfile>`
      + `<SellerPaymentProfile><PaymentProfileID>${xmlEsc(p.payment)}</PaymentProfileID></SellerPaymentProfile></SellerProfiles>`);
    const k = d.package || {};
    x.push(`<ShippingPackageDetails><MeasurementUnit>English</MeasurementUnit><PackageDepth unit="in">${Number(k.depth) || 0}</PackageDepth>`
      + `<PackageLength unit="in">${Number(k.length) || 0}</PackageLength><PackageWidth unit="in">${Number(k.width) || 0}</PackageWidth>`
      + `<ShippingPackage>${xmlEsc(k.type || 'PackageThickEnvelope')}</ShippingPackage>`
      + `<WeightMajor unit="lbs">${Number(k.weightLbs) || 0}</WeightMajor><WeightMinor unit="oz">${Number(k.weightOz) || 0}</WeightMinor></ShippingPackageDetails>`);
    x.push(`<Site>${xmlEsc(d.site || 'US')}</Site>`);
  }
  if (d.variations) {
    const size = d.sizeName || 'Size';
    x.push('<Variations>');
    x.push(`<VariationSpecificsSet>${nameValueMany(size, d.sizeValues || d.variations.map((v) => v.size))}</VariationSpecificsSet>`);
    for (const v of d.variations) {
      x.push(`<Variation><SKU>${xmlEsc(v.sku)}</SKU><StartPrice>${Number(v.price).toFixed(2)}</StartPrice><Quantity>${Math.max(0, Math.round(Number(v.qty)))}</Quantity>`
        + (v.upc ? `<VariationProductListingDetails><UPC>${xmlEsc(v.upc)}</UPC></VariationProductListingDetails>` : '')
        + `<VariationSpecifics>${nameValue(size, v.size)}</VariationSpecifics></Variation>`);
    }
    x.push('</Variations>');
  }
  return `<Item>${x.join('')}</Item>`;
}
function nameValueMany(name, values) {
  return `<NameValueList><Name>${xmlEsc(name)}</Name>${[...new Set(values)].map((v) => `<Value>${xmlEsc(v)}</Value>`).join('')}</NameValueList>`;
}

// eBay answers a repeated UUID with the ORIGINAL item id in the error: that call already listed it.
export function uuidDuplicateItemId(errors) {
  const dup = (errors || []).find((x) => /uuid/i.test(`${x.long} ${x.short}`) && /(already|used|duplicate)/i.test(`${x.long} ${x.short}`));
  return (dup && [...(dup.params || []), dup.long].join(' ').match(/\b\d{11,13}\b/)?.[0]) || null;
}
// eBay's own dry run: nothing is listed, no fee. → { ok:true } or { ok:false, errors:[{code,short,long}], error }
export async function verifyAddFixedPriceItem(data) {
  try { await trading('VerifyAddFixedPriceItem', itemXml(data, 'add'), { guard: 'read' }); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message, errors: e.errors || [], budget: !!e.budget, auth: isAuthError(e.message) }; }
}
// List it. → { ok, itemId } or { ok:false, errors, error }
export async function addFixedPriceItem(data) {
  try {
    const xml = await trading('AddFixedPriceItem', itemXml(data, 'add'), { guard: 'write' });
    return { ok: true, itemId: unesc(tag(xml, 'ItemID') || '') };
  } catch (e) {
    // The same UUID already listed this: eBay answers with the ORIGINAL item id. That is a success, not a second listing.
    const id = uuidDuplicateItemId(e.errors);
    if (id) return { ok: true, itemId: id, duplicateUuid: true };
    return { ok: false, error: e.message, errors: e.errors || [], budget: !!e.budget, auth: isAuthError(e.message) };
  }
}
// Change title / description / pictures / sizes of a live listing. `data.variations` is the FULL set to
// send (existing ones carrying their current price and quantity) with the union VariationSpecificsSet.
export async function reviseFixedPriceItem(itemId, data) {
  try { await trading('ReviseFixedPriceItem', itemXml(data, 'revise', itemId), { guard: 'write' }); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message, errors: e.errors || [], budget: !!e.budget, auth: isAuthError(e.message) }; }
}
// An ended listing back on, by its stored item id (eBay gives it a NEW id). → { ok, itemId }
export async function relistFixedPriceItem(itemId, data = {}) {
  try {
    const xml = await trading('RelistFixedPriceItem', itemXml(data, 'relist', itemId), { guard: 'write' });
    return { ok: true, itemId: unesc(tag(xml, 'ItemID') || '') || String(itemId) };
  } catch (e) {
    const id = uuidDuplicateItemId(e.errors);
    if (id) return { ok: true, itemId: id, duplicateUuid: true };
    return { ok: false, error: e.message, errors: e.errors || [], budget: !!e.budget, auth: isAuthError(e.message) };
  }
}

// Quantity ONLY (never price). [{ key, itemId, sku|null, qty }] -> [{ key, ok, error?, auth? }]. Four per call;
// a refused batch is re-sent one by one so each size gets its own answer (as reviseEbayPrices does).
const qtyCall = (list) => trading('ReviseInventoryStatus', list.map((c) => `<InventoryStatus><ItemID>${String(c.itemId).replace(/[^0-9]/g, '')}</ItemID>${c.sku ? `<SKU>${xmlEsc(c.sku)}</SKU>` : ''}<Quantity>${Math.max(0, Math.round(Number(c.qty)))}</Quantity></InventoryStatus>`).join(''), { guard: 'write' });
export async function reviseEbayQuantities(changes) {
  const out = [];
  for (let i = 0; i < changes.length; i += 4) {
    const batch = changes.slice(i, i + 4);
    try { await qtyCall(batch); batch.forEach((c) => out.push({ key: c.key, ok: true })); continue; } catch (e) {
      if (batch.length === 1 || e.budget) { batch.forEach((c) => out.push({ key: c.key, ok: false, error: e.message, auth: isAuthError(e.message), budget: !!e.budget })); continue; }
    }
    for (const c of batch) {
      try { await qtyCall([c]); out.push({ key: c.key, ok: true }); }
      catch (e) { out.push({ key: c.key, ok: false, error: e.message, auth: isAuthError(e.message), budget: !!e.budget }); }
    }
  }
  return out;
}

// One live listing's content for the drift check: title, description, picture count, sizes.
const descOf = (raw) => { const t = String(raw ?? ''); const m = t.match(/^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/); return m ? m[1] : unesc(t); };
export function parseItemContent(xml) {
  const item = tag(xml, 'Item') || xml;
  const flat = String(item).replace(/<Variations>[\s\S]*<\/Variations>/, '');
  const pics = tag(flat, 'PictureDetails') || '';
  const variations = tags(tag(item, 'Variations') || '', 'Variation').map((v) => {
    const sp = tags(tag(v, 'VariationSpecifics') || '', 'NameValueList').map((nv) => [unesc(tag(nv, 'Name') || ''), unesc(tag(nv, 'Value') || '')]);
    const sold = num(tag(tag(v, 'SellingStatus') || '', 'QuantitySold')) ?? 0;
    const quantity = num(tag(v, 'Quantity')) ?? 0;
    return {
      sku: unesc(tag(v, 'SKU') || ''), size: (sp.find(([n]) => /size/i.test(n)) || [])[1] || null,
      upc: unesc(tag(tag(v, 'VariationProductListingDetails') || '', 'UPC') || '') || null,
      price: num(tag(v, 'StartPrice')), quantity, sold, available: quantity - sold,
    };
  });
  const set = tags(tag(tag(item, 'Variations') || '', 'VariationSpecificsSet') || '', 'NameValueList')
    .map((nv) => ({ name: unesc(tag(nv, 'Name') || ''), values: tags(nv, 'Value').map(unesc) }));
  const sizeSet = set.find((x) => /size/i.test(x.name)) || null;
  return {
    specificsSet: sizeSet, item_id: unesc(tag(flat, 'ItemID') || ''), title: unesc(tag(flat, 'Title') || ''), description: descOf(tag(flat, 'Description')),
    pictureCount: tags(pics, 'PictureURL').length, status: tag(tag(flat, 'SellingStatus') || '', 'ListingStatus') || null,
    sizeName: variations.length ? 'Size' : null, variations,
  };
}
export async function fetchEbayItemContent(itemId) {
  const xml = await trading('GetItem', `<ItemID>${String(itemId).replace(/[^0-9]/g, '')}</ItemID><DetailLevel>ReturnAll</DetailLevel>`, { guard: 'read' });
  return parseItemContent(xml);
}
