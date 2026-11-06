// POST /api/cart/gift-card-read  { cartId, fileId }  -> { ok, cards:[{number,pin,balance,retailer,already}], source }
//
// Reading gift cards OFF THE FILE the desk already uploaded, so the digits do not have
// to be retyped. The cards arrive three ways and all three land here:
//   · one card as an image — the cardwell.fund card face: CARD NUMBER, PIN, a barcode;
//   · a phone screenshot of the same;
//   · a table — a spreadsheet screenshot or a PDF listing a whole batch, one card a row
//     (balance · number · PIN);
//   · a retailer's e-gift PDF, one card a PAGE, with its fields LABELLED on lines of their
//     own ("Gift Card Value: 200.00" / "Card Number: …" / "Pin: …" — Nike's layout);
//   · a CSV the card seller exports (number · PIN · balance), usually sent alongside
//     card-face images that carry no balance.
// No AI, and nothing leaves this server (owner's call, 2026-11-06). An IMAGE is read with
// tesseract, twice, and both readings must agree: a card face is clean printed text on a flat
// picture. A PDF is read from its text with pdfjs. A PDF page with no text is one picture (the
// cardwell PDF is a card face a page), so that picture goes through the same image reader.
//
// NOTHING HERE RECORDS A CARD: every row goes back to a review table, a person ticks it, and
// only then does `cart/gift-card` encrypt and store it, one call per card, the same path a
// pasted card takes. A card number is a bearer instrument, so this endpoint also NEVER logs
// one, and the trail event says how many were read, never what.
//
// Only the issuing desk may call it (`issue_gift_cards`): reading a card image is
// reading the card, and the file endpoint already gates the image on the same duty.
import { getJsonBody, send, applySecurity, rateLimit } from '../_lib/util.js';
import { getBuyCart, getBuyCartFile, listBuyCartCardTails, logCartEvent, dbConfigured, setBuyCartFileCardTail } from '../_lib/db.js';
import { cleanCards, MAX_CARDS } from '../_lib/gcCards.js';
import { requirePrivilege } from '../_lib/buycart.js';
import { getObject, r2Configured } from '../_lib/r2.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const LOCAL_TIMEOUT_MS = 30_000;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..'); // eng.traineddata is checked in

/** Every page's text as its own list of lines, one line per baseline, top to bottom. */
export async function pdfPages(buf) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true, isEvalSupported: false }).promise;
  const pages = [];
  pages.overCap = Math.max(0, doc.numPages - MAX_CARDS);
  for (let p = 1; p <= Math.min(doc.numPages, MAX_CARDS); p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    // Group runs by their baseline so a row's balance, number and PIN stay on one line.
    const rows = new Map();
    for (const it of tc.items) {
      if (!it.str) continue;
      const y = Math.round(it.transform[5]);
      const key = [...rows.keys()].find((k) => Math.abs(k - y) <= 2) ?? y;
      rows.set(key, `${rows.get(key) || ''} ${it.str}`);
    }
    pages.push([...rows.keys()].sort((a, b) => b - a).map((k) => rows.get(k).trim()));
  }
  return pages;
}

/**
 * Cards out of plain text, one per line: the long digit run is the number, a 4–8 digit
 * run beside it is the PIN, a $ amount is the balance. Rows with no long run are skipped.
 */
export function cardsFromText(lines) {
  const out = [];
  for (const raw of lines) {
    const line = String(raw || '');
    const digitRuns = [...line.matchAll(/\b\d{12,24}\b/g)].map((m) => m[0]);
    if (!digitRuns.length) continue;
    const number = digitRuns[0];
    const rest = line.replace(number, ' ');
    const pin = (rest.match(/\b\d{4,8}\b/) || [])[0] || null;
    const money = rest.match(/\$\s*([\d,]+(?:\.\d{1,2})?)/);
    const balance = money ? Number(money[1].replace(/,/g, '')) : null;
    out.push({ number, pin, balance: Number.isFinite(balance) ? balance : null, retailer: '' });
  }
  return out;
}

const LONG_RUN = /\b\d{12,24}\b/g;

/**
 * One card off its face, from lines holding exactly one card number. The PIN and value
 * are read off their LABELS anywhere on the face; a PIN with no label of its own is the
 * short run beside the number, which is the cardwell face: "CARD NUMBER   PIN" on one
 * line, both values on the next. `labelled` says a label was actually found.
 */
export function cardFromFaceLines(lines) {
  const text = lines.join('\n');
  const number = (text.match(LONG_RUN) || [])[0];
  const labelledPin = (text.match(/\bpin(?:\s*(?:number|code|#))?\s*[:#=]?\s*(\d{4,8})\b/i) || [])[1] || null;
  const value = text.match(/\b(?:gift\s*card\s*value|card\s*value|value|balance|amount|denomination)\s*[:=]?\s*\$?\s*([\d,]+(?:\.\d{1,2})?)/i);
  const balance = value ? Number(value[1].replace(/,/g, '')) : null;
  const row = lines.find((l) => l.includes(number)) || '';
  const pin = labelledPin || (row.replace(number, ' ').match(/\b\d{4,8}\b/) || [])[0] || null;
  return {
    labelled: !!(labelledPin || value),
    card: { number, pin, balance: Number.isFinite(balance) && balance > 0 ? balance : null, retailer: '' },
  };
}

/**
 * Cards out of a PDF, page by page. A page carrying exactly ONE card number is a card
 * face — an e-gift PDF, one card a page — and its PIN and value are read off their
 * LABELS anywhere on that page. Nike prints "Pin:" and "Gift Card Value:" on lines of
 * their own, so the row reader below found every number in such a file and not one PIN
 * or balance (measured 2026-09-30 on an 8-card Nike PDF: 8 numbers, 0 PINs, 0 balances).
 * Any other page is a table and is read row by row, as before.
 */
export function cardsFromPages(pages) {
  const out = [];
  for (const page of pages || []) {
    const lines = (page || []).map((l) => String(l || ''));
    const numbers = new Set(lines.flatMap((l) => [...l.matchAll(LONG_RUN)].map((m) => m[0])));
    if (numbers.size !== 1) { out.push(...cardsFromText(lines)); continue; }
    const face = cardFromFaceLines(lines);
    // No labels at all (a card face with the digits and nothing else): the row reader.
    if (!face.labelled) { out.push(...cardsFromText(lines)); continue; }
    out.push(face.card);
  }
  return out;
}

/** One CSV record per line, quotes honoured ("a,b" stays one cell). */
function csvRows(text) {
  const rows = [];
  let row = []; let cell = ''; let q = false;
  const s = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"' && s[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',' || ch === ';' || ch === '\t') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some(Boolean));
}

/**
 * Cards out of a CSV (number · PIN · balance). Columns are found by their HEADER when
 * there is one ("Card Number", "PIN", "Balance"/"Amount"/"Value"), in any order; with no
 * header, by what the cells look like — the long digit run is the number, a 4–8 digit
 * cell the PIN, a money-shaped cell the balance.
 *
 * A number Excel has already mangled into "6.06E+18" is NOT recoverable — the digits are
 * gone — so it is reported back as `mangled` rather than silently dropped or, worse,
 * expanded into a wrong card.
 */
export function cardsFromCsv(text) {
  const rows = csvRows(text);
  if (!rows.length) return { cards: [], mangled: 0 };
  const head = rows[0].map((h) => h.toLowerCase());
  const find = (re) => head.findIndex((h) => re.test(h));
  let col = {
    number: find(/card\s*(no|num|#)|number|card\s*code|^code$|gift\s*card$|^card$/),
    pin: find(/\bpin\b|security|access|cvv|scratch/),
    balance: find(/bal|amount|value|denom|\$|price|face/),
    retailer: find(/retailer|merchant|store|brand/),
  };
  const hasHeader = col.number !== -1 && !/\d{8,}/.test(rows[0].join(''));
  const body = hasHeader ? rows.slice(1) : rows;
  if (!hasHeader) {
    // Infer from the first data row.
    const r = body[0] || [];
    col = {
      number: r.findIndex((c) => /^\d{12,24}$/.test(c.replace(/[\s-]/g, ''))),
      pin: r.findIndex((c) => /^\d{4,8}$/.test(c)),
      balance: r.findIndex((c) => /^\$?\s*[\d,]+\.\d{1,2}$/.test(c) || /^\$\s*[\d,]+$/.test(c)),
      retailer: -1,
    };
  }
  let mangled = 0;
  const cards = [];
  for (const r of body) {
    const rawNum = col.number >= 0 ? String(r[col.number] || '') : '';
    if (/\d(\.\d+)?e\+?\d+/i.test(rawNum)) { mangled++; continue; }
    const number = rawNum.replace(/[\s-]/g, '');
    if (!/^\d{8,24}$/.test(number)) continue;
    const pin = col.pin >= 0 ? (String(r[col.pin] || '').replace(/\D/g, '') || null) : null;
    const b = col.balance >= 0 ? Number(String(r[col.balance] || '').replace(/[$,\s]/g, '')) : NaN;
    const retailer = col.retailer >= 0 ? String(r[col.retailer] || '').trim() : '';
    cards.push({ number, pin, balance: Number.isFinite(b) && b > 0 ? b : null, retailer });
  }
  return { cards, mangled };
}

/**
 * The two readings of one card face → the card, or null when this is not a job for
 * tesseract. Null covers no number, more than one number (a table), and readings that
 * differ on the number or the PIN: a wrong digit is a card that cannot be spent, so a
 * disagreement goes to the vision model rather than to a guess. The balance may come from
 * either reading, and a person fills it in if neither has one.
 */
export function cardFromTwoReadings(a, b) {
  const read = (text) => {
    const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
    const numbers = new Set(lines.flatMap((l) => [...l.matchAll(LONG_RUN)].map((m) => m[0])));
    return numbers.size === 1 ? cardFromFaceLines(lines).card : null;
  };
  const [x, y] = [read(a), read(b)];
  if (!x || !y || x.number !== y.number || x.pin !== y.pin) return null;
  if (x.balance != null && y.balance != null && x.balance !== y.balance) return { ...x, balance: null };
  return { ...x, balance: x.balance ?? y.balance };
}

/**
 * Several cards in one picture (a screenshot of a table), from the two readings: a row counts
 * only when both readings have its number with the same PIN. Empty for a single card.
 */
function tableFromTwoReadings(a, b) {
  const rows = (text) => cardsFromText(String(text || '').split('\n'));
  const [x, y] = [rows(a), rows(b)];
  if (x.length < 2 || y.length < 2) return [];
  return x.flatMap((r) => {
    const twin = y.find((o) => o.number === r.number && o.pin === r.pin);
    if (!twin) return [];
    return [{ ...r, balance: r.balance === twin.balance ? r.balance : null }];
  });
}

/**
 * Tesseract, twice: the picture as it is and with its light and dark swapped, because a card
 * prints white digits on colour. Transparent corners are flattened first, or they read as noise
 * and the whole card fails. With the language file we ship: no download, nothing sent anywhere.
 * Any failure is "could not read it" (no cards), and the screen says to type it in.
 */
async function readImageOnce(buf) {
  let worker;
  let timer;
  try {
    const sharp = (await import('sharp')).default;
    const { createWorker } = await import('tesseract.js');
    const base = sharp(buf).rotate().flatten({ background: '#808080' }).resize({ width: 2400 }).greyscale();
    const plain = await base.clone().png().toBuffer();
    const swapped = await base.clone().negate().normalise().png().toBuffer();
    worker = await createWorker('eng', 1, { langPath: REPO_ROOT, gzip: false, cachePath: tmpdir() });
    const read = async () => {
      const a = (await worker.recognize(plain)).data.text;
      const b = (await worker.recognize(swapped)).data.text;
      const one = cardFromTwoReadings(a, b);
      return one ? [one] : tableFromTwoReadings(a, b);
    };
    const late = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('local read timed out')), LOCAL_TIMEOUT_MS); });
    return await Promise.race([read(), late]);
  } catch (e) {
    console.error('[cart/gift-card-read] local', e.message); // the message only: never the text it read
    return [];
  } finally {
    clearTimeout(timer);
    if (worker) await worker.terminate().catch(() => {});
  }
}

// One at a time: each worker loads the language model into memory, and a PDF of pictures or
// the all-cards PDF can ask about many at once. readImageOnce never rejects.
let localQueue = Promise.resolve();
export function readCardsLocally(buf) {
  const run = localQueue.then(() => readImageOnce(buf));
  localQueue = run;
  return run;
}

/** The biggest picture on a PDF page, as a PNG, or null. Page numbers start at 1. */
export async function pdfPageImage(doc, pageNumber, pdfjs) {
  const sharp = (await import('sharp')).default;
  const page = await doc.getPage(pageNumber);
  const ops = await page.getOperatorList();
  let best = null;
  for (let i = 0; i < ops.fnArray.length; i++) {
    if (ops.fnArray[i] !== pdfjs.OPS.paintImageXObject) continue;
    const name = ops.argsArray[i][0];
    const img = await Promise.race([
      new Promise((res) => (page.objs.has(name) ? res(page.objs.get(name)) : page.objs.get(name, res))),
      new Promise((res) => { setTimeout(() => res(null), 10_000); }),
    ]);
    if (img?.data && (!best || img.width * img.height > best.width * best.height)) best = img;
  }
  if (!best) return null;
  const channels = best.data.length / (best.width * best.height);
  if (channels !== 3 && channels !== 4) return null;   // a 1-bit scan has no plain pixels to hand on
  return sharp(Buffer.from(best.data), { raw: { width: best.width, height: best.height, channels } }).png().toBuffer();
}

/**
 * Every card in a PDF. A page with text is read from its text; a page with none is a picture of
 * a card and is read as one. `unread` counts picture pages nothing came off, so the screen can
 * say some were missed rather than reading like the whole file was done.
 */
export async function cardsFromPdf(buf) {
  const pages = await pdfPages(buf);
  const cards = [];
  let unread = pages.overCap;   // pages past the cap are pages nobody read, and the screen says so
  let pictures = 0;
  let open = null;
  for (let i = 0; i < pages.length; i++) {
    if (pages[i].length) { cards.push(...cardsFromPages([pages[i]])); continue; }
    if (!open) {
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
      open = { pdfjs, doc: await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true, isEvalSupported: false, verbosity: 0 }).promise };
    }
    pictures++;
    const png = await pdfPageImage(open.doc, i + 1, open.pdfjs).catch(() => null);
    const read = png ? await readCardsLocally(png) : [];
    if (read.length) cards.push(...read.map((c) => ({ ...c, page: i }))); else unread++;
  }
  return { cards, unread, pictures };
}

/**
 * Every card in one file, by its kind. Reads and returns; records nothing, logs no digit.
 * `single` is an image holding exactly one card: its last four pair the picture with its card
 * on the all-cards PDF.
 */
export async function readCardFile(file, bytes, tails = []) {
  const isPdf = String(file.content_type || '').includes('pdf') || /\.pdf$/i.test(file.name || '');
  const isCsv = /csv|comma-separated/.test(String(file.content_type || '')) || /\.csv$/i.test(file.name || '');
  if (isPdf) {
    const parsed = await cardsFromPdf(bytes);
    return { cards: cleanCards(parsed.cards, tails), source: parsed.pictures ? 'local' : 'pdf', unread: parsed.unread, mangled: 0, single: false };
  }
  if (isCsv) {
    const parsed = cardsFromCsv(bytes.toString('utf8'));
    return { cards: cleanCards(parsed.cards, tails), source: 'csv', unread: 0, mangled: parsed.mangled, single: false };
  }
  const cards = cleanCards(await readCardsLocally(bytes), tails);
  return { cards, source: 'local', unread: 0, mangled: 0, single: cards.length === 1 };
}

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = await requirePrivilege(req, res, 'issue_gift_cards');
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 12 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded — wait a minute before reading another.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const cartId = Number(body.cartId);
  const fileId = Number(body.fileId);
  if (!Number.isInteger(cartId) || !Number.isInteger(fileId))
    return send(res, 400, { ok: false, error: 'Which file?' });

  try {
    const cart = await getBuyCart(cartId);
    if (!cart) return send(res, 404, { ok: false, error: 'That buying request does not exist.' });
    const file = await getBuyCartFile(cartId, fileId);
    if (!file || file.kind !== 'gift_card')
      return send(res, 404, { ok: false, error: 'That card image is not on this request.' });

    // After the access and file checks, so a stranger learns nothing about the server.
    if (!r2Configured()) return send(res, 503, { ok: false, error: 'File storage is not configured.' });
    const tails = await listBuyCartCardTails(cartId);
    if (/\.zip$/i.test(file.r2_key || ''))
      return send(res, 409, { ok: false, error: 'This ZIP is being unpacked on the server. Its cards will come up for review by themselves.' });
    const { cards, source, mangled, unread, single } = await readCardFile(file, await getObject(file.r2_key), tails);
    // A card face is ONE card: remember which (its last four — shown on screen anyway,
    // never the number) so the gift-card PDF can put this picture on that card's page.
    if (single) await setBuyCartFileCardTail(cartId, fileId, cards[0].number.slice(-4)).catch(() => {});

    // On the trail: HOW MANY, by what, from which file. Never a digit of any of them.
    await logCartEvent({
      cartId, kind: 'gc_read', actor: user,
      body: `${cards.length} card${cards.length === 1 ? '' : 's'} read from “${file.name || 'file'}” by ${source === 'pdf' ? 'the PDF text' : source === 'csv' ? 'the CSV' : 'this server, read twice'} — nothing recorded until reviewed`,
    });
    return send(res, 200, { ok: true, cards, source, mangled, unread, file: { id: Number(file.id), name: file.name } });
  } catch (e) {
    console.error('[cart/gift-card-read]', e.message);
    return send(res, 500, { ok: false, error: 'Could not read that file.' });
  }
}
