// PH "create batch" form (Phase 1). The PH team opens a Purchase Order — the
// batch — for a supplier: pick the supplier account, enter the tag/code + purchase
// date, and add one shipping label per row (each with its pre-assigned courier
// tracking number). The supplier then retrieves it on their portal and scans the
// contents. See docs/context/purchase-orders.md.
import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { TopBar } from '../components/common.jsx';

const today = () => new Date().toISOString().slice(0, 10);

export function CreatePO({ onHome, onSignOut }) {
  const [suppliers, setSuppliers] = useState(null);
  const [supplierUserId, setSupplierUserId] = useState('');
  const [tagCode, setTagCode] = useState('');
  const [dateOfPurchase, setDateOfPurchase] = useState(today());
  const [notes, setNotes] = useState('');
  const [labels, setLabels] = useState([{ trackingNumber: '' }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState(null); // { po, boxes } after success

  useEffect(() => {
    api.poSuppliers()
      .then((r) => setSuppliers(r.suppliers || []))
      .catch((e) => { if (e.unauthorized) return onSignOut(); setError(e.message); });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const setLabel = (i, v) => setLabels((ls) => ls.map((l, idx) => (idx === i ? { trackingNumber: v } : l)));
  const addLabel = () => setLabels((ls) => [...ls, { trackingNumber: '' }]);
  const removeLabel = (i) => setLabels((ls) => (ls.length > 1 ? ls.filter((_, idx) => idx !== i) : ls));

  const reset = () => {
    setSupplierUserId(''); setTagCode(''); setDateOfPurchase(today()); setNotes('');
    setLabels([{ trackingNumber: '' }]); setCreated(null); setError('');
  };

  const submit = async () => {
    setError('');
    const supplier = (suppliers || []).find((s) => String(s.id) === String(supplierUserId));
    if (!supplier) { setError('Pick a supplier account.'); return; }
    const cleaned = labels.map((l) => ({ trackingNumber: l.trackingNumber.trim() })).filter(() => true);
    if (cleaned.length < 1) { setError('Add at least one shipping label.'); return; }
    setBusy(true);
    try {
      const r = await api.poCreate({
        supplierName: supplier.name,
        supplierUserId: supplier.id,
        tagCode, dateOfPurchase, notes,
        labels: cleaned,
      });
      setCreated({ po: r.po, boxes: r.boxes });
    } catch (e) {
      if (e.unauthorized) return onSignOut();
      setError(e.message);
    } finally { setBusy(false); }
  };

  if (created) {
    return (
      <div className="app">
        <TopBar title="Batch created" onHome={onHome} onSignOut={onSignOut} />
        <div className="wrap-narrow">
          <div className="card">
            <div className="po-created-icon">✓</div>
            <h3 className="rows-title">{created.po.po_code} created</h3>
            <p className="muted sm">
              For {created.po.supplier_name}{created.po.tag_code ? ` · ${created.po.tag_code}` : ''} ·
              {' '}{created.boxes.length} label{created.boxes.length === 1 ? '' : 's'}.
            </p>
            <ul className="po-lines">
              {created.boxes.map((b) => (
                <li key={b.id}><span className="po-line-name">Label {b.box_number}</span>
                  <span className="po-line-meta">{b.tracking_number || '— no tracking #'}</span></li>
              ))}
            </ul>
            <p className="muted sm">Send the physical labels to the supplier in the group chat. They'll retrieve this batch on their portal and scan the items.</p>
            <div className="modal-actions">
              <button className="btn ghost" onClick={onHome}>Done</button>
              <button className="btn primary" onClick={reset}>Create another</button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const noSuppliers = suppliers != null && suppliers.length === 0;
  return (
    <div className="app">
      <TopBar title="New Batch (Purchase Order)" onHome={onHome} onSignOut={onSignOut} />
      <div className="wrap-narrow">
        {error && <div className="po-err">{error}</div>}
        {noSuppliers && (
          <div className="card empty-state">No supplier accounts yet. An admin needs to create one in <b>Check Access</b> (set a user's role to <b>supplier</b>) before you can open a batch for them.</div>
        )}
        <div className="card">
          <h3 className="rows-title">Batch details</h3>
          <div className="batch-form">
            <label>Supplier account *
              <select value={supplierUserId} onChange={(e) => setSupplierUserId(e.target.value)}>
                <option value="">Select supplier…</option>
                {(suppliers || []).map((s) => <option key={s.id} value={s.id}>{s.name} ({s.username})</option>)}
              </select>
            </label>
            <label>Tag / code name
              <input value={tagCode} maxLength={120} placeholder="e.g. Joey JP23 AJ40" onChange={(e) => setTagCode(e.target.value)} />
            </label>
            <label>Date of purchase
              <input type="date" value={dateOfPurchase} onChange={(e) => setDateOfPurchase(e.target.value)} />
            </label>
            <label className="batch-form-wide">Notes
              <input value={notes} maxLength={2000} placeholder="Optional" onChange={(e) => setNotes(e.target.value)} />
            </label>
          </div>
        </div>

        <div className="card">
          <div className="po-card-top">
            <h3 className="rows-title">Shipping labels <span className="muted">({labels.length})</span></h3>
            <button type="button" className="btn sm" onClick={addLabel}>+ Add label</button>
          </div>
          <p className="muted sm">One row per shipping label — enter each label's pre-assigned courier tracking number.</p>
          <div className="po-label-rows">
            {labels.map((l, i) => (
              <div className="po-label-row" key={i}>
                <span className="po-label-n">#{i + 1}</span>
                <input value={l.trackingNumber} maxLength={120} placeholder="Tracking number"
                  autoCapitalize="characters" autoCorrect="off" onChange={(e) => setLabel(i, e.target.value)} />
                <button type="button" className="btn sm ghost po-label-x" title="Remove label" disabled={labels.length <= 1}
                  onClick={() => removeLabel(i)} aria-label="Remove label">×</button>
              </div>
            ))}
          </div>
        </div>

        <div className="po-submit-bar">
          <button className="btn ghost" onClick={onHome}>Cancel</button>
          <button className="btn primary" disabled={busy || noSuppliers} onClick={submit}>{busy ? 'Creating…' : 'Create batch'}</button>
        </div>
      </div>
    </div>
  );
}
