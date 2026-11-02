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
import { RULES, planListing, gapPct, daysListed, floorPrice, ruleLabel } from '../lib/stockxReprice.js';

const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const money = (n) => (n == null || n === '' ? '—' : `$${Number(n).toFixed(2).replace(/\.00$/, '')}`);
const when = (iso) => (iso ? `${PH_DATETIME.format(new Date(iso))} EST` : '—');
const numOr = (v) => { const n = Number(String(v).replace(/[$,%\s]/g, '')); return String(v).trim() !== '' && Number.isFinite(n) ? n : null; };
const PAGE = 100;
const CHANGE = ['change', 'floored'];

export function StockxListings({ onHome, onSignOut }) {
  const [data, setData] = useState(null);   // { rows, pull, queue, configured }
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  // The rule — never remembered: every visit starts at "match the Standard lowest ask", $5 floor.
  const [rule, setRule] = useState('standard');
  const [offset, setOffset] = useState('1');
  const [minProfit, setMinProfit] = useState('5');
  const [allowNoCost, setAllowNoCost] = useState(false);
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
  }
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useLive(['stockx_listings', 'stockx_price_edits', 'stockx_price_locks', 'app_settings'], load, { mount: false, paused: confirm || !!lockAsk });
  const loadLog = async () => { try { setEdits((await api.stockxEdits()).edits || []); } catch (e) { if (e.unauthorized) onSignOut(); } };
  useEffect(() => { if (showLog) loadLog(); }, [showLog, data]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = data?.rows || [];
  const pull = data?.pull || null;
  const queue = data?.queue || {};
  const pulling = pull?.state === 'running';
  const opts = useMemo(() => ({ rule, offset: numOr(offset) ?? 0, minProfit: numOr(minProfit) ?? 5, allowNoCost }), [rule, offset, minProfit, allowNoCost]);
  const nowMs = Date.now();
  const plans = useMemo(() => new Map(rows.map((r) => [r.listing_id, planListing(r, opts)])), [rows, opts]);
  const gapN = numOr(gapMin); const daysN = numOr(daysMin); const minN = numOr(priceMin); const maxN = numOr(priceMax);
  const filtered = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return rows.filter((r) => {
      if (words.length && !words.every((w) => `${r.product_name} ${r.style_id} ${r.size}`.toLowerCase().includes(w))) return false;
      if (lockedOnly && !r.locked) return false;
      if (changesOnly && !lockedOnly && !CHANGE.includes(plans.get(r.listing_id)?.state)) return false;
      if (gapN != null && !((gapPct(r) ?? -Infinity) >= gapN)) return false;
      if (daysN != null && !((daysListed(r, nowMs) ?? -1) >= daysN)) return false;
      const a = Number(r.amount);
      if (minN != null && !(a >= minN)) return false;
      if (maxN != null && !(a <= maxN)) return false;
      return true;
    });
  }, [rows, q, lockedOnly, changesOnly, gapN, daysN, minN, maxN, plans]); // eslint-disable-line react-hooks/exhaustive-deps
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
      const r = await api.stockxReprice({ listingIds: toSend.map((x) => x.listing_id), rule, offset: opts.offset, minProfit: opts.minProfit, allowNoCost });
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
          <label className="er-dry" title="With no cost on file the floor can't be checked — off by default"><input type="checkbox" checked={allowNoCost} onChange={(e) => setAllowNoCost(e.target.checked)} /> Reprice ones with no cost (no floor)</label>
        </div>
        <p className="muted xs">Floor = the lowest ask that still pays the min profit after StockX’s 10 % fee: ⌈(cost + profit) ÷ 0.9⌉. Cost is the Pre-sell row’s for a Pre-sell pair, otherwise the average cost of our pairs of that style + size.</p>
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
        </div>
        <p className="muted xs sx-counts">
          {fmt(rows.length)} listings · <b>{fmt((counts.change || 0) + (counts.floored || 0))}</b> would drop{counts.floored ? ` (${fmt(counts.floored)} held at the floor)` : ''}
          {counts.kept ? ` · ${fmt(counts.kept)} already at or under` : ''}{counts.below_floor ? ` · ${fmt(counts.below_floor)} the floor stops` : ''}
          {counts.no_cost ? ` · ${fmt(counts.no_cost)} no cost` : ''}{counts.no_market ? ` · ${fmt(counts.no_market)} no market` : ''}
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
                  </div>
                  <div className="sx-nums">
                    <span><span className="muted xs">Ours</span> <b>{money(r.amount)}</b></span>
                    <span><span className="muted xs">Standard</span> {money(r.standard_lowest)}{g != null && g > 0 ? <span className="ebl-note bad xs"> +{g.toFixed(0)}%</span> : null}</span>
                    <span><span className="muted xs">Direct</span> {money(r.direct_lowest)}</span>
                    <span><span className="muted xs">Bid</span> {money(r.highest_bid)}</span>
                    <span><span className="muted xs">Cost</span> {money(r.cost)}{r.cost_source === 'presell' ? <span className="muted xs"> (pre-sell)</span> : null}</span>
                  </div>
                  <div className="sx-call">
                    {CHANGE.includes(p.state)
                      ? <><b className="ebl-note ok">→ {money(p.price)}</b><span className="muted xs"> −{money(Number(r.amount) - p.price)}</span>{p.why && <div className="muted xs">{p.why}</div>}</>
                      : <span className="muted xs">{p.why}</span>}
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
