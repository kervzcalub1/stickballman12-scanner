// My Scans (/my-scans, docs/context/inventory.md "Stock Check" → My Scans).
// A person's SCAN HISTORY (the user's call, 2026-11-04): every Stock Check scan they made,
// newest first, and second the counts they ran — for a day / week / month (EST),
// with CSV and PDF reports of either. Everyone sees their own; an admin can pick anyone,
// or everyone. Read-only: the rows are recorded by the server as the scans happen.
import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { TopBar, DateRangeBar } from '../components/common.jsx';
import { useLive } from '../hooks.js';
import { useQueryDateRange, useQueryParam } from '../lib/urlstate.js';
import { rangeOf, estDate, estTime } from '../lib/format.js';
import { scanRows, countRows, countTotals } from '../lib/scanReport.js';

export function MyScans({ user, onHome, onSignOut, onStockCheck }) {
  const admin = user?.role === 'admin' || user?.role === 'superadmin';
  const [dr, setDr] = useQueryDateRange('day');
  const [tab, setTab] = useQueryParam('tab', 'scans');
  // An admin opens on EVERYONE's history (the user's call, 2026-11-04); anyone else only
  // ever gets their own — the server enforces that, not this default.
  const [who, setWho] = useQueryParam('user', admin ? 'all' : '');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [from, to] = rangeOf(dr.mode, dr.anchor);

  async function load() {
    try { setData(await api.myScans({ from, to, user: who })); setError(''); }
    catch (e) { if (e.unauthorized) return onSignOut(); setError(e.message); }
  }
  useEffect(() => { setData(null); load(); }, [from, to, who]); // eslint-disable-line react-hooks/exhaustive-deps
  // LIVE (live-updates.md): a scan made on another phone shows here without a refresh.
  useLive(['stock_check_scans', 'stock_counts'], load, { mount: false, paused: data == null });

  const scans = data?.scans || [];
  const counts = data?.counts || [];
  const cr = countRows(counts);
  const sr = scanRows(scans);
  const t = countTotals(cr);
  const whoLabel = data?.who === 'all' ? 'Everyone' : (data?.users || []).find((u) => u.username === data?.who)?.user_name || data?.who || user?.name || '';

  async function download(fmt) {
    setBusy(fmt); setError('');
    try {
      const rep = await import('../lib/scanReport.js');
      const now = new Date();
      const name = `${tab === 'counts' ? 'stock_counts' : 'stock_scans'}_${from === to ? from : `${from}_to_${to}`}`;
      let blob;
      if (fmt === 'csv') blob = new Blob([tab === 'counts' ? rep.countsCsv(counts) : rep.scansCsv(scans)], { type: 'text/csv;charset=utf-8' });
      else {
        const opts = { from, to, who: whoLabel, generatedAt: `Generated ${estDate(now)} ${estTime(now)} EST` };
        blob = (await (tab === 'counts' ? rep.countsPdf(counts, opts) : rep.scansPdf(scans, opts))).output('blob');
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `${name}.${fmt}`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) {
      if (e.unauthorized) return onSignOut();
      setError(e.message || 'Could not build the report.');
    } finally { setBusy(''); }
  }

  return (
    <div className="app">
      <TopBar title={admin ? 'Scan History' : 'My Scans'} onHome={onHome} onSignOut={onSignOut}
        right={onStockCheck ? <button type="button" className="btn ghost sm" onClick={onStockCheck}>Stock Check</button> : null} />
      <div className="wrap-narrow myscans">
        <DateRangeBar mode={dr.mode} anchor={dr.anchor} onChange={(mode, anchor) => setDr({ mode, anchor })} />
        <div className="myscans-bar">
          <div className="seg" role="tablist" aria-label="Show">
            <button type="button" role="tab" aria-selected={tab === 'scans'} className={`seg-btn ${tab === 'scans' ? 'on' : ''}`} onClick={() => setTab('scans')}>Scan history ({scans.length})</button>
            <button type="button" role="tab" aria-selected={tab === 'counts'} className={`seg-btn ${tab === 'counts' ? 'on' : ''}`} onClick={() => setTab('counts')}>Counts ({counts.length})</button>
          </div>
          {admin && (
            <label className="myscans-who"><span className="muted xs">Whose</span>
              <select value={who} onChange={(e) => setWho(e.target.value)} aria-label="Whose scans">
                <option value="all">Everyone</option>
                <option value="">Mine</option>
                {(data?.users || []).filter((u) => u.username !== (user?.username || '')).map((u) => (
                  <option key={u.username} value={u.username}>{u.user_name || u.username}</option>
                ))}
              </select>
            </label>
          )}
          <div className="myscans-dl">
            <button type="button" className="btn ghost sm" disabled={!!busy || !data} onClick={() => download('csv')}>{busy === 'csv' ? 'Building…' : '⬇ CSV'}</button>
            <button type="button" className="btn ghost sm" disabled={!!busy || !data} onClick={() => download('pdf')}>{busy === 'pdf' ? 'Building…' : '⬇ PDF'}</button>
          </div>
        </div>
        {error && <div className="error mt">{error}</div>}

        {data == null ? <p className="muted">Loading…</p> : tab === 'counts' ? (
          cr.length === 0 ? (
            <div className="card empty-state">No counts in this period. Start one on <b>Stock Check</b>: scan a box, then <b>Count this size</b>.</div>
          ) : (
            <>
              <p className="muted sm">{t.finished} finished · <b>{t.matched}</b> matched · <b>{t.short}</b> short · <b>{t.extra}</b> extra{t.typed ? ` · ${t.typed} pairs typed by hand` : ''}</p>
              <ul className="myscans-list" aria-label="Counts">
                {cr.map((r) => (
                  <li key={r.id} className={`card myscans-row ${r.tone || 'open'}`}>
                    <div className="myscans-main">
                      <div className="myscans-shoe">{r.name || r.sku}</div>
                      <div className="muted sm">{r.sku} · size <b>{r.size}</b> · {r.date} {r.time} EST{data.who === 'all' ? ` · ${r.by}` : ''} · {r.mode}</div>
                      <div className="myscans-result">{r.result}</div>
                      <div className="muted xs">{r.byVin} by VIN · {r.byBarcode} by box barcode{r.typed ? ` · ${r.typed} typed by hand` : ''}{r.flagged ? ` · ${r.flagged} record says gone` : ''}{r.refused ? ` · ${r.refused} not counted` : ''}</div>
                    </div>
                    <div className="myscans-num" aria-label={`Counted ${r.counted}`}>
                      <b>{r.counted || 0}</b><span className="muted xs">of {r.shopifyEnd || r.shopifyStart || '?'}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )
        ) : (
          sr.length === 0 ? (
            <div className="card empty-state">Nothing scanned in this period. Scans made on <b>Stock Check</b> show up here.</div>
          ) : (
            <ul className="myscans-list" aria-label="Scan history">
              {sr.map((r, i) => (
                <li key={`${scans[i].id}`} className="card myscans-row">
                  <div className="myscans-main">
                    <div className="myscans-shoe">{r.name || r.sku || r.code}</div>
                    <div className="muted sm"><span className="mono">{r.code}</span> · {r.kind}{r.via ? ` (${r.via.toLowerCase()})` : ''}{r.size ? ` · size ${r.size}` : ''} · {r.time} EST{data.who === 'all' ? ` · ${r.by}` : ''}</div>
                    {(r.answer || r.count) && (
                      <div className="muted xs">{r.answer}{r.count ? `${r.answer ? ' · ' : ''}count ${r.count}: ${r.counted === 'Yes' ? 'counted' : r.counted === 'Undone' ? 'undone' : 'not counted'}` : ''}{r.note ? ` — ${r.note}` : ''}</div>
                    )}
                  </div>
                  {r.shopify !== '' && <div className="myscans-num"><b>{r.shopify}</b><span className="muted xs">on Shopify</span></div>}
                </li>
              ))}
            </ul>
          )
        )}
      </div>
    </div>
  );
}
