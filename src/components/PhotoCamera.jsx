// Full-screen custom camera for listing photos (V6 Feature 5). Live preview with
// a bottom angle strip (side · diagonal · outsole · top · rear) — pick an angle,
// tap the shutter, and it captures the frame INSTANTLY (shutter never blocks),
// then compresses + uploads to R2 for that angle in the background while you line
// up the next shot. Already-shot angles show their thumbnail in the strip.
// "Gallery" picks an existing file instead.
//
// Why background upload: the sign → PUT-to-R2 → attach round-trip is ~1–3s on a
// warehouse phone. Blocking the shutter on it made every shot feel frozen. Now
// each photo shows immediately from a local object URL and uploads on its own, so
// by the time all angles are shot the uploads are already done.
//
// Uses getUserMedia directly (no barcode decoding) with explicit play() + a
// loading/retry state, so it doesn't hit the black/stalled-preview issues.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { compressImage } from '../lib/image.js';
import { SHOE_ANGLES } from './ShoeAngleIcons.jsx';
import { Icon } from './NavIcons.jsx';

export function PhotoCamera({ sku, photos, initialAngle, onUploaded, onRemove, onClose, onSignOut }) {
  const videoRef = useRef(null);
  const galleryRef = useRef(null);
  const urlsRef = useRef([]); // local object URLs to revoke on unmount
  const [live, setLive] = useState(false);
  const [slow, setSlow] = useState(false);
  const [error, setError] = useState('');       // camera-start error (replaces preview)
  const [notice, setNotice] = useState('');      // non-blocking upload notice
  const [restartKey, setRestartKey] = useState(0);
  // Optimistic per-angle upload state: angle -> { url, status, blob, type }.
  // Kept even after success (status 'done') so the freshly shot image keeps
  // showing without a network reload flash; all object URLs are revoked on close.
  const [pending, setPending] = useState({});
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
        // We only keep ~1600px after compressImage, so there's no reason to run
        // the live preview at full 1080p — on warehouse phones that heavier sensor
        // mode makes the preview stutter. Ask for a 1600×1200 (4:3) stream capped
        // at 30fps: the capture still meets the 1600px target, but the preview is
        // lighter and smoother. `max` caps it so a device can't hand back 1080p60.
        started = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1600, max: 1600 },
            height: { ideal: 1200, max: 1200 },
            frameRate: { ideal: 30, max: 30 },
          },
          audio: false,
        });
        if (cancelled) { started.getTracks().forEach((t) => t.stop()); return; }
        const v = videoRef.current;
        if (v) { v.srcObject = started; try { await v.play(); if (!cancelled) setLive(true); } catch { /* autoplay */ } }
      } catch (e) {
        if (!cancelled) setError(e?.name === 'NotAllowedError'
          ? 'Camera permission denied — allow access, or use Gallery.'
          : 'Could not start the camera. Use Gallery instead.');
      }
    })();
    return () => {
      cancelled = true; clearTimeout(slowTimer);
      // Only stop THIS run's stream; under StrictMode the shared <video> may
      // already hold the next run's stream — don't kill it (caused black/zoom).
      if (started?.getTracks) started.getTracks().forEach((t) => { try { t.stop(); } catch { /* noop */ } });
      const v = videoRef.current;
      if (v && v.srcObject === started) v.srcObject = null;
    };
  }, [restartKey]);

  // Revoke all local object URLs when the camera closes.
  useEffect(() => () => { urlsRef.current.forEach((u) => { try { URL.revokeObjectURL(u); } catch { /* noop */ } }); }, []);

  // Background upload of one angle's blob. Never blocks the UI; updates just the
  // one slot's status (uploading → done | error) so other shots keep flowing.
  function uploadOne(a, blob, type) {
    (async () => {
      try {
        const { uploadUrl, publicUrl } = await api.photoSign(sku, a, type);
        const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': type }, body: blob });
        if (!put.ok) throw new Error(`Upload failed (${put.status}). Check the R2 bucket CORS policy.`);
        await api.photoAttach(sku, a, publicUrl);
        onUploaded(a, publicUrl);
        setPending((p) => (p[a] ? { ...p, [a]: { ...p[a], status: 'done' } } : p));
      } catch (err) {
        if (err.unauthorized) return onSignOut?.();
        setNotice('A photo didn’t upload — tap the slot and Retry.');
        setPending((p) => (p[a] ? { ...p, [a]: { ...p[a], status: 'error' } } : p));
      }
    })();
  }

  // Advance to the next angle that has neither a saved nor a just-shot photo.
  const advanceFrom = (a) => {
    const next = SHOE_ANGLES.find(([x]) => x !== a && !photos[x] && !pending[x]);
    if (next) setAngle(next[0]);
  };

  function capture() {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = v.videoWidth; canvas.height = v.videoHeight;
    canvas.getContext('2d').drawImage(v, 0, 0);
    // Single JPEG encode — the stream is already capped at ~1600px, so no
    // compressImage re-decode/re-encode pass is needed for camera shots.
    canvas.toBlob((blob) => {
      if (!blob) { setNotice('Could not capture the frame — try again.'); return; }
      const a = angle;
      const url = URL.createObjectURL(blob);
      urlsRef.current.push(url);
      setNotice('');
      setPending((p) => ({ ...p, [a]: { url, status: 'uploading', blob, type: 'image/jpeg' } }));
      uploadOne(a, blob, 'image/jpeg');
      advanceFrom(a);
    }, 'image/jpeg', 0.82);
  }

  function onGallery(e) {
    const f = e.target.files?.[0]; if (e.target) e.target.value = '';
    if (!f) return;
    const a = angle;
    // Preview the picked file immediately; compress + upload in the background.
    const url = URL.createObjectURL(f);
    urlsRef.current.push(url);
    setNotice('');
    setPending((p) => ({ ...p, [a]: { url, status: 'uploading', blob: f, type: f.type || 'image/jpeg' } }));
    advanceFrom(a);
    compressImage(f, { type: f.type || 'image/jpeg' })
      .then(({ blob, type }) => uploadOne(a, blob, type))
      .catch(() => uploadOne(a, f, f.type || 'image/jpeg'));
  }

  function retry(a) {
    const item = pending[a];
    if (!item || item.status === 'uploading') return;
    setNotice('');
    setPending((p) => ({ ...p, [a]: { ...p[a], status: 'uploading' } }));
    uploadOne(a, item.blob, item.type);
  }
  const retryAll = () => { setNotice(''); SHOE_ANGLES.forEach(([a]) => { if (pending[a]?.status === 'error') retry(a); }); };

  function removeAngle(a) {
    setPending((p) => { if (!p[a]) return p; const n = { ...p }; delete n[a]; return n; });
    if (photos[a]) onRemove(a); // only the saved (attached) copy needs a server delete
  }

  const shownUrl = (a) => pending[a]?.url || photos[a];
  const filled = SHOE_ANGLES.filter(([a]) => shownUrl(a)).length;
  const curUrl = shownUrl(angle);
  const curStatus = pending[angle]?.status;
  const hasFailed = SHOE_ANGLES.some(([a]) => pending[a]?.status === 'error');

  return (
    <div className="pc-overlay" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
      <div className="pc-top">
        <span className="pc-title">Listing photos · {filled}/{SHOE_ANGLES.length}</span>
        <button type="button" className="btn primary sm pc-done" onClick={onClose}>Done</button>
      </div>

      <div className="pc-stage">
        {error
          ? <div className="pc-error">{error}<button type="button" className="btn sm ghost" onClick={() => setRestartKey((k) => k + 1)}>Retry camera</button></div>
          : <video ref={videoRef} className="pc-video" muted playsInline autoPlay
              onPlaying={() => { setLive(true); setSlow(false); }} onCanPlay={() => setLive(true)} onLoadedData={() => setLive(true)} />}
        {!error && !live && (
          <div className="pc-loading"><span>Starting camera…</span>{slow && <button type="button" className="btn sm ghost" onClick={() => setRestartKey((k) => k + 1)}>Camera blank? Retry</button>}</div>
        )}
        {curUrl && (
          <div className={`pc-current ${curStatus === 'uploading' ? 'uploading' : ''} ${curStatus === 'error' ? 'error' : ''}`}>
            <img src={curUrl} alt="current angle" title="Current photo — capture to replace" />
          </div>
        )}
        {notice && (
          <div className="pc-notice">
            <span>{notice}</span>
            {hasFailed
              ? <button type="button" className="btn sm ghost" onClick={retryAll}>Retry</button>
              : <button type="button" className="pc-notice-x" aria-label="Dismiss" onClick={() => setNotice('')}>×</button>}
          </div>
        )}
      </div>

      <div className="pc-bottom">
        <div className="pc-angles">
          {SHOE_ANGLES.map(([a, label, AngleIcon]) => {
            const url = shownUrl(a);
            const st = pending[a]?.status;
            return (
              <button key={a} type="button" className={`pc-angle ${angle === a ? 'sel' : ''} ${url ? 'filled' : ''} ${st === 'error' ? 'err' : ''}`} onClick={() => setAngle(a)}>
                <span className="pc-angle-ic">{url ? <img src={url} alt="" /> : <AngleIcon />}</span>
                <span className="pc-angle-lbl">{label}{st === 'uploading' ? ' …' : st === 'error' ? ' !' : url ? ' ✓' : ''}</span>
              </button>
            );
          })}
        </div>
        <div className="pc-actions">
          <button type="button" className="btn ghost" onClick={() => galleryRef.current?.click()}><Icon name="image" /> Gallery</button>
          <button type="button" className="pc-shutter" onClick={capture} disabled={!live} aria-label={`Capture ${angle}`} />
          {curUrl
            ? <button type="button" className="btn ghost danger" onClick={() => removeAngle(angle)}>Remove</button>
            : <span className="pc-side-spacer" />}
        </div>
      </div>
      <input ref={galleryRef} type="file" accept="image/*" hidden onChange={onGallery} />
    </div>
  );
}
