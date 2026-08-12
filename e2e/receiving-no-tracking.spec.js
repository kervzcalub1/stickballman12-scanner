// "No tracking number" — some inbounds genuinely arrive without one (hand-delivered,
// local pickup, a supplier who never sent one). Before this, a receiving batch could
// not be committed at all without a tracking #, so those shipments had no honest way
// in. The flag is STATED by staff and stored on the batch (`batches.no_tracking`), so
// it stays distinguishable from a field somebody just left empty.
import { test, expect } from '@playwright/test';
import { signToken } from '../api/_lib/util.js';
import { loadEnv, loginAs } from './helpers/auth.js';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, values) => pool.query(text, values).then((r) => r.rows);
const authHeaders = () => ({
  Authorization: `Bearer ${signToken({ uid: 'e2e-wh', username: 'e2e_wh', name: 'E2E Warehouse', role: 'warehouse' })}`,
});

const SKU = 'E2E-NOTRACK-A';
const item = () => ({ name: 'E2E No-Tracking Runner', sku: SKU, size: '9.5', upc: '', withBox: true, source: 'manual' });
const batch = (extra) => ({
  kind: 'receiving',
  batch: { buyer: 'stickballman12', supplier: 'E2E No-Track Supplier', dateReceived: '2026-08-13', ...extra },
  items: [item()],
});

test.afterAll(async () => {
  await q('DELETE FROM item_events WHERE item_id IN (SELECT id FROM items WHERE sku = $1)', [SKU]);
  await q('DELETE FROM items WHERE sku = $1', [SKU]);
  await q("DELETE FROM batches WHERE supplier_name = 'E2E No-Track Supplier'");
  await pool.end();
});

test.describe('Receiving · no tracking number (API)', () => {
  test('a receiving batch with no tracking and no flag is still refused', async ({ request }) => {
    const res = await request.post('/api/batches/commit', { headers: authHeaders(), data: batch({ tracking: '' }) });
    expect(res.status()).toBe(400);
    // The message has to name the way out, or the rule just reads as a dead end.
    expect((await res.json()).error).toMatch(/No tracking number/i);
  });

  test('ticking the flag commits, and the batch records it', async ({ request }) => {
    const res = await request.post('/api/batches/commit', { headers: authHeaders(), data: batch({ tracking: '', noTracking: true }) });
    expect(res.status()).toBe(200);
    const { batchCode } = await res.json();
    const rows = await q('SELECT tracking_number, no_tracking FROM batches WHERE batch_code = $1', [batchCode]);
    expect(rows[0].no_tracking).toBe(true);
    expect(rows[0].tracking_number).toBeNull();
  });

  test('the flag wins over a stray tracking value — the two can never disagree', async ({ request }) => {
    const res = await request.post('/api/batches/commit', {
      headers: authHeaders(), data: batch({ tracking: 'E2E-STRAY-123', noTracking: true }),
    });
    expect(res.status()).toBe(200);
    const rows = await q('SELECT tracking_number, no_tracking FROM batches WHERE batch_code = $1', [(await res.json()).batchCode]);
    expect(rows[0].tracking_number).toBeNull();
    expect(rows[0].no_tracking).toBe(true);
  });

  test('a normal tracked batch is unchanged — the flag defaults to false', async ({ request }) => {
    const res = await request.post('/api/batches/commit', { headers: authHeaders(), data: batch({ tracking: `E2E-TRACKED-${Date.now()}` }) });
    expect(res.status()).toBe(200);
    const rows = await q('SELECT tracking_number, no_tracking FROM batches WHERE batch_code = $1', [(await res.json()).batchCode]);
    expect(rows[0].no_tracking).toBe(false);
    expect(rows[0].tracking_number).toMatch(/^E2E-TRACKED-/);
  });
});

test.describe('Receiving · no tracking number (wizard)', () => {
  test('Next is blocked with an empty tracking #, and the checkbox unblocks it', async ({ page }) => {
    await loginAs(page, 'warehouse');
    await page.goto('/receiving');
    await page.locator('.batch-form select').first().selectOption('Nike');

    // Blocked HERE, on step 1 — not after every shoe has been scanned in.
    await page.getByRole('button', { name: 'Next →' }).click();
    await expect(page.locator('.error')).toContainText(/tracking/i);
    await expect(page.locator('.batch-form')).toBeVisible();

    // Ticking it disables the field (and its scan/photo buttons) so the checkbox and
    // the field can't disagree about what this shipment had.
    await page.locator('.no-track-check input').check();
    const track = page.locator('.track-field input').first();
    await expect(track).toBeDisabled();
    await expect(track).toHaveAttribute('placeholder', 'No tracking number');

    await page.getByRole('button', { name: 'Next →' }).click();
    await expect(page.getByRole('button', { name: /Add Item/i })).toBeVisible();
  });

  test('typed tracking is cleared when the box is ticked, and restored blank when unticked', async ({ page }) => {
    await loginAs(page, 'warehouse');
    await page.goto('/receiving');
    const track = page.locator('.track-field input').first();
    await track.fill('1Z999AA10123456784');
    await page.locator('.no-track-check input').check();
    await expect(track).toHaveValue('');
    await page.locator('.no-track-check input').uncheck();
    await expect(track).toBeEnabled();
    await expect(track).toHaveValue('');
  });
});
