// Downscale + recompress a captured photo before upload — warehouse phones shoot
// multi-MB images; listing photos only need ~1600px JPEG. Keeps R2 storage and
// upload time down (the call flagged storage cost). Falls back to the original
// file if anything goes wrong (canvas/Image unsupported, decode error).
export async function compressImage(file, { maxEdge = 1600, quality = 0.82, type = 'image/jpeg' } = {}) {
  // Callers pass the file's own type through, which for a HEIC/AVIF pick is a format the
  // canvas can't ENCODE (it silently emits PNG while we'd report the original type) and
  // that nothing downstream can read. Clamp to a format we know both ends handle, and
  // never keep the original bytes for those — see toUploadableImage below.
  const outType = UPLOADABLE.test(type) ? type : 'image/jpeg';
  const keepOriginal = UPLOADABLE.test(file.type || '') || !file.type;
  try {
    const bitmap = await loadBitmap(file);
    const { width, height } = bitmap;
    const scale = Math.min(1, maxEdge / Math.max(width, height));
    const w = Math.round(width * scale);
    const h = Math.round(height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, outType, quality));
    if (!blob) return { blob: file, type: file.type || outType };
    // If recompression didn't help (e.g. tiny image), keep the smaller one — but only
    // when the original is a format we can actually serve back.
    return blob.size < file.size || !keepOriginal ? { blob, type: outType } : { blob: file, type: file.type || outType };
  } catch {
    return { blob: file, type: file.type || 'image/jpeg' };
  }
}

// Formats the whole downstream chain can read: the browser preview, R2, the server's
// canvas, and the Replicate background remover (Pillow). Anything else has to be
// converted HERE, in the browser, which is the only place that can still decode it —
// Safari/iOS reads HEIC and Chrome reads AVIF, while the server reads neither safely.
const UPLOADABLE = /^image\/(jpeg|png|webp)$/i;
const UPLOADABLE_EXT = /\.(jpe?g|png|webp)$/i;

// Ensure an uploaded file is one of those formats, transcoding when it isn't. A raw
// iPhone HEIC or a .avif saved off a brand site otherwise uploads as-is (the upload
// path just stamps `image/jpeg` on it) and dies later with an unhelpful "could not cut
// out this shoe". Throws when the browser can't decode it either — a clear message
// beats a broken photo in the library. Long edge capped so a transcoded PNG stays sane.
export async function toUploadableImage(file, { maxEdge = 2000 } = {}) {
  const type = file.type || '';
  if (UPLOADABLE.test(type) || (!type && UPLOADABLE_EXT.test(file.name || ''))) {
    return { blob: file, type: type || 'image/jpeg' };
  }
  let bitmap;
  try {
    bitmap = await loadBitmap(file);
  } catch {
    throw new Error('This device can’t read that image format — re-save the photo as JPEG or PNG.');
  }
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  // PNG, not JPEG: an AVIF/HEIC pick may carry transparency (a pre-cut render), and
  // flattening it onto black would be worse than the extra bytes.
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('Could not convert that image — re-save it as JPEG or PNG.');
  return { blob, type: 'image/png' };
}

function loadBitmap(file) {
  if (typeof createImageBitmap === 'function') return createImageBitmap(file);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}
