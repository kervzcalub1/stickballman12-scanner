// Stock Check + My Scans (docs/context/inventory.md "Stock Check"): scan a box / VIN / SKU
// → one answer (size + Shopify's for-sale count; for a VIN: in inventory or not), count a
// size, and every scan recorded under the person for My Scans (CSV + PDF).
// The count is the SERVER's — the bypass tests below try to move it from outside the page.
// CI has no Shopify token, so "couldn't read Shopify" is accepted as the Shopify half of
// any answer — it must never be shown as a zero.
import { test, expect } from '@playwright/test';
import pg from 'pg';
import fs from 'node:fs';
import { loginAs, loadEnv } from './helpers/auth.js';
import { signToken } from '../api/_lib/util.js';
import { pairVerdict, shopifyForSize, shopifySizes, sameShoe, countResult, countDecision, entryVia } from '../src/lib/stockCheck.js';
import { scanRows, countRows, scansCsv, countsCsv } from '../src/lib/scanReport.js';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, values) => pool.query(text, values).then((r) => r.rows);
const STAMP = `${Date.now()}`.slice(-6);
const SKU = `E2E-STKCHK-${STAMP}`;
const UPC = `09${STAMP}0099`.slice(0, 12);
const T0 = new Date();
const WH = { uid: 'e2e-wh', username: 'e2e_wh', name: 'E2E Warehouse', role: 'warehouse' };
const PH = { uid: 'e2e-ph', username: 'e2e_ph', name: 'E2E PH', role: 'ph_team' };

test.describe.configure({ mode: 'serial' });

test.afterAll(async () => {
  await q("DELETE FROM stock_check_scans WHERE username IN ('e2e_wh','e2e_ph') AND created_at >= $1", [T0]);
  await q("DELETE FROM stock_counts WHERE username IN ('e2e_wh','e2e_ph') AND started_at >= $1", [T0]);
  await q('DELETE FROM item_events WHERE item_id IN (SELECT id FROM items WHERE sku = $1)', [SKU]);
  await q('DELETE FROM items WHERE sku = $1', [SKU]);
  await q("DELETE FROM batches WHERE origin = 'E2E stock check' AND NOT EXISTS (SELECT 1 FROM items WHERE batch_id = batches.id)");
  await pool.end();
});

// The API as a given person, from outside the page — what a hand-made request can do.
const call = (request, who, method, path, data) => request.fetch(path, {
  method, data, headers: { authorization: `Bearer ${signToken(who)}`, 'content-type': 'application/json' },
});

let VINS = [];

test('the answers, pure', () => {
  const sold = pairVerdict({ status: 'sold' }, [
    { type: 'status_change', details: { status: 'needs_shelf' }, created_at: '2026-10-01T15:00:00Z' },
    { type: 'status_change', details: { status: 'sold' }, created_at: '2026-10-12T15:00:00Z' },
  ]);
  expect(sold).toMatchObject({ tone: 'out', inInventory: false, detail: 'Marked Sold', when: '2026-10-12T15:00:00Z' });
  expect(pairVerdict({ status: 'in_stock', location_label: 'A2-04' })).toMatchObject({ tone: 'in', inInventory: true, shelf: 'A2-04' });
  expect(pairVerdict({ status: 'missing' })).toMatchObject({ tone: 'warn', inInventory: false });
  expect(pairVerdict({ status: 'pre_sold' }).inInventory).toBe(true);

  const products = [
    { title: 'A', status: 'ACTIVE', sizes: [{ size: '10', qty: 2 }, { size: '9 W', qty: -1 }] },
    { title: 'B', status: 'ACTIVE', sizes: [{ size: '10', qty: 1 }] },
    { title: 'Old', status: 'ARCHIVED', sizes: [{ size: '10', qty: 4 }] },
  ];
  expect(shopifyForSize(products, '10')).toEqual({ qty: 3, listed: true, inactive: 4 });
  expect(shopifyForSize(products, '9W')).toEqual({ qty: 0, listed: true, inactive: 0 });
  expect(shopifyForSize(products, '11')).toEqual({ qty: 0, listed: false, inactive: 0 });
  expect(shopifySizes(products)).toEqual([{ size: '9 W', qty: 0 }, { size: '10', qty: 3 }]);

  expect(sameShoe({ sku: 'DD1391-100', size: '9 W' }, { sku: 'dd1391100', size: '9W' })).toBe(true);
  expect(sameShoe({ sku: 'DD1391-100', size: '9' }, { sku: 'DD1391-100', size: '9W' })).toBe(false);

  expect(countResult(3, 3).tone).toBe('in');
  expect(countResult(2, 3).text).toMatch(/^1 short/);
  expect(countResult(4, 3).text).toMatch(/^1 extra/);
  expect(countResult(2, null).tone).toBe('warn');

  // What counts — decided on the server.
  const c = { sku: 'X1', size: '9', vin_only: false };
  const shoe = { sku: 'X1', size: '9' };
  expect(countDecision(c, { kind: 'upc', shoe }).counted).toBe(true);
  expect(countDecision(c, { kind: 'sku', shoe }).counted).toBe(false);                       // typing a SKU is not a pair
  expect(countDecision({ ...c, vin_only: true }, { kind: 'upc', shoe }).counted).toBe(false); // VINs only
  expect(countDecision(c, { kind: 'vin', shoe: { sku: 'X1', size: '10' } }).counted).toBe(false);
  expect(countDecision(c, { kind: 'vin', shoe, verdict: { inInventory: false, detail: 'Marked Sold' } }))
    .toEqual({ counted: true, note: 'our record says marked sold' });                        // in hand: counts, flagged
  expect(countDecision(c, { kind: 'vin', shoe: null }).counted).toBe(false);

  // A gun types a code in a burst; a person doesn't; a paste is typed.
  expect(entryVia(17, 60)).toBe('scanner');
  expect(entryVia(17, 2400)).toBe('typed');
  expect(entryVia(17, 10, true)).toBe('typed');
  expect(entryVia(3, 0)).toBe('typed');

  // Report rows: CSV carries every column the PDF has.
  const rows = countRows([{ id: '7', started_at: '2026-11-04T15:00:00Z', username: 'u', sku: 'X1', size: '9', status: 'finished',
    counted: 2, expected_start: 3, expected_end: 3, vin_only: true, by_vin: 2, by_barcode: 0, typed: 1, flagged: 0, refused: 1, tally: 2 }]);
  expect(rows[0]).toMatchObject({ id: '#7', counted: '2', diff: '-1', mode: 'VINs only', result: '1 short — counted 2, Shopify has 3' });
  expect(countsCsv([])).toMatch(/^Count,Date \(EST\)/);
  expect(scanRows([{ created_at: '2026-11-04T15:00:00Z', username: 'u', code: 'SBM-1', kind: 'vin', verdict: 'out', item_status: 'sold', count_id: '7', counted: true, undone: false }])[0])
    .toMatchObject({ answer: 'Not in inventory (Sold)', count: '#7', counted: 'Yes' });
  expect(scansCsv([])).toMatch(/^Date \(EST\),Time,By,Scanned/);
});

test('scan a VIN → in inventory; count it on the server; sold → not in inventory', async ({ page }) => {
  page.on('pageerror', (err) => { throw err; });
  await loginAs(page, 'warehouse');
  await page.goto('/stock-check');
  const res = await page.evaluate(async ([sku, upc]) => {
    const r = await fetch('/api/batches/commit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionStorage.getItem('sb_session_token')}` },
      body: JSON.stringify({ kind: 'existing', noShelf: true, batch: { origin: 'E2E stock check' },
        items: [
          { name: 'E2E Stock Check Runner', sku, size: '9', upc, withBox: true, source: 'manual' },
          { name: 'E2E Stock Check Runner', sku, size: '9', upc, withBox: true, source: 'manual' },
          { name: 'E2E Stock Check Runner', sku, size: '10', withBox: true, source: 'manual' },
          { name: 'E2E Stock Check Runner', sku, size: '9', upc, withBox: true, source: 'manual' },
        ] }),
    });
    return { status: r.status, body: await r.json() };
  }, [SKU, UPC]);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  VINS = res.body.vins;
  const [vinA, vinB, vin10] = VINS;

  const box = page.getByLabel('Scan or type a code');
  await box.fill(vinA);
  await box.press('Enter');
  const answer = page.getByRole('region', { name: 'Answer' });
  await expect(answer.getByText('In inventory', { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(answer.getByText(SKU, { exact: true })).toBeVisible();
  await expect(answer.getByText(/Live from Shopify at|Couldn’t read Shopify/)).toBeVisible();

  await answer.getByRole('button', { name: 'Count this size' }).click();
  const counting = page.getByRole('region', { name: 'Counting' });
  await expect(counting.getByLabel('Counted 1')).toBeVisible();                 // the scanned pair is #1 (server-filed)
  await box.fill(vinB); await box.press('Enter');
  await expect(counting.getByLabel('Counted 2')).toBeVisible({ timeout: 15_000 });
  await box.fill(vinB); await box.press('Enter');
  await expect(counting.getByText(/already counted/).first()).toBeVisible({ timeout: 15_000 });
  await box.fill(vin10); await box.press('Enter');
  await expect(counting.getByText(/a different shoe: .* size 10/).first()).toBeVisible({ timeout: 15_000 });
  await expect(counting.getByLabel('Counted 2')).toBeVisible();

  // A refresh mid-count picks it up where it was.
  await page.reload();
  await expect(page.getByRole('region', { name: 'Counting' }).getByLabel('Counted 2')).toBeVisible({ timeout: 15_000 });

  await counting.getByRole('button', { name: '↶ Undo last' }).click();
  await expect(counting.getByLabel('Counted 1')).toBeVisible();
  await counting.getByRole('button', { name: 'Finish count' }).click();
  const result = page.getByRole('region', { name: 'Count result' });
  await expect(result.getByText(/1 extra — counted 1, Shopify has 0|Counted 1 — Shopify’s number couldn’t be read/)).toBeVisible({ timeout: 20_000 });
  await result.getByRole('button', { name: 'Done' }).click();

  const sold = await page.evaluate(async (vin) => {
    const r = await fetch('/api/items/bulk-status', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionStorage.getItem('sb_session_token')}` },
      body: JSON.stringify({ vins: [vin], status: 'sold' }),
    });
    return r.status;
  }, vinA);
  expect(sold).toBe(200);
  await box.fill(vinA); await box.press('Enter');
  await expect(answer.getByText('Not in inventory', { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(answer.getByText(/Marked Sold/)).toBeVisible();
});

test('bypass attempts: the count can only move by real scans of the right pair', async ({ request }) => {
  const [vinA, vinB, vin10, vinC] = VINS;
  // A VIN-only count of size 9, started without a scan.
  let r = await call(request, WH, 'POST', '/api/items/stock-count', { action: 'start', sku: SKU, size: '9', vinOnly: true });
  expect(r.status()).toBe(200);
  const count = (await r.json()).count;
  const id = Number(count.id);

  // 1. The browser can't say "counted": a different size stays uncounted whatever is sent.
  r = await call(request, WH, 'POST', '/api/items/stock-check', { code: vin10, countId: id, counted: true, note: 'trust me' });
  expect((await r.json()).scan.counted).toBe(false);
  // 2. VINs only: a box barcode (even of the right shoe) and a typed SKU don't count.
  r = await call(request, WH, 'POST', '/api/items/stock-check', { code: UPC, countId: id });
  const upcScan = await r.json();
  expect(upcScan.scan.counted, JSON.stringify(upcScan)).toBe(false);
  r = await call(request, WH, 'POST', '/api/items/stock-check', { code: SKU, countId: id });
  expect((await r.json()).scan.counted).toBe(false);
  // 3. The same pair fired twice at once counts once (the unique index, not a pre-check).
  const both = await Promise.all([1, 2].map(() => call(request, WH, 'POST', '/api/items/stock-check', { code: vinC, countId: id, via: 'scanner' })));
  const counted = (await Promise.all(both.map((x) => x.json()))).filter((x) => x.scan.counted);
  expect(counted).toHaveLength(1);
  // 4. Typed by hand is recorded as typed.
  r = await call(request, WH, 'POST', '/api/items/stock-check', { code: vinB, countId: id, via: 'typed' });
  const typed = await r.json();
  expect(typed.scan).toMatchObject({ counted: true });
  expect(typed.scan.note).toMatch(/typed by hand/);
  expect(typed.tally).toMatchObject({ counted: 2, by_vin: 2, typed: 1 });
  // 5. Somebody else can't scan into, undo or finish my count.
  r = await call(request, PH, 'POST', '/api/items/stock-check', { code: vinA, countId: id });
  expect(r.status()).toBe(404);
  for (const action of ['undo', 'finish', 'cancel']) {
    r = await call(request, PH, 'POST', '/api/items/stock-count', { action, id });
    expect(r.status()).toBe(404);
  }
  // 6. ...nor start a count off my scan.
  const [mine] = await q("SELECT id FROM stock_check_scans WHERE username = 'e2e_wh' AND count_id IS NULL ORDER BY id DESC LIMIT 1");
  r = await call(request, PH, 'POST', '/api/items/stock-count', { action: 'start', scanId: Number(mine.id) });
  expect(r.status()).toBe(404);
  // 7. My Scans: not an admin → always your own, whatever you ask for.
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  r = await call(request, PH, 'GET', `/api/items/my-scans?from=${today}&to=${today}&user=e2e_wh`);
  const ph = await r.json();
  expect(ph.who).toBe('e2e_ph');
  expect(ph.scans.every((s) => s.username === 'e2e_ph')).toBe(true);
  // ...and only the pairs YOU received: none of the warehouse's.
  expect(ph.received.some((it) => VINS.includes(it.vin))).toBe(false);

  r = await call(request, WH, 'POST', '/api/items/stock-count', { action: 'finish', id });
  const done = await r.json();
  expect(done.count).toMatchObject({ status: 'finished', counted: 2 });
  // 8. Closed is closed.
  r = await call(request, WH, 'POST', '/api/items/stock-check', { code: vinA, countId: id });
  expect(r.status()).toBe(409);
});

// My Scans means the pairs a person RECEIVED (owner, 2026-11-10): that's what it opens on.
test('My Scans opens on the pairs you received, with the shipment, and downloads CSV + PDF', async ({ page }) => {
  page.on('pageerror', (err) => { throw err; });
  await loginAs(page, 'warehouse');
  await page.goto('/my-scans');
  await expect(page.getByRole('tab', { name: /Received/ })).toHaveAttribute('aria-selected', 'true');
  const got = page.getByRole('list', { name: 'Pairs received' });
  for (const vin of VINS) await expect(got.getByText(vin)).toBeVisible({ timeout: 15_000 });
  const row = got.locator('li').filter({ hasText: VINS[0] });
  await expect(row).toContainText(SKU);
  await expect(row).toContainText('E2E stock check');          // where it came from
  await expect(row).toContainText('Existing stock');           // and what kind of intake
  const [csv] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '⬇ CSV' }).click()]);
  expect(csv.suggestedFilename()).toMatch(/^received_.*\.csv$/);
  const text = fs.readFileSync(await csv.path(), 'utf8');
  expect(text).toMatch(/^Date \(EST\),Time,Received by,VIN,SKU/);
  for (const vin of VINS) expect(text).toContain(vin);
  expect(text).toContain('E2E Warehouse');
  const [pdf] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '⬇ PDF' }).click()]);
  expect(pdf.suggestedFilename()).toMatch(/^received_.*\.pdf$/);
  expect(fs.readFileSync(await pdf.path()).subarray(0, 4).toString()).toBe('%PDF');
});

test('My Scans lists the counts and scans, and downloads CSV + PDF', async ({ page }) => {
  page.on('pageerror', (err) => { throw err; });
  await loginAs(page, 'warehouse');
  await page.goto('/my-scans');
  await page.getByRole('tab', { name: /Stock Check/ }).click();
  const history = page.getByRole('list', { name: 'Scan history' });
  await expect(history.getByText(VINS[0]).first()).toBeVisible({ timeout: 15_000 });
  const [csv2] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '⬇ CSV' }).click()]);
  const hist = fs.readFileSync(await csv2.path(), 'utf8');
  expect(hist).toMatch(/^Date \(EST\),Time,By,Scanned/);
  expect(hist).toContain(VINS[0]);

  await page.getByRole('tab', { name: /Counts/ }).click();
  const list = page.getByRole('list', { name: 'Counts' });
  await expect(list.getByText(SKU).first()).toBeVisible({ timeout: 15_000 });
  await expect(list.getByText(/VINs only/).first()).toBeVisible();

  const [csv] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '⬇ CSV' }).click()]);
  const text = fs.readFileSync(await csv.path(), 'utf8');
  expect(text).toMatch(/^Count,Date \(EST\)/);
  expect(text).toContain(SKU);
  const [pdf] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '⬇ PDF' }).click()]);
  expect(pdf.suggestedFilename()).toMatch(/^stock_counts_.*\.pdf$/);
  expect(fs.readFileSync(await pdf.path()).subarray(0, 4).toString()).toBe('%PDF');
});

test('a scan fired the instant after tapping "Count this size" lands in the count', async ({ page }) => {
  page.on('pageerror', (err) => { throw err; });
  await loginAs(page, 'warehouse');
  await page.goto('/stock-check');
  const box = page.getByLabel('Scan or type a code');
  await box.fill(VINS[3]); await box.press('Enter');
  const answer = page.getByRole('region', { name: 'Answer' });
  await expect(answer.getByText('In inventory', { exact: true })).toBeVisible({ timeout: 20_000 });
  await answer.getByRole('button', { name: 'Count this size' }).click();
  // No wait: the gun fires while the count is still being started.
  await box.fill(VINS[1]); await box.press('Enter');
  const counting = page.getByRole('region', { name: 'Counting' });
  await expect(counting.getByLabel('Counted 2')).toBeVisible({ timeout: 20_000 });
  page.once('dialog', (d) => d.accept());
  await counting.getByRole('button', { name: 'Cancel' }).click();
  await expect(counting).toBeHidden({ timeout: 15_000 });
});

test('an admin sees every warehouse user’s scan history by default', async ({ page }) => {
  page.on('pageerror', (err) => { throw err; });
  await loginAs(page, 'admin');
  await page.goto('/my-scans');
  await expect(page.getByLabel('Whose scans')).toHaveValue('all');
  // Received, everyone's: the warehouse's pairs, under their name.
  const got = page.getByRole('list', { name: 'Pairs received' });
  await expect(got.locator('li').filter({ hasText: VINS[0] })).toContainText('E2E Warehouse', { timeout: 15_000 });
  await page.getByRole('tab', { name: /Stock Check/ }).click();
  const history = page.getByRole('list', { name: 'Scan history' });
  await expect(history.getByText(VINS[0]).first()).toBeVisible({ timeout: 15_000 });
  await expect(history.getByText(/E2E Warehouse/).first()).toBeVisible();     // whose scan it was
  await expect(page.getByLabel('Whose scans').locator('option', { hasText: 'E2E Warehouse' })).toHaveCount(1);
  await page.getByLabel('Whose scans').selectOption('');                       // Mine: the admin scanned nothing
  await expect(history.getByText(VINS[0])).toHaveCount(0);
  await page.getByRole('tab', { name: /Received/ }).click();                    // nor received anything
  await expect(page.getByText(VINS[0])).toHaveCount(0);
  await page.getByLabel('Whose scans').selectOption('e2e_wh');                 // one person: theirs
  await expect(got.getByText(VINS[0])).toBeVisible({ timeout: 15_000 });
});

test('a sticker no pair wears says so', async ({ page }) => {
  page.on('pageerror', (err) => { throw err; });
  await loginAs(page, 'warehouse');
  await page.goto('/stock-check');
  const box = page.getByLabel('Scan or type a code');
  await box.fill('SBM-R-999999999'); await box.press('Enter');
  await expect(page.getByRole('region', { name: 'Answer' }).getByText(/Not in inventory —/)).toBeVisible({ timeout: 20_000 });
});
