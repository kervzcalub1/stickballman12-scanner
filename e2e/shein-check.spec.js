// SHEIN ↔ Shopify check (docs/context/shein-check.md). What this pins:
//   · sizes are compared as number + who-it-fits: "US8" vs "9" is WRONG, "US6" vs "6W" is
//     fine, "7 Toddler" vs "7Y" is the wrong age group, "CN35"/"US7-8" can't be checked;
//   · each SHEIN size is matched to Shopify by seller SKU: gone from Shopify, more stock on
//     SHEIN, a SKU used twice — all flagged; the fix list CSV carries only real findings;
//   · the page: upload the export → tiles → worst product first, phone width, PH + admin.
// Shopify is mocked; the export is built here with our own xlsx writer.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers/auth.js';
import { buildXlsx } from '../src/lib/xlsx.js';
import { compareSize, checkRows, tally, issuesCsv, readSheinExport, parseSize } from '../src/lib/sheinCheck.js';

test.describe('SHEIN check rules', () => {
  test('size = number + who it fits', () => {
    expect(compareSize('US10.5', '10.5')).toBe('ok');
    expect(compareSize('US8', '9')).toBe('wrong_size');
    expect(compareSize('US15W', '15.5W')).toBe('wrong_size');
    expect(compareSize('US6', '6W')).toBe('ok_suffix');
    expect(compareSize('US9.5W', '9.5W')).toBe('ok');
    expect(compareSize('7 Toddler', '7Y')).toBe('wrong_group');
    expect(compareSize('US6.5', '6.5Y')).toBe('check_group');
    expect(compareSize('US6W', '6Y')).toBe('wrong_group');
    expect(compareSize('CN35', '5W')).toBe('other_system');
    expect(compareSize('EUR15', '10')).toBe('other_system');
    expect(compareSize('US7-8', '8')).toBe('other_system');
    expect(compareSize('', '8')).toBe('blank');
    expect(parseSize('4C')).toMatchObject({ n: 4, group: 'child' });
  });

  test('matched by seller SKU: wrong size, gone from Shopify, more stock on SHEIN, used twice', () => {
    const shein = [
      { line: 2, sellerSku: '100', size: 'US9', qty: 1 },
      { line: 3, sellerSku: '101', size: 'US8', qty: 2 },     // Shopify says 9
      { line: 4, sellerSku: '102', size: 'US10', qty: 8 },    // Shopify has 4
      { line: 5, sellerSku: '999', size: 'US11', qty: 1 },    // not in Shopify, still offered
      { line: 6, sellerSku: '103', size: 'US12', qty: 1 },
      { line: 7, sellerSku: '103', size: 'US12', qty: 1 },    // same SKU twice
      { line: 8, sellerSku: '104', size: 'US7', qty: 0 },     // fewer on SHEIN: info only
    ];
    const variants = [
      { sku: '100', size: '9', qty: 3, status: 'ACTIVE', productTitle: 'A' },
      { sku: '101', size: '9', qty: 2, status: 'ACTIVE', productTitle: 'A' },
      { sku: '102', size: '10', qty: 4, status: 'ACTIVE', productTitle: 'A' },
      { sku: '103', size: '12', qty: 5, status: 'ACTIVE', productTitle: 'B' },
      { sku: '104', size: '7', qty: 2, status: 'ACTIVE', productTitle: 'B' },
    ];
    const c = checkRows(shein, variants);
    expect(c.map((r) => r.issues)).toEqual([['under_stock'], ['wrong_size'], ['over_stock'], ['not_in_shopify'], ['duplicate', 'under_stock'], ['duplicate', 'under_stock'], ['under_stock']]);
    expect(tally(c)).toMatchObject({ wrong_size: 1, over_stock: 1, not_in_shopify: 1, duplicate: 2, clean: 2, total: 7 });
    expect(checkRows([{ line: 9, sellerSku: '888', size: 'US9', qty: 0 }], variants)[0].issues).toEqual(['not_in_shopify_zero']);   // nothing offered: a warning, not an emergency
    const csv = issuesCsv(c).replace(/^﻿/, '').trim().split('\r\n');
    expect(csv).toHaveLength(1 + 5);   // header + the five rows with a real finding
    expect(csv[1]).toMatch(/^Wrong size,101,/);
  });
});

const HEAD = ['SPU', 'SKC', 'SKU', 'Secondary Specification Value1', 'brand name', 'Default Product Name(en)', 'sellerSKU', 'Main Image', 'Current inventory', 'Mall link[shein-us]'];
function exportFile(rows) {
  const bytes = buildXlsx({ sheetName: 'Product Information', columns: HEAD.map((label) => ({ label })), rows });
  return Buffer.from(bytes);
}

test.describe('SHEIN check page', () => {
  test('upload the export → the wrong size and the oversell are on top; fix list downloads', async ({ page }) => {
    const rows = [
      ['spu1', 'skc1', 'I1', 'US9', 'Nike', 'Nike Air Max 95 (IB7936-100)', '10086264', '', '1', 'https://us.shein.com/x'],
      ['spu1', 'skc1', 'I2', 'US8', 'Nike', 'Nike Air Max 95 (IB7936-100)', '10086263', '', '1', 'https://us.shein.com/x'],
      ['spu2', 'skc2', 'I3', 'US10', 'Nike', 'Nike Dunk Low (DD1391-100)', '20000001', '', '7', ''],
      ['spu3', 'skc3', 'I4', 'US11', 'Adidas', 'Adidas Samba (B75806)', '30000001', '', '1', ''],
    ];
    const parsed = readSheinExport(new Uint8Array(exportFile(rows)));
    expect(parsed.ok).toBe(true);
    expect(parsed.rows[1]).toMatchObject({ sellerSku: '10086263', size: 'US8', qty: 1, spu: 'spu1' });

    await page.route('**/api/shopify-listings/variants', (r) => r.fulfill({ json: { ok: true, variants: [
      { sku: '10086264', size: '9', qty: 1, status: 'ACTIVE', productTitle: 'Nike Air Max 95 (IB7936-100)' },
      { sku: '10086263', size: '9', qty: 1, status: 'ACTIVE', productTitle: 'Nike Air Max 95 (IB7936-100)' },
      { sku: '20000001', size: '10', qty: 4, status: 'ACTIVE', productTitle: 'Nike Dunk Low (DD1391-100)' },
      { sku: '30000001', size: '11', qty: 1, status: 'ACTIVE', productTitle: 'Adidas Samba (B75806)' },
    ] } }));
    await loginAs(page, 'ph_team');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/ph/shein-check');
    await page.getByLabel('SHEIN export file').setInputFiles({ name: 'Export Products_2026-10-09 13_36_02.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: exportFile(rows) });
    await expect(page.locator('.shc-tile.bad').filter({ hasText: 'Wrong size' })).toContainText('1');
    await expect(page.locator('.shc-tile.bad').filter({ hasText: 'More on SHEIN than Shopify' })).toContainText('1');
    await expect(page.locator('.shc-tile.ok b')).toHaveText('2');
    await expect(page.locator('.shc-tile.ok span')).toHaveText('of 4 sizes OK');
    await expect(page.locator('p.notice')).toContainText('This export is from 2026-10-09');
    const products = page.locator('.shc-product');
    await expect(products).toHaveCount(2);                                   // problems only; the Samba is clean
    await expect(products.first().locator('tr.bad')).toContainText('10086263');
    await page.locator('.shc-tile').filter({ hasText: 'More on SHEIN' }).click();
    await expect(products).toHaveCount(1);
    await expect(products.first()).toContainText('Nike Dunk Low');
    // tap the tile again → back to all problems; a wrong size outranks the oversell
    await page.locator('.shc-tile').filter({ hasText: 'More on SHEIN' }).click();
    await expect(products).toHaveCount(2);
    await expect(products.first()).toContainText('Nike Air Max 95');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '⬇ Fix list (CSV)', exact: true }).click()]);
    expect(dl.suggestedFilename()).toBe('SHEIN check 2026-10-09.csv');
    const wide = await page.evaluate(() => [...document.querySelectorAll('body *')].filter((el) => !el.closest('.ap-tablewrap') && el.getBoundingClientRect().right > window.innerWidth + 1).slice(0, 6).map((el) => `${el.tagName}.${el.className}`));
    expect(wide).toEqual([]);
  });

  test('admins reach it from their home (Marketplaces)', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto('/');
    await page.getByRole('button', { name: /SHEIN ↔ Shopify check/ }).click();
    await expect(page).toHaveURL(/\/shein-check$/);
    await expect(page.getByLabel('SHEIN export file')).toBeAttached();
  });
});
