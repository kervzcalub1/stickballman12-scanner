import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { api, getToken, setToken, clearToken } from './api.js';
import { loadPrefs, savePrefs } from './prefs.js';

// Lazy-loaded so the barcode library only downloads when the camera is opened.
const CameraScanner = lazy(() => import('./components/CameraScanner.jsx'));

let rowId = 1;
// A custom (user-typed) size row. `fixed` rows come from a known size list and
// show the size as a static label instead of an editable input.
const newRow = () => ({ id: rowId++, size: '', quantity: 0, fixed: false });

// Build the initial size/quantity rows for a product.
//   • StockX  — the API already knows the exact size for the scanned barcode,
//     so there is a single fixed-size row (quantity typed into a text box).
//   • Alias / KicksDB — a known size list laid out as the size/quantity table,
//     plus one blank editable row at the end for manually adding extra variants.
//   • Neither — start with one editable row the user can fill in / add to.
function buildRows(product) {
  const sizes = product?.sizes ?? [];
  if (product?.source === 'stockx') {
    return [{ id: rowId++, size: sizes[0] || '', quantity: '', fixed: Boolean(sizes[0]) }];
  }
  if (sizes.length) {
    return [
      ...sizes.map((s) => ({ id: rowId++, size: s, quantity: 0, fixed: true })),
      newRow(), // blank manual-entry row for sizes/variants not in the list
    ];
  }
  return [newRow()];
}

// Coerce an input value into a non-negative integer quantity.
function toQty(v) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/* --------------------------- Result dialog ----------------------------- */
// Lightweight modal used to confirm a successful "Send to Sheet" or surface a
// failure. Click the backdrop or press Escape to dismiss.
function Modal({ type, title, message, onClose, children }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className={`modal ${type}`}
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={`modal-icon ${type}`}>{type === 'success' ? '✓' : '✕'}</div>
        <h3 className="modal-title">{title}</h3>
        <p className="modal-msg">{message}</p>
        <div className="modal-actions">{children}</div>
      </div>
    </div>
  );
}

export default function App() {
  const [authed, setAuthed] = useState(Boolean(getToken()));

  if (!authed) return <Login onSuccess={() => setAuthed(true)} />;
  return <Scanner onSignOut={() => { clearToken(); setAuthed(false); }} />;
}

/* ------------------------------- Login --------------------------------- */

function Login({ onSuccess }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const { token } = await api.login(password);
      setToken(token);
      onSuccess();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app center">
      <form className="card login" onSubmit={submit}>
        <img className="app-logo" src="/logo.png" alt="Stickballman12 logo" />
        <h1>Stickballman12</h1>
        <p className="muted">Shoe Scanner — sign in to continue</p>
        <input
          type="password"
          placeholder="Access password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
        />
        {error && <div className="error">{error}</div>}
        <button className="btn primary" disabled={busy}>
          {busy ? 'Checking…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

/* ------------------------------ Scanner -------------------------------- */

function Scanner({ onSignOut }) {
  const [mode, setMode] = useState('upc'); // 'upc' | 'sku'
  const [upcSubMode, setUpcSubMode] = useState('scanner'); // 'scanner' | 'camera'

  // Persisted user preferences (e.g. camera zoom).
  const [prefs, setPrefs] = useState(loadPrefs);
  const [showPrefs, setShowPrefs] = useState(false);
  function setCameraZoom(zoom) {
    setPrefs((p) => {
      const next = { ...p, cameraZoom: zoom };
      savePrefs(next);
      return next;
    });
  }

  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [product, setProduct] = useState(null);
  const [rows, setRows] = useState([]);

  const [sendState, setSendState] = useState({ status: 'idle', msg: '' });
  const inputRef = useRef(null);
  // True once a search has run and the box still holds that (now stale) value.
  // The next keystroke from the scanner gun (or keyboard) then replaces it
  // instead of appending to it.
  const staleRef = useRef(false);

  // Keep the scanner-gun input focused so a HID scanner "types" straight in.
  useEffect(() => {
    if (mode === 'upc' && upcSubMode === 'scanner') inputRef.current?.focus();
  }, [mode, upcSubMode, product]);

  function resetResult() {
    setProduct(null);
    setRows([]);
    setSendState({ status: 'idle', msg: '' });
  }

  function dismissDialog() {
    setSendState({ status: 'idle', msg: '' });
  }

  // Modal "Scan another": clear everything and put the cursor back in the box.
  function scanAnother() {
    setInput('');
    staleRef.current = false;
    resetResult();
  }

  // On the scanner bar: if a previous search left a stale value in the box, the
  // first new keystroke wipes it so the freshly scanned barcode replaces it.
  function onScannerKeyDown(e) {
    if (staleRef.current && e.key.length === 1) {
      staleRef.current = false;
      if (inputRef.current) inputRef.current.value = '';
      setInput('');
    }
  }

  async function runSearch(value) {
    const q = (value ?? input).trim();
    if (!q) return;
    setLoading(true);
    setError('');
    resetResult();
    try {
      const { product: p } =
        mode === 'upc' ? await api.searchUpc(q) : await api.searchSku(q);
      setProduct(p);
      setRows(buildRows(p));
      setInput(''); // clear so the next scan starts fresh
    } catch (err) {
      if (err.unauthorized) return onSignOut();
      setError(err.message);
    } finally {
      staleRef.current = true; // box holds a searched value; replace it on next keystroke
      setLoading(false);
    }
  }

  function onCameraDetected(code) {
    setUpcSubMode('scanner');
    setInput(code);
    runSearch(code);
  }

  /* ---- size / quantity rows ---- */
  function updateRow(id, field, val) {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, [field]: val } : r)));
  }
  // Set a row's quantity from the text box (clamped to a non-negative integer).
  function setQty(id, val) {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, quantity: toQty(val) } : r)));
  }
  // Step a row's quantity up/down by `delta`, never below zero.
  function stepQty(id, delta) {
    setRows((rs) =>
      rs.map((r) => (r.id === id ? { ...r, quantity: Math.max(0, toQty(r.quantity) + delta) } : r))
    );
  }
  function addRow() {
    setRows((rs) => [...rs, newRow()]);
  }
  function removeRow(id) {
    setRows((rs) => (rs.length > 1 ? rs.filter((r) => r.id !== id) : rs));
  }

  async function sendToSheet() {
    const clean = rows
      .map((r) => ({ size: String(r.size).trim(), quantity: toQty(r.quantity) }))
      .filter((r) => r.size && r.quantity > 0);
    if (!clean.length) {
      setSendState({ status: 'error', msg: 'Add at least one size with a quantity.' });
      return;
    }
    const sizeKeys = clean.map((r) => r.size.toLowerCase());
    const dup = sizeKeys.find((s, i) => sizeKeys.indexOf(s) !== i);
    if (dup) {
      setSendState({ status: 'error', msg: `Size "${dup}" is listed more than once. Combine it into one row.` });
      return;
    }
    setSendState({ status: 'sending', msg: '' });
    try {
      const res = await api.sendToSheet(product, clean);
      setSendState({
        status: 'done',
        msg: res.message || `Sent ${res.count} size(s) to the sheet.`,
      });
    } catch (err) {
      if (err.unauthorized) return onSignOut();
      setSendState({ status: 'error', msg: err.message });
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img className="brand-logo" src="/logo.png" alt="" />
          <span>Stickballman12 · Shoe Scanner</span>
        </div>
        <div className="topbar-actions">
          <button
            className="btn ghost sm"
            onClick={() => setShowPrefs(true)}
            title="Preferences"
            aria-label="Preferences"
          >
            ⚙ Settings
          </button>
          <button className="btn ghost sm" onClick={onSignOut}>Sign out</button>
        </div>
      </header>

      {/* Mode tabs */}
      <div className="tabs">
        <button
          className={`tab ${mode === 'upc' ? 'active' : ''}`}
          onClick={() => { setMode('upc'); setInput(''); }}
        >
          Scan / Enter Barcode (UPC)
        </button>
        <button
          className={`tab ${mode === 'sku' ? 'active' : ''}`}
          onClick={() => { setMode('sku'); setInput(''); }}
        >
          Enter SKU
        </button>
      </div>

      <div className="card">
        {mode === 'upc' && (
          <>
            <div className="subtabs">
              <button
                className={`subtab ${upcSubMode === 'scanner' ? 'active' : ''}`}
                onClick={() => setUpcSubMode('scanner')}
              >
                🔫 Barcode Scanner
              </button>
              <button
                className={`subtab ${upcSubMode === 'camera' ? 'active' : ''}`}
                onClick={() => setUpcSubMode('camera')}
              >
                📷 Camera
              </button>
            </div>

            {upcSubMode === 'scanner' ? (
              <form
                className="searchrow"
                onSubmit={(e) => { e.preventDefault(); runSearch(); }}
              >
                <input
                  ref={inputRef}
                  inputMode="numeric"
                  placeholder="Scan with the gun or type the UPC, then Enter"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={onScannerKeyDown}
                />
                <button className="btn primary" disabled={loading}>
                  {loading ? 'Searching…' : 'Search'}
                </button>
              </form>
            ) : (
              <Suspense fallback={<p className="muted">Loading camera…</p>}>
                <CameraScanner
                  onDetected={onCameraDetected}
                  onClose={() => setUpcSubMode('scanner')}
                  zoom={prefs.cameraZoom}
                  onZoomChange={setCameraZoom}
                />
              </Suspense>
            )}
          </>
        )}

        {mode === 'sku' && (
          <form
            className="searchrow"
            onSubmit={(e) => { e.preventDefault(); runSearch(); }}
          >
            <input
              placeholder="Enter shoe SKU (e.g. DX2931-600)"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              autoFocus
            />
            <button className="btn primary" disabled={loading}>
              {loading ? 'Searching…' : 'Search'}
            </button>
          </form>
        )}

        {error && <div className="error mt">{error}</div>}
      </div>

      {/* Result */}
      {product && (
        <div className="card result">
          <div className="result-grid">
            {product.image ? (
              <img className="shoe-img" src={product.image} alt={product.name} loading="lazy" />
            ) : (
              <div className="shoe-img placeholder">No image</div>
            )}
            <div className="details">
              <h2>{product.name}</h2>
              <dl>
                <div><dt>SKU</dt><dd>{product.sku || '—'}</dd></div>
                <div><dt>UPC</dt><dd>{product.upc || '—'}</dd></div>
                {product.brand && <div><dt>Brand</dt><dd>{product.brand}</dd></div>}
                {product.colorway && <div><dt>Colorway</dt><dd>{product.colorway}</dd></div>}
              </dl>
              <span className="source">via {product.source}</span>
            </div>
          </div>

          {/* Size / Quantity */}
          {product.source === 'stockx' && rows[0] ? (
            // StockX already resolved the exact size for this barcode — show it
            // and just take a typed quantity.
            <>
              <h3 className="rows-title">Size &amp; Quantity</h3>
              <div className="single-variant">
                <div className="sv-field">
                  <span className="sv-label">Size</span>
                  {rows[0].fixed ? (
                    <span className="sv-size">{rows[0].size}</span>
                  ) : (
                    <input
                      className="size-in"
                      placeholder="Size"
                      value={rows[0].size}
                      onChange={(e) => updateRow(rows[0].id, 'size', e.target.value)}
                    />
                  )}
                </div>
                <div className="sv-field">
                  <span className="sv-label">Quantity</span>
                  <div className="qty-stepper">
                    <button
                      type="button"
                      className="btn icon ghost step"
                      title="Decrease quantity"
                      aria-label="Decrease quantity"
                      onClick={() => stepQty(rows[0].id, -1)}
                      disabled={toQty(rows[0].quantity) === 0}
                    >
                      −
                    </button>
                    <input
                      className="qty-in sv-qty"
                      type="number"
                      min="0"
                      inputMode="numeric"
                      placeholder="Qty"
                      value={rows[0].quantity}
                      onChange={(e) => setQty(rows[0].id, e.target.value)}
                    />
                    <button
                      type="button"
                      className="btn icon step"
                      title="Increase quantity"
                      aria-label="Increase quantity"
                      onClick={() => stepQty(rows[0].id, 1)}
                    >
                      +
                    </button>
                  </div>
                </div>
              </div>
            </>
          ) : (() => {
            // Manual (non-fixed) rows can be added/removed; always keep at least
            // one blank manual row so the "add" affordance is never lost.
            const editableCount = rows.filter((r) => !r.fixed).length;
            return (
              <>
                <h3 className="rows-title">Sizes &amp; Quantities</h3>
                <div className="size-table-wrap">
                  <table className="size-table">
                    <thead>
                      <tr>
                        <th>Size</th>
                        <th>Quantity</th>
                        <th className="actions-col" aria-label="Add or remove row" />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.id}>
                          <td className="size-cell">
                            {r.fixed ? (
                              <span className="size-label">{r.size}</span>
                            ) : (
                              <input
                                className="size-in"
                                placeholder="Add size…"
                                value={r.size}
                                onChange={(e) => updateRow(r.id, 'size', e.target.value)}
                              />
                            )}
                          </td>
                          <td>
                            <div className="qty-stepper">
                              <button
                                type="button"
                                className="btn icon ghost step"
                                title="Decrease quantity"
                                aria-label={`Decrease quantity for size ${r.size || 'row'}`}
                                onClick={() => stepQty(r.id, -1)}
                                disabled={toQty(r.quantity) === 0}
                              >
                                −
                              </button>
                              <input
                                className="qty-in"
                                type="number"
                                min="0"
                                inputMode="numeric"
                                value={r.quantity}
                                onChange={(e) => setQty(r.id, e.target.value)}
                              />
                              <button
                                type="button"
                                className="btn icon step"
                                title="Increase quantity"
                                aria-label={`Increase quantity for size ${r.size || 'row'}`}
                                onClick={() => stepQty(r.id, 1)}
                              >
                                +
                              </button>
                            </div>
                          </td>
                          <td className="row-actions">
                            {!r.fixed && (
                              <>
                                <button
                                  type="button"
                                  className="btn icon add-row"
                                  title="Add another row"
                                  aria-label="Add another manual row"
                                  onClick={addRow}
                                >
                                  ＋
                                </button>
                                <button
                                  type="button"
                                  className="btn icon ghost remove"
                                  title="Remove this row"
                                  aria-label="Remove this row"
                                  onClick={() => removeRow(r.id)}
                                  disabled={editableCount === 1}
                                >
                                  ×
                                </button>
                              </>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            );
          })()}

          <div className="send">
            <button
              className="btn primary wide"
              onClick={sendToSheet}
              disabled={sendState.status === 'sending'}
            >
              {sendState.status === 'sending' ? 'Sending…' : 'Send to Sheet'}
            </button>
          </div>
        </div>
      )}

      {sendState.status === 'done' && (
        <Modal
          type="success"
          title="Added to sheet"
          message={sendState.msg}
          onClose={dismissDialog}
        >
          <button className="btn primary" onClick={scanAnother}>Scan another</button>
          <button className="btn ghost" onClick={dismissDialog}>Close</button>
        </Modal>
      )}

      {sendState.status === 'error' && (
        <Modal
          type="error"
          title="Couldn’t add to sheet"
          message={sendState.msg}
          onClose={dismissDialog}
        >
          <button className="btn primary" onClick={dismissDialog}>OK</button>
        </Modal>
      )}

      {showPrefs && (
        <PreferencesModal
          prefs={prefs}
          onCameraZoom={setCameraZoom}
          onClose={() => setShowPrefs(false)}
        />
      )}
    </div>
  );
}

/* ----------------------------- Preferences ----------------------------- */
// Saved automatically (localStorage) as the user toggles — no separate Save.
function PreferencesModal({ prefs, onCameraZoom, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal prefs"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="modal-title">Preferences</h3>

        <div className="pref-row">
          <div className="pref-text">
            <div className="pref-label">Camera zoom</div>
            <div className="pref-help">Zoom in so you can scan from farther away.</div>
          </div>
          <div className="zoom-toggle" role="group" aria-label="Camera zoom">
            {[1, 2].map((z) => (
              <button
                key={z}
                type="button"
                className={`btn sm ${prefs.cameraZoom === z ? 'primary' : 'ghost'}`}
                aria-pressed={prefs.cameraZoom === z}
                onClick={() => onCameraZoom(z)}
              >
                {z}×
              </button>
            ))}
          </div>
        </div>

        <div className="modal-actions">
          <button className="btn primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
