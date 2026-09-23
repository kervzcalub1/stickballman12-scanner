// Shared React hooks.
import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { onLiveChange } from './lib/live.js';

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
const PENDING_COUNT_TABLES = ['items', 'batches', 'batch_boxes', 'purchase_orders', 'po_boxes', 'po_lines',
  'rescale_requests', 'rescale_request_items', 'buy_carts', 'buy_cart_lines', 'buy_cart_tasks', 'shipment_issues'];
export function usePendingCounts() {
  const [counts, setCounts] = useState(null);
  // Live: re-read whenever any table a count is built from changes (every count is over
  // units, shipments, orders, rescale requests or buying requests).
  useLive(PENDING_COUNT_TABLES, () => api.pendingCounts()
    .then(({ counts: c }) => setCounts((cur) => (JSON.stringify(cur) === JSON.stringify(c) ? cur : c)))
    .catch(() => {}));
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

// For a live re-read that must not land under somebody's cursor: resolves at once, or as
// soon as the field they are typing in (an input inside `sel`) loses focus. Screens whose
// inputs re-seed from the server value — a count keyed on it, a line row — await this
// first, so a re-read can never put the old number back mid-keystroke.
const typingIn = (sel) => { const el = document.activeElement; return !!el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && !!el.closest(sel); };
export const afterTyping = (sel) => new Promise((resolve) => {
  if (!typingIn(sel)) return resolve();
  const check = () => setTimeout(() => { if (typingIn(sel)) return; document.removeEventListener('focusout', check, true); resolve(); }, 0);
  document.addEventListener('focusout', check, true);
});

// LIVE DATA (docs/context/live-updates.md). Runs `reload` once when the screen mounts,
// again within about a second of any write to one of `tables` — pushed by the database
// over the tab's one live stream (src/lib/live.js) — and on a slow fallback timer in case
// a notice was ever missed. Pass `[]` tables for "fallback timer only".
//
// The rules that keep it from getting in anybody's way:
//   · never overlapping — a slow read is not doubled; a change that lands mid-read runs
//     one more read after it, never three;
//   · never while the tab is hidden — it catches up the moment the tab comes back;
//   · never while `paused` (the user's own write is in flight and reloads on its own) —
//     it catches up when the pause lifts;
//   · never a spinner: `reload` replaces data quietly, and each caller only swaps state
//     that actually changed, so a half-typed input is never disturbed.
// `mount: false` when the screen already loads on its own and only wants the updates.
export function useLive(tables, reload, { paused = false, every = 60_000, mount = true, minGap = 1500 } = {}) {
  const fnRef = useRef(reload); fnRef.current = reload;
  const pausedRef = useRef(paused); pausedRef.current = paused;
  const busy = useRef(false);
  const dirty = useRef(false);
  const timer = useRef(null);
  const last = useRef(0);
  const key = (tables || []).join(',');

  const run = useRef(null);
  run.current = async () => {
    if (document.hidden || pausedRef.current) { dirty.current = true; return; }
    if (busy.current) { dirty.current = true; return; }
    // A floor scanning at speed writes `items` every second or two; a screen watching it
    // re-reads at most once per `minGap`, catching up with everything in one read.
    const wait = last.current + minGap - Date.now();
    if (wait > 0) { dirty.current = true; clearTimeout(timer.current); timer.current = setTimeout(() => run.current(), wait); return; }
    busy.current = true; dirty.current = false; last.current = Date.now();
    try { await fnRef.current(); } catch { /* transient — the next change or tick retries */ }
    finally {
      busy.current = false;
      if (dirty.current && !document.hidden && !pausedRef.current) run.current();
    }
  };

  useEffect(() => {
    const want = new Set(key ? key.split(',') : []);
    const off = want.size ? onLiveChange((changed) => {
      if (!changed.some((t) => t === '*' || want.has(t))) return;
      dirty.current = true;
      clearTimeout(timer.current);
      // A burst of writes (a 40-pair commit) arrives as several notices; read once after it.
      timer.current = setTimeout(() => run.current(), 300);
    }) : () => {};
    const onVisible = () => { if (!document.hidden && dirty.current) run.current(); };
    document.addEventListener('visibilitychange', onVisible);
    const tick = every ? setInterval(() => { if (!document.hidden) run.current(); }, every) : null;
    return () => { off(); clearTimeout(timer.current); clearInterval(tick); document.removeEventListener('visibilitychange', onVisible); };
  }, [key, every]);

  useEffect(() => { if (mount) run.current(); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  // The pause lifted with a change waiting behind it.
  useEffect(() => { if (!paused && dirty.current) run.current(); }, [paused]);
}
