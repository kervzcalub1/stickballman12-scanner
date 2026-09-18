// Shared React hooks.
import { useEffect, useRef, useState } from 'react';
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

// Quiet live refresh. Calls `refresh` every `every` ms while the tab is VISIBLE, and
// once more the moment it becomes visible again — on a phone the buyer's tab is
// backgrounded between the shop and the group chat, and coming back to it is exactly
// when they want to see what the desk decided. Never overlapping (a slow call is not
// doubled), never while `paused` (an action of the user's own is in flight and will
// reload on its own), and never a spinner: the caller decides what to do with the data.
//
// Not a lock, not presence — the PH grid has its own richer loop (`quietRefresh`). This
// is the plain version for a page that otherwise only changed on F5.
export function useLiveRefresh(refresh, { every = 15_000, paused = false } = {}) {
  const fnRef = useRef(refresh); fnRef.current = refresh;
  const pausedRef = useRef(paused); pausedRef.current = paused;
  const busyRef = useRef(false);
  useEffect(() => {
    if (!every) return undefined;
    const tick = async () => {
      if (document.hidden || pausedRef.current || busyRef.current) return;
      busyRef.current = true;
      try { await fnRef.current(); } catch { /* transient — next tick */ }
      finally { busyRef.current = false; }
    };
    const onVisible = () => { if (!document.hidden) tick(); };
    const t = setInterval(tick, every);
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVisible); };
  }, [every]);
}
