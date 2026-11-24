// Receiving evidence (docs/context/receiving-evidence.md): the claim photos taken while the
// parcel is still on the bench. The rules here; the gate itself is walked in
// receiving-issues-notes (a typed problem), receiving-manifest-audit (no manifest) and
// receiving-online-order (short against an online order). This file adds the clean receive,
// where the label is only ASKED for, and what a case shows.
import { test, expect } from '@playwright/test';
import pg from 'pg';
import { signToken } from '../api/_lib/util.js';
import { loadEnv, loginAs } from './helpers/auth.js';
import { stubClaimUploads } from './helpers/claimPhotos.js';
import * as E from '../src/lib/receivingEvidence.js';

loadEnv();
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const stamp = `${Date.now()}`.slice(-7);
const SKU = `E2E-EV-${stamp}`;
const TRACK = `1ZEVID${stamp}`;
let pool;
const q = async (text, values) => (await pool.query(text, values)).rows;
test.beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.DATABASE_URL }); });
test.afterAll(async () => { await pool.end(); });

test('when the claim photos are required, and which ones', () => {
  const label = (t) => ({ tampered: 'Tampered', shortfall: 'Short count' }[t] || t);
  expect(E.evidenceReasons({})).toEqual([]);
  expect(E.evidenceReasons({ issues: [{ type: 'box_no_lid' }, { type: 'box_missing' }] })).toEqual([]);   // box-swap housekeeping, not a claim
  expect(E.evidenceReasons({ online: { missing: 2, extra: 0 }, po: { missing: 0, extra: 1 }, issues: [{ type: 'tampered' }, { type: 'shortfall' }, { type: 'tampered' }], noManifest: true, issueLabel: label }))
    .toEqual(['2 pairs missing against the online order', '1 pair not on the purchase order', 'Reported: Tampered, Short count', 'Received without a manifest']);
  const one = ['https://x.test/a.jpg'];
  expect(E.evidenceLeft({}).map((c) => c.key)).toEqual(['label', 'pairs', 'slip']);
  expect(E.evidenceLeft({ label: one, pairs: one }, { noSlip: true })).toEqual([]);
  expect(E.evidenceLeft({ label: one }, { slipOptional: true }).map((c) => c.key)).toEqual(['pairs']);
  // What the server keeps: https links only, nothing when there is no photo.
  expect(E.cleanEvidence({ label: ['javascript:alert(1)', 'https://x.test/a.jpg', 'https://x.test/a.jpg'], noSlip: true, reasons: ['  short  by 1 '] }))
    .toEqual({ label: one, pairs: [], slip: [], noSlip: true, reasons: ['short by 1'] });
  expect(E.cleanEvidence({ reasons: ['x'] })).toBeNull();
  expect(E.evidenceCoversClaim({ label: one, pairs: one })).toBe(true);
  expect(E.evidenceCoversClaim({ label: one })).toBe(false);
  expect(E.evidenceWords({ label: one, pairs: [...one, 'https://x.test/b.jpg'], slip: [], noSlip: true })).toBe('label ×1, boxes ×2, no packing slip in the parcel');
});

test('a clean receive is asked for the label photo, not blocked; the photo is kept on the batch and shown on a later case', async ({ page, request }) => {
  test.setTimeout(90_000);
  await loginAs(page, 'warehouse');
  await stubClaimUploads(page, 'ev');
  await page.route('**/api/sku-search', (route) => route.fulfill({ json: { ok: true, product: { name: 'E2E Evidence Runner', sku: SKU, image: '', source: 'manual', scannedSize: '9', sizes: ['9'] } } }));
  await page.goto('/receiving');
  await page.locator('label:has-text("Supplier") select').selectOption({ index: 1 });
  await page.locator('.track-field input').first().fill(TRACK);
  await page.locator('.manifest-q').getByRole('button', { name: 'Yes' }).click();
  await page.getByRole('button', { name: 'Next →' }).click();
  await page.locator('.scanbar input').first().fill(SKU);
  await page.locator('.scanbar').getByRole('button', { name: 'Add' }).click();
  await expect(page.locator(`.recv-item[data-sku="${SKU}"]`)).toBeVisible();
  await page.getByRole('button', { name: 'Review →' }).click();
  await page.getByRole('button', { name: 'Next →' }).click();

  // Nothing is off: no required card, only the ask.
  await expect(page.locator('.oo-claim')).toHaveCount(0);
  const ask = page.locator('[data-claim-optional="label"]');
  await expect(ask).toContainText('Photo of the shipping label');
  await ask.locator('input[type=file]').last().setInputFiles({ name: 'label.png', mimeType: 'image/png', buffer: PNG });
  await expect(ask.locator('.dp-thumb')).toHaveCount(1);
  await page.getByRole('button', { name: 'Finish batch' }).click();
  await page.getByRole('button', { name: 'Yes, commit' }).click();
  await expect(page.getByText(/^Batch .* saved$/)).toBeVisible({ timeout: 15_000 });

  const [{ batch_id }] = await q('SELECT batch_id FROM items WHERE sku = $1 LIMIT 1', [SKU]);
  const [{ evidence }] = await q('SELECT evidence FROM batches WHERE id = $1', [batch_id]);
  expect(evidence).toMatchObject({ label: ['https://photos.e2e.test/ev-1.jpg'], pairs: [], reasons: [] });

  // A problem found LATER on that delivery: the case shows the label that was photographed.
  const [{ batch_code }] = await q('SELECT batch_code FROM batches WHERE id = $1', [batch_id]);
  const wh = { Authorization: `Bearer ${signToken({ uid: 'e2e-wh', username: 'e2e_wh', name: 'E2E Warehouse', role: 'warehouse' })}` };
  const r = await request.post('/api/inbound-issues/report', { headers: wh, data: { scope: 'shipment', code: batch_code, type: 'shortfall', description: 'one pair short, found at shelving', expectedCount: 2, receivedCount: 1 } });
  expect(r.ok(), await r.text()).toBeTruthy();
  const { rows } = await (await request.get('/api/inbound-issues/list?view=open', { headers: wh })).json();
  const kase = rows.find((x) => Number(x.batch_id) === Number(batch_id));
  expect(kase.evidence.label).toEqual(['https://photos.e2e.test/ev-1.jpg']);
  await page.goto(`/inbound-issues?id=${kase.id}`);
  await expect(page.locator('.rcv-ev').first()).toContainText('Photos taken at receiving');
  await expect(page.locator('.rcv-ev').first()).toContainText('Shipping label');

  await q('DELETE FROM inbound_issue_events WHERE issue_id = $1', [kase.id]);
  await q('DELETE FROM inbound_issues WHERE id = $1', [kase.id]);
  // Leave nothing behind: a pair with no cost at the top of Inventory is another spec's subject.
  await q('DELETE FROM shipment_issues WHERE batch_id = $1', [batch_id]);
  await q('DELETE FROM items WHERE batch_id = $1', [batch_id]);
  await q('DELETE FROM batches WHERE id = $1', [batch_id]);
});

// Alex buys in a store and drives the pairs over: no courier, no label, nobody to claim from.
// "No tracking number" on step 1 switches the whole photo step off — even with no manifest.
test('carried in by hand ("No tracking number"): no photos are asked for, even without a manifest', async ({ page }) => {
  test.setTimeout(90_000);
  const sku = `${SKU}-H`;
  await loginAs(page, 'warehouse');
  await page.route('**/api/sku-search', (route) => route.fulfill({ json: { ok: true, product: { name: 'E2E Evidence Hand Carry', sku, image: '', source: 'manual', scannedSize: '9', sizes: ['9'] } } }));
  await page.goto('/receiving');
  await page.locator('label:has-text("Supplier") select').selectOption({ index: 1 });
  await page.locator('.no-track-check input[type=checkbox]').check();
  await page.locator('.manifest-q').getByRole('button', { name: 'No' }).click();
  // No tracking number AND no manifest: nothing to review it against, so no audit (2026-11-24).
  await expect(page.locator('.manifest-q')).toContainText('no manifest review');
  await expect(page.locator('.manifest-q')).not.toContainText('flagged for an audit');
  await page.getByRole('button', { name: 'Next →' }).click();
  await page.locator('.scanbar input').first().fill(sku);
  await page.locator('.scanbar').getByRole('button', { name: 'Add' }).click();
  await expect(page.locator(`.recv-item[data-sku="${sku}"]`)).toBeVisible();
  await page.getByRole('button', { name: 'Review →' }).click();
  await page.getByRole('button', { name: 'Next →' }).click();

  await expect(page.getByRole('button', { name: 'Finish batch' })).toBeVisible();
  await expect(page.locator('.oo-claim')).toHaveCount(0);
  await expect(page.locator('[data-claim-optional="label"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Finish batch' }).click();
  await expect(page.locator('.confirm-summary')).toBeVisible();
  await expect(page.locator('.confirm-summary')).not.toContainText('flagged for audit');
  await page.getByRole('button', { name: 'Yes, commit' }).click();
  await expect(page.getByText(/^Batch .* saved$/)).toBeVisible({ timeout: 15_000 });

  const [{ batch_id }] = await q('SELECT batch_id FROM items WHERE sku = $1 LIMIT 1', [sku]);
  const [b] = await q('SELECT evidence, no_tracking, manifest_received FROM batches WHERE id = $1', [batch_id]);
  // manifest_received NULL = not flagged: it is on no audit list and carries no audit chip.
  expect(b).toMatchObject({ evidence: null, no_tracking: true, manifest_received: null });
  const pending = await (await page.request.get('/api/batches/list?kind=receiving&audit=pending', { headers: { Authorization: `Bearer ${signToken({ uid: 'e2e-ev', username: 'e2e_ev', name: 'E2E Evidence', role: 'warehouse' })}` } })).json();
  expect(pending.batches.some((x) => Number(x.id) === Number(batch_id))).toBe(false);
  await q('DELETE FROM shipment_issues WHERE batch_id = $1', [batch_id]);
  await q('DELETE FROM items WHERE batch_id = $1', [batch_id]);
  await q('DELETE FROM batches WHERE id = $1', [batch_id]);
});
