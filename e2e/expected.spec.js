// Expected This Week: what is coming, by supplier and by online store.
import { test, expect } from '@playwright/test';
import pg from 'pg';
import { loginAs } from './helpers/auth.js';
import { expectedColumn, expectedDashboard, delayedDays, delayedShipments, delayFollowUp } from '../src/lib/expected.js';

const TODAY = '2026-11-10';
const NOW = Date.parse('2026-11-10T15:00:00Z');
const moving = { tracking_number: '1Z999', tracking_status: 'InTransit', last_move_at: '2026-11-10T10:00:00Z' };

test('a parcel lands in the column its estimate says, and no date is never hidden', () => {
  const col = (x) => expectedColumn({ ...moving, ...x }, TODAY, NOW);
  expect(col({ eta_from: '2026-11-10', eta_to: '2026-11-12' })).toBe('today');
  expect(col({ eta_from: '2026-11-11' })).toBe('week');
  expect(col({ eta_from: '2026-11-17' })).toBe('week');
  expect(col({ eta_from: '2026-11-18' })).toBe('later');
  expect(col({ eta_from: '2026-11-05', eta_to: '2026-11-06' })).toBe('overdue');
  expect(col({})).toBe('nodate');
  expect(col({ tracking_number: '' })).toBe('nodate');
  expect(col({ tracking_status: 'OutForDelivery' })).toBe('today');
  expect(col({ tracking_status: 'Delivered' })).toBe('landed');
});

test('suppliers and online stores stay apart, grouped by name, with pairs added up', () => {
  const b = expectedDashboard({
    boxes: [
      { ...moving, box_id: 1, supplier_name: 'Andrew', po_code: 'PO-1', box_units: 10, eta_from: TODAY },
      { ...moving, box_id: 2, supplier_name: ' andrew ', po_code: 'PO-1', box_units: 0, eta_from: '2026-11-12' },
      { ...moving, box_id: 3, supplier_name: 'Zed', po_code: 'PO-2', box_units: 5, eta_from: '2026-11-12' },
    ],
    online: [
      { ...moving, order_id: 7, store: 'Nike', order_number: 'N-7', pairs: 2, eta_from: TODAY },
      { order_id: 8, store: 'Foot Locker', order_number: null, tracking_number: null, pairs: 1 },
    ],
  }, TODAY, NOW);
  expect(b.suppliers.groups.map((g) => g.name)).toEqual(['Andrew', 'Zed']);
  expect(b.suppliers.groups[0].cols.today).toEqual({ count: 1, pairs: 10, unknownPairs: 0 });
  // A box with no declared pairs is unknown, never counted as zero.
  expect(b.suppliers.groups[0].cols.week).toEqual({ count: 1, pairs: 0, unknownPairs: 1 });
  expect(b.suppliers.total.week.count).toBe(2);
  expect(b.stores.groups.map((g) => g.name)).toEqual(['Nike', 'Foot Locker']);
  expect(b.stores.total.today).toEqual({ count: 1, pairs: 2, unknownPairs: 0 });
  expect(b.stores.groups[1].cols.nodate.count).toBe(1);
  expect(b.stores.groups[1].items[0].code).toBe('Order 8');
});

test('seven days without movement is delayed, ahead of any estimate; a week is the line', () => {
  const ago = (d) => new Date(NOW - d * 86400000).toISOString();
  const row = (x) => ({ tracking_number: '1Z999', tracking_status: 'InTransit', ...x });
  expect(delayedDays(row({ last_move_at: ago(6.9) }), NOW)).toBeNull();
  expect(delayedDays(row({ last_move_at: ago(7) }), NOW)).toBe(7);
  expect(expectedColumn(row({ last_move_at: ago(9), eta_from: TODAY }), TODAY, NOW)).toBe('delayed');
  // Not a delay: no number, here already, or never seen move with nothing to count from.
  expect(delayedDays(row({ tracking_number: '', last_move_at: ago(9) }), NOW)).toBeNull();
  expect(delayedDays(row({ tracking_status: 'Delivered', last_move_at: ago(9) }), NOW)).toBeNull();
  expect(delayedDays(row({ box_status: 'delivered', last_move_at: ago(9) }), NOW)).toBeNull();
  expect(delayedDays(row({}), NOW)).toBeNull();
  // A box with no scan counts from when it shipped.
  expect(delayedDays(row({ shipped_at: ago(8) }), NOW)).toBe(8);
});

test('who to chase: the sender for a label never scanned, the carrier otherwise', () => {
  const r = { supplier_name: 'Andrew', carrier: 'UPS', tracking_number: '1Z999' };
  expect(delayFollowUp({ ...r, tracking_status: 'InfoReceived' })).toMatch(/never scanned\. Ask Andrew/);
  expect(delayFollowUp({ ...r, tracking_status: 'Exception' })).toMatch(/UPS reports a problem\. Call UPS, and tell Andrew/);
  expect(delayFollowUp({ ...r, tracking_status: 'InTransit' })).toMatch(/Ask UPS for a trace, and tell Andrew/);
  expect(delayFollowUp({ store: 'Nike.com', tracking_number: '9', tracking_status: 'InTransit' })).toMatch(/Ask the carrier for a trace, and tell Nike\.com/);
});

test('an alert names each parcel once, then reminds weekly; moving and stopping again is new', async () => {
  const { splitDelayAlerts } = await import('../api/_lib/tracking-delay-worker.js');
  const moved = '2026-11-01T00:00:00Z';
  const rows = [{ number: 'A', last_move_at: moved }, { number: 'B', last_move_at: moved }, { number: 'C', last_move_at: moved }, { number: 'D', last_move_at: moved }];
  const state = {
    B: { last_move_at: moved, last_alerted_at: new Date(NOW - 1 * 86400000).toISOString() },
    C: { last_move_at: moved, last_alerted_at: new Date(NOW - 7 * 86400000).toISOString() },
    D: { last_move_at: '2026-10-01T00:00:00Z', last_alerted_at: new Date(NOW - 1 * 86400000).toISOString() },
  };
  const out = splitDelayAlerts(rows, state, NOW);
  expect(out.fresh.map((r) => r.number)).toEqual(['A', 'D']);
  expect(out.reminders.map((r) => r.number)).toEqual(['C']);
});

test('the message says who to chase, and stays under Telegram’s limit however many there are', async () => {
  const { trackingDelayBody } = await import('../api/_lib/alerts.js');
  const row = (n) => ({ party: 'Andrew', code: `PO-${n}`, box_number: 2, pairs: 12, carrier: 'UPS', tracking_number: `1Z${n}`, days: 9, last_location: 'Memphis, TN', followUp: 'Stopped moving. Ask UPS for a trace, and tell Andrew.' });
  const one = trackingDelayBody({ fresh: [row(1)] });
  expect(one).toContain('1 shipment with no tracking movement');
  expect(one).toContain('Andrew PO-1 box 2 · 12 pairs');
  expect(one).toContain('UPS 1Z1 · 9 days, last seen Memphis, TN');
  expect(one).toContain('Ask UPS for a trace');
  const many = trackingDelayBody({ fresh: Array.from({ length: 200 }, (_, i) => row(i)), reminders: Array.from({ length: 200 }, (_, i) => row(i)) });
  expect(many.length).toBeLessThan(4000);
  expect(many).toMatch(/more on the page/);
  expect(many).toContain('400 shipments');
});

test('stops older than 60 days stay off the alert, and the newest stall comes first', () => {
  const ago = (d) => new Date(NOW - d * 86400000).toISOString();
  const rows = delayedShipments({
    boxes: [{ box_id: 1, tracking_number: '1Z OLD', tracking_status: 'InTransit', last_move_at: ago(61), supplier_name: 'A', po_code: 'P1' },
      { box_id: 2, tracking_number: '1Z-TWO', tracking_status: 'InTransit', last_move_at: ago(20), supplier_name: 'A', po_code: 'P2', box_units: 3 }],
    online: [{ order_id: 3, tracking_number: 'ONE', tracking_status: 'InTransit', last_move_at: ago(8), store: 'Nike', pairs: 2 }],
  }, NOW);
  expect(rows.map((r) => [r.party, r.days])).toEqual([['Nike', 8], ['A', 20]]);
  expect(rows[1].number).toBe('1ZTWO');
});

test.describe('the morning run, end to end', () => {
  let pool; let fake;
  const STAMP = `${Date.now()}`.slice(-6);
  const NUM = `EXPDLY${STAMP}`;
  const UNREG = `EXPUNREG${STAMP}`;
  const calls = [];
  const keep = {};
  const made = { users: [], pos: [], orders: [] };

  test.beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const http = await import('node:http');
    fake = http.createServer((req, res) => {
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
    for (const k of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'TELEGRAM_API_BASE', 'TRACKING_API_KEY']) keep[k] = process.env[k];
    Object.assign(process.env, { TELEGRAM_BOT_TOKEN: 'e2e', TELEGRAM_CHAT_ID: '-1', TELEGRAM_API_BASE: 'http://127.0.0.1:5198', TRACKING_API_KEY: '' });
  });
  test.afterAll(async () => {
    for (const [k, v] of Object.entries(keep)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await pool.query('DELETE FROM alert_log WHERE user_id = ANY($1)', [made.users]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [made.users]);
    await pool.query('DELETE FROM po_lines WHERE po_id = ANY($1)', [made.pos]);
    await pool.query('DELETE FROM po_boxes WHERE po_id = ANY($1)', [made.pos]);
    await pool.query('DELETE FROM purchase_orders WHERE id = ANY($1)', [made.pos]);
    await pool.query('DELETE FROM online_orders WHERE id = ANY($1)', [made.orders]);
    await pool.query('DELETE FROM tracking_delay_alerts WHERE tracking_number = $1', [NUM]);
    await new Promise((r) => fake.close(r));
    await pool.end();
  });

  test('a stalled box reaches the team once, and an unregistered online number is listed for 17TRACK', async () => {
    const { trackingDelayTick } = await import('../api/_lib/tracking-delay-worker.js');
    const { listUnregisteredOnlineTracking } = await import('../api/_lib/db.js');
    const { rows: [u] } = await pool.query(
      `INSERT INTO users (name, username, pass_hash, role, status, telegram_user_id) VALUES ('E2E Delay', $1, 'x', 'warehouse', 'approved', $2) RETURNING id`,
      [`e2e_delay_${STAMP}`, 7700000 + Number(STAMP)]);
    made.users.push(Number(u.id));
    const po = Number((await pool.query(
      `INSERT INTO purchase_orders (po_code, supplier_name, status, expected_boxes, manifest_scope) VALUES ($1, 'E2E Delay Supplier', 'shipped', 1, 'box') RETURNING id`, [`PO-DLY-${STAMP}`])).rows[0].id);
    made.pos.push(po);
    const when = new Date(Date.now() - 7.05 * 86400000).toISOString();
    await pool.query(
      `INSERT INTO po_boxes (po_id, box_number, tracking_number, carrier, status, tracking_status, checked_at, tracking_events)
       VALUES ($1, 1, $2, 'UPS', 'in_transit', 'InTransit', now(), $3)`, [po, NUM, JSON.stringify([{ time: when, location: 'Memphis, TN' }])]);
    const order = Number((await pool.query(
      `INSERT INTO online_orders (store, order_number, tracking_number) VALUES ('E2E Delay Store', 'D-1', $1) RETURNING id`, [UNREG])).rows[0].id);
    made.orders.push(order);
    await pool.query(`INSERT INTO online_order_lines (order_id, sku, size, qty, unit_price) VALUES ($1, 'E2E-D', '9', 1, 50)`, [order]);
    expect(await listUnregisteredOnlineTracking(5000)).toContain(UNREG);

    const t0 = calls.length;
    await pool.query(`DELETE FROM alert_log WHERE event_key = 'tracking.delayed'`);
    const first = await trackingDelayTick({ force: true });
    expect(first.sent).toBe(true);
    const sent = calls.slice(t0).filter((c) => c.method === 'sendMessage' && String(c.body.chat_id) === String(7700000 + Number(STAMP)));
    expect(sent).toHaveLength(1);
    expect(sent[0].body.text).toContain('Shipments delayed');
    expect(sent[0].body.text).toContain(NUM);
    expect(sent[0].body.text).toContain('E2E Delay Supplier');
    expect(sent[0].body.text).toContain('Memphis, TN');
    expect(sent[0].body.text).toContain('Ask UPS for a trace');

    // A parcel that stalls after the day's message has gone waits for the next one, rather than
    // being marked as told when nothing was sent.
    await pool.query('DELETE FROM tracking_delay_alerts WHERE tracking_number = $1', [NUM]);
    const t2 = calls.length;
    const again = await trackingDelayTick({ force: true });
    expect(again).toMatchObject({ sent: false, reason: 'already sent' });
    expect(calls.slice(t2).filter((c) => c.method === 'sendMessage')).toHaveLength(0);
    expect((await pool.query('SELECT 1 FROM tracking_delay_alerts WHERE tracking_number = $1', [NUM])).rows).toHaveLength(0);
    await pool.query(`DELETE FROM alert_log WHERE event_key = 'tracking.delayed'`);
    expect((await trackingDelayTick({ force: true })).sent).toBe(true);

    // Already said: the same stall is not news the next run.
    const t1 = calls.length;
    await pool.query(`DELETE FROM alert_log WHERE event_key = 'tracking.delayed'`);
    await trackingDelayTick({ force: true });
    expect(calls.slice(t1).filter((c) => String(c.body?.text || '').includes(NUM))).toHaveLength(0);
    const { rows: st } = await pool.query('SELECT 1 FROM tracking_delay_alerts WHERE tracking_number = $1', [NUM]);
    expect(st).toHaveLength(1);
  });

  test('the worker stays off outside production unless asked', async () => {
    const { trackingDelayWorkerEnabled: on } = await import('../api/_lib/tracking-delay-worker.js');
    expect(on({})).toBe(false);
    expect(on({ RAILWAY_ENVIRONMENT_NAME: 'production' })).toBe(true);
    expect(on({ RAILWAY_ENVIRONMENT_NAME: 'production', TRACKING_DELAY_WORKER: 'off' })).toBe(false);
    expect(on({ TRACKING_DELAY_WORKER: 'on' })).toBe(true);
  });
});

test.describe('the screen and its data', () => {
  let pool;
  const STAMP = `${Date.now()}`.slice(-6);
  const SUPPLIER = `E2E Expected Supplier ${STAMP}`;
  const STORE = `E2E Expected Store ${STAMP}`;
  const made = { orders: [], pos: [], tracking: [] };

  test.beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.DATABASE_URL }); });
  test.afterAll(async () => {
    for (const id of made.orders) {
      await pool.query('DELETE FROM online_order_lines WHERE order_id = $1', [id]);
      await pool.query('DELETE FROM online_orders WHERE id = $1', [id]);
    }
    for (const id of made.pos) {
      await pool.query('DELETE FROM po_lines WHERE po_id = $1', [id]);
      await pool.query('DELETE FROM po_boxes WHERE po_id = $1', [id]);
      await pool.query('DELETE FROM purchase_orders WHERE id = $1', [id]);
    }
    if (made.tracking.length) await pool.query('DELETE FROM shipment_tracking WHERE tracking_number = ANY($1)', [made.tracking]);
    await pool.end();
  });

  test('the warehouse sees both sides; a parcel counted in or cancelled drops off', async ({ page }) => {
    const est = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
    const po = Number((await pool.query(
      `INSERT INTO purchase_orders (po_code, supplier_name, status, expected_boxes, manifest_scope)
       VALUES ($1, $2, 'shipped', 1, 'box') RETURNING id`, [`PO-EXP-${STAMP}`, SUPPLIER])).rows[0].id);
    made.pos.push(po);
    const box = Number((await pool.query(
      `INSERT INTO po_boxes (po_id, box_number, tracking_number, status, tracking_status, checked_at, eta_from, eta_to)
       VALUES ($1, 1, $2, 'in_transit', 'InTransit', now(), $3, $3) RETURNING id`, [po, `EXPBOX${STAMP}`, est])).rows[0].id);
    await pool.query(`INSERT INTO po_lines (po_id, po_box_id, sku, size, qty_expected) VALUES ($1, $2, 'E2E-EXP-1', '9', 4)`, [po, box]);

    const order = async (number, tracking, opts = {}) => {
      const id = Number((await pool.query(
        `INSERT INTO online_orders (store, order_number, tracking_number, received_at) VALUES ($1, $2, $3, $4) RETURNING id`,
        [STORE, number, tracking, opts.received ? new Date() : null])).rows[0].id);
      made.orders.push(id);
      await pool.query(
        `INSERT INTO online_order_lines (order_id, sku, size, qty, unit_price, cancelled_at) VALUES ($1, 'E2E-EXP-2', '10', 2, 50, $2)`,
        [id, opts.cancelled ? new Date() : null]);
      return id;
    };
    const trk = `EXPONL${STAMP}`;
    made.tracking.push(trk);
    await pool.query(
      `INSERT INTO shipment_tracking (tracking_number, tracking_status, eta_from, eta_to, checked_at) VALUES ($1, 'InTransit', $2, $2, now())`, [trk, est]);
    await order(`COMING-${STAMP}`, trk);
    await order(`NOTRACK-${STAMP}`, null);
    await order(`COUNTED-${STAMP}`, `EXPDONE${STAMP}`, { received: true });
    await order(`CANCELLED-${STAMP}`, `EXPCXL${STAMP}`, { cancelled: true });

    await loginAs(page, 'warehouse');
    await page.goto('/expected');
    const suppliers = page.locator('[data-side="supplier"]');
    const stores = page.locator('[data-side="store"]');
    const supplierRow = suppliers.locator('tr.exp-row', { hasText: SUPPLIER });
    const storeRow = stores.locator('tr.exp-row', { hasText: STORE });
    await expect(supplierRow).toContainText('4 pairs');
    await expect(stores.locator('tr.exp-row', { hasText: SUPPLIER })).toHaveCount(0);
    await expect(suppliers.locator('tr.exp-row', { hasText: STORE })).toHaveCount(0);
    await expect(storeRow.locator('td').nth(1)).toContainText('1');      // Today
    await expect(storeRow.locator('td').nth(4)).toContainText('1');      // No date yet

    await storeRow.click();
    const detail = stores.locator('.exp-detail');
    await expect(detail).toContainText(`COMING-${STAMP}`);
    await expect(detail).toContainText(`NOTRACK-${STAMP}`);
    await expect(detail).toContainText('no tracking yet');
    await expect(detail).not.toContainText(`COUNTED-${STAMP}`);
    await expect(detail).not.toContainText(`CANCELLED-${STAMP}`);
    expect(page.url()).toContain('open=');
    await page.reload();
    await expect(stores.locator('.exp-detail')).toContainText(`COMING-${STAMP}`);
  });

  test('PH has the same screen at its own address', async ({ page }) => {
    await loginAs(page, 'ph_team');
    await page.goto('/ph');
    await page.getByRole('button', { name: /Expected This Week/ }).first().click();
    await expect(page).toHaveURL(/\/ph\/expected/);
    await expect(page.locator('[data-side="supplier"]')).toBeVisible();
    await page.reload();
    await expect(page.locator('[data-side="supplier"]')).toBeVisible();
  });

  test('a supplier account cannot read it', async ({ page, request }) => {
    const { signToken } = await import('../api/_lib/util.js');
    const r = await request.get('/api/expected', { headers: { Authorization: `Bearer ${signToken({ uid: 999999, username: 'x', name: 'x', role: 'supplier' })}` } });
    expect(r.status()).toBe(403);
  });
});
