// What the warehouse should expect: today and this week, by supplier and by online store.
// A plan, not a timetable, so the week is one column rather than a day each. Days come from
// the carrier's own estimate, through the same `arrivalBucket` the Inbound screen uses.
import { arrivalBucket, inboundState, daysSince, neverScanned, STALL_DAYS } from './inbound.js';

// A week with no movement is delayed, and the team is told (`tracking-delay-worker`).
export const DELAY_DAYS = STALL_DAYS;
const words = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');

// Days since it last moved, if it has a tracking number, isn't here, and has stopped. Else null.
export function delayedDays(row, now = Date.now()) {
  if (!String(row?.tracking_number || '').trim()) return null;
  if (row?.box_status === 'delivered' || inboundState(row, now) === 'delivered') return null;
  const days = daysSince(row?.last_move_at ?? row?.shipped_at, now);
  return days != null && days >= DELAY_DAYS ? Math.floor(days) : null;
}

// Who to chase, in words: a label nobody scanned is the sender's, a stopped parcel the carrier's.
export function delayFollowUp(row) {
  const who = row?.supplier_name || row?.store || 'the sender';
  const carrier = row?.carrier || 'the carrier';
  if (neverScanned(row)) return `Label made but never scanned. Ask ${who} if it was handed over.`;
  if (words(row?.tracking_status).includes('exception') || words(row?.tracking_sub_status).startsWith('exception'))
    return `${carrier} reports a problem. Call ${carrier}, and tell ${who}.`;
  return `Stopped moving. Ask ${carrier} for a trace, and tell ${who}.`;
}

// The columns, in reading order. `week` is the rest of the next seven days after today.
export const EXPECTED_COLUMNS = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'Rest of the week' },
  { key: 'later', label: 'Later' },
  { key: 'nodate', label: 'No date yet' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'delayed', label: 'Delayed' },
  { key: 'landed', label: 'Here, not counted in' },
];

// The carrier's last word on a delayed parcel, for the Telegram alert. Most recent stall first:
// those are the ones somebody can still do something about.
const OLDEST_ALERTED_DAYS = 60;
export function delayedShipments({ boxes = [], online = [] } = {}, now = Date.now()) {
  const rows = [
    ...boxes.map((b) => ({ ...b, party: b.supplier_name, code: b.po_code, pairs: b.box_units })),
    ...online.map((o) => ({ ...o, party: o.store, code: o.order_number || `Order ${o.order_id}` })),
  ];
  return rows.flatMap((r) => {
    const days = delayedDays(r, now);
    if (days == null || days > OLDEST_ALERTED_DAYS) return [];
    return [{
      number: String(r.tracking_number).replace(/[^A-Za-z0-9]/g, '').toUpperCase(),
      tracking_number: r.tracking_number, party: String(r.party || '').trim() || 'Not named', code: r.code,
      box_number: r.box_number ?? null, carrier: r.carrier || null, pairs: Number(r.pairs) || 0,
      days, last_location: r.last_location || null, last_move_at: r.last_move_at || r.shipped_at || null,
      followUp: delayFollowUp(r),
    }];
  }).sort((a, b) => a.days - b.days);
}

const COLUMN_OF = {
  today: 'today', tomorrow: 'week', this_week: 'week', later: 'later', unknown: 'nodate', overdue: 'overdue', landed: 'landed',
};

export function expectedColumn(row, today, now = Date.now()) {
  // Ahead of the estimate: a parcel stopped for a week isn't arriving today because a carrier said so.
  if (delayedDays(row, now) != null) return 'delayed';
  return COLUMN_OF[arrivalBucket(row, today, inboundState(row, now), now)];
}

const emptyCols = () => Object.fromEntries(EXPECTED_COLUMNS.map((c) => [c.key, { count: 0, pairs: 0, unknownPairs: 0 }]));

function add(cols, col, pairs) {
  cols[col].count += 1;
  if (pairs > 0) cols[col].pairs += pairs; else cols[col].unknownPairs += 1;
}

// One side of the screen. Groups ignore case and stray spaces, so one supplier typed two ways
// isn't two rows. Busiest first: what lands soonest is what the floor plans around.
function group(rows, nameOf, today, now) {
  const groups = new Map();
  const total = emptyCols();
  for (const r of rows) {
    const name = String(nameOf(r) || '').trim() || 'Not named';
    const key = name.toLowerCase();
    if (!groups.has(key)) groups.set(key, { name, cols: emptyCols(), items: [] });
    const g = groups.get(key);
    const column = expectedColumn(r, today, now);
    const pairs = Number(r.pairs) || 0;
    add(g.cols, column, pairs);
    add(total, column, pairs);
    g.items.push({ ...r, column, delayedDays: delayedDays(r, now) });
  }
  const list = [...groups.values()].sort((a, b) => b.cols.today.count - a.cols.today.count
    || b.cols.week.count - a.cols.week.count || a.name.localeCompare(b.name));
  return { groups: list, total };
}

export function expectedDashboard({ boxes = [], online = [] } = {}, today, now = Date.now()) {
  const fromSuppliers = boxes.map((b) => ({
    ...b, pairs: b.box_units, code: b.po_code, id: `box-${b.box_id}`,
  }));
  const fromStores = online.map((o) => ({
    ...o, code: o.order_number || `Order ${o.order_id}`, id: `order-${o.order_id}`,
  }));
  return {
    suppliers: group(fromSuppliers, (b) => b.supplier_name, today, now),
    stores: group(fromStores, (o) => o.store, today, now),
  };
}
