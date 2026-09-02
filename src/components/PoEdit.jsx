// Editing a purchase order after it exists: its own details, and its labels.
//
// An order isn't settled the moment it's raised — the supplier buys more and gets another
// label, a tracking number goes in with a typo, and a label sometimes belongs to a
// different order entirely. Everything here is staff-side (PH/admin); the supplier's
// portal only ever fills the contents of the labels it was given.
//
// The one rule worth knowing before reading further: a label the warehouse has already
// counted stock into can be MOVED but never deleted, so "Remove" refuses it and hands the
// caller to "Move" instead. Deleting it would take the record of what physically arrived
// with it. Server side: api/po/label-remove.js + api/po/label-move.js.
import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { CARRIERS } from '../lib/carriers.js';
import { Icon } from './NavIcons.jsx';

const FROZEN = ['reconciled', 'closed'];
export const poEditable = (po) => !!po && !FROZEN.includes(po.status);

/* The order's own details. Collapsed behind a button: the overview is read first and
   edited rarely, and an always-open form of six fields buries the labels under it. */
export function PoDetailsEdit({ po, boxes = [], lineCount = 0, onChanged, onSignOut }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [suppliers, setSuppliers] = useState(null);
  const [form, setForm] = useState(null);

  const labelCount = boxes.filter((b) => b.kind !== 'replacement').length;

  useEffect(() => {
    if (!open) return;
    setForm({
      supplierUserId: po.supplier_user_id ? String(po.supplier_user_id) : '',
      supplierName: po.supplier_name || '',
      tagCode: po.tag_code || '',
      dateOfPurchase: po.date_of_purchase ? String(po.date_of_purchase).slice(0, 10) : '',
      expectedBoxes: po.expected_boxes == null ? '' : String(po.expected_boxes),
      orderKind: po.order_kind || 'shoes',
      notes: po.notes || '',
    });
    if (suppliers == null) api.poSuppliers().then((r) => setSuppliers(r.suppliers || [])).catch(() => setSuppliers([]));
  }, [open, po]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!poEditable(po)) return null;
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const save = async () => {
    setBusy(true); setError('');
    try {
      // The supplier is picked as an ACCOUNT — that link is what lets them see the order
      // on their own portal — so the name follows the account rather than being typed.
      const picked = (suppliers || []).find((s) => String(s.id) === String(form.supplierUserId));
      await api.poUpdate(po.id, {
        ...(picked ? { supplierName: picked.name, supplierUserId: picked.id } : {}),
        tagCode: form.tagCode,
        dateOfPurchase: form.dateOfPurchase,
        expectedBoxes: form.expectedBoxes,
        orderKind: form.orderKind,
        notes: form.notes,
      });
      setOpen(false);
      onChanged?.();
    } catch (e) {
      if (e.unauthorized) return onSignOut?.();
      setError(e.message);
    } finally { setBusy(false); }
  };

  if (!open) {
    return (
      <button type="button" className="btn ghost sm po-edit-btn" onClick={() => setOpen(true)}>
        <Icon name="pencil" /> Edit details
      </button>
    );
  }
  return (
    <div className="po-edit-form">
      {error && <div className="po-err">{error}</div>}
      <div className="batch-form">
        <label>Supplier account
          <select value={form?.supplierUserId ?? ''} onChange={(e) => set({ supplierUserId: e.target.value })}>
            <option value="">{po.supplier_name} (unchanged)</option>
            {(suppliers || []).map((s) => <option key={s.id} value={s.id}>{s.name} ({s.username})</option>)}
          </select>
        </label>
        {/* An order for empty boxes is routinely raised on the shoes form before anyone
            says which it is, and the supplier can't declare a thing until the order says
            what it's for — so this is editable, not fixed at creation. Anything already
            declared under the old kind is KEPT but has to be re-stated: a shoe line's
            size and a box line's dimensions are different facts, not two names for one. */}
        <label className="batch-form-wide">What is this order for?
          <span className="seg po-kind-seg" role="group" aria-label="What this order is for">
            <button type="button" className={`seg-btn ${form?.orderKind !== 'boxes' ? 'on' : ''}`}
              aria-pressed={form?.orderKind !== 'boxes'} onClick={() => set({ orderKind: 'shoes' })}>Shoes</button>
            <button type="button" className={`seg-btn ${form?.orderKind === 'boxes' ? 'on' : ''}`}
              aria-pressed={form?.orderKind === 'boxes'} onClick={() => set({ orderKind: 'boxes' })}>Empty shoe boxes</button>
          </span>
          <span className="muted sm">{form?.orderKind === 'boxes'
            ? 'The supplier declares each box by SKU, shoe name, dimensions and cost.'
            : 'The supplier declares each pair by SKU and size.'}</span>
          {form && (form.orderKind || 'shoes') !== (po.order_kind || 'shoes') && lineCount > 0 && (
            <span className="po-kind-warn sm">
              {lineCount} line{lineCount === 1 ? '' : 's'} already declared on this order will be kept, but
              {' '}{(form.orderKind === 'boxes') ? 'their sizes will not show — each one needs its box dimensions.' : 'their dimensions will not show — each one needs a size.'}
            </span>
          )}
        </label>
        <label>Tag / code name
          <input value={form?.tagCode ?? ''} maxLength={120} onChange={(e) => set({ tagCode: e.target.value })} />
        </label>
        <label>Date of purchase
          <input type="date" value={form?.dateOfPurchase ?? ''} onChange={(e) => set({ dateOfPurchase: e.target.value })} />
        </label>
        {/* Can be set HIGHER than the labels entered so far — an order often knows six
            boxes are coming before the last tracking numbers exist. Never lower: that
            would leave the order contradicting the labels it already holds. */}
        <label>Boxes expected
          <input type="number" min={labelCount || 1} max={500} step={1} inputMode="numeric"
            value={form?.expectedBoxes ?? ''} onChange={(e) => set({ expectedBoxes: e.target.value })} />
          <span className="muted sm">{labelCount} label{labelCount === 1 ? '' : 's'} entered so far.</span>
        </label>
        <label className="batch-form-wide">Notes
          <input value={form?.notes ?? ''} maxLength={2000} onChange={(e) => set({ notes: e.target.value })} />
        </label>
      </div>
      <div className="po-edit-actions">
        <button type="button" className="btn ghost sm" disabled={busy} onClick={() => { setOpen(false); setError(''); }}>Cancel</button>
        <button type="button" className="btn primary sm" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save details'}</button>
      </div>
    </div>
  );
}

/* Add labels to an order that already exists — typed in, or read off the courier's PDF
   exactly as the create-order form does it (one label per page, tracking number decoded
   from the barcode). Same component either way: the imported rows land in the same
   editable list as a typed one.

   The FILE is the subtle part. An order stores ONE labels PDF, and a per-label download
   is a page range into it — so attaching a second sheet replaces the first, and the
   labels that came with the old one lose their printable page (`attachPoLabels` clears
   every page pointer first, so nothing is left pointing at a stranger's label). That's
   the right trade when the courier re-issues the whole set, and the wrong one when the
   PDF only holds the new labels — so it's a choice, defaulted to safe, and never made
   silently. */
export function PoAddLabels({ po, boxes = [], onChanged, onSignOut }) {
  const [rows, setRows] = useState(null);   // null = closed
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pdfFile, setPdfFile] = useState(null);
  const [pdfPages, setPdfPages] = useState([]);    // [{ page, value }] from the import
  const [pdfStatus, setPdfStatus] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const hasSheet = !!(po?.labels_key || po?.labels_pages || po?.labels_uploaded_at);
  const [storeSheet, setStoreSheet] = useState(false);
  if (!poEditable(po)) return null;

  const key = (t) => String(t || '').trim().toUpperCase().replace(/\s+/g, '');
  const onOrder = new Set(boxes.map((b) => key(b.tracking_number)).filter(Boolean));
  const set = (i, patch) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const close = () => {
    setRows(null); setError(''); setPdfFile(null); setPdfPages([]); setPdfStatus(''); setStoreSheet(false);
  };

  // Read a sheet of labels → one row per page, tracking number decoded from the barcode.
  // Rows stay fully editable, and a page whose number is already on this order is dropped
  // rather than added for the server to refuse.
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
      const dupes = pages.filter((r) => r.value && onOrder.has(key(r.value)));
      const found = pages
        .filter((r) => !(r.value && onOrder.has(key(r.value))))
        .map((r) => ({ trackingNumber: r.value || '', carrierKey: r.carrierKey || null }));
      setPdfFile(file); setPdfPages(results);
      setStoreSheet(!hasSheet);   // nothing to lose when the order has no sheet yet
      // Keep whatever's already been typed; append the imported rows after it.
      setRows((ls) => [...(ls || []).filter((l) => String(l.trackingNumber || '').trim()), ...found]);
      const carrierCount = found.filter((r) => r.carrierKey).length;
      setPdfStatus(undecidable
        ? `Read ${pages.length} label${pages.length === 1 ? '' : 's'} — no tracking number could be read from any page. Fill them in below.`
        : `Added ${found.length} label${found.length === 1 ? '' : 's'} from ${results.length} pages`
          + `${carrierCount ? `, detected ${carrierCount} courier${carrierCount === 1 ? '' : 's'}` : ''}.`
          + `${dupes.length ? ` ${dupes.length} page${dupes.length === 1 ? '' : 's'} already on this order, skipped.` : ''}`
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

  const submit = async () => {
    const cleaned = (rows || []).map((l) => ({ trackingNumber: String(l.trackingNumber || '').trim(), carrierKey: l.carrierKey || null }))
      .filter((l) => l.trackingNumber);
    if (!cleaned.length) { setError('Enter at least one tracking number.'); return; }
    setBusy(true); setError('');
    try {
      await api.poLabelAdd(po.id, cleaned);
      // Store the sheet AFTER the labels exist — attachPoLabels maps its pages by tracking
      // number, so a page for a label that isn't on the order yet would map to nothing.
      if (pdfFile && storeSheet) {
        setPdfStatus('Saving the labels PDF…');
        const { key: objKey, url } = await api.poLabelsSign(po.id);
        const put = await fetch(url, { method: 'PUT', body: pdfFile, headers: { 'Content-Type': 'application/pdf' } });
        if (!put.ok) throw new Error(`Upload failed (${put.status})`);
        await api.poLabelsAttach({
          poId: po.id, key: objKey, name: pdfFile.name, pages: pdfPages.length,
          pageMap: pdfPages.filter((x) => x.value).map((x) => ({ tracking: x.value, page: x.page })),
        });
      }
      close();
      onChanged?.();
    } catch (e) {
      if (e.unauthorized) return onSignOut?.();
      // The labels are on the order by this point if the failure came from the upload —
      // say so, rather than leaving it looking like nothing happened.
      setError(pdfFile && storeSheet ? `The labels were added, but the PDF could not be saved (${e.message}).` : e.message);
      onChanged?.();
    } finally { setBusy(false); }
  };

  if (rows == null) {
    return (
      <button type="button" className="btn sm po-add-label-btn" onClick={() => setRows([{ trackingNumber: '', carrierKey: null }])}>
        + Add label
      </button>
    );
  }
  return (
    <div className="po-edit-form">
      {error && <div className="po-err">{error}</div>}
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
      {pdfStatus && <p className="po-pdf-status sm">{pdfStatus}</p>}
      {pdfFile && (
        <label className="po-store-sheet">
          <input type="checkbox" checked={storeSheet} onChange={(e) => setStoreSheet(e.target.checked)} />
          <span>
            Save this PDF as the order's labels file
            {hasSheet
              ? <span className="muted sm"> — replaces the sheet already on file, and any label not in this PDF can no longer be printed from here.</span>
              : <span className="muted sm"> — lets the supplier print each box's own label.</span>}
          </span>
        </label>
      )}
      <div className="po-label-rows">
        {rows.map((l, i) => (
          <div className="po-label-row" key={i}>
            <span className="po-label-n">new</span>
            <input value={l.trackingNumber} maxLength={120} placeholder="Tracking number"
              autoCapitalize="characters" autoCorrect="off" onChange={(e) => set(i, { trackingNumber: e.target.value })} />
            <select className="po-label-carrier" value={l.carrierKey ?? ''} title="Courier"
              onChange={(e) => set(i, { carrierKey: e.target.value ? Number(e.target.value) : null })}>
              <option value="">— Select courier —</option>
              {CARRIERS.map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}
            </select>
            <button type="button" className="btn sm ghost po-label-x" title="Remove row" disabled={rows.length <= 1}
              onClick={() => setRows((r) => r.filter((_, j) => j !== i))} aria-label="Remove row">×</button>
          </div>
        ))}
      </div>
      <div className="po-edit-actions">
        <button type="button" className="btn ghost sm" onClick={() => setRows((r) => [...r, { trackingNumber: '', carrierKey: null }])}>+ Another</button>
        <button type="button" className="btn ghost sm" disabled={busy} onClick={close}>Cancel</button>
        <button type="button" className="btn primary sm" disabled={busy} onClick={submit}>{busy ? 'Adding…' : 'Add to order'}</button>
      </div>
    </div>
  );
}

/* Per-label tools: fix the tracking number, move the label to another order, remove it.
   `received` is what the warehouse has counted into this label's box — it decides whether
   removing is even offered. */
export function PoLabelTools({ po, box, pos = [], received = 0, onChanged, onSignOut }) {
  const [mode, setMode] = useState(null);   // 'edit' | 'move' | 'remove'
  if (!poEditable(po)) return null;
  const close = () => setMode(null);
  const done = () => { setMode(null); onChanged?.(); };
  return (
    <>
      <button type="button" className="btn ghost sm" onClick={() => setMode('edit')}><Icon name="pencil" /> Tracking #</button>
      <button type="button" className="btn ghost sm" onClick={() => setMode('move')}>Move…</button>
      <button type="button" className="btn ghost sm danger" onClick={() => setMode('remove')}>Remove</button>
      {mode === 'edit' && <LabelEditModal box={box} onClose={close} onDone={done} onSignOut={onSignOut} />}
      {mode === 'move' && <LabelMoveModal po={po} box={box} pos={pos} received={received} onClose={close} onDone={done} onSignOut={onSignOut} />}
      {mode === 'remove' && (
        <LabelRemoveModal box={box} received={received} onClose={close} onDone={done} onSignOut={onSignOut}
          onMoveInstead={() => setMode('move')} />
      )}
    </>
  );
}

function LabelEditModal({ box, onClose, onDone, onSignOut }) {
  const [tracking, setTracking] = useState(box.tracking_number || '');
  const [carrierKey, setCarrierKey] = useState(box.carrier_key ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    setBusy(true); setError('');
    try {
      await api.poLabelUpdate(box.id, { trackingNumber: tracking.trim(), carrierKey: carrierKey === '' ? null : Number(carrierKey) });
      onDone();
    } catch (e) {
      if (e.unauthorized) return onSignOut?.();
      setError(e.message); setBusy(false);
    }
  };
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal po-label-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">Label {box.box_number} tracking number</h3>
        {error && <div className="po-err">{error}</div>}
        <p className="muted sm">
          This number is what ties the label to the box the warehouse receives, what the labels
          PDF maps its pages by, and what the courier is watched on — so a typo here is a parcel
          nobody is tracking.
        </p>
        <div className="batch-form">
          <label>Tracking number
            <input value={tracking} maxLength={120} autoCapitalize="characters" autoCorrect="off"
              onChange={(e) => setTracking(e.target.value)} />
          </label>
          <label>Courier
            <select value={carrierKey ?? ''} onChange={(e) => setCarrierKey(e.target.value)}>
              <option value="">— Select courier —</option>
              {CARRIERS.map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}
            </select>
          </label>
        </div>
        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}

function LabelRemoveModal({ box, received, onClose, onDone, onSignOut, onMoveInstead }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [mustMove, setMustMove] = useState(received > 0);
  const remove = async () => {
    setBusy(true); setError('');
    try {
      await api.poLabelRemove(box.id, text.trim());
      onDone();
    } catch (e) {
      if (e.unauthorized) return onSignOut?.();
      if (e.data?.mustMove) setMustMove(true);
      setError(e.message); setBusy(false);
    }
  };
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal po-label-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">Remove label {box.box_number}?</h3>
        {error && <div className="po-err">{error}</div>}
        {mustMove ? (
          <>
            {/* The record of what physically arrived outlives the paperwork it was filed
                under. There is no "delete anyway" here on purpose. */}
            <p className="modal-msg">
              <b>{received || 'Some'} pair(s)</b> have already been counted into this label's box.
              It can't be deleted — move it to the order it really belongs to instead, and the
              received stock goes with it.
            </p>
            <div className="modal-actions">
              <button className="btn ghost" onClick={onClose}>Cancel</button>
              <button className="btn primary" onClick={onMoveInstead}>Move it instead</button>
            </div>
          </>
        ) : (
          <>
            <p className="modal-msg">
              {box.tracking_number || 'No tracking number'} · anything declared for this label goes
              with it. There is no undo.
            </p>
            <label className="po-confirm">
              <span className="muted sm">Type <b>{box.box_number}</b> to confirm</span>
              <input value={text} onChange={(e) => setText(e.target.value)} placeholder={String(box.box_number)} />
            </label>
            <div className="modal-actions">
              <button className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
              <button className="btn danger" onClick={remove} disabled={busy || text.trim() !== String(box.box_number)}>
                {busy ? 'Removing…' : 'Remove label'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function LabelMoveModal({ po, box, pos, received, onClose, onDone, onSignOut }) {
  const [target, setTarget] = useState('');      // '' | poId | '__new__'
  const [supplierName, setSupplierName] = useState(po.supplier_name || '');
  const [tagCode, setTagCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  // Only orders that can still take a label: a settled one has agreed its count.
  const options = (pos || []).filter((p) => Number(p.id) !== Number(po.id) && !FROZEN.includes(p.status));

  const move = async () => {
    setBusy(true); setError('');
    try {
      const payload = target === '__new__'
        ? { newPo: { supplierName: supplierName.trim(), tagCode: tagCode.trim() } }
        : { targetPoId: Number(target) };
      const r = await api.poLabelMove(box.id, payload);
      setResult(r);
    } catch (e) {
      if (e.unauthorized) return onSignOut?.();
      setError(e.message); setBusy(false);
    }
  };

  if (result) {
    return (
      <div className="modal-overlay" onClick={onDone}>
        <div className="modal po-label-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
          <h3 className="modal-title">Moved to {result.to?.po_code}</h3>
          <p className="modal-msg">
            It's label {result.boxNumber} there{result.units ? `, and the ${result.units} pair(s) already received on it moved with it` : ''}.
            {result.createdBatch ? ` Their box landed in a new receiving batch, ${result.createdBatch}.` : ''}
          </p>
          <div className="modal-actions"><button className="btn primary" onClick={onDone}>Done</button></div>
        </div>
      </div>
    );
  }
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal po-label-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">Move label {box.box_number}</h3>
        {error && <div className="po-err">{error}</div>}
        <p className="muted sm">
          {box.tracking_number || 'No tracking number'} · its declared lines go with it
          {received > 0 ? `, and so do the ${received} pair(s) the warehouse has already counted into it` : ''}.
        </p>
        <div className="batch-form">
          <label className="batch-form-wide">Move to
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">Select an order…</option>
              <option value="__new__">➕ A new order for this label</option>
              {options.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.po_code} · {p.supplier_name}{p.tag_code ? ` · ${p.tag_code}` : ''}
                </option>
              ))}
            </select>
          </label>
          {target === '__new__' && (
            <>
              <label>Supplier
                <input value={supplierName} maxLength={120} onChange={(e) => setSupplierName(e.target.value)} />
              </label>
              <label>Tag / code name
                <input value={tagCode} maxLength={120} placeholder="Optional" onChange={(e) => setTagCode(e.target.value)} />
              </label>
            </>
          )}
        </div>
        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" onClick={move} disabled={busy || !target}>{busy ? 'Moving…' : 'Move label'}</button>
        </div>
      </div>
    </div>
  );
}
