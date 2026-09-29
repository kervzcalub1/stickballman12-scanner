// GET /api/cart/gift-cards-pdf?cartId=…  -> application/pdf
//
// Every live gift card on a request as ONE PDF, a page a card: the balance, the full
// number and PIN, and the card's own picture under them (its barcode is what the till
// scans). The cards arrive in pieces — a CSV from the card seller with number · PIN ·
// balance, plus card-face images that carry no balance; or a retailer PDF, one card a
// page — and the buyer at the till needs the pieces together, not three files to cross-
// reference on a phone.
//
// It prints every code on the request, so it is the bulk form of `cart/gc-reveal` and
// follows the same rules exactly:
//   · who: the issuing desk, and the buyer on their own request once it is released;
//   · the trail row is written BEFORE anything is decrypted — "who could have spent
//     this" is the question the record exists to answer;
//   · no-store, never a bucket URL, never logged.
//
// Page order: the CSV's row order whenever the request has a CSV (matched on the full
// number) — never the order cards were recorded or images uploaded. Cards on no CSV follow.
//
// Pairing a picture with its card:
//   · a PDF page is matched by the FULL number in its text layer;
//   · an image by the last four remembered when it was read (`buy_cart_files.gc_last4`),
//     and an image never read is read now, once (the vision model, ~$0.003), and
//     remembered. A picture that matches no live card is still printed, at the end,
//     under a heading that says so — dropping it would hide a card nobody recorded.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { send, applySecurity, rateLimit, requireAuth, isPrivileged, blockIfMustChange } from '../_lib/util.js';
import {
  getBuyCart, listBuyCartGiftCardSecrets, listBuyCartCardFiles, setBuyCartFileCardTail, logCartEvent, dbConfigured,
} from '../_lib/db.js';
import { decryptSecret, secretsConfigured } from '../_lib/secrets.js';
import { hasPrivilege, requireBuyerAccess } from '../_lib/buycart.js';
import { getObject, r2Configured } from '../_lib/r2.js';
import { pdfPages, readCardImage, aiConfigured, cardsFromCsv } from './gift-card-read.js';

const PAGE_W = 612; // US Letter
const PAGE_H = 792;
const M = 48;
const INK = rgb(0.1, 0.1, 0.12);
const MUTED = rgb(0.42, 0.44, 0.48);
const RULE = rgb(0.85, 0.86, 0.88);

// The standard fonts are WinAnsi: a file name with an emoji or a CJK character would
// throw mid-document. Anything outside printable ASCII is dropped to "?".
const ascii = (s) => String(s ?? '').replace(/[^\x20-\x7E]/g, '?');
const money = (n) => `$${(Number(n) || 0).toFixed(2)}`;
const grouped = (d) => String(d || '').replace(/(\d{4})(?=\d)/g, '$1 ');
const estStamp = () => `${new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
}).format(new Date())} EST`;

async function jpegFor(buf) {
  const sharp = (await import('sharp')).default;
  return sharp(buf).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 }).toBuffer();
}

// A few images at a time: each is a model call, and a request can carry twenty cards.
async function mapLimit(list, n, fn) {
  const out = new Array(list.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => {
    while (i < list.length) { const k = i++; out[k] = await fn(list[k], k); }
  }));
  return out;
}

/**
 * The document itself: a page per card (`cards` carry the DECRYPTED code/pin — the
 * caller has already written the trail row), its picture from `pictureFor` (card id →
 * { kind:'img', bytes } | { kind:'pdf', bytes, page }), then any `loose` pictures.
 * Separate from the handler so it can be rendered without a request or a bucket.
 */
export async function buildGiftCardPdf({ cards, pictureFor = new Map(), loose = [], cartCode = '', printedFor = '' }) {
// ---- The document ---------------------------------------------------------------
const doc = await PDFDocument.create();
doc.setTitle(`${cartCode} gift cards`);
const font = await doc.embedFont(StandardFonts.Helvetica);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);
const stamp = `${ascii(cartCode)} · printed for ${ascii(printedFor || 'you')} · ${estStamp()}`;
const embedded = new Map();     // source pdf bytes -> PDFDocument pages already embedded

async function drawPicture(page, pic, top) {
  const boxW = PAGE_W - 2 * M;
  const boxH = top - M - 28;
  if (!pic) {
    page.drawText('No picture of this card on file — use the number and PIN above.', { x: M, y: top - 16, size: 10, font, color: MUTED });
    return;
  }
  try {
    let w; let h; let draw;
    if (pic.kind === 'pdf') {
      // Every page of a source PDF is embedded once, the first time any card needs one.
      if (!embedded.has(pic.bytes)) {
        const n = (await PDFDocument.load(pic.bytes, { ignoreEncryption: true })).getPageCount();
        embedded.set(pic.bytes, await doc.embedPdf(pic.bytes, [...Array(n).keys()]));
      }
      const ep = embedded.get(pic.bytes)[pic.page];
      ({ width: w, height: h } = ep);
      draw = (x, y, sw, sh) => page.drawPage(ep, { x, y, width: sw, height: sh });
    } else {
      const img = await doc.embedJpg(await jpegFor(pic.bytes));
      ({ width: w, height: h } = img);
      draw = (x, y, sw, sh) => page.drawImage(img, { x, y, width: sw, height: sh });
    }
    const k = Math.min(boxW / w, boxH / h, 1.5);
    const sw = w * k; const sh = h * k;
    draw(M + (boxW - sw) / 2, top - sh, sw, sh);
  } catch {
    page.drawText('The picture on file could not be drawn — open it from the request.', { x: M, y: top - 16, size: 10, font, color: MUTED });
  }
}

for (const [i, c] of cards.entries()) {
  const page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - M;
  page.drawText(`Gift card ${i + 1} of ${cards.length}`, { x: M, y: y - 12, size: 12, font: bold, color: MUTED });
  const who = [c.retailer, c.label].filter(Boolean).map(ascii).join(' · ');
  if (who) page.drawText(who.slice(0, 80), { x: M + 150, y: y - 12, size: 10, font, color: MUTED });
  y -= 48;
  page.drawText(money(c.balance), { x: M, y, size: 30, font: bold, color: INK });
  y -= 40;
  page.drawText('CARD NUMBER', { x: M, y, size: 9, font: bold, color: MUTED });
  page.drawText(grouped(c.code), { x: M, y: y - 24, size: 20, font: bold, color: INK });
  y -= 58;
  page.drawText('PIN', { x: M, y, size: 9, font: bold, color: MUTED });
  page.drawText(c.pin || '— none on record', { x: M, y: y - 24, size: 20, font: c.pin ? bold : font, color: c.pin ? INK : MUTED });
  y -= 44;
  page.drawLine({ start: { x: M, y }, end: { x: PAGE_W - M, y }, thickness: 1, color: RULE });
  await drawPicture(page, pictureFor.get(c.id), y - 14);
  page.drawText(stamp, { x: M, y: M - 20, size: 8, font, color: MUTED });
}
for (const [i, p] of loose.entries()) {
  const page = doc.addPage([PAGE_W, PAGE_H]);
  page.drawText(`Picture not matched to a recorded card (${i + 1} of ${loose.length})`, { x: M, y: PAGE_H - M - 12, size: 12, font: bold, color: MUTED });
  page.drawText(ascii(p.name || '').slice(0, 90), { x: M, y: PAGE_H - M - 30, size: 9, font, color: MUTED });
  await drawPicture(page, { kind: 'img', bytes: p.bytes }, PAGE_H - M - 44);
  page.drawText(stamp, { x: M, y: M - 20, size: 8, font, color: MUTED });
}
  return Buffer.from(await doc.save());
}

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  // Two people qualify two different ways — the same shape as gc-reveal.
  const user = requireAuth(req, res);
  if (!user) return;
  if (!(await requireBuyerAccess(req, res, user))) return;
  if (blockIfMustChange(user, res)) return;
  const isBuyer = user.role === 'supplier' && !isPrivileged(user.role);
  if (!isBuyer && !(await hasPrivilege(user, 'issue_gift_cards')))
    return send(res, 403, { ok: false, error: 'You do not have access to gift card numbers.' });
  if (!rateLimit(req, { windowMs: 60_000, max: 6 }))
    return send(res, 429, { ok: false, error: 'Too many downloads. Wait a moment.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  if (!secretsConfigured())
    return send(res, 503, { ok: false, error: 'Gift card codes can’t be read on this server (BUY_GC_KEY is not set).' });

  const cartId = Number(new URL(req.url, 'http://x').searchParams.get('cartId'));
  if (!Number.isInteger(cartId)) return send(res, 400, { ok: false, error: 'A valid cartId is required.' });

  try {
    const cart = await getBuyCart(cartId);
    if (!cart) return send(res, 404, { ok: false, error: 'That buying request does not exist.' });
    if (isBuyer) {
      if (Number(cart.buyer_user_id) !== Number(user.uid))
        return send(res, 403, { ok: false, error: 'You do not have access to this request.' });
      if (!['funded', 'receipted', 'audited', 'closed'].includes(cart.status))
        return send(res, 409, { ok: false, error: 'These cards have not been released to you yet.' });
    }
    const rows = await listBuyCartGiftCardSecrets(cartId);
    if (!rows.length) return send(res, 404, { ok: false, error: 'No gift cards are recorded on this request yet.' });
    const files = r2Configured() ? await listBuyCartCardFiles(cartId) : [];

    // The trail first, the secrets second.
    const total = rows.reduce((a, r) => a + (Number(r.balance) || 0), 0);
    await logCartEvent({
      cartId, kind: 'gc_pdf', actor: user,
      body: `${rows.length} card${rows.length === 1 ? '' : 's'} · ${money(total)} downloaded as one PDF`,
    });
    const cards = rows.map((r) => ({
      ...r,
      code: decryptSecret(r.code_enc),
      pin: r.pin_enc ? decryptSecret(r.pin_enc) : null,
    }));

    // ---- Pictures → cards ---------------------------------------------------------
    const pictureFor = new Map();   // card id -> { kind:'img', bytes } | { kind:'pdf', bytes, page }
    const loose = [];               // pictures that match no live card
    const byTail = (t) => cards.filter((c) => c.code.slice(-4) === t);
    await mapLimit(files, 4, async (f) => {
      const isPdf = String(f.content_type || '').includes('pdf') || /\.pdf$/i.test(f.name || '');
      const isImg = String(f.content_type || '').startsWith('image/');
      if (!isPdf && !isImg) return;   // a CSV has no picture
      let bytes;
      try { bytes = await getObject(f.r2_key); } catch { return; }
      if (isPdf) {
        let pages = [];
        try { pages = await pdfPages(bytes); } catch { return; }
        pages.forEach((lines, page) => {
          const text = lines.join(' ').replace(/[\s-]/g, '');
          const hit = cards.find((c) => !pictureFor.has(c.id) && c.code.length >= 8 && text.includes(c.code));
          if (hit) pictureFor.set(hit.id, { kind: 'pdf', bytes, page, name: f.name });
        });
        return;
      }
      let tail = f.gc_last4 || null;
      let fullNumber = null;
      if (!tail && aiConfigured()) {
        try {
          const read = await readCardImage(f.r2_key);
          const nums = [...new Set((read || []).map((c) => String(c?.number || '').replace(/\D/g, '')).filter((n) => n.length >= 8))];
          if (nums.length === 1) {
            fullNumber = nums[0];
            tail = fullNumber.slice(-4);
            await setBuyCartFileCardTail(cartId, f.id, tail).catch(() => {});
          }
        } catch { /* unread → printed as unmatched below */ }
      }
      // An exact number beats the last four; the last four alone must name ONE card.
      const exact = fullNumber ? cards.find((c) => c.code === fullNumber) : null;
      const byFour = !exact && tail ? byTail(tail) : [];
      const hit = exact || (byFour.length === 1 ? byFour[0] : null);
      if (hit && !pictureFor.has(hit.id)) pictureFor.set(hit.id, { kind: 'img', bytes, name: f.name });
      else loose.push({ bytes, name: f.name });
    });

    // ---- Page order: the CSV's -------------------------------------------------------
    // The card seller's CSV is the list the buyer works from, so the pages follow ITS
    // rows — not the order the cards were recorded, and not the order the images were
    // uploaded or read in. Matched on the full number. Several CSVs: in upload order,
    // each in its row order. A card on no CSV keeps its recorded place, after them.
    const rank = new Map();
    for (const f of files) {
      if (!/csv|comma-separated/.test(String(f.content_type || '')) && !/\.csv$/i.test(f.name || '')) continue;
      try {
        for (const c of cardsFromCsv((await getObject(f.r2_key)).toString('utf8')).cards)
          if (!rank.has(c.number)) rank.set(c.number, rank.size);
      } catch { /* an unreadable CSV just doesn't order anything */ }
    }
    if (rank.size) {
      const recorded = new Map(cards.map((c, i) => [c.id, i]));
      const at = (c) => (rank.has(c.code) ? rank.get(c.code) : rank.size + recorded.get(c.id));
      cards.sort((x, y) => at(x) - at(y));
    }

    const bytes = await buildGiftCardPdf({ cards, pictureFor, loose, cartCode: cart.cart_code, printedFor: user.username || user.name });

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', String(bytes.length));
    res.setHeader('Content-Disposition', `attachment; filename="${ascii(cart.cart_code).replace(/[^A-Za-z0-9._-]/g, '_')}-gift-cards.pdf"`);
    // A spendable code must never sit in a shared cache.
    res.setHeader('Cache-Control', 'private, no-store');
    return res.end(bytes);
  } catch (e) {
    console.error('[cart/gift-cards-pdf]', e.message);
    return send(res, 500, { ok: false, error: 'Could not build the gift card PDF.' });
  }
}
