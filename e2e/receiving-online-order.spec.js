// Receive New reads PH's online orders (2026-10-01). A parcel whose tracking number is on
// an online order says what it should hold, and each pair's cost comes from the order's
// ACTUAL cost for that SKU + size (coupon, tax, shipping and gift card already spread) —
// with what was paid saved as the pair's shelf price, for the audit.
import { test, expect } from '@playwright/test';
import pg from 'pg';
import { signToken } from '../api/_lib/util.js';
import { loginAs } from './helpers/auth.js';
import { compareOrderWithReceived, countsFromReceived, underOrderCodes } from '../api/_lib/online-order-received.js';
import { lineKey, nearCode } from '../src/lib/onlineOrders.js';
import { issueHeadline } from '../src/lib/inboundIssues.js';
import { onlineOrderArrivedBody } from '../api/_lib/alerts.js';

// A 1×1 PNG: the photo the stubs hand around.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const PH = { Authorization: `Bearer ${signToken({ uid: 'oo-ph', username: 'oo_ph', name: 'OO PH', role: 'ph_team' })}` };
const stamp = `${Date.now()}`.slice(-7);
const SKU = `E2E-OOR-${stamp}`;
const TRACK = `1ZOOR${stamp}`;
let db; let orderId;

test.beforeAll(async ({ request }) => {
  db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  // 2 × $100 with a $20 coupon and $16 tax → $98 a pair.
  const r = await request.post('/api/online-orders/save', { headers: PH, data: {
    store: 'E2E-OO Receive', tracking_number: TRACK, coupon: 20, tax: 16,
    lines: [{ sku: SKU, size: '9', qty: 2, unit_price: 100 }],
  } });
  expect(r.ok(), await r.text()).toBeTruthy();
  orderId = (await r.json()).id;
});

test.afterAll(async () => {
  // SKU and its suffixed variants (-M, -X, -D).
  const like = `${SKU}%`;
  await db.query('DELETE FROM item_events WHERE item_id IN (SELECT id FROM items WHERE sku LIKE $1)', [like]);
  const b = await db.query('SELECT DISTINCT batch_id FROM items WHERE sku LIKE $1', [like]);
  await db.query('DELETE FROM items WHERE sku LIKE $1', [like]);
  for (const { batch_id: id } of b.rows) {
    await db.query('DELETE FROM inbound_issues WHERE batch_id = $1', [id]).catch(() => {});
    await db.query('DELETE FROM shipment_issues WHERE batch_id = $1', [id]).catch(() => {});
    await db.query('DELETE FROM batches WHERE id = $1', [id]).catch(() => {});
  }
  await db.query(`DELETE FROM online_orders WHERE store LIKE 'E2E-OO%'`);
  await db.end();
});

test('an online order’s parcel says what it holds, and its pairs land at the order’s actual cost', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.route('**/api/sku-search', (route) => route.fulfill({
    json: { ok: true, product: { name: 'E2E OO Receive Shoe', sku: SKU, image: '', source: 'manual', scannedSize: '9', sizes: ['9'] } },
  }));
  await page.goto('/receiving');
  await page.locator('label:has-text("Supplier") select').selectOption({ index: 1 });
  // Typed with a space and lower case, the way a number gets copied from an email.
  await page.locator('.track-field input').first().fill(`1zoor ${stamp}`);
  const banner = page.locator('.oo-recv-banner').first();
  await expect(banner).toContainText(`OO-${String(orderId).padStart(4, '0')}`, { timeout: 10_000 });
  await expect(banner).toContainText(`${SKU} US 9 ×2`);
  await page.locator('.manifest-q').getByRole('button', { name: 'Yes' }).click();
  await page.getByRole('button', { name: 'Next →' }).click();

  for (let i = 0; i < 2; i += 1) {
    await page.locator('.scanbar input').first().fill(SKU);
    await page.locator('.scanbar').getByRole('button', { name: 'Add' }).click();
  }
  const card = page.locator(`.recv-item[data-sku="${SKU}"]`);
  await expect(card.locator('.recv-item-cost-src')).toContainText('from online order', { timeout: 10_000 });
  await expect(card.locator('.recv-item-cost input')).toHaveAttribute('placeholder', '98.00');

  await page.getByRole('button', { name: 'Review →' }).click();
  // Both pairs that were ordered came out — the box matches its order.
  await expect(page.locator('.po-summary.clean')).toContainText('Everything the online order declared came out of the box');
  await page.getByRole('button', { name: 'Next →' }).click();
  await page.getByRole('button', { name: 'Finish batch' }).click();
  await page.getByRole('button', { name: 'Yes, commit' }).click();
  await expect(page.getByText(/^Batch .* saved$/)).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.po-mismatch')).toHaveCount(0);

  const rows = (await db.query('SELECT cost, shelf_price FROM items WHERE sku = $1', [SKU])).rows;
  expect(rows).toHaveLength(2);
  for (const r of rows) { expect(Number(r.cost)).toBe(98); expect(Number(r.shelf_price)).toBe(100); }
});

test('a tracking number that is no online order changes nothing', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.goto('/receiving');
  await page.locator('.track-field input').first().fill(`1ZNOTANORDER${stamp}`);
  await page.waitForTimeout(1200);
  await expect(page.locator('.oo-recv-banner')).toHaveCount(0);
});

// QA pass #2, finding 1: a multi-box receive with box 1 = order A and box 2 = order B costed
// a box-2 pair off order A whenever both orders carried that SKU + size (the first order in
// the list won), and a shoe only on A's order was costed in box 2 too. Each box now uses
// ITS OWN parcel's order.
test('a multi-box receive costs each box from its own online order', async ({ page, request }) => {
  const S = `${SKU}-M`; const X = `${SKU}-X`;
  const mk = async (tracking, lines) => {
    const r = await request.post('/api/online-orders/save', { headers: PH, data: { store: 'E2E-OO Multi', tracking_number: tracking, lines } });
    expect(r.ok(), await r.text()).toBeTruthy();
    return (await r.json()).id;
  };
  await mk(`1ZOOMA${stamp}`, [{ sku: S, size: '9', qty: 1, unit_price: 50 }, { sku: X, size: '9', qty: 1, unit_price: 51 }]);
  const bId = await mk(`1ZOOMB${stamp}`, [{ sku: S, size: '9', qty: 1, unit_price: 80 }]);

  await loginAs(page, 'warehouse');
  await page.route('**/api/sku-search', (route) => {
    const sku = String(route.request().postDataJSON()?.sku || '').toUpperCase();
    return route.fulfill({ json: { ok: true, product: { name: `E2E OO ${sku.slice(-1)}`, sku, image: '', source: 'manual', scannedSize: '9', sizes: ['9'] } } });
  });
  await page.goto('/receiving');
  await page.locator('label:has-text("Supplier") select').selectOption({ index: 1 });
  await page.locator('label:has-text("Boxes expected") input').fill('2');
  await page.locator('.manifest-q').getByRole('button', { name: 'Yes' }).click();
  const rows = page.locator('.box-build-row');
  await expect(rows).toHaveCount(2);
  await rows.nth(0).locator('.box-build-track input').fill(`1ZOOMA${stamp}`);
  await rows.nth(1).locator('.box-build-track input').fill(`1ZOOMB${stamp}`);
  await page.waitForTimeout(1200);   // the lookup's pause
  await rows.nth(1).getByRole('button', { name: 'Add items' }).click();

  await expect(page.locator('.oo-recv-banner')).toHaveCount(1);
  await expect(page.locator('.oo-recv-banner')).toContainText(`OO-${String(bId).padStart(4, '0')}`);
  for (const code of [S, X]) {
    await page.locator('.scanbar input').first().fill(code);
    await page.locator('.scanbar').getByRole('button', { name: 'Add' }).click();
  }
  const card = (sku) => page.locator(`.recv-item[data-sku="${sku}"]`);
  await expect(card(S).locator('.recv-item-cost input')).toHaveAttribute('placeholder', '80.00');
  await expect(card(S).locator('.recv-item-cost-src')).toContainText(`OO-${String(bId).padStart(4, '0')}`);
  // X is only on box 1's order — nothing to take from box 2's.
  await expect(card(X).locator('.recv-item-cost-src')).not.toContainText('online order');
});


// Brent, 2026-10-21: "compare what is scanned to what is expected and say if there is a
// short or over, like inbounding against a supplier's manifest" — on Review, again once
// the batch is saved, and on the batch so Recent shows it.
test('a box that doesn’t match its online order: short / not on order on Review, an alert when saved, an issue on the batch', async ({ page, request }) => {
  const S = `${SKU}-D`; const T = `1ZOOD${stamp}`;
  const r = await request.post('/api/online-orders/save', { headers: PH, data: { store: 'E2E-OO Foot Locker', order_number: 'P750', tracking_number: T,
    lines: [{ sku: S, size: '9', qty: 3, unit_price: 100 }, { sku: S, size: '8', qty: 1, unit_price: 100 }] } });
  expect(r.ok(), await r.text()).toBeTruthy();
  const code = `OO-${String((await r.json()).id).padStart(4, '0')}`;

  await loginAs(page, 'warehouse');
  await page.route('**/api/sku-search', (route) => route.fulfill({
    json: { ok: true, product: { name: 'E2E OO Short Shoe', sku: S, image: '', source: 'manual', scannedSize: '9', sizes: ['8', '9'] } },
  }));
  await page.goto('/receiving');
  await page.locator('label:has-text("Supplier") select').selectOption({ index: 1 });
  await page.locator('.track-field input').first().fill(T);
  await expect(page.locator('.oo-recv-banner').first()).toContainText(code, { timeout: 10_000 });
  await page.locator('.manifest-q').getByRole('button', { name: 'Yes' }).click();
  await page.getByRole('button', { name: 'Next →' }).click();
  // Two of the three 9s came out, the 8 didn't.
  for (let i = 0; i < 2; i += 1) {
    await page.locator('.scanbar input').first().fill(S);
    await page.locator('.scanbar').getByRole('button', { name: 'Add' }).click();
  }
  await expect(page.locator(`.recv-item[data-sku="${S}"]`)).toBeVisible();
  await page.getByRole('button', { name: 'Review →' }).click();

  const sum = page.locator('.po-summary').filter({ hasText: `online order ${code}` });
  await expect(sum).toContainText('4 expected');
  await expect(sum).toContainText('2 received');
  await expect(sum).toContainText('2 missing');
  await expect(sum.locator('.po-summary-row.missing')).toContainText('size 8');
  await expect(sum.locator('.po-summary-row.short')).toContainText('size 9');

  await page.getByRole('button', { name: 'Next →' }).click();

  // SHORT: the claim photos are required before the box can be saved (owner, 2026-11-18).
  // The uploads are stubbed: this is about the gate, not the bucket.
  let n = 0;
  await page.route('**/api/inbound-issues/photo-sign', (route) => { n += 1; return route.fulfill({ json: { ok: true, uploadUrl: 'https://uploads.e2e.test/put', publicUrl: `https://photos.e2e.test/claim-${n}.jpg` } }); });
  await page.route('https://uploads.e2e.test/**', (route) => route.fulfill({ status: 200, body: '' }));
  await page.route('https://photos.e2e.test/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
  const claim = page.locator('.oo-claim');
  await expect(claim).toContainText('2 pairs missing');
  await expect(claim).toHaveAttribute('data-claim-left', '3');
  await expect(claim.locator('.oo-short-msg')).toContainText(`order #P750 (${code}), tracking ${T}. Ordered 4, received 2, short by 2`);
  await page.getByRole('button', { name: 'Finish batch' }).click();
  await expect(page.locator('.error')).toContainText('Take the photos for the claim first');
  const shoot = async (key) => {
    await claim.locator(`[data-claim="${key}"] input[type=file]`).last().setInputFiles({ name: `${key}.png`, mimeType: 'image/png', buffer: PNG });
    await expect(claim.locator(`[data-claim="${key}"] .dp-thumb`)).toHaveCount(1);
  };
  await shoot('label');
  await shoot('pairs');
  if (process.env.SHOT) { await page.setViewportSize({ width: 430, height: 1500 }); await page.locator('.oo-claim').screenshot({ path: '/private/tmp/claude-501/-Users-kervz-Stickballman12/9a97eea1-0ed1-4509-b269-b446f0ebfe4d/scratchpad/claim.png' }); }
  await page.getByRole('button', { name: 'Finish batch' }).click();
  await expect(page.locator('.error')).toContainText('the packing slip / manifest that came inside');
  // No paper in the parcel is an answer, said out loud.
  await claim.getByLabel('There was no packing slip in the parcel').check();
  await expect(claim).toHaveAttribute('data-claim-left', '0');

  await page.getByRole('button', { name: 'Finish batch' }).click();
  await page.getByRole('button', { name: 'Yes, commit' }).click();
  await expect(page.getByText(/^Batch .* saved$/)).toBeVisible({ timeout: 15_000 });
  const alert = page.locator('.po-mismatch');
  await expect(alert).toContainText('Tell the PH team on WhatsApp now');
  await expect(alert).toContainText(`${code} doesn’t match the online order`);
  await expect(alert).toContainText('2 short');
  await expect(alert.getByRole('link', { name: 'Open the order on Online Orders' })).toBeVisible();

  const issue = (await db.query(`SELECT si.type, si.description, si.expected_count, si.received_count, si.photos FROM shipment_issues si
    JOIN items i ON i.batch_id = si.batch_id WHERE i.sku = $1 AND si.type = 'online_order' LIMIT 1`, [S])).rows[0];
  expect(issue).toMatchObject({ type: 'online_order', expected_count: 4, received_count: 2 });
  expect(issue.description).toContain(`${S} US 8 missing (0/1)`);
  expect(issue.description).toContain(`${S} US 9 short (2/3)`);
  expect(issue.description).toContain('Claim photos: label ×1, pairs ×1, slip ×0 (no packing slip in the parcel)');
  expect(issue.photos).toEqual(['https://photos.e2e.test/claim-1.jpg', 'https://photos.e2e.test/claim-2.jpg']);
  // …and it is a case for the PH team, said in words.
  const c = (await db.query(`SELECT ii.id, ii.type, ii.expected_count, ii.received_count, ii.photos FROM inbound_issues ii
    JOIN items i ON i.batch_id = ii.batch_id WHERE i.sku = $1 LIMIT 1`, [S])).rows[0];
  expect(c).toMatchObject({ type: 'online_order', expected_count: 4, received_count: 2 });
  expect(issueHeadline({ scope: 'shipment', ...c })).toContain('Online order parcel SHORT by 2');
});

test('received first, tracking number later: the short parcel is found, a case opened, the photos asked of the warehouse', async ({ page, request }) => {
  const S = `${SKU}-L`; const T = `1ZOOL${stamp}`;
  // The parcel lands with no online order on its number yet: 3 pairs, nothing to compare with.
  await loginAs(page, 'warehouse');
  await page.route('**/api/sku-search', (route) => route.fulfill({
    json: { ok: true, product: { name: 'E2E OO Late Shoe', sku: S, image: '', source: 'manual', scannedSize: '7.5', sizes: ['7.5'] } },
  }));
  await page.goto('/receiving');
  await page.locator('label:has-text("Supplier") select').selectOption({ index: 1 });
  await page.locator('.track-field input').first().fill(T);
  await page.locator('.manifest-q').getByRole('button', { name: 'Yes' }).click();
  await page.getByRole('button', { name: 'Next →' }).click();
  for (let i = 0; i < 3; i += 1) {
    await page.locator('.scanbar input').first().fill(S);
    await page.locator('.scanbar').getByRole('button', { name: 'Add' }).click();
  }
  await page.getByRole('button', { name: 'Review →' }).click();
  await page.getByRole('button', { name: 'Next →' }).click();
  await expect(page.locator('.oo-claim')).toHaveCount(0);
  await page.getByRole('button', { name: 'Finish batch' }).click();
  await page.getByRole('button', { name: 'Yes, commit' }).click();
  await expect(page.getByText(/^Batch .* saved$/)).toBeVisible({ timeout: 15_000 });

  // An order with no tracking number is nothing to compare; nor is one whose parcel isn't in.
  const mk = async (data) => (await (await request.post('/api/online-orders/save', { headers: PH, data: { store: 'E2E-OO Shoe Palace', order_number: `SPL${stamp}`, ...data } })).json()).id;
  const none = await mk({ lines: [{ sku: S, size: '7.5', qty: 4, unit_price: 100 }] });
  expect((await compareOrderWithReceived(none)).state).toBe('no_tracking');
  const far = await mk({ tracking_number: `1ZNOTIN${stamp}`, lines: [{ sku: S, size: '7.5', qty: 4, unit_price: 100 }] });
  expect((await compareOrderWithReceived(far)).state).toBe('not_received');

  // The number reaches the order (typed here; the store's email does the same): 4 ordered, 3 in.
  // The SKU on the order is typed differently from the box's: short is by COUNT, so it still reads 1.
  const id = await mk({ tracking_number: T, lines: [{ sku: 'TYPED-OTHERWISE', size: '7.5', qty: 4, unit_price: 100 }] });
  await expect.poll(async () => (await db.query('SELECT received_check_at FROM online_orders WHERE id = $1', [id])).rows[0].received_check_at, { timeout: 10_000 }).not.toBeNull();
  // The compare stamps received_check_at BEFORE it opens the case (photos are looked up in
  // between), so the case is waited for too — reading it at once was a race CI lost (2026-11-24).
  const readCases = async () => (await db.query(`SELECT ii.* FROM inbound_issues ii JOIN items i ON i.batch_id = ii.batch_id WHERE i.sku = $1 GROUP BY ii.id`, [S])).rows;
  await expect.poll(async () => (await readCases()).length, { timeout: 10_000 }).toBe(1);
  await expect.poll(async () => (await readCases())[0]?.warehouse_task || '', { timeout: 10_000 }).toContain('WhatsApp');
  const cases = await readCases();
  expect(cases).toHaveLength(1);
  expect(cases[0]).toMatchObject({ type: 'online_order', expected_count: 4, received_count: 3, status: 'open', source: 'online_order' });
  expect(cases[0].description).toContain(`Short by 1: 3 of 4 pairs came out of the parcel with tracking ${T}`);
  expect(cases[0].warehouse_task).toContain('photos needed for the claim');
  expect(cases[0].warehouse_task).toContain('WhatsApp');
  // The SKU doesn't match the box's, so which pair is missing is a judgement: NOT counted in.
  expect((await db.query('SELECT received_at FROM online_orders WHERE id = $1', [id])).rows[0].received_at).toBeNull();
  // Asked again (the worker, another save): one case, not two.
  expect((await compareOrderWithReceived(id)).state).toBe('already');
  expect((await db.query(`SELECT count(*)::int n FROM inbound_issues WHERE batch_id = $1`, [cases[0].batch_id])).rows[0].n).toBe(1);
  // A parcel with every pair in it opens nothing.
  await db.query(`DELETE FROM inbound_issue_events WHERE issue_id = $1`, [cases[0].id]).catch(() => {});
  await db.query(`DELETE FROM inbound_issues WHERE id = $1`, [cases[0].id]);
  await db.query(`DELETE FROM shipment_issues WHERE batch_id = $1`, [cases[0].batch_id]);
  const full = await mk({ tracking_number: T, allowDuplicateTracking: true, lines: [{ sku: S, size: '7.5', qty: 3, unit_price: 100 }] });
  // …and is COUNTED IN by itself: the warehouse scanning the parcel was the count.
  // (Saving the number already started the compare on the server; whichever ran, it is counted.)
  await compareOrderWithReceived(full);
  const got = await (await request.get(`/api/online-orders/get?id=${full}`, { headers: PH })).json();
  expect(got.order.stage).toBe('delivered');
  expect(got.order.received_by).toMatch(/^Auto · batch B-/);
  expect(got.events.at(-1)).toMatchObject({ action: 'received' });
  expect(got.events.at(-1).detail).toContain('all 3 pair(s) arrived — matched to batch');
  expect(await compareOrderWithReceived(full)).toMatchObject({ state: 'ok' });   // again: nothing more

  // Short, and the pairs that came ARE the ones ordered: counted in with what arrived, the
  // missing pair split off as not delivered with its refund to chase, and a case for PH.
  const shortId = await mk({ tracking_number: T, allowDuplicateTracking: true, lines: [{ sku: S, size: '7.5', qty: 5, unit_price: 100 }] });
  await compareOrderWithReceived(shortId);
  const sh = { caseId: (await db.query(`SELECT id FROM inbound_issues WHERE batch_id = $1 AND description LIKE 'Short by 2:%'`, [cases[0].batch_id])).rows[0].id };
  const so = (await (await request.get(`/api/online-orders/get?id=${shortId}`, { headers: PH })).json()).order;
  expect(so.stage).toBe('delivered');
  expect(so.lines.map((l) => [l.qty, l.cancel_reason || null, l.refund || null])).toEqual([[3, null, null], [2, 'not_delivered', 'needs_request']]);
  await db.query(`DELETE FROM inbound_issues WHERE id = $1`, [sh.caseId]);
  await db.query(`DELETE FROM shipment_issues WHERE batch_id = $1`, [cases[0].batch_id]);

  // The right COUNT but not the shoe that was ordered: wrong pairs, a case as well.
  const cleanUp = async (batchId) => {
    await db.query(`DELETE FROM inbound_issues WHERE batch_id = $1`, [batchId]);
    await db.query(`DELETE FROM shipment_issues WHERE batch_id = $1`, [batchId]);
  };
  const other = await mk({ tracking_number: T, allowDuplicateTracking: true, lines: [{ sku: S, size: '7.5', qty: 2, unit_price: 100 }, { sku: S, size: '9', qty: 1, unit_price: 100 }] });
  const w = await compareOrderWithReceived(other);
  expect(['wrong', 'already']).toContain(w.state);
  expect(w.counted).toBe(false);
  // 'already' = the server's own compare (started by the save) got there first and may still be
  // writing the case: wait for it.
  const readWrong = async () => (await db.query(`SELECT * FROM inbound_issues WHERE batch_id = $1 AND description LIKE 'Wrong pairs:%'`, [cases[0].batch_id])).rows[0];
  await expect.poll(async () => Boolean(await readWrong()), { timeout: 10_000 }).toBe(true);
  const wc = await readWrong();
  expect((await db.query('SELECT received_at FROM online_orders WHERE id = $1', [other])).rows[0].received_at).toBeNull();
  expect(wc.description).toContain('Wrong pairs: 1 of the 3 in the parcel');
  expect(wc.description).toContain(`${S} US 7.5 extra (+1)`);
  expect(issueHeadline({ scope: 'shipment', ...wc })).toContain('Online order parcel has WRONG pairs');
  await cleanUp(cases[0].batch_id);

  // The warehouse sees the job on the case.
  const again = await compareOrderWithReceived(id);
  expect(again.state).toBe('short');
  await page.goto(`/inbound-issues?id=${again.caseId}`);
  await expect(page.locator('body')).toContainText('photos needed for the claim');
});

test('countsFromReceived: the delivery’s pairs are handed to the order’s lines by code and size', () => {
  const lines = [{ id: 1, sku: 'DD1391-100', size: '9', qty: 2 }, { id: 2, sku: 'dd1391 100', size: '9.0', qty: 2 }, { id: 3, sku: 'DD1391-100', size: '10', qty: 1 }, { id: 4, sku: 'X', size: '9', qty: 1, cancelled_at: '2026-11-01' }];
  const c = countsFromReceived(lines, [{ sku: 'DD1391100', size: '9', qty: 3 }, { sku: 'ZZ', size: '10', qty: 5 }]);
  expect([...c]).toEqual([[1, 2], [2, 1], [3, 0]]);
  // The slash JD Sports prints and the dash on the box are one code; a code one character off
  // with the same size is the same shoe mistyped; anything further is a different shoe.
  expect(lineKey('IV2867/100', '9')).toBe(lineKey('iv2867-100', '9.0'));
  expect(nearCode('Q0400-100', 'IQ0400-100')).toBe(true);
  expect(nearCode('DD1391-100', 'DD1391-103')).toBe(true);
  expect(nearCode('DD1391-100', 'DD1391-001')).toBe(false);
  expect(nearCode('AB1', 'AB12')).toBe(false);
  const typed = [{ id: 1, sku: 'Q0400-100', size: '10.5', qty: 5 }];
  expect(underOrderCodes(typed, [{ sku: 'IQ0400-100', size: '10.5', qty: 5 }])).toEqual([{ sku: 'Q0400-100', size: '10.5', qty: 5 }]);
  expect(underOrderCodes(typed, [{ sku: 'IQ0400-100', size: '11', qty: 5 }])[0].sku).toBe('IQ0400-100');   // another size: not assumed
  // The box in women's sizing for the men's size ordered (11.5W = men's 10): the same pairs.
  expect(underOrderCodes([{ id: 1, sku: 'HF2881-302', size: '10', qty: 4 }], [{ sku: 'HF2881-302-', size: '11.5W', qty: 4 }])).toEqual([{ sku: 'HF2881-302', size: '10', qty: 4 }]);
  expect(underOrderCodes([{ id: 1, sku: 'HF2881-302', size: '10', qty: 4 }], [{ sku: 'HF2881-302', size: '11.5', qty: 4 }])[0].size).toBe('11.5');   // not marked W: a different size
  // Two order lines it could be: not assumed either.
  expect(underOrderCodes([{ id: 1, sku: 'DD1391-100', size: '9', qty: 1 }, { id: 2, sku: 'DD1391-102', size: '9', qty: 1 }], [{ sku: 'DD1391-101', size: '9', qty: 1 }])[0].sku).toBe('DD1391-101');
});

test('the Telegram message for a parcel: who, which numbers, what came, and the finding', async () => {
  const order = { id: 85, store: 'Foot Locker', order_number: 'P7509922306077007872', tracking_number: '384212231759' };
  const ok = onlineOrderArrivedBody({ order, batchCode: 'B-101889', items: [{ sku: 'IM4260-001', size: '13', qty: 1 }], expected: 1, received: 1, counted: true });
  expect(ok).toBe('Foot Locker · order #P7509922306077007872\nTracking 384212231759 · batch B-101889\nArrived: 1 pair — IM4260-001 US 13 ×1\n✅ All 1 ordered pair arrived. Counted in.');
  const bad = onlineOrderArrivedBody({ order, batchCode: 'B-1', items: [{ sku: 'A', size: '9', qty: 3 }], expected: 4, received: 3, short: 1, counted: true, caseId: 12, text: 'A US 9 short (3/4)' });
  expect(bad).toContain('⚠️ SHORT by 1 (3 of 4).');
  expect(bad).toContain('A US 9 short (3/4)');
  expect(bad).toContain('Case #12 is open for the claim.');
  // What the compare hands the alert: every parcel is told once, an old clean one is not.
  const told = [];
  const io = (received_at, items) => ({ arrived: (i) => told.push(i), order: async () => ({ ...order, lines: [{ id: 1, sku: 'IM4260-001', size: '13', qty: 1 }] }),
    received: async () => ({ batch_id: 1, box_id: null, batch_code: 'B-101889', received_at, items }), mark: async () => {}, flagged: async () => null, count: async () => true,
    issue: async () => [{ id: 1, description: 'd' }], open: async () => [{ id: 9 }], task: async () => null, alert: () => {}, alertTask: () => {} });
  await compareOrderWithReceived(85, { io: io(new Date().toISOString(), [{ sku: 'IM4260-001', size: '13', qty: 1 }]) });
  expect(told).toHaveLength(1);
  expect(told[0]).toMatchObject({ batchCode: 'B-101889', expected: 1, received: 1, short: 0, wrong: 0, counted: true });
  await compareOrderWithReceived(85, { io: io('2026-10-31T17:55:00Z', [{ sku: 'IM4260-001', size: '13', qty: 1 }]) });
  expect(told).toHaveLength(1);                       // matched, landed weeks ago: counted in quietly
  await compareOrderWithReceived(85, { io: io('2026-10-31T17:55:00Z', []) });
  expect(told[1]).toMatchObject({ short: 1, caseId: 9 });   // short is always told, however old
});
