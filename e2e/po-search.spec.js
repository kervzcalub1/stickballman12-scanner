// The one search box on the PO lists: every handle a person has on an order — the shoe,
// the style code, the tracking number, the PO code, and the status / reconciliation
// words the chips print. Pure function (`poMatchesSearch`), pinned fact by fact.
import { test, expect } from '@playwright/test';
import { poMatchesSearch, reconcileChipOf } from '../src/lib/postatus.js';

const po = (over = {}) => ({
  id: 1, po_code: 'PO-100042', status: 'draft', supplier_name: 'Alex Supply', tag_code: '',
  box_count: 3, shipped_count: 0, delivered_count: 0, unit_count: 12, received_units: 0,
  tracking_numbers: ['1Z999AA10123456784'],
  skus: ['DZ5485-612', 'IQ5085-102'],
  shoe_names: ["Air Jordan 1 Retro High OG 'Chicago'", 'Nike Dunk Low Panda'],
  ...over,
});

test('a blank query matches everything; the old code matches still hold', () => {
  expect(poMatchesSearch(po(), '')).toBe(true);
  expect(poMatchesSearch(po(), '  ')).toBe(true);
  expect(poMatchesSearch(po(), 'po-100042')).toBe(true);
  expect(poMatchesSearch(po(), '6784')).toBe(true);
  // A number pasted out of an email, with its spaces, is still ONE number.
  expect(poMatchesSearch(po(), '1Z 999 AA1 01 2345 6784')).toBe(true);
  expect(poMatchesSearch(po(), '1Z 999 BB1')).toBe(false);
});

test('the shoe: by name (any case, part of it) and by style code (punctuation-blind)', () => {
  expect(poMatchesSearch(po(), 'chicago')).toBe(true);
  expect(poMatchesSearch(po(), 'PANDA')).toBe(true);
  expect(poMatchesSearch(po(), 'dz5485-612')).toBe(true);
  expect(poMatchesSearch(po(), 'DZ5485612')).toBe(true);
  expect(poMatchesSearch(po(), '5085')).toBe(true);
  expect(poMatchesSearch(po(), 'yeezy')).toBe(false);
  // An order with no manifest lines yet has nothing to match a shoe against.
  expect(poMatchesSearch(po({ skus: [], shoe_names: [] }), 'chicago')).toBe(false);
});

test('where it is: the words the status chip prints, and the raw status', () => {
  expect(poMatchesSearch(po({ status: 'draft' }), 'filling')).toBe(true);
  expect(poMatchesSearch(po({ status: 'draft' }), 'draft')).toBe(true);
  expect(poMatchesSearch(po({ status: 'draft', labels_requested_at: '2026-09-18T00:00:00Z' }), 'labels requested')).toBe(true);
  expect(poMatchesSearch(po({ status: 'draft', shipped_count: 2 }), 'shipped')).toBe(true);   // "2/3 shipped"
  expect(poMatchesSearch(po({ status: 'draft' }), 'shipped')).toBe(false);
  expect(poMatchesSearch(po({ status: 'receiving' }), 'receiving')).toBe(true);
  expect(poMatchesSearch(po({ status: 'reconciled' }), 'reconciled')).toBe(true);
  expect(poMatchesSearch(po({ status: 'draft', delivered_count: 3, shipped_count: 3 }), 'delivered')).toBe(true);
  expect(poMatchesSearch(po({ order_kind: 'boxes' }), 'empty boxes')).toBe(true);
});

test('reconciliation: from the counts on the PO list, and from rc on the reconciliation list', () => {
  // The PO list has no rc block; it knows these two from its own numbers.
  expect(poMatchesSearch(po({ status: 'receiving' }), 'to reconcile')).toBe(true);
  expect(poMatchesSearch(po({ status: 'draft' }), 'to reconcile')).toBe(false);
  expect(poMatchesSearch(po({ status: 'receiving', unit_count: 0, received_units: 9 }), 'received blind')).toBe(true);
  expect(poMatchesSearch(po({ status: 'receiving', unit_count: 12, received_units: 9 }), 'blind')).toBe(false);
  // The reconciliation list carries rc, so the chip's own words are searchable.
  const rc = { intake_done: true, shortage: 2, expected_units: 12, received_units: 10 };
  expect(reconcileChipOf('receiving', rc).label).toBe('2 discrepancies');
  expect(poMatchesSearch(po({ status: 'receiving', rc }), 'discrepanc')).toBe(true);
  expect(poMatchesSearch(po({ status: 'receiving', rc }), '2 discrepancies')).toBe(true);
  expect(poMatchesSearch(po({ status: 'receiving', rc: { intake_done: true, awaiting_boxes: true } }), 'boxes still out')).toBe(true);
  expect(poMatchesSearch(po({ status: 'receiving', rc: { intake_done: true } }), 'ready to close')).toBe(true);
  expect(poMatchesSearch(po({ status: 'receiving', resolution_state: 'open' }), 'resolution open')).toBe(true);
  expect(poMatchesSearch(po({ status: 'closed' }), 'archived')).toBe(true);
});

test('every word must land somewhere — a shoe AND a state narrows, not widens', () => {
  expect(poMatchesSearch(po({ status: 'draft', shipped_count: 3 }), 'chicago shipped')).toBe(true);
  expect(poMatchesSearch(po({ status: 'draft' }), 'chicago shipped')).toBe(false);
  expect(poMatchesSearch(po({ status: 'draft', shipped_count: 3 }), 'yeezy shipped')).toBe(false);
  expect(poMatchesSearch(po(), 'alex chicago')).toBe(true);
});
