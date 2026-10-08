// The "Market prices" step shared by eBay Reprice and Shopify Reprice: a resumable,
// retrying fetch of style + size → Alias market price through api/ebay-reprice/prices
// (docs/context/ebay-reprice.md — why it is that endpoint and not /api/get-price).
//
// One batch at a time (the server runs 4 lookups of it at once). An `error` answer goes
// back in the queue with a growing delay, up to MAX_TRIES; a 429 from our own server
// pauses EVERYTHING. Nothing unresolved is ever stored as an answer, so it can't reach
// a reprice step dressed up as "no data". Answers are cached per EST day in this browser
// and shared by both pages — the same style + size costs one lookup a day.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { ProgressBar } from './common.jsx';
import { useUnsavedGuard } from '../hooks.js';
import { estToday } from '../lib/format.js';
import { cacheKey } from '../lib/ebayReprice.js';

const BATCH = 20;
export const MAX_TRIES = 10;
const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PREFIXES = ['reprice:prices:', 'ebay-reprice:prices:'];   // the second = before it was shared
const storeKey = () => `reprice:prices:${estToday()}`;
function loadCache() {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && PREFIXES.some((p) => k.startsWith(p)) && k !== storeKey()) localStorage.removeItem(k);
    }
    return JSON.parse(localStorage.getItem(storeKey()) || '{}') || {};
  } catch { return {}; }
}
function saveCache(c) { try { localStorage.setItem(storeKey(), JSON.stringify(c)); } catch { /* full / private */ } }

export function useMarketPrices(jobs, onSignOut) {
  const [cache, setCache] = useState(loadCache);
  const cacheRef = useRef(cache);
  const stopRef = useRef(false);
  const [state, setState] = useState({ running: false, unresolved: [], startedAt: 0, doneThisRun: 0, pausedFor: 0 });
  useUnsavedGuard(state.running);
  useEffect(() => () => { stopRef.current = true; }, []);

  const cached = jobs.filter((j) => cache[cacheKey(j.sku, j.size)]).length;
  const tally = useMemo(() => {
    const t = { ok: 0, null_price: 0, not_listed: 0, bad_size: 0 };
    for (const j of jobs) { const s = cache[cacheKey(j.sku, j.size)]?.status; if (s in t) t[s]++; }
    return t;
  }, [jobs, cache]);

  async function run() {
    stopRef.current = false;
    const tries = new Map();
    const notBefore = new Map();
    const unresolved = [];
    let queue = jobs.filter((j) => !cacheRef.current[cacheKey(j.sku, j.size)]);
    let backoff = 0;
    let done = 0;
    setState({ running: true, unresolved: [], startedAt: Date.now(), doneThisRun: 0, pausedFor: 0 });
    while (queue.length && !stopRef.current) {
      const now = Date.now();
      const ready = queue.filter((j) => (notBefore.get(cacheKey(j.sku, j.size)) || 0) <= now).slice(0, BATCH);
      if (!ready.length) { await sleep(Math.max(250, Math.min(...queue.map((j) => notBefore.get(cacheKey(j.sku, j.size)) || 0)) - now)); continue; }
      let results;
      try {
        results = (await api.ebayRepricePrices(ready)).results || [];
        backoff = 0;
      } catch (err) {
        if (err.unauthorized) { stopRef.current = true; onSignOut(); return; }
        if (err.status === 429) {
          const wait = Math.min(60, 5 * 2 ** backoff++) * 1000;
          setState((s) => ({ ...s, pausedFor: wait / 1000 }));
          await sleep(wait);
          setState((s) => ({ ...s, pausedFor: 0 }));
          continue;
        }
        results = ready.map((j) => ({ ...j, status: 'error', error: err.message }));
      }
      const next = { ...cacheRef.current };
      const settled = new Set();
      for (const r of results) {
        const k = cacheKey(r.sku, r.size);
        if (r.status === 'error') {
          const t = (tries.get(k) || 0) + 1;
          tries.set(k, t);
          if (t >= MAX_TRIES) { unresolved.push({ ...r, tries: t }); settled.add(k); } else notBefore.set(k, Date.now() + 2000 * t);
        } else {
          next[k] = { status: r.status, valueCents: r.valueCents ?? null, label: r.label || null, name: r.name || null };
          settled.add(k);
          done++;
        }
      }
      queue = queue.filter((j) => !settled.has(cacheKey(j.sku, j.size)));
      cacheRef.current = next;
      setCache(next);
      saveCache(next);
      setState((s) => ({ ...s, doneThisRun: done, unresolved: [...unresolved] }));
    }
    setState((s) => ({ ...s, running: false, unresolved: [...unresolved] }));
  }
  function clear() { cacheRef.current = {}; setCache({}); saveCache({}); }

  return {
    cache, cacheRef, state, tally, cached, total: jobs.length,
    done: jobs.length > 0 && cached === jobs.length,
    ready: jobs.length > 0 && cached === jobs.length && !state.running && !state.unresolved.length,
    run, pause: () => { stopRef.current = true; }, clear,
  };
}

function Stat({ n, label, tone }) {
  return <div className={`er-stat${tone ? ` ${tone}` : ''}`}><b>{n}</b><span>{label}</span></div>;
}

// The step card. `num` is its step number; `hint` replaces the default timing line.
export function MarketPricesStep({ mp, num, hint, onCleared }) {
  const { state, tally, cached, total, done } = mp;
  const remaining = total - cached;
  const perJob = state.running && state.doneThisRun ? (Date.now() - state.startedAt) / state.doneThisRun : 0;
  const eta = perJob ? Math.ceil((remaining * perJob) / 60000) : null;
  return (
    <div className="card er-step">
      <h3 className="er-step-title"><span className="er-num">{num}</span> Market prices</h3>
      <p className="muted sm">{fmt(total)} style + size lookups. Saved in this browser for today, so a reload picks up where it stopped. {hint || 'Keep this tab open while it runs.'}</p>
      <ProgressBar value={total ? cached / total : 0}
        label={`${fmt(cached)} of ${fmt(total)} priced${state.running && eta != null ? ` · about ${eta} min left` : ''}${state.pausedFor ? ` · server busy, pausing ${state.pausedFor}s` : ''}`} />
      <div className="er-stats mt">
        <Stat n={fmt(tally.ok)} label="priced" />
        <Stat n={fmt(tally.null_price)} label="no market data" />
        <Stat n={fmt(tally.not_listed)} label="not on Alias" tone={tally.not_listed > 20 ? 'warn' : ''} />
        <Stat n={fmt(state.unresolved.length)} label="failed (Alias errors)" tone={state.unresolved.length ? 'bad' : ''} />
      </div>
      {tally.not_listed > 20 && <p className="muted xs">Lots of “not on Alias” usually means a wrong style code, not a quiet market.</p>}
      {state.unresolved.length > 0 && !state.running && (
        <div className="error mt">{fmt(state.unresolved.length)} lookup{state.unresolved.length === 1 ? '' : 's'} still failed after {MAX_TRIES} tries ({state.unresolved[0].error}). Repricing waits until they resolve — press Retry.</div>
      )}
      <div className="er-actions">
        {state.running
          ? <button type="button" className="btn" onClick={mp.pause}>Pause</button>
          : <button type="button" className="btn primary" disabled={done && !state.unresolved.length} onClick={mp.run}>
            {state.unresolved.length ? 'Retry failed' : done ? '✓ All prices fetched' : cached ? `Resume (${fmt(remaining)} left)` : 'Fetch prices'}</button>}
        {!state.running && cached > 0 && <button type="button" className="btn ghost sm" onClick={() => { mp.clear(); onCleared?.(); }} title="Forget today’s saved prices and fetch everything again">Clear saved prices</button>}
      </div>
    </div>
  );
}
