// Counting a rescale audit by SCANNING rather than typing a number (2026-09-23).
//
// Brent counts a shelf with a scanner, and the two are not the same claim: a typed 3 is
// somebody's assertion, three scans are three pairs that were each in a hand. The value
// is in what scanning refuses — the mistakes a shelf count actually makes:
//   · the same pair counted twice (its 1ID is already in the list);
//   · a pair of a DIFFERENT shoe that shares the shelf (its style code doesn't match);
//   · a size nobody asked about, which gets its own row instead of being dropped.
// And what it records: WHICH pairs were counted, so a disputed audit can be re-walked.
import { test, expect } from '@playwright/test';
import { signToken } from '../api/_lib/util.js';
import { loadEnv, loginAs } from './helpers/auth.js';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, values) => pool.query(text, values).then((r) => r.rows);
const wh = { Authorization: `Bearer ${signToken({ uid: 'e2e-wh', username: 'e2e_wh', name: 'E2E Warehouse', role: 'warehouse' })}` };

const stamp = `${Date.now()}`.slice(-6);
const SKU = `E2E-AUD-${stamp}`;
const OTHER = `E2E-OTHER-${stamp}`;
const UPC = `9${stamp}0001`.slice(0, 12);
const vin = (n) => `SBM-888888-${stamp}${n}`;
let batchId = null;
let reqId = null;

test.beforeAll(async () => {
  batchId = Number((await q(
    `INSERT INTO batches (batch_code, status, kind, supplier_name) VALUES ($1,'closed','receiving','E2E Audit Supplier') RETURNING id`,
    [`B-AUD-${stamp}`]))[0].id);
  const add = (sku, size, n, upc = null) => q(
    `INSERT INTO items (vin, batch_id, name, sku, size, upc, status) VALUES ($1,$2,'E2E Audit Shoe',$3,$4,$5,'needs_shelf')`,
    [vin(n), batchId, sku, size, upc]);
  await add(SKU, '9', 1);
  await add(SKU, '9', 2, UPC);          // this one's box carries a scannable barcode
  await add(SKU, '10', 3);
  await add(SKU, '11', 4);              // a size the request never mentions
  await add(OTHER, '9', 5);             // another shoe sharing the shelf
  reqId = Number((await q(
    `INSERT INTO rescale_requests (sku, sku_all, name, sizes, reason, requested_by, status)
     VALUES ($1,$1,'E2E Audit Shoe',$2::jsonb,'recount','E2E PH','open') RETURNING id`,
    [SKU, JSON.stringify([{ size: '9', qty: 3 }, { size: '10', qty: 1 }])]))[0].id);
});

test.afterAll(async () => {
  await q('DELETE FROM rescale_requests WHERE sku = ANY($1)', [[SKU, OTHER]]);
  const items = await q('SELECT id FROM items WHERE batch_id = $1', [batchId]);
  for (const i of items) await q('DELETE FROM item_events WHERE item_id = $1', [i.id]);
  await q('DELETE FROM items WHERE batch_id = $1', [batchId]);
  await q('DELETE FROM batches WHERE id = $1', [batchId]);
  await pool.end();
});

const scan = (request, code) => request.post('/api/rescale-requests/audit-scan', { headers: wh, data: { id: reqId, code } });

test('a scan resolves to the pair’s size — and a different shoe is turned away', async ({ request }) => {
  const ok = await scan(request, vin(1));
  expect(ok.ok(), await ok.text()).toBeTruthy();
  expect(await ok.json()).toMatchObject({ kind: 'vin', size: '9', vin: vin(1) });

  // The shoe that shares the shelf. This is the one a typed count silently absorbs.
  const wrong = await scan(request, vin(5));
  expect(wrong.status()).toBe(409);
  expect((await wrong.json()).error).toContain(SKU);

  // A box barcode names a SIZE, and that is enough to count one.
  const byUpc = await scan(request, UPC);
  expect(byUpc.ok(), await byUpc.text()).toBeTruthy();
  expect(await byUpc.json()).toMatchObject({ kind: 'upc', size: '9' });

  // A sticker no pair wears, and a style code typed in by mistake, each say what to do.
  expect((await scan(request, 'SBM-888888-000000')).status()).toBe(409);
  const asSku = await scan(request, SKU);
  expect(asSku.status()).toBe(409);
  expect((await asSku.json()).error).toMatch(/style code/i);
});

test('the audit stores WHICH pairs were counted, per size', async ({ request }) => {
  const r = await request.post('/api/rescale-requests/audit', {
    headers: wh,
    data: {
      id: reqId,
      actualSizes: [
        { size: '9', qty: 2, vins: [vin(1), vin(2), vin(1)] },   // the repeat is dropped
        { size: '10', qty: 1, vins: [] },                         // typed, no VIN
        { size: '11', qty: 1, vins: ['not-a-vin', vin(4)] },      // junk is dropped
      ],
      note: 'counted by scanning',
    },
  });
  expect(r.ok(), await r.text()).toBeTruthy();
  const [row] = await q('SELECT actual_sizes, status FROM rescale_requests WHERE id = $1', [reqId]);
  expect(row.status).toBe('audited');
  const bySize = Object.fromEntries(row.actual_sizes.map((s) => [s.size, s]));
  expect(bySize['9'].vins).toEqual([vin(1), vin(2)]);
  expect(bySize['10'].vins).toBeUndefined();   // typed: stored exactly as it always was
  expect(bySize['11'].vins).toEqual([vin(4)]);
  // The COUNT is still the count — a row corrected by hand keeps its number even though
  // only two VINs back it.
  expect(bySize['9'].qty).toBe(2);
});

test('the shelf is counted by scanning on the screen, starting at zero', async ({ page }) => {
  // A fresh request: the one above is audited now.
  const id = Number((await q(
    `INSERT INTO rescale_requests (sku, sku_all, name, sizes, reason, requested_by, status)
     VALUES ($1,$1,'E2E Audit Shoe',$2::jsonb,'recount','E2E PH','open') RETURNING id`,
    [SKU, JSON.stringify([{ size: '9', qty: 3 }])]))[0].id);

  await loginAs(page, 'warehouse');
  await page.goto('/rescalereq?status=open');
  const card = page.locator('.rc-item', { hasText: SKU }).first();
  await card.getByRole('button', { name: /Audit shelf/ }).click();

  // Scanning is the default, and every size starts at 0 — seeding from what PH reported
  // and then adding scans on top would make "actual" = reported + shelf.
  const audit = card.locator('.rc-audit');
  await expect(audit.locator('.seg-btn.on')).toContainText('Scanning');
  await expect(audit.locator('.size-line').first().locator('.qty')).toHaveValue('0');

  const scanIn = async (code) => {
    await audit.locator('.rc-audit-scan input').fill(code);
    await audit.locator('.rc-audit-scan').getByRole('button', { name: 'Add', exact: true }).click();
  };
  await scanIn(vin(1));
  await expect(audit.locator('.size-line').first().locator('.qty')).toHaveValue('1');
  await expect(audit.locator('.rc-audit-scanned').first()).toContainText('1 scanned');

  // The same pair again is refused — the whole reason to scan instead of typing.
  await scanIn(vin(1));
  await expect(audit.locator('.scan-flash')).toContainText(/Already counted/i);
  await expect(audit.locator('.size-line').first().locator('.qty')).toHaveValue('1');

  // A size nobody asked about gets its own row rather than being dropped.
  await scanIn(vin(4));
  await expect(audit.locator('.size-line')).toHaveCount(2);
  await expect(audit.locator('.size-line').nth(1).locator('.sz')).toHaveValue('11');

  // A pair of another shoe is turned away, and the refusal is KEPT — "it wouldn't scan"
  // is answerable from a list, and it is usually the finding.
  await scanIn(vin(5));
  await expect(audit.locator('.rc-audit-fails')).toContainText(vin(5));

  // Undo takes back the last pair, count and all.
  await audit.getByRole('button', { name: /Undo last scan/ }).click();
  await expect(audit.locator('.size-line').nth(1).locator('.qty')).toHaveValue('0');

  await audit.getByRole('button', { name: 'Submit audit' }).click();
  await expect(card.locator('.rc-audit')).toHaveCount(0);
  const [saved] = await q('SELECT status, actual_sizes FROM rescale_requests WHERE id = $1', [id]);
  expect(saved.status).toBe('audited');
  const nine = saved.actual_sizes.find((s) => s.size === '9');
  expect(nine.qty).toBe(1);
  expect(nine.vins).toEqual([vin(1)]);
  await q('DELETE FROM rescale_requests WHERE id = $1', [id]);
});
