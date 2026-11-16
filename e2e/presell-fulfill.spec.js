// Pre-sell FULFILMENT (docs/context/presell-fulfillment.md): read each sale's order back for
// its status, the label the platform made at the sale, tracking and ship-by; the 📦 Fulfill tab
// + pick list. Marketplaces are fakes — nothing here reaches Alias or StockX (the tab's
// "↻ Check status now" is never pressed).
import { test, expect } from '@playwright/test';
import pg from 'pg';
import { signToken } from '../api/_lib/util.js';
import { loadEnv, loginAs } from './helpers/auth.js';
import { shipStateOf, orderShipInfo, stockxDocs, assignWhere, pickGroups, fulfillTotals, urgency, timeLeft, labelLink } from '../src/lib/presellFulfill.js';

loadEnv();
test.describe.configure({ mode: 'serial' });
const stamp = `${Date.now()}`.slice(-7);
const SKU = `QAFUL-${stamp}`;
const as = (role) => ({ Authorization: `Bearer ${signToken({ uid: `e2e-${role}`, username: `e2e-${role}`, name: `E2E ${role}`, role })}` });
let db;

test.beforeAll(async () => {
  db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
});
test.afterAll(async () => {
  if (!db) return;
  await db.query(`DELETE FROM presell_sales WHERE order_id LIKE $1`, [`QAF${stamp}%`]);
  await db.query(`DELETE FROM presell_stock WHERE sku LIKE $1`, [`${SKU}%`]);
  await db.end();
});

// Shapes as seen live on 2026-10-12 (trimmed).
const ALIAS_ORDER = {
  id: '520527758', status: 'ORDER_STATUS_LABEL_GENERATED', label_url: 'https://s3.example/label.pdf',
  label_tracking_number: '1Z3YY4080329993876', label_courier: 'ups', cancels_at: '2026-10-14T04:00:00Z',
};
const SX_ORDER = {
  orderNumber: '06-XP26KR8ZY6', status: 'CREATED',
  shipment: { carrierCode: 'UPS', shipByDate: '2026-10-14T00:59:59.999Z', shippingLabelUrl: 'https://logistics.example/label.png',
    trackingNumber: '1ZR1H014YW30521120', trackingUrl: 'https://www.ups.com/track?tracknum=1ZR1H014YW30521120' },
};
const SX_DOCS = { shippingDocuments: {
  sellerShippingInstructions: { thermalLabel: { EN_US: 'https://l.example/thermal.pdf' }, normalLabel: { EN_US: 'https://l.example/standard.pdf' } },
  thermalLabelOnly: 'https://l.example/labelOnly.pdf', additionalDocumentsRequired: false,
} };

test('each platform\'s status → to ship / shipped / cancelled', () => {
  expect(shipStateOf('alias', 'ORDER_STATUS_LABEL_GENERATED')).toBe('to_ship');
  expect(shipStateOf('alias', 'ORDER_STATUS_UNDER_REVIEW')).toBe('shipped');
  expect(shipStateOf('alias', 'ORDER_STATUS_COMPLETED')).toBe('shipped');
  expect(shipStateOf('alias', 'ORDER_STATUS_CANCELED_BY_BUYER')).toBe('cancelled');
  expect(shipStateOf('stockx', 'CREATED')).toBe('to_ship');
  expect(shipStateOf('stockx', 'CCAUTHORIZATIONFAILED')).toBe('to_ship');
  expect(shipStateOf('stockx', 'PAYOUTCOMPLETED')).toBe('shipped');
  expect(shipStateOf('stockx', 'PAYOUTFAILED')).toBe('shipped');   // failed PAYOUT ≠ cancelled sale
  expect(shipStateOf('stockx', 'DIDNOTSHIP')).toBe('cancelled');
  expect(shipStateOf('stockx', 'CANCELED')).toBe('cancelled');
  expect(shipStateOf('stockx', null)).toBeNull();
});

test('order → label, tracking, ship by (Alias + StockX with its documents)', () => {
  const a = orderShipInfo('alias', ALIAS_ORDER);
  expect(a).toMatchObject({ ship_state: 'to_ship', carrier: 'UPS', tracking_number: '1Z3YY4080329993876', ship_by: '2026-10-14T04:00:00Z', label_url: 'https://s3.example/label.pdf' });
  expect(a.tracking_url).toContain('ups.com');
  const docs = stockxDocs(SX_DOCS);
  expect(docs).toMatchObject({ thermal: 'https://l.example/thermal.pdf', letter: 'https://l.example/standard.pdf', labelOnly: 'https://l.example/labelOnly.pdf', additionalRequired: false });
  const s = orderShipInfo('stockx', SX_ORDER, docs);
  expect(s).toMatchObject({ ship_state: 'to_ship', carrier: 'UPS', tracking_number: '1ZR1H014YW30521120', ship_by: '2026-10-14T00:59:59.999Z' });
  // The label to print: StockX's label-only PDF over its PNG.
  expect(labelLink(s)).toBe('https://l.example/labelOnly.pdf');
  expect(labelLink(orderShipInfo('stockx', SX_ORDER))).toBe('https://logistics.example/label.png');
  expect(stockxDocs({})).toBeNull();
});

test('where is the pair: set-aside pairs go to the most urgent orders first', () => {
  const st = { stock_id: 1, sku: 'A', size: '10', in_transit: true, arrived_at: null, arrived_qty: 3, released_qty: 1, shipped_n: 1 };
  // set aside = 3 − 1 = 2, one already shipped → 1 ready now.
  const rows = assignWhere([
    { ...st, id: 1, ship_by: '2026-10-15T00:00:00Z' },
    { ...st, id: 2, ship_by: '2026-10-13T00:00:00Z' },
    { ...st, id: 3, ship_by: '2026-10-14T00:00:00Z' },
    { id: 4, stock_id: 2, sku: 'B', size: '9', in_transit: false, ship_by: '2026-10-13T00:00:00Z' },
    { id: 5, stock_id: 3, sku: 'C', size: '8', in_transit: true, arrived_at: '2026-10-10T00:00:00Z', arrived_qty: 2, released_qty: 2, shipped_n: 0, ship_by: '2026-10-16T00:00:00Z' },
  ]);
  const w = Object.fromEntries(rows.map((r) => [r.id, r.where]));
  expect(w).toEqual({ 2: 'ready', 3: 'transit', 1: 'transit', 4: 'source', 5: 'shelf' });
  const g = pickGroups(rows);
  expect(g.map((x) => x.sku)).toEqual(['A', 'B', 'C']);   // A's first order is due first (tie with B → by SKU)
  expect(g[0].orders.map((o) => o.id)).toEqual([2, 3, 1]);
  const now = Date.parse('2026-10-13T12:00:00Z');
  expect(fulfillTotals(rows, now)).toMatchObject({ toShip: 5, overdue: 2, today: 1, ready: 1, transit: 2, source: 1, shelf: 1 });
  expect(urgency(null, now)).toBeNull();
  expect(timeLeft('2026-10-13T10:00:00Z', now)).toBe('2 h late');
  expect(timeLeft('2026-10-16T12:00:00Z', now)).toBe('3 days left');
});

test('the sync reads open orders, writes only what changed, and stops at a 429', async () => {
  const { rows: [st] } = await db.query(`INSERT INTO presell_stock (sku, name, size, qty, sold, in_transit, arrived_qty, released_qty)
    VALUES ($1, 'QA fulfil', '10.5', 3, 2, true, 1, 0) RETURNING id`, [SKU]);
  await db.query(`INSERT INTO presell_sales (stock_id, platform, order_id, price_cents, sold_at) VALUES
    ($1, 'alias', $2, 14900, now()), ($1, 'stockx', $3, 17100, now())`, [st.id, `QAF${stamp}A`, `QAF${stamp}S`]);
  const F = await import('../api/_lib/presell-fulfill.js');
  const calls = [];
  const fetchers = {
    alias: async (s) => { if (!s.order_id.startsWith(`QAF${stamp}`)) return { ok: false, error: 'not ours' }; calls.push(`alias:${s.order_id}`); return { ok: true, info: orderShipInfo('alias', { ...ALIAS_ORDER, id: s.order_id }) }; },
    stockx: async (s) => { if (!s.order_id.startsWith(`QAF${stamp}`)) return { ok: false, error: 'not ours' }; calls.push(`stockx:${s.order_id}`); return { ok: true, info: orderShipInfo('stockx', SX_ORDER, stockxDocs(SX_DOCS)) }; },
  };
  const p1 = await F.syncFulfillment({ force: true, fetchers });
  expect(calls).toEqual(expect.arrayContaining([`alias:QAF${stamp}A`, `stockx:QAF${stamp}S`]));
  expect(p1.changed).toBeGreaterThanOrEqual(2);
  const { rows } = await db.query(`SELECT order_id, ship_state, tracking_number, ship_docs FROM presell_sales WHERE order_id LIKE $1 ORDER BY order_id`, [`QAF${stamp}%`]);
  expect(rows.map((r) => [r.ship_state, r.tracking_number])).toEqual([['to_ship', '1Z3YY4080329993876'], ['to_ship', '1ZR1H014YW30521120']]);
  expect(rows[1].ship_docs.labelOnly).toBe('https://l.example/labelOnly.pdf');
  // Same answer again → nothing written (presell_sales is a live table).
  const p2 = await F.syncFulfillment({ force: true, fetchers });
  const ours = (p) => p.changed;   // only our two rows answer; the rest error
  expect(ours(p2)).toBe(0);
  // Not forced: read a moment ago → skipped.
  calls.length = 0;
  await F.syncFulfillment({ fetchers });
  expect(calls).toEqual([]);
  // A 429 ends the pass.
  const p3 = await F.syncFulfillment({ force: true, fetchers: { alias: async () => ({ ok: false, status: 429 }), stockx: async () => ({ ok: false, status: 429 }) } });
  expect(p3.stoppedBy).toMatch(/rate limit/);
  // Alias shipped → leaves "to ship".
  await F.syncFulfillment({ force: true, fetchers: { ...fetchers, alias: async (s) => (s.order_id === `QAF${stamp}A` ? { ok: true, info: orderShipInfo('alias', { ...ALIAS_ORDER, status: 'ORDER_STATUS_UNDER_REVIEW' }) } : { ok: false, error: 'x' }) } });
  const { rows: [a] } = await db.query(`SELECT ship_state, ship_state_at FROM presell_sales WHERE order_id = $1`, [`QAF${stamp}A`]);
  expect(a.ship_state).toBe('shipped');
  expect(a.ship_state_at).not.toBeNull();
});

test('the endpoint: to ship / shipped views, search, roles', async ({ request }) => {
  const h = { headers: as('warehouse') };
  const r = await (await request.get(`/api/presell-listings/fulfill?q=${SKU}`, h)).json();
  expect(r.ok).toBe(true);
  expect(r.rows.map((x) => x.order_id)).toEqual([`QAF${stamp}S`]);
  expect(r.rows[0]).toMatchObject({ sku: SKU, size: '10.5', in_transit: true, arrived_qty: 1, shipped_n: 1 });
  const sh = await (await request.get(`/api/presell-listings/fulfill?view=shipped&q=${SKU}`, h)).json();
  expect(sh.rows.map((x) => x.order_id)).toEqual([`QAF${stamp}A`]);
  expect((await request.get('/api/presell-listings/fulfill', { headers: as('supplier') })).status()).toBe(403);
  expect((await request.post('/api/presell-listings/fulfill', { headers: as('supplier'), data: { action: 'sync' } })).status()).toBe(403);
  expect((await request.post('/api/presell-listings/fulfill', { headers: as('warehouse'), data: { action: 'nope' } })).status()).toBe(400);
});

test('📦 Fulfill tab on a phone: card per SKU + size, label, pick list PDF', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/presell-listings?tab=fulfill&fq=${SKU}`);
  const card = page.locator('.ff-group').filter({ hasText: SKU });
  await expect(card).toContainText('size 10.5');
  await expect(card).toContainText('StockX');
  // The one arrived pair went out with the (shipped) Alias order → this one waits on the truck.
  await expect(card).toContainText('In transit — not here yet');
  await expect(card.getByRole('link', { name: '🏷 Label' })).toHaveAttribute('href', 'https://l.example/labelOnly.pdf');
  await expect(card.getByRole('link', { name: 'Instructions 4×6' })).toHaveAttribute('href', 'https://l.example/thermal.pdf');
  // No sideways scroll on a phone.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '🖨 Pick list PDF' }).click()]);
  expect(dl.suggestedFilename()).toMatch(/^presell-pick-list_\d{4}-\d{2}-\d{2}\.pdf$/);
  const [csv] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '⬇ CSV' }).click()]);
  const text = await (await import('node:fs')).promises.readFile(await csv.path(), 'utf8');
  expect(text).toContain(`QAF${stamp}S`);
  expect(text).toContain('1ZR1H014YW30521120');
});

// ---- Labels by platform: one PDF per platform, all on screen or only the ticked orders ----
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

test('labels: PDFs and pictures merge in the order given; what could not go in is named', async () => {
  const { PDFDocument } = await import('pdf-lib');
  const { mergeLabels, labelUrlAllowed } = await import('../api/_lib/presell-labels.js');
  const two = await PDFDocument.create(); two.addPage([288, 432]); two.addPage([288, 432]);
  const twoPages = Buffer.from(await two.save());
  const files = { 'https://l.example/a.pdf': twoPages, 'https://l.example/b.png': PNG_1PX, 'https://l.example/junk.pdf': Buffer.from('<html>expired</html>') };
  const fetcher = async (url) => { if (!files[url]) throw new Error('HTTP 403'); return files[url]; };
  const r = await mergeLabels([
    { id: 1, order_id: 'A1', label_url: 'https://l.example/old.png', ship_docs: { labelOnly: 'https://l.example/a.pdf' } },   // label-only PDF beats the PNG
    { id: 2, order_id: 'A2', label_url: 'https://l.example/b.png' },
    { id: 3, order_id: 'A3', label_url: 'https://l.example/gone.pdf' },
    { id: 4, order_id: 'A4', label_url: null },
    { id: 5, order_id: 'A5', label_url: 'https://l.example/junk.pdf' },
    { id: 6, order_id: 'A6', label_url: 'http://169.254.169.254/latest' },
  ], { fetcher });
  expect(r.included).toEqual(['A1', 'A2']);
  expect(r.missing.map((m) => [m.order_id, m.reason])).toEqual([['A3', 'HTTP 403'], ['A4', 'no label yet'], ['A5', 'not a PDF or a picture'], ['A6', 'label link not usable']]);
  const out = await PDFDocument.load(r.bytes);
  expect(out.getPageCount()).toBe(3);   // 2 pages of A1 + the picture of A2 on its own 4x6 page
  // Nothing usable → no file at all.
  expect((await mergeLabels([{ id: 4, order_id: 'A4', label_url: null }], { fetcher })).bytes).toBeNull();
  // StockX instructions: the thermal sheet, else the letter sheet, else the bare label.
  const { docLink } = await import('../api/_lib/presell-labels.js');
  const sxRow = { label_url: 'https://l.example/l.png', ship_docs: { thermal: 'https://l.example/t.pdf', letter: 'https://l.example/n.pdf', labelOnly: 'https://l.example/a.pdf' } };
  expect(docLink(sxRow, 'instructions')).toBe('https://l.example/t.pdf');
  expect(docLink({ ...sxRow, ship_docs: { letter: 'https://l.example/n.pdf' } }, 'instructions')).toBe('https://l.example/n.pdf');
  expect(docLink({ label_url: 'https://l.example/l.png', ship_docs: null }, 'instructions')).toBe('https://l.example/l.png');
  expect(docLink(sxRow)).toBe('https://l.example/a.pdf');
  const ins = await mergeLabels([{ id: 1, order_id: 'S1', label_url: null, ship_docs: { thermal: 'https://l.example/a.pdf' } }], { fetcher, with: 'instructions' });
  expect(ins.included).toEqual(['S1']);
  for (const bad of ['http://x.com/a.pdf', 'https://localhost/a', 'https://10.0.0.1/a', 'https://[::1]/a', 'file:///etc/passwd', 'nope'])
    expect(labelUrlAllowed(bad)).toBe(false);
});

test('labels endpoint: roles, platform, ids; a label that cannot be fetched is an error, not an empty file', async ({ request }) => {
  const { rows: [sx] } = await db.query(`SELECT id FROM presell_sales WHERE order_id = $1`, [`QAF${stamp}S`]);
  const post = (role, data) => request.post('/api/presell-listings/labels', { headers: as(role), data });
  expect((await post('supplier', { platform: 'stockx', ids: [sx.id] })).status()).toBe(403);
  expect((await post('warehouse', { platform: 'ebay', ids: [sx.id] })).status()).toBe(400);
  expect((await post('warehouse', { platform: 'stockx', ids: [] })).status()).toBe(400);
  expect((await post('warehouse', { platform: 'stockx', ids: Array.from({ length: 301 }, (_, i) => i + 1) })).status()).toBe(400);
  // Instructions exist on StockX only.
  expect((await post('warehouse', { platform: 'alias', ids: [sx.id], with: 'instructions' })).status()).toBe(400);
  // The StockX order asked for as Alias: not found on that platform.
  expect((await post('ph_team', { platform: 'alias', ids: [sx.id] })).status()).toBe(404);
  // Its label lives on l.example, which does not exist → nothing downloaded → 502 with the order named.
  const r = await post('warehouse', { platform: 'stockx', ids: [sx.id] });
  expect(r.status()).toBe(502);
  expect((await r.json()).missing[0].order_id).toBe(`QAF${stamp}S`);
});

test('📦 Fulfill tab: Alias / StockX split, tick orders, one labels PDF per platform', async ({ page }) => {
  await loginAs(page, 'warehouse');
  const { PDFDocument } = await import('pdf-lib');
  const pdf = await PDFDocument.create(); pdf.addPage([288, 432]);
  const bytes = Buffer.from(await pdf.save());
  let sent = null;
  await page.route('**/api/presell-listings/labels', async (route) => {
    sent = route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: 'application/pdf', body: bytes,
      headers: { 'Content-Disposition': 'attachment; filename="presell-labels-stockx_2026-11-16.pdf"', 'X-Labels-Included': '1', 'X-Labels-Missing': encodeURIComponent('[]') } });
  });
  await page.goto(`/presell-listings?tab=fulfill&fq=${SKU}`);
  const card = page.locator('.ff-group').filter({ hasText: SKU });
  await expect(card).toBeVisible();
  const plat = page.getByRole('group', { name: 'Platform' });
  // Only the StockX order is still to ship (the Alias one shipped).
  await expect(page.getByRole('button', { name: '🏷 StockX labels PDF (1)' })).toBeEnabled();
  await expect(page.getByRole('button', { name: '🏷 Alias labels PDF (0)' })).toBeDisabled();
  await plat.getByRole('button', { name: /^Alias/ }).click();
  await expect(page).toHaveURL(/plat=alias/);
  await expect(page.getByText('Nothing matches.')).toBeVisible();
  await expect(page.getByRole('button', { name: /StockX labels PDF/ })).toHaveCount(0);
  await plat.getByRole('button', { name: /^StockX/ }).click();
  await expect(card).toBeVisible();
  // Tick the order → the button counts ticked orders, and only those are sent.
  await card.getByRole('checkbox', { name: new RegExp(`QAF${stamp}S`) }).check();
  const btn = page.getByRole('button', { name: '🏷 StockX labels PDF (1 ticked)' });
  const [dl] = await Promise.all([page.waitForEvent('download'), btn.click()]);
  expect(dl.suggestedFilename()).toBe('presell-labels-stockx_2026-11-16.pdf');
  const { rows: [sx] } = await db.query(`SELECT id FROM presell_sales WHERE order_id = $1`, [`QAF${stamp}S`]);
  expect(sent).toEqual({ platform: 'stockx', ids: [Number(sx.id)] });
  await expect(page.getByText('StockX: 1 ticked label in the PDF')).toBeVisible();
  // StockX's instructions sheet + label, for the same ticked order.
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '📄 StockX instructions + labels PDF (1 ticked)' }).click()]);
  expect(dl2).toBeTruthy();
  expect(sent).toEqual({ platform: 'stockx', ids: [Number(sx.id)], with: 'instructions' });
  await page.getByRole('button', { name: 'Clear (1)' }).click();
  await expect(page.getByRole('button', { name: '🏷 StockX labels PDF (1)' })).toBeEnabled();
});
