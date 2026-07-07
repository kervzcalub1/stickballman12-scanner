// "Bought Without Box" worklist — not postable, so hidden from the PH report.
// Visible to admin + PH; admin/warehouse resolve a unit (box found → With Box,
// or another status). PH is read-only. Prints box-style UPC labels.
import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { STATUSES } from '../statuses.js';
import { TopBar, StatusPill, DateRangeBar, LabelSheet } from '../components/common.jsx';
import { Icon } from '../components/NavIcons.jsx';
import { useUnsavedGuard, useMediaQuery } from '../hooks.js';
import { rangeOf } from '../lib/format.js';
import { upcDigits } from '../lib/codes.js';

export function NoBoxReport({ user, onHome, onSignOut }) {
  const canEdit = user.role === 'admin' || user.role === 'superadmin' || user.role === 'warehouse';
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [drafts, setDrafts] = useState({}); // vin -> chosen status
  const [savingVin, setSavingVin] = useState(null);
  const [labels, setLabels] = useState(null); // box-style UPC labels to print
  // Default to Month, not Day — this is a pending backlog queue, so a Day filter
  // lands on "all clear" while Home shows real no-box units. Month surfaces the backlog.
  const [dr, setDr] = useState(() => ({ mode: 'month', anchor: new Date() }));
  const isMobile = useMediaQuery('(max-width: 768px)');
  useUnsavedGuard(Object.keys(drafts).length > 0); // guard staged no-box resolutions

  async function load() {
    setError('');
    try { const [from, to] = rangeOf(dr.mode, dr.anchor); const { rows: r } = await api.noBoxList(from, to); setRows(r); setDrafts({}); }
    catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
  }
  useEffect(() => { load(); }, [dr]); // eslint-disable-line react-hooks/exhaustive-deps

  const setDraft = (vin, status) => setDrafts((d) => ({ ...d, [vin]: status }));
  async function save(vin) {
    const status = drafts[vin];
    if (!status || status === 'no_box') return;
    setSavingVin(vin); setError('');
    try {
      await api.itemEvent(vin, 'status_change', { status, from: 'no_box', note: 'Resolved from No Box' });
      setRows((rs) => rs.filter((r) => r.vin !== vin)); // resolved → leaves the queue
    } catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setSavingVin(null); }
  }
  // A box was sourced → mark With Box (now sellable; we never sell without a box).
  async function boxFound(vin) {
    setSavingVin(vin); setError('');
    try {
      await api.boxFound(vin);
      setRows((rs) => rs.filter((r) => r.vin !== vin)); // now With Box → leaves the queue
    } catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setSavingVin(null); }
  }

  // Shared controls (used by both the desktop table and the mobile cards).
  // Primary action: "Box found → With Box". A secondary dropdown handles edge
  // cases (e.g. mark Missing/Issue) without selling a no-box pair.
  const resolveCtl = (r) => (canEdit ? (
    <span className="nobox-resolve">
      <button className="btn sm primary" disabled={savingVin === r.vin} onClick={() => boxFound(r.vin)}>
        {savingVin === r.vin ? '…' : <><Icon name="box" /> Box found → With Box</>}
      </button>
      <select value={drafts[r.vin] ?? ''} onChange={(e) => setDraft(r.vin, e.target.value)}>
        <option value="">Other status…</option>
        {STATUSES.filter((s) => s.key !== 'no_box' && s.key !== 'needs_shelf').map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
      </select>
      <button className="btn sm ghost" disabled={!drafts[r.vin] || savingVin === r.vin} onClick={() => save(r.vin)}>Set</button>
    </span>
  ) : <StatusPill status={r.status} />);
  const boxBtn = (r) => (
    <button className="btn sm ghost" title={upcDigits(r.upc) ? 'Print box label' : 'No UPC on file'} onClick={() => setLabels([r])}><Icon name="print" /> Box label</button>
  );

  return (
    <div className="app">
      <TopBar title="No Box — Not Ready" onHome={onHome} onSignOut={onSignOut} />
      <div className="card">
        <p className="muted sm">
          Units received <b>without a box</b> — not ready for posting, so they’re hidden from the PH report.{' '}
          {canEdit
            ? 'Once a box is found, “Box found → With Box” makes it sellable.'
            : 'Warehouse/admin resolves these; this view is read-only for you.'}
        </p>
        <DateRangeBar mode={dr.mode} anchor={dr.anchor} onChange={(mode, anchor) => setDr({ mode, anchor })}
          right={<span className="muted sm">{rows ? `${rows.length} unit${rows.length === 1 ? '' : 's'}` : ''}</span>} />
        {canEdit && rows?.length > 0 && (
          <div className="nobox-actions">
            <button className="btn sm primary" onClick={() => setLabels(rows)}><Icon name="print" /> Print box labels (all {rows.length})</button>
            <span className="muted sm">Box-style UPC labels for no-box shoes — recreate the original box label so it scans normally.</span>
          </div>
        )}
        {error && <div className="error mt">{error}</div>}
        {!rows ? <p className="muted">Loading…</p> : !rows.length ? <p className="ok">All clear — no “Bought Without Box” items.</p> : isMobile ? (
          <div className="dcards">
            {rows.map((r) => (
              <div className="dcard" key={r.vin}>
                <div className="dcard-top"><span className="vin">{r.vin}</span>{!canEdit && <StatusPill status={r.status} />}</div>
                <div className="dcard-name">{r.name || '—'}</div>
                <div className="dcard-line"><span>Size {r.size ? `US ${r.size}` : '—'}</span><span className="muted">{r.sku || '—'}</span></div>
                <div className="dcard-line muted sm">{(r.created_at || '').slice(0, 10)}{r.created_by ? ` · ${r.created_by}` : ''}</div>
                {canEdit && <div className="dcard-actions">{resolveCtl(r)}{boxBtn(r)}</div>}
              </div>
            ))}
          </div>
        ) : (
          <div className="inv-tablewrap">
            <table className="inv-table">
              <thead>
                <tr>
                  <th className="inv-col-vin">VIN</th>
                  <th>Shoe</th>
                  <th className="inv-col-size">Size</th>
                  <th className="inv-col-sku">SKU</th>
                  <th>Received</th>
                  {canEdit && <th aria-label="label" />}
                  <th>{canEdit ? 'Resolve → status' : 'Status'}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.vin}>
                    <td className="inv-col-vin"><span className="vin">{r.vin}</span></td>
                    <td className="inv-name" title={r.name}>{r.name}</td>
                    <td className="inv-col-size">{r.size ? `US ${r.size}` : '—'}</td>
                    <td className="inv-col-sku">{r.sku || '—'}</td>
                    <td className="muted sm" style={{ whiteSpace: 'nowrap' }}>{(r.created_at || '').slice(0, 10)}{r.created_by ? ` · ${r.created_by}` : ''}</td>
                    {canEdit && <td>{boxBtn(r)}</td>}
                    <td>{resolveCtl(r)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {labels && <LabelSheet items={labels} mode="upc" onClose={() => setLabels(null)} />}
    </div>
  );
}
