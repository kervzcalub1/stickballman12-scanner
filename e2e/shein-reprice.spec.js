// SHEIN Reprice (PH) — the rules that silently cost money when they slip
// (docs/context/shein-reprice.md), then the page end to end with the price endpoint
// mocked, so CI never calls Alias. The export is built here as a real .xlsx; the template
// is the one the app ships (public/templates/shein-edit-price.xlsx).
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { loginAs } from './helpers/auth.js';
import { buildXlsx } from '../src/lib/xlsx.js';
import * as S from '../src/lib/sheinReprice.js';

const TEMPLATE = new Uint8Array(fs.readFileSync(new URL('../public/templates/shein-edit-price.xlsx', import.meta.url)));
const BLURB = '\nWelcome to Stickballman12\nFounded in 2007…';
// Only the columns the tool reads, in a different order from SHEIN's — found by NAME.
const HEAD = ['SPU', 'Default product description(en)', 'SKU', 'Default Product Name(en)', 'Secondary Specification Value1',
  'Original Price(shein-us_USD)', 'Special Offer(shein-us_USD)'];
const ROWS = [
  ['t1', `CD5010-100${BLURB}`, 'S-CUT', 'Nike Heritage Vulc', 'US10', '100.00', '0.00'],        // 70 → 80.5 → 81 < 100: cut
  ['t1', `CD5010-100${BLURB}`, 'S-HIGH', 'Nike Heritage Vulc', 'US9.5W', '50.00', '0.00'],      // 81 > 50: never raised
  ['t1', `CD5010-100${BLURB}`, 'S-NOSIZE', 'Nike Heritage Vulc', '', '100.00', '0.00'],         // skipped
  ['t2', `CD5010-100${BLURB}`, 'S-EUR', 'Nike Heritage Vulc', 'EUR38', '100.00', '0.00'],       // skipped
  ['t3', `Welcome to Stickballman12${BLURB}`, 'S-NAME', 'Nike Kobe 8 Protro (HM6469-301)', 'US11', '130.00', '0.00'], // style from the name: 104.35 → 120.0025 → 121
  ['t4', `CD5010-100${BLURB}`, 'S-PROMO', 'Nike Heritage Vulc', 'US12', '100.00', '90.00'],     // 81 ≤ special 90: not sent
  ['t5', `Nike Air Force 1 "Jason Voorhees" – IB4025-100${BLURB}`, 'S-KEEPSP', 'AF1', 'US8', '200.00', '50.00'], // 115, special 50 carried
];
const exportBytes = () => buildXlsx({ sheetName: 'Product Information', columns: HEAD.map((label) => ({ label })), rows: ROWS });
const MARKET = { 'CD5010-100|10': 7000, 'CD5010-100|9.5': 7000, 'HM6469-301|11': 10435, 'CD5010-100|12': 7000, 'IB4025-100|8': 10000 };

test.describe('SHEIN reprice rules', () => {
  test('markup is ALWAYS rounded up to a whole dollar, in integers', () => {
    expect(S.sheinRepriceDollars(10000, 1500)).toBe(115);    // exactly 115
    expect(S.sheinRepriceDollars(10500, 1500)).toBe(121);    // 120.75 → 121
    expect(S.sheinRepriceDollars(10435, 1500)).toBe(121);    // 120.0025 → 121, not 120
    expect(S.sheinRepriceDollars(7000, 1500)).toBe(81);      // 80.50 → 81
  });

  test('sizes: US + any letters stripped; anything else is not guessed', () => {
    expect(S.sheinSize('US10.5')).toBe('10.5');
    expect(S.sheinSize('US9.5W')).toBe('9.5');
    expect(S.sheinSize('US 7')).toBe('7');
    for (const odd of ['', 'EUR38', 'CN36', '7 Toddler', 'US7-8', 'MX-14.5-NINA']) expect(S.sheinSize(odd)).toBe('');
  });

  test('style code: start of the description, else in that line, else the product name', () => {
    expect(S.sheinStyle(`CD5010-100${BLURB}`, '').style).toBe('CD5010-100');
    expect(S.sheinStyle(`Nike Air Force 1 "Jason Voorhees" – IB4025-100${BLURB}`, '').style).toBe('IB4025-100');
    expect(S.sheinStyle(`Welcome to Stickballman12${BLURB}`, 'Nike Kobe 8 Protro (HM6469-301)').style).toBe('HM6469-301');
    expect(S.sheinStyle(`Welcome to Stickballman12${BLURB}`, 'Nike Manoa Leather SE Rugged Orange').style).toBe('');
  });

  test('only cuts, a special offer in the way blocks the row, and the filled template verifies', () => {
    const ex = S.readExportFile(exportBytes());
    expect(ex.ok).toBe(true);
    const cache = Object.fromEntries(Object.entries(MARKET).map(([k, v]) => [k, { status: 'ok', valueCents: v }]));
    const r = S.applyReprice(ex.rows, cache, 1500);
    expect(r.upload).toEqual([
      { sku: 'S-CUT', price: '81', special: '' },
      { sku: 'S-NAME', price: '121', special: '' },
      { sku: 'S-KEEPSP', price: '115', special: '50.00' },   // a live promo is carried, never blanked
    ]);
    expect(r.n).toMatchObject({ lower: 3, higher: 1, special: 1, skipped: 2 });
    const out = S.fillTemplate(TEMPLATE, r.upload);
    expect(S.verifyOutput(TEMPLATE, out, r.upload, ex.rows).ok).toBe(true);
    const sheet = S.readSheetRows(out, 'sheet1');
    expect(sheet[3]).toEqual([undefined, 'S-CUT', 'USD', '81']);
    expect(sheet[5]).toEqual([undefined, 'S-KEEPSP', 'USD', '115', '50.00']);
    // A tampered file (a price raised) fails the verify.
    const raised = S.fillTemplate(TEMPLATE, [{ sku: 'S-HIGH', price: '81', special: '' }]);
    expect(S.verifyOutput(TEMPLATE, raised, [{ sku: 'S-HIGH' }], ex.rows).ok).toBe(false);
  });
});

test.describe('SHEIN Reprice page', () => {
  test('export → prices → verified Edit+Price download', async ({ page }) => {
    await loginAs(page, 'ph_team');
    let calls = 0;
    await page.route('**/api/ebay-reprice/prices', async (route) => {
      calls++;
      const { jobs } = route.request().postDataJSON();
      await route.fulfill({ json: { ok: true, results: jobs.map((j) => {
        const k = `${j.sku}|${j.size}`;
        // The first answer for one job is an Alias failure: retried, never "no data".
        if (k === 'IB4025-100|8' && calls === 1) return { ...j, status: 'error', error: 'Alias returned 503' };
        return { ...j, status: 'ok', valueCents: MARKET[k], rank: 1, label: 'Global Indicator - Consigned' };
      }) } });
    });
    await page.goto('/ph/shein-reprice');
    await page.evaluate(() => { try { Object.keys(localStorage).filter((k) => k.startsWith('reprice:')).forEach((k) => localStorage.removeItem(k)); } catch { /* */ } });
    await page.reload();

    await expect(page.locator('.er-file').nth(1)).toContainText('built in');
    await page.locator('#sr-export').setInputFiles({ name: 'Export Products_2026-10-09 13_36_02.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(exportBytes()) });
    await expect(page.locator('.er-file').first()).toContainText('7 listings');
    await expect(page.locator('.card').first()).toContainText('2skipped');                // skipped, and why:
    await expect(page.locator('.card').first()).toContainText('1 — No size');
    await expect(page.locator('.card').first()).toContainText('1 — Size isn’t a single US size');

    await page.getByRole('button', { name: 'Fetch prices' }).click();
    await expect(page.getByRole('button', { name: '✓ All prices fetched' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByLabel('Markup percent')).toHaveValue('15');
    await page.getByRole('button', { name: 'Build upload file' }).click();
    await expect(page.locator('.er-verify.pass')).toBeVisible();

    const [dl] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: /Download upload file/ }).click(),
    ]);
    expect(dl.suggestedFilename()).toBe('SHEIN reprice (10.9.2026).xlsx');
    const sheet = S.readSheetRows(new Uint8Array(fs.readFileSync(await dl.path())), 'sheet1');
    expect(sheet.slice(3).map((r) => [r[1], r[3]])).toEqual([['S-CUT', '81'], ['S-NAME', '121'], ['S-KEEPSP', '115']]);
    expect(sheet[0]).toEqual(['Field Code', 'SKU', 'Currency', 'Original Price', 'Special Offer']);
  });
});
