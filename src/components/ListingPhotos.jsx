// Per-SKU listing photos captured during receiving (V6 Feature 5). Five angle
// slots (side · diagonal · outsole · top · rear); the warehouse fills any of
// them, in any order. If the SKU already has photos they load in as filled —
// no re-shooting (dedupe). Each capture is compressed client-side, uploaded
// straight to Cloudflare R2 via a presigned PUT, then recorded against the SKU.
import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { compressImage } from '../lib/image.js';
import { SHOE_ANGLES } from './ShoeAngleIcons.jsx';

const MIN_PHOTOS = 3;

export function ListingPhotos({ sku, onSignOut }) {
  const [photos, setPhotos] = useState({});   // angle -> url
  const [configured, setConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);      // angle currently uploading
  const [error, setError] = useState('');
  const fileRef = useRef(null);
  const angleRef = useRef(null);               // which slot the file picker is for

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError('');
    api.photoList(sku)
      .then(({ photos: rows, configured: cfg }) => {
        if (cancelled) return;
        setConfigured(cfg);
        const map = {};
        for (const r of rows || []) map[r.angle] = r.url;
        setPhotos(map);
      })
      .catch((err) => { if (err.unauthorized) return onSignOut?.(); if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sku]); // eslint-disable-line react-hooks/exhaustive-deps

  function pick(angle) {
    if (busy || !configured) return;
    angleRef.current = angle;
    fileRef.current?.click();
  }

  async function onFile(e) {
    const file = e.target.files?.[0];
    if (e.target) e.target.value = '';
    const angle = angleRef.current;
    if (!file || !angle) return;
    setBusy(angle); setError('');
    try {
      const { blob, type } = await compressImage(file);
      const { uploadUrl, publicUrl } = await api.photoSign(sku, angle, type);
      const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': type }, body: blob });
      if (!put.ok) throw new Error(`Upload failed (${put.status}). Check the R2 bucket CORS policy.`);
      await api.photoAttach(sku, angle, publicUrl);
      setPhotos((p) => ({ ...p, [angle]: publicUrl }));
    } catch (err) {
      if (err.unauthorized) return onSignOut?.();
      setError(err.message || 'Could not upload the photo.');
    } finally { setBusy(null); }
  }

  async function remove(angle) {
    if (busy) return;
    setBusy(angle); setError('');
    try {
      await api.photoRemove(sku, angle);
      setPhotos((p) => { const n = { ...p }; delete n[angle]; return n; });
    } catch (err) {
      if (err.unauthorized) return onSignOut?.();
      setError(err.message);
    } finally { setBusy(null); }
  }

  const count = Object.keys(photos).length;

  return (
    <div className="listing-photos">
      <div className="lp-head">
        <span className="lp-title">Listing photos</span>
        {configured && (
          <span className={`lp-count ${count >= MIN_PHOTOS ? 'ok' : ''}`}>
            {count}/{SHOE_ANGLES.length}{count < MIN_PHOTOS ? ` · add ${MIN_PHOTOS - count} more` : ' ✓'}
          </span>
        )}
      </div>

      {!configured ? (
        <p className="muted sm">Photo storage isn’t set up yet — add the R2 env vars to enable listing photos.</p>
      ) : loading ? (
        <p className="muted sm">Loading photos…</p>
      ) : (
        <>
          {count > 0 && count >= 1 && <p className="muted sm">This SKU already has photos — only fill the missing angles.</p>}
          <div className="lp-grid">
            {SHOE_ANGLES.map(([angle, label, Icon]) => {
              const url = photos[angle];
              const isBusy = busy === angle;
              return (
                <div key={angle} className={`lp-slot ${url ? 'filled' : ''}`}>
                  <button type="button" className="lp-slot-btn" onClick={() => pick(angle)} disabled={isBusy} title={url ? `Replace ${label}` : `Add ${label}`}>
                    {isBusy ? <span className="lp-spin">…</span>
                      : url ? <img src={url} alt={label} className="lp-thumb" />
                        : <span className="lp-icon"><Icon /></span>}
                  </button>
                  <span className="lp-label">{label}</span>
                  {url && !isBusy && (
                    <button type="button" className="lp-remove" title={`Remove ${label}`} onClick={() => remove(angle)}>×</button>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
      {error && <div className="error sm mt">{error}</div>}
      <input ref={fileRef} type="file" accept="image/*" capture="environment" hidden onChange={onFile} />
    </div>
  );
}
