// "Failed to fetch dynamically imported module" — the app was updated while this tab
// was open.
//
// Every lazily-loaded chunk (jspdf, jsbarcode, pdfjs, the camera scanner) statically
// imports the main bundle, so its own content-hash moves on EVERY deploy. A tab left
// open across a deploy then asks the server for a filename that no longer exists. The
// warehouse keeps the app open all shift and we sometimes ship several times a day, so
// this is routine rather than exotic — and the raw browser message names a URL, which
// tells the person nothing they can act on.
//
// Diagnosed first for box labels (2026-08-07) and fixed only there; it resurfaced on the
// PO page's manifest download. This module is the shared version, so the next lazy import
// somebody adds inherits the handling instead of re-learning it.
export class ChunkLoadError extends Error {
  constructor(cause) {
    super('The app was updated while this tab was open. Reload the page, then try again.');
    this.name = 'ChunkLoadError';
    this.cause = cause;
  }
}

export const isChunkLoadError = (e) => e?.name === 'ChunkLoadError' || CHUNK_MSG_RE.test(String(e?.message || ''));

// What the browsers actually say. Chrome/Edge: "Failed to fetch dynamically imported
// module". Firefox: "error loading dynamically imported module". Safari: "Importing a
// module script failed". Also catches a stale CSS preload.
const CHUNK_MSG_RE = /dynamically imported module|Importing a module script failed|error loading dynamically imported|Failed to fetch dynamically/i;

// Wrap a dynamic import so a stale chunk arrives as something the UI can explain.
// NEVER swallow one: a lazy import here feeds a printed label, a manifest or the camera,
// and a silent failure is worse than an error — it ends up on a box.
export async function lazyImport(load) {
  try {
    return await load();
  } catch (e) {
    if (isChunkLoadError(e) || e instanceof TypeError) throw new ChunkLoadError(e);
    throw e;
  }
}

// The app-wide safety net, for the lazy loads that don't go through `lazyImport` —
// React.lazy components (the camera) fail inside Suspense, where there is no catch site
// to put a message in. Vite fires `vite:preloadError` on the window for those.
// Deliberately does NOT auto-reload: Receiving and the counting screens hold work that
// isn't saved yet, and throwing it away to fix a download is a bad trade. The banner
// hands the choice to the person.
export function onAppUpdated(handler) {
  const fire = () => handler();
  window.addEventListener('vite:preloadError', fire);
  return () => window.removeEventListener('vite:preloadError', fire);
}
