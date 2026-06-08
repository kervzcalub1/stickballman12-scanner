import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { api, getToken, setToken, clearToken } from './api.js';

// Lazy-loaded so the barcode library only downloads when the camera is opened.
const CameraScanner = lazy(() => import('./components/CameraScanner.jsx'));

let rowId = 1;
const newRow = () => ({ id: rowId++, size: '', quantity: '' });

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

  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [product, setProduct] = useState(null);
  const [rows, setRows] = useState([newRow()]);

  const [sendState, setSendState] = useState({ status: 'idle', msg: '' });
  const inputRef = useRef(null);

  // Keep the scanner-gun input focused so a HID scanner "types" straight in.
  useEffect(() => {
    if (mode === 'upc' && upcSubMode === 'scanner') inputRef.current?.focus();
  }, [mode, upcSubMode, product]);

  function resetResult() {
    setProduct(null);
    setRows([newRow()]);
    setSendState({ status: 'idle', msg: '' });
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
    } catch (err) {
      if (err.unauthorized) return onSignOut();
      setError(err.message);
    } finally {
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
  function addRow(afterId) {
    setRows((rs) => {
      const idx = rs.findIndex((r) => r.id === afterId);
      const copy = [...rs];
      copy.splice(idx + 1, 0, newRow());
      return copy;
    });
  }
  function removeRow(id) {
    setRows((rs) => (rs.length > 1 ? rs.filter((r) => r.id !== id) : rs));
  }

  async function sendToSheet() {
    const clean = rows
      .map((r) => ({ size: r.size.trim(), quantity: Number(r.quantity) }))
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
        <div className="brand">Stickballman12 · Shoe Scanner</div>
        <button className="btn ghost sm" onClick={onSignOut}>Sign out</button>
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

          {/* Size / Quantity rows */}
          <h3 className="rows-title">Sizes &amp; Quantities</h3>
          <datalist id="size-options">
            {product.sizes?.map((s) => <option key={s} value={s} />)}
          </datalist>

          <div className="rows">
            {rows.map((r) => (
              <div className="qty-row" key={r.id}>
                <input
                  className="size-in"
                  list="size-options"
                  placeholder="Size"
                  value={r.size}
                  onChange={(e) => updateRow(r.id, 'size', e.target.value)}
                />
                <input
                  className="qty-in"
                  type="number"
                  min="1"
                  placeholder="Qty"
                  value={r.quantity}
                  onChange={(e) => updateRow(r.id, 'quantity', e.target.value)}
                />
                <button
                  type="button"
                  className="btn icon"
                  title="Add another size"
                  onClick={() => addRow(r.id)}
                >
                  +
                </button>
                <button
                  type="button"
                  className="btn icon ghost"
                  title="Remove this size"
                  onClick={() => removeRow(r.id)}
                  disabled={rows.length === 1}
                >
                  −
                </button>
              </div>
            ))}
          </div>

          <div className="send">
            <button
              className="btn primary wide"
              onClick={sendToSheet}
              disabled={sendState.status === 'sending'}
            >
              {sendState.status === 'sending' ? 'Sending…' : 'Send to Sheet'}
            </button>
            {sendState.status === 'done' && <div className="ok mt">{sendState.msg}</div>}
            {sendState.status === 'error' && <div className="error mt">{sendState.msg}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
