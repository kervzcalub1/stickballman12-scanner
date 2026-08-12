// Existing Stock — count old stock (stock that predates this system) into the
// inventory, shelf by shelf.
//
// The flow is deliberately NOT the receiving wizard: these pairs have no shipment,
// no supplier, no tracking and no cost to capture, and there can be thousands of
// them. So it's a continuous loop — scan the shelf once, then scan pair after pair
// onto it — closer to Shelve/Put-away than to intake.
//
// Two things make this kind different (see docs/context/existing-stock.md):
//  · the pairs are ALREADY on the shelf, so the shelf is part of the count and the
//    commit shelves them in the same request (no needs_shelf round-trip); and
//  · they were ALREADY listed to II and the stores years ago, so they bypass the PH
//    team entirely (batches.kind='existing' ∈ PH_EXCLUDED_KINDS) and are recorded
//    as already-synced.
// They have no VIN labels yet, so a commit ends by opening the label print dialog.
import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { loadPrefs, savePrefs } from '../prefs.js';
import { TopBar, Modal, LabelSheet } from '../components/common.jsx';
import { Icon } from '../components/NavIcons.jsx';
import { useUnsavedGuard } from '../hooks.js';
import { isUpcCode, isLocationCode, compareSizes } from '../lib/codes.js';
import { useAutoAnimate } from '@formkit/auto-animate/react';
import { ShelfPicker } from '../components/ShelfPicker.jsx';

const CameraScanner = lazy(() => import('../components/CameraScanner.jsx'));

let rowKey = 1;

export function ExistingStock({ navBack, onHome, onSignOut }) {
  const [location, setLocation] = useState(null);  // the shelf being counted
  const [rows, setRows] = useState([]);            // { key, name, sku, upc, image, size, qty, withBox }
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showCam, setShowCam] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [done, setDone] = useState(null);          // commit result
  const [labels, setLabels] = useState(null);      // VIN labels to print after a commit
  const [prefs, setPrefs] = useState(loadPrefs);
  const setCameraZoom = (z) => setPrefs((p) => { const n = { ...p, cameraZoom: z }; savePrefs(n); return n; });
  const inputRef = useRef(null);
  const recentRef = useRef({});
  const [flash, setFlash] = useState(null);
  const flashTimer = useRef(null);
  const [listRef] = useAutoAnimate();
  useUnsavedGuard(rows.length > 0);

  // Same loud per-scan feedback as Shelve/Put-away: a colour banner (iOS has no
  // Vibration API) plus a best-effort haptic. Warehouse staff are looking at the
  // shoe, not the screen.
  function pulse(kind, text) {
    setFlash({ kind, text });
    try { navigator.vibrate?.(kind === 'dup' || kind === 'err' ? [30, 40, 30] : 30); } catch { /* unsupported */ }
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 1600);
  }
  useEffect(() => () => clearTimeout(flashTimer.current), []);

  // Keep the field hot for a HID scanner gun between scans. Deliberately NOT
  // focused while the camera is open (see the iOS keyboard-trap note in hooks).
  useEffect(() => {
    if (showCam) return undefined;
    const t = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [showCam, rows.length, location]);

  useEffect(() => {
    if (!navBack) return undefined;
    navBack.current = () => { if (showCam) { setShowCam(false); return true; } return false; };
    return () => { if (navBack) navBack.current = null; };
  }, [navBack, showCam]);

  const total = rows.reduce((n, r) => n + r.qty, 0);

  async function setShelf(code) {
    setError('');
    if (location && location.code === code) return;
    if (rows.length) { setError('Save or clear this shelf before switching to another one.'); pulse('err', 'Save this shelf first.'); return; }
    setBusy(true);
    try {
      const { location: loc } = await api.locationLookup(code);
      setLocation({ code: loc.code, label: loc.label, warehouse: loc.warehouse, area: loc.area, active: loc.active });
      pulse('shelf', `Counting onto ${loc.label || loc.code}. Now scan the pairs on it.`);
      if (loc.active === false) setError(`Heads up: “${loc.code}” is marked inactive — the count will be refused.`);
    } catch (err) {
      if (err.unauthorized) return onSignOut();
      setError(err.message); pulse('err', err.message);
    } finally { setBusy(false); }
  }

  // Scan a box UPC (or type a SKU) → resolve the shoe, then add/bump its size.
  // Old boxes often scan to a size-specific UPC, in which case the catalogue hands
  // back `scannedSize` and this is a pure one-scan-per-pair loop; when it doesn't,
  // the row lands with no size and is flagged so it can be filled in by hand.
  async function addProduct(code) {
    setError('');
    if (!location) { setError('Scan the shelf first.'); pulse('err', 'Scan the shelf first.'); return; }
    setBusy(true);
    try {
      const isUpc = isUpcCode(code);
      const { product: p } = isUpc ? await api.searchUpc(code) : await api.searchSku(code);
      const sku = p.sku || (isUpc ? '' : code);
      const size = p.scannedSize || '';
      setRows((rs) => {
        // Same SKU + same size → bump the qty rather than stacking duplicate rows.
        const at = rs.findIndex((r) => r.sku && sku && r.sku.toUpperCase() === sku.toUpperCase() && r.size === size);
        if (at >= 0 && size) {
          const next = rs.slice();
          next[at] = { ...next[at], qty: next[at].qty + 1 };
          return next;
        }
        return [{
          key: rowKey++, name: p.name || sku || code, sku, upc: (isUpc ? code : '') || p.upc || '',
          image: p.image || '', size, qty: 1, withBox: true,
          sizeOptions: (p.sizes || []).slice().sort(compareSizes),
        }, ...rs];
      });
      if (size) pulse('vin', `+1 · ${p.name || sku} · US ${size}`);
      else pulse('dup', `${p.name || sku || code} — no size from the catalogue. Set it below.`);
    } catch (err) {
      if (err.unauthorized) return onSignOut();
      setError(err.message); pulse('err', err.message);
    } finally { setBusy(false); }
  }

  // A shelf barcode switches the target; anything else is treated as a product
  // code. (Cooldown dedupes gun/camera re-reads of the same barcode.)
  function routeScan(raw) {
    const c = String(raw).trim().toUpperCase();
    if (!c) return;
    const now = Date.now();
    if (recentRef.current[c] && now - recentRef.current[c] < 1200) return;
    recentRef.current[c] = now;
    setInput('');
    if (isLocationCode(c)) return setShelf(c);
    return addProduct(c);
  }

  const patchRow = (key, patch) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const removeRow = (key) => setRows((rs) => rs.filter((r) => r.key !== key));
  const clearShelf = () => { setRows([]); setLocation(null); setError(''); };

  const missingSize = rows.filter((r) => !String(r.size || '').trim()).length;

  async function save() {
    if (!location || !rows.length) return;
    setShowConfirm(false);
    setBusy(true); setError('');
    try {
      // One item per unit — the server assigns a VIN to each, exactly as receiving
      // does, so labels/locate/sold-shipped all behave normally afterwards.
      const items = rows.flatMap((r) => Array.from({ length: r.qty }, () => ({
        name: r.name, sku: r.sku, size: r.size, upc: r.upc, image: r.image,
        withBox: r.withBox, source: 'manual',
      })));
      const res = await api.batchCommit({
        kind: 'existing',
        locationCode: location.code,
        batch: { origin: location.label || location.code },
        items,
      });
      // Keep the label items ON `done` — the success modal's "Print again" button
      // needs them after the sheet has been closed (closing sets `labels` to null,
      // so a button reading from `labels` would be permanently dead).
      const labelItems = items.map((it, i) => ({ ...it, vin: res.vins[i] }));
      setDone({
        count: res.count,
        batchCode: res.batchCode,
        shelved: res.shelved,
        label: location.label || location.code,
        labelItems,
      });
      // The pairs have no VIN stickers yet — that's the one part of this that can't
      // fix itself later, so go straight to the print dialog.
      setLabels(labelItems);
      setRows([]);
    } catch (err) {
      if (err.unauthorized) return onSignOut();
      setError(err.message);
    } finally { setBusy(false); }
  }

  return (
    <div className="app">
      <TopBar title="Existing Stock" onHome={onHome} onSignOut={onSignOut} />

      <div className="card">
        {flash && (
          <div className={`scan-flash scan-flash--${flash.kind}`} role="status" aria-live="assertive">
            <span className="scan-flash-ic">{flash.kind === 'dup' || flash.kind === 'err' ? '!' : '✓'}</span>
            <span>{flash.text}</span>
          </div>
        )}
        {location ? (
          <div className={`shelve-target${flash?.kind === 'shelf' ? ' flash-ok' : ''}`}>
            <span className="muted sm">Counting onto</span>
            <span className="shelve-loc"><Icon name="pin" /> {location.warehouse}{location.area ? ` · ${location.area}` : ''} · <b>{location.label || location.code}</b></span>
            <button type="button" className="btn ghost sm" onClick={clearShelf}>Change shelf</button>
          </div>
        ) : (
          <p className="muted">Scan the <b>shelf barcode</b> you're standing at, then scan the box of every pair already on it.</p>
        )}

        <form className="searchrow" onSubmit={(e) => { e.preventDefault(); routeScan(input); }}>
          <input ref={inputRef} autoCapitalize="characters" autoCorrect="off"
            placeholder={location ? 'Scan a box UPC — or type a SKU' : 'Scan a shelf barcode (e.g. MNH-WH-A2-04)'}
            value={input} onChange={(e) => setInput(e.target.value)} disabled={busy} />
          <button className="btn primary" disabled={busy}>Add</button>
          <button type="button" className={`btn ${showCam ? 'primary' : 'ghost'}`} onClick={() => setShowCam((v) => !v)} title="Scan with camera">
            <Icon name="camera" /> {showCam ? 'Close camera' : 'Scan with camera'}
          </button>
          {!location && <button type="button" className="btn ghost" onClick={() => setPickerOpen(true)}><Icon name="pin" /> Pick shelf</button>}
        </form>

        {showCam && (
          <Suspense fallback={<p className="muted">Loading camera…</p>}>
            <CameraScanner continuous mode="rescale" onDetected={routeScan} onClose={() => setShowCam(false)}
              zoom={prefs.cameraZoom} onZoomChange={setCameraZoom} />
          </Suspense>
        )}
        {error && <div className="error mt">{error}</div>}
        <p className="muted sm mt">
          These pairs are already listed on II and the stores, so they <b>never reach the PH team</b> and no price is fetched.
          Each one gets a VIN — print and stick the labels before moving to the next shelf.
        </p>
      </div>

      <div className="batch-bar">
        <button className="btn ghost" onClick={onHome}>← Home</button>
        <div className="batch-totals">
          <b>{total}</b> pair{total === 1 ? '' : 's'} on this shelf
          {missingSize ? ` · ${missingSize} need a size` : ''}
        </div>
        <button className="btn primary" disabled={busy || !location || !rows.length || missingSize > 0}
          onClick={() => setShowConfirm(true)}>{busy ? 'Saving…' : 'Save shelf'}</button>
      </div>

      {rows.length > 0 && (
        <div className="card">
          <div className="dcards" ref={listRef}>
            {rows.map((r) => (
              <div className="dcard" key={r.key}>
                <div className="dcard-top">
                  <span className="dcard-name">{r.name}</span>
                  <button type="button" className="btn icon ghost remove" title="Remove" onClick={() => removeRow(r.key)}>×</button>
                </div>
                <div className="muted sm">{r.sku || '—'}{r.upc ? ` · ${r.upc}` : ''}</div>
                <div className="dcard-line">
                  <label className="sm">Size&nbsp;
                    {r.sizeOptions?.length ? (
                      <select value={r.size} onChange={(e) => patchRow(r.key, { size: e.target.value })}>
                        <option value="">— pick —</option>
                        {r.sizeOptions.map((s) => <option key={s} value={s}>US {s}</option>)}
                      </select>
                    ) : (
                      <input className="sz-input" value={r.size} placeholder="US"
                        onChange={(e) => patchRow(r.key, { size: e.target.value })} />
                    )}
                  </label>
                  <span className="qty-ctl">
                    <button type="button" className="btn icon ghost" disabled={r.qty <= 1}
                      onClick={() => patchRow(r.key, { qty: r.qty - 1 })}>−</button>
                    <b>{r.qty}</b>
                    <button type="button" className="btn icon ghost" onClick={() => patchRow(r.key, { qty: r.qty + 1 })}>＋</button>
                  </span>
                </div>
                <label className="check-pill">
                  <input type="checkbox" checked={r.withBox} onChange={(e) => patchRow(r.key, { withBox: e.target.checked })} /> With box
                </label>
                {!r.withBox && <div className="muted sm">No box — can’t be shelved; it’ll go to the No Box queue.</div>}
              </div>
            ))}
          </div>
        </div>
      )}

      {pickerOpen && <ShelfPicker onPick={(c) => { setPickerOpen(false); setShelf(String(c).trim().toUpperCase()); }} onClose={() => setPickerOpen(false)} />}

      {showConfirm && location && (
        <Modal type="warn" title={`Count ${total} pair${total === 1 ? '' : 's'} onto ${location.label || location.code}?`}
          message={`These are recorded as already listed on II, Alias, StockX and Shopify, and will NOT appear for the PH team. Confirm the shelf is ${location.warehouse}${location.area ? ` · ${location.area}` : ''} · ${location.label || location.code}.`}
          onClose={() => setShowConfirm(false)}>
          <div className="confirm-list">
            {rows.slice(0, 5).map((r) => (
              <div key={r.key} className="confirm-line">
                <span className="muted sm">{r.name}{r.size ? ` · US ${r.size}` : ''} · ×{r.qty}</span>
              </div>
            ))}
            {rows.length > 5 && <div className="muted sm">+ {rows.length - 5} more</div>}
          </div>
          <button className="btn primary" onClick={save}>Confirm — count onto this shelf</button>
          <button className="btn ghost" onClick={() => setShowConfirm(false)}>Cancel</button>
        </Modal>
      )}

      {/* The print dialog opens first, so hold the summary back until it's closed
          rather than stacking two modals. */}
      {done && !labels && (
        <Modal type="success" title={`${done.count} pair${done.count === 1 ? '' : 's'} counted in`}
          message={`Batch ${done.batchCode} · ${done.shelved?.updated ?? 0} shelved at ${done.label}`
            + (done.shelved?.noBoxBlocked ? ` · ${done.shelved.noBoxBlocked} had no box and went to the No Box queue instead.` : '.')}
          onClose={() => setDone(null)}>
          <button className="btn primary" onClick={() => setLabels(done.labelItems)}>Print VIN labels again</button>
          <button className="btn ghost" onClick={() => { setDone(null); clearShelf(); }}>Next shelf</button>
          <button className="btn ghost" onClick={onHome}>← Home</button>
        </Modal>
      )}

      {labels && <LabelSheet items={labels} onClose={() => setLabels(null)} />}
    </div>
  );
}
