// Temu Reprice (PH) — the rules that silently cost money when they slip
// (docs/context/temu-reprice.md), then the page end to end with the price endpoint mocked,
// so CI never calls Alias. The fixture is Temu's own template (Instructions, Data
// Definitions, per-row dropdowns) cut down to seven made-up SKUs.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { loginAs } from './helpers/auth.js';
import { readInventoryFile } from '../src/lib/ebayReprice.js';
import { readSheetRows } from '../src/lib/sheinReprice.js';
import * as T from '../src/lib/temuReprice.js';

const TEMPLATE = new Uint8Array(fs.readFileSync(new URL('./fixtures/temu-pricing-template.xlsx', import.meta.url)));
// Row 3 T-ACC   10/Black  100.00 → Temu 85.00     market 70 → 80.50: Temu is above → Accept
// Row 4 T-PROP  8.5W/Pink 120.00 → Temu 80.00     market 90 → 103.50: countered at 103.50
// Row 5 T-ONLY  Grit/9    120.00 → Temu 80.00     same, but the row only offers Accept → blank
// Row 6 T-HIGH  11         75.00 → Temu 70.00     80.50 ≥ 75: never raised → blank
// Row 7 T-NOSZ  As shown                          no size → skipped
// Row 8 T-NOSTYLE                                 no Style ID anywhere → skipped
// Row 9 T-DASH  Team Red-11.5W/One-size 200.00 → Temu 110.00, Inactive, style from the name;
//               market 104.35 → 120.0025 → 120.01 (rounded UP to the cent): countered
const INVENTORY = 'SKU,Style ID,Product Name\nT-ACC,AA1111-100,Nike Heritage Vulc\nT-PROP,BB2222-200,Nike Vomero\nT-ONLY,BB2222-200,Nike Vomero\nT-HIGH,AA1111-100,Nike Heritage Vulc\nT-NOSZ,AA1111-100,Nike Heritage Vulc\n';
const MARKET = { 'AA1111-100|10': 7000, 'BB2222-200|8.5': 9000, 'BB2222-200|9': 9000, 'AA1111-100|11': 7000, 'CC3333-300|11.5': 10435 };
const cache = Object.fromEntries(Object.entries(MARKET).map(([k, v]) => [k, { status: 'ok', valueCents: v }]));
const load = () => {
  const file = T.readTemuFile(TEMPLATE);
  return { file, rows: T.resolveStyles(file.rows, readInventoryFile(INVENTORY)).rows };
};

test.describe('Temu reprice rules', () => {
  test('market + markup is rounded UP to the cent, in integers', () => {
    expect(T.temuFloorCents(10000, 1500)).toBe(11500);
    expect(T.temuFloorCents(10435, 1500)).toBe(12001);   // 120.0025 → 120.01
    expect(T.temuFloorCents(7000, 1500)).toBe(8050);
    expect(T.temuFloorCents(7000, 0)).toBe(7000);
  });

  test('the size is found inside Temu’s Variation, never guessed', () => {
    for (const [v, want] of [['8.5W/Pink', '8.5'], ['Grit/6', '6'], ['4Y', '4'], ['10', '10'], ['10.5/As shown: 2', '10.5'],
      ['Team Red-11.5W/One-size', '11.5'], ['As shown: 6-4Y-One-size/One-size', '4'], ['As shown: 10-10.5/One-size', '10.5']]) expect(T.temuSize(v), v).toBe(want);
    for (const odd of ['', 'As shown', 'Black', 'One-size', '8/9', 'EU 42/Black']) expect(T.temuSize(odd), odd).toBe('');
  });

  test('the file: columns by name, each row’s own dropdown, Style ID from the report then the name', () => {
    const { file, rows } = load();
    expect(file.ok).toBe(true);
    expect(file.stats).toMatchObject({ rows: 7, inactive: 1, acceptOnly: 1, filled: 0 });
    expect(file.reasons).toContain('High production cost');
    expect(rows.map((x) => [x.sku, x.style, x.size])).toEqual([
      ['T-ACC', 'AA1111-100', '10'], ['T-PROP', 'BB2222-200', '8.5'], ['T-ONLY', 'BB2222-200', '9'], ['T-HIGH', 'AA1111-100', '11'],
      ['T-NOSZ', 'AA1111-100', ''], ['T-NOSTYLE', '', '9'], ['T-DASH', 'CC3333-300', '11.5'],
    ]);
    expect(rows[2].actions).toEqual(['Accept']);
    expect(T.jobsFor(rows)).toHaveLength(5);
    expect(T.jobsFor(rows, { activeOnly: true })).toHaveLength(4);
  });

  test('accept at or above market + markup, counter under it, never raise — and the file verifies', () => {
    const { file, rows } = load();
    const r = T.applyReprice(rows, cache, 1500);
    expect(r.fills).toEqual([
      { line: 3, skuId: '800000000000001', action: 'Accept', price: '', reason: '' },
      { line: 4, skuId: '800000000000002', action: 'New proposal', price: '103.50', reason: 'High production cost' },
      { line: 9, skuId: '800000000000007', action: 'New proposal', price: '120.01', reason: 'High production cost' },
    ]);
    expect(r.n).toMatchObject({ accept: 1, propose: 2, noCounter: 1, tooLow: 1, skipped: 2, nodata: 0, reductionCents: 1500 + 1650 + 7999 });
    // A lower markup turns the counters into accepts where Temu's price now clears it.
    expect(T.applyReprice(rows, cache, 0).n).toMatchObject({ accept: 3, propose: 1, noCounter: 1, tooLow: 0 });
    expect(T.applyReprice(rows, cache, 1500, { counter: false }).n).toMatchObject({ accept: 1, propose: 0, noCounter: 3 });

    const out = T.fillTemplate(file, r.fills);
    expect(T.verifyOutput(file, out, r.fills).ok).toBe(true);
    const sheet = readSheetRows(out, 'Template');
    const before = readSheetRows(TEMPLATE, 'Template');
    expect(sheet[2].slice(12, 15)).toEqual(['Accept', '', '']);
    expect(sheet[3].slice(12, 15)).toEqual(['New proposal', '103.50', 'High production cost']);
    expect(sheet[4]).toEqual(before[4]);                       // an unanswered row is untouched
    expect(sheet.slice(0, 2)).toEqual(before.slice(0, 2));     // headers + Temu's explanations
    // Tampered answers fail: a counter above today's price, and New proposal on an Accept-only row.
    for (const bad of [{ line: 4, skuId: '800000000000002', action: 'New proposal', price: '150.00', reason: 'High production cost' },
      { line: 5, skuId: '800000000000003', action: 'New proposal', price: '103.50', reason: 'High production cost' }]) {
      expect(T.verifyOutput(file, T.fillTemplate(file, [bad]), [bad]).ok).toBe(false);
    }
    // A file someone already answered by hand: that row is left alone.
    const again = T.readTemuFile(out);
    expect(again.stats.filled).toBe(3);
    expect(T.applyReprice(T.resolveStyles(again.rows, readInventoryFile(INVENTORY)).rows, cache, 1500).fills).toEqual([]);
  });

  test('more than 1,000 answers become several files', () => {
    const fills = Array.from({ length: 2300 }, (_, i) => ({ line: i + 3 }));
    expect(T.partsOf(fills).map((p) => p.length)).toEqual([1000, 1000, 300]);
    expect(T.outputName('2026-11-20', 2, 3)).toBe('Temu reprice (11.20.2026) part 2 of 3.xlsx');
    expect(T.outputName('2026-11-20', 1, 1)).toBe('Temu reprice (11.20.2026).xlsx');
  });
});

test.describe('Temu Reprice page', () => {
  test('template + inventory → prices → verified download', async ({ page }) => {
    await loginAs(page, 'ph_team');
    await page.route('**/api/ebay-reprice/prices', async (route) => {
      const { jobs } = route.request().postDataJSON();
      await route.fulfill({ json: { ok: true, results: jobs.map((j) => ({ ...j, status: 'ok', valueCents: MARKET[`${j.sku}|${j.size}`], rank: 1, label: 'Global Indicator - Consigned' })) } });
    });
    await page.goto('/ph/temu-reprice');
    await page.evaluate(() => { try { Object.keys(localStorage).filter((k) => k.startsWith('reprice:')).forEach((k) => localStorage.removeItem(k)); } catch { /* */ } });
    await page.reload();

    // The wrong file in the template field is refused on drop.
    await page.locator('#tr-temu').setInputFiles({ name: 'x.xlsx', mimeType: 'text/csv', buffer: Buffer.from(INVENTORY) });
    await expect(page.getByText('Not an Excel file')).toBeVisible();
    await page.locator('#tr-temu').setInputFiles({ name: 'Traffic boost opportunity_1795113600672.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(TEMPLATE) });
    await expect(page.locator('.er-file').first()).toContainText('7 SKUs · 1 can only be accepted · 1 inactive');
    await page.locator('#tr-inv').setInputFiles({ name: 'StoreInventoryReport.csv', mimeType: 'text/csv', buffer: Buffer.from(INVENTORY) });
    await expect(page.locator('.card').first()).toContainText('5SKUs to price');
    await expect(page.locator('.card').first()).toContainText('1 — Variation has no single US size');

    await page.getByRole('button', { name: 'Fetch prices' }).click();
    await expect(page.getByRole('button', { name: '✓ All prices fetched' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByLabel('Markup percent')).toHaveValue('15');
    await page.getByRole('button', { name: 'Build Temu file' }).click();
    await expect(page.locator('.er-verify.pass')).toBeVisible();
    await expect(page.locator('.er-result')).toContainText('1accepted');
    await expect(page.locator('.er-result')).toContainText('2our price proposed');

    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /^Download — Temu reprice/ }).click()]);
    expect(dl.suggestedFilename()).toMatch(/^Temu reprice \(\d+\.\d+\.\d{4}\)\.xlsx$/);
    const sheet = readSheetRows(new Uint8Array(fs.readFileSync(await dl.path())), 'Template');
    expect(sheet.slice(2).map((r) => [r[3], r[12] || '', r[13] || ''])).toEqual([
      ['T-ACC', 'Accept', ''], ['T-PROP', 'New proposal', '103.50'], ['T-ONLY', '', ''], ['T-HIGH', '', ''],
      ['T-NOSZ', '', ''], ['T-NOSTYLE', '', ''], ['T-DASH', 'New proposal', '120.01'],
    ]);

    // The markup is the user's: at 0 % Temu's 85, 70 and 110 all clear the market.
    await page.getByLabel('Markup percent').fill('0');
    await page.getByRole('button', { name: 'Build Temu file' }).click();
    await expect(page.locator('.er-result')).toContainText('3accepted');
  });
});
