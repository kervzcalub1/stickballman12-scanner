// Email receipts (docs/context/receipts.md). The Make "Receipt sweep" files every store
// receipt it finds in our order mailboxes at /api/receipts/ingest; a receipt sent to an
// address a buyer registered is filed under them. What this pins:
//   · the key is required, and a re-sent email (the sweep overlaps) is one row, not two;
//   · the buyer is matched by ANY recipient address (to, cc, the original recipient of a
//     forward), case-insensitively — and an address registered LATER claims the
//     receipts that already arrived to it, without overwriting a person's assignment;
//   · one address belongs to one person;
//   · a receipt whose order number is on a buying request links to it;
//   · a supplier adds their purchase email on their Buying Requests page;
//   · the Receipts page filters by buyer / state and an admin can assign the buyer.
import { test, expect } from '@playwright/test';
import pg from 'pg';
import { signToken, hashPassword } from '../api/_lib/util.js';
import { loadEnv, loginAs } from './helpers/auth.js';

loadEnv();
test.describe.configure({ mode: 'serial' });
const KEY = process.env.RECEIPT_INGEST_KEY;
const stamp = `${Date.now()}`.slice(-8);
const JOEY = `joey.e2e.${stamp}@example.com`;
const LATE = `late.e2e.${stamp}@example.com`;
const ORDER = `E2E${stamp}`;
const tok = (u) => ({ Authorization: `Bearer ${signToken({ uid: u.uid, username: u.username, name: u.name, role: u.role, privileges: u.privileges })}` });
const ADMIN = { Authorization: `Bearer ${signToken({ uid: 'admin', username: 'admin', name: 'Alex', role: 'admin' })}` };
let db; const people = {}; let cartId;

const receipt = (n, over = {}) => ({
  message_key: `gmail:e2e:${stamp}:${n}`, mailbox: 'gmail:orderemail', folder: n === 2 ? '[Gmail]/Spam' : 'INBOX',
  received_at: '2026-10-06T14:05:00-04:00', from: 'Foot Locker <orders@em.footlocker.com>',
  subject: `Your Foot Locker receipt ${n}`, store: 'footlocker',
  recipients: { to: [], cc: [], delivered_to: 'orderemail@stickballman12llc.com', original_to: null },
  store_location: { name: 'Foot Locker Garden State Plaza', store_number: '07123', address: '1 Garden State Plaza', city: 'Paramus', state: 'nj', zip: '07652' },
  order_number: null,
  totals: { subtotal: 200, tax: 0, shipping: null, total: 200 },
  items: [{ name: 'NIKE DUNK LO RTR', style_id: 'DD1391-100', size: '10', qty: 2, final_price: 200 }],
  text: 'FOOT LOCKER #07123 PARAMUS NJ ...', warnings: [], ...over,
});
const ingest = (request, body, key = KEY) => request.post('/api/receipts/ingest', { headers: key ? { 'x-api-key': key } : {}, data: body });

test.beforeAll(async () => {
  db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  for (const [k, u] of Object.entries({
    joey: { username: `e2e_rc_joey_${stamp}`, name: `E2E Joey ${stamp}`, role: 'supplier', privileges: ['request_buying'] },
    council: { username: `e2e_rc_council_${stamp}`, name: `E2E Council ${stamp}`, role: 'supplier', privileges: ['request_buying'] },
  })) {
    const { rows } = await db.query(`INSERT INTO users (name, username, pass_hash, role, status, privileges) VALUES ($1,$2,$3,$4,'approved',$5) RETURNING id`,
      [u.name, u.username, hashPassword('e2e-not-used'), u.role, u.privileges]);
    people[k] = { ...u, uid: Number(rows[0].id) };
  }
  cartId = Number((await db.query(`INSERT INTO buy_carts (buyer_user_id, buyer_name, retailer, purpose, status) VALUES ($1,$2,'Foot Locker','e2e','funded') RETURNING id`,
    [people.joey.uid, people.joey.name])).rows[0].id);
  await db.query(`INSERT INTO buy_cart_files (cart_id, kind, r2_key, name) VALUES ($1,'receipt','e2e/none',$2)`, [cartId, `Email receipt ${ORDER}.txt`]);
});

test.afterAll(async () => {
  await db.query(`DELETE FROM email_receipts WHERE message_key LIKE $1`, [`gmail:e2e:${stamp}:%`]);
  await db.query(`DELETE FROM buy_carts WHERE id = $1`, [cartId]);
  await db.query(`DELETE FROM users WHERE id = ANY($1)`, [Object.values(people).map((p) => p.uid)]);
  await db.end();
});

test('ingest: the key is required, a re-sent email is one row, and the buyer is matched by recipient', async ({ request }) => {
  expect(KEY, 'RECEIPT_INGEST_KEY is set by playwright.config.js').toBeTruthy();
  expect((await ingest(request, receipt(1), null)).status()).toBe(401);
  expect((await ingest(request, receipt(1), 'wrong')).status()).toBe(401);
  expect((await ingest(request, { ...receipt(1), message_key: '' })).status()).toBe(400);

  // Joey registers the address he buys with (as himself).
  const add = await request.post('/api/purchase-emails', { headers: tok(people.joey), data: { action: 'add', email: JOEY.toUpperCase() } });
  expect(add.ok(), await add.text()).toBeTruthy();
  // One address, one person: Council can't take it.
  expect((await request.post('/api/purchase-emails', { headers: tok(people.council), data: { action: 'add', email: JOEY } })).status()).toBe(409);

  // A receipt FORWARDED into our mailbox: Joey is the original recipient. It carries the
  // order number that is on Joey's buying request.
  const r1 = await (await ingest(request, receipt(1, { order_number: ORDER, recipients: { to: ['orderemail@stickballman12llc.com'], cc: [], delivered_to: null, original_to: `Joey <${JOEY}>` } }))).json();
  expect(r1).toMatchObject({ ok: true, duplicate: false, buyerMatched: true });
  const again = await (await ingest(request, receipt(1))).json();
  expect(again).toMatchObject({ ok: true, duplicate: true, id: r1.id });

  // Found in spam, sent to an address nobody has registered yet.
  const r2 = await (await ingest(request, receipt(2, { recipients: { to: [LATE], cc: [], delivered_to: null, original_to: null }, store_location: { city: 'Atlanta', state: 'GA', zip: '30303' } }))).json();
  expect(r2.buyerMatched).toBe(false);
  // Another to that address — an admin assigns it to Joey by hand before anyone registers it.
  const r3 = await (await ingest(request, receipt(3, { recipients: { to: [LATE], cc: [], delivered_to: null, original_to: null } }))).json();
  expect((await request.post('/api/receipts/assign', { headers: ADMIN, data: { id: r3.id, userId: people.joey.uid } })).ok()).toBeTruthy();

  // Council registers it: the unassigned one becomes theirs, the hand-assigned one stays Joey's.
  const late = await (await request.post('/api/purchase-emails', { headers: tok(people.council), data: { action: 'add', email: LATE } })).json();
  expect(late).toMatchObject({ ok: true, claimed: 1 });
  const row = async (id) => (await db.query('SELECT buyer_user_id, buyer_source, state, recipient_addrs FROM email_receipts WHERE id = $1', [id])).rows[0];
  expect(await row(r1.id)).toMatchObject({ buyer_user_id: String(people.joey.uid), buyer_source: 'email', state: 'NJ' });
  expect(await row(r2.id)).toMatchObject({ buyer_user_id: String(people.council.uid), buyer_source: 'email' });
  expect(await row(r3.id)).toMatchObject({ buyer_user_id: String(people.joey.uid), buyer_source: 'manual' });
  expect((await row(r1.id)).recipient_addrs).toContain(JOEY);   // lower-cased

  // Suppliers don't browse the mailbox.
  expect((await request.get('/api/receipts/list', { headers: tok(people.joey) })).status()).toBe(403);
  // Staff see it, linked to the buying request by order number.
  const list = await (await request.get(`/api/receipts/list?q=${ORDER}`, { headers: ADMIN })).json();
  expect(list.rows).toHaveLength(1);
  expect(list.rows[0]).toMatchObject({ cart_id: String(cartId), pairs: 2, buyer_name: people.joey.name });
});

test('the Receipts page filters by buyer and state, and an admin can reassign', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.goto(`/receipts?q=${encodeURIComponent('Your Foot Locker receipt')}`);
  await page.getByRole('button', { name: new RegExp(`E2E Council ${stamp}`) }).click();
  const rows = page.locator('.rc-table tbody tr');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Atlanta, GA 30303');
  await expect(rows.first().locator('.rc-spam')).toBeVisible();
  await rows.first().click();
  const dlg = page.getByRole('dialog');
  await expect(dlg).toContainText('matched by email');
  await dlg.getByLabel('Buyer').selectOption({ label: `E2E Joey ${stamp}` });
  await expect(dlg).toContainText('set by');
});

test('a supplier adds the email they buy with on their Buying Requests page', async ({ page }) => {
  const u = people.council;
  await page.addInitScript(([token, user]) => {
    sessionStorage.setItem('sb_session_token', token);
    sessionStorage.setItem('sb_user', JSON.stringify(user));
  }, [tok(u).Authorization.slice(7), { uid: u.uid, username: u.username, name: u.name, role: u.role, privileges: u.privileges }]);
  await page.goto('/buying');
  const card = page.getByRole('region', { name: 'Purchase emails' });
  await expect(card).toContainText(LATE);
  await card.getByLabel('Email address').fill(`second.${stamp}@example.com`);
  await card.getByRole('button', { name: 'Add' }).click();
  await expect(card).toContainText(`second.${stamp}@example.com`);
  await db.query('DELETE FROM user_purchase_emails WHERE user_id = $1', [u.uid]);
});
