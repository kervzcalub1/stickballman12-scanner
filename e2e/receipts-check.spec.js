// "Check mailboxes" (docs/context/receipts.md): the receipt sweep runs ONLY when someone
// presses the button. Make fetches the mail since the last check and posts each raw email
// to /api/receipts/ingest-raw, where OUR server parses and files it. What this pins:
//   · the button starts Make with the time to look back to, and the ingest key, and a
//     double-tap doesn't start a second run;
//   · "From a date…" looks back to midnight EST of that day;
//   · a raw receipt email is parsed and filed (order number, totals, buyer by recipient),
//     a re-sent one is the same row, and marketing mail is skipped.
// Make is a fake on 127.0.0.1:5197 (playwright.config.js) — the real scenario never runs.
import { test, expect } from '@playwright/test';
import http from 'node:http';
import pg from 'pg';
import { signToken } from '../api/_lib/util.js';
import { loadEnv, loginAs } from './helpers/auth.js';

loadEnv();
test.describe.configure({ mode: 'serial' });
const KEY = process.env.RECEIPT_INGEST_KEY;
const stamp = `${Date.now()}`.slice(-8);
const ORDER = `T0900${stamp}`;
const BUYER_EMAIL = `rc.check.${stamp}@example.com`;
const WH = { Authorization: `Bearer ${signToken({ uid: 'rcc-wh', username: 'rcc_wh', name: 'RCC Warehouse', role: 'warehouse' })}` };
const SUP = { Authorization: `Bearer ${signToken({ uid: 'rcc-sup', username: 'rcc_sup', name: 'RCC Supplier', role: 'supplier' })}` };

let db; let fake; const hits = []; let buyerId;
const raw = (request, form, key = KEY) => request.post('/api/receipts/ingest-raw', { headers: key ? { 'x-api-key': key } : {}, form });
const nikeEmail = (over = {}) => ({
  mailbox: 'orderemail@stickballman12llc.com', folder: '[Gmail]/All Mail',
  from: 'nike@official.nike.com', subject: 'Your Nike receipt', date: '2026-10-08T15:12:00-04:00',
  to: `Buyer <${BUYER_EMAIL.toUpperCase()}>`, cc: '', delivered_to: 'orderemail@stickballman12llc.com', original_to: '',
  message_id: `<e2e-rcc-${stamp}@nike.com>`,
  html: '',
  text: [
    'THANK YOU FOR SHOPPING AT NIKE', 'Nike Factory Store - The Quarry', '', `Order # ${ORDER}`, '',
    'Subtotal $120.00', 'Tax $7.20', 'Total $127.20',
  ].join('\n'),
  ...over,
});

test.beforeAll(async () => {
  db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  await db.query(`DELETE FROM app_settings WHERE key = 'receipt_sweep_last'`);
  buyerId = Number((await db.query(`INSERT INTO users (name, username, pass_hash, role, status, privileges)
    VALUES ($1, $2, 'x', 'supplier', 'approved', ARRAY['request_buying']) RETURNING id`, [`E2E RCC ${stamp}`, `e2e_rcc_${stamp}`])).rows[0].id);
  await db.query(`INSERT INTO user_purchase_emails (user_id, email) VALUES ($1, $2)`, [buyerId, BUYER_EMAIL]);
  fake = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => { hits.push(Object.fromEntries(new URLSearchParams(b))); res.end('Accepted'); });
  });
  await new Promise((r) => fake.listen(5197, '127.0.0.1', r));
});

test.afterAll(async () => {
  fake?.close();
  if (!db) return;
  await db.query(`DELETE FROM email_receipts WHERE order_number = $1 OR message_key LIKE $2`, [ORDER, `%e2e-rcc-${stamp}%`]);
  await db.query(`DELETE FROM user_purchase_emails WHERE user_id = $1`, [buyerId]);
  await db.query(`DELETE FROM users WHERE id = $1`, [buyerId]);
  await db.query(`DELETE FROM app_settings WHERE key IN ('receipt_sweep_last', 'receipt_ingest_rejected')`);
  await db.end();
});

test('a raw receipt email is parsed and filed here, under the buyer it was sent to', async ({ request }) => {
  expect((await raw(request, nikeEmail(), null)).status()).toBe(401);
  expect((await raw(request, nikeEmail(), 'wrong')).status()).toBe(401);
  // A bounce is kept (length only, never the key) — Make's history wouldn't show it.
  await expect.poll(async () => JSON.parse((await db.query(`SELECT value FROM app_settings WHERE key = 'receipt_ingest_rejected'`)).rows[0]?.value || 'null')?.key_length).toBe(5);

  const first = await (await raw(request, nikeEmail())).json();
  expect(first).toMatchObject({ ok: true, duplicate: false, buyerMatched: true });
  const again = await (await raw(request, nikeEmail())).json();   // the next check overlaps
  expect(again).toMatchObject({ ok: true, id: first.id, duplicate: true });

  const { rows } = await db.query(`SELECT store, order_number, total, buyer_user_id, folder FROM email_receipts WHERE id = $1`, [first.id]);
  expect(rows[0]).toMatchObject({ store: 'nike', order_number: ORDER, buyer_user_id: String(buyerId), folder: '[Gmail]/All Mail' });
  expect(Number(rows[0].total)).toBe(127.2);

  const promo = await (await raw(request, nikeEmail({ subject: 'Just In: new arrivals', text: 'Shop the latest drops now.', message_id: `<e2e-rcc-promo-${stamp}@nike.com>` }))).json();
  expect(promo).toMatchObject({ ok: true, skipped: 'not_a_receipt' });
});

test('Check mailboxes starts Make from the last check, and a double-tap does not start two', async ({ request }) => {
  expect((await request.post('/api/receipts/sweep', { headers: SUP, data: {} })).status()).toBe(403);
  const st = await (await request.get('/api/receipts/sweep', { headers: WH })).json();
  expect(st).toMatchObject({ ok: true, configured: true, last: null });

  const before = Date.now();
  const r = await request.post('/api/receipts/sweep', { headers: WH, data: {} });
  expect(r.ok(), await r.text()).toBeTruthy();
  const out = await r.json();
  // Never checked → the last 3 days.
  expect(before - Date.parse(out.since)).toBeGreaterThan(3 * 86_400_000 - 60_000);
  expect(hits).toHaveLength(1);
  expect(hits[0]).toMatchObject({ key: KEY, by: 'RCC Warehouse', since_iso: out.since });
  expect(Number(hits[0].since_epoch)).toBe(Math.floor(Date.parse(out.since) / 1000));

  const twice = await request.post('/api/receipts/sweep', { headers: WH, data: {} });
  expect(twice.status()).toBe(409);
  expect(hits).toHaveLength(1);

  const last = (await (await request.get('/api/receipts/sweep', { headers: WH })).json()).last;
  expect(last).toMatchObject({ by: 'RCC Warehouse', since: out.since });
});

test('the next check looks back to the last one (minus an hour); a date looks back to that midnight EST', async ({ request }) => {
  const prev = Date.parse((await (await request.get('/api/receipts/sweep', { headers: WH })).json()).last.at);
  await db.query(`UPDATE app_settings SET value = jsonb_set(value::jsonb, '{at}', to_jsonb($1::text))::text WHERE key = 'receipt_sweep_last'`,
    [new Date(prev - 5 * 60_000).toISOString()]);   // past the double-tap guard
  const next = await (await request.post('/api/receipts/sweep', { headers: WH, data: {} })).json();
  expect(Date.parse(next.since)).toBe(prev - 5 * 60_000 - 60 * 60_000);

  await db.query(`UPDATE app_settings SET value = jsonb_set(value::jsonb, '{at}', to_jsonb($1::text))::text WHERE key = 'receipt_sweep_last'`,
    [new Date(Date.now() - 5 * 60_000).toISOString()]);
  const dated = await (await request.post('/api/receipts/sweep', { headers: WH, data: { since: '2026-10-06' } })).json();
  expect(dated.since).toBe('2026-10-06T04:00:00.000Z');   // midnight EDT
  expect((await request.post('/api/receipts/sweep', { headers: WH, data: { since: '2099-01-01' } })).status()).toBe(400);
});

test('a folder the last run cut off (Make caps each search, oldest first) makes the next check start from the newest email it reached', async ({ request }) => {
  const MB = `rcc-${stamp}@example.com`;
  const runAt = new Date(Date.now() - 5 * 60_000).toISOString();   // past the double-tap guard
  await db.query(`UPDATE app_settings SET value = jsonb_set(value::jsonb, '{at}', to_jsonb($1::text))::text WHERE key = 'receipt_sweep_last'`, [runAt]);

  // ingest-raw counts every email it's handed against the current run, receipt or not.
  for (const n of [1, 2]) {
    await raw(request, nikeEmail({ mailbox: MB, subject: 'Just In', text: 'Shop now.', date: `2026-10-0${n}T12:00:00Z`, message_id: `<e2e-rcc-cap-${n}-${stamp}@x>` }));
  }
  // Counted after the answer goes out, so wait for it.
  await expect.poll(async () => (await db.query(`SELECT fetched FROM receipt_sweep_folders WHERE mailbox = $1`, [MB])).rows[0]?.fetched).toBe(2);
  let row = (await db.query(`SELECT fetched, newest, run_at, outcomes, empty_bodies FROM receipt_sweep_folders WHERE mailbox = $1`, [MB])).rows[0];
  expect(row.outcomes).toEqual({ 'skipped:not_a_receipt': 2 });   // what became of each, per folder
  expect(row.empty_bodies).toBe(0);
  expect(row.newest.toISOString()).toBe('2026-10-02T12:00:00.000Z');
  expect(row.run_at.toISOString()).toBe(runAt);

  // 2 is nowhere near the cap: the next check starts from the last press, as before.
  const quiet = await (await request.get('/api/receipts/sweep', { headers: WH })).json();
  expect(quiet.nearCap.filter((f) => f.mailbox === MB)).toHaveLength(0);

  // At the cap, the folder may have stopped short: resume from its newest email (minus the hour).
  const newest = new Date(Date.now() - 2 * 86_400_000);
  await db.query(`UPDATE receipt_sweep_folders SET fetched = 300, newest = $2 WHERE mailbox = $1`, [MB, newest]);
  const st = await (await request.get('/api/receipts/sweep', { headers: WH })).json();
  expect(st.nearCap.map((f) => f.mailbox)).toContain(MB);
  expect(st.folders.find((f) => f.mailbox === MB)).toMatchObject({ fetched: 300 });
  const next = await (await request.post('/api/receipts/sweep', { headers: WH, data: {} })).json();
  // To the second — Make takes whole seconds (since_epoch).
  expect(Math.floor(Date.parse(next.since) / 1000)).toBe(Math.floor((newest.getTime() - 60 * 60_000) / 1000));
  expect(next.resumed).toContain(`${MB} [Gmail]/All Mail`);

  // A new run resets the count — the cut-off folder isn't re-read forever.
  await raw(request, nikeEmail({ mailbox: MB, subject: 'Just In', text: 'Shop now.', message_id: `<e2e-rcc-cap-3-${stamp}@x>` }));
  await expect.poll(async () => (await db.query(`SELECT fetched, outcomes FROM receipt_sweep_folders WHERE mailbox = $1`, [MB])).rows[0])
    .toMatchObject({ fetched: 1, outcomes: { 'skipped:not_a_receipt': 1 } });
  await db.query(`DELETE FROM receipt_sweep_folders WHERE mailbox = $1`, [MB]);
});

test('the Receipts page has the button and says when it last checked', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.goto('/receipts');
  await expect(page.getByRole('button', { name: '↻ Check mailboxes' })).toBeVisible();
  await expect(page.locator('.rc-check')).toContainText('Last checked');
  await page.getByRole('button', { name: 'From a date…' }).click();
  await expect(page.getByRole('button', { name: 'Check from this date' })).toBeDisabled();
});
