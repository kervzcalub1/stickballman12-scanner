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
