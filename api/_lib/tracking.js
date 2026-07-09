// Shipment-tracking adapter (17TRACK). Thin + optional: everything no-ops unless
// TRACKING_API_KEY is set, so the app runs fine without it (like the other
// integrations). We register each label's tracking number when it ships, then get
// status via 17TRACK's webhook push (api/po/tracking-webhook.js) or an on-demand
// pull (api/po/track-refresh.js). Kept behind this one module so swapping providers
// (e.g. AfterShip) is a single-file change. See docs/po-scanout-plan.md.
const BASE = 'https://api.17track.net/track/v2.2';

export const trackingConfigured = () => !!process.env.TRACKING_API_KEY;
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

// Register tracking numbers so 17TRACK starts tracking + will webhook updates.
export async function registerTracking(numbers) {
  const nums = (numbers || []).filter(Boolean).slice(0, 40);
  if (!trackingConfigured() || !nums.length) return { skipped: true };
  return call('/register', nums.map((n) => ({ number: String(n) })));
}

// Pull current status for a set of numbers. Returns [{ trackingNumber, carrier,
// trackingStatus, lastCheckpoint, boxStatus }] (only entries we could parse).
export async function fetchTrackInfo(numbers) {
  const nums = (numbers || []).filter(Boolean).slice(0, 40);
  if (!trackingConfigured() || !nums.length) return [];
  const json = await call('/gettrackinfo', nums.map((n) => ({ number: String(n) })));
  const accepted = json?.data?.accepted || [];
  return accepted.map(parseTrackEntry).filter(Boolean);
}

// Map a 17TRACK status string → our po_boxes.status (pending|shipped|in_transit|delivered).
// Unknown/exception statuses return null (leave the box status unchanged).
export function mapBoxStatus(status17) {
  const s = String(status17 || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!s) return null;
  if (s.includes('delivered')) return 'delivered';
  if (['intransit', 'outfordelivery', 'availableforpickup', 'inforeceived', 'pickup'].some((x) => s.includes(x)))
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
  const lastCheckpoint = ti?.latest_event?.description || ti?.latest_event?.stage || null;
  const carrier = entry.carrier != null ? String(entry.carrier) : (ti?.tracking?.providers?.[0]?.provider?.name || null);
  return {
    trackingNumber: String(number),
    carrier: carrier ? String(carrier) : null,
    trackingStatus: trackingStatus ? String(trackingStatus) : null,
    lastCheckpoint: lastCheckpoint ? String(lastCheckpoint).slice(0, 300) : null,
    boxStatus: mapBoxStatus(trackingStatus),
  };
}

// Extract the track record(s) from a 17TRACK webhook push body.
export function parseWebhook(body) {
  // 17TRACK pushes { event, data: <track record> } (single) — be tolerant of arrays.
  const items = Array.isArray(body?.data) ? body.data : (body?.data ? [body.data] : []);
  return items.map(parseTrackEntry).filter(Boolean);
}
