// Lost Package Tracker Tool (docs/context/lost-packages.md): Phase 1 in the browser from a
// month's Order Updates workbook, Phase 2 on the server against a FAKE FedEx + EasyPost on
// :5193 (playwright.config.js points both there with fake keys — no real tracker is ever made).
import { test, expect } from '@playwright/test';
import http from 'node:http';
import { signToken } from '../api/_lib/util.js';
import { loadEnv, loginAs } from './helpers/auth.js';
import { buildXlsxBook } from '../src/lib/xlsx.js';
import { readSheetRows, openWorkbook } from '../src/lib/sheinReprice.js';

loadEnv();
test.describe.configure({ mode: 'serial' });

const ph = () => ({ Authorization: `Bearer ${signToken({ uid: 'e2e-ph', username: 'e2e_ph', name: 'E2E PH', role: 'ph_team' })}` });
const wh = () => ({ Authorization: `Bearer ${signToken({ uid: 'e2e-wh', username: 'e2e_wh', name: 'E2E Warehouse', role: 'warehouse' })}` });

// ---- the fake couriers --------------------------------------------------------------
const calls = [];
let server;
const FEDEX = {
  '794655555555': { latestStatusDetail: { code: 'IT', description: 'In transit', statusByLocale: 'In transit' } },
  '794612345678': { latestStatusDetail: { code: 'OD', description: 'On FedEx vehicle for delivery', statusByLocale: 'On FedEx vehicle for delivery' } },
  '794600000002': { latestStatusDetail: { code: 'DL', description: 'Delivered', statusByLocale: 'Delivered' } },
  '794699999999': { error: { code: 'TRACKING.TRACKINGNUMBER.NOTFOUND', message: 'Tracking number cannot be found.' } },
};
const polls = {};
function easypostFor(code, id) {
  if (code === '9400111899223344556677') {
    polls[id] = (polls[id] || 0) + 1;
    return { id, status: polls[id] > 1 ? 'out_for_delivery' : 'unknown', status_detail: polls[id] > 1 ? 'out_for_delivery' : 'unknown' };
  }
  return { id, status: 'unknown', status_detail: 'unknown' };
}
test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, body });
      const json = (o, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.url === '/fedex/oauth/token') return json({ access_token: 'fake', expires_in: 3600 });
      if (req.url === '/fedex/track/v1/trackingnumbers') {
        const num = JSON.parse(body).trackingInfo[0].trackingNumberInfo.trackingNumber;
        const answer = () => json({ output: { completeTrackResults: [{ trackResults: [FEDEX[num] || { error: { code: 'NOTFOUND', message: 'not found' } }] }] } });
        // A slow one, so a Pause can land while it is in flight.
        if (num === '794655555555') return setTimeout(answer, 1500);
        return answer();
      }
      if (req.method === 'POST' && req.url === '/easypost/v2/trackers') {
        const code = JSON.parse(body).tracker.tracking_code;
        return json(easypostFor(code, `trk_${code}`));
      }
      const m = req.url.match(/^\/easypost\/v2\/trackers\/(trk_(.+))$/);
      if (req.method === 'GET' && m) return json(easypostFor(m[2], m[1]));
      return json({ error: 'unexpected' }, 404);
    });
  });
  await new Promise((r) => server.listen(5193, '127.0.0.1', r));
});
test.afterAll(async () => { await new Promise((r) => server.close(r)); });

// ---- a small month workbook: two daily tabs -------------------------------------------
const H = ['Order Date', 'Store Name', 'Product Name', 'SKU', 'Quantity', 'Order Number', 'x', 'y', 'z',
  'Tracking Courier', 'Tracking Number', 'a', 'b', 'c', 'Delivery Status'].map((label) => ({ label }));
const row = (date, store, shoe, order, courier, trk, status) => [date, store, shoe, 'E2E-SKU', '1', order, '', '', '', courier, trk, '', '', '', status];
function workbook() {
  return Buffer.from(buildXlsxBook([
    { sheetName: 'Nov 1', columns: H, rows: [
      row('45962', 'Nike', 'AF1', 'E2E-A1', 'FedEx', '794612345678', 'In transit'),
      row('45962', 'Nike', 'Dunk', 'E2E-A2', 'UPS', '1Z999AA10123456784', 'Delivered'),
      row('45962', 'Foot Locker', 'AJ1', 'E2E-A3', '', 'N/A', 'Order cancelled'),
      row('45962', 'Nike', 'P6000', 'E2E-A4', 'USPS', '', ''),
      row('45962', 'Nike', 'Vomero', 'E2E-A9', '', '', ''),
    ] },
    { sheetName: 'Nov 2', columns: H, rows: [
      row('45963', 'Nike', 'AF1', 'E2E-A1', 'FedEx', '794612345678', 'Still moving'),
      row('45963', 'Nike', 'P6000', 'E2E-A4', 'USPS', '9400111899223344556677', 'label created'),
      row('45963', 'Nike', 'Pegasus', 'E2E-A5', 'FedEx', '794600000001', 'Refund issued'),
      row('45963', 'Nike', 'Rift', 'E2E-A6', 'FedEx', '794600000002', 'shipped'),
      row('45963', 'Nike', 'KD 19', 'E2E-A7', '', '794699999999', ''),
    ] },
  ]));
}

let runId = null;

// A run left behind by an earlier failed attempt would make the "Saved runs" row ambiguous.
test.beforeAll(async ({ request }) => {
  const runs = (await (await request.get('/api/lost-packages/runs', { headers: ph() })).json()).runs || [];
  for (const r of runs.filter((x) => x.month_label === 'November 2025 E2E')) {
    await request.post('/api/lost-packages/phase2', { headers: ph(), data: { runId: Number(r.id), action: 'stop' } });
    await request.post('/api/lost-packages/phase2', { headers: ph(), data: { runId: Number(r.id), action: 'delete' } });
  }
});

test('Phase 1 in the browser, Phase 2 on the server: the month\'s lost packages', async ({ page }) => {
  await loginAs(page, 'ph_team');
  await page.goto('/ph/lost-packages');
  await expect(page.getByRole('heading', { name: 'Phase 1 — scan a month’s workbook' })).toBeVisible();
  await page.getByLabel('Order Updates workbook (.xlsx)').setInputFiles({
    name: 'Make | Order Updates Sheet | November 2025 E2E.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: workbook(),
  });
  await expect(page.getByRole('textbox', { name: 'Month' })).toHaveValue('November 2025');
  await page.getByRole('textbox', { name: 'Month' }).fill('November 2025 E2E');
  await page.getByRole('button', { name: 'Run Phase 1 Scan' }).click();

  // Refunded > Cancelled > Delivered > Lost; "Lost" = nothing in the workbook says delivered.
  const tile = (label) => page.locator('.lp-run .lp-tile', { hasText: new RegExp(`^\\d+${label}$`) });
  await expect(tile('Lost')).toContainText('6');
  await expect(tile('Delivered')).toContainText('1');
  await expect(tile('Cancelled')).toContainText('1');
  await expect(tile('Refunded')).toContainText('1');
  await expect(page).toHaveURL(/run=\d+/);
  runId = Number(new URL(page.url()).searchParams.get('run'));
  await expect(page.locator('.lp-runs tr', { hasText: 'November 2025 E2E' })).toBeVisible();

  // The Phase 1 workbook, as the original laid it out.
  const [d1] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '⬇ Phase 1 Excel' }).click()]);
  const p1 = await (await import('node:fs/promises')).readFile(await d1.path());
  expect(openWorkbook(p1).sheets.map((s) => s.name)).toEqual(['Summary', 'Lost', 'Delivered', 'Cancelled', 'Refunded']);
  expect(readSheetRows(p1, 'Lost').length).toBe(7);   // header + 6

  // Phase 2 on the server.
  await page.getByRole('button', { name: 'Run Phase 2 on these results →' }).click();
  await expect(page.locator('.lp-p2-line')).toContainText('Done', { timeout: 60_000 });
  const p2 = (cls) => page.locator(`.lp-p2 .lp-tile.${cls}`);
  // In transit (incl. "On FedEx vehicle for delivery" and EasyPost "out_for_delivery") stays LOST —
  // the original counted any "deliv" as delivered. Only a real delivery counts.
  await expect(p2('lost')).toContainText('3');
  await expect(p2('delivered')).toContainText('1');
  await expect(p2('failed')).toContainText('2');

  // The same number on two rows was asked once; FedEx "not found" fell back to EasyPost.
  const trackersMade = calls.filter((c) => c.method === 'POST' && c.url === '/easypost/v2/trackers').map((c) => JSON.parse(c.body).tracker.tracking_code);
  expect(trackersMade.filter((t) => t === '9400111899223344556677')).toHaveLength(1);
  expect(trackersMade).toContain('794699999999');
  expect(calls.some((c) => c.method === 'GET' && c.url.includes('trk_9400111899223344556677'))).toBe(true);   // re-polled the unknown

  const [d2] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '⬇ Phase 2 Excel' }).click()]);
  const p2x = await (await import('node:fs/promises')).readFile(await d2.path());
  expect(openWorkbook(p2x).sheets.map((s) => s.name)).toEqual(['PHASE 2 LOST PACKAGES', 'PHASE 2 CANCEL', 'PHASE 2 REFUND', 'FAILED TO SCAN', 'SUMMARY']);
  expect(readSheetRows(p2x, 'PHASE 2 LOST PACKAGES').length).toBe(4);
  const failed = readSheetRows(p2x, 'FAILED TO SCAN');
  expect(failed.length).toBe(3);
  expect(failed.map((r) => r.join(' ')).join('\n')).toContain('No tracking number');
});

test('Pause / Resume / Stop move only where they may; the warehouse is refused', async ({ request }) => {
  expect(runId).toBeTruthy();
  const act = (action, headers = ph()) => request.post('/api/lost-packages/phase2', { headers, data: { runId, action } });
  expect((await act('pause')).status()).toBe(409);            // done: nothing to pause
  expect((await act('start')).status()).toBe(409);            // already ran
  expect((await (await act('recheck')).json()).status).toBe('running');
  expect((await (await act('pause')).json()).status).toBe('paused');
  expect((await (await act('stop')).json()).status).toBe('stopped');
  expect((await (await act('resume')).json()).status).toBe('running');
  expect((await act('stop', wh())).status()).toBe(403);
  expect((await request.get('/api/lost-packages/runs', { headers: wh() })).status()).toBe(403);
  await act('stop');
  expect((await (await act('delete')).json()).status).toBe('deleted');
});

// QA 2026-11-13: Pause while the LAST order was in flight, then Resume, left the run "Checking…"
// at 100% forever — nothing was left to finish it. The worker now closes an idle running run.
test('Pause while the last order is in flight, then Resume: the run still finishes', async ({ request }) => {
  const make = await request.post('/api/lost-packages/runs', { headers: ph(), data: {
    monthLabel: 'November 2025 E2E', sourceName: 'pause-race.xlsx', sheetsScanned: 1, rowsScanned: 1, rowsSkipped: 0,
    counts: { Lost: 1, Delivered: 0, Cancelled: 0, Refunded: 0 }, orderCount: 1 } });
  const id = (await make.json()).id;
  await request.post('/api/lost-packages/orders', { headers: ph(), data: { runId: id, orders: [
    { key: 'T:794655555555', tracking: '794655555555', order_number: 'E2E-SLOW', courier: 'FedEx', p1_class: 'Lost' }] } });
  const act = (action) => request.post('/api/lost-packages/phase2', { headers: ph(), data: { runId: id, action } });
  const run = async () => (await (await request.get(`/api/lost-packages/orders?run=${id}`, { headers: ph() })).json()).run;
  await act('start');
  await expect.poll(async () => calls.filter((c) => c.body.includes('794655555555')).length).toBeGreaterThan(0);
  expect((await (await act('pause')).json()).status).toBe('paused');            // the order is mid-check
  await expect.poll(async () => Number((await run()).p2_checked), { timeout: 10_000 }).toBe(1);
  expect((await run()).p2_status).toBe('paused');                                 // answered, still paused
  await act('resume');
  await expect.poll(async () => (await run()).p2_status, { timeout: 10_000 }).toBe('done');
  await act('delete');
});

test('Phase 1: "not delivered" is not a delivery; an Order Date column is not the order number (pure)', async () => {
  const { scanSheets } = await import('../src/lib/lostPackage.js');
  const cls = (status) => scanSheets([{ name: 'T', rows: [['Order Number', 'Tracking Number', 'Delivery Status'], ['A1', '111', status]] }]).orders[0].p1_class;
  for (const s of ['NOT delivered', 'not yet delivered', 'never delivered', 'wasn’t delivered', "hasn't been delivered", 'undelivered',
    'not left at door', "wasn't handed to resident"]) expect(cls(s)).toBe('Lost');
  for (const s of ['Delivered', 'delivered - left at door', 'POD received']) expect(cls(s)).toBe('Delivered');
  const r = scanSheets([{ name: 'T', rows: [['Order Date', 'Tracking Number', 'Status'], ['45962', '222', 'in transit']] }]);
  expect(r.orders[0].order_number).toBe('');
  expect(r.orders[0].key).toBe('T:222');
});

test('a tracking number the sheet holds as "4.93235840438E11" goes to FedEx as 493235840438 (pure)', async () => {
  const { scanSheets, excelIdText, cleanTracking, inferCourier } = await import('../src/lib/lostPackage.js');
  for (const [raw, want] of [['4.93235840438E11', '493235840438'], ['3.8363917247E11', '383639172470'], ['4.93235840438E+11', '493235840438'],
    ['493235840438.0', '493235840438'], ['1Z7311EY0392973725', '1Z7311EY0392973725'], ['1.5E0', '1.5E0']]) expect(excelIdText(raw)).toBe(want);
  // the same pair written both ways is ONE order
  const r = scanSheets([{ name: 'T', rows: [['Order Number', 'Tracking Number', 'Status'], ['A1', '4.93235840438E11', 'in transit'], ['A1', '493235840438', '']] }]);
  expect(r.orders.map((o) => o.key)).toEqual(['T:493235840438']);
  // a run saved before the fix still asks FedEx the right number
  expect(cleanTracking('4.93235840438E11')).toBe('493235840438');
  expect(inferCourier(cleanTracking('4.93235840438E11'), '')).toBe('fedex');
});

test('admin home has the card; the warehouse home does not, and the page sends them home', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.goto('/');
  await expect(page.locator('.home-sections .home-card', { hasText: 'Lost Package Tracker Tool' })).toBeVisible();
  await loginAs(page, 'warehouse');
  await page.goto('/');
  await expect(page.locator('.home-sections .home-card', { hasText: 'Lost Package Tracker Tool' })).toHaveCount(0);
  await page.goto('/lost-packages');
  await expect(page.getByRole('heading', { name: 'Phase 1 — scan a month’s workbook' })).toHaveCount(0);
});
