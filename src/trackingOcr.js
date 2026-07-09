// Decode a carrier tracking number from an uploaded/snapped label photo — the
// fallback for smudged or hard-to-scan labels (UPS/USPS/FedEx/DHL).
// Primary: decode a barcode in the image with zxing. Fallback: OCR the printed
// digits with Tesseract. Both libraries are imported lazily so they stay out of
// the main bundle and only download when this feature is actually used.

// Pull the most tracking-number-like token out of free OCR text.
function pickFromText(text) {
  const s = String(text || '').toUpperCase().replace(/[^0-9A-Z]/g, ' ');
  const fx96 = s.replace(/\s+/g, '').match(/96\d{18,38}/); // FedEx Ground 96-barcode
  if (fx96) return fx96[0];
  const ups = s.match(/(?:^|\s)(1Z[0-9A-Z]{16})(?=\s|$)/); // UPS: standalone 1Z token
  if (ups) return ups[1];
  const digitRuns = s.match(/\d{12,40}/g);
  if (digitRuns) return digitRuns.sort((a, b) => b.length - a.length)[0];
  const anyRun = s.match(/[0-9A-Z]{10,40}/g);
  return anyRun ? anyRun.sort((a, b) => b.length - a.length)[0] : '';
}

export async function decodeTrackingImage(file) {
  const url = URL.createObjectURL(file);
  try {
    // 1) Barcode in the image.
    try {
      const { BrowserMultiFormatReader } = await import('@zxing/browser');
      const reader = new BrowserMultiFormatReader();
      const res = await reader.decodeFromImageUrl(url);
      const text = res?.getText?.() || res?.text;
      if (text) return { value: text, via: 'barcode' };
    } catch { /* no readable barcode — fall through to OCR */ }

    // 2) OCR the human-readable number.
    const { default: Tesseract } = await import('tesseract.js');
    const { data } = await Tesseract.recognize(url, 'eng');
    return { value: pickFromText(data?.text), via: 'ocr' };
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
  const viewport = page.getViewport({ scale: 2 }); // upscale for OCR legibility
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
  const pdfjs = await import('pdfjs-dist');
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
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
      try {
        const tc = await page.getTextContent();
        value = pickTrackingFromItems(tc.items);
      } catch { /* no text layer — fall through to render */ }
      if (!value) {
        try {
          const blob = await renderPageToBlob(page);
          if (blob) { const r = await decodeTrackingImage(blob); value = r.value; via = r.via; }
        } catch { /* leave blank for manual entry */ }
      }
      page.cleanup?.();
      out.push({ page: p, value, via });
    }
  } finally {
    pdf.destroy?.();
  }
  return out;
}
