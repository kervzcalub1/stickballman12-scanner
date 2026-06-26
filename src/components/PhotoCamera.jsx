// Full-screen custom camera for listing photos (V6 Feature 5). Live preview with
// a bottom angle strip (side · diagonal · outsole · top · rear) — pick an angle,
// tap the shutter, and it captures → compresses → uploads to R2 for that angle,
// then advances to the next empty angle. "Gallery" picks an existing file
// instead. Already-shot angles show their thumbnail in the strip and can be
// replaced/removed (this is the "view photo listing" review too).
//
// Uses getUserMedia directly (no barcode decoding) with explicit play() + a
// loading/retry state, so it doesn't hit the black/stalled-preview issues.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { compressImage } from '../lib/image.js';
import { SHOE_ANGLES } from './ShoeAngleIcons.jsx';

export function PhotoCamera({ sku, photos, initialAngle, onUploaded, onRemove, onClose, onSignOut }) {
  const videoRef = useRef(null);
  const galleryRef = useRef(null);
  const [live, setLive] = useState(false);
  const [slow, setSlow] = useState(false);
  const [error, setError] = useState('');
  const [restartKey, setRestartKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const firstEmpty = useMemo(() => SHOE_ANGLES.find(([a]) => !photos[a])?.[0] || SHOE_ANGLES[0][0], []); // eslint-disable-line react-hooks/exhaustive-deps
  const [angle, setAngle] = useState(initialAngle || firstEmpty);

  // Acquire camera once per restart; release every track on close/unmount.
  useEffect(() => {
    let cancelled = false;
    let started = null;
    setLive(false); setSlow(false); setError('');
    const slowTimer = setTimeout(() => { if (!cancelled) setSlow(true); }, 4500);
    (async () => {
      try {
        started = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
        if (cancelled) { started.getTracks().forEach((t) => t.stop()); return; }
        const v = videoRef.current;
        if (v) { v.srcObject = started; try { await v.play(); } catch { /* autoplay */ } }
      } catch (e) {
        if (!cancelled) setError(e?.name === 'NotAllowedError'
          ? 'Camera permission denied — allow access, or use Gallery.'
          : 'Could not start the camera. Use Gallery instead.');
      }
    })();
    return () => {
      cancelled = true; clearTimeout(slowTimer);
      const s = videoRef.current?.srcObject || started;
      if (s?.getTracks) s.getTracks().forEach((t) => { try { t.stop(); } catch { /* noop */ } });
      if (videoRef.current) videoRef.current.srcObject = null;
    };
  }, [restartKey]);

  async function upload(fileOrBlob, type) {
    setBusy(true); setError('');
    try {
      const { blob, type: t } = await compressImage(fileOrBlob, { type: type || 'image/jpeg' });
      const { uploadUrl, publicUrl } = await api.photoSign(sku, angle, t);
      const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': t }, body: blob });
      if (!put.ok) throw new Error(`Upload failed (${put.status}). Check the R2 bucket CORS policy.`);
      await api.photoAttach(sku, angle, publicUrl);
      onUploaded(angle, publicUrl);
      const next = SHOE_ANGLES.find(([a]) => a !== angle && !photos[a]); // jump to a still-empty angle
      if (next) setAngle(next[0]);
    } catch (err) {
      if (err.unauthorized) return onSignOut?.();
      setError(err.message || 'Could not upload the photo.');
    } finally { setBusy(false); }
  }

  async function capture() {
    const v = videoRef.current;
    if (!v || !v.videoWidth || busy) return;
    const canvas = document.createElement('canvas');
    canvas.width = v.videoWidth; canvas.height = v.videoHeight;
    canvas.getContext('2d').drawImage(v, 0, 0);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
    if (blob) await upload(blob, 'image/jpeg');
  }

  function onGallery(e) {
    const f = e.target.files?.[0]; if (e.target) e.target.value = '';
    if (f) upload(f, f.type);
  }

  const filled = SHOE_ANGLES.filter(([a]) => photos[a]).length;

  return (
    <div className="pc-overlay" role="dialog" aria-modal="true">
      <div className="pc-top">
        <span className="pc-title">Listing photos · {filled}/{SHOE_ANGLES.length}</span>
        <button type="button" className="btn icon ghost" onClick={onClose} aria-label="Close">×</button>
      </div>

      <div className="pc-stage">
        {error
          ? <div className="pc-error">{error}<button type="button" className="btn sm ghost" onClick={() => setRestartKey((k) => k + 1)}>Retry camera</button></div>
          : <video ref={videoRef} className="pc-video" muted playsInline autoPlay onPlaying={() => { setLive(true); setSlow(false); }} />}
        {!error && !live && (
          <div className="pc-loading"><span>Starting camera…</span>{slow && <button type="button" className="btn sm ghost" onClick={() => setRestartKey((k) => k + 1)}>Camera blank? Retry</button>}</div>
        )}
        {photos[angle] && <img className="pc-current" src={photos[angle]} alt="current angle" title="Current photo — capture to replace" />}
      </div>

      <div className="pc-bottom">
        <div className="pc-angles">
          {SHOE_ANGLES.map(([a, label, Icon]) => (
            <button key={a} type="button" className={`pc-angle ${angle === a ? 'sel' : ''} ${photos[a] ? 'filled' : ''}`} onClick={() => setAngle(a)}>
              <span className="pc-angle-ic">{photos[a] ? <img src={photos[a]} alt="" /> : <Icon />}</span>
              <span className="pc-angle-lbl">{label}{photos[a] ? ' ✓' : ''}</span>
            </button>
          ))}
        </div>
        <div className="pc-actions">
          <button type="button" className="btn ghost" onClick={() => galleryRef.current?.click()} disabled={busy}>🖼 Gallery</button>
          <button type="button" className="pc-shutter" onClick={capture} disabled={busy || !live} aria-label={`Capture ${angle}`}>{busy ? '…' : ''}</button>
          {photos[angle]
            ? <button type="button" className="btn ghost danger" onClick={() => onRemove(angle)} disabled={busy}>Remove</button>
            : <span className="pc-side-spacer" />}
        </div>
      </div>
      <input ref={galleryRef} type="file" accept="image/*" hidden onChange={onGallery} />
    </div>
  );
}
