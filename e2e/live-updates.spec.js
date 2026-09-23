// Live updates: a write shows on an open page without a refresh (docs/context/live-updates.md).
//
// The chain under test is the whole one — the sb_live trigger, the server's LISTEN, the
// /api/live stream, the tab's shared connection and useLive re-reading through the
// ordinary endpoint. The page is marked before the write and the mark is checked after,
// so a test that passed by reloading the page would fail here.
import { test, expect } from '@playwright/test';
import { signToken } from '../api/_lib/util.js';
import { loadEnv, loginAs } from './helpers/auth.js';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (t, v) => pool.query(t, v).then((r) => r.rows);
const wh = () => ({ Authorization: `Bearer ${signToken({ uid: 'e2e-live', username: 'e2e_live', name: 'E2E Live', role: 'warehouse' })}` });
const SUPPLIER = 'E2E Live Supplier';

test.afterAll(async () => {
  await q(`DELETE FROM items WHERE batch_id IN (SELECT id FROM batches WHERE supplier_name = $1)`, [SUPPLIER]);
  await q(`DELETE FROM batches WHERE supplier_name = $1`, [SUPPLIER]);
  await pool.end();
});

test('the stream refuses a request with no sign-in', async ({ request }) => {
  const r = await request.get('/api/live');
  expect(r.status()).toBe(401);
});

test('a count on the home page moves when somebody else writes — no refresh', async ({ page, request }) => {
  await loginAs(page, 'warehouse');
  await page.goto('/');
  // Whatever the count is now (the tile is hidden at zero), and a mark on THIS page load.
  await expect(page.locator('.home-section, .home-card').first()).toBeVisible();
  await expect(page.locator('.live-dot--live')).toBeVisible({ timeout: 10_000 });
  const tile = page.locator('.home-attention').filter({ hasText: 'Pre-sell to work' });
  // Read the starting number off the endpoint the tile is drawn from — the tile itself
  // may not have loaded yet, and is absent altogether at zero.
  const before = (await (await request.get('/api/items/pending-counts', { headers: wh() })).json()).counts.presell_pending;
  if (before > 0) await expect(tile.locator('.home-attention-count')).toHaveText(String(before));
  await page.evaluate(() => { window.__sameLoad = true; });

  // Somebody else receives a pre-sell shipment of three pairs.
  const sku = `E2E-LIVE-${Date.now().toString(36)}`;
  const items = Array.from({ length: 3 }, () => ({ name: 'E2E Live Runner', sku, size: '9', cost: 90, withBox: true }));
  const r = await request.post('/api/batches/commit', {
    headers: wh(),
    data: { kind: 'receiving', batch: { supplier: SUPPLIER, tracking: `E2E-LIVE-${Date.now()}`, preSell: true }, items, issues: [] },
  });
  expect(r.ok(), await r.text()).toBeTruthy();

  // The tile shows the new number well inside the 60 s fallback — pushed, not polled.
  await expect(tile.locator('.home-attention-count')).toHaveText(String(before + 3), { timeout: 8_000 });
  expect(await page.evaluate(() => window.__sameLoad)).toBe(true);
});
