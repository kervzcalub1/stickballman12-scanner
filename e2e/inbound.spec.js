// The Inbound feed: the rules that decide whether a shipment is in trouble.
//
// These are pure-function tests on purpose. The classification is the whole feature —
// the screen is a rendering of it — and it is the part that will be tuned later
// (thresholds, new carrier statuses). Pinning it here means a tweak that quietly
// reclassifies half the warehouse's shipments fails in CI rather than on the floor.
import { test, expect } from '@playwright/test';
import { inboundState, groupShipments, countStates, needsAttention, STALL_DAYS, INVESTIGATE_DAYS }
  from '../src/lib/inbound.js';

const NOW = Date.parse('2026-09-03T12:00:00Z');
const daysAgo = (d) => new Date(NOW - d * 86400000).toISOString();
const box = (o) => ({ tracking_number: '1Z999', last_move_at: daysAgo(1), ...o });

test('a delivered box is never chased, however old', () => {
  expect(inboundState(box({ tracking_status: 'Delivered', last_move_at: daysAgo(90) }), NOW)).toBe('delivered');
});

test('no tracking number is its own state, not a delay', () => {
  expect(inboundState(box({ tracking_number: '', tracking_status: null }), NOW)).toBe('no_tracking');
});

test('InfoReceived reads as with-supplier — the carrier never got the parcel', () => {
  expect(inboundState(box({ tracking_status: 'InfoReceived' }), NOW)).toBe('with_supplier');
  // …until it has sat there long enough that somebody has to ask the supplier.
  expect(inboundState(box({ tracking_status: 'InfoReceived', last_move_at: daysAgo(INVESTIGATE_DAYS + 1) }), NOW))
    .toBe('investigate');
});

test('silence escalates: moving → delayed → investigate', () => {
  expect(inboundState(box({ tracking_status: 'InTransit', last_move_at: daysAgo(1) }), NOW)).toBe('in_transit');
  expect(inboundState(box({ tracking_status: 'InTransit', last_move_at: daysAgo(STALL_DAYS + 1) }), NOW)).toBe('delayed');
  expect(inboundState(box({ tracking_status: 'InTransit', last_move_at: daysAgo(INVESTIGATE_DAYS + 1) }), NOW)).toBe('investigate');
});

test('Expired means the carrier lost sight of it — investigate regardless of age', () => {
  expect(inboundState(box({ tracking_status: 'Expired', last_move_at: daysAgo(1) }), NOW)).toBe('investigate');
});

test('Out for delivery is kept, not folded into In transit', () => {
  // mapBoxStatus collapses it for the BOX's own status, which is right for receiving
  // and wrong here: "arriving today" is the whole point of a daily feed.
  expect(inboundState(box({ tracking_status: 'OutForDelivery' }), NOW)).toBe('out');
});

test('an exception is a delay, and a stale exception is an investigation', () => {
  expect(inboundState(box({ tracking_status: 'Exception', tracking_sub_status: 'Exception_Other' }), NOW)).toBe('delayed');
  expect(inboundState(box({ tracking_status: 'Exception', last_move_at: daysAgo(INVESTIGATE_DAYS + 2) }), NOW)).toBe('investigate');
});

test('a shipment is as healthy as its unhealthiest box', () => {
  // The real case this screen was built for: seven boxes land, one is stuck, and the
  // order reads "delivered" unless the worst box decides the headline.
  const rows = [
    { po_id: 1, po_code: 'PO-1', supplier_name: 'Eric', expected_units: 169, received_units: 158, box_count: 2,
      box_id: 1, box_number: 1, tracking_number: 'A', tracking_status: 'Delivered', last_move_at: daysAgo(2) },
    { po_id: 1, po_code: 'PO-1', supplier_name: 'Eric', expected_units: 169, received_units: 158, box_count: 2,
      box_id: 2, box_number: 2, tracking_number: 'B', tracking_status: 'InTransit', last_move_at: daysAgo(20) },
  ];
  const [s] = groupShipments(rows, NOW);
  expect(s.state).toBe('investigate');
  expect(s.outstanding).toBe(11);
  expect(s.delivered).toBe(1);
  // Worst box first, so opening the shipment shows the problem without scrolling.
  expect(s.boxes[0].box_number).toBe(2);
});

test('outstanding is withheld until something has actually been received', () => {
  const rows = [{ po_id: 9, expected_units: 40, received_units: 0, box_count: 1,
    box_id: 9, tracking_number: 'C', tracking_status: 'InTransit', last_move_at: daysAgo(1) }];
  // "Expected 40, outstanding 40" is the order restating itself, not a shortfall.
  expect(groupShipments(rows, NOW)[0].outstanding).toBeNull();
});

test('counts and needsAttention agree with the states', () => {
  const rows = [
    { po_id: 1, box_id: 1, tracking_number: 'A', tracking_status: 'Delivered', last_move_at: daysAgo(1) },
    { po_id: 1, box_id: 2, tracking_number: '',  tracking_status: null,        last_move_at: null },
    { po_id: 2, box_id: 3, tracking_number: 'C', tracking_status: 'InTransit', last_move_at: daysAgo(30) },
  ];
  const c = countStates(rows, NOW);
  expect(c.delivered).toBe(1);
  expect(c.no_tracking).toBe(1);
  expect(c.investigate).toBe(1);
  expect(needsAttention('investigate')).toBe(true);
  expect(needsAttention('delivered')).toBe(false);
  expect(needsAttention('in_transit')).toBe(false);
});

test('the feed is auth-gated', async ({ request }) => {
  expect((await request.get('/api/inbound')).status()).toBe(401);
});

// --- filtering -------------------------------------------------------------
// The filters run over the same rows the summary strip counts, so these pin the
// shape the screen relies on rather than the JSX: a strip that kept counting the
// whole warehouse while the list showed one supplier would be a strip that lies.
test('counts follow the filtered set, not the whole warehouse', () => {
  const rows = [
    { po_id: 1, supplier_name: 'Eric',  po_created_at: '2026-09-01T12:00:00Z',
      box_id: 1, tracking_number: 'A', tracking_status: 'InTransit', last_move_at: daysAgo(30) },
    { po_id: 2, supplier_name: 'Kathleen', po_created_at: '2026-09-02T12:00:00Z',
      box_id: 2, tracking_number: 'B', tracking_status: 'Delivered', last_move_at: daysAgo(1) },
  ];
  const eric = rows.filter((r) => r.supplier_name === 'Eric');
  expect(countStates(eric, NOW).investigate).toBe(1);
  expect(countStates(eric, NOW).delivered).toBe(0);
  expect(groupShipments(eric, NOW)).toHaveLength(1);
});

// --- tracking-number normalisation ----------------------------------------
// Registration sends the canonical form; anything that MATCHES a number has to
// canonicalise too, or a push lands nowhere. Both halves are pinned here because
// fixing one without the other is a silent failure, not a loud one.
test('a number typed the way a person reads it still registers', async () => {
  const { normalizeTrackingNumber } = await import('../api/_lib/tracking.js');
  // 17TRACK refused this outright for format.
  expect(normalizeTrackingNumber('1Z 3YY 408 13 2795 1235')).toBe('1Z3YY4081327951235');
  // UPS Mail Innovations: a 420+ZIP routing prefix in front of the real 1Z.
  expect(normalizeTrackingNumber('420175451Z3YY4080312658064')).toBe('1Z3YY4080312658064');
  // Left alone: some couriers use dashes meaningfully, and inventing a number is
  // worse than failing to register one.
  expect(normalizeTrackingNumber('9261290339735032822752')).toBe('9261290339735032822752');
  expect(normalizeTrackingNumber('D10017614315926')).toBe('D10017614315926');
  expect(normalizeTrackingNumber('  1Z3YY4080325234836 ')).toBe('1Z3YY4080325234836');
  expect(normalizeTrackingNumber('')).toBe('');
});

// --- WHEN it is due -------------------------------------------------------
// The half the feed did not answer. "In transit" covered both a parcel two streets
// away and one leaving Guangzhou on Thursday, and a floor cannot plan a morning from
// that. These pin the day buckets, because getting one wrong puts boxes on the
// warehouse's list for the wrong day — which is worse than no list at all.
import { arrivalBucket, arrivalPlan, inboundProgress, addDays } from '../src/lib/inbound.js';

const TODAY = '2026-09-03';
const due = (o) => box({ tracking_status: 'InTransit', ...o });
// NOW is pinned as well as TODAY. Passing only TODAY left `arrivalBucket` deriving the
// box's state off the real wall clock, so `last_move_at: daysAgo(1)` drifted further
// from "1 day ago" every day the suite was not run — these passed for eight days and
// then failed on their own, on a commit that touched nothing near them.
const bucket = (b, today = TODAY) => arrivalBucket(b, today, null, NOW);

test('out for delivery beats the carrier’s own estimate', () => {
  // The parcel is on a truck. Whatever a three-day window said this morning, it is
  // arriving today — the movement is better evidence than the promise.
  expect(bucket(due({ tracking_status: 'OutForDelivery', eta_from: '2026-09-20' }))).toBe('today');
});

test('a quoted WINDOW counts as today on any day inside it', () => {
  // Carriers quote "Tue–Thu" as often as a date. Telling the floor "Tuesday" on
  // Wednesday helps nobody, and collapsing the window to its first day would put a
  // parcel on the list two days early.
  expect(bucket(due({ eta_from: '2026-09-02', eta_to: '2026-09-04' }))).toBe('today');
  expect(bucket(due({ eta_from: '2026-09-03', eta_to: '2026-09-03' }))).toBe('today');
});

test('a window that has passed is overdue, not "later"', () => {
  expect(bucket(due({ eta_from: '2026-08-30', eta_to: '2026-09-01' }))).toBe('overdue');
});

test('tomorrow, this week and later are separate answers', () => {
  expect(bucket(due({ eta_from: '2026-09-04' }))).toBe('tomorrow');
  expect(bucket(due({ eta_from: '2026-09-08' }))).toBe('this_week');
  expect(bucket(due({ eta_from: '2026-09-10' }))).toBe('this_week'); // exactly +7
  expect(bucket(due({ eta_from: '2026-09-11' }))).toBe('later');
});

test('no estimate is "no date", never quietly folded into later', () => {
  // "Not for a while" and "we have no idea" are different answers, and only one of
  // them lets somebody stop planning around it.
  expect(bucket(due({}))).toBe('unknown');
  // And nothing the carrier has never scanned gets a date it has not earned.
  expect(bucket(box({ tracking_status: 'InfoReceived', eta_from: '2026-09-03' }))).toBe('unknown');
  expect(bucket(box({ tracking_number: '', eta_from: '2026-09-03' }))).toBe('unknown');
});

// The case the wall-clock leak was hiding. A label-only box that has sat long enough
// derives as `investigate` rather than `with_supplier` — still a label with no parcel
// behind it, and it was landing in "arriving today" off an estimate the carrier never
// earned. The state alone is not enough to decide this, because `investigate` also
// covers a parcel that WAS scanned and then went quiet.
test('a label-only box that has gone stale still has no arrival date', () => {
  const stale = { last_move_at: daysAgo(INVESTIGATE_DAYS + 1) };
  expect(inboundState(box({ tracking_status: 'InfoReceived', ...stale }), NOW)).toBe('investigate');
  expect(bucket(box({ tracking_status: 'InfoReceived', eta_from: '2026-09-03', ...stale }))).toBe('unknown');
  expect(bucket(box({ tracking_status: 'InfoReceived', eta_from: '2026-09-20', ...stale }))).toBe('unknown');
  // But a parcel the carrier DID scan and then lost sight of keeps its estimate, and
  // "overdue" is the honest answer for it rather than "we have no idea".
  expect(bucket(box({ tracking_status: 'InTransit', eta_from: '2026-08-28', eta_to: '2026-08-29', ...stale }))).toBe('overdue');
});

test('a delivered box has landed, whatever its estimate said', () => {
  expect(bucket(box({ tracking_status: 'Delivered', eta_from: '2026-09-30' }))).toBe('landed');
});

test('the plan counts boxes AND pairs, and says how many it cannot count', () => {
  const rows = [
    { ...due({ eta_from: TODAY }), po_id: 1, box_units: 8 },
    { ...due({ eta_from: TODAY }), po_id: 1, box_units: 5 },
    // Same day, different order — the shipment count must not double it.
    { ...due({ eta_from: TODAY }), po_id: 2, box_units: 0 },
    { ...due({ eta_from: '2026-09-04' }), po_id: 3, box_units: 40 },
  ];
  const plan = arrivalPlan(rows, TODAY, NOW);
  expect(plan.today.boxes).toBe(3);
  expect(plan.today.units).toBe(13);
  expect(plan.today.shipments).toBe(2);
  // A box with no manifest behind it is NOT zero pairs — it is an unknown, and the
  // strip says so rather than reporting a total it cannot stand behind.
  expect(plan.today.unknownUnits).toBe(1);
  expect(plan.tomorrow.units).toBe(40);
});

test('the progress bar counts landed against everything still inbound', () => {
  const rows = [
    box({ tracking_status: 'Delivered' }),
    box({ tracking_status: 'Delivered' }),
    due({}),
    due({}),
  ];
  expect(inboundProgress(rows, NOW)).toEqual({ landed: 2, total: 4, pct: 50 });
});

test('day arithmetic crosses months and years without a timezone', () => {
  // String dates, string comparison — `new Date('YYYY-MM-DD')` reads midnight in the
  // VIEWER'S zone, and the PH team's clock is a day ahead of the EST day the
  // warehouse is working to.
  expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
  expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
});
