// Live updates — the browser half (docs/context/live-updates.md).
//
// ONE stream per tab, shared by every screen and hook that wants to know when data
// changed. It carries table names only; a screen that hears one of its tables re-reads
// through its ordinary endpoint (useLive in hooks.js), so what it shows is still exactly
// what the viewer's own call returns.
//
// fetch() rather than EventSource: EventSource cannot send an Authorization header, and
// the session token lives in sessionStorage, not in a cookie. A small SSE parser over the
// response body does the same job.
import { getToken } from '../api.js';

const listeners = new Set();
let ctrl = null;          // AbortController of the open stream
let running = false;
let backoff = 1000;
let stateListeners = new Set();
let state = 'off';
let idleTimer = null;
const IDLE_CLOSE_MS = 10_000;        // 'off' | 'connecting' | 'live' | 'down'

function setState(s) {
  if (s === state) return;
  state = s;
  for (const fn of stateListeners) { try { fn(s); } catch { /* ignore */ } }
}

function emit(tables) {
  for (const fn of listeners) { try { fn(tables); } catch { /* one bad screen never stops the rest */ } }
}

async function run() {
  if (running) return;
  running = true;
  let first = true;
  while (listeners.size > 0) {
    const token = getToken();
    if (!token) { setState('off'); break; }   // signed out — the next sign-in starts it again
    setState('connecting');
    ctrl = new AbortController();
    try {
      const res = await fetch('/api/live', { headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal, cache: 'no-store' });
      if (res.status === 401) { setState('off'); break; }  // the next ordinary call signs them out
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      setState('live');
      backoff = 1000;
      // Coming back after a drop: whatever changed in the gap was never announced.
      if (!first) emit(['*']);
      first = false;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
          if (!data) continue;
          try { const m = JSON.parse(data); if (Array.isArray(m.tables)) emit(m.tables); } catch { /* not ours */ }
        }
      }
      // The server closes every stream on a timer to re-check the token — reconnect now.
      first = false;
    } catch (e) {
      if (e?.name === 'AbortError') break;
      setState('down');
      first = false;
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
  ctrl = null;
  running = false;
  if (listeners.size === 0) setState('off');
}

/** Hear batches of changed table names ('*' = re-read everything). Returns the unsubscribe. */
export function onLiveChange(fn) {
  listeners.add(fn);
  run();
  clearTimeout(idleTimer);
  return () => {
    listeners.delete(fn);
    // Moving between screens unsubscribes the old one a moment before the new one
    // subscribes. Closing on the spot made every navigation a new connection — and a
    // warehouse behind one shared IP would walk into the stream's rate limit. Hold it
    // open briefly; only a page with nothing live on it for a while lets it go.
    if (listeners.size === 0) {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { if (listeners.size === 0 && ctrl) ctrl.abort(); }, IDLE_CLOSE_MS);
    }
  };
}

/** 'off' | 'connecting' | 'live' | 'down' — for the small indicator in the top bar. */
export function onLiveState(fn) {
  stateListeners.add(fn);
  fn(state);
  return () => stateListeners.delete(fn);
}
