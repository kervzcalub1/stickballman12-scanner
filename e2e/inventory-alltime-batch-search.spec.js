// Two finds that used to need a workaround (owner, 2026-11-21):
//   1. Inventory → "All time": no date filter at all, so a SKU or a shoe's name is searched
//      across everything ever received — and the date bar SAYS so, a refresh keeps it, and a
//      list cut at the cap says it was cut.
//   2. Batches → the search box also finds a batch by a SKU inside it, by the PO it was
//      received against, and by the online order it came from (OO code or the store's
//      order number) — and each row says why it matched.
import { test, expect } from '@playwright/test';
import { loadEnv, loginAs } from './helpers/auth.js';
import { signToken } from '../api/_lib/util.js';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, values) => pool.query(text, values).then((r) => r.rows);
const stamp = `${Date.now()}`.slice(-7);
const SKU = `EA${stamp}-001`;                 // searched as typed, lower-cased, and without the dash
const NAME = `E2E Alltime Runner ${stamp}`;
const TRACK = `1ZE2EALL${stamp}XQ7K`;           // its tail is in no SKU or order number here
const ORDER_NO = `E2EORD${stamp}`;
const SUPPLIER = `E2E Alltime ${stamp}`;
const auth = () => ({ Authorization: `Bearer ${signToken({ uid: 'e2e-wh', username: 'e2e_wh', name: 'E2E Warehouse', role: 'warehouse' })}` });
let batch = null; let po = null; let oo = null; let other = null;

test.beforeAll(async () => {
  // A batch received long ago (so "this week" cannot hold it), against a PO, whose tracking
  // number is an online order's.
  po = (await q(`INSERT INTO purchase_orders (supplier_name) VALUES ($1) RETURNING id, po_code`, [SUPPLIER]))[0];
  batch = (await q(
    `INSERT INTO batches (batch_code, status, kind, supplier_name, tracking_number, date_received, po_id, created_at)
     VALUES ($1,'committed','receiving',$2,$3,'2025-01-15',$4,'2025-01-15T15:00:00Z') RETURNING id, batch_code`,
    [`B-ALL-${stamp}`, SUPPLIER, TRACK, po.id]))[0];
  await q(`INSERT INTO items (vin, batch_id, name, sku, size, status, created_at)
           VALUES ($1,$3,$4,$5,'9','needs_shelf','2025-01-15T15:00:00Z'), ($2,$3,$4,$5,'10','needs_shelf','2025-01-15T15:00:00Z')`,
    [`SBM-250115-9${stamp.slice(-5)}`, `SBM-250115-8${stamp.slice(-5)}`, batch.id, NAME, SKU]);
  oo = (await q(`INSERT INTO online_orders (store, order_number, tracking_number) VALUES ('E2E Shop',$1,$2) RETURNING id`, [ORDER_NO, TRACK.toLowerCase()]))[0];
  // A second batch that matches NONE of it — a search must not return everything.
  other = (await q(`INSERT INTO batches (batch_code, status, kind, supplier_name, tracking_number) VALUES ($1,'committed','receiving',$2,$3) RETURNING id, batch_code`,
    [`B-OTH-${stamp}`, SUPPLIER, `1ZOTHER${stamp}`]))[0];
});

test.afterAll(async () => {
  await q('DELETE FROM items WHERE batch_id = $1', [batch.id]);
  await q('DELETE FROM batches WHERE id = ANY($1)', [[batch.id, other.id]]);
  await q('DELETE FROM online_orders WHERE id = $1', [oo.id]);
  await q('DELETE FROM purchase_orders WHERE id = $1', [po.id]);
  await pool.end();
});

test.describe('Inventory → All time', () => {
  test('All time drops the date filter, says so, survives a refresh, and a date narrows it again', async ({ page }) => {
    page.on('pageerror', (err) => { throw err; });
    await loginAs(page, 'warehouse');
    await page.goto(`/inventory?supplier=${encodeURIComponent(SUPPLIER)}`);
    const rows = page.locator('.inv-trow, .dcard').filter({ hasText: SKU });
    // This week, this supplier: the 2025 pairs are not in it.
    await expect(page.getByRole('button', { name: 'Week', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('No items in this range.')).toBeVisible();

    await page.getByRole('button', { name: 'All time', exact: true }).click();
    await expect(rows.first()).toBeVisible();
    await expect(page.locator('[data-inv-alltime]')).toHaveText('Every date — no date filter');
    await expect(page).toHaveURL(/period=all/);
    await expect(page).not.toHaveURL(/from=|to=/);
    await expect(page.getByRole('button', { name: 'Previous' })).toHaveCount(0);   // nothing to step through

    await page.reload();
    await expect(page.getByRole('button', { name: 'All time', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(rows.first()).toBeVisible();

    // Back to a period is a deliberate narrowing: honoured.
    await page.getByRole('button', { name: 'Month', exact: true }).click();
    await expect(rows).toHaveCount(0);
    await expect(page.locator('[data-inv-alltime]')).toHaveCount(0);

    // A typed search widens to all time, as it always did — and now the bar shows it.
    await page.goto('/inventory');
    await page.getByPlaceholder(/Scan a VIN or shelf/i).fill(NAME);
    await page.getByRole('button', { name: 'Go', exact: true }).click();
    await expect(rows.first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'All time', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-inv-capped]')).toHaveCount(0);
  });

  test('a list cut at the cap says so; a narrow one does not', async ({ request, page }) => {
    const narrow = await (await request.get(`/api/items/query?q=${SKU}`, { headers: auth() })).json();
    expect(narrow).toMatchObject({ ok: true, capped: false, limit: 2000 });
    expect(narrow.rows).toHaveLength(2);
    // The page's side of it, with the answer stubbed (CI's database is nowhere near 2,000 pairs).
    await loginAs(page, 'warehouse');
    await page.route('**/api/items/query**', async (route) => {
      const real = await (await route.fetch()).json();
      await route.fulfill({ json: { ...real, capped: true, limit: 2000 } });
    });
    await page.goto(`/inventory?period=all&q=${SKU}`);
    await expect(page.locator('[data-inv-capped]')).toContainText('Showing the first 2,000 pairs');
  });
});

test.describe('Batches → search by SKU, PO and online order', () => {
  const find = async (request, term, token = auth()) => (await (await request.get(`/api/batches/list?kind=receiving&q=${encodeURIComponent(term)}`, { headers: token })).json());

  test('the server finds the batch each way, says why, and matches nothing it should not', async ({ request }) => {
    const ooCode = `OO-${String(oo.id).padStart(4, '0')}`;
    for (const term of [SKU, SKU.toLowerCase(), SKU.replace('-', ' '), SKU.slice(0, 7)]) {
      const r = await find(request, term);
      const hit = r.batches.find((b) => b.batch_code === batch.batch_code);
      expect(hit, term).toBeTruthy();
      expect(hit.matched_skus, term).toBe(`${SKU} × 2`);
      expect(r.batches.some((b) => b.batch_code === other.batch_code), term).toBe(false);
    }
    for (const term of [po.po_code, po.po_code.replace('-', ''), po.po_code.toLowerCase()]) {
      const r = await find(request, term);
      expect(r.batches.map((b) => b.batch_code), term).toContain(batch.batch_code);
      expect(r.batches.find((b) => b.batch_code === batch.batch_code).po_code).toBe(po.po_code);
      expect(r.batches.some((b) => b.batch_code === other.batch_code), term).toBe(false);
    }
    for (const term of [ooCode, `OO-${oo.id}`, `oo${oo.id}`, ORDER_NO, ORDER_NO.toLowerCase()]) {
      const r = await find(request, term);
      const hit = r.batches.find((b) => b.batch_code === batch.batch_code);
      expect(hit, term).toBeTruthy();
      expect(hit.matched_oo, term).toBe(`${ooCode} · #${ORDER_NO}`);
      expect(r.batches.some((b) => b.batch_code === other.batch_code), term).toBe(false);
    }
    // The old ways still work, and say nothing extra.
    const byTrack = await find(request, TRACK.slice(-7));
    expect(byTrack.batches.find((b) => b.batch_code === batch.batch_code)).toMatchObject({ matched_skus: null, matched_oo: null });
    expect((await find(request, batch.batch_code)).total).toBe(1);
    // Two characters never search SKUs, POs or orders; a made-up term finds nothing.
    expect((await find(request, `ZZNOPE${stamp}`)).total).toBe(0);
    expect((await find(request, SKU.slice(0, 2))).batches.every((b) => !b.matched_skus)).toBe(true);
  });

  test('the page: type a SKU, a PO, an online order — the row says why it is there', async ({ page }) => {
    page.on('pageerror', (err) => { throw err; });
    await loginAs(page, 'warehouse');
    await page.goto('/batches');
    const box = page.getByLabel('Search batches by tracking number, batch code, SKU, PO or online order');
    const hit = page.locator('.batch-nav-row').filter({ hasText: batch.batch_code });
    await box.fill(SKU);
    await expect(hit).toHaveCount(1);
    await expect(hit.locator('[data-batch-why]')).toContainText(`SKU ${SKU} × 2`);
    await expect(hit.locator('[data-batch-why]')).toContainText(po.po_code);
    await expect(page.locator('.batch-nav-row').filter({ hasText: other.batch_code })).toHaveCount(0);
    await box.fill(po.po_code);
    await expect(hit).toHaveCount(1);
    await box.fill(`OO-${oo.id}`);
    await expect(hit.locator('[data-batch-why]')).toContainText(`Online order OO-${String(oo.id).padStart(4, '0')} · #${ORDER_NO}`);
    await box.fill(`ZZNOPE${stamp}`);
    await expect(page.getByText('No batch matches that.')).toBeVisible();
  });
});
