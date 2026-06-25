// Downscale + recompress a captured photo before upload — warehouse phones shoot
// multi-MB images; listing photos only need ~1600px JPEG. Keeps R2 storage and
// upload time down (the call flagged storage cost). Falls back to the original
// file if anything goes wrong (canvas/Image unsupported, decode error).
export async function compressImage(file, { maxEdge = 1600, quality = 0.82, type = 'image/jpeg' } = {}) {
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
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, quality));
    if (!blob) return { blob: file, type: file.type || type };
    // If recompression didn't help (e.g. tiny image), keep the smaller one.
    return blob.size < file.size ? { blob, type } : { blob: file, type: file.type || type };
  } catch {
    return { blob: file, type: file.type || 'image/jpeg' };
  }
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
