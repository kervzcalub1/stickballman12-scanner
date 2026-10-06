// Duplicate Tracking — every package received under a tracking number we had already
// received (docs/context/receiving.md, "Duplicate tracking numbers").
//
// Why: Alexander saw Foot Locker send two single-pair packages under ONE tracking number
// instead of one box of two. The receive screen warned, and that was the end of it —
// nothing kept the incident or said how often a supplier does it. Now the server logs one
// row per such receive at commit time; this page is that log, counted per supplier.
// An admin closes an entry with what was decided — told the supplier, or left it (which
// is what Alexander chose for the Foot Locker one). The warehouse reads.
import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { TopBar, FormModal } from '../components/common.jsx';
import { useLive } from '../hooks.js';
import { useQueryParam } from '../lib/urlstate.js';
import { PH_DATE, PH_DATETIME } from '../lib/format.js';

const when = (ts) => (ts ? `${PH_DATETIME.format(new Date(ts))} EST` : '');
const day = (ts) => (ts ? PH_DATE.format(new Date(ts)) : '');
const where = (code, boxNo, batchId) => {
  const label = `${code || 'deleted batch'}${boxNo ? ` · box ${boxNo}` : ''}`;
  return batchId ? <a href={`/batches?b=${batchId}`}>{label}</a> : label;
};

export function TrackingDuplicates({ user, onHome, onSignOut }) {
  const isAdmin = user?.role === 'admin' || user?.role === 'superadmin';
  const [status, setStatus] = useQueryParam('status', 'open');
  const [supplier, setSupplier] = useQueryParam('supplier', '');
  const [q, setQ] = useQueryParam('q', '');
  const [focus] = useQueryParam('d', '');          // an alert's link lands on its row
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [closing, setClosing] = useState(null);

  async function load() {
    try {
      const r = await api.trackingDuplicates({ status: status === 'all' ? '' : status, supplier, q: q.trim() });
      setData(r); setError('');
    } catch (e) { if (e.unauthorized) return onSignOut(); setError(e.message); }
  }
  useEffect(() => { const t = setTimeout(load, q ? 300 : 0); return () => clearTimeout(t); }, [status, supplier, q]); // eslint-disable-line react-hooks/exhaustive-deps
  useLive(['tracking_duplicates'], load, { mount: false });
  useEffect(() => {
    if (!focus || !data) return;
    document.getElementById(`dup-${focus}`)?.scrollIntoView({ block: 'center' });
  }, [focus, data]);

  async function reopen(row) {
    try { await api.setTrackingDuplicate(row.id, false); load(); } catch (e) { if (e.unauthorized) return onSignOut(); setError(e.message); }
  }

  const rows = data?.rows || [];
  const sup = data?.bySupplier || [];
  return (
    <div className="app dup-page">
      <TopBar title="Duplicate Tracking" onHome={onHome} onSignOut={onSignOut} />
      <div className="card">
        <p className="muted sm dup-lede">
          Every package received under a tracking number we had <b>already received</b> — on an earlier batch, or another box
          of the same one. Logged automatically when the box is submitted, so it doesn’t depend on anyone noticing the warning.
          {isAdmin ? ' Close an entry with what was decided: told the supplier, or left it.' : ''}
        </p>
        {sup.length > 0 && (
          <div className="dup-suppliers" role="group" aria-label="By supplier">
            <button type="button" className={`dup-sup ${!supplier ? 'on' : ''}`} onClick={() => setSupplier('')}>All suppliers</button>
            {sup.map((s) => (
              <button key={s.supplier} type="button" className={`dup-sup ${supplier === s.supplier ? 'on' : ''}`}
                onClick={() => setSupplier(supplier === s.supplier ? '' : s.supplier)}
                title={`Last on ${day(s.last_at)}`}>
                {s.supplier} <b>{s.total}</b>{s.open ? <span className="dup-open"> · {s.open} open</span> : null}
              </button>
            ))}
          </div>
        )}
        <div className="dup-filters">
          <div className="seg sm" role="tablist" aria-label="Status">
            {[['open', 'Open'], ['handled', 'Handled'], ['all', 'All']].map(([k, label]) => (
              <button key={k} type="button" role="tab" aria-selected={status === k} className={`seg-btn ${status === k ? 'on' : ''}`} onClick={() => setStatus(k)}>{label}</button>
            ))}
          </div>
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tracking #, batch or supplier" aria-label="Search" />
        </div>
        {error && <div className="error mt">{error}</div>}
      </div>

      <div className="card">
        {!data ? <p className="muted">Loading…</p> : !rows.length ? (
          <p className="muted">{status === 'open' ? 'Nothing open — no duplicate is waiting on a decision.' : 'Nothing here.'}</p>
        ) : (
          <table className="dup-table">
            <thead><tr><th>Received</th><th>Tracking #</th><th>Supplier</th><th>This package</th><th>Already received as</th><th>Status</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} id={`dup-${r.id}`} className={String(r.id) === String(focus) ? 'focus' : ''}>
                  <td data-label="Received">{when(r.detected_at)}{r.detected_by === 'history' ? <div className="muted xs">found in past batches</div> : r.detected_by ? <div className="muted xs">by {r.detected_by}</div> : null}</td>
                  <td data-label="Tracking #"><code>{r.tracking_number}</code></td>
                  <td data-label="Supplier">{r.supplier_name || '—'}</td>
                  <td data-label="This package">{where(r.batch_code, r.box_number, r.batch_id)}</td>
                  <td data-label="Already received as">
                    {where(r.prior_batch_code, r.prior_box_number, r.prior_batch_id)}
                    {r.same_batch ? <span className="dup-same"> same batch</span> : null}
                    <div className="muted xs">{day(r.prior_at)}{r.prior_supplier && r.prior_supplier !== r.supplier_name ? ` · ${r.prior_supplier}` : ''}</div>
                  </td>
                  <td data-label="Status">
                    {r.status === 'handled' ? (
                      <>
                        <span className="dup-handled">Handled</span>
                        <div className="xs">{r.handled_note}</div>
                        <div className="muted xs">{r.handled_by}{r.handled_at ? `, ${day(r.handled_at)}` : ''}</div>
                        {isAdmin && <button type="button" className="btn sm ghost" onClick={() => reopen(r)}>Reopen</button>}
                      </>
                    ) : (
                      <>
                        <span className="dup-open-chip">Open</span>
                        {isAdmin && <button type="button" className="btn sm ghost" onClick={() => setClosing(r)}>Close…</button>}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {closing && (
        <FormModal
          title="Close this duplicate"
          message={`${closing.supplier_name || 'The supplier'} — ${closing.tracking_number}. What was decided?`}
          submitLabel="Close it"
          fields={[{ name: 'note', label: 'What was decided', type: 'textarea', required: true, maxLength: 500,
            placeholder: 'e.g. Told the supplier · Left it — not worth chasing for one pair' }]}
          onClose={() => setClosing(null)}
          onSubmit={async ({ note }) => { await api.setTrackingDuplicate(closing.id, true, note); setClosing(null); load(); }} />
      )}
    </div>
  );
}
