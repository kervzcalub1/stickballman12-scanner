// Filtering the Batch page by date, supplier and purchase order (2026-08-28).
//
// The filters are SERVER-side (the list is paged there), carried in the URL like the
// search, and applied to the open-batches card too — that one arrives whole from its own
// endpoint, so leaving it alone would show a card full of batches the filter excludes
// directly above one that honours it.
import { test, expect } from '@playwright/test';
import { loadEnv, loginAs } from './helpers/auth.js';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, values) => pool.query(text, values).then((r) => r.rows);

const stamp = `${Date.now()}`.slice(-8);
const SUP_A = `ZZ FiltA ${stamp}`;
const SUP_B = `ZZ FiltB ${stamp}`;
const OLD_DAY = '2026-03-04';
const NEW_DAY = '2026-08-21';
let poId = null; let poCode = null; const ids = [];

const mkBatch = async (code, supplier, day, po = null, status = 'committed') => {
  const id = Number((await q(
    `INSERT INTO batches (batch_code, status, kind, supplier_name, date_received, po_id)
     VALUES ($1,$2,'receiving',$3,$4,$5) RETURNING id`,
    [code, status, supplier, day, po]))[0].id);
  ids.push(id);
  return id;
};

test.beforeAll(async () => {
  poCode = `PO-FILT-${stamp}`;
  poId = Number((await q(
    `INSERT INTO purchase_orders (po_code, status, supplier_name) VALUES ($1,'receiving','ZZ Filt') RETURNING id`,
    [poCode]))[0].id);
  await mkBatch(`B-FA-${stamp}`, SUP_A, OLD_DAY);              // old · A · no PO
  await mkBatch(`B-FB-${stamp}`, SUP_A, NEW_DAY);              // new · A · no PO
  await mkBatch(`B-FC-${stamp}`, SUP_B, NEW_DAY, poId);        // new · B · on the PO
  await mkBatch(`B-FD-${stamp}`, SUP_B, NEW_DAY, null, 'open');// open, so it lands in the other card
});

test.afterAll(async () => {
  await q('DELETE FROM batches WHERE id = ANY($1)', [ids]);
  await q('DELETE FROM purchase_orders WHERE id = $1', [poId]);
  await pool.end();
});

const count = async (request, qs) => {
  const r = await request.get(`/api/batches/list?kind=receiving&excludeOpen=1&${qs}`, {
    headers: { Authorization: `Bearer ${(await import('../api/_lib/util.js')).signToken({ uid: 'e2e-wh', username: 'e2e_wh', name: 'W', role: 'warehouse' })}` },
  });
  return (await r.json()).total;
};

test('each filter narrows the list, and they combine', async ({ request }) => {
  const all = await count(request, `supplier=${encodeURIComponent(SUP_A)}`);
  expect(all).toBe(2);
  // Date filters read the day the row DISPLAYS — date_received when set.
  expect(await count(request, `supplier=${encodeURIComponent(SUP_A)}&from=${NEW_DAY}`)).toBe(1);
  expect(await count(request, `supplier=${encodeURIComponent(SUP_A)}&to=${OLD_DAY}`)).toBe(1);
  expect(await count(request, `po=${poCode}`)).toBe(1);
  // Combining is an AND: supplier A has nothing on that order.
  expect(await count(request, `supplier=${encodeURIComponent(SUP_A)}&po=${poCode}`)).toBe(0);
});

test('"Not against a PO" is its own answer, not the absence of one', async ({ request }) => {
  const onPo = await count(request, `supplier=${encodeURIComponent(SUP_B)}&po=${poCode}`);
  const offPo = await count(request, `supplier=${encodeURIComponent(SUP_B)}&po=none`);
  expect(onPo).toBe(1);
  expect(offPo).toBe(0);   // B's only closed batch IS on the order
  expect(await count(request, `supplier=${encodeURIComponent(SUP_A)}&po=none`)).toBe(2);
});

test('a blank filter is no filter — an empty date must not become an empty match', async ({ request }) => {
  expect(await count(request, `supplier=${encodeURIComponent(SUP_A)}&from=&to=&po=`)).toBe(2);
});

test('the filters survive a refresh and narrow both cards', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.goto('/batches');
  await page.getByLabel('Supplier').selectOption(SUP_B);
  await expect(page).toHaveURL(/supplier=/);
  // The OPEN card obeys it too — B has one open batch, A has none.
  const openCard = page.locator('.card').filter({ has: page.getByRole('heading', { name: /^Open batches/ }) });
  await expect(openCard.locator('.batch-nav-row')).toHaveCount(1);
  await page.reload();
  await expect(page.getByLabel('Supplier')).toHaveValue(SUP_B);
  await expect(openCard.locator('.batch-nav-row')).toHaveCount(1);

  await page.getByLabel('Supplier').selectOption(SUP_A);
  await expect(openCard.locator('.batch-nav-row')).toHaveCount(0);
});

test('filtering while on a later page goes back to page 1', async ({ page }) => {
  // Narrowing while on page 4 of a 2-page result shows an empty list that reads as
  // "nothing matches" when the filter really has results.
  await loginAs(page, 'warehouse');
  await page.goto('/batches?p=3');
  await page.getByLabel('Supplier').selectOption(SUP_A);
  await expect(page).not.toHaveURL(/[?&]p=3/);
  const recentCard = page.locator('.card').filter({ has: page.getByRole('heading', { name: 'Recent batches' }) });
  await expect(recentCard.locator('.batch-nav-row')).toHaveCount(2);
});

test('Clear filters puts everything back', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.goto(`/batches?supplier=${encodeURIComponent(SUP_A)}&from=${NEW_DAY}`);
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page.getByLabel('Supplier')).toHaveValue('');
  await expect(page.getByLabel('Received from')).toHaveValue('');
});

test('a search inside a filter stays inside it', async ({ page }) => {
  // Otherwise narrowing the list and then searching would quietly widen it again.
  await loginAs(page, 'warehouse');
  await page.goto(`/batches?supplier=${encodeURIComponent(SUP_A)}`);
  await page.locator('.batch-search input').fill(`B-FC-${stamp}`);   // belongs to supplier B
  await expect(page.getByText('No batch carries that number')).toBeVisible();
  await page.goto(`/batches?supplier=${encodeURIComponent(SUP_B)}`);
  await page.locator('.batch-search input').fill(`B-FC-${stamp}`);
  await expect(page.locator('.batch-nav-row')).toHaveCount(1);
});
