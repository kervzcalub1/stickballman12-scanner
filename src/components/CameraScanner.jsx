import React, { useEffect, useRef, useState } from 'react';
import { BrowserMultiFormatReader } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';

// Camera-based 1D barcode scanner (UPC-A / UPC-E / EAN-13 / EAN-8 / Code-128).
// Calls onDetected(code) once with the decoded digits, then stops.
//
// `zoom` (1 or 2) is applied to the live camera track when the device supports
// the `zoom` capability. `mode`: 'product' (UPC/EAN digits) vs 'tracking'/'vin'
// (alphanumeric Code128/39 RAW) vs 'rescale' (both). `continuous`: keep decoding.
//
// Start is done ONCE per device: the initial run uses facingMode=environment
// (no exact deviceId) so we never call setDeviceId mid-effect — that used to
// re-trigger the effect and start a second getUserMedia while the first was
// still acquiring the camera, which raced into a black/stalled preview.
export default function CameraScanner({ onDetected, onClose, zoom = 1, onZoomChange, mode = 'product', continuous = false }) {
  const videoRef = useRef(null);
  const controlsRef = useRef(null);
  const trackRef = useRef(null);
  const doneRef = useRef(false);
  const lastTextRef = useRef(null);
  const [error, setError] = useState('');
  const [devices, setDevices] = useState([]);
  const [deviceId, setDeviceId] = useState(undefined); // only set by the user switcher
  const [selDevice, setSelDevice] = useState('');       // dropdown display (active camera)
  const [hwZoom, setHwZoom] = useState(false);
  const [live, setLive] = useState(false);              // video is actually rendering frames
  const [slow, setSlow] = useState(false);              // took too long → offer retry
  const [restartKey, setRestartKey] = useState(0);

  function applyZoom(track, z) {
    try {
      const caps = track?.getCapabilities?.();
      if (!caps || !('zoom' in caps)) return false;
      const min = caps.zoom.min ?? 1;
      const max = caps.zoom.max ?? z;
      track.applyConstraints({ advanced: [{ zoom: Math.min(max, Math.max(min, z)) }] }).catch(() => {});
      return true;
    } catch { return false; }
  }

  useEffect(() => {
    const hints = new Map();
    const rawMode = mode !== 'product';
    const formats = mode === 'rescale'
      ? [BarcodeFormat.UPC_A, BarcodeFormat.UPC_E, BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.CODE_128, BarcodeFormat.CODE_39]
      : rawMode
        ? [BarcodeFormat.CODE_128, BarcodeFormat.CODE_39]
        : [BarcodeFormat.UPC_A, BarcodeFormat.UPC_E, BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.CODE_128];
    hints.set(DecodeHintType.POSSIBLE_FORMATS, formats);
    hints.set(DecodeHintType.TRY_HARDER, true);
    const reader = new BrowserMultiFormatReader(hints);
    let cancelled = false;

    // Per-run handles so teardown only ever stops the stream THIS run created —
    // under React StrictMode (dev) the effect mounts→unmounts→remounts, and a
    // shared-element teardown would kill the *next* run's live stream (black).
    let myControls = null;
    let myStream = null;
    const stopMine = () => {
      // Let zxing release its own stream via controls.stop(). We deliberately do
      // NOT stop tracks / clear srcObject ourselves: that raced with StrictMode
      // (dev) and HMR remounts and blanked the *live* stream (black scanner that
      // still "worked once"). The original camera-stays-on bug was the
      // double-start (two streams, one orphaned), already fixed by not calling
      // setDeviceId mid-effect — so a single controls.stop() now fully releases it.
      try { myControls?.stop(); } catch { /* noop */ }
      if (controlsRef.current === myControls) controlsRef.current = null;
    };

    setLive(false); setSlow(false); setError('');
    const slowTimer = setTimeout(() => { if (!cancelled) setSlow(true); }, 4500);

    (async () => {
      try {
        const want = rawMode ? { w: 1920, h: 1080 } : { w: 1280, h: 720 };
        const videoConstraints = {
          width: { ideal: want.w },
          height: { ideal: want.h },
          ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } }),
        };

        lastTextRef.current = null;
        myControls = await reader.decodeFromConstraints(
          { video: videoConstraints }, videoRef.current,
          (result, _err, controls) => {
            if (result && !doneRef.current) {
              const raw = result.getText();
              const text = rawMode ? raw.trim() : (raw.replace(/\D/g, '') || raw);
              if (rawMode && lastTextRef.current !== text) { lastTextRef.current = text; return; }
              if (!continuous) { doneRef.current = true; try { controls.stop(); } catch { /* noop */ } }
              onDetected(text);
            }
          },
        );
        myStream = videoRef.current?.srcObject || null;
        if (cancelled) { stopMine(); return; }
        controlsRef.current = myControls;

        // Some browsers don't auto-play the attached stream — force it. zxing may
        // start playback before React attaches onPlaying, so the event can be
        // missed; mark live as soon as play() resolves (the deterministic signal).
        try { await videoRef.current?.play?.(); if (!cancelled) setLive(true); } catch { /* autoplay policy / interrupted */ }

        const track = myStream?.getVideoTracks?.()[0] || null;
        trackRef.current = track;
        setSelDevice(track?.getSettings?.().deviceId || '');
        setHwZoom(applyZoom(track, zoom));

        // Populate the camera switcher without re-triggering this effect.
        try { const cams = await BrowserMultiFormatReader.listVideoInputDevices(); if (!cancelled) setDevices(cams); } catch { /* labels need permission */ }
      } catch (e) {
        if (!cancelled) {
          setError(e?.name === 'NotAllowedError'
            ? 'Camera permission was denied. Allow camera access and try again.'
            : 'Unable to start the camera. Use the scanner gun or enter the code manually.');
        }
      }
    })();

    return () => { cancelled = true; clearTimeout(slowTimer); stopMine(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId, restartKey]);

  useEffect(() => { if (trackRef.current) setHwZoom(applyZoom(trackRef.current, zoom)); }, [zoom]);

  const videoStyle = !hwZoom && zoom !== 1 ? { transform: `scale(${zoom})` } : undefined;
  const retry = () => { doneRef.current = false; setRestartKey((k) => k + 1); };

  return (
    <div className="scanner">
      {error ? (
        <div className="scanner-error">
          {error}
          <button type="button" className="btn sm ghost" style={{ marginTop: 8 }} onClick={retry}>Retry camera</button>
        </div>
      ) : (
        <>
          <div className="scanner-frame">
            <video ref={videoRef} className="scanner-video" style={videoStyle} muted playsInline autoPlay
              onPlaying={() => { setLive(true); setSlow(false); }} onCanPlay={() => setLive(true)} onLoadedData={() => setLive(true)} />
            <div className="scanner-reticle" />
            {!live && (
              <div className="scanner-loading">
                <span>Starting camera…</span>
                {slow && <button type="button" className="btn sm ghost" onClick={retry}>Camera blank? Tap to retry</button>}
              </div>
            )}
            {onZoomChange && (
              <div className="zoom-toggle on-frame" role="group" aria-label="Camera zoom">
                {[1, 2].map((z) => (
                  <button key={z} type="button" className={`btn sm ${zoom === z ? 'primary' : 'ghost'}`}
                    aria-pressed={zoom === z} onClick={() => onZoomChange(z)}>{z}×</button>
                ))}
              </div>
            )}
          </div>
          <p className="scanner-hint">Point the camera at the barcode.</p>
        </>
      )}

      <div className="scanner-controls">
        {devices.length > 1 && (
          <select value={selDevice} onChange={(e) => { doneRef.current = false; setSelDevice(e.target.value); setDeviceId(e.target.value); }}>
            {devices.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Camera ${i + 1}`}</option>)}
          </select>
        )}
        <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}
