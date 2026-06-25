import React, { useEffect, useRef, useState } from 'react';
import { BrowserMultiFormatReader } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';

// Camera-based 1D barcode scanner (UPC-A / UPC-E / EAN-13 / EAN-8 / Code-128).
// Calls onDetected(code) once with the decoded digits, then stops.
//
// `zoom` (1 or 2) is applied to the live camera track when the device supports
// the `zoom` capability (true optical/digital zoom, so the decoder also sees
// the magnified frames). On devices without that capability we fall back to a
// CSS transform — that magnifies the preview only, not the decoded frame.
// `mode`: 'product' (default — shoe UPC/EAN, digits only) vs any other value
// ('tracking', 'vin') which reads alphanumeric Code128/39 RAW (keeps letters &
// dashes, e.g. UPS 1Z… or our VIN SBM-…), at higher resolution with a two-read
// confirm for accuracy.
// `continuous`: keep decoding and fire onDetected for every read (the parent
// must de-dupe). Default false = stop after the first read.
export default function CameraScanner({ onDetected, onClose, zoom = 1, onZoomChange, mode = 'product', continuous = false }) {
  const videoRef = useRef(null);
  const controlsRef = useRef(null);
  const trackRef = useRef(null);
  const doneRef = useRef(false);
  const lastTextRef = useRef(null); // tracking: require two agreeing reads
  const [error, setError] = useState('');
  const [devices, setDevices] = useState([]);
  const [deviceId, setDeviceId] = useState(undefined);
  // Whether the active camera supports a real (hardware) zoom constraint.
  const [hwZoom, setHwZoom] = useState(false);

  // Apply the requested zoom to the live track if the camera supports it.
  // Returns true when hardware zoom is available.
  function applyZoom(track, z) {
    try {
      const caps = track?.getCapabilities?.();
      if (!caps || !('zoom' in caps)) return false;
      const min = caps.zoom.min ?? 1;
      const max = caps.zoom.max ?? z;
      const value = Math.min(max, Math.max(min, z));
      track.applyConstraints({ advanced: [{ zoom: value }] }).catch(() => {});
      return true;
    } catch {
      return false;
    }
  }

  useEffect(() => {
    const hints = new Map();
    // Non-product modes (tracking, vin) read alphanumeric Code128 (UPS 1Z,
    // FedEx Ground 96, our VIN SBM-…) + Code39. We exclude ITF/Codabar — their
    // weak self-checking causes false reads on long/partial barcodes.
    const rawMode = mode !== 'product';
    // 'rescale' reads BOTH our alphanumeric VIN (Code128/39) AND a product
    // UPC/EAN, keeping the raw text so VIN letters/dashes survive (a UPC still
    // comes through as digits). Other raw modes (tracking/vin) are Code128/39
    // only; product mode is the UPC/EAN set.
    const formats = mode === 'rescale'
      ? [BarcodeFormat.UPC_A, BarcodeFormat.UPC_E, BarcodeFormat.EAN_13,
         BarcodeFormat.EAN_8, BarcodeFormat.CODE_128, BarcodeFormat.CODE_39]
      : rawMode
        ? [BarcodeFormat.CODE_128, BarcodeFormat.CODE_39]
        : [BarcodeFormat.UPC_A, BarcodeFormat.UPC_E, BarcodeFormat.EAN_13,
           BarcodeFormat.EAN_8, BarcodeFormat.CODE_128];
    hints.set(DecodeHintType.POSSIBLE_FORMATS, formats);
    // TRY_HARDER makes the 1D reader also attempt a 90°-rotated scan, so a
    // barcode held vertically reads without rotating the phone or the box.
    hints.set(DecodeHintType.TRY_HARDER, true);
    const reader = new BrowserMultiFormatReader(hints);
    let cancelled = false;

    // Fully release the camera: stop the zxing scan loop AND every live track,
    // then detach the stream. controls.stop() alone doesn't reliably free the
    // device on all browsers, so the OS "camera in use" indicator can linger —
    // stopping the tracks directly is what actually turns the camera off.
    const stopCamera = () => {
      try { controlsRef.current?.stop(); } catch { /* noop */ }
      controlsRef.current = null;
      const stream = videoRef.current?.srcObject;
      if (stream && typeof stream.getTracks === 'function') {
        for (const t of stream.getTracks()) { try { t.stop(); } catch { /* noop */ } }
      }
      if (videoRef.current) videoRef.current.srcObject = null;
      trackRef.current = null;
    };

    (async () => {
      try {
        const cams = await BrowserMultiFormatReader.listVideoInputDevices();
        if (cancelled) return;
        setDevices(cams);
        // Prefer a rear/environment camera when available.
        const back = cams.find((d) => /back|rear|environment/i.test(d.label));
        const chosen = deviceId || back?.deviceId || cams[0]?.deviceId;
        setDeviceId(chosen);

        // Long barcodes (e.g. FedEx's 34-digit Code128) need resolution to
        // resolve the narrow bars — request a high-res stream, higher for
        // tracking. Falls back gracefully if the camera can't provide it.
        const want = rawMode ? { w: 1920, h: 1080 } : { w: 1280, h: 720 };
        const videoConstraints = {
          width: { ideal: want.w },
          height: { ideal: want.h },
          ...(chosen ? { deviceId: { exact: chosen } } : { facingMode: { ideal: 'environment' } }),
        };

        lastTextRef.current = null;
        controlsRef.current = await reader.decodeFromConstraints(
          { video: videoConstraints },
          videoRef.current,
          (result, err, controls) => {
            if (result && !doneRef.current) {
              const raw = result.getText();
              // Raw modes keep letters/dashes (UPS 1Z…, VIN SBM-…); product = digits.
              const text = rawMode ? raw.trim() : (raw.replace(/\D/g, '') || raw);
              // Raw modes: require two agreeing reads to reject transient misreads.
              if (rawMode) {
                if (lastTextRef.current !== text) { lastTextRef.current = text; return; }
              }
              // Single-shot: stop after the (confirmed) read. Continuous: keep
              // decoding and let the parent de-dupe (cooldown).
              if (!continuous) { doneRef.current = true; controls.stop(); }
              onDetected(text);
            }
          }
        );

        // The modal may have closed while the camera was still starting up — if
        // so, tear down the stream we just opened (it started after unmount, so
        // the cleanup below already ran and missed it).
        if (cancelled) { stopCamera(); return; }

        // Grab the live video track so we can drive zoom, then apply the
        // current preference.
        const stream = videoRef.current?.srcObject;
        const track = stream?.getVideoTracks?.()[0] || null;
        trackRef.current = track;
        setHwZoom(applyZoom(track, zoom));
      } catch (e) {
        if (!cancelled) {
          setError(
            e?.name === 'NotAllowedError'
              ? 'Camera permission was denied. Allow camera access and try again.'
              : 'Unable to start the camera. Use the scanner gun or enter the code manually.'
          );
        }
      }
    })();

    return () => {
      cancelled = true;
      stopCamera();
    };
    // Re-run when the selected device changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId]);

  // Re-apply zoom whenever the preference changes while the camera is open.
  useEffect(() => {
    if (trackRef.current) setHwZoom(applyZoom(trackRef.current, zoom));
  }, [zoom]);

  // CSS fallback only kicks in when the camera lacks hardware zoom.
  const videoStyle =
    !hwZoom && zoom !== 1 ? { transform: `scale(${zoom})` } : undefined;

  return (
    <div className="scanner">
      {error ? (
        <div className="scanner-error">{error}</div>
      ) : (
        <>
          <div className="scanner-frame">
            <video ref={videoRef} className="scanner-video" style={videoStyle} muted playsInline />
            <div className="scanner-reticle" />
            {onZoomChange && (
              <div className="zoom-toggle on-frame" role="group" aria-label="Camera zoom">
                {[1, 2].map((z) => (
                  <button
                    key={z}
                    type="button"
                    className={`btn sm ${zoom === z ? 'primary' : 'ghost'}`}
                    aria-pressed={zoom === z}
                    onClick={() => onZoomChange(z)}
                  >
                    {z}×
                  </button>
                ))}
              </div>
            )}
          </div>
          <p className="scanner-hint">Point the camera at the barcode.</p>
        </>
      )}

      <div className="scanner-controls">
        {devices.length > 1 && (
          <select
            value={deviceId || ''}
            onChange={(e) => {
              doneRef.current = false;
              setDeviceId(e.target.value);
            }}
          >
            {devices.map((d, i) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `Camera ${i + 1}`}
              </option>
            ))}
          </select>
        )}
        <button type="button" className="btn ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
