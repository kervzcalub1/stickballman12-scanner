// The courier's labels PDFs for a purchase order.
//
// They used to be read for their tracking numbers and thrown away ("the shipping labels
// themselves are never stored"), which left the supplier hunting through email for the
// label belonging to the box in front of them. They're kept in R2 now, and the supplier
// can pull every label on the order or just their box's page.
//
// An order holds SEVERAL files (2026-11-12): labels are bought in parts — a supplier asks
// for 30 and wants 7 first — so each upload ADDS a file and never replaces one. A label
// prints from the newest file that carries it (see attachPoLabels).
//
// Downloads go through the server, never a public URL: these carry the ship-to address
// and a live courier barcode. See api/po/label-download.js.
import React, { useRef, useState } from 'react';
import { api } from '../api.js';
import { Icon } from './NavIcons.jsx';
import { estDate, estTime } from '../lib/format.js';

// Save a { blob, filename } from the API to disk.
function saveBlob({ blob, filename }) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const isPdf = (f) => f && (f.type === 'application/pdf' || /\.pdf$/i.test(f.name || ''));

// Store ONE labels PDF against an order: presigned PUT straight to R2, then map its pages
// to the order's labels BY TRACKING NUMBER (never page order — rows get reordered or typed
// by hand, and a label pointing at someone else's page is worse than none). `pages` is
// decodeTrackingPdf's [{ page, value }]; only pages that ARE labels get mapped, and the
// packing slips between them ride along in the stored file with the label they follow.
// Every caller (create order, add labels, assign labels, the labels panel) goes through here.
export async function saveLabelsSheet(poId, file, pages) {
  const { key, url } = await api.poLabelsSign(poId);
  const put = await fetch(url, { method: 'PUT', body: file, headers: { 'Content-Type': 'application/pdf' } });
  if (!put.ok) throw new Error(`Upload failed (${put.status})`);
  return api.poLabelsAttach({
    poId, key, name: file.name, pages: pages.length,
    pageMap: pages.filter((x) => x.value).map((x) => ({ tracking: x.value, page: x.page })),
  });
}

// One label's pages. Hidden when that label has no page mapped — a download that 404s is
// worse than no button.
export function PoLabelDownload({ poId, box, label = 'Print label', onSignOut }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!box?.label_page) return null;
  const go = async () => {
    setBusy(true); setError('');
    try { saveBlob(await api.poLabelDownload(poId, box.id)); }
    catch (e) { if (e.unauthorized) return onSignOut?.(); setError(e.message); }
    finally { setBusy(false); }
  };
  return (
    <>
      <button type="button" className="btn sm" disabled={busy} onClick={go}>
        <Icon name="download" /> {busy ? 'Fetching…' : label}
      </button>
      {error && <span className="error sm">{error}</span>}
    </>
  );
}

// Every file on the order + (for staff) adding more or removing one.
// `files` = po/get's `labelFiles` ([{ id, name, pages, labels, uploaded_by, uploaded_at }]).
export function PoLabelsFile({ po, files = [], canUpload = false, onChanged, onSignOut }) {
  const fileRef = useRef(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const has = files.length > 0;
  const fail = (e) => { if (e.unauthorized) { onSignOut?.(); return true; } setError(e.message); return false; };

  const download = async (fileId = null) => {
    setBusy(fileId ? `down${fileId}` : 'down'); setError('');
    try { saveBlob(await api.poLabelDownload(po.id, null, fileId)); }
    catch (e) { fail(e); }
    finally { setBusy(''); }
  };

  // One or several PDFs, each read for its tracking numbers and stored as its OWN file,
  // one after another. A file that fails says which — the others are still saved.
  const upload = async (list) => {
    const all = [...(list || [])];
    const pdfs = all.filter(isPdf);
    if (!pdfs.length) { if (all.length) setError('Pick a PDF file of shipping labels.'); return; }
    setError(''); setNote('');
    const notes = [];
    const { decodeTrackingPdf } = await import('../trackingOcr.js');
    for (let i = 0; i < pdfs.length; i++) {
      const file = pdfs[i];
      const of = pdfs.length > 1 ? ` (${i + 1} of ${pdfs.length}: ${file.name})` : '';
      try {
        setBusy(`Reading PDF${of}…`);
        const pages = await decodeTrackingPdf(file, (p, n) => setBusy(`Reading page ${p} of ${n}${of}…`));
        setBusy(`Uploading${of}…`);
        const r = await saveLabelsSheet(po.id, file, pages);
        const n = pages.length;
        const name = pdfs.length > 1 ? `${file.name}: ` : '';
        if (!r.matched) {
          notes.push(`${name}saved ${n} page${n === 1 ? '' : 's'}, but none matched a label's tracking number — `
            + 'it downloads whole, single labels from it will not.');
        } else if (pdfs.length > 1) {
          notes.push(`${name}saved — ${r.matched} label${r.matched === 1 ? '' : 's'} matched.`);
        } else if (r.matched < pages.filter((x) => x.value).length) {
          notes.push(`Saved. ${r.matched} of ${pages.filter((x) => x.value).length} labels in it are on this order.`);
        }
      } catch (e) {
        if (fail(e)) return;
        notes.push(`${file.name}: not saved (${e.message}).`);
      }
    }
    if (all.length > pdfs.length) notes.push(`${all.length - pdfs.length} file${all.length - pdfs.length === 1 ? ' was' : 's were'} not a PDF and skipped.`);
    setBusy('');
    setNote(notes.join(' '));
    onChanged?.();
  };

  const remove = async (f) => {
    const msg = `Delete “${f.name || 'labels PDF'}”?`
      + (f.labels ? ` ${f.labels} label${f.labels === 1 ? '' : 's'} print from it — they can’t be printed from here after this unless another file has them.` : '');
    if (!window.confirm(msg)) return;
    setBusy(`rm${f.id}`); setError(''); setNote('');
    try {
      const r = await api.poLabelsRemove(po.id, f.id);
      if (r.remapped) setNote(`Deleted. ${r.remapped} label${r.remapped === 1 ? '' : 's'} now print from an older file that also has ${r.remapped === 1 ? 'it' : 'them'}.`);
      onChanged?.();
    } catch (e) { fail(e); }
    finally { setBusy(''); }
  };

  const onDrop = (e) => {
    e.preventDefault(); setDragOver(false);
    if (!canUpload || busy) return;
    upload(e.dataTransfer?.files);
  };
  const reading = busy && !busy.startsWith('down') && !busy.startsWith('rm');
  const totalPages = files.reduce((t, f) => t + (Number(f.pages) || 0), 0);

  if (!has && !canUpload) return null;
  return (
    <div className={`po-labels-file${dragOver ? ' drag' : ''}`}
      onDragOver={canUpload ? (e) => { e.preventDefault(); setDragOver(true); } : undefined}
      onDragEnter={canUpload ? (e) => { e.preventDefault(); setDragOver(true); } : undefined}
      onDragLeave={canUpload ? () => setDragOver(false) : undefined}
      onDrop={canUpload ? onDrop : undefined}>
      <div className="po-labels-head">
        <b>Shipping labels</b>
        {has
          ? <span className="muted xs">
            {files.length > 1 ? `${files.length} PDFs · ` : ''}{totalPages ? `${totalPages} page${totalPages === 1 ? '' : 's'}` : 'PDF on file'}
            {files.length === 1 && files[0].uploaded_by ? ` · added by ${files[0].uploaded_by}` : ''}</span>
          : <span className="muted xs">Not uploaded yet — the supplier has no label to print from here.</span>}
      </div>
      <div className="po-labels-actions">
        {has && (
          <button type="button" className="btn sm" disabled={!!busy} onClick={() => download()}>
            <Icon name="download" /> {busy === 'down' ? 'Fetching…' : 'Download all labels'}
          </button>
        )}
        {canUpload && (
          <>
            <input ref={fileRef} type="file" accept="application/pdf" multiple hidden aria-label="Add labels PDFs"
              onChange={(e) => { const l = [...(e.target.files || [])]; e.target.value = ''; upload(l); }} />
            <button type="button" className="btn sm ghost" disabled={!!busy} onClick={() => fileRef.current?.click()}>
              <Icon name="box" /> {has ? 'Add more labels PDFs' : 'Upload labels PDF'}
            </button>
          </>
        )}
      </div>
      {files.length > 1 && (
        <ul className="po-label-files">
          {files.map((f) => (
            <li key={f.id}>
              <span className="po-label-file-name">{f.name || 'Labels PDF'}</span>
              <span className="muted xs">
                {f.pages ? `${f.pages} page${f.pages === 1 ? '' : 's'} · ` : ''}
                {f.labels} label{f.labels === 1 ? '' : 's'} print from it
                {' · '}{f.uploaded_by ? `${f.uploaded_by} · ` : ''}{estDate(f.uploaded_at)} {estTime(f.uploaded_at)} EST
              </span>
              <button type="button" className="btn sm ghost" disabled={!!busy} onClick={() => download(f.id)}>
                {busy === `down${f.id}` ? 'Fetching…' : 'Download'}
              </button>
              {canUpload && (
                <button type="button" className="btn sm ghost danger" disabled={!!busy} onClick={() => remove(f)}>
                  {busy === `rm${f.id}` ? 'Deleting…' : 'Delete'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {files.length === 1 && canUpload && (
        <ul className="po-label-files">
          <li>
            <span className="po-label-file-name">{files[0].name || 'Labels PDF'}</span>
            <span className="muted xs">{estDate(files[0].uploaded_at)} {estTime(files[0].uploaded_at)} EST</span>
            <button type="button" className="btn sm ghost danger" disabled={!!busy} onClick={() => remove(files[0])}>
              {busy === `rm${files[0].id}` ? 'Deleting…' : 'Delete'}
            </button>
          </li>
        </ul>
      )}
      {canUpload && <p className="muted xs">Labels bought in parts? Add each PDF as it comes — pick several at once, or drop them here. Nothing already on file is replaced.</p>}
      {reading && <p className="muted xs">{busy}</p>}
      {note && <p className="po-labels-note sm">{note}</p>}
      {error && <p className="po-labels-note sm">{error}</p>}
    </div>
  );
}
