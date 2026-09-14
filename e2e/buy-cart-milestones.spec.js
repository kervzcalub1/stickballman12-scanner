// The milestone bar on a buying request: which of the ten stops a request is AT.
//
// The status column alone cannot say — "receipted" covers everything from "the receipt
// just landed" to "every box is sealed and waiting on a label", and the back half lives
// on the purchase order and its boxes. So the stop is derived from the facts, furthest
// supported milestone first. Pure function, pinned here fact by fact.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { MILESTONES, milestoneFor } from '../src/lib/buycartMilestones.js';

const at = (cart) => milestoneFor(cart).key;
const box = (o) => ({ id: 1, status: 'pending', tracking_number: null, kind: 'shoes', ...o });
const packed = (boxes, extra = {}) => ({
  status: 'receipted', po_id: 5, po: { id: 5, status: 'draft', labels_requested_at: null, ...extra },
  pack: { poId: 5, totalQty: 3, unpacked: 0, boxes },
});

test('ten stops, in the order the process runs', () => {
  expect(MILESTONES.map((m) => m.label)).toEqual([
    'Purchase request', 'Waiting for approval', 'Waiting for gift card', 'Waiting for receipt',
    'Sorting / packing', 'Waiting for manifest', 'Waiting for labels', 'Shipping', 'Delivered', 'Audited',
  ]);
});

test('the front half follows the request status', () => {
  expect(at({ status: 'draft' })).toBe('request');
  expect(at({ status: 'submitted' })).toBe('approval');
  expect(at({ status: 'approved' })).toBe('cards');
  expect(at({ status: 'funded' })).toBe('receipt');
  // A receipt in but no order yet is still "sorting / packing" — the next thing to do is
  // start packing, and the order is raised by that.
  expect(at({ status: 'receipted', po_id: null })).toBe('packing');
  // Money audited while the boxes are still being filled does not move the dot.
  expect(at({ status: 'audited', po_id: 5, pack: { poId: 5, totalQty: 3, unpacked: 2, boxes: [box()] } })).toBe('packing');
});

test('packing, manifest, labels: read off the boxes, not the status', () => {
  const open = { status: 'receipted', po_id: 5, po: { id: 5, status: 'draft' } };
  expect(at({ ...open, pack: { poId: 5, totalQty: 3, unpacked: 1, boxes: [box()] } })).toBe('packing');
  // Every pair boxed, boxes still open → the manifest (closing a box prints it).
  expect(at(packed([box()]))).toBe('manifest');
  // Closed boxes with nothing asked yet → waiting for labels; so is an explicit ask.
  expect(at(packed([box({ status: 'packed' })]))).toBe('labels');
  expect(at(packed([box()], { labels_requested_at: '2026-09-12T00:00:00Z' }))).toBe('labels');
  // Every box carrying a tracking number → labels are answered; it is shipping now.
  expect(at(packed([box({ status: 'pre_transit', tracking_number: '1Z1' })]))).toBe('shipping');
  // One box on the road is enough to say shipping, even while another has no label.
  expect(at(packed([box({ status: 'in_transit', tracking_number: '1Z1' }), box({ id: 2 })]))).toBe('shipping');
  // A replacement box the supplier reships is not part of "did the shipment arrive".
  expect(at(packed([box({ status: 'delivered', tracking_number: '1Z1' }), box({ id: 2, kind: 'replacement' })]))).toBe('delivered');
});

test('the back half follows the order, then the audits', () => {
  expect(at(packed([box({ status: 'delivered', tracking_number: '1Z1' })]))).toBe('delivered');
  expect(at(packed([box({ status: 'shipped', tracking_number: '1Z1' })], { status: 'receiving' }))).toBe('delivered');
  expect(at(packed([box({ status: 'delivered', tracking_number: '1Z1' })], { status: 'reconciled' }))).toBe('audited');
  expect(at({ ...packed([box({ status: 'delivered', tracking_number: '1Z1' })]), goods_audited_at: '2026-09-12T00:00:00Z' })).toBe('audited');
  const done = milestoneFor({ ...packed([box({ status: 'delivered', tracking_number: '1Z1' })], { status: 'closed' }), status: 'closed' });
  expect(done.complete).toBe(true);
  expect(done.key).toBe('audited');
});

test('a request that stopped stays on the dot it stopped at, and says why', () => {
  expect(milestoneFor({ status: 'denied' })).toMatchObject({ key: 'approval', stopped: 'Denied', complete: false });
  expect(milestoneFor({ status: 'cancelled' })).toMatchObject({ key: 'request', stopped: 'Cancelled' });
  // Written off after the receipt: the dot is wherever the evidence had reached.
  expect(milestoneFor({ ...packed([box()]), status: 'written_off' })).toMatchObject({ key: 'manifest', stopped: 'Written off' });
});

test('nothing on the bar reads the clock', () => {
  const src = readFileSync('src/lib/buycartMilestones.js', 'utf8');
  expect(src).not.toMatch(/Date\.now|new Date\(|toLocale/);
});
