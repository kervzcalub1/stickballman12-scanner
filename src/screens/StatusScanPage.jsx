// Warehouse bulk action: scan many VINs (VIN only — not UPC) and mark them all
// Sold or Shipped at once. Reuses the bulk-status endpoint (sold cascades the
// delist). Unsaved scans are guarded against accidental Back/refresh.
import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { loadPrefs, savePrefs } from '../prefs.js';
import { TopBar, StatusPill, Modal } from '../components/common.jsx';
import { useUnsavedGuard, useMediaQuery } from '../hooks.js';
import { isVinCode } from '../lib/codes.js';

// Lazy-loaded so the barcode library only downloads when the camera is opened.
const CameraScanner = lazy(() => import('../components/CameraScanner.jsx'));

export function StatusScanPage({ target, navBack, onHome, onSignOut }) {
  const label = target === 'sold' ? 'Sold' : 'Shipped';
  const [rows, setRows] = useState([]);   // { vin, name, sku, size, status }
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const [showCam, setShowCam] = useState(false);
  const [prefs, setPrefs] = useState(loadPrefs);
  const setCameraZoom = (z) => setPrefs((p) => { const n = { ...p, cameraZoom: z }; savePrefs(n); return n; });
  const inputRef = useRef(null);
  const recentRef = useRef({});
  const isMobile = useMediaQuery('(max-width: 768px)');
  useUnsavedGuard(rows.length > 0);

  // Keep the box focused so a scanner gun types straight in.
  useEffect(() => { if (!showCam) { const t = setTimeout(() => inputRef.current?.focus(), 50); return () => clearTimeout(t); } }, [showCam, rows]);

  // Back closes the camera first; otherwise falls through to app navigation.
  useEffect(() => {
    if (!navBack) return undefined;
    navBack.current = () => { if (showCam) { setShowCam(false); return true; } return false; };
    return () => { if (navBack) navBack.current = null; };
  }, [navBack, showCam]);

  async function addVin(code) {
    const c = String(code).trim().toUpperCase();
    if (!c) return;
    const now = Date.now();
    if (recentRef.current[c] && now - recentRef.current[c] < 1200) return; // gun/camera re-read
    recentRef.current[c] = now;
    setInput(''); setError('');
    if (!isVinCode(c)) { setError(`“${c}” is not a VIN — scan the SBM-… label, not the UPC.`); return; }
    if (rows.some((r) => r.vin === c)) { setError(`${c} is already in the list.`); return; }
    setBusy(true);
    try {
      const { item } = await api.itemLookup(c);
      if (item.status === target) { setError(`${item.vin} is already ${label}.`); return; }
      setRows((rs) => [{ vin: item.vin, name: item.name, sku: item.sku, size: item.size, status: item.status }, ...rs]);
    } catch (err) {
      if (err.unauthorized) return onSignOut();
      setError(err.message);
    } finally { setBusy(false); }
  }
  const removeRow = (vin) => setRows((rs) => rs.filter((r) => r.vin !== vin));

  async function save() {
    if (!rows.length) return;
    setBusy(true); setError('');
    try {
      await api.bulkStatus(rows.map((r) => r.vin), target);
      setResult(`${rows.length} item${rows.length === 1 ? '' : 's'} marked ${label}.`);
      setRows([]);
    } catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="app">
      <TopBar title={`Mark ${label}`} onHome={onHome} onSignOut={onSignOut} />
      <div className="card">
        <form className="searchrow" onSubmit={(e) => { e.preventDefault(); addVin(input); }}>
          <input ref={inputRef} autoFocus autoCapitalize="characters" autoCorrect="off"
            placeholder="Scan a VIN (SBM-…)" value={input} onChange={(e) => setInput(e.target.value)} disabled={busy} />
          <button className="btn primary" disabled={busy}>Add</button>
          <button type="button" className={`btn ${showCam ? 'primary' : 'ghost'}`} onClick={() => setShowCam((v) => !v)} title="Scan with camera">{showCam ? '📷 Close camera' : '📷 Scan with camera'}</button>
        </form>
        {showCam && (
          <Suspense fallback={<p className="muted">Loading camera…</p>}>
            <CameraScanner continuous mode="vin" onDetected={addVin} onClose={() => setShowCam(false)}
              zoom={prefs.cameraZoom} onZoomChange={setCameraZoom} />
          </Suspense>
        )}
        {error && <div className="error mt">{error}</div>}
        <p className="muted sm mt">Scan each box’s VIN to mark it <b>{label}</b> (VIN only — not the product UPC).{target === 'sold' ? ' Marking sold also delists it from Intelligent Inventory and all stores.' : ''}</p>
      </div>

      <div className="batch-bar">
        <button className="btn ghost" onClick={onHome}>← Home</button>
        <div className="batch-totals"><b>{rows.length}</b> to mark {label}</div>
        <button className="btn primary" disabled={busy || !rows.length} onClick={save}>{busy ? 'Saving…' : `Save → ${label}`}</button>
      </div>

      {rows.length > 0 && (
        <div className="card">
          {isMobile ? (
            <div className="dcards">
              {rows.map((r) => (
                <div className="dcard" key={r.vin}>
                  <div className="dcard-top">
                    <span className="vin">{r.vin}</span>
                    <button type="button" className="btn icon ghost remove" title="Remove" onClick={() => removeRow(r.vin)}>×</button>
                  </div>
                  <div className="dcard-name">{r.name || '—'}</div>
                  <div className="dcard-line"><span>Size {r.size ? `US ${r.size}` : '—'}</span><StatusPill status={r.status} /></div>
                </div>
              ))}
            </div>
          ) : (
            <div className="inv-tablewrap">
              <table className="inv-table">
                <thead><tr><th className="inv-col-vin">VIN</th><th>Shoe</th><th className="inv-col-size">Size</th><th>Current status</th><th aria-label="remove" /></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.vin}>
                      <td className="inv-col-vin"><span className="vin">{r.vin}</span></td>
                      <td className="inv-name" title={r.name}>{r.name || '—'}</td>
                      <td className="inv-col-size">{r.size ? `US ${r.size}` : '—'}</td>
                      <td><StatusPill status={r.status} /></td>
                      <td><button type="button" className="btn icon ghost remove" title="Remove" onClick={() => removeRow(r.vin)}>×</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {result && (
        <Modal type="success" title={`Marked ${label}`} message={result} onClose={() => setResult('')}>
          <button className="btn primary" onClick={() => setResult('')}>Scan more</button>
          <button className="btn ghost" onClick={onHome}>← Home</button>
        </Modal>
      )}
    </div>
  );
}
