// SHEIN Open Platform client (docs/context/shein-fix.md → "SHEIN API"). READY, NOT LIVE:
// it waits for SHEIN to approve our developer app. Until SHEIN_APP_ID + SHEIN_APP_SECRET are
// set, everything here reports "not configured" and the SHEIN pages work from export files.
//
// How SHEIN auth works (from SHEIN's official SDK, github.com/sheinsight/open-sdk-java):
//   1. The seller account owner opens SHEIN's authorization page (SHEIN_AUTH_URL, with our
//      appid, the callback URL base64-encoded, and a one-time state) and approves.
//   2. SHEIN redirects to /api/shein/callback with a tempToken. We trade it at
//      /open-api/auth/get-by-token, signed with appid + app secret.
//   3. The answer holds openKeyId + secretKey; the secretKey comes AES-encrypted with the
//      app secret (AES-128-CBC, key = first 16 bytes of the app secret, IV "space-station-de").
//      Both are stored encrypted (secrets.js, fails closed without BUY_GC_KEY).
//   4. Every call is signed: x-lt-openKeyId, x-lt-timestamp, x-lt-signature where
//      signature = r + base64(hex(HMAC-SHA256(`${openKeyId}&${ts}&${path}`, secretKey + r))),
//      r = 5 random characters.
//
// Env: SHEIN_APP_ID, SHEIN_APP_SECRET, SHEIN_API_HOST (default https://openapi.sheincorp.com),
// SHEIN_AUTH_URL (default https://openapi-sem.sheincorp.com/#/empower).
import crypto from 'node:crypto';
import { getSetting, setSetting } from './db.js';
import { encryptSecret, decryptSecret, secretsConfigured } from './secrets.js';

const appId = () => String(process.env.SHEIN_APP_ID || '').trim();
const appSecret = () => String(process.env.SHEIN_APP_SECRET || '').trim();
const apiHost = () => String(process.env.SHEIN_API_HOST || 'https://openapi.sheincorp.com').trim().replace(/\/+$/, '');
const authUrl = () => String(process.env.SHEIN_AUTH_URL || 'https://openapi-sem.sheincorp.com/#/empower').trim();

const AUTH_KEY = 'shein_auth';        // { openKeyId (encrypted), secretKey (encrypted), supplierId, mode, connectedBy, connectedAt }
const STATE_KEY = 'shein_oauth_state';
const STATE_TTL_MS = 15 * 60 * 1000;

export const sheinConfigured = () => !!(appId() && appSecret());
export const sheinMissing = () => [['SHEIN_APP_ID', appId()], ['SHEIN_APP_SECRET', appSecret()]].filter(([, v]) => !v).map(([k]) => k);

async function readJson(key) {
  try { const v = await getSetting(key); return v ? JSON.parse(v) : null; } catch { return null; }
}

/* ------------------------------ signing ------------------------------ */

// The SDK's SignUtil, byte for byte: HMAC over "key&timestamp&path" with (secret + random5),
// lower-case hex, base64 of that hex STRING, prefixed by the same random5.
export function sheinSignature(keyId, secret, path, timestamp, random5 = crypto.randomUUID().slice(0, 5)) {
  const hex = crypto.createHmac('sha256', secret + random5).update(`${keyId}&${timestamp}&${path}`).digest('hex');
  return random5 + Buffer.from(hex, 'utf8').toString('base64');
}

// The SDK's AesUtil.decrypt: AES/CBC/PKCS5, key = the first 16 bytes of the app secret
// (zero-padded), fixed IV "space-station-de".
export function sheinDecryptSecret(encrypted, secret) {
  const key = Buffer.alloc(16);
  Buffer.from(secret, 'utf8').copy(key, 0, 0, 16);
  const d = crypto.createDecipheriv('aes-128-cbc', key, Buffer.from('space-station-de', 'utf8'));
  return Buffer.concat([d.update(Buffer.from(encrypted, 'base64')), d.final()]).toString('utf8');
}

/* ------------------------------ connect ------------------------------ */

export async function sheinStatus() {
  const auth = await readJson(AUTH_KEY);
  return {
    configured: sheinConfigured(), missing: sheinMissing(), secrets: secretsConfigured(),
    connected: !!auth?.openKeyId, supplierId: auth?.supplierId || null, mode: auth?.mode || null,
    connectedBy: auth?.connectedBy || null, connectedAt: auth?.connectedAt || null, host: apiHost(),
  };
}

export async function sheinConsentUrl(by, callbackUrl) {
  const state = crypto.randomBytes(16).toString('hex');
  await setSetting(STATE_KEY, JSON.stringify({ state, by, at: Date.now() }), by);
  const q = new URLSearchParams({ appid: appId(), redirectUrl: Buffer.from(callbackUrl, 'utf8').toString('base64'), state });
  return `${authUrl()}?${q}`;
}

export async function sheinFinishConnect({ tempToken, state }) {
  const st = await readJson(STATE_KEY);
  await setSetting(STATE_KEY, '', 'shein-callback');   // one use
  if (!st?.state || !state || st.state.length !== String(state).length
    || !crypto.timingSafeEqual(Buffer.from(st.state), Buffer.from(String(state)))) {
    throw new Error('This SHEIN approval was not started here (or was already used). Press Connect SHEIN again.');
  }
  if (Date.now() - Number(st.at) > STATE_TTL_MS) throw new Error('The SHEIN approval took too long. Press Connect SHEIN again.');
  if (!tempToken) throw new Error('SHEIN sent no tempToken.');
  const path = '/open-api/auth/get-by-token';
  const ts = String(Date.now());
  const r = await fetch(`${apiHost()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-lt-appid': appId(), 'x-lt-timestamp': ts, 'x-lt-signature': sheinSignature(appId(), appSecret(), path, ts) },
    body: JSON.stringify({ tempToken }),
    signal: AbortSignal.timeout(20_000),
  });
  const j = await r.json().catch(() => ({}));
  const info = j.info || j.data || {};
  if (!r.ok || String(j.code ?? '0') !== '0' || !info.openKeyId || !info.secretKey) {
    throw new Error(`SHEIN token exchange failed: ${j.msg || j.message || `HTTP ${r.status}`}`);
  }
  const secretKey = sheinDecryptSecret(info.secretKey, appSecret());
  const auth = {
    openKeyId: encryptSecret(info.openKeyId), secretKey: encryptSecret(secretKey),
    supplierId: info.supplierId ?? null, mode: info.supplierBusinessMode ?? info.supplierSource ?? null,
    connectedBy: st.by || null, connectedAt: new Date().toISOString(),
  };
  await setSetting(AUTH_KEY, JSON.stringify(auth), st.by || 'shein-callback');
  return { supplierId: auth.supplierId };
}

export async function sheinDisconnect(by) { await setSetting(AUTH_KEY, '', by); }

/* ------------------------------- calls ------------------------------- */

// One signed call to the seller's account. Returns SHEIN's `info` (or the whole body).
// `query` goes on the URL only — SHEIN signs the path without it.
export async function sheinCall(path, body = {}, { method = 'POST', query = '' } = {}) {
  const auth = await readJson(AUTH_KEY);
  if (!auth?.openKeyId) throw Object.assign(new Error('SHEIN is not connected yet.'), { notConnected: true });
  const keyId = decryptSecret(auth.openKeyId);
  const secret = decryptSecret(auth.secretKey);
  const ts = String(Date.now());
  const r = await fetch(`${apiHost()}${path}${query ? `?${query}` : ''}`, {
    method,
    headers: { 'Content-Type': 'application/json;charset=UTF-8', 'x-lt-appid': appId(), 'x-lt-openKeyId': keyId, 'x-lt-timestamp': ts,
      'x-lt-signature': sheinSignature(keyId, secret, path, ts), language: 'en' },
    body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || String(j.code ?? '0') !== '0') throw new Error(`SHEIN ${path}: ${j.msg || j.message || `HTTP ${r.status}`}`);
  return j.info ?? j.data ?? j;
}

// The brands our SHEIN account may list under (the first read once connected).
export const sheinBrands = () => sheinCall('/open-api/goods/query-brand-list', {});

/* --------------------------- the live fix's calls --------------------------- */
// docs/shein-api-reference.md has every field; docs/context/shein-live-fix.md how they're used.

// One page of every APPROVED listing (codes only: spu / skc / sku codes). 50 a page.
export async function sheinProductPage(pageNum, pageSize = 50) {
  const info = await sheinCall('/open-api/openapi-business-backend/product/query', { pageNum, pageSize });
  return listOf(info, 'data');
}
// Every SPU code in the store (de-duplicated, in SHEIN's order).
export async function sheinAllSpus({ max = 400 } = {}) {
  const seen = new Set();
  for (let p = 1; p <= max; p++) {
    const page = await sheinProductPage(p, 50);
    for (const x of page) if (x?.spuName) seen.add(x.spuName);
    if (page.length < 50) break;
  }
  return [...seen];
}
// One product: sizes, seller SKUs, prices, shelf state. No stock (that's stock-query).
export const sheinSpuInfo = (spuName) => sheinCall('/open-api/goods/spu-info', { spuName, languageList: ['en'] });
// SHEIN's docs show `info` as an object, but some answers come wrapped in a list:
// stock-query returns info = [{ goodsInventory: [...] }] (seen on prod 2026-10-17 — reading
// info.goodsInventory gave NOTHING, so every size looked like 0). Take `key` from either.
export function listOf(info, key) {
  const parts = Array.isArray(info) ? info : [info];
  return parts.flatMap((p) => (Array.isArray(p?.[key]) ? p[key] : []));
}
// Merchant (virtual) stock for ≤100 SHEIN SKU codes. `warehouseType` 2 is required until
// SHEIN retires it (2026-12-31); `invType` VI is its replacement and wins when both are sent.
export async function sheinStock(skuCodes) {
  const out = [];
  for (let i = 0; i < skuCodes.length; i += 100) {
    const info = await sheinCall('/open-api/stock/stock-query', { skuCodeList: skuCodes.slice(i, i + 100), warehouseType: '2', invType: 'VI' });
    out.push(...listOf(info, 'goodsInventory'));
  }
  return out;
}
// Our own warehouses (type 1 = merchant warehouse — the only kind whose stock we may set).
export async function sheinWarehouses() {
  const info = await sheinCall('/open-api/msc/warehouse/list', {}, { method: 'GET' });
  return listOf(info, 'list');
}
// Set stock: OVERWRITE the TOTAL (sellable + held by open orders) per SKU per warehouse.
// SHEIN never lets the total go below what orders already hold. ≤100 per call; the
// idempotency key makes a retried call a no-op instead of a second write.
export async function sheinSetStock(writes) {
  const failed = [];
  for (let i = 0; i < writes.length; i += 100) {
    const info = await sheinCall('/open-api/stock/change-inventory/v2', {
      updateSkuInventoryQuantityRequests: writes.slice(i, i + 100).map((w) => ({
        idempotencyKey: w.key, skuCode: w.skuCode, invType: 'VI', warehouseCode: w.warehouseCode || undefined,
        changeType: 'OVERWRITE', changeQuantity: Math.max(0, Math.round(Number(w.total) || 0)), changeReason: 'Stickballman12 live fix: Shopify stock',
      })),
    });
    const f = info?.failedList;
    for (const x of Array.isArray(f) ? f : f ? [f] : []) failed.push({ skuCode: x.skuCode, reason: x.reason || x.code || 'refused' });
  }
  return { failed };
}
// Is any SKC of this SPU in a review (1 = waiting, 5 = appeal)? SHEIN refuses edits then.
export async function sheinInReview(spuName) {
  const info = await sheinCall('/open-api/goods/query-document-state', { spuList: [{ spuName }] });
  return listOf(info, 'data').some((d) => (d.skcList || []).some((s) => [1, 5].includes(Number(s.documentState))));
}
// Which of these seller SKUs already exist anywhere in the store (incl. products in review).
export async function sheinSellerSkusTaken(skus) {
  const taken = new Set();
  for (let i = 0; i < skus.length; i += 200) {
    const info = await sheinCall('/open-api/goods/product/check-supplierSku-repeated', { supplierSkuList: skus.slice(i, i + 200) });
    for (const x of Array.isArray(info) ? info : []) if (x.repeated) taken.add(String(x.supplierSku));
  }
  return taken;
}
// Change seller SKUs on existing sizes of ONE product (partialEdit — SHEIN reviews it).
// edits: [{ skc, skuCode, supplierSku }]. Returns { ok, version, messages }.
export async function sheinSetSellerSkus(spuName, edits) {
  const bySkc = new Map();
  for (const e of edits) { const a = bySkc.get(e.skc) || []; a.push({ sku_code: e.skuCode, supplier_sku: e.supplierSku }); bySkc.set(e.skc, a); }
  const info = await sheinCall('/open-api/goods/product/partialEdit', { spu_name: spuName, skc_list: [...bySkc].map(([skc_name, sku_list]) => ({ skc_name, sku_list })) });
  const messages = (info?.pre_valid_result || []).flatMap((x) => x.messages || []);
  return { ok: info?.success !== false && !messages.length, version: info?.version || null, messages };
}

// Shelf: list (1) / delist (2) SKCs per site, ≤100 a call. SHEIN refuses a second change to
// the same SKC + site within 20 minutes, and one locked by a promotion. Returns per-SKC failures.
export async function sheinSetShelf(list, state) {
  const failed = new Map();
  for (let i = 0; i < list.length; i += 100) {
    const info = await sheinCall('/open-api/goods/modify-skc-shelf', {
      skc_site_info_list: list.slice(i, i + 100).map((x) => ({ skc_name: x.skc, site_list: x.sites, shelf_state: state })),
    });
    for (const f of [].concat(info?.failure_results || [])) failed.set(String(f.identity), f.msg || f.code || 'refused');
  }
  return { failed };
}
// Delete, step 1: may these SKCs be deleted (seller allowed, daily quota of 500 left,
// approved and not deleted)? Off-shelf + no orders in a year are only judged at review.
export async function sheinCheckDeletable(skcs) {
  const ok = new Set(); const no = new Map();
  for (let i = 0; i < skcs.length; i += 50) {
    const info = await sheinCall('/open-api/goods/check-deletable', { skc_name_list: skcs.slice(i, i + 50) });
    for (const x of [].concat(info?.deletable_list || [])) ok.add(String(x));
    for (const x of [].concat(info?.undeletable_list || [])) no.set(String(x.skc_name), x.reason || x.code || 'not deletable');
  }
  return { ok, no };
}
// Delete, step 2: ask SHEIN to delete ONE SKC (it reviews; can't be undone). The signed path
// includes the SKC. Returns the application number.
export async function sheinDeleteSkc(skc) {
  const info = await sheinCall(`/open-api/goods/delete/${encodeURIComponent(skc)}`, {}, { method: 'DELETE' });
  return { submitted: info?.deleted !== false, applyNo: info?.apply_no || null };
}
// Delete, step 3: SHEIN's review of our requests (≤10 SKCs). status 0/1 pending · 2 deleted · 3 refused.
export async function sheinDeleteLogs(skcs) {
  const out = new Map();
  for (let i = 0; i < skcs.length; i += 10) {
    const info = await sheinCall('/open-api/goods-delete-logs/search', { skc_name_list: skcs.slice(i, i + 10) }, { query: 'page_num=1&page_size=100' });
    for (const x of listOf(info, 'data')) {
      const k = String(x.skc_name); const cur = out.get(k);
      if (!cur || String(x.submit_time || '') > String(cur.submit_time || '')) out.set(k, x);   // the latest request
    }
  }
  return out;
}

/* ------------------------------- webhooks ------------------------------- */
// SHEIN's pushes (docs: system page 3b13b1c5…, "Webhook说明"): signed like our calls but with
// the APP's id + secret (not the store's openKeyId), over the request PATH; the body is
// form-data `eventData`, AES-encrypted with the app secret (same AES as the get-by-token
// answer). Returns the decrypted JSON, or null when anything doesn't check out.
export function sheinOpenWebhook({ headers, path, eventData, now = Date.now() }) {
  const h = (k) => String(headers?.[k] ?? headers?.[k.toLowerCase()] ?? '').trim();
  const id = h('x-lt-appid'); const ts = h('x-lt-timestamp'); const sig = h('x-lt-signature');
  if (!appId() || !appSecret() || id !== appId() || !ts || sig.length < 6 || !eventData) return null;
  if (Math.abs(now - Number(ts)) > 15 * 60_000) return null;           // a replayed old push
  const want = sheinSignature(id, appSecret(), path, ts, sig.slice(0, 5));
  const a = Buffer.from(want); const b = Buffer.from(sig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { return JSON.parse(sheinDecryptSecret(eventData, appSecret())); } catch { return null; }
}
