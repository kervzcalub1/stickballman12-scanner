// Alerts on Telegram — the 🔔 panel, self-service connect, and the events that DM people
// (api/me/*, api/_lib/alerts.js, the private-chat /start in api/telegram/webhook.js).
//
// The server playwright starts points its Bot API at a FAKE on 127.0.0.1:5198
// (playwright.config.js). This spec runs that fake, reads what the server said to
// "Telegram", and plays Telegram back at the webhook — the real bot is never touched.
import { test, expect } from '@playwright/test';
import pg from 'pg';
import { signToken, hashPassword } from '../api/_lib/util.js';

test.describe.configure({ mode: 'serial' });

const SECRET = 'e2e-telegram-secret';
const TG_WH = 771020001;
const TG_PH = 771020002;
const TG_ADMIN = 771020003;
const TG_BLOCKED = 771020099;           // the fake answers 403 for this chat
const SKU = 'E2E-ALRT-1';

const CAST = {
  wh: { username: 'e2e_alerts_wh', name: 'E2E Alerts Warehouse', role: 'warehouse', privileges: [] },
  ph: { username: 'e2e_alerts_ph', name: 'E2E Alerts PH', role: 'ph_team', privileges: [] },
  admin: { username: 'e2e_alerts_admin', name: 'E2E Alerts Admin', role: 'admin', privileges: [] },
  sup: { username: 'e2e_alerts_sup', name: 'E2E Alerts Shipper', role: 'supplier', privileges: [] },
};

let pool;
let fake;
const people = {};
const calls = [];
let msgSeq = 9000;

test.beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  for (const [key, u] of Object.entries(CAST)) {
    const { rows } = await pool.query(
      `INSERT INTO users (name, username, pass_hash, role, status, privileges)
       VALUES ($1,$2,$3,$4,'approved',$5)
       ON CONFLICT (username) DO UPDATE
         SET name = EXCLUDED.name, role = EXCLUDED.role, status = 'approved', privileges = EXCLUDED.privileges,
             telegram_user_id = NULL, telegram_name = NULL, telegram_username = NULL,
             telegram_broken_at = NULL, alerts_muted = false, alert_prefs = '{}'::jsonb
       RETURNING id`,
      [u.name, u.username, hashPassword('e2e-not-used'), u.role, u.privileges],
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
      if (method === 'getMe') return res.end(JSON.stringify({ ok: true, result: { id: 1, is_bot: true, username: 'e2e_alerts_bot' } }));
      if (method === 'sendMessage' && Number(body.chat_id) === TG_BLOCKED) {
        res.statusCode = 403;
        return res.end(JSON.stringify({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }));
      }
      msgSeq += 1;
      return res.end(JSON.stringify({ ok: true, result: { message_id: msgSeq, chat: { id: body.chat_id } } }));
    });
  });
  await new Promise((r) => fake.listen(5198, '127.0.0.1', r));
});

test.afterAll(async () => {
  const ids = Object.values(people).map((p) => p.uid);
  await pool.query(`UPDATE users SET telegram_user_id = NULL, telegram_name = NULL, telegram_username = NULL,
    telegram_broken_at = NULL, alerts_muted = false, alert_prefs = '{}'::jsonb WHERE id = ANY($1)`, [ids]);
  await pool.query('DELETE FROM alert_log WHERE user_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM telegram_link_tokens WHERE user_id = ANY($1)', [ids]);
  await pool.query(`DELETE FROM rescale_requests WHERE sku = $1`, [SKU]).catch(() => {});
  await pool.query(`DELETE FROM users WHERE username LIKE 'e2e_alerts_new_%'`);
  await new Promise((r) => fake.close(r));
  await pool.end();
});

const tokenFor = (u) => signToken({ uid: u.uid, username: u.username, name: u.name, role: u.role });
const ENV_ADMIN = signToken({ uid: 'admin', username: 'admin', name: 'Alex', role: 'admin' });
const get = async (request, who, path) => {
  const r = await request.get(`/api/${path}`, { headers: { Authorization: `Bearer ${typeof who === 'string' ? tokenFor(people[who]) : who.token}` } });
  return { status: r.status(), body: await r.json() };
};
const post = async (request, who, path, data) => {
  const r = await request.post(`/api/${path}`, { headers: { Authorization: `Bearer ${tokenFor(people[who])}` }, data });
  return { status: r.status(), body: await r.json() };
};
const hook = (request, update) => request.post('/api/telegram/webhook', {
  headers: { 'x-telegram-bot-api-secret-token': SECRET }, data: update,
});
const startFrom = (tg, text, { username = 'e2e_tg', first = 'Tele', last = 'Gram' } = {}) => ({
  update_id: Date.now(),
  message: {
    message_id: Date.now() % 100000, text,
    chat: { id: tg, type: 'private' },
    from: { id: tg, is_bot: false, first_name: first, last_name: last, username },
  },
});
const since = (i) => calls.slice(i);
const dmsTo = (from, tg) => since(from).filter((c) => c.method === 'sendMessage' && Number(c.body.chat_id) === tg);
const userRow = async (key) => (await pool.query(
  'SELECT telegram_user_id, telegram_username, telegram_broken_at, alerts_muted, alert_prefs FROM users WHERE id = $1',
  [people[key].uid])).rows[0];

async function connect(request, key, tg, opts) {
  const link = await post(request, key, 'me/telegram', { action: 'link' });
  expect(link.status).toBe(200);
  const token = new URL(link.body.url).searchParams.get('start');
  expect((await hook(request, startFrom(tg, `/start ${token}`, opts))).status()).toBe(200);
  return token;
}

test('the panel lists only the alerts that apply to the job', async ({ request }) => {
  const keys = (b) => b.events.map((e) => e.key);
  const wh = (await get(request, 'wh', 'me/alerts')).body;
  expect(wh.account).toBe('own');
  expect(wh.telegram.connected).toBe(false);
  expect(keys(wh)).toContain('rescale.requested');
  expect(keys(wh)).not.toContain('account.signup');
  expect(keys(wh)).not.toContain('buy.cards_needed');
  expect(wh.events.find((e) => e.key === 'rescale.requested').on).toBe(true);

  const admin = (await get(request, 'admin', 'me/alerts')).body;
  expect(admin.events.find((e) => e.key === 'account.signup')).toMatchObject({ required: true, on: true });
  // The warehouse's job — an admin sees the row but starts with it off.
  expect(admin.events.find((e) => e.key === 'rescale.requested').on).toBe(false);

  // A supplier who only ships boxes gets nudges and nothing else.
  expect((await get(request, 'sup', 'me/alerts')).body.events.map((e) => e.key)).toEqual(['nudge']);

  // The env login is shared — it can't carry one person's Telegram.
  const shared = await get(request, { token: ENV_ADMIN }, 'me/alerts');
  expect(shared.body.account).toBe('shared');
});

test('preferences: an opt-out is stored, a required alert cannot be turned off', async ({ request }) => {
  const r = await post(request, 'wh', 'me/alerts', { prefs: { 'rescale.requested': false, 'buy.cards_released': false, bogus: true } });
  expect(r.status).toBe(200);
  expect(r.body.events.find((e) => e.key === 'rescale.requested').on).toBe(false);
  expect(r.body.events.find((e) => e.key === 'buy.cards_released').on).toBe(true);
  expect((await userRow('wh')).alert_prefs).toEqual({ 'rescale.requested': false });
  // Back to the default → nothing stored, so a later default change still reaches them.
  await post(request, 'wh', 'me/alerts', { prefs: { 'rescale.requested': true } });
  expect((await userRow('wh')).alert_prefs).toEqual({});
});

test('connect: the deep link + /start connects THIS account, and the token is single use', async ({ request }) => {
  const t0 = calls.length;
  const link = await post(request, 'wh', 'me/telegram', { action: 'link' });
  expect(link.body.url).toMatch(/^https:\/\/t\.me\/e2e_alerts_bot\?start=[A-Za-z0-9_-]{20,64}$/);
  const token = new URL(link.body.url).searchParams.get('start');

  await hook(request, startFrom(TG_WH, `/start ${token}`, { username: 'wh_on_tg' }));
  const row = await userRow('wh');
  expect(Number(row.telegram_user_id)).toBe(TG_WH);
  expect(row.telegram_username).toBe('wh_on_tg');
  const reply = dmsTo(t0, TG_WH).at(-1);
  expect(reply.body.text).toContain('Connected to Stickballman12 Inventory as E2E Alerts Warehouse');

  const state = (await get(request, 'wh', 'me/alerts')).body;
  expect(state.telegram).toMatchObject({ connected: true, username: 'wh_on_tg', broken: false });

  // The same link a second time does nothing but say so.
  const t1 = calls.length;
  await hook(request, startFrom(TG_PH, `/start ${token}`));
  expect(dmsTo(t1, TG_PH).at(-1).body.text).toMatch(/expired or was already used/);
  expect(Number((await userRow('wh')).telegram_user_id)).toBe(TG_WH);
});

test('a Telegram account already connected to someone else is refused, by name', async ({ request }) => {
  const t0 = calls.length;
  await connect(request, 'ph', TG_WH);
  expect(dmsTo(t0, TG_WH).at(-1).body.text).toContain('already connected to E2E Alerts Warehouse');
  expect((await userRow('ph')).telegram_user_id).toBeNull();
});

test('a plain /start says who the chat is connected as', async ({ request }) => {
  const t0 = calls.length;
  await hook(request, startFrom(TG_WH, '/start'));
  expect(dmsTo(t0, TG_WH).at(-1).body.text).toContain("You're connected to Stickballman12 Inventory as E2E Alerts Warehouse");
  await hook(request, startFrom(TG_PH, '/start'));
  expect(dmsTo(t0, TG_PH).at(-1).body.text).toMatch(/tap 🔔 Alerts, then Connect Telegram/);
});

test('Send test is a formatted message; a 403 marks the connection broken', async ({ request }) => {
  const t0 = calls.length;
  expect((await post(request, 'wh', 'me/telegram', { action: 'test' })).status).toBe(200);
  const msg = dmsTo(t0, TG_WH).at(-1);
  expect(msg.body.parse_mode).toBe('HTML');
  expect(msg.body.text).toMatch(/<b>(\[dev\] )?Test alert<\/b>/);

  await pool.query('UPDATE users SET telegram_user_id = $1 WHERE id = $2', [TG_BLOCKED, people.wh.uid]);
  try {
    const r = await post(request, 'wh', 'me/telegram', { action: 'test' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/Reconnect/);
    expect((await get(request, 'wh', 'me/alerts')).body.telegram.broken).toBe(true);
  } finally {
    await pool.query('UPDATE users SET telegram_user_id = $1, telegram_broken_at = NULL WHERE id = $2', [TG_WH, people.wh.uid]);
  }
});

test('a rescale request DMs the warehouse — unless they turned that alert off', async ({ request }) => {
  const ask = () => post(request, 'ph', 'rescale-requests/create', {
    sku: SKU, name: 'E2E Alert Shoe', reason: 'Count is off', sizes: [{ size: '10', qty: 2 }, { size: '11', qty: 1 }],
  });
  const t0 = calls.length;
  expect((await ask()).status).toBe(200);
  await expect.poll(() => dmsTo(t0, TG_WH).length).toBe(1);
  const dm = dmsTo(t0, TG_WH)[0];
  expect(dm.body.text).toMatch(/📨 <b>(\[dev\] )?New rescale request<\/b>/);
  expect(dm.body.text).toContain(SKU);
  expect(dm.body.text).toContain('E2E Alerts PH asked for a recount of E2E Alert Shoe — sizes 10 ×2, 11');
  await expect.poll(async () => (await pool.query(
    `SELECT count(*)::int AS n FROM alert_log WHERE user_id = $1 AND event_key = 'rescale.requested' AND status = 'sent'`,
    [people.wh.uid])).rows[0].n).toBe(1);

  await post(request, 'wh', 'me/alerts', { prefs: { 'rescale.requested': false } });
  const t1 = calls.length;
  expect((await ask()).status).toBe(200);
  await expect.poll(async () => (await pool.query(
    `SELECT count(*)::int AS n FROM alert_log WHERE user_id = $1 AND event_key = 'rescale.requested' AND status = 'skipped' AND reason = 'event turned off'`,
    [people.wh.uid])).rows[0].n).toBe(1);
  expect(dmsTo(t1, TG_WH)).toHaveLength(0);
  await post(request, 'wh', 'me/alerts', { prefs: { 'rescale.requested': true } });
});

test('the master switch silences even a required alert', async ({ request }) => {
  await pool.query('UPDATE users SET telegram_user_id = $1 WHERE id = $2', [TG_ADMIN, people.admin.uid]);
  const signup = (username) => request.post('/api/auth/signup', { data: { name: 'E2E New Person', username, password: 'e2e-password-1' } });

  const t0 = calls.length;
  expect((await signup(`e2e_alerts_new_${Date.now() % 1e6}`)).status()).toBe(201);
  await expect.poll(() => dmsTo(t0, TG_ADMIN).length).toBe(1);
  expect(dmsTo(t0, TG_ADMIN)[0].body.text).toMatch(/🔑 <b>(\[dev\] )?New account waiting<\/b>[\s\S]*E2E New Person signed up as Warehouse/);

  await post(request, 'admin', 'me/alerts', { muted: true });
  const t1 = calls.length;
  expect((await signup(`e2e_alerts_new_${(Date.now() + 7) % 1e6}`)).status()).toBe(201);
  await expect.poll(async () => (await pool.query(
    `SELECT count(*)::int AS n FROM alert_log WHERE user_id = $1 AND event_key = 'account.signup' AND reason = 'all alerts off'`,
    [people.admin.uid])).rows[0].n).toBe(1);
  expect(dmsTo(t1, TG_ADMIN)).toHaveLength(0);
});

test('disconnect says goodbye and clears the connection', async ({ request }) => {
  const t0 = calls.length;
  expect((await post(request, 'wh', 'me/telegram', { action: 'disconnect' })).status).toBe(200);
  expect(dmsTo(t0, TG_WH).at(-1).body.text).toContain('Disconnected');
  expect((await userRow('wh')).telegram_user_id).toBeNull();
  expect((await get(request, 'wh', 'me/alerts')).body.telegram.connected).toBe(false);
});

test('the bell opens the panel, and ?alerts=1 survives a refresh', async ({ page }) => {
  const u = people.wh;
  await page.addInitScript(([token, user]) => {
    sessionStorage.setItem('sb_session_token', token);
    sessionStorage.setItem('sb_user', JSON.stringify(user));
  }, [tokenFor(u), { uid: u.uid, username: u.username, name: u.name, role: u.role, privileges: [] }]);
  await page.goto('/');
  await page.getByRole('button', { name: 'Alerts' }).first().click();
  const panel = page.getByRole('dialog', { name: 'Alerts' });
  await expect(panel.getByRole('button', { name: 'Connect Telegram' })).toBeVisible();
  await expect(panel.getByRole('switch', { name: 'New rescale request' })).toHaveAttribute('aria-checked', 'true');
  await expect(page).toHaveURL(/[?&]alerts=1/);
  await page.reload();
  await expect(page.getByRole('dialog', { name: 'Alerts' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Alerts' })).toHaveCount(0);
  await expect(page).not.toHaveURL(/alerts=1/);
});
