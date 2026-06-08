import React, { useEffect, useRef, useState } from 'react';
import { BrowserMultiFormatReader } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';

// Camera-based 1D barcode scanner (UPC-A / UPC-E / EAN-13 / EAN-8 / Code-128).
// Calls onDetected(code) once with the decoded digits, then stops.
export default function CameraScanner({ onDetected, onClose }) {
  const videoRef = useRef(null);
  const controlsRef = useRef(null);
  const doneRef = useRef(false);
  const [error, setError] = useState('');
  const [devices, setDevices] = useState([]);
  const [deviceId, setDeviceId] = useState(undefined);

  useEffect(() => {
    const hints = new Map();
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [
      BarcodeFormat.UPC_A,
      BarcodeFormat.UPC_E,
      BarcodeFormat.EAN_13,
      BarcodeFormat.EAN_8,
      BarcodeFormat.CODE_128,
    ]);
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
      try { controlsRef.current?.stop(); } catch { /* noop */ }
    };
    // Re-run when the selected device changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId]);

  return (
    <div className="scanner">
      {error ? (
        <div className="scanner-error">{error}</div>
      ) : (
        <>
          <div className="scanner-frame">
            <video ref={videoRef} className="scanner-video" muted playsInline />
            <div className="scanner-reticle" />
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
