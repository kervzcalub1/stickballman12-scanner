// Per-SKU listing photos captured during receiving (V6 Feature 5). Shows the
// five angle slots as an at-a-glance "photo listing" (review) and opens a
// full-screen custom camera (PhotoCamera) to shoot/replace them. Already-shot
// SKUs load their photos in (dedupe — no re-shooting). Uploads go straight to R2.
import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { SHOE_ANGLES, ShoeAngleIcon } from './ShoeAngleIcons.jsx';
import { PhotoCamera } from './PhotoCamera.jsx';
import { Icon } from './NavIcons.jsx';

const MIN_PHOTOS = 3;

// Session cache of "how many warehouse angles does this SKU have" so a 20-shoe
// receiving cart doesn't refetch a count on every render.
const countCache = new Map();
export function invalidatePhotoCount(sku) { countCache.delete(sku); }

// The per-row photo button on the receiving cart. Photos moved out of the scan
// flow (which is now uninterrupted) onto each shoe in the list — so the badge has
// to say, at a glance, which shoes still need shooting.
export function PhotoCountButton({ sku, onOpen, refreshKey = 0 }) {
  const [count, setCount] = useState(() => countCache.get(sku) ?? null);
  useEffect(() => {
    if (!sku) return undefined;
    if (countCache.has(sku)) { setCount(countCache.get(sku)); return undefined; }
    let dead = false;
    api.photoList(sku)
      .then(({ photos: rows }) => {
        const n = (rows || []).filter((r) => r.source !== 'ph_edited').length;
        countCache.set(sku, n);
        if (!dead) setCount(n);
      })
      .catch(() => { /* leave the count unknown — the button still opens */ });
    return () => { dead = true; };
  }, [sku, refreshKey]);
  const done = count != null && count >= MIN_PHOTOS;
  return (
    <button type="button" className={`recv-photo-btn ${done ? 'ok' : ''} ${count === 0 ? 'empty' : ''}`}
      onClick={onOpen} title={count === 0 ? 'Add listing photos' : 'View / replace listing photos'}>
      <Icon name="camera" />
      <span className="recv-photo-count">{count == null ? 'Photos' : `${count}/${SHOE_ANGLES.length}`}</span>
    </button>
  );
}

export function ListingPhotos({ sku, onSignOut, onCameraToggle }) {
  const [photos, setPhotos] = useState({});   // angle -> url (warehouse's own shots)
  const [hasPhEdited, setHasPhEdited] = useState(false); // PH already uploaded edits for this SKU
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
        // Warehouse manages only its own ('warehouse') shots here; PH edits are a
        // separate layer that wins the listing/thumbnail (flagged by the banner).
        const map = {};
        for (const r of rows || []) if (r.source !== 'ph_edited') map[r.angle] = r.url;
        setPhotos(map);
        setHasPhEdited((rows || []).some((r) => r.source === 'ph_edited'));
      })
      .catch((err) => { if (err.unauthorized) return onSignOut?.(); if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sku]); // eslint-disable-line react-hooks/exhaustive-deps

  // Tell the parent (Receiving) when the full-screen camera is open so it can
  // stop re-focusing the hidden scan field (which pops the mobile keyboard).
  useEffect(() => { onCameraToggle?.(!!camera); }, [camera]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onCameraToggle?.(false), []); // eslint-disable-line react-hooks/exhaustive-deps

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
          {hasPhEdited && (
            <p className="lp-phedited"><Icon name="image" /> <span><b>PH edited photos are on file for this SKU.</b> They’ll be used as the listing images &amp; thumbnail. You can still take warehouse shots — they’re kept as reference.</span></p>
          )}
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
            {count === 0 ? <><Icon name="camera" /> Add listing photos</> : <><Icon name="image" /> View / replace photos</>}
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
