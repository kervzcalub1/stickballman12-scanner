// POIZON Reprice (the Prices section of the POIZON page) — the rules that silently cost
// money when they slip (docs/context/poizon-reprice.md), then the page end to end with the
// price endpoint mocked, so CI never calls Alias. The template is POIZON's own, as shipped
// with the app; the export is built here with made-up listings in POIZON's column names.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { loginAs } from './helpers/auth.js';
import { readInventoryFile } from '../src/lib/ebayReprice.js';
import { readSheetRows } from '../src/lib/sheinReprice.js';
import { buildXlsx } from '../src/lib/xlsx.js';
import * as P from '../src/lib/poizonReprice.js';

const TEMPLATE = new Uint8Array(fs.readFileSync(new URL('../public/templates/poizon-price-inventory.xlsx', import.meta.url)));
const HEAD = ['Seller SPU ID', 'Seller SKU ID', 'Status', 'Reason for Unready to List', 'Article Number/Style ID', 'Size', 'Currency',
  'Expected Price (Tax-Exclusive)', 'Item Name', 'Barcode', 'Price Update Method'];
const LIMIT = 'Listing price exceeds the limit. Set it to $100.00 or below. For questions, please\ncontact customer service. [Error code: DWFSJ01]';
const BLURB = 'Welcome to stickballman12 — trusted sneaker seller focused on fast shipping.';
// SKU ID            what it is                                              market → ours   result
// 49714395807934    Listed 6W $122, style from the report (barcode)         70 → 81         cut to 81
// 49714395807935    Listed 10 $75                                           70 → 81         81 ≥ 75: never raised
// 49714395807936    Sold Out 5.5Y $200, not in the report, "im6366-605 24"  104.35 → 121    cut to 121
// 49714395807937    Unable to List 9 $300, POIZON's limit $100, Manual      90 → 104        cut to 104 (still over the limit)
// 49714395807938    Unmatched                                                               skipped
// 49714395807939    Listed 2XL (clothing)                                                   skipped
// 49714395807940    Listed 11 $150, style column is the blurb → item name   100 → 115       cut to 115
// 49714395807941    Listed 9 $90, no style anywhere                                         skipped
// 49714395807942    Listed 12 $81                                           70 → 81         equal: kept
const LISTINGS = [
  ['9001', '49714395807934', 'Listed', '', '408719-02', '6W', 'USD', '122.00', 'Puma Speedcat', '10128150', 'Update via API'],
  ['9001', '49714395807935', 'Listed', '', 'AA1111-100', '10', 'USD', '75.00', 'Nike Heritage Vulc', '10128151', 'Update via API'],
  ['9002', '49714395807936', 'Sold Out', 'No inventory available', 'im6366-605 24', '5.5Y', 'USD', '200.00', 'Nike Kobe GS', '10128152', 'Update via API'],
  ['9003', '49714395807937', 'Unable to List', LIMIT, 'BB2222-200', '9', 'USD', '300.00', 'Nike Vomero', '10128153', 'Update Manually'],
  ['9004', '49714395807938', 'Unmatched', 'SKU not published on POIZON', 'AA1111-100', '10', 'USD', '150.00', 'Nike Heritage Vulc', '10128154', 'Update via API'],
  ['9005', '49714395807939', 'Listed', '', 'IR6453-010', '2XL', 'USD', '60.00', 'Nike Tee', '10128155', 'Update via API'],
  ['9006', '49714395807940', 'Listed', '', BLURB, '11', 'USD', '150.00', 'Nike Thing Blue (CC3333-300)', '10128156', 'Update via API'],
  ['9007', '49714395807941', 'Listed', '', 'Nike Manoa Leather', '9', 'USD', '90.00', 'Nike Manoa Leather SE', '10128157', 'Update via API'],
  ['9001', '49714395807942', 'Listed', '', 'AA1111-100', '12', 'USD', '81.00', 'Nike Heritage Vulc', '10128158', 'Update via API'],
];
const EXPORT = buildXlsx({ sheetName: 'ExportCommodity|10', columns: HEAD.map((label) => ({ label })), rows: LISTINGS });
// The report's SKU is POIZON's Barcode. The first listing's own style column says 408719-02; the report wins.
const INVENTORY = 'Product Name,Size,Style ID,SKU\nNike Heritage Vulc,6W,AA1111-100,10128150\nNike Heritage Vulc,10,AA1111-100,10128151\nNike Vomero,9,BB2222-200,10128153\nNike Heritage Vulc,12,AA1111-100,10128158\n';
const MARKET = { 'AA1111-100|6': 7000, 'AA1111-100|10': 7000, 'AA1111-100|12': 7000, 'IM6366-605|5.5': 10435, 'BB2222-200|9': 9000, 'CC3333-300|11': 10000 };
const cache = Object.fromEntries(Object.entries(MARKET).map(([k, v]) => [k, { status: 'ok', valueCents: v }]));
const load = () => {
  const file = P.readExportFile(EXPORT);
  return { file, ...P.resolveStyles(file.rows, readInventoryFile(INVENTORY)) };
};
const CUTS = [['9001', '49714395807934', '81'], ['9002', '49714395807936', '121'], ['9003', '49714395807937', '104'], ['9006', '49714395807940', '115']];

test.describe('POIZON reprice rules', () => {
  test('market + markup is rounded UP to a whole dollar, in integers', () => {
    expect(P.poizonRepriceDollars(10000, 1500)).toBe(115);
    expect(P.poizonRepriceDollars(10435, 1500)).toBe(121);   // 120.0025 → 121
    expect(P.poizonRepriceDollars(7000, 1500)).toBe(81);     // 80.50 → 81
    expect(P.poizonRepriceDollars(7000, 0)).toBe(70);
  });

  test('sizes, style codes and POIZON’s price limit are read, never guessed', () => {
    for (const [v, want] of [['10', '10'], ['6W', '6'], ['6.5W', '6.5'], ['5.5Y', '5.5'], ['10C', '10'], ['5c', '5'], ['14.5W', '14.5']]) expect(P.poizonSize(v), v).toBe(want);
    for (const odd of ['', 'S', 'XL', '2XL', 'EU 42', '7-8', '10.3']) expect(P.poizonSize(odd), odd).toBe('');
    for (const [v, want] of [['HM6803-019', 'HM6803-019'], ['im6366-605', 'IM6366-605'], ['AR3565-101 24', 'AR3565-101'], ['IX1852-100-', 'IX1852-100'], ['JL8537', 'JL8537']]) expect(P.articleCode(v), v).toBe(want);
    for (const odd of ['', BLURB, 'Nike Dunk Low Velvet Teal (Women’s)', 'fv2291--001', '09390 1002500YYB BLAC', 'DV3606-105 26Welcome to Stickballman12']) expect(P.articleCode(odd), odd).toBe('');
    expect(P.limitCents(LIMIT)).toBe(10000);
    expect(P.limitCents('The price is too high. Please adjust your price.')).toBeNull();
  });

  test('the export: columns by name; Style ID from the report (by Barcode), then POIZON’s column, then the item name', () => {
    const { file, rows, n } = load();
    expect(file.ok).toBe(true);
    expect(file.stats).toEqual({ rows: 9, listed: 6, unable: 1, soldOut: 1, notOn: 1 });
    expect(rows.map((x) => [x.sku.slice(-2), x.style, x.styleFrom, x.size])).toEqual([
      ['34', 'AA1111-100', 'inventory report', '6'], ['35', 'AA1111-100', 'inventory report', '10'], ['36', 'IM6366-605', 'POIZON export', '5.5'],
      ['37', 'BB2222-200', 'inventory report', '9'], ['38', 'AA1111-100', 'POIZON export', '10'], ['39', 'IR6453-010', 'POIZON export', ''],
      ['40', 'CC3333-300', 'item name', '11'], ['41', '', '', '9'], ['42', 'AA1111-100', 'inventory report', '12'],
    ]);
    expect(n).toEqual({ report: 4, article: 3, name: 1, none: 1 });
    expect(P.jobsFor(rows)).toHaveLength(6);
    expect(P.jobsFor(rows, { soldOut: false })).toHaveLength(5);
    expect(P.readExportFile(TEMPLATE).ok).toBe(false);                 // the template is not an export
    expect(P.readExportFile(new TextEncoder().encode('a,b')).error).toMatch(/Not an Excel file/);
  });

  test('only cuts go in the file, never a raise — and POIZON’s own template verifies', () => {
    const { rows } = load();
    const r = P.applyReprice(rows, cache, 1500);
    expect(r.upload.map((u) => [u.spu, u.sku, u.price])).toEqual(CUTS);
    expect(r.n).toMatchObject({ lower: 4, higher: 1, equal: 1, nodata: 0, skipped: 3, overLimit: 1, toManual: 3, reductionCents: (41 + 79 + 196 + 35) * 100 });
    const note = (sku) => r.report.find((x) => x.sku.endsWith(sku));
    expect(note('35')).toMatchObject({ action: 'kept', note: 'Market + markup is higher — never raised' });
    expect(note('37').note).toBe('Still above POIZON’s limit of $100.00 — it may stay unlisted');
    expect(note('38')).toMatchObject({ action: 'skipped', note: 'Not on POIZON yet (Unmatched)' });
    expect(note('39').note).toBe('Size "2XL" is not a shoe size');
    expect(note('42')).toMatchObject({ action: 'kept', note: 'Already at market + markup' });
    expect(P.applyReprice(rows, cache, 1500, { soldOut: false }).upload).toHaveLength(3);
    expect(P.applyReprice(rows, {}, 1500).n).toMatchObject({ lower: 0, nodata: 6 });

    expect(P.readTemplateFile(TEMPLATE)).toMatchObject({ ok: true, extra: 0 });
    expect(P.readTemplateFile(EXPORT).ok).toBe(false);
    const bytes = P.fillTemplate(TEMPLATE, r.upload);
    const v = P.verifyOutput(TEMPLATE, bytes, r.upload, rows);
    expect(v.checks.filter((c) => !c.ok)).toEqual([]);
    const sheet = readSheetRows(bytes, 'Template');
    expect(sheet[1].slice(0, 9)).toEqual(['SPU ID', 'SKU ID', 'Expected Price (Tax-Exclusive)', 'Expected Price (Tax-Inclusive)', 'Retail Price (Tax-Exclusive)',
      'Retail Price (Tax-Inclusive)', 'Discount', 'Inventory', 'Price Update Method']);
    // A, B, C, G and I: the other prices and Inventory stay empty; Discount is always 0 (POIZON refuses a blank).
    expect(sheet.slice(2).map((row) => Array.from({ length: 9 }, (_, i) => row[i] || ''))).toEqual(CUTS.map(([spu, sku, price]) => [spu, sku, price, '', '', '', '0', '', 'Update Manually']));
    expect(readSheetRows(bytes, 'Data Definition')).toEqual(readSheetRows(TEMPLATE, 'Data Definition'));
    // Filling a filled file replaces its rows.
    const again = P.fillTemplate(bytes, r.upload.slice(0, 1));
    expect(readSheetRows(again, 'Template').slice(2)).toHaveLength(1);
    expect(readSheetRows(again, 'Template')[2][6]).toBe('0');
    expect(P.verifyOutput(TEMPLATE, again, r.upload.slice(0, 1), rows).ok).toBe(true);
    // The gate catches a raise, a wrong SPU and a row that is not ours.
    const bad = (upload) => P.verifyOutput(TEMPLATE, P.fillTemplate(TEMPLATE, upload), upload, rows).ok;
    expect(bad([{ spu: '9001', sku: '49714395807935', price: '81' }])).toBe(false);   // 81 > today's 75
    expect(bad([{ spu: '9999', sku: '49714395807934', price: '81' }])).toBe(false);
    expect(bad([{ spu: '9001', sku: '123', price: '81' }])).toBe(false);
    expect(P.verifyOutput(TEMPLATE, bytes, r.upload.slice(1), rows).ok).toBe(false);
  });

  test('names and the audit report', () => {
    expect(P.outputName('Export Smart Listing20261118.xlsx', '2026-11-21')).toBe('POIZON reprice (11.18.2026).xlsx');
    expect(P.outputName('listings.xlsx', '2026-11-21')).toBe('POIZON reprice (11.21.2026).xlsx');
    const { rows } = load();
    const lines = P.reportText(P.applyReprice(rows, cache, 1500).report, '15').split('\r\n');
    expect(lines).toHaveLength(11);   // header + 9 listings + the trailing newline
    expect(lines[1]).toContain('"=""49714395807934""",10128150,AA1111-100,inventory report,6W,6,Listed,Update via API,122.00,70.00,81,lowered');
  });
});

test.describe('POIZON → Prices (the page)', () => {
  test('files → prices → build → verified download of POIZON’s template', async ({ page }) => {
    await page.route('**/api/ebay-reprice/prices', async (route) => {
      const { jobs } = route.request().postDataJSON();
      await route.fulfill({ json: { ok: true, results: jobs.map((j) => ({ ...j, status: 'ok', valueCents: MARKET[`${j.sku}|${j.size}`], rank: 1, label: 'Global Indicator - Consigned' })) } });
    });
    await page.route('**/api/poizon/orders**', (r) => r.fulfill({ json: { ok: true, orders: [], sync: null, configured: true } }));
    await loginAs(page, 'ph_team');
    await page.goto('/ph/poizon');
    await page.evaluate(() => { try { Object.keys(localStorage).filter((k) => k.startsWith('reprice:')).forEach((k) => localStorage.removeItem(k)); } catch { /* */ } });
    await page.getByRole('tab', { name: 'Prices' }).click();
    await expect(page).toHaveURL(/section=reprice/);

    const xlsx = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    await page.locator('#pz-export').setInputFiles({ name: 'x.xlsx', mimeType: xlsx, buffer: Buffer.from(INVENTORY) });
    await expect(page.getByText('Not an Excel file')).toBeVisible();
    await page.locator('#pz-export').setInputFiles({ name: 'Export Smart Listing20261118.xlsx', mimeType: xlsx, buffer: Buffer.from(EXPORT) });
    await expect(page.locator('.er-file').first()).toContainText('9 listings · 6 listed · 1 unable to list · 1 sold out');
    await page.locator('#pz-inv').setInputFiles({ name: 'StoreInventoryReport.csv', mimeType: 'text/csv', buffer: Buffer.from(INVENTORY) });
    const card = page.locator('[data-poizon-reprice]');
    await expect(card).toContainText('6listings to price');
    await expect(card).toContainText('1 — Not on POIZON yet');
    await expect(card).toContainText('1 — Size isn’t a shoe size');

    await page.getByRole('button', { name: 'Fetch prices' }).click();
    await expect(page.getByRole('button', { name: '✓ All prices fetched' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByLabel('Markup percent')).toHaveValue('15');
    await page.getByRole('button', { name: 'Build upload file' }).click();
    await expect(page.locator('.er-verify.pass')).toBeVisible();
    await expect(page.locator('.er-result')).toContainText('4lowered');
    await expect(page.locator('.er-result')).toContainText('1 of the cuts is still above the price limit');

    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /^Download upload file/ }).click()]);
    expect(dl.suggestedFilename()).toBe('POIZON reprice (11.18.2026).xlsx');
    const sheet = readSheetRows(new Uint8Array(fs.readFileSync(await dl.path())), 'Template');
    expect(sheet.slice(2).map((r) => [r[0], r[1], r[2], r[8]])).toEqual(CUTS.map((c) => [...c, 'Update Manually']));

    // The markup is the user's: at 0 % the $75 pair (market 70) is cut too.
    await page.getByLabel('Markup percent').fill('0');
    await page.getByRole('button', { name: 'Build upload file' }).click();
    await expect(page.locator('.er-result')).toContainText('6lowered');

    // A refresh stays on Prices; the Orders section is one tap away.
    await page.reload();
    await expect(page.locator('[data-poizon-reprice]')).toBeVisible();
    await page.getByRole('tab', { name: 'Orders' }).click();
    await expect(page.locator('[data-poizon-orders]')).toBeVisible();
  });
});
