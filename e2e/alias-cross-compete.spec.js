// Alias Cross-Listing ⚔ PRICE COMPETE (docs/context/alias-cross-listing.md → "Price compete"):
// pre-sell's rules (undercut $1 / match, $5 floor, follow up, 2-hour re-base, 🔒 lock) per size
// × SKU — each SKU against its OWN market. Alias and Telegram are fakes; nothing leaves here.
import { test, expect } from '@playwright/test';
import pg from 'pg';
import { signToken } from '../api/_lib/util.js';
import { loadEnv, loginAs } from './helpers/auth.js';

loadEnv();
test.describe.configure({ mode: 'serial' });
const tag = `E2ECMP-${`${Date.now()}`.slice(-7)}`;
const NAME = `${tag} Dunk Low`;
const as = (role) => ({ Authorization: `Bearer ${signToken({ uid: `e2e-${role}`, username: `e2e-${role}`, name: `E2E ${role}`, role })}` });
let db; let S; let saved; let groupId; let skus; let pool9; let pool10;

// What "Alias" holds: { [external_id]: cents | 'gone' | 'off' }.
const prices = {};
const calls = [];
const io = {
  refresh: async (l) => {
    const p = prices[l.external_id];
    if (p === 'gone') return { ok: false, notFound: true, error: 'not found' };
    if (p === 'off') return { ok: true, status: 'off', price_cents: 20000 };
    return { ok: true, status: 'live', price_cents: p };
  },
  update: async (l, { priceCents }) => { calls.push(`${l.external_id}:${priceCents}`); prices[l.external_id] = priceCents; return { ok: true, status: 'live', price_cents: priceCents }; },
};
const sent = [];
const notify = async (lines) => { sent.push(lines.map((l) => (typeof l === 'string' ? l : l.b + (l.t || ''))).join('\n')); };
const row = async (pool, sku) => (await S.crossCompRows()).find((r) => Number(r.pool_id) === Number(pool.id) && r.sku === sku);
const comp = async (pool, k) => (await db.query(`SELECT lock_cents, base_cents, state FROM cross_comp WHERE pool_id = $1 AND group_sku_id = $2`, [pool.id, k.id])).rows[0];
async function list(pool, k, n, cents, sfx) {
  for (let i = 0; i < n; i++) {
    const id = `${tag}-${sfx}${i}`;
    await S.insertCrossListing({ pool_id: pool.id, group_sku_id: k.id, external_id: id, size_value: Number(pool.size), price_cents: cents, status: 'live' }, 'e2e');
    prices[id] = cents;
  }
}

test.beforeAll(async () => {
  db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  S = await import('../api/_lib/db.js');
  saved = await S.crossCompSettings();
  groupId = await S.createCrossGroup({ name: NAME, skus: [
    { catalogId: `${tag}-a`, sku: 'AA1111-100', name: 'Dunk A', sizes: { 9: 9, 10: 10 } },
    { catalogId: `${tag}-b`, sku: 'BB2222-200', name: 'Dunk B', sizes: { 9: 9, 10: 10 } },
  ] }, 'e2e');
  skus = await S.getCrossGroupSkus(groupId);
  pool9 = await S.upsertCrossPool({ groupId, size: '9', addQty: 2 }, 'e2e');
  pool10 = await S.upsertCrossPool({ groupId, size: '10', addQty: 2 }, 'e2e');
});
test.afterAll(async () => {
  if (!db) return;
  if (groupId) await S.deleteCrossGroup(groupId);
  await S.setSetting('cross_comp_master', saved.master ? 'on' : '', 'e2e');
  await S.setSetting('cross_comp_all', saved.all.on ? 'on' : '', 'e2e');
  await S.setSetting('cross_comp_all_mode', saved.all.mode, 'e2e');
  await S.setSetting('cross_lock', saved.lock ? 'on' : 'off', 'e2e');
  await db.end();
});

test('the engine: each SKU against its own market — adopts the live price, moves every live listing, keeps the floor, follows up', async () => {
  const { competeCrossOne } = await import('../api/_lib/cross-compete.js');
  const [a, b] = skus;
  await list(pool9, a, 2, 28400, 'a');
  await list(pool9, b, 2, 20000, 'b');
  // Alias really has SKU A at $180 (changed before any lock existed) — our rows still say $284.
  prices[`${tag}-a0`] = 18000; prices[`${tag}-a1`] = 18000;
  const r1 = await competeCrossOne(await row(pool9, 'AA1111-100'), 'undercut', { io, market: async () => 17900 });
  expect(r1).toMatchObject({ action: 'down', from_cents: 18000, to_cents: 17800, floor_cents: 17500, changed: 2, sku: 'AA1111-100' });
  expect(calls).toEqual([`${tag}-a0:17800`, `${tag}-a1:17800`]);
  expect(await comp(pool9, a)).toMatchObject({ lock_cents: 17800, base_cents: 18000 });
  expect((await comp(pool9, a)).state).toMatchObject({ price: 17800, market: 17900, floor: 17500 });
  // SKU B was not touched: it has its own market.
  expect([prices[`${tag}-b0`], prices[`${tag}-b1`]]).toEqual([20000, 20000]);
  expect(await competeCrossOne(await row(pool9, 'BB2222-200'), 'match', { io, market: async () => 19700 })).toMatchObject({ action: 'down', to_cents: 19700, changed: 2 });
  // SKU A's market crashes to $150: it stops at its floor. Then up to $230: it follows, $1 under.
  expect(await competeCrossOne(await row(pool9, 'AA1111-100'), 'undercut', { io, market: async () => 15000 })).toMatchObject({ action: 'floor', to_cents: 17500 });
  expect(await competeCrossOne(await row(pool9, 'AA1111-100'), 'undercut', { io, market: async () => 23000 })).toMatchObject({ action: 'up', to_cents: 22900 });
  expect([prices[`${tag}-a0`], prices[`${tag}-a1`]]).toEqual([22900, 22900]);
  const ours = (await S.openCrossListings(pool9.id)).filter((l) => l.sku === 'AA1111-100').map((l) => Number(l.price_cents));
  expect(ours).toEqual([22900, 22900]);
});

test('2-hour rule: the market under the floor for 2 h becomes the new price we set', async () => {
  const { competeCrossOne } = await import('../api/_lib/cross-compete.js');
  const b = skus[1];
  const t0 = Date.parse('2026-11-20T12:00:00Z');
  const opts = (now) => ({ io, market: async () => 16000, now });
  expect(await competeCrossOne(await row(pool9, 'BB2222-200'), 'undercut', opts(t0))).toMatchObject({ action: 'floor', to_cents: 19500 });
  expect(await competeCrossOne(await row(pool9, 'BB2222-200'), 'undercut', opts(t0 + 60 * 60_000))).toMatchObject({ action: 'hold' });
  expect(await competeCrossOne(await row(pool9, 'BB2222-200'), 'undercut', opts(t0 + 121 * 60_000))).toMatchObject({ action: 'rebase', from_cents: 19500, to_cents: 15900, floor_cents: 15500 });
  expect(await comp(pool9, b)).toMatchObject({ lock_cents: 15900, base_cents: 16000 });
});

test('🔒 lock: a price changed outside the app is put back; off → kept and logged; a listing gone on Alias is passed over', async () => {
  const { competeCrossOne } = await import('../api/_lib/cross-compete.js');
  const { topUpSku, repriceSku } = await import('../api/_lib/cross.js');
  const a = skus[0];
  // Listing through the app sets "the price we set" for a SKU that had nothing up.
  let n = 0;
  const make = { create: async ({ priceCents }) => { const id = `${tag}-t${n++}`; prices[id] = priceCents; return { ok: true, external_id: id, price_cents: priceCents }; },
    price: async (id, cents) => { prices[id] = cents; return { ok: true }; } };
  expect(await topUpSku(pool10, a, { sizeValue: 10, priceCents: 20000, active: true }, 'e2e', make)).toMatchObject({ created: 2 });
  expect(await comp(pool10, a)).toMatchObject({ lock_cents: 20000, base_cents: 20000 });
  // A bulk reprice on Alias: $161.
  prices[`${tag}-t0`] = 16100; prices[`${tag}-t1`] = 16100;
  expect(await competeCrossOne(await row(pool10, 'AA1111-100'), null, { io, lock: true })).toMatchObject({ action: 'restore', from_cents: 16100, to_cents: 20000, restored: true, changed: 2 });
  expect(prices[`${tag}-t0`]).toBe(20000);
  // In competition the decision starts from the LOCKED price, not the outside one.
  prices[`${tag}-t0`] = 16100;
  expect(await competeCrossOne(await row(pool10, 'AA1111-100'), 'match', { io, lock: true, market: async () => 19800 })).toMatchObject({ action: 'down', from_cents: 16100, to_cents: 19800, restored: true });
  // Lock off: the outside price is kept and logged as drift.
  prices[`${tag}-t0`] = 18800;
  expect(await competeCrossOne(await row(pool10, 'AA1111-100'), null, { io, lock: false })).toMatchObject({ action: 'hold' });
  expect(prices[`${tag}-t0`]).toBe(18800);
  expect((await db.query(`SELECT action FROM cross_comp_log WHERE pool_id = $1 ORDER BY id DESC LIMIT 1`, [pool10.id])).rows[0].action).toBe('drift');
  // A price changed on the Listed tab is the new "price we set" and the new lock.
  expect(await repriceSku(pool10.id, a.id, 21000, 'e2e', make)).toMatchObject({ changed: 2 });
  expect(await comp(pool10, a)).toMatchObject({ lock_cents: 21000, base_cents: 21000 });
  // The oldest listing was deleted on Alias: it is marked down here and the next one is read.
  prices[`${tag}-t0`] = 'gone';
  expect(await competeCrossOne(await row(pool10, 'AA1111-100'), 'match', { io, lock: true, market: async () => 20800 })).toMatchObject({ action: 'down', to_cents: 20800, changed: 1 });
  const gone = (await db.query(`SELECT status, delete_reason FROM cross_listings WHERE external_id = $1`, [`${tag}-t0`])).rows[0];
  expect(gone).toEqual({ status: 'deleted', delete_reason: 'platform' });
});

test('a pass respects the switches and posts ONE message', async () => {
  const { runCrossCompetition, crossPriceLines } = await import('../api/_lib/cross-compete.js');
  // Start from a known place: every live listing at $220, locked there.
  for (const l of [...(await S.openCrossListings(pool9.id)), ...(await S.openCrossListings(pool10.id))]) {
    prices[l.external_id] = 22000;
    await S.updateCrossListing(l.id, { price_cents: 22000 }, 'e2e');
    await S.setCrossComp(l.pool_id, l.group_sku_id, { lock: 22000, base: 22000 });
  }
  const run = (extra = {}) => runCrossCompetition({ groupId, io, notify, market: async () => 21500, ...extra });
  await S.setSetting('cross_comp_master', '', 'e2e');
  await S.setSetting('cross_lock', 'off', 'e2e');
  expect(await run()).toMatchObject({ off: true });
  await S.setSetting('cross_comp_master', 'on', 'e2e');
  await S.setSetting('cross_comp_all', '', 'e2e');
  expect(await run()).toMatchObject({ ok: true, checked: 0 });          // master on, but no shoe takes part
  await S.setCrossGroupComp(groupId, { enabled: true, mode: 'match' });
  sent.length = 0;
  // Size 9 on two SKUs + size 10 on one = 3 size × SKU.
  expect(await run()).toMatchObject({ ok: true, checked: 3, moved: 3, notified: true });
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain('⚔ CROSS-LISTING PRICE CHANGES');
  expect(sent[0]).toContain('3 changes');
  expect(sent[0]).toContain(NAME);
  expect(sent[0]).toContain('US 9 · AA1111-100 ↓ $220 → $215');
  expect(sent[0]).toContain('US 9 · BB2222-200 ↓ $220 → $215');
  // Nothing moved → nothing posted.
  sent.length = 0;
  expect(await run()).toMatchObject({ moved: 0, notified: false });
  expect(sent).toHaveLength(0);
  // A size switched off by override is left alone; the other follows its market up.
  await S.setCrossPoolOverride(pool9.id, 'off', 'e2e');
  expect(await run({ market: async () => 21800 })).toMatchObject({ checked: 1, moved: 1 });
  // …and holds at the $5 floor when the market drops under it.
  expect(await run({ market: async () => 21000 })).toMatchObject({ checked: 1, moved: 1 });
  expect(await run({ market: async () => 21000 })).toMatchObject({ checked: 1, moved: 0 });
  await S.setCrossPoolOverride(pool9.id, null, 'e2e');
  expect(crossPriceLines([{ name: 'N', sku: 'X', size: '9', action: 'restore', from_cents: 16100, to_cents: 20000, restored: true }]).map((l) => (typeof l === 'string' ? l : l.b + (l.t || ''))).join('\n'))
    .toContain('US 9 · X 🔒 put back $161 → $200');
});

test('the endpoint: switches save; reset floor; Run now refuses where prices must not move; suppliers are out', async ({ request }) => {
  const post = (data, role = 'warehouse') => request.post('/api/cross-listing/compete', { headers: as(role), data });
  const r = await post({ action: 'all', on: true, mode: 'match' });
  expect(r.status()).toBe(200);
  expect((await r.json()).all).toEqual({ on: true, mode: 'match' });
  const off = await (await post({ action: 'group', groupId, enabled: false, mode: 'undercut' })).json();
  const g = off.groups.find((x) => x.id === groupId);
  expect(g.setting).toEqual({ enabled: false, mode: 'undercut' });
  expect(g.sizes.map((z) => z.mode)).toEqual([null, null]);
  expect(g.sizes[0].skus.map((k) => k.sku)).toEqual(['AA1111-100', 'BB2222-200']);
  const one = await (await post({ action: 'size', poolId: Number(pool9.id), override: 'on' }, 'ph_team')).json();
  expect(one.groups.find((x) => x.id === groupId).sizes.map((z) => z.mode)).toEqual(['undercut', null]);
  const follow = await (await post({ action: 'group', groupId, clear: true })).json();
  expect(follow.groups.find((x) => x.id === groupId).setting).toBeNull();
  // "reset floor" forgets the price we set (retaken from the live price at the next check).
  expect((await post({ action: 'base', poolId: Number(pool9.id), groupSkuId: Number(skus[0].id) })).status()).toBe(200);
  expect((await comp(pool9, skus[0])).base_cents).toBeNull();
  expect((await post({ action: 'run' })).status()).toBe(409);   // the test server has PRESELL_WATCH off
  expect((await post({ action: 'size', poolId: 999999999, override: 'on' })).status()).toBe(404);
  expect((await post({ action: 'group', groupId: 999999999, enabled: true })).status()).toBe(404);
  expect((await post({ action: 'master', on: true }, 'supplier')).status()).toBe(403);
  // The price-change chat: admin (or Check Access) only, and it must look like a chat id.
  expect((await request.post('/api/cross-listing/settings', { headers: as('ph_team'), data: { priceChatId: '-1001234567890' } })).status()).toBe(403);
  expect((await request.post('/api/cross-listing/settings', { headers: as('admin'), data: { priceChatId: 'price group' } })).status()).toBe(400);
});

test('the page: ⚔ Compete tab — switches, a shoe, its sizes with one line per SKU, the log', async ({ page }) => {
  page.on('pageerror', (err) => { throw err; });
  await loginAs(page, 'ph_team');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/ph/alias-cross?tab=compete');
  await expect(page.getByText(/Price compete is (ON|OFF)/)).toBeVisible();
  await expect(page.getByText(/Lock cross-listing prices is (ON|OFF)/)).toBeVisible();
  const card = page.locator('.ap-group').filter({ hasText: NAME });
  await card.getByRole('button', { name: 'On', exact: true }).first().click();
  await expect(card.getByText(/⚔ 2 of 2 sizes/)).toBeVisible();
  await card.locator('.ap-group-head').click();
  await expect(card.getByText('Size 9', { exact: true })).toBeVisible();
  await expect(card.locator('.ap-comp-plat').filter({ hasText: 'BB2222-200' }).first()).toContainText('live at');
  await expect(card.getByRole('button', { name: 'reset floor' }).first()).toBeVisible();
  await page.getByRole('button', { name: /Price changes/ }).click();
  await expect(page.locator('.ap-comp-logrow').filter({ hasText: NAME }).first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});
