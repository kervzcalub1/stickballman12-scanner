// Putting courier tracking numbers onto boxes the supplier already declared.
//
// This is the manifest-first flow's counterpart to raising an order FROM its labels. The
// boxes exist and are packed; what they lack is a number. PH drops in the sheet bought
// from the courier, the tracking numbers are read off each page exactly as they are when
// creating an order, and each one is put on a box.
//
// THE MAPPING IS A DECISION, NOT A DERIVATION. A numberless box has nothing to match a
// page against, so page order is only a sensible default — page 1 → box 1 — and the whole
// mapping is shown for a person to confirm, with every row changeable. That is the
// opposite of `attachPoLabels`, which maps a stored PDF's pages onto labels that already
// carry numbers and must never use page order (a label pointing at someone else's page is
// worse than no label at all).
import React, { useState } from 'react';
import { api } from '../api.js';
import { Icon } from './NavIcons.jsx';
import { CARRIERS } from '../lib/carriers.js';

export function PoAssignLabels({ po, boxes, onDone, onSignOut }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState([]);        // [{ boxId, trackingNumber, carrierKey }]
  const [pdfFile, setPdfFile] = useState(null);
  const [pdfPages, setPdfPages] = useState([]);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [storeSheet, setStoreSheet] = useState(true);

  // Only the supplier's own boxes, and only ones that can still take a label: a box the
  // carrier already has is not waiting for a number.
  const open_ = boxes.filter((b) => b.kind !== 'replacement' && ['pending', 'packed'].includes(b.status));
  const unlabelled = open_.filter((b) => !b.tracking_number);
  if (!open_.length) return null;

  const start = () => {
    setOpen(true); setError(''); setStatus('');
    setRows(open_.map((b) => ({ boxId: Number(b.id), boxNumber: b.box_number, trackingNumber: b.tracking_number || '', carrierKey: b.carrier_key || null })));
  };
  const close = () => { setOpen(false); setRows([]); setPdfFile(null); setPdfPages([]); setStatus(''); setError(''); };
  const setRow = (i, patch) => setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  // Read the sheet, then lay its labels onto the boxes IN ORDER. Boxes that already carry
  // a number are skipped rather than overwritten — a second sheet for two extra boxes is
  // the normal way this gets used.
  const importPdf = async (file) => {
    if (!file) return;
    setError(''); setStatus('Reading PDF…');
    try {
      const { decodeTrackingPdf, labelPagesOnly } = await import('../trackingOcr.js');
      const results = await decodeTrackingPdf(file, (p, n) => setStatus(`Reading page ${p} of ${n}…`));
      const { labels: pages, skipped, undecidable } = labelPagesOnly(results);
      const found = pages.filter((r) => r.value);
      setPdfFile(file); setPdfPages(results);
      setRows((rs) => {
        let k = 0;
        return rs.map((r) => (r.trackingNumber ? r : (found[k]
          ? { ...r, trackingNumber: found[k].value, carrierKey: found[k].carrierKey || r.carrierKey, _from: `page ${found[k++].page}` }
          : r)));
      });
      setStatus(undecidable
        ? `No tracking number could be read from any page — type them in below.`
        : `Read ${found.length} label${found.length === 1 ? '' : 's'} from ${results.length} pages`
          + `${skipped.length ? `, skipped ${skipped.length} packing slip${skipped.length === 1 ? '' : 's'}` : ''}.`
          + ` Laid onto the boxes in order — check each row before saving.`);
    } catch (e) {
      setStatus(''); setError(`Could not read that PDF. ${e.message || ''}`.trim());
    }
  };
  const onDrop = (e) => {
    e.preventDefault(); setDragOver(false);
    const f = [...(e.dataTransfer?.files || [])].find((x) => x.type === 'application/pdf' || /\.pdf$/i.test(x.name));
    if (!f) { setError('Drop a PDF of shipping labels.'); return; }
    importPdf(f);
  };

  const save = async () => {
    const assignments = rows
      .filter((r) => r.trackingNumber.trim())
      .map((r) => ({ boxId: r.boxId, trackingNumber: r.trackingNumber.trim(), carrierKey: r.carrierKey || null }));
    if (!assignments.length) { setError('Nothing to assign yet.'); return; }
    setBusy(true); setError('');
    try {
      await api.poAssignLabels(po.id, assignments);
      // The sheet itself, stored against the order so the supplier can print the label for
      // the box they're sealing. Attached AFTER the numbers land, because the page↔label
      // map is keyed on the tracking number — before this it would match nothing.
      if (pdfFile && storeSheet) {
        try {
          setStatus('Saving the labels PDF…');
          const { key, url } = await api.poLabelsSign(po.id);
          const put = await fetch(url, { method: 'PUT', body: pdfFile, headers: { 'Content-Type': 'application/pdf' } });
          if (!put.ok) throw new Error(`Upload failed (${put.status})`);
          await api.poLabelsAttach({
            poId: po.id, key, name: pdfFile.name, pages: pdfPages.length,
            pageMap: pdfPages.filter((x) => x.value).map((x) => ({ tracking: x.value, page: x.page })),
          });
        } catch (e) {
          setError(`Labels assigned, but the PDF could not be stored (${e.message}). Attach it from “Shipping labels”.`);
        }
      }
      close(); onDone?.();
    } catch (e) {
      if (e.unauthorized) return onSignOut?.();
      setError(e.message);
    } finally { setBusy(false); }
  };

  if (!open) {
    return (
      <button type="button" className={`btn sm ${unlabelled.length ? 'primary' : 'ghost'} po-assign-btn`} onClick={start}>
        <Icon name="tag" /> {unlabelled.length
          ? `Assign labels to ${unlabelled.length} box${unlabelled.length === 1 ? '' : 'es'}`
          : 'Reassign labels'}
      </button>
    );
  }
  return (
    <div className="po-edit-form po-assign">
      {error && <div className="po-err">{error}</div>}
      <p className="muted sm">
        Drop the sheet you bought from the courier. Its tracking numbers are read off each page and laid
        onto the boxes <b>in order</b> — page 1 onto box 1. <b>Check every row before saving</b>: if the
        courier returned the pages in a different order, this is the only place to catch it.
      </p>
      <label className={`po-dropzone${dragOver ? ' drag' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragEnter={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)} onDrop={onDrop}>
        <input type="file" accept="application/pdf" hidden
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; importPdf(f); }} />
        <span className="po-dropzone-icon">📄</span>
        <span className="po-dropzone-text"><b>Drag &amp; drop the labels PDF</b>, or <span className="po-dropzone-link">browse</span></span>
        <span className="muted sm">Or type the numbers in by hand below.</span>
      </label>
      {status && <p className="po-pdf-status sm">{status}</p>}

      <div className="po-assign-rows">
        {rows.map((r, i) => (
          <div className="po-assign-row" key={r.boxId}>
            <span className="po-assign-box">Box {r.boxNumber}</span>
            <input value={r.trackingNumber} placeholder="Tracking number" maxLength={120}
              autoCapitalize="characters" autoCorrect="off"
              onChange={(e) => setRow(i, { trackingNumber: e.target.value, _from: null })} />
            <select className="po-label-carrier" value={r.carrierKey ?? ''} title="Courier"
              onChange={(e) => setRow(i, { carrierKey: e.target.value ? Number(e.target.value) : null })}>
              <option value="">— Courier —</option>
              {CARRIERS.map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}
            </select>
            {r._from && <span className="muted xs po-assign-from">{r._from}</span>}
          </div>
        ))}
      </div>

      {pdfFile && (
        <label className="po-assign-store">
          <input type="checkbox" checked={storeSheet} onChange={(e) => setStoreSheet(e.target.checked)} />
          Store this PDF on the order so the supplier can print each box’s label
        </label>
      )}
      <div className="po-edit-actions">
        <button type="button" className="btn ghost sm" disabled={busy} onClick={close}>Cancel</button>
        <button type="button" className="btn primary sm" disabled={busy} onClick={save}>
          {busy ? 'Saving…' : `Assign ${rows.filter((r) => r.trackingNumber.trim()).length} label(s)`}
        </button>
      </div>
    </div>
  );
}
