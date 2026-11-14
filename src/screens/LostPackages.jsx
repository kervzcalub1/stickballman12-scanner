// Lost Package Tracker Tool (docs/context/lost-packages.md, 2026-11-14) — the website's own
// version of "Stickballman12LLC - Lost Package Tracker Tool v1.1.0", which had to be started
// from run.bat / run.command on one person's computer. Nothing to install here:
//   Phase 1 reads the month's "Make | Order Updates Sheet | <Month Year>.xlsx" IN THE BROWSER
//   (src/lib/lostPackage.js) and saves every order it found as a RUN for that month.
//   Phase 2 is a SERVER job (api/_lib/lostpkg-worker.js) asking FedEx / EasyPost about the
//   Lost ones — closing this page doesn't stop it; Pause / Resume / Stop work from anywhere.
// Admins + the PH team. Every run is kept, so each month can be reopened and re-checked.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { TopBar } from '../components/common.jsx';
import { TrackingLink } from '../components/TrackingLink.jsx';
import { useLive } from '../hooks.js';
import { useQueryParam } from '../lib/urlstate.js';
import { estDate, estTime } from '../lib/format.js';
import { XLSX_MIME } from '../lib/xlsx.js';
import { scanWorkbookBytes, monthFromFileName, phase1Book, phase2Book, CLASSES, P2_LABEL, excelIdText } from '../lib/lostPackage.js';

const CHUNK = 400;
const SHOW = 300;
const n = (v) => Number(v || 0).toLocaleString('en-US');
const when = (v) => (v ? `${estDate(v)} ${estTime(v)} EST` : '');
const P2_STATE = { none: 'Not run yet', running: 'Checking…', paused: 'Paused', stopped: 'Stopped', done: 'Done' };

function saveBytes(name, bytes) {
  const url = URL.createObjectURL(new Blob([bytes], { type: XLSX_MIME }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const fileSafe = (s) => String(s || 'run').replace(/[^A-Za-z0-9 _-]+/g, '').trim().replace(/\s+/g, '-');

export function LostPackages({ onHome, onSignOut }) {
  const [runs, setRuns] = useState(null);
  const [carriers, setCarriers] = useState({ ready: false, missing: [] });
  const [runParam, setRunParam] = useQueryParam('run', '');
  const runId = Number(runParam) || null;
  const [detail, setDetail] = useState(null);       // { run, orders } for the open run
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');

  // Phase 1 form
  const [file, setFile] = useState(null);
  const [month, setMonth] = useState('');
  const [drag, setDrag] = useState(false);
  const [progress, setProgress] = useState('');
  const inputRef = useRef(null);

  const fail = useCallback((e) => { if (e?.unauthorized) return onSignOut(); setErr(e?.message || String(e)); }, [onSignOut]);

  const loadRuns = useCallback(async () => {
    try { const r = await api.lostRuns(); setRuns(r.runs || []); setCarriers(r.carriers || { ready: false, missing: [] }); }
    catch (e) { fail(e); }
  }, [fail]);
  const loadRun = useCallback(async () => {
    if (!runId) { setDetail(null); return; }
    try { setDetail(await api.lostRun(runId)); }
    catch (e) { if (e?.status === 404) { setDetail(null); setRunParam(''); } else fail(e); }
  }, [runId, fail, setRunParam]);

  useEffect(() => { loadRuns(); }, [loadRuns]);
  useEffect(() => { setDetail(null); loadRun(); }, [loadRun]);
  // Phase 2 moves the run row on every answer; the page follows it live.
  useLive(['lost_pkg_runs'], () => { loadRuns(); loadRun(); });

  function pick(f) {
    if (!f) return;
    setErr(''); setFile(f); setMonth(monthFromFileName(f.name));
  }

  async function runPhase1() {
    if (!file) return;
    setErr(''); setBusy('scan'); setProgress('Reading the workbook…');
    try {
      const scan = scanWorkbookBytes(new Uint8Array(await file.arrayBuffer()));
      if (!scan.orders.length) throw new Error('No orders with a tracking or order number were found in that workbook.');
      setProgress(`Found ${n(scan.orders.length)} orders across ${scan.sheetsScanned} tabs. Saving…`);
      const { id } = await api.lostCreateRun({
        monthLabel: month.trim() || monthFromFileName(file.name), sourceName: file.name,
        sheetsScanned: scan.sheetsScanned, rowsScanned: scan.rowsScanned, rowsSkipped: scan.rowsSkipped,
        counts: scan.counts, orderCount: scan.orders.length,
      });
      for (let i = 0; i < scan.orders.length; i += CHUNK) {
        await api.lostAddOrders(id, scan.orders.slice(i, i + CHUNK));
        setProgress(`Saving… ${n(Math.min(i + CHUNK, scan.orders.length))} / ${n(scan.orders.length)}`);
      }
      setFile(null); setMonth(''); if (inputRef.current) inputRef.current.value = '';
      setProgress('');
      setRunParam(String(id));
      loadRuns();
    } catch (e) {
      setProgress('');
      fail(e);
    } finally {
      setBusy('');
    }
  }

  async function phase2(action) {
    if (!detail) return;
    if (action === 'delete' && !window.confirm(`Delete the ${detail.run.month_label} run and everything checked on it?`)) return;
    if (action === 'recheck' && !window.confirm('Ask the couriers again about every Lost order on this run? The answers so far are replaced.')) return;
    setErr(''); setBusy(action);
    try {
      await api.lostPhase2(detail.run.id, action);
      if (action === 'delete') { setRunParam(''); setDetail(null); }
      loadRuns(); loadRun();
    } catch (e) { fail(e); } finally { setBusy(''); }
  }

  return (
    <div className="app lp-page">
      <TopBar title="Lost Package Tracker Tool" onHome={onHome} onSignOut={onSignOut} />
      <div className="card">
        <p className="muted sm lp-lede">
          Finds the <b>online orders that may be lost in transit</b>, a month at a time. <b>Phase 1</b> reads the month’s
          {' '}<i>Make | Order Updates Sheet</i> (.xlsx, every daily tab) and labels each order <b>Refunded › Cancelled › Delivered › Lost</b> —
          “Lost” means nothing in the workbook says it was delivered. <b>Phase 2</b> asks <b>FedEx</b> and <b>EasyPost</b> (UPS, USPS,
          DHL, Canada Post) about the Lost ones. Phase 2 runs on the server: you can close this page and come back.
        </p>
      </div>
      {err && <p className="error mt" role="alert">{err}</p>}

      <section className="card lp-p1">
        <h3 className="lp-h">Phase 1 — scan a month’s workbook</h3>
        <label className={`lp-drop${drag ? ' drag' : ''}${file ? ' has' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); pick(e.dataTransfer.files?.[0]); }}>
          <input ref={inputRef} type="file" accept=".xlsx" className="lp-file" aria-label="Order Updates workbook (.xlsx)"
            onChange={(e) => pick(e.target.files?.[0])} />
          <span className="lp-drop-main">{file ? file.name : 'Drop the Order Updates workbook here, or click to choose it'}</span>
          <span className="muted xs">{file ? `${Math.round(file.size / 1024).toLocaleString('en-US')} KB` : '.xlsx — the month’s “Make | Order Updates Sheet”'}</span>
        </label>
        {file && (
          <div className="lp-p1-row">
            <label className="lp-month">Month
              <input className="input" value={month} maxLength={80} onChange={(e) => setMonth(e.target.value)} placeholder="e.g. November 2026" />
            </label>
            <button type="button" className="btn primary" disabled={!!busy} onClick={runPhase1}>
              {busy === 'scan' ? 'Scanning…' : 'Run Phase 1 Scan'}
            </button>
          </div>
        )}
        {progress && <p className="muted sm" role="status">{progress}</p>}
      </section>

      {runId && !detail && !err && <div className="card muted sm">Loading the run…</div>}
      {detail && <RunView detail={detail} carriers={carriers} busy={busy} onAction={phase2} />}

      <section className="card">
        <h3 className="lp-h">Saved runs <span className="muted sm">{runs ? `${runs.length}` : ''}</span></h3>
        {!runs && <p className="muted sm">Loading…</p>}
        {runs && !runs.length && <p className="muted sm">Nothing scanned yet. Start with Phase 1 above.</p>}
        {runs && runs.length > 0 && (
          <div className="lp-scroll">
            <table className="table lp-runs">
              <thead><tr><th>Month</th><th>File</th><th className="num">Orders</th><th className="num">Lost (Phase 1)</th><th>Phase 2</th><th>Scanned</th></tr></thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} className={Number(r.id) === runId ? 'on' : ''} onClick={() => setRunParam(String(r.id))} tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter') setRunParam(String(r.id)); }}>
                    <td data-label="Month"><b>{r.month_label}</b></td>
                    <td data-label="File" className="lp-file-cell">{r.source_name}</td>
                    <td data-label="Orders" className="num">{n(r.order_count)}</td>
                    <td data-label="Lost" className="num">{n(r.counts?.Lost)}</td>
                    <td data-label="Phase 2">{P2_STATE[r.p2_status] || r.p2_status}
                      {r.p2_status !== 'none' && <span className="muted xs"> · {n(r.p2_checked)} / {n(r.p2_total)}</span>}
                      {r.p2_status === 'done' && <span className="muted xs"> · {n(r.p2_counts?.lost)} lost</span>}</td>
                    <td data-label="Scanned" className="muted xs">{r.created_by} · {when(r.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function RunView({ detail, carriers, busy, onAction }) {
  const { run, orders } = detail;
  const [cls, setCls] = useQueryParam('show', 'Lost');
  const [q, setQ] = useQueryParam('q', '');
  const lost = useMemo(() => orders.filter((o) => o.p1_class === 'Lost'), [orders]);
  const p2 = run.p2_counts || {};
  const pct = run.p2_total ? Math.round((Number(run.p2_checked) / Number(run.p2_total)) * 100) : 0;
  const incomplete = Number(run.uploaded) < Number(run.order_count);
  const checked = lost.some((o) => o.p2_class);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return orders.filter((o) => {
      if (cls.startsWith('p2:')) { if (o.p2_class !== cls.slice(3)) return false; } else if (cls !== 'all' && o.p1_class !== cls) return false;
      if (!needle) return true;
      return [o.tracking, o.tracking_fallback, o.order_number, o.store, o.product, o.sku].some((v) => String(v || '').toLowerCase().includes(needle));
    });
  }, [orders, cls, q]);

  const p1Download = () => saveBytes(`lost-packages-phase1-${fileSafe(run.month_label)}.xlsx`, phase1Book(run, orders));
  const p2Download = () => saveBytes(`lost-packages-phase2-${fileSafe(run.month_label)}.xlsx`, phase2Book(run, lost));

  return (
    <>
      <section className="card lp-run">
        <div className="lp-run-head">
          <div>
            <h3 className="lp-h">{run.month_label}</h3>
            <div className="muted xs">{run.source_name} · scanned by {run.created_by || '—'} · {when(run.created_at)}</div>
          </div>
          <div className="lp-run-actions">
            <button type="button" className="btn sm" onClick={p1Download} disabled={incomplete}>⬇ Phase 1 Excel</button>
            <button type="button" className="btn sm ghost danger" disabled={!!busy || run.p2_status === 'running'}
              onClick={() => onAction('delete')}>{busy === 'delete' ? 'Deleting…' : 'Delete run'}</button>
          </div>
        </div>
        {incomplete && (
          <p className="notice">Only {n(run.uploaded)} of {n(run.order_count)} orders were saved (the scan was interrupted). Scan the workbook again.</p>
        )}
        <div className="lp-tiles">
          {CLASSES.map((c) => (
            <button type="button" key={c} className={`lp-tile ${c.toLowerCase()}${cls === c ? ' on' : ''}`} onClick={() => setCls(c)}>
              <span className="lp-tile-n">{n(run.counts?.[c])}</span><span className="lp-tile-l">{c}</span>
            </button>
          ))}
        </div>
        <p className="muted xs">{n(run.sheets_scanned)} tab{Number(run.sheets_scanned) === 1 ? '' : 's'} · {n(run.rows_scanned)} rows read · {n(run.rows_skipped)} rows with no tracking or order number skipped · {n(run.order_count)} orders</p>
      </section>

      <section className="card lp-p2">
        <div className="lp-run-head">
          <h3 className="lp-h">Phase 2 — ask the couriers about the {n(lost.length)} Lost</h3>
          {checked && <button type="button" className="btn sm" onClick={p2Download}>⬇ Phase 2 Excel</button>}
        </div>
        {!carriers.ready && (
          <p className="notice">Phase 2 isn’t set up on this server yet — missing {carriers.missing.join(', ')}. Phase 1 works without it.</p>
        )}
        {run.p2_status !== 'none' && (
          <>
            <div className="lp-bar" role="progressbar" aria-valuemin={0} aria-valuemax={Number(run.p2_total)} aria-valuenow={Number(run.p2_checked)}
              aria-label="Phase 2 progress"><span style={{ width: `${pct}%` }} /></div>
            <p className="sm lp-p2-line">
              <b>{P2_STATE[run.p2_status]}</b> · {n(run.p2_checked)} of {n(run.p2_total)} checked ({pct}%)
              {run.p2_last && run.p2_status === 'running' && <span className="muted"> · last: {run.p2_last}</span>}
              {run.p2_by && <span className="muted xs"> · started by {run.p2_by}</span>}
            </p>
            <div className="lp-tiles p2">
              {['lost', 'delivered', 'cancelled', 'refunded', 'failed'].map((c) => (
                <button type="button" key={c} className={`lp-tile ${c}${cls === `p2:${c}` ? ' on' : ''}`} onClick={() => setCls(`p2:${c}`)}>
                  <span className="lp-tile-n">{n(p2[c])}</span><span className="lp-tile-l">{P2_LABEL[c]}</span>
                </button>
              ))}
            </div>
          </>
        )}
        <div className="lp-p2-actions">
          {run.p2_status === 'none' && (
            <button type="button" className="btn primary" disabled={!carriers.ready || !lost.length || incomplete || !!busy}
              onClick={() => onAction('start')}>{busy === 'start' ? 'Starting…' : 'Run Phase 2 on these results →'}</button>
          )}
          {run.p2_status === 'running' && <button type="button" className="btn" disabled={!!busy} onClick={() => onAction('pause')}>Pause</button>}
          {run.p2_status === 'paused' && <button type="button" className="btn primary" disabled={!!busy || !carriers.ready} onClick={() => onAction('resume')}>Resume</button>}
          {['running', 'paused'].includes(run.p2_status) && <button type="button" className="btn ghost" disabled={!!busy} onClick={() => onAction('stop')}>Stop</button>}
          {run.p2_status === 'stopped' && <button type="button" className="btn primary" disabled={!!busy || !carriers.ready} onClick={() => onAction('resume')}>Resume</button>}
          {['stopped', 'done'].includes(run.p2_status) && (
            <button type="button" className="btn ghost" disabled={!!busy || !carriers.ready} onClick={() => onAction('recheck')}>Check them all again</button>
          )}
        </div>
        <p className="muted xs">
          FedEx numbers go to FedEx first, UPS / USPS / DHL / Canada Post to EasyPost first, each with the other as a fallback.
          Only an actual delivery counts as delivered; a number neither can read is <b>Failed to scan</b>, never quietly Lost.
        </p>
      </section>

      <section className="card">
        <div className="lp-filter">
          <select className="input" value={cls} onChange={(e) => setCls(e.target.value)} aria-label="Which orders">
            <option value="all">All orders ({n(orders.length)})</option>
            {CLASSES.map((c) => <option key={c} value={c}>Phase 1: {c} ({n(run.counts?.[c])})</option>)}
            {checked && ['lost', 'delivered', 'cancelled', 'refunded', 'failed'].map((c) => (
              <option key={c} value={`p2:${c}`}>Phase 2: {P2_LABEL[c]} ({n(p2[c])})</option>
            ))}
          </select>
          <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Tracking, order #, store, shoe, SKU" aria-label="Search the orders" />
        </div>
        <p className="muted xs">{n(shown.length)} order{shown.length === 1 ? '' : 's'}{shown.length > SHOW ? ` — first ${SHOW} shown; the Excel has them all` : ''}</p>
        {shown.length > 0 && (
          <div className="lp-scroll">
            <table className="table lp-orders">
              <thead><tr><th>Tracking</th><th>Order #</th><th>Store</th><th>Shoe</th><th>Ordered</th><th>As written</th><th>Phase 1</th><th>Phase 2</th></tr></thead>
              <tbody>
                {shown.slice(0, SHOW).map((o) => {
                  const trk = excelIdText(o.tracking || o.tracking_fallback);
                  return (
                    <tr key={o.id}>
                      <td data-label="Tracking" className="lp-trk">{trk ? <TrackingLink number={trk} carrier={o.courier} /> : <span className="muted">—</span>}
                        {o.courier && <div className="muted xs">{o.courier}</div>}</td>
                      <td data-label="Order #">{excelIdText(o.order_number) || <span className="muted">—</span>}</td>
                      <td data-label="Store">{o.store}</td>
                      <td data-label="Shoe">{o.product}{o.sku && <div className="muted xs">{o.sku}{o.qty ? ` · ×${o.qty}` : ''}</div>}</td>
                      <td data-label="Ordered" className="muted xs">{o.order_date}{o.eta && <div>ETA {o.eta}</div>}</td>
                      <td data-label="As written" className="xs">{o.status_written}<div className="muted">{o.evidence || `first seen: ${o.first_sheet}`}</div></td>
                      <td data-label="Phase 1"><span className={`lp-chip ${o.p1_class.toLowerCase()}`}>{o.p1_class}</span></td>
                      <td data-label="Phase 2" title={[o.p2_raw, o.p2_error].filter(Boolean).join(' — ')}>
                        {o.p2_class
                          ? <span className={`lp-chip ${o.p2_class}`}>{P2_LABEL[o.p2_class]}</span>
                          : o.p2_state === 'queued' || o.p2_state === 'checking'
                            ? <span className="muted xs">{o.p2_state === 'checking' ? 'checking…' : 'waiting'}</span>
                            : <span className="muted xs">—</span>}
                        {o.p2_raw && <div className="muted xs lp-raw">{o.p2_raw}</div>}
                        {o.p2_error && <div className="xs lp-err">{o.p2_error}</div>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
