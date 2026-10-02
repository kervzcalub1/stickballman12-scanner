// Inventory · "Bulk · check all" — scan (or paste) a hundred-plus VINs FIRST, then ask
// once: which of these are registered? (api/items/check-vins → checkVinsBulk).
//
// The sibling of "Rapid · instant" (Inventory.jsx ScanSession), which answers every scan
// as it lands. This one doesn't look anything up while you scan — a gun at full speed
// shouldn't wait on the network — and the answer is a SUMMARY you can filter, copy and
// download: registered / not registered / unused sticker / void / deleted / not a VIN.
//
// The list is kept on this device (localStorage) so a refresh, a trip into a pair's
// detail or a dropped connection halfway through a 200-pair walk doesn't lose it.
import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { statusLabel } from '../statuses.js';
import { estDate, estTime, estToday } from '../lib/format.js';
import { downloadCSV } from '../lib/csv.js';
import { beepOk } from '../lib/beep.js';
import { Icon } from './NavIcons.jsx';

const STORE = 'sb_bulk_vin_check_v1';
const MAX = 1000;
const RESULT = {
  registered:     { label: 'Registered',      tone: 'ok' },
  not_registered: { label: 'Not registered',  tone: 'bad' },
  sticker_unused: { label: 'Unused sticker',  tone: 'warn' },
  sticker_void:   { label: 'Void sticker',    tone: 'bad' },
  deleted:        { label: 'Deleted',         tone: 'warn' },
  not_a_vin:      { label: 'Not a VIN',       tone: 'muted' },
  pending:        { label: 'Not checked yet', tone: 'muted' },
};
const ORDER = ['registered', 'not_registered', 'sticker_unused', 'sticker_void', 'deleted', 'not_a_vin', 'pending'];

function load() {
  try { const s = JSON.parse(localStorage.getItem(STORE) || 'null'); if (s && Array.isArray(s.list)) return s; } catch { /* fresh */ }
  return { list: [], results: {}, checkedAt: null };
}

function detailOf(r) {
  if (!r) return '';
  if (r.result === 'registered') {
    const it = r.item || {};
    return [it.name, [it.sku, it.size && `size ${it.size}`].filter(Boolean).join(' · '),
      it.location ? `shelf ${it.location}` : 'unshelved', it.batch && `batch ${it.batch}`].filter(Boolean).join(' — ');
  }
  if (r.result === 'deleted') {
    const d = r.deleted || {};
    return `Removed ${d.at ? `${estDate(d.at)} EST` : ''}${d.by ? ` by ${d.by}` : ''}${d.reason ? ` (${d.reason})` : ''} — was ${[d.sku, d.size && `size ${d.size}`].filter(Boolean).join(' ')}`;
  }
  if (r.result === 'sticker_unused') return `A 1ID still on the roll — on no pair${r.sticker?.runId ? ` (roll #${r.sticker.runId})` : ''}`;
  if (r.result === 'sticker_void') return `A voided 1ID${r.sticker?.voidedAt ? ` (voided ${estDate(r.sticker.voidedAt)} EST)` : ''} — should not be on a pair`;
  if (r.result === 'not_registered') return 'No pair, sticker or record has this VIN';
  if (r.result === 'not_a_vin') return 'Not shaped like a VIN (a UPC, a shelf code, a mis-scan?)';
  return '';
}

export const BulkVinCheck = forwardRef(function BulkVinCheck({ sound = false, onOpen, onSignOut }, ref) {
  const [state, setState] = useState(load);   // { list: [{ vin, seen, at }] newest first, results: { vin: result }, checkedAt }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [scan, setScan] = useState('');
  const [pasting, setPasting] = useState(false);
  const [paste, setPaste] = useState('');
  const [copied, setCopied] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => { try { localStorage.setItem(STORE, JSON.stringify(state)); } catch { /* private mode: list lives in memory */ } }, [state]);
  useEffect(() => { inputRef.current?.focus(); }, []);

  // Adding is instant and offline — the whole point is a gun that never waits.
  function add(codes) {
    const clean = (Array.isArray(codes) ? codes : [codes]).map((c) => String(c || '').trim().toUpperCase()).filter(Boolean);
    if (!clean.length) return;
    setState((s) => {
      let list = s.list;
      for (const vin of clean) {
        const i = list.findIndex((r) => r.vin === vin);
        // A repeat bumps a counter rather than stacking a second row: on a walk the same
        // pair genuinely gets crossed twice, and two rows read as two pairs.
        list = i < 0
          ? [{ vin, seen: 1, at: Date.now() }, ...list]
          : [{ ...list[i], seen: list[i].seen + 1, at: Date.now() }, ...list.slice(0, i), ...list.slice(i + 1)];
      }
      return { ...s, list };
    });
    if (sound) beepOk();
  }
  useImperativeHandle(ref, () => ({ add }));

  const unchecked = state.list.filter((r) => !state.results[r.vin]);
  async function check(onlyNew) {
    const vins = (onlyNew ? unchecked : state.list).map((r) => r.vin);
    if (!vins.length) return;
    if (vins.length > MAX) { setError(`That's ${vins.length} VINs — check at most ${MAX} at a time (Clear, or split the walk).`); return; }
    setBusy(true); setError('');
    try {
      const r = await api.checkVinsBulk(vins);
      setState((s) => {
        const results = onlyNew ? { ...s.results } : {};
        for (const x of r.results) results[x.vin] = x;
        return { ...s, results, checkedAt: Date.now() };
      });
    } catch (e) {
      if (e.unauthorized) return onSignOut?.();
      setError(e.message);
    } finally { setBusy(false); }
  }

  const rows = state.list.map((r) => ({ ...r, res: state.results[r.vin] || null, key: state.results[r.vin]?.result || 'pending' }));
  const counts = useMemo(() => {
    const c = {};
    for (const r of rows) c[r.key] = (c[r.key] || 0) + 1;
    return c;
  }, [rows]);
  const shown = filter ? rows.filter((r) => r.key === filter) : rows;

  function submitScan(e) {
    e.preventDefault();
    // Read the BOX, not state: a gun types the code and hits Enter in the same breath,
    // and the Enter can land before React has re-rendered with the last keystrokes.
    const el = inputRef.current;
    // Split like the paste box: several VINs pasted into the scan box are several scans.
    add(String(el ? el.value : scan).split(/[\s,;]+/));
    if (el) el.value = '';
    setScan('');
    el?.focus();
  }
  function addPasted() {
    add(paste.split(/[\s,;]+/));
    setPaste(''); setPasting(false);
  }
  async function copyShown() {
    try { await navigator.clipboard.writeText(shown.map((r) => r.vin).join('\n')); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { setError('Could not copy — your browser blocked the clipboard.'); }
  }
  function download() {
    const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const head = ['VIN', 'Result', 'Times scanned', 'Name', 'SKU', 'Size', 'Status', 'Shelf', 'Batch', 'Detail'];
    const body = shown.map((r) => {
      const it = r.res?.item || r.res?.deleted || {};
      return [r.vin, RESULT[r.key].label, r.seen, it.name, it.sku, it.size,
        r.res?.item?.status ? statusLabel(r.res.item.status) : '', r.res?.item?.location, r.res?.item?.batch, detailOf(r.res)].map(esc).join(',');
    });
    downloadCSV(`vin-check-${estToday()}${filter ? `-${filter}` : ''}.csv`, [head.join(','), ...body].join('\n'));
  }
  function clearAll() {
    if (state.list.length && !window.confirm(`Clear all ${state.list.length} scanned VINs?`)) return;
    setState({ list: [], results: {}, checkedAt: null }); setFilter(''); setError('');
  }
  const undo = () => setState((s) => {
    const [last, ...rest] = s.list;
    if (!last) return s;
    if (last.seen > 1) return { ...s, list: [{ ...last, seen: last.seen - 1 }, ...rest] };
    const results = { ...s.results }; delete results[last.vin];
    return { ...s, list: rest, results };
  });

  return (
    <div className="bulk-check">
      <div className="bulk-check-head">
        <div>
          <b>Bulk · check all</b>
          <span className="muted sm"> — scan every VIN first, then press Check. Nothing is looked up while you scan.</span>
        </div>
      </div>

      <form className="bulk-check-scan" onSubmit={submitScan}>
        <input ref={inputRef} value={scan} onChange={(e) => setScan(e.target.value)} placeholder="Scan VINs here, one after another"
          autoCapitalize="characters" autoCorrect="off" spellCheck={false} aria-label="Scan a VIN into the bulk list" />
        <button className="btn" type="submit" disabled={!scan.trim()}>Add</button>
        <button className="btn ghost" type="button" onClick={() => setPasting((v) => !v)}>{pasting ? 'Close paste' : 'Paste a list'}</button>
      </form>
      {pasting && (
        <div className="bulk-check-paste">
          <textarea className="input" rows={4} value={paste} onChange={(e) => setPaste(e.target.value)}
            placeholder="Paste VINs — one per line, or separated by spaces or commas" />
          <button className="btn sm" type="button" disabled={!paste.trim()} onClick={addPasted}>Add these</button>
        </div>
      )}

      <div className="bulk-check-bar">
        <span className="bulk-check-total"><b>{state.list.length}</b> VIN{state.list.length === 1 ? '' : 's'}
          {state.list.reduce((n, r) => n + r.seen, 0) > state.list.length && <span className="muted sm"> ({state.list.reduce((n, r) => n + r.seen, 0)} scans)</span>}
        </span>
        {unchecked.length > 0 && Object.keys(state.results).length > 0 ? (
          <button className="btn primary" type="button" disabled={busy} onClick={() => check(true)}>
            {busy ? 'Checking…' : `Check ${unchecked.length} new`}
          </button>
        ) : (
          <button className="btn primary" type="button" disabled={busy || !state.list.length} onClick={() => check(false)}>
            {busy ? 'Checking…' : Object.keys(state.results).length ? 'Check all again' : `Check all${state.list.length ? ` ${state.list.length}` : ''}`}
          </button>
        )}
        <button className="btn ghost sm" type="button" disabled={!state.list.length} onClick={undo}>↶ Undo last</button>
        <button className="btn ghost sm" type="button" disabled={!state.list.length} onClick={clearAll}>Clear</button>
      </div>
      {error && <p className="notice sm" role="alert">{error}</p>}

      {state.list.length > 0 && (
        <>
          <div className="bulk-check-chips" role="group" aria-label="Filter by result">
            <button type="button" className={`bc-chip${!filter ? ' on' : ''}`} onClick={() => setFilter('')}>All {state.list.length}</button>
            {ORDER.filter((k) => counts[k]).map((k) => (
              <button key={k} type="button" className={`bc-chip tone-${RESULT[k].tone}${filter === k ? ' on' : ''}`}
                aria-pressed={filter === k} onClick={() => setFilter(filter === k ? '' : k)}>
                {RESULT[k].label} {counts[k]}
              </button>
            ))}
            <span className="bulk-check-exports">
              <button type="button" className="btn ghost sm" onClick={copyShown}>{copied ? 'Copied ✓' : `Copy ${shown.length} VIN${shown.length === 1 ? '' : 's'}`}</button>
              <button type="button" className="btn ghost sm" onClick={download}><Icon name="download" /> CSV</button>
            </span>
          </div>
          {state.checkedAt && <div className="muted xs">Checked {estTime(state.checkedAt)} EST</div>}

          <ul className="bulk-check-list">
            {shown.map((r) => (
              <li key={r.vin} className={`bulk-row tone-${RESULT[r.key].tone}`}>
                <span className="bulk-row-vin mono">{r.vin}{r.seen > 1 && <span className="muted sm"> ×{r.seen}</span>}</span>
                <span className={`bulk-pill tone-${RESULT[r.key].tone}`}>{RESULT[r.key].label}</span>
                {r.res?.item?.status && <span className="bulk-status muted sm">{statusLabel(r.res.item.status)}</span>}
                <span className="bulk-row-detail sm">{detailOf(r.res)}</span>
                {r.key === 'registered' && onOpen && (
                  <button type="button" className="btn ghost sm" onClick={() => onOpen(r.vin)}>Details →</button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
});
