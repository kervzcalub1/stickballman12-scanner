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
export async function sheinCall(path, body = {}, { method = 'POST' } = {}) {
  const auth = await readJson(AUTH_KEY);
  if (!auth?.openKeyId) throw Object.assign(new Error('SHEIN is not connected yet.'), { notConnected: true });
  const keyId = decryptSecret(auth.openKeyId);
  const secret = decryptSecret(auth.secretKey);
  const ts = String(Date.now());
  const r = await fetch(`${apiHost()}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json;charset=UTF-8', 'x-lt-appid': appId(), 'x-lt-openKeyId': keyId, 'x-lt-timestamp': ts,
      'x-lt-signature': sheinSignature(keyId, secret, path, ts), language: 'en' },
    body: method === 'GET' ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || String(j.code ?? '0') !== '0') throw new Error(`SHEIN ${path}: ${j.msg || j.message || `HTTP ${r.status}`}`);
  return j.info ?? j.data ?? j;
}

// The brands our SHEIN account may list under (the first read once connected).
export const sheinBrands = () => sheinCall('/open-api/goods/query-brand-list', {});
