// eBay Listings → Reprice (docs/context/ebay-api-reprice.md). Reprice eBay sizes straight
// through the API: pick listings (or all of them), fetch today's market price per size,
// and send market + markup to eBay — both directions by default, "Only lower" to never
// raise. The CSV tool (/ph/ebay-reprice) stays for file-based bulk runs.
//
// Market prices are the same shared, cached lookup Shopify Listings and eBay Reprice use
// (MarketPrices.jsx); the suggestion maths is Shopify Listings' (src/lib/shopifyListings.js),
// so the three tools agree on what "market + 12 %" means for a size.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Modal, ProgressBar } from '../components/common.jsx';
import { api } from '../api.js';
import { useUnsavedGuard } from '../hooks.js';
import { useMarketPrices } from '../components/MarketPrices.jsx';
import { parseMarkup } from '../lib/ebayReprice.js';
import { jobsFor, suggestion, priceable, centsToPrice, BIG_SWING } from '../lib/shopifyListings.js';
import { PH_DATETIME } from '../lib/format.js';

const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const usd = (c) => `$${(c / 100).toFixed(2).replace(/\.00$/, '')}`;
const money = (n) => (n == null ? '—' : `$${Number(n).toFixed(2).replace(/\.00$/, '')}`);
const when = (iso) => (iso ? `${PH_DATETIME.format(new Date(iso))} EST` : '—');
const keyOf = (s) => `${s.item_id}|${s.variation_key}`;
const PAGE = 60;
const BATCH = 20;

// Why a size can't be repriced through the API at all (before any market price).
function blocked(s) {
  if (s.listing_type && s.listing_type !== 'FixedPriceItem') return 'Auction — not repriced';
  if (s.variation_key && !s.sku) return 'No Custom label on eBay';
  if (!priceable(s)) return s.style ? 'No size' : 'No style code';
  return null;
}

// The change for one size at this markup / direction, or why there's none.
function plan(s, cache, pctH, onlyLower, allowBig) {
  const b = blocked(s);
  if (b) return { state: 'blocked', why: b };
  const g = suggestion(s, cache, pctH);
  if (g.state === 'not_priced') return { state: 'not_priced' };
  if (g.state !== 'ok') return { state: 'no_data', why: g.why || 'No market price' };
  if (g.kind === 'same') return { ...g, state: 'same' };
  if (onlyLower && g.kind === 'raise') return { ...g, state: 'kept', why: 'Market is higher — kept (only lowering)' };
  if (g.big && !allowBig) return { ...g, state: 'big', why: `Over ${BIG_SWING * 100}% from today’s price` };
  return { ...g, state: 'change' };
}

export function EbayApiReprice({ listings, isAdmin, onSignOut, onConnect, onChanged }) {
  const [q, setQ] = useState('');
  const [stockOnly, setStockOnly] = useState(true);
  const [onlyLower, setOnlyLower] = useState(false);
  const [allowBig, setAllowBig] = useState(false);
  const [changesOnly, setChangesOnly] = useState(false);
  const [markup, setMarkup] = useState('12');   // never remembered: every visit starts at 12 %
  const [sel, setSel] = useState(() => new Set());   // size keys
  const [open, setOpen] = useState(() => new Set());
  const [shown, setShown] = useState(PAGE);
  const [confirm, setConfirm] = useState(false);
  const [run, setRun] = useState(null);   // { done, total, updated, failed:[], skipped:[], running, reconnect }
  const [showLog, setShowLog] = useState(false);
  const stop = useRef(false);
  const mp = useMarketPrices([], onSignOut);
  const pctH = parseMarkup(markup);
  useUnsavedGuard(!!run?.running);

  const sizesOf = (g) => (stockOnly ? g.sizes.filter((s) => Number(s.qty_available) > 0) : g.sizes);
  const planOf = (s) => plan(s, mp.cache, pctH, onlyLower, allowBig);
  const filtered = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return listings.filter((g) => {
      const sizes = sizesOf(g);
      if (!sizes.length) return false;
      if (words.length) {
        const hay = [g.title, g.style, g.item_sku, g.item_id, ...g.sizes.map((s) => s.sku)].join(' ').toLowerCase();
        if (!words.every((w) => hay.includes(w))) return false;
      }
      if (changesOnly && !sizes.some((s) => planOf(s).state === 'change')) return false;
      return true;
    });
  }, [listings, q, stockOnly, changesOnly, mp.cache, pctH, onlyLower, allowBig]); // eslint-disable-line react-hooks/exhaustive-deps
  const viewSizes = useMemo(() => filtered.flatMap(sizesOf), [filtered]); // eslint-disable-line react-hooks/exhaustive-deps
  const sizeByKey = useMemo(() => new Map(listings.flatMap((g) => g.sizes.map((s) => [keyOf(s), s]))), [listings]);
  const selected = useMemo(() => [...sel].map((k) => sizeByKey.get(k)).filter(Boolean), [sel, sizeByKey]);
  const selPlans = useMemo(() => selected.map((s) => [s, planOf(s)]), [selected, mp.cache, pctH, onlyLower, allowBig]); // eslint-disable-line react-hooks/exhaustive-deps
  const toSend = selPlans.filter(([, p]) => p.state === 'change');
  const lowered = toSend.filter(([, p]) => p.kind === 'lower');
  const raised = toSend.filter(([, p]) => p.kind === 'raise');
  const selJobs = useMemo(() => jobsFor(selected.filter((s) => !blocked(s))).filter((j) => !mp.cache[`${j.sku}|${j.size}`]), [selected, mp.cache]);
  const viewJobs = useMemo(() => jobsFor(viewSizes.filter((s) => !blocked(s))).filter((j) => !mp.cache[`${j.sku}|${j.size}`]), [viewSizes, mp.cache]);
  const pricing = mp.state.running;

  const selectable = (s) => !blocked(s);
  const allInView = viewSizes.filter(selectable);
  const allPicked = allInView.length > 0 && allInView.every((s) => sel.has(keyOf(s)));
  function setMany(sizes, on) {
    setSel((cur) => { const n = new Set(cur); for (const s of sizes) { if (on) n.add(keyOf(s)); else n.delete(keyOf(s)); } return n; });
  }
  const toggleOpen = (id) => setOpen((o) => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  async function go() {
    setConfirm(false);
    stop.current = false;
    const list = toSend.map(([s, p]) => ({ s, p }));
    const st = { done: 0, total: list.length, updated: 0, failed: [], skipped: [], running: true, reconnect: false };
    setRun({ ...st });
    for (let i = 0; i < list.length && !stop.current; i += BATCH) {
      const chunk = list.slice(i, i + BATCH);
      try {
        const r = await api.ebayReprice(chunk.map(({ s, p }) => ({
          itemId: s.item_id, variationKey: s.variation_key, price: centsToPrice(p.suggestedCents),
          marketCents: p.marketCents, markupPct: pctH / 100,
        })), allowBig);
        for (const x of r.results || []) {
          const s = sizeByKey.get(`${x.itemId}|${x.variationKey}`);
          const label = s ? `${s.title} — size ${s.size || '—'}` : `#${x.itemId}`;
          if (x.ok) st.updated++;
          else if (x.skipped) st.skipped.push(`${label}: ${x.error}`);
          else st.failed.push(`${label}: ${x.error}`);
        }
        if (r.needsReconnect) st.reconnect = true;
      } catch (e) {
        if (e.unauthorized) return onSignOut();
        st.failed.push(...chunk.map(({ s }) => `${s.title} — size ${s.size || '—'}: ${e.message}`));
      }
      st.done += chunk.length;
      setRun({ ...st });
      if (st.reconnect) break;
    }
    setRun({ ...st, running: false });
    setSel(new Set());
    onChanged();
  }

  return (
    <>
      <div className="card sl-toolbar">
        <p className="muted sm">Sends <b>market + markup</b> straight to eBay for the sizes you pick — price only, quantities aren’t touched. Market = today’s Alias price (the same lookup as eBay Reprice and Shopify Listings). The file-based <b>eBay Reprice</b> tool is still there for CSV runs.</p>
        <div className="sl-search-row">
          <input type="search" className="sl-search" value={q} onChange={(e) => { setQ(e.target.value); setShown(PAGE); }}
            placeholder="Search title, style code, Custom label, item #…" aria-label="Search eBay listings" />
        </div>
        <div className="sl-filters">
          <label className="sl-markup"><span className="muted xs">Markup</span>
            <input type="text" inputMode="decimal" value={markup} aria-label="Markup percent" onChange={(e) => setMarkup(e.target.value)} /> %
            {pctH == null && <span className="error xs"> 0–100</span>}
          </label>
          <label className="er-dry"><input type="checkbox" checked={onlyLower} onChange={(e) => setOnlyLower(e.target.checked)} /> Only lower prices</label>
          <label className="er-dry"><input type="checkbox" checked={stockOnly} onChange={(e) => setStockOnly(e.target.checked)} /> In stock on eBay</label>
          <label className="er-dry"><input type="checkbox" checked={changesOnly} onChange={(e) => setChangesOnly(e.target.checked)} /> Price off market</label>
          <label className="er-dry" title={`A suggestion more than ${BIG_SWING * 100}% away from today’s price is usually a wrong style code`}><input type="checkbox" checked={allowBig} onChange={(e) => setAllowBig(e.target.checked)} /> Include big swings</label>
        </div>
        <div className="sl-pricing">
          <span className="muted sm">{fmt(filtered.length)} listing{filtered.length === 1 ? '' : 's'} · {fmt(viewSizes.length)} sizes{pctH != null ? ` · e.g. market $100 → $${Math.round(100 + pctH / 100)}` : ''}</span>
          {pricing ? (
            <span className="sl-progress">
              <ProgressBar value={mp.state.queued ? mp.state.doneThisRun / mp.state.queued : 0} label={`Getting market prices… ${fmt(mp.state.doneThisRun)} of ${fmt(mp.state.queued || 0)}${mp.state.pausedFor ? ` · pausing ${mp.state.pausedFor}s` : ''}`} />
              <button type="button" className="btn xs" onClick={mp.pause}>Stop</button>
            </span>
          ) : (
            <>
              {selJobs.length > 0 && <button type="button" className="btn sm primary" onClick={() => mp.run(selJobs)}>Get market prices for the {fmt(selJobs.length)} picked size{selJobs.length === 1 ? '' : 's'}</button>}
              {!selJobs.length && viewJobs.length > 0 && <button type="button" className="btn sm" onClick={() => mp.run(viewJobs)}>Get market prices for {fmt(viewJobs.length)} size{viewJobs.length === 1 ? '' : 's'} in view{viewJobs.length > 300 ? ` (~${Math.ceil(viewJobs.length / 110)} min)` : ''}</button>}
            </>
          )}
        </div>
        {mp.state.unresolved.length > 0 && !pricing && <div className="error xs mt">{fmt(mp.state.unresolved.length)} market lookups failed after retries ({mp.state.unresolved[0].error}) — press Get market prices again.</div>}
      </div>

      {run && (
        <div className={`er-verify ${run.running ? '' : run.failed.length || run.reconnect ? 'fail' : 'pass'}`}>
          {run.running
            ? <><ProgressBar value={run.total ? run.done / run.total : 0} label={`Repricing on eBay… ${fmt(run.done)} of ${fmt(run.total)}`} /> <button type="button" className="btn xs" onClick={() => { stop.current = true; }}>Stop</button></>
            : <b>{run.failed.length || run.reconnect ? '✗ Some prices did not go through' : '✓ Repriced on eBay'}</b>}
          {!run.running && (
            <ul>
              <li>{fmt(run.updated)} size{run.updated === 1 ? '' : 's'} updated on eBay</li>
              {run.skipped.length > 0 && <li>{fmt(run.skipped.length)} skipped</li>}
              {run.failed.length > 0 && <li>{fmt(run.failed.length)} failed</li>}
              {run.reconnect && <li>eBay refused the current approval — {isAdmin ? <button type="button" className="btn xs" onClick={onConnect}>Connect eBay again</button> : 'an admin presses Connect eBay again'}, then retry.</li>}
              {[...run.skipped, ...run.failed].slice(0, 10).map((m) => <li key={m} className="xs">{m}</li>)}
            </ul>
          )}
          {!run.running && <button type="button" className="btn xs ghost" onClick={() => setRun(null)}>Dismiss</button>}
        </div>
      )}

      <div className="card sl-list">
        <div className="ebl-endbar">
          <label className="ebl-check"><input type="checkbox" checked={allPicked} disabled={!allInView.length || !!run?.running}
            onChange={(e) => setMany(allInView, e.target.checked)} /> Select all {fmt(allInView.length)} sizes in view</label>
          <span className="ebr-sel-actions">
            {sel.size > 0 && <button type="button" className="btn ghost sm" disabled={!!run?.running} onClick={() => setSel(new Set())}>Clear ({fmt(sel.size)})</button>}
            <button type="button" className="btn primary" disabled={!toSend.length || pricing || !!run?.running || pctH == null} onClick={() => setConfirm(true)}>
              Reprice {toSend.length ? fmt(toSend.length) : ''} on eBay</button>
          </span>
        </div>
        {sel.size > 0 && (
          <p className="muted xs">{fmt(sel.size)} picked · {fmt(toSend.length)} will change ({fmt(lowered.length)} down, {fmt(raised.length)} up)
            {selJobs.length ? ` · ${fmt(selJobs.length)} still need a market price` : ''}
            {selPlans.filter(([, p]) => p.state !== 'change' && p.state !== 'not_priced').length ? ` · ${fmt(selPlans.filter(([, p]) => p.state !== 'change' && p.state !== 'not_priced').length)} stay as they are` : ''}</p>
        )}
        {!filtered.length ? <p className="muted">No listings match.</p> : filtered.slice(0, shown).map((g) => {
          const sizes = sizesOf(g);
          const ok = sizes.filter(selectable);
          const picked = ok.filter((s) => sel.has(keyOf(s))).length;
          const plans = sizes.map(planOf);
          const down = plans.filter((p) => p.state === 'change' && p.kind === 'lower').length;
          const up = plans.filter((p) => p.state === 'change' && p.kind === 'raise').length;
          const isOpen = open.has(g.item_id);
          return (
            <div key={g.item_id} className={`ebr-listing${picked ? ' on' : ''}`}>
              <div className="ebr-head">
                <input type="checkbox" checked={ok.length > 0 && picked === ok.length} ref={(el) => { if (el) el.indeterminate = picked > 0 && picked < ok.length; }}
                  disabled={!ok.length || !!run?.running} onChange={(e) => setMany(ok, e.target.checked)} aria-label={`Pick ${g.title}`} />
                <button type="button" className="ebr-main" aria-expanded={isOpen} onClick={() => toggleOpen(g.item_id)}>
                  {g.image_url ? <img className="ebl-thumb" src={g.image_url} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <span className="ebl-thumb ebl-thumb-empty" aria-hidden="true" />}
                  <span className="ebl-orphan-main">
                    <span className="ebl-title">{g.title}</span>
                    <span className="muted xs">{isOpen ? '▾' : '▸'} {sizes.length} size{sizes.length === 1 ? '' : 's'} · {g.style || 'no style code'} · #{g.item_id}</span>
                    <span className="xs">
                      {down > 0 && <span className="ebr-chip down">↓ {down}</span>}
                      {up > 0 && <span className="ebr-chip up">↑ {up}</span>}
                      {picked > 0 && <span className="ebr-chip">{picked} picked</span>}
                    </span>
                  </span>
                </button>
              </div>
              {isOpen && (
                <div className="ebr-sizes">
                  {sizes.map((s) => {
                    const p = planOf(s);
                    const k = keyOf(s);
                    return (
                      <label key={k} className={`ebr-size${p.state === 'change' ? ` ${p.kind}` : ''}`}>
                        <input type="checkbox" checked={sel.has(k)} disabled={!selectable(s) || !!run?.running} onChange={(e) => setMany([s], e.target.checked)} />
                        <span className="ebr-size-name">Size <b>{s.size || '—'}</b><span className="muted xs"> · {s.qty_available ?? 0} avail.</span></span>
                        <span className="ebr-now">{money(s.price)}</span>
                        <span className="ebr-arrow" aria-hidden="true">→</span>
                        <span className="ebr-new">{p.suggestedCents != null && (p.state === 'change' || p.state === 'same' || p.state === 'big' || p.state === 'kept')
                          ? <b>{usd(p.suggestedCents)}</b> : <span className="muted">—</span>}</span>
                        <span className="ebr-why xs">
                          {p.marketCents != null && <span className="muted">market {usd(p.marketCents)} </span>}
                          {p.state === 'change' && <span className={p.kind === 'lower' ? 'ebl-note bad' : 'ebl-note ok'}>{p.kind === 'lower' ? '↓' : '↑'} {usd(Math.abs(p.diffCents))}</span>}
                          {p.state === 'same' && <span className="muted">already there</span>}
                          {p.state === 'not_priced' && <span className="muted">no market price yet</span>}
                          {['blocked', 'no_data', 'kept', 'big'].includes(p.state) && <span className={p.state === 'big' ? 'ebl-note warn' : 'muted'}>{p.why}</span>}
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        {filtered.length > shown && <button type="button" className="btn ghost sm mt" onClick={() => setShown((n) => n + PAGE * 4)}>Show more ({fmt(filtered.length - shown)} left)</button>}
      </div>

      <div className="card">
        <button type="button" className="btn ghost sm" onClick={() => setShowLog((v) => !v)}>{showLog ? '▾' : '▸'} Price changes sent from here</button>
        {showLog && <PriceLog onSignOut={onSignOut} stamp={run?.running ? 0 : run?.done} />}
      </div>

      {confirm && (
        <Modal type="warn" title={`Reprice ${fmt(toSend.length)} size${toSend.length === 1 ? '' : 's'} on eBay?`}
          message={`${fmt(lowered.length)} go down (−${usd(lowered.reduce((n, [, p]) => n - p.diffCents, 0))} in total), ${fmt(raised.length)} go up (+${usd(raised.reduce((n, [, p]) => n + p.diffCents, 0))}). Each becomes market + ${markup}% (whole dollars). It changes the live eBay price straight away; quantities aren't touched.`}
          onClose={() => setConfirm(false)}>
          <button type="button" className="btn ghost" onClick={() => setConfirm(false)}>Cancel</button>
          <button type="button" className="btn primary" onClick={go}>Reprice {fmt(toSend.length)} on eBay</button>
        </Modal>
      )}
    </>
  );
}

function PriceLog({ onSignOut, stamp }) {
  const [edits, setEdits] = useState(null);
  useEffect(() => {
    api.ebayPriceEdits().then((r) => setEdits(r.edits || [])).catch((e) => { if (e.unauthorized) onSignOut(); else setEdits([]); });
  }, [stamp]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!edits) return <p className="muted">Loading…</p>;
  if (!edits.length) return <p className="muted mt">Nothing repriced from here yet.</p>;
  return (
    <div className="ap-tablewrap mt">
      <table className="table ebl-table">
        <thead><tr><th>When</th><th>Listing</th><th>Size</th><th className="num">Was</th><th className="num">Now</th><th>Market</th><th>By</th><th /></tr></thead>
        <tbody>
          {edits.map((e) => (
            <tr key={e.id}>
              <td className="xs ebl-nowrap">{when(e.changed_at)}</td>
              <td className="xs">{e.title || `#${e.item_id}`}</td>
              <td>{e.size || '—'}</td>
              <td className="num">{money(e.old_price)}</td>
              <td className="num"><b>{money(e.new_price)}</b></td>
              <td className="xs">{e.market_cents != null ? `${usd(e.market_cents)} +${Number(e.markup_pct)}%` : '—'}</td>
              <td className="xs">{e.changed_by || ''}</td>
              <td className="xs">{e.ok ? <span className="ebl-note ok">✓</span> : <span className="error xs">{e.error}</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
