import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { api, setToken, setUser, getUser, clearAuth } from './api.js';
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
  const [user, setUserState] = useState(getUser);
  const [view, setView] = useState('home'); // 'home' | 'bulk' | 'rapid' | 'access'

  function onAuthed(u) { setUserState(u); setView('home'); }
  function signOut() { clearAuth(); setUserState(null); setView('home'); }

  if (!user) return <Auth onAuthed={onAuthed} />;

  const go = (v) => setView(v);
  if (view === 'bulk') return <BulkScan onHome={() => go('home')} onSignOut={signOut} />;
  if (view === 'rapid') return <RapidScan user={user} onHome={() => go('home')} onSignOut={signOut} />;
  if (view === 'access') return <CheckAccess user={user} onHome={() => go('home')} onSignOut={signOut} />;
  return <Home user={user} onPick={go} onSignOut={signOut} />;
}

/* -------------------------------- Auth --------------------------------- */

function Auth({ onAuthed }) {
  const [tab, setTab] = useState('login'); // 'login' | 'signup'
  return (
    <div className="app center">
      <div className="card login">
        <img className="app-logo" src="/logo.png" alt="Stickballman12 logo" />
        <h1>Stickballman12</h1>
        <p className="muted">Shoe Scanner</p>
        <div className="tabs auth-tabs">
          <button className={`tab ${tab === 'login' ? 'active' : ''}`} onClick={() => setTab('login')}>Sign in</button>
          <button className={`tab ${tab === 'signup' ? 'active' : ''}`} onClick={() => setTab('signup')}>Create account</button>
        </div>
        {tab === 'login'
          ? <LoginForm onAuthed={onAuthed} />
          : <SignupForm onDone={() => setTab('login')} />}
      </div>
    </div>
  );
}

function LoginForm({ onAuthed }) {
  const [username, setU] = useState('');
  const [password, setP] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault(); setError(''); setBusy(true);
    try {
      const { token, user } = await api.login(username.trim(), password);
      setToken(token); setUser(user);
      onAuthed(user);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return (
    <form onSubmit={submit} className="auth-form">
      <input placeholder="Username" autoCapitalize="none" autoCorrect="off" value={username} onChange={(e) => setU(e.target.value)} autoFocus />
      <input type="password" placeholder="Password" value={password} onChange={(e) => setP(e.target.value)} />
      {error && <div className="error">{error}</div>}
      <button className="btn primary wide" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
    </form>
  );
}

function SignupForm({ onDone }) {
  const [name, setName] = useState('');
  const [username, setU] = useState('');
  const [password, setP] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  async function submit(e) {
    e.preventDefault(); setError(''); setBusy(true);
    try {
      await api.signup({ name: name.trim(), username: username.trim(), password });
      setDone(true);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  if (done) return (
    <div className="auth-done">
      <div className="modal-icon success">✓</div>
      <h3 className="modal-title">Account created</h3>
      <p className="muted">Please wait for an admin to approve your access. You can sign in once approved.</p>
      <button className="btn primary wide" onClick={onDone}>Back to sign in</button>
    </div>
  );
  return (
    <form onSubmit={submit} className="auth-form">
      <input placeholder="Full name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      <input placeholder="Username" autoCapitalize="none" autoCorrect="off" value={username} onChange={(e) => setU(e.target.value)} />
      <input type="password" placeholder="Password (min 8 chars)" value={password} onChange={(e) => setP(e.target.value)} />
      {error && <div className="error">{error}</div>}
      <button className="btn primary wide" disabled={busy}>{busy ? 'Creating…' : 'Create account'}</button>
    </form>
  );
}

/* ------------------------------ TopBar --------------------------------- */

function TopBar({ title, onHome, onSignOut, right }) {
  return (
    <header className="topbar">
      <div className="brand">
        <img className="brand-logo" src="/logo.png" alt="" />
        <span>{title || 'Stickballman12'}</span>
      </div>
      <div className="topbar-actions">
        {right}
        {onHome && <button className="btn ghost sm" onClick={onHome}>← Home</button>}
        <button className="btn ghost sm" onClick={onSignOut}>Sign out</button>
      </div>
    </header>
  );
}

/* ------------------------------- Home ---------------------------------- */

function Home({ user, onPick, onSignOut }) {
  const isAdmin = user.role === 'admin';
  return (
    <div className="app">
      <TopBar onSignOut={onSignOut} />
      <div className="home-greeting">Hi {user.name} <span className="role-badge">{user.role}</span></div>
      <div className="home-grid">
        {isAdmin && (
          <button className="home-card" onClick={() => onPick('access')}>
            <span className="home-card-icon">🔑</span>
            <span className="home-card-title">Check Access</span>
            <span className="home-card-sub">Approve new accounts</span>
          </button>
        )}
        <button className="home-card" onClick={() => onPick('bulk')}>
          <span className="home-card-icon">📦</span>
          <span className="home-card-title">Bulk Scan</span>
          <span className="home-card-sub">Enter sizes &amp; quantities</span>
        </button>
        <button className="home-card" onClick={() => onPick('rapid')}>
          <span className="home-card-icon">⚡</span>
          <span className="home-card-title">Rapid Scan</span>
          <span className="home-card-sub">Scan → confirm → qty 1</span>
        </button>
      </div>
    </div>
  );
}

/* --------------------------- Check Access ------------------------------ */

function CheckAccess({ onHome, onSignOut }) {
  const [users, setUsers] = useState(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);
  async function load() {
    setError('');
    try { const { users } = await api.adminListUsers(); setUsers(users); }
    catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
  }
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  async function review(id, decision) {
    setBusyId(id);
    try { await api.adminReview(id, decision); await load(); }
    catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setBusyId(null); }
  }
  return (
    <div className="app">
      <TopBar title="Check Access" onHome={onHome} onSignOut={onSignOut} />
      {error && <div className="error mt">{error}</div>}
      {!users ? <p className="muted">Loading…</p> : (
        <div className="card">
          {users.length === 0 ? <p className="muted">No accounts yet.</p> : (
            <table className="access-table">
              <thead><tr><th>Name</th><th>Username</th><th>Status</th><th aria-label="actions" /></tr></thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>{u.name}</td>
                    <td>{u.username}</td>
                    <td><span className={`status-pill ${u.status}`}>{u.status}</span></td>
                    <td className="access-actions">
                      {u.status !== 'approved' && <button className="btn sm primary" disabled={busyId === u.id} onClick={() => review(u.id, 'approve')}>Approve</button>}
                      {u.status !== 'rejected' && <button className="btn sm ghost" disabled={busyId === u.id} onClick={() => review(u.id, 'reject')}>Reject</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

/* --------------------------- Confirm dialog ---------------------------- */
// Pre-send double-check. NOT dismissable by backdrop or Escape — only Yes/No.
// SKU is given visual prominence so the user actually verifies it.
function ConfirmSend({ product, size, quantity, items, busy, onYes, onNo }) {
  return (
    <div className="modal-overlay">
      <div className="modal confirm" role="dialog" aria-modal="true">
        <h3 className="modal-title">Double-check before sending</h3>
        <div className="confirm-body">
          {product.image
            ? <img className="confirm-img" src={product.image} alt="" />
            : <div className="confirm-img placeholder">No image</div>}
          <div className="confirm-info">
            <div className="confirm-name">{product.name}</div>
            <div className="confirm-sku-box">
              <span className="confirm-sku-label">Verify this SKU</span>
              <span className="confirm-sku">{product.sku || '—'}</span>
            </div>
            {items ? (
              <div className="confirm-items">
                {items.map((it) => (
                  <span key={it.size} className="confirm-item">{it.size} <b>×{it.quantity}</b></span>
                ))}
              </div>
            ) : (
              <div className="confirm-meta">
                <span><b>Size</b> {size}</span>
                {quantity != null && <span><b>Qty</b> {quantity}</span>}
              </div>
            )}
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn ghost" onClick={onNo} disabled={busy}>No</button>
          <button className="btn primary" onClick={onYes} disabled={busy}>
            {busy ? 'Sending…' : 'Yes, send'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------- Rapid Scan ------------------------------- */
// Scan → confirm → send qty 1 → re-arm. StockX resolves the size automatically;
// Alias asks for the size first (selectable boxes, +W for women's).
function RapidScan({ onHome, onSignOut }) {
  const [subMode, setSubMode] = useState('scanner'); // 'scanner' | 'camera'
  const [prefs, setPrefs] = useState(loadPrefs);
  const [showPrefs, setShowPrefs] = useState(false);
  function setCameraZoom(zoom) {
    setPrefs((p) => { const n = { ...p, cameraZoom: zoom }; savePrefs(n); return n; });
  }

  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [product, setProduct] = useState(null);
  const [pendingSize, setPendingSize] = useState(null);
  const [sending, setSending] = useState(false);
  const [flash, setFlash] = useState(null); // { type:'ok'|'err', msg }
  const [camKey, setCamKey] = useState(0);   // bump to remount camera for the next scan

  const inputRef = useRef(null);
  const staleRef = useRef(false);

  useEffect(() => { if (subMode === 'scanner' && !product) inputRef.current?.focus(); }, [subMode, product]);
  useEffect(() => { if (!flash) return; const t = setTimeout(() => setFlash(null), 3500); return () => clearTimeout(t); }, [flash]);

  const isWomens = (p) => p && /women/i.test(p.name || '');
  const sizesWithW = (p) =>
    isWomens(p) ? (p.sizes || []).map((s) => (/[wW]$/.test(String(s)) ? s : `${s}W`)) : (p.sizes || []);

  function rearm() {
    setProduct(null);
    setPendingSize(null);
    setInput('');
    staleRef.current = false;
    setCamKey((k) => k + 1);
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  async function runSearch(value) {
    const q = (value ?? input).trim();
    if (!q) return;
    setLoading(true); setError(''); setProduct(null); setPendingSize(null);
    try {
      const { product: p } = await api.searchUpc(q);
      setProduct(p);
      // StockX already knows the size → straight to confirm; Alias → size grid.
      if (p.source === 'stockx' && p.sizes?.[0]) setPendingSize(p.sizes[0]);
      setInput('');
    } catch (err) {
      if (err.unauthorized) return onSignOut();
      setError(err.message);
    } finally {
      staleRef.current = true;
      setLoading(false);
    }
  }

  function onScannerKeyDown(e) {
    if (staleRef.current && e.key.length === 1) {
      staleRef.current = false;
      if (inputRef.current) inputRef.current.value = '';
      setInput('');
    }
  }
  function onCameraDetected(code) { setSubMode('scanner'); setInput(code); runSearch(code); }

  async function confirmYes() {
    if (!product || !pendingSize) return;
    setSending(true);
    try {
      const res = await api.rapidSend(product, pendingSize);
      setFlash({ type: 'ok', msg: res.message || 'Sent.' });
      rearm();
    } catch (err) {
      if (err.unauthorized) return onSignOut();
      setFlash({ type: 'err', msg: err.message });
    } finally {
      setSending(false);
    }
  }
  function confirmNo() { rearm(); }

  const showConfirm = product && pendingSize;
  const showSizeGrid = product && !pendingSize;

  return (
    <div className="app">
      <TopBar
        title="Rapid Scan"
        onHome={onHome}
        onSignOut={onSignOut}
        right={
          <button className="btn ghost sm" onClick={() => setShowPrefs(true)} title="Preferences" aria-label="Preferences">
            ⚙ Settings
          </button>
        }
      />

      <div className="card">
        <div className="subtabs">
          <button className={`subtab ${subMode === 'scanner' ? 'active' : ''}`} onClick={() => setSubMode('scanner')}>🔫 Scanner</button>
          <button className={`subtab ${subMode === 'camera' ? 'active' : ''}`} onClick={() => setSubMode('camera')}>📷 Camera</button>
        </div>

        {subMode === 'scanner' ? (
          <form className="searchrow" onSubmit={(e) => { e.preventDefault(); runSearch(); }}>
            <input
              ref={inputRef}
              inputMode="numeric"
              placeholder="Scan a barcode (UPC), then Enter"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onScannerKeyDown}
            />
            <button className="btn primary" disabled={loading}>{loading ? 'Searching…' : 'Go'}</button>
          </form>
        ) : (
          <Suspense fallback={<p className="muted">Loading camera…</p>}>
            <CameraScanner
              key={camKey}
              onDetected={onCameraDetected}
              onClose={() => setSubMode('scanner')}
              zoom={prefs.cameraZoom}
              onZoomChange={setCameraZoom}
            />
          </Suspense>
        )}

        {error && <div className="error mt">{error}</div>}
        {flash && <div className={`mt ${flash.type === 'ok' ? 'ok' : 'error'}`}>{flash.msg}</div>}
        <p className="muted rapid-hint">
          Records quantity 1 per scan. StockX sends after you confirm; Alias asks for the size first.
        </p>
      </div>

      {showSizeGrid && (
        <div className="card">
          <h3 className="rows-title">Select size</h3>
          <p className="muted confirm-name">{product.name}</p>
          {(product.sizes && product.sizes.length) ? (
            <div className="size-grid">
              {sizesWithW(product).map((s) => (
                <button key={s} type="button" className="size-box" onClick={() => setPendingSize(s)}>{s}</button>
              ))}
            </div>
          ) : (
            <p className="error">No sizes available for this product.</p>
          )}
          <button className="btn ghost mt" onClick={rearm}>Cancel</button>
        </div>
      )}

      {showConfirm && (
        <ConfirmSend product={product} size={pendingSize} busy={sending} onYes={confirmYes} onNo={confirmNo} />
      )}

      {showPrefs && (
        <PreferencesModal prefs={prefs} onCameraZoom={setCameraZoom} onClose={() => setShowPrefs(false)} />
      )}
    </div>
  );
}

/* ------------------------------ Bulk Scan ------------------------------ */

function BulkScan({ onHome, onSignOut }) {
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
  const [confirmItems, setConfirmItems] = useState(null); // opens the confirm dialog
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

  // Validate the rows, then open the confirm dialog (the actual send happens on
  // "Yes" in the dialog).
  function prepareSend() {
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
    setConfirmItems(clean);
  }

  async function doSend() {
    const clean = confirmItems;
    if (!clean) return;
    setSendState({ status: 'sending', msg: '' });
    try {
      const res = await api.sendToSheet(product, clean);
      setConfirmItems(null);
      setSendState({
        status: 'done',
        msg: res.message || `Sent ${res.count} size(s) to the sheet.`,
      });
    } catch (err) {
      setConfirmItems(null);
      if (err.unauthorized) return onSignOut();
      setSendState({ status: 'error', msg: err.message });
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img className="brand-logo" src="/logo.png" alt="" />
          <span>Bulk Scan</span>
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
          <button className="btn ghost sm" onClick={onHome}>← Home</button>
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
              onClick={prepareSend}
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

      {confirmItems && (
        <ConfirmSend
          product={product}
          items={confirmItems}
          busy={sendState.status === 'sending'}
          onYes={doSend}
          onNo={() => setConfirmItems(null)}
        />
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
