// Raw 1ID stickers — the "VIN Project" intake mode.
//
// The operational invariant: a pair leaves the bench wearing the number that is
// physically stuck to it. Everything else here exists to protect that — the sticker
// scan binds, an un-stickered pair can't be committed, a used sticker is refused, and
// intake never mints a competing VIN behind the scan.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers/auth.js';
import { signToken } from '../api/_lib/util.js';
import pg from 'pg';

// The app authenticates with a Bearer token from sessionStorage, not a cookie, so
// direct API calls have to carry it themselves (same pattern as batch-continue-box).
const AUTH = {
  Authorization: `Bearer ${signToken({ uid: 'e2e-wh', username: 'e2e_wh', name: 'E2E Warehouse', role: 'warehouse' })}`,
};

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, values) => pool.query(text, values).then((r) => r.rows);

const SKU = 'ZZZ-RAWVIN-1';
let minted = [];

// Put the browser in raw-1ID mode before the app boots — the pref is read from
// localStorage at mount, so setting it afterwards wouldn't take effect.
async function rawMode(page, on = true) {
  await page.addInitScript((v) => {
    const k = 'sb_prefs';
    const cur = JSON.parse(localStorage.getItem(k) || '{}');
    localStorage.setItem(k, JSON.stringify({ ...cur, rawVins: v }));
  }, on);
}

test.beforeAll(async () => {
  const rows = await q(
    `INSERT INTO vin_stock (vin, run_id, printed_by)
     SELECT 'SBM-R-9' || lpad(g::text, 5, '0'), 9999, 'e2e' FROM generate_series(1, 4) g
     RETURNING vin`,
  );
  minted = rows.map((r) => r.vin).sort();
});

test.afterAll(async () => {
  await q(`DELETE FROM items WHERE sku = $1`, [SKU]);
  await q(`DELETE FROM vin_stock WHERE run_id = 9999`);
  await pool.end();
});

test.describe('Raw 1ID · the stock page', () => {
  test('mints stickers and counts what is left', async ({ page }) => {
    await loginAs(page, 'warehouse');
    await page.goto('/vin-stock');
    await expect(page.locator('.topbar .brand')).toContainText('1ID Stickers');
    // The four seeded stickers are unused, so the "ready to stick" count sees them.
    await expect(page.locator('.vs-count.big .vs-n')).not.toHaveText('0');
    await expect(page.getByRole('button', { name: /Mint & print/i })).toBeVisible();
  });

  test('a run can be reprinted', async ({ page }) => {
    await loginAs(page, 'warehouse');
    await page.goto('/vin-stock');
    const row = page.locator('tr', { hasText: '#9999' });
    await expect(row).toBeVisible();
    await expect(row.getByRole('button', { name: 'Reprint' })).toBeEnabled();
  });
});

// The scan bar lives on step 2 of the wizard, so every receiving test has to get past
// the shipment header first (supplier + tracking are both enforced).
async function toItemsStep(page) {
  await page.goto('/receiving');
  await page.locator('label:has-text("Supplier") select').selectOption({ index: 1 });
  await page.locator('.track-field input').first().fill(`E2E-RAWVIN-${Date.now()}`);
  await page.getByRole('button', { name: 'Next →' }).click();
}

test.describe('Raw 1ID · receiving', () => {
  test('the scan bar asks for the shoe, then the sticker', async ({ page }) => {
    await rawMode(page);
    await loginAs(page, 'warehouse');
    await toItemsStep(page);
    await expect(page.getByPlaceholder(/Scan the shoe/i)).toBeVisible();
    await expect(page.locator('.rawvin-beat')).toContainText('Scan the shoe');
  });

  // Guards `pickStickerSlot`: the bar names a pair, and the sticker must land on THAT
  // pair's size row — the same pick the PO manifest highlights.
  test('the sticker binds to the pair the bar names', async ({ page }) => {
    await rawMode(page);
    await loginAs(page, 'warehouse');
    await page.route('**/api/sku-search', (route) => route.fulfill({
      json: { ok: true, product: { name: 'Raw VIN Runner', sku: SKU, image: '', source: 'manual', scannedSize: '9', sizes: ['9', '9.5'] } },
    }));
    await toItemsStep(page);

    await page.locator('.scanbar input').first().fill(SKU);
    await page.locator('.scanbar').getByRole('button', { name: 'Add' }).click();
    const line = page.locator(`.recv-item[data-sku="${SKU}"]`);
    await expect(line).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.rawvin-beat')).toContainText('Scan the 1ID');
    await expect(line).toHaveClass(/needs-fix/);   // no sticker yet → can't be saved

    await page.locator('.scanbar input').first().fill(minted[0]);
    await page.locator('.scanbar').getByRole('button', { name: 'Add' }).click();
    await expect(line).not.toHaveClass(/needs-fix/);
    await line.locator('.recv-size-row').first().click();
    await expect(line.locator('.recv-unit .vin')).toHaveText(minted[0]);
  });

  test('off by default — the normal flow is untouched', async ({ page }) => {
    await rawMode(page, false);
    await loginAs(page, 'warehouse');
    await toItemsStep(page);
    await expect(page.getByPlaceholder(/Scan or type UPC/i)).toBeVisible();
    await expect(page.locator('.rawvin-beat')).toHaveCount(0);
  });
});

test.describe('Raw 1ID · the guards hold', () => {
  test('a sticker already on a shoe is refused, and one that is free is not', async ({ request }) => {
    const free = minted[0];
    const taken = minted[1];
    await q(`UPDATE vin_stock SET status = 'assigned' WHERE vin = $1`, [taken]);

    const okRes = await request.get(`/api/vins/check?vin=${free}`, { headers: AUTH });
    expect((await okRes.json()).state).toBe('available');

    const badRes = await request.get(`/api/vins/check?vin=${taken}`, { headers: AUTH });
    expect((await badRes.json()).state).toBe('assigned');

    const unknownRes = await request.get('/api/vins/check?vin=SBM-R-000000', { headers: AUTH });
    expect((await unknownRes.json()).state).toBe('unknown');

    await q(`UPDATE vin_stock SET status = 'available' WHERE vin = $1`, [taken]);
  });

  test('a voided sticker stays voided and cannot be handed out', async ({ request }) => {
    const v = minted[2];
    const res = await request.post('/api/vins/void', { data: { vins: [v] }, headers: AUTH });
    expect((await res.json()).voided).toContain(v);
    const after = await request.get(`/api/vins/check?vin=${v}`, { headers: AUTH });
    expect((await after.json()).state).toBe('void');
  });

  test('committing with a scanned sticker keeps THAT number on the shoe', async ({ request }) => {
    const v = minted[3];
    const res = await request.post('/api/batches/commit', {
      headers: AUTH,
      data: {
        kind: 'receiving',
        batch: { supplier: 'E2E-RAWVIN', tracking: 'E2E-RAWVIN-1', dateReceived: '2026-08-19' },
        items: [{ name: 'Raw VIN test', sku: SKU, size: '9', vin: v, withBox: true }],
      },
    });
    expect(res.ok()).toBeTruthy();
    const rows = await q(`SELECT vin FROM items WHERE sku = $1`, [SKU]);
    // The shoe wears the sticker's number — NOT a freshly minted dated VIN.
    expect(rows.map((r) => r.vin)).toEqual([v]);
    // …and the sticker is marked used, so it can't be handed out twice.
    const stock = await q(`SELECT status FROM vin_stock WHERE vin = $1`, [v]);
    expect(stock[0].status).toBe('assigned');
  });
});
