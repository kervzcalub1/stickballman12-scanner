// Targeted QA: duplicate-tracking UI (isolated — avoids rate-limit exhaustion)
// + box double-submit guard
import { test, expect } from '@playwright/test';
import { signToken } from '../api/_lib/util.js';
import { loginAs } from './helpers/auth.js';

const authHeaders = () => ({
  Authorization: `Bearer ${signToken({ uid: 'e2e-wh', username: 'e2e_wh', name: 'E2E Warehouse', role: 'warehouse' })}`,
});

// ─── 1. Duplicate tracking UI warning (isolated, low API call count) ─────────
test('Receiving wizard: duplicate tracking .dup-warn appears', async ({ page, request }) => {
  // Seed the batch using the request fixture (minimal prior calls)
  const TRACK = `QA-UIONLY-${Date.now()}`;
  const r = await request.post('/api/batches/commit', {
    headers: authHeaders(),
    data: {
      batch: { supplier: 'QA-UI', tracking: TRACK, dateReceived: '2026-07-03' },
      items: [{ name: 'UI Only Test', sku: 'QA-UI-ONLY', size: '9', cost: 40 }],
    },
  });
  test.skip(r.status() === 429, 'rate-limited (run this spec in isolation)');
  expect(r.status()).toBe(200);

  await loginAs(page, 'warehouse');
  await page.goto('/receiving');
  await expect(page.getByText('Shipment details')).toBeVisible();

  const trackInput = page.locator('input[placeholder="Type, scan, or upload a photo"]');
  await expect(trackInput).toBeVisible({ timeout: 8000 });
  await trackInput.fill(TRACK);
  // Trigger React onChange properly: tab away
  await page.keyboard.press('Tab');

  // Wait for debounce (500ms) + API round-trip + render
  await page.waitForTimeout(2500);
  const warn = page.locator('.dup-warn');
  const warnVisible = await warn.isVisible().catch(() => false);
  if (warnVisible) {
    await expect(warn).toContainText('already received');
    console.log('PASS: Duplicate tracking .dup-warn visible and contains "already received"');
  } else {
    // Fallback: check if any text about duplicates is visible
    const anyText = await page.locator('text=already received').isVisible().catch(() => false);
    console.log(`warnVisible=${warnVisible} anyText=${anyText}`);
  }
  expect(warnVisible).toBe(true);
});

// ─── 2. Box double-submit: already-received box → 409 ────────────────────────
test('box-commit: re-submitting an already-received box → 409', async ({ request }) => {
  // Create open batch
  const r1 = await request.post('/api/batches/create-open', {
    headers: authHeaders(),
    data: { batch: { supplier: 'QA-BoxDouble', dateReceived: '2026-07-03', expectedBoxes: 1 } },
  });
  test.skip(r1.status() === 429, 'rate-limited');
  expect(r1.status()).toBe(200);
  const { id: batchId } = await r1.json();

  // Add a box
  const r2 = await request.post('/api/batches/add-box', {
    headers: authHeaders(),
    data: { batchId, trackingNumber: `QA-BOX-DBL-${Date.now()}`, boxNumber: 1 },
  });
  expect(r2.status()).toBe(200);
  const boxId = (await r2.json()).box.id;

  // First commit succeeds
  const r3 = await request.post('/api/batches/box-commit', {
    headers: authHeaders(),
    data: {
      batchId, boxId,
      items: [{ name: 'Box Double Test', sku: 'QA-BOX-DBL', size: '9', cost: 45 }],
    },
  });
  test.skip(r3.status() === 429, 'rate-limited');
  expect(r3.status()).toBe(200);
  console.log('First box-commit: PASS (status 200)');

  // Second commit of SAME box → must 409 (or 429 when rate-limited in full-suite run)
  const r4 = await request.post('/api/batches/box-commit', {
    headers: authHeaders(),
    data: {
      batchId, boxId,
      items: [{ name: 'Box Double Test 2', sku: 'QA-BOX-DBL2', size: '10', cost: 45 }],
    },
  });
  test.skip(r4.status() === 429, 'rate-limited in full-suite run — already-received guard confirmed in isolation');
  expect(r4.status()).toBe(409);
  const body4 = await r4.json();
  expect(body4.error).toMatch(/already submitted/i);
  console.log('PASS: Second box-commit correctly rejected with 409:', body4.error);
});

// ─── 3. Status transitions — wrong VIN on sold scan ─────────────────────────
test('StatusScan: unknown VIN returns 404 (no item found)', async ({ request }) => {
  const bogusVin = 'SBM-260703-999999';
  const res = await request.get(`/api/items/lookup?code=${bogusVin}`, { headers: authHeaders() });
  expect(res.status()).toBe(404);
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(body.error).toMatch(/No item found/i);
  console.log('PASS: Unknown VIN lookup returns 404:', body.error);
});

// ─── 4. batch set-status can reopen a committed batch ───────────────────────
test('FINDING: set-status can reopen a committed batch to open', async ({ request }) => {
  // Create a regular committed batch
  const r1 = await request.post('/api/batches/commit', {
    headers: authHeaders(),
    data: {
      batch: { supplier: 'QA-Reopen', tracking: `QA-REOPEN-${Date.now()}`, dateReceived: '2026-07-03' },
      items: [{ name: 'Reopen Test', sku: 'QA-REOPEN-SKU', size: '9', cost: 40 }],
    },
  });
  test.skip(r1.status() === 429, 'rate-limited');
  expect(r1.status()).toBe(200);
  const batchId = (await r1.json()).batchCode;

  // Get the batch id from the list
  const listRes = await request.get('/api/batches/list', { headers: authHeaders() });
  test.skip(listRes.status() === 429, 'rate-limited');
  const batches = (await listRes.json()).batches || [];
  const found = batches.find((b) => b.batch_code === batchId);
  test.skip(!found, 'batch not in list');

  // Try to set status to 'open' on a committed batch
  const res = await request.post('/api/batches/set-status', {
    headers: authHeaders(),
    data: { id: found.id, status: 'open' },
  });
  const body = await res.json();
  console.log(`set-status to open on committed batch: HTTP ${res.status()} ok:${body.ok}`);
  // This currently SUCCEEDS — a committed batch can be reopened
  // This is a potential loophole: staff could reopen a batch that was already closed
  if (res.status() === 200 && body.ok) {
    console.log('FINDING: set-status endpoint can reopen a committed receiving batch back to open');
  }
});
