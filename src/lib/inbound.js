// Classifying an inbound box. One set of rules, read by the Inbound screen, its
// summary counts, and the Home tile — three places that must never disagree about
// whether a shipment is in trouble.
//
// Everything here is derived from what the 17TRACK webhook already writes. Nothing
// is fetched, and no new column was added: the raw `tracking_status` retains detail
// that `mapBoxStatus` throws away (it folds Out for Delivery into In Transit for the
// box's own status, which is right for receiving and wrong for a daily feed).

// A parcel is judged by when the CARRIER last scanned it, not by when we last looked.
// Four days of silence is a question; eight is a problem. Chosen against real data:
// live orders on 3 Sep had boxes sitting nine days on "Dropped off at The UPS Store"
// and one fourteen days on "Label Created" — the second is a supplier who never
// actually handed the parcel over, which is a different conversation to a delay.
export const STALL_DAYS = 4;
export const INVESTIGATE_DAYS = 8;

export const INBOUND_STATES = {
  delivered:    { label: 'Delivered',    tone: 'ok',       blurb: 'Arrived at the warehouse.' },
  out:          { label: 'Out for delivery', tone: 'due',  blurb: 'On the truck — expected today.' },
  in_transit:   { label: 'In transit',   tone: 'info',     blurb: 'Moving normally through the carrier network.' },
  delayed:      { label: 'Delayed',      tone: 'warn',     blurb: 'The carrier reports a problem, or it has stopped progressing.' },
  investigate:  { label: 'Investigate',  tone: 'bad',      blurb: 'Nothing has moved for long enough that somebody has to chase it.' },
  with_supplier:{ label: 'With supplier', tone: 'muted',   blurb: 'A label exists but the carrier has never scanned the parcel.' },
  no_tracking:  { label: 'No tracking',  tone: 'muted',    blurb: 'We are expecting this box and have no number to follow.' },
};
// Worst first — this is the order the feed is sorted in and the order the summary
// strip reads, because the whole point is that trouble is above the fold.
export const STATE_ORDER = ['investigate', 'delayed', 'no_tracking', 'with_supplier', 'out', 'in_transit', 'delivered'];

const words = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
export const daysSince = (iso, now = Date.now()) => {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? (now - t) / 86400000 : null;
};

// The order matters: an exception outranks "in transit" even though the carrier is
// still reporting movement, and a delivered box is never chased no matter how old.
export function inboundState(box, now = Date.now()) {
  const st = words(box?.tracking_status);
  const sub = words(box?.tracking_sub_status);
  if (st.includes('delivered')) return 'delivered';
  if (!String(box?.tracking_number || '').trim()) return 'no_tracking';

  const idle = daysSince(box?.last_move_at, now);
  const stalled = idle != null && idle >= INVESTIGATE_DAYS;

  // Expired / NotFound mean the carrier has lost sight of it entirely.
  if (st.includes('expired') || st.includes('notfound') || st.includes('undelivered')) return 'investigate';
  if (st.includes('exception') || sub.startsWith('exception')) return stalled ? 'investigate' : 'delayed';

  // "InfoReceived" is a label with no parcel behind it — still the supplier's move.
  // Called out separately because chasing the courier about it wastes everyone's time.
  if (st.includes('inforeceived')) return stalled ? 'investigate' : 'with_supplier';

  if (st.includes('outfordelivery') || sub.includes('outfordelivery')) return 'out';
  if (stalled) return 'investigate';
  if (idle != null && idle >= STALL_DAYS) return 'delayed';
  if (st.includes('intransit') || st.includes('pickup')) return 'in_transit';
  return st ? 'in_transit' : 'no_tracking';
}

// Does this box need a person? The Home tile and the "needs attention" filter both
// key on this rather than on a list of states, so adding a state can't silently
// drop it out of the one place somebody would notice it.
export const needsAttention = (state) => state === 'investigate' || state === 'delayed' || state === 'no_tracking';

// Group flat box rows into shipments (one per order), each carrying its own worst
// state — an order is as healthy as its unhealthiest box, which is exactly how the
// 169-of-169 case went wrong: eight pairs in one stuck box behind seven fine ones.
export function groupShipments(rows, now = Date.now()) {
  const byPo = new Map();
  for (const r of rows || []) {
    const key = Number(r.po_id);
    if (!byPo.has(key)) {
      byPo.set(key, {
        poId: key, poCode: r.po_code, supplier: r.supplier_name, poStatus: r.po_status,
        orderKind: r.order_kind, createdAt: r.po_created_at,
        expected: Number(r.expected_units) || 0, received: Number(r.received_units) || 0,
        boxCount: Number(r.box_count) || 0, boxes: [],
      });
    }
    byPo.get(key).boxes.push({ ...r, state: inboundState(r, now), idleDays: daysSince(r.last_move_at, now) });
  }
  return [...byPo.values()].map((s) => {
    const rank = (b) => STATE_ORDER.indexOf(b.state);
    const worst = s.boxes.reduce((a, b) => (rank(b) < rank(a) ? b : a), s.boxes[0]);
    return {
      ...s,
      state: worst?.state || 'no_tracking',
      // Outstanding is only meaningful once something has been received against the
      // order: before that, "expected 169, outstanding 169" is just the order.
      outstanding: s.received > 0 ? s.expected - s.received : null,
      delivered: s.boxes.filter((b) => b.state === 'delivered').length,
      boxes: s.boxes.slice().sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state)),
    };
  }).sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state)
    || String(a.supplier || '').localeCompare(String(b.supplier || '')));
}

export function countStates(rows, now = Date.now()) {
  const out = Object.fromEntries(STATE_ORDER.map((k) => [k, 0]));
  for (const r of rows || []) out[inboundState(r, now)] += 1;
  return out;
}

// ---------------------------------------------------------------------------
// WHEN it is expected — a different question from where it is, and the one the
// warehouse actually opens the day with.
//
// The feed could say a parcel was "in transit" and never say whether that meant this
// morning or next Thursday, so "what should we expect today" could only be answered by
// opening every order and reading checkpoints. The carrier's own estimate is in the
// 17TRACK payload we already receive (`po_boxes.eta_from` / `eta_to`); this turns it
// into the handful of buckets a floor actually plans around.

// Every date here is an EST calendar day, compared as a string. `estToday()` and the
// DATE columns are both 'YYYY-MM-DD', so string comparison IS date comparison — and it
// avoids the `new Date('YYYY-MM-DD')` trap that reads a day in the viewer's zone. The PH
// team's clock is a day ahead of the EST day the warehouse works to.
export const addDays = (ymd, n) => {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
};

export const ARRIVAL_BUCKETS = {
  landed:    { label: 'Landed',      blurb: 'Already at the warehouse.' },
  overdue:   { label: 'Overdue',     blurb: 'The carrier’s own estimate has passed and it is not here.' },
  today:     { label: 'Today',       blurb: 'Expected on the floor today.' },
  tomorrow:  { label: 'Tomorrow',    blurb: 'Expected tomorrow.' },
  this_week: { label: 'Within a week', blurb: 'Expected in the next seven days.' },
  later:     { label: 'Later',       blurb: 'Expected beyond the next week.' },
  unknown:   { label: 'No date',     blurb: 'Moving, but the carrier has not given a delivery estimate.' },
};
export const ARRIVAL_ORDER = ['overdue', 'today', 'tomorrow', 'this_week', 'later', 'unknown', 'landed'];

/**
 * Which day-bucket a box falls in.
 *
 * `out for delivery` beats the estimate outright: the parcel is on a truck, so it is
 * arriving today whatever a three-day window said this morning. That is the single most
 * useful thing this screen can tell the floor, and it is the one case where the carrier's
 * movement is better evidence than the carrier's own promise.
 *
 * A box with no estimate is `unknown`, never quietly folded into "later" — the difference
 * between "not for a while" and "we have no idea" is the difference between planning the
 * day and being surprised by it.
 */
export function arrivalBucket(box, today, state = null) {
  const st = state || inboundState(box);
  if (st === 'delivered') return 'landed';
  if (st === 'out') return 'today';
  // Nothing the carrier has never scanned gets a date it does not deserve.
  if (st === 'no_tracking' || st === 'with_supplier') return 'unknown';

  const from = box?.eta_from || null;
  const to = box?.eta_to || from;
  if (!from) return 'unknown';
  // Inside the quoted window counts as today — a "Tue–Thu" parcel is genuinely due on
  // any of those days, and telling the floor "Tuesday" on Wednesday helps nobody.
  if (from <= today && today <= to) return 'today';
  if (to < today) return 'overdue';
  if (from === addDays(today, 1)) return 'tomorrow';
  return from <= addDays(today, 7) ? 'this_week' : 'later';
}

/**
 * The day's arrivals, in the terms the floor plans in: BOXES and PAIRS per bucket.
 *
 * Pairs, not just boxes, because they are what costs time — twelve boxes of two is a
 * quiet morning and two boxes of a hundred and sixty is not. `box_units` is null on a box
 * nobody declared a manifest for, and that stays visible as `unknownUnits` rather than
 * being counted as zero: "no pairs expected" and "we don't know how many" are different
 * answers, and only one of them means you can stop planning.
 */
export function arrivalPlan(rows, today, now = Date.now()) {
  const out = {};
  for (const k of ARRIVAL_ORDER) out[k] = { boxes: 0, units: 0, unknownUnits: 0, shipments: new Set() };
  for (const r of rows || []) {
    const state = inboundState(r, now);
    const b = out[arrivalBucket(r, today, state)];
    b.boxes += 1;
    const u = Number(r.box_units);
    if (Number.isFinite(u) && u > 0) b.units += u; else b.unknownUnits += 1;
    b.shipments.add(Number(r.po_id));
  }
  for (const k of ARRIVAL_ORDER) out[k].shipments = out[k].shipments.size;
  return out;
}

/** Everything still coming — the denominator of the "how much of it is here" bar. */
export function inboundProgress(rows, now = Date.now()) {
  let landed = 0; let total = 0;
  for (const r of rows || []) {
    total += 1;
    if (inboundState(r, now) === 'delivered') landed += 1;
  }
  return { landed, total, pct: total ? Math.round((landed / total) * 100) : 0 };
}
