// The courier's labels PDF for a purchase order.
//
// It used to be read for its tracking numbers and thrown away ("the shipping labels
// themselves are never stored"), which left the supplier hunting through email for the
// label belonging to the box in front of them. It's kept in R2 now, and they can pull
// the whole sheet or just their box's page.
//
// Downloads go through the server, never a public URL: these carry the ship-to address
// and a live courier barcode. See api/po/label-download.js.
import React, { useRef, useState } from 'react';
import { api } from '../api.js';
import { Icon } from './NavIcons.jsx';

// Save a { blob, filename } from the API to disk.
function saveBlob({ blob, filename }) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// One label's page. Hidden when that label has no page mapped — a download that 404s is
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

// The whole sheet + (for staff) attaching or replacing it.
export function PoLabelsFile({ po, canUpload = false, onChanged, onSignOut }) {
  const fileRef = useRef(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const has = !!po?.labels_pages || !!po?.labels_key || !!po?.labels_uploaded_at;

  const downloadAll = async () => {
    setBusy('down'); setError('');
    try { saveBlob(await api.poLabelDownload(po.id)); }
    catch (e) { if (e.unauthorized) return onSignOut?.(); setError(e.message); }
    finally { setBusy(''); }
  };

  // Read the pages for their tracking numbers, upload the file as-is, then map page →
  // label BY TRACKING NUMBER (never page order — the rows may have been reordered or
  // typed by hand, and a label pointing at someone else's page is worse than none).
  const upload = async (file) => {
    if (!file) return;
    setError(''); setBusy('read');
    try {
      const { decodeTrackingPdf } = await import('../trackingOcr.js');
      const pages = await decodeTrackingPdf(file, (p, n) => setBusy(`Reading page ${p} of ${n}…`));
      const pageMap = pages.filter((r) => r.value).map((r) => ({ tracking: r.value, page: r.page }));

      setBusy('Uploading…');
      const { key, url } = await api.poLabelsSign(po.id);
      const put = await fetch(url, { method: 'PUT', body: file, headers: { 'Content-Type': 'application/pdf' } });
      if (!put.ok) throw new Error(`Upload failed (${put.status})`);

      const r = await api.poLabelsAttach({ poId: po.id, key, name: file.name, pages: pages.length, pageMap });
      onChanged?.(r);
      if (!r.matched) {
        setError(`Saved ${pages.length} page${pages.length === 1 ? '' : 's'}, but none matched a label's tracking number — `
          + 'the whole sheet downloads, single labels will not.');
      } else if (r.matched < pages.length) {
        setError(`Saved. ${r.matched} of ${pages.length} pages matched a label — the rest are in the full sheet only.`);
      }
    } catch (e) {
      if (e.unauthorized) return onSignOut?.();
      setError(e.message);
    } finally { setBusy(''); }
  };

  if (!has && !canUpload) return null;
  return (
    <div className="po-labels-file">
      <div className="po-labels-head">
        <b>Shipping labels</b>
        {has
          ? <span className="muted xs">{po.labels_pages ? `${po.labels_pages} page${po.labels_pages === 1 ? '' : 's'}` : 'PDF on file'}
            {po.labels_uploaded_by ? ` · added by ${po.labels_uploaded_by}` : ''}</span>
          : <span className="muted xs">Not uploaded yet — the supplier has no label to print from here.</span>}
      </div>
      <div className="po-labels-actions">
        {has && (
          <button type="button" className="btn sm" disabled={!!busy} onClick={downloadAll}>
            <Icon name="download" /> {busy === 'down' ? 'Fetching…' : 'Download all labels'}
          </button>
        )}
        {canUpload && (
          <>
            <input ref={fileRef} type="file" accept="application/pdf" hidden
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; upload(f); }} />
            <button type="button" className="btn sm ghost" disabled={!!busy} onClick={() => fileRef.current?.click()}>
              <Icon name="box" /> {has ? 'Replace labels PDF' : 'Upload labels PDF'}
            </button>
          </>
        )}
      </div>
      {busy && busy !== 'down' && <p className="muted xs">{busy === 'read' ? 'Reading PDF…' : busy}</p>}
      {error && <p className="po-labels-note sm">{error}</p>}
    </div>
  );
}
