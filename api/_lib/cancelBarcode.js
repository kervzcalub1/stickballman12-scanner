// The barcode on a Stadium Goods packing slip IS its order number (owner, 2026-11-21): the
// "AMA00386134" printed under it. Decoding the bars is exact or nothing — a barcode carries a
// checksum — where reading the small print under it is not: on three real slips at Telegram's
// photo size (1200 px wide) tesseract got that number wrong on every one, a character at a time.
//
// MEASURED LIMIT (2026-11-21): at that same size the barcode is ~200 px wide, about 1.6 px per
// bar, and after phone blur and JPEG it does not decode (0 of 3, every preparation tried). A
// clean barcode of the same kind decodes down to ~1 px per bar, so the limit is the photo, not
// the decoder: the slip has to arrive sharper — sent "as a file" (full phone resolution, about
// three times the pixels) or shot close. That case was never tested on a real photo; when the
// bars don't decode this returns null and the bot says how to resend it.
//
// zxing is already a dependency (the browser decodes tracking labels with it, src/trackingOcr.js).

/** What a Stadium Goods order number looks like: three letters, eight digits (AMA00386134, ETH00380838). */
export const SG_ORDER_NO = /^[A-Z]{3}\d{8}$/;
const TIMEOUT_MS = 8000;

let lib = null;
async function zxing() {
  if (!lib) { const m = await import('@zxing/library'); lib = m.MultiFormatReader ? m : m.default; }
  return lib;
}

/** Luminance pixels → the text of a 1-D barcode in them, or null. */
export async function decodeLuminance(lum, width, height) {
  const zx = await zxing();
  const hints = new Map();
  hints.set(zx.DecodeHintType.TRY_HARDER, true);
  hints.set(zx.DecodeHintType.POSSIBLE_FORMATS, [zx.BarcodeFormat.CODE_128, zx.BarcodeFormat.CODE_39, zx.BarcodeFormat.CODE_93]);
  const src = new zx.RGBLuminanceSource(new Uint8ClampedArray(lum.buffer, lum.byteOffset, width * height), width, height);
  for (const Bin of [zx.HybridBinarizer, zx.GlobalHistogramBinarizer]) {
    try { return new zx.MultiFormatReader().decode(new zx.BinaryBitmap(new Bin(src)), hints).getText(); } catch { /* next */ }
  }
  return null;
}

/**
 * The picture → the first barcode in it whose text `accept`s, or null. The whole photo and
 * its top half (where the slip prints it), each at up to three sizes — never enlarged past
 * the original, which adds no detail.
 */
export async function decodeSlipBarcode(buf, accept = (t) => SG_ORDER_NO.test(t)) {
  const sharp = (await import('sharp')).default;
  const started = Date.now();
  try {
    const meta = await sharp(buf).rotate().metadata();
    const W = meta.width || 0; const H = meta.height || 0;
    if (!W || !H) return null;
    const regions = [null, { left: 0, top: 0, width: W, height: Math.round(H / 2) }, { left: Math.round(W / 2), top: 0, width: W - Math.round(W / 2), height: Math.round(H / 2) }];
    for (const region of regions) {
      const base = region ? region.width : W;
      for (const width of [...new Set([Math.min(base, 3200), Math.min(base, 2000), Math.min(base, 1200)])]) {
        if (Date.now() - started > TIMEOUT_MS) return null;
        let p = sharp(buf).rotate();
        if (region) p = p.extract(region);
        const { data, info } = await p.resize({ width }).greyscale().normalise().raw().toBuffer({ resolveWithObject: true });
        const text = String(await decodeLuminance(data, info.width, info.height) || '').trim().toUpperCase();
        if (text && accept(text)) return text;
      }
    }
  } catch (e) {
    console.warn('[cancellations] barcode:', e.message);
  }
  return null;
}
