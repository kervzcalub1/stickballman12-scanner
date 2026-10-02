// Alerts, Phase 2 — the events that follow a request or an order through its life, and
// nudges (api/_lib/alerts.js, api/nudge.js). Same fake Bot API on :5198 as alerts.spec.js;
// ALERT_BATCH_MS is 1.5 s in playwright.config.js so a batched summary arrives in a test.
import { test, expect } from '@playwright/test';
import pg from 'pg';
import { signToken, hashPassword } from '../api/_lib/util.js';

test.describe.configure({ mode: 'serial' });

const TG = { buyer: 771030001, approver: 771030002, ph: 771030003, wh: 771030004, admin: 771030005, sup: 771030006, issuer: 771030007 };
const CAST = {
  buyer: { username: 'e2e_al2_buyer', name: 'E2E Al2 Buyer', role: 'supplier', privileges: ['request_buying'] },
  approver: { username: 'e2e_al2_approver', name: 'E2E Al2 Approver', role: 'warehouse', privileges: ['approve_buying'] },
  ph: { username: 'e2e_al2_ph', name: 'E2E Al2 PH', role: 'ph_team', privileges: [] },
  wh: { username: 'e2e_al2_wh', name: 'E2E Al2 Warehouse', role: 'warehouse', privileges: [] },
  admin: { username: 'e2e_al2_admin', name: 'E2E Al2 Admin', role: 'admin', privileges: [] },
  sup: { username: 'e2e_al2_sup', name: 'E2E Al2 Supplier', role: 'supplier', privileges: [] },
  issuer: { username: 'e2e_al2_issuer', name: 'E2E Al2 Issuer', role: 'ph_team', privileges: ['issue_gift_cards'] },
};
const SKU = 'E2E-AL2';
const TRK = ['E2EAL2TRK0001', 'E2EAL2TRK0002', 'E2EAL2TRK0003'];

let pool; let fake;
const people = {};
const calls = [];
const made = { carts: [], pos: [], online: [] };

test.beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  for (const [key, u] of Object.entries(CAST)) {
    const { rows } = await pool.query(
      `INSERT INTO users (name, username, pass_hash, role, status, privileges, telegram_user_id)
       VALUES ($1,$2,$3,$4,'approved',$5,$6)
       ON CONFLICT (username) DO UPDATE
         SET name = EXCLUDED.name, role = EXCLUDED.role, status = 'approved', privileges = EXCLUDED.privileges,
             telegram_user_id = EXCLUDED.telegram_user_id, telegram_broken_at = NULL,
             alerts_muted = false, alert_prefs = '{}'::jsonb
       RETURNING id`,
      [u.name, u.username, hashPassword('e2e-not-used'), u.role, u.privileges, TG[key]],
    );
    people[key] = { ...u, uid: Number(rows[0].id) };
  }
  const http = await import('node:http');
  fake = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const method = req.url.split('/').pop();
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      calls.push({ method, body });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(method === 'getMe'
        ? { ok: true, result: { id: 1, is_bot: true, username: 'e2e_alerts_bot' } }
        : { ok: true, result: { message_id: calls.length, chat: { id: body.chat_id } } }));
    });
  });
  await new Promise((r) => fake.listen(5198, '127.0.0.1', r));
});

test.afterAll(async () => {
  const ids = Object.values(people).map((p) => p.uid);
  await pool.query(`UPDATE users SET telegram_user_id = NULL, alert_prefs = '{}'::jsonb WHERE id = ANY($1)`, [ids]);
  await pool.query('DELETE FROM alert_log WHERE user_id = ANY($1)', [ids]);
  if (made.carts.length) await pool.query('DELETE FROM buy_carts WHERE id = ANY($1)', [made.carts]);
  if (made.online.length) await pool.query('DELETE FROM online_orders WHERE id = ANY($1)', [made.online]);
  if (made.pos.length) {
    await pool.query('DELETE FROM po_comments WHERE po_id = ANY($1)', [made.pos]);
    await pool.query('DELETE FROM po_boxes WHERE po_id = ANY($1)', [made.pos]);
    await pool.query('DELETE FROM purchase_orders WHERE id = ANY($1)', [made.pos]);
  }
  await pool.query('DELETE FROM shipment_tracking WHERE tracking_number = ANY($1)', [TRK]);
  await pool.query('DELETE FROM rescale_requests WHERE sku = $1', [SKU]);
  await new Promise((r) => fake.close(r));
  await pool.end();
});

const tokenFor = (u) => signToken({ uid: u.uid, username: u.username, name: u.name, role: u.role });
const post = async (request, who, path, data) => {
  const r = await request.post(`/api/${path}`, { headers: { Authorization: `Bearer ${tokenFor(people[who])}` }, data });
  return { status: r.status(), body: await r.json() };
};
// The "Open in Inventory" link — only there when the server has APP_BASE_URL (CI has
// none). Where it routes per role is tested directly below, so it is covered either way.
const linkOf = (dm) => dm.body.reply_markup?.inline_keyboard?.[0]?.[0]?.url
  || (String(dm.body.text).match(/https?:\/\/\S+/) || [])[0] || null;
const expectLinkIfAny = (dm, re) => { const l = linkOf(dm); if (l) expect(l).toMatch(re); };
const dmsTo = (from, who) => calls.slice(from).filter((c) => c.method === 'sendMessage' && Number(c.body.chat_id) === TG[who]);

// In THIS process, against the same fake — for the events whose trigger (a supplier
// shipping a packed, declared label; a finished intake) is a long fixture of its own.
async function inProcess(fn) {
  const keep = { ...process.env };
  Object.assign(process.env, {
    TELEGRAM_BOT_TOKEN: 'e2e-fake-token', TELEGRAM_CHAT_ID: '-100777',
    TELEGRAM_API_BASE: 'http://127.0.0.1:5198', ALERT_BATCH_MS: '1500',
  });
  try { return await fn(await import('../api/_lib/alerts.js')); } finally {
    for (const k of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'TELEGRAM_API_BASE', 'ALERT_BATCH_MS']) {
      if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k];
    }
  }
}

async function newCart(lines) {
  const cartId = Number((await pool.query(
    `INSERT INTO buy_carts (buyer_user_id, buyer_name, retailer, purpose, status, submitted_at, list_closed_at)
     VALUES ($1,$2,'E2E Al2 Store','E2E alerts','submitted', now(), now()) RETURNING id`,
    [people.buyer.uid, people.buyer.name])).rows[0].id);
  made.carts.push(cartId);
  const ids = [];
  for (const l of lines) {
    ids.push(Number((await pool.query(
      `INSERT INTO buy_cart_lines (cart_id, sku, size, shelf_price) VALUES ($1,$2,$3,50) RETURNING id`,
      [cartId, l.sku, l.size])).rows[0].id));
  }
  const code = (await pool.query('SELECT cart_code FROM buy_carts WHERE id = $1', [cartId])).rows[0].cart_code;
  return { cartId, ids, code };
}

test('decisions on a request reach the buyer as ONE summary', async ({ request }) => {
  const { cartId, ids, code } = await newCart([{ sku: 'E2E-AL2-A', size: '9' }, { sku: 'E2E-AL2-B', size: '10' }, { sku: 'E2E-AL2-C', size: '11' }]);
  const t0 = calls.length;
  expect((await post(request, 'approver', 'cart/decide', { cartId, action: 'approve', lineIds: [ids[0]], qty: { [ids[0]]: 2 } })).status).toBe(200);
  expect((await post(request, 'approver', 'cart/decide', { cartId, action: 'reject', lineIds: [ids[1]], reason: 'Too slow' })).status).toBe(200);
  expect((await post(request, 'approver', 'cart/decide', { cartId, action: 'approve', lineIds: [ids[2]], qty: { [ids[2]]: 1 } })).status).toBe(200);
  await expect.poll(() => dmsTo(t0, 'buyer').length, { timeout: 10_000 }).toBe(1);
  await new Promise((r) => setTimeout(r, 2000)); // and no second message trails in
  const dms = dmsTo(t0, 'buyer');
  expect(dms).toHaveLength(1);
  const text = dms[0].body.text;
  expect(text).toMatch(/Your pairs decided/);
  expect(text).toContain(`E2E Al2 Approver decided 3 lines on ${code}`);
  expect(text).toContain('Approved 3 pairs: E2E-AL2-A 9 ×2, E2E-AL2-C 11 ×1');
  expect(text).toContain('Turned down: E2E-AL2-B 10 (Too slow)');
  // A supplier's link goes to the supplier portal's buying page.
  expectLinkIfAny(dms[0], /\/buying\?request=/);
  // The approver never hears about their own decisions.
  expect(dmsTo(t0, 'approver').filter((d) => /pairs decided/.test(d.body.text))).toHaveLength(0);
});

test('a comment reaches the people on the request, not the writer', async ({ request }) => {
  const cartId = made.carts[0];
  const t0 = calls.length;
  expect((await post(request, 'buyer', 'cart/comment', { cartId, body: 'Is size 10 still a no?' })).status).toBe(200);
  await expect.poll(() => dmsTo(t0, 'approver').length).toBe(1);
  expect(dmsTo(t0, 'approver')[0].body.text).toContain('E2E Al2 Buyer: “Is size 10 still a no?”');
  expect(dmsTo(t0, 'buyer')).toHaveLength(0);

  const t1 = calls.length;
  expect((await post(request, 'approver', 'cart/comment', { cartId, body: 'Still a no.' })).status).toBe(200);
  await expect.poll(() => dmsTo(t1, 'buyer').length).toBe(1);
  expect(dmsTo(t1, 'buyer')[0].body.text).toContain('Still a no.');
});

test('a rescale count tells whoever asked for it, reported vs counted', async ({ request }) => {
  const made1 = await post(request, 'ph', 'rescale-requests/create', {
    sku: SKU, name: 'E2E Al2 Shoe', reason: 'Count is off', sizes: [{ size: '10', qty: 2 }],
  });
  expect(made1.status).toBe(200);
  const t0 = calls.length;
  expect((await post(request, 'wh', 'rescale-requests/audit', { id: made1.body.id, actualSizes: [{ size: '10', qty: 1 }] })).status).toBe(200);
  await expect.poll(() => dmsTo(t0, 'ph').length).toBe(1);
  const dm = dmsTo(t0, 'ph')[0];
  expect(dm.body.text).toContain('E2E Al2 Warehouse counted E2E Al2 Shoe — you reported 10 ×2; on the shelf: 10.');
  // PH lives under /ph — the link has to land inside the PH app.
  expectLinkIfAny(dm, /\/ph\/rescale/);
});

test('boxes shipped on one order are one message; a delivery is announced once', async ({ request }) => {
  const po = (await pool.query(
    `INSERT INTO purchase_orders (supplier_name, supplier_user_id, status) VALUES ('E2E Al2 Supplier', $1, 'shipped')
     RETURNING id, po_code, supplier_name`, [people.sup.uid])).rows[0];
  made.pos.push(Number(po.id));
  const boxes = [];
  for (const n of TRK.slice(0, 2)) {
    boxes.push((await pool.query(
      `INSERT INTO po_boxes (po_id, tracking_number, status) VALUES ($1, $2, 'shipped') RETURNING id, tracking_number`,
      [po.id, n])).rows[0]);
  }

  const t0 = calls.length;
  await inProcess(async (a) => {
    a.alertPoShipped(po, boxes[0], { uid: people.sup.uid, name: 'E2E Al2 Supplier' });
    a.alertPoShipped(po, boxes[1], { uid: people.sup.uid, name: 'E2E Al2 Supplier' });
    await expect.poll(() => dmsTo(t0, 'wh').length, { timeout: 10_000 }).toBe(1);
  });
  expect(dmsTo(t0, 'wh')[0].body.text).toContain(`E2E Al2 Supplier shipped 2 boxes — tracking ${TRK[0]}, ${TRK[1]}`);

  // 17TRACK says both delivered → ONE message; the same push again → nothing new.
  const push = (nums) => request.post('/api/po/tracking-webhook?secret=e2e-tracking-secret', {
    data: { event: 'TRACKING_UPDATED', data: nums.map((number) => ({ number, track_info: { latest_status: { status: 'Delivered' } } })) },
  });
  const t1 = calls.length;
  expect((await push(TRK.slice(0, 2))).status()).toBe(200);
  await expect.poll(() => dmsTo(t1, 'wh').length).toBe(1);
  expect(dmsTo(t1, 'wh')[0].body.text).toContain('2 boxes from E2E Al2 Supplier delivered — ready to receive.');
  const t2 = calls.length;
  expect((await push(TRK.slice(0, 2))).status()).toBe(200);
  await new Promise((r) => setTimeout(r, 1500));
  expect(dmsTo(t2, 'wh')).toHaveLength(0);
});

test('an online order delivered tells the warehouse to count it in — once', async ({ request }) => {
  const o = (await pool.query(
    `INSERT INTO online_orders (store, order_number, tracking_number, created_by) VALUES ('E2E Al2 Shop', 'A-77', $1, 'E2E Al2 PH') RETURNING id`,
    [TRK[2]])).rows[0];
  made.online.push(Number(o.id));
  await pool.query(`INSERT INTO online_order_lines (order_id, sku, size, qty, unit_price) VALUES ($1,'E2E-AL2-O','9',3,80)`, [o.id]);
  const push = () => request.post('/api/po/tracking-webhook?secret=e2e-tracking-secret', {
    data: { event: 'TRACKING_UPDATED', data: { number: TRK[2], track_info: { latest_status: { status: 'Delivered' } } } },
  });
  const t0 = calls.length;
  expect((await push()).status()).toBe(200);
  await expect.poll(() => dmsTo(t0, 'wh').length).toBe(1);
  expect(dmsTo(t0, 'wh')[0].body.text).toMatch(/Online order delivered[\s\S]*E2E Al2 Shop #A-77[\s\S]*Delivered — 3 pairs to count in \(ordered by E2E Al2 PH\)/);
  const t1 = calls.length;
  await push();
  await new Promise((r) => setTimeout(r, 1500));
  expect(dmsTo(t1, 'wh')).toHaveLength(0);
});

test('an order that does not match is told to admins once per result', async () => {
  const rc = { poId: made.pos[0], poCode: 'PO-E2E', supplierName: 'E2E Al2 Supplier', shortage: 2, overage: 0, wrongSize: 1, wrongSku: 0, noManifest: false, expectedUnits: 10, receivedUnits: 8 };
  const t0 = calls.length;
  await inProcess(async (a) => {
    a.alertPoDiscrepancy(rc, { uid: people.wh.uid });
    await expect.poll(() => dmsTo(t0, 'admin').length).toBe(1);
    a.alertPoDiscrepancy(rc, { uid: people.wh.uid });
    await new Promise((r) => setTimeout(r, 1200));
  });
  expect(dmsTo(t0, 'admin')).toHaveLength(1);
  expect(dmsTo(t0, 'admin')[0].body.text).toContain('Received 8 of 10 from E2E Al2 Supplier: 2 short · 1 wrong size.');
});

test('nudges: the server picks the people, once an hour, and it is on the trail', async ({ request }) => {
  const cartId = made.carts[0];
  const t0 = calls.length;
  const r = await post(request, 'approver', 'nudge', { kind: 'cart', id: cartId, to: 'buyer', note: 'Still in the shop?' });
  expect(r.status).toBe(200);
  expect(r.body.sentTo).toEqual(['E2E Al2 Buyer']);
  await expect.poll(() => dmsTo(t0, 'buyer').length).toBe(1);
  expect(dmsTo(t0, 'buyer')[0].body.text).toMatch(/E2E Al2 Approver nudged you about buying request BC-\d+ \(E2E Al2 Store\)\.\n“Still in the shop\?”/);

  // Again within the hour → refused, nothing sent.
  const again = await post(request, 'approver', 'nudge', { kind: 'cart', id: cartId, to: 'buyer' });
  expect(again.status).toBe(429);

  // On the request's own history.
  const ev = (await pool.query(`SELECT body FROM buy_cart_events WHERE cart_id = $1 AND kind = 'nudge'`, [cartId])).rows;
  expect(ev[0].body).toContain('Nudged the buyer on Telegram (E2E Al2 Buyer)');

  // A buyer may nudge the approvers — and only the people who hold the privilege.
  const t1 = calls.length;
  expect((await post(request, 'buyer', 'nudge', { kind: 'cart', id: cartId, to: 'approvers' })).status).toBe(200);
  await expect.poll(() => dmsTo(t1, 'approver').length).toBe(1);
  // …but not "the buyer" (themselves / another buyer), and nothing outside its own requests.
  expect((await post(request, 'buyer', 'nudge', { kind: 'cart', id: cartId, to: 'buyer' })).status).toBe(403);
  // Another supplier's request is "not found", the way the rest of the buying API answers.
  expect((await post(request, 'sup', 'nudge', { kind: 'cart', id: cartId, to: 'approvers' })).status).toBe(404);

  // A PO nudge reaches its supplier and lands on the PO thread.
  const t2 = calls.length;
  expect((await post(request, 'ph', 'nudge', { kind: 'po', id: made.pos[0], to: 'supplier' })).status).toBe(200);
  await expect.poll(() => dmsTo(t2, 'sup').length).toBe(1);
  expectLinkIfAny(dmsTo(t2, 'sup')[0], /\/orders\?po=/);
  expect((await pool.query(`SELECT count(*)::int AS n FROM po_comments WHERE po_id = $1 AND body LIKE 'Nudged the supplier%'`, [made.pos[0]])).rows[0].n).toBe(1);

  // Nonsense targets are refused before anything is looked up.
  expect((await post(request, 'ph', 'nudge', { kind: 'po', id: made.pos[0], to: 'everyone' })).status).toBe(400);
});

test('the gift card desk hears when a request is re-opened, and when it closes again — with what changed', async ({ request }) => {
  const { cartId, ids, code } = await newCart([{ sku: 'E2E-AL2-R1', size: '9' }]);
  await pool.query(`INSERT INTO buy_cart_files (cart_id, kind, sku, r2_key) VALUES ($1,'shoe','E2E-AL2-R1','e2e/r1.jpg'), ($1,'shoe','E2E-AL2-R2','e2e/r2.jpg')`, [cartId]);
  expect((await post(request, 'approver', 'cart/decide', { cartId, action: 'approve', lineIds: ids, qty: { [ids[0]]: 2 } })).status).toBe(200);
  // $100 approved, $100 already on cards.
  await pool.query(`INSERT INTO buy_cart_gift_cards (cart_id, code_enc, balance) VALUES ($1, 'e2e-not-a-code', 100)`, [cartId]);
  await pool.query(`UPDATE buy_carts SET gc_total = 100 WHERE id = $1`, [cartId]);
  await new Promise((r) => setTimeout(r, 2500)); // let the "pairs decided" batch go first
  const issuerSays = (from) => dmsTo(from, 'issuer').map((d) => d.body.text).filter((t) => t.includes(code));

  // 1. Re-opened → heads-up, cards already issued are named.
  let t = calls.length;
  expect((await post(request, 'buyer', 'cart/submit', { cartId, reopen: true })).status).toBe(200);
  await expect.poll(() => issuerSays(t).length).toBe(1);
  expect(issuerSays(t)[0]).toMatch(/Request re-opened[\s\S]*re-opened .* to add more pairs\.\n\$100\.00 already on cards stays\.\nHold off on more cards/);

  // 2. Closed again, nothing changed → said so, and nothing more to issue.
  t = calls.length;
  expect((await post(request, 'buyer', 'cart/submit', { cartId })).status).toBe(200);
  await expect.poll(() => issuerSays(t).length).toBe(1);
  expect(issuerSays(t)[0]).toContain(`closed ${code} again with no changes.\nNothing more to issue — $100.00 on cards covers the $100.00 approved.`);

  // 3. Re-opened, a pair added, closed again → what was added, and that it needs approving first.
  expect((await post(request, 'buyer', 'cart/submit', { cartId, reopen: true })).status).toBe(200);
  expect((await post(request, 'buyer', 'cart/line', { cartId, line: { sku: 'E2E-AL2-R2', size: '10', shelfPrice: 60 } })).status).toBe(200);
  t = calls.length;
  expect((await post(request, 'buyer', 'cart/submit', { cartId })).status).toBe(200);
  await expect.poll(() => issuerSays(t).filter((x) => /closed again/i.test(x)).length).toBe(1);
  expect(issuerSays(t).find((x) => /closed again/i.test(x)))
    .toContain(`again — added 1: E2E-AL2-R2 10.\n1 line still needs approving — you will get “Gift cards needed” with any top-up once they are decided.`);
});

test('a request the desk has nothing to do with yet stays quiet on re-open', async ({ request }) => {
  const { cartId, code } = await newCart([{ sku: 'E2E-AL2-Q', size: '9' }]);
  const t = calls.length;
  expect((await post(request, 'buyer', 'cart/submit', { cartId, reopen: true })).status).toBe(200);
  await new Promise((r) => setTimeout(r, 1500));
  expect(dmsTo(t, 'issuer').filter((d) => d.body.text.includes(code))).toHaveLength(0);
});

test('"Open in Inventory" lands inside the reader\'s own app', async () => {
  const { at } = await import('../api/_lib/alerts.js');
  const ph = { role: 'ph_team' }; const sup = { role: 'supplier' }; const wh = { role: 'warehouse' }; const sa = { role: 'superadmin' };
  expect(at('buying', 'request=7')(ph)).toBe('/ph/gift-card-buying?request=7');
  expect(at('buying', 'request=7')(sup)).toBe('/buying?request=7');
  expect(at('buying', 'request=7')(wh)).toBe('/buy-carts?request=7');
  expect(at('buying', 'request=7')(sa)).toBe('/buy-carts?request=7');
  expect(at('rescale')(ph)).toBe('/ph/rescale');
  expect(at('rescale')(wh)).toBe('/rescalereq');
  expect(at('po', 'po=3')(sup)).toBe('/orders?po=3');
  expect(at('reconcile', 'po=3')(ph)).toBe('/ph/reconciliation?po=3');
});

test('the panel lists the Phase 2 alerts by job', async ({ request }) => {
  const get = async (who) => (await (await request.get('/api/me/alerts', { headers: { Authorization: `Bearer ${tokenFor(people[who])}` } })).json()).events;
  const wh = await get('wh');
  expect(wh.find((e) => e.key === 'po.delivered')).toMatchObject({ on: true });
  expect(wh.find((e) => e.key === 'online.delivered')).toMatchObject({ on: true });
  expect(wh.find((e) => e.key === 'nudge')).toMatchObject({ required: true });
  const admin = await get('admin');
  expect(admin.find((e) => e.key === 'po.delivered')).toMatchObject({ on: false });
  expect(admin.find((e) => e.key === 'po.discrepancy')).toMatchObject({ on: true });
  const sup = await get('sup');
  expect(sup.map((e) => e.key)).toEqual(['nudge']);
});
