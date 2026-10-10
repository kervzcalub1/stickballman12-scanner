// Pre-sell MARKET COMPETITION (docs/context/presell-listings.md → "Market competition"):
// undercut $1 / match the lowest ask, never more than $5 under the price we set, follow the
// market up. Marketplaces are fakes — nothing here reaches Alias or StockX.
import { test, expect } from '@playwright/test';
import pg from 'pg';
import { signToken } from '../api/_lib/util.js';
import { loadEnv, loginAs } from './helpers/auth.js';
import { compDecide, compEffective, compFarCheck } from '../src/lib/presellCompete.js';

loadEnv();
test.describe.configure({ mode: 'serial' });
const stamp = `${Date.now()}`.slice(-7);
const SKU = `QACMP-${stamp}`;
const as = (role) => ({ Authorization: `Bearer ${signToken({ uid: `e2e-${role}`, username: `e2e-${role}`, name: `E2E ${role}`, role })}` });
let db; let S; let saved;

test.beforeAll(async () => {
  db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  S = await import('../api/_lib/db.js');
  saved = await S.presellCompSettings();
});
test.afterAll(async () => {
  if (!db) return;
  await db.query(`DELETE FROM presell_stock WHERE sku = $1`, [SKU]);
  await db.query(`DELETE FROM presell_comp_sku WHERE sku = $1`, [SKU]);
  await S.setSetting('presell_comp_master', saved.master ? 'on' : '', 'e2e');
  await S.setSetting('presell_comp_all', saved.all.on ? 'on' : '', 'e2e');
  await S.setSetting('presell_comp_all_mode', saved.all.mode, 'e2e');
  await S.setSetting('presell_lock', saved.lock ? 'on' : 'off', 'e2e');
  await db.end();
});

const d = (mode, market, current, base = current) => compDecide({ mode, marketCents: market * 100, currentCents: current * 100, baseCents: base * 100 });

test('the rules: undercut $1 / match, $5 floor from the price we set, follow the market up', () => {
  // Owner's example: set 180, someone lists 179.
  expect(d('undercut', 179, 180)).toMatchObject({ action: 'down', target: 17800 });
  expect(d('match', 179, 180)).toMatchObject({ action: 'down', target: 17900 });
  // ...and so on, down to the floor (180 − 5 = 175) — never under it.
  expect(d('undercut', 176, 177, 180)).toMatchObject({ action: 'down', target: 17500 });
  expect(d('undercut', 170, 177, 180)).toMatchObject({ action: 'floor', target: 17500 });
  expect(d('undercut', 170, 175, 180)).toMatchObject({ action: 'hold', target: 17500 });
  expect(d('match', 175, 176, 180)).toMatchObject({ action: 'down', target: 17500 });
  // The market goes up → we go up, above the price we set, no cap.
  expect(d('match', 182, 179, 180)).toMatchObject({ action: 'up', target: 18200 });
  expect(d('undercut', 400, 179, 180)).toMatchObject({ action: 'up', target: 39900 });
  // Lowest ask = our price → hold (it may be our own listing): no chasing ourselves.
  expect(d('undercut', 178, 178, 180)).toMatchObject({ action: 'hold' });
  // Undercut, already $1 under the next seller → hold.
  expect(d('undercut', 179, 178, 180)).toMatchObject({ action: 'hold' });
  // No market → nothing.
  expect(compDecide({ mode: 'match', marketCents: null, currentCents: 18000, baseCents: 18000 }).action).toBe('none');
});

test('who takes part: master → size override → shoe → All shoes', () => {
  const all = { on: true, mode: 'match' };
  expect(compEffective({ master: false, all, sku: null, override: 'on' })).toBeNull();
  expect(compEffective({ master: true, all, sku: null, override: null })).toBe('match');
  expect(compEffective({ master: true, all: { on: false, mode: 'match' }, sku: null, override: null })).toBeNull();
  expect(compEffective({ master: true, all, sku: { enabled: false, mode: 'undercut' }, override: null })).toBeNull();
  expect(compEffective({ master: true, all, sku: { enabled: false, mode: 'undercut' }, override: 'on' })).toBe('undercut');
  expect(compEffective({ master: true, all, sku: { enabled: true, mode: 'undercut' }, override: 'off' })).toBeNull();
});

function fakes(prices) {
  // prices: { [external_id]: cents } — what the "platform" holds; updates write here.
  const calls = [];
  const plat = (name) => ({
    refresh: async (l) => ({ ok: true, status: 'live', price_cents: prices[l.external_id] }),
    update: async (l, { priceCents }) => { calls.push(`${name}:${l.external_id}:${priceCents}`); prices[l.external_id] = priceCents; return { ok: true, status: 'live', price_cents: priceCents }; },
  });
  return { calls, platforms: { alias: plat('alias'), stockx: plat('stockx') } };
}

const sent = [];
const notify = async (lines) => { sent.push(lines.map((l) => (typeof l === 'string' ? l : l.b + (l.t || ''))).join('\n')); };

test('the 2-hour rule: under the floor for 2 h straight → re-base', () => {
  const t0 = Date.parse('2026-10-11T12:00:00Z');
  const first = compFarCheck({ marketCents: 15000, floorCents: 17500, farSince: null, now: t0 });
  expect(first).toEqual({ farSince: '2026-10-11T12:00:00.000Z', rebase: false });
  expect(compFarCheck({ marketCents: 15000, floorCents: 17500, farSince: first.farSince, now: t0 + 119 * 60_000 }).rebase).toBe(false);
  expect(compFarCheck({ marketCents: 15000, floorCents: 17500, farSince: first.farSince, now: t0 + 120 * 60_000 }).rebase).toBe(true);
  // The market came back over the floor: the clock resets.
  expect(compFarCheck({ marketCents: 17600, floorCents: 17500, farSince: first.farSince, now: t0 + 60 * 60_000 })).toEqual({ farSince: null, rebase: false });
});

test('the engine: adopts the live price first, moves every live listing, keeps the floor, follows up', async () => {
  const { competeOne } = await import('../api/_lib/presell-compete.js');
  const st = await S.upsertPresellStock({ sku: SKU, size: '10', name: 'QA Compete', addQty: 3 }, 'e2e');
  for (let i = 0; i < 2; i++) await db.query(`INSERT INTO presell_listings (stock_id, platform, external_id, price_cents, status) VALUES ($1, 'alias', $2, 28400, 'live')`, [st.id, `${SKU}-a${i}`]);
  // The platform really has $180 (changed before the lock existed) — the DB still says $284.
  // First check: the lock ADOPTS $180 (never pushes the old $284 back up).
  const prices = { [`${SKU}-a0`]: 18000, [`${SKU}-a1`]: 18000 };
  const f = fakes(prices);
  const row = async () => (await S.presellCompRows()).find((r) => r.id === st.id);
  const r1 = await competeOne(await row(), 'alias', 'undercut', { platforms: f.platforms, market: async () => 17900 });
  expect(r1).toMatchObject({ action: 'down', from_cents: 18000, to_cents: 17800, floor_cents: 17500, changed: 2 });
  expect(f.calls).toEqual([`alias:${SKU}-a0:17800`, `alias:${SKU}-a1:17800`]);
  const s1 = (await db.query(`SELECT comp_base_alias_cents, lock_alias_cents, comp_state FROM presell_stock WHERE id = $1`, [st.id])).rows[0];
  expect(s1).toMatchObject({ comp_base_alias_cents: 18000, lock_alias_cents: 17800 });
  expect(s1.comp_state.alias).toMatchObject({ price: 17800, market: 17900, floor: 17500 });
  // The market crashes to $150: we stop at the floor.
  expect(await competeOne(await row(), 'alias', 'undercut', { platforms: f.platforms, market: async () => 15000 })).toMatchObject({ action: 'floor', to_cents: 17500 });
  // It goes up to $230: we follow, $1 under.
  expect(await competeOne(await row(), 'alias', 'undercut', { platforms: f.platforms, market: async () => 23000 })).toMatchObject({ action: 'up', to_cents: 22900 });
  expect(Object.values(prices)).toEqual([22900, 22900]);
});

test('🔒 lock: a price changed outside the app is put back — competing or not', async () => {
  const { competeOne } = await import('../api/_lib/presell-compete.js');
  const st = await S.upsertPresellStock({ sku: SKU, size: '11', name: 'QA Compete', addQty: 2 }, 'e2e');
  await db.query(`INSERT INTO presell_listings (stock_id, platform, external_id, price_cents, status) VALUES ($1, 'alias', $2, 20000, 'live')`, [st.id, `${SKU}-l0`]);
  await S.setPresellLock(st.id, 'alias', 20000);
  // Alex's bulk reprice on Alias: $161.
  const prices = { [`${SKU}-l0`]: 16100 };
  const f = fakes(prices);
  const row = async () => (await S.presellCompRows()).find((r) => r.id === st.id);
  const r = await competeOne(await row(), 'alias', null, { platforms: f.platforms, lock: true });
  expect(r).toMatchObject({ action: 'restore', from_cents: 16100, to_cents: 20000, restored: true, changed: 1 });
  expect(prices[`${SKU}-l0`]).toBe(20000);
  // In competition, the decision starts from the LOCKED price, not the outside one.
  prices[`${SKU}-l0`] = 16100;
  const c = await competeOne(await row(), 'alias', 'match', { platforms: f.platforms, lock: true, market: async () => 19500 });
  expect(c).toMatchObject({ action: 'down', from_cents: 16100, to_cents: 19500, restored: true });
  // Lock off: the outside price is kept and logged as drift.
  prices[`${SKU}-l0`] = 18800;
  expect(await competeOne(await row(), 'alias', null, { platforms: f.platforms, lock: false })).toMatchObject({ action: 'hold' });
  expect(prices[`${SKU}-l0`]).toBe(18800);
  const last = (await db.query(`SELECT action FROM presell_comp_log WHERE stock_id = $1 ORDER BY id DESC LIMIT 1`, [st.id])).rows[0];
  expect(last.action).toBe('drift');
});

test('2-hour rule in the engine: the market becomes the new price we set, then the mode applies', async () => {
  const { competeOne } = await import('../api/_lib/presell-compete.js');
  const st = await S.upsertPresellStock({ sku: SKU, size: '12', name: 'QA Compete', addQty: 1 }, 'e2e');
  await db.query(`INSERT INTO presell_listings (stock_id, platform, external_id, price_cents, status) VALUES ($1, 'alias', $2, 28400, 'live')`, [st.id, `${SKU}-r0`]);
  await S.setPresellLock(st.id, 'alias', 28400); await S.setPresellCompBase(st.id, 'alias', 28400);
  const prices = { [`${SKU}-r0`]: 28400 };
  const f = fakes(prices);
  const row = async () => (await S.presellCompRows()).find((r) => r.id === st.id);
  const t0 = Date.parse('2026-10-11T12:00:00Z');
  const opts = (now) => ({ platforms: f.platforms, market: async () => 16000, now });
  expect(await competeOne(await row(), 'alias', 'undercut', opts(t0))).toMatchObject({ action: 'floor', to_cents: 27900 });
  expect(await competeOne(await row(), 'alias', 'undercut', opts(t0 + 60 * 60_000))).toMatchObject({ action: 'hold' });
  const r = await competeOne(await row(), 'alias', 'undercut', opts(t0 + 121 * 60_000));
  expect(r).toMatchObject({ action: 'rebase', from_cents: 27900, to_cents: 15900, floor_cents: 15500 });
  expect(prices[`${SKU}-r0`]).toBe(15900);
  expect((await db.query(`SELECT comp_base_alias_cents, lock_alias_cents FROM presell_stock WHERE id = $1`, [st.id])).rows[0]).toMatchObject({ comp_base_alias_cents: 16000, lock_alias_cents: 15900 });
});

test('a pass respects the switches and posts ONE price-alert message', async () => {
  const { runCompetition, priceAlertLines } = await import('../api/_lib/presell-compete.js');
  const prices = {};
  for (const r of (await db.query(`SELECT l.external_id FROM presell_listings l JOIN presell_stock s ON s.id = l.stock_id WHERE s.sku = $1`, [SKU])).rows) prices[r.external_id] = 22000;
  for (const r of (await db.query(`SELECT id FROM presell_stock WHERE sku = $1`, [SKU])).rows) await S.setPresellLock(r.id, 'alias', 22000);
  const f = fakes(prices);
  await S.setSetting('presell_comp_master', '', 'e2e');
  await S.setSetting('presell_lock', 'off', 'e2e');
  expect(await runCompetition({ sku: SKU, platforms: f.platforms, notify, market: async () => 21000 })).toMatchObject({ off: true });
  await S.setSetting('presell_comp_master', 'on', 'e2e');
  await S.setSetting('presell_comp_all', '', 'e2e');
  await S.setPresellCompSku(SKU, { enabled: true, mode: 'match' }, 'e2e');
  sent.length = 0;
  const pass = await runCompetition({ sku: SKU, platforms: f.platforms, notify, market: async () => 21500 });
  expect(pass).toMatchObject({ ok: true, sizes: 3, moved: 3, notified: true });
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain('⚔ PRE-SELL PRICE CHANGES');
  expect(sent[0]).toContain('3 changes');
  expect(sent[0]).toContain('US 10 · Alias ↓ $220 → $215');
  // Nothing moved → nothing posted.
  sent.length = 0;
  expect(await runCompetition({ sku: SKU, platforms: f.platforms, notify, market: async () => 21500 })).toMatchObject({ moved: 0, notified: false });
  expect(sent).toHaveLength(0);
  // A size switched off by override is left alone (lock off too).
  const ten = (await db.query(`SELECT id FROM presell_stock WHERE sku = $1 AND size = '10'`, [SKU])).rows[0].id;
  await S.setPresellCompOverride(ten, 'off', 'e2e');
  expect(await runCompetition({ sku: SKU, platforms: f.platforms, notify, market: async () => 21000 })).toMatchObject({ sizes: 2 });
  await S.setPresellCompOverride(ten, null, 'e2e');
  expect(priceAlertLines([{ sku: 'X', name: 'N', size: '9', platform: 'stockx', action: 'restore', from_cents: 16100, to_cents: 20000, restored: true }]).map((l) => (typeof l === 'string' ? l : l.b + (l.t || ''))).join('\n'))
    .toContain('US 9 · StockX 🔒 put back $161 → $200');
});

test('a price edited by hand becomes the new "price we set"', async ({ request }) => {
  // The endpoint path can't reach a marketplace here; the db helper is what action.js calls.
  const st = (await db.query(`SELECT id FROM presell_stock WHERE sku = $1 AND size = '10'`, [SKU])).rows[0];
  await S.setPresellCompBase(st.id, 'alias', 25000);
  expect((await db.query(`SELECT comp_base_alias_cents FROM presell_stock WHERE id = $1`, [st.id])).rows[0].comp_base_alias_cents).toBe(25000);
  // "reset" forgets it (retaken from the live price at the next check).
  const r = await request.post('/api/presell-listings/compete', { headers: as('ph_team'), data: { action: 'base', stockId: st.id, platform: 'alias' } });
  expect(r.status()).toBe(200);
  expect((await db.query(`SELECT comp_base_alias_cents FROM presell_stock WHERE id = $1`, [st.id])).rows[0].comp_base_alias_cents).toBeNull();
});

test('the endpoint: switches save; Run now refuses where prices must not move; suppliers are out', async ({ request }) => {
  const post = (data, role = 'warehouse') => request.post('/api/presell-listings/compete', { headers: as(role), data });
  const r = await post({ action: 'all', on: true, mode: 'match' });
  expect(r.status()).toBe(200);
  expect((await r.json()).all).toEqual({ on: true, mode: 'match' });
  const sku = await (await post({ action: 'sku', sku: SKU.toLowerCase(), enabled: false, mode: 'undercut' })).json();
  const shoe = sku.shoes.find((x) => x.sku === SKU);
  expect(shoe.setting).toMatchObject({ enabled: false, mode: 'undercut' });
  expect(shoe.sizes[0].mode).toBeNull();
  expect((await post({ action: 'run' })).status()).toBe(409);   // the test server has PRESELL_WATCH off
  expect((await post({ action: 'size', stockId: 999999999, override: 'on' })).status()).toBe(404);
  expect((await post({ action: 'master', on: true }, 'supplier')).status()).toBe(403);
});

test('the page: ⚔ Compete tab — master switch, All shoes, a shoe and its sizes, the log', async ({ page }) => {
  page.on('pageerror', (err) => { throw err; });
  await loginAs(page, 'ph_team');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/ph/presell-listings?tab=compete');
  await expect(page.getByText(/Market competition is (ON|OFF)/)).toBeVisible();
  await expect(page.getByText(/Lock pre-sell prices is (ON|OFF)/)).toBeVisible();
  const card = page.locator('.ap-group').filter({ hasText: SKU });
  await card.getByRole('button', { name: 'On', exact: true }).first().click();
  await expect(card.getByText(/⚔ 3 of 3 sizes/)).toBeVisible();
  await card.locator('.ap-group-head').click();
  await expect(card.getByText('Size 10')).toBeVisible();
  await expect(card.getByText(/Alias/).first()).toBeVisible();
  await page.getByRole('button', { name: /Price changes/ }).click();
  await expect(page.locator('.ap-comp-logrow').filter({ hasText: SKU }).first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});
