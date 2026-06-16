import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, setToken, setUser, getUser, clearAuth } from './api.js';
import { loadPrefs, savePrefs } from './prefs.js';

// Lazy-loaded so the barcode library only downloads when the camera is opened.
const CameraScanner = lazy(() => import('./components/CameraScanner.jsx'));

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
  const [view, setView] = useState('home'); // 'home' | 'bulk' | 'rapid' | 'receiving' | 'inventory' | 'access'

  function onAuthed(u) { setUserState(u); setView('home'); }
  function signOut() { clearAuth(); setUserState(null); setView('home'); }

  if (!user) return <Auth onAuthed={onAuthed} />;

  const go = (v) => setView(v);
  if (view === 'receiving') return <Receiving user={user} onHome={() => go('home')} onSignOut={signOut} />;
  if (view === 'inventory') return <Inventory onHome={() => go('home')} onSignOut={signOut} />;
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
      <input placeholder="Username" autoCapitalize="none" autoCorrect="off" autoComplete="username" value={username} onChange={(e) => setU(e.target.value)} autoFocus />
      <input type="password" placeholder="Password" autoComplete="current-password" value={password} onChange={(e) => setP(e.target.value)} />
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
      <input placeholder="Full name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      <input placeholder="Username" autoCapitalize="none" autoCorrect="off" autoComplete="username" value={username} onChange={(e) => setU(e.target.value)} />
      <input type="password" placeholder="Password (min 8 chars)" autoComplete="new-password" value={password} onChange={(e) => setP(e.target.value)} />
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
        <button className="home-card" onClick={() => onPick('receiving')}>
          <span className="home-card-icon">📥</span>
          <span className="home-card-title">Receiving</span>
          <span className="home-card-sub">Scan a shipment into a batch</span>
        </button>
        <button className="home-card" onClick={() => onPick('inventory')}>
          <span className="home-card-icon">🔎</span>
          <span className="home-card-title">Inventory</span>
          <span className="home-card-sub">Search, scan, report &amp; print labels</span>
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

/* ------------------------------ Receiving ------------------------------ */
// Batch intake: fill shipment details, scan many items into a cart (lookups
// resolve in the background so scanning never blocks), add shipment issues,
// then commit once → DB (one VIN per item) + Sheet mirror.

let cartKey = 1;
const SUPPLIERS = ['Sunny', 'Nike', 'Foot Locker', 'DTLR', 'Snipes', 'Champs', 'Finish Line', 'Shoe Palace'];

// Extract a clean carrier tracking number from a scanned shipping barcode.
// UPS 1Z barcodes encode the tracking directly; FedEx Ground "96…" barcodes
// encode 34 digits whose last 12 are the tracking number.
function parseTrackingNumber(raw) {
  const s = String(raw || '').toUpperCase().replace(/\s+/g, '');
  const ups = s.match(/1Z[0-9A-Z]{16}/);            // UPS: 1Z + 16 chars
  if (ups) return ups[0];
  if (/^\d{20,40}$/.test(s) && s.startsWith('96')) return s.slice(-12); // FedEx Ground 96-barcode
  if (/^\d{12}$/.test(s)) return s;                 // FedEx Express
  return s;                                         // anything else: as scanned
}
// Standard US shoe-size chart — a last-resort fallback to populate the "add
// another size" dropdown when the API returns only the single scanned size.
// `kind`: 'w' women's (5–12, "W" suffix), 'y' youth/kids (1–7, "Y" suffix),
// '' men's (6–16, no suffix). Half sizes included.
function usSizeChart(kind) {
  const ranges = { w: [5, 12], y: [1, 7], '': [6, 16] };
  const [lo, hi] = ranges[kind] || ranges[''];
  const out = [];
  for (let h = lo * 2; h <= hi * 2; h++) {
    const n = h / 2;
    const label = Number.isInteger(n) ? String(n) : n.toFixed(1);
    out.push(kind ? `${label}${kind.toUpperCase()}` : label);
  }
  return out;
}
const ISSUE_TYPES = [
  ['mismatched', 'Mismatched shoe'],
  ['stolen', 'Stolen package'],
  ['ripped', 'Package ripped open'],
  ['improperly_packed', 'Improperly packed'],
  ['missing_boxes', 'Missing boxes'],
  ['shortfall', 'Short count (expected vs received)'],
  ['other', 'Other'],
];

function Receiving({ onHome, onSignOut }) {
  const [tab, setTab] = useState('intake'); // 'intake' | 'recent'
  const today = new Date().toISOString().slice(0, 10);
  const [header, setHeader] = useState({
    buyer: '', supplier: '', tracking: '', dateReceived: today,
    defaultCost: '', notes: '', specialRules: '',
  });
  const setH = (k, v) => setHeader((h) => ({ ...h, [k]: v }));
  const [customSupplier, setCustomSupplier] = useState(false);
  const [scanTracking, setScanTracking] = useState(false);

  const [showCam, setShowCam] = useState(false); // camera needs activating; the gun just types into the field
  const [prefs, setPrefs] = useState(loadPrefs);
  const [showPrefs, setShowPrefs] = useState(false);
  const setCameraZoom = (zoom) => setPrefs((p) => { const n = { ...p, cameraZoom: zoom }; savePrefs(n); return n; });

  const [input, setInput] = useState('');
  const inputRef = useRef(null);
  const staleRef = useRef(false);

  const [cart, setCart] = useState([]);
  const [issues, setIssues] = useState([]);
  const [error, setError] = useState('');
  const [showConfirm, setShowConfirm] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [result, setResult] = useState(null);
  const [scanFlash, setScanFlash] = useState(null); // { type:'added'|'dup', text }
  const [printLabels, setPrintLabels] = useState(null); // { batchCode, items }

  // Refs (always current, even inside the camera's captured callback):
  const recentRef = useRef({});        // code -> last scan time (cooldown vs camera re-reads)
  const codesRef = useRef(new Set());  // codes already in the cart (de-dupe)
  const defaultCostRef = useRef(header.defaultCost);
  defaultCostRef.current = header.defaultCost;

  useEffect(() => { if (tab === 'intake' && !showCam) inputRef.current?.focus(); }, [tab, showCam, cart.length]);
  useEffect(() => { if (!scanFlash) return; const t = setTimeout(() => setScanFlash(null), 2200); return () => clearTimeout(t); }, [scanFlash]);

  // Short audible + haptic confirmation that a box registered.
  function scanFeedback(kind) {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) {
        const ctx = new Ctx();
        const o = ctx.createOscillator(); const g = ctx.createGain();
        o.frequency.value = kind === 'added' ? 920 : 330;
        g.gain.value = 0.05; o.connect(g); g.connect(ctx.destination);
        o.start(); setTimeout(() => { o.stop(); ctx.close(); }, 90);
      }
    } catch { /* no audio */ }
    try { navigator.vibrate?.(kind === 'added' ? 70 : [30, 40, 30]); } catch { /* no haptics */ }
  }

  const updateLine = (key, patch) => setCart((c) => c.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const removeLine = (key) => setCart((c) => {
    const l = c.find((x) => x.key === key);
    if (l?.code) codesRef.current.delete(l.code);
    return c.filter((x) => x.key !== key);
  });

  // Sizes are used exactly as the API returns them (a "W" appears only if the
  // API's own size value has it — we never synthesize it from the title).
  const newSizeRow = (size = '') => ({ key: cartKey++, size, quantity: 1, cost: defaultCostRef.current });

  // size sub-rows within a scanned product line
  function addSizeRow(lineKey, size) {
    setCart((c) => c.map((l) => {
      if (l.key !== lineKey) return l;
      if (size && l.rows.some((r) => r.size === size)) return l; // already added
      return { ...l, rows: [...l.rows, newSizeRow(size)] };
    }));
  }
  function updateSizeRow(lineKey, rowKey, patch) {
    setCart((c) => c.map((l) => (l.key === lineKey
      ? { ...l, rows: l.rows.map((r) => (r.key === rowKey ? { ...r, ...patch } : r)) }
      : l)));
  }
  function removeSizeRow(lineKey, rowKey) {
    setCart((c) => c.map((l) => (l.key === lineKey
      ? { ...l, rows: l.rows.filter((r) => r.key !== rowKey) }
      : l)));
  }

  async function resolve(key, code) {
    try {
      const isUpc = /^\d{8,14}$/.test(code);
      const { product: p } = isUpc ? await api.searchUpc(code) : await api.searchSku(code);
      const sizes = p.sizes || []; // full option list for the dropdown (W only if the API has it)
      setCart((c) => c.map((l) => {
        if (l.key !== key) return l;
        // StockX resolves the exact scanned size → auto-add it as a row; the full
        // size run (enriched from Alias) stays in `sizes` to feed the dropdown.
        const autoRow = p.scannedSize ? [newSizeRow(p.scannedSize)] : l.rows;
        return {
          ...l, name: p.name || '', sku: p.sku || '', image: p.image || '',
          source: p.source || 'manual', sizes, rows: autoRow, status: 'ready',
        };
      }));
      // StockX (and barcodes generally) resolve only the scanned size, so the
      // "add another size" dropdown would be empty. Fetch the full size run by
      // SKU so every API ends up with the complete list to choose from.
      if (sizes.length <= 1 && p.sku) {
        try {
          const { product: full } = await api.searchSku(p.sku);
          const fullSizes = full?.sizes || [];
          if (fullSizes.length > 1) updateLine(key, { sizes: fullSizes });
        } catch { /* keep the single known size */ }
      }
    } catch (err) {
      if (err.unauthorized) return onSignOut();
      updateLine(key, { status: 'error', error: err.message });
    }
  }

  function addScan(code) {
    const c = String(code).trim();
    if (!c) return;
    const now = Date.now();
    // Cooldown: ignore the same code re-read within 1.2s (kills the camera's
    // continuous re-detection of a box still held in frame).
    if (recentRef.current[c] && now - recentRef.current[c] < 1200) return;
    recentRef.current[c] = now;
    setInput(''); staleRef.current = false;
    // De-dupe: one line per product. A second scan of the same box just flashes
    // a reminder to use the quantity field (don't add a duplicate line).
    if (codesRef.current.has(c)) {
      setScanFlash({ type: 'dup', text: 'Already in list — set its quantity below.' });
      scanFeedback('dup');
      return;
    }
    codesRef.current.add(c);
    const key = cartKey++;
    const upc = /^\d{8,14}$/.test(c) ? c : '';
    setCart((prev) => [...prev, {
      key, code: c, upc, name: '', sku: '', image: '', source: 'manual',
      sizes: [], rows: [], status: 'resolving',
    }]);
    resolve(key, c);
    setScanFlash({ type: 'added', text: `✓ Scanned ${c}` });
    scanFeedback('added');
  }

  function addManual() {
    const key = cartKey++;
    setCart((prev) => [...prev, {
      key, code: '', upc: '', name: '', sku: '', image: '', source: 'manual',
      sizes: [], rows: [newSizeRow('')], status: 'manual',
    }]);
  }

  function onScannerKeyDown(e) {
    if (staleRef.current && e.key.length === 1) {
      staleRef.current = false;
      if (inputRef.current) inputRef.current.value = '';
      setInput('');
    }
  }

  const addIssue = () => setIssues((is) => [...is, { key: cartKey++, type: 'mismatched', description: '', expectedCount: '', receivedCount: '' }]);
  const updateIssue = (key, patch) => setIssues((is) => is.map((i) => (i.key === key ? { ...i, ...patch } : i)));
  const removeIssue = (key) => setIssues((is) => is.filter((i) => i.key !== key));

  const rowQty = (r) => Math.max(1, Number(r.quantity) || 0);
  const totalItems = cart.reduce((s, l) => s + l.rows.reduce((a, r) => a + rowQty(r), 0), 0);
  const totalCost = cart.reduce((s, l) => s + l.rows.reduce((a, r) => a + rowQty(r) * (Number(r.cost) || 0), 0), 0);
  const resolving = cart.some((l) => l.status === 'resolving');

  function startCommit() {
    setError('');
    // Shipment details required for traceability (tracking stays optional —
    // drop-offs may have none).
    if (!String(header.supplier).trim()) { setError('Select a supplier.'); return; }
    if (!String(header.buyer).trim()) { setError('Enter the buyer.'); return; }
    if (!String(header.dateReceived).trim()) { setError('Enter the date received.'); return; }
    if (!cart.length) { setError('Scan or add at least one item first.'); return; }
    if (cart.some((l) => !String(l.name).trim())) { setError('Every item needs a name.'); return; }
    if (cart.some((l) => !l.rows.length)) { setError('Every item needs at least one size — pick from the dropdown.'); return; }
    if (cart.some((l) => l.rows.some((r) => !String(r.size).trim()))) { setError('Fill in the highlighted sizes.'); return; }
    setShowConfirm(true);
  }

  async function doCommit() {
    setCommitting(true);
    try {
      // Expand each product's size rows into individual physical items
      // (quantity N → N items → N VINs).
      const items = [];
      for (const l of cart) {
        for (const r of l.rows) {
          const cost = r.cost === '' || r.cost == null ? null : Number(r.cost);
          for (let n = 0; n < rowQty(r); n++) {
            items.push({ name: l.name, sku: l.sku, size: r.size, upc: l.upc, image: l.image, source: l.source, cost });
          }
        }
      }
      const payload = {
        batch: { ...header, defaultCost: header.defaultCost === '' ? null : Number(header.defaultCost) },
        items,
        issues: issues.map((i) => ({
          type: i.type, description: i.description,
          expectedCount: i.expectedCount === '' ? null : Number(i.expectedCount),
          receivedCount: i.receivedCount === '' ? null : Number(i.receivedCount),
        })),
      };
      const res = await api.batchCommit(payload);
      setShowConfirm(false);
      // Pair each returned VIN with its item so labels can print right away.
      const printItems = (res.vins || []).map((vin, i) => ({
        vin, name: payload.items[i]?.name, sku: payload.items[i]?.sku, size: payload.items[i]?.size,
      }));
      setResult({ ...res, printItems });
      setCart([]); setIssues([]); setScanFlash(null);
      codesRef.current.clear(); recentRef.current = {};
      setHeader((h) => ({ ...h, tracking: '', notes: '', specialRules: '' })); // keep buyer/supplier/date/cost
    } catch (err) {
      setShowConfirm(false);
      if (err.unauthorized) return onSignOut();
      setError(err.message);
    } finally {
      setCommitting(false);
    }
  }

  return (
    <div className="app">
      <TopBar
        title="Receiving"
        onHome={onHome}
        onSignOut={onSignOut}
        right={<button className="btn ghost sm" onClick={() => setShowPrefs(true)} title="Preferences">⚙</button>}
      />

      <div className="tabs auth-tabs">
        <button className={`tab ${tab === 'intake' ? 'active' : ''}`} onClick={() => setTab('intake')}>New Batch</button>
        <button className={`tab ${tab === 'recent' ? 'active' : ''}`} onClick={() => setTab('recent')}>Recent</button>
      </div>

      {tab === 'recent' ? <BatchList onSignOut={onSignOut} /> : (
        <>
          {/* Shipment details */}
          <div className="card">
            <h3 className="rows-title">Shipment details</h3>
            <div className="batch-form">
              <label>Buyer *<input value={header.buyer} onChange={(e) => setH('buyer', e.target.value)} /></label>
              <label>Supplier *
                <select
                  value={customSupplier ? '__custom__' : header.supplier}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === '__custom__') { setCustomSupplier(true); setH('supplier', ''); }
                    else { setCustomSupplier(false); setH('supplier', v); }
                  }}
                >
                  <option value="">Select supplier…</option>
                  {SUPPLIERS.map((s) => <option key={s} value={s}>{s}</option>)}
                  <option value="__custom__">Custom…</option>
                </select>
              </label>
              {customSupplier && (
                <label>Custom supplier<input autoFocus value={header.supplier} onChange={(e) => setH('supplier', e.target.value)} placeholder="Type supplier name" /></label>
              )}
              <label>Tracking #
                <span className="track-field">
                  <input value={header.tracking} onChange={(e) => setH('tracking', e.target.value)} placeholder="Scan or type" />
                  <button type="button" className="btn sm ghost" title="Scan tracking barcode" onClick={() => setScanTracking(true)}>📷</button>
                </span>
              </label>
              <label>Date received *<input type="date" value={header.dateReceived} onChange={(e) => setH('dateReceived', e.target.value)} /></label>
              <label>Default cost ($)<input type="number" min="0" step="0.01" value={header.defaultCost} onChange={(e) => setH('defaultCost', e.target.value)} /></label>
              <label className="batch-form-wide">Special rules<input value={header.specialRules} onChange={(e) => setH('specialRules', e.target.value)} /></label>
              <label className="batch-form-wide">Notes<input value={header.notes} onChange={(e) => setH('notes', e.target.value)} /></label>
            </div>
          </div>

          {/* Scan items — a scanner gun types straight into this field; the
              camera is an optional toggle for when there's no gun. */}
          <div className="card">
            <form className="searchrow" onSubmit={(e) => { e.preventDefault(); addScan(input); staleRef.current = true; }}>
              <input ref={inputRef} autoCapitalize="characters" autoCorrect="off" placeholder="Scan or type a barcode/SKU, Enter to add"
                value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={onScannerKeyDown} />
              <button className="btn primary">Add</button>
              <button type="button" className={`btn ${showCam ? 'primary' : 'ghost'}`} onClick={() => setShowCam((v) => !v)} title="Scan with camera">📷</button>
            </form>
            {showCam && (
              <Suspense fallback={<p className="muted">Loading camera…</p>}>
                <CameraScanner continuous onDetected={addScan} onClose={() => setShowCam(false)}
                  zoom={prefs.cameraZoom} onZoomChange={setCameraZoom} />
              </Suspense>
            )}
            <div className="scan-flash-live" role="status" aria-live="polite">
              {scanFlash && <div className={`scan-flash ${scanFlash.type}`}>{scanFlash.text}</div>}
            </div>
            <button type="button" className="btn add-size" onClick={addManual}>+ Add item manually</button>
          </div>

          {/* Cart */}
          <div className="card">
            <h3 className="rows-title">Items <span className="muted">({totalItems}{resolving ? ', resolving…' : ''})</span></h3>
            {!cart.length ? <p className="muted">No items yet — scan or add manually.</p> : (
              <div className="cart">
                {cart.map((l) => {
                  // Use the API's size run when it returned more than one; otherwise
                  // fall back to the standard US chart so the dropdown is never empty.
                  const apiSizes = l.sizes || [];
                  const womens = [...apiSizes, ...l.rows.map((r) => r.size)].some((s) => /w/i.test(String(s || '')));
                  const pool = apiSizes.length > 1 ? apiSizes : [...new Set([...apiSizes, ...usSizeChart(womens)])];
                  const available = pool.filter((s) => !l.rows.some((r) => r.size === s));
                  return (
                    <div className={`cart-line ${l.status}`} key={l.key}>
                      <div className="cart-head">
                        {l.image ? <img className="cart-thumb" src={l.image} alt="" /> : <div className="cart-thumb placeholder">{l.status === 'resolving' ? '…' : '—'}</div>}
                        <div className="cart-fields">
                          <input className="cart-name" placeholder="Product name" value={l.name} onChange={(e) => updateLine(l.key, { name: e.target.value })} />
                          <input placeholder="SKU" value={l.sku} onChange={(e) => updateLine(l.key, { sku: e.target.value })} />
                          {l.status === 'error' && <div className="error sm">Lookup failed — type details + add sizes.</div>}
                        </div>
                        <button type="button" className="btn icon ghost remove" title="Remove item" onClick={() => removeLine(l.key)}>×</button>
                      </div>

                      {/* sizes for this product */}
                      <div className="size-rows">
                        {l.rows.map((r) => (
                          <div className="size-line" key={r.key}>
                            <input className={`sz ${!String(r.size).trim() ? 'need' : ''}`} placeholder="Size" value={r.size} onChange={(e) => updateSizeRow(l.key, r.key, { size: e.target.value })} />
                            <input className="qty" type="number" min="1" placeholder="Qty" value={r.quantity} onChange={(e) => updateSizeRow(l.key, r.key, { quantity: e.target.value })} />
                            <input className="cst" type="number" min="0" step="0.01" placeholder="Cost" value={r.cost} onChange={(e) => updateSizeRow(l.key, r.key, { cost: e.target.value })} />
                            <button type="button" className="btn icon ghost remove" title="Remove size" onClick={() => removeSizeRow(l.key, r.key)}>×</button>
                          </div>
                        ))}
                        <div className="size-add">
                          <select value="" onChange={(e) => { if (e.target.value) addSizeRow(l.key, e.target.value); }}>
                            <option value="">{available.length ? 'Add a size…' : 'Add another size…'}</option>
                            {available.map((s) => <option key={s} value={s}>{s}</option>)}
                          </select>
                          <button type="button" className="btn sm ghost" onClick={() => addSizeRow(l.key, '')}>+ custom</button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Issues */}
          <div className="card">
            <h3 className="rows-title">Shipment issues <span className="muted">(optional)</span></h3>
            {issues.map((i) => (
              <div className="issue-row" key={i.key}>
                <select value={i.type} onChange={(e) => updateIssue(i.key, { type: e.target.value })}>
                  {ISSUE_TYPES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                </select>
                {i.type === 'shortfall' && (
                  <span className="issue-counts">
                    <input type="number" min="0" placeholder="Exp" value={i.expectedCount} onChange={(e) => updateIssue(i.key, { expectedCount: e.target.value })} />
                    <input type="number" min="0" placeholder="Got" value={i.receivedCount} onChange={(e) => updateIssue(i.key, { receivedCount: e.target.value })} />
                  </span>
                )}
                <input placeholder="Description" value={i.description} onChange={(e) => updateIssue(i.key, { description: e.target.value })} />
                <button type="button" className="btn icon ghost remove" onClick={() => removeIssue(i.key)}>×</button>
              </div>
            ))}
            <button type="button" className="btn add-size" onClick={addIssue}>+ Add issue</button>
          </div>

          {error && <div className="error mt">{error}</div>}

          <div className="batch-bar">
            <div className="batch-totals"><b>{totalItems}</b> items · <b>${totalCost.toFixed(2)}</b></div>
            <button className="btn primary" onClick={startCommit} disabled={committing || resolving}>
              {resolving ? 'Resolving…' : 'Finish batch'}
            </button>
          </div>
        </>
      )}

      {showConfirm && (
        <div className="modal-overlay">
          <div className="modal confirm" role="dialog" aria-modal="true">
            <h3 className="modal-title">Commit this batch?</h3>
            <div className="confirm-summary">
              <div><b>{totalItems}</b> items ({cart.length} product{cart.length === 1 ? '' : 's'}) · total <b>${totalCost.toFixed(2)}</b></div>
              <div className="muted">Supplier: {header.supplier || '—'} · Buyer: {header.buyer || '—'}</div>
              <div className="muted">Tracking: {header.tracking || '—'} · {header.dateReceived}</div>
              {issues.length > 0 && <div className="muted">{issues.length} issue(s) recorded</div>}
              <p className="muted sm">Each item gets a VIN; items mirror to the sheet (consolidated).</p>
            </div>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setShowConfirm(false)} disabled={committing}>No</button>
              <button className="btn primary" onClick={doCommit} disabled={committing}>{committing ? 'Saving…' : 'Yes, commit'}</button>
            </div>
          </div>
        </div>
      )}

      {result && (
        <Modal type="success" title={`Batch ${result.batchCode} saved`}
          message={`${result.count} item(s) recorded${result.mirror?.error ? ' (sheet mirror failed — data is safe in the database)' : ''}. VINs ${result.vins?.[0]}…${result.vins?.[result.vins.length - 1]}.`}
          onClose={() => setResult(null)}>
          <button className="btn primary" onClick={() => setPrintLabels({ batchCode: result.batchCode, items: result.printItems })}>🖨 Print labels</button>
          <button className="btn ghost" onClick={() => setResult(null)}>Start another</button>
        </Modal>
      )}

      {printLabels && <LabelSheet batchCode={printLabels.batchCode} items={printLabels.items} onClose={() => setPrintLabels(null)} />}

      {scanTracking && (
        <div className="modal-overlay" onClick={() => setScanTracking(false)}>
          <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Scan tracking barcode</h3>
            <Suspense fallback={<p className="muted">Loading camera…</p>}>
              <CameraScanner mode="tracking"
                onDetected={(code) => { setH('tracking', parseTrackingNumber(code)); setScanTracking(false); }}
                onClose={() => setScanTracking(false)}
                zoom={prefs.cameraZoom} onZoomChange={setCameraZoom} />
            </Suspense>
            <div className="modal-actions"><button className="btn ghost" onClick={() => setScanTracking(false)}>Cancel</button></div>
          </div>
        </div>
      )}

      {showPrefs && <PreferencesModal prefs={prefs} onCameraZoom={setCameraZoom} onClose={() => setShowPrefs(false)} />}
    </div>
  );
}

/* Recent batches list (Phase 1: read-only, expand to see items/issues). */
function BatchList({ onSignOut }) {
  const [batches, setBatches] = useState(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(null); // batch id -> details
  const [detail, setDetail] = useState(null);
  const [labels, setLabels] = useState(null); // { batchCode, items }

  useEffect(() => {
    api.batchList()
      .then(({ batches }) => setBatches(batches))
      .catch((err) => { if (err.unauthorized) return onSignOut(); setError(err.message); });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function toggle(id) {
    if (open === id) { setOpen(null); setDetail(null); return; }
    setOpen(id); setDetail(null);
    try { setDetail(await api.batchGet(id)); }
    catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
  }

  if (error) return <div className="error mt">{error}</div>;
  if (!batches) return <p className="muted">Loading…</p>;
  if (!batches.length) return <div className="card"><p className="muted">No batches yet.</p></div>;

  return (
    <>
      <div className="card">
        {batches.map((b) => (
          <div className="batch-item" key={b.id}>
            <button className="batch-head" onClick={() => toggle(b.id)}>
              <span className="batch-code">{b.batch_code}</span>
              <span className="muted">{b.supplier_name || '—'} · {b.item_count} items · ${Number(b.total_cost).toFixed(2)}{b.issue_count ? ` · ${b.issue_count}⚠` : ''}</span>
              <span className="muted sm">{(b.date_received || b.created_at || '').slice(0, 10)}</span>
            </button>
            {open === b.id && (
              <div className="batch-detail">
                {!detail ? <p className="muted">Loading…</p> : (
                  <>
                    <button className="btn sm primary" onClick={() => setLabels({ batchCode: detail.batch.batch_code, items: detail.items })}>🖨 Print labels</button>
                    {detail.items.map((it) => (
                      <div className="batch-detail-row" key={it.id}>
                        <span className="vin">{it.vin}</span> {it.name} · {it.sku || '—'} · sz {it.size || '—'} · ${Number(it.cost || 0).toFixed(2)}
                      </div>
                    ))}
                    {detail.issues.map((is) => (
                      <div className="batch-detail-row issue" key={is.id}>⚠ {is.type}: {is.description || ''}{is.type === 'shortfall' ? ` (${is.received_count}/${is.expected_count})` : ''}</div>
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
      {labels && <LabelSheet batchCode={labels.batchCode} items={labels.items} onClose={() => setLabels(null)} />}
    </>
  );
}

/* ------------------------------ Inventory ------------------------------ */
// One page: search/scan inventory, filter (date/supplier/status) with totals +
// CSV (the daily report), select rows → print VIN labels, and click a row (or
// scan a VIN) to open an item's detail + history + status/notes.
function Inventory({ onHome, onSignOut }) {
  const today = new Date().toISOString().slice(0, 10);
  const [mode, setMode] = useState('list'); // 'list' | 'detail'

  // list / filters
  const [q, setQ] = useState('');
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [supplier, setSupplier] = useState('');
  const [status, setStatus] = useState('');
  const [data, setData] = useState(null); // { rows, totals }
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sel, setSel] = useState(() => new Set());
  const [labels, setLabels] = useState(null);

  // scan (camera optional; a scanner gun just types into the search box)
  const [showCam, setShowCam] = useState(false);
  const [prefs, setPrefs] = useState(loadPrefs);
  const [showPrefs, setShowPrefs] = useState(false);
  const setCameraZoom = (z) => setPrefs((p) => { const n = { ...p, cameraZoom: z }; savePrefs(n); return n; });
  const searchRef = useRef(null);

  // detail
  const [detail, setDetail] = useState(null); // { item, events }
  const [note, setNote] = useState('');
  const [statusNote, setStatusNote] = useState(''); // optional reason saved with a status change
  const [busy, setBusy] = useState(false);

  async function load(over = {}) {
    setLoading(true); setError(''); setSel(new Set());
    const f = { q, from, to, supplier, status, ...over };
    const params = {};
    if (f.q) params.q = f.q;
    if (f.from) params.from = f.from;
    if (f.to) params.to = f.to;
    if (f.supplier) params.supplier = f.supplier;
    if (f.status) params.status = f.status;
    try { setData(await api.itemsQuery(params)); }
    catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Keep the search box focused in list mode so a scanner gun types into it.
  useEffect(() => { if (mode === 'list' && !showCam) searchRef.current?.focus(); }, [mode, showCam, data]);

  // One box for everything: a scanned/typed VIN opens its detail; anything else
  // searches the whole inventory (dates cleared so search isn't limited to today).
  function submit() {
    const v = q.trim();
    if (!v) return;
    if (/^s[a-z]*-?\d/i.test(v)) { openDetail(v); setQ(''); return; } // looks like a VIN (SBM-…/SB-…)
    // Text search: clear the date window (so it isn't limited to today) but keep
    // the query visible in the box so the user can see/refine what they searched.
    setFrom(''); setTo(''); load({ q: v, from: '', to: '' });
  }
  function viewToday() {
    setQ(''); setFrom(today); setTo(today); setSupplier(''); setStatus('');
    load({ q: '', from: today, to: today, supplier: '', status: '' });
  }

  async function openDetail(vin) {
    const v = String(vin).trim();
    if (!v) return;
    setMode('detail'); setDetail(null); setError(''); setShowCam(false);
    try { setDetail(await api.itemLookup(v)); }
    catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
  }
  function backToList() { setMode('list'); setDetail(null); setError(''); load(); }

  const STATUS = ['in_stock', 'sold', 'returned', 'missing', 'issue'];
  async function setItemStatus(s) {
    if (!detail) return;
    const reason = statusNote.trim();
    setBusy(true); setError('');
    try {
      setDetail(await api.itemEvent(detail.item.vin, 'status_change', { status: s, from: detail.item.status, note: reason || undefined }));
      setStatusNote('');
    }
    catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setBusy(false); }
  }
  async function submitNote() {
    const text = note.trim();
    if (!text || !detail) return;
    setBusy(true); setError('');
    try { setDetail(await api.itemEvent(detail.item.vin, 'note', { text })); setNote(''); }
    catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setBusy(false); }
  }
  const eventLabel = (e) => {
    if (e.type === 'received') return 'Received into inventory';
    if (e.type === 'status_change') return `Status → ${e.details?.status}${e.details?.note ? ` — ${e.details.note}` : ''}`;
    if (e.type === 'note') return `Note: ${e.details?.text || ''}`;
    if (e.type === 'issue') return `Issue: ${e.details?.text || e.details?.type || ''}`;
    return e.type;
  };

  /* ----- detail view ----- */
  if (mode === 'detail') {
    const it = detail?.item;
    return (
      <div className="app">
        <TopBar title="Inventory" onHome={onHome} onSignOut={onSignOut}
          right={<button className="btn ghost sm" onClick={backToList}>← Back to list</button>} />
        {error && <div className="error mt">{error}</div>}
        {!detail ? <p className="muted">Loading…</p> : (
          <>
            <div className="card result">
              <div className="result-grid">
                {it.image_url ? <img className="shoe-img" src={it.image_url} alt="" loading="lazy" /> : <div className="shoe-img placeholder">No image</div>}
                <div className="details">
                  <h2>{it.name}</h2>
                  <dl>
                    <div><dt>VIN</dt><dd><span className="vin">{it.vin}</span></dd></div>
                    <div><dt>SKU</dt><dd>{it.sku || '—'}</dd></div>
                    <div><dt>Size</dt><dd>{it.size || '—'}</dd></div>
                    <div><dt>Cost</dt><dd>${Number(it.cost || 0).toFixed(2)}</dd></div>
                    <div><dt>Status</dt><dd><span className={`status-pill ${it.status}`}>{it.status}</span></dd></div>
                    <div><dt>Batch</dt><dd>{it.batch_code || '—'}</dd></div>
                    <div><dt>Supplier</dt><dd>{it.supplier_name || '—'}</dd></div>
                    <div><dt>Received</dt><dd>{(it.date_received || '').slice(0, 10) || '—'}</dd></div>
                  </dl>
                </div>
              </div>

              <h3 className="rows-title">Set status</h3>
              <input className="status-reason" placeholder="Optional reason — saved with the status change (e.g. why it was returned)" value={statusNote} onChange={(e) => setStatusNote(e.target.value)} />
              <div className="status-actions">
                {STATUS.map((s) => (
                  <button key={s} className={`btn sm ${it.status === s ? 'primary' : 'ghost'}`} disabled={busy || it.status === s} onClick={() => setItemStatus(s)}>{s.replace('_', ' ')}</button>
                ))}
              </div>

              <h3 className="rows-title">Add note</h3>
              <form className="searchrow" onSubmit={(e) => { e.preventDefault(); submitNote(); }}>
                <input placeholder="Note about this item…" value={note} onChange={(e) => setNote(e.target.value)} />
                <button className="btn primary" disabled={busy || !note.trim()}>Add</button>
              </form>

              <div className="send"><button className="btn ghost wide" onClick={() => setLabels([{ vin: it.vin, sku: it.sku, size: it.size }])}>🖨 Print this label</button></div>
            </div>

            <div className="card">
              <h3 className="rows-title">History</h3>
              <div className="timeline">
                {detail.events.map((e) => (
                  <div className="tl-item" key={e.id}>
                    <div className="tl-dot" />
                    <div className="tl-body">
                      <div>{eventLabel(e)}</div>
                      <div className="muted sm">{e.created_by || '—'} · {new Date(e.created_at).toLocaleString()}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
        {labels && <LabelSheet items={labels} onClose={() => setLabels(null)} />}
        {showPrefs && <PreferencesModal prefs={prefs} onCameraZoom={setCameraZoom} onClose={() => setShowPrefs(false)} />}
      </div>
    );
  }

  /* ----- list view ----- */
  const rows = data?.rows || [];
  const toggle = (vin) => setSel((s) => { const n = new Set(s); n.has(vin) ? n.delete(vin) : n.add(vin); return n; });
  const toggleAll = () => setSel((s) => (s.size === rows.length ? new Set() : new Set(rows.map((r) => r.vin))));
  const selectedItems = rows.filter((r) => sel.has(r.vin));

  return (
    <div className="app">
      <TopBar title="Inventory" onHome={onHome} onSignOut={onSignOut}
        right={<button className="btn ghost sm" onClick={() => setShowPrefs(true)} title="Preferences">⚙</button>} />

      <div className="card">
        {/* One box: scan a VIN (gun or camera) to open it, or type to search. */}
        <form className="searchrow" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <input ref={searchRef} placeholder="Scan a VIN, or search VIN / SKU / name…" value={q}
            onChange={(e) => setQ(e.target.value)} autoCapitalize="characters" />
          <button className="btn primary" disabled={loading}>Go</button>
          <button type="button" className={`btn ${showCam ? 'primary' : 'ghost'}`} onClick={() => setShowCam((v) => !v)} title="Scan with camera">📷</button>
        </form>
        {showCam && (
          <Suspense fallback={<p className="muted">Loading camera…</p>}>
            <CameraScanner mode="vin" onDetected={(c) => openDetail(c)} onClose={() => setShowCam(false)}
              zoom={prefs.cameraZoom} onZoomChange={setCameraZoom} />
          </Suspense>
        )}

        <div className="report-filters mt">
          <label>From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label>To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          <label>Supplier
            <select value={supplier} onChange={(e) => setSupplier(e.target.value)}>
              <option value="">All</option>
              {SUPPLIERS.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label>Status
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All</option>
              {['in_stock', 'sold', 'returned', 'missing', 'issue'].map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
            </select>
          </label>
          <button className="btn primary" onClick={() => load()} disabled={loading}>{loading ? '…' : 'Apply'}</button>
          <button className="btn ghost" onClick={viewToday}>Today</button>
        </div>
      </div>

      {error && <div className="error mt">{error}</div>}

      {data && (
        <>
          <div className="batch-bar">
            <div className="batch-totals">
              <b>{data.totals.count}</b> items · <b>${data.totals.totalCost.toFixed(2)}</b>
              {Object.entries(data.totals.byStatus).map(([s, n]) => <span key={s} className="muted"> · {s.replace('_', ' ')}: {n}</span>)}
            </div>
            <span className="report-actions">
              <button className="btn sm primary" disabled={!sel.size} onClick={() => setLabels(selectedItems)}>🖨 Print {sel.size || ''} label{sel.size === 1 ? '' : 's'}</button>
              <button className="btn sm ghost" disabled={!rows.length} onClick={() => downloadCSV(`inventory_${from || 'all'}_${to || ''}.csv`, toCSV(rows))}>Export CSV</button>
            </span>
          </div>
          <div className="card">
            {!rows.length ? <p className="muted">No items.</p> : (
              <div className="report-wrap">
                <table className="report-table">
                  <thead>
                    <tr>
                      <th className="report-check"><input type="checkbox" checked={sel.size === rows.length && rows.length > 0} onChange={toggleAll} /></th>
                      {REPORT_COLS.map(([, label]) => <th key={label}>{label}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.vin} className={sel.has(r.vin) ? 'sel' : ''}>
                        <td className="report-check"><input type="checkbox" checked={sel.has(r.vin)} onChange={() => toggle(r.vin)} /></td>
                        <td><button className="vin vin-link" onClick={() => openDetail(r.vin)} title="View history">{r.vin}</button></td>
                        <td>{r.name}</td>
                        <td>{r.sku || '—'}</td>
                        <td>{r.size || '—'}</td>
                        <td>${Number(r.cost || 0).toFixed(2)}</td>
                        <td><span className={`status-pill ${r.status}`}>{r.status}</span></td>
                        <td>{r.supplier_name || '—'}</td>
                        <td>{r.batch_code || '—'}</td>
                        <td>{(r.date_received || '').slice(0, 10) || '—'}</td>
                        <td>{r.created_by || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {labels && <LabelSheet items={labels} onClose={() => setLabels(null)} />}
      {showPrefs && <PreferencesModal prefs={prefs} onCameraZoom={setCameraZoom} onClose={() => setShowPrefs(false)} />}
    </div>
  );
}

/* ----------------------------- VIN labels ------------------------------ */
// Code128 barcode (jsbarcode lazy-loaded so it's not in the main bundle).
function Barcode({ value }) {
  const ref = useRef(null);
  useEffect(() => {
    let cancelled = false;
    import('jsbarcode').then(({ default: JsBarcode }) => {
      if (cancelled || !ref.current) return;
      try {
        JsBarcode(ref.current, value, { format: 'CODE128', displayValue: false, height: 42, width: 1.5, margin: 0 });
      } catch { /* ignore */ }
    });
    return () => { cancelled = true; };
  }, [value]);
  return <svg ref={ref} className="barcode-svg" />;
}

// Printable VIN labels for label-printer rolls (Rollo / Dymo). One label per
// page, sized to the selected stock. Layout per the warehouse mockup:
//   SKU | Size  /  VIN: <vin>  /  [barcode]  /  <vin>
const LABEL_SIZES = {
  rollo: { w: 2.25, h: 1.25, label: 'Rollo 30256/30327 — 2.25 × 1.25"' },
  dymo: { w: 2.125, h: 1.125, label: 'Dymo 30334 — 2.125 × 1.125"' },
};

function LabelSheet({ items, onClose }) {
  const [size, setSize] = useState('rollo');
  const s = LABEL_SIZES[size];
  // Rendered into <body> (a portal) so printing can hide #root entirely — this
  // avoids the app content adding blank/repeated pages behind the labels.
  return createPortal(
    <div className="label-overlay" style={{ '--lw': `${s.w}in`, '--lh': `${s.h}in` }}>
      <style>{`@media print { @page { size: ${s.w}in ${s.h}in; margin: 0; } }`}</style>
      <div className="label-toolbar no-print">
        <span>{items.length} label(s)</span>
        <span className="label-tools">
          <select value={size} onChange={(e) => setSize(e.target.value)}>
            {Object.entries(LABEL_SIZES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          <button className="btn ghost sm" onClick={onClose}>Close</button>
          <button className="btn primary sm" onClick={() => window.print()}>🖨 Print</button>
        </span>
      </div>
      <div className="label-roll">
        {items.map((it) => (
          <div className="rlabel" key={it.vin}>
            <div className="rlabel-top">
              <span className="rlabel-sku">{it.sku || '—'}</span>
              <span className="rlabel-sep">|</span>
              <span className="rlabel-size">{it.size || '—'}</span>
            </div>
            <div className="rlabel-vinlabel">VIN: <b>{it.vin}</b></div>
            <Barcode value={it.vin} />
            <div className="rlabel-vin">{it.vin}</div>
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
}

/* ------------------- Inventory table columns + CSV --------------------- */
const REPORT_COLS = [
  ['vin', 'VIN'], ['name', 'Name'], ['sku', 'SKU'], ['size', 'Size'],
  ['cost', 'Cost'], ['status', 'Status'], ['supplier_name', 'Supplier'],
  ['batch_code', 'Batch'], ['date_received', 'Received'], ['created_by', 'By'],
];

function toCSV(rows) {
  const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const head = REPORT_COLS.map(([, label]) => esc(label)).join(',');
  const body = rows.map((r) => REPORT_COLS.map(([k]) => esc(k === 'date_received' ? (r[k] || '').slice(0, 10) : r[k])).join(',')).join('\n');
  return `${head}\n${body}`;
}
function downloadCSV(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
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
