// Per-SKU listing photos captured during receiving (V6 Feature 5). Shows the
// five angle slots as an at-a-glance "photo listing" (review) and opens a
// full-screen custom camera (PhotoCamera) to shoot/replace them. Already-shot
// SKUs load their photos in (dedupe — no re-shooting). Uploads go straight to R2.
import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { SHOE_ANGLES, ShoeAngleIcon } from './ShoeAngleIcons.jsx';
import { PhotoCamera } from './PhotoCamera.jsx';

const MIN_PHOTOS = 3;

export function ListingPhotos({ sku, onSignOut }) {
  const [photos, setPhotos] = useState({});   // angle -> url
  const [configured, setConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [camera, setCamera] = useState(null);  // { angle } when open, else null

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

  async function remove(angle) {
    setError('');
    try {
      await api.photoRemove(sku, angle);
      setPhotos((p) => { const n = { ...p }; delete n[angle]; return n; });
    } catch (err) {
      if (err.unauthorized) return onSignOut?.();
      setError(err.message);
    }
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
          {count > 0 && <p className="muted sm">This SKU already has photos — review them, replace any, or fill the missing angles.</p>}
          <div className="lp-grid">
            {SHOE_ANGLES.map(([angle, label]) => {
              const url = photos[angle];
              return (
                <div key={angle} className={`lp-slot ${url ? 'filled' : ''}`}>
                  <button type="button" className="lp-slot-btn" onClick={() => setCamera({ angle })} title={url ? `Replace ${label}` : `Add ${label}`}>
                    {url ? <img src={url} alt={label} className="lp-thumb" /> : <span className="lp-icon"><ShoeAngleIcon angle={angle} /></span>}
                  </button>
                  <span className="lp-label">{label}</span>
                  {url && <button type="button" className="lp-remove" title={`Remove ${label}`} onClick={() => remove(angle)}>×</button>}
                </div>
              );
            })}
          </div>
          <button type="button" className="btn primary wide lp-open" onClick={() => setCamera({})}>
            {count === 0 ? '📷 Add listing photos' : '🖼 View / replace photos'}
          </button>
        </>
      )}
      {error && <div className="error sm mt">{error}</div>}

      {camera && (
        <PhotoCamera
          sku={sku}
          photos={photos}
          initialAngle={camera.angle}
          onUploaded={(angle, url) => setPhotos((p) => ({ ...p, [angle]: url }))}
          onRemove={remove}
          onClose={() => setCamera(null)}
          onSignOut={onSignOut}
        />
      )}
    </div>
  );
}
