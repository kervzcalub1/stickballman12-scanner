// POST /api/cart/gift-card-read  { cartId, fileId }  -> { ok, cards:[{number,pin,balance,retailer,already}], source }
//
// Reading gift cards OFF THE FILE the desk already uploaded, so the digits do not have
// to be retyped. The cards arrive three ways and all three land here:
//   · one card as an image — the cardwell.fund card face: CARD NUMBER, PIN, a barcode;
//   · a phone screenshot of the same;
//   · a table — a spreadsheet screenshot or a PDF listing a whole batch, one card a row
//     (balance · number · PIN).
// An IMAGE goes to the vision model, the same reader and the same rules as the receipt
// (`receipt-read.js`). A PDF is text already, so it is read with pdfjs and a regex —
// paying a model to look at a picture of text would spend money to lose accuracy.
//
// THE MODEL IS A READER, NOT A DECIDER. Nothing here records a card: every row goes back
// to a review table, a person ticks it, and only then does `cart/gift-card` encrypt and
// store it — one call per card, the same path a pasted card takes. A card number is a
// bearer instrument, so this endpoint also NEVER logs one, and the trail event says how
// many were read, never what.
//
// Only the issuing desk may call it (`issue_gift_cards`): reading a card image is
// reading the card, and the file endpoint already gates the image on the same duty.
import { getJsonBody, send, applySecurity, rateLimit } from '../_lib/util.js';
import { getBuyCart, getBuyCartFile, listBuyCartCardTails, logCartEvent, dbConfigured } from '../_lib/db.js';
import { requirePrivilege } from '../_lib/buycart.js';
import { getObject, r2Configured } from '../_lib/r2.js';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = process.env.RECEIPT_AI_MODEL || process.env.PAYOUT_AI_MODEL || 'gpt-5.4-mini';
const MAX_EDGE = 1500;
const TIMEOUT_MS = 45_000;
const MAX_CARDS = 60;

const aiConfigured = () => !!process.env.OPENAI_API_KEY;

const PROMPT = `This image shows one or more retail gift cards — either a card face (with "CARD NUMBER", "PIN" and a barcode) or a table listing several cards, one per row. Return JSON only, in this exact shape:
{"cards":[{"number":"","pin":"","balance":null,"retailer":""}]}

- "number" is the full card number, digits only, copied EXACTLY as printed (typically 16–19 digits). Never invent or pad digits.
- "pin" is the PIN / security code printed beside it (typically 4–8 digits), or null if none is shown.
- "balance" is the dollar amount for that card if one is shown (e.g. a "$200.00" column), as a number, else null. Never guess a balance.
- "retailer" is the store the card is for if shown (e.g. "Nike"), else "".
- One entry per card. If a number is not fully legible, LEAVE THAT CARD OUT rather than guessing — a wrong digit is a card that cannot be spent.`;

async function imageForModel(key) {
  const buf = await getObject(key);
  try {
    const sharp = (await import('sharp')).default;
    const out = await sharp(buf).rotate()
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 }).toBuffer();
    return { b64: out.toString('base64'), mime: 'image/jpeg' };
  } catch {
    return { b64: buf.toString('base64'), mime: 'image/jpeg' };
  }
}

/** Every page's text, one line per text run, top to bottom. */
async function pdfText(key) {
  const buf = await getObject(key);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true, isEvalSupported: false }).promise;
  const lines = [];
  for (let p = 1; p <= Math.min(doc.numPages, 20); p++) {
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
    for (const k of [...rows.keys()].sort((a, b) => b - a)) lines.push(rows.get(k).trim());
  }
  return lines;
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

/** Tidy and de-duplicate whatever the reader produced; never trust a shape. */
function cleanCards(list, tails) {
  const seen = new Set();
  const out = [];
  for (const c of Array.isArray(list) ? list : []) {
    const number = String(c?.number ?? '').replace(/\D/g, '');
    if (number.length < 8 || number.length > 24 || seen.has(number)) continue;
    seen.add(number);
    const pin = String(c?.pin ?? '').replace(/\D/g, '').slice(0, 12) || null;
    const b = Number(c?.balance);
    out.push({
      number,
      pin,
      balance: Number.isFinite(b) && b > 0 ? Math.round(b * 100) / 100 : null,
      retailer: String(c?.retailer ?? '').trim().slice(0, 60) || null,
      // Same last four as a card already on this request — a likely re-read of the same
      // card. A hint for the reviewer, not a refusal: two cards can end the same way.
      already: tails.includes(number.slice(-4)),
    });
    if (out.length >= MAX_CARDS) break;
  }
  return out;
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
    const isPdf = String(file.content_type || '').includes('pdf') || /\.pdf$/i.test(file.name || '');
    let cards;
    let source;
    if (isPdf) {
      source = 'pdf';
      cards = cleanCards(cardsFromText(await pdfText(file.r2_key)), tails);
    } else {
      if (!aiConfigured())
        return send(res, 503, { ok: false, error: 'Reading card images with AI is not configured on this server — type the numbers in.' });
      source = 'ai';
      const { b64, mime } = await imageForModel(file.r2_key);
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
      let payload;
      try {
        const r = await fetch(OPENAI_URL, {
          method: 'POST', signal: ac.signal,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
          body: JSON.stringify({
            model: MODEL,
            response_format: { type: 'json_object' },
            messages: [{ role: 'user', content: [
              { type: 'text', text: PROMPT },
              { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
            ] }],
          }),
        });
        if (!r.ok) {
          console.error('[cart/gift-card-read] openai', r.status);
          return send(res, 502, { ok: false, error: 'The reader did not answer. Try again, or type the numbers in.' });
        }
        payload = await r.json();
      } finally { clearTimeout(timer); }
      let out;
      try { out = JSON.parse(payload?.choices?.[0]?.message?.content || '{}'); }
      catch { return send(res, 502, { ok: false, error: 'The reader answered with something unreadable. Type the numbers in.' }); }
      cards = cleanCards(out.cards, tails);
    }

    // On the trail: HOW MANY, by what, from which file. Never a digit of any of them.
    await logCartEvent({
      cartId, kind: 'gc_read', actor: user,
      body: `${cards.length} card${cards.length === 1 ? '' : 's'} read from “${file.name || 'file'}” by ${source === 'pdf' ? 'the PDF text' : MODEL} — nothing recorded until reviewed`,
    });
    return send(res, 200, { ok: true, cards, source, file: { id: Number(file.id), name: file.name } });
  } catch (e) {
    const aborted = e.name === 'AbortError';
    console.error('[cart/gift-card-read]', e.message);
    return send(res, aborted ? 504 : 500, {
      ok: false,
      error: aborted ? 'The reader took too long. Try again, or type the numbers in.' : 'Could not read that file.',
    });
  }
}
