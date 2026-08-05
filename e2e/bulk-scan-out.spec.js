// Bulk scan-out (Mark Shipped) — the high-volume loop: scan → scan → scan →
// review → submit. What's under test is what makes 300 scans a shift survivable:
// the scanner never closes, every scan answers, failures are KEPT with a reason
// rather than overwritten by the next scan, and the last scan is undoable.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers/auth.js';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, values) => pool.query(text, values).then((r) => r.rows);

const SKU = 'E2E-SCANOUT-A';

test.afterAll(async () => {
  await q('DELETE FROM item_events WHERE item_id IN (SELECT id FROM items WHERE sku = $1)', [SKU]);
  await q('DELETE FROM items WHERE sku = $1', [SKU]);
  await q("DELETE FROM batches WHERE origin = 'E2E scanout' AND NOT EXISTS (SELECT 1 FROM items WHERE batch_id = batches.id)");
  await pool.end();
});

// N pairs sitting in `sold` — the real "awaiting shipment" queue this screen works.
async function seedSold(page, n) {
  const res = await page.evaluate(async ([sku, count]) => {
    const auth = { 'content-type': 'application/json', authorization: `Bearer ${sessionStorage.getItem('sb_session_token')}` };
    const commit = await fetch('/api/batches/commit', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        kind: 'existing', noShelf: true, batch: { origin: 'E2E scanout' },
        items: Array.from({ length: count }, (_, i) => ({
          name: 'E2E Scanout Runner', sku, size: String(9 + i * 0.5), withBox: true, source: 'manual',
        })),
      }),
    }).then((r) => r.json());
    await fetch('/api/items/bulk-status', {
      method: 'POST', headers: auth, body: JSON.stringify({ vins: commit.vins, status: 'sold' }),
    });
    return commit.vins;
  }, [SKU, n]);
  expect(res.length).toBe(n);
  return res;
}

const scan = async (page, code) => {
  await page.getByPlaceholder(/Scan a VIN/i).fill(code);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
};
const stat = (page, label) => page.locator('.scanout-stat').filter({ hasText: label }).locator('.scanout-num');

test.describe('Bulk scan-out · the run', () => {
  test('shows the run counters, and Remaining counts down live', async ({ page }) => {
    await loginAs(page, 'warehouse');
    await page.goto('/shipped');
    const vins = await seedSold(page, 2);
    await page.reload();                       // pick up the seeded backlog

    await expect(stat(page, 'Scanned')).toHaveText('0');
    const before = Number(await stat(page, 'Remaining').innerText());
    expect(before).toBeGreaterThanOrEqual(2);

    await scan(page, vins[0]);
    await expect(stat(page, 'Scanned')).toHaveText('1');
    // Projected, not re-fetched: the pair is staged, not yet submitted.
    await expect(stat(page, 'Remaining')).toHaveText(String(before - 1));
    await expect(page.locator('.scanout-last')).toContainText(vins[0]);
  });

  test('the scanner stays open and ready after each scan', async ({ page }) => {
    await loginAs(page, 'warehouse');
    await page.goto('/shipped');
    const vins = await seedSold(page, 2);
    for (const v of vins) await scan(page, v);
    await expect(stat(page, 'Scanned')).toHaveText('2');
    // Field is empty and focused, so the next gun scan just lands.
    const box = page.getByPlaceholder(/Scan a VIN/i);
    await expect(box).toHaveValue('');
    await expect(box).toBeFocused();
  });
});

test.describe('Bulk scan-out · failures are kept, not overwritten', () => {
  test('a non-VIN barcode is logged with its reason and survives later scans', async ({ page }) => {
    await loginAs(page, 'warehouse');
    await page.goto('/shipped');
    const vins = await seedSold(page, 1);

    await scan(page, '195244570123');                 // a product UPC, not a VIN
    await expect(page.locator('.scanout-fail')).toHaveCount(1);
    await expect(page.locator('.scanout-fail').first()).toContainText(/is not a VIN/i);
    await expect(stat(page, 'Errors')).toHaveText('1');

    // The whole point: a good scan afterwards must NOT wipe the reason.
    await scan(page, vins[0]);
    await expect(stat(page, 'Scanned')).toHaveText('1');
    await expect(page.locator('.scanout-fail')).toHaveCount(1);
    await expect(page.locator('.scanout-fail').first()).toContainText(/is not a VIN/i);
  });

  test('an unknown VIN and a duplicate each log their own reason', async ({ page }) => {
    await loginAs(page, 'warehouse');
    await page.goto('/shipped');
    const vins = await seedSold(page, 1);

    await scan(page, 'SBM-260101-999999');            // well-formed, not ours
    await expect(page.locator('.scanout-fail').first()).toContainText(/No item found/i);

    await scan(page, vins[0]);
    // A gun double-trigger (same code inside the 1.2s cooldown) is a hardware
    // artifact, not a mistake — swallowed silently, no error logged.
    await scan(page, vins[0]);
    await expect(stat(page, 'Errors')).toHaveText('1');

    // A DELIBERATE re-scan after the cooldown is a real duplicate, and says so.
    await page.waitForTimeout(1300);
    await scan(page, vins[0]);
    await expect(page.locator('.scanout-fail').first()).toContainText(/scanned twice/i);
    await expect(stat(page, 'Scanned')).toHaveText('1');   // not double-counted
    await expect(stat(page, 'Errors')).toHaveText('2');
  });

  test('a pair already shipped is refused with that reason', async ({ page }) => {
    await loginAs(page, 'warehouse');
    await page.goto('/shipped');
    const vins = await seedSold(page, 1);
    await q("UPDATE items SET status = 'shipped' WHERE vin = $1", [vins[0]]);

    await scan(page, vins[0]);
    await expect(page.locator('.scanout-fail').first()).toContainText(/already Shipped/i);
    await expect(stat(page, 'Scanned')).toHaveText('0');
  });
});

test.describe('Bulk scan-out · undo and submit', () => {
  test('Undo last removes the most recent scan and lets it be re-scanned', async ({ page }) => {
    await loginAs(page, 'warehouse');
    await page.goto('/shipped');
    const vins = await seedSold(page, 2);
    await scan(page, vins[0]);
    await scan(page, vins[1]);
    await expect(stat(page, 'Scanned')).toHaveText('2');

    await page.getByRole('button', { name: /Undo last/i }).click();
    await expect(stat(page, 'Scanned')).toHaveText('1');
    await expect(page.locator('.scanout-last')).toContainText(vins[0]);

    // The undone VIN is immediately scannable again (its re-read cooldown is cleared).
    await scan(page, vins[1]);
    await expect(stat(page, 'Scanned')).toHaveText('2');
  });

  test('submitting marks them shipped and summarises the session', async ({ page }) => {
    await loginAs(page, 'warehouse');
    await page.goto('/shipped');
    const vins = await seedSold(page, 2);

    await scan(page, 'NOT-A-VIN');                    // one deliberate error
    for (const v of vins) await scan(page, v);

    await page.getByRole('button', { name: /Save → Shipped/i }).click();
    await page.getByRole('button', { name: /Confirm — Mark Shipped/i }).click();

    const summary = page.locator('.modal');
    await expect(summary).toContainText('2 pairs scanned out successfully');
    await expect(summary).toContainText('1 error during the session');

    const rows = await q('SELECT status FROM items WHERE vin = ANY($1)', [vins]);
    expect(rows.map((r) => r.status)).toEqual(['shipped', 'shipped']);

    // A fresh run starts clean.
    await page.getByRole('button', { name: /Scan more/i }).click();
    await expect(stat(page, 'Scanned')).toHaveText('0');
    await expect(stat(page, 'Errors')).toHaveText('0');
  });
});

// `<Modal>` drops every child into .modal-actions, which is a flex ROW — so a
// preview list next to Confirm/Cancel came out as three squeezed columns with the
// labels breaking mid-word. It only stacked below 600px, so tablets and desktops
// got the cramped version. A plain button pair must still sit side by side.
test.describe('Modal actions · stack when it is not a plain button pair', () => {
  const dir = (page) => page.locator('.modal-actions').evaluate((el) => getComputedStyle(el).flexDirection);

  test('a confirm with a preview list stacks one per line', async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 900 });   // well above the old 600px breakpoint
    await loginAs(page, 'warehouse');
    await page.goto('/shipped');
    const vins = await seedSold(page, 2);
    for (const v of vins) await scan(page, v);
    await page.getByRole('button', { name: /Save → Shipped/i }).click();

    await expect(page.locator('.modal .confirm-list')).toBeVisible();
    expect(await dir(page)).toBe('column');
    // Full width each, and in DOM order: list, Confirm, Cancel.
    const widths = await page.locator('.modal-actions > *').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width));
    expect(new Set(widths.map(Math.round)).size, 'every row spans the same full width').toBe(1);
  });

  test('a plain Confirm/Cancel pair still sits side by side', async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 900 });
    await loginAs(page, 'warehouse');
    await page.goto('/shipped');
    const vins = await seedSold(page, 1);
    await scan(page, vins[0]);
    await page.getByRole('button', { name: /Save → Shipped/i }).click();
    await page.getByRole('button', { name: /Confirm — Mark Shipped/i }).click();

    // Success modal = two buttons, nothing else.
    await expect(page.locator('.modal')).toContainText('scanned out successfully');
    expect(await dir(page)).toBe('row');
  });
});

test.describe('Bulk scan-out · sound', () => {
  test('the sound toggle flips and persists across a reload', async ({ page }) => {
    await loginAs(page, 'warehouse');
    await page.goto('/shipped');
    const bell = page.locator('.topbar button[aria-pressed]');
    await expect(bell).toHaveAttribute('aria-pressed', 'true');   // on by default
    await bell.click();
    await expect(bell).toHaveAttribute('aria-pressed', 'false');
    await page.reload();
    await expect(page.locator('.topbar button[aria-pressed]')).toHaveAttribute('aria-pressed', 'false');
  });

  test('Mark Sold has no Remaining counter — it has no pending queue', async ({ page }) => {
    await loginAs(page, 'warehouse');
    await page.goto('/sold');
    await expect(page.locator('.scanout-stat').filter({ hasText: 'Scanned' })).toBeVisible();
    await expect(page.locator('.scanout-stat').filter({ hasText: 'Remaining' })).toHaveCount(0);
  });
});
