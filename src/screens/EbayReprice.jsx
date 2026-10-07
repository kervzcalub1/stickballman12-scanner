// eBay Reprice (PH) — cut every eBay listing priced above today's market down to
// market + markup, never up (docs/context/ebay-reprice.md). Four steps on one page:
//   1 Files      the revise-price export + the inventory information report, each in its
//                own labelled field and validated on drop
//   2 Style IDs  SKU → style code (direct, sibling sizes, title); blanks and conflicts
//                need a person's call before anything is priced
//   3 Prices     the slow, resumable network stage — batches to api/ebay-reprice/prices,
//                answers cached per EST day in this browser
//   4 Reprice    markup (default 12 %, never remembered), dry run, the verify gate, and
//                the two downloads
// The parsing / editing / verifying is all src/lib/ebayReprice.js — pure, and checked
// byte-for-byte against the skill's own output for the 9.1.2026 run.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { TopBar, ProgressBar } from '../components/common.jsx';
import { useUnsavedGuard } from '../hooks.js';
import { estToday } from '../lib/format.js';
import {
  readReviseFile, readInventoryFile, resolveStyles, effectiveStyles, jobsFor, cacheKey,
  parseMarkup, multiplierLabel, repriceDollars, applyReprice, verifyOutput, outputName, reportText,
} from '../lib/ebayReprice.js';

const BATCH = 20;
const MAX_TRIES = 10;                 // an `error` gets ten spaced tries before it is "unresolved"
const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const money = (cents) => `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Prices are cached per EST day in this browser, so a reload (or a second run the same
// day) resumes instead of starting over. Best effort: private mode just means no resume.
const cacheStoreKey = () => `ebay-reprice:prices:${estToday()}`;
function loadCache() {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith('ebay-reprice:prices:') && k !== cacheStoreKey()) localStorage.removeItem(k);
    }
    return JSON.parse(localStorage.getItem(cacheStoreKey()) || '{}') || {};
  } catch { return {}; }
}
function saveCache(c) { try { localStorage.setItem(cacheStoreKey(), JSON.stringify(c)); } catch { /* full / private */ } }

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function FileField({ id, label, hint, file, result, onFile }) {
  return (
    <div className={`er-file${result?.ok ? ' ok' : result && !result.ok ? ' bad' : ''}`}>
      <label htmlFor={id} className="er-file-label">{label}</label>
      <div className="muted xs">{hint}</div>
      <input id={id} type="file" accept=".csv,text/csv" onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
      {file && <div className="er-file-name">{file.name}</div>}
      {result && !result.ok && <div className="error xs">{result.error}</div>}
      {result?.ok && result.summary && <div className="er-file-ok xs">✓ {result.summary}</div>}
    </div>
  );
}

function Stat({ n, label, tone }) {
  return <div className={`er-stat${tone ? ` ${tone}` : ''}`}><b>{n}</b><span>{label}</span></div>;
}

export function EbayReprice({ onHome, onSignOut }) {
  const [reviseFile, setReviseFile] = useState(null);
  const [reviseText, setReviseText] = useState('');
  const [revise, setRevise] = useState(null);
  const [invFile, setInvFile] = useState(null);
  const [inv, setInv] = useState(null);
  const [decisions, setDecisions] = useState({});
  const [cache, setCache] = useState(loadCache);
  const [fetchState, setFetchState] = useState({ running: false, unresolved: [], startedAt: 0, doneThisRun: 0, pausedFor: 0, error: '' });
  const stopRef = useRef(false);
  const cacheRef = useRef(cache);
  const [markup, setMarkup] = useState('12');   // never remembered: every fresh run starts at 12 %
  const [dryRun, setDryRun] = useState(false);
  const [result, setResult] = useState(null);
  useUnsavedGuard(fetchState.running);
  useEffect(() => () => { stopRef.current = true; }, []);

  async function pickRevise(f) {
    setReviseFile(f); setResult(null); setDecisions({});
    const text = await f.text();
    const r = readReviseFile(text);
    setReviseText(r.ok ? text : '');
    setRevise(r.ok ? { ...r, summary: `${fmt(r.dataRows)} rows · ${fmt(r.sizeRows)} size rows` } : r);
  }
  async function pickInv(f) {
    setInvFile(f); setResult(null); setDecisions({});
    const r = readInventoryFile(await f.text());
    setInv(r.ok ? { ...r, summary: `${fmt(r.units)} units · ${fmt(r.sku2style.size)} SKUs · columns “${r.columns.style}” + “${r.columns.sku}”` } : r);
  }

  const resolved = useMemo(() => (revise?.ok && inv?.ok ? resolveStyles(revise, inv) : null), [revise, inv]);
  const effective = useMemo(() => (resolved ? effectiveStyles(resolved.groups, decisions) : null), [resolved, decisions]);
  // Blocking rows first, so the ones holding up step 3 are at the top of the table.
  const review = resolved ? resolved.groups.filter((g) => g.issue || g.unverified)
    .sort((a, b) => (b.issue ? 1 : 0) - (a.issue ? 1 : 0)) : [];
  const jobs = useMemo(() => (effective && !effective.pending.length ? jobsFor(revise, effective.styleAt) : []), [effective, revise]);
  const cached = jobs.filter((j) => cache[cacheKey(j.sku, j.size)]).length;
  const fetchDone = jobs.length > 0 && cached === jobs.length;
  const tally = useMemo(() => {
    const t = { ok: 0, null_price: 0, not_listed: 0, bad_size: 0 };
    for (const j of jobs) { const s = cache[cacheKey(j.sku, j.size)]?.status; if (s in t) t[s]++; }
    return t;
  }, [jobs, cache]);
  const pctH = parseMarkup(markup);

  function skipAllPending() {
    setResult(null);
    setDecisions((cur) => ({ ...cur, ...Object.fromEntries(effective.pending.map((g) => [g.id, { skip: true }])) }));
  }
  const firstPendingRef = useRef(null);
  function decide(id, d) { setResult(null); setDecisions((cur) => { const n = { ...cur }; if (d) n[id] = d; else delete n[id]; return n; }); }

  // The network stage. One batch at a time (the server runs 4 lookups of it at once);
  // `error` answers go back in the queue with a growing delay; a 429 from our own server
  // pauses EVERYTHING, not just the batch that hit it. Nothing unresolved is ever cached
  // as an answer, so it can't reach the reprice step dressed up as "no data".
  async function runFetch() {
    stopRef.current = false;
    const tries = new Map();
    const notBefore = new Map();
    const unresolved = [];
    let queue = jobs.filter((j) => !cacheRef.current[cacheKey(j.sku, j.size)]);
    let backoff = 0;
    setFetchState({ running: true, unresolved: [], startedAt: Date.now(), doneThisRun: 0, pausedFor: 0, error: '' });
    let done = 0;
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
          setFetchState((s) => ({ ...s, pausedFor: wait / 1000 }));
          await sleep(wait);
          setFetchState((s) => ({ ...s, pausedFor: 0 }));
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
      setFetchState((s) => ({ ...s, doneThisRun: done, unresolved: [...unresolved] }));
    }
    setFetchState((s) => ({ ...s, running: false, unresolved: [...unresolved] }));
  }

  function clearSaved() {
    cacheRef.current = {};
    setCache({});
    saveCache({});
    setResult(null);
  }

  function run() {
    if (pctH == null) return;
    const out = applyReprice(revise, effective.styleAt, cacheRef.current, pctH, { dryRun });
    const verify = out.text ? verifyOutput(reviseText, out.text) : null;
    setResult({ ...out, verify, pctH, dryRun, name: outputName(reviseFile?.name, estToday()) });
  }

  const remaining = jobs.length - cached;
  const elapsed = fetchState.running && fetchState.doneThisRun ? (Date.now() - fetchState.startedAt) / fetchState.doneThisRun : 0;
  const eta = elapsed ? Math.ceil((remaining * elapsed) / 60000) : null;
  const canPrice = !!effective && !effective.pending.length && jobs.length > 0;
  const canRun = fetchDone && !fetchState.running && !fetchState.unresolved.length && pctH != null;

  return (
    <div className="app">
      <TopBar title="eBay Reprice" onHome={onHome} onSignOut={onSignOut} />

      <div className="card er-step">
        <h3 className="er-step-title"><span className="er-num">1</span> Files</h3>
        <p className="muted sm">Your uploads are never changed — the new file is built from a copy and checked against the original before you can download it.</p>
        <div className="er-files">
          <FileField id="er-revise" label="eBay revise-price file" file={reviseFile} result={revise} onFile={pickRevise}
            hint="Seller Hub → eBay-active-revise-price-quantity-download — e.g. eBay-edit-price-quantity-template-2026-09-01-….csv" />
          <FileField id="er-inv" label="Inventory information report" file={invFile} result={inv} onFile={pickInv}
            hint="Store inventory export — e.g. StoreInventoryReport-2026-09-01T21_38_57.819Z.csv" />
        </div>
      </div>

      {resolved && (
        <div className="card er-step">
          <h3 className="er-step-title"><span className="er-num">2</span> Style IDs</h3>
          <div className="er-stats">
            <Stat n={fmt(resolved.stats.direct)} label="matched directly" />
            <Stat n={fmt(resolved.stats.fromSibling)} label="filled from sibling sizes / title" />
            <Stat n={fmt(resolved.stats.fromTitle)} label="listings resolved via title" />
            <Stat n={fmt(resolved.stats.blank)} label="still blank" tone={resolved.stats.blank ? 'bad' : ''} />
          </div>
          {inv.conflicts.size > 0 && <div className="notice mt">{fmt(inv.conflicts.size)} SKU{inv.conflicts.size === 1 ? '' : 's'} map to more than one Style ID in the inventory report — those listings are below for you to decide.</div>}
          {review.length > 0 ? (
            <>
              <p className="muted sm mt">{effective.pending.length
                ? <><b>{effective.pending.length} listing{effective.pending.length === 1 ? '' : 's'} need{effective.pending.length === 1 ? 's' : ''} your call</b> before prices are fetched — type the Style ID, or skip it (its prices stay as they are).{' '}
                  <button type="button" className="btn xs" onClick={skipAllPending}>Skip all {effective.pending.length} remaining</button></>
                : 'Every listing that needed a decision has one.'}</p>
              <div className="ap-tablewrap">
                <table className="table er-review">
                  <thead><tr><th>Listing</th><th>Why</th><th>Style ID</th><th>Skip</th></tr></thead>
                  <tbody>
                    {review.map((g) => {
                      const d = decisions[g.id];
                      const why = g.issue === 'blank' ? 'No Style ID for these SKUs'
                        : g.issue === 'conflict' ? `Sizes disagree: ${g.knownStyles.join(' vs ')}`
                          : g.issue === 'sku_conflict' ? g.skuConflicts.map(([s, st]) => `${s} → ${st.join(' / ')}`).join('; ')
                            : `From the title, not in the report: ${g.unverified}`;
                      const options = g.issue === 'conflict' ? g.knownStyles : g.issue === 'sku_conflict' ? [...new Set(g.skuConflicts.flatMap(([, st]) => st))] : [];
                      return (
                        <tr key={g.id} className={g.issue && !d ? 'er-needs' : ''}
                          ref={g.issue && !d && g.id === effective.pending[0]?.id ? firstPendingRef : undefined}>
                          <td><div className="er-title">{g.title || '(no title)'}</div><div className="muted xs">{g.item ? `#${g.item} · ` : ''}{g.rows.length} size{g.rows.length === 1 ? '' : 's'}</div></td>
                          <td className="xs">{why}{!g.issue && <div className="muted">Not blocking — check it looks right.</div>}</td>
                          <td>
                            <input className="er-style-input" value={d?.style ?? (g.issue ? '' : g.unverified || '')} disabled={!!d?.skip} placeholder="e.g. DQ8426-109"
                              aria-label={`Style ID for ${g.title}`} onChange={(e) => decide(g.id, e.target.value.trim() ? { style: e.target.value } : null)} />
                            {options.length > 0 && <div className="er-opts">{options.map((o) => <button key={o} type="button" className="btn xs ghost" disabled={!!d?.skip} onClick={() => decide(g.id, { style: o })}>{o}</button>)}</div>}
                          </td>
                          <td><input type="checkbox" checked={!!d?.skip} aria-label={`Skip ${g.title}`} onChange={(e) => decide(g.id, e.target.checked ? { skip: true } : null)} /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          ) : <p className="er-ok sm mt">✓ Every listing has a Style ID.</p>}
        </div>
      )}

      {/* Step 3 used to just not exist until step 2 was settled, which read as "the
          Fetch prices button is missing" (user, 2026-10-07). Say what it's waiting on. */}
      {effective && !canPrice && (
        <div className="card er-step er-waiting">
          <h3 className="er-step-title"><span className="er-num">3</span> Market prices</h3>
          {effective.pending.length ? (
            <>
              <p className="sm">Waiting on <b>{effective.pending.length} listing{effective.pending.length === 1 ? '' : 's'}</b> in step 2 — give each a Style ID or tick Skip, and <b>Fetch prices</b> appears here.</p>
              <div className="er-actions">
                <button type="button" className="btn" onClick={() => firstPendingRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>Show me</button>
                <button type="button" className="btn ghost" onClick={skipAllPending}>Skip all {effective.pending.length} (leave their prices as they are)</button>
              </div>
            </>
          ) : <p className="sm">Nothing to price — no size row in the eBay file has both a Style ID and a Start price.</p>}
        </div>
      )}

      {canPrice && (
        <div className="card er-step">
          <h3 className="er-step-title"><span className="er-num">3</span> Market prices</h3>
          <p className="muted sm">{fmt(jobs.length)} style + size lookups. Saved in this browser for today, so a reload picks up where it stopped. Keep this tab open while it runs — about 15–20 minutes for a full file.</p>
          <ProgressBar value={jobs.length ? cached / jobs.length : 0}
            label={`${fmt(cached)} of ${fmt(jobs.length)} priced${fetchState.running && eta != null ? ` · about ${eta} min left` : ''}${fetchState.pausedFor ? ` · server busy, pausing ${fetchState.pausedFor}s` : ''}`} />
          <div className="er-stats mt">
            <Stat n={fmt(tally.ok)} label="priced" />
            <Stat n={fmt(tally.null_price)} label="no market data" />
            <Stat n={fmt(tally.not_listed)} label="not on Alias" tone={tally.not_listed > 20 ? 'warn' : ''} />
            <Stat n={fmt(fetchState.unresolved.length)} label="failed (Alias errors)" tone={fetchState.unresolved.length ? 'bad' : ''} />
          </div>
          {tally.not_listed > 20 && <p className="muted xs">Lots of “not on Alias” usually means a wrong Style ID in step 2, not a quiet market.</p>}
          {fetchState.unresolved.length > 0 && !fetchState.running && (
            <div className="error mt">{fmt(fetchState.unresolved.length)} lookup{fetchState.unresolved.length === 1 ? '' : 's'} still failed after {MAX_TRIES} tries ({fetchState.unresolved[0].error}). Repricing waits until they resolve — press Retry.</div>
          )}
          <div className="er-actions">
            {fetchState.running
              ? <button type="button" className="btn" onClick={() => { stopRef.current = true; }}>Pause</button>
              : <button type="button" className="btn primary" disabled={fetchDone && !fetchState.unresolved.length} onClick={runFetch}>
                {fetchState.unresolved.length ? 'Retry failed' : fetchDone ? '✓ All prices fetched' : cached ? `Resume (${fmt(remaining)} left)` : 'Fetch prices'}</button>}
            {!fetchState.running && cached > 0 && <button type="button" className="btn ghost sm" onClick={clearSaved} title="Forget today’s saved prices and fetch everything again">Clear saved prices</button>}
          </div>
        </div>
      )}

      {canPrice && (
        <div className="card er-step">
          <h3 className="er-step-title"><span className="er-num">4</span> Reprice</h3>
          <p className="muted sm">Every size priced <b>above</b> market + markup is cut to it (rounded half-up to a whole dollar). Nothing is ever raised. The upload file changes <b>Start price only</b> and drops <b>Available quantity</b>, so sales since the export aren’t undone.</p>
          <div className="er-controls">
            <label className="er-markup">
              <span className="muted xs">Markup over market</span>
              <span className="er-markup-field">
                <input type="text" inputMode="decimal" value={markup} aria-label="Markup percent" onChange={(e) => { setMarkup(e.target.value); setResult(null); }} />
                <span>%</span>
              </span>
              {pctH == null ? <span className="error xs">0 to 100, up to 2 decimals</span> : <span className="muted xs">× {multiplierLabel(pctH)} · $86 → ${repriceDollars(8600, pctH)}</span>}
            </label>
            <label className="er-dry"><input type="checkbox" checked={dryRun} onChange={(e) => { setDryRun(e.target.checked); setResult(null); }} /> Dry run — audit report only, no upload file</label>
            <button type="button" className="btn primary" disabled={!canRun} onClick={run}>{dryRun ? 'Run dry run' : 'Build upload file'}</button>
          </div>
          {!fetchDone && <p className="muted xs">Waiting for every price in step 3.</p>}

          {result && (
            <div className="er-result">
              <div className="er-result-head">{result.dryRun ? 'Dry run' : 'Run'} at <b>{(result.pctH / 100).toString()}% markup (× {multiplierLabel(result.pctH)})</b></div>
              <div className="er-stats">
                <Stat n={fmt(result.n.lower)} label={result.dryRun ? 'would be repriced (lower)' : 'repriced (lower)'} tone="ok" />
                <Stat n={fmt(result.n.higher)} label="kept (market higher)" />
                <Stat n={fmt(result.n.equal)} label="kept (equal)" />
                <Stat n={fmt(result.n.nodata)} label="no price data" tone={result.n.nodata ? 'warn' : ''} />
              </div>
              <p className="sm">Total reduction: <b>{money(result.n.reductionCents)}</b> across {fmt(result.n.lower)} size{result.n.lower === 1 ? '' : 's'}.</p>
              {result.verify && (
                <div className={`er-verify ${result.verify.ok ? 'pass' : 'fail'}`}>
                  <b>{result.verify.ok ? '✓ Verified — only Start price changed' : '✗ Verification FAILED — download blocked'}</b>
                  <ul>{result.verify.checks.map((c) => <li key={c.label}>{c.ok ? '✓' : '✗'} {c.label} <span className="muted">— {c.detail}</span></li>)}</ul>
                </div>
              )}
              <div className="er-actions">
                {!result.dryRun && (
                  <button type="button" className="btn primary" disabled={!result.verify?.ok} onClick={() => download(result.name, result.text)}>
                    Download upload file — {result.name}</button>
                )}
                <button type="button" className="btn" onClick={() => download(result.name.replace(/^eBay reprice/, 'reprice report'), reportText(result.report, result.pctH))}>
                  Download audit report</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
