// The pre-sell guard per purchase order (PR E of docs/store-orders-plan.md, §4.9).
// Joey's manifests were wrong, so pairs that never existed were pre-sold on Alias / StockX.
//   (a) the CAP: pairs pre-listed against an order can't exceed what the order lists for
//       that SKU + size — on listing, and on raising a stock row's quantity;
//   (b) AT RISK: once the order has landed, pairs sold against it that never arrived on it
//       are orders we can't fill — shown on the Stock tab and posted to the pre-sell group
//       once per change.
// No marketplace is called here: the cap refuses before anything is listed, and raising a
// stock row's quantity never touches a platform.
import { test, expect } from '@playwright/test';
import { signToken } from '../api/_lib/util.js';
import { loadEnv, loginAs } from './helpers/auth.js';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (t, v) => pool.query(t, v).then((r) => r.rows);
const stamp = `${Date.now()}`.slice(-7);
const SUPPLIER = `E2E PresellGuard ${stamp}`;
const SKU = `E2E-PG-${stamp}`;
const PH = { Authorization: `Bearer ${signToken({ uid: 'e2e-ph', username: 'e2e_ph', name: 'E2E PH', role: 'ph_team' })}` };

test.describe.configure({ mode: 'serial' });

let po; let noList; let row9; let label; let batchId;

test.beforeAll(async () => {
  [po] = await q(`INSERT INTO purchase_orders (supplier_name, status, manifest_scope, created_by)
                  VALUES ($1, 'shipped', 'po', 'e2e') RETURNING id, po_code`, [SUPPLIER]);
  // The order lists 3 × size 9 and 2 × size 10.
  await q(`INSERT INTO po_lines (po_id, sku, size, name, qty_expected, unit_cost) VALUES
             ($1, $2, '9', 'E2E PG Shoe', 3, 100), ($1, $2, '10', 'E2E PG Shoe', 2, 100)`, [po.id, SKU]);
  [label] = await q(`INSERT INTO po_boxes (po_id, box_number, tracking_number, status) VALUES ($1, 1, $2, 'in_transit') RETURNING id`, [po.id, `PG${stamp}1`]);
  [noList] = await q(`INSERT INTO purchase_orders (supplier_name, status, created_by) VALUES ($1, 'draft', 'e2e') RETURNING id, po_code`, [SUPPLIER]);
  // 2 pairs of size 9 already pre-listed against the order.
  [row9] = await q(`INSERT INTO presell_stock (sku, size, name, qty, po_id) VALUES ($1, '9', 'E2E PG Shoe', 2, $2) RETURNING id`, [SKU, po.id]);
  await q('INSERT INTO presell_stock_po (stock_id, po_id, qty) VALUES ($1, $2, 2)', [row9.id, po.id]);
});

test.afterAll(async () => {
  await q('DELETE FROM item_events WHERE item_id IN (SELECT id FROM items WHERE sku = $1)', [SKU]);
  await q('DELETE FROM items WHERE sku = $1', [SKU]);
  await q('UPDATE purchase_orders SET received_batch_id = NULL WHERE supplier_name = $1', [SUPPLIER]);
  if (batchId) { await q('DELETE FROM batch_boxes WHERE batch_id = $1', [batchId]); await q('DELETE FROM batches WHERE id = $1', [batchId]); }
  await q('DELETE FROM presell_sales WHERE stock_id IN (SELECT id FROM presell_stock WHERE sku = $1)', [SKU]);
  await q('DELETE FROM presell_stock WHERE sku = $1', [SKU]);
  await q('DELETE FROM purchase_orders WHERE supplier_name = $1', [SUPPLIER]);
  await pool.end();
});

const create = (request, items, poId = po.id) => request.post('/api/presell-listings/create', { headers: PH,
  data: { activate: false, poId, items: items.map((x) => ({ sku: SKU, name: 'E2E PG Shoe', alias: { price: 150 }, ...x })) } });
const setQty = (request, stockId, qty) => request.post('/api/presell-listings/action', { headers: PH, data: { stockId, action: 'qty', qty } });
const listed = async (stockId, poId = po.id) => (await q('SELECT qty FROM presell_stock_po WHERE stock_id = $1 AND po_id = $2', [stockId, poId]))[0]?.qty ?? null;

test('listing more pairs than the order lists is refused, naming the order, the size and the numbers', async ({ request }) => {
  const r = await create(request, [{ size: '9', qty: 2 }]);
  expect(r.status()).toBe(409);
  const b = await r.json();
  expect(b.code).toBe('over_po');
  expect(b.error).toBe(`${po.po_code} lists 3 of ${SKU} size 9 — 2 already pre-listed, you're adding 2.`);
  // Two lines of the same size in one go count together.
  const two = await create(request, [{ size: '10', qty: 1 }, { size: '10', qty: 2 }]);
  expect(two.status()).toBe(409);
  expect((await two.json()).error).toMatch(/lists 2 of .* size 10 — 1 already pre-listed, you're adding 2/);
  // Nothing was written.
  expect(await listed(row9.id)).toBe(2);
});

test('an order with no list yet has nothing to check against — allowed, with a warning', async () => {
  const { presellPoCap } = await import('../api/_lib/db.js');
  expect(await presellPoCap(noList.id, SKU, '9')).toEqual({ hasList: false, expected: null, listed: 0 });
  // Notation doesn't fool the cap: "9W" / dashes-and-case are the same line.
  expect(await presellPoCap(po.id, SKU.toLowerCase(), '9W')).toMatchObject({ hasList: true, expected: 3, listed: 2 });
});

test('raising a stock row\'s pairs is capped by its order too; lowering is always allowed', async ({ request }) => {
  expect((await setQty(request, row9.id, 3)).status()).toBe(200);
  expect(await listed(row9.id)).toBe(3);
  const over = await setQty(request, row9.id, 4);
  expect(over.status()).toBe(409);
  expect((await over.json()).error).toMatch(/lists 3 of .* size 9 — 3 already pre-listed, you're adding 1/);
  expect((await setQty(request, row9.id, 2)).status()).toBe(200);
  expect(await listed(row9.id)).toBe(2);
});

test('a sale remembers the order it was sold against', async () => {
  const { recordPresellSale } = await import('../api/_lib/db.js');
  for (const n of [1, 2]) {
    const [l] = await q(`INSERT INTO presell_listings (stock_id, platform, price_cents, status) VALUES ($1, 'alias', 15000, 'live') RETURNING id, stock_id`, [row9.id]);
    await recordPresellSale({ listing: l, platform: 'alias', orderId: `E2EPG-${stamp}-${n}`, priceCents: 15000, payoutCents: 13000, soldAt: new Date().toISOString(), raw: {} }, 'e2e');
  }
  const sales = await q('SELECT po_id FROM presell_sales WHERE stock_id = $1', [row9.id]);
  expect(sales.map((x) => Number(x.po_id))).toEqual([Number(po.id), Number(po.id)]);
});

test('once the order lands, sold pairs that never arrived on it are at risk — said once per change', async ({ request }) => {
  const { presellPoStatus } = await import('../api/_lib/db.js');
  const { checkAtRisk } = await import('../api/_lib/presell-arrival.js');
  // One size 9 arrives, in a batch still open: the order hasn't landed, nothing is "at risk" yet.
  const [b] = await q(`INSERT INTO batches (batch_code, supplier_name, status, kind, po_id, date_received)
                       VALUES ($1, $2, 'open', 'receiving', $3, current_date) RETURNING id`, [`B-E2EPG-${stamp}`, SUPPLIER, po.id]);
  batchId = Number(b.id);
  const [bx] = await q(`INSERT INTO batch_boxes (batch_id, box_number, tracking_number, status, po_box_id) VALUES ($1, 1, $2, 'received', $3) RETURNING id`, [batchId, `PG${stamp}1`, label.id]);
  await q(`INSERT INTO items (vin, batch_id, box_id, sku, size, name, status) VALUES ($1, $2, $3, $4, '9', 'E2E PG Shoe', 'in_stock')`, [`SBM-E2EPG${stamp}1`, batchId, bx.id, SKU]);
  let [st] = (await presellPoStatus([po.id])).filter((x) => x.stock_id === Number(row9.id));
  expect(st).toMatchObject({ sold: 2, received: 1, landed: false, at_risk: 0, listed: 2, expected: 3, over_cap: false });

  // The batch is finished → every label is in → landed: 2 sold, 1 arrived → 1 at risk.
  await q(`UPDATE batches SET status = 'committed' WHERE id = $1`, [batchId]);
  [st] = (await presellPoStatus([po.id])).filter((x) => x.stock_id === Number(row9.id));
  expect(st).toMatchObject({ landed: true, at_risk: 1 });

  // The pre-sell group hears it once; the same number again is quiet.
  const posts = [];
  const send = async (lines) => { posts.push(lines); };
  const first = await checkAtRisk({ enabled: true, send });
  expect(first.map((x) => x.stock_id)).toContain(Number(row9.id));
  const text = JSON.stringify(posts[0]);
  expect(text).toContain('AT RISK');
  expect(text).toContain(`Sold 2, arrived on ${po.po_code} 1 → 1 pair at risk`);
  const again = await checkAtRisk({ enabled: true, send });
  expect(again.find((x) => x.stock_id === Number(row9.id))).toBeUndefined();
  // Off outside the one environment allowed to act (PRESELL_WATCH).
  expect(await checkAtRisk({ enabled: false, send })).toEqual([]);

  // The Stock tab carries it.
  const rows = (await (await request.get(`/api/presell-listings/list?tab=stock&q=${SKU}`, { headers: PH })).json()).rows;
  expect(rows.find((r) => Number(r.id) === Number(row9.id))).toMatchObject({ po_expected: 3, po_listed: 2, po_sold: 2, po_received: 1, at_risk: 1 });
});

test('the Stock tab shows the order\'s count and what is at risk', async ({ page }) => {
  await loginAs(page, 'ph_team');
  await page.goto(`/ph/presell-listings?tab=stock&q=${SKU}`);
  await expect(page.locator('.ap-po-cap').first()).toContainText(`${po.po_code} lists 3 · pre-listed 2`, { timeout: 15_000 });
  await expect(page.locator('.ap-po-risk.bad').first()).toContainText(`sold 2, arrived on ${po.po_code} 1 → 1 order at risk`);
});
