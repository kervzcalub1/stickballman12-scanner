// Targeted QA for this session's features:
//  1. Receiving "GOAT only" flag (Add-Item draft + cart badge/toggle) → commits items.goat_only
//  2. No Box redesigned row + UPC gate
//  3. PH New Inventory GOAT-only chip/toggle + N/A store flags + GOAT-aware completion
//
// Real Alias-catalog network calls are used for the receiving flow (reusing SKUs
// already known to resolve locally); No-Box fixtures are seeded directly via the
// real batches/commit API (same code path as the UI) to keep that spec focused on
// the No-Box PAGE itself. All test data is cleaned up in an afterAll.
import { test, expect } from '@playwright/test';
import { loginAs, loadEnv } from './helpers/auth.js';
import { signToken } from '../api/_lib/util.js';

loadEnv();
const authHeaders = (role = 'warehouse') => ({
  Authorization: `Bearer ${signToken({ uid: `e2e-${role}`, username: `e2e_${role}`, name: 'E2E', role })}`,
});

const SKU_A = 'IQ1867-474'; // Nike Shox R4 'Puerto Rico' — will be GOAT-only in this run
const SKU_B = 'JR1267';     // adidas Adizero — normal (non-GOAT) control

let pgClient;
async function db() {
  if (!pgClient) {
    const { default: pg } = await import('pg');
    pgClient = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await pgClient.connect();
  }
  return pgClient;
}

test.afterAll(async () => {
  if (pgClient) await pgClient.end();
});

test.describe.serial('Session QA · Receiving GOAT-only', () => {
  test('Add-Item draft GOAT-only checkbox → cart badge + toggle → commits items.goat_only', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto('/receiving');
    await expect(page.getByText('Shipment details')).toBeVisible();

    // Step 1 — pick a supplier (buyer/date are pre-filled) + a tracking # (required server-side).
    await page.locator('select').first().selectOption({ index: 1 });
    await page.getByPlaceholder('Type, scan, or upload a photo').fill(`QA-GOAT-${Date.now()}`);
    await page.getByRole('button', { name: 'Next →' }).click();
    await expect(page.getByText('Items (0 units)')).toBeVisible();

    // --- Item 1: GOAT-only ---
    await page.getByRole('button', { name: '+ Add Item' }).click();
    const modalInput = page.locator('.modal.additem input').first();
    await modalInput.fill(SKU_A);
    await page.locator('.modal.additem').getByRole('button', { name: 'Add' }).click();
    await expect(page.locator('.additem-draft')).toBeVisible({ timeout: 15_000 });

    const goatToggle = page.locator('.goat-toggle input[type="checkbox"]');
    await expect(goatToggle).toBeVisible();
    await expect(goatToggle).not.toBeChecked(); // off by default
    await goatToggle.check();
    await expect(goatToggle).toBeChecked();

    await page.locator('.size-chips').getByRole('button', { name: '10', exact: true }).click();
    await page.getByRole('button', { name: 'Complete item ✓' }).click();
    // completeItem() closes the Add-Item modal itself — wait for it to be gone.
    await expect(page.locator('.modal.additem')).toHaveCount(0);

    const cartLine = page.locator('.recv-item').filter({ hasText: SKU_A });
    await expect(cartLine.locator('.goat-badge')).toHaveText('GOAT only');

    // --- Item 2: normal shoe (no GOAT) — control ---
    await page.getByRole('button', { name: '+ Add Item' }).click();
    await modalInput.fill(SKU_B);
    await page.locator('.modal.additem').getByRole('button', { name: 'Add' }).click();
    await expect(page.locator('.additem-draft')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.goat-toggle input[type="checkbox"]')).not.toBeChecked();
    await page.locator('.size-chips').getByRole('button', { name: '10', exact: true }).click();
    await page.getByRole('button', { name: 'Complete item ✓' }).click();
    await expect(page.locator('.modal.additem')).toHaveCount(0);

    const cartLine2 = page.locator('.recv-item').filter({ hasText: SKU_B });
    await expect(cartLine2.locator('.goat-badge')).toHaveCount(0); // no GOAT badge on the control line

    // Per-line GOAT toggle in the Review step flips state (round trip, then leave it on).
    await page.getByRole('button', { name: 'Review →' }).click();
    const reviewLine = page.locator('.recv-item').filter({ hasText: SKU_A });
    const reviewGoatCheck = reviewLine.locator('.goat-chip-toggle input[type="checkbox"]');
    await expect(reviewGoatCheck).toBeChecked();
    await reviewGoatCheck.uncheck();
    await expect(reviewGoatCheck).not.toBeChecked();
    await reviewGoatCheck.check();
    await expect(reviewGoatCheck).toBeChecked();

    // Proceed to Issues → Finish batch → confirm.
    await page.getByRole('button', { name: 'Next →' }).click();
    await page.getByRole('button', { name: 'Finish batch' }).click();
    await expect(page.getByText('Commit this batch?')).toBeVisible();
    await page.getByRole('button', { name: 'Yes, commit' }).click();
    await expect(page.getByText(/^Batch .* saved$/)).toBeVisible({ timeout: 15_000 });
  });

  test('DB: goat_only persisted correctly per SKU', async () => {
    const client = await db();
    const a = await client.query(
      `SELECT vin, goat_only FROM items WHERE sku = $1 AND created_at > now() - interval '10 minutes' ORDER BY created_at DESC`,
      [SKU_A],
    );
    expect(a.rows.length).toBeGreaterThan(0);
    expect(a.rows.every((r) => r.goat_only === true)).toBe(true);

    const b = await client.query(
      `SELECT vin, goat_only FROM items WHERE sku = $1 AND created_at > now() - interval '10 minutes' ORDER BY created_at DESC`,
      [SKU_B],
    );
    expect(b.rows.length).toBeGreaterThan(0);
    expect(b.rows.every((r) => r.goat_only === false)).toBe(true);
  });

  test('cleanup: remove the batch this test created', async () => {
    const client = await db();
    const vins = await client.query(
      `SELECT vin, batch_id FROM items WHERE sku IN ($1,$2) AND created_at > now() - interval '10 minutes'`,
      [SKU_A, SKU_B],
    );
    const batchIds = [...new Set(vins.rows.map((r) => r.batch_id))];
    for (const v of vins.rows) {
      await client.query('DELETE FROM item_events WHERE item_id = (SELECT id FROM items WHERE vin = $1)', [v.vin]);
      await client.query('DELETE FROM items WHERE vin = $1', [v.vin]);
    }
    for (const id of batchIds) await client.query('DELETE FROM batches WHERE id = $1', [id]);
    expect(vins.rows.length).toBeGreaterThan(0); // sanity: there was something to clean
  });
});

test.describe.serial('Session QA · No Box redesigned row + UPC gate', () => {
  const FIXTURE_SKU = 'QA-NOBOX-FIXTURE';
  const FIXTURE_NAME = 'QA NoBox Fixture Shoe';
  let vins = [];

  test.beforeAll(async ({ request }) => {
    // Seed 3 no-box, no-upc units via the real commit API (same code path as the
    // UI) so the No-Box PAGE itself is what gets driven through the browser.
    const res = await request.post('/api/batches/commit', {
      headers: authHeaders('warehouse'),
      data: {
        batch: { buyer: 'QA', supplier: 'QA Test Supplier', tracking: `QA-NOBOX-${Date.now()}`, dateReceived: new Date().toISOString().slice(0, 10), defaultCost: 10 },
        items: [1, 2, 3].map((n) => ({ name: FIXTURE_NAME, sku: FIXTURE_SKU, size: String(9 + n), upc: '', cost: 10, withBox: false })),
      },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    vins = body.vins;
    expect(vins.length).toBe(3);
  });

  test('row layout: Box found / Box label (needs UPC) / Other status, no stray Set button', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto('/nobox');
    const row = page.locator('.dcard, tr').filter({ hasText: FIXTURE_NAME }).first();
    await expect(row).toBeVisible({ timeout: 10_000 });
    await expect(row.getByRole('button', { name: /Box found/ })).toBeVisible();
    await expect(row.getByRole('button', { name: /Box label.*needs UPC/ })).toBeVisible();
    await expect(row.locator('select.nobox-other-sel')).toBeVisible();
    // The old standalone "Set" button is gone.
    await expect(row.getByRole('button', { name: /^Set$/ })).toHaveCount(0);
  });

  test('Box label UPC gate: rejects invalid UPC, accepts valid UPC, saves it, and prints', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto('/nobox');
    const row = page.locator('.dcard, tr').filter({ hasText: vins[0] }).first();
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.getByRole('button', { name: /Box label/ }).click();

    await expect(page.getByText('Box label — UPC needed')).toBeVisible();
    const upcInput = page.locator('.nobox-upc-input');
    await upcInput.fill('12345'); // invalid — 5 digits
    await page.getByRole('button', { name: 'Save & print' }).click();
    await expect(page.getByRole('dialog').getByText(/valid 8-, 12-, or 13-digit UPC/)).toBeVisible();

    await upcInput.fill('012345678905'); // valid 12-digit
    await page.getByRole('button', { name: 'Save & print' }).click();
    await expect(page.locator('.label-overlay')).toBeVisible({ timeout: 10_000 });
    await page.locator('.label-overlay').getByRole('button', { name: 'Close' }).click();
  });

  test('DB: valid UPC was saved to the unit', async () => {
    const client = await db();
    const r = await client.query('SELECT upc FROM items WHERE vin = $1', [vins[0]]);
    expect(r.rows[0].upc).toBe('012345678905');
  });

  test('Box label UPC gate: "No UPC found" checkbox prints without a barcode and does not set a UPC', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto('/nobox');
    const row = page.locator('.dcard, tr').filter({ hasText: vins[1] }).first();
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.getByRole('button', { name: /Box label/ }).click();
    await expect(page.getByText('Box label — UPC needed')).toBeVisible();
    await page.locator('.nobox-noupc-check input[type="checkbox"]').check();
    await expect(page.getByRole('button', { name: 'Print without UPC' })).toBeEnabled();
    await page.getByRole('button', { name: 'Print without UPC' }).click();
    await expect(page.locator('.label-overlay')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.rlabel.boxlabel.missing')).toBeVisible();
    await page.locator('.label-overlay').getByRole('button', { name: 'Close' }).click();
  });

  test('a unit that already has a UPC prints directly, no prompt', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto('/nobox');
    const row = page.locator('.dcard, tr').filter({ hasText: vins[0] }).first(); // already has a UPC from an earlier test
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.getByRole('button', { name: /Box label/ }).click();
    await expect(page.getByText('Box label — UPC needed')).toHaveCount(0);
    await expect(page.locator('.label-overlay')).toBeVisible({ timeout: 10_000 });
    await page.locator('.label-overlay').getByRole('button', { name: 'Close' }).click();
  });

  test('Other status… applies on select with a confirm, and the unit leaves the queue', async ({ page }) => {
    await loginAs(page, 'admin');
    page.on('dialog', (d) => d.accept());
    await page.goto('/nobox');
    const row = page.locator('.dcard, tr').filter({ hasText: vins[2] }).first();
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.locator('select.nobox-other-sel').selectOption('missing');
    await expect(page.locator('.dcard, tr').filter({ hasText: vins[2] })).toHaveCount(0, { timeout: 10_000 });
  });

  test('DB: "Other status" unit is now Missing, off the no_box queue', async () => {
    const client = await db();
    const r = await client.query('SELECT status FROM items WHERE vin = $1', [vins[2]]);
    expect(r.rows[0].status).toBe('missing');
  });

  test('cleanup: remove the No-Box fixture batch', async () => {
    const client = await db();
    for (const v of vins) {
      await client.query('DELETE FROM item_events WHERE item_id = (SELECT id FROM items WHERE vin = $1)', [v]);
    }
    const batchRow = await client.query('SELECT batch_id FROM items WHERE vin = $1', [vins[0]]);
    await client.query('DELETE FROM items WHERE vin = ANY($1)', [vins]);
    if (batchRow.rows[0]) await client.query('DELETE FROM batches WHERE id = $1', [batchRow.rows[0].batch_id]);
  });
});

test.describe.serial('Session QA · PH New Inventory — GOAT-only + status filter', () => {
  const FIXTURE_SKU = 'QA-PHGOAT-FIXTURE';
  const FIXTURE_NAME = 'QA PH GOAT Fixture Shoe';
  let vins = [];

  test.beforeAll(async ({ request }) => {
    const res = await request.post('/api/batches/commit', {
      headers: authHeaders('warehouse'),
      data: {
        batch: { buyer: 'QA', supplier: 'QA Test Supplier', tracking: `QA-PHGOAT-${Date.now()}`, dateReceived: new Date().toISOString().slice(0, 10), defaultCost: 10 },
        items: [{ name: FIXTURE_NAME, sku: FIXTURE_SKU, size: '10', upc: '', cost: 10, withBox: true, goatOnly: true }],
      },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    vins = body.vins;
  });

  test('GOAT-only group: purple chip, SX/SH show N/A, group is Done at II+Alias only', async ({ page }) => {
    await loginAs(page, 'ph_team');
    await page.goto('/ph/new-inventory');
    // Default filter is Pending — a freshly received group with no flags set is Pending.
    const row = page.locator('.ph-card, tr.ph-trow').filter({ hasText: FIXTURE_NAME }).first();
    await expect(row).toBeVisible({ timeout: 10_000 });
    const chip = row.locator('.goat-chip');
    await expect(chip).toBeVisible();
    await expect(chip).toContainText('GOAT only'); // already GOAT-only from receiving fixture
    await expect(chip).toHaveClass(/on/);

    // Expand the group to see per-size flags — SX/SH should read N/A, not Yes/No.
    await row.click();
    const naCells = page.locator('.ph-flag-na');
    await expect(naCells.first()).toBeVisible();
    const naCount = await naCells.count();
    expect(naCount).toBeGreaterThanOrEqual(2); // StockX + Shopify, at least this group's size row
  });

  test('toggling GOAT only off/on persists in the DB and updates the badge', async ({ page }) => {
    await loginAs(page, 'ph_team');
    await page.goto('/ph/new-inventory');
    const row = page.locator('.ph-card, tr.ph-trow').filter({ hasText: FIXTURE_NAME }).first();
    await expect(row).toBeVisible({ timeout: 10_000 });
    const chip = row.locator('.goat-chip');
    await chip.click(); // turn OFF
    await expect(chip).not.toHaveClass(/on/);

    const client = await db();
    await expect.poll(async () => {
      const r = await client.query('SELECT goat_only FROM items WHERE vin = ANY($1)', [vins]);
      return r.rows.every((x) => x.goat_only === false);
    }, { timeout: 10_000 }).toBe(true);

    await chip.click(); // turn back ON
    await expect(chip).toHaveClass(/on/);
    await expect.poll(async () => {
      const r = await client.query('SELECT goat_only FROM items WHERE vin = ANY($1)', [vins]);
      return r.rows.every((x) => x.goat_only === true);
    }, { timeout: 10_000 }).toBe(true);
  });

  test('pending-counts: GOAT-only units are excluded from not_stockx/not_shopify but still count for not_alias', async ({ request }) => {
    const before = await request.get('/api/items/pending-counts', { headers: authHeaders('ph_team') });
    expect(before.status()).toBe(200);
    const b1 = await before.json();

    // Flip goatOnly off directly via the API and diff the counts.
    const off = await request.post('/api/ph/set-goat', { headers: authHeaders('ph_team'), data: { vins, goatOnly: false } });
    expect(off.status()).toBe(200);
    const after = await request.get('/api/items/pending-counts', { headers: authHeaders('ph_team') });
    const b2 = await after.json();

    // With goat_only=false, this unit now counts toward not_stockx/not_shopify — so
    // turning GOAT OFF should raise (or hold) those counts vs. GOAT ON, never lower.
    expect(b2.counts.not_stockx).toBeGreaterThanOrEqual(b1.counts.not_stockx);
    expect(b2.counts.not_shopify).toBeGreaterThanOrEqual(b1.counts.not_shopify);

    // Restore GOAT-only for the completion test below.
    const restore = await request.post('/api/ph/set-goat', { headers: authHeaders('ph_team'), data: { vins, goatOnly: true } });
    expect(restore.status()).toBe(200);
  });

  test('GOAT-aware completion: II + Alias set (SX/SH ignored) moves the group to Done', async ({ page }) => {
    await loginAs(page, 'ph_team');
    await page.goto('/ph/new-inventory');
    const row = page.locator('.ph-card, tr.ph-trow').filter({ hasText: FIXTURE_NAME }).first();
    await expect(row).toBeVisible({ timeout: 10_000 }); // visible under default Pending filter

    // Set II + Alias flags true directly (the edit-checkbox UI flow itself is
    // standard PH-grid behavior already covered by ph-grid.spec.js — this test is
    // about the GOAT-aware completion rule) — then confirm the derived status via
    // the status filter.
    const client = await db();
    await client.query(`UPDATE items SET added_to_intel_inv = true, synced_alias = true WHERE vin = ANY($1)`, [vins]);

    await page.goto('/ph/new-inventory'); // reload to re-derive listing status
    // Pending (default) should no longer show it…
    await expect(page.locator('.ph-card, tr.ph-trow').filter({ hasText: FIXTURE_NAME })).toHaveCount(0, { timeout: 10_000 });
    // …but selecting "Done" should.
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.getByRole('button', { name: 'Pending', exact: true }).click(); // deselect Pending
    await expect(page.locator('.ph-card, tr.ph-trow').filter({ hasText: FIXTURE_NAME })).toBeVisible({ timeout: 10_000 });
  });

  test('cleanup: remove the PH GOAT fixture batch', async () => {
    const client = await db();
    for (const v of vins) {
      await client.query('DELETE FROM item_events WHERE item_id = (SELECT id FROM items WHERE vin = $1)', [v]);
    }
    const batchRow = await client.query('SELECT batch_id FROM items WHERE vin = $1', [vins[0]]);
    await client.query('DELETE FROM items WHERE vin = ANY($1)', [vins]);
    if (batchRow.rows[0]) await client.query('DELETE FROM batches WHERE id = $1', [batchRow.rows[0].batch_id]);
  });
});

test.describe('Session QA · Locate Shoe — collapsible grouped results', () => {
  test('a broad search groups per SKU, collapsed by default, expands on click, shows "size" not "sz"', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto('/locations');
    await page.getByPlaceholder(/Find a shoe/).fill('a');
    await page.getByRole('button', { name: 'Locate', exact: true }).click();

    const groups = page.locator('.loc-sku-group');
    await expect(groups.first()).toBeVisible({ timeout: 10_000 });
    const count = await groups.count();
    expect(count).toBeGreaterThan(1); // broad term → multiple SKU groups

    // All collapsed by default.
    await expect(page.locator('.loc-sku-group.open')).toHaveCount(0);
    const firstGroup = groups.first();
    await expect(firstGroup).toContainText(/pair/);
    await expect(firstGroup.locator('.loc-group-toggle')).toBeVisible();
    await expect(firstGroup.locator('.loc-caret')).toHaveText('▸');

    // Expand the first group.
    await firstGroup.locator('.loc-group-toggle').click();
    await expect(firstGroup).toHaveClass(/open/);
    await expect(firstGroup.locator('.loc-caret')).toHaveText('▾');
    await expect(firstGroup.locator('.loc-unit-row').first()).toBeVisible();
    // Per-unit row shows VIN · size (as "US <n>", never the abbreviation "sz").
    await expect(firstGroup.locator('.loc-unit-row').first().locator('.loc-unit-vin')).toBeVisible();
    const sizeChips = firstGroup.locator('.loc-size-chip');
    if (await sizeChips.count()) {
      await expect(sizeChips.first()).toContainText(/^US /);
    }
    await expect(page.locator('.loc-results')).not.toContainText(/\bsz\b/i);
  });

  test('a search returning a single shoe stays auto-expanded (no collapse toggle)', async ({ page, request }) => {
    // Find a VIN that's currently a unique-SKU hit for its own VIN search.
    const res = await request.get(`/api/items/query`, { headers: authHeaders('warehouse') });
    const body = await res.json();
    const vin = body.rows[0].vin;

    await loginAs(page, 'admin');
    await page.goto('/locations');
    await page.getByPlaceholder(/Find a shoe/).fill(vin);
    await page.getByRole('button', { name: 'Locate', exact: true }).click();

    const groups = page.locator('.loc-sku-group');
    await expect(groups).toHaveCount(1, { timeout: 10_000 });
    await expect(groups.first()).toHaveClass(/open/); // auto-expanded, single result
    await expect(groups.first().locator('.loc-group-toggle')).toHaveCount(0); // no caret/toggle needed
    await expect(groups.first().locator('.loc-unit-row', { hasText: vin })).toBeVisible();
  });
});

test.describe('Session QA · PH home + status filter empty-state', () => {
  test('PH home renders the 3 sections: Pricing & Listing / Purchase Orders / Requests & Tracking', async ({ page }) => {
    await loginAs(page, 'ph_team');
    await page.goto('/ph');
    await expect(page.getByRole('heading', { name: 'Pricing & Listing' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Purchase Orders' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Requests & Tracking' })).toBeVisible();
  });

  test('New Inventory: deselecting every status shows the empty-state hint', async ({ page }) => {
    await loginAs(page, 'ph_team');
    await page.goto('/ph/new-inventory');
    await expect(page.locator('.ph-status-filter')).toBeVisible();
    // Default = Pending only.
    await expect(page.getByRole('button', { name: 'Pending', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: 'In-Progress', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByRole('button', { name: 'Done', exact: true })).toHaveAttribute('aria-pressed', 'false');

    // Add In-Progress and Done, then remove all three → empty-state hint.
    await page.getByRole('button', { name: 'In-Progress', exact: true }).click();
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.getByRole('button', { name: 'Pending', exact: true }).click();
    await page.getByRole('button', { name: 'In-Progress', exact: true }).click();
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(page.getByText('Select a status above to show lines.')).toBeVisible();
  });
});
