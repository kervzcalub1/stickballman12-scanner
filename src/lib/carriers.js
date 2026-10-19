// Couriers we support for PO shipping labels, keyed by 17TRACK's numeric carrier code
// (from res.17track.net/asset/carrier/info/apicarrier.all.json). The key is passed to
// 17TRACK's register/gettrackinfo so it pulls status from the RIGHT carrier instead of
// guessing. Curated to the couriers a US sneaker warehouse actually ships with — extend
// as needed. Shared by the client (dropdown + PDF detection) and the server (register +
// display), so it's plain data + pure functions (no JSX / server imports).
export const CARRIERS = [
  { key: 100002, name: 'UPS' },
  { key: 100003, name: 'FedEx' },
  { key: 21051, name: 'USPS' },
  { key: 100001, name: 'DHL Express' },
  { key: 100049, name: 'OnTrac' },
  { key: 100005, name: 'GLS' },
  { key: 100006, name: 'Aramex' },
  { key: 100042, name: 'Purolator' },
  { key: 3041, name: 'Canada Post' },
  { key: 11031, name: 'Royal Mail' },
  { key: 1151, name: 'Australia Post' },
];

const BY_KEY = new Map(CARRIERS.map((c) => [Number(c.key), c.name]));

// Display name for a stored value: a 17TRACK carrier key (from our dropdown/detection) OR
// a name/string already set by the tracking feed. Falls back to the raw value.
export function carrierName(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (Number.isInteger(n) && BY_KEY.has(n)) return BY_KEY.get(n);
  return String(value);
}

// Detect the 17TRACK carrier key from a label's text and/or its tracking number. The
// label TEXT (the carrier is almost always printed on it) wins; otherwise the tracking-
// number format. Returns a key from CARRIERS, or null when nothing is confident.
export function detectCarrierKey({ text = '', number = '' } = {}) {
  const T = String(text || '').toUpperCase();
  const N = String(number || '').toUpperCase().replace(/[^0-9A-Z]/g, '');

  // 1) Printed carrier name on the label (most reliable).
  if (/\bUPS\b|UNITED PARCEL/.test(T)) return 100002;
  if (/FED\s?EX|FEDEX/.test(T)) return 100003;
  if (/\bUSPS\b|UNITED STATES POSTAL|\bUS POSTAL\b|PRIORITY MAIL|FIRST[-\s]?CLASS MAIL/.test(T)) return 21051;
  if (/\bDHL\b/.test(T)) return 100001;
  if (/ONTRAC/.test(T)) return 100049;
  if (/PUROLATOR/.test(T)) return 100042;
  if (/CANADA POST|POSTES CANADA/.test(T)) return 3041;
  if (/ROYAL MAIL/.test(T)) return 11031;
  if (/AUSTRALIA POST|AUSPOST/.test(T)) return 1151;
  if (/\bGLS\b/.test(T)) return 100005;
  if (/ARAMEX/.test(T)) return 100006;

  // 2) Tracking-number format.
  if (/^1Z[0-9A-Z]{16}$/.test(N)) return 100002;            // UPS
  if (/^96\d{20}$/.test(N)) return 100003;                   // FedEx Ground 96-barcode (22 digits)
  if (/^9[1-5]\d{18,24}$/.test(N)) return 21051;             // USPS IMpb (91–95…)
  if (/^[A-Z]{2}\d{9}US$/.test(N)) return 21051;             // USPS international (e.g. LZ…US)
  if (/^[CD]\d{14}$/.test(N)) return 100049;                 // OnTrac
  if (/^\d{12}$/.test(N) || /^\d{15}$/.test(N)) return 100003; // FedEx Express (12 / 15 digit)
  if (/^\d{10,11}$/.test(N)) return 100001;                  // DHL Express (10–11 digit)
  return null;
}

// ---- The courier's OWN tracking page --------------------------------------------------
// 17TRACK is a relay: it polls the courier and pushes to our webhook, so what we show can
// be hours behind what UPS itself says. Every tracking number on screen links straight to
// the courier's site with the number already filled in, so a person checking on a late
// parcel reads the courier's live answer, not our copy of it.
//
// `bulk` = the courier's page takes several numbers at once (UPS 25, FedEx 30, USPS 35:
// their own limits), joined by `sep` — used by "Open on UPS (12)" on the Undelivered page.
// Everything else opens one number per page, and an unknown courier falls back to 17TRACK's
// public page (which also takes a list).
const COURIER_PAGES = {
  100002: { name: 'UPS', max: 25, sep: '\n', url: (q) => `https://www.ups.com/track?loc=en_US&tracknum=${q}&requester=ST/trackdetails` },
  100003: { name: 'FedEx', max: 30, sep: ',', url: (q) => `https://www.fedex.com/fedextrack/?trknbr=${q}` },
  21051: { name: 'USPS', max: 35, sep: ',', url: (q) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${q}` },
  100001: { name: 'DHL', max: 10, sep: ',', url: (q) => `https://www.dhl.com/us-en/home/tracking/tracking-express.html?submit=1&tracking-id=${q}` },
  100049: { name: 'OnTrac', max: 1, url: (q) => `https://www.ontrac.com/tracking/?number=${q}` },
  100005: { name: 'GLS', max: 1, url: (q) => `https://gls-group.com/GROUP/en/parcel-tracking?match=${q}` },
  100006: { name: 'Aramex', max: 1, url: (q) => `https://www.aramex.com/us/en/track/results?ShipmentNumber=${q}` },
  100042: { name: 'Purolator', max: 1, url: (q) => `https://www.purolator.com/en/shipping/tracker?pin=${q}` },
  3041: { name: 'Canada Post', max: 1, url: (q) => `https://www.canadapost-postescanada.ca/track-reperage/en#/search?searchFor=${q}` },
  11031: { name: 'Royal Mail', max: 1, url: (q) => `https://www.royalmail.com/track-your-item#/tracking-results/${q}` },
  1151: { name: 'Australia Post', max: 1, url: (q) => `https://auspost.com.au/mypost/track/details/${q}` },
};
const SEVENTEEN = { name: '17TRACK', max: 40, sep: ',', url: (q) => `https://t.17track.net/en#nums=${q}` };
const BY_NAME = new Map(CARRIERS.map((c) => [c.name.toUpperCase().replace(/[^A-Z]/g, ''), c.key]));

// The courier for a number: what we stored (a 17TRACK key, or the name the feed wrote,
// e.g. "UPS" / "FedEx" / "DHL Express"), else the number's own format.
export function courierKeyFor(number, carrier) {
  if (carrier != null && carrier !== '') {
    const n = Number(carrier);
    if (Number.isInteger(n) && COURIER_PAGES[n]) return n;
    const name = String(carrier).toUpperCase().replace(/[^A-Z]/g, '');
    if (BY_NAME.has(name)) return BY_NAME.get(name);
    if (name.startsWith('DHL')) return 100001;
    if (name.startsWith('FEDEX')) return 100003;
    if (name.startsWith('UPS')) return 100002;
    if (name.startsWith('USPS')) return 21051;
  }
  return detectCarrierKey({ number });
}

const clean = (n) => String(n || '').replace(/[\s-]/g, '').toUpperCase();

// { name, url } for one number — `name` is the courier the link opens ("17TRACK" when we
// could not tell). Null for a blank number.
export function courierTrackLink(number, carrier) {
  const num = clean(number);
  if (!num) return null;
  const page = COURIER_PAGES[courierKeyFor(num, carrier)] || SEVENTEEN;
  return { name: page.name, url: page.url(encodeURIComponent(num)) };
}

// Many numbers → one link per courier page, split at the courier's own limit:
// [{ name, url, numbers }]. Input rows: { tracking_number, carrier_key?, carrier? }.
export function courierBulkLinks(rows) {
  const groups = new Map();
  for (const r of rows || []) {
    const num = clean(r.tracking_number);
    if (!num) continue;
    const key = courierKeyFor(num, r.carrier_key || r.carrier) ?? '17track';
    if (!groups.has(key)) groups.set(key, []);
    if (!groups.get(key).includes(num)) groups.get(key).push(num);
  }
  const out = [];
  for (const [key, nums] of groups) {
    const page = COURIER_PAGES[key] || SEVENTEEN;
    const step = Math.max(1, page.max || 1);
    for (let i = 0; i < nums.length; i += step) {
      const chunk = nums.slice(i, i + step);
      out.push({ name: page.name, numbers: chunk, url: page.url(encodeURIComponent(chunk.join(page.sep || ','))) });
    }
  }
  return out;
}
