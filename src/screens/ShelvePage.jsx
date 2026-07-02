// Shelve / Put-away: scan a shelf barcode, then scan every shoe going on it, and
// submit — each unit is recorded at that shelf and (if it has a box) marked
// In Stock. A no-box unit gets a "has a box now?" toggle; ticking it makes the
// unit sellable, otherwise it's still recorded on the shelf but stays no-box.
// Re-scanning an already-stored unit onto another shelf is a transfer.
import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { loadPrefs, savePrefs } from '../prefs.js';
import { TopBar, StatusPill, Modal } from '../components/common.jsx';
import { Icon } from '../components/NavIcons.jsx';
import { useUnsavedGuard, useMediaQuery } from '../hooks.js';
import { isVinCode, isLocationCode } from '../lib/codes.js';

const CameraScanner = lazy(() => import('../components/CameraScanner.jsx'));

export function ShelvePage({ navBack, onHome, onSignOut }) {
  const [location, setLocation] = useState(null); // { code, label, warehouse, area }
  const [rows, setRows] = useState([]);            // { vin, name, sku, size, status, with_box, nowHasBox }
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const [showCam, setShowCam] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [prefs, setPrefs] = useState(loadPrefs);
  const setCameraZoom = (z) => setPrefs((p) => { const n = { ...p, cameraZoom: z }; savePrefs(n); return n; });
  const inputRef = useRef(null);
  const recentRef = useRef({});
  const isMobile = useMediaQuery('(max-width: 768px)');
  useUnsavedGuard(rows.length > 0);

  useEffect(() => { if (!showCam) { const t = setTimeout(() => inputRef.current?.focus(), 50); return () => clearTimeout(t); } }, [showCam, rows, location]);

  useEffect(() => {
    if (!navBack) return undefined;
    navBack.current = () => { if (showCam) { setShowCam(false); return true; } return false; };
    return () => { if (navBack) navBack.current = null; };
  }, [navBack, showCam]);

  async function setShelf(code) {
    setError('');
    if (location && location.code === code) return; // re-scanned the same shelf
    if (rows.length) { setError('Submit or clear the current shelf before switching shelves.'); return; }
    setBusy(true);
    try {
      const { location: loc } = await api.locationLookup(code);
      setLocation({ code: loc.code, label: loc.label, warehouse: loc.warehouse, area: loc.area, active: loc.active });
      if (loc.active === false) setError(`Heads up: “${loc.code}” is marked inactive.`);
    } catch (err) {
      if (err.unauthorized) return onSignOut();
      setError(err.message);
    } finally { setBusy(false); }
  }

  async function addVin(code) {
    setError('');
    if (!location) { setError('Scan the shelf barcode first.'); return; }
    if (rows.some((r) => r.vin === code)) { setError(`${code} is already in the list.`); return; }
    setBusy(true);
    try {
      const { item } = await api.itemLookup(code);
      if (item.status === 'sold' || item.status === 'shipped') { setError(`${item.vin} is ${item.status} — can’t shelve it.`); return; }
      setRows((rs) => [{ vin: item.vin, name: item.name, sku: item.sku, size: item.size, status: item.status, with_box: item.with_box, nowHasBox: false }, ...rs]);
    } catch (err) {
      if (err.unauthorized) return onSignOut();
      setError(err.message);
    } finally { setBusy(false); }
  }

  // Route a scan/typed code: a shelf barcode sets/switches the target; a VIN is
  // added to the list. (Cooldown dedupes gun/camera re-reads.)
  function routeScan(raw) {
    const c = String(raw).trim().toUpperCase();
    if (!c) return;
    const now = Date.now();
    if (recentRef.current[c] && now - recentRef.current[c] < 1200) return;
    recentRef.current[c] = now;
    setInput('');
    if (isVinCode(c)) return addVin(c);
    if (isLocationCode(c)) return setShelf(c);
    setError(`“${c}” isn’t a shelf barcode or a VIN.`);
  }

  const removeRow = (vin) => setRows((rs) => rs.filter((r) => r.vin !== vin));
  const setNowHasBox = (vin, v) => setRows((rs) => rs.map((r) => (r.vin === vin ? { ...r, nowHasBox: v } : r)));
  const clearShelf = () => { setRows([]); setLocation(null); setError(''); };

  async function save() {
    if (!location || !rows.length) return;
    setShowConfirm(false);
    setBusy(true); setError('');
    try {
      const units = rows.map((r) => ({ vin: r.vin, nowHasBox: r.with_box === false ? !!r.nowHasBox : false }));
      const res = await api.shelveItems(location.code, units);
      const boxNote = res.gotBox ? ` · ${res.gotBox} marked With Box` : '';
      setResult(`${res.updated} item${res.updated === 1 ? '' : 's'} shelved to ${location.label || location.code}${boxNote}.`);
      setRows([]);
    } catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setBusy(false); }
  }

  const noBoxCount = rows.filter((r) => r.with_box === false && !r.nowHasBox).length;

  return (
    <div className="app">
      <TopBar title="Shelve / Put-away" onHome={onHome} onSignOut={onSignOut} />
      <div className="card">
        {location ? (
          <div className="shelve-target">
            <span className="muted sm">Shelving to</span>
            <span className="shelve-loc"><Icon name="pin" /> {location.warehouse}{location.area ? ` · ${location.area}` : ''} · <b>{location.label || location.code}</b></span>
            <button type="button" className="btn ghost sm" onClick={clearShelf}>Change shelf</button>
          </div>
        ) : (
          <p className="muted">Scan a <b>shelf barcode</b> to begin, then scan each shoe going on it.</p>
        )}
        <form className="searchrow" onSubmit={(e) => { e.preventDefault(); routeScan(input); }}>
          <input ref={inputRef} autoFocus autoCapitalize="characters" autoCorrect="off"
            placeholder={location ? 'Scan a VIN (SBM-…) — or another shelf' : 'Scan a shelf barcode (e.g. MNH-WH-A2-04)'}
            value={input} onChange={(e) => setInput(e.target.value)} disabled={busy} />
          <button className="btn primary" disabled={busy}>Add</button>
          <button type="button" className={`btn ${showCam ? 'primary' : 'ghost'}`} onClick={() => setShowCam((v) => !v)} title="Scan with camera"><Icon name="camera" /> {showCam ? 'Close camera' : 'Scan with camera'}</button>
        </form>
        {showCam && (
          <Suspense fallback={<p className="muted">Loading camera…</p>}>
            <CameraScanner continuous mode="vin" onDetected={routeScan} onClose={() => setShowCam(false)}
              zoom={prefs.cameraZoom} onZoomChange={setCameraZoom} />
          </Suspense>
        )}
        {error && <div className="error mt">{error}</div>}
        <p className="muted sm mt">Boxed pairs become <b>In Stock</b> at this shelf. For a pair with <b>no box</b>, tick “has a box now?” to make it sellable — otherwise it’s still recorded here but stays no-box.</p>
      </div>

      <div className="batch-bar">
        <button className="btn ghost" onClick={onHome}>← Home</button>
        <div className="batch-totals"><b>{rows.length}</b> to shelve{noBoxCount ? ` · ${noBoxCount} still no-box` : ''}</div>
        <button className="btn primary" disabled={busy || !location || !rows.length} onClick={() => setShowConfirm(true)}>{busy ? 'Saving…' : 'Shelve here'}</button>
      </div>

      {showConfirm && location && (
        <Modal type="warn" title={`Shelve ${rows.length} pair${rows.length === 1 ? '' : 's'} to ${location.label || location.code}?`}
          message={`Confirm the shelf is correct — everything below goes to ${location.warehouse}${location.area ? ` · ${location.area}` : ''} · ${location.label || location.code}.`}
          onClose={() => setShowConfirm(false)}>
          <div className="confirm-list">
            {rows.slice(0, 5).map((r) => <div key={r.vin} className="confirm-line"><span className="vin">{r.vin}</span> <span className="muted sm">{r.name || '—'}{r.size ? ` · US ${r.size}` : ''}</span></div>)}
            {rows.length > 5 && <div className="muted sm">+ {rows.length - 5} more</div>}
          </div>
          <button className="btn primary" onClick={save}>Confirm — Shelve here</button>
          <button className="btn ghost" onClick={() => setShowConfirm(false)}>Cancel</button>
        </Modal>
      )}

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
                  {r.with_box === false && (
                    <label className="shelve-box-toggle"><input type="checkbox" checked={r.nowHasBox} onChange={(e) => setNowHasBox(r.vin, e.target.checked)} /> Has a box now?</label>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="inv-tablewrap">
              <table className="inv-table">
                <thead><tr><th className="inv-col-vin">VIN</th><th>Shoe</th><th className="inv-col-size">Size</th><th>Current status</th><th>Box?</th><th aria-label="remove" /></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.vin}>
                      <td className="inv-col-vin"><span className="vin">{r.vin}</span></td>
                      <td className="inv-name" title={r.name}>{r.name || '—'}</td>
                      <td className="inv-col-size">{r.size ? `US ${r.size}` : '—'}</td>
                      <td><StatusPill status={r.status} /></td>
                      <td>{r.with_box === false
                        ? <label className="shelve-box-toggle"><input type="checkbox" checked={r.nowHasBox} onChange={(e) => setNowHasBox(r.vin, e.target.checked)} /> has box now</label>
                        : <span className="muted sm">✓ boxed</span>}</td>
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
        <Modal type="success" title="Shelved" message={result} onClose={() => setResult('')}>
          <button className="btn primary" onClick={() => setResult('')}>Shelve more here</button>
          <button className="btn ghost" onClick={clearShelf}>Different shelf</button>
          <button className="btn ghost" onClick={onHome}>← Home</button>
        </Modal>
      )}
    </div>
  );
}
