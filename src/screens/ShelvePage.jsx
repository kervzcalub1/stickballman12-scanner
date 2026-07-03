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
import { useAutoAnimate } from '@formkit/auto-animate/react';
import { ShelfPicker } from '../components/ShelfPicker.jsx';

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
  const [listRef] = useAutoAnimate(); // shoes slide in as each VIN is scanned onto the shelf
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
      const blockNote = res.noBoxBlocked ? ` · ${res.noBoxBlocked} refused (still no box)` : '';
      setResult(`${res.updated} item${res.updated === 1 ? '' : 's'} shelved to ${location.label || location.code}${boxNote}${blockNote}.`);
      setRows((rs) => rs.filter((r) => r.with_box === false && !r.nowHasBox)); // keep the refused no-box rows so they're not lost
    } catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setBusy(false); }
  }

  const noBoxCount = rows.filter((r) => r.with_box === false && !r.nowHasBox).length;

  // ---- "Pick from list" put-away: select pending-shelf shoes, assign a shelf ----
  const [mode, setMode] = useState('scan'); // 'scan' (classic) | 'list'
  const [pending, setPending] = useState(null);
  const [pendSel, setPendSel] = useState(() => new Set());
  const [pickerOpen, setPickerOpen] = useState(false);
  const [listCam, setListCam] = useState(false);
  const [assignBusy, setAssignBusy] = useState(false);

  async function loadPending() {
    try { const { rows: r } = await api.itemsQuery({ status: 'needs_shelf' }); setPending(r || []); }
    catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
  }
  useEffect(() => { if (mode === 'list' && pending == null) loadPending(); }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const pendGroups = React.useMemo(() => {
    const m = new Map();
    for (const r of pending || []) {
      let g = m.get(r.sku || r.vin);
      if (!g) { g = { key: r.sku || r.vin, sku: r.sku, name: r.name, vins: [], _sizes: {} }; m.set(g.key, g); }
      g.vins.push(r.vin); g._sizes[r.size || '—'] = (g._sizes[r.size || '—'] || 0) + 1;
    }
    return [...m.values()].map((g) => ({ ...g, qty: g.vins.length,
      sizes: Object.entries(g._sizes).sort((a, b) => String(a[0]).localeCompare(b[0], undefined, { numeric: true })) }));
  }, [pending]);
  const groupSel = (g) => g.vins.length > 0 && g.vins.every((v) => pendSel.has(v));
  const toggleGroup = (g) => setPendSel((s) => { const n = new Set(s); const all = groupSel(g); g.vins.forEach((v) => (all ? n.delete(v) : n.add(v))); return n; });
  const allVins = React.useMemo(() => (pending || []).map((r) => r.vin), [pending]);
  const toggleAllPending = () => setPendSel((s) => (s.size === allVins.length && allVins.length ? new Set() : new Set(allVins)));

  async function assignShelf(code) {
    const c = String(code || '').trim().toUpperCase();
    if (!isLocationCode(c) || !pendSel.size) return;
    setPickerOpen(false); setListCam(false); setAssignBusy(true); setError('');
    try {
      const res = await api.shelveItems(c, [...pendSel].map((v) => ({ vin: v })));
      setResult(`${res.updated} item${res.updated === 1 ? '' : 's'} shelved to ${res.location?.label || c}.`);
      setPendSel(new Set()); await loadPending();
    } catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setAssignBusy(false); }
  }

  return (
    <div className="app">
      <TopBar title="Shelve / Put-away" onHome={onHome} onSignOut={onSignOut} />
      <div className="tabs shelve-tabs">
        <button className={`tab ${mode === 'scan' ? 'active' : ''}`} onClick={() => setMode('scan')}>Scan shelf → shoes</button>
        <button className={`tab ${mode === 'list' ? 'active' : ''}`} onClick={() => setMode('list')}>Pick from pending list</button>
      </div>

      {mode === 'scan' && (<>
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
        <p className="muted sm mt">Boxed pairs become <b>In Stock</b> at this shelf. A pair bought with <b>no box</b> can’t go on a shelf — tick “has a box now?” once you’ve found one; otherwise resolve it in the No Box queue first.</p>
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
            <div className="dcards" ref={listRef}>
              {rows.map((r) => (
                <div className="dcard" key={r.vin}>
                  <div className="dcard-top">
                    <span className="vin">{r.vin}</span>
                    <button type="button" className="btn icon ghost remove" title="Remove" onClick={() => removeRow(r.vin)}>×</button>
                  </div>
                  <div className="dcard-name">{r.name || '—'}</div>
                  <div className="dcard-line"><span>Size {r.size ? `US ${r.size}` : '—'}</span><StatusPill status={r.status} /></div>
                  {r.with_box === false && (
                    <label className="check-pill shelve-box-toggle"><input type="checkbox" checked={r.nowHasBox} onChange={(e) => setNowHasBox(r.vin, e.target.checked)} /> Has a box now?</label>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="inv-tablewrap">
              <table className="inv-table">
                <thead><tr><th className="inv-col-vin">VIN</th><th>Shoe</th><th className="inv-col-size">Size</th><th>Current status</th><th>Box?</th><th aria-label="remove" /></tr></thead>
                <tbody ref={listRef}>
                  {rows.map((r) => (
                    <tr key={r.vin}>
                      <td className="inv-col-vin"><span className="vin">{r.vin}</span></td>
                      <td className="inv-name" title={r.name}>{r.name || '—'}</td>
                      <td className="inv-col-size">{r.size ? `US ${r.size}` : '—'}</td>
                      <td><StatusPill status={r.status} /></td>
                      <td>{r.with_box === false
                        ? <label className="check-pill shelve-box-toggle"><input type="checkbox" checked={r.nowHasBox} onChange={(e) => setNowHasBox(r.vin, e.target.checked)} /> has box now</label>
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
      </>)}

      {mode === 'list' && (<>
        <div className="card">
          <div className="shelve-list-head">
            <span className="muted sm">{pending == null ? 'Loading…' : `${allVins.length} pair${allVins.length === 1 ? '' : 's'} pending a shelf`}</span>
            {allVins.length > 0 && <label className="check-pill sm"><input type="checkbox" checked={pendSel.size === allVins.length} onChange={toggleAllPending} /> Select all</label>}
          </div>
          <p className="muted sm">Select the shoes to put away, then pick a shelf (browse or scan) — a fast alternative to scanning each VIN.</p>
          {error && <div className="error mt">{error}</div>}
          {pending == null ? <p className="muted mt">Loading…</p>
            : !pendGroups.length ? <p className="ok mt">Nothing pending — every boxed shoe is on a shelf ✓</p>
              : (
                <div className="shelve-plist">
                  {pendGroups.map((g) => (
                    <label className={`shelve-prow ${groupSel(g) ? 'sel' : ''}`} key={g.key}>
                      <input type="checkbox" checked={groupSel(g)} onChange={() => toggleGroup(g)} />
                      <span className="shelve-prow-main">
                        <span className="shelve-prow-name">{g.name || '—'} <span className="muted sm">{g.sku || '—'} · ×{g.qty}</span></span>
                        <span className="shelve-prow-sizes">{g.sizes.map(([sz, n]) => <span className="istore-size" key={sz}>{sz}<span className="muted">×{n}</span></span>)}</span>
                      </span>
                    </label>
                  ))}
                </div>
              )}
        </div>
        <div className="batch-bar">
          <button className="btn ghost" onClick={onHome}>← Home</button>
          <div className="batch-totals"><b>{pendSel.size}</b> selected</div>
          <span className="shelve-assign">
            <button className="btn ghost" disabled={!pendSel.size || assignBusy} onClick={() => setListCam(true)}><Icon name="camera" /> Scan shelf</button>
            <button className="btn primary" disabled={!pendSel.size || assignBusy} onClick={() => setPickerOpen(true)}><Icon name="pin" /> {assignBusy ? 'Shelving…' : 'Pick shelf'}</button>
          </span>
        </div>
        {listCam && (
          <Suspense fallback={<p className="muted">Loading camera…</p>}>
            <CameraScanner mode="vin" onDetected={(c) => assignShelf(c)} onClose={() => setListCam(false)}
              zoom={prefs.cameraZoom} onZoomChange={setCameraZoom} />
          </Suspense>
        )}
      </>)}

      {pickerOpen && <ShelfPicker onPick={assignShelf} onClose={() => setPickerOpen(false)} />}

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
