// "Send for rescale" — raising a rescale request straight off a PH New Inventory row.
//
// It creates the SAME request the PH Request Rescale form creates (`rescale-requests/create`,
// status `open`) and lands in the same warehouse inbox, so the loop that follows is
// unchanged: PH reports, warehouse audits the shelf, both read reported-vs-actual.
// Nothing here touches the items — a request is an audit ASK, not `restock_pending`
// (that flag is the warehouse's to set when it actually rescales). See
// docs/context/rescale.md.
//
// The one thing this adds over the standalone form is the comparison PH is looking at
// when they hit the button: the row's own per-size counts are pre-filled AND kept on
// screen as "on file", so what PH types is visibly *their* count next to ours. That
// difference is the whole reason for the request, and re-typing it from memory on
// another screen is where it used to get lost.
import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api.js';
import { REQUEST_REASONS } from '../lib/constants.js';
import { PH_DATETIME } from '../lib/format.js';
import { SkuCodePicker } from './SkuCodePicker.jsx';

let rowKey = 1;

export function RescaleRequestModal({ group, existing = null, onClose, onDone }) {
  // Pre-fill from the row: every size it holds, at the qty we have on file. A size
  // with no size on file ('—') can't be reported as one — it comes in blank for PH
  // to fill rather than sending the warehouse a dash to go and count.
  const [rows, setRows] = useState(() => (group.sizes || []).map((s) => ({
    key: rowKey++,
    size: s.size === '—' ? '' : String(s.size),
    qty: s.qty,
    onFile: s.qty,          // ours, fixed — the number PH is comparing against
    unknownSize: s.size === '—',
  })));
  // Only when every size that HAS a price agrees on it: "current price" is one field,
  // and picking one of several would put a number on the request nobody chose.
  const [price, setPrice] = useState(() => {
    // Normalised through Number: a NUMERIC column arrives as '180.00', and a price
    // field that opens reading "180.00" looks like something was already typed in it.
    const set = new Set((group.sizes || []).filter((s) => s.price != null).map((s) => String(Number(s.price))));
    return set.size === 1 ? [...set][0] : '';
  });
  // Which style code(s) the warehouse should count. Defaults to ALL of the row's
  // codes: the shelf can hold pairs filed under either, so counting everything is the
  // answer that can't miss any — narrowing is the deliberate act.
  const [askSku, setAskSku] = useState(group.sku || '');
  const [reason, setReason] = useState('mismatch');
  const [reasonOther, setReasonOther] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const setRow = (k, patch) => setRows((a) => a.map((r) => (r.key === k ? { ...r, ...patch } : r)));
  const addRow = () => setRows((a) => [...a, { key: rowKey++, size: '', qty: 1, onFile: null }]);
  const rmRow = (k) => setRows((a) => a.filter((r) => r.key !== k));

  const clean = useMemo(() => rows
    .filter((r) => String(r.size).trim())
    .map((r) => ({ size: String(r.size).trim(), qty: Math.max(1, Number(r.qty) || 1) })), [rows]);
  // How far PH's count is from ours, summed — the headline the warehouse is being
  // asked to settle. Only counted over sizes that exist on both sides.
  const onFileTotal = (group.sizes || []).reduce((n, s) => n + (s.qty || 0), 0);
  const reportedTotal = clean.reduce((n, r) => n + r.qty, 0);

  async function submit() {
    setError('');
    if (reason === 'other' && !reasonOther.trim()) { setError('Enter a custom reason.'); return; }
    if (!clean.length) { setError('Enter at least one size and quantity.'); return; }
    setBusy(true);
    try {
      const { id } = await api.rescaleRequestCreate({
        sku: askSku || group.sku, skuAll: group.sku, name: group.name || '', sizes: clean,
        // The pairs this is about. Only the row modal knows them — the standalone form
        // names a SKU and nothing else, and stays unlinked on purpose.
        vins: group.vins || [],
        price: price === '' ? null : Number(price),
        reason: reason === 'other' ? reasonOther.trim() : reason,
        note: note.trim(),
      });
      onDone({ id, sku: askSku || group.sku, qty: reportedTotal });
    } catch (e) {
      if (e.unauthorized) return onClose();
      setError(e.message || 'Could not send this for rescale.');
      setBusy(false);
    }
  }

  return createPortal(
    <div className="modal-overlay" onClick={() => { if (!busy) onClose(); }}>
      <div className="modal rescale-ask" role="dialog" aria-modal="true" aria-label="Send for rescale" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">Send for rescale</h3>
        <p className="modal-msg">{group.name || 'Unknown shoe'}{group.sku ? <> · <span className="mono">{group.sku}</span></> : null}</p>

        {/* Raised twice, the warehouse counts the same shelf twice and the two requests
            disagree for no reason. It isn't blocked — a second, later count can be
            exactly the point — but it has to be a choice. */}
        {existing && (
          <p className="ra-dupe">
            <b>{existing.requested_by || 'Someone'}</b> already has an open rescale request for this SKU
            {existing.created_at ? ` (${PH_DATETIME.format(new Date(existing.created_at))} EST)` : ''}.
            Sending another asks the warehouse to count the same shelf again.
          </p>
        )}

        <SkuCodePicker all={group.sku} value={askSku} onChange={setAskSku}
          label="This shoe has more than one style code — which should the warehouse count?" />

        <p className="ra-help muted sm">
          Enter what <b>you</b> have on your side. The warehouse counts the shelf and enters the actual
          quantity — you'll both see reported vs actual on <b>Rescale Requests</b>.
        </p>

        <div className="ra-rows">
          <div className="ra-head muted xs"><span>Size</span><span>On file</span><span>Your count</span><span /></div>
          {rows.map((r) => {
            const q = Math.max(0, Number(r.qty) || 0);
            const diff = r.onFile == null ? 0 : q - r.onFile;
            return (
              <div className={`ra-row ${diff ? 'diff' : ''}`} key={r.key}>
                <input className="sz" placeholder={r.unknownSize ? 'No size on file' : 'Size'} value={r.size}
                  onChange={(e) => setRow(r.key, { size: e.target.value })} />
                <span className="ra-onfile muted sm">{r.onFile == null ? '—' : `×${r.onFile}`}</span>
                <div className="qty-stepper">
                  <button type="button" className="btn icon ghost step" onClick={() => setRow(r.key, { qty: Math.max(0, q - 1) })}>−</button>
                  <input className="qty" type="number" min="0" inputMode="numeric" value={r.qty}
                    onChange={(e) => setRow(r.key, { qty: e.target.value })} />
                  <button type="button" className="btn icon ghost step" onClick={() => setRow(r.key, { qty: q + 1 })}>+</button>
                </div>
                <button type="button" className="btn icon ghost remove" title="Drop this size from the request" onClick={() => rmRow(r.key)}>×</button>
              </div>
            );
          })}
          <div className="ra-rows-foot">
            <button type="button" className="btn sm ghost" onClick={addRow}>+ Add size</button>
            <span className="muted sm">
              {reportedTotal} reported vs {onFileTotal} on file
              {reportedTotal !== onFileTotal && <b className="ra-delta"> · {reportedTotal > onFileTotal ? '+' : '−'}{Math.abs(reportedTotal - onFileTotal)}</b>}
            </span>
          </div>
        </div>

        <div className="ra-fields">
          <label><span className="muted xs">Reason *</span>
            <select value={reason} onChange={(e) => setReason(e.target.value)}>
              {REQUEST_REASONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          {reason === 'other' && (
            <label><span className="muted xs">Custom reason *</span>
              <input value={reasonOther} maxLength={80} onChange={(e) => setReasonOther(e.target.value)} /></label>
          )}
          <label><span className="muted xs">Current price ($)</span>
            <input type="number" min="0" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} /></label>
          <label className="ra-note"><span className="muted xs">Note (optional)</span>
            <input value={note} maxLength={2000} placeholder="What you're seeing on your side"
              onChange={(e) => setNote(e.target.value)} /></label>
        </div>

        {error && <p className="rm-error">{error}</p>}

        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" onClick={submit} disabled={busy || !clean.length}>
            {busy ? 'Sending…' : 'Send for rescale'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
