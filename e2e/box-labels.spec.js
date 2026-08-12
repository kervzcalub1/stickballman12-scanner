// Box Labels — replacement box labels for a pair with no original box.
// Three workflows behind one scan field (see docs/context/no-box.md):
//   1. UPC / SKU  → mint a VIN (existing stock, PH-invisible) + print both labels
//   2. VIN        → reprint the box label (and the VIN sticker) for a known pair
//   3. UPC / SKU  → box label only, nothing recorded
// The catalogue lookups are stubbed so the UI loop itself is under test rather
// than a third-party's uptime; the commit and the label PDF are real.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers/auth.js';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, values) => pool.query(text, values).then((r) => r.rows);

// Printing is one dialog now — stock picker + Print — with no on-screen copy of the
// label (see components/common.jsx). So what a spec can assert is that the RIGHT
// dialog opened for the right label count, and that the PDF actually built: the
// dialog builds it up front and only enables Print once it exists, so a label that
// can't be drawn (unencodable barcode, missing size) surfaces as `.label-error` and
// a dead Print button rather than a silently-wrong sticker.
async function expectPrintDialog(page, title, count = 1) {
  const dlg = page.locator('.print-dialog');
  await expect(dlg).toBeVisible({ timeout: 10_000 });
  await expect(dlg.locator('.modal-title')).toContainText(title);
  await expect(dlg.locator('.modal-msg')).toContainText(`${count} label`);
  await expect(dlg.getByRole('button', { name: 'Print', exact: true })).toBeEnabled();
  await expect(dlg.locator('.label-error')).toHaveCount(0);
  return dlg;
}
const closePrintDialog = (page) => page.locator('.print-dialog').getByRole('button', { name: 'Cancel' }).click();

const SKU = 'E2E-BOXLBL-A';
const UPC = '195244570123';
const PRODUCT = {
  ok: true,
  product: {
    name: 'E2E Box Label Runner', sku: SKU, upc: null, image: null, brand: 'Nike',
    colorway: 'Black/White', sizes: ['8', '9', '9.5', '10'], gender: 'Men', source: 'alias',
  },
};

// Stub both catalogue endpoints. The UPC one also hands back the scanned size,
// exactly as the StockX proxy does — that's what makes the UPC path one-scan.
// Also forces the local-stock lookup to MISS, so these specs exercise the
// catalogue path regardless of what earlier tests left in the database.
async function stubCatalogue(page) {
  await page.route('**/api/items/find*', (route) => route.fulfill({ json: { ok: true, product: null, units: [] } }));
  await page.route('**/api/sku-search', (route) => route.fulfill({ json: PRODUCT }));
  await page.route('**/api/upc-search', (route) => route.fulfill({
    json: { ok: true, product: { ...PRODUCT.product, upc: UPC, scannedSize: '9.5' } },
  }));
}

// A real unit to scan by VIN, created through the same endpoint the tool uses.
async function mintUnit(page, { upc = null } = {}) {
  const res = await page.evaluate(async ([sku, u]) => {
    const r = await fetch('/api/batches/commit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionStorage.getItem('sb_session_token')}` },
      body: JSON.stringify({
        kind: 'existing', noShelf: true, batch: { origin: 'E2E box label' },
        items: [{ name: 'E2E Box Label Runner', sku, size: '9.5', upc: u || '', withBox: true, source: 'manual' }],
      }),
    });
    return { status: r.status, body: await r.json() };
  }, [SKU, upc]);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.vins[0];
}

test.afterAll(async () => {
  await q('DELETE FROM item_events WHERE item_id IN (SELECT id FROM items WHERE sku = $1)', [SKU]);
  await q('DELETE FROM items WHERE sku = $1', [SKU]);
  await q("DELETE FROM batches WHERE origin IN ('E2E box label', 'Box label — no box') AND id NOT IN (SELECT batch_id FROM items WHERE batch_id IS NOT NULL)");
  await pool.end();
});

test.describe('Box Labels · lookup', () => {
  test('the screen renders and takes any of the three codes', async ({ page }) => {
    await loginAs(page, 'warehouse');
    await page.goto('/box-labels');
    await expect(page.locator('.topbar .brand')).toContainText('Box Labels');
    await expect(page.getByPlaceholder(/Scan a VIN or box UPC/i)).toBeVisible();
    // Nothing to print until something is found.
    await expect(page.getByRole('button', { name: /Print box label/i })).toHaveCount(0);
  });

  test('a SKU resolves to the product and asks for the size first', async ({ page }) => {
    await loginAs(page, 'warehouse');
    await stubCatalogue(page);
    await page.goto('/box-labels');
    await page.getByPlaceholder(/Scan a VIN or box UPC/i).fill(SKU);
    await page.getByRole('button', { name: 'Find', exact: true }).click();

    await expect(page.locator('.dcard-name')).toContainText('E2E Box Label Runner');
    // No size yet → both actions are dead, because a sizeless box label is useless.
    await expect(page.getByRole('button', { name: /Print box label only/i })).toBeDisabled();
    await expect(page.getByRole('button', { name: /Give it a VIN/i })).toBeDisabled();
    await page.locator('select').first().selectOption('9.5');
    await expect(page.getByRole('button', { name: /Print box label only/i })).toBeEnabled();
  });

  test('a UPC resolves WITH the scanned size, so nothing is left to pick', async ({ page }) => {
    await loginAs(page, 'warehouse');
    await stubCatalogue(page);
    await page.goto('/box-labels');
    await page.getByPlaceholder(/Scan a VIN or box UPC/i).fill(UPC);
    await page.getByRole('button', { name: 'Find', exact: true }).click();

    await expect(page.locator('.card').last()).toContainText(`UPC ${UPC}`);
    await expect(page.getByRole('button', { name: /Print box label only/i })).toBeEnabled();
  });
});

// The bug this guards: the tool used to ask the third-party catalogue ONLY, so a
// pair we already had — old stock, in-store buys, anything hand-entered — came
// back "No product found for that UPC" even with the UPC sitting on the record.
test.describe('Box Labels · our own stock comes first', () => {
  for (const by of ['UPC', 'SKU']) {
    test(`a ${by} already in inventory resolves locally, even when the catalogue misses`, async ({ page }) => {
      await loginAs(page, 'warehouse');
      await page.goto('/box-labels');
      const vin = await mintUnit(page, { upc: UPC });
      // Catalogue hard-misses, exactly as it does for a SKU it's never heard of.
      await page.route('**/api/upc-search', (r) => r.fulfill({ status: 404, json: { ok: false, error: 'No product found for that UPC.' } }));
      await page.route('**/api/sku-search', (r) => r.fulfill({ status: 404, json: { ok: false, error: 'No product found for that SKU.' } }));

      await page.getByPlaceholder(/Scan a VIN or box UPC/i).fill(by === 'UPC' ? UPC : SKU);
      await page.getByRole('button', { name: 'Find', exact: true }).click();

      await expect(page.locator('.error')).toHaveCount(0);
      await expect(page.locator('.card').last()).toContainText('From your inventory');
      await expect(page.locator('.boxlbl-unit').filter({ hasText: vin })).toBeVisible();

      // …and the matching unit is one click from its own box label.
      await page.locator('.boxlbl-unit').filter({ hasText: vin }).getByRole('button', { name: /Use this VIN/i }).click();
      await expect(page.locator('.vin').first()).toContainText(vin);
      await page.getByRole('button', { name: /Print box label/i }).click();
      await expectPrintDialog(page, 'Print box labels');
    });
  }

  test('a code in neither place says what to try next', async ({ page }) => {
    await loginAs(page, 'warehouse');
    await page.route('**/api/upc-search', (r) => r.fulfill({ status: 404, json: { ok: false, error: 'No product found for that UPC.' } }));
    await page.goto('/box-labels');
    await page.getByPlaceholder(/Scan a VIN or box UPC/i).fill('999999999999');
    await page.getByRole('button', { name: 'Find', exact: true }).click();
    await expect(page.locator('.error').first()).toContainText(/isn’t in your inventory either/i);
    await expect(page.locator('.error').first()).toContainText(/VIN sticker/i);
  });
});

test.describe('Box Labels · workflow 3 — label only', () => {
  test('prints without recording anything', async ({ page }) => {
    await loginAs(page, 'warehouse');
    await stubCatalogue(page);
    await page.goto('/box-labels');
    const before = (await q('SELECT count(*)::int AS n FROM items WHERE sku = $1', [SKU]))[0].n;

    await page.getByPlaceholder(/Scan a VIN or box UPC/i).fill(UPC);
    await page.getByRole('button', { name: 'Find', exact: true }).click();
    await page.getByRole('button', { name: /Print box label only/i }).click();

    // One box label, built and ready to print — no inventory written on the way.
    await expectPrintDialog(page, 'Print box labels');

    const after = (await q('SELECT count(*)::int AS n FROM items WHERE sku = $1', [SKU]))[0].n;
    expect(after, 'a label-only print must not create inventory').toBe(before);
  });
});

test.describe('Box Labels · workflow 1 — no box, no VIN', () => {
  test('minting a VIN lands existing stock that PH never sees', async ({ page }) => {
    await loginAs(page, 'warehouse');
    await stubCatalogue(page);
    await page.goto('/box-labels');
    await page.getByPlaceholder(/Scan a VIN or box UPC/i).fill(UPC);
    await page.getByRole('button', { name: 'Find', exact: true }).click();
    await page.getByRole('button', { name: /Give it a VIN/i }).click();

    // Confirming is deliberate — it's the one action here that writes inventory.
    await expect(page.locator('.modal')).toContainText(/isn’t in the system yet/i);
    await page.getByRole('button', { name: /Confirm — create the VIN/i }).click();

    await expectPrintDialog(page, 'Print box labels');
    await closePrintDialog(page);
    // First line only — the VIN is click-to-copy, so its innerText also carries
    // the (visually hidden) "Copy" cue on a second line.
    const vinText = (await page.locator('.vin').first().innerText()).split('\n')[0].trim();
    expect(vinText).toMatch(/^SBM-\d{6}-\d{6}$/);
    // Both stickers are offered — the box label and the VIN one.
    await expect(page.getByRole('button', { name: /Print box label/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Print VIN label/i })).toBeVisible();

    const rows = await q(
      `SELECT i.status, i.with_box, i.upc, i.location_id, b.kind, b.origin
         FROM items i JOIN batches b ON b.id = i.batch_id WHERE i.vin = $1`, [vinText]);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('existing');        // PH-excluded, like all old stock
    expect(rows[0].with_box).toBe(true);          // the new label IS its box
    expect(rows[0].status).toBe('needs_shelf');   // not shelved here — put away later
    expect(rows[0].location_id).toBeNull();
    expect(rows[0].upc).toBe(UPC);
  });

  test('the pair is invisible to the PH team', async ({ page }) => {
    await loginAs(page, 'ph_team');
    await page.goto('/ph/new-inventory');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('body')).not.toContainText(SKU);
  });
});

test.describe('Box Labels · workflow 2 — pair already has a VIN', () => {
  test('scanning the VIN reprints its box label straight away', async ({ page }) => {
    await loginAs(page, 'warehouse');
    await page.goto('/box-labels');
    const vin = await mintUnit(page, { upc: UPC });

    await page.getByPlaceholder(/Scan a VIN or box UPC/i).fill(vin);
    await page.getByRole('button', { name: 'Find', exact: true }).click();
    await expect(page.locator('.vin').first()).toContainText(vin);

    await page.getByRole('button', { name: /Print box label/i }).click();
    await expectPrintDialog(page, 'Print box labels');
    await closePrintDialog(page);

    // …and the VIN sticker can be reprinted too, on its own stock.
    await page.getByRole('button', { name: /Reprint VIN label/i }).click();
    await expectPrintDialog(page, 'Print VIN labels');
  });

  test('a unit with no UPC is asked for one, and it sticks', async ({ page }) => {
    await loginAs(page, 'warehouse');
    await page.goto('/box-labels');
    const vin = await mintUnit(page);   // no UPC on file

    await page.getByPlaceholder(/Scan a VIN or box UPC/i).fill(vin);
    await page.getByRole('button', { name: 'Find', exact: true }).click();
    await page.getByRole('button', { name: /Print box label/i }).click();

    // Prompt, not a silently-barcodeless label.
    await expect(page.locator('.modal-title')).toContainText('UPC needed');
    await page.locator('.nobox-upc-input').fill(UPC);
    await page.getByRole('button', { name: /Save & print/i }).click();

    await expectPrintDialog(page, 'Print box labels');
    const rows = await q('SELECT upc FROM items WHERE vin = $1', [vin]);
    expect(rows[0].upc, 'the typed UPC is saved so the next reprint stops asking').toBe(UPC);
  });

  test('“No UPC found” still prints — as a text-only label', async ({ page }) => {
    await loginAs(page, 'warehouse');
    await page.goto('/box-labels');
    const vin = await mintUnit(page);

    await page.getByPlaceholder(/Scan a VIN or box UPC/i).fill(vin);
    await page.getByRole('button', { name: 'Find', exact: true }).click();
    await page.getByRole('button', { name: /Print box label/i }).click();
    await page.locator('.nobox-noupc-check input').check();
    await page.getByRole('button', { name: /Print without UPC/i }).click();

    // Still prints — the PDF falls back to a text-only "No UPC on file" label.
    await expectPrintDialog(page, 'Print box labels');
    const rows = await q('SELECT upc FROM items WHERE vin = $1', [vin]);
    expect(rows[0].upc, 'skipping the prompt must not write a bogus UPC').toBeNull();
  });
});

test.describe('Box Labels · the shelf guard still holds elsewhere', () => {
  test('existing stock without noShelf is still refused when no shelf is sent', async ({ page }) => {
    await loginAs(page, 'warehouse');
    await page.goto('/box-labels');
    const res = await page.evaluate(async () => {
      const r = await fetch('/api/batches/commit', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionStorage.getItem('sb_session_token')}` },
        body: JSON.stringify({ kind: 'existing', items: [{ name: 'X', sku: 'E2E-BOXLBL-GUARD', size: '9', withBox: true }] }),
      });
      return { status: r.status, body: await r.json() };
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Scan a shelf/i);
  });
});
