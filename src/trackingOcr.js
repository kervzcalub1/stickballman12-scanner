import { lazyImport } from './lib/chunkLoad.js';
import { detectCarrierKey } from './lib/carriers.js';

// Decode a carrier tracking number from an uploaded/snapped label photo — the
// fallback for smudged or hard-to-scan labels (UPS/USPS/FedEx/DHL).
// Primary: decode a barcode in the image with zxing. Fallback: OCR the printed
// digits with Tesseract. Both libraries are imported lazily so they stay out of
// the main bundle and only download when this feature is actually used.

// Pull the most tracking-number-like token out of free OCR text.
function pickFromText(text) {
  const s = String(text || '').toUpperCase().replace(/[^0-9A-Z]/g, ' ');
  const compact = s.replace(/\s+/g, '');
  const upsC = compact.match(/1Z[0-9A-Z]{16}/); // UPS 1Z, incl. the SPACED human-readable form ("1Z E0X 4W6 …")
  if (upsC) return upsC[0];
  const fx96 = compact.match(/96\d{18,38}/); // FedEx Ground 96-barcode
  if (fx96) return fx96[0];
  const ups = s.match(/(?:^|\s)(1Z[0-9A-Z]{16})(?=\s|$)/); // UPS: standalone 1Z token
  if (ups) return ups[1];
  const digitRuns = s.match(/\d{12,40}/g);
  if (digitRuns) return digitRuns.sort((a, b) => b.length - a.length)[0];
  const anyRun = s.match(/[0-9A-Z]{10,40}/g);
  return anyRun ? anyRun.sort((a, b) => b.length - a.length)[0] : '';
}

// Does a string look like a real carrier tracking number (not routing/MaxiCode noise)?
const isTrackingLike = (v) => {
  const s = String(v || '').toUpperCase().replace(/\s+/g, '');
  return /^1Z[0-9A-Z]{16}$/.test(s) || /^96\d{18,38}$/.test(s) || /^\d{12,40}$/.test(s);
};

export async function decodeTrackingImage(file) {
  const url = URL.createObjectURL(file);
  try {
    // 1) Barcode(s) in the image. A shipping label carries several (MaxiCode, routing
    // Code128, the 1Z) and zxing returns whichever it locks onto first — which is often
    // NOT the tracking number. So run the decoded text through pickFromText to pull a
    // real tracking pattern (the 1Z is usually embedded in the routing/MaxiCode payload
    // too), and only trust it if it actually looks like a tracking number.
    let barcodeText = '';
    try {
      const { BrowserMultiFormatReader } = await lazyImport(() => import('@zxing/browser'));
      const { DecodeHintType, BarcodeFormat } = await lazyImport(() => import('@zxing/library'));
      // TRY_HARDER + restrict to the formats couriers actually print the tracking number
      // in — Code128 (UPS 1Z / USPS), Code39, ITF (FedEx 96-barcode) — plus MaxiCode /
      // Data Matrix whose payload embeds the 1Z. Restricting off the busy 2D graphics on a
      // shipping label helps zxing lock onto the tracking barcode instead of returning
      // nothing. pickFromText then pulls the 1Z out of whichever one decodes.
      const hints = new Map();
      hints.set(DecodeHintType.TRY_HARDER, true);
      hints.set(DecodeHintType.POSSIBLE_FORMATS, [
        BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.ITF,
        BarcodeFormat.PDF_417, BarcodeFormat.MAXICODE, BarcodeFormat.DATA_MATRIX,
      ]);
      const reader = new BrowserMultiFormatReader(hints);
      const res = await reader.decodeFromImageUrl(url);
      barcodeText = res?.getText?.() || res?.text || '';
    } catch { /* no readable barcode — fall through to OCR */ }
    const fromBarcode = pickFromText(barcodeText);
    if (isTrackingLike(fromBarcode)) return { value: fromBarcode, via: 'barcode' };

    // 2) OCR the human-readable number printed on the label (catches the 1Z when the
    // barcode read gave routing noise).
    const { default: Tesseract } = await lazyImport(() => import('tesseract.js'));
    const { data } = await Tesseract.recognize(url, 'eng');
    const fromOcr = pickFromText(data?.text);
    if (isTrackingLike(fromOcr)) return { value: fromOcr, via: 'ocr' };

    // Nothing that looks like a tracking number — leave it BLANK for manual entry rather
    // than surfacing routing/URL noise (e.g. a label footer's "ActionOriginPair" URL param).
    return { value: '', via: fromBarcode ? 'barcode' : 'ocr' };
  } finally {
    URL.revokeObjectURL(url);
  }
}

// A tracking number is 12–40 digits, often printed *grouped* ("9400 1000 0000 …"),
// so spaces can't be treated as separators. UPS is "1Z" + 16.
const GROUPED_RE = /\b\d{2,5}(?:\s+\d{2,5}){2,7}\b/g; // "1234 5678 90" style
const norm = (s) => String(s).replace(/\s+/g, '');
const inRange = (d) => d.length >= 12 && d.length <= 40;

// Rank candidates: the real tracking number is usually printed more than once on a
// label (routing + human-readable), so prefer the most-repeated, then the longest.
function bestOf(list, strs) {
  const hay = strs.join(' ').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
  const seen = new Map();
  for (const d of list) if (!seen.has(d)) seen.set(d, true);
  const occ = (d) => { let n = 0, i = 0; while ((i = hay.indexOf(d, i)) >= 0) { n++; i += d.length; } return n; };
  return [...seen.keys()].sort((a, b) => (occ(b) - occ(a)) || (b.length - a.length))[0];
}

// Pick the tracking number from a PDF page's positioned text ITEMS. Crucially we
// look at each item on its own — joining the whole page with spaces merges adjacent
// label fields (the tracking number runs into the zip / the FedEx ASTRA form line),
// producing bogus mega-numbers. Priority: (1) UPS anywhere; (2) an item that IS a
// single tracking number on its own (the strongest signal); (3) numbers pulled from
// within mixed-content items; (4) a de-spaced FedEx 96-barcode as a last resort.
function pickTrackingFromItems(items) {
  const strs = (items || []).map((it) => String(it && it.str != null ? it.str : it));
  for (const s of strs) {
    const ups = s.toUpperCase().replace(/[^0-9A-Z]/g, '').match(/1Z[0-9A-Z]{16}/);
    if (ups) return ups[0];
  }
  const primary = [];
  for (const s of strs) {
    const t = s.trim().toUpperCase();
    if (/^\d{2,5}(?:\s+\d{2,5}){2,7}$/.test(t)) { const d = norm(t); if (inRange(d)) primary.push(d); }
    else if (/^\d{12,40}$/.test(t)) primary.push(t);
  }
  if (primary.length) return bestOf(primary, strs);
  const cands = [];
  for (const s of strs) {
    const raw = s.toUpperCase();
    for (const g of raw.match(GROUPED_RE) || []) { const d = norm(g); if (inRange(d)) cands.push(d); }
    for (const r of raw.replace(/[^0-9A-Z]/g, ' ').match(/\d{12,40}/g) || []) cands.push(r);
  }
  if (cands.length) return bestOf(cands, strs);
  for (const s of strs) { const m = s.replace(/[^0-9A-Z]/g, '').match(/96\d{18,20}/); if (m) return m[0]; }
  return '';
}

// Render a pdf.js page to a PNG blob so the image barcode/OCR path can read it —
// the fallback when a page has no useful embedded text (a scanned/flattened label).
async function renderPageToBlob(page) {
  const viewport = page.getViewport({ scale: 3 }); // upscale for barcode/OCR legibility (UPS Code128 needs the resolution)
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

// Extract one tracking number per page from an uploaded shipping-label PDF (one
// label per page). Tries the page's embedded text first (fast + exact); falls back
// to rendering the page and reading its barcode / OCR'ing it. `onProgress(page,total)`
// fires per page. Returns [{ page, value, via }] — value '' when nothing was found.
export async function decodeTrackingPdf(file, onProgress) {
  const pdfjs = await lazyImport(() => import('pdfjs-dist'));
  const workerUrl = (await lazyImport(() => import('pdfjs-dist/build/pdf.worker.min.mjs?url'))).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  const data = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data }).promise;
  const out = [];
  try {
    for (let p = 1; p <= pdf.numPages; p++) {
      onProgress?.(p, pdf.numPages);
      const page = await pdf.getPage(p);
      let value = '';
      let via = 'text';
      let pageText = '';
      try {
        const tc = await page.getTextContent();
        pageText = (tc?.items || []).map((it) => (it && it.str) || '').join(' ');
        value = pickTrackingFromItems(tc.items);
      } catch { /* no text layer — fall through to render */ }
      if (!value) {
        try {
          const blob = await renderPageToBlob(page);
          if (blob) { const r = await decodeTrackingImage(blob); value = r.value; via = r.via; }
        } catch { /* leave blank for manual entry */ }
      }
      // Detect the courier from the printed label text (reliable even when the number is a
      // barcode we couldn't read) and/or the number format → a 17TRACK carrier key.
      const carrierKey = detectCarrierKey({ text: pageText, number: value });
      page.cleanup?.();
      out.push({ page: p, value, via, carrierKey });
    }
  } finally {
    pdf.destroy?.();
  }
  return out;
}

// Which pages of a labels PDF are actually LABELS.
//
// The sheets bought from UPS CampusShip interleave a packing slip after every label, so a
// 9-label request arrives as 17 pages: label, slip, label, slip… The slips are image-only
// with no barcode, so they used to import as blank label rows that someone deleted by
// hand — nine real labels and eight to clean up, every single time.
//
// A page that yielded no tracking number is not a label. The exception is a sheet where
// NOTHING decoded: then we can't tell a slip from a label whose barcode we simply failed
// to read, so every page comes back for the human to fill in — losing a label silently is
// far worse than showing a blank row.
export function labelPagesOnly(results) {
  const read = (results || []).filter((r) => r.value);
  if (!read.length) return { labels: results || [], skipped: [], undecidable: true };
  return {
    labels: read,
    skipped: (results || []).filter((r) => !r.value),
    undecidable: false,
  };
}
