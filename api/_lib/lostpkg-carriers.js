// Lost Package Tracker Tool, Phase 2: ask the couriers (docs/context/lost-packages.md).
// A port of the original tool's phase2.py — FedEx Track API + EasyPost, smart routing with
// a fallback, EasyPost "unknown" re-polled at 3 / 6 / 10 / 15 s (its Fix A), still unknown →
// Failed to scan (its Fix C). Keys: EASYPOST_API_KEY, FEDEX_CLIENT_ID, FEDEX_CLIENT_SECRET.
//
// FEDEX_API_BASE / EASYPOST_API_BASE exist so the test suite can point both at a fake on
// localhost (playwright.config.js) — the suite must never create a real EasyPost tracker
// (EasyPost bills per tracker) or spend FedEx quota.
import { courierClass, inferCourier, routeFor, cleanTracking } from '../../src/lib/lostPackage.js';

const FEDEX = () => (process.env.FEDEX_API_BASE || 'https://apis.fedex.com').replace(/\/+$/, '');
const EASYPOST = () => (process.env.EASYPOST_API_BASE || 'https://api.easypost.com').replace(/\/+$/, '');
const TIMEOUT_MS = 30_000;
const MAX_RETRIES = 6;
const POLL_S = [3, 6, 10, 15];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const carriersConfigured = () =>
  !!(process.env.EASYPOST_API_KEY && process.env.FEDEX_CLIENT_ID && process.env.FEDEX_CLIENT_SECRET);
export const missingCarrierKeys = () =>
  ['EASYPOST_API_KEY', 'FEDEX_CLIENT_ID', 'FEDEX_CLIENT_SECRET'].filter((k) => !process.env[k]);

async function http(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}
const short = (s) => String(s || '').replace(/\s+/g, ' ').slice(0, 300);

/* ---------------------------------- FedEx ---------------------------------- */

let fedexToken = null;   // { token, until }

async function fedexAuth() {
  if (fedexToken && Date.now() < fedexToken.until) return fedexToken.token;
  const r = await http(`${FEDEX()}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.FEDEX_CLIENT_ID || '',
      client_secret: process.env.FEDEX_CLIENT_SECRET || '',
    }),
  });
  if (!r.ok) throw new Error(`FedEx sign-in HTTP ${r.status}: ${short(await r.text())}`);
  const j = await r.json();
  if (!j.access_token) throw new Error('FedEx sign-in gave no token.');
  fedexToken = { token: j.access_token, until: Date.now() + Math.max(60, Number(j.expires_in || 3500) - 60) * 1000 };
  return fedexToken.token;
}

/** → { delivered, status, raw }. Throws when FedEx can't answer for this number (→ fallback). */
export async function fedexTrack(tracking) {
  const token = await fedexAuth();
  const r = await http(`${FEDEX()}/track/v1/trackingnumbers`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-locale': 'en_US' },
    body: JSON.stringify({ includeDetailedScans: true, trackingInfo: [{ trackingNumberInfo: { trackingNumber: tracking } }] }),
  });
  if (r.status === 401) fedexToken = null;   // a revoked token is fetched afresh next time
  if (!r.ok) throw new Error(`FedEx track HTTP ${r.status}: ${short(await r.text())}`);
  const data = await r.json();
  const tr = data?.output?.completeTrackResults?.[0]?.trackResults?.[0];
  if (!tr) throw new Error('FedEx gave no result for this number.');
  // "Tracking number not found" comes back as a 200 with an error on the result. The original
  // read that as "still moving" and filed it LOST; here it goes to the other service first.
  if (tr.error) throw new Error(`FedEx: ${short(tr.error.message || tr.error.code)}`);
  const latest = tr.latestStatusDetail || {};
  const code = String(latest.code || '').toUpperCase();
  const desc = String(latest.description || '');
  const locale = String(latest.statusByLocale || '');
  const actual = (tr.dateAndTimes || tr.dates || []).some((d) => String(d.type || '').toLowerCase().replace(/_/g, '') === 'actualdelivery');
  // Only what FedEx actually said: an empty status must read as "unknown" (→ failed to scan),
  // not as "code= | desc=" text that classifies as still moving.
  const raw = [code && `code=${code}`, desc && `desc=${desc}`, locale && `locale=${locale}`, actual && 'actualdelivery_present']
    .filter(Boolean).join(' | ');
  return { delivered: code === 'DL' || actual || /^delivered$/i.test(locale.trim()), status: code === 'DL' ? 'delivered' : code ? 'in_transit' : '', raw };
}

/* --------------------------------- EasyPost -------------------------------- */

async function easypost(method, path, body) {
  const auth = `Basic ${Buffer.from(`${process.env.EASYPOST_API_KEY || ''}:`).toString('base64')}`;
  let backoff = 1000;
  for (let i = 0; i < MAX_RETRIES; i++) {
    const r = await http(`${EASYPOST()}${path}`, {
      method,
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (r.ok) return r.json();
    if (r.status === 429 || r.status === 409) { await sleep(backoff); backoff = Math.min(30_000, backoff * 2); continue; }
    throw new Error(`EasyPost HTTP ${r.status}: ${short(await r.text())}`);
  }
  throw new Error('EasyPost kept asking us to slow down.');
}

const epAnswer = (j) => {
  const status = String(j?.status || '').toLowerCase();
  const detail = String(j?.status_detail || '');
  return { delivered: status === 'delivered', status, raw: [status, detail].filter(Boolean).join(' | ') };
};

/** → { delivered, status, raw }. An "unknown" tracker is asked again at 3 / 6 / 10 / 15 s. */
export async function easypostTrack(tracking, courier) {
  const created = await easypost('POST', '/v2/trackers', {
    tracker: { tracking_code: tracking, ...(courier === 'fedex' ? { carrier: 'FedExDefault' } : {}) },
  });
  let a = epAnswer(created);
  if ((a.status === 'unknown' || !a.status) && created?.id) {
    for (const s of POLL_S) {
      await sleep(s * 1000 * Number(process.env.LOSTPKG_POLL_SCALE ?? 1));
      a = epAnswer(await easypost('GET', `/v2/trackers/${encodeURIComponent(created.id)}`));
      if (a.status && a.status !== 'unknown') break;
    }
  }
  return a;
}

/* --------------------------------- One order -------------------------------- */

const LABEL = { lost: 'still not delivered', delivered: 'delivered', cancelled: 'cancelled', refunded: 'refunded', failed: 'failed to scan' };

/**
 * One order, as the original's Phase 2 loop did it: route by courier, fall back on an error,
 * classify. → { class: lost|delivered|cancelled|refunded|failed, courier, primary, fallback,
 * raw, error, label }. Never throws.
 */
export async function checkOrder(order) {
  const tracking = cleanTracking(order.tracking || order.tracking_fallback || '');
  const courier = inferCourier(tracking, order.courier);
  const { primary, fallback } = routeFor(courier);
  const out = (cls, raw, error) => ({
    class: cls, courier, primary, fallback, raw: raw || '', error: error || '',
    label: `${tracking || order.order_number || order.key} (${courier}) → ${LABEL[cls]}`,
  });
  if (!tracking) return out('failed', '', 'No tracking number (and no fallback via Order Number).');

  const ask = (who) => (who === 'fedex' ? fedexTrack(tracking) : easypostTrack(tracking, courier));
  let answer;
  let error = '';
  try {
    answer = await ask(primary);
  } catch (e1) {
    error = `${primary === 'fedex' ? 'FedEx' : 'EasyPost'} failed: ${short(e1.message)}`;
    try {
      answer = await ask(fallback);
    } catch (e2) {
      return out('failed', '', `${error} | ${fallback === 'fedex' ? 'FedEx' : 'EasyPost'} failed: ${short(e2.message)}`);
    }
  }
  const cls = courierClass(answer);
  if (cls === 'unknown') return out('failed', answer.raw, error || 'UNKNOWN after polling — failed to scan.');
  return out(cls === 'shipping' ? 'lost' : cls, answer.raw, error);
}
