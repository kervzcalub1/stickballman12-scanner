// Make a source image byte-buffer safe for the rest of the imaging pipeline.
//
// Two consumers downstream are pickier than "it's an image":
//   • the hosted background remover (Replicate → Pillow) reads JPEG/PNG/WebP/GIF/BMP/TIFF
//     and NOTHING else. Handed an AVIF it dies with the cryptic
//     `cannot identify image file '/tmp/tmp….png'` — which is what PH sees as
//     "Could not cut out this shoe via replicate". AVIF is not exotic: saving a product
//     photo from adidas.com (or most brand sites) in Chrome gives you a .avif.
//   • @napi-rs/canvas `loadImage` decodes AVIF fine but **SEGFAULTS on HEIC** — a raw
//     iPhone photo doesn't throw, it kills the Node process and takes every other
//     in-flight request with it. It must never reach the decoder.
//
// So: sniff the real format from the magic bytes (never trust Content-Type — the upload
// path stamps `image/jpeg` on whatever it was handed), pass the readable formats through
// untouched, transcode what only canvas can read, and reject HEIC with a message PH can
// act on. Cheap: only the odd-format path decodes anything.
import { createCanvas, loadImage } from '@napi-rs/canvas';

// Formats Pillow (and therefore the cutout provider) reads directly.
const PILLOW_READABLE = new Set(['jpeg', 'png', 'webp', 'gif', 'bmp', 'tiff']);

const ascii = (buf, start, end) => buf.toString('latin1', start, end);

// Magic-byte sniff → format name, or null when it isn't an image we recognise.
export function sniffImageFormat(buf) {
  if (!buf || buf.length < 16) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (ascii(buf, 0, 8) === '\x89PNG\r\n\x1a\n') return 'png';
  if (ascii(buf, 0, 4) === 'GIF8') return 'gif';
  if (ascii(buf, 0, 2) === 'BM') return 'bmp';
  if (ascii(buf, 0, 4) === 'II*\0' || ascii(buf, 0, 4) === 'MM\0*') return 'tiff';
  if (ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 12) === 'WEBP') return 'webp';
  // ISO base media (AVIF / HEIC / HEIF): `ftyp` box at offset 4, then the major brand and
  // a list of compatible brands. AVIF files routinely carry a `mif1` major brand with
  // `avif` only in the compatible list, so scan the whole box rather than trusting byte 8.
  if (ascii(buf, 4, 8) === 'ftyp') {
    const size = buf.readUInt32BE(0);
    const brands = ascii(buf, 8, Math.min(buf.length, size > 8 && size <= 512 ? size : 32));
    if (brands.includes('avif') || brands.includes('avis')) return 'avif';
    return 'heic'; // heic/heix/hevc/mif1/msf1… — all decode-unsafe here
  }
  return null;
}

// Buffer → a buffer every downstream consumer can read. Returns the ORIGINAL buffer when
// it's already fine (the common case: JPEG/PNG from a marketplace or a normal upload).
// Throws a PH-readable message when the bytes can't be salvaged — failing loudly beats
// handing a corrupt file to the provider and reporting its internal error.
export async function normalizeSourceImage(buf) {
  const format = sniffImageFormat(buf);
  if (PILLOW_READABLE.has(format)) return buf;
  if (format === 'heic') {
    throw new Error('HEIC/HEIF images aren’t supported — re-save the photo as JPEG or PNG and upload it again.');
  }
  if (!format) {
    throw new Error('That file isn’t a readable image (JPEG, PNG or WebP).');
  }
  // AVIF: canvas can decode it, the cutout provider can't — re-encode to PNG so the rest
  // of the pipeline (and Replicate) sees a format it knows. Lossless: this is the source
  // the matte is cut from, so no second-generation JPEG artefacts on the shoe edge.
  let img;
  try {
    img = await loadImage(buf);
  } catch {
    throw new Error(`This ${format.toUpperCase()} image couldn’t be decoded — re-save it as JPEG or PNG.`);
  }
  const canvas = createCanvas(img.width, img.height);
  canvas.getContext('2d').drawImage(img, 0, 0);
  return canvas.toBuffer('image/png');
}
