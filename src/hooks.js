// Shared React hooks.
import { useEffect, useState } from 'react';
import { api } from './api.js';

// Global unsaved-changes guard. A page calls useUnsavedGuard(true) while it has
// unsaved data (edit mode, scanned-but-unsaved rows, a cart, …). It (1) arms the
// browser's native "Leave site?" prompt on refresh/reload/close, and (2) flips a
// shared flag the app's Back handler checks (isUnsavedDirty) before navigating away.
let unsavedDirty = false;
export const isUnsavedDirty = () => unsavedDirty;
export function useUnsavedGuard(isDirty) {
  useEffect(() => {
    unsavedDirty = !!isDirty;
    if (!isDirty) return undefined;
    const onBeforeUnload = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => { window.removeEventListener('beforeunload', onBeforeUnload); unsavedDirty = false; };
  }, [isDirty]);
}

// Pending-work counts for home badges (fetched once when a home screen mounts).
export function usePendingCounts() {
  const [counts, setCounts] = useState(null);
  useEffect(() => {
    let on = true;
    api.pendingCounts().then(({ counts: c }) => { if (on) setCounts(c); }).catch(() => {});
    return () => { on = false; };
  }, []);
  return counts;
}

// Small reactive media-query hook (used to switch the Report to cards on phones).
export function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => (typeof window !== 'undefined' ? window.matchMedia(query).matches : false));
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}
