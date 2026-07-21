// URL query-string state — so a refresh (or a shared link) doesn't throw away what
// the user was looking at.
//
// The established convention is that the top-level PAGE lives in the path
// (`pathForView` / `phPathForPage`) and sub-state stayed in memory. This adds one
// layer: the small, cheap identifiers that make a page reproducible — the SKU that was
// searched, a filter, an open record — go in the QUERY STRING.
//
// Why the query string and not more path segments: `phPageForPath` matches whole paths
// exactly, so `/ph/price-inquiry/DZ5485-612` resolves to no page at all and silently
// drops the user on the PH home. Neither router reads `location.search`, so a query is
// invisible to both and can't break routing.
//
// What belongs here: short, serializable, non-sensitive values that are safe for
// someone else to open (a SKU, a date range, an open PO id).
// What does NOT: staged uploads and File/blob handles, rendered slide data-URIs,
// server-staged cutout URLs, "already committed" flags, held edit locks, unsaved
// drafts, and anything secret (e.g. a one-time temp password). Restoring those is
// either impossible, silently stale, or would spend money on re-render.
import { useCallback, useEffect, useState } from 'react';

export function readParam(key) {
  try { return new URLSearchParams(window.location.search).get(key) || ''; }
  catch { return ''; }
}

// Write (or clear) one query param without touching the path or adding history noise.
// `replace` by default: typing in a search box shouldn't bury the Back button under a
// dozen entries.
export function writeParam(key, value, { replace = true } = {}) {
  try {
    const url = new URL(window.location.href);
    if (value === '' || value == null) url.searchParams.delete(key);
    else url.searchParams.set(key, String(value));
    const next = url.pathname + (url.search || '') + url.hash;
    if (next === window.location.pathname + window.location.search + window.location.hash) return;
    window.history[replace ? 'replaceState' : 'pushState'](null, '', next);
  } catch { /* history unavailable — degrade to in-memory state */ }
}

// Keep the whole query string but drop it when leaving a page: another page's `?sku=`
// is meaningless and would look like state that failed to load.
export function clearQuery() {
  try {
    if (!window.location.search) return;
    window.history.replaceState(null, '', window.location.pathname + window.location.hash);
  } catch { /* ignore */ }
}

// `useState` whose value is mirrored into `?key=`. Seeded from the URL on mount, so a
// refresh comes back to the same place. Also follows Back/Forward via popstate.
export function useQueryParam(key, initial = '') {
  const [value, setValue] = useState(() => readParam(key) || initial);

  useEffect(() => {
    const onPop = () => setValue(readParam(key) || initial);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [key, initial]);

  const set = useCallback((next, opts) => {
    setValue(next);
    writeParam(key, next, opts);
  }, [key]);

  return [value, set];
}
