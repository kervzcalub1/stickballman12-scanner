// GS received as men's (receiving.md). A Grade School Jordan Retro that sells better under
// the men's product is converted by the warehouse AS IT IS RECEIVED: the pair goes in under
// the men's style code and size (GS 7Y → men's 7), and keeps the GS code + size it arrived
// as for the record (items.original_sku / original_size). The next box of the same GS code
// is offered the same men's code.
import { test, expect } from '@playwright/test';
import pg from 'pg';
import { loginAs } from './helpers/auth.js';

test.describe.configure({ mode: 'serial' });
const stamp = `${Date.now()}`.slice(-7);
const GS = `E2E-GS-${stamp}`;
const MENS = `E2E-MN-${stamp}`;
let db;

test.beforeAll(async () => {
  db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
});

test.afterAll(async () => {
  const where = 'sku = $1 OR original_sku = $2';
  await db.query(`DELETE FROM item_events WHERE item_id IN (SELECT id FROM items WHERE ${where})`, [MENS, GS]);
  const b = await db.query(`SELECT DISTINCT batch_id FROM items WHERE ${where}`, [MENS, GS]);
  await db.query(`DELETE FROM items WHERE ${where}`, [MENS, GS]);
  for (const { batch_id: id } of b.rows) await db.query('DELETE FROM batches WHERE id = $1', [id]).catch(() => {});
  await db.end();
});

// The catalogue: the GS code answers as a GS 7Y box; the men's code is the men's product.
async function stubCatalogue(page) {
  await page.route('**/api/sku-search', async (route) => {
    const { sku } = route.request().postDataJSON();
    const mens = String(sku).toUpperCase() === MENS;
    await route.fulfill({ json: { ok: true, product: mens
      ? { name: 'Air Jordan 9 Retro E2E', sku: MENS, image: '', colorway: 'White/Black', source: 'manual', sizes: ['7', '8'] }
      : { name: 'Air Jordan 9 Retro GS E2E', sku: GS, image: '', source: 'manual', scannedSize: '7Y', sizes: ['7Y'] } } });
  });
}

async function startReceive(page) {
  await loginAs(page, 'warehouse');
  await stubCatalogue(page);
  await page.goto('/receiving');
  await page.locator('label:has-text("Supplier") select').selectOption({ index: 1 });
  await page.locator('.track-field input').first().fill(`1ZGSM${stamp}${Math.floor(Math.random() * 1000)}`);
  await page.locator('.manifest-q').getByRole('button', { name: 'No' }).click();
  await page.getByRole('button', { name: 'Next →' }).click();
  for (let i = 0; i < 2; i += 1) {
    await page.locator('.scanbar input').first().fill(GS);
    await page.locator('.scanbar').getByRole('button', { name: 'Add' }).click();
  }
  const card = page.locator(`.recv-item[data-sku="${GS}"]`);
  await expect(card).toBeVisible({ timeout: 10_000 });
  return card;
}

test('a GS shoe received as men\'s goes in under the men\'s code + size, and keeps the GS one', async ({ page }) => {
  // Never received before and nothing in the catalogue (the suite never asks the real Alias).
  await page.route('**/api/items/mens-for**', (route) => route.fulfill({ json: { ok: true, mens: null, candidates: [] } }));
  const card = await startReceive(page);
  await card.getByRole('button', { name: 'As men’s…' }).click();
  const dlg = page.getByRole('dialog', { name: "Receive as men's" });
  await expect(dlg).toContainText('7Y → 7');
  await expect(dlg).toContainText('No men’s version found in the catalogue');
  await dlg.getByLabel("Men's style code").fill(MENS);
  // Not before it is looked up — the name has to come with it.
  await expect(dlg.getByRole('button', { name: 'Look it up first' })).toBeDisabled();
  await dlg.getByRole('button', { name: 'Look up' }).click();
  await expect(dlg).toContainText('Air Jordan 9 Retro E2E');
  await dlg.getByRole('button', { name: `Receive as ${MENS}` }).click();
  await expect(card.locator('.mens-chip')).toContainText(`Men’s ${MENS}`);

  await page.getByRole('button', { name: 'Review →' }).click();
  await expect(page.locator(`.recv-item[data-sku="${GS}"] .mens-chip`)).toBeVisible();   // still there on Review
  await page.getByRole('button', { name: 'Next →' }).click();
  await page.getByRole('button', { name: 'Finish batch' }).click();
  await page.getByRole('button', { name: 'Yes, commit' }).click();
  await expect(page.getByText(/^Batch .* saved$/)).toBeVisible({ timeout: 15_000 });

  const rows = (await db.query('SELECT sku, size, name, gender, colorway, original_sku, original_size FROM items WHERE original_sku = $1', [GS])).rows;
  expect(rows).toHaveLength(2);
  for (const r of rows) {
    expect(r).toMatchObject({ sku: MENS, size: '7', name: 'Air Jordan 9 Retro E2E', gender: 'Men', colorway: 'White/Black', original_sku: GS, original_size: '7Y' });
  }
  // Nothing went in under the GS code itself.
  expect((await db.query('SELECT count(*)::int AS n FROM items WHERE sku = $1', [GS])).rows[0].n).toBe(0);
});

test('the next box of that GS code is offered the same men\'s code; "Keep as GS" undoes it', async ({ page }) => {
  const card = await startReceive(page);
  await card.getByRole('button', { name: 'As men’s…' }).click();
  const dlg = page.getByRole('dialog', { name: "Receive as men's" });
  await expect(dlg.getByLabel("Men's style code")).toHaveValue(MENS);
  await expect(dlg).toContainText(`Last time ${GS} was received as men’s`);
  // A size Alias won't take as men's stays GS.
  await dlg.locator('.mens-sizes label', { hasText: '7Y' }).click();
  await expect(dlg.getByRole('button', { name: `Receive as ${MENS}` })).toBeDisabled();   // nothing left to convert
  await dlg.locator('.mens-sizes label', { hasText: '7Y' }).click();
  await dlg.getByRole('button', { name: `Receive as ${MENS}` }).click();
  await expect(card.locator('.mens-chip')).toBeVisible();
  await card.locator('.mens-chip').click();
  await page.getByRole('dialog', { name: "Receive as men's" }).getByRole('button', { name: 'Keep as GS' }).click();
  await expect(card.getByRole('button', { name: 'As men’s…' })).toBeVisible();
});

// The first box of a GS code nobody has converted before: the men's code is FOUND in the
// catalogue (the men's product with the same name minus "GS") — the warehouse can't read it
// off a GS box. Offered, ready to confirm in one tap; or, when the names don't agree
// exactly, the men's results are listed to pick from.
test('the first time, the men\'s code is found in the catalogue and offered', async ({ page }) => {
  await page.route('**/api/items/mens-for**', (route) => route.fulfill({ json: { ok: true,
    mens: { sku: 'IW3808-400', name: "Air Jordan 13 Retro 'Flint' 2026", image: '', colorway: 'Navy', source: 'catalogue' }, candidates: [] } }));
  const card = await startReceive(page);
  await card.getByRole('button', { name: 'As men’s…' }).click();
  const dlg = page.getByRole('dialog', { name: "Receive as men's" });
  await expect(dlg.getByLabel("Men's style code")).toHaveValue('IW3808-400');
  await expect(dlg).toContainText('Found in the Alias catalogue');
  await expect(dlg).toContainText("Air Jordan 13 Retro 'Flint' 2026");
  await expect(dlg.getByRole('button', { name: 'Receive as IW3808-400' })).toBeEnabled();   // no Look up needed
  await dlg.getByRole('button', { name: 'Cancel' }).click();
});

test('when the names don\'t agree exactly, the men\'s results are listed to pick from', async ({ page }) => {
  await page.route('**/api/items/mens-for**', (route) => route.fulfill({ json: { ok: true, mens: null, candidates: [
    { sku: 'DZ5485-612', name: "Air Jordan 1 Retro High OG 'Chicago Lost & Found'", image: '', colorway: null },
    { sku: '555088-160', name: "Air Jordan 1 Retro High OG 'Phantom'", image: '', colorway: null },
  ] } }));
  const card = await startReceive(page);
  await card.getByRole('button', { name: 'As men’s…' }).click();
  const dlg = page.getByRole('dialog', { name: "Receive as men's" });
  await expect(dlg.getByLabel("Men's style code")).toHaveValue('');
  await dlg.locator('.mens-cand', { hasText: 'DZ5485-612' }).click();
  await expect(dlg.getByLabel("Men's style code")).toHaveValue('DZ5485-612');
  await expect(dlg.locator('.mens-cands')).toHaveCount(0);
  await expect(dlg.getByRole('button', { name: 'Receive as DZ5485-612' })).toBeEnabled();
  await dlg.getByRole('button', { name: 'Cancel' }).click();
});

// The supplier's manifest names the GS code. Pairs received as men's are still the pairs
// it promised — reconciliation counts them by what the box said (original_sku / size).
test('a PO that expected GS pairs reconciles clean when they were received as men\'s', async ({ page }) => {
  const po = (await db.query(
    `INSERT INTO purchase_orders (po_code, status, supplier_name, manifest_scope) VALUES ($1,'receiving','E2E GS Co','po') RETURNING id`,
    [`PO-GSM-${stamp}`])).rows[0].id;
  await db.query(`INSERT INTO po_lines (po_id, sku, size, qty_expected, name) VALUES ($1,$2,'7Y',2,'AJ9 GS')`, [po, GS]);
  const batch = (await db.query(
    `INSERT INTO batches (batch_code, status, kind, supplier_name, po_id) VALUES ($1,'committed','receiving','E2E GS Co',$2) RETURNING id`,
    [`B-GSM-${stamp}`, po])).rows[0].id;
  for (const n of [1, 2]) {
    await db.query(`INSERT INTO items (vin, batch_id, name, sku, size, original_sku, original_size, status)
                    VALUES ($1,$2,'AJ9',$3,'7',$4,'7Y','needs_shelf')`, [`SBM-999997-${stamp}${n}`, batch, MENS, GS]);
  }
  try {
    await loginAs(page, 'warehouse');
    await page.goto('/');
    const r = await page.evaluate(async (id) => {
      const res = await fetch(`/api/po/reconciliation?poId=${id}`, { headers: { authorization: `Bearer ${sessionStorage.getItem('sb_session_token')}` } });
      return res.json();
    }, po);
    expect(r.summary).toMatchObject({ expected_units: 2, received_units: 2, shortage: 0, overage: 0 });
  } finally {
    await db.query('DELETE FROM items WHERE batch_id = $1', [batch]);
    await db.query('DELETE FROM batches WHERE id = $1', [batch]);
    await db.query('DELETE FROM po_lines WHERE po_id = $1', [po]);
    await db.query('DELETE FROM purchase_orders WHERE id = $1', [po]);
  }
});
