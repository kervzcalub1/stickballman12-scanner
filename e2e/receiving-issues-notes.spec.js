// Shipment issues + key notes. The Issues step names the problems the floor actually
// reports (damaged package, damaged shoe boxes, tampering, a missing item…) and takes
// free-text key notes beside them. Everything recorded there has to be readable on the
// BATCH page afterwards — that is where a supplier dispute gets settled, and until now
// the issues only showed under Receiving → Recent.
import { test, expect } from '@playwright/test';
import { loadEnv, loginAs } from './helpers/auth.js';
import { stubClaimUploads, shootClaim } from './helpers/claimPhotos.js';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (t, v) => pool.query(t, v).then((r) => r.rows);
const stamp = `${Date.now()}`.slice(-6);
const SKU = `E2E-ISSUE-${stamp}`;
const NOTE = `E2E key note ${stamp}: outer carton re-taped on one side, two shoe boxes wet`;

test.afterAll(async () => {
  const items = await q('SELECT id, batch_id FROM items WHERE sku = $1', [SKU]);
  for (const i of items) await q('DELETE FROM item_events WHERE item_id = $1', [i.id]);
  await q('DELETE FROM items WHERE sku = $1', [SKU]);
  for (const id of [...new Set(items.map((i) => i.batch_id))]) {
    await q('DELETE FROM inbound_issues WHERE batch_id = $1', [id]); // the tampered issue opened a case
    await q('DELETE FROM shipment_issues WHERE batch_id = $1', [id]);
    await q('DELETE FROM batch_boxes WHERE batch_id = $1', [id]);
    await q('DELETE FROM batches WHERE id = $1', [id]);
  }
  await pool.end();
});

test('a named problem and the key notes land on the batch, and the Batch page shows them', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await stubClaimUploads(page);
  await page.route('**/api/sku-search', (route) => route.fulfill({ json: { ok: true, product: { name: 'E2E Issue Runner', sku: SKU, image: '', source: 'manual', scannedSize: '9', sizes: ['9'] } } }));
  await page.goto('/receiving');
  await page.locator('label:has-text("Supplier") select').selectOption({ index: 1 });
  await page.locator('.track-field input').first().fill(`E2E-ISSUE-${stamp}`);
  await page.locator('.manifest-q').getByRole('button', { name: 'Yes' }).click(); // the manifest question is required
  await page.getByRole('button', { name: 'Next →' }).click();
  await page.locator('.scanbar input').first().fill(SKU);
  await page.locator('.scanbar').getByRole('button', { name: 'Add' }).click();
  await expect(page.locator(`.recv-item[data-sku="${SKU}"]`)).toBeVisible();
  await page.getByRole('button', { name: 'Review →' }).click();
  await page.getByRole('button', { name: 'Next →' }).click();

  // Step 4: the new types are offered, and the key-notes box sits under the rows.
  await page.getByRole('button', { name: '+ Add issue' }).click();
  const row = page.locator('.issue-row').first();
  await expect(row.locator('select option')).toContainText(['Package arrived damaged', 'Shoe boxes damaged', 'Merchandise appears removed / tampered with', 'Item appears to be missing']);
  await row.locator('select').selectOption('tampered');
  await row.locator('input[placeholder="Description"]').fill('inner seal broken, one box empty');
  await page.locator('.key-notes textarea').fill(NOTE);

  // A reported problem needs the three claim photos before the batch can be saved
  // (receiving-evidence.md): label, the boxes, the packing slip — or saying there was none.
  await expect(page.locator('.oo-claim')).toContainText('Reported: Merchandise appears removed / tampered with');
  await page.getByRole('button', { name: 'Finish batch' }).click();
  await expect(page.locator('.error')).toContainText('Take the photos for the claim first');
  await shootClaim(page, ['label', 'pairs']);
  await page.locator('.oo-claim').getByLabel('There was no packing slip in the parcel').check();
  await expect(page.locator('.oo-claim')).toHaveAttribute('data-claim-left', '0');

  await page.getByRole('button', { name: 'Finish batch' }).click();
  await page.getByRole('button', { name: 'Yes, commit' }).click();
  await expect(page.getByText(/^Batch .* saved$/)).toBeVisible({ timeout: 15_000 });

  const [{ batch_id }] = await q('SELECT batch_id FROM items WHERE sku = $1 LIMIT 1', [SKU]);
  const issues = await q('SELECT type, description FROM shipment_issues WHERE batch_id = $1 ORDER BY id', [batch_id]);
  expect(issues).toEqual([
    { type: 'tampered', description: 'inner seal broken, one box empty' },
    { type: 'note', description: NOTE },
  ]);
  // The claim photos are on the receiving record, and on the case the PH team opens.
  const [{ evidence }] = await q('SELECT evidence FROM batches WHERE id = $1', [batch_id]);
  expect(evidence).toMatchObject({ noSlip: true, slip: [], reasons: ['Reported: Merchandise appears removed / tampered with'] });
  expect(evidence.label).toHaveLength(1);
  expect(evidence.pairs).toHaveLength(1);
  const [kase] = await q(`SELECT id FROM inbound_issues WHERE batch_id = $1 AND type = 'tampered'`, [batch_id]);
  expect(kase).toBeTruthy();

  // …and the Batch page reads them back in words, not type keys.
  await page.goto(`/batches?b=${batch_id}`);
  const block = page.locator('.batch-issues');
  await expect(block).toBeVisible();
  await expect(block).toContainText('Merchandise appears removed / tampered with');
  await expect(block).toContainText('inner seal broken, one box empty');
  await expect(block).toContainText('Key note');
  await expect(block).toContainText(NOTE);
  await expect(block.locator('.batch-issue-type').first()).toHaveText('Merchandise appears removed / tampered with'); // the label, never the raw key
});
