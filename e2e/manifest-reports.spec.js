// Manifest discrepancy reports (docs/context/manifest-reports.md).
//
// The owner's ask: the paper in a parcel says 4 pairs, the box holds 2. The warehouse
// reports it with a photo of the boxes and a photo of the manifest, the PH team is told,
// and it has its own page. What has to hold:
//   · no photos, no report (both kinds are required);
//   · it needs no batch, no order on file: a parcel can be reported before it is received;
//   · it is an inbound-issues case, so PH takes it the usual way, and one parcel is one case;
//   · the page shows the counts, the rows that differ and the two sets of photos.
import { test, expect } from '@playwright/test';
import pg from 'pg';
import { signToken } from '../api/_lib/util.js';
import { loadEnv, loginAs } from './helpers/auth.js';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (t, v) => pool.query(t, v).then((r) => r.rows);
const stamp = `${Date.now()}`.slice(-7);
const STORE = `E2E MR Store ${stamp}`;
const TRACK = `1ZE2EMR${stamp}0001`;
const WH_USER = { uid: 990201, username: 'e2e_mr_wh', name: 'E2E MR Brent', role: 'warehouse' };
const PH_USER = { uid: 990202, username: 'e2e_mr_ph', name: 'E2E MR Ruby', role: 'ph_team' };
const auth = (u) => ({ Authorization: `Bearer ${signToken(u)}` });
const WH = auth(WH_USER); const PH = auth(PH_USER);
const BOX = 'https://example.com/e2e-mr-boxes.jpg';
const SLIP = 'https://example.com/e2e-mr-slip.jpg';
const LABEL = 'https://example.com/e2e-mr-label.jpg';
const report = (request, data, headers = WH) => request.post('/api/inbound-issues/manifest-report', { headers, data });
let caseId;
test.describe.configure({ mode: 'serial' });

test.afterAll(async () => {
  await q(`DELETE FROM inbound_issue_events WHERE issue_id IN (SELECT id FROM inbound_issues WHERE supplier = $1)`, [STORE]);
  await q(`DELETE FROM inbound_issues WHERE supplier = $1`, [STORE]);
  await pool.end();
});

test('a report needs both photos and a real difference, then opens one urgent case', async ({ request }) => {
  test.setTimeout(120_000);   // the first call on a fresh dev server compiles the handlers
  const base = { origin: 'online', tracking: TRACK.replace(/(.{4})/g, '$1 ').toLowerCase(), store: STORE, orderNumber: 'W123456',
    lines: [{ shoe: 'Air Max 90 · DH8010-100', size: '9', listed: 2, got: 1 }, { shoe: 'Air Max 90 · DH8010-100', size: '10', listed: 2, got: 1 }] };

  // The shipping label first: the store asks for it before it looks at a claim (Alex, 2026-11-20).
  let r = await report(request, { ...base, boxPhotos: [BOX], manifestPhotos: [SLIP] });
  expect(r.status()).toBe(400);
  expect((await r.json()).error).toMatch(/photo of the shipping label/i);
  r = await report(request, { ...base, labelPhotos: [LABEL], manifestPhotos: [SLIP] });
  expect(r.status()).toBe(400);
  expect((await r.json()).error).toMatch(/photo of the boxes/i);
  r = await report(request, { ...base, labelPhotos: [LABEL], boxPhotos: [BOX] });
  expect(r.status()).toBe(400);
  expect((await r.json()).error).toMatch(/photo of the manifest/i);
  // Same count on both sides and nothing said about what differs: not a report.
  r = await report(request, { origin: 'online', store: STORE, listed: 3, got: 3, labelPhotos: [LABEL], boxPhotos: [BOX], manifestPhotos: [SLIP] });
  expect(r.status()).toBe(400);
  // A supplier account has no business here.
  r = await report(request, { ...base, labelPhotos: [LABEL], boxPhotos: [BOX], manifestPhotos: [SLIP] }, auth({ uid: 990203, username: 'e2e_mr_sup', name: 'E2E MR Sup', role: 'supplier' }));
  expect(r.status()).toBe(403);

  r = await report(request, { ...base, labelPhotos: [LABEL], boxPhotos: [BOX], manifestPhotos: [SLIP], note: 'box was re-taped' });
  expect(r.ok(), await r.text()).toBeTruthy();
  const { row } = await r.json();
  caseId = row.id;
  expect(row).toMatchObject({ type: 'manifest', scope: 'shipment', status: 'open', source: 'manifest',
    expected_count: 4, received_count: 2, supplier: STORE, tracking_number: TRACK, batch_id: null, reported_by: WH_USER.name });
  expect(row.photos).toEqual([LABEL, BOX, SLIP]);
  expect(row.manifest).toMatchObject({ origin: 'online', store: STORE, orderNumber: 'W123456', boxPhotos: [BOX], manifestPhotos: [SLIP] });
  expect(row.manifest.lines).toHaveLength(2);
  expect(row.description).toContain('lists 4 pairs; 2 in the box (SHORT by 2)');
  expect(row.description).toContain('size 9: manifest 2, in the box 1');

  // The same parcel again (number typed plainly this time) is the same case, not a twin.
  r = await report(request, { origin: 'online', tracking: TRACK, store: STORE, listed: 4, got: 2, labelPhotos: [LABEL], boxPhotos: [BOX], manifestPhotos: [SLIP] });
  expect(r.status()).toBe(409);
  expect((await r.json()).caseId).toBe(caseId);

  // No tracking number and only the two totals is still a report.
  r = await report(request, { origin: 'supplier', store: STORE, listed: 6, got: 5, noLabel: true, boxPhotos: [BOX], manifestPhotos: [SLIP] });
  expect(r.ok(), await r.text()).toBeTruthy();
  expect((await r.json()).row).toMatchObject({ expected_count: 6, received_count: 5, tracking_number: null });
});

test('it is on the page list, and PH takes it like any case', async ({ request }) => {
  let list = await (await request.get('/api/inbound-issues/manifests?view=open', { headers: PH })).json();
  expect(list.canWork).toBe(true);
  expect(list.rows.some((x) => x.id === caseId)).toBe(true);
  expect(list.counts.open).toBeGreaterThanOrEqual(2);
  // The warehouse reads the list but cannot take a case.
  const wh = await (await request.get('/api/inbound-issues/manifests?view=open', { headers: WH })).json();
  expect(wh.canWork).toBe(false);
  expect((await request.post('/api/inbound-issues/action', { headers: WH, data: { id: caseId, action: 'claim' } })).status()).toBe(403);

  const take = await request.post('/api/inbound-issues/action', { headers: PH, data: { id: caseId, action: 'claim' } });
  expect(take.ok(), await take.text()).toBeTruthy();
  list = await (await request.get('/api/inbound-issues/manifests?view=working', { headers: PH })).json();
  expect(list.rows.find((x) => x.id === caseId)).toMatchObject({ status: 'in_progress', owner: PH_USER.name });
  // It is also a normal case on Inbound Issues, with its history.
  const one = await (await request.get(`/api/inbound-issues/get?id=${caseId}`, { headers: PH })).json();
  expect(one.row.events.map((e) => e.action)).toEqual(expect.arrayContaining(['reported']));
  // The untaken one counts on the home badge.
  const counts = await (await request.get('/api/items/pending-counts', { headers: PH })).json();
  expect((counts.counts || counts).manifest_reports_new).toBeGreaterThanOrEqual(1);
});

test('the page shows the report, and the form says what is missing', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.goto(`/manifest-reports?id=${caseId}`);
  const card = page.locator(`#report-${caseId}`);
  await expect(card).toContainText('SHORT by 2');
  await expect(card).toContainText(STORE);
  await expect(card).toContainText('W123456');
  await expect(card.locator('.mr-lines tbody tr')).toHaveCount(2);
  await expect(card.getByRole('button', { name: 'Open the photo: The boxes' })).toHaveCount(1);
  await expect(card.getByRole('button', { name: 'Open the photo: The manifest' })).toHaveCount(1);
  await expect(card.getByRole('button', { name: /Take it/ })).toHaveCount(0);   // the warehouse reports, PH takes

  await page.getByRole('button', { name: '+ Report a discrepancy' }).click();
  const form = page.getByRole('dialog', { name: 'Report a manifest discrepancy' });
  await form.getByRole('button', { name: 'Send to the PH team' }).click();
  await expect(form.locator('.error')).toContainText('Which store');
  await form.getByPlaceholder(/Foot Locker/).fill(STORE);
  await form.getByLabel('Pairs the manifest lists').fill('4');
  await form.getByLabel('Pairs in the box').fill('2');
  await expect(form.locator('.mr-gap')).toHaveText('SHORT by 2');
  await form.getByRole('button', { name: 'Send to the PH team' }).click();
  await expect(form.locator('.error')).toContainText('photo of the shipping label');
  // The carton is gone: said out loud, and the next thing asked for is the boxes.
  await form.getByLabel(/carton is already thrown away/).check();
  await form.getByRole('button', { name: 'Send to the PH team' }).click();
  await expect(form.locator('.error')).toContainText('photo of the boxes');
  // The open form survives a refresh (it is in the URL).
  expect(page.url()).toContain('new=1');
});

test('the PH team has its own copy of the page', async ({ page }) => {
  await loginAs(page, 'ph_team');
  await page.goto('/ph/manifest-reports?view=working');
  await expect(page.locator(`#report-${caseId}`)).toContainText('SHORT by 2');
});
