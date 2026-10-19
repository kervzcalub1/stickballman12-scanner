// Order Cancellations (docs/context/cancellations.md), end to end:
//   photo to the bot → read → rows filed + an answer in the chat
//   unreadable photo → a row WITH the photo, flagged; the reviewer types the number
//   the same number twice → not filed twice
//   a typed number → a row; a stranger / unlinked chat → told to connect
//   review: edit → verify (hard flags block) → cancelled; couldn't cancel → back, flagged
//   who may do what: the warehouse sends, only PH / admin review
//
// Telegram is the suite's fake Bot API on :5198 (getFile + the file download are served
// here too); the reader is a fake OpenAI on :5196 (playwright.config CANCEL_AI_URL).
import { test, expect } from '@playwright/test';
import http from 'node:http';
import pg from 'pg';
import sharp from 'sharp';
import { signToken, hashPassword } from '../api/_lib/util.js';
import { loadEnv, loginAs } from './helpers/auth.js';

loadEnv();
const SECRET = 'e2e-telegram-secret';
const TG_WH = 7710001; const TG_STRANGER = 7710002;
let pool; let tgFake; let aiFake; let JPEG;
const sent = [];          // sendMessage bodies
const docs = [];          // sendDocument multipart bodies
let nextRead = null;      // what the fake reader answers next: object | 'fail'
const prompts = [];       // the text half of every request the reader got
const WH = { name: 'E2E Cx Warehouse', username: 'e2e_cx_wh', role: 'warehouse' };
let whUid;

const q = (t, v) => pool.query(t, v).then((r) => r.rows);
const auth = (role) => ({ Authorization: `Bearer ${signToken({ uid: `e2e-cx-${role}`, username: `e2e_cx_${role}`, name: `E2E Cx ${role}`, role })}` });

test.beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  await q(`DELETE FROM cancellations WHERE sent_by LIKE 'E2E Cx%' OR order_number LIKE 'E2ECX%' OR order_number LIKE '9911%'`);
  await q(`DELETE FROM cancellation_photos WHERE sent_by LIKE 'E2E Cx%'`);
  await q(`DELETE FROM cancellation_tg_ctx WHERE key LIKE 'chat:%7710001'`);
  whUid = Number((await q(
    `INSERT INTO users (name, username, pass_hash, role, status, telegram_user_id)
     VALUES ($1, $2, $3, $4, 'approved', $5)
     ON CONFLICT (username) DO UPDATE SET role = EXCLUDED.role, status = 'approved', telegram_user_id = EXCLUDED.telegram_user_id
     RETURNING id`, [WH.name, WH.username, hashPassword('e2e-not-used'), WH.role, TG_WH]))[0].id);
  JPEG = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#fff' } }).jpeg().toBuffer();

  tgFake = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.url.includes('/file/bot')) { res.setHeader('content-type', 'image/jpeg'); return res.end(JPEG); }
      const method = req.url.split('/').pop();
      const raw = Buffer.concat(chunks).toString();
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { body = { raw }; }   // sendDocument is multipart
      if (method === 'sendDocument') docs.push(raw);
      res.setHeader('content-type', 'application/json');
      if (method === 'getFile') return res.end(JSON.stringify({ ok: true, result: { file_id: body.file_id, file_path: `photos/${body.file_id}.jpg`, file_size: JPEG.length } }));
      if (method === 'sendMessage') sent.push(body);
      return res.end(JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: body.chat_id } } }));
    });
  });
  aiFake = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      // Every photo is read TWICE (readTwice). An array = [first read, second read];
      // anything else answers both the same.
      const prompt = JSON.parse(Buffer.concat(chunks).toString() || '{}').messages?.[0]?.content?.[0]?.text || '';
      prompts.push(prompt);
      const k = prompt.includes('ONE CHARACTER AT A TIME') ? 1 : 0;
      const answer = Array.isArray(nextRead) ? nextRead[k] : nextRead;
      if (answer === 'fail' || !answer) { res.statusCode = 500; return res.end(JSON.stringify({ error: { message: 'fake failure' } })); }
      return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }));
    });
  });
  await new Promise((r) => tgFake.listen(5198, '127.0.0.1', r));
  await new Promise((r) => aiFake.listen(5196, '127.0.0.1', r));
});

test.afterAll(async () => {
  await q(`DELETE FROM cancellations WHERE sent_by LIKE 'E2E Cx%' OR order_number LIKE 'E2ECX%' OR order_number LIKE '9911%'`);
  await q(`DELETE FROM cancellation_photos WHERE sent_by LIKE 'E2E Cx%'`);
  await q(`DELETE FROM cancellation_tg_ctx WHERE key LIKE 'chat:%7710001' OR key LIKE 'album:mg%'`);
  await q('UPDATE users SET telegram_user_id = NULL WHERE id = $1', [whUid]);
  await q('DELETE FROM users WHERE id = $1', [whUid]);
  await new Promise((r) => tgFake.close(r));
  await new Promise((r) => aiFake.close(r));
  await pool.end();
});

let msgId = 50_000;
const GROUP = -100555;   // playwright.config TELEGRAM_CANCEL_CHAT_ID
const tap = (request, from, chat, data) => request.post('/api/telegram/webhook', {
  headers: { 'x-telegram-bot-api-secret-token': SECRET },
  data: { update_id: ++msgId, callback_query: { id: `cq${msgId}`, data, from: { id: from },
    message: { message_id: 1, chat: chat ? { id: chat, type: 'supergroup' } : { id: from, type: 'private' } } } },
});
const hook = (request, message) => request.post('/api/telegram/webhook', {
  headers: { 'x-telegram-bot-api-secret-token': SECRET },
  data: { update_id: ++msgId, message: { message_id: msgId,
    chat: message.chat ? { id: message.chat, type: 'supergroup' } : { id: message.from, type: 'private' },
    from: { id: message.from, is_bot: false, first_name: 'Karon' }, ...message.body } },
});
const photo = (from, fileId, caption) => ({ from, body: { photo: [{ file_id: `${fileId}-s`, width: 90 }, { file_id: fileId, width: 1280 }], ...(caption ? { caption } : {}) } });
const lastSaid = async (chatId, n = 1) => {
  await expect.poll(() => sent.filter((m) => m.chat_id === chatId).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(n);
  return sent.filter((m) => m.chat_id === chatId).at(-1).text;
};
const list = async (request, view = 'all', role = 'ph_team') => (await (await request.get(`/api/cancellations/list?view=${view}&days=all`, { headers: auth(role) })).json());
const order = (o) => ({ platform: null, order_number: null, sku: null, size: null, product: null, confidence: 0.97, unclear: [], ...o });

test('a photo with two orders → two rows, an answer in the chat; the same order again is not filed twice', async ({ request }) => {
  sent.length = 0;
  const stamp = String(Date.now()).slice(-8);
  const sx = `${stamp}-${stamp}`;
  nextRead = { what: 'StockX order screen', orders: [
    order({ platform: 'stockx', order_number: sx, sku: 'dd1391-100', size: '9', product: 'Dunk Low Panda' }),
    order({ platform: 'ebay', order_number: `99-${stamp.slice(0, 5)}-${stamp.slice(3, 8)}`, confidence: 0.6, unclear: ['order_number'] }),
  ] };
  expect((await hook(request, photo(TG_WH, `cx-a-${stamp}`, 'wrong size sent'))).ok()).toBeTruthy();
  const said = await lastSaid(TG_WH);
  expect(said).toMatch(/Logged 2 for review/);
  expect(said).toContain(sx);

  const rows = (await list(request)).rows.filter((r) => r.sent_by === WH.name && r.order_number?.includes(stamp.slice(0, 5)));
  expect(rows).toHaveLength(2);
  const s = rows.find((r) => r.platform === 'stockx');
  expect(s).toMatchObject({ status: 'to_review', order_number: sx, reason: 'wrong size sent', source: 'telegram', flags: [] });
  expect(s.photo_id).toBeTruthy();
  const e = rows.find((r) => r.platform === 'ebay');
  expect(e.flags).toEqual(expect.arrayContaining(['low_confidence', 'unclear']));

  // The photo is served to a signed-in viewer only.
  expect((await request.get(`/api/cancellations/photo?id=${s.photo_id}`)).status()).toBe(401);
  const img = await request.get(`/api/cancellations/photo?id=${s.photo_id}`, { headers: auth('warehouse') });
  expect(img.headers()['content-type']).toBe('image/jpeg');

  // Same order on another photo: answered, not filed again.
  nextRead = { what: '', orders: [order({ platform: 'stockx', order_number: sx })] };
  await hook(request, photo(TG_WH, `cx-b-${stamp}`));
  expect(await lastSaid(TG_WH, 2)).toMatch(new RegExp(`${sx} is already logged as #${s.id}`));
  expect((await list(request)).rows.filter((r) => r.order_number === sx)).toHaveLength(1);

  // Telegram re-sending the SAME update files nothing new.
  const before = (await list(request)).rows.length;
  nextRead = { what: '', orders: [order({ platform: 'alias', order_number: `E2ECX${stamp}` })] };
  const again = { from: TG_WH, body: { photo: [{ file_id: `cx-c-${stamp}` }] } };
  await hook(request, again);
  await lastSaid(TG_WH, 3);
  msgId -= 1;                                   // the same message_id once more
  await hook(request, again);
  await new Promise((r) => setTimeout(r, 1500));
  expect((await list(request)).rows.length).toBe(before + 1);
});

test('two reads that disagree flag the row and say what the second read saw', async ({ request }) => {
  sent.length = 0;
  const a = `9911${String(Date.now()).slice(-6)}`; const b = `${a.slice(0, -1)}${(Number(a.at(-1)) + 1) % 10}`;
  nextRead = [{ what: '', orders: [order({ platform: 'alias', order_number: a, confidence: 0.98 })] },
    { what: '', orders: [order({ platform: 'alias', order_number: b, confidence: 0.98 })] }];
  await hook(request, photo(TG_WH, `cx-d-${a}`));
  expect(await lastSaid(TG_WH)).toMatch(/Two reads of the photo gave different numbers/);
  const row = (await list(request)).rows.find((r) => r.order_number === a);
  expect(row.flags).toEqual(['reads_disagree']);
  expect(row.note).toBe(`Second read said ${b}`);
  // Verifying is still allowed — the reviewer's look at the photo is the check — and it
  // clears the reader's doubt once a person has edited the row.
  const fixed = await request.post('/api/cancellations/save', { headers: auth('ph_team'), data: { id: row.id, platform: 'alias', order_number: a, note: '' } });
  expect((await fixed.json()).row.flags).toEqual([]);
});

test('an unreadable photo still files a row with the photo; the reviewer types the number and verifies', async ({ request }) => {
  sent.length = 0;
  nextRead = 'fail';
  await hook(request, photo(TG_WH, `cx-bad-${Date.now()}`));
  expect(await lastSaid(TG_WH)).toMatch(/couldn't read an order number.*saved as #\d+/s);
  const row = (await list(request, 'review')).rows.find((r) => r.sent_by === WH.name && r.flags.includes('unreadable'));
  expect(row).toBeTruthy();
  expect(row.photo_id).toBeTruthy();

  // Verify is refused while the hard flags stand.
  const v1 = await request.post('/api/cancellations/action', { headers: auth('ph_team'), data: { id: row.id, action: 'verify' } });
  expect(v1.status()).toBe(409);
  // The warehouse can't correct or review.
  expect((await request.post('/api/cancellations/save', { headers: auth('warehouse'), data: { id: row.id, platform: 'alias', order_number: '991100112233' } })).status()).toBe(403);
  expect((await request.post('/api/cancellations/action', { headers: auth('warehouse'), data: { id: row.id, action: 'verify' } })).status()).toBe(403);

  const fixed = await request.post('/api/cancellations/save', { headers: auth('ph_team'), data: { id: row.id, platform: 'alias', order_number: ' #9911 0011 2233 ' } });
  expect(fixed.ok(), await fixed.text()).toBeTruthy();
  expect((await fixed.json()).row).toMatchObject({ order_number: '991100112233', flags: [] });
  const v2 = await request.post('/api/cancellations/action', { headers: auth('ph_team'), data: { id: row.id, action: 'verify' } });
  expect(v2.ok(), await v2.text()).toBeTruthy();
  expect((await v2.json()).row).toMatchObject({ status: 'verified', verified_by: 'E2E Cx ph_team' });

  // Couldn't cancel → back to review, flagged, with why. Then verified again and cancelled.
  const f = await request.post('/api/cancellations/action', { headers: auth('ph_team'), data: { id: row.id, action: 'failed', note: 'order not found on Alias' } });
  expect((await f.json()).row).toMatchObject({ status: 'to_review', flags: ['submit_failed'] });
  await request.post('/api/cancellations/action', { headers: auth('ph_team'), data: { id: row.id, action: 'verify' } });
  const done = await request.post('/api/cancellations/action', { headers: auth('admin'), data: { id: row.id, action: 'submitted', platformRef: 'CASE-1' } });
  const d = (await done.json()).row;
  expect(d).toMatchObject({ status: 'submitted', submitted_by: 'E2E Cx admin', platform_ref: 'CASE-1' });
  expect(d.events.map((x) => x.action)).toEqual(['created', 'edited', 'verified', 'reopened', 'verified', 'submitted']);
  // A second "cancelled" on the same row is a conflict, not a second record.
  expect((await request.post('/api/cancellations/action', { headers: auth('ph_team'), data: { id: row.id, action: 'submitted' } })).status()).toBe(409);
});

test('a typed number files a row; an unlinked chat is told to connect; a by-hand add refuses a duplicate', async ({ request }) => {
  sent.length = 0;
  const n = `${String(Date.now()).slice(-8)}-${String(Date.now()).slice(-8)}`;
  await hook(request, { from: TG_WH, body: { text: `${n} - customer asked` } });
  expect(await lastSaid(TG_WH)).toMatch(new RegExp(`Logged 1 for review:\\n#\\d+ StockX · ${n}`));
  const row = (await list(request)).rows.find((r) => r.order_number === n);
  expect(row).toMatchObject({ platform: 'stockx', source: 'typed', reason: 'customer asked', photo_id: null });

  await hook(request, { from: TG_WH, body: { text: 'hello' } });
  expect(await lastSaid(TG_WH, 2)).toMatch(/send the platform, then the photo\(s\)[\s\S]*\/sg Stadium Goods · \/kc Kicks Crew/);
  await hook(request, photo(TG_STRANGER, 'cx-stranger'));
  expect(await lastSaid(TG_STRANGER)).toMatch(/connect this chat first/);

  const dup = await request.post('/api/cancellations/save', { headers: auth('warehouse'), data: { platform: 'stockx', order_number: n } });
  expect(dup.status()).toBe(409);
  expect((await dup.json()).error).toMatch(new RegExp(`already logged as #${row.id}`));
  // Rejected numbers may come back.
  await request.post('/api/cancellations/action', { headers: auth('ph_team'), data: { id: row.id, action: 'reject', reason: 'test' } });
  expect((await request.post('/api/cancellations/save', { headers: auth('warehouse'), data: { platform: 'stockx', order_number: n } })).ok()).toBeTruthy();
});

test('/sg in the caption names the platform (over the reader\'s guess) and is told to the reader; the rest is the reason', async ({ request }) => {
  sent.length = 0; prompts.length = 0;
  const n = `9911${String(Date.now()).slice(-7)}`;
  nextRead = { what: '', orders: [order({ platform: 'stockx', order_number: n })] };
  await hook(request, photo(TG_WH, `cx-sg-${n}`, '/sg box damaged'));
  expect(await lastSaid(TG_WH)).toMatch(new RegExp(`#\\d+ Stadium Goods · ${n}`));
  expect(prompts.some((p) => p.includes('The sender says these orders are from Stadium Goods'))).toBe(true);
  expect((await list(request)).rows.find((r) => r.order_number === n)).toMatchObject({ platform: 'sg', reason: 'box damaged' });
});

test('/kc first, then a photo; an album takes its caption\'s platform; an unknown command files nothing', async ({ request }) => {
  sent.length = 0;
  await hook(request, { from: TG_WH, body: { text: '/kc' } });
  expect(await lastSaid(TG_WH)).toMatch(/Kicks Crew — send the photo\(s\) now/);
  const n1 = `9911${String(Date.now()).slice(-7)}1`;
  nextRead = { what: '', orders: [order({ platform: null, order_number: n1 })] };
  await hook(request, photo(TG_WH, `cx-kc-${n1}`));
  expect(await lastSaid(TG_WH, 2)).toMatch(new RegExp(`Kicks Crew · ${n1}`));

  // An album: the caption rides on ONE photo, and the other arrives first.
  const n2 = `9911${String(Date.now()).slice(-7)}2`;
  await hook(request, { from: TG_WH, body: { text: '/temu' } });          // a later platform for the chat …
  await lastSaid(TG_WH, 3);
  nextRead = { what: '', orders: [order({ platform: null, order_number: n2 })] };
  const mg = `mg${Date.now()}`;
  await hook(request, { from: TG_WH, body: { media_group_id: mg, photo: [{ file_id: `cx-al-1-${n2}` }] } });
  await hook(request, { from: TG_WH, body: { media_group_id: mg, photo: [{ file_id: `cx-al-2-${n2}` }], caption: '/tiktok' } });
  await expect.poll(async () => (await list(request)).rows.find((r) => r.order_number === n2)?.platform, { timeout: 15_000 }).toBe('tiktok');

  const before = (await list(request)).rows.length;
  await hook(request, photo(TG_WH, `cx-unk-${n2}`, '/goat'));
  expect(await lastSaid(TG_WH)).toMatch(/"\/goat" isn't one of the platforms/);
  await new Promise((r) => setTimeout(r, 800));
  expect((await list(request)).rows.length).toBe(before);
  // A typed number with its command.
  const n3 = `${String(Date.now()).slice(-8)}-${String(Date.now()).slice(-8)}`;
  await hook(request, { from: TG_WH, body: { text: `/stockx ${n3} - customer asked` } });
  expect(await lastSaid(TG_WH)).toMatch(new RegExp(`StockX · ${n3}`));
});

test('the cancellations group: photos and commands are filed, chatter (even a number) is ignored', async ({ request }) => {
  sent.length = 0;
  const n = `9911${String(Date.now()).slice(-7)}`;
  await hook(request, { from: TG_WH, chat: GROUP, body: { text: `call me ${n}` } });
  await hook(request, { from: TG_WH, chat: GROUP, body: { text: n } });
  await new Promise((r) => setTimeout(r, 800));
  expect(sent.filter((m) => m.chat_id === GROUP)).toHaveLength(0);
  expect((await list(request)).rows.some((r) => r.order_number === n)).toBe(false);

  // "/alias@Bot" then a photo — Telegram appends the bot's name to a command in a group.
  await hook(request, { from: TG_WH, chat: GROUP, body: { text: '/alias@StickballBot' } });
  expect(await lastSaid(GROUP)).toMatch(/Alias — send the photo/);
  nextRead = { what: '', orders: [order({ platform: null, order_number: n })] };
  await hook(request, { from: TG_WH, chat: GROUP, body: { photo: [{ file_id: `cx-grp-${n}` }] } });
  expect(await lastSaid(GROUP, 2)).toMatch(new RegExp(`Alias · ${n}`));
  expect((await list(request)).rows.find((r) => r.order_number === n)).toMatchObject({ platform: 'alias', sent_by: WH.name });

  // Someone in the group who isn't connected is told how.
  await hook(request, { from: TG_STRANGER, chat: GROUP, body: { photo: [{ file_id: 'cx-grp-stranger' }], caption: '/ebay' } });
  expect(await lastSaid(GROUP, 3)).toMatch(/connect this chat first/);
});

test('a failure before the read is answered, not silent', async ({ request }) => {
  sent.length = 0;
  // What a server without the cancellation tables does (prod before db:setup).
  await q('ALTER TABLE cancellation_tg_ctx RENAME TO cancellation_tg_ctx_off');
  try {
    await hook(request, photo(TG_WH, `cx-fail-${Date.now()}`, '/alias'));
    expect(await lastSaid(TG_WH)).toMatch(/That wasn't logged — something went wrong on our side/);
  } finally {
    await q('ALTER TABLE cancellation_tg_ctx_off RENAME TO cancellation_tg_ctx');
  }
});

test('end of shift: /msg picks a platform, /msgall and /msg-all list them all, /report sends the CSV — by EST day', async ({ request }) => {
  // A fixed past day, so the expected messages are exact whatever else this database holds.
  // 23:30 EST on the 4th is the 5th in UTC — it must count as the 4th.
  const DAY = '2021-03-04';
  const at = (t) => `('${t}'::timestamp AT TIME ZONE 'America/New_York')`;
  await q(`DELETE FROM cancellations WHERE sent_by = 'E2E Cx shift'`);
  const ins = (platform, num, sku, size, status = 'to_review', when = at(`${DAY} 10:00`)) => q(
    `INSERT INTO cancellations (platform, order_number, order_key, sku, size, status, sent_by, source, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,'E2E Cx shift','app', ${when})`, [platform, num, num ? `CXSHIFT${num.replace(/[^0-9A-Z]/gi, '')}` : null, sku, size, status]);
  await ins('alias', '176889923', 'CZ1884-010', 'US M 8.5');
  await ins('alias', '206557037', 'DQ4071-001', '9.5', 'verified', at(`${DAY} 23:30`));
  await ins('stockx', '11223344-55667788', null, null);
  await ins('alias', '300000001', 'X', '9', 'rejected');                      // rejected: never asked for
  await ins('ebay', null, null, null);                                           // no number yet: counted, not listed
  await ins('sg', '555000111', 'AB1234-001', '10', 'to_review', at('2021-03-03 12:00'));  // the day before
  sent.length = 0; docs.length = 0;

  await hook(request, { from: TG_WH, chat: GROUP, body: { text: `/msg ${DAY}` } });
  await expect.poll(() => sent.filter((m) => m.chat_id === GROUP && m.reply_markup).length).toBe(1);
  const picker = sent.find((m) => m.chat_id === GROUP && m.reply_markup);
  expect(picker.reply_markup.inline_keyboard.flat().map((b) => b.text)).toEqual(['Alias (2)', 'StockX (1)']);
  expect(picker.text).toMatch(/1 with no order number yet/);

  await tap(request, TG_WH, GROUP, picker.reply_markup.inline_keyboard[0][0].callback_data);
  expect(await lastSaid(GROUP, 2)).toBe('[dev] Alias\nPlease cancel the following order(s):\n#176889923 - CZ1884-010 size 8.5\n#206557037 - DQ4071-001 size 9.5');
  // A stranger's tap does nothing but tell them to connect.
  await tap(request, TG_STRANGER, GROUP, picker.reply_markup.inline_keyboard[0][0].callback_data);
  expect(await lastSaid(GROUP, 3)).toMatch(/Connect this Telegram first/);

  for (const [k, text] of [[1, `/msgall ${DAY}`], [2, `/msg-all ${DAY}`]]) {
    const said = await (async () => { await hook(request, { from: TG_WH, body: { text } }); return lastSaid(TG_WH, k); })();
    expect(said).toBe('[dev] Alias\nPlease cancel the following order(s):\n#176889923 - CZ1884-010 size 8.5\n#206557037 - DQ4071-001 size 9.5'
      + '\n\nStockX\nPlease cancel the following order(s):\n#11223344-55667788'
      + '\n\n⚠️ Not listed: 1 with no order number yet — fix them on the Cancellations page, then ask again.');
  }

  await hook(request, { from: TG_WH, body: { text: `/report ${DAY}` } });
  await expect.poll(() => docs.length).toBe(1);
  expect(docs[0]).toContain(`filename="cancellations-${DAY}.csv"`);
  expect(docs[0]).toContain('176889923');
  expect(docs[0]).toContain('300000001');          // the report is the record: rejected rows too
  expect(docs[0]).not.toContain('555000111');      // …but only that day's
  await hook(request, { from: TG_WH, body: { text: '/report someday' } });
  expect(await lastSaid(TG_WH, 3)).toMatch(/Which day\?/);

  // No date = TODAY in EST.
  await ins('kc', '424242424', 'KC0001-001', '7', 'to_review', 'now()');
  await hook(request, { from: TG_WH, body: { text: '/msgall' } });
  // (Other tests in this file log orders today too — so: the heading, and our row under it.)
  const todayMsg = await lastSaid(TG_WH, 4);
  expect(todayMsg).toContain('Kicks Crew\nPlease cancel the following order(s):\n');
  expect(todayMsg).toContain('\n#424242424 - KC0001-001 size 7');
  await q(`DELETE FROM cancellations WHERE sent_by = 'E2E Cx shift'`);
});

test('the page: a reviewer fixes the number from the photo, verifies, and marks it cancelled', async ({ page, request }) => {
  const num = `E2ECX${Date.now()}`;
  const r = await request.post('/api/cancellations/save', { headers: auth('warehouse'), data: { platform: 'alias', order_number: num.slice(0, 9) + 'X' } });
  const { row } = await r.json();
  await loginAs(page, 'ph_team');
  await page.goto(`/ph/cancellations?q=${encodeURIComponent(row.order_number)}`);
  const byId = () => page.locator('.cx-row').filter({ has: page.locator('.cx-head b', { hasText: new RegExp(`^#${row.id}$`) }) });
  const card = byId();
  await expect(card).toHaveCount(1);
  await card.getByPlaceholder('as printed on the photo').fill(num);
  await card.getByRole('button', { name: '✓ Verify' }).click();
  await expect(page.getByRole('status')).toContainText(`#${row.id} verified`);
  await page.getByRole('tab', { name: /To cancel/ }).click();
  await page.getByLabel('Search').fill(num);
  const v = byId();
  await expect(v.locator('.cx-num')).toHaveText(num);
  await v.getByRole('button', { name: /Cancelled on Alias/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Mark cancelled' }).click();
  await expect(page.getByRole('status')).toContainText(`#${row.id} marked cancelled`);
  await expect(byId()).toHaveCount(0);
});
