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
