// The one search box on the PO lists: every handle a person has on an order — the shoe,
// the style code, the tracking number, the PO code, and the status / reconciliation
// words the chips print. Pure function (`poMatchesSearch`), pinned fact by fact.
import { test, expect } from '@playwright/test';
import { poMatchesSearch, poSearchHits, reconcileChipOf } from '../src/lib/postatus.js';
import { segmentsFor } from '../src/lib/highlight.js';

const po = (over = {}) => ({
  id: 1, po_code: 'PO-100042', status: 'draft', supplier_name: 'Alex Supply', tag_code: '',
  box_count: 3, shipped_count: 0, delivered_count: 0, unit_count: 12, received_units: 0,
  tracking_numbers: ['1Z999AA10123456784'],
  lines: [
    { sku: 'DZ5485-612', name: "Air Jordan 1 Retro High OG 'Chicago'", qty: 6, upcs: ['194272681941', '194272681958'] },
    { sku: 'IQ5085-102', name: 'Nike Dunk Low Panda', qty: 4, upcs: ['19759605950'] },
    { sku: 'HV4091-006', name: null, qty: 2, upcs: [] },
  ],
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
  expect(poMatchesSearch(po({ lines: [] }), 'chicago')).toBe(false);
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

test('a UPC finds the order, whole or by its tail, and marks the style it belongs to', () => {
  expect(poMatchesSearch(po(), '194272681941')).toBe(true);
  expect(poMatchesSearch(po(), '1958')).toBe(true);           // the tail of the second size's UPC
  expect(poMatchesSearch(po(), '194 272 681 941')).toBe(true); // spaced, as a scanner or an email gives it
  expect(poMatchesSearch(po(), '999999999999')).toBe(false);
  const hits = poSearchHits(po(), '19759605950');
  expect(hits.lines[0]).toMatchObject({ sku: 'IQ5085-102', hit: true });
  expect(hits.lines.filter((l) => l.hit)).toHaveLength(1);
});

// The user's report: "nike dunk low" showed every order with a Nike anything, because
// each word only had to land SOMEWHERE on the order. The content words must now land on
// the same line; only a word about the order as a whole (a state, the supplier) may
// come from elsewhere.
test('the words of a shoe name must land on the SAME line', () => {
  const split = po({ lines: [
    { sku: 'CW2288-111', name: 'Nike Air Force 1 Low White', qty: 5 },
    { sku: 'DD1391-100', name: 'Adidas Dunk Low Panda', qty: 3 },
  ] });
  expect(poMatchesSearch(split, 'nike dunk low')).toBe(false);   // nike on one line, dunk on another
  expect(poMatchesSearch(split, 'nike air force')).toBe(true);
  expect(poMatchesSearch(split, 'dunk low')).toBe(true);
  expect(poMatchesSearch(split, 'low')).toBe(true);
  expect(poMatchesSearch(po(), 'nike dunk low')).toBe(true);     // one line carries all three
  expect(poMatchesSearch(po(), 'low dunk nike')).toBe(true);     // order of words is not enforced
  // A name AND its code, on the same line, is fine; across two lines it is not.
  expect(poMatchesSearch(po(), 'panda IQ5085')).toBe(true);
  expect(poMatchesSearch(po(), 'panda DZ5485')).toBe(false);
  // And the preview marks only the line that satisfied the search.
  const hits = poSearchHits(po(), 'nike dunk low');
  expect(hits.lines.map((l) => [l.sku, l.hit])).toEqual([['IQ5085-102', true], ['DZ5485-612', false], ['HV4091-006', false]]);
});

test('a state or the supplier still counts from the order as a whole', () => {
  expect(poMatchesSearch(po({ status: 'draft', shipped_count: 3 }), 'chicago shipped')).toBe(true);
  expect(poMatchesSearch(po({ status: 'draft' }), 'chicago shipped')).toBe(false);
  expect(poMatchesSearch(po({ status: 'draft', shipped_count: 3 }), 'yeezy shipped')).toBe(false);
  expect(poMatchesSearch(po(), 'alex chicago')).toBe(true);
});

// What a matched row SHOWS: the lines the search landed on first, the rest of the order
// filling in behind them, the tracking number or status word if that is what matched —
// each with the exact characters marked.
test('the preview leads with what matched inside, and marks the characters', () => {
  expect(poSearchHits(po(), '')).toBeNull();
  const byShoe = poSearchHits(po(), 'panda');
  expect(byShoe.lines.map((l) => [l.sku, l.hit])).toEqual([['IQ5085-102', true], ['DZ5485-612', false], ['HV4091-006', false]]);
  expect(byShoe.more).toBe(0);
  expect(byShoe.insideHit).toBe(true);
  // A style code, punctuation-blind, marks the characters as WRITTEN on the row.
  const bySku = poSearchHits(po(), '5485612');
  expect(bySku.lines[0]).toMatchObject({ sku: 'DZ5485-612', hit: true });
  expect(segmentsFor('DZ5485-612', bySku.words, { code: true })).toEqual([{ text: 'DZ', hit: false }, { text: '5485-612', hit: true }]);
  // A spaced tracking number marks the whole number it is.
  const byTrack = poSearchHits(po(), '1Z 999 AA1 01 2345 6784');
  expect(byTrack.tracking).toEqual(['1Z999AA10123456784']);
  expect(segmentsFor('1Z999AA10123456784', byTrack.words, { code: true })).toEqual([{ text: '1Z999AA10123456784', hit: true }]);
  // A status word: the chip's words, only the ones the search landed on.
  const byStatus = poSearchHits(po({ status: 'draft', shipped_count: 2 }), 'shipped');
  expect(byStatus.status).toEqual(['2/3 shipped']);   // not 'shipped' as well — one chip per state
  expect(byStatus.lines.every((l) => !l.hit)).toBe(true);   // the contents still preview
  // Matched on the code alone: nothing inside hit, but the biggest lines still show.
  const byCode = poSearchHits(po(), 'PO-100042');
  expect(byCode.insideHit).toBe(false);
  expect(byCode.lines).toHaveLength(3);
  // Caps at the biggest three unless more of them matched.
  const big = po({ lines: Array.from({ length: 6 }, (_, i) => ({ sku: `SKU-${i}`, name: `Shoe ${i}`, qty: 6 - i })) });
  expect(poSearchHits(big, 'nothing-here').lines).toHaveLength(3);
  expect(poSearchHits(big, 'nothing-here').more).toBe(3);
  expect(poSearchHits(big, 'shoe').lines).toHaveLength(6);
});

test('word highlighting is case-blind, marks every occurrence, and merges overlaps', () => {
  expect(segmentsFor("Air Jordan 1 'Chicago'", ['CHICAGO', 'air'])).toEqual([
    { text: 'Air', hit: true }, { text: " Jordan 1 '", hit: false }, { text: 'Chicago', hit: true }, { text: "'", hit: false },
  ]);
  expect(segmentsFor('Dunk Low Panda', ['dunk low', 'low panda'])).toEqual([{ text: 'Dunk Low Panda', hit: true }]);
  expect(segmentsFor('Dunk Low Panda', ['yeezy'])).toEqual([{ text: 'Dunk Low Panda', hit: false }]);
  expect(segmentsFor('', ['x'])).toEqual([{ text: '', hit: false }]);
});
