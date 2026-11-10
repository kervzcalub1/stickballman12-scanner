// Costs → Cost lookup (2026-11-11): search a SKU, see every time we bought it — supplier
// PO lines AND online order lines — with what one pair actually cost. What has to hold:
//   · a PO line's cost is the shelf price through the supplier's preset (the same
//     landedFromShelf receiving uses); a supplier with NO preset shows no cost, never
//     the shelf price;
//   · the same SKU + size + price spread over two labels is ONE row, quantities summed;
//   · an online line's cost is orderCosts' actual cost (coupon, tax split in);
//   · the SKU matches with spaces/dashes ignored; read-only roles only (no supplier).
import { test, expect } from '@playwright/test';
import pg from 'pg';
import { loadEnv, loginAs } from './helpers/auth.js';
import { signToken } from '../api/_lib/util.js';
import { landedFromShelf } from '../src/lib/costs.js';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, values) => pool.query(text, values).then((r) => r.rows);

const stamp = `${Date.now()}`.slice(-6);
const SKU = `E2E-CL-${stamp}`;
const SUPPLIER = `E2E CL Supplier ${stamp}`;
const NP_SUPPLIER = `E2E CL NoPreset ${stamp}`;
const PRESET = { tipAmt: 5, shippingAmt: 8.25, taxPct: 8.25, giftPct: 8, storePct: 0, promoPct: 0, cashbackPct: 0 };
const auth = (role) => ({ Authorization: `Bearer ${signToken({ uid: `e2e-cl-${role}`, username: `e2e_cl_${role}`, name: `E2E CL ${role}`, role })}` });
let presetId; let poId; let npPoId; let orderId;

test.beforeAll(async ({ request }) => {
  const [p] = await q(
    `INSERT INTO payout_presets (name, tip_amt, shipping_amt, tax_pct, gift_pct, supplier_name)
     VALUES ($1, 5, 8.25, 8.25, 8, $2) RETURNING id`, [`E2E CL Stack ${stamp}`, SUPPLIER]);
  presetId = Number(p.id);
  const [po] = await q(`INSERT INTO purchase_orders (po_code, supplier_name, status, date_of_purchase)
                        VALUES ($1, $2, 'shipped', '2026-10-02') RETURNING id`, [`PO-E2ECL-${stamp}`, SUPPLIER]);
  poId = Number(po.id);
  const [l1] = await q(`INSERT INTO po_boxes (po_id, box_number, tracking_number, status) VALUES ($1, 1, $2, 'shipped') RETURNING id`, [poId, `CLA${stamp}`]);
  const [l2] = await q(`INSERT INTO po_boxes (po_id, box_number, tracking_number, status) VALUES ($1, 2, $2, 'shipped') RETURNING id`, [poId, `CLB${stamp}`]);
  await q(`INSERT INTO po_lines (po_id, po_box_id, sku, size, name, qty_expected, unit_cost) VALUES
             ($1, $2, $4, '9',  'E2E CL Shoe', 2, 150),
             ($1, $3, $4, '9',  'E2E CL Shoe', 1, 150),
             ($1, $3, $4, '10', 'E2E CL Shoe', 1, 120)`, [poId, l1.id, l2.id, SKU]);
  const [np] = await q(`INSERT INTO purchase_orders (po_code, supplier_name, status, date_of_purchase)
                        VALUES ($1, $2, 'shipped', '2026-09-01') RETURNING id`, [`PO-E2ECLN-${stamp}`, NP_SUPPLIER]);
  npPoId = Number(np.id);
  const [nl] = await q(`INSERT INTO po_boxes (po_id, box_number, tracking_number, status) VALUES ($1, 1, $2, 'shipped') RETURNING id`, [npPoId, `CLN${stamp}`]);
  await q(`INSERT INTO po_lines (po_id, po_box_id, sku, size, name, qty_expected, unit_cost)
           VALUES ($1, $2, $3, '9', 'E2E CL Shoe', 1, 80)`, [npPoId, nl.id, SKU]);
  // 2 × $100 with a $20 coupon and $16 tax → $98 a pair.
  const r = await request.post('/api/online-orders/save', { headers: auth('ph_team'), data: {
    store: 'E2E-CL Store', ordered_on: '2026-11-03', coupon: 20, tax: 16,
    lines: [{ sku: SKU, name: 'E2E CL Shoe', size: '9', qty: 2, unit_price: 100 }],
  } });
  expect(r.ok(), await r.text()).toBeTruthy();
  orderId = (await r.json()).id;
});

test.afterAll(async () => {
  await q('DELETE FROM po_lines WHERE po_id = ANY($1)', [[poId, npPoId]]);
  await q('DELETE FROM po_boxes WHERE po_id = ANY($1)', [[poId, npPoId]]);
  await q('DELETE FROM purchase_orders WHERE id = ANY($1)', [[poId, npPoId]]);
  await q('DELETE FROM payout_presets WHERE id = $1', [presetId]);
  await q(`DELETE FROM online_orders WHERE store = 'E2E-CL Store'`);
  await pool.end();
});

test('a SKU search returns PO + online lines with the actual cost of a pair', async ({ request }) => {
  // Typed with a space where the dash is — the way a code gets copied off a box.
  const res = await request.get(`/api/items/cost-lookup?q=${encodeURIComponent(SKU.replace(/-/g, ' ').toLowerCase())}`, { headers: auth('ph_team') });
  expect(res.ok(), await res.text()).toBeTruthy();
  const { rows } = await res.json();
  const mine = rows.filter((r) => r.sku === SKU);
  expect(mine).toHaveLength(4);

  const po9 = mine.find((r) => r.source === 'po' && r.size === '9' && r.paid === 150);
  expect(po9.qty).toBe(3);                                   // two labels, one row
  expect(po9.cost).toBeCloseTo(landedFromShelf(150, null, PRESET), 2);
  expect(po9.bought_on).toBe('2026-10-02');

  const noPreset = mine.find((r) => r.source === 'po' && r.paid === 80);
  expect(noPreset.cost).toBeNull();                          // never the shelf price
  expect(noPreset.note).toMatch(/No preset/);

  const online = mine.find((r) => r.source === 'online');
  expect(online.ref).toBe(`OO-${String(orderId).padStart(4, '0')}`);
  expect(online.paid).toBe(100);
  expect(online.cost).toBe(98);
  expect(online.qty).toBe(2);
  // Newest first.
  expect(mine[0].source).toBe('online');
});

test('a supplier cannot read it', async ({ request }) => {
  const res = await request.get(`/api/items/cost-lookup?q=${SKU}`, { headers: auth('supplier') });
  expect(res.status()).toBe(403);
});

test('the Costs page Cost lookup tab shows the sheet, the by-size summary and the source filter', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.goto('/costs');
  await page.getByRole('tab', { name: /Cost lookup/ }).click();
  await page.getByLabel('Search a SKU or shoe name').fill(SKU);
  await page.getByRole('button', { name: 'Find' }).click();

  const sheet = page.locator('.cl-sheet tbody tr');
  await expect(sheet).toHaveCount(4);
  const summary = page.locator('.cl-summary tbody tr');
  await expect(summary).toHaveCount(2);                       // US 9, US 10
  await expect(summary.first()).toContainText('US 9');
  await expect(summary.first()).toContainText('$98.00');     // latest = the online order (11/03)
  await expect(summary.first()).toContainText('(1 no cost)'); // the no-preset pair

  await page.getByRole('tab', { name: /Online orders/ }).click();
  await expect(sheet).toHaveCount(1);
  await expect(sheet.first()).toContainText('E2E-CL Store');

  // A refresh keeps the search and the filter.
  await page.reload();
  await expect(page.getByLabel('Search a SKU or shoe name')).toHaveValue(SKU);
  await expect(sheet).toHaveCount(1);

  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /CSV/ }).click()]);
  expect(dl.suggestedFilename()).toMatch(/^costs-E2E-CL-\d+-\d{4}-\d{2}-\d{2}\.csv$/);
});
