// The drop-off receipt on a purchase order: proof a box was handed to the courier. The supplier
// uploads it, or our team does for them. Staff can ask for it on Telegram once a box has left.
import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useLive } from '../hooks.js';
import { ImageZoomModal } from './common.jsx';
import { estDate, estTime } from '../lib/format.js';

const MAX_BYTES = 15 * 1024 * 1024;
export const hasDroppedOff = (boxes) => (boxes || []).some((b) => ['shipped', 'in_transit', 'delivered'].includes(b.status));

export function PoDropoffChip({ po, supplier = false }) {
  const dropped = Number(po?.shipped_count) > 0;
  if (!dropped || Number(po?.dropoff_receipt_count) > 0 || ['reconciled', 'closed'].includes(po?.status)) return null;
  return <span className="po-chip dropoff-missing">{supplier ? 'Upload drop-off receipt' : 'No drop-off receipt'}</span>;
}

// Reads the order itself, so it works the same on all three pages that show it, and a supplier's
// upload appears on the team's open page without a refresh.
export function PoDropoffReceipts({ po, isSupplier = false, onSignOut }) {
  const input = useRef(null);
  const [data, setData] = useState(null);
  const poId = po?.id;
  const reload = () => api.poGet(poId).then(setData).catch((ex) => { if (ex.unauthorized) onSignOut?.(); });
  useEffect(() => { setData(null); if (poId) reload(); }, [poId]); // eslint-disable-line react-hooks/exhaustive-deps
  useLive(['po_dropoff_receipts', 'po_boxes'], reload, { mount: false, minGap: 3000 });
  const boxes = data?.boxes || [];
  const receipts = data?.dropoffReceipts || [];
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [done, setDone] = useState('');
  const [view, setView] = useState(null);     // { url, label }
  const dropped = hasDroppedOff(boxes);
  const fail = (ex) => { if (ex.unauthorized) return onSignOut?.(); setErr(ex.message); };

  // Boxes are often dropped off over several days (7, then 10, then 13), so an order holds
  // many receipts — and several can be picked or dropped at once. Each file becomes its own
  // receipt, one after another; a file that fails says so without losing the others.
  async function uploadFiles(list) {
    const files = [...(list || [])];
    if (!files.length) return;
    setErr(''); setDone('');
    let saved = 0;
    const problems = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file.size > MAX_BYTES) { problems.push(`${file.name}: over 15 MB — try a smaller photo`); continue; }
      setBusy(files.length > 1 ? `Uploading ${i + 1} of ${files.length}…` : 'upload');
      try {
        const { uploadUrl, key } = await api.poDropoffSign(po.id, file.type);
        const put = await fetch(uploadUrl, { method: 'PUT', body: file });
        if (!put.ok) throw new Error('the upload did not go through — try again');
        await api.poDropoffAttach({ poId: po.id, key, name: file.name, contentType: file.type, sizeBytes: file.size });
        saved++;
      } catch (ex) {
        if (ex.unauthorized) { setBusy(''); return onSignOut?.(); }
        problems.push(`${file.name}: ${ex.message}`);
      }
    }
    setBusy('');
    if (saved) setDone(saved === 1 ? 'Receipt saved.' : `${saved} receipts saved.`);
    if (problems.length) setErr(`Not saved — ${problems.join('; ')}`);
    await reload();
  }
  const upload = (e) => { const list = [...(e.target.files || [])]; e.target.value = ''; uploadFiles(list); };
  const [dragOver, setDragOver] = useState(false);
  const onDrop = (e) => {
    e.preventDefault(); setDragOver(false);
    if (busy) return;
    uploadFiles(e.dataTransfer?.files);
  };
  const uploading = busy === 'upload' || busy.startsWith('Uploading');

  async function open(r) {
    setBusy(`view${r.id}`); setErr('');
    try {
      const { blob, filename } = await api.poDropoffFile(r.id);
      const url = URL.createObjectURL(blob);
      if (String(r.content_type).startsWith('image/')) setView({ url, label: r.name || 'Drop-off receipt' });
      else {
        const a = document.createElement('a');
        a.href = url; a.download = filename || r.name || 'dropoff-receipt.pdf';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      }
    } catch (ex) { fail(ex); } finally { setBusy(''); }
  }

  async function remove(r) {
    setBusy(`rm${r.id}`); setErr('');
    try { await api.poDropoffDelete(po.id, r.id); await reload(); } catch (ex) { fail(ex); } finally { setBusy(''); }
  }

  async function ask() {
    setBusy('ask'); setErr(''); setDone('');
    try {
      const r = await api.nudge('po', po.id, 'supplier', `Please upload the drop-off receipt for ${po.po_code}.`);
      setDone(r.sentTo?.length ? `Asked ${r.sentTo.join(', ')} on Telegram.` : 'They aren’t on Telegram, so nothing was sent. Message them another way.');
    } catch (ex) { fail(ex); } finally { setBusy(''); }
  }

  // A supplier only reaches their own orders, so a supplier's upload here is theirs.
  const canRemove = (r) => !isSupplier || r.uploaded_role === 'supplier';

  return (
    <section className={`po-dropoff${dragOver ? ' drag' : ''}`} aria-label="Drop-off receipt"
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragEnter={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}>
      <div className="po-dropoff-h">
        <b>Drop-off receipt{receipts.length > 1 ? `s (${receipts.length})` : ''}</b>
        {!receipts.length && (
          <span className={dropped ? 'po-chip dropoff-missing' : 'muted sm'}>
            {dropped ? (isSupplier ? 'Please upload it' : 'Not in yet') : 'Needed once a box is dropped off'}
          </span>
        )}
        <span className="po-dropoff-actions">
          {!isSupplier && dropped && !receipts.length && (
            <button type="button" className="btn sm ghost" disabled={busy === 'ask'} onClick={ask}>
              {busy === 'ask' ? 'Asking…' : 'Ask supplier'}
            </button>
          )}
          <button type="button" className="btn sm" disabled={uploading} onClick={() => input.current?.click()}>
            {uploading ? (busy === 'upload' ? 'Uploading…' : busy) : receipts.length ? 'Add another' : 'Upload receipt'}
          </button>
          {/* multiple: one drop-off a day for three days is three receipts, often sent together. */}
          <input ref={input} type="file" accept="image/*,application/pdf" multiple hidden onChange={upload} aria-label="Upload drop-off receipts" />
        </span>
      </div>
      {receipts.length > 0 && (
        <ul className="po-dropoff-list">
          {receipts.map((r) => (
            <li key={r.id}>
              <span className="po-dropoff-name">{r.name || 'Drop-off receipt'}</span>
              <span className="muted xs">{r.uploaded_by || ''} · {estDate(r.uploaded_at)} {estTime(r.uploaded_at)} EST</span>
              <button type="button" className="btn sm ghost" disabled={busy === `view${r.id}`} onClick={() => open(r)}>
                {String(r.content_type).startsWith('image/') ? 'View' : 'Download'}
              </button>
              {canRemove(r) && (
                <button type="button" className="btn sm ghost" disabled={busy === `rm${r.id}`} onClick={() => remove(r)}>Remove</button>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="muted xs">One receipt per drop-off — pick several at once, or drop them on this box.</p>
      {done && <p className="muted sm" role="status">{done}</p>}
      {err && <p className="error sm">{err}</p>}
      {view && <ImageZoomModal url={view.url} label={view.label} onClose={() => { URL.revokeObjectURL(view.url); setView(null); }} />}
    </section>
  );
}
