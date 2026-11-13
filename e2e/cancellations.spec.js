// Order Cancellations (docs/context/cancellations.md), end to end. Since 2026-11-12 a row is
// simply RECORDED (no review step):
//   photos to the bot → read → recorded → ONE reply per batch, as a reply to the first photo
//   the shoe (name, SKU, size): our own eBay / SHEIN / pre-sell order by number (one OCR
//     letter-for-digit slip put right only when exactly ONE of our orders is that close),
//     an eBay label's tracking number, the label itself, then our catalogue by SKU
//   unreadable photo → a row WITH the photo, "no order # read"; a typed number fills it
//   the same number twice → not recorded twice; a re-sent Telegram update → nothing
//   a restart mid-batch → the sweep answers (once)
//   the page: platform + EST-day filters (checked from Manila), edit, remove, CSV
//
// Telegram is the suite's fake Bot API on :5198 (getFile + the file download are served
// here too); the AI reader is a fake OpenAI on :5196 (playwright.config CANCEL_AI_URL) — it
// is only asked when tesseract finds no order number, which on these blank test pictures is
// always. Each test picture has its own width, so the fake can answer each photo apart.
import { test, expect } from '@playwright/test';
import http from 'node:http';
import pg from 'pg';
import sharp from 'sharp';
import { signToken, hashPassword } from '../api/_lib/util.js';
import {
  ordersFromText, trackingFromText, labelProduct, confusableKeys, matchOurOrder, detailsFromOrder, typedDetails,
  batchReplyText, periodDays, cancellationsCsv,
} from '../src/lib/cancellations.js';
import { loadEnv, loginAs } from './helpers/auth.js';

loadEnv();
// This test process imports the server's sweep directly (the restart test): point ITS
// Telegram at the fake too, before anything reads the env. Never the real bot.
process.env.TELEGRAM_API_BASE = 'http://127.0.0.1:5198';
process.env.TELEGRAM_BOT_TOKEN = 'e2e-fake-token';
process.env.TELEGRAM_CHAT_ID = '-100777';
process.env.CANCEL_PHOTOS_IN_DB = '1';
process.env.CANCEL_AI = 'off';

const SECRET = 'e2e-telegram-secret';
const TG_WH = 7710001; const TG_STRANGER = 7710002;
let pool; let tgFake; let aiFake;
const sent = [];          // sendMessage bodies
const docs = [];          // sendDocument multipart bodies
let nextRead = null;      // what the fake reader answers when no per-picture answer is set
const readsByWidth = new Map(); // picture width → its answer
const pictures = new Map(); // file_id → the picture the fake Telegram serves
const prompts = [];       // the text half of every request the reader got
const WH = { name: 'E2E Cx Warehouse', username: 'e2e_cx_wh', role: 'warehouse' };
let whUid;
let JPEG;

const q = (t, v) => pool.query(t, v).then((r) => r.rows);
const auth = (role) => ({ Authorization: `Bearer ${signToken({ uid: `e2e-cx-${role}`, username: `e2e_cx_${role}`, name: `E2E Cx ${role}`, role })}` });
let width = 60;
/** A blank picture of its own width, served for this file id; `answer` = what the reader sees on it. */
async function picture(fileId, answer) {
  width += 1;
  pictures.set(fileId, await sharp({ create: { width, height: 30, channels: 3, background: '#fff' } }).jpeg().toBuffer());
  if (answer !== undefined) readsByWidth.set(width, answer);
  return fileId;
}

test.beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  await cleanup();
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
      if (req.url.includes('/file/bot')) {
        const id = decodeURIComponent(req.url.split('/').pop()).replace(/\.jpg$/, '');
        res.setHeader('content-type', 'image/jpeg'); return res.end(pictures.get(id) || JPEG);
      }
      const method = req.url.split('/').pop();
      const raw = Buffer.concat(chunks).toString();
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { body = { raw }; }   // sendDocument is multipart
      if (method === 'sendDocument') docs.push(raw);
      res.setHeader('content-type', 'application/json');
      if (method === 'getFile') return res.end(JSON.stringify({ ok: true, result: { file_id: body.file_id, file_path: `photos/${body.file_id}.jpg`, file_size: 1000 } }));
      if (method === 'sendMessage') sent.push(body);
      return res.end(JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: body.chat_id } } }));
    });
  });
  aiFake = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      res.setHeader('content-type', 'application/json');
      // Every photo is read TWICE (readTwice). An array = [first read, second read];
      // anything else answers both the same.
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      const prompt = body.messages?.[0]?.content?.[0]?.text || '';
      prompts.push(prompt);
      const url = body.messages?.[0]?.content?.[1]?.image_url?.url || '';
      let w = null;
      try { w = (await sharp(Buffer.from(url.split(',')[1] || '', 'base64')).metadata()).width; } catch { /* not a picture */ }
      const k = prompt.includes('ONE CHARACTER AT A TIME') ? 1 : 0;
      const pick = readsByWidth.has(w) ? readsByWidth.get(w) : nextRead;
      const answer = Array.isArray(pick) ? pick[k] : pick;
      if (answer === 'quota') {   // what OpenAI says when the account has no credit left
        res.statusCode = 429;
        return res.end(JSON.stringify({ error: { message: 'You have no credits remaining.', type: 'insufficient_quota', code: 'credit_balance_exhausted' } }));
      }
      if (answer === 'fail' || !answer) { res.statusCode = 500; return res.end(JSON.stringify({ error: { message: 'fake failure' } })); }
      return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }));
    });
  });
  await new Promise((r) => tgFake.listen(5198, '127.0.0.1', r));
  await new Promise((r) => aiFake.listen(5196, '127.0.0.1', r));
});

async function cleanup() {
  await q(`DELETE FROM cancellations WHERE sent_by LIKE 'E2E Cx%' OR order_number LIKE 'E2ECX%' OR order_number LIKE '9911%' OR order_number LIKE 'GS%E2E'`);
  await q(`DELETE FROM cancellation_photos WHERE sent_by LIKE 'E2E Cx%'`);
  await q(`DELETE FROM cancellation_tg_ctx WHERE key LIKE 'chat:%7710001' OR key LIKE 'album:mg%'`);
  await q(`DELETE FROM ebay_orders WHERE buyer = 'e2e-cx'`);
  await q(`DELETE FROM shein_order_units WHERE note = 'e2e-cx'`);
  await q(`DELETE FROM presell_sales WHERE raw->>'e2e' = 'cx'`);
  await q(`DELETE FROM presell_stock WHERE created_by = 'e2e-cx'`);
  await q(`DELETE FROM shopify_listing_variants WHERE variant_id LIKE 'e2e-cx-%'`);
  await q(`DELETE FROM products WHERE source = 'e2e-cx'`);
}

test.afterAll(async () => {
  await cleanup();
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
// Sends one update; resolves to the message_id it carried.
const hook = async (request, message) => {
  const id = message.id ?? ++msgId;
  const r = await request.post('/api/telegram/webhook', {
    headers: { 'x-telegram-bot-api-secret-token': SECRET },
    data: { update_id: id, message: { message_id: id,
      chat: message.chat ? { id: message.chat, type: 'supergroup' } : { id: message.from, type: 'private' },
      from: { id: message.from, is_bot: false, first_name: 'Karon' }, ...message.body } },
  });
  expect(r.ok()).toBeTruthy();
  return id;
};
const photo = (from, fileId, caption, extra = {}) => ({ from, body: { photo: [{ file_id: `${fileId}-s`, width: 90 }, { file_id: fileId, width: 1280 }], ...(caption ? { caption } : {}), ...extra } });
const saidTo = (chatId) => sent.filter((m) => m.chat_id === chatId);
const lastSaid = async (chatId, n = 1) => {
  await expect.poll(() => saidTo(chatId).length, { timeout: 20_000 }).toBeGreaterThanOrEqual(n);
  return saidTo(chatId).at(-1).text;
};
const list = async (request, role = 'ph_team') => (await (await request.get('/api/cancellations/list', { headers: auth(role) })).json());
const order = (o) => ({ platform: null, order_number: null, sku: null, size: null, product: null, confidence: 0.97, unclear: [], ...o });
const read = (...orders) => ({ what: '', orders: orders.map(order) });

// ── The rules (pure) ─────────────────────────────────────────────────────────────────
test('the no-AI rules pick the order number out of read text, and never a tracking number or a phone', () => {
  // An Alias packing label as tesseract reads it: the small captions are lost, the big lines read.
  expect(ordersFromText('N 5 Air Max 90 Anthracite\n176889923\nDQ4071 001\nB14\nUSM 9.5', 'alias'))
    .toEqual([{ order_number: '176889923', platform: 'alias', why: 'label', sku: 'DQ4071-001', size: 'US M 9.5', product: null }]);
  // Measured on the real label of 2026-10-20: two of eight preparations read the 7 as "/".
  expect(ordersFromText('1/6889923\nDQ40/71 001\nB14\nUSM 9.5', 'alias').map((o) => o.order_number)).toEqual(['176889923']);
  // A lone 9-digit line is NOT taken from a picture that isn't a packing label.
  expect(ordersFromText('Call us\n176889923\nThanks')).toEqual([]);
  // A StockX screen: its shape, even with a stray space and an O for a 0.
  expect(ordersFromText('Order Details\nOrder number: 1234567O - 87654321\nShips via UPS 1Z3YY4081218923258')
    .map((o) => [o.order_number, o.platform])).toEqual([['12345670-87654321', 'stockx']]);
  // "Order #" on its own line, the number on the next.
  expect(ordersFromText('ORDER #\nPO-211-0098765\nTotal $120.00').map((o) => o.order_number)).toEqual(['PO-211-0098765']);
  // A SHEIN order number keeps its letters (an O stays an O), and is SHEIN by its shape.
  expect(ordersFromText('Order No.: GSON8F44T00000N\nUPS 1Z3YY4080307722977').map((o) => [o.order_number, o.platform])).toEqual([['GSON8F44T00000N', 'shein']]);
  // A FedEx label for an eBay sale prints no order number: phone, REF and TRK# are not one.
  expect(ordersFromText('FROM (717) 368-3333\n19173877468\nREF: 8173017869\nTRK# 8787 7611 2569\n9632 0019 6')).toEqual([]);
  // Two orders → no style code / size / name pinned on either.
  const two = ordersFromText('12-34567-89012\n98-76543-21098\nDD1391 100\nUS 9');
  expect(two.map((o) => [o.order_number, o.platform, o.sku])).toEqual([['12-34567-89012', 'ebay', null], ['98-76543-21098', 'ebay', null]]);
});

test('the shoe name on a label is taken only when it reads whole; tracking numbers are read for the lookup', () => {
  expect(labelProduct(['ITEM', "Nike Free Run 5.0 'Phantom Sail'", 'TRACKING'])).toBe("Nike Free Run 5.0 'Phantom Sail'");
  expect(labelProduct(['ke Air Max 90 A', '176889923'])).toBe(null);                    // a cut-off name: blank, never half
  expect(labelProduct(["Nike Air Max 90 'Anthracite Team Red'", '176889923'])).toBe("Nike Air Max 90 'Anthracite Team Red'");
  expect(labelProduct(['ITEM', 'UPS 1Z3YY4081218923258'])).toBe(null);                   // a tracking line is not a name
  expect(labelProduct(['ITEM', 'Nike Air Max 90 "Anthracite Team Red"'])).toBe("Nike Air Max 90 'Anthracite Team Red'"); // OCR read the quote as " (Linux CI)
  expect(labelProduct(['Nike Dunk Low “Panda”', '176889923'])).toBe("Nike Dunk Low 'Panda'");
  expect(trackingFromText('UPS 1Z3YY4081218923258\nTRK# 8790 6081 3551\n9632 0019 6 000 | 0 00 8790 6081 3551'))
    .toEqual(['1Z3YY4081218923258', '879060813551']);
});

test('a read number is put right only when ONE of our orders is a single letter-for-digit slip away', () => {
  expect(confusableKeys('GS0N1')).toEqual(expect.arrayContaining(['GSON1', 'G50N1', '6S0N1', 'GS0NI', 'GS0NL']));
  expect(confusableKeys('1234')).not.toContain('7234');                                   // never digit for digit
  const k = (order_id, platform = 'shein') => ({ key: order_id.replace(/[^A-Z0-9]/g, ''), order_id, platform, source: platform, lines: [] });
  expect(matchOurOrder('GS0N12345678X', null, [k('GSON12345678X')])).toMatchObject({ corrected: true, order: { order_id: 'GSON12345678X' } });
  expect(matchOurOrder('GSON12345678X', null, [k('GSON12345678X'), k('GS0N12345678X')])).toMatchObject({ corrected: false });   // exact wins
  expect(matchOurOrder('GS1N12345678X', null, [k('GSIN12345678X'), k('GSLN12345678X')])).toBe(null);                        // two close: no guess
  expect(matchOurOrder('GS0N12345678X', 'alias', [k('GSON12345678X')])).toBe(null);                                         // another platform's
  expect(matchOurOrder('206557031', null, [k('206557037', 'alias')])).toBe(null);                                           // 1/7: not a slip we fix
  // The shoe from our order: one line, or the line the photo points at, else all of them.
  const two = { lines: [{ name: 'Dunk', sku: 'DD1391-100', size: '9.5' }, { name: 'Dunk', sku: 'DD1391-100', size: '10' }] };
  expect(detailsFromOrder(two, { size: 'US M 10' })).toEqual({ product: 'Dunk', sku: 'DD1391-100', size: '10' });
  expect(detailsFromOrder(two, {})).toEqual({ product: 'Dunk', sku: 'DD1391-100', size: '9.5 + 10' });
  // Typed after the number: SKU, size, then the reason.
  expect(typedDetails('DD1391-100 9.5 customer asked')).toEqual({ sku: 'DD1391-100', size: '9.5', reason: 'customer asked' });
  expect(typedDetails('9.5 - wrong size')).toEqual({ sku: null, size: '9.5', reason: 'wrong size' });
  expect(typedDetails('- called 2 times')).toEqual({ sku: null, size: null, reason: 'called 2 times' });
});

test('the batch reply: one list per platform, then what needs a person', () => {
  expect(batchReplyText([
    { n: 1, rows: [{ platform: 'alias', order_number: '206557037', product: "Nike Free Run 5.0 'Phantom Sail'", sku: 'CZ1884-010', size: 'US M 8.5' }] },
    { n: 2, rows: [{ platform: 'alias', order_number: '176889923', sku: 'DQ4071-001', size: '9.5', read_as: '176889923' }] },
    { n: 3, rows: [{ platform: 'alias', order_number: null }] },
    { n: 4, rows: [], dupes: [{ order_number: '300000001', existing: { id: 12, sent_by: 'Karon' } }] },
    { n: 5, error: 'could not download the picture (HTTP 500)' },
  ])).toBe([
    'Alias · 2 orders recorded',
    "1. #206557037 — Nike Free Run 5.0 'Phantom Sail' · CZ1884-010 · size 8.5",
    '2. #176889923 — DQ4071-001 · size 9.5 (read as 176889923)',
    '',
    "⚠️ Photo 3: no order number found — it's kept with the photo. Type it: /alias 123456789 (it fills that photo's row)",
    '⚠️ Photo 5: not saved (could not download the picture (HTTP 500)) — send it again.',
    '↩️ #300000001 is already logged as #12 by Karon — not added again',
  ].join('\n'));
  // EST days for the page's periods.
  expect(periodDays('today', '2026-03-01')).toEqual({ from: '2026-03-01', to: '2026-03-01' });
  expect(periodDays('yesterday', '2026-03-01')).toEqual({ from: '2026-02-28', to: '2026-02-28' });
  expect(periodDays('7', '2026-03-01')).toEqual({ from: '2026-02-23', to: '2026-03-01' });
  expect(periodDays('range', '2026-03-01', '2026-02-10', '2026-02-01')).toEqual({ from: '2026-02-01', to: '2026-02-10' });
  expect(periodDays('all', '2026-03-01')).toEqual({ from: null, to: null });
  expect(cancellationsCsv([{ id: 1, platform: 'alias', order_number: '1', details_from: 'ebay,catalogue', created_at: '2026-08-21T03:30:00Z' }]))
    .toContain('2026-08-20');                                                             // 23:30 EDT is the 20th
});

// ── One reply per batch ─────────────────────────────────────────────────────────────
test('separate photos sent together → ONE reply, under the first photo, listing every order', async ({ request }) => {
  sent.length = 0;
  const s = String(Date.now()).slice(-6);
  const a = `9911${s}1`; const b = `9911${s}2`;
  await hook(request, { from: TG_WH, body: { text: '/alias' } });
  await lastSaid(TG_WH);
  sent.length = 0;
  const f1 = await picture(`cx-b1-${s}`, read({ order_number: a, sku: 'DD1391-100', size: '9.5', product: "Nike Dunk Low 'Panda'" }));
  const f2 = await picture(`cx-b2-${s}`, read({ order_number: b }));
  const f3 = await picture(`cx-b3-${s}`, 'fail');                     // nothing readable
  const first = await hook(request, photo(TG_WH, f1));
  await hook(request, photo(TG_WH, f2));
  await hook(request, photo(TG_WH, f3));
  const said = await lastSaid(TG_WH);
  await new Promise((r) => setTimeout(r, 2500));                       // …and nothing else comes
  expect(saidTo(TG_WH)).toHaveLength(1);
  expect(saidTo(TG_WH)[0].reply_parameters.message_id).toBe(first);
  expect(said).toBe([
    '[dev] Alias · 2 orders recorded',
    `1. #${a} — Nike Dunk Low 'Panda' · DD1391-100 · size 9.5`,
    `2. #${b} — no shoe details found`,
    '',
    "⚠️ Photo 3: no order number found (the reader did not answer (HTTP 500)) — it's kept with the photo. Type it: /alias 123456789 (it fills that photo's row)",
  ].join('\n'));
  const rows =(await list(request)).rows.filter((r) => r.sent_by === WH.name);
  expect(rows.find((r) => r.order_number === a)).toMatchObject({ status: 'to_review', platform: 'alias', product: "Nike Dunk Low 'Panda'", details_from: 'label' });
  const blank = rows.find((r) => !r.order_number && r.platform === 'alias');
  expect(blank.photo_id).toBeTruthy();

  // "Type it": the number fills that photo's row — one row, photo and number together.
  const c = `9911${s}3`;
  await hook(request, { from: TG_WH, body: { text: `/alias ${c} DD1391-100 10` } });
  expect(await lastSaid(TG_WH, 2)).toContain(`(Filled the photo row #${blank.id} that had no order number.)`);
  const filled = (await list(request)).rows.find((r) => r.id === blank.id);
  expect(filled).toMatchObject({ order_number: c, sku: 'DD1391-100', size: '10', photo_id: blank.photo_id });

  // The same order on a later photo: answered, not recorded again.
  const f4 = await picture(`cx-b4-${s}`, read({ order_number: a }));
  await hook(request, photo(TG_WH, f4));
  expect(await lastSaid(TG_WH, 3)).toMatch(new RegExp(`↩️ #${a} is already logged as #\\d+ by ${WH.name} — not added again`));
  expect((await list(request)).rows.filter((r) => r.order_number === a)).toHaveLength(1);

  // Telegram re-sending the SAME update records nothing and says nothing more.
  const f5 = await picture(`cx-b5-${s}`, read({ order_number: `E2ECX${s}` }));
  const again = photo(TG_WH, f5);
  const id5 = await hook(request, again);
  await lastSaid(TG_WH, 4);
  await hook(request, { ...again, id: id5 });
  await new Promise((r) => setTimeout(r, 2500));
  expect(saidTo(TG_WH)).toHaveLength(4);
  expect((await list(request)).rows.filter((r) => r.order_number === `E2ECX${s}`)).toHaveLength(1);
  await q(`DELETE FROM cancellation_tg_ctx WHERE key LIKE 'chat:%7710001'`);
});

test('an album (caption on one photo) is one batch, one reply, on the caption\'s platform', async ({ request }) => {
  sent.length = 0;
  const s = String(Date.now()).slice(-6);
  const mg = `mg${Date.now()}`;
  const f1 = await picture(`cx-al1-${s}`, read({ order_number: `9911${s}5` }));
  const f2 = await picture(`cx-al2-${s}`, read({ order_number: `9911${s}6` }));
  const first = await hook(request, photo(TG_WH, f1, null, { media_group_id: mg }));
  await hook(request, photo(TG_WH, f2, '/tiktok customer asked', { media_group_id: mg }));
  const said = await lastSaid(TG_WH);
  await new Promise((r) => setTimeout(r, 2500));
  expect(saidTo(TG_WH)).toHaveLength(1);
  expect(saidTo(TG_WH)[0].reply_parameters.message_id).toBe(first);
  expect(said).toMatch(/^\[dev\] TikTok Shop · 2 orders recorded\n/);
  const rows = (await list(request)).rows.filter((r) => [`9911${s}5`, `9911${s}6`].includes(r.order_number));
  expect(rows.map((r) => r.platform)).toEqual(['tiktok', 'tiktok']);
});

// ── The shoe from OUR orders ───────────────────────────────────────────────────────────
test('our own eBay / SHEIN / pre-sell orders give the shoe by number; one letter-for-digit slip is put right only with one candidate', async ({ request }) => {
  sent.length = 0;
  const s = String(Date.now()).slice(-5);
  const ebayNo = `27-${s}-${s}`;
  await q(`INSERT INTO shopify_listing_variants (variant_id, product_title, sku, size, style) VALUES ('e2e-cx-v1', $1, 'E2ECX-SHOP-1', '9.5', 'DD1391-100')`, ["Nike Dunk Low Retro 'Panda'"]);
  await q(`INSERT INTO ebay_orders (order_id, created_at, buyer, lines) VALUES ($1, now(), 'e2e-cx', $2::jsonb)`,
    [ebayNo, JSON.stringify([{ title: 'Nike Dunk Low Panda Men 9.5 DD1391-100', sku: 'E2ECX-SHOP-1', size: null, qty: 1 }])]);
  const shein = `GSON${s}K00E2E`;           // the reader will see a 0 for the O
  const twinA = `GSIN${s}K00E2E`; const twinB = `GSLN${s}K00E2E`;   // read "GS1N…": two candidates
  await q(`INSERT INTO shein_order_units (goods_id, order_no, seller_sku, title, note) VALUES ($1, $2, 'E2ECX-SH-1', 'SHEIN Jordan title', 'e2e-cx'),
                                                                                        ($3, $4, 'E2ECX-SH-2', 'Twin A', 'e2e-cx'),
                                                                                        ($5, $6, 'E2ECX-SH-3', 'Twin B', 'e2e-cx')`,
  [`e2e-cx-g1-${s}`, shein, `e2e-cx-g2-${s}`, twinA, `e2e-cx-g3-${s}`, twinB]);
  const [{ id: stockId }] = await q(`INSERT INTO presell_stock (sku, name, size, qty, created_by) VALUES ($1, 'E2E Cx Presell Shoe', '10', 1, 'e2e-cx') RETURNING id`, [`CX${s}-001`]);
  const pre = `9911${s}77`;
  await q(`INSERT INTO presell_sales (stock_id, platform, order_id, raw) VALUES ($1, 'alias', $2, '{"e2e":"cx"}')`, [stockId, pre]);

  const fE = await picture(`cx-e-${s}`, read({ order_number: ebayNo }));
  await hook(request, photo(TG_WH, fE, '/ebay'));
  expect(await lastSaid(TG_WH)).toContain(`#${ebayNo} — Nike Dunk Low Retro 'Panda' · DD1391-100 · size 9.5`);
  const fS = await picture(`cx-s-${s}`, read({ order_number: `GS0N${s}K00E2E` }));
  await hook(request, photo(TG_WH, fS, '/shein'));
  expect(await lastSaid(TG_WH, 2)).toContain(`#${shein} — SHEIN Jordan title (read as GS0N${s}K00E2E)`);
  const fT = await picture(`cx-t-${s}`, read({ order_number: `GS1N${s}K00E2E` }));
  await hook(request, photo(TG_WH, fT, '/shein'));
  expect(await lastSaid(TG_WH, 3)).toContain(`#GS1N${s}K00E2E — no shoe details found`);
  const fP = await picture(`cx-p-${s}`, read({ order_number: pre }));
  await hook(request, photo(TG_WH, fP, '/alias'));
  expect(await lastSaid(TG_WH, 4)).toContain(`#${pre} — E2E Cx Presell Shoe · CX${s}-001 · size 10`);

  const rows = (await list(request)).rows;
  expect(rows.find((r) => r.order_number === ebayNo)).toMatchObject({ platform: 'ebay', order_match: 'ebay', details_from: 'ebay', sku: 'DD1391-100', size: '9.5' });
  const fixed = rows.find((r) => r.order_number === shein);
  expect(fixed).toMatchObject({ order_match: 'shein', product: 'SHEIN Jordan title' });
  expect(fixed.note).toMatch(/Read as GS0N.* one character off our SHEIN order/);
  expect(rows.find((r) => r.order_number === `GS1N${s}K00E2E`)).toMatchObject({ order_match: null, product: null });
  expect(rows.find((r) => r.order_number === pre)).toMatchObject({ order_match: 'presell', details_from: 'presell' });
  await q(`DELETE FROM cancellation_tg_ctx WHERE key LIKE 'chat:%7710001'`);
});

test('an eBay label with no order number is matched by its tracking number — the AI is never asked', async ({ page, request }) => {
  sent.length = 0; prompts.length = 0;
  const s = String(Date.now()).slice(-5);
  const ebayNo = `28-${s}-${s}`;
  const trk = `8790${s}551`;   // 12 digits
  await q(`INSERT INTO ebay_orders (order_id, created_at, buyer, lines, fulfillments) VALUES ($1, now(), 'e2e-cx', $2::jsonb, $3::jsonb)`,
    [ebayNo, JSON.stringify([{ title: "Air Jordan 4 'Bred Reimagined'", sku: 'E2ECX-SHOP-9', size: '11', qty: 1 }]),
      JSON.stringify([{ id: 'f1', number: trk, carrier: 'FEDEX' }])]);
  // A FedEx label like eBay's, drawn in the browser so the test needs no fonts on the server.
  await page.setViewportSize({ width: 600, height: 700 });
  await page.setContent(`<body style="margin:0;background:#fff;font-family:Arial,Helvetica,sans-serif">
    <div style="margin:40px;width:500px">
      <div style="font-size:22px">FROM: Alex (717) 368-3333</div>
      <div style="font-size:22px;margin-top:20px">MOONACHIE NJ 07074</div>
      <div style="font-size:22px">REF: 8181034599</div>
      <div style="font-size:30px;margin-top:60px">TRK# ${trk.slice(0, 4)} ${trk.slice(4, 8)} ${trk.slice(8)}</div>
    </div></body>`);
  const fileId = `cx-trk-${s}`;
  pictures.set(fileId, await sharp(await page.screenshot()).jpeg({ quality: 85 }).toBuffer());
  nextRead = 'fail';
  await hook(request, photo(TG_WH, fileId, '/ebay'));
  expect(await lastSaid(TG_WH)).toBe(`[dev] eBay · 1 order recorded\n1. #${ebayNo} — Air Jordan 4 'Bred Reimagined' · size 11 (found by its tracking number)`);
  expect(prompts).toHaveLength(0);
  expect((await list(request)).rows.find((r) => r.order_number === ebayNo)).toMatchObject({ order_match: 'ebay', platform: 'ebay' });
  await q(`DELETE FROM cancellation_tg_ctx WHERE key LIKE 'chat:%7710001'`);
});

test('a printed Alias label is read on our own server — number, SKU, size and the name line', async ({ page, request }) => {
  sent.length = 0; prompts.length = 0;
  const num = `9911${String(Date.now()).slice(-5)}`;
  // A label like Alias's, drawn in the browser so the test needs no fonts on the server.
  await page.setViewportSize({ width: 600, height: 900 });
  await page.setContent(`<body style="margin:0;background:#ddd;font-family:Arial,Helvetica,sans-serif">
    <div style="margin:40px;padding:40px;background:#fff;width:440px">
      <div style="font-size:14px">ITEM</div><div style="font-size:22px">Nike Air Max 90 'Anthracite Team Red'</div>
      <div style="font-size:11px;margin-top:14px">TRACKING</div><div style="font-size:18px">UPS 1Z3YY4081218923258</div>
      <div style="font-size:11px;margin-top:30px">ORDER #</div><div style="font-size:34px">${num}</div>
      <div style="font-size:11px;margin-top:30px">SKU</div><div style="font-size:34px">DQ4071 001</div>
      <div style="font-size:11px;margin-top:30px">SIZE</div><div style="font-size:34px">US M 9.5</div>
    </div></body>`);
  const fileId = `cx-ocr-${num}`;
  pictures.set(fileId, await sharp(await page.screenshot()).jpeg({ quality: 85 }).toBuffer());
  nextRead = 'fail';   // were the AI asked, the row would come out unreadable
  await hook(request, photo(TG_WH, fileId, '/alias customer asked'));
  expect(await lastSaid(TG_WH)).toBe(`[dev] Alias · 1 order recorded\n1. #${num} — Nike Air Max 90 'Anthracite Team Red' · DQ4071-001 · size 9.5`);
  const row = (await list(request)).rows.find((r) => r.order_number === num);
  expect(row).toMatchObject({ platform: 'alias', sku: 'DQ4071-001', size: 'US M 9.5', reason: 'customer asked', details_from: 'label' });
  expect(prompts).toHaveLength(0);
  const [raw] = await q('SELECT ai_raw FROM cancellations WHERE id = $1', [row.id]);
  // One label = one order whatever tesseract does: both reads agree, or the second misread ONE
  // digit (CI read "#991…" as "#091…", 2026-11-13) and that is kept as "Second read said …" on
  // this row instead of filing a second cancellation (mergeReads in api/_lib/cancelOcr.js).
  expect(raw.ai_raw).toMatchObject({ by: 'ocr' });
  if (raw.ai_raw.agreed !== true) expect(raw.ai_raw.other).toMatch(/^\d+$/);
  expect(raw.ai_raw.text).toContain(num);
  await q(`DELETE FROM cancellation_tg_ctx WHERE key LIKE 'chat:%7710001'`);
});

test('a style code with no name on the photo is named from our catalogue; a typed number with SKU and size', async ({ request }) => {
  sent.length = 0;
  const s = String(Date.now()).slice(-6);
  await q(`INSERT INTO products (sku, size, name, source) VALUES ('ZX9911-001', '9', 'E2E Cx Catalogue Shoe', 'e2e-cx')`);
  const n = `9911${s}8`;
  await hook(request, { from: TG_WH, body: { text: `/alias ${n} ZX9911 001 9 - wrong size` } });
  expect(await lastSaid(TG_WH)).toBe(`[dev] Alias · 1 order recorded\n1. #${n} — E2E Cx Catalogue Shoe · ZX9911-001 · size 9`);
  expect((await list(request)).rows.find((r) => r.order_number === n)).toMatchObject({ source: 'typed', reason: 'wrong size', details_from: 'typed,catalogue' });
  await q(`DELETE FROM cancellation_tg_ctx WHERE key LIKE 'chat:%7710001'`);
});

test('two reads that disagree still record the number, with what the second read saw', async ({ request }) => {
  sent.length = 0;
  const a = `9911${String(Date.now()).slice(-6)}`; const b = `${a.slice(0, -1)}${(Number(a.at(-1)) + 1) % 10}`;
  const f = await picture(`cx-d-${a}`, [read({ platform: 'alias', order_number: a, confidence: 0.98 }), read({ platform: 'alias', order_number: b, confidence: 0.98 })]);
  await hook(request, photo(TG_WH, f));
  expect(await lastSaid(TG_WH)).toContain(`#${a}`);
  const row = (await list(request)).rows.find((r) => r.order_number === a);
  expect(row.note).toBe(`Second read said ${b}`);
});

test('an AI account with no credit left is said plainly, and the photo is still recorded', async ({ request }) => {
  sent.length = 0;
  const f = await picture(`cx-quota-${Date.now()}`, 'quota');
  await hook(request, photo(TG_WH, f));
  expect(await lastSaid(TG_WH)).toMatch(/This photo: no order number found \(the AI reader is out of credit \(OpenAI billing\) — tell an admin\)/);
});

test('a stranger is told to connect; a by-hand add refuses a duplicate; a removed number may come back', async ({ request }) => {
  sent.length = 0;
  const n = `${String(Date.now()).slice(-8)}-${String(Date.now()).slice(-8)}`;
  await hook(request, { from: TG_WH, body: { text: `${n} - customer asked` } });
  expect(await lastSaid(TG_WH)).toMatch(new RegExp(`StockX · 1 order recorded\\n1\\. #${n}`));
  const row = (await list(request)).rows.find((r) => r.order_number === n);
  expect(row).toMatchObject({ platform: 'stockx', source: 'typed', reason: 'customer asked', photo_id: null });

  await hook(request, { from: TG_WH, body: { text: 'hello' } });
  expect(await lastSaid(TG_WH, 2)).toMatch(/send the platform, then the photo\(s\)[\s\S]*\/sg Stadium Goods · \/kc Kicks Crew/);
  await hook(request, photo(TG_STRANGER, await picture('cx-stranger')));
  expect(await lastSaid(TG_STRANGER)).toMatch(/connect this chat first/);

  const dup = await request.post('/api/cancellations/save', { headers: auth('warehouse'), data: { platform: 'stockx', order_number: n } });
  expect(dup.status()).toBe(409);
  expect((await dup.json()).error).toMatch(new RegExp(`already logged as #${row.id}`));
  // The warehouse can fix a row (no review step) but not remove someone else's.
  const fix = await request.post('/api/cancellations/save', { headers: auth('warehouse'), data: { id: row.id, platform: 'stockx', order_number: n, size: '10' } });
  expect((await fix.json()).row).toMatchObject({ size: '10', details_from: 'edited' });
  expect((await request.post('/api/cancellations/action', { headers: auth('warehouse'), data: { id: row.id, action: 'remove', reason: 'x' } })).status()).toBe(403);
  const rm = await request.post('/api/cancellations/action', { headers: auth('ph_team'), data: { id: row.id, action: 'remove', reason: 'sent twice' } });
  expect(rm.ok()).toBeTruthy();
  expect((await list(request)).rows.some((r) => r.id === row.id)).toBe(false);
  expect((await request.post('/api/cancellations/save', { headers: auth('warehouse'), data: { platform: 'stockx', order_number: n } })).ok()).toBeTruthy();
});

test('/sg in the caption names the platform (over the reader\'s guess); /kc first, then a photo; an unknown command records nothing', async ({ request }) => {
  sent.length = 0; prompts.length = 0;
  const n = `9911${String(Date.now()).slice(-7)}`;
  await hook(request, photo(TG_WH, await picture(`cx-sg-${n}`, read({ platform: 'stockx', order_number: n })), '/sg box damaged'));
  expect(await lastSaid(TG_WH)).toMatch(new RegExp(`Stadium Goods · 1 order recorded\\n1\\. #${n}`));
  expect(prompts.some((p) => p.includes('The sender says these orders are from Stadium Goods'))).toBe(true);
  expect((await list(request)).rows.find((r) => r.order_number === n)).toMatchObject({ platform: 'sg', reason: 'box damaged' });

  await hook(request, { from: TG_WH, body: { text: '/kc' } });
  expect(await lastSaid(TG_WH, 2)).toMatch(/Kicks Crew — send the photo\(s\) now/);
  const n1 = `9911${String(Date.now()).slice(-7)}1`;
  await hook(request, photo(TG_WH, await picture(`cx-kc-${n1}`, read({ order_number: n1 }))));
  expect(await lastSaid(TG_WH, 3)).toMatch(new RegExp(`Kicks Crew · 1 order recorded\\n1\\. #${n1}`));

  const before = (await list(request)).rows.length;
  await hook(request, photo(TG_WH, await picture(`cx-unk-${n1}`), '/goat'));
  expect(await lastSaid(TG_WH, 4)).toMatch(/"\/goat" isn't one of the platforms/);
  await new Promise((r) => setTimeout(r, 800));
  expect((await list(request)).rows.length).toBe(before);
  await q(`DELETE FROM cancellation_tg_ctx WHERE key LIKE 'chat:%7710001'`);
});

test('the cancellations group: photos and commands are recorded, chatter (even a number) is ignored', async ({ request }) => {
  sent.length = 0;
  const n = `9911${String(Date.now()).slice(-7)}`;
  await hook(request, { from: TG_WH, chat: GROUP, body: { text: `call me ${n}` } });
  await hook(request, { from: TG_WH, chat: GROUP, body: { text: n } });
  await new Promise((r) => setTimeout(r, 800));
  expect(saidTo(GROUP)).toHaveLength(0);
  expect((await list(request)).rows.some((r) => r.order_number === n)).toBe(false);

  // "/alias@Bot" then a photo — Telegram appends the bot's name to a command in a group.
  await hook(request, { from: TG_WH, chat: GROUP, body: { text: '/alias@StickballBot' } });
  expect(await lastSaid(GROUP)).toMatch(/Alias — send the photo/);
  const pid = await hook(request, { from: TG_WH, chat: GROUP, body: { photo: [{ file_id: await picture(`cx-grp-${n}`, read({ order_number: n })) }] } });
  expect(await lastSaid(GROUP, 2)).toMatch(new RegExp(`Alias · 1 order recorded\\n1\\. #${n}`));
  expect(saidTo(GROUP).at(-1).reply_parameters.message_id).toBe(pid);
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
    await hook(request, photo(TG_WH, await picture(`cx-fail-${Date.now()}`), '/alias'));
    expect(await lastSaid(TG_WH)).toMatch(/That wasn't logged — something went wrong on our side/);
  } finally {
    await q('ALTER TABLE cancellation_tg_ctx_off RENAME TO cancellation_tg_ctx');
  }
});

test('a restart mid-batch: the sweep re-reads what never finished and answers once', async () => {
  sent.length = 0;
  const { sweepCancellationPhotos } = await import('../api/_lib/cancellations.js');
  const s = String(Date.now()).slice(-6);
  // A photo already read and recorded, never answered (the process died in the quiet window) …
  const [{ id: p1 }] = await q(`INSERT INTO cancellation_photos (tg_chat_id, tg_message_id, tg_file_id, sent_by_user_id, sent_by, read_status, created_at)
    VALUES ($1, $2, 'cx-sw-1', $3, $4, 'read', now() - interval '3 minutes') RETURNING id`, [TG_WH, 990000 + Number(s.slice(-3)), whUid, WH.name]);
  const [{ id: r1 }] = await q(`INSERT INTO cancellations (status, platform, order_number, order_key, photo_id, sent_by_user_id, sent_by, source)
    VALUES ('to_review', 'alias', $1, $1, $2, $3, $4, 'telegram') RETURNING id`, [`9911${s}9`, p1, whUid, WH.name]);
  await q(`UPDATE cancellation_photos SET result = $1::jsonb WHERE id = $2`, [JSON.stringify({ rows: [{ id: Number(r1) }], dupes: [] }), p1]);
  // … and one whose read never finished (still 'pending', 4 minutes old).
  await picture('cx-sw-2');
  await q(`INSERT INTO cancellation_photos (tg_chat_id, tg_message_id, tg_file_id, platform, sent_by_user_id, sent_by, created_at)
    VALUES ($1, $2, 'cx-sw-2', 'alias', $3, $4, now() - interval '4 minutes')`, [TG_WH, 990500 + Number(s.slice(-3)), whUid, WH.name]);

  const out = await sweepCancellationPhotos();
  expect(out).toMatchObject({ reread: 1, answered: 1 });
  expect(saidTo(TG_WH)).toHaveLength(1);
  expect(saidTo(TG_WH)[0].reply_parameters.message_id).toBe(990000 + Number(s.slice(-3)));
  expect(saidTo(TG_WH)[0].text).toMatch(new RegExp(`Alias · 1 order recorded\\n1\\. #9911${s}9[\\s\\S]*Photo 2: no order number found`));
  // A second sweep finds nothing to say.
  expect(await sweepCancellationPhotos()).toMatchObject({ reread: 0, answered: 0 });
  expect(saidTo(TG_WH)).toHaveLength(1);
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
  await ins('alias', '206557037', 'DQ4071-001', '9.5', 'verified', at(`${DAY} 23:30`));   // an old reviewed row: still listed
  await ins('stockx', '11223344-55667788', null, null);
  await ins('alias', '300000001', 'X', '9', 'rejected');                      // removed: never listed
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
  await tap(request, TG_STRANGER, GROUP, picker.reply_markup.inline_keyboard[0][0].callback_data);
  expect(await lastSaid(GROUP, 3)).toMatch(/Connect this Telegram first/);

  for (const [k, text] of [[1, `/msgall ${DAY}`], [2, `/msg-all ${DAY}`]]) {
    await hook(request, { from: TG_WH, body: { text } });
    expect(await lastSaid(TG_WH, k)).toBe('[dev] Alias\nPlease cancel the following order(s):\n#176889923 - CZ1884-010 size 8.5\n#206557037 - DQ4071-001 size 9.5'
      + '\n\nStockX\nPlease cancel the following order(s):\n#11223344-55667788'
      + '\n\n⚠️ Not listed: 1 with no order number yet — fix them on the Cancellations page, then ask again.');
  }

  await hook(request, { from: TG_WH, body: { text: `/report ${DAY}` } });
  await expect.poll(() => docs.length).toBe(1);
  expect(docs[0]).toContain(`filename="cancellations-${DAY}.csv"`);
  expect(docs[0]).toContain('176889923');
  expect(docs[0]).not.toContain('300000001');      // a removed row is not in the record
  expect(docs[0]).not.toContain('555000111');      // …and only that day's
  await hook(request, { from: TG_WH, body: { text: '/report someday' } });
  expect(await lastSaid(TG_WH, 3)).toMatch(/Which day\?/);
  await q(`DELETE FROM cancellations WHERE sent_by = 'E2E Cx shift'`);
});

// ── The page, from Manila: EST days ──────────────────────────────────────────────────
test.describe('the page, seen from PH time', () => {
  test.use({ timezoneId: 'Asia/Manila' });

  test('platform chips, EST "Today" / "Yesterday", the "No order # read" filter, and typing a number in', async ({ page }) => {
    const s = String(Date.now()).slice(-6);
    // Today (EST, now) and yesterday (EST 23:00 — already "today" in Manila and in UTC).
    const yest = `((date_trunc('day', now() AT TIME ZONE 'America/New_York') - interval '1 hour') AT TIME ZONE 'America/New_York')`;
    const ins = (platform, num, when, extra = {}) => q(
      `INSERT INTO cancellations (status, platform, order_number, order_key, product, sku, size, sent_by, source, created_at)
       VALUES ('to_review', $1, $2, $3, $4, $5, $6, 'E2E Cx page', 'app', ${when}) RETURNING id`,
      [platform, num, num ? num.replace(/[^0-9A-Z]/gi, '') : null, extra.product || null, extra.sku || null, extra.size || null]);
    await ins('alias', `E2ECX${s}A`, 'now()', { product: "Nike Dunk Low 'Panda'", sku: 'DD1391-100', size: '9.5' });
    await ins('stockx', `E2ECX${s}S`, 'now()');
    const [{ id: missingId }] = await ins('alias', null, 'now()');
    await ins('ebay', `E2ECX${s}Y`, yest);

    await loginAs(page, 'ph_team');
    await page.goto('/ph/cancellations');
    const row = (text) => page.locator('.cx-row').filter({ hasText: text });
    await expect(row(`E2ECX${s}A`)).toHaveCount(1);
    await expect(row(`E2ECX${s}A`)).toContainText("Nike Dunk Low 'Panda'");
    await expect(row(`E2ECX${s}A`)).toContainText('DD1391-100');
    await expect(row(`E2ECX${s}Y`)).toHaveCount(0);              // yesterday EST, though "today" in Manila
    await expect(page.locator('.cx-span')).toContainText(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date()));

    await page.getByRole('tab', { name: /^StockX \(\d+\)$/ }).click();
    await expect(row(`E2ECX${s}S`)).toHaveCount(1);
    await expect(row(`E2ECX${s}A`)).toHaveCount(0);
    await page.getByRole('tab', { name: /^All \(\d+\)$/ }).click();

    await page.getByLabel('Period').selectOption('yesterday');
    await expect(row(`E2ECX${s}Y`)).toHaveCount(1);
    await expect(row(`E2ECX${s}A`)).toHaveCount(0);
    await page.getByLabel('Period').selectOption('today');

    // The row with no order number stands out, has its own filter, and a person types it in.
    await page.getByRole('button', { name: /No order # read \(\d+\)/ }).click();
    const blank = page.locator(`.cx-row[data-id="${missingId}"]`);
    await expect(blank).toHaveClass(/cx-missing/);
    await expect(row(`E2ECX${s}A`)).toHaveCount(0);
    await blank.getByRole('button', { name: /Type the order #/ }).click();
    await blank.getByPlaceholder('as printed on the photo').fill(`E2ECX${s}M`);
    await blank.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('status')).toContainText(`#${missingId} saved`);
    await page.getByRole('button', { name: /No order # read/ }).click();
    await expect(row(`E2ECX${s}M`)).toHaveCount(1);
    await expect(row(`E2ECX${s}M`)).not.toHaveClass(/cx-missing/);

    // Search by order #.
    await page.getByLabel('Search').fill(`e2ecx${s}s`);
    await expect(page.locator('.cx-row')).toHaveCount(1);
    await q(`DELETE FROM cancellations WHERE sent_by = 'E2E Cx page'`);
  });
});

test('two reads: a one-digit misread is the same order; two real numbers both read stay two (pure)', async () => {
  const { mergeReads } = await import('../api/_lib/cancelOcr.js');
  const o = (n) => ({ platform: 'alias', order_number: n });
  // The misread CI hit: one order, flagged, the other reading kept.
  const one = mergeReads([o('991138546')], [o('091138546')]);
  expect(one).toHaveLength(1);
  expect(one[0]).toMatchObject({ order_number: '991138546', agreed: false, other: '091138546' });
  // Both reads agree.
  expect(mergeReads([o('991138546')], [o('991138546')])).toEqual([expect.objectContaining({ agreed: true })]);
  // Consecutive orders on one photo, the second read saw both: both filed.
  const two = mergeReads([o('991138546')], [o('991138546'), o('991138547')]);
  expect(two.map((x) => x.order_number)).toEqual(['991138546', '991138547']);
  expect(two[1]).toMatchObject({ onlySecond: true, agreed: false });
  // Two characters apart is not a misread: filed separately.
  expect(mergeReads([o('991138546')], [o('091138547')])).toHaveLength(2);
  // No second read at all.
  expect(mergeReads([o('991138546')], null)).toEqual([expect.objectContaining({ agreed: null })]);
});
