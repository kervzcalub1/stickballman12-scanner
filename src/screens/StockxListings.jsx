// StockX Listings — our live StockX asks next to the market, and a bulk reprice
// (docs/context/stockx-reprice.md, 2026-11-03). Alex was lowering ~1,750 Direct asks one by
// one in StockX Pro; the Direct lowest ask sat far above the Standard (Ship to Verify) one
// ($170 vs $48). Here: pull every listing + its market, filter to the ones priced over the
// market, keep the exceptions (🔒), and send "match the Standard lowest ask" (default) to all
// of them at once — never under the profit floor, only ever lower. The SERVER works out every
// price from the same rules (src/lib/stockxReprice.js); a worker sends them at StockX's pace.
import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { TopBar, Modal, FormModal, ProgressBar } from '../components/common.jsx';
import { useLive } from '../hooks.js';
import { PH_DATETIME, estDate, estToday } from '../lib/format.js';
import { toCsv } from '../lib/manifestCsv.js';
import { downloadCSV } from '../lib/csv.js';
import { RULES, BANDS, MAX_CUT_NO_COST, planListing, gapPct, daysListed, floorPrice, ruleLabel, dailyStats } from '../lib/stockxReprice.js';

const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const money = (n) => (n == null || n === '' ? '—' : `$${Number(n).toFixed(2).replace(/\.00$/, '')}`);
const when = (iso) => (iso ? `${PH_DATETIME.format(new Date(iso))} EST` : '—');
const numOr = (v) => { const n = Number(String(v).replace(/[$,%\s]/g, '')); return String(v).trim() !== '' && Number.isFinite(n) ? n : null; };
const PAGE = 100;
const CHANGE = ['change', 'floored'];

export function StockxListings({ onHome, onSignOut, isAdmin = false }) {
  const [data, setData] = useState(null);   // { rows, pull, queue, configured }
  const [daily, setDaily] = useState(null); // { settings, days, today, running, enabledHere }
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  // The rule — never remembered: every visit starts at "match the Standard lowest ask", $5 floor.
  const [rule, setRule] = useState('standard');
  const [offset, setOffset] = useState('1');
  const [minProfit, setMinProfit] = useState('5');
  const [allowNoCost, setAllowNoCost] = useState(false);
  const [maxCut, setMaxCut] = useState(String(MAX_CUT_NO_COST));
  const [stateOnly, setStateOnly] = useState('');   // '' | 'no_cost' (to look at) | 'below_floor'
  const [teachAsk, setTeachAsk] = useState(null);   // { row } — "lowest price for this size"
  // Finding the ones to cut.
  const [q, setQ] = useState('');
  const [gapMin, setGapMin] = useState('');
  const [daysMin, setDaysMin] = useState('');
  const [priceMin, setPriceMin] = useState('');
  const [priceMax, setPriceMax] = useState('');
  const [changesOnly, setChangesOnly] = useState(true);
  const [lockedOnly, setLockedOnly] = useState(false);
  const [sel, setSel] = useState(() => new Set());
  const [shown, setShown] = useState(PAGE);
  const [confirm, setConfirm] = useState(false);
  const [lockAsk, setLockAsk] = useState(null);   // { lock, ids }
  const [busy, setBusy] = useState('');
  const [showLog, setShowLog] = useState(false);
  const [edits, setEdits] = useState(null);

  async function load() {
    try { setData(await api.stockxListings()); setErr(''); }
    catch (e) { if (e.unauthorized) return onSignOut(); setErr(e.message); }
    try { setDaily(await api.stockxDaily()); } catch (e) { if (e.unauthorized) onSignOut(); }
  }
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useLive(['stockx_listings', 'stockx_price_edits', 'stockx_price_locks', 'stockx_teach', 'stockx_daily', 'app_settings'], load, { mount: false, paused: confirm || !!lockAsk || !!teachAsk });
  const loadLog = async () => { try { setEdits((await api.stockxEdits()).edits || []); } catch (e) { if (e.unauthorized) onSignOut(); } };
  useEffect(() => { if (showLog) loadLog(); }, [showLog, data]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = data?.rows || [];
  const pull = data?.pull || null;
  const queue = data?.queue || {};
  const pulling = pull?.state === 'running';
  const opts = useMemo(() => ({ rule, offset: numOr(offset) ?? 0, minProfit: numOr(minProfit) ?? 5, allowNoCost, maxCutNoCost: numOr(maxCut) ?? 0 }), [rule, offset, minProfit, allowNoCost, maxCut]);
  const nowMs = Date.now();
  const plans = useMemo(() => new Map(rows.map((r) => [r.listing_id, planListing(r, opts)])), [rows, opts]);
  const gapN = numOr(gapMin); const daysN = numOr(daysMin); const minN = numOr(priceMin); const maxN = numOr(priceMax);
  const filtered = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return rows.filter((r) => {
      if (words.length && !words.every((w) => `${r.product_name} ${r.style_id} ${r.size}`.toLowerCase().includes(w))) return false;
      if (lockedOnly && !r.locked) return false;
      if (stateOnly && plans.get(r.listing_id)?.state !== stateOnly) return false;
      if (changesOnly && !lockedOnly && !stateOnly && !CHANGE.includes(plans.get(r.listing_id)?.state)) return false;
      if (gapN != null && !((gapPct(r) ?? -Infinity) >= gapN)) return false;
      if (daysN != null && !((daysListed(r, nowMs) ?? -1) >= daysN)) return false;
      const a = Number(r.amount);
      if (minN != null && !(a >= minN)) return false;
      if (maxN != null && !(a <= maxN)) return false;
      return true;
    });
  }, [rows, q, lockedOnly, changesOnly, stateOnly, gapN, daysN, minN, maxN, plans]); // eslint-disable-line react-hooks/exhaustive-deps
  const counts = useMemo(() => {
    const c = {};
    for (const p of plans.values()) c[p.state] = (c[p.state] || 0) + 1;
    return c;
  }, [plans]);

  const changeable = (r) => CHANGE.includes(plans.get(r.listing_id)?.state) && !['queued', 'sent'].includes(r.last_status);
  const inView = filtered.filter(changeable);
  const picked = rows.filter((r) => sel.has(r.listing_id));
  const toSend = picked.filter(changeable);
  const cutTotal = toSend.reduce((n, r) => n + (Number(r.amount) - plans.get(r.listing_id).price), 0);
  const allPicked = inView.length > 0 && inView.every((r) => sel.has(r.listing_id));
  const setMany = (list, on) => setSel((cur) => { const n = new Set(cur); for (const r of list) { if (on) n.add(r.listing_id); else n.delete(r.listing_id); } return n; });

  async function startPull() {
    setBusy('pull'); setErr('');
    try { await api.stockxPull(); await load(); }
    catch (e) { if (e.unauthorized) return onSignOut(); setErr(e.message); }
    finally { setBusy(''); }
  }
  async function go() {
    setConfirm(false); setBusy('reprice'); setErr(''); setNote('');
    try {
      const r = await api.stockxReprice({ listingIds: toSend.map((x) => x.listing_id), rule, offset: opts.offset, minProfit: opts.minProfit, allowNoCost, maxCutNoCost: opts.maxCutNoCost });
      setNote(`${fmt(r.queued)} price change${r.queued === 1 ? '' : 's'} queued — they go to StockX a few a second; this page follows them.${r.skipped?.length ? ` ${fmt(r.skipped.length)} skipped (${[...new Set(r.skipped.map((s) => s.why))].slice(0, 3).join(' · ')}).` : ''}`);
      setSel(new Set());
      await load();
    } catch (e) { if (e.unauthorized) return onSignOut(); setErr(e.message); }
    finally { setBusy(''); }
  }
  async function stopQueue() {
    try { const r = await api.stockxRepriceCancel(); setNote(`${fmt(r.cancelled)} queued change${r.cancelled === 1 ? '' : 's'} stopped.`); await load(); }
    catch (e) { if (e.unauthorized) return onSignOut(); setErr(e.message); }
  }
  async function doLock({ note: why }) {
    const { lock, ids } = lockAsk;
    for (let i = 0; i < ids.length; i += 1000) await api.stockxLock(ids.slice(i, i + 1000), lock, lock ? (String(why || '').trim() || null) : undefined);
    if (lock) setSel((cur) => { const n = new Set(cur); ids.forEach((id) => n.delete(id)); return n; });
    setLockAsk(null);
    await load();
  }

  // Teaching the daily run, per SIZE: "this big cut is fine" / "never ask less than $X" / forget it.
  async function teach(row, t) {
    setErr('');
    try { await api.stockxTeach([row.variant_id], t); await load(); }
    catch (e) { if (e.unauthorized) return onSignOut(); setErr(e.message); }
  }
  async function saveAuto(patch) {
    setBusy('auto'); setErr('');
    try { const r = await api.stockxDailySettings(patch); setDaily((d) => (d ? { ...d, settings: r.settings } : d)); }
    catch (e) { if (e.unauthorized) return onSignOut(); setErr(e.message); }
    finally { setBusy(''); }
  }
  async function runDaily() {
    setBusy('auto'); setErr(''); setNote('');
    try { await api.stockxDailyRun(); setNote('Today’s update started — the market read takes about 15 minutes, then the prices go out. This page follows it.'); await load(); }
    catch (e) { if (e.unauthorized) return onSignOut(); setErr(e.message); }
    finally { setBusy(''); }
  }
  const showState = (st) => { setStateOnly(st); setLockedOnly(false); setShown(PAGE); };

  // The view as a spreadsheet — the dated snapshot Genesis checks against in a few days.
  function exportView() {
    const cols = [['product_name', 'Shoe'], ['style_id', 'Style'], ['size', 'Size'], ['days', 'Days listed'], ['amount', 'Our ask'],
      ['standard_lowest', 'Standard lowest'], ['direct_lowest', 'Direct lowest'], ['flex_lowest', 'Flex lowest'], ['highest_bid', 'Highest bid'],
      ['gap', 'Over Standard %'], ['cost', 'Cost'], ['cost_source', 'Cost from'], ['floor', 'Floor'], ['new', 'Suggested'], ['call', 'Call'], ['listing_id', 'Listing id']];
    const out = filtered.map((r) => { const p = plans.get(r.listing_id); const g = gapPct(r);
      return { ...r, days: daysListed(r, nowMs) ?? '', gap: g == null ? '' : g.toFixed(0), floor: floorPrice(r.cost, opts.minProfit) ?? '',
        new: p.price ?? '', call: p.why || (CHANGE.includes(p.state) ? 'lower' : p.state) }; });
    downloadCSV(`stockx-listings-${estToday()}.csv`, toCsv(cols, out));
  }
  function exportLog() {
    const cols = [['requested_at', 'When (UTC)'], ['product_name', 'Shoe'], ['style_id', 'Style'], ['size', 'Size'], ['old_amount', 'Was'], ['new_amount', 'Now'],
      ['standard_lowest', 'Standard lowest'], ['direct_lowest', 'Direct lowest'], ['rule', 'Rule'], ['status', 'Status'], ['error', 'Error'], ['requested_by', 'By'], ['ended', 'Ended since (sold / taken down)'], ['listing_id', 'Listing id']];
    downloadCSV(`stockx-price-changes-${estToday()}.csv`, toCsv(cols, (edits || []).map((e) => ({ ...e, ended: e.listing_ended_at ? estDate(e.listing_ended_at) : '' }))));
  }

  return (
    <div className="app">
      <TopBar title="StockX Listings" onHome={onHome} onSignOut={onSignOut} />
      <div className="card">
        <p className="muted sm">Our live StockX listings (Direct) next to the market for each size — the <b>Standard</b> (Ship to Verify) lowest ask, the <b>Direct</b> lowest ask, Flex and the highest bid. Filter to the ones priced over the market, 🔒 keep the exceptions, and send <b>match the Standard lowest ask</b> to the rest at once — never under the profit floor, and only ever lower.</p>
        <div className="sx-pull">
          <button type="button" className="btn primary" disabled={pulling || busy === 'pull' || data?.configured === false} onClick={startPull}>
            {pulling ? 'Pulling…' : '↻ Pull listings + market from StockX'}</button>
          {pulling && (
            <span className="sx-progress">
              <ProgressBar value={pull.phase === 'market' ? (pull.of ? pull.done / pull.of : 0) : 0}
                label={pull.phase === 'market' ? `Reading the market… ${fmt(pull.done)} of ${fmt(pull.of)} sizes` : `Reading listings… ${fmt(pull.listings)}${pull.total ? ` of ${fmt(pull.total)}` : ''}`} />
            </span>
          )}
          {!pulling && pull?.state === 'done' && <span className="muted sm">Last pulled {when(pull.finishedAt)}{pull.by ? ` by ${pull.by}` : ''} — {fmt(pull.listings)} listings, {fmt(pull.sizes)} sizes{pull.ended ? `, ${fmt(pull.ended)} gone since the pull before` : ''}{pull.marketFailed ? ` · ${fmt(pull.marketFailed)} market reads failed` : ''}.</span>}
          {!pulling && pull?.state === 'failed' && <span className="error sm">The last pull failed: {pull.error}</span>}
          {data && !pull && <span className="muted sm">Not pulled yet — press Pull (about 15 minutes for ~1,750 listings).</span>}
        </div>
        {data?.configured === false && <div className="error sm mt">StockX isn’t set up on this server.</div>}
      </div>

      {daily && <DailyCard daily={daily} rows={rows} isAdmin={isAdmin} busy={busy === 'auto'} pulling={pulling}
        onSave={saveAuto} onRun={runDaily} onShow={showState} />}

      <div className="card sl-toolbar">
        <div className="sl-filters">
          <label className="sl-markup"><span className="muted xs">Rule</span>
            <select className="input" value={rule} onChange={(e) => setRule(e.target.value)} aria-label="Reprice rule">
              {RULES.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select></label>
          {rule === 'standard_minus' && <label className="sl-markup"><span className="muted xs">− $</span>
            <input type="text" inputMode="decimal" value={offset} onChange={(e) => setOffset(e.target.value)} aria-label="Dollars under the Standard lowest ask" /></label>}
          <label className="sl-markup"><span className="muted xs">Min profit $</span>
            <input type="text" inputMode="decimal" value={minProfit} onChange={(e) => setMinProfit(e.target.value)} aria-label="Minimum profit per pair" /></label>
          <label className="sl-markup" title="A pair with no cost on file has no floor. A cut up to this % of today's ask still goes; a bigger one waits for a person."><span className="muted xs">No cost: cut up to</span>
            <input type="text" inputMode="decimal" value={maxCut} onChange={(e) => setMaxCut(e.target.value)} aria-label="Biggest cut for a pair with no cost, percent" /> %</label>
          <label className="er-dry" title="Also lower the big cuts that have no cost on file — off by default"><input type="checkbox" checked={allowNoCost} onChange={(e) => setAllowNoCost(e.target.checked)} /> Reprice ones with no cost (no floor)</label>
        </div>
        <p className="muted xs">Floor = the lowest ask that still pays the min profit after StockX’s 10 % fee: ⌈(cost + profit) ÷ 0.9⌉, or the <b>lowest price</b> someone set for that size. Cost is the Pre-sell row’s for a Pre-sell pair, otherwise the average cost of our pairs of that style + size, otherwise of that style’s other sizes. With no cost at all, the size of the cut is the guard.</p>
        <div className="sl-search-row">
          <input type="search" className="sl-search" value={q} onChange={(e) => { setQ(e.target.value); setShown(PAGE); }} placeholder="Search shoe, style code, size…" aria-label="Search StockX listings" />
        </div>
        <div className="sl-filters ebr-find">
          <span className="muted xs">Find them:</span>
          <label className="sl-markup"><span className="muted xs">Over Standard ≥</span>
            <input type="text" inputMode="decimal" value={gapMin} placeholder="—" aria-label="Over the Standard lowest ask by at least percent" onChange={(e) => { setGapMin(e.target.value); setShown(PAGE); }} /> %</label>
          <label className="sl-markup"><span className="muted xs">Listed ≥</span>
            <input type="text" inputMode="numeric" value={daysMin} placeholder="—" aria-label="Listed at least days" onChange={(e) => { setDaysMin(e.target.value); setShown(PAGE); }} /> days</label>
          <label className="sl-markup"><span className="muted xs">Ask $</span>
            <input type="text" inputMode="decimal" value={priceMin} placeholder="min" aria-label="Ask from" onChange={(e) => { setPriceMin(e.target.value); setShown(PAGE); }} />
            <span className="muted xs">to $</span>
            <input type="text" inputMode="decimal" value={priceMax} placeholder="max" aria-label="Ask to" onChange={(e) => { setPriceMax(e.target.value); setShown(PAGE); }} /></label>
          <label className="er-dry"><input type="checkbox" checked={changesOnly} onChange={(e) => setChangesOnly(e.target.checked)} /> Only ones that would drop</label>
          <label className="er-dry"><input type="checkbox" checked={lockedOnly} onChange={(e) => setLockedOnly(e.target.checked)} /> 🔒 Locked only</label>
          <label className="sl-markup"><span className="muted xs">Show</span>
            <select className="input" value={stateOnly} onChange={(e) => showState(e.target.value)} aria-label="Which listings">
              <option value="">By the boxes on the left</option>
              <option value="no_cost">To look at — big cut, no cost</option>
              <option value="below_floor">Stopped by the floor</option>
            </select></label>
        </div>
        <p className="muted xs sx-counts">
          {fmt(rows.length)} listings · <b>{fmt((counts.change || 0) + (counts.floored || 0))}</b> would drop{counts.floored ? ` (${fmt(counts.floored)} held at the floor)` : ''}
          {counts.kept ? ` · ${fmt(counts.kept)} already at or under` : ''}{counts.below_floor ? ` · ${fmt(counts.below_floor)} the floor stops` : ''}
          {counts.no_cost ? ` · ${fmt(counts.no_cost)} to look at (no cost, big cut)` : ''}{counts.no_market ? ` · ${fmt(counts.no_market)} no market` : ''}
          {counts.locked ? ` · ${fmt(counts.locked)} locked` : ''}{counts.presell ? ` · ${fmt(counts.presell)} Pre-sell` : ''}
        </p>
      </div>

      {(queue.queued > 0 || queue.sent > 0 || note || err) && (
        <div className={`er-verify ${err ? 'fail' : 'pass'}`}>
          {(queue.queued > 0 || queue.sent > 0) && (
            <div className="sx-queue"><b>Sending to StockX:</b> {fmt(queue.queued)} waiting · {fmt(queue.sent)} confirming · {fmt(queue.done_24h)} done today{queue.failed_24h ? ` · ${fmt(queue.failed_24h)} failed` : ''}
              {queue.queued > 0 && <button type="button" className="btn xs ghost" onClick={stopQueue}>Stop the rest</button>}</div>
          )}
          {note && <div className="sm">{note}</div>}
          {err && <div className="error sm">{err}</div>}
        </div>
      )}

      <div className="card sl-list">
        <div className="ebr-bulk">
          {filtered.filter((r) => !r.locked).length > 0 && <button type="button" className="btn sm" onClick={() => setLockAsk({ lock: true, ids: filtered.filter((r) => !r.locked).map((r) => r.listing_id) })}>🔒 Keep all {fmt(filtered.filter((r) => !r.locked).length)} in view</button>}
          {filtered.filter((r) => r.locked).length > 0 && <button type="button" className="btn sm ghost" onClick={() => setLockAsk({ lock: false, ids: filtered.filter((r) => r.locked).map((r) => r.listing_id) })}>🔓 Unlock all {fmt(filtered.filter((r) => r.locked).length)} in view</button>}
          <button type="button" className="btn sm ghost" disabled={!filtered.length} onClick={exportView}>⬇ CSV of this view</button>
        </div>
        <div className="ebl-endbar">
          <label className="ebl-check"><input type="checkbox" checked={allPicked} disabled={!inView.length} onChange={(e) => setMany(inView, e.target.checked)} /> Select all {fmt(inView.length)} that would drop</label>
          <span className="ebr-sel-actions">
            {sel.size > 0 && <button type="button" className="btn ghost sm" onClick={() => setSel(new Set())}>Clear ({fmt(sel.size)})</button>}
            <button type="button" className="btn primary" disabled={!toSend.length || busy === 'reprice'} onClick={() => setConfirm(true)}>Reprice {toSend.length ? fmt(toSend.length) : ''} on StockX</button>
          </span>
        </div>
        {!data ? <p className="muted">Loading…</p> : !filtered.length ? <p className="muted">{rows.length ? 'Nothing matches.' : 'No listings yet — pull them from StockX.'}</p> : (
          <div className="sx-rows">
            {filtered.slice(0, shown).map((r) => {
              const p = plans.get(r.listing_id);
              const g = gapPct(r);
              const d = daysListed(r, nowMs);
              const can = changeable(r);
              return (
                <div key={r.listing_id} className={`sx-row${sel.has(r.listing_id) ? ' on' : ''}${r.locked ? ' locked' : ''}`}>
                  <input type="checkbox" checked={sel.has(r.listing_id)} disabled={!can} onChange={(e) => setMany([r], e.target.checked)} aria-label={`Pick ${r.product_name} size ${r.size}`} />
                  <div className="sx-shoe">
                    <b>{r.product_name || '—'}</b>
                    <span className="muted xs">{r.style_id || 'no style'} · size {r.size || '—'}{d != null ? ` · listing ${d} d old` : ''}</span>
                    {r.locked && <span className="ebr-chip lock" title={r.lock_note || ''}>🔒 Keep price{r.locked_by ? ` · ${r.locked_by}` : ''}</span>}
                    {['queued', 'sent'].includes(r.last_status) && <span className="ebr-chip">→ ${Number(r.last_amount)} on its way</span>}
                    {r.last_status === 'failed' && <span className="ebl-note bad xs">Last change failed: {r.last_error}</span>}
                    {(Number(r.min_price) > 0 || r.big_cut_ok) && (
                      <span className="ebr-chip lock" title={`${r.teach_note || ''}${r.taught_by ? ` — ${r.taught_by}` : ''}`}>
                        {Number(r.min_price) > 0 ? `Lowest ${money(r.min_price)}` : ''}{Number(r.min_price) > 0 && r.big_cut_ok ? ' · ' : ''}{r.big_cut_ok ? 'Big cut OK’d' : ''}
                        <button type="button" className="sx-x" aria-label={`Forget what was taught for ${r.product_name} size ${r.size}`} onClick={() => teach(r, { clear: true })}>×</button>
                      </span>
                    )}
                  </div>
                  <div className="sx-nums">
                    <span><span className="muted xs">Ours</span> <b>{money(r.amount)}</b></span>
                    <span><span className="muted xs">Standard</span> {money(r.standard_lowest)}{g != null && g > 0 ? <span className="ebl-note bad xs"> +{g.toFixed(0)}%</span> : null}</span>
                    <span><span className="muted xs">Direct</span> {money(r.direct_lowest)}</span>
                    <span><span className="muted xs">Bid</span> {money(r.highest_bid)}</span>
                    <span><span className="muted xs">Cost</span> {money(r.cost)}{r.cost_source === 'presell' ? <span className="muted xs"> (pre-sell)</span> : r.cost_source === 'style' ? <span className="muted xs"> (other sizes)</span> : null}</span>
                  </div>
                  <div className="sx-call">
                    {CHANGE.includes(p.state)
                      ? <><b className="ebl-note ok">→ {money(p.price)}</b><span className="muted xs"> −{money(Number(r.amount) - p.price)}</span>{p.why && <div className="muted xs">{p.why}</div>}</>
                      : <span className="muted xs">{p.why}</span>}
                    {p.state === 'no_cost' && p.target < Number(r.amount) && r.variant_id && (
                      <div className="sx-teach">
                        <button type="button" className="btn xs" onClick={() => teach(r, { bigCutOk: true })} aria-label={`OK to lower ${r.product_name} size ${r.size} to ${money(p.target)}`}>✓ OK → {money(p.target)}</button>
                        <button type="button" className="btn xs ghost" onClick={() => setTeachAsk({ row: r })} aria-label={`Set the lowest price for ${r.product_name} size ${r.size}`}>Lowest price…</button>
                      </div>
                    )}
                  </div>
                  <button type="button" className={`btn xs ${r.locked ? '' : 'ghost'}`} aria-label={r.locked ? `Unlock ${r.product_name} size ${r.size}` : `Keep ${r.product_name} size ${r.size}`}
                    onClick={() => setLockAsk({ lock: !r.locked, ids: [r.listing_id] })}>{r.locked ? '🔓' : '🔒'}</button>
                </div>
              );
            })}
          </div>
        )}
        {filtered.length > shown && <button type="button" className="btn ghost sm mt" onClick={() => setShown((n) => n + PAGE * 5)}>Show more ({fmt(filtered.length - shown)} left)</button>}
      </div>

      <div className="card">
        <button type="button" className="btn ghost sm" onClick={() => setShowLog((v) => !v)}>{showLog ? '▾' : '▸'} Price changes sent from here</button>
        {showLog && (
          !edits ? <p className="muted">Loading…</p> : !edits.length ? <p className="muted mt">Nothing repriced from here yet.</p> : (
            <>
              <p className="muted xs mt">“Ended” = the listing has gone from StockX since (sold, or taken down) — the check for whether a cut moved it.
                <button type="button" className="btn xs ghost" onClick={exportLog}>⬇ CSV</button></p>
              <div className="ap-tablewrap">
                <table className="table ebl-table">
                  <thead><tr><th>When</th><th>Shoe</th><th>Size</th><th className="num">Was</th><th className="num">Now</th><th>Standard</th><th>Status</th><th>Ended</th><th>By</th></tr></thead>
                  <tbody>
                    {edits.slice(0, 300).map((e) => (
                      <tr key={e.id}>
                        <td className="xs ebl-nowrap">{when(e.requested_at)}</td>
                        <td className="xs">{e.product_name || e.listing_id}</td>
                        <td>{e.size || '—'}</td>
                        <td className="num">{money(e.old_amount)}</td>
                        <td className="num"><b>{money(e.new_amount)}</b></td>
                        <td className="xs">{money(e.standard_lowest)}</td>
                        <td className="xs">{e.status === 'failed' ? <span className="error xs">failed: {e.error}</span> : e.status}</td>
                        <td className="xs">{e.listing_ended_at ? `✓ ${estDate(e.listing_ended_at)}` : ''}</td>
                        <td className="xs">{e.requested_by || ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )
        )}
      </div>

      {confirm && (
        <Modal type="warn" title={`Reprice ${fmt(toSend.length)} StockX listing${toSend.length === 1 ? '' : 's'}?`}
          message={`Each goes to ${ruleLabel(rule, opts.offset)}, never under its floor (min profit $${opts.minProfit}) — ${money(cutTotal)} off in total. They change the live StockX ask, a few a second; this page shows them landing. Locked and Pre-sell listings are left alone.`}
          onClose={() => setConfirm(false)}>
          <button type="button" className="btn ghost" onClick={() => setConfirm(false)}>Cancel</button>
          <button type="button" className="btn primary" onClick={go}>Reprice {fmt(toSend.length)}</button>
        </Modal>
      )}
      {teachAsk && (
        <FormModal
          title={`Lowest price for ${teachAsk.row.product_name || 'this shoe'} · size ${teachAsk.row.size}`}
          message={`Ours ${money(teachAsk.row.amount)} · Standard lowest ${money(teachAsk.row.standard_lowest)} · highest bid ${money(teachAsk.row.highest_bid)}. The daily update follows the market down to this price and never under it — remembered for this size, also after the listing is re-made.`}
          submitLabel="Save"
          onClose={() => setTeachAsk(null)}
          onSubmit={async ({ price, note: why }) => {
            const m = numOr(price ?? '');
            if (!(m > 0)) throw new Error('Type a dollar amount.');
            await api.stockxTeach([teachAsk.row.variant_id], { minPrice: m, note: String(why || '').trim() || undefined });
            setTeachAsk(null); await load();
          }}
          fields={[{ name: 'price', label: 'Never ask less than ($)', type: 'text', placeholder: 'e.g. 85' }, { name: 'note', label: 'Why? (optional)', type: 'textarea', placeholder: 'e.g. paid $70 in-store' }]} />
      )}
      {lockAsk && (
        <FormModal
          title={lockAsk.lock ? `Keep the price on ${fmt(lockAsk.ids.length)} listing${lockAsk.ids.length === 1 ? '' : 's'}?` : `Unlock ${fmt(lockAsk.ids.length)} listing${lockAsk.ids.length === 1 ? '' : 's'}?`}
          message={lockAsk.lock ? 'No reprice run will change these until someone unlocks them.' : 'Reprice runs can change these again.'}
          submitLabel={lockAsk.lock ? `🔒 Keep ${fmt(lockAsk.ids.length)}` : `🔓 Unlock ${fmt(lockAsk.ids.length)}`}
          onClose={() => setLockAsk(null)} onSubmit={doLock}
          fields={lockAsk.lock ? [{ name: 'note', label: 'Why? (optional)', type: 'textarea', placeholder: 'e.g. rare size — holding' }] : []} />
      )}
    </div>
  );
}

// ---- The daily, automatic update ------------------------------------------------------------
// The server reads the market every day at the set EST hour and — when the switch is ON —
// lowers every ask the rules allow. This card is the switch, the rules it runs by, today's
// picture and the record of the last days. Only an admin changes the switch or the rules.
function DailyCard({ daily, rows, isAdmin, busy, pulling, onSave, onRun, onShow }) {
  const s = daily.settings;
  const [form, setForm] = useState(null);   // the rules being edited, or null
  const live = useMemo(() => dailyStats(rows, { rule: s.rule, offset: s.offset, minProfit: s.minProfit, maxCutNoCost: s.maxCutNoCost }), [rows, s]);
  const today = (daily.days || []).find((d) => d.day === daily.today) || null;
  const a = today?.auto || null;
  const hour12 = (h) => `${((h + 11) % 12) + 1}:00 ${h < 12 ? 'AM' : 'PM'} EST`;
  const status = daily.running || (pulling && !a) ? 'Running now — reading the market…'
    : a?.failed ? `Today’s run failed: ${a.failed}`
      : a?.off ? 'Today’s market read is done. The automatic update is OFF, so no price was changed.'
        : a ? `Today’s run is done: ${fmt(a.queued)} listing${a.queued === 1 ? '' : 's'} sent to be lowered${a.cutUsd != null ? ` (−$${fmt(a.cutUsd)})` : ''} at ${when(a.at)}.`
          : daily.enabledHere ? `Today’s run starts at ${hour12(s.hour)}.` : 'The daily run only happens on the production server.';
  return (
    <div className="card sx-daily">
      <div className="sx-daily-head">
        <h3 className="sx-daily-h">Daily price update <span className={`ebr-chip ${s.on ? 'up' : 'down'}`}>{s.on ? 'AUTOMATIC — ON' : 'AUTOMATIC — OFF'}</span></h3>
        {isAdmin && (
          <span className="sx-daily-actions">
            <button type="button" className={`btn sm ${s.on ? 'ghost' : 'primary'}`} disabled={busy}
              onClick={() => { if (s.on || window.confirm(`Turn the automatic update ON? Every day at ${hour12(s.hour)} the server will lower our StockX asks by these rules, with nobody pressing anything.`)) onSave({ on: !s.on }); }}>
              {s.on ? 'Turn it off' : 'Turn it on'}</button>
            <button type="button" className="btn sm ghost" disabled={busy} onClick={() => setForm(form ? null : { minProfit: String(s.minProfit), maxCutNoCost: String(s.maxCutNoCost), hour: String(s.hour) })}>Rules…</button>
            <button type="button" className="btn sm ghost" disabled={busy || daily.running || pulling || !daily.enabledHere} onClick={onRun}
              title={daily.enabledHere ? '' : 'Only on the production server'}>Run today’s update now</button>
          </span>
        )}
      </div>
      <p className="sm sx-daily-status" role="status">{status}</p>
      <p className="muted xs">
        Every day at <b>{hour12(s.hour)}</b> the server reads every listing and its market, then lowers each ask to <b>{ruleLabel(s.rule, s.offset)}</b> —
        never under the floor (cost + ${s.minProfit} profit after StockX’s fee, or the lowest price set for that size), never a 🔒 or Pre-sell listing, and only ever down.
        A pair with <b>no cost on file</b> follows the market when the cut is {s.maxCutNoCost} % or less; a bigger cut waits below until someone presses <b>✓ OK</b>, sets a <b>lowest price</b> or 🔒 keeps it — that answer is remembered for the size.
        {s.changedBy ? ` Rules last changed by ${s.changedBy}.` : ''}
      </p>
      {form && (
        <div className="sl-filters sx-daily-form">
          <label className="sl-markup"><span className="muted xs">Min profit $</span>
            <input type="text" inputMode="decimal" value={form.minProfit} onChange={(e) => setForm({ ...form, minProfit: e.target.value })} aria-label="Daily update: minimum profit" /></label>
          <label className="sl-markup"><span className="muted xs">No cost: cut up to</span>
            <input type="text" inputMode="decimal" value={form.maxCutNoCost} onChange={(e) => setForm({ ...form, maxCutNoCost: e.target.value })} aria-label="Daily update: biggest cut with no cost, percent" /> %</label>
          <label className="sl-markup"><span className="muted xs">Hour (EST, 0–23)</span>
            <input type="text" inputMode="numeric" value={form.hour} onChange={(e) => setForm({ ...form, hour: e.target.value })} aria-label="Daily update: hour of the day, EST" /></label>
          <button type="button" className="btn sm primary" disabled={busy}
            onClick={async () => { await onSave({ minProfit: numOr(form.minProfit) ?? s.minProfit, maxCutNoCost: numOr(form.maxCutNoCost) ?? s.maxCutNoCost, hour: numOr(form.hour) ?? s.hour }); setForm(null); }}>Save the rules</button>
        </div>
      )}
      <div className="sx-daily-tiles">
        <div className="sx-tile"><b>{fmt(live.over)}</b><span>of {fmt(live.active)} over the Standard lowest ask · ${fmt(live.overUsd)} over</span>
          <span className="muted xs">{BANDS.map(([k, label]) => `${fmt(live.bands[k])} ${label}`).join(' · ')}</span></div>
        <button type="button" className="sx-tile act" onClick={() => onShow('')}><b>{fmt(live.ready)}</b><span>{s.on ? 'go down with the next run' : 'ready to lower'} · −${fmt(live.readyUsd)}</span>
          <span className="muted xs">{fmt(live.readyNoCost)} of them have no cost (small cuts)</span></button>
        <button type="button" className="sx-tile act warn" onClick={() => onShow('no_cost')}><b>{fmt(live.review)}</b><span>to look at — big cut, no cost · −${fmt(live.reviewUsd)}</span>
          <span className="muted xs">✓ OK · Lowest price… · 🔒 Keep</span></button>
        <button type="button" className="sx-tile act" onClick={() => onShow('below_floor')}><b>{fmt(live.floorStops)}</b><span>stopped by the floor</span>
          <span className="muted xs">the market is under what they cost us</span></button>
      </div>
      {daily.days?.length > 0 && (
        <div className="ap-tablewrap">
          <table className="table ebl-table sx-days">
            <thead><tr><th>Day (EST)</th><th className="num">Live</th><th className="num">Over Standard</th><th className="num">$ over</th><th className="num">Lowered</th><th className="num">$ cut</th><th className="num">To look at</th><th className="num">Left StockX</th><th>Run</th></tr></thead>
            <tbody>
              {daily.days.map((d) => (
                <tr key={d.day}>
                  <td className="ebl-nowrap">{d.day}</td>
                  <td className="num">{d.stats ? fmt(d.stats.active) : '—'}</td>
                  <td className="num">{d.stats ? fmt(d.stats.over) : '—'}</td>
                  <td className="num">{d.stats ? `$${fmt(d.stats.overUsd)}` : '—'}</td>
                  <td className="num"><b>{fmt(d.lowered)}</b>{d.failed ? <span className="error xs"> · {fmt(d.failed)} failed</span> : null}</td>
                  <td className="num">{d.cut ? `−$${fmt(Math.round(d.cut))}` : '—'}</td>
                  <td className="num">{d.stats ? fmt(d.stats.review) : '—'}</td>
                  <td className="num">{fmt(d.gone)}</td>
                  <td className="xs">{d.auto?.failed ? <span className="error xs">failed</span> : d.auto?.off ? 'read only (off)' : d.auto ? `auto · ${d.auto.by || ''}` : 'read by hand'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
