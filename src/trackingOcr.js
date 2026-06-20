// Decode a carrier tracking number from an uploaded/snapped label photo — the
// fallback for smudged or hard-to-scan labels (UPS/USPS/FedEx/DHL).
// Primary: decode a barcode in the image with zxing. Fallback: OCR the printed
// digits with Tesseract. Both libraries are imported lazily so they stay out of
// the main bundle and only download when this feature is actually used.

// Pull the most tracking-number-like token out of free OCR text.
function pickFromText(text) {
  const s = String(text || '').toUpperCase().replace(/[^0-9A-Z]/g, ' ');
  const ups = s.match(/1Z[0-9A-Z]{16}/);
  if (ups) return ups[0];
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
