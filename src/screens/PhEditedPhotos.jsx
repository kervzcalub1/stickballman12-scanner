// Edited-photos MANAGEMENT panel — embedded in "Find Image Listings" (ImageFinder).
// PH uploads/removes/reorders EDITED listing images per SKU (source='ph_edited'), which
// take precedence over the warehouse's raw shots for the thumbnail + listing. Warehouse
// originals are shown read-only for reference and never overwritten. Slots 1–5 are the
// standard angles; 6–7 are extra images (viewer-only, never a thumbnail). Driven by the
// parent's loaded `sku`. See docs/context/ph-report.md.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useAutoAnimate } from '@formkit/auto-animate/react';
import { api } from '../api.js';
import { compressImage } from '../lib/image.js';
import { ImageZoomModal, ProgressBar } from '../components/common.jsx';
import { Icon } from '../components/NavIcons.jsx';

const ANGLE_SLOTS = [['side', 'Side'], ['diagonal', 'Diagonal'], ['outsole', 'Outsole'], ['top', 'Top'], ['rear', 'Rear']];
const EXTRA_SLOTS = [['extra1', 'Extra 1'], ['extra2', 'Extra 2']];
const ALL_SLOTS = [...ANGLE_SLOTS, ...EXTRA_SLOTS];

export function EditedPhotosPanel({ sku, onSignOut, reloadKey, onBuildFromTemplate, buildBusy }) {
  const [edited, setEdited] = useState({});      // angle -> url (source='ph_edited')
  const [originals, setOriginals] = useState([]); // [{ angle, url }] (source='warehouse')
  const [configured, setConfigured] = useState(true);
  const [loading, setLoading] = useState(false);
  const [busySlot, setBusySlot] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [replacing, setReplacing] = useState(false);  // SKU already has edits → hide bulk until "Replace" is clicked
  const [preview, setPreview] = useState(null);       // { list: [{url,label}], idx } for the zoom modal
  const editedList = useMemo(
    () => ALL_SLOTS.filter(([a]) => edited[a]).map(([a, label]) => ({ url: edited[a], label, angle: a })),
    [edited],
  );
  const fileRefs = useRef({}); // angle -> input
  const [staged, setStaged] = useState([]);        // [{ id, file, url }] in slot order
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkAt, setBulkAt] = useState(-1);        // index currently uploading
  const [dragOver, setDragOver] = useState(false);
  const [dragId, setDragId] = useState(null);
  const dragFrom = useRef(null);
  const bulkInputRef = useRef(null);
  const [stageAnimRef] = useAutoAnimate({ duration: 180 });
  const stagedRef = useRef([]);
  useEffect(() => { stagedRef.current = staged; }, [staged]);
  useEffect(() => () => stagedRef.current.forEach((s) => URL.revokeObjectURL(s.url)), []);

  function clearStaged() { staged.forEach((s) => URL.revokeObjectURL(s.url)); setStaged([]); }

  async function load() {
    const s = String(sku || '').trim();
    if (!s) return;
    setLoading(true); setError(''); setNotice(''); clearStaged(); setReplacing(false);
    try {
      const { photos, configured: cfg } = await api.photoList(s);
      setConfigured(cfg);
      const ed = {}; const og = [];
      for (const p of photos || []) {
        if (p.source === 'ph_edited') ed[p.angle] = p.url;
        else og.push(p);
      }
      setEdited(ed); setOriginals(og);
    } catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setLoading(false); }
  }
  // Reload whenever the parent's SKU changes or asks for a refresh (e.g. after Brand & Fill saves).
  useEffect(() => { load(); }, [sku, reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Compress + presign + PUT to R2 + attach. Shared by single-slot and bulk upload.
  async function putPhoto(angle, file) {
    const { blob, type } = await compressImage(file, { type: file.type || 'image/jpeg' });
    const { uploadUrl, publicUrl } = await api.photoSign(sku, angle, type, 'ph_edited');
    const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': type }, body: blob });
    if (!put.ok) throw new Error(`Upload failed (${put.status}). Check the R2 bucket CORS policy.`);
    await api.photoAttach(sku, angle, publicUrl, 'ph_edited');
    return publicUrl;
  }

  async function upload(angle, file) {
    if (!file || !sku) return;
    setBusySlot(angle); setError(''); setNotice('');
    try {
      const publicUrl = await putPhoto(angle, file);
      setEdited((e) => ({ ...e, [angle]: publicUrl }));
    } catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message || 'Could not upload the image.'); }
    finally { setBusySlot(null); }
  }

  function addFiles(fileList) {
    const imgs = [...(fileList || [])].filter((f) => f.type?.startsWith('image/'));
    if (!imgs.length) return;
    setError('');
    setStaged((prev) => {
      const room = ALL_SLOTS.length - prev.length;
      const take = imgs.slice(0, Math.max(0, room));
      if (imgs.length > take.length) setNotice(`Only ${ALL_SLOTS.length} angle slots — kept the first ${prev.length + take.length} image${prev.length + take.length === 1 ? '' : 's'}.`);
      const mk = (f) => ({ id: (crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`), file: f, url: URL.createObjectURL(f) });
      return [...prev, ...take.map(mk)];
    });
  }

  function reorder(from, to) {
    setStaged((prev) => {
      if (from == null || to < 0 || to >= prev.length || from === to) return prev;
      const arr = [...prev];
      const [it] = arr.splice(from, 1);
      arr.splice(to, 0, it);
      return arr;
    });
  }

  function removeStaged(i) {
    setStaged((prev) => { const s = prev[i]; if (s) URL.revokeObjectURL(s.url); return prev.filter((_, j) => j !== i); });
  }

  async function uploadStaged() {
    if (!staged.length || !sku) return;
    setBulkBusy(true); setError(''); setNotice('');
    try {
      for (let i = 0; i < staged.length; i++) {
        setBulkAt(i);
        const angle = ALL_SLOTS[i][0];
        const publicUrl = await putPhoto(angle, staged[i].file);
        setEdited((e) => ({ ...e, [angle]: publicUrl }));
      }
      const n = staged.length;
      clearStaged(); setReplacing(false);
      setNotice(`Uploaded ${n} image${n === 1 ? '' : 's'}.`);
    } catch (err) {
      if (err.unauthorized) return onSignOut();
      setError(err.message || 'Bulk upload failed. The photos still uploaded before the error were saved; you can retry the rest.');
    } finally { setBulkBusy(false); setBulkAt(-1); }
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

  async function download(source, fallbackName) {
    setNotice(''); setError('');
    try {
      const { blob, filename } = await api.photoDownload(sku, source);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = filename || fallbackName;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    } catch (err) { if (err.unauthorized) return onSignOut(); setError('Could not download the images.'); }
  }
  const downloadAll = () => download(undefined, `${sku}-all-photos.zip`);
  const downloadOriginals = () => download('warehouse', `${sku}-warehouse-photos.zip`);

  const onPick = (angle, e) => { const f = e.target.files?.[0]; if (e.target) e.target.value = ''; if (f) upload(angle, f); };
  const editedCount = Object.keys(edited).length;
  const hasEdited = editedCount > 0;
  const anyImages = editedCount > 0 || originals.length > 0;
  const showBulk = !hasEdited || replacing || staged.length > 0;

  if (!configured) return <p className="muted mt">Photo storage isn’t set up yet — add the R2 env vars to enable uploads.</p>;
  if (loading) return <div className="mt"><ProgressBar indeterminate label="Loading photos…" /></div>;

  return (
    <div className="pe-panel">
      {error && <div className="error mt">{error}</div>}
      {notice && <div className="ok mt">{notice}</div>}

      <div className="pe-head">
        <span className="pe-title">Edited listing set</span>
        <span className={`pe-count ${editedCount >= 5 ? 'ok' : ''}`}>{editedCount}/{ALL_SLOTS.length}</span>
      </div>

      {anyImages && (
        <div className="pe-actionbar">
          <button type="button" className="btn primary pe-download-all" onClick={downloadAll}
            title="Download every image for this SKU (edited + warehouse originals) as a zip">
            <Icon name="download" /> Download all photos
          </button>
        </div>
      )}

      {!showBulk ? (
        <div className="pe-replace">
          <div className="pe-replace-txt">
            <span className="pe-replace-lbl">This SKU already has edited listing images.</span>
            <span className="muted sm">Upload a finished image as-is below, or use <b>Build from template</b> above to generate them.</span>
          </div>
          <button type="button" className="btn primary" onClick={() => setReplacing(true)}>
            <Icon name="image" /> Replace listing images
          </button>
        </div>
      ) : (
        <div className="pe-bulk">
          {staged.length === 0 && onBuildFromTemplate && (
            <div className="pe-autosearch">
              <span className="muted sm">Auto-source the shoe from the marketplace and build it on your template — you can still upload/replace angles and resize on the canvas, and nothing here is overwritten until you Upload.</span>
              <button type="button" className="btn primary" disabled={buildBusy} onClick={onBuildFromTemplate}>
                <Icon name="image" /> {buildBusy ? 'Finding…' : 'Auto-search Images'}
              </button>
            </div>
          )}
          {staged.length === 0 ? (
            <div
              className={`pe-dropzone ${dragOver ? 'over' : ''}`}
              role="button" tabIndex={0}
              onClick={() => bulkInputRef.current?.click()}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); bulkInputRef.current?.click(); } }}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files); }}
            >
              <Icon name="image" />
              <span className="pe-dz-main">Drag finished images here, or tap to select</span>
              <span className="pe-dz-sub muted sm">Up to {ALL_SLOTS.length} at once — they fill Side → Extra 2 in order; rearrange before uploading. Uploaded as-is (no template).</span>
              {hasEdited && <button type="button" className="pe-dz-cancel linklike sm" onClick={(e) => { e.stopPropagation(); setReplacing(false); }}>Cancel</button>}
            </div>
          ) : (
            <div className="pe-stage">
              <div className="pe-stage-head">
                <span className="pe-stage-lbl">{staged.length} photo{staged.length === 1 ? '' : 's'} staged — drag or use ◀ ▶ so each sits on the right angle</span>
                <button type="button" className="btn sm ghost" disabled={bulkBusy} onClick={clearStaged}>Clear</button>
              </div>
              <div className="pe-stage-grid" ref={stageAnimRef}>
                {staged.map((s, i) => {
                  const [, label] = ALL_SLOTS[i];
                  const isExtra = ALL_SLOTS[i][0].startsWith('extra');
                  const active = bulkBusy && bulkAt === i;
                  const done = bulkBusy && bulkAt > i;
                  return (
                    <div
                      key={s.id}
                      className={`pe-stage-card ${isExtra ? 'extra' : ''} ${active ? 'uploading' : ''} ${done ? 'done' : ''} ${dragId === s.id ? 'dragging' : ''}`}
                      draggable={!bulkBusy}
                      onDragStart={() => { dragFrom.current = i; setDragId(s.id); }}
                      onDragEnter={() => { if (dragFrom.current != null && dragFrom.current !== i) { reorder(dragFrom.current, i); dragFrom.current = i; } }}
                      onDragOver={(e) => e.preventDefault()}
                      onDragEnd={() => { dragFrom.current = null; setDragId(null); }}
                      onDrop={(e) => { e.preventDefault(); dragFrom.current = null; setDragId(null); }}
                    >
                      <span className="pe-stage-slotno">{i + 1}</span>
                      <img src={s.url} alt={label} className="pe-stage-img" title={`Preview ${label}`}
                        onClick={() => setPreview({ list: staged.map((st, k) => ({ url: st.url, label: ALL_SLOTS[k][1] })), idx: i })} />
                      {active && <span className="pe-stage-status">Uploading…</span>}
                      {done && <span className="pe-stage-status ok">✓</span>}
                      <div className="pe-stage-ctl">
                        <button type="button" className="pe-move" title="Move left" disabled={bulkBusy || i === 0} onClick={() => reorder(i, i - 1)}>◀</button>
                        <span className="pe-stage-angle">{label}</span>
                        <button type="button" className="pe-move" title="Move right" disabled={bulkBusy || i === staged.length - 1} onClick={() => reorder(i, i + 1)}>▶</button>
                      </div>
                      <button type="button" className="pe-stage-x" title="Remove" disabled={bulkBusy} onClick={() => removeStaged(i)}>×</button>
                    </div>
                  );
                })}
              </div>
              {bulkBusy && <div className="mt"><ProgressBar value={(bulkAt + 1) / staged.length} label={`Uploading ${bulkAt + 1} of ${staged.length}…`} /></div>}
              <div className="pe-stage-actions">
                <button type="button" className="btn primary" disabled={bulkBusy} onClick={uploadStaged}>
                  {bulkBusy ? `Uploading ${bulkAt + 1}/${staged.length}…` : `Upload ${staged.length} to R2`}
                </button>
                <button type="button" className="btn ghost" disabled={bulkBusy} onClick={() => bulkInputRef.current?.click()}>Add more</button>
              </div>
              <p className="muted sm pe-stage-note">Uploading fills slots {staged.length === 1 ? '1' : `1–${staged.length}`} and replaces any existing edited photo in those angles.</p>
            </div>
          )}
          <input ref={bulkInputRef} type="file" accept="image/*" multiple hidden
            onChange={(e) => { addFiles(e.target.files); if (e.target) e.target.value = ''; }} />
        </div>
      )}

      <div className="pe-grid">
        {ALL_SLOTS.map(([angle, label]) => {
          const url = edited[angle];
          const isExtra = angle.startsWith('extra');
          const busy = busySlot === angle;
          return (
            <div className={`pe-slot ${url ? 'filled' : ''} ${isExtra ? 'extra' : ''}`} key={angle}>
              <button type="button" className="pe-slot-btn" disabled={busy}
                onClick={() => (url ? setPreview({ list: editedList, idx: Math.max(0, editedList.findIndex((x) => x.angle === angle)) }) : fileRefs.current[angle]?.click())}
                title={url ? `Preview ${label}` : `Upload ${label}`}>
                {url ? <img src={url} alt={label} className="pe-thumb" />
                  : <span className="pe-slot-empty">{busy ? '…' : <><Icon name="image" /><span>{isExtra ? 'Extra' : 'Upload'}</span></>}</span>}
              </button>
              <span className="pe-slot-lbl">{label}{url ? ' ✓' : ''}</span>
              {url && <button type="button" className="pe-slot-change" title={`Replace ${label}`} disabled={busy} onClick={() => fileRefs.current[angle]?.click()}><Icon name="image" size="0.9em" /></button>}
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
              {originals.map((p, oi) => (
                <button type="button" className="pe-orig-cell" key={`${p.source}-${p.angle}`} title={`Preview ${p.angle}`}
                  onClick={() => setPreview({ list: originals.map((op) => ({ url: op.url, label: op.angle })), idx: oi })}>
                  <img src={p.url} alt={p.angle} />
                  <span className="pe-orig-angle">{p.angle}</span>
                </button>
              ))}
            </div>
          )}
      </div>

      {preview && preview.list[preview.idx] && (
        <ImageZoomModal
          url={preview.list[preview.idx].url}
          label={preview.list[preview.idx].label}
          onClose={() => setPreview(null)}
          onPrev={preview.idx > 0 ? () => setPreview((p) => ({ ...p, idx: p.idx - 1 })) : undefined}
          onNext={preview.idx < preview.list.length - 1 ? () => setPreview((p) => ({ ...p, idx: p.idx + 1 })) : undefined}
        />
      )}
    </div>
  );
}
