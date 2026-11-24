// Costs → "From emails". Reads what each pair was PAID out of the stores' own emails: the
// parcel's tracking number finds the shipping email, that names the order, and the order's
// confirmation has the price after the store's discount (before any gift card). The run
// happens on the server and waits here as a preview; nothing is written until Apply, and
// Apply only fills pairs that still have no cost (docs/context/costs.md → "Fill from emails").
import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { downloadCSV } from '../lib/csv.js';
import { PH_DATETIME } from '../lib/format.js';

const money = (n) => (n == null ? '—' : `$${Number(n).toFixed(2)}`);
const when = (ts) => (ts ? `${PH_DATETIME.format(new Date(ts))} EST` : '');
const NO_SUPPLIER = '__none__';

export function CostsFromEmails({ supplier = '', from = '', to = '', onSignOut, onApplied }) {
  const [state, setState] = useState(null);     // { configured, run, needsSetup }
  const [rows, setRows] = useState(null);       // the preview, loaded once the run is done
  const [show, setShow] = useState('priced');   // priced | not
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const sup = supplier && supplier !== NO_SUPPLIER ? supplier : '';
  const run = state?.run || null;
  const running = run?.status === 'running' && !run.stalled;

  async function load() {
    try { setState(await api.costEmails()); }
    catch (e) { if (e.unauthorized) return onSignOut?.(); setError(e.message); }
  }
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Progress: look again every 3 s while the server is reading the mailbox.
  useEffect(() => {
    if (!running) return undefined;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [running]); // eslint-disable-line react-hooks/exhaustive-deps
  // The preview rows are big; fetch them once, when there is a finished run to show.
  useEffect(() => {
    setRows(null);
    if (!run || !['done', 'applied'].includes(run.status)) return;
    let off = false;
    api.costEmails(run.id, true).then((r) => { if (!off) setRows(r.run?.rows || []); })
      .catch((e) => { if (e.unauthorized) return onSignOut?.(); if (!off) setError(e.message); });
    return () => { off = true; };
  }, [run?.id, run?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  async function act(body, after) {
    setBusy(true); setError(''); setNotice('');
    try { const r = await api.costEmailsAct(body); await load(); after?.(r); }
    catch (e) { if (e.unauthorized) return onSignOut?.(); setError(e.message); await load(); }
    finally { setBusy(false); }
  }

  const s = run?.summary || null;
  const priced = useMemo(() => (rows || []).filter((r) => r.each != null), [rows]);
  const not = useMemo(() => (rows || []).filter((r) => r.each == null), [rows]);
  const list = show === 'priced' ? priced : not;
  const scope = `${sup || 'Every supplier'}${from || to ? ` · received ${from || '…'} to ${to || '…'}` : ' · any date'}`;
  const runScope = run ? `${run.supplier || 'Every supplier'}${run.date_from || run.date_to ? ` · ${run.date_from || '…'} to ${run.date_to || '…'}` : ' · any date'}` : '';

  function exportCsv() {
    const head = ['VIN', 'SKU', 'Size', 'Shoe', 'Batch', 'Supplier', 'Tracking', 'Store (email)', 'Order #', 'Name in the email', 'Listed', 'Paid', 'How', 'Note', 'Not priced because'];
    const body = (rows || []).map((r) => [r.vin, r.sku, r.size, r.name, r.batch, r.supplier, r.trk, r.store, r.order, r.email_name, r.full, r.each, r.how, r.note, r.reason]);
    const esc = (v) => { const t = String(v ?? ''); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
    downloadCSV(`costs-from-emails-run-${run.id}.csv`, [head, ...body].map((r) => r.map(esc).join(',')).join('\n'));
  }

  if (!state) return <p className="muted">{error || 'Loading…'}</p>;
  return (
    <div className="cfe">
      <p className="muted sm">
        Reads the price <b>paid</b> for each pair from the store’s own emails: the parcel’s tracking number
        finds the shipping email, that names the order, and the order’s confirmation has the price after the
        store’s discount (gift cards are not taken off). Parcels on a purchase order are left out.
        Nothing is saved until you press Apply, and only pairs with no cost are filled.
      </p>
      {state.needsSetup && <div className="error sm">This server has not been set up for it yet (db:setup).</div>}
      {!state.configured && <div className="error sm">The mailbox search is not set up on this server, so a run cannot start here.</div>}

      <div className="cfe-start">
        <div><span className="muted xs">This run will read</span><br /><b>{scope}</b>
          <span className="muted sm"> — change the supplier and dates on the “No cost on file” tab.</span></div>
        <button type="button" className="btn primary" disabled={busy || running || !state.configured}
          onClick={() => act({ action: 'start', supplier: sup, from, to })}>
          {running ? 'Reading the emails…' : 'Read the emails'}
        </button>
      </div>
      {error && <div className="error sm mt" role="alert">{error}</div>}
      {notice && <div className="notice mt" role="status">{notice}</div>}

      {run && (
        <div className="cfe-run">
          <h3 className="rows-title">Run #{run.id} <span className="muted">· {runScope} · started {when(run.created_at)}{run.created_by ? ` by ${run.created_by}` : ''}</span></h3>
          {run.status === 'running' && (
            <>
              <div className="progress-bar"><span style={{ width: `${run.parcels_total ? Math.round((run.parcels_done / run.parcels_total) * 100) : 0}%` }} /></div>
              <p className="sm" role="status">
                {run.stalled ? 'Stopped part-way (the server restarted). ' : 'Reading the mailbox: '}
                <b>{run.parcels_done}</b> of <b>{run.parcels_total || '…'}</b> parcels. About 5 seconds a parcel — you can leave this page.
              </p>
              <div className="cfe-btns">
                {run.stalled && <button type="button" className="btn primary sm" disabled={busy} onClick={() => act({ action: 'continue', id: run.id })}>Continue</button>}
                <button type="button" className="btn ghost sm" disabled={busy} onClick={() => act({ action: 'stop', id: run.id })}>Stop</button>
              </div>
            </>
          )}
          {run.status === 'failed' && <div className="error sm">The run failed: {run.error || 'unknown error'}. Start it again — what it already read is remembered.</div>}
          {run.status === 'stopped' && <p className="muted sm">Stopped at {run.parcels_done} of {run.parcels_total} parcels. Nothing was saved. Start it again to carry on — what it already read is remembered.</p>}

          {s && ['done', 'applied'].includes(run.status) && (
            <>
              <div className="cfe-stats">
                <div><b>{s.priced.toLocaleString('en-US')}</b><span className="muted sm"> of {s.pairs.toLocaleString('en-US')} pairs priced</span></div>
                <div><b>{s.parcels.toLocaleString('en-US')}</b><span className="muted sm"> parcels read</span></div>
                {run.status === 'applied' && <div><b>{run.applied_pairs}</b><span className="muted sm"> costs saved {when(run.applied_at)}{run.applied_by ? ` by ${run.applied_by}` : ''}</span></div>}
              </div>
              {s.capped && <p className="batch-po-hint sm">Only the first 1,500 parcels were read. Apply these, then run it again for the rest.</p>}
              <table className="cfe-table cfe-stores">
                <thead><tr><th>Store (from the email)</th><th>Pairs</th><th>Priced</th></tr></thead>
                <tbody>{Object.entries(s.stores || {}).sort((a, b) => b[1].pairs - a[1].pairs).map(([k, v]) => (
                  <tr key={k}><td>{k}</td><td>{v.pairs}</td><td>{v.priced}</td></tr>))}</tbody>
              </table>
              {Object.keys(s.reasons || {}).length > 0 && (
                <ul className="cfe-reasons sm">
                  {Object.entries(s.reasons).sort((a, b) => b[1] - a[1]).map(([k, n]) => <li key={k}><b>{n}</b> not priced — {k}</li>)}
                </ul>
              )}
              <div className="cfe-btns">
                {run.status === 'done' && s.priced > 0 && (
                  <button type="button" className="btn primary" disabled={busy}
                    onClick={() => act({ action: 'apply', id: run.id }, (r) => { setNotice(`Cost saved on ${r.filled} pair${r.filled === 1 ? '' : 's'}.`); onApplied?.(); })}>
                    {busy ? 'Saving…' : `Apply — save the cost on ${s.priced.toLocaleString('en-US')} pairs`}
                  </button>
                )}
                {rows && <button type="button" className="btn ghost sm" onClick={exportCsv}>Download the whole preview (CSV)</button>}
              </div>

              <div className="seg cfe-seg" role="tablist">
                <button type="button" role="tab" aria-selected={show === 'priced'} className={`seg-btn${show === 'priced' ? ' on' : ''}`} onClick={() => setShow('priced')}>Priced ({priced.length})</button>
                <button type="button" role="tab" aria-selected={show === 'not'} className={`seg-btn${show === 'not' ? ' on' : ''}`} onClick={() => setShow('not')}>Not priced ({not.length})</button>
              </div>
              {rows == null ? <p className="muted sm">Loading the pairs…</p> : !list.length ? <p className="muted sm">None.</p> : (
                <div className="cfe-scroll">
                  <table className="cfe-table">
                    <thead><tr><th>Pair</th><th>Size</th><th>Batch</th><th>Store · order</th>{show === 'priced' ? <><th>Listed</th><th>Paid</th><th>From</th></> : <th>Why not</th>}</tr></thead>
                    <tbody>
                      {list.slice(0, 300).map((r) => (
                        <tr key={r.id}>
                          <td><b>{r.sku}</b> <span className="muted sm">{r.name}</span>{r.email_name ? <div className="muted xs">email: {r.email_name}</div> : null}</td>
                          <td>{r.size}</td>
                          <td>{r.batch}<div className="muted xs">{r.trk}</div></td>
                          <td>{r.store || '—'}{r.order ? <div className="muted xs">#{r.order}</div> : null}</td>
                          {show === 'priced'
                            ? <><td className="muted">{r.full != null && r.full > r.each ? money(r.full) : ''}</td><td><b>{money(r.each)}</b></td><td className="muted sm">{r.how === 'order' ? 'the order' : 'the parcel’s email'}{r.note ? ` · ${r.note}` : ''}</td></>
                            : <td className="sm">{r.reason}</td>}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {list.length > 300 && <p className="muted sm">Showing the first 300 of {list.length}. The CSV has all of them.</p>}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
