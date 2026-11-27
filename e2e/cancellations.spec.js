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
  batchReplyText, periodDays, cancellationsCsv, rowStatus, flagsFor, splitCommand, extractImageFile, pickerKeyboard,
  platformFromText, slipDetails, platformFromNumber, canonKey, plainFromHtml,
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
const edits = [];         // editMessageText bodies
const copies = [];        // sendPhoto / sendDocument bodies that send a picture back by its file id
const reactions = [];     // setMessageReaction bodies
const answers = [];       // answerCallbackQuery bodies
let botMsgId = 800_000;   // the fake's message ids
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
      // A CSV report is a multipart upload; a picture sent back by its file id is plain JSON.
      if (method === 'sendDocument' && body.raw !== undefined) docs.push(raw);
      if ((method === 'sendPhoto' || method === 'sendDocument') && body.raw === undefined) { body.message_id = ++botMsgId; copies.push(body); }
      res.setHeader('content-type', 'application/json');
      if (method === 'getFile') return res.end(JSON.stringify({ ok: true, result: { file_id: body.file_id, file_path: `photos/${body.file_id}.jpg`, file_size: 1000 } }));
      // Every message the bot sends gets its own id (a tap and "Void Batch" find their photos
      // by the message they are on); edits and button answers are kept to assert on.
      if (method === 'sendMessage') { body.message_id = ++botMsgId; sent.push(body); }
      if (method === 'editMessageText') edits.push(body);
      if (method === 'answerCallbackQuery') answers.push(body);
      if (method === 'setMessageReaction') reactions.push(body);
      return res.end(JSON.stringify({ ok: true, result: { message_id: body.message_id || 1, chat: { id: body.chat_id } } }));
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
  await q(`DELETE FROM cancellations WHERE sent_by LIKE 'E2E Cx%' OR order_number LIKE 'E2ECX%' OR order_number LIKE '9911%' OR order_number LIKE 'PO-211-9911%' OR order_number LIKE 'GS%E2E'`);
  await q(`DELETE FROM cancellation_photos WHERE sent_by LIKE 'E2E Cx%'`);
  await q(`DELETE FROM cancellation_tg_ctx WHERE key LIKE 'chat:%7710001' OR key LIKE 'album:mg%'`);
  await q(`DELETE FROM ebay_orders WHERE buyer = 'e2e-cx'`);
  await q(`DELETE FROM shein_order_units WHERE note = 'e2e-cx'`);
  await q(`DELETE FROM presell_sales WHERE raw->>'e2e' = 'cx'`);
  await q(`DELETE FROM presell_stock WHERE created_by = 'e2e-cx'`);
  await q(`DELETE FROM shopify_listing_variants WHERE variant_id LIKE 'e2e-cx-%'`);
  await q(`DELETE FROM products WHERE source = 'e2e-cx'`);
  await q(`DELETE FROM shopify_order_index WHERE channel = 'e2e-cx'`);
  await q(`DELETE FROM app_settings WHERE key = 'shopify_order_index_sync' AND updated_by = 'e2e-cx'`);
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
const tap = (request, from, chat, data, on = {}) => request.post('/api/telegram/webhook', {
  headers: { 'x-telegram-bot-api-secret-token': SECRET },
  data: { update_id: ++msgId, callback_query: { id: `cq${msgId}`, data, from: { id: from },
    message: { message_id: on.message_id || 1, ...(on.text ? { text: on.text } : {}), chat: chat ? { id: chat, type: 'supergroup' } : { id: from, type: 'private' } } } },
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
  ], { link: 'https://app.example/cancellations' })).toBe([
    '5 photos · 2 recorded · 1 to check · 1 needs a number · 1 not saved · 1 already logged',
    '',
    '❌ <b>No order number · Alias · 1 photo</b>',
    'Photo 3',
    'Type the number on the Cancellations page, or send the photo again.',
    '',
    '❌ <b>Not saved · Photo 5</b>',
    'Could not download the picture (HTTP 500). Send it again.',
    '',
    '⚠️ <b>Check 1</b>',
    '<code>176889923</code> · Alias · DQ4071-001 · 9.5 · read as 176889923',
    '',
    '✅ <b>Alias · 1</b>',
    "<code>206557037</code> · CZ1884-010 · 8.5 · Nike Free Run 5.0 'Phantom…",
    '',
    '↩️ <code>300000001</code> already logged as #12 by Karon',
    '',
    'Fix on the page: https://app.example/cancellations',
  ].join('\n'));
  // Seven photos missed for one reason are ONE block listing them — the reason said once.
  const why = "The order number is the barcode, and it can't be read at this size";
  const seven = batchReplyText([1, 2, 3, 4, 5, 7, 9].map((k) => ({ n: k, rows: [{ platform: 'sg', order_number: null }], why, sentBack: true })));
  expect(seven).toBe([
    '7 photos · 0 recorded · 7 need a number',
    '',
    '❌ <b>No order number · Stadium Goods · 7 photos</b>',
    'Photos 1, 2, 3, 4, 5, 7, 9',
    `${why}.`,
    'Each is sent back below: reply to it with the number.',
    '',
    'Fix on the Cancellations page.',
  ].join('\n'));
  // What came off a label is escaped (the message is Telegram HTML), and what is fine is what
  // gets cut short when a batch is too long for one message — never what needs someone.
  expect(batchReplyText([{ n: null, rows: [{ platform: 'alias', order_number: '206557037', product: 'A <b>&</b> B', flags: [] }] }]))
    .toBe('✅ <b>Alias · 1</b>\n<code>206557037</code> · A &lt;b&gt;&amp;&lt;/b&gt; B');
  const long = batchReplyText([...Array.from({ length: 120 }, (_, i) => ({ n: i + 1, rows: [{ platform: 'alias', order_number: String(700000000 + i), sku: 'DD1391-100', size: '10', product: 'Nike Dunk Low Retro Panda Black White', flags: [] }] })),
    { n: 121, rows: [{ platform: 'alias', order_number: '176889923', flags: ['reads_disagree'] }] }]);
  expect(long.length).toBeLessThan(4000);
  expect(long).toContain('<code>176889923</code> · Alias · no shoe details · reads disagreed');
  expect(long).toMatch(/…and \d+ more, on the page/);
  // Too long even so (a hundred rows to check): cut at a line, so every tag sent is closed.
  const huge = batchReplyText(Array.from({ length: 150 }, (_, i) => ({ n: i + 1, rows: [{ platform: 'alias', order_number: String(700000000 + i), sku: 'DD1391-100', flags: ['reads_disagree'] }] })));
  expect(huge.length).toBeLessThan(4000);
  expect((huge.match(/<(b|code)>/g) || []).length).toBe((huge.match(/<\/(b|code)>/g) || []).length);
  // If Telegram ever refuses the HTML, the same words go out plain.
  expect(plainFromHtml('✅ <b>Alias · 1</b>\n<code>1</code> · A &lt;b&gt;&amp; B')).toBe('✅ Alias · 1\n1 · A <b>& B');
  // [OK] = both reads agreed or it is one of our orders; [CHECK] = a person compares it with
  // the photo; nothing to look at → no link.
  expect(rowStatus({ order_number: '1', flags: [] })).toEqual({ tag: 'OK', why: null });
  expect(rowStatus({ order_number: '1', flags: ['low_confidence', 'reads_disagree'] })).toEqual({ tag: 'CHECK', why: 'reads disagreed' });
  expect(rowStatus({ order_number: '1', flags: ['tie_break'] })).toEqual({ tag: 'CHECK', why: 'a third read decided' });
  expect(rowStatus({ order_number: null })).toEqual({ tag: 'MISSED', why: null });
  expect(flagsFor({ order_number: '206557037', platform: 'alias' }, { confidence: 0.99, agreed: true, byThird: true })).toEqual(['tie_break']);
  expect(batchReplyText([{ n: null, rows: [{ platform: 'alias', order_number: '206557037', flags: [] }] }], { link: 'x' }))
    .toBe('✅ <b>Alias · 1</b>\n<code>206557037</code> · no shoe details');
  // Commands: "/alias@Bot" in a group is "/alias"; what follows is the note.
  expect(splitCommand('/alias@StickballBot wrong size')).toEqual({ cmd: '/alias', platform: 'alias', rest: 'wrong size' });
  expect(splitCommand('/goat')).toEqual({ cmd: '/goat', platform: null, rest: '' });
  // The picture: the largest compressed size, or an image sent "as a file" (uncompressed).
  expect(extractImageFile({ photo: [{ file_id: 's', width: 90, height: 60 }, { file_id: 'L', width: 1280, height: 960 }, { file_id: 'm', width: 320, height: 240 }] }))
    .toMatchObject({ fileId: 'L', uncompressed: false });
  expect(extractImageFile({ document: { file_id: 'D', mime_type: 'image/png' } })).toMatchObject({ fileId: 'D', uncompressed: true });
  expect(extractImageFile({ document: { file_id: 'D', mime_type: 'application/pdf' } })).toBe(null);
  expect(pickerKeyboard().map((r) => r.map((b) => b.text))).toEqual([['Alias', 'StockX', 'eBay', 'SHEIN'], ['TikTok', 'Temu', 'SG', 'KC']]);
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
  // (The last line is where to check them: a link when APP_BASE_URL is set, the words otherwise.)
  // The totals, then what needs someone, then what is fine; every number tap-to-copy.
  expect(said.split('\n').slice(0, 10).join('\n')).toBe([
    '[dev] 3 photos · 2 recorded · 1 needs a number',
    '',
    '❌ <b>No order number · Alias · 1 photo</b>',
    'Photo 3',
    'The reader did not answer (HTTP 500).',
    'It is sent back below: reply to it with the number.',
    '',
    '✅ <b>Alias · 2</b>',
    `<code>${a}</code> · DD1391-100 · 9.5 · Nike Dunk Low 'Panda'`,
    `<code>${b}</code> · no shoe details`,
  ].join('\n'));
  expect(said).toMatch(/\n\nFix on the (page: \S+|Cancellations page\.)$/);
  expect(saidTo(TG_WH)[0].parse_mode).toBe('HTML');
  // The summary carries the way out for a batch sent on the wrong platform.
  expect(saidTo(TG_WH)[0].reply_markup.inline_keyboard.flat().map((x) => x.callback_data)).toEqual(['cxvoid']);
  const rows =(await list(request)).rows.filter((r) => r.sent_by === WH.name);
  expect(rows.find((r) => r.order_number === a)).toMatchObject({ status: 'to_review', platform: 'alias', product: "Nike Dunk Low 'Panda'", details_from: 'label' });
  const blank = rows.find((r) => !r.order_number && r.platform === 'alias');
  expect(blank.photo_id).toBeTruthy();

  // "Type it": the number fills that photo's row — one row, photo and number together.
  const c = `9911${s}3`;
  await hook(request, { from: TG_WH, body: { text: `/alias ${c} DD1391-100 10` } });
  expect(await lastSaid(TG_WH, 2)).toContain(`Filled the photo row #${blank.id} that had no order number.`);
  const filled = (await list(request)).rows.find((r) => r.id === blank.id);
  expect(filled).toMatchObject({ order_number: c, sku: 'DD1391-100', size: '10', photo_id: blank.photo_id });

  // The same order on a later photo: answered, not recorded again.
  const f4 = await picture(`cx-b4-${s}`, read({ order_number: a }));
  await hook(request, photo(TG_WH, f4));
  expect(await lastSaid(TG_WH, 3)).toMatch(new RegExp(`↩️ <code>${a}</code> already logged as #\\d+ by ${WH.name}`));
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
  expect(said).toMatch(/^\[dev\] 2 photos · 2 recorded\n\n✅ <b>TikTok Shop · 2<\/b>\n/);
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
  expect(await lastSaid(TG_WH)).toContain(`<code>${ebayNo}</code> · DD1391-100 · 9.5 · Nike Dunk Low Retro 'Panda'`);
  const fS = await picture(`cx-s-${s}`, read({ order_number: `GS0N${s}K00E2E` }));
  await hook(request, photo(TG_WH, fS, '/shein'));
  expect(await lastSaid(TG_WH, 2)).toContain(`<code>${shein}</code> · SHEIN · SHEIN Jordan title · read as GS0N${s}K00E2E`);
  const fT = await picture(`cx-t-${s}`, read({ order_number: `GS1N${s}K00E2E` }));
  await hook(request, photo(TG_WH, fT, '/shein'));
  expect(await lastSaid(TG_WH, 3)).toContain(`<code>GS1N${s}K00E2E</code> · no shoe details`);
  const fP = await picture(`cx-p-${s}`, read({ order_number: pre }));
  await hook(request, photo(TG_WH, fP, '/alias'));
  expect(await lastSaid(TG_WH, 4)).toContain(`<code>${pre}</code> · CX${s}-001 · 10 · E2E Cx Presell Shoe`);

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
  expect(await lastSaid(TG_WH)).toBe(`[dev] ✅ <b>eBay · 1</b>\n<code>${ebayNo}</code> · 11 · Air Jordan 4 'Bred Reimagin… · found by its tracking number`);
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
  // [OK] when the first two reads agree; [CHECK] when a third read had to decide (it does on
  // some CI fonts) — the number, the shoe, the SKU and the size are the same either way.
  expect(await lastSaid(TG_WH)).toMatch(new RegExp(`^\\[dev\\] (✅ <b>Alias · 1</b>|⚠️ <b>Check 1</b>)\\n<code>${num}</code> · (Alias · )?DQ4071-001 · 9\\.5 · Nike Air Max 90 'Anthracite…`));
  const row = (await list(request)).rows.find((r) => r.order_number === num);
  expect(row).toMatchObject({ platform: 'alias', sku: 'DQ4071-001', size: 'US M 9.5', reason: 'customer asked', details_from: 'label' });
  expect(prompts).toHaveLength(0);
  const [raw] = await q('SELECT ai_raw FROM cancellations WHERE id = $1', [row.id]);
  // One label = one order whatever tesseract does. On CI's font (Liberation Sans) the first read
  // turns "#991…" into "#091…" on ~40 % of labels (measured 2026-11-15 in the CI image); the
  // reads then disagree, a third read decides, and the losing reading is kept on the row as
  // `other` (mergeReads + settleWithThird in api/_lib/cancelOcr.js).
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
  expect(await lastSaid(TG_WH)).toBe(`[dev] ✅ <b>Alias · 1</b>\n<code>${n}</code> · ZX9911-001 · 9 · E2E Cx Catalogue Shoe`);
  expect((await list(request)).rows.find((r) => r.order_number === n)).toMatchObject({ source: 'typed', reason: 'wrong size', details_from: 'typed,catalogue' });
  await q(`DELETE FROM cancellation_tg_ctx WHERE key LIKE 'chat:%7710001'`);
});

test('two reads that disagree still record the number, with what the second read saw', async ({ request }) => {
  sent.length = 0;
  const a = `9911${String(Date.now()).slice(-6)}`; const b = `${a.slice(0, -1)}${(Number(a.at(-1)) + 1) % 10}`;
  const f = await picture(`cx-d-${a}`, [read({ platform: 'alias', order_number: a, confidence: 0.98 }), read({ platform: 'alias', order_number: b, confidence: 0.98 })]);
  await hook(request, photo(TG_WH, f, '/alias'));
  expect(await lastSaid(TG_WH)).toContain(`<code>${a}</code> · Alias · no shoe details · reads disagreed`);
  const row = (await list(request)).rows.find((r) => r.order_number === a);
  expect(row.note).toBe(`Second read said ${b}`);
});

test('an AI account with no credit left is said plainly, and the photo is still recorded', async ({ request }) => {
  sent.length = 0;
  const f = await picture(`cx-quota-${Date.now()}`, 'quota');
  await hook(request, photo(TG_WH, f, '/alias'));
  expect(await lastSaid(TG_WH)).toMatch(/❌ <b>No order number · Alias · 1 photo<\/b>\nThe AI reader is out of credit \(OpenAI billing\) — tell an admin\./);
});

test('a stranger is told to connect; a by-hand add refuses a duplicate; a removed number may come back', async ({ request }) => {
  // A platform named by the test before this one stays on for 90 s, and a row it left with no
  // number would be filled by the number typed here: start with neither.
  await q(`DELETE FROM cancellation_tg_ctx WHERE key LIKE 'chat:%7710001'`);
  await q(`UPDATE cancellations SET status = 'rejected' WHERE sent_by = $1 AND order_key IS NULL AND status <> 'rejected'`, [WH.name]);
  sent.length = 0;
  const n = `${String(Date.now()).slice(-8)}-${String(Date.now()).slice(-8)}`;
  await hook(request, { from: TG_WH, body: { text: `${n} - customer asked` } });
  expect(await lastSaid(TG_WH)).toMatch(new RegExp(`✅ <b>StockX · 1</b>\\n<code>${n}</code>`));
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
  // "Reported to the platform" (2026-11-27): anyone who sees the page ticks it — who and when
  // are kept — and takes it off. A row with no order number can't be reported.
  const act = (role, data) => request.post('/api/cancellations/action', { headers: auth(role), data });
  expect(await (await act('warehouse', { id: row.id, action: 'reported' })).json()).toMatchObject({ ok: true, changed: [row.id] });
  const ticked = (await list(request)).rows.find((r) => r.id === row.id);
  expect(ticked).toMatchObject({ reported_by: 'E2E Cx warehouse' });
  expect(ticked.reported_at).toBeTruthy();
  expect(await (await act('ph_team', { id: row.id, action: 'reported' })).json()).toMatchObject({ ok: true, changed: [] });   // already ticked: nothing to do
  expect((await list(request)).rows.find((r) => r.id === row.id).reported_by).toBe('E2E Cx warehouse');                      // …and still the first person's
  const [{ id: blankId }] = await q(`INSERT INTO cancellations (status, platform, sent_by, source) VALUES ('to_review', 'alias', 'E2E Cx blank', 'app') RETURNING id`);
  const noNumber = await act('warehouse', { id: Number(blankId), action: 'reported' });
  expect(noNumber.status()).toBe(400);
  expect((await noNumber.json()).error).toMatch(/no order number yet/);
  // Many at once: what can't change is counted, never an error for the rest.
  expect(await (await act('ph_team', { ids: [row.id, Number(blankId)], action: 'unreported' })).json()).toMatchObject({ ok: true, changed: [row.id], skipped: 1 });
  expect((await list(request)).rows.find((r) => r.id === row.id)).toMatchObject({ reported_at: null, reported_by: null });
  expect((await act('warehouse', { ids: [], action: 'reported' })).status()).toBe(400);
  await q('DELETE FROM cancellations WHERE id = $1', [blankId]);

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
  expect(await lastSaid(TG_WH)).toMatch(new RegExp(`✅ <b>Stadium Goods · 1</b>\\n<code>${n}</code>`));
  expect(prompts.some((p) => p.includes('The sender says these orders are from Stadium Goods'))).toBe(true);
  expect((await list(request)).rows.find((r) => r.order_number === n)).toMatchObject({ platform: 'sg', reason: 'box damaged' });

  await hook(request, { from: TG_WH, body: { text: '/kc' } });
  expect(await lastSaid(TG_WH, 2)).toMatch(/Kicks Crew mode on for 90 s — send your photos/);
  const n1 = `9911${String(Date.now()).slice(-7)}1`;
  await hook(request, photo(TG_WH, await picture(`cx-kc-${n1}`, read({ order_number: n1 }))));
  expect(await lastSaid(TG_WH, 3)).toMatch(new RegExp(`✅ <b>Kicks Crew · 1</b>\\n<code>${n1}</code>`));

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
  expect(await lastSaid(GROUP)).toMatch(/Alias mode on for 90 s — send your photos/);
  const pid = await hook(request, { from: TG_WH, chat: GROUP, body: { photo: [{ file_id: await picture(`cx-grp-${n}`, read({ order_number: n })) }] } });
  expect(await lastSaid(GROUP, 2)).toMatch(new RegExp(`✅ <b>Alias · 1</b>\\n<code>${n}</code>`));
  expect(saidTo(GROUP).at(-1).reply_parameters.message_id).toBe(pid);
  expect((await list(request)).rows.find((r) => r.order_number === n)).toMatchObject({ platform: 'alias', sent_by: WH.name });

  // Someone in the group who isn't connected is told how.
  await hook(request, { from: TG_STRANGER, chat: GROUP, body: { photo: [{ file_id: 'cx-grp-stranger' }], caption: '/ebay' } });
  expect(await lastSaid(GROUP, 3)).toMatch(/connect this chat first/);
});

// ── The platform without being told: our Shopify orders, the number's shape, the slip's words (2026-11-21) ──
test('the slips of each marketplace: Temu and StockX by their number, Stadium Goods by its name, SHEIN through its look-alikes (pure)', async () => {
  const nums = (t, h) => ordersFromText(t, h).map((o) => `${o.platform}:${o.order_number}`);
  // Temu's packing slip, as tesseract read the real ones: the PO number whole, in pieces, and with the O as a zero.
  const temu = 'Tracking Number:\n1ZZKTWGRO03928084 35\nShipping Service: UPS\nPurchase Order ID:\nPO-211-00591237806711370\nOrder Date: 14 nov 2026, 7:09 pm CST\nNike Court Legacy Next Nature White Desert Ochre\n(DH3162-100)\nBRAND: Nike\nSKU: DH3162-100\nSIZE: 14';
  expect(nums(temu)).toEqual(['temu:PO-211-00591237806711370']);
  expect(ordersFromText(temu)[0]).toMatchObject({ sku: 'DH3162-100', size: '14' });
  expect(nums('Purchase Order ID:\nPO-211-05609904394872 563')).toEqual(['temu:PO-211-05609904394872563']);
  expect(nums('P0-211-05600904394872 563')).toEqual(['temu:PO-211-05600904394872563']);
  expect(nums('Purchase Order ID: PO-211-19319877274232381 ORDER')).toEqual(['temu:PO-211-19319877274232381']);
  // StockX: the shape its Shopify orders carry now, and the older one; eBay is still eBay.
  expect(nums('Order 06-B1P9GP5N4H')).toEqual(['stockx:06-B1P9GP5N4H']);
  expect(nums('06-LZQ93WHGEL')).toEqual(['stockx:06-LZQ93WHGEL']);                        // four digits: a shape, not "mostly digits"
  expect(nums('12345678-12345678')).toEqual(['stockx:12345678-12345678']);
  expect(nums('07-15461-19264')).toEqual(['ebay:07-15461-19264']);
  expect(nums('call 48-0618534469 now')).toEqual([]);                                     // digits only is not the new StockX shape
  expect(flagsFor({ order_number: '06-B1P9GP5N4H', platform: 'stockx' })).toEqual([]);
  expect(platformFromNumber('PO-211-00591237806711370')).toBe('temu');
  expect(platformFromNumber('211-15609680886391006')).toBe('temu');                       // the same order's line number
  expect(platformFromNumber('GSU19K45B000Q2R')).toBe('shein');
  expect(platformFromNumber('206557037')).toBe(null);
  // A Stadium Goods slip prints no order number in words (it is the barcode): nothing is made
  // up from the fulfilment number, the dates or the phone — but its name and the shoe are read.
  const sg = 'STADIUM GOODS\nOrder Date: 11/14/2026\nShipment Date: 11/13/2026\nFulfillment Number\nSONDSS_CKRS00003248\nAMA00386134\n218726 Air Jordan 12 Retro PS 151186 003 13C 1 $96\nSKU: 151186 003\nSIZE: 13C\nBRAND: JORDAN';
  expect(nums(sg)).toEqual([]);
  expect(nums(sg, 'sg')).toEqual([]);
  expect(platformFromText(sg)).toBe('sg');
  expect(slipDetails(sg)).toEqual({ sku: '151186-003', size: '13C', product: null });
  expect(slipDetails('BRAND: Nike\nSKU: FQ8706-300\nSIZE: 9W')).toEqual({ sku: 'FQ8706-300', size: '9W', product: null });
  // The platform a slip names — only when it names exactly one. A shoe called "Flight Club" names none.
  expect(platformFromText('alias\nSold on Sneakers.com')).toBe('alias');
  expect(platformFromText('GOAT ORDER # 123')).toBe('alias');
  expect(platformFromText('Jordan 4 Retro OG Flight Club')).toBe(null);
  expect(platformFromText('STADIUM GOODS … sold on eBay')).toBe(null);
  expect(platformFromText(temu)).toBe(null);
  // SHEIN's thin print came back three look-alikes off; folded together it is the same number.
  const k = (id, platform = 'shein') => ({ key: id.replace(/[^A-Z0-9]/g, ''), order_id: id, platform, source: 'shopify', lines: [] });
  expect(nums('Order Number: GSUT9K45BO00O2R')).toEqual(['shein:GSUT9K45BO00O2R']);
  expect(canonKey('GSUT9K45BO00O2R')).toBe(canonKey('GSU19K45B000Q2R'));
  expect(matchOurOrder('GSUT9K45BO00O2R', null, [k('GSU19K45B000Q2R')])).toMatchObject({ corrected: true, order: { order_id: 'GSU19K45B000Q2R' } });
  expect(matchOurOrder('GSUT9K45BO00O2R', null, [k('GSU19K45B000Q2R'), k('GSUI9K45B0000ZR')])).toBe(null);   // two fold to the same: no guess
  expect(canonKey('206557037')).toBe('206557037');                                        // digits are never folded onto each other
  expect(matchOurOrder('206557031', null, [k('206557037', 'alias')])).toBe(null);
  expect(rowStatus({ order_number: '1', flags: ['not_in_shopify'] })).toEqual({ tag: 'CHECK', why: 'not found in our orders' });
  // A slip that names its marketplace is that marketplace's: the flag is kept, the row is [OK].
  expect(rowStatus({ order_number: '1', flags: ['platform_guess'] })).toEqual({ tag: 'OK', why: null });

  // Live 2026-11-25: the rule for an Alias label's lone 9-10 digit line fired on Stadium Goods
  // slips and recorded numbers that were no order's. Never on a slip that names another
  // marketplace, that the sender named as another, or that is laid out with "BRAND:".
  const sgDigits = 'STADIUM GOODS\nOrder Date: 11/20/2026\nFulfillment Number\nSONDSS_CKRS00003301\n219001 Air Jordan 4 026484 052 9.5 1 $180\nSKU: DZ5485 052\nSIZE: 9.5\nBRAND: JORDAN';
  expect(nums(sgDigits.replace('026484 052 9.5 1 $180', '').concat('\n026484 052'))).toEqual([]);
  expect(nums('1112002026\n4653440050\nFN8358 200\nSIZE: 10\nBRAND: NIKE', 'sg')).toEqual([]);      // the sender tapped Stadium Goods
  expect(nums('1112002026\n4653440050\nFN8358 200\nSIZE: 10\nBRAND: NIKE')).toEqual([]);            // nobody said: "BRAND:" is not an Alias label
  expect(nums('104092 791\nDZ5485 052', 'temu')).toEqual([]);
  expect(nums('ORDER #\n316743576\nSKU\nDV3950 001\nSIZE\nUS M 7')).toEqual(['null:316743576']);    // an Alias label with no "alias" read: still read
  expect(nums('GOAT\n746390732\nBRAND: NIKE')).toEqual(['null:746390732']);                           // it says GOAT: an Alias label whatever else it prints
  // A Stadium Goods order number run together is not the shoe's style code.
  expect(slipDetails('STADIUM GOODS\nFAR02077818\nSIZE: 8\nBRAND: NIKE')).toEqual({ sku: null, size: '8', product: null });
  expect(slipDetails('FAR02077818\nSKU: IQ4092 001\nSIZE: 8.5')).toMatchObject({ sku: 'IQ4092-001' });
  // The slip is known by what only it prints, when the wordmark doesn't read.
  expect(platformFromText('Fulfillment Number\nSONDSS_CKRS00003248\nSIZE: 13C')).toBe('sg');
  expect(platformFromText('Futhment Number\nSIZE: 13C')).toBe('sg');
  // Temu's "PO" read as "P00" is the same order, once.
  expect(nums('Purchase Order ID:\nP00-211-15728317205111706')).toEqual(['temu:PO-211-15728317205111706']);

  // The Shopify order index: where each channel keeps the marketplace's own number (the real shapes).
  const { orderIndexRow } = await import('../api/_lib/shopify-order-index.js');
  const line = (title, variantTitle, customAttributes = []) => ({ node: { title, variantTitle, sku: '10123948', customAttributes } });
  const row = (o) => orderIndexRow({ id: 'gid://shopify/Order/1', createdAt: '2026-11-20T17:00:00Z', updatedAt: '2026-11-20T17:00:00Z', tags: [], customAttributes: [], fulfillments: [], lineItems: { edges: [] }, ...o });
  expect(row({ name: '06-B1P9GP5N4H', app: { name: 'StockX' }, customAttributes: [{ key: 'StockX Order Number', value: '06-B1P9GP5N4H' }], lineItems: { edges: [line('adidas AE 2 With Love (JS3514)', '10.5')] } }))
    .toMatchObject({ platform: 'stockx', numbers: ['06B1P9GP5N4H'], number_texts: ['06-B1P9GP5N4H'], lines: [{ style: 'JS3514', size: '10.5', name: 'adidas AE 2 With Love' }] });
  expect(row({ name: '#33938', app: { name: 'My Store: GOAT' }, customAttributes: [{ key: 'g_order_number', value: '637973365' }, { key: 'g_platform', value: 'flight_club' }], lineItems: { edges: [line('Nike Air Max 97 Black White Anthracite (921826-015)', '12')] } }))
    .toMatchObject({ platform: 'alias', numbers: ['637973365'], lines: [{ style: '921826-015', size: '12', name: 'Nike Air Max 97 Black White Anthracite' }] });   // never our own "#33938"
  expect(row({ name: '#33943', app: { name: 'My Store: SGAPP' }, note: 'CK5191645963', customAttributes: [{ key: 'Order Number', value: 'CK5191645963' }, { key: 'Tracking Number', value: '3638579394' }] }))
    .toMatchObject({ platform: 'sg', numbers: ['CK5191645963'], trackings: ['3638579394'] });
  expect(row({ name: '#33921', app: { name: 'Temu' }, sourceName: 'TEMU', sourceIdentifier: 'PO-211-15609528842871006',
    lineItems: { edges: [line('Nike Air Max Plus Golf NRG Eastside Golf (HV4363-400)', '13', [{ key: 'ORDER_SN', value: '211-15609680886391006' }])] }, fulfillments: [{ trackingInfo: [{ number: '1Z2K1W600399808439' }] }] }))
    .toMatchObject({ platform: 'temu', numbers: ['PO21115609528842871006', '21115609680886391006'], trackings: ['1Z2K1W600399808439'] });
  expect(row({ name: 'KS2699631', app: { name: 'Kicks Crew Stickballman12 ' }, sourceIdentifier: '91180836' }).numbers).toEqual(['KS2699631']);
  expect(row({ name: '07-15461-19264', app: { name: 'eBay Integration - DPL' }, sourceName: 'eBay', sourceIdentifier: '07-15461-19264' }).numbers).toEqual(['071546119264']);
  expect(row({ name: '#33772', app: { name: 'SHEIN via Stickballman12.com' }, sourceIdentifier: 'GSU1A607200MC1M' })).toMatchObject({ platform: 'shein', numbers: ['GSU1A607200MC1M'], numbers_canon: [canonKey('GSU1A607200MC1M')] });
  expect(row({ name: '#33846', app: { name: 'TikTok' }, sourceName: 'tiktok', tags: ['Shipped by TikTok', 'TikTokOrderID:577694771234567890'] }).numbers).toEqual(['577694771234567890']);
  expect(row({ name: '#33000', app: { name: 'Online Store' } })).toBe(null);               // our own web store: not a marketplace order
  expect(row({ name: '21315226930833298', app: { name: 'POIZON' } })).toBe(null);
});

test('a photo with NO platform is read first: one of our Shopify orders (or a Temu number) files itself; a number in none of them is [CHECK]', async ({ request }) => {
  await q(`DELETE FROM cancellation_tg_ctx WHERE key LIKE 'chat:%7710001'`);
  sent.length = 0; edits.length = 0;
  const s = String(Date.now()).slice(-6);
  const alias = `9911${s}77`; const temu = `PO-211-9911${s}0000000`; const stray = `9911${s}55`;
  // What the index holds: a GOAT (Alias) order under its g_order_number.
  await q(`INSERT INTO shopify_order_index (shopify_order_id, name, channel, platform, numbers, number_texts, numbers_canon, lines, ordered_at)
           VALUES ($1, '#30001', 'e2e-cx', 'alias', $2::text[], $2::text[], $2::text[], $3::jsonb, now())`,
  [`e2e-cx-${s}`, [alias], JSON.stringify([{ style: 'IM4002-100', size: '11', name: 'Jordan 4 Retro OG Flight Club', title: 'Jordan 4 Retro OG Flight Club (IM4002-100)' }])]);
  try {
    // No command, no caption, nothing on: the number IS our Alias order → recorded as Alias, the
    // shoe from the order, and nobody is asked.
    const first = await hook(request, photo(TG_WH, await picture(`cx-ix1-${s}`, read({ order_number: alias }))));
    expect(await lastSaid(TG_WH)).toBe(`[dev] ✅ <b>Alias · 1</b>\n<code>${alias}</code> · IM4002-100 · 11 · Jordan 4 Retro OG Flight Cl…`);
    expect(saidTo(TG_WH)[0].reply_parameters.message_id).toBe(first);
    expect(saidTo(TG_WH)[0].reply_markup.inline_keyboard.flat().map((x) => x.callback_data)).toEqual(['cxvoid']);   // no platform buttons
    expect((await list(request)).rows.find((r) => r.order_number === alias)).toMatchObject({ platform: 'alias', order_match: 'shopify', details_from: 'shopify', sku: 'IM4002-100', size: '11' });
    // A Temu purchase order names its platform by its shape.
    await hook(request, photo(TG_WH, await picture(`cx-ix2-${s}`, read({ order_number: temu }))));
    expect(await lastSaid(TG_WH, 2)).toMatch(new RegExp(`^\\[dev\\] ✅ <b>Temu · 1</b>\\n<code>${temu}</code>`));

    // The index is complete and current: a Temu number in none of our orders is most likely misread.
    // Not so an Alias one — some real Alias orders never reach Shopify (4 clean reads of 7, live
    // 2026-11-25): a clean Alias read stays [OK].
    await q(`INSERT INTO app_settings (key, value, updated_by) VALUES ('shopify_order_index_sync', $1, 'e2e-cx')
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = 'e2e-cx'`,
    [JSON.stringify({ state: 'done', firstDone: true, lastAt: new Date().toISOString(), cursor: new Date().toISOString() })]);
    const strayTemu = `PO-211-9911${s}5555555`;
    await hook(request, photo(TG_WH, await picture(`cx-ix3-${s}`, read({ order_number: strayTemu })), '/temu'));
    expect(await lastSaid(TG_WH, 3)).toMatch(new RegExp(`⚠️ <b>Check 1</b>\\n<code>${strayTemu}</code> · Temu · no shoe details · not found in our orders`));
    expect((await list(request)).rows.find((r) => r.order_number === strayTemu).flags).toContain('not_in_shopify');
    await hook(request, photo(TG_WH, await picture(`cx-ix4-${s}`, read({ order_number: stray })), '/alias'));
    expect(await lastSaid(TG_WH, 4)).toMatch(new RegExp(`✅ <b>Alias · 1</b>\\n<code>${stray}</code> · no shoe details$`));
    expect((await list(request)).rows.find((r) => r.order_number === stray).flags).not.toContain('not_in_shopify');
  } finally {
    await q(`DELETE FROM app_settings WHERE key = 'shopify_order_index_sync' AND updated_by = 'e2e-cx'`);
    await q(`DELETE FROM shopify_order_index WHERE channel = 'e2e-cx'`);
    await q(`DELETE FROM cancellation_tg_ctx WHERE key LIKE 'chat:%7710001'`);
  }
});

// ── A photo no number was read off is sent back; a reply to it carries the number (2026-11-26) ──
test('a photo with no number read is sent back, and a reply to THAT copy with the number fills that photo\'s row', async ({ request }) => {
  await q(`DELETE FROM cancellation_tg_ctx WHERE key LIKE 'chat:%7710001'`);
  await q(`UPDATE cancellations SET status = 'rejected' WHERE sent_by = $1 AND order_key IS NULL AND status <> 'rejected'`, [WH.name]);
  sent.length = 0; copies.length = 0; reactions.length = 0;
  const s = String(Date.now()).slice(-6);
  const n2 = `9911${s}32`;
  const f1 = await picture(`cx-mr1-${s}`, 'fail');
  const f2 = await picture(`cx-mr2-${s}`, 'fail');
  const p1 = await hook(request, photo(TG_WH, f1, '/sg'));
  const p2 = await hook(request, photo(TG_WH, f2));                              // Stadium Goods is on
  const said = await lastSaid(TG_WH);
  // ONE block for the two missed photos (same marketplace, same reason), not a line each.
  expect(said).toMatch(/^\[dev\] 2 photos · 0 recorded · 2 need a number\n\n❌ <b>No order number · Stadium Goods · 2 photos<\/b>\nPhotos 1, 2\n[^\n]+\nEach is sent back below: reply to it with the number\./);
  // Both photos come back, each on its own, as a reply to the photo it is a copy of — the
  // same Telegram file, nothing uploaded again.
  await expect.poll(() => copies.length, { timeout: 20_000 }).toBe(2);
  expect(copies.map((c) => c.photo)).toEqual([f1, f2]);
  expect(copies.map((c) => c.reply_parameters.message_id)).toEqual([p1, p2]);
  expect(copies[1].caption).toMatch(/^\[dev\] \[MISSED\] Photo 2: no order number read \(Stadium Goods\)\.\nReply to this message with the order number\.$/);
  const rowOf = async (messageId) => (await q(`SELECT c.id, c.order_number, c.platform FROM cancellations c JOIN cancellation_photos p ON p.id = c.photo_id
     WHERE p.tg_chat_id = $1 AND p.tg_message_id = $2 AND c.status <> 'rejected'`, [TG_WH, messageId]))[0];

  // The number, replied onto the SECOND copy: it is the second photo's — not the oldest open row's.
  const replyId = await hook(request, { from: TG_WH, body: { text: n2, reply_to_message: { message_id: copies[1].message_id } } });
  expect(await lastSaid(TG_WH, 2)).toMatch(new RegExp(`✅ <b>Stadium Goods · 1</b>\\n<code>${n2}</code>[\\s\\S]*Filled the photo row #\\d+ that had no order number\\.$`));
  expect(await rowOf(p2)).toMatchObject({ order_number: n2, platform: 'sg' });
  expect((await rowOf(p1)).order_number).toBe(null);
  // A 👍 on the reply (taken) and on the copy (that photo is done) — and on nothing else.
  await expect.poll(() => reactions.length).toBe(2);
  expect(reactions.map((r) => r.message_id).sort()).toEqual([replyId, copies[1].message_id].sort());
  expect(reactions.every((r) => r.chat_id === TG_WH && r.reaction[0].emoji === '👍')).toBe(true);

  // A second reply to the same copy changes nothing and says so; words with no number are asked again.
  await hook(request, { from: TG_WH, body: { text: `9911${s}39`, reply_to_message: { message_id: copies[1].message_id } } });
  expect(await lastSaid(TG_WH, 3)).toMatch(new RegExp(`That photo already has its order number: #${n2}`));
  expect((await rowOf(p2)).order_number).toBe(n2);
  await hook(request, { from: TG_WH, body: { text: 'not sure', reply_to_message: { message_id: copies[0].message_id } } });
  expect(await lastSaid(TG_WH, 4)).toMatch(/couldn't find an order number in that/);
  await new Promise((r) => setTimeout(r, 500));
  expect(reactions).toHaveLength(2);                                             // a refused reply gets no 👍

  // The number replied onto a photo keeps the shoe already read off its slip (live 2026-11-25:
  // seven Stadium Goods rows lost their SKU and size to the reply that gave them their number).
  const first = await rowOf(p1);
  await q(`UPDATE cancellations SET sku = 'DM4044-001', size = '12', details_from = 'label' WHERE id = $1`, [first.id]);
  await hook(request, { from: TG_WH, body: { text: `9911${s}31`, reply_to_message: { message_id: copies[0].message_id } } });
  expect(await lastSaid(TG_WH, 5)).toMatch(new RegExp(`<code>9911${s}31</code> · DM4044-001 · 12$`, 'm'));
  expect((await list(request)).rows.find((r) => r.id === Number(first.id))).toMatchObject({ order_number: `9911${s}31`, sku: 'DM4044-001', size: '12', details_from: 'label' });

  // In the group, a reply to anything that is not one of those copies is chatter: nothing is said.
  const before = saidTo(GROUP).length;
  await hook(request, { from: TG_STRANGER, chat: GROUP, body: { text: '123456789', reply_to_message: { message_id: 424242 } } });
  await new Promise((r) => setTimeout(r, 800));
  expect(saidTo(GROUP)).toHaveLength(before);
  await q(`DELETE FROM cancellation_tg_ctx WHERE key LIKE 'chat:%7710001'`);
});

// ── The forgiving flows (2026-11-20) ────────────────────────────────────────────────
test('photos with no platform wait for a tap: ONE question, the pick files them into that message, Void Batch takes the rows back', async ({ request }) => {
  await q(`DELETE FROM cancellation_tg_ctx WHERE key LIKE 'chat:%7710001'`);
  sent.length = 0; edits.length = 0; answers.length = 0;
  const s = String(Date.now()).slice(-6);
  const a = `9911${s}7`; const b = `9911${s}8`;
  const f1 = await picture(`cx-pk1-${s}`, read({ order_number: a }));
  const f2 = await picture(`cx-pk2-${s}`, read({ order_number: b }));
  const first = await hook(request, photo(TG_WH, f1));
  await hook(request, photo(TG_WH, f2));
  // One question for both, under the first photo, with the eight platforms; nothing recorded.
  await lastSaid(TG_WH);
  await new Promise((r) => setTimeout(r, 2500));
  expect(saidTo(TG_WH)).toHaveLength(1);
  const ask = saidTo(TG_WH)[0];
  expect(ask.text).toMatch(/^\[dev\] 2 photos from E2E Cx Warehouse — I couldn't tell the platform\. Which is it\?/);
  expect(ask.reply_parameters.message_id).toBe(first);
  expect(ask.reply_markup.inline_keyboard.map((r) => r.map((x) => x.callback_data))).toEqual([
    ['cxpick:alias', 'cxpick:stockx', 'cxpick:ebay', 'cxpick:shein'], ['cxpick:tiktok', 'cxpick:temu', 'cxpick:sg', 'cxpick:kc']]);
  expect((await list(request)).rows.some((r) => [a, b].includes(r.order_number))).toBe(false);

  // Someone who isn't connected can't pick for them.
  await tap(request, TG_STRANGER, null, 'cxpick:alias', { message_id: ask.message_id });
  await expect.poll(() => answers.at(-1)?.text || '').toMatch(/Connect this Telegram first/);

  // The tap: read as Alias, and the question itself becomes the summary — no second message.
  await tap(request, TG_WH, null, 'cxpick:alias', { message_id: ask.message_id });
  const summary = () => edits.filter((e) => e.message_id === ask.message_id).at(-1) || {};
  await expect.poll(() => summary().text || '', { timeout: 20_000 }).toBe(
    `[dev] 2 photos · 2 recorded\n\n✅ <b>Alias · 2</b>\n<code>${a}</code> · no shoe details\n<code>${b}</code> · no shoe details`);
  expect(summary().reply_markup.inline_keyboard.flat().map((x) => x.callback_data)).toEqual(['cxvoid']);
  expect(saidTo(TG_WH)).toHaveLength(1);
  expect((await list(request)).rows.filter((r) => [a, b].includes(r.order_number)).map((r) => r.platform)).toEqual(['alias', 'alias']);

  // An old button (a second tap) files nothing twice and says why.
  await tap(request, TG_WH, null, 'cxpick:stockx', { message_id: ask.message_id });
  await expect.poll(() => answers.at(-1)?.text || '').toMatch(/already logged/);
  expect((await list(request)).rows.filter((r) => [a, b].includes(r.order_number))).toHaveLength(2);

  // Void Batch: both rows leave the record (kept as removed), the message says who did it.
  await tap(request, TG_WH, null, 'cxvoid', { message_id: ask.message_id, text: summary().text });
  await expect.poll(async () => (await list(request)).rows.filter((r) => [a, b].includes(r.order_number)).length).toBe(0);
  await expect.poll(() => summary().text || '').toMatch(/VOIDED by E2E Cx Warehouse — 2 rows removed from the record/);
  expect((await q(`SELECT status, rejected_reason FROM cancellations WHERE order_number = $1`, [a]))[0])
    .toMatchObject({ status: 'rejected', rejected_reason: 'Batch voided on Telegram (wrong platform, or sent by mistake)' });
  await tap(request, TG_WH, null, 'cxvoid', { message_id: ask.message_id });
  await expect.poll(() => answers.at(-1)?.text || '').toMatch(/already voided/);
});

test('the note after a command rides on every photo; an image sent "as a file" is read; photos sent first are filed by the command that follows', async ({ request }) => {
  await q(`DELETE FROM cancellation_tg_ctx WHERE key LIKE 'chat:%7710001'`);
  sent.length = 0; edits.length = 0;
  const s = String(Date.now()).slice(-6);
  const a = `9911${s}4`; const b = `9911${s}0`;
  // "/tiktok wrong size shipped" has no order number in it: it is a note, and TikTok is on.
  // (TikTok: a platform with no number shape of its own, so this made-up number is not [CHECK]ed
  // for its format — a Temu number has to look like PO-211-… since 2026-11-21.)
  await hook(request, { from: TG_WH, body: { text: '/tiktok wrong size shipped' } });
  expect(await lastSaid(TG_WH)).toMatch(/TikTok Shop mode on for 90 s — send your photos[\s\S]*Note on each: "wrong size shipped"/);
  const fa = await picture(`cx-doc-${s}`, read({ order_number: a }));
  await hook(request, { from: TG_WH, body: { document: { file_id: fa, mime_type: 'image/jpeg', file_name: 'label.jpg' } } });
  expect(await lastSaid(TG_WH, 2)).toMatch(new RegExp(`✅ <b>TikTok Shop · 1</b>\\n<code>${a}</code>`));
  expect((await list(request)).rows.find((r) => r.order_number === a)).toMatchObject({ platform: 'tiktok', reason: 'wrong size shipped' });
  expect((await q('SELECT as_file FROM cancellation_photos WHERE tg_file_id = $1', [fa]))[0].as_file).toBe(true);

  // A photo first (it is asked about), then the command instead of a tap: filed by the command.
  await q(`DELETE FROM cancellation_tg_ctx WHERE key LIKE 'chat:%7710001'`);
  sent.length = 0; edits.length = 0;
  await hook(request, photo(TG_WH, await picture(`cx-late-${s}`, read({ order_number: b }))));
  await lastSaid(TG_WH);
  const askId = saidTo(TG_WH)[0].message_id;
  await hook(request, { from: TG_WH, body: { text: '/kc' } });
  expect(await lastSaid(TG_WH, 2)).toMatch(/Kicks Crew — reading the photo you already sent/);
  await expect.poll(() => edits.filter((e) => e.message_id === askId).at(-1)?.text || '', { timeout: 20_000 })
    .toMatch(new RegExp(`✅ <b>Kicks Crew · 1</b>\\n<code>${b}</code>`));
  expect((await list(request)).rows.find((r) => r.order_number === b)).toMatchObject({ platform: 'kc' });
  await q(`DELETE FROM cancellation_tg_ctx WHERE key LIKE 'chat:%7710001'`);
});

test('a question nobody answers: the sweep files those photos with no platform, into the question', async () => {
  sent.length = 0; edits.length = 0;
  const { sweepCancellationPhotos } = await import('../api/_lib/cancellations.js');
  const s = String(Date.now()).slice(-6);
  await picture(`cx-exp-${s}`);
  const [{ id }] = await q(`INSERT INTO cancellation_photos (tg_chat_id, tg_message_id, tg_file_id, sent_by_user_id, sent_by, held_at, prompt_message_id, created_at)
    VALUES ($1, $2, $3, $4, $5, now() - interval '11 minutes', 777001, now() - interval '11 minutes') RETURNING id`,
  [TG_WH, 991000 + Number(s.slice(-3)), `cx-exp-${s}`, whUid, WH.name]);
  expect(await sweepCancellationPhotos()).toMatchObject({ reread: 1, answered: 1 });
  expect((await q('SELECT held_at, read_status, reply_message_id FROM cancellation_photos WHERE id = $1', [id]))[0])
    .toMatchObject({ held_at: null, read_status: 'nothing', reply_message_id: '777001' });
  expect(edits.at(-1)).toMatchObject({ message_id: 777001 });
  expect(edits.at(-1).text).toMatch(/❌ <b>No order number · 1 photo<\/b>/);
  expect(saidTo(TG_WH)).toHaveLength(0);
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
  expect(saidTo(TG_WH)[0].text).toMatch(new RegExp(`No order number · Alias · 1 photo</b>\\nPhoto 2[\\s\\S]*✅ <b>Alias · 1</b>\\n<code>9911${s}9</code>`));
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

    // "Reported to <platform>": the tick on a row — who and when beside it, the row marked done.
    const a = row(`E2ECX${s}A`);
    await expect(a.getByLabel('Reported to Alias')).not.toBeChecked();
    await a.getByLabel('Reported to Alias').check();
    await expect(page.getByRole('status')).toContainText('marked as reported to Alias');
    await expect(a).toHaveClass(/cx-reported/);
    await expect(a.locator('.cx-tick')).toContainText(/· \S.* · .* EST/);       // who · when (EST)
    // The two filters: what is still to report, and what has been.
    await page.getByRole('button', { name: /^Reported \(\d+\)$/ }).click();
    await expect(row(`E2ECX${s}A`)).toHaveCount(1);
    await expect(row(`E2ECX${s}S`)).toHaveCount(0);
    await page.getByRole('button', { name: /^To report \(\d+\)$/ }).click();
    await expect(row(`E2ECX${s}A`)).toHaveCount(0);
    await expect(row(`E2ECX${s}S`)).toHaveCount(1);
    // "Mark the N shown": only this search's rows, after a confirmation.
    await page.getByLabel('Search').fill(`e2ecx${s}`);
    await expect(page.getByRole('button', { name: '✓ Mark the 2 shown as reported' })).toBeEnabled();   // …S and …M (A is ticked; yesterday's isn't shown)
    await page.getByRole('button', { name: '✓ Mark the 2 shown as reported' }).click();
    await page.getByRole('button', { name: 'Mark 2 as reported' }).click();
    await expect(page.getByRole('status')).toContainText('2 marked as reported');
    await expect(page.locator('.cx-row')).toHaveCount(0);       // nothing of this search left to report
    await page.getByRole('button', { name: /^To report \(\d+\)$/ }).click();
    await expect(page.locator('.cx-row.cx-reported')).toHaveCount(3);
    // …and a tick comes off again.
    await row(`E2ECX${s}S`).getByLabel('Reported to StockX').uncheck();
    await expect(row(`E2ECX${s}S`)).not.toHaveClass(/cx-reported/);
    const trail = await q(`SELECT e.action, e.actor FROM cancellation_events e JOIN cancellations c ON c.id = e.cancellation_id
                            WHERE c.order_number = $1 AND e.action IN ('reported', 'unreported') ORDER BY e.id`, [`E2ECX${s}S`]);
    expect(trail.map((e) => e.action)).toEqual(['reported', 'unreported']);      // who did each is kept
    expect(trail.every((e) => e.actor)).toBe(true);

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

test('reads that disagree: a third read decides; two real numbers one read saw together stay two (pure)', async () => {
  const { mergeReads, settleWithThird } = await import('../api/_lib/cancelOcr.js');
  const o = (n) => ({ platform: 'alias', order_number: n });
  const settle = (a, b, c) => settleWithThird(mergeReads(a, b), c, a, b);
  // The CI misread: the first read said 091…, the second and third 991… → 991…, first kept as `other`.
  expect(settle([o('091138476')], [o('991138476')], [o('991138476')]))
    .toEqual([expect.objectContaining({ order_number: '991138476', agreed: true, other: '091138476' })]);
  // The third agrees with the first: the first stands.
  expect(settle([o('991138476')], [o('091138476')], [o('991138476')]))
    .toEqual([expect.objectContaining({ order_number: '991138476', agreed: true, other: '091138476' })]);
  // Two characters off ("00…" / "99…") filed one photo as TWO cancellations: now one order.
  expect(settle([o('001177462')], [o('991177462')], [o('991177462')]))
    .toEqual([expect.objectContaining({ order_number: '991177462', agreed: true, other: '001177462' })]);
  // A digit too many ("0901144585" for "991144585"): the same.
  expect(settle([o('0901144585')], [o('991144585')], [o('991144585')]).map((x) => x.order_number)).toEqual(['991144585']);
  // Two consecutive orders the second read saw TOGETHER stay two, whatever the third read missed.
  expect(settle([o('991138546')], [o('991138546'), o('991138547')], [o('991138546')]).map((x) => x.order_number))
    .toEqual(['991138546', '991138547']);
  // The third read can't settle it: left flagged exactly as before.
  expect(settle([o('091138476')], [o('991138476')], [o('551138476')]))
    .toEqual([expect.objectContaining({ order_number: '091138476', agreed: false, other: '991138476' })]);
  expect(settleWithThird(mergeReads([o('091138476')], [o('991138476')]), null)).toHaveLength(1);
});
