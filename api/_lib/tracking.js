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

// A tracked item is either a bare number string or { number, carrier } where carrier is
// the 17TRACK numeric carrier key (so the aggregator pulls status from the RIGHT carrier
// instead of guessing). Normalizes to 17TRACK's { number, carrier? } request shape.
function toItem(x) {
  const raw = x && typeof x === 'object' ? x : { number: x };
  const number = String(raw.number || '').trim();
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
  return call('/register', list);
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
export const sheetsTrackingUrl = () => process.env.GOOGLE_SHEETS_TRACKING_URL || '';
export async function forwardTrackingToSheet(updates) {
  const url = sheetsTrackingUrl();
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
  if (!url || !rows.length) return { skipped: true };
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 6000);
    try {
      await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'stickballman12', updates: rows }), signal: ac.signal,
      });
    } finally { clearTimeout(t); }
    return { ok: true, sent: rows.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Extract the track record(s) from a 17TRACK webhook push body.
export function parseWebhook(body) {
  // 17TRACK pushes { event, data: <track record> } (single) — be tolerant of arrays.
  const items = Array.isArray(body?.data) ? body.data : (body?.data ? [body.data] : []);
  return items.map(parseTrackEntry).filter(Boolean);
}
