// "Bought Without Box" worklist — not postable, so hidden from the PH report.
// Visible to admin + PH; admin/warehouse resolve a unit (box found → With Box,
// or another status). PH is read-only. Prints box-style UPC labels.
import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { STATUSES } from '../statuses.js';
import { TopBar, StatusPill, DateRangeBar, LabelSheet } from '../components/common.jsx';
import { Icon } from '../components/NavIcons.jsx';
import { useMediaQuery } from '../hooks.js';
import { rangeOf } from '../lib/format.js';
import { upcDigits } from '../lib/codes.js';

export function NoBoxReport({ user, onHome, onSignOut }) {
  const canEdit = user.role === 'admin' || user.role === 'superadmin' || user.role === 'warehouse';
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [savingVin, setSavingVin] = useState(null);
  const [labels, setLabels] = useState(null); // box-style UPC labels to print
  const [upcPrompt, setUpcPrompt] = useState(null); // unit needing a UPC before its box label prints
  const [upcInput, setUpcInput] = useState('');
  const [noUpcFound, setNoUpcFound] = useState(false);
  const [upcBusy, setUpcBusy] = useState(false);
  // Default to Month, not Day — this is a pending backlog queue, so a Day filter
  // lands on "all clear" while Home shows real no-box units. Month surfaces the backlog.
  const [dr, setDr] = useState(() => ({ mode: 'month', anchor: new Date() }));
  const isMobile = useMediaQuery('(max-width: 768px)');

  async function load() {
    setError('');
    try { const [from, to] = rangeOf(dr.mode, dr.anchor); const { rows: r } = await api.noBoxList(from, to); setRows(r); }
    catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
  }
  useEffect(() => { load(); }, [dr]); // eslint-disable-line react-hooks/exhaustive-deps

  // Edge-case resolution (mark Missing/Issue/etc.) — applied straight from the
  // dropdown with a confirm, so there's no separate "Set" step cluttering the row.
  async function onOtherStatus(r, status) {
    if (!status) return;
    const label = STATUSES.find((s) => s.key === status)?.label || status;
    if (!window.confirm(`Mark ${r.vin} as “${label}”? It leaves the No Box queue.`)) return;
    setSavingVin(r.vin); setError('');
    try {
      await api.itemEvent(r.vin, 'status_change', { status, from: 'no_box', note: 'Resolved from No Box' });
      setRows((rs) => rs.filter((x) => x.vin !== r.vin));
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

  // Print a box label. UPC is required for a scannable label — if the unit has none
  // on file, prompt for it first (with a "No UPC found" escape hatch).
  function printBoxLabel(r) {
    if (upcDigits(r.upc)) { setLabels([r]); return; }
    setUpcPrompt(r); setUpcInput(''); setNoUpcFound(false); setError('');
  }
  async function confirmUpc() {
    const r = upcPrompt;
    const digits = upcDigits(upcInput);
    if (!noUpcFound && ![8, 12, 13].includes(digits.length)) {
      setError('Enter a valid 8-, 12-, or 13-digit UPC — or tick “No UPC found”.'); return;
    }
    setUpcBusy(true); setError('');
    try {
      if (noUpcFound) {
        setLabels([r]); // LabelSheet prints a text-only "No UPC on file" box label
      } else {
        await api.setItemUpc(r.vin, digits);
        const updated = { ...r, upc: digits };
        setRows((rs) => rs.map((x) => (x.vin === r.vin ? updated : x))); // now on file
        setLabels([updated]);
      }
      setUpcPrompt(null);
    } catch (err) {
      if (err.unauthorized) return onSignOut();
      setError(err.message);
    } finally { setUpcBusy(false); }
  }

  // One tidy vertical action stack per row (desktop cell + mobile card): the primary
  // "Box found", the box-label print, and an "Other status…" dropdown for edge cases.
  const boxBtn = (r) => (
    <button className="btn sm ghost nobox-label-btn" disabled={savingVin === r.vin} onClick={() => printBoxLabel(r)}>
      <Icon name="print" /> Box label{!upcDigits(r.upc) && <span className="nobox-noupc-flag"> · needs UPC</span>}
    </button>
  );
  const resolveCtl = (r) => (canEdit ? (
    <div className="nobox-cell-actions">
      <button className="btn sm primary nobox-boxfound" disabled={savingVin === r.vin} onClick={() => boxFound(r.vin)}>
        {savingVin === r.vin ? '…' : <><Icon name="box" /> Box found → With Box</>}
      </button>
      {boxBtn(r)}
      <select className="nobox-other-sel" value="" disabled={savingVin === r.vin}
        onChange={(e) => { const v = e.target.value; e.target.value = ''; onOtherStatus(r, v); }}>
        <option value="">Other status…</option>
        {STATUSES.filter((s) => s.key !== 'no_box' && s.key !== 'needs_shelf').map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
      </select>
    </div>
  ) : <StatusPill status={r.status} />);

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
                {canEdit && <div className="dcard-actions">{resolveCtl(r)}</div>}
              </div>
            ))}
          </div>
        ) : (
          <div className="inv-tablewrap">
            <table className="inv-table nobox-table">
              <thead>
                <tr>
                  <th className="inv-col-vin">VIN</th>
                  <th>Shoe</th>
                  <th className="inv-col-size">Size</th>
                  <th className="inv-col-sku">SKU</th>
                  <th>Received</th>
                  <th className="nobox-col-actions">{canEdit ? 'Actions' : 'Status'}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.vin}>
                    <td className="inv-col-vin"><span className="vin">{r.vin}</span></td>
                    <td className="nobox-name" title={r.name}>{r.name}</td>
                    <td className="inv-col-size">{r.size ? `US ${r.size}` : '—'}</td>
                    <td className="inv-col-sku">{r.sku || '—'}</td>
                    <td className="muted sm" style={{ whiteSpace: 'nowrap' }}>{(r.created_at || '').slice(0, 10)}{r.created_by ? ` · ${r.created_by}` : ''}</td>
                    <td className="nobox-col-actions">{resolveCtl(r)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {labels && <LabelSheet items={labels} mode="upc" onClose={() => setLabels(null)} />}

      {upcPrompt && (
        <div className="modal-overlay" onClick={() => !upcBusy && setUpcPrompt(null)}>
          <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Box label — UPC needed</h3>
            <p className="modal-msg">
              <b>{upcPrompt.name || upcPrompt.sku || upcPrompt.vin}</b>{upcPrompt.size ? ` · US ${upcPrompt.size}` : ''} has no UPC on file.
              Scan or enter the shoe’s box UPC so the label scans normally — it’s saved to this pair for next time.
            </p>
            <input className="nobox-upc-input" autoFocus={!isMobile} inputMode="numeric" autoComplete="off"
              placeholder="Scan or type the UPC (12–13 digits)" value={upcInput} disabled={noUpcFound || upcBusy}
              onChange={(e) => setUpcInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') confirmUpc(); }} />
            <label className="nobox-noupc-check">
              <input type="checkbox" checked={noUpcFound} disabled={upcBusy} onChange={(e) => setNoUpcFound(e.target.checked)} />
              No UPC found — print a label without a barcode
            </label>
            {error && <div className="error sm mt">{error}</div>}
            <div className="modal-actions">
              <button className="btn ghost" disabled={upcBusy} onClick={() => setUpcPrompt(null)}>Cancel</button>
              <button className="btn primary" disabled={upcBusy || (!noUpcFound && !upcDigits(upcInput))} onClick={confirmUpc}>
                {upcBusy ? '…' : (noUpcFound ? 'Print without UPC' : 'Save & print')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
