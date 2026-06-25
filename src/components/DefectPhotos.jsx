// Per-unit defect photos for the review screen (V6 Feature 4). Free-form (no
// fixed angles), up to 4 per VIN. Each is compressed client-side and uploaded
// straight to R2 via a presigned PUT keyed by VIN; the parent keeps the list of
// resulting URLs and sends them with the batch commit (stored on an 'issue'
// item_event). The note works even when R2 is unconfigured — only uploads fail.
import React, { useRef, useState } from 'react';
import { api } from '../api.js';
import { compressImage } from '../lib/image.js';

const MAX = 4;

export function DefectPhotos({ vin, photos = [], onChange, onSignOut }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef(null);

  async function onFile(e) {
    const file = e.target.files?.[0];
    if (e.target) e.target.value = '';
    if (!file) return;
    setBusy(true); setError('');
    try {
      const { blob, type } = await compressImage(file);
      const { uploadUrl, publicUrl } = await api.photoSignIssue(vin, type);
      const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': type }, body: blob });
      if (!put.ok) throw new Error(`Upload failed (${put.status}). Check the R2 bucket CORS policy.`);
      onChange([...photos, publicUrl]);
    } catch (err) {
      if (err.unauthorized) return onSignOut?.();
      setError(err.message || 'Could not upload the photo.');
    } finally { setBusy(false); }
  }

  const remove = (i) => onChange(photos.filter((_, j) => j !== i));

  return (
    <div className="defect-photos">
      <div className="dp-grid">
        {photos.map((url, i) => (
          <div className="dp-thumb-wrap" key={`${url}-${i}`}>
            <img className="dp-thumb" src={url} alt="defect" />
            <button type="button" className="lp-remove" title="Remove photo" onClick={() => remove(i)}>×</button>
          </div>
        ))}
        {photos.length < MAX && (
          <button type="button" className="dp-add" onClick={() => fileRef.current?.click()} disabled={busy}>
            {busy ? '…' : '＋ Photo'}
          </button>
        )}
      </div>
      {error && <div className="error sm mt">{error}</div>}
      <input ref={fileRef} type="file" accept="image/*" capture="environment" hidden onChange={onFile} />
    </div>
  );
}
