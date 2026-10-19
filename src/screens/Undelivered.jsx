// Undelivered — every tracking number we are still waiting on, PO labels and online
// orders in one list, exported as the list to chase (docs/context/undelivered.md).
//
// Why: packages have gone missing, and finding them meant opening every PO and every
// online order to read its tracking. This is that read in one place: not delivered per
// the courier feed AND not received by the warehouse.
//
// The trap the owner named up front: a parcel added two days ago is "undelivered" too,
// and is not missing. So every row has a tick box (all ticked to start), the list sorts
// newest → oldest (or the other way), and "Skip the newest" drops anything added inside
// the last N days in one go. Only the ticked rows go into the CSV / PDF and the bulk
// "Open on UPS" links.
//
// Every number links to the COURIER's own page — 17TRACK is a relay and can lag behind
// what UPS itself says, so the courier site is where a "missing" call gets confirmed.
// When it shows Delivered and 17TRACK still doesn't, "Mark delivered" says so by hand
// (name + day recorded, Undo on the "Marked delivered" tab).
import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { TopBar, FormModal } from '../components/common.jsx';
import { TrackingLink } from '../components/TrackingLink.jsx';
import { useLive } from '../hooks.js';
import { useQueryParam } from '../lib/urlstate.js';
import { estDate, estTime, estToday } from '../lib/format.js';
import { orderCode } from '../lib/onlineOrders.js';
import { courierBulkLinks } from '../lib/carriers.js';
import { feedStatus, reportRows, rowKey, sortRows, undeliveredCsv, undeliveredPdf, ageDays, SOURCES, codeOf, courierOf } from '../lib/undelivered.js';

const PERIODS = [['30', 'Last 30 days'], ['90', 'Last 90 days'], ['180', 'Last 180 days'], ['365', 'Last year'], ['all', 'All time']];
const SKIP = [['0', 'Show everything'], ['3', 'Skip added in the last 3 days'], ['7', 'Skip added in the last 7 days'],
  ['14', 'Skip added in the last 14 days'], ['30', 'Skip added in the last 30 days']];
const ago = (d) => (d == null ? '' : d === 0 ? 'today' : d === 1 ? '1 day ago' : `${d} days ago`);

export function Undelivered({ onHome, onSignOut }) {
  const [days, setDays] = useQueryParam('days', '90');
  const [source, setSource] = useQueryParam('src', 'all');
  const [sort, setSort] = useQueryParam('sort', 'new');
  const [skip, setSkip] = useQueryParam('skip', '0');
  const [q, setQ] = useQueryParam('q', '');
  const [view, setView] = useQueryParam('view', 'open');
  const [rows, setRows] = useState(null);
  const [marked, setMarked] = useState([]);
  const [marking, setMarking] = useState(null);   // the row being marked delivered
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [unticked, setUnticked] = useState(() => new Set());
  const [busy, setBusy] = useState('');

  async function load() {
    try {
      const r = await api.undelivered(days);
      setRows(r.rows || []); setMarked(r.marked || []); setError('');
    } catch (e) { if (e.unauthorized) return onSignOut(); setError(e.message); }
  }
  useEffect(() => { load(); }, [days]); // eslint-disable-line react-hooks/exhaustive-deps
  useLive(['po_boxes', 'online_orders', 'online_order_lines', 'shipment_tracking', 'batch_boxes'], load, { mount: false });

  const now = Date.now();
  const shown = useMemo(() => {
    const term = q.trim().toUpperCase();
    const termTrk = term.replace(/[^A-Z0-9]/g, '');
    const minAge = Number(skip) || 0;
    return sortRows((rows || []).filter((r) => {
      if (source !== 'all' && r.source !== source) return false;
      if (minAge && (ageDays(r, now) ?? 0) < minAge) return false;
      if (!term) return true;
      return String(r.tracking_number || '').toUpperCase().replace(/[^A-Z0-9]/g, '').includes(termTrk || '\u0000')
        || [codeOf(r), r.party, r.order_number, courierOf(r)].some((v) => String(v || '').toUpperCase().includes(term));
    }), sort);
  }, [rows, source, sort, skip, q]); // eslint-disable-line react-hooks/exhaustive-deps

  const picked = shown.filter((r) => !unticked.has(rowKey(r)));
  const allOn = shown.length > 0 && picked.length === shown.length;
  const toggle = (k) => setUnticked((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const setAll = (on) => setUnticked((s) => {
    const n = new Set(s);
    for (const r of shown) { if (on) n.delete(rowKey(r)); else n.add(rowKey(r)); }
    return n;
  });
  const bulk = useMemo(() => courierBulkLinks(picked), [picked]);
  const pairs = picked.reduce((t, r) => t + (Number(r.pairs) || 0), 0);

  async function undo(m) {
    if (!window.confirm(`Undo "delivered" on ${m.tracking_number}? It goes back to what 17TRACK said.`)) return;
    try {
      await api.unmarkDelivered(m.tracking_number);
      setNote(`${m.tracking_number} is back on the list.`); load();
    } catch (e) { if (e.unauthorized) return onSignOut(); setError(e.message); }
  }

  async function download(fmt) {
    if (!picked.length) return;
    setBusy(fmt);
    try {
      const at = Date.now();
      const rs = reportRows(picked, at);
      const scope = [PERIODS.find(([k]) => k === days)?.[1], source === 'all' ? 'PO labels + online orders' : SOURCES[source],
        Number(skip) ? `added ${skip}+ days ago` : '', sort === 'old' ? 'oldest first' : 'newest first'].filter(Boolean).join(', ');
      const blob = fmt === 'csv'
        ? new Blob([undeliveredCsv(rs)], { type: 'text/csv;charset=utf-8' })
        : (await undeliveredPdf(rs, { scope, generatedAt: `Generated ${estDate(at)} ${estTime(at)} EST` })).output('blob');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `undelivered-tracking-${estDate(at)}.${fmt}`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { setError(e.message || 'Could not build the file.'); }
    setBusy('');
  }

  return (
    <div className="app und-page">
      <TopBar title="Undelivered Tracking" onHome={onHome} onSignOut={onSignOut} />
      <div className="card">
        <p className="muted sm und-lede">
          Every tracking number on a <b>purchase order</b> or an <b>online order</b> that the courier has not delivered
          <b> and</b> the warehouse has not received. A parcel added a few days ago is usually just on its way — untick it,
          or skip the newest in one go, then export the rest as the list to chase. Tap a number to open it on the
          courier’s own site (17TRACK can lag behind it).
        </p>
        <div className="und-filters">
          <select className="input" value={days} onChange={(e) => { setDays(e.target.value); setUnticked(new Set()); }} aria-label="Added in">
            {PERIODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <select className="input" value={skip} onChange={(e) => setSkip(e.target.value)} aria-label="Skip the newest">
            {SKIP.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <div className="seg sm" role="tablist" aria-label="Sort">
            {[['new', 'Newest first'], ['old', 'Oldest first']].map(([k, l]) => (
              <button key={k} type="button" role="tab" aria-selected={sort === k} className={`seg-btn ${sort === k ? 'on' : ''}`} onClick={() => setSort(k)}>{l}</button>
            ))}
          </div>
          <div className="seg sm" role="tablist" aria-label="Source">
            {[['all', 'All'], ['po', 'PO labels'], ['online', 'Online orders']].map(([k, l]) => (
              <button key={k} type="button" role="tab" aria-selected={source === k} className={`seg-btn ${source === k ? 'on' : ''}`} onClick={() => setSource(k)}>{l}</button>
            ))}
          </div>
 <div className="seg sm" role="tablist" aria-label="View">
            {[['open', 'Not delivered'], ['marked', `Marked delivered${marked.length ? ` (${marked.length})` : ''}`]].map(([k, l]) => (
              <button key={k} type="button" role="tab" aria-selected={view === k} className={`seg-btn ${view === k ? 'on' : ''}`} onClick={() => setView(k)}>{l}</button>
            ))}
          </div>
          <input className="input und-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tracking #, PO / order, supplier or store" aria-label="Search" />
        </div>
        {error && <div className="error mt">{error}</div>}
        {note && <div className="ok mt" role="status">{note}</div>}
      </div>

      {view === 'marked' ? (
        <div className="card">
          {!marked.length ? <p className="muted">Nothing marked delivered by hand in this period.</p> : (
            <table className="und-table">
              <thead>
                <tr><th>Tracking #</th><th>Order</th><th>Supplier / store</th><th>Delivered on</th><th>Marked by</th><th /></tr>
              </thead>
              <tbody>
                {marked.map((m) => (
                  <tr key={m.tracking_number}>
                    <td data-label="Tracking #"><code><TrackingLink number={m.tracking_number} carrier={m.carrier_key || m.carrier} /></code></td>
                    <td data-label="Order">{[m.po_codes, ...(m.online_ids || []).map(orderCode)].filter(Boolean).join(', ') || '—'}</td>
                    <td data-label="Supplier / store">{[m.suppliers, m.stores].filter(Boolean).join(', ') || '—'}</td>
                    <td data-label="Delivered on">{m.delivered_on || '—'}</td>
                    <td data-label="Marked by">{m.manual_by || '—'}<div className="muted xs">{estDate(m.manual_at)} {estTime(m.manual_at)} EST</div>{m.manual_note && <div className="muted xs">{m.manual_note}</div>}</td>
                    <td data-label=""><button type="button" className="btn sm ghost" onClick={() => undo(m)}>Undo</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : (

      <div className="card">
        {!rows ? <p className="muted">Loading…</p> : !shown.length ? (
          <p className="muted">{rows.length ? 'Nothing matches these filters.' : 'Nothing undelivered — every tracking number in this period has landed.'}</p>
        ) : (
          <>
            <div className="und-bar">
              <span><b>{picked.length}</b> of {shown.length} ticked{pairs ? <> · {pairs} pairs</> : null}</span>
              <span className="und-bar-actions">
                <button type="button" className="btn sm" disabled={!picked.length || !!busy} onClick={() => download('pdf')}>{busy === 'pdf' ? 'Building…' : '⬇ PDF'}</button>
                <button type="button" className="btn sm" disabled={!picked.length || !!busy} onClick={() => download('csv')}>{busy === 'csv' ? 'Building…' : '⬇ CSV'}</button>
              </span>
            </div>
            {bulk.length > 0 && (
              <div className="und-bulk" aria-label="Open the ticked numbers on the courier's site">
                <span className="muted xs">Open ticked on the courier’s site:</span>
                {bulk.map((b) => (
                  <a key={b.url} className="btn sm ghost" href={b.url} target="_blank" rel="noopener noreferrer"
                    title={b.numbers.join('\n')}>{b.name} ({b.numbers.length}) ↗</a>
                ))}
              </div>
            )}
            <table className="und-table">
              <thead>
                <tr>
                  <th className="und-tick"><input type="checkbox" checked={allOn} onChange={(e) => setAll(e.target.checked)} aria-label="Tick all shown" /></th>
                  <th>Added</th><th>Order</th><th>Supplier / store</th><th>Tracking #</th><th>Courier status</th><th className="num">Pairs</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const k = rowKey(r);
                  const on = !unticked.has(k);
                  const fs = feedStatus(r);
                  const age = ageDays(r, now);
                  return (
                    <tr key={k} className={on ? '' : 'off'}>
                      <td className="und-tick" data-label="Include"><input type="checkbox" checked={on} onChange={() => toggle(k)} aria-label={`Include ${r.tracking_number}`} /></td>
                      <td data-label="Added">{r.added_at ? estDate(r.added_at) : '—'}<div className={`xs ${age != null && age < 7 ? 'und-new' : 'muted'}`}>{ago(age)}</div></td>
                      <td data-label="Order">
                        <b>{codeOf(r)}</b>
                        <div className="muted xs">
                          {SOURCES[r.source]}
                          {r.source === 'po' ? (r.box_kind === 'replacement' ? ' · replacement' : r.box_number != null ? ` · label ${r.box_number}` : '') : r.order_number ? ` · #${r.order_number}` : ''}
                        </div>
                      </td>
                      <td data-label="Supplier / store">{r.party || '—'}{r.ordered_on ? <div className="muted xs">ordered {r.ordered_on}</div> : null}</td>
                      <td data-label="Tracking #"><code><TrackingLink number={r.tracking_number} carrier={r.carrier_key || r.carrier} /></code><div className="muted xs">{courierOf(r) || 'courier unknown'}</div></td>
                      <td data-label="Courier status">
                        <span className={`inbound-chip sm ${fs.tone}`}>{fs.label}</span>
                        {r.last_checkpoint && <div className="muted xs">{r.last_checkpoint}</div>}
                        {r.last_move_at && r.tracking_status && <div className="muted xs">last scan {estDate(r.last_move_at)}</div>}
                        <button type="button" className="btn xs ghost und-mark" onClick={() => { setNote(''); setMarking(r); }}>✓ Mark delivered</button>
                      </td>
                      <td className="num" data-label="Pairs">{Number(r.pairs) || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )}
      </div>
      )}

      {marking && (
        <FormModal
          title="Mark delivered"
          message={`${marking.tracking_number} · ${codeOf(marking)}${marking.party ? ` · ${marking.party}` : ''}. Only do this when the courier's own page says Delivered. It leaves this list and reads Delivered on the PO and Inbound; your name is recorded. Undo is on the "Marked delivered" tab.`}
          submitLabel="Mark delivered"
          fields={[
            { name: 'on', label: 'Delivered on (per the courier)', type: 'date', value: estToday(), max: estToday(), required: true },
            { name: 'note', label: 'Note', placeholder: 'e.g. UPS shows delivered, photo at the dock', maxLength: 300 },
          ]}
          onClose={() => setMarking(null)}
          onSubmit={async (v) => {
            await api.markDelivered(marking.tracking_number, v.on, v.note);
            setNote(`${marking.tracking_number} marked delivered.`);
            setMarking(null); load();
          }}
        />
      )}
    </div>
  );
}
