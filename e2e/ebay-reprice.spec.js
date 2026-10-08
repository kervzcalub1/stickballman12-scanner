// eBay Reprice (PH) — the rules that silently cost money when they slip
// (docs/context/ebay-reprice.md), then the page end to end with the price endpoint
// mocked, so CI never calls Alias.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers/auth.js';
import * as R from '../src/lib/ebayReprice.js';

const BOM = '﻿';
const HEAD = 'Action,Category name,Item number,Title,Listing site,Currency,Start price,Buy It Now price,Available quantity,Relationship,Relationship details,Custom label (SKU)';
// A parent + 3 sizes (one quoted "85.0" price), a listing found only by its title, and
// one nobody can place.
const REVISE = BOM + [
  '#INFO,Version=1.0.0,Template= eBay-active-revise-price-quantity-download_US,,,,,,,,,',
  HEAD,
  'Revise,"Athletic Shoes (15709)","327090839752",adidas Retropy E5 (GW0561),US,USD,,,,,Size=9;10;11,',
  ',,,,,,"85.0",,"1","Variation",Size=9,SKU-A9',
  ',,,,,,150,,2,Variation,Size=10,SKU-A10',
  ',,,,,,100,,1,Variation,Size=11,SKU-A11',
  'Revise,"Athletic Shoes (15709)","327090839753",Nike Dunk Low (Women\'s) - DD1503-101,US,USD,,,,,Size=7W,',
  ',,,,,,120,,1,Variation,Size=7W,SKU-NOTINREPORT',
  'Revise,"Athletic Shoes (15709)","327090839754",Mystery Shoe (GS),US,USD,,,,,Size=5Y,',
  ',,,,,,90,,1,Variation,Size=5Y,SKU-UNKNOWN',
].join('\n') + '\n';
// Column order deliberately NOT Style ID first — they must be found by name.
const INVENTORY = 'Product Name,Size,Style ID,SKU\n"Retropy, E5",9,GW0561,SKU-A9\n"Retropy, E5",10,GW0561,SKU-A10\n"Retropy, E5",10,GW0561,SKU-A10\nDunk,7W,DD1503-101,OTHER\n';

test.describe('eBay reprice rules', () => {
  test('markup: exact half-up whole dollars, labelled, range-checked', () => {
    expect(R.repriceDollars(8600, 1200)).toBe(96);     // 96.32
    expect(R.repriceDollars(14400, 1200)).toBe(161);   // 161.28
    expect(R.repriceDollars(12500, 1200)).toBe(140);   // 140.00
    expect(R.repriceDollars(4375, 2000)).toBe(53);     // 52.50 rounds UP, not to even
    expect(R.multiplierLabel(1200)).toBe('1.12');
    expect(R.multiplierLabel(1250)).toBe('1.125');
    expect(R.parseMarkup('12')).toBe(1200);
    expect(R.parseMarkup('12.5')).toBe(1250);
    expect(R.parseMarkup('101')).toBeNull();
    expect(R.parseMarkup('-3')).toBeNull();
    expect(R.parseMarkup('abc')).toBeNull();
  });

  test('a parent row is a table of contents, not a size', () => {
    expect(R.sizesOf('Size=6;6.5;7')).toEqual(['6', '6.5', '7']);
    expect(R.sizesOf('Size=9')).toEqual(['9']);
  });

  test('the title fallback rejects (Women\'s)/(GS) and prefers a code the report knows', () => {
    expect(R.styleFromTitle("Nike Dunk Low (Women's) - DD1503-101")).toBe('DD1503-101');
    expect(R.styleFromTitle('Mystery Shoe (GS)')).toBe('');
    expect(R.styleFromTitle('Nike P-6000 (HF4308-072)')).toBe('HF4308-072');
    expect(R.styleFromTitle('X (AB1234) (CD5678)', new Set(['AB1234']))).toBe('AB1234');
  });

  test('inventory columns are found by NAME; a missing one is a hard stop', () => {
    expect(R.readInventoryFile(INVENTORY).sku2style.get('SKU-A9')).toBe('GW0561');
    const bad = R.readInventoryFile('Product Name,Size,Code,Thing\nx,9,y,z\n');
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('Product Name');
  });

  test('end to end: only cuts, keeps formatting, drops quantity, verifies', () => {
    const rv = R.readReviseFile(REVISE);
    const inv = R.readInventoryFile(INVENTORY);
    expect(rv.ok && inv.ok).toBe(true);
    const { groups, stats } = R.resolveStyles(rv, inv);
    expect(stats).toMatchObject({ direct: 2, fromTitle: 1, blank: 1 });
    const blank = groups.find((g) => g.issue === 'blank');
    expect(blank.title).toBe('Mystery Shoe (GS)');
    expect(R.effectiveStyles(groups, {}).pending).toHaveLength(1);
    const { styleAt, pending } = R.effectiveStyles(groups, { [blank.id]: { skip: true } });
    expect(pending).toHaveLength(0);
    // SKU-A11 isn't in the report: it takes its siblings' GW0561.
    expect(R.jobsFor(rv, styleAt).map((j) => R.cacheKey(j.sku, j.size)).sort())
      .toEqual(['DD1503-101|7W', 'GW0561|10', 'GW0561|11', 'GW0561|9']);
    const cache = {
      'GW0561|9': { status: 'ok', valueCents: 7000 },   // 78.40 → 78 < 85.0 → cut, written "78.0" in quotes
      'GW0561|10': { status: 'ok', valueCents: 14400 }, // 161 > 150 → kept (market higher)
      'GW0561|11': { status: 'null_price' },            // no data
      'DD1503-101|7W': { status: 'ok', valueCents: 8600 }, // 96 < 120 → cut
    };
    const out = R.applyReprice(rv, styleAt, cache, 1200);
    expect(out.n).toMatchObject({ lower: 2, higher: 1, equal: 0, nodata: 1, reductionCents: 700 + 2400 });
    const lines = out.text.slice(1).split('\n');   // after the BOM
    expect(out.text.startsWith(BOM)).toBe(true);
    expect(lines[0]).toBe('#INFO,Version=1.0.0,Template= eBay-active-revise-price-quantity-download_US,,,,,,,,');
    expect(lines[1]).toBe(HEAD.replace(',Available quantity', ''));
    expect(lines[3]).toBe(',,,,,,"78.0",,"Variation",Size=9,SKU-A9');
    expect(lines[4]).toBe(',,,,,,150,,Variation,Size=10,SKU-A10');
    expect(R.verifyOutput(REVISE, out.text).ok).toBe(true);
    // A shifted column must FAIL verification.
    const broken = out.text.replace(',,,,,,150,,Variation', ',,,,,150,,,Variation');
    const v = R.verifyOutput(REVISE, broken);
    expect(v.ok).toBe(false);
    expect(v.checks.find((c) => c.label.startsWith('Every difference')).ok).toBe(false);
    // Dry run: report only.
    expect(R.applyReprice(rv, styleAt, cache, 1200, { dryRun: true }).text).toBeNull();
    expect(R.reportText(out.report, 1200).split('\r\n')[0]).toBe(`${BOM}SKU,StyleID,Size,Old start price,Market price,Reprice (x1.12),Action,Note`);
  });

  test('a multi-code style is priced by its CHEAPEST code', () => {
    const text = BOM + ['#INFO,,,,,,,,,,,', HEAD, 'Revise,c,1,T,US,USD,,,,,Size=9,', ',,,,,,200,,1,Variation,Size=9,S1'].join('\n') + '\n';
    const rv = R.readReviseFile(text);
    const styleAt = new Map([[3, 'G57540 / 100252505']]);
    expect(R.jobsFor(rv, styleAt)).toHaveLength(2);
    const out = R.applyReprice(rv, styleAt, { 'G57540|9': { status: 'ok', valueCents: 15000 }, '100252505|9': { status: 'ok', valueCents: 12000 } }, 1200);
    expect(out.report[0]).toMatchObject({ reprice: '134', note: '100252505' });
  });
});

test.describe('eBay Reprice page', () => {
  test('two uploads → style IDs → prices → verified download', async ({ page }) => {
    await loginAs(page, 'ph_team');
    let calls = 0;
    await page.route('**/api/ebay-reprice/prices', async (route) => {
      calls++;
      const { jobs } = route.request().postDataJSON();
      const price = { 'GW0561|9': 7000, 'GW0561|10': 14400, 'DD1503-101|7W': 8600 };
      // The first answer for size 11 is an Alias failure: it must be retried, never
      // recorded as "no data".
      await route.fulfill({ json: { ok: true, results: jobs.map((j) => {
        const k = `${j.sku}|${j.size}`;
        if (k === 'GW0561|11') return calls === 1 ? { ...j, status: 'error', error: 'Alias returned 503' } : { ...j, status: 'null_price' };
        return { ...j, status: 'ok', valueCents: price[k], rank: 1, label: 'Global Indicator - Consigned' };
      }) } });
    });
    await page.goto('/ph/ebay-reprice');
    await page.evaluate(() => { try { Object.keys(localStorage).filter((k) => k.startsWith('reprice:')).forEach((k) => localStorage.removeItem(k)); } catch { /* */ } });
    await page.reload();

    await page.locator('#er-revise').setInputFiles({ name: 'eBay-edit-price-quantity-template-2026-09-01-1.csv', mimeType: 'text/csv', buffer: Buffer.from(REVISE) });
    await expect(page.getByText('✓ 8 rows · 5 size rows')).toBeVisible();
    // The wrong file in the wrong field is refused on drop.
    await page.locator('#er-inv').setInputFiles({ name: 'x.csv', mimeType: 'text/csv', buffer: Buffer.from(REVISE) });
    await expect(page.getByText('Couldn’t find the “Style ID” and “SKU” columns')).toBeVisible();
    await page.locator('#er-inv').setInputFiles({ name: 'StoreInventoryReport.csv', mimeType: 'text/csv', buffer: Buffer.from(INVENTORY) });

    // The blank listing blocks pricing until someone decides.
    await expect(page.getByText('1 listing needs your call')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Fetch prices' })).toHaveCount(0);
    // …and step 3 says so, instead of just not being there.
    await expect(page.locator('.er-waiting')).toContainText('Waiting on 1 listing in step 2');
    await page.getByRole('button', { name: 'Skip all 1 remaining', exact: true }).click();
    await expect(page.getByRole('checkbox', { name: 'Skip Mystery Shoe (GS)' })).toBeChecked();
    await expect(page.locator('.er-waiting')).toHaveCount(0);

    await page.getByRole('button', { name: 'Fetch prices' }).click();
    await expect(page.getByText('4 of 4 priced')).toBeVisible({ timeout: 20_000 });
    expect(calls).toBeGreaterThan(1);   // the 503 was retried

    await expect(page.getByLabel('Markup percent')).toHaveValue('12');
    await page.getByRole('button', { name: 'Build upload file' }).click();
    await expect(page.getByText('✓ Verified — only Start price changed')).toBeVisible();
    await expect(page.locator('.er-result')).toContainText('12% markup (× 1.12)');
    await expect(page.locator('.er-result .er-stat').first()).toContainText('2');
    const [dl] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: /Download upload file/ }).click(),
    ]);
    expect(dl.suggestedFilename()).toBe('eBay reprice (9.1.2026).csv');

    // Dry run: report only.
    await page.getByLabel('Dry run — audit report only, no upload file').check();
    await page.getByRole('button', { name: 'Run dry run' }).click();
    await expect(page.getByRole('button', { name: /Download upload file/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Download audit report' })).toBeVisible();
  });

  test('the endpoint needs a signed-in PH account', async ({ request }) => {
    const r = await request.post('/api/ebay-reprice/prices', { data: { jobs: [{ sku: 'X', size: '9' }] } });
    expect(r.status()).toBe(401);
  });
});
