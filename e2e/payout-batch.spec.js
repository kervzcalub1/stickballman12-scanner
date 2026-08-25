// Batch analysis on the Payout Calculator — a whole list at once.
//
// Two halves, tested separately because they fail differently: the PARSE (pure, and the
// part that quietly ruins everything downstream when it misreads a size) and the SCREEN
// around it, with the pricing stubbed. Live Alias/StockX pricing isn't ours to assert in
// CI, and the maths it feeds is already covered by e2e/payout-calculator.spec.js.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers/auth.js';
import { parseBatch } from '../src/lib/batchParse.js';
import { analyseBatch, batchSummary } from '../src/lib/batch.js';

test.describe('reading a pasted list', () => {
  test('a header line and its size run become one row per size', () => {
    const { rows, shape } = parseBatch(`DD1391-100 Dunk Low Panda $95
9 x 2
9.5 x 1
⸻
FQ8080-133 Air Max 90 $110
10 x 3
Total: 6 pairs`);
    expect(shape).toBe('grouped');
    // The header's price and name carry down to every size under it, and the "Total"
    // footer is a footer — not a fourth pair of shoes.
    expect(rows.map((r) => [r.sku, r.size, r.qty, r.cost])).toEqual([
      ['DD1391-100', '9', 2, '95'],
      ['DD1391-100', '9.5', 1, '95'],
      ['FQ8080-133', '10', 3, '110'],
    ]);
    expect(rows[0].name).toBe('Dunk Low Panda');
  });

  test('one row per line works too, and never claims to be grouped', () => {
    const { rows, shape } = parseBatch('DD1391-100 size 9 $95 qty 2\nFQ8080-133 sz 10.5 x3 $110');
    expect(shape).toBe('per-line');
    expect(rows.map((r) => [r.sku, r.size, r.qty, r.cost])).toEqual([
      ['DD1391-100', '9', 2, '95'],
      ['FQ8080-133', '10.5', 3, '110'],
    ]);
  });

  test('a missing cost stays blank — never a zero', () => {
    // "They didn't say" and "it's free" are different, and only one of them should
    // produce a verdict at all.
    const { rows } = parseBatch('DD1391-100 size 9 qty 2');
    expect(rows[0].cost).toBe('');
  });

  test('a size like 9W keeps its letter — it is a different shoe', () => {
    const { rows } = parseBatch('HV8288-001 Wmns AJ1 $120\n7.5W x 2');
    expect(rows[0].size).toBe('7.5W');
  });

  test('lines with no style code are skipped rather than guessed at', () => {
    const { rows } = parseBatch('hey man here is the list\nthanks!\nDD1391-100 sz 9 $95');
    expect(rows).toHaveLength(1);
    expect(rows[0].sku).toBe('DD1391-100');
  });
});

test.describe('calling the list', () => {
  const quotes = {
    'DD1391-100': { alias: { results: [{ size: '9', lowest_listing: 150 }] }, stockx: { results: [{ size: '9', lowest_ask: 140 }] } },
  };

  test('each row gets the app-wide verdict, and the line total is qty-aware', () => {
    const rows = [{ key: 'a', sku: 'DD1391-100', size: '9', qty: 3, cost: '95' }];
    const [r] = analyseBatch(rows, quotes);
    // Alias 150 − 9.9% = 135.15, − 95 = 40.15 a pair, 42.3% ROI → both thresholds → Buy.
    expect(r.status).toBe('buy');
    expect(r.best.platform).toBe('alias');
    expect(r.best.profit).toBeCloseTo(40.15, 2);
    expect(r.lineProfit).toBeCloseTo(120.45, 2);  // what the LINE is worth, not the pair
  });

  test('no market and no cost are different answers, and neither is a zero-profit Pass', () => {
    const rows = [
      { key: 'a', sku: 'DD1391-100', size: '9', qty: 1, cost: '' },     // priced, no cost
      { key: 'b', sku: 'DD1391-100', size: '13', qty: 1, cost: '95' },  // costed, no market
    ];
    const out = analyseBatch(rows, quotes);
    expect(out[0].status).toBe('no_cost');
    expect(out[1].status).toBe('no_price');
    const s = batchSummary(out);
    // Neither is folded into the money — averaging a blank into a blended ROI is how a
    // bad batch reads as an acceptable one.
    expect(s.totalCost).toBe(0);
    expect(s.blendedRoi).toBe(0);
    expect(s.noCost).toBe(1);
    expect(s.noPrice).toBe(1);
  });
});

test.describe('the screen', () => {
  // It lives at the bottom of the one-pair page, under the cost stack — that placement
  // is the feature, so the test navigates the way a person does rather than to a mode.
  async function openBatch(page) {
    await loginAs(page, 'warehouse');
    await page.goto('/payout');
    await expect(page.locator('.pc-batch-text')).toBeVisible();
  }

  test('paste → review → analyse, with the review step editable', async ({ page }) => {
    await page.route('**/api/payout/batch', (route) => route.fulfill({
      json: { ok: true, quotes: { 'DD1391-100': { alias: { results: [{ size: '9', lowest_listing: 150 }] }, stockx: { results: [] } } } },
    }));
    await openBatch(page);
    await page.locator('.pc-batch-text').fill('DD1391-100 Dunk Low Panda $95\n9 x 2');
    await page.getByRole('button', { name: 'Read the list' }).click();

    // It shows what it read BEFORE anything is priced — a wrong number must not decide
    // a purchase unseen.
    const row = page.locator('.pc-batch-rows .pc-batch-row').nth(1);
    await expect(row.locator('.pc-batch-sku input')).toHaveValue('DD1391-100');
    await expect(row.locator('.pc-batch-size')).toHaveValue('9');
    await expect(row.locator('.pc-batch-qty')).toHaveValue('2');
    // …and it's editable: fix the cost, then price. The stack above is empty in this
    // test, so a shelf price of 100 lands as a cost of 100.
    await row.locator('.pc-batch-cost').fill('100');
    await page.getByRole('button', { name: /Analyse 1 row/ }).click();

    await expect(page.locator('.pc-batch-result')).toHaveCount(1);
    await expect(page.locator('.pc-call')).toHaveText('Buy');
    // 150 − 9.9% = 135.15, − 100 = 35.15 a pair; two pairs = 70.30.
    await expect(page.locator('.pc-batch-result-money')).toContainText('$35.15/pair');
    await expect(page.locator('.pc-batch-result-money')).toContainText('$70.30');
    await expect(page.locator('.pc-batch-stats')).toContainText('$70.30');
  });

  test('the Store cost stack above prices every pasted row', async ({ page }) => {
    await page.route('**/api/payout/batch', (route) => route.fulfill({
      json: { ok: true, quotes: { 'DD1391-100': { alias: { results: [{ size: '9', lowest_listing: 220 }] }, stockx: { results: [] } } } },
    }));
    await openBatch(page);
    // Fill the register once, at the top of the page.
    const field = (label) => page.locator('.pc-field', { hasText: label }).first().locator('input');
    await field('Store discount').fill('30');
    await field('Promo / birthday').fill('10');
    await field('Tax').fill('8');
    await field('Tip').fill('5');
    await field('Shipping').fill('8.25');
    // A coupon must NOT reach the batch: it's one amount off one transaction, and
    // carrying it into every row would quietly take $10 a pair off the whole list.
    await field('Coupon').fill('10');

    await page.locator('.pc-batch-text').fill('DD1391-100 Dunk Low Panda $150\n9 x 1');
    await page.getByRole('button', { name: 'Read the list' }).click();
    // The column is a SHELF price now, and the line says what will happen to it.
    await expect(page.locator('.pc-batch-row.head')).toContainText('Shelf price');
    await expect(page.locator('.pc-batch-stackline')).toContainText('30% store');
    await expect(page.locator('.pc-batch-stackline')).toContainText('$8.25 shipping');
    await page.getByRole('button', { name: /Analyse 1 row/ }).click();

    // 150 → −30% → 105 → −10% → 94.50 → +8% tax → 102.06 → +5 tip +8.25 shipping = 115.31.
    // With the coupon it would have been 104.51 — so this number is the assertion that
    // the coupon stayed out.
    await expect(page.locator('.pc-batch-result-nums')).toContainText('$115.31');
    await expect(page.locator('.pc-batch-result-nums')).toContainText('(from $150.00)');
  });

  test('“Already my cost” takes the pasted number as-is', async ({ page }) => {
    await page.route('**/api/payout/batch', (route) => route.fulfill({
      json: { ok: true, quotes: { 'DD1391-100': { alias: { results: [{ size: '9', lowest_listing: 220 }] }, stockx: { results: [] } } } },
    }));
    await openBatch(page);
    await page.locator('.pc-field', { hasText: 'Store discount' }).first().locator('input').fill('30');
    await page.locator('.pc-batch-text').fill('DD1391-100 $150\n9 x 1');
    await page.getByRole('button', { name: 'Read the list' }).click();
    await page.getByRole('button', { name: 'Already my cost' }).click();
    await expect(page.locator('.pc-batch-row.head')).toContainText('Cost / pair');
    await page.getByRole('button', { name: /Analyse 1 row/ }).click();
    await expect(page.locator('.pc-batch-result-nums')).toContainText('Cost $150.00');
    await expect(page.locator('.pc-batch-result-nums')).not.toContainText('(from');
  });

  test('a list it cannot read says so instead of showing an empty table', async ({ page }) => {
    await openBatch(page);
    await page.locator('.pc-batch-text').fill('hey do you want these?\nthanks');
    await page.getByRole('button', { name: 'Read the list' }).click();
    await expect(page.locator('.error')).toContainText('Nothing recognisable');
    await expect(page.locator('.pc-batch-rows')).toHaveCount(0);
  });
});
