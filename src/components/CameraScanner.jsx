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
export default function CameraScanner({ onDetected, onClose, zoom = 1, onZoomChange }) {
  const videoRef = useRef(null);
  const controlsRef = useRef(null);
  const trackRef = useRef(null);
  const doneRef = useRef(false);
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
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [
      BarcodeFormat.UPC_A,
      BarcodeFormat.UPC_E,
      BarcodeFormat.EAN_13,
      BarcodeFormat.EAN_8,
      BarcodeFormat.CODE_128,
    ]);
    // TRY_HARDER makes the 1D reader also attempt a 90°-rotated scan, so a
    // barcode held vertically reads without rotating the phone or the box.
    hints.set(DecodeHintType.TRY_HARDER, true);
    const reader = new BrowserMultiFormatReader(hints);
    let cancelled = false;

    (async () => {
      try {
        const cams = await BrowserMultiFormatReader.listVideoInputDevices();
        if (cancelled) return;
        setDevices(cams);
        // Prefer a rear/environment camera when available.
        const back = cams.find((d) => /back|rear|environment/i.test(d.label));
        const chosen = deviceId || back?.deviceId || cams[0]?.deviceId;
        setDeviceId(chosen);

        controlsRef.current = await reader.decodeFromVideoDevice(
          chosen,
          videoRef.current,
          (result, err, controls) => {
            if (result && !doneRef.current) {
              doneRef.current = true;
              controls.stop();
              const text = result.getText().replace(/\D/g, '');
              onDetected(text || result.getText());
            }
          }
        );

        // Grab the live video track so we can drive zoom, then apply the
        // current preference.
        const stream = videoRef.current?.srcObject;
        const track = stream?.getVideoTracks?.()[0] || null;
        trackRef.current = track;
        if (!cancelled) setHwZoom(applyZoom(track, zoom));
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
      trackRef.current = null;
      try { controlsRef.current?.stop(); } catch { /* noop */ }
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
