// /api/sku-search resolves a style code through THREE sources — Alias → StockX → Nike.
//
// Alias and KicksDB are sneaker catalogues, so any other kind of Nike product dead-ended
// at "No product found" on all nine screens this endpoint feeds at once: a Nike x Stüssy
// hoodie (FJ9175-261), a PSG match jersey (HJ4547-411) and an Off-White jersey
// (FQ0997-389) were each unresolvable while Nike's own catalogue had all three. A
// manifest carrying one had its title typed from memory with nothing to check it against.
//
// These assert the MAPPERS directly rather than driving the live upstreams: the rule
// worth pinning is which answer is allowed to become a product, and that must hold
// identically whether or not CI has an Alias/StockX key.
import { test, expect } from '@playwright/test';
import { fromStockx, fromNike } from '../api/sku-search.js';
import { compareSizes, apparelRank } from '../src/lib/codes.js';

test.describe('sku-search fallbacks', () => {
  // THE guard. stockxProductBySku falls back to the closest search result when nothing
  // matches the style id exactly and flags it `exact: false` — useful on a screen that
  // can say "near match", ruinous here. Asked for the Stüssy hoodie FJ9175-261, StockX
  // really does answer with FJ4195-201 "Nike Waffle Nav": a different product, a
  // different category. Auto-filled onto a receiving line or a PO manifest that files a
  // garment as a shoe under a name nobody typed — worse than the blank field this
  // endpoint used to return.
  test('a NON-exact StockX hit is refused, however plausible it looks', () => {
    const nearMiss = {
      exact: false, styleId: 'FJ4195-201',
      title: 'Nike Waffle Nav Mink Brown Ironstone Light Bone Vast Grey',
      colorway: 'Mink Brown/Ironstone/Light Bone/Vast Grey',
    };
    expect(fromStockx(nearMiss, 'FJ9175-261')).toBeNull();
  });

  test('an exact StockX hit becomes a product, tagged with its source', () => {
    const hit = {
      exact: true, styleId: 'HJ4547-411',
      title: 'Nike Paris Saint-Germain 2025/26 Match Home Authentic Jersey Midnight Navy/Midnight Navy/White',
      colorway: null,
    };
    const p = fromStockx(hit, 'HJ4547-411');
    expect(p.source).toBe('stockx');
    expect(p.sku).toBe('HJ4547-411');
    expect(p.name).toContain('Paris Saint-Germain');
    // No sizes and no catalogId: StockX keeps sizes on variants (a second call, on the
    // scan path) and the catalog id is Alias's. The pricing paths must keep failing
    // honestly rather than pricing against something we didn't match.
    expect(p.sizes).toEqual([]);
    expect(p.catalogId).toBeUndefined();
  });

  test('Nike answers when both catalogues have nothing', () => {
    const p = fromNike({ title: 'Nike x Stüssy', sku: 'FJ9175-261', brand: 'Nike', hero: 'https://static.nike.com/x.jpg' }, 'FJ9175-261');
    expect(p.source).toBe('nike');
    expect(p.name).toBe('Nike x Stüssy');
    expect(p.image).toBe('https://static.nike.com/x.jpg');
  });

  test('a source with no usable title is not a product', () => {
    expect(fromNike({ sku: 'FJ9175-261', hero: 'https://static.nike.com/x.jpg' }, 'FJ9175-261')).toBeNull();
    expect(fromStockx(null, 'FJ9175-261')).toBeNull();
  });

  // A garment's chips used to read 6, 6.5 … 16. `sizePool` falls back to a US shoe
  // ladder whenever the lookup returns fewer than two sizes, so receiving a jersey
  // offered a 10.5 and the only honest answer was "+ Custom". Nike's feed has the real
  // run AND says what kind of product it is, in one call we already make.
  test('Nike supplies the real size run and says it is apparel', () => {
    const p = fromNike({
      title: 'Nike x Stüssy', sku: 'FJ9175-261', brand: 'Nike', hero: 'x',
      productType: 'APPAREL', sizes: ['XS', 'S', 'M', 'L', 'XL'],
    }, 'FJ9175-261');
    expect(p.sizes).toEqual(['XS', 'S', 'M', 'L', 'XL']);
    expect(p.sizeKind).toBe('apparel');
  });

  test('a Nike FOOTWEAR hit is not mistaken for apparel', () => {
    const p = fromNike({ title: 'Sabrina 3', sku: 'IQ5085-102', hero: 'x', productType: 'FOOTWEAR', sizes: ['5', '5.5'] }, 'IQ5085-102');
    expect(p.sizeKind).toBe('shoe');
  });

  // Unknown must stay unknown: the client keeps its shoe-ladder default there, because
  // an unlisted sneaker is far more common than an unlisted garment.
  test('an absent productType is null, not a guess', () => {
    expect(fromNike({ title: 'Something', sku: 'AA1111-001', hero: 'x' }, 'AA1111-001').sizeKind).toBeNull();
  });

  // Same rule the Alias mapper has always had: the upstream searched on the FIRST code
  // and answers with that one alone, so trusting its reply would quietly halve a dual
  // code the user typed.
  test('a dual code the user typed survives both fallbacks', () => {
    const typed = '315122-111/CW2288-111';
    for (const p of [
      fromStockx({ exact: true, styleId: '315122-111', title: 'Nike Air Force 1' }, typed),
      fromNike({ title: 'Nike Air Force 1', sku: '315122-111', hero: 'x' }, typed),
    ]) {
      expect(p.sku).toBe(typed);
      expect(p.skuOptions).toEqual(['315122-111', 'CW2288-111']);
    }
  });
});

// Ordering apparel sizes: neither naive reading works, and both look like a bug on
// screen. Alphabetically it is L, M, S, XL, XS; by `sizeNum` the 2 inside "2XL" files a
// garment among the toddler shoes.
test.describe('apparel size ordering', () => {
  test('letter sizes sort by their own scale, not alphabetically', () => {
    expect(['XL', 'S', 'XXL', 'XS', 'M', 'L'].sort(compareSizes))
      .toEqual(['XS', 'S', 'M', 'L', 'XL', 'XXL']);
  });

  test('"2XL" is not the number 2', () => {
    expect(['2XL', 'M', 'XS', '3XL'].sort(compareSizes)).toEqual(['XS', 'M', '2XL', '3XL']);
    // …and it ranks with the spelling Nike uses interchangeably for it.
    expect(apparelRank('2XL')).toBe(apparelRank('XXL'));
    expect(apparelRank('3XL')).toBe(apparelRank('XXXL'));
  });

  test('shoe sizes are untouched', () => {
    expect(['10.5', '9', '11', '9.5'].sort(compareSizes)).toEqual(['9', '9.5', '10.5', '11']);
    expect(['8.5W', '7W', '10W'].sort(compareSizes)).toEqual(['7W', '8.5W', '10W']);
    expect(apparelRank('10.5')).toBeNull();
    expect(apparelRank('8.5W')).toBeNull();
  });
});
