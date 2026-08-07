// The 8-level pricing hierarchy PH lists by (api/_lib/pricing.js). Pure logic —
// no browser, no network: `resolveFromInsights` is the whole decision, and
// aliasPriceWithBasis only feeds it two already-fetched Alias responses. Guards
// the ORDER, which is the part a well-meaning edit is most likely to break.
import { test, expect } from '@playwright/test';
import { PRICE_HIERARCHY, resolveFromInsights, isPriceBasis, priceBasisLabel } from '../api/_lib/pricing.js';
import { PRICE_BASES } from '../src/lib/ph.js';

// An empty aliasPriceInsights response; fill only the field under test.
const insights = (o = {}) => ({ globalIndicator: null, lowestListing: null, lastSold: null, highestOffer: null, ...o });

test('the hierarchy is the eight levels, in the agreed order', () => {
  expect(PRICE_HIERARCHY.map((h) => h.label)).toEqual([
    'Global Indicator - Consigned',
    'Global Indicator - With You',
    'Lowest - Consigned',
    'Lowest - With You',
    'Last Sold - Consigned',
    'Last Sold - With You',
    'Highest - Consigned',
    'Highest - With You',
  ]);
  expect(PRICE_HIERARCHY.map((h) => h.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
});

test('each level wins when every level above it is empty', () => {
  for (const step of PRICE_HIERARCHY) {
    const consigned = insights();
    const withYou = insights();
    (step.consigned ? consigned : withYou)[step.field] = 100 + step.rank;
    expect(resolveFromInsights(consigned, withYou))
      .toEqual({ value: 100 + step.rank, basis: step.key, rank: step.rank });
  }
});

test('a higher level always beats a lower one', () => {
  const full = insights({ globalIndicator: 1, lowestListing: 2, lastSold: 3, highestOffer: 4 });
  expect(resolveFromInsights(full, full).rank).toBe(1);
  // The ordering that is easy to get wrong: the With You GI (2) outranks the
  // consigned Lowest (3) — basis does NOT beat field.
  expect(resolveFromInsights(insights({ lowestListing: 50 }), insights({ globalIndicator: 90 })))
    .toEqual({ value: 90, basis: 'with_you', rank: 2 });
});

test('Alias reports 0 for "no demand" — treat it as no price, not a $0 listing', () => {
  expect(resolveFromInsights(insights({ globalIndicator: 0, lowestListing: 0, lastSold: 77 }), insights()))
    .toEqual({ value: 77, basis: 'last_sold_consigned', rank: 5 });
});

test('no price anywhere (and a failed Alias call) resolves to nothing', () => {
  expect(resolveFromInsights(insights(), insights())).toEqual({ value: null, basis: null, rank: null });
  expect(resolveFromInsights(null, null)).toEqual({ value: null, basis: null, rank: null });
});

test('only real hierarchy keys can be persisted as a basis', () => {
  for (const h of PRICE_HIERARCHY) expect(isPriceBasis(h.key)).toBe(true);
  for (const junk of ['', null, undefined, 'manual', 'DROP TABLE items']) expect(isPriceBasis(junk)).toBe(false);
});

test('history lines name the fallback level but stay quiet on the normal case', () => {
  expect(priceBasisLabel('consigned')).toBe('');
  expect(priceBasisLabel('nope')).toBe('');
  expect(priceBasisLabel('last_sold_consigned')).toBe('Last Sold - Consigned');
});

test('the PH grid mirror matches the server table', () => {
  // src/lib/ph.js duplicates the display half (the client can't import api/_lib).
  // If these drift, the grid shows a chip for the wrong level.
  expect(Object.keys(PRICE_BASES)).toEqual(PRICE_HIERARCHY.map((h) => h.key));
  for (const h of PRICE_HIERARCHY) {
    expect(PRICE_BASES[h.key].rank).toBe(h.rank);
    expect(PRICE_BASES[h.key].label).toBe(h.label);
  }
  // Rank 1 is the normal case and must stay chip-less; every fallback must show one.
  expect(PRICE_BASES.consigned.short).toBeNull();
  for (const h of PRICE_HIERARCHY.slice(1)) expect(PRICE_BASES[h.key].short).toBeTruthy();
});
