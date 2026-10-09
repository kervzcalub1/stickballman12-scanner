// Pre-sell Listings — IN TRANSIT (docs/context/presell-listings.md). Alex, 2026-10-10: list a
// shipment while it's on the truck; when the warehouse receives that SKU + size, the unsold
// listings are DELETED and the pre-sell group is told how many sold in transit (set aside,
// inbound only the rest). Marketplaces and Telegram are fakes — nothing leaves the machine.
import { test, expect } from '@playwright/test';
import pg from 'pg';
import { loadEnv } from './helpers/auth.js';

loadEnv();
test.describe.configure({ mode: 'serial' });
const stamp = `${Date.now()}`.slice(-7);
const SKU = `QAIT-${stamp}`;
let db; let S;
const ids = { stock: [], batch: [] };

const fakes = () => {
  const removed = [];
  const sent = [];
  const platform = (name) => ({ remove: async (l) => { removed.push(`${name}:${l.external_id}`); return { ok: true, status: 'deleted' }; } });
  return { removed, sent, opts: { enabled: true, platforms: { alias: platform('alias'), stockx: platform('stockx') }, notify: async (lines) => { sent.push(lines); } } };
};
async function listed(size, { qty = 12, sold = 0, inTransit = true } = {}) {
  const stock = (await S.upsertPresellStock({ sku: SKU, size, name: 'QA In Transit Shoe', addQty: qty, inTransit, transitNote: 'PO 1042', expectedOn: '2026-10-12' }, 'e2e')).id;
  ids.stock.push(stock);
  if (sold) await db.query(`UPDATE presell_stock SET sold = $2 WHERE id = $1`, [stock, sold]);
  for (const [p, n] of [['alias', 2], ['stockx', 2]]) for (let i = 0; i < n; i++) {
    await db.query(`INSERT INTO presell_listings (stock_id, platform, external_id, price_cents, status) VALUES ($1, $2, $3, 20000, 'live')`, [stock, p, `${SKU}-${size}-${p}-${i}`]);
  }
  return stock;
}
async function batch(kind = 'receiving') {
  const { rows } = await db.query(`INSERT INTO batches (batch_code, kind, date_received) VALUES ($1, $2, CURRENT_DATE) RETURNING id, batch_code`, [`QAIT${stamp}${ids.batch.length}`, kind]);
  ids.batch.push(rows[0].id);
  return rows[0];
}

test.beforeAll(async () => {
  db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  S = await import('../api/_lib/db.js');
});
test.afterAll(async () => {
  if (!db) return;
  await db.query(`DELETE FROM presell_stock WHERE sku = $1`, [SKU]);
  await db.query(`DELETE FROM batches WHERE id = ANY($1)`, [ids.batch]);
  await db.end();
});

test('receiving the SKU + size deletes every unsold listing, once, and says how many to set aside', async () => {
  const stock = await listed('8', { qty: 12, sold: 2 });
  const { onItemsReceived } = await import('../api/_lib/presell-arrival.js');
  const b = await batch();
  const f = fakes();
  // "US8" / "8" / "8.0"-style differences don't stop the match; another size doesn't trigger.
  const out = await onItemsReceived(b.id, [{ sku: SKU.toLowerCase(), size: 'US 8' }, { sku: SKU, size: '9' }], f.opts);
  expect(out).toHaveLength(1);
  expect(f.removed.sort()).toEqual([`alias:${SKU}-8-alias-0`, `alias:${SKU}-8-alias-1`, `stockx:${SKU}-8-stockx-0`, `stockx:${SKU}-8-stockx-1`].sort());
  const { rows } = await db.query(`SELECT status FROM presell_listings WHERE stock_id = $1`, [stock]);
  expect(rows.map((r) => r.status)).toEqual(['deleted', 'deleted', 'deleted', 'deleted']);
  const st = (await db.query(`SELECT arrived_at, arrived_batch FROM presell_stock WHERE id = $1`, [stock])).rows[0];
  expect(st.arrived_at).not.toBeNull();
  expect(st.arrived_batch).toBe(b.batch_code);
  const text = f.sent[0].map((l) => (typeof l === 'string' ? l : l.b)).join('\n');
  expect(text).toContain('INBOUNDED');
  expect(text).toContain('Deleted: Alias 2, StockX 2');
  expect(text).toContain('Sold while in transit: 2 of 12');
  expect(text).toContain('inbound and list only 10');
  // The next box of the same size: already arrived, nothing happens again.
  const again = fakes();
  expect(await onItemsReceived(b.id, [{ sku: SKU, size: '8' }], again.opts)).toEqual([]);
  expect(again.sent).toHaveLength(0);
});

test('Existing Stock counting is not an arrival; a row listed without the tick is never touched', async () => {
  const transit = await listed('10');
  const normal = await listed('11', { inTransit: false });
  const { onItemsReceived } = await import('../api/_lib/presell-arrival.js');
  const f = fakes();
  expect(await onItemsReceived((await batch('existing')).id, [{ sku: SKU, size: '10' }], f.opts)).toEqual([]);
  expect(await onItemsReceived((await batch()).id, [{ sku: SKU, size: '11' }], f.opts)).toEqual([]);
  expect(f.removed).toHaveLength(0);
  const { rows } = await db.query(`SELECT id, arrived_at FROM presell_stock WHERE id = ANY($1)`, [[transit, normal]]);
  expect(rows.every((r) => r.arrived_at === null)).toBe(true);
});

test('only where PRESELL_WATCH=on: anywhere else a receive never reaches a marketplace', async () => {
  await listed('12');
  const { onItemsReceived, arrivalsEnabled } = await import('../api/_lib/presell-arrival.js');
  expect(arrivalsEnabled({})).toBe(false);
  expect(arrivalsEnabled({ PRESELL_WATCH: 'on' })).toBe(true);
  const f = fakes();
  expect(await onItemsReceived((await batch()).id, [{ sku: SKU, size: '12' }], { ...f.opts, enabled: false })).toEqual([]);
  expect(f.removed).toHaveLength(0);
});

test('listing the same SKU + size in transit again re-arms it; listing it plainly leaves the flag', async () => {
  const id = await listed('13');
  await db.query(`UPDATE presell_stock SET arrived_at = now() WHERE id = $1`, [id]);
  await S.upsertPresellStock({ sku: SKU, size: '13', addQty: 1 }, 'e2e');            // plain: arrived stays
  expect((await db.query(`SELECT in_transit, arrived_at FROM presell_stock WHERE id = $1`, [id])).rows[0].arrived_at).not.toBeNull();
  await S.upsertPresellStock({ sku: SKU, size: '13', addQty: 1, inTransit: true, transitNote: 'PO 2' }, 'e2e');
  const r = (await db.query(`SELECT in_transit, arrived_at, transit_note, qty FROM presell_stock WHERE id = $1`, [id])).rows[0];
  expect(r).toMatchObject({ in_transit: true, arrived_at: null, transit_note: 'PO 2', qty: 14 });
});

test('the two kinds of sale read differently: source it vs set it aside on arrival', async () => {
  const { handleSale } = await import('../api/_lib/presell.js');
  const sale = async (inTransit, size) => {
    const stock = (await S.upsertPresellStock({ sku: SKU, size, name: 'QA Sale Shoe', addQty: 12, inTransit, transitNote: inTransit ? 'PO 1042' : null }, 'e2e')).id;
    // One listing — the one that sold — so nothing is left to take down (no marketplace call).
    const { rows } = await db.query(`INSERT INTO presell_listings (stock_id, platform, external_id, price_cents, status) VALUES ($1, 'alias', $2, 20000, 'live') RETURNING *`, [stock, `${SKU}-sale-${size}`]);
    const sent = [];
    await handleSale({ listing: rows[0], platform: 'alias', orderId: `ORD-${size}-${stamp}`, priceCents: 20000, payoutCents: 18000, soldAt: new Date().toISOString(), raw: {} },
      { notify: async (lines) => { sent.push(lines.map((l) => (typeof l === 'string' ? l : l.b)).join('\n')); } });
    return sent[0];
  };
  const plain = await sale(false, '14');
  expect(plain).toContain('PRE-SELL SALE — Alias — SOURCE IT');
  expect(plain).toContain("We don't have this pair");
  expect(plain).not.toContain('IN-TRANSIT');
  const transit = await sale(true, '15');
  expect(transit).toContain('IN-TRANSIT SALE — Alias');
  expect(transit).toContain('Shipment: PO 1042');
  expect(transit).toContain('set 1 pair of size 15 aside');
  expect(transit).toContain('Inbound the other 11');
  expect(transit).not.toContain('SOURCE IT');
});

const ALEX = `JA1091-100
Nike Air Griffey Max 1 'Cincinnati Reds'

8x 12
8.5 x 14
9 x 19
9.5 x 17
10 x 26
10.5 x 14
11 x 18
12 x 13
13 x 12`;

test('paste: Alex\'s message → one shoe, nine sizes, 145 pairs; no-name and multi-shoe messages too', async () => {
  const { parsePresellPaste } = await import('../src/lib/presellPaste.js');
  const r = parsePresellPaste(ALEX);
  expect(r.shoes).toEqual([{ sku: 'JA1091-100', name: "Nike Air Griffey Max 1 'Cincinnati Reds'", sizes: [
    { size: '8', qty: 12 }, { size: '8.5', qty: 14 }, { size: '9', qty: 19 }, { size: '9.5', qty: 17 }, { size: '10', qty: 26 },
    { size: '10.5', qty: 14 }, { size: '11', qty: 18 }, { size: '12', qty: 13 }, { size: '13', qty: 12 }] }]);
  expect(r.pairs).toBe(145);
  expect(r.skipped).toEqual([]);
  const two = parsePresellPaste('dd1391-100\n8 x 2\n9×1\n8*1\nKI6956\n7W x 3\nsee you tomorrow\n8-9 x 2');
  expect(two.shoes).toEqual([
    { sku: 'DD1391-100', name: '', sizes: [{ size: '8', qty: 3 }, { size: '9', qty: 1 }] },   // the same size twice adds up
    { sku: 'KI6956', name: '', sizes: [{ size: '7W', qty: 3 }] },
  ]);
  expect(two.skipped.map((x) => x.line)).toEqual(['see you tomorrow', '8-9 x 2']);   // never guessed at
});

test('paste on the page: the cart fills, In transit ticks, and 290 listings go out in batches of ≤100', async ({ page }) => {
  const { loginAs } = await import('./helpers/auth.js');
  const calls = [];
  await page.route('**/api/sku-search**', (r) => r.fulfill({ json: { ok: true, product: { sku: 'JA1091-100', name: 'Air Griffey', image: null, sizes: [] } } }));
  await page.route('**/api/presell-listings/prices', (r) => r.fulfill({ json: { ok: true, prices: {} } }));
  await page.route('**/api/presell-listings/create', async (r) => {
    const body = r.request().postDataJSON();
    calls.push(body);
    await r.fulfill({ json: { ok: true, created: body.items.reduce((n, i) => n + i.qty * ((i.alias ? 1 : 0) + (i.stockx ? 1 : 0)), 0), failed: 0,
      lines: body.items.map((i) => ({ sku: i.sku, size: i.size, alias: { results: [] }, stockx: { results: [] } })) } });
  });
  await loginAs(page, 'ph_team');
  await page.goto('/ph/presell-listings');
  await page.getByRole('button', { name: '📋 Paste message' }).click();
  await page.getByLabel('Paste the message').fill(ALEX);
  await page.getByRole('button', { name: 'Add 145 pairs to the list' }).click();
  await expect(page.locator('.ap-cart-line')).toHaveCount(9);
  await expect(page.getByRole('checkbox', { name: /In transit/ })).toBeChecked();
  for (const [label, v] of [['Alias price for every pair', '250'], ['StockX price for every pair', '260']]) {
    await page.getByLabel(label).fill(v);
    await page.getByLabel(label).locator('xpath=following-sibling::button').click();
  }
  await page.getByRole('button', { name: /List 145 pairs on Alias \+ StockX/ }).click();
  await page.getByRole('button', { name: 'List live' }).click();
  await expect(page.getByText('290 listings created')).toBeVisible();
  expect(calls.length).toBeGreaterThanOrEqual(3);
  for (const c of calls) {
    expect(c.inTransit).toBe(true);
    expect(c.items.reduce((n, i) => n + i.qty * 2, 0)).toBeLessThanOrEqual(100);
  }
  expect(calls.flatMap((c) => c.items).reduce((n, i) => n + i.qty, 0)).toBe(145);
});

test('cost: preset + shelf price → landed cost and payout/profit per platform; edit for this purchase only', async ({ page }) => {
  const { loginAs } = await import('./helpers/auth.js');
  const calls = [];
  const saved = [];
  await page.route('**/api/payout/presets', (r) => {
    if (r.request().method() === 'POST') { saved.push(r.request().postDataJSON()); return r.fulfill({ json: { ok: true } }); }
    return r.fulfill({ json: { ok: true, presets: [{ id: 7, name: 'QA Supplier', taxPct: 6, giftPct: 0, storePct: 0, promoPct: 0, cashbackPct: 0, tipAmt: 10, shippingAmt: 5 }] } });
  });
  await page.route('**/api/sku-search**', (r) => r.fulfill({ json: { ok: true, product: null } }));
  await page.route('**/api/presell-listings/prices', (r) => r.fulfill({ json: { ok: true, prices: {} } }));
  await page.route('**/api/presell-listings/create', async (r) => {
    const body = r.request().postDataJSON(); calls.push(body);
    await r.fulfill({ json: { ok: true, created: 2, failed: 0, lines: body.items.map((i) => ({ sku: i.sku, size: i.size, alias: { results: [] }, stockx: { results: [] } })) } });
  });
  await loginAs(page, 'ph_team');
  await page.goto('/ph/presell-listings');
  await page.getByRole('button', { name: '📋 Paste message' }).click();
  await page.getByLabel('Paste the message').fill('JA1091-100\n8 x 1');
  await page.getByRole('button', { name: 'Add 1 pairs to the list' }).click();
  await page.getByLabel('Supplier preset').selectOption('7');
  await page.getByLabel('Shelf price for every pair').fill('100');
  await page.getByLabel('Shelf price for every pair').locator('xpath=following-sibling::button').click();
  // 100 + 6% tax + $10 tip + $5 shipping = 121.00
  await expect(page.locator('.ap-cost-out')).toContainText('$121.00');
  await page.getByLabel('Line 1 Alias price').fill('200');
  // Alias 9.9% fee: payout 180.20, profit 59.20
  await expect(page.locator('.ap-payout').first()).toContainText('Payout $180.20');
  await expect(page.locator('.ap-payout').first()).toContainText('profit $59.20');
  // Edit tax for THIS purchase: 8% → 123.00; the saved preset is never written.
  await page.getByRole('button', { name: '✎ Edit for this purchase' }).click();
  await page.getByLabel('Sales tax for this purchase').fill('8');
  await expect(page.locator('.ap-cost-out')).toContainText('$123.00');
  await expect(page.getByText('edited for this purchase')).toBeVisible();
  await page.getByLabel('Line 1 StockX price').fill('210');
  await page.getByRole('button', { name: /List 1 pair on Alias \+ StockX/ }).click();
  await page.getByRole('button', { name: 'List live' }).click();
  await expect(page.getByText('2 listings created')).toBeVisible();
  expect(saved).toHaveLength(0);
  expect(calls[0].costStack).toMatchObject({ preset: 'QA Supplier', presetId: 7, edited: true, taxPct: 8, tipAmt: 10, shippingAmt: 5 });
  expect(calls[0].items[0].shelfPrice).toBe(100);
});

test('cost is stored on the pre-sell row, computed the same way as everywhere', async () => {
  const { landedFromShelf } = await import('../src/lib/costs.js');
  const stack = { taxPct: 8, giftPct: 0, storePct: 0, promoPct: 0, cashbackPct: 0, tipAmt: 10, shippingAmt: 5 };
  const unitCost = landedFromShelf(100, null, stack);
  expect(unitCost).toBe(123);
  const row = await S.upsertPresellStock({ sku: SKU, size: '16', addQty: 1, shelfPrice: 100, unitCost, costStack: { ...stack, preset: 'QA', edited: true } }, 'e2e');
  expect(Number(row.unit_cost)).toBe(123);
  expect(Number(row.shelf_price)).toBe(100);
  // A re-list with no cost keeps the cost we had.
  const again = await S.upsertPresellStock({ sku: SKU, size: '16', addQty: 1 }, 'e2e');
  expect(Number(again.unit_cost)).toBe(123);
  expect(again.cost_stack).toMatchObject({ preset: 'QA', taxPct: 8 });
});

test('after a listing run: ONE "listed" post, built from what went through', async () => {
  const { announceLines } = await import('../api/presell-listings/announce.js');
  const rows = [
    { sku: 'JA1091-100', name: 'Air Griffey', size: '8', in_transit: true, arrived_at: null, transit_note: 'PO 1042', expected_on: '2026-10-12', platform: 'alias', n: 12, live: 12, min_cents: 25000, max_cents: 25000 },
    { sku: 'JA1091-100', name: 'Air Griffey', size: '8', in_transit: true, arrived_at: null, transit_note: 'PO 1042', expected_on: '2026-10-12', platform: 'stockx', n: 12, live: 10, min_cents: 26000, max_cents: 26000 },
    { sku: 'JA1091-100', name: 'Air Griffey', size: '9', in_transit: true, arrived_at: null, transit_note: 'PO 1042', expected_on: '2026-10-12', platform: 'alias', n: 19, live: 19, min_cents: 25500, max_cents: 25500 },
  ];
  const text = announceLines(rows, 'Kervy').map((l) => (typeof l === 'string' ? l : l.b)).join('\n');
  expect(text).toContain('🚚 LISTED — IN-TRANSIT PRE-SELL');
  expect(text).toContain('31 pairs · by Kervy');
  expect(text).toContain('JA1091-100 · Air Griffey');
  expect(text).toContain('Shipment: PO 1042 · expected 2026-10-12');
  expect(text).toContain('US 8 — 12 pairs · Alias 12 · StockX 12\nUS 9 — 19 pairs · Alias 19');
  // Sorted by size, not as text: 9.5 before 10.
  const sorted = announceLines([{ ...rows[2], size: '10' }, { ...rows[2], size: '9.5' }, { ...rows[2], size: '8' }], '').filter((l) => typeof l === 'string' && l.startsWith('US '));
  expect(sorted).toEqual(['US 8 — 19 pairs · Alias 19', 'US 9.5 — 19 pairs · Alias 19', 'US 10 — 19 pairs · Alias 19']);
  expect(text).toContain('Alias: 31 listings at $250–$255');
  expect(text).toContain('StockX: 12 listings at $260 (2 not live yet)');
  const plain = announceLines([{ ...rows[0], in_transit: false }], '').map((l) => (typeof l === 'string' ? l : l.b)).join('\n');
  expect(plain).toContain('📝 LISTED — PRE-SELL');
});

test('↻ Re-check pending re-reads each pending listing ONE AT A TIME', async ({ page }) => {
  const { loginAs } = await import('./helpers/auth.js');
  const pending = Array.from({ length: 5 }, (_, i) => ({ id: 900 + i, stock_id: 1, platform: 'stockx', external_id: `sx-${i}`, status: 'pending',
    price_cents: 23000, sku: 'JA1091-100', name: 'Air Griffey', size: '10', created_at: new Date().toISOString(), last_error: 'Too Many Requests' }));
  let inFlight = 0; let maxInFlight = 0; let calls = 0;
  await page.route('**/api/presell-listings/list**', (r) => {
    const view = new URL(r.request().url()).searchParams.get('view');
    return r.fulfill({ json: { ok: true, rows: view === 'pending' || view === 'all' ? pending : [], counts: { all: 5, pending: 5 } } });
  });
  await page.route('**/api/presell-listings/action', async (r) => {
    inFlight++; calls++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((res) => setTimeout(res, 150));
    inFlight--;
    await r.fulfill({ json: { ok: true, listing: { ...pending[0], status: 'live' } } });
  });
  await loginAs(page, 'ph_team');
  await page.goto('/ph/presell-listings?tab=listings');
  await page.getByRole('button', { name: /Re-check pending \(5\)/ }).click();
  await expect(page.getByText('Re-checked 5 — 5 settled.')).toBeVisible();
  expect(calls).toBe(5);
  expect(maxInFlight).toBe(1);
});

test('＋ Fill missing listings tops each short size up, ONE size at a time', async ({ page }) => {
  const { loginAs } = await import('./helpers/auth.js');
  const stock = [
    { id: 1, sku: 'JA1091-100', name: 'Air Griffey', size: '9', qty: 19, sold: 0, alias_live: 19, alias_other: 0, stockx_live: 6, stockx_other: 3 },   // 10 missing
    { id: 2, sku: 'JA1091-100', name: 'Air Griffey', size: '10', qty: 26, sold: 0, alias_live: 26, alias_other: 0, stockx_live: 5, stockx_other: 4 },  // 17 missing
    { id: 3, sku: 'JA1091-100', name: 'Air Griffey', size: '11', qty: 2, sold: 0, alias_live: 2, alias_other: 0, stockx_live: 2, stockx_other: 0 },    // full
  ];
  const calls = []; let inFlight = 0; let maxInFlight = 0;
  await page.route('**/api/presell-listings/list**', (r) => r.fulfill({ json: { ok: true, rows: stock } }));
  await page.route('**/api/presell-listings/action', async (r) => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    const b = r.request().postDataJSON(); calls.push(b);
    await new Promise((res) => setTimeout(res, 150));
    inFlight--;
    const n = b.stockId === 1 ? 10 : 17;
    await r.fulfill({ json: { ok: true, created: n, results: Array.from({ length: n }, () => ({ ok: true })) } });
  });
  await loginAs(page, 'ph_team');
  await page.goto('/ph/presell-listings?tab=stock');
  await page.getByRole('button', { name: '＋ Fill missing listings' }).click();
  const dlg = page.getByRole('dialog', { name: 'Fill missing listings' });
  await expect(dlg).toContainText('27 StockX listings missing across 2 sizes');
  await dlg.getByLabel('Price for the missing listings').fill('230');
  await dlg.getByRole('button', { name: 'List 27 on StockX' }).click();
  await expect(dlg).toContainText('Done: 27 listed.');
  expect(calls.map((c) => [c.stockId, c.action, c.platform, c.price, c.activate])).toEqual([[1, 'list', 'stockx', 230, true], [2, 'list', 'stockx', 230, true]]);
  expect(maxInFlight).toBe(1);
});

test('Listings: one card per SKU + size with the pair count and per-platform summary; tap for the pairs', async ({ page }) => {
  const { loginAs } = await import('./helpers/auth.js');
  const rows = []; let id = 1;
  const mk = (stock, size, platform, status) => rows.push({ id: id++, stock_id: stock, sku: 'JA1091-100', name: 'Air Griffey', image: null, size, platform, status,
    price_cents: 23000, external_id: `x${id}`, created_at: new Date(Date.now() - id * 1000).toISOString(), created_by: 'Kervy', last_error: null });
  for (let i = 0; i < 26; i++) mk(5, '10', 'alias', 'live');
  for (let i = 0; i < 5; i++) mk(5, '10', 'stockx', 'live');
  for (let i = 0; i < 4; i++) mk(5, '10', 'stockx', 'pending');
  for (let i = 0; i < 2; i++) mk(1, '9.5', 'alias', 'live');
  await page.route('**/api/presell-listings/list**', (r) => r.fulfill({ json: { ok: true, rows, counts: { all: rows.length } } }));
  await loginAs(page, 'ph_team');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/ph/presell-listings?tab=listings');
  const cards = page.locator('.ap-group');
  await expect(cards).toHaveCount(2);
  await expect(cards.first()).toContainText('size 9.5');            // sizes smallest first
  const ten = cards.nth(1);
  await expect(ten.locator('.ap-group-count')).toContainText('26');
  await expect(ten).toContainText('5 ON');
  await expect(ten).toContainText('4 PENDING');
  await expect(ten).toContainText('17 —');                         // pairs with no StockX listing
  await expect(ten.locator('.ap-pair')).toHaveCount(0);            // closed until tapped
  await ten.locator('.ap-group-head').click();
  await expect(ten.locator('.ap-pair')).toHaveCount(26);
  // No sideways scroll on a phone.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

test('✎ Edit prices: every open listing of a size, per platform, one at a time; pending skipped', async ({ page }) => {
  const { loginAs } = await import('./helpers/auth.js');
  const rows = []; let id = 1;
  const mk = (platform, status, cents) => rows.push({ id: id++, stock_id: 5, sku: 'JA1091-100', name: 'Air Griffey', image: null, size: '10', platform, status,
    price_cents: cents, external_id: `x${id}`, created_at: new Date(Date.now() - id * 1000).toISOString(), created_by: 'Kervy', last_error: null });
  for (let i = 0; i < 3; i++) mk('alias', 'live', 23000);
  mk('alias', 'live', 24000);           // already at the new price → not touched
  for (let i = 0; i < 2; i++) mk('stockx', 'live', 23000);
  mk('stockx', 'pending', 23000);       // can't take a price yet → skipped
  const calls = []; let inFlight = 0; let maxInFlight = 0;
  await page.route('**/api/presell-listings/list**', (r) => r.fulfill({ json: { ok: true, rows, counts: { all: rows.length } } }));
  await page.route('**/api/presell-listings/prices', (r) => r.fulfill({ json: { ok: true, prices: {} } }));
  await page.route('**/api/presell-listings/action', async (r) => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    calls.push(r.request().postDataJSON());
    await new Promise((res) => setTimeout(res, 100));
    inFlight--;
    await r.fulfill({ json: { ok: true, listing: {} } });
  });
  await loginAs(page, 'ph_team');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/ph/presell-listings?tab=listings');
  await page.getByRole('button', { name: '✎ Edit prices' }).click();
  const dlg = page.getByRole('dialog', { name: /Prices · JA1091-100 size 10/ });
  await dlg.getByLabel('New Alias price').fill('240');
  await dlg.getByLabel('New StockX price').fill('250');
  await expect(dlg).toContainText('1 listing is still pending on StockX');
  await dlg.getByRole('button', { name: 'Update 5 listings' }).click();
  await expect(dlg).toContainText('Done: 5 updated · 1 pending skipped.');
  expect(calls.map((c) => [c.action, c.price])).toEqual([['update', 240], ['update', 240], ['update', 240], ['update', 250], ['update', 250]]);
  expect(maxInFlight).toBe(1);
});

test('a 524 mid-run: the timed-out batch counts as sent (never re-sent), unsent lines stay with the right pairs', async ({ page }) => {
  const { loginAs } = await import('./helpers/auth.js');
  const calls = [];
  await page.route('**/api/sku-search**', (r) => r.fulfill({ json: { ok: true, product: null } }));
  await page.route('**/api/presell-listings/prices', (r) => r.fulfill({ json: { ok: true, prices: {} } }));
  await page.route('**/api/presell-listings/announce', (r) => r.fulfill({ json: { ok: true } }));
  await page.route('**/api/presell-listings/create', async (r) => {
    const body = r.request().postDataJSON(); calls.push(body);
    if (calls.length === 2) return r.fulfill({ status: 524, contentType: 'text/html', body: '<html>A timeout occurred</html>' });
    await r.fulfill({ json: { ok: true, created: body.items.reduce((n, i) => n + i.qty * 2, 0), failed: 0,
      lines: body.items.map((i, k) => ({ sku: i.sku, size: i.size, stockId: 100 + k, alias: { results: [] }, stockx: { results: [] } })) } });
  });
  await loginAs(page, 'ph_team');
  await page.goto('/ph/presell-listings');
  await page.getByRole('button', { name: '📋 Paste message' }).click();
  await page.getByLabel('Paste the message').fill('IQ5495-005\n8 x 18\n8.5 x 19\n9 x 4');
  await page.getByRole('button', { name: 'Add 41 pairs to the list' }).click();
  for (const [label, v] of [['Alias price for every pair', '250'], ['StockX price for every pair', '260']]) {
    await page.getByLabel(label).fill(v);
    await page.getByLabel(label).locator('xpath=following-sibling::button').click();
  }
  await page.getByRole('button', { name: /List 41 pairs on Alias \+ StockX/ }).click();
  await page.getByRole('button', { name: 'List live' }).click();
  await expect(page.locator('.error')).toContainText("Don't list those again");
  // ≤ 20 listings a call (10 pairs on two platforms); stopped at the 524 (call 2).
  expect(calls).toHaveLength(2);
  for (const c of calls) expect(c.items.reduce((n, i) => n + i.qty * 2, 0)).toBeLessThanOrEqual(20);
  // Calls 1–2 carried size 8: 10 + 8 = 18 → all of it counts as sent; 8.5 and 9 untouched.
  const cart = await page.locator('.ap-cart-line').allInnerTexts();
  expect(cart.map((t) => t.match(/size (\S+)/)?.[1])).toEqual(['8.5', '9']);
  await expect(page.getByLabel('Line 1 quantity')).toHaveValue('19');
});
