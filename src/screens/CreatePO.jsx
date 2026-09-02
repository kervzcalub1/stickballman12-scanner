// PH "create batch" form (Phase 1). The PH team opens a Purchase Order — the
// batch — for a supplier: pick the supplier account, enter the tag/code + purchase
// date, and add one shipping label per row (each with its pre-assigned courier
// tracking number). The supplier then retrieves it on their portal and scans the
// contents. See docs/context/purchase-orders.md.
import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { TopBar } from '../components/common.jsx';
import { CARRIERS, carrierName } from '../lib/carriers.js';
import { estToday } from '../lib/format.js';

// EST, not UTC: an order raised at 9pm EST would otherwise be dated tomorrow, and one
// raised from a PH desk dated by Manila's calendar. The whole system dates by EST.
const today = () => estToday();

export function CreatePO({ onHome, onSignOut }) {
  const [suppliers, setSuppliers] = useState(null);
  const [supplierUserId, setSupplierUserId] = useState('');
  const [tagCode, setTagCode] = useState('');
  const [dateOfPurchase, setDateOfPurchase] = useState(today());
  const [notes, setNotes] = useState('');
  // Shoes, or the empty shoe boxes we buy to replace the crushed and missing ones. It
  // decides what the supplier is asked to declare (sizes vs carton dimensions), so it is
  // the first thing on the form rather than a detail further down. Changeable afterwards
  // from the order itself — an order for boxes is routinely raised before anyone says so.
  const [orderKind, setOrderKind] = useState('shoes');
  const [labels, setLabels] = useState([{ trackingNumber: '', carrierKey: null }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState(null); // { po, boxes } after success
  const [pdfStatus, setPdfStatus] = useState(''); // progress/result note for the PDF import
  // The imported file itself, kept so it can be stored once the order exists — the
  // supplier prints their box's label from it instead of hunting through email.
  const [pdfFile, setPdfFile] = useState(null);
  const [pdfPages, setPdfPages] = useState([]);   // [{ page, value }] from the import
  const [dragOver, setDragOver] = useState(false); // dropzone highlight while dragging a file

  useEffect(() => {
    api.poSuppliers()
      .then((r) => setSuppliers(r.suppliers || []))
      .catch((e) => { if (e.unauthorized) return onSignOut(); setError(e.message); });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const setLabel = (i, patch) => setLabels((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const addLabel = () => setLabels((ls) => [...ls, { trackingNumber: '', carrierKey: null }]);
  const removeLabel = (i) => setLabels((ls) => (ls.length > 1 ? ls.filter((_, idx) => idx !== i) : ls));

  // Upload a PDF of shipping labels (one label per page) → auto-create a label row
  // per page with its tracking number read off the page. Rows stay fully editable.
  const importPdf = async (file) => {
    if (!file) return;
    setError(''); setPdfStatus('Reading PDF…');
    try {
      const { decodeTrackingPdf, labelPagesOnly } = await import('../trackingOcr.js');
      const results = await decodeTrackingPdf(file, (p, n) => setPdfStatus(`Reading page ${p} of ${n}…`));
      if (!results.length) { setPdfStatus(''); setError('That PDF had no pages to read.'); return; }
      // Packing slips are interleaved after every label — they carry no barcode, and used
      // to import as blank rows to delete by hand.
      const { labels: pages, skipped, undecidable } = labelPagesOnly(results);
      const found = pages.map((r) => ({ trackingNumber: r.value || '', carrierKey: r.carrierKey || null }));
      setPdfFile(file); setPdfPages(results);
      // Keep any tracking numbers already typed; append the imported rows after them.
      setLabels((ls) => { const kept = ls.filter((l) => l.trackingNumber.trim()); return [...kept, ...found]; });
      const carrierCount = pages.filter((r) => r.carrierKey).length;
      setPdfStatus(undecidable
        ? `Added ${pages.length} label${pages.length === 1 ? '' : 's'} — no tracking number could be read from any page. Fill them in below.`
        : `Added ${pages.length} label${pages.length === 1 ? '' : 's'} from ${results.length} pages`
          + `${carrierCount ? `, detected ${carrierCount} courier${carrierCount === 1 ? '' : 's'}` : ''}.`
          + `${skipped.length ? ` Skipped ${skipped.length} page${skipped.length === 1 ? '' : 's'} with no tracking number (packing slips).` : ''}`);
    } catch (e) {
      setPdfStatus(''); setError(`Could not read that PDF. ${e.message || ''}`.trim());
    }
  };

  const onDrop = (e) => {
    e.preventDefault(); setDragOver(false);
    const file = [...(e.dataTransfer?.files || [])].find((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
    if (!file) { setError('Drop a PDF file of shipping labels.'); return; }
    importPdf(file);
  };

  const reset = () => {
    setSupplierUserId(''); setTagCode(''); setDateOfPurchase(today()); setNotes('');
    setLabels([{ trackingNumber: '', carrierKey: null }]); setCreated(null); setError('');
    setOrderKind('shoes');
  };

  const submit = async () => {
    setError('');
    const supplier = (suppliers || []).find((s) => String(s.id) === String(supplierUserId));
    if (!supplier) { setError('Pick a supplier account.'); return; }
    const cleaned = labels.map((l) => ({ trackingNumber: l.trackingNumber.trim(), carrierKey: l.carrierKey || null }));
    if (cleaned.length < 1) { setError('Add at least one shipping label.'); return; }
    setBusy(true);
    try {
      const r = await api.poCreate({
        supplierName: supplier.name,
        supplierUserId: supplier.id,
        tagCode, dateOfPurchase, notes, orderKind,
        labels: cleaned,
      });
      // Store the sheet against the order it just became. Best-effort: the order is
      // created either way, and the labels can be attached later from its own page.
      if (pdfFile) {
        try {
          setPdfStatus('Saving the labels PDF…');
          const { key, url } = await api.poLabelsSign(r.po.id);
          const put = await fetch(url, { method: 'PUT', body: pdfFile, headers: { 'Content-Type': 'application/pdf' } });
          if (!put.ok) throw new Error(`Upload failed (${put.status})`);
          const att = await api.poLabelsAttach({
            poId: r.po.id, key, name: pdfFile.name, pages: pdfPages.length,
            pageMap: pdfPages.filter((x) => x.value).map((x) => ({ tracking: x.value, page: x.page })),
          });
          setPdfStatus(att.matched
            ? `Labels PDF saved — ${att.matched} of ${pdfPages.length} pages matched a label.`
            : 'Labels PDF saved, but no page matched a tracking number — single-label downloads won’t work.');
        } catch (e) {
          setPdfStatus(`The order was created, but the labels PDF could not be saved (${e.message}). Attach it from the order page.`);
        }
      }
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
              {' '}{created.boxes.length} label{created.boxes.length === 1 ? '' : 's'} ·
              {' '}{created.po.order_kind === 'boxes' ? 'empty shoe boxes' : 'shoes'}.
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
            {/* First, because it changes what the supplier is asked for: a shoes order is
                declared per size, a boxes order per carton size. */}
            <label className="batch-form-wide">What is this order for? *
              <span className="seg po-kind-seg" role="group" aria-label="What this order is for">
                <button type="button" className={`seg-btn ${orderKind === 'shoes' ? 'on' : ''}`}
                  aria-pressed={orderKind === 'shoes'} onClick={() => setOrderKind('shoes')}>Shoes</button>
                <button type="button" className={`seg-btn ${orderKind === 'boxes' ? 'on' : ''}`}
                  aria-pressed={orderKind === 'boxes'} onClick={() => setOrderKind('boxes')}>Empty shoe boxes</button>
              </span>
              <span className="muted sm">{orderKind === 'boxes'
                ? 'Replacement boxes for pairs that arrived crushed or with no box. The supplier declares each one by SKU, shoe name, box dimensions and cost.'
                : 'A shipment of pairs. The supplier declares each one by SKU and size.'}</span>
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
          <label
            className={`po-dropzone${dragOver ? ' drag' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragEnter={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
          >
            <input type="file" accept="application/pdf" hidden
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; importPdf(f); }} />
            <span className="po-dropzone-icon">📄</span>
            <span className="po-dropzone-text"><b>Drag &amp; drop a labels PDF</b> here, or <span className="po-dropzone-link">browse</span></span>
            <span className="muted sm">One label per page — each tracking number is read in automatically.</span>
          </label>
          <p className="po-dropzone-note sm">The tracking numbers are read off each page, and the PDF is saved with the order so the supplier can print the label for the box they’re packing. It’s only ever served to them through the app — never a public link.</p>
          {pdfStatus && <p className="po-pdf-status sm">{pdfStatus}</p>}
          <div className="po-label-rows">
            {labels.map((l, i) => (
              <div className="po-label-row" key={i}>
                <span className="po-label-n">#{i + 1}</span>
                <input value={l.trackingNumber} maxLength={120} placeholder="Tracking number"
                  autoCapitalize="characters" autoCorrect="off" onChange={(e) => setLabel(i, { trackingNumber: e.target.value })} />
                <select className="po-label-carrier" value={l.carrierKey ?? ''}
                  title="Courier" onChange={(e) => setLabel(i, { carrierKey: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">— Select courier —</option>
                  {CARRIERS.map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}
                </select>
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
