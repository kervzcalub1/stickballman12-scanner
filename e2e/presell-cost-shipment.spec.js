// Pre-sell Listings — cost & shipment after listing, net on the sale post, date-filtered
// reports, PO link on Inbound (docs/context/presell-listings.md, 2026-10-10). Nothing here
// reaches a marketplace or Telegram: rows are written straight to our tables and the sale
// post goes to a fake.
import { test, expect } from '@playwright/test';
import pg from 'pg';
import { signToken } from '../api/_lib/util.js';
import { loadEnv, loginAs } from './helpers/auth.js';
import { parseTrackingList, saleNet } from '../src/lib/presellDetails.js';
import { landedFromShelf } from '../src/lib/costs.js';
import { stockReportCsv, salesReportCsv } from '../src/lib/presellReport.js';

loadEnv();
test.describe.configure({ mode: 'serial' });
const stamp = `${Date.now()}`.slice(-7);
const SKU = `QACS-${stamp}`;
const as = (role) => ({ Authorization: `Bearer ${signToken({ uid: `e2e-${role}`, username: `e2e-${role}`, name: `E2E ${role}`, role })}` });
let db; let S;
const STACK = { preset: 'QA Preset', presetId: null, taxPct: 8.875, giftPct: 0, storePct: 10, promoPct: 0, cashbackPct: 0, tipAmt: 2, shippingAmt: 3 };

test.beforeAll(async () => {
  db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  S = await import('../api/_lib/db.js');
});
test.afterAll(async () => {
  if (!db) return;
  await db.query(`DELETE FROM presell_sales WHERE order_id LIKE $1`, [`QACS-${stamp}%`]);
  await db.query(`DELETE FROM presell_stock WHERE sku = $1`, [SKU]);
  await db.end();
});

test('tracking numbers paste in any shape; words and duplicates are left out', () => {
  expect(parseTrackingList('1Z999AA10123456784\n1z999aa10123456784, 9400111899223197428490; UPS tracking: 773912345678')).toEqual([
    '1Z999AA10123456784', '9400111899223197428490', '773912345678',
  ]);
  expect(parseTrackingList('')).toEqual([]);
  expect(parseTrackingList(['ABCDEFGHIJ', '12345'])).toEqual([]);   // no digits / too short
});

test('net = payout − cost; no cost → no net (never a $0 cost)', () => {
  expect(saleNet({ platform: 'alias', price_cents: 17500, payout_cents: 16275, unit_cost: '120.50' })).toMatchObject({ payout: 162.75, cost: 120.5, profit: 42.25, estimated: false });
  expect(saleNet({ platform: 'alias', price_cents: 17400, payout_cents: 16182, unit_cost: null })).toMatchObject({ payout: 161.82, cost: null, profit: null });
  expect(saleNet({ platform: 'stockx', price_cents: 20000, payout_cents: null, unit_cost: 150 })).toMatchObject({ payout: 180, estimated: true, profit: 30 });
});

test('✎ details: fix a cost after listing, then tracking — one never wipes the other', async ({ request }) => {
  const a = await S.upsertPresellStock({ sku: SKU, size: '9', name: 'QA Cost Shoe', addQty: 3 }, 'e2e');
  const b = await S.upsertPresellStock({ sku: SKU, size: '10', name: 'QA Cost Shoe', addQty: 2 }, 'e2e');
  const act = (data) => request.post('/api/presell-listings/action', { headers: as('warehouse'), data: { action: 'details', ...data } });
  // A cost the server computes itself, per size's shelf price.
  const r = await act({ stockIds: [a.id, b.id], cost: { costStack: STACK, shelf: { [a.id]: 110, [b.id]: 120 } } });
  expect(r.status()).toBe(200);
  let rows = (await db.query(`SELECT id, shelf_price, unit_cost, cost_stack FROM presell_stock WHERE id = ANY($1) ORDER BY size`, [[a.id, b.id]])).rows;
  expect(Number(rows.find((x) => x.id === a.id).unit_cost)).toBe(landedFromShelf(110, null, STACK));
  expect(Number(rows.find((x) => x.id === b.id).unit_cost)).toBe(landedFromShelf(120, null, STACK));
  expect(rows[0].cost_stack.preset).toBe('QA Preset');
  // Tracking + supplier only: the cost stays.
  expect((await act({ stockIds: [a.id, b.id], supplier: 'QA Supplier', trackingNumbers: '1Z999AA10123456784 1Z999AA10123456785' })).status()).toBe(200);
  rows = (await db.query(`SELECT unit_cost, supplier, tracking_numbers FROM presell_stock WHERE id = $1`, [a.id])).rows;
  expect(Number(rows[0].unit_cost)).toBe(landedFromShelf(110, null, STACK));
  expect(rows[0]).toMatchObject({ supplier: 'QA Supplier', tracking_numbers: ['1Z999AA10123456784', '1Z999AA10123456785'] });
  // Shelf without a preset → shelf kept, cost blank (owner's rule).
  await act({ stockIds: [b.id], cost: { costStack: null, shelf: { [b.id]: 99 } } });
  rows = (await db.query(`SELECT shelf_price, unit_cost FROM presell_stock WHERE id = $1`, [b.id])).rows;
  expect(rows[0]).toMatchObject({ shelf_price: '99.00', unit_cost: null });
  // Refused: nothing to change, a PO that doesn't exist, a supplier account.
  expect((await act({ stockIds: [a.id] })).status()).toBe(400);
  expect((await act({ stockIds: [a.id], poId: 999999999 })).status()).toBe(400);
  expect((await request.post('/api/presell-listings/action', { headers: as('supplier'), data: { action: 'details', stockIds: [a.id], supplier: 'x' } })).status()).toBe(403);
});

test('the sale post carries cost → NET when a cost is entered, and says so when not', async () => {
  const { handleSale } = await import('../api/_lib/presell.js');
  const sale = async (size, cost) => {
    const st = await S.upsertPresellStock({ sku: SKU, size, name: 'QA Cost Shoe', addQty: 5, supplier: 'QA Supplier', trackingNumbers: ['1Z999AA10123456799'] }, 'e2e');
    if (cost) await S.updatePresellStockDetails(st.id, { shelf_price: 110, unit_cost: landedFromShelf(110, null, STACK), cost_stack: STACK }, 'e2e');
    const { rows } = await db.query(`INSERT INTO presell_listings (stock_id, platform, external_id, price_cents, status) VALUES ($1, 'alias', $2, 17500, 'live') RETURNING *`, [st.id, `${SKU}-sale-${size}`]);
    const sent = [];
    await handleSale({ listing: rows[0], platform: 'alias', orderId: `QACS-${stamp}-${size}`, priceCents: 17500, payoutCents: 16275, soldAt: new Date().toISOString(), raw: {} },
      { notify: async (lines) => { sent.push(lines.map((l) => (typeof l === 'string' ? l : l.b)).join('\n')); } });
    return sent[0];
  };
  const withCost = await sale('11', true);
  const net = Math.round((162.75 - landedFromShelf(110, null, STACK)) * 100) / 100;
  expect(withCost).toContain('Price: $175 → payout $162.75');
  expect(withCost).toContain(`Cost: $${landedFromShelf(110, null, STACK)}`);
  expect(withCost).toContain('shelf $110 · QA Preset');
  expect(withCost).toContain(`NET $${net}`);
  expect(withCost).toContain('Supplier: QA Supplier');
  const without = await sale('12', false);
  expect(without).toContain('Cost: not entered');
  expect(without).not.toContain('NET');
});

test('date filters: sales by the day sold, stock by the day listed; the reports read the same rows', async ({ request }) => {
  const h = { headers: as('ph_team') };
  await db.query(`UPDATE presell_sales SET sold_at = '2026-01-15T15:00:00Z' WHERE order_id = $1`, [`QACS-${stamp}-11`]);
  const jan = (await (await request.get('/api/presell-listings/list?tab=sales&from=2026-01-15&to=2026-01-15', h)).json()).rows;
  expect(jan.map((x) => x.order_id)).toContain(`QACS-${stamp}-11`);
  expect(jan.map((x) => x.order_id)).not.toContain(`QACS-${stamp}-12`);
  const one = jan.find((x) => x.order_id === `QACS-${stamp}-11`);
  expect(one).toMatchObject({ supplier: 'QA Supplier', sku: SKU });
  const csv = salesReportCsv([one]);
  expect(csv.split('\n')[0]).toContain('Net $');
  expect(csv).toContain(SKU);
  const future = (await (await request.get('/api/presell-listings/list?tab=stock&from=2099-01-01', h)).json()).rows;
  expect(future).toEqual([]);
  const today = (await (await request.get(`/api/presell-listings/list?tab=stock&q=${SKU}`, h)).json()).rows;
  expect(today.length).toBeGreaterThanOrEqual(4);
  expect(stockReportCsv(today)).toContain('1Z999AA10123456784');
  expect((await request.get('/api/presell-listings/list?tab=pos', h)).status()).toBe(200);
});

test('a PO-linked pre-sell row shows on Inbound with what sold', async ({ request }) => {
  const po = (await db.query(`SELECT p.id FROM purchase_orders p JOIN po_boxes b ON b.po_id = p.id
                                WHERE p.status NOT IN ('reconciled', 'closed') LIMIT 1`)).rows[0];
  test.skip(!po, 'no open PO with a box in this database');
  const st = await S.upsertPresellStock({ sku: SKU, size: '13', name: 'QA Cost Shoe', addQty: 4, poId: po.id }, 'e2e');
  const r = await (await request.get('/api/inbound', { headers: as('warehouse') })).json();
  expect(r.presell.find((x) => Number(x.id) === Number(st.id))).toMatchObject({ sku: SKU, qty: 4, sold: 0 });
});

test('the page: ✎ Cost & shipment saves pasted tracking; the report downloads', async ({ page }) => {
  page.on('pageerror', (err) => { throw err; });
  await loginAs(page, 'ph_team');
  await page.goto(`/ph/presell-listings?tab=stock&q=${SKU}`);
  const row = page.getByRole('row').filter({ hasText: SKU }).filter({ has: page.getByRole('cell', { name: '10', exact: true }) });
  await row.getByRole('button', { name: /Cost & shipment/ }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Tracking numbers').fill('1Z999AA10123456784\n9400111899223197428490');
  await expect(dlg.getByText('2 tracking numbers')).toBeVisible();
  await dlg.getByRole('button', { name: /^Save \d+ size/ }).click();
  await expect(dlg).toBeHidden();
  const { rows } = await db.query(`SELECT tracking_numbers FROM presell_stock WHERE sku = $1 AND size = '10'`, [SKU]);
  expect(rows[0].tracking_numbers).toEqual(['1Z999AA10123456784', '9400111899223197428490']);
  const [csv] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '⬇ CSV' }).click()]);
  expect(csv.suggestedFilename()).toMatch(/^presell-stock_.*\.csv$/);
  const [pdf] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '⬇ PDF' }).click()]);
  expect(pdf.suggestedFilename()).toMatch(/\.pdf$/);
  await page.getByRole('button', { name: 'Sales', exact: true }).click();
  await expect(page.getByText(/what sold/)).toBeVisible();
  // Phone width: no sideways scroll on the page itself.
  await page.setViewportSize({ width: 390, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});
