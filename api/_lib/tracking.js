// Shipment-tracking adapter (17TRACK). Thin + optional: everything no-ops unless
// TRACKING_API_KEY is set, so the app runs fine without it (like the other
// integrations). We register each label's tracking number when it ships, then get
// status via 17TRACK's webhook push (api/po/tracking-webhook.js) or an on-demand
// pull (api/po/track-refresh.js). Kept behind this one module so swapping providers
// (e.g. AfterShip) is a single-file change. See docs/po-scanout-plan.md.
import { carrierName } from '../../src/lib/carriers.js';
import { subStatusLabel, subStatusNeedsAction } from '../../src/lib/trackstatus.js';

const BASE = 'https://api.17track.net/track/v2.2';

export const trackingConfigured = () => !!process.env.TRACKING_API_KEY;

// Registering a number with 17TRACK is a WRITE to a live, shared, metered account, and
// it is permanent: the number sits in the dashboard and stays on auto-tracking long
// after whatever created it is gone. That is not a thing a development machine should be
// able to do by accident — and it did. `e2e/po-edit.spec.js` invents numbers like
// `EDIT<timestamp>A`; PO creation registers whatever it is handed; the dev server loads
// the real .env. 50 invented numbers accumulated on the account over a week, none of
// which existed in any database, because test teardown deletes rows and registration
// outlives them.
//
// So the dev server does not register, full stop. This is the chokepoint — all eleven
// call sites (po/create, label-add, label-update, ship, resolution, track-refresh,
// tracking-register, track.js) go through here, which is why the guard lives here and
// not in the test harness. Blocking known test PREFIXES was the other option and it is
// fragile: the suite alone invents ten of them, and one day a courier issues a number
// that collides.
//
// Fails safe in both directions: production runs server.mjs, which never sets APP_ENV,
// so nothing changes there and the feature cannot be silently switched off by a missing
// variable. To exercise registration locally on purpose, set TRACKING_ALLOW_DEV=1.
const registerAllowed = () => process.env.APP_ENV !== 'dev' || process.env.TRACKING_ALLOW_DEV === '1';

// A tracked item is either a bare number string or { number, carrier } where carrier is
// the 17TRACK numeric carrier key (so the aggregator pulls status from the RIGHT carrier
// instead of guessing). Normalizes to 17TRACK's { number, carrier? } request shape.
// Couriers reject a number typed the way a person reads it. 17TRACK refused
// "1Z 3YY 408 13 2795 1235" outright for format, and could not route
// "420175451Z3YY4080312658064" — a UPS Mail Innovations label carries a 420+ZIP
// routing prefix in front of the real 1Z. Both are good parcels behind a
// presentation problem, and the number is typed by hand in half a dozen places.
// Normalising HERE covers every call site at once.
export function normalizeTrackingNumber(raw) {
  const n = String(raw || '').trim();
  const bare = n.replace(/[\s-]/g, '');
  const mi = bare.match(/^420\d{4,9}(1Z[A-Z0-9]{16})$/i);
  if (mi) return mi[1].toUpperCase();
  // Only collapse spacing on formats where it is decorative. Left alone otherwise:
  // some couriers use dashes meaningfully, and inventing a number is worse than
  // failing to register one.
  return /^1Z[A-Z0-9\s-]{16,}$/i.test(n) ? bare.toUpperCase() : n;
}

function toItem(x) {
  const raw = x && typeof x === 'object' ? x : { number: x };
  const number = normalizeTrackingNumber(raw.number);
  if (!number) return null;
  const carrier = Number.isInteger(Number(raw.carrier)) && Number(raw.carrier) > 0 ? Number(raw.carrier) : null;
  return carrier ? { number, carrier } : { number };
}
export const trackingWebhookSecret = () => process.env.TRACKING_WEBHOOK_SECRET || '';

async function call(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { '17token': process.env.TRACKING_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`17TRACK ${path} → HTTP ${res.status}`);
  return res.json();
}

// Register tracking numbers so 17TRACK starts tracking + will webhook updates. Items may
// carry a `carrier` (17TRACK key) so registration is bound to the correct courier.
export async function registerTracking(items) {
  const list = (items || []).map(toItem).filter(Boolean).slice(0, 40);
  if (!trackingConfigured() || !list.length) return { skipped: true };
  if (!registerAllowed()) {
    // Loud, not silent: someone testing the tracking flow locally needs to know why
    // nothing appeared, and the numbers are named so it is obvious what was withheld.
    console.warn(`[tracking] register SKIPPED (dev server): ${list.map((i) => i.number).join(', ')}`
      + ' — set TRACKING_ALLOW_DEV=1 to register against the live 17TRACK account.');
    return { skipped: true, reason: 'dev' };
  }
  return call('/register', list);
}

// Register tracking numbers the WAREHOUSE typed in, rather than ones that arrived on a
// purchase order. Claim-then-register: `claimForTracking` stamps `registered_at` in the
// same statement that inserts the row, so the same parcel scanned into two boxes, or a
// batch re-synced twice, cannot both spend quota on it. Numbers already known are
// silently skipped and nothing is called.
//
// Fire-and-forget by design — receiving must never wait on, or fail because of, a
// third-party account. The dev guard inside registerTracking still applies.
export async function registerWarehouseTracking(numbers, { claim, label = 'tracking' } = {}) {
  const list = (numbers || []).map((n) => String(n || '').trim()).filter(Boolean);
  if (!trackingConfigured() || !list.length || typeof claim !== 'function') return { skipped: true };
  let fresh = [];
  try { fresh = await claim(list); } catch (e) { console.warn(`[${label}] claim:`, e.message); return { skipped: true }; }
  if (!fresh.length) return { skipped: true, reason: 'already-registered' };
  for (let i = 0; i < fresh.length; i += 40) {
    await registerTracking(fresh.slice(i, i + 40))
      .catch((e) => console.warn(`[${label}] registerTracking:`, e.message));
  }
  return { registered: fresh.length };
}

// Tell 17TRACK to STOP auto-tracking these numbers — call once a parcel is delivered.
// A delivered parcel never changes again, so leaving it on auto-tracking just burns the
// account's tracking quota (see the "Tracking stopped" state in the 17TRACK dashboard).
// Idempotent: stopping an already-stopped number is a harmless no-op. Best-effort, and
// no-ops without TRACKING_API_KEY.
export async function stopTracking(items) {
  const list = (items || []).map(toItem).filter(Boolean).slice(0, 40);
  if (!trackingConfigured() || !list.length) return { skipped: true };
  return call('/stoptrack', list);
}

// Pull current status for a set of items (number + optional carrier key). Returns
// [{ trackingNumber, carrier, trackingStatus, lastCheckpoint, boxStatus }] (only parsed).
export async function fetchTrackInfo(items) {
  const list = (items || []).map(toItem).filter(Boolean).slice(0, 40);
  if (!trackingConfigured() || !list.length) return [];
  const json = await call('/gettrackinfo', list);
  const accepted = json?.data?.accepted || [];
  return accepted.map(parseTrackEntry).filter(Boolean);
}

// Map a 17TRACK status string → our po_boxes.status
// (pending|pre_transit|shipped|in_transit|delivered). Unknown/exception → null (leave as-is).
export function mapBoxStatus(status17) {
  const s = String(status17 || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!s) return null;
  if (s.includes('delivered')) return 'delivered';
  // "InfoReceived" = the carrier has the label details but hasn't scanned the parcel yet —
  // it's still physically with the sender (the supplier). Distinct from actually moving.
  if (s.includes('inforeceived')) return 'pre_transit';
  if (['intransit', 'outfordelivery', 'availableforpickup', 'pickup'].some((x) => s.includes(x)))
    return 'in_transit';
  return null; // notfound / exception / expired / deliveryfailure → don't downgrade
}

// Tolerant extractor for a single 17TRACK track record (register/gettrackinfo item
// and the webhook payload share this shape). Digs a few known paths defensively.
export function parseTrackEntry(entry) {
  if (!entry) return null;
  const number = entry.number || entry.tracking_number;
  if (!number) return null;
  const ti = entry.track_info || entry.track || entry;
  const trackingStatus = ti?.latest_status?.status || ti?.latest_status || null;
  // sub_status is the detail behind the coarse status — Exception_Returning vs
  // Exception_Security are the same "Exception" but very different problems. Only present
  // when latest_status is an object (older/simpler payloads send a bare string).
  const subStatus = ti?.latest_status?.sub_status || null;
  const subStatusDescr = ti?.latest_status?.sub_status_descr || null;
  const lastCheckpoint = ti?.latest_event?.description || ti?.latest_event?.stage || null;
  // Prefer the human-readable provider name; else map 17TRACK's numeric carrier code to a
  // name (UPS, FedEx…) so labels never show a bare code like "100002".
  const providerName = ti?.tracking?.providers?.[0]?.provider?.name || null;
  const carrier = providerName || carrierName(entry.carrier);
  // Full checkpoint history (newest first) for the milestone timeline UI, capped.
  const events = (ti?.tracking?.providers?.[0]?.events || [])
    .slice(0, 60)
    .map((e) => ({
      time: e.time_iso || e.time_utc || null,
      description: e.description ? String(e.description).slice(0, 300) : null,
      location: e.location ? String(e.location).slice(0, 200) : null,
      stage: e.stage || null,
    }))
    .filter((e) => e.time || e.description);
  return {
    trackingNumber: String(number),
    carrier: carrier ? String(carrier) : null,
    trackingStatus: trackingStatus ? String(trackingStatus) : null,
    subStatus: subStatus ? String(subStatus).slice(0, 60) : null,
    subStatusDescr: subStatusDescr ? String(subStatusDescr).slice(0, 300) : null,
    lastCheckpoint: lastCheckpoint ? String(lastCheckpoint).slice(0, 300) : null,
    boxStatus: mapBoxStatus(trackingStatus),
    events,
  };
}

// Fan-out to Google Sheets. 17TRACK pushes to ONE webhook URL (ours); the warehouse still
// keeps tracking labels in a Google Sheet, so we forward each status update there too.
// Point GOOGLE_SHEETS_TRACKING_URL at a Google Apps Script Web App (deployed "Anyone")
// that appends/updates rows keyed by tracking number. Best-effort + env-gated: no-ops
// without the URL, and a slow/broken Sheet never blocks the DB write or the 17TRACK 200.
// One or more Apps Script Web App URLs, comma- or newline-separated (a URL can hold
// neither, so splitting on both is safe). Multiple targets matter because this env var
// is the ONLY thing pointing at a sheet: with a single slot, adding a second sheet
// meant overwriting the first, which silently stopped it updating.
export const sheetsTrackingUrls = () => String(process.env.GOOGLE_SHEETS_TRACKING_URL || '')
  .split(/[\s,]+/)
  .map((u) => u.trim())
  .filter((u) => /^https?:\/\//i.test(u));
// "Is a sheet configured at all" — kept for callers that only need the yes/no.
export const sheetsTrackingUrl = () => sheetsTrackingUrls()[0] || '';

// An /exec URL is a capability — anyone holding it can write to that sheet — so logs
// get a recognisable tail, never the whole thing.
const shortSheetUrl = (u) => {
  const seg = String(u).split('/').filter(Boolean).sort((a, b) => b.length - a.length)[0] || '';
  return `…${seg.slice(-6)}`;
};

export async function forwardTrackingToSheet(updates) {
  const urls = sheetsTrackingUrls();
  // Both the raw sub-status and a readable version: the raw code is what you'd filter or
  // pivot on in the sheet, the label is what a person reads without a lookup table.
  const rows = (updates || []).map((u) => ({
    trackingNumber: u.trackingNumber,
    status: u.trackingStatus || null,   // raw 17TRACK status text
    subStatus: u.subStatus || null,     // raw 17TRACK sub_status, e.g. Exception_Returning
    subStatusLabel: subStatusLabel(u.subStatus) || null,   // e.g. "Being returned to sender"
    subStatusDetail: u.subStatusDescr || null,             // 17TRACK's own extra description
    needsAction: subStatusNeedsAction(u.subStatus),        // stuck / returning / lost
    stage: u.boxStatus || null,         // our mapped stage: pre_transit | in_transit | delivered
    carrier: u.carrier || null,
    lastCheckpoint: u.lastCheckpoint || null,
  }));
  if (!urls.length || !rows.length) return { skipped: true };
  const body = JSON.stringify({ source: 'stickballman12', updates: rows });
  // Every sheet gets its own request, its own timeout and its own failure. One slow or
  // broken sheet must not stop the others receiving the update — and none of them may
  // block the DB write or the 200 we owe 17TRACK, which is why both callers
  // fire-and-forget this.
  const results = await Promise.all(urls.map(async (url) => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 6000);
    try {
      const res = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: ac.signal,
      });
      return { url, ok: res.ok, status: res.status };
    } catch (e) {
      return { url, ok: false, error: e.message };
    } finally { clearTimeout(t); }
  }));
  // Name the sheet that broke. Silence was the old failure mode: the callers
  // fire-and-forget and this swallowed its own errors, so a sheet that quietly stopped
  // updating left no trace anywhere. With more than one target that gets worse — the
  // other sheet keeps filling in, which makes everything look fine.
  const failed = results.filter((r) => !r.ok);
  for (const f of failed) {
    console.warn('[tracking sheet]', shortSheetUrl(f.url), 'failed:', f.error || `HTTP ${f.status}`);
  }
  return { ok: !failed.length, sent: rows.length, targets: urls.length, failed: failed.length };
}

// Extract the track record(s) from a 17TRACK webhook push body.
export function parseWebhook(body) {
  // 17TRACK pushes { event, data: <track record> } (single) — be tolerant of arrays.
  const items = Array.isArray(body?.data) ? body.data : (body?.data ? [body.data] : []);
  return items.map(parseTrackEntry).filter(Boolean);
}
