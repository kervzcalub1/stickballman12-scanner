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
const UPC11 = `9${stamp}0011`.slice(0, 12);
const UPC_OTHER = `9${stamp}0099`.slice(0, 12);
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
  await add(SKU, '11', 4, UPC11);       // a size the request never mentions
  await add(OTHER, '9', 5, UPC_OTHER);  // another shoe sharing the shelf
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

test('a box barcode is counted at its size; a 1ID is refused, and says what to scan instead', async ({ request }) => {
  // The 1ID only knows the size we recorded — the thing being checked.
  const byVin = await scan(request, vin(1));
  expect(byVin.status()).toBe(409);
  expect((await byVin.json()).error).toMatch(/barcode on the box/i);

  // A barcode the catalogue doesn't know falls back to our own stock, and says so.
  const byUpc = await scan(request, UPC);
  expect(byUpc.ok(), await byUpc.text()).toBeTruthy();
  expect(await byUpc.json()).toMatchObject({ kind: 'upc', size: '9', source: 'own-stock' });

  // The shoe that shares the shelf. This is the one a typed count silently absorbs.
  const wrong = await scan(request, UPC_OTHER);
  expect(wrong.status()).toBe(409);
  expect((await wrong.json()).error).toContain(SKU);

  // A style code typed in by mistake says what to do.
  const asSku = await scan(request, SKU);
  expect(asSku.status()).toBe(409);
  expect((await asSku.json()).error).toMatch(/style code/i);
});

test('the catalogue sets the size — and a record that disagrees is the finding', async () => {
  const { resolveAuditScan } = await import('../api/_lib/db.js');
  // Our records hold UPC as a size 9; the box (the catalogue) says 10.
  const r = await resolveAuditScan({ requestId: reqId, code: UPC, catalogue: { sku: SKU, scannedSize: '10', via: 'stockx' } });
  expect(r).toMatchObject({ kind: 'upc', size: '10', source: 'stockx' });
  expect(r.warn).toContain('Our records have this barcode as size 9 — the box says 10. Counted as 10');
  // They agree → no warning.
  const same = await resolveAuditScan({ requestId: reqId, code: UPC, catalogue: { sku: SKU, scannedSize: '9', via: 'nike' } });
  expect(same).toMatchObject({ size: '9', warn: null });
  // The catalogue says it's another shoe → turned away, whatever our records think.
  const other = await resolveAuditScan({ requestId: reqId, code: UPC, catalogue: { sku: OTHER, scannedSize: '9', via: 'stockx' } });
  expect(other.error).toContain(`That box is ${OTHER}, size 9`);
  // …unless the catalogue itself is unsure (one barcode, several products): our stock answers.
  const unsure = await resolveAuditScan({ requestId: reqId, code: UPC, catalogue: { sku: OTHER, scannedSize: '9', via: 'stockx', ambiguous: true } });
  expect(unsure).toMatchObject({ size: '9', source: 'own-stock' });
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
  await scanIn(UPC);
  await expect(audit.locator('.size-line').first().locator('.qty')).toHaveValue('1');
  await expect(audit.locator('.rc-audit-scanned').first()).toContainText('1 scanned');

  // Two boxes of a 9 are two real pairs — the same barcode again counts again.
  await scanIn(UPC);
  await expect(audit.locator('.size-line').first().locator('.qty')).toHaveValue('2');

  // A 1ID is refused and KEPT in the list, with what to scan instead.
  await scanIn(vin(1));
  await expect(audit.locator('.rc-audit-fails')).toContainText(/barcode on the box/i);
  await expect(audit.locator('.size-line').first().locator('.qty')).toHaveValue('2');

  // A size nobody asked about gets its own row rather than being dropped.
  await scanIn(UPC11);
  await expect(audit.locator('.size-line')).toHaveCount(2);
  await expect(audit.locator('.size-line').nth(1).locator('.sz')).toHaveValue('11');

  // A box of another shoe is turned away, and the refusal is KEPT — "it wouldn't scan"
  // is answerable from a list, and it is usually the finding.
  await scanIn(UPC_OTHER);
  await expect(audit.locator('.rc-audit-fails')).toContainText(UPC_OTHER);

  // Undo takes back the last counted box, count and all — a barcode scan too, not only a 1ID.
  await audit.getByRole('button', { name: /Undo last scan/ }).click();
  await expect(audit.locator('.size-line').nth(1).locator('.qty')).toHaveValue('0');

  await audit.getByRole('button', { name: 'Submit audit' }).click();
  await expect(card.locator('.rc-audit')).toHaveCount(0);
  const [saved] = await q('SELECT status, actual_sizes FROM rescale_requests WHERE id = $1', [id]);
  expect(saved.status).toBe('audited');
  const nine = saved.actual_sizes.find((s) => s.size === '9');
  expect(nine.qty).toBe(2);
  expect(nine.vins).toBeUndefined();   // counted by barcode: no 1IDs to store
  await q('DELETE FROM rescale_requests WHERE id = $1', [id]);
});
