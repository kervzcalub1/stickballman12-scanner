// Pure helpers for reading gift card files: tidying what the reader found, opening Cardwell's
// ZIP, and merging many files into one review table. No database, no storage, no logging, so
// no digit can leave here by accident (docs/context/buy-cart.md).
import { unzipSync } from 'fflate';

export const MAX_CARDS = 200;
export const MAX_ZIP_FILES = 200;
const MAX_ENTRY_BYTES = 20 * 1024 * 1024;
const MAX_ZIP_BYTES = 300 * 1024 * 1024;

/** Tidy and de-duplicate whatever the reader produced; never trust a shape. */
export function cleanCards(list, tails = []) {
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

// A file name can hold a whole card number. Names are shown to more people than the digits are.
export const maskDigitsInName = (name) => String(name || '').replace(/\d{8,}/g, (d) => `••••${d.slice(-4)}`);

/** What a file in a ZIP really is, by its first bytes (and the name, for a CSV), or null. */
function entryType(name, b) {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: 'jpg', contentType: 'image/jpeg' };
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { ext: 'png', contentType: 'image/png' };
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) return { ext: 'webp', contentType: 'image/webp' };
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return { ext: 'pdf', contentType: 'application/pdf' };
  if (/\.csv$/i.test(name)) return { ext: 'csv', contentType: 'text/csv' };
  return null;
}

/**
 * The card files inside a ZIP, in name order (Cardwell numbers them 001-, 002-…).
 * `skipped` counts real files that aren't a card picture, PDF or CSV, or are too big; the
 * screen says so rather than a card quietly going missing. Folders and the junk macOS and
 * Windows add don't count. A ZIP over the limits, password-protected or damaged throws.
 */
export function cardFilesFromZip(bytes) {
  let skipped = 0;
  let total = 0;
  let count = 0;
  const isJunk = (name) => name.endsWith('/') || /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db|desktop\.ini)(\/|$)/i.test(name) || /(^|\/)\.[^/]*$/.test(name);
  const raw = unzipSync(new Uint8Array(bytes), {
    filter: (f) => {
      if (isJunk(f.name)) return false;
      if (f.originalSize > MAX_ENTRY_BYTES) { skipped++; return false; }
      total += f.originalSize;
      count++;
      if (count > MAX_ZIP_FILES) throw new Error(`more than ${MAX_ZIP_FILES} files`);
      if (total > MAX_ZIP_BYTES) throw new Error('too large');
      return true;
    },
  });
  const files = [];
  for (const name of Object.keys(raw).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
    const data = raw[name];
    const type = data?.length ? entryType(name, data) : null;
    if (!type) { skipped++; continue; }
    files.push({ name: maskDigitsInName(name.split('/').pop()), bytes: Buffer.from(data), ...type });
  }
  return { files, skipped };
}

/**
 * Many files' readings → one review table, by full number. The same card in two files is one
 * row (a CSV's balance fills in the blank a picture left). When the files disagree on its PIN
 * or balance, the row keeps the first reading and `conflict` holds it unticked for a person.
 * @param {Array<{fileId:number, fileName:string, cards:Array}>} reads
 */
export function mergeCardReads(reads, tails = []) {
  const byNumber = new Map();
  for (const { fileId, fileName, cards } of reads) {
    for (const c of cards || []) {
      const had = byNumber.get(c.number);
      if (!had) { byNumber.set(c.number, { ...c, fileId, fileName, conflict: false }); continue; }
      if (c.pin && had.pin && c.pin !== had.pin) had.conflict = true;
      if (c.balance != null && had.balance != null && c.balance !== had.balance) had.conflict = true;
      had.pin = had.pin || c.pin;
      had.balance = had.balance ?? c.balance;
      had.retailer = had.retailer || c.retailer;
    }
  }
  return [...byNumber.values()].map((c) => ({ ...c, already: tails.includes(c.number.slice(-4)) }));
}
