// Drop-off receipts on a purchase order, and the alert that asks for them.
import { test, expect } from '@playwright/test';
import pg from 'pg';
import { signToken } from '../api/_lib/util.js';
import { loginAs, loadEnv } from './helpers/auth.js';

loadEnv?.();
const STAMP = `${Date.now()}`.slice(-6);
const SUPPLIER = `E2E Dropoff Supplier ${STAMP}`;
const auth = (role, uid) => ({ Authorization: `Bearer ${signToken({ uid: uid ?? `e2e-${role}`, username: `e2e_${role}`, name: `E2E ${role}`, role })}` });
let pool;
const made = { pos: [], users: [] };
let owner; let other;

async function order({ status = 'draft', boxStatus = 'shipped', alerted = false } = {}) {
  const po = (await pool.query(
    `INSERT INTO purchase_orders (po_code, supplier_name, supplier_user_id, status, expected_boxes, manifest_scope)
     VALUES ($1, $2, $3, $4, 1, 'box') RETURNING id, po_code`, [`PO-DRP-${STAMP}-${made.pos.length}`, SUPPLIER, owner, status])).rows[0];
  made.pos.push(Number(po.id));
  const trk = `DRP${STAMP}${made.pos.length}`;
  const box = (await pool.query(
    `INSERT INTO po_boxes (po_id, box_number, tracking_number, status, dropoff_alerted_at) VALUES ($1, 1, $2, $3, $4) RETURNING id`,
    [po.id, trk, boxStatus, alerted ? new Date() : null])).rows[0];
  return { poId: Number(po.id), code: po.po_code, boxId: Number(box.id), trk };
}
const receipt = (poId, role = 'supplier', uid = owner, name = 'dropoff.jpg') => pool.query(
  `INSERT INTO po_dropoff_receipts (po_id, r2_key, name, content_type, uploaded_by, uploaded_by_id, uploaded_role)
   VALUES ($1, $2, $3, 'image/jpeg', 'E2E', $4, $5) RETURNING id`, [poId, `po-dropoff/x/${Date.now()}.jpg`, name, uid, role]);

test.beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  for (const [i, u] of [`e2e_drp_a_${STAMP}`, `e2e_drp_b_${STAMP}`].entries()) {
    const id = Number((await pool.query(
      `INSERT INTO users (name, username, pass_hash, role, status) VALUES ($1, $2, 'x', 'supplier', 'approved') RETURNING id`, [u, u])).rows[0].id);
    made.users.push(id);
    if (i === 0) owner = id; else other = id;
  }
});
test.afterAll(async () => {
  await pool.query('DELETE FROM po_boxes WHERE po_id = ANY($1)', [made.pos]);
  await pool.query('DELETE FROM purchase_orders WHERE id = ANY($1)', [made.pos]);
  await pool.query('DELETE FROM users WHERE id = ANY($1)', [made.users]);
  await pool.end();
});

test('a box is announced once, whichever gets there first, and only once it has really left', async () => {
  const { claimDropoffAlerts } = await import('../api/_lib/db.js');
  const a = await order();
  const viaTap = await claimDropoffAlerts({ boxIds: [a.boxId] });
  expect(viaTap.map((r) => Number(r.id))).toEqual([a.boxId]);
  expect(viaTap[0]).toMatchObject({ po_code: a.code, supplier_name: SUPPLIER, tracking_number: a.trk });
  // The carrier's scan arriving afterwards says nothing new, spelled with spaces or not.
  expect(await claimDropoffAlerts({ trackingNumbers: [`${a.trk.slice(0, 3)} ${a.trk.slice(3)}`] })).toEqual([]);

  const b = await order();
  expect((await claimDropoffAlerts({ trackingNumbers: [b.trk.toLowerCase()] })).map((r) => Number(r.id))).toEqual([b.boxId]);

  // A label the carrier only knows as paperwork hasn't been dropped off.
  const c = await order({ boxStatus: 'pre_transit' });
  expect(await claimDropoffAlerts({ boxIds: [c.boxId], trackingNumbers: [c.trk] })).toEqual([]);
  // Nothing asked for, nothing claimed.
  expect(await claimDropoffAlerts({})).toEqual([]);
});

test('the message asks for the receipt, or says it is in', async () => {
  const { dropoffBody } = await import('../api/_lib/alerts.js');
  const none = dropoffBody({ supplier: 'Andrew', boxes: [{ tracking_number: '1Z1' }, { tracking_number: '1Z2' }], receipts: 0 });
  expect(none).toContain('Andrew dropped off 2 boxes, tracking 1Z1, 1Z2.');
  expect(none).toContain('No drop-off receipt yet. Ask them for it, or upload it on the order.');
  expect(dropoffBody({ supplier: 'Andrew', boxes: [{ tracking_number: '1Z1' }], receipts: 1 })).toContain('1 box');
  expect(dropoffBody({ supplier: 'Andrew', boxes: [{}], receipts: 1 })).toContain('Drop-off receipt on file (1).');
});

test('a receipt has to be a photo or a PDF, judged by its bytes', async () => {
  const { dropoffFileProblem: bad } = await import('../api/po/dropoff.js');
  const pad = Buffer.alloc(32);
  expect(bad(Buffer.concat([Buffer.from('%PDF-1.7'), pad]))).toBeNull();
  expect(bad(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), pad]))).toBeNull();
  expect(bad(Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic0000heicmif1'), pad]))).toMatch(/HEIC/);
  expect(bad(Buffer.from('not a receipt, just some words in a file'))).toMatch(/isn’t a photo or a PDF/);
  expect(bad(Buffer.alloc(0))).toMatch(/isn’t a photo or a PDF/);
});

test('who may do what: the supplier their own order, PH any; removing their own only', async ({ request }) => {
  const { poId } = await order({ alerted: true });
  const theirs = Number((await receipt(poId)).rows[0].id);
  const ours = Number((await receipt(poId, 'ph_team', null, 'ours.jpg')).rows[0].id);
  const del = (who, uid, id, p = poId) => request.post('/api/po/dropoff', { headers: auth(who, uid), data: { poId: p, action: 'delete', id } });

  // Another supplier reaches nothing on it.
  expect((await request.post('/api/po/dropoff', { headers: auth('supplier', other), data: { poId, action: 'sign', contentType: 'image/jpeg' } })).status()).toBe(403);
  expect((await request.get(`/api/po/dropoff?id=${theirs}`, { headers: auth('supplier', other) })).status()).toBe(403);
  expect((await del('supplier', other, theirs)).status()).toBe(403);
  // The warehouse has no part in it.
  expect((await del('warehouse', undefined, theirs)).status()).toBe(403);
  // The owner can't remove what our team uploaded, but can remove their own.
  expect((await del('supplier', owner, ours)).status()).toBe(403);
  expect((await del('supplier', owner, theirs)).status()).toBe(200);
  // PH can remove anybody's, and a receipt on another order is not found.
  expect((await del('ph_team', undefined, ours, made.pos[0])).status()).toBe(404);
  const r = await del('ph_team', undefined, ours);
  expect(r.status()).toBe(200);
  expect((await r.json()).dropoffReceipts).toEqual([]);
});

test('the supplier sees their order’s receipts, with our staff unnamed', async ({ request }) => {
  const { poId } = await order({ alerted: true });
  await receipt(poId);
  await pool.query(`INSERT INTO po_dropoff_receipts (po_id, r2_key, name, content_type, uploaded_by, uploaded_role) VALUES ($1, 'k', 'ph.jpg', 'image/jpeg', 'Nikki PH', 'ph_team')`, [poId]);
  const as = async (who, uid) => (await request.get(`/api/po/get?id=${poId}`, { headers: auth(who, uid) })).json();
  const theirs = await as('supplier', owner);
  expect(theirs.dropoffReceipts.map((r) => r.uploaded_by)).toEqual(['E2E', 'Our team']);
  expect(JSON.stringify(theirs)).not.toContain('Nikki PH');
  expect((await as('ph_team')).dropoffReceipts.map((r) => r.uploaded_by)).toEqual(['E2E', 'Nikki PH']);
});

test('uploading really works, end to end', async ({ request }) => {
  test.skip(!process.env.R2_ACCOUNT_ID, 'needs real storage');
  const sharp = (await import('sharp')).default;
  const jpeg = await sharp({ create: { width: 40, height: 40, channels: 3, background: '#fff' } }).jpeg().toBuffer();
  const { poId } = await order({ alerted: true });
  const post = (data) => request.post('/api/po/dropoff', { headers: auth('supplier', owner), data: { poId, ...data } });
  const signed = await (await post({ action: 'sign', contentType: 'image/jpeg' })).json();
  expect((await fetch(signed.uploadUrl, { method: 'PUT', body: jpeg })).ok).toBe(true);
  // Only a key this server minted, for this order.
  expect((await post({ action: 'attach', key: 'po-labels/other.pdf', contentType: 'image/jpeg' })).status()).toBe(400);
  const att = await post({ action: 'attach', key: signed.key, name: 'r.jpg', contentType: 'image/jpeg', sizeBytes: jpeg.length });
  expect(att.status()).toBe(200);
  const { receipt: r } = await att.json();
  const file = await request.get(`/api/po/dropoff?id=${r.id}`, { headers: auth('supplier', owner) });
  expect(file.status()).toBe(200);
  expect(file.headers()['content-type']).toContain('image/jpeg');
  expect(file.headers()['cache-control']).toContain('no-store');
  expect((await post({ action: 'delete', id: Number(r.id) })).status()).toBe(200);
  // A file that isn't one is refused, and doesn't stay.
  const s2 = await (await post({ action: 'sign', contentType: 'application/pdf' })).json();
  await fetch(s2.uploadUrl, { method: 'PUT', body: Buffer.from('nonsense that is not a pdf at all') });
  const refused = await post({ action: 'attach', key: s2.key, name: 'x.pdf', contentType: 'application/pdf' });
  expect(refused.status()).toBe(400);
});

test('on screen: PH sees it missing and can ask; a receipt clears the chip', async ({ page }) => {
  const a = await order({ status: 'shipped', alerted: true });
  let asked = null;
  await page.route('**/api/nudge', async (route) => { asked = route.request().postDataJSON(); return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, sentTo: ['Andrew'] }) }); });
  await loginAs(page, 'ph_team');
  await page.goto(`/ph/po-status?q=${encodeURIComponent(a.code)}`);
  const row = page.getByText(a.code).first();
  await expect(row).toBeVisible();
  await expect(page.locator('.po-chip.dropoff-missing').first()).toHaveText('No drop-off receipt');
  await page.goto(`/ph/po-status?po=${a.poId}`);
  const panel = page.locator('.po-dropoff');
  await expect(panel).toContainText('Not in yet');
  await panel.getByRole('button', { name: 'Ask supplier' }).click();
  await expect(panel).toContainText('Asked Andrew on Telegram.');
  expect(asked).toMatchObject({ kind: 'po', to: 'supplier' });
  expect(Number(asked.id)).toBe(a.poId);
  expect(asked.note).toContain(a.code);

  await receipt(a.poId);
  await page.reload();
  await expect(panel).toContainText('dropoff.jpg');
  await expect(panel.getByRole('button', { name: 'Ask supplier' })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Add another' })).toBeVisible();
  await page.goto(`/ph/po-status?q=${encodeURIComponent(a.code)}`);
  await expect(page.getByText(a.code).first()).toBeVisible();
  await expect(page.locator('.po-chip.dropoff-missing')).toHaveCount(0);
});

test('on screen: the supplier is asked to upload it, and can take theirs back but not ours', async ({ page }) => {
  const a = await order({ status: 'shipped', alerted: true });
  const token = signToken({ uid: owner, username: `e2e_drp_a_${STAMP}`, name: 'E2E Drop', role: 'supplier' });
  await page.addInitScript(([t, u]) => {
    sessionStorage.setItem('sb_session_token', t);
    sessionStorage.setItem('sb_user', u);
  }, [token, JSON.stringify({ username: `e2e_drp_a_${STAMP}`, name: 'E2E Drop', role: 'supplier' })]);
  await page.goto('/orders');
  await expect(page.locator('.po-card', { hasText: a.code }).locator('.po-chip.dropoff-missing')).toHaveText('Upload drop-off receipt');
  await page.locator('.po-card', { hasText: a.code }).click();
  const panel = page.locator('.po-dropoff');
  await expect(panel).toContainText('Please upload it');
  await expect(panel.getByRole('button', { name: 'Upload receipt' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Ask supplier' })).toHaveCount(0);

  // Appears by itself, with no refresh: the team uploading it for them while they look.
  await receipt(a.poId, 'supplier', owner, 'mine.jpg');
  await receipt(a.poId, 'ph_team', null, 'ours.jpg');
  await expect(panel.locator('li', { hasText: 'mine.jpg' }).getByRole('button', { name: 'Remove' })).toBeVisible();
  await expect(panel.locator('li', { hasText: 'ours.jpg' })).toContainText('Our team');
  await expect(panel.locator('li', { hasText: 'ours.jpg' }).getByRole('button', { name: 'Remove' })).toHaveCount(0);
});

test('the Telegram link lands an admin on the order, with its receipt panel', async ({ page }) => {
  const a = await order({ status: 'shipped', alerted: true });
  await loginAs(page, 'admin');
  await page.goto(`/reconcile?po=${a.poId}`);
  await expect(page.locator('.po-dropoff')).toContainText('Not in yet');
});

test('the warehouse’s view of the same order carries no panel', async ({ page }) => {
  const a = await order({ status: 'shipped', alerted: true });
  await loginAs(page, 'warehouse');
  await page.goto(`/reconcile?po=${a.poId}`);
  await expect(page.locator('.rcn-actions')).toBeVisible();
  await expect(page.locator('.po-dropoff')).toHaveCount(0);
});

test('the team hears on Telegram, one message an order, and it says the receipt is missing or in', async () => {
  const http = await import('node:http');
  const calls = [];
  const fake = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const method = req.url.split('/').pop();
      calls.push({ method, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(method === 'getMe' ? { ok: true, result: { id: 1, username: 'e2e_bot' } } : { ok: true, result: { message_id: calls.length } }));
    });
  });
  await new Promise((r) => fake.listen(5198, '127.0.0.1', r));
  const keep = {};
  for (const k of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'TELEGRAM_API_BASE', 'ALERT_BATCH_MS']) keep[k] = process.env[k];
  Object.assign(process.env, { TELEGRAM_BOT_TOKEN: 'e2e', TELEGRAM_CHAT_ID: '-1', TELEGRAM_API_BASE: 'http://127.0.0.1:5198', ALERT_BATCH_MS: '50' });
  const chat = 8800000 + Number(STAMP);
  const wh = chat + 1;
  const ph = Number((await pool.query(
    `INSERT INTO users (name, username, pass_hash, role, status, telegram_user_id) VALUES ('E2E Drop PH', $1, 'x', 'ph_team', 'approved', $2) RETURNING id`, [`e2e_drp_ph_${STAMP}`, chat])).rows[0].id);
  const whId = Number((await pool.query(
    `INSERT INTO users (name, username, pass_hash, role, status, telegram_user_id) VALUES ('E2E Drop WH', $1, 'x', 'warehouse', 'approved', $2) RETURNING id`, [`e2e_drp_wh_${STAMP}`, wh])).rows[0].id);
  made.users.push(ph, whId);
  try {
    const { alertPoDroppedOff, alertDropoffReceiptUploaded } = await import('../api/_lib/alerts.js');
    const a = await order();
    alertPoDroppedOff([
      { id: a.boxId, po_id: a.poId, po_code: a.code, supplier_name: SUPPLIER, tracking_number: a.trk },
      { id: a.boxId + 1000000, po_id: a.poId, po_code: a.code, supplier_name: SUPPLIER, tracking_number: 'SECOND' },
    ]);
    const toPh = () => calls.filter((c) => c.method === 'sendMessage' && String(c.body.chat_id) === String(chat));
    await expect.poll(() => toPh().length, { timeout: 8000 }).toBe(1);
    const msg = toPh()[0].body;
    expect(msg.text).toContain('Dropped off: ask for the receipt');
    expect(msg.text).toContain(`${SUPPLIER} dropped off 2 boxes`);
    expect(msg.text).toContain('No drop-off receipt yet');
    expect(JSON.stringify(msg.reply_markup)).toContain(`/ph/po-status?po=${a.poId}`);
    // Warehouse has its own "Boxes shipped" alert, and isn't asked to chase paperwork.
    expect(calls.some((c) => String(c.body.chat_id) === String(wh))).toBe(false);

    alertDropoffReceiptUploaded({ id: a.poId, po_code: a.code, supplier_name: SUPPLIER }, { uid: owner });
    await expect.poll(() => toPh().length, { timeout: 8000 }).toBe(2);
    expect(toPh()[1].body.text).toContain('uploaded a drop-off receipt');
  } finally {
    for (const [k, v] of Object.entries(keep)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await pool.query('DELETE FROM alert_log WHERE user_id = ANY($1)', [[ph, whId]]);
    await new Promise((r) => fake.close(r));
  }
});

