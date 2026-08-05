// Existing Stock (kind='existing') — old stock counted in shelf by shelf.
// The invariant under test is the one that matters operationally: it lands shelved
// and already-listed, and the PH team never sees it. See docs/context/existing-stock.md.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers/auth.js';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, values) => pool.query(text, values).then((r) => r.rows);

let shelfCode = null;
let batchId = null;
let vins = [];

test.beforeAll(async () => {
  const rows = await q('SELECT code FROM locations WHERE active = true ORDER BY id LIMIT 1');
  shelfCode = rows[0]?.code || null;
});

test.afterAll(async () => {
  if (batchId) {
    await q('DELETE FROM items WHERE batch_id = $1', [batchId]);
    await q('DELETE FROM batches WHERE id = $1', [batchId]);
  }
  await pool.end();
});

test.describe('Existing Stock · intake', () => {
  test('the screen renders and asks for a shelf first', async ({ page }) => {
    await loginAs(page, 'warehouse');
    await page.goto('/existing-stock');
    // TopBar renders its title as a span inside .brand, not a heading role.
    await expect(page.locator('.topbar .brand')).toContainText('Existing Stock');
    await expect(page.getByPlaceholder(/Scan a shelf barcode/i)).toBeVisible();
    // Save is dead until a shelf + pairs exist.
    await expect(page.getByRole('button', { name: /Save shelf/i })).toBeDisabled();
  });

  test('scanning a shelf switches the prompt to product scanning', async ({ page }) => {
    test.skip(!shelfCode, 'no active shelf locations seeded');
    await loginAs(page, 'warehouse');
    await page.goto('/existing-stock');
    await page.getByPlaceholder(/Scan a shelf barcode/i).fill(shelfCode);
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    // Scoped to the target strip — the transient scan-flash banner also says
    // "Counting onto", which would make a bare text match ambiguous.
    await expect(page.locator('.shelve-target')).toContainText(shelfCode.split('-').slice(-2).join('-'));
    await expect(page.getByPlaceholder(/Scan a box UPC/i)).toBeVisible();
  });

  test('commit lands the pairs shelved, already-synced, and invisible to PH', async ({ page, request }) => {
    test.skip(!shelfCode, 'no active shelf locations seeded');
    await loginAs(page, 'warehouse');
    await page.goto('/existing-stock');

    // Drive the real endpoint from the authenticated page context (the product
    // lookup itself hits a third-party catalogue, so the UI loop isn't asserted
    // here — the screen's own scan/shelf wiring is covered by the tests above).
    const res = await page.evaluate(async (code) => {
      const r = await fetch('/api/batches/commit', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${sessionStorage.getItem('sb_session_token')}`,
        },
        body: JSON.stringify({
          kind: 'existing',
          locationCode: code,
          batch: { origin: 'E2E back room' },
          items: [
            { name: 'E2E Existing A', sku: 'E2E-EXIST-A', size: '9', withBox: true },
            { name: 'E2E Existing A', sku: 'E2E-EXIST-A', size: '10', withBox: true },
          ],
        }),
      });
      return { status: r.status, body: await r.json() };
    }, shelfCode);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.shelved?.updated).toBe(2);
    vins = res.body.vins;

    const rows = await q(
      `SELECT i.status, i.location_code, i.added_to_intel_inv, i.synced_alias,
              i.synced_stockx, i.synced_shopify, b.kind, b.id AS batch_id
         FROM items i JOIN batches b ON b.id = i.batch_id
        WHERE i.vin = ANY($1)`, [vins]);
    batchId = rows[0].batch_id;

    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.kind).toBe('existing');
      expect(r.status).toBe('in_stock');           // shelved on commit, no needs_shelf hop
      expect(r.location_code).toBe(shelfCode);
      expect(r.added_to_intel_inv).toBe(true);     // already live on II + the stores
      expect(r.synced_alias).toBe(true);
      expect(r.synced_stockx).toBe(true);
      expect(r.synced_shopify).toBe(true);
    }
  });

  test('a bad shelf is refused BEFORE any batch is created', async ({ page }) => {
    await loginAs(page, 'warehouse');
    await page.goto('/existing-stock');
    const before = (await q("SELECT count(*)::int AS n FROM batches WHERE kind = 'existing'"))[0].n;
    const res = await page.evaluate(async () => {
      const r = await fetch('/api/batches/commit', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${sessionStorage.getItem('sb_session_token')}`,
        },
        body: JSON.stringify({
          kind: 'existing',
          locationCode: 'MNH-WH-NOPE-99',
          items: [{ name: 'X', sku: 'X', size: '9', withBox: true }],
        }),
      });
      return { status: r.status, body: await r.json() };
    });
    expect(res.status).toBe(404);
    const after = (await q("SELECT count(*)::int AS n FROM batches WHERE kind = 'existing'"))[0].n;
    expect(after, 'a rejected shelf must not leave an orphan batch behind').toBe(before);
  });

  test('existing stock is invisible to the PH team', async ({ page }) => {
    test.skip(!vins.length, 'commit test did not run');
    await loginAs(page, 'ph_team');
    await page.goto('/ph/new-inventory');
    await page.waitForLoadState('networkidle');
    // The SKU counted in above must not appear anywhere on the PH worklist.
    await expect(page.locator('body')).not.toContainText('E2E-EXIST-A');
  });

  test('rescanning existing stock for Rescale is refused', async ({ page }) => {
    test.skip(!vins.length, 'commit test did not run');
    await loginAs(page, 'warehouse');
    await page.goto('/');
    const res = await page.evaluate(async (vin) => {
      const r = await fetch('/api/items/rescale', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${sessionStorage.getItem('sb_session_token')}`,
        },
        body: JSON.stringify({ vin, status: 'in_stock' }),
      });
      return { status: r.status, body: await r.json() };
    }, vins[0]);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/existing stock/i);
  });
});

// The cart loop + what happens after Save. The product catalogue is a third party,
// so it's stubbed — that's what makes the screen's own logic testable.
test.describe('Existing Stock · cart loop and post-commit', () => {
  let shelfCode2 = null;

  test.beforeEach(async ({ page }) => {
    await page.route('**/api/sku-search', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, product: { name: 'Stub Shoe', sku: 'E2E-CART-1', sizes: ['8', '9', '10'], scannedSize: '9', image: '', upc: '' } }),
    }));
  });

  test.beforeAll(async () => {
    shelfCode2 = (await q('SELECT code FROM locations WHERE active = true ORDER BY id LIMIT 1'))[0]?.code || null;
  });

  test.afterAll(async () => {
    const ids = (await q("SELECT DISTINCT batch_id FROM items WHERE sku = 'E2E-CART-1'")).map((r) => r.batch_id);
    if (ids.length) {
      await q('DELETE FROM items WHERE batch_id = ANY($1)', [ids]);
      await q('DELETE FROM batches WHERE id = ANY($1)', [ids]);
    }
  });

  test('rescan bumps qty, and Save is blocked until every row has a size', async ({ page }) => {
    test.skip(!shelfCode2, 'no active shelf locations seeded');
    await loginAs(page, 'warehouse');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/existing-stock');
    await page.getByPlaceholder(/Scan a shelf barcode/i).fill(shelfCode2);
    await page.getByRole('button', { name: 'Add', exact: true }).click();

    await page.getByPlaceholder(/Scan a box UPC/i).fill('CARTCODEA');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.locator('.dcard')).toHaveCount(1);

    // routeScan dedupes an identical code for 1200ms (gun/camera re-reads), so a
    // rescan inside that window is silently swallowed — use a different code string
    // that resolves to the same SKU, or this asserts nothing.
    await page.getByPlaceholder(/Scan a box UPC/i).fill('CARTCODEB');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.locator('.dcard')).toHaveCount(1);          // bumped, not stacked
    await expect(page.locator('.dcard .qty-ctl b').first()).toHaveText('2');

    // Clearing the size must block the save — a sizeless pair can't be counted in.
    await page.locator('.dcard select').selectOption('');
    await expect(page.getByRole('button', { name: /Save shelf/i })).toBeDisabled();
    await page.locator('.dcard select').selectOption('9');
    await expect(page.getByRole('button', { name: /Save shelf/i })).toBeEnabled();
  });

  test('after Save: labels first, then the summary — and Print again re-opens them', async ({ page }) => {
    test.skip(!shelfCode2, 'no active shelf locations seeded');
    await loginAs(page, 'warehouse');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/existing-stock');
    await page.getByPlaceholder(/Scan a shelf barcode/i).fill(shelfCode2);
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByPlaceholder(/Scan a box UPC/i).fill('CARTCODEC');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByRole('button', { name: /Save shelf/i }).click();
    await page.getByRole('button', { name: /Confirm — count onto this shelf/i }).click();

    // The pairs carry no VIN stickers yet, so the sheet leads — and the summary must
    // NOT be stacked underneath it (two overlays at once).
    await expect(page.locator('.label-toolbar')).toBeVisible();
    await expect(page.locator('.modal')).toHaveCount(0);

    // The label toolbar has to be usable on the phone this is done from: Print sat
    // fully off-screen at 390px until .label-tools was allowed to wrap.
    const overflow = await page.evaluate(() => {
      const el = document.querySelector('.label-toolbar');
      return el.scrollWidth - el.clientWidth;
    });
    expect(overflow, 'label toolbar must not overflow a 390px phone').toBeLessThanOrEqual(0);
    for (const name of [/Close/i, /Print/i]) {
      const b = await page.locator('.label-tools').getByRole('button', { name }).boundingBox();
      expect(b.x + b.width, `${name} must be on-screen`).toBeLessThanOrEqual(390);
    }

    await page.locator('.label-tools').getByRole('button', { name: /Close/i }).click();
    await expect(page.locator('.modal')).toContainText(/counted in/i);

    // This button read from `labels`, which Close had just set to null — so it was
    // permanently dead. It now reads the items off `done`.
    await page.getByRole('button', { name: /Print VIN labels again/i }).click();
    await expect(page.locator('.label-toolbar')).toBeVisible();
  });
});

// Warehouse staff pulling a shoe need to know it's pre-system stock BEFORE they
// pull it. Fixtures put the same SKU on one shelf in both kinds, so the views have
// to actually distinguish them rather than just render a chip somewhere.
test.describe('Existing Stock · Locate Shoe indicator', () => {
  let exB = null; let rcB = null; let shelf = null;

  test.beforeAll(async () => {
    shelf = (await q('SELECT * FROM locations WHERE active = true ORDER BY id LIMIT 1'))[0];
    if (!shelf) return;
    const db = await import('../api/_lib/db.js');
    exB = await db.createBatch({ kind: 'existing', origin: 'Back room' }, 'e2e');
    const ex = await db.insertItems(exB.id, [{ sku: 'E2E-LOC-1', size: '9', name: 'E2E Locate Test', withBox: true, status: 'needs_shelf' }], 'e2e', null);
    await db.insertIntakeEvents(ex.map((r) => r.id), 'e2e', 'existing');
    rcB = await db.createBatch({ kind: 'receiving', supplier: 'S', tracking: 'E2ELOC1' }, 'e2e');
    const rc = await db.insertItems(rcB.id, [{ sku: 'E2E-LOC-1', size: '10', name: 'E2E Locate Test', withBox: true, status: 'needs_shelf' }], 'e2e', null);
    await db.insertIntakeEvents(rc.map((r) => r.id), 'e2e', 'receiving');
    await db.shelveItems({ location: shelf, units: [...ex, ...rc].map((r) => ({ vin: r.vin })), createdBy: 'e2e' });
  });

  test.afterAll(async () => {
    const ids = [exB?.id, rcB?.id].filter(Boolean);
    if (!ids.length) return;
    await q('DELETE FROM items WHERE batch_id = ANY($1)', [ids]);
    await q('DELETE FROM batches WHERE id = ANY($1)', [ids]);
  });

  test('a search flags the existing pair and leaves the received one alone', async ({ page }) => {
    test.skip(!shelf, 'no active shelf locations seeded');
    await loginAs(page, 'warehouse');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/locations');
    await page.getByPlaceholder(/Find a shoe/i).first().fill('E2E-LOC-1');
    await page.keyboard.press('Enter');

    // Header carries it too: with several hits the group collapses, so a chip only
    // on the unit rows would be invisible while scanning the list.
    await expect(page.locator('.loc-group-name .inv-existing-chip')).toContainText(/Part existing/i);

    const exRow = page.locator('.loc-unit-row', { hasText: 'US 9' });
    await expect(exRow.locator('.inv-existing-chip')).toBeVisible();
    await expect(page.locator('.loc-unit-row', { hasText: 'US 10' }).locator('.inv-existing-chip')).toHaveCount(0);

    // The chip must not crowd out the VIN — it's the number you actually scan.
    // Laid out inline, it ellipsed the VIN to zero width at 390px.
    const box = await exRow.locator('.loc-unit-vin').boundingBox();
    expect(box.width, 'VIN must stay legible beside the chip').toBeGreaterThan(60);
    await expect(exRow.locator('.loc-unit-vin')).toContainText('SBM-');
  });

  test('the shelf contents view flags it as well', async ({ page }) => {
    test.skip(!shelf, 'no active shelf locations seeded');
    await loginAs(page, 'warehouse');
    await page.setViewportSize({ width: 390, height: 844 });
    // The tile drill-down is the only path through listItemsAtLocation (searching a
    // shelf code goes via the shoe search), so this covers the b.kind column there.
    await page.goto('/locations/manheim-main-shed/warehouse-rows/a/a1/1');
    await expect(page.locator('.loc-item').first()).toBeVisible();
    // Scope by SKU as well as size — the commit test above leaves its own pairs on
    // this same shelf until the file-level afterAll, so size alone matches two shoes.
    const onShelf = (size) => page.locator('.loc-item').filter({ hasText: 'E2E-LOC-1' }).filter({ hasText: size });
    await expect(onShelf('US 9').locator('.inv-existing-chip')).toBeVisible();
    await expect(onShelf('US 10').locator('.inv-existing-chip')).toHaveCount(0);
  });
});
