// PH Edited Photos (Phase 1) — the PH team uploads EDITED listing images per SKU.
// These live alongside the warehouse's raw shots (source='ph_edited' vs 'warehouse')
// and take precedence for the thumbnail + listing. Warehouse originals are shown
// here as read-only reference + download, and are never overwritten. Slots 1–5 are
// the standard angles; 6–7 are extra images that show only in the photo viewer
// (never a thumbnail). PH team + admin only. See docs/context/ph-report.md.
import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { compressImage } from '../lib/image.js';
import { TopBar } from '../components/common.jsx';
import { Icon } from '../components/NavIcons.jsx';

const ANGLE_SLOTS = [['side', 'Side'], ['diagonal', 'Diagonal'], ['outsole', 'Outsole'], ['top', 'Top'], ['rear', 'Rear']];
const EXTRA_SLOTS = [['extra1', 'Extra 1'], ['extra2', 'Extra 2']];
const ALL_SLOTS = [...ANGLE_SLOTS, ...EXTRA_SLOTS];

export function PhEditedPhotos({ onHome, onSignOut }) {
  const [skuInput, setSkuInput] = useState('');
  const [sku, setSku] = useState('');           // the loaded SKU
  const [edited, setEdited] = useState({});      // angle -> url (source='ph_edited')
  const [originals, setOriginals] = useState([]); // [{ angle, url }] (source='warehouse')
  const [configured, setConfigured] = useState(true);
  const [loading, setLoading] = useState(false);
  const [busySlot, setBusySlot] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const fileRefs = useRef({}); // angle -> input

  async function load(rawSku) {
    const s = String(rawSku || '').trim();
    if (!s) return;
    setLoading(true); setError(''); setNotice('');
    try {
      const { photos, configured: cfg } = await api.photoList(s);
      setConfigured(cfg);
      const ed = {}; const og = [];
      for (const p of photos || []) {
        if (p.source === 'ph_edited') ed[p.angle] = p.url;
        else og.push(p);
      }
      setEdited(ed); setOriginals(og); setSku(s);
    } catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setLoading(false); }
  }

  async function upload(angle, file) {
    if (!file || !sku) return;
    setBusySlot(angle); setError(''); setNotice('');
    try {
      const { blob, type } = await compressImage(file, { type: file.type || 'image/jpeg' });
      const { uploadUrl, publicUrl } = await api.photoSign(sku, angle, type, 'ph_edited');
      const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': type }, body: blob });
      if (!put.ok) throw new Error(`Upload failed (${put.status}). Check the R2 bucket CORS policy.`);
      await api.photoAttach(sku, angle, publicUrl, 'ph_edited');
      setEdited((e) => ({ ...e, [angle]: publicUrl }));
    } catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message || 'Could not upload the image.'); }
    finally { setBusySlot(null); }
  }

  async function remove(angle) {
    if (!sku) return;
    setBusySlot(angle); setError('');
    try {
      await api.photoRemove(sku, angle, 'ph_edited');
      setEdited((e) => { const n = { ...e }; delete n[angle]; return n; });
    } catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setBusySlot(null); }
  }

  async function downloadOriginals() {
    setNotice(''); setError('');
    try {
      const { blob, filename } = await api.photoDownload(sku, 'warehouse');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = filename || `${sku}-warehouse-photos.zip`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    } catch (err) { if (err.unauthorized) return onSignOut(); setError('Could not download the originals.'); }
  }

  const onPick = (angle, e) => { const f = e.target.files?.[0]; if (e.target) e.target.value = ''; if (f) upload(angle, f); };
  const editedCount = Object.keys(edited).length;

  return (
    <div className="app">
      <TopBar title="PH Edited Photos" onHome={onHome} onSignOut={onSignOut} />
      <div className="card">
        <p className="muted sm">
          Upload your <b>edited</b> listing images for a SKU. They’re used as the listing photos &amp; thumbnail,
          replacing the warehouse’s raw shots for display — the originals stay on file below for reference.
        </p>
        <form className="pe-skubar" onSubmit={(e) => { e.preventDefault(); load(skuInput); }}>
          <input className="pe-sku-input" placeholder="Enter a SKU (e.g. DZ5485-612)" autoCapitalize="characters"
            autoCorrect="off" value={skuInput} onChange={(e) => setSkuInput(e.target.value)} />
          <button type="submit" className="btn primary" disabled={loading || !skuInput.trim()}>{loading ? 'Loading…' : 'Load'}</button>
        </form>

        {error && <div className="error mt">{error}</div>}
        {notice && <div className="ok mt">{notice}</div>}

        {!sku ? (
          <p className="muted mt">Enter a SKU to upload its edited photos.</p>
        ) : !configured ? (
          <p className="muted mt">Photo storage isn’t set up yet — add the R2 env vars to enable uploads.</p>
        ) : (
          <>
            <div className="pe-head">
              <span className="pe-title">Edited images — <span className="mono">{sku}</span></span>
              <span className={`pe-count ${editedCount >= 5 ? 'ok' : ''}`}>{editedCount}/{ALL_SLOTS.length}</span>
            </div>
            <div className="pe-grid">
              {ALL_SLOTS.map(([angle, label]) => {
                const url = edited[angle];
                const isExtra = angle.startsWith('extra');
                const busy = busySlot === angle;
                return (
                  <div className={`pe-slot ${url ? 'filled' : ''} ${isExtra ? 'extra' : ''}`} key={angle}>
                    <button type="button" className="pe-slot-btn" disabled={busy}
                      onClick={() => fileRefs.current[angle]?.click()}
                      title={url ? `Replace ${label}` : `Upload ${label}`}>
                      {url ? <img src={url} alt={label} className="pe-thumb" />
                        : <span className="pe-slot-empty">{busy ? '…' : <><Icon name="image" /><span>{isExtra ? 'Extra' : 'Upload'}</span></>}</span>}
                    </button>
                    <span className="pe-slot-lbl">{label}{isExtra ? '' : ''}{url ? ' ✓' : ''}</span>
                    {url && <button type="button" className="pe-slot-x" title={`Remove ${label}`} disabled={busy} onClick={() => remove(angle)}>×</button>}
                    <input ref={(el) => { fileRefs.current[angle] = el; }} type="file" accept="image/*" hidden onChange={(e) => onPick(angle, e)} />
                  </div>
                );
              })}
            </div>
            <p className="muted sm pe-hint">Slots 6–7 (Extra) don’t appear as a thumbnail — they show when the listing photo is opened, and are downloadable.</p>

            <div className="pe-originals">
              <div className="pe-orig-head">
                <span className="pe-orig-lbl">Warehouse originals <span className="tag-ref">reference · read-only</span></span>
                {originals.length > 0 && <button type="button" className="btn sm ghost" onClick={downloadOriginals}><Icon name="download" /> Download originals</button>}
              </div>
              {originals.length === 0
                ? <p className="muted sm">No warehouse photos on file for this SKU yet.</p>
                : (
                  <div className="pe-orig-strip">
                    {originals.map((p) => (
                      <a className="pe-orig-cell" key={`${p.source}-${p.angle}`} href={p.url} target="_blank" rel="noreferrer" title={`Open ${p.angle} full size`}>
                        <img src={p.url} alt={p.angle} />
                        <span className="pe-orig-angle">{p.angle}</span>
                      </a>
                    ))}
                  </div>
                )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
