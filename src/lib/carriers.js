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
