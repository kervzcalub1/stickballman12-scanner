import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, setToken, setUser, getUser, clearAuth } from './api.js';
import { loadPrefs, savePrefs } from './prefs.js';
import { STATUSES, STATUS_MAP, statusLabel } from './statuses.js';

// Live clock, always rendered in US Eastern with a literal "EST" suffix so the
// PH team (in PH time) is never confused about which timezone a time is in.
const EST_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', weekday: 'short', month: 'short', day: '2-digit',
  year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true,
});
function EstClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);
  return <span className="topbar-clock" title="US Eastern time">{EST_FMT.format(now)} EST</span>;
}

// Item-status pill driven by the central status map (soft colors).
function StatusPill({ status }) {
  const s = STATUS_MAP[status];
  return <span className="status-pill" style={s ? { color: s.fg, background: s.bg } : undefined}>{statusLabel(status)}</span>;
}

// PH-Team sync indicators surfaced in the admin/warehouse views: Intelligent
// Inventory + Alias / StockX / Shopify. `compact` shows only the lit ones (for a
// list row); otherwise all four show, dim when not yet done.
const SYNC_FIELDS = [
  ['added_to_intel_inv', 'II', 'Intelligent Inventory'],
  ['synced_alias', 'AL', 'Alias'],
  ['synced_stockx', 'SX', 'StockX'],
  ['synced_shopify', 'SH', 'Shopify'],
];
function SyncBadges({ item, compact }) {
  const fields = compact ? SYNC_FIELDS.filter(([k]) => item[k]) : SYNC_FIELDS;
  if (!fields.length) return null;
  return (
    <span className="sync-badges">
      {fields.map(([k, ab, label]) => (
        <span key={k} className={`sync-badge ${item[k] ? 'on' : ''}`}
          title={`${label}: ${item[k] ? 'added / synced' : 'not yet'}`}>{ab}</span>
      ))}
    </span>
  );
}

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

// Top-level pages are reflected in the URL path so a refresh restores the page
// (and pages are linkable). Sub-state (open item, wizard step) stays in memory.
const ROUTES = ['receiving', 'rescale', 'inventory', 'report', 'access', 'nobox', 'sold', 'shipped'];
const pathForView = (v) => (v && v !== 'home' ? `/${v}` : '/');
const viewForPath = (p) => {
  const seg = String(p || '/').replace(/^\/+|\/+$/g, '').split('/')[0];
  return ROUTES.includes(seg) ? seg : 'home';
};

// Global unsaved-changes guard. A page calls useUnsavedGuard(true) while it has
// unsaved data (edit mode, scanned-but-unsaved rows, a cart, …). It (1) arms the
// browser's native "Leave site?" prompt on refresh/reload/close, and (2) flips a
// shared flag the app's Back handler checks to confirm before navigating away.
let unsavedDirty = false;
function useUnsavedGuard(isDirty) {
  useEffect(() => {
    unsavedDirty = !!isDirty;
    if (!isDirty) return undefined;
    const onBeforeUnload = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => { window.removeEventListener('beforeunload', onBeforeUnload); unsavedDirty = false; };
  }, [isDirty]);
}

export default function App() {
  const [user, setUserState] = useState(getUser);
  // Initial page comes from the URL (so refreshing /inventory stays on Inventory).
  const [view, setView] = useState(() => viewForPath(window.location.pathname));
  const [openVin, setOpenVin] = useState(null); // VIN to open in Inventory detail (cross-nav)
  const navBack = useRef(null);              // current page sets its internal back handler here
  const appRef = useRef({ view, user });
  appRef.current = { view, user };

  function onAuthed(u) {
    setUserState(u);
    // Honor a deep link the user landed on before signing in (e.g. /inventory).
    const v = viewForPath(window.location.pathname);
    setView(v);
    window.history.replaceState(null, '', pathForView(v));
  }
  function signOut() { clearAuth(); setUserState(null); setView('home'); window.history.replaceState(null, '', '/'); }

  // Keep the URL in sync with the page so refresh restores it and the browser
  // Back/Forward buttons move between pages. A modal or wizard step still
  // consumes Back first (via navBack) so Back closes it instead of leaving.
  useEffect(() => {
    if (!user) return undefined;
    const onPop = () => {
      // Let the page handle Back internally first (close a modal, step back a
      // wizard) — that keeps you on the page, so no "lose changes" prompt.
      const back = navBack.current;
      if (back && back()) {
        window.history.pushState(null, '', pathForView(appRef.current.view));
        return;
      }
      // Back would now leave the page — if there's unsaved data, confirm first.
      if (unsavedDirty && !window.confirm('You have unsaved changes. Leave this page and lose them?')) {
        window.history.pushState(null, '', pathForView(appRef.current.view));
        return;
      }
      setView(viewForPath(window.location.pathname));
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [user]);

  if (!user) return <Auth onAuthed={onAuthed} />;

  // PH Team users get their own home: choose the New Inventory report or the
  // Rescale Stock report (same listing/sync job, split by workflow).
  if (user.role === 'ph_team') return <PHTeamApp user={user} onSignOut={signOut} />;

  const go = (v) => {
    setView(v);
    if (window.location.pathname !== pathForView(v)) window.history.pushState(null, '', pathForView(v));
  };
  const openItem = (vin) => { setOpenVin(vin); go('inventory'); };
  if (view === 'receiving') return <Receiving user={user} navBack={navBack} onOpenItem={openItem} onHome={() => go('home')} onSignOut={signOut} />;
  if (view === 'rescale') return <Receiving mode="rescale" user={user} navBack={navBack} onOpenItem={openItem} onHome={() => go('home')} onSignOut={signOut} />;
  if (view === 'inventory') return <Inventory navBack={navBack} openVin={openVin} onConsumedVin={() => setOpenVin(null)} onHome={() => go('home')} onSignOut={signOut} />;
  if (view === 'report') return <PHGrid user={user} onHome={() => go('home')} onSignOut={signOut} />;
  if (view === 'access') return <CheckAccess user={user} onHome={() => go('home')} onSignOut={signOut} />;
  if (view === 'nobox') return <NoBoxReport user={user} onHome={() => go('home')} onSignOut={signOut} />;
  if (view === 'sold') return <StatusScanPage target="sold" navBack={navBack} onHome={() => go('home')} onSignOut={signOut} />;
  if (view === 'shipped') return <StatusScanPage target="shipped" navBack={navBack} onHome={() => go('home')} onSignOut={signOut} />;
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
  const [role, setRole] = useState('warehouse');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  async function submit(e) {
    e.preventDefault(); setError(''); setBusy(true);
    try {
      await api.signup({ name: name.trim(), username: username.trim(), password, role });
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
      <label className="signup-role">Role
        <select value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="warehouse">Warehouse — receiving &amp; inventory</option>
          <option value="ph_team">PH Team — report only</option>
        </select>
      </label>
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
      <EstClock />
      <div className="topbar-actions">
        {right}
        {onHome && <button className="btn ghost sm" onClick={onHome}>← Home</button>}
        <button className="btn ghost sm" onClick={onSignOut}>Sign out</button>
      </div>
    </header>
  );
}

/* ------------------------------- Home ---------------------------------- */

const ROLE_LABEL = { admin: 'Admin', warehouse: 'Warehouse', ph_team: 'PH Team' };
const roleLabel = (r) => ROLE_LABEL[r] || r;

// Home is grouped into categories. `adminOnly` cards/sections show for admin only.
const HOME_SECTIONS = [
  { title: 'Administration', adminOnly: true, cards: [
    { key: 'access', icon: '🔑', title: 'Check Access', sub: 'Approve, change role, or remove accounts' },
  ] },
  { title: 'Receiving & Stock', cards: [
    { key: 'receiving', icon: '📥', title: 'Receive New', sub: 'Scan a new shipment into a batch' },
    { key: 'rescale', icon: '♻️', title: 'Rescale Stock', sub: 'Re-scan in-hand stock (no shipment)' },
    { key: 'nobox', icon: '🚫', title: 'No Box / Not Ready', sub: 'Resolve units bought without a box' },
  ] },
  { title: 'Sales & Shipment', cards: [
    { key: 'sold', icon: '💰', title: 'Mark Sold', sub: 'Scan VINs to mark sold (delists from all stores)' },
    { key: 'shipped', icon: '📦', title: 'Mark Shipped', sub: 'Scan VINs to mark shipped' },
  ] },
  { title: 'Reports & Lookup', cards: [
    { key: 'inventory', icon: '🔎', title: 'Inventory', sub: 'Search, scan & print labels' },
    { key: 'report', icon: '📊', title: 'Report', sub: 'Monthly listing & store sync' },
  ] },
];

function Home({ user, onPick, onSignOut }) {
  const isAdmin = user.role === 'admin';
  return (
    <div className="app">
      <TopBar onSignOut={onSignOut} />
      <div className="home-greeting">Hi {user.name} <span className="role-badge">{roleLabel(user.role)}</span></div>
      {HOME_SECTIONS.filter((s) => !s.adminOnly || isAdmin).map((section) => (
        <section className="home-section" key={section.title}>
          <h2 className="home-section-title">{section.title}</h2>
          <div className="home-grid">
            {section.cards.map((c) => (
              <button className="home-card" key={c.key} onClick={() => onPick(c.key)}>
                <span className="home-card-icon">{c.icon}</span>
                <span className="home-card-title">{c.title}</span>
                <span className="home-card-sub">{c.key === 'report' && !isAdmin ? `${c.sub} (view-only)` : c.sub}</span>
              </button>
            ))}
          </div>
        </section>
      ))}
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
  async function changeRole(id, role) {
    setBusyId(id);
    try { await api.adminSetRole(id, role); await load(); }
    catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setBusyId(null); }
  }
  async function remove(u) {
    if (!window.confirm(`Delete account "${u.username}"? This cannot be undone.`)) return;
    setBusyId(u.id);
    try { await api.adminDeleteUser(u.id); await load(); }
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
            <div className="hscroll">
            <table className="access-table">
              <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Status</th><th aria-label="actions" /></tr></thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>{u.name}</td>
                    <td>{u.username}</td>
                    <td>
                      <select className="role-select" value={u.role} disabled={busyId === u.id} onChange={(e) => changeRole(u.id, e.target.value)}>
                        <option value="warehouse">Warehouse</option>
                        <option value="ph_team">PH Team</option>
                        <option value="admin">Admin</option>
                      </select>
                    </td>
                    <td><span className={`status-pill ${u.status}`}>{u.status}</span></td>
                    <td className="access-actions">
                      {u.status !== 'approved' && <button className="btn sm primary" disabled={busyId === u.id} onClick={() => review(u.id, 'approve')}>Approve</button>}
                      {u.status !== 'rejected' && <button className="btn sm ghost" disabled={busyId === u.id} onClick={() => review(u.id, 'reject')}>Reject</button>}
                      <button className="btn sm danger" disabled={busyId === u.id} onClick={() => remove(u)}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
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
// Why in-hand stock is being re-scaled (no shipment). Stored on the batch.
const RESCALE_REASONS = [
  ['returned', 'Returned'],
  ['relisting', 'Re-listing'],
  ['recount', 'Recount / found stock'],
  ['transfer', 'Transfer'],
  ['other', 'Other'],
];

// Code-type detection so a scan/typed code is routed correctly BEFORE any API
// call: our minted VIN is `SBM-YYMMDD-<sequence>` (alphanumeric); a UPC/EAN is
// 8–14 digits; anything else is treated as a SKU.
const VIN_RE = /^SBM-\d{6}-\d+$/i;
const isVinCode = (s) => VIN_RE.test(String(s || '').trim());
const isUpcCode = (s) => /^\d{8,14}$/.test(String(s || '').trim());

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

function Receiving({ mode = 'receiving', navBack, onOpenItem, onHome, onSignOut }) {
  const isRescale = mode === 'rescale';
  const today = new Date().toISOString().slice(0, 10);
  const [tab, setTab] = useState('intake');   // 'intake' | 'recent'
  const [step, setStep] = useState(1);         // receiving: 1 shipment·2 items·3 issues | rescale: 1 details·2 items

  const [header, setHeader] = useState({
    buyer: 'stickballman12', supplier: '', tracking: '', dateReceived: today,
    defaultCost: '', notes: '', specialRules: '', origin: 'returned', originOther: '',
  });
  // The reason stored on the batch: the custom text when "Other" is picked.
  const effectiveOrigin = header.origin === 'other'
    ? (String(header.originOther || '').trim() || 'Other')
    : header.origin;
  const setH = (k, v) => setHeader((h) => ({ ...h, [k]: v }));
  const [customSupplier, setCustomSupplier] = useState(false);

  const [prefs, setPrefs] = useState(loadPrefs);
  const [showPrefs, setShowPrefs] = useState(false);
  const setCameraZoom = (zoom) => setPrefs((p) => { const n = { ...p, cameraZoom: zoom }; savePrefs(n); return n; });

  const [items, setItems] = useState([]);     // completed shoes (each: name,sku,…,withBox,sizes[])
  // Rescale only: EXISTING units re-scanned by VIN — each updates its own record
  // (no new VIN). { key, vin, name, sku, size, image, statusSel, custom }.
  const [rescanned, setRescanned] = useState([]);
  const [openSizes, setOpenSizes] = useState(() => new Set()); // expanded size rows (item:size keys)
  const [issues, setIssues] = useState([]);   // manual shipment issues
  const toggleSize = (k) => setOpenSizes((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const [error, setError] = useState('');
  const [committing, setCommitting] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [result, setResult] = useState(null);
  const [printLabels, setPrintLabels] = useState(null);

  // Tracking capture (camera + photo-OCR fallback).
  const [scanTracking, setScanTracking] = useState(false);
  const [ocrBusy, setOcrBusy] = useState(false);
  const fileRef = useRef(null);

  // Add Item modal — scan one shoe model at a time into a `draft`.
  const [showAdd, setShowAdd] = useState(false);
  const [draft, setDraft] = useState(null);
  const draftRef = useRef(null); draftRef.current = draft;
  const rescannedRef = useRef([]); rescannedRef.current = rescanned; // mirror so the camera callback dedupes against fresh state
  useUnsavedGuard(items.length > 0 || !!draft || rescanned.length > 0 || issues.length > 0); // guard the cart against Back/refresh
  const [mInput, setMInput] = useState('');
  const [mBusy, setMBusy] = useState(false);
  const [mError, setMError] = useState('');
  const [mCam, setMCam] = useState(false);
  const [pendingSwitch, setPendingSwitch] = useState(null); // different SKU scanned mid-session
  const [flash, setFlash] = useState(null);
  const mInputRef = useRef(null);
  const recentRef = useRef({}); // code -> last scan time (cooldown vs gun/camera re-reads)

  // Keep the scan field focused so a HID scanner gun types straight into it.
  useEffect(() => {
    if (showAdd && !mCam && !pendingSwitch) { const t = setTimeout(() => mInputRef.current?.focus(), 60); return () => clearTimeout(t); }
  }, [showAdd, mCam, pendingSwitch, draft]);
  useEffect(() => { if (!flash) return; const t = setTimeout(() => setFlash(null), 1800); return () => clearTimeout(t); }, [flash]);

  // Device Back button: close any open modal, else step back, else fall through
  // to the app (→ home). Returns true when it consumed the Back press.
  useEffect(() => {
    if (!navBack) return undefined;
    navBack.current = () => {
      if (pendingSwitch) { setPendingSwitch(null); return true; }
      if (showAdd) { closeAddItem(); return true; }
      if (scanTracking) { setScanTracking(false); return true; }
      if (showPrefs) { setShowPrefs(false); return true; }
      if (showConfirm) { setShowConfirm(false); return true; }
      if (result) { setResult(null); return true; }
      if (printLabels) { setPrintLabels(null); return true; }
      if (tab === 'recent') { setTab('intake'); return true; }
      if (step > 1) { setStep((s) => s - 1); return true; }
      return false;
    };
    return () => { if (navBack) navBack.current = null; };
  }, [navBack, pendingSwitch, showAdd, scanTracking, showPrefs, showConfirm, result, printLabels, tab, step]);

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

  // ---- Add Item modal: scan one shoe model, auto-incrementing sizes ----
  const sameSku = (a, b) => Boolean(a) && Boolean(b)
    && String(a).trim().toUpperCase().replace(/\s+/g, '-') === String(b).trim().toUpperCase().replace(/\s+/g, '-');
  const bumpSize = (rows, size) => {
    const i = rows.findIndex((r) => r.size === size);
    return i === -1 ? [...rows, { key: cartKey++, size, qty: 1 }] : rows.map((r, j) => (j === i ? { ...r, qty: r.qty + 1 } : r));
  };
  // Size options for the modal dropdown: API run when it has >1, else the
  // standard US chart (W/Y suffix detected), minus sizes already added.
  function sizePool(d) {
    const apiSizes = d?.sizeOptions || [];
    const tokens = [...apiSizes, ...(d?.rows || []).map((r) => r.size)].map((s) => String(s || ''));
    const kind = tokens.some((s) => /y$/i.test(s)) ? 'y' : tokens.some((s) => /w$/i.test(s)) ? 'w' : '';
    const pool = apiSizes.length > 1 ? apiSizes : [...new Set([...apiSizes, ...usSizeChart(kind)])];
    return pool.filter((s) => !(d?.rows || []).some((r) => r.size === s));
  }

  function openAddItem() { setDraft(null); setMInput(''); setMError(''); setPendingSwitch(null); setMCam(false); recentRef.current = {}; setShowAdd(true); }
  function closeAddItem() { setShowAdd(false); setDraft(null); setPendingSwitch(null); setMError(''); setMCam(false); }

  // Resolve a scanned/typed code (auto-detect UPC vs SKU) and fold it into the
  // current draft: start the shoe, +1 the matching size, or (different SKU)
  // prompt to finish the current shoe and start a new one.
  async function addCode(code) {
    const c = String(code).trim();
    if (!c) return;
    const now = Date.now();
    if (recentRef.current[c] && now - recentRef.current[c] < 1200) return; // gun/camera re-read
    recentRef.current[c] = now;
    setMInput(''); setMError('');

    // Rescale: a scanned/typed VIN is an EXISTING unit — look it up and add it
    // to the rescanned list (its own record gets updated on finish; no new VIN).
    // UPC/SKU still fall through to the product lookup below (new/unlabeled stock).
    if (isRescale && isVinCode(c)) {
      const vin = c.toUpperCase();
      if (rescannedRef.current.some((r) => r.vin === vin)) { setFlash({ type: 'dup', text: `Already added · ${vin}` }); scanFeedback('dup'); return; }
      setMBusy(true);
      try {
        const { item } = await api.itemLookup(vin);
        setRescanned((arr) => [...arr, { key: cartKey++, vin: item.vin, name: item.name, sku: item.sku, size: item.size, image: item.image_url, statusSel: '', custom: '' }]);
        setFlash({ type: 'added', text: `✓ ${item.vin}${item.size ? ` · sz ${item.size}` : ''}` }); scanFeedback('added');
      } catch (err) {
        if (err.unauthorized) return onSignOut();
        setMError(err.message); scanFeedback('dup');
      } finally { setMBusy(false); }
      return;
    }

    const isUpc = isUpcCode(c);
    setMBusy(true);
    try {
      const { product: p } = isUpc ? await api.searchUpc(c) : await api.searchSku(c);
      const incoming = {
        name: p.name || '', sku: p.sku || '', image: p.image || '', source: p.source || 'manual',
        upc: isUpc ? c : '', scannedSize: p.scannedSize || null, sizeOptions: p.sizes || [],
        gender: p.gender || null,
      };
      const d = draftRef.current;
      if (!d) {
        const rows = incoming.scannedSize ? [{ key: cartKey++, size: incoming.scannedSize, qty: 1 }] : [];
        setDraft({ ...incoming, withBox: true, rows });
        setFlash({ type: 'added', text: `✓ ${incoming.name || c}` }); scanFeedback('added');
      } else if (!sameSku(d.sku, incoming.sku)) {
        setPendingSwitch(incoming); scanFeedback('dup'); // different shoe → confirm switch
      } else if (incoming.scannedSize) {
        setDraft({ ...d, rows: bumpSize(d.rows, incoming.scannedSize) });
        setFlash({ type: 'added', text: `+1 · size ${incoming.scannedSize}` }); scanFeedback('added');
      } else {
        setFlash({ type: 'dup', text: 'Already loaded — add sizes below.' }); scanFeedback('dup');
      }
    } catch (err) {
      if (err.unauthorized) return onSignOut();
      setMError(err.message); scanFeedback('dup');
    } finally { setMBusy(false); }
  }

  // Validate the draft and build a completed item — reserving REAL VINs for each
  // unit up front so they can be stickered before submit (esp. no-box shoes).
  // If reservation fails, the item still commits (server assigns VINs then).
  async function buildItemFromDraft(d) {
    if (!d || !String(d.name).trim()) { setMError('Scan or type a product first.'); return null; }
    const rows = (d.rows || []).filter((r) => String(r.size).trim());
    if (!rows.length) { setMError('Add at least one size.'); return null; }
    const total = rows.reduce((a, r) => a + Math.max(1, Number(r.qty) || 1), 0);
    let vins = [];
    try { const res = await api.reserveVins(total, header.dateReceived); vins = res.vins || []; }
    catch (err) { if (err.unauthorized) { onSignOut(); return null; } /* else proceed without preview VINs */ }
    let idx = 0;
    const sizes = rows.map((r) => {
      const qty = Math.max(1, Number(r.qty) || 1);
      const vs = vins.slice(idx, idx + qty); idx += qty;
      return { key: r.key, size: r.size, qty, vins: vs };
    });
    return { key: cartKey++, name: d.name, sku: d.sku, image: d.image, source: d.source, upc: d.upc, gender: d.gender || null, withBox: d.withBox !== false, sizes };
  }
  async function completeItem() {
    setMBusy(true);
    try {
      const item = await buildItemFromDraft(draftRef.current);
      if (!item) return;
      setItems((arr) => [...arr, item]);
      closeAddItem();
    } finally { setMBusy(false); }
  }
  async function confirmSwitch() {
    setMBusy(true);
    try {
      const item = await buildItemFromDraft(draftRef.current);
      if (!item) return; // current invalid — keep editing it (prompt stays)
      setItems((arr) => [...arr, item]);
      const next = pendingSwitch; setPendingSwitch(null);
      const rows = next.scannedSize ? [{ key: cartKey++, size: next.scannedSize, qty: 1 }] : [];
      setDraft({ ...next, withBox: true, rows });
      setFlash({ type: 'added', text: `✓ ${next.name || ''}` });
    } finally { setMBusy(false); }
  }

  // Draft size-row helpers (manual add / steppers / remove).
  const setDraftRows = (fn) => setDraft((d) => (d ? { ...d, rows: fn(d.rows) } : d));
  const addDraftSize = (size) => { if (size) setDraftRows((rows) => (rows.some((r) => r.size === size) ? rows : [...rows, { key: cartKey++, size, qty: 1 }])); };
  const addCustomSize = () => setDraftRows((rows) => [...rows, { key: cartKey++, size: '', qty: 1 }]);
  const bumpRow = (key, delta) => setDraftRows((rows) => rows.map((r) => (r.key === key ? { ...r, qty: Math.max(1, (Number(r.qty) || 1) + delta) } : r)));
  const setRowQty = (key, v) => setDraftRows((rows) => rows.map((r) => (r.key === key ? { ...r, qty: v } : r)));
  const setRowSize = (key, v) => setDraftRows((rows) => rows.map((r) => (r.key === key ? { ...r, size: v } : r)));
  const removeDraftRow = (key) => setDraftRows((rows) => rows.filter((r) => r.key !== key));

  const removeItem = (key) => setItems((arr) => arr.filter((i) => i.key !== key));

  // ---- Rescale: existing-unit (VIN) helpers ----
  // The new status to apply to a rescanned unit: a preset key, or the typed
  // custom tag when "Custom tag…" is chosen. Empty until the user picks one.
  const effRescaleStatus = (r) => (r.statusSel === '__custom__' ? String(r.custom || '').trim() : r.statusSel);
  const setRescannedStatus = (key, statusSel) => setRescanned((arr) => arr.map((r) => (r.key === key ? { ...r, statusSel } : r)));
  const setRescannedCustom = (key, custom) => setRescanned((arr) => arr.map((r) => (r.key === key ? { ...r, custom } : r)));
  const removeRescanned = (key) => setRescanned((arr) => arr.filter((r) => r.key !== key));

  // Tracking photo → barcode decode (zxing) → OCR digits (Tesseract) fallback.
  async function onTrackingFile(e) {
    const file = e.target.files?.[0]; if (e.target) e.target.value = '';
    if (!file) return;
    setOcrBusy(true); setError('');
    try {
      const { decodeTrackingImage } = await import('./trackingOcr.js');
      const { value } = await decodeTrackingImage(file);
      const parsed = parseTrackingNumber(value);
      if (parsed) setH('tracking', parsed);
      else setError('Could not read a tracking number from that photo — type it in.');
    } catch {
      setError('Could not read the photo — type the tracking number in.');
    } finally { setOcrBusy(false); }
  }

  const addIssue = () => setIssues((is) => [...is, { key: cartKey++, type: 'mismatched', description: '', expectedCount: '', receivedCount: '' }]);
  const updateIssue = (key, patch) => setIssues((is) => is.map((i) => (i.key === key ? { ...i, ...patch } : i)));
  const removeIssue = (key) => setIssues((is) => is.filter((i) => i.key !== key));

  const defaultCostNum = header.defaultCost === '' ? null : Number(header.defaultCost);
  const itemUnits = (i) => i.sizes.reduce((a, r) => a + Math.max(1, Number(r.qty) || 1), 0);
  const totalItems = items.reduce((s, i) => s + itemUnits(i), 0);
  const totalCost = (defaultCostNum || 0) * totalItems;
  const rescaledCount = rescanned.length; // existing units re-scanned by VIN (rescale only)

  // Rescale finish: allow new stock and/or rescanned VINs, and require a status
  // on every rescanned unit (the warehouse picks it — no auto-default).
  function startRescaleFinish() {
    setError('');
    if (!items.length && !rescanned.length) { setError('Scan at least one item or VIN.'); return; }
    if (rescanned.some((r) => !effRescaleStatus(r))) { setError('Pick a status for every rescanned unit.'); return; }
    setShowConfirm(true);
  }
  // Shoes received without a box are auto-listed as shipment issues: "SKU Size — No box".
  const autoIssues = items.filter((i) => !i.withBox)
    .flatMap((i) => i.sizes.map((s) => ({ key: `auto-${i.key}-${s.key}`, description: `${i.sku || '?'} ${s.size} — No box` })));

  function goStep2() {
    setError('');
    if (!isRescale && !String(header.supplier).trim()) { setError('Select a supplier.'); return; }
    if (!isRescale && !String(header.buyer).trim()) { setError('Enter the buyer.'); return; }
    if (!String(header.dateReceived).trim()) { setError('Enter the date.'); return; }
    if (isRescale && header.origin === 'other' && !String(header.originOther).trim()) { setError('Enter a custom reason.'); return; }
    setStep(2);
  }
  function goStep3() {
    setError('');
    if (!items.length) { setError('Add at least one item first.'); return; }
    setStep(3);
  }

  async function doCommit() {
    setCommitting(true);
    try {
      let batchRes = null;
      let out = [];
      // New / unlabeled stock (scanned by UPC/SKU) → batch commit, minting VINs.
      if (items.length) {
        // Expand each shoe's size rows into individual physical items (qty N → N VINs).
        for (const it of items) {
          for (const r of it.sizes) {
            for (let n = 0; n < Math.max(1, Number(r.qty) || 1); n++) {
              out.push({ name: it.name, sku: it.sku, size: r.size, upc: it.upc, image: it.image, source: it.source, gender: it.gender, cost: defaultCostNum, withBox: it.withBox, vin: r.vins?.[n] || null });
            }
          }
        }
        const payload = {
          kind: mode,
          batch: { ...header, origin: effectiveOrigin, defaultCost: defaultCostNum },
          items: out,
          issues: isRescale ? [] : [
            ...autoIssues.map((a) => ({ type: 'no_box', description: a.description })),
            ...issues.map((i) => ({
              type: i.type, description: i.description,
              expectedCount: i.expectedCount === '' ? null : Number(i.expectedCount),
              receivedCount: i.receivedCount === '' ? null : Number(i.receivedCount),
            })),
          ],
        };
        batchRes = await api.batchCommit(payload);
      }

      // Rescale: existing units scanned by VIN → update each item's OWN history
      // (a 'rescaled' event + the picked status). No new VIN is minted.
      let rescaledDone = 0;
      if (isRescale && rescanned.length) {
        const reasonLabel = header.origin === 'other'
          ? effectiveOrigin
          : (RESCALE_REASONS.find(([v]) => v === header.origin)?.[1] || effectiveOrigin);
        for (const r of rescanned) {
          await api.rescaleItem(r.vin, effRescaleStatus(r), undefined, reasonLabel);
          rescaledDone++;
        }
      }

      setShowConfirm(false);
      const printItems = (batchRes?.vins || []).map((vin, i) => ({ vin, name: out[i]?.name, sku: out[i]?.sku, size: out[i]?.size }));
      setResult({
        batchCode: batchRes?.batchCode || null,
        newCount: batchRes?.count || 0,
        rescaledCount: rescaledDone,
        vins: batchRes?.vins || [],
        printItems,
      });
      setItems([]); setIssues([]); setRescanned([]); setStep(1);
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
        title={isRescale ? 'Rescale Stock' : 'Receiving'}
        onHome={onHome}
        onSignOut={onSignOut}
        right={<button className="btn ghost sm" onClick={() => setShowPrefs(true)} title="Preferences">⚙</button>}
      />

      <div className="tabs auth-tabs">
        <button className={`tab ${tab === 'intake' ? 'active' : ''}`} onClick={() => setTab('intake')}>{isRescale ? 'New Rescale' : 'New Batch'}</button>
        <button className={`tab ${tab === 'recent' ? 'active' : ''}`} onClick={() => setTab('recent')}>Recent</button>
      </div>

      {tab === 'recent' ? <BatchList kind={mode} onOpenItem={onOpenItem} onSignOut={onSignOut} /> : (
        <>
          {/* Stepper */}
          <div className="wizard-steps">
            {(isRescale ? [[1, 'Details'], [2, 'Items']] : [[1, 'Shipment'], [2, 'Items'], [3, 'Issues']]).map(([n, label]) => (
              <button key={n} type="button" className={`wstep ${step === n ? 'active' : ''} ${step > n ? 'done' : ''}`}
                onClick={() => { if (n < step) setStep(n); }}>
                <span className="wstep-num">{step > n ? '✓' : n}</span>{label}
              </button>
            ))}
          </div>

          {step === 1 && (
            <>
              <div className="card">
                <h3 className="rows-title">{isRescale ? 'Rescale details' : 'Shipment details'}</h3>
                <div className="batch-form">
                  {!isRescale && <label>Buyer *<input value={header.buyer} onChange={(e) => setH('buyer', e.target.value)} /></label>}
                  {!isRescale && (
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
                  )}
                  {!isRescale && customSupplier && (
                    <label>Custom supplier<input autoFocus value={header.supplier} onChange={(e) => setH('supplier', e.target.value)} placeholder="Type supplier name" /></label>
                  )}
                  {!isRescale && (
                    <label>Tracking #
                      <span className="track-field">
                        <input value={header.tracking} onChange={(e) => setH('tracking', e.target.value)} placeholder="Type, scan, or upload a photo" />
                        <button type="button" className="btn sm ghost" title="Scan tracking barcode" onClick={() => setScanTracking(true)}>📷</button>
                        <button type="button" className="btn sm ghost" title="Upload / snap a label photo" onClick={() => fileRef.current?.click()} disabled={ocrBusy}>{ocrBusy ? '…' : '🖼'}</button>
                      </span>
                    </label>
                  )}
                  {isRescale && (
                    <label>Reason / origin *
                      <select value={header.origin} onChange={(e) => setH('origin', e.target.value)}>
                        {RESCALE_REASONS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                      </select>
                    </label>
                  )}
                  {isRescale && header.origin === 'other' && (
                    <label>Custom reason *
                      <input value={header.originOther} placeholder="Describe the reason"
                        maxLength={80} onChange={(e) => setH('originOther', e.target.value)} />
                    </label>
                  )}
                  <label>{isRescale ? 'Date *' : 'Date received *'}<input type="date" value={header.dateReceived} onChange={(e) => setH('dateReceived', e.target.value)} /></label>
                  <label>Default cost ($)<input type="number" min="0" step="0.01" value={header.defaultCost} onChange={(e) => setH('defaultCost', e.target.value)} /></label>
                  {!isRescale && <label className="batch-form-wide">Special rules<input value={header.specialRules} onChange={(e) => setH('specialRules', e.target.value)} /></label>}
                  <label className="batch-form-wide">Notes<input value={header.notes} onChange={(e) => setH('notes', e.target.value)} /></label>
                </div>
              </div>
              {error && <div className="error mt">{error}</div>}
              <div className="batch-bar">
                <span className="muted sm">Step 1 of {isRescale ? 2 : 3}</span>
                <button className="btn primary" onClick={goStep2}>Next →</button>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <div className="card">
                <div className="step-head">
                  <h3 className="rows-title">{isRescale ? 'New / unlabeled stock' : 'Items'} <span className="muted">({totalItems} unit{totalItems === 1 ? '' : 's'})</span></h3>
                  <button className="btn primary sm" onClick={openAddItem}>+ Add Item</button>
                </div>
                {!items.length ? <p className="muted">{isRescale ? 'No new stock — scan a UPC/SKU here for unlabeled stock, or scan VINs below to rescan existing units.' : 'No items yet — tap “Add Item” and scan a box.'}</p> : (
                  <div className="recv-items">
                    {items.map((it) => (
                      <div className={`recv-item ${it.withBox ? '' : 'nobox'}`} key={it.key}>
                        <div className="recv-item-head">
                          {it.image ? <img className="cart-thumb" src={it.image} alt="" /> : <div className="cart-thumb placeholder">—</div>}
                          <div className="recv-item-info">
                            <div className="recv-item-title">{it.name} <span className="muted">— {it.sku || '—'}</span></div>
                            <div className="recv-item-meta">
                              <span className={`box-badge ${it.withBox ? 'yes' : 'no'}`}>{it.withBox ? '📦 With box' : '🚫 No box'}</span>
                              <span className="muted sm">{isRescale ? 'Rescale' : (header.supplier || '—')} · {defaultCostNum != null ? `$${defaultCostNum.toFixed(2)}` : 'no cost'}</span>
                            </div>
                          </div>
                          <button type="button" className="btn icon ghost remove" title="Remove item" onClick={() => removeItem(it.key)}>×</button>
                        </div>
                        <div className="recv-sizes">
                          <div className="recv-sizes-head"><span>Size</span><span>Qty · tap to see units</span></div>
                          {it.sizes.map((s) => {
                            const k = `${it.key}:${s.key}`;
                            const open = openSizes.has(k);
                            return (
                              <div className="recv-size" key={s.key}>
                                <button type="button" className="recv-size-row" onClick={() => toggleSize(k)} aria-expanded={open} title="Show units / VINs">
                                  <span className="recv-caret">{open ? '▾' : '▸'}</span>
                                  <span className="recv-size-name">{s.size}</span>
                                  <span className="recv-size-qty">×{s.qty}</span>
                                </button>
                                {open && (
                                  <div className="recv-units">
                                    {Array.from({ length: Math.max(1, Number(s.qty) || 1) }, (_, i) => (
                                      <div className="recv-unit" key={i}>
                                        <span className="recv-unit-n">{i + 1}.</span>
                                        {s.vins?.[i]
                                          ? <span className="vin">{s.vins[i]}</span>
                                          : <span className="vin pending">VIN on submit</span>}
                                        {!it.withBox && <span className="recv-unit-nobox">no box — sticker carefully</span>}
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {isRescale && (
                <div className="card">
                  <h3 className="rows-title">Rescanned existing stock <span className="muted">({rescaledCount} VIN{rescaledCount === 1 ? '' : 's'})</span></h3>
                  {!rescanned.length ? <p className="muted">Scan a VIN (gun or 📷 in “Add Item”) to rescan a unit already in inventory. Each keeps its own history — no new VIN.</p> : (
                    <div className="rescan-list">
                      {rescanned.map((r) => (
                        <div className="rescan-row" key={r.key}>
                          {r.image ? <img className="cart-thumb sm" src={r.image} alt="" /> : <div className="cart-thumb sm placeholder">—</div>}
                          <div className="rescan-info">
                            <span className="vin">{r.vin}</span>
                            <span className="muted sm">{r.name || '—'} · {r.sku || '—'}{r.size ? ` · sz ${r.size}` : ''}</span>
                          </div>
                          <div className="rescan-status">
                            <select value={r.statusSel} onChange={(e) => setRescannedStatus(r.key, e.target.value)}>
                              <option value="">Set status…</option>
                              {STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                              <option value="__custom__">Custom tag…</option>
                            </select>
                            {r.statusSel === '__custom__' && (
                              <input className="custom-tag-input" placeholder="Custom tag…" maxLength={40} value={r.custom} onChange={(e) => setRescannedCustom(r.key, e.target.value)} />
                            )}
                          </div>
                          <button type="button" className="btn icon ghost remove" title="Remove" onClick={() => removeRescanned(r.key)}>×</button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {error && <div className="error mt">{error}</div>}
              <div className="batch-bar">
                <button className="btn ghost" onClick={() => setStep(1)}>← Back</button>
                <div className="batch-totals"><b>{totalItems}</b> new{isRescale ? <> · <b>{rescaledCount}</b> rescanned</> : <> units · <b>${totalCost.toFixed(2)}</b></>}</div>
                {isRescale
                  ? <button className="btn primary" onClick={startRescaleFinish} disabled={committing}>Finish rescale</button>
                  : <button className="btn primary" onClick={goStep3}>Next →</button>}
              </div>
            </>
          )}

          {step === 3 && !isRescale && (
            <>
              <div className="card">
                <h3 className="rows-title">Shipment issues <span className="muted">(optional)</span></h3>
                {autoIssues.length > 0 && (
                  <div className="auto-issues">
                    <div className="muted sm">Auto-added — shoes received without a box:</div>
                    {autoIssues.map((a) => <div className="auto-issue" key={a.key}>⚠ {a.description}</div>)}
                  </div>
                )}
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
                <button className="btn ghost" onClick={() => setStep(2)}>← Back</button>
                <div className="batch-totals"><b>{totalItems}</b> units · <b>${totalCost.toFixed(2)}</b></div>
                <button className="btn primary" onClick={() => { setError(''); if (!items.length) { setError('Add at least one item.'); return; } setShowConfirm(true); }} disabled={committing}>
                  Finish batch
                </button>
              </div>
            </>
          )}
        </>
      )}

      {/* hidden file input — tracking label photo (OCR) */}
      <input ref={fileRef} type="file" accept="image/*" capture="environment" hidden onChange={onTrackingFile} />

      {/* Add Item modal */}
      {showAdd && (
        <div className="modal-overlay" onClick={closeAddItem}>
          <div className="modal additem" role="dialog" aria-modal="true" onClick={(e) => { e.stopPropagation(); if (!mCam) mInputRef.current?.focus(); }}>
            <div className="modal-head">
              <h3 className="modal-title">Add item</h3>
              <button type="button" className="btn icon ghost" onClick={closeAddItem}>×</button>
            </div>
            <form className="searchrow" onSubmit={(e) => { e.preventDefault(); addCode(mInput); }}>
              <input ref={mInputRef} autoFocus autoCapitalize="characters" autoCorrect="off"
                placeholder={isRescale ? 'Scan or type VIN / UPC / SKU' : 'Scan or type UPC / SKU'} value={mInput} onChange={(e) => setMInput(e.target.value)} disabled={mBusy} />
              <button className="btn primary" disabled={mBusy}>{mBusy ? '…' : 'Add'}</button>
              <button type="button" className={`btn ${mCam ? 'primary' : 'ghost'}`} onClick={() => setMCam((v) => !v)} title="Scan with camera">📷</button>
            </form>
            {mCam && (
              <Suspense fallback={<p className="muted">Loading camera…</p>}>
                <CameraScanner continuous mode={isRescale ? 'rescale' : 'product'} onDetected={addCode} onClose={() => setMCam(false)}
                  zoom={prefs.cameraZoom} onZoomChange={setCameraZoom} />
              </Suspense>
            )}
            <div className="scan-flash-live" role="status" aria-live="polite">
              {flash && <div className={`scan-flash ${flash.type}`}>{flash.text}</div>}
            </div>
            {mError && <div className="error sm mt">{mError}</div>}

            {isRescale && rescaledCount > 0 && (
              <p className="muted sm mt">✓ {rescaledCount} VIN{rescaledCount === 1 ? '' : 's'} rescanned — set each unit's status on the Items step.</p>
            )}
            {!draft && !mBusy && (
              <p className="muted sm mt">{isRescale
                ? 'Scan a VIN to rescan an existing unit, or a UPC/SKU for new/unlabeled stock. Re-scanning the same shoe’s boxes auto-increments by size.'
                : 'Scan a box (or type a UPC/SKU) to begin. Re-scanning the same shoe’s boxes auto-increments by size.'}</p>
            )}

            {draft && (
              <>
                <div className="additem-product">
                  {draft.image ? <img className="cart-thumb" src={draft.image} alt="" /> : <div className="cart-thumb placeholder">—</div>}
                  <div className="cart-fields">
                    <input className="cart-name" placeholder="Product name" value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
                    <input placeholder="SKU" value={draft.sku} onChange={(e) => setDraft((d) => ({ ...d, sku: e.target.value }))} />
                  </div>
                </div>
                <div className="withbox-field">
                  <span className="withbox-q">Does this shoe have its box?</span>
                  <div className="seg" role="group" aria-label="With box?">
                    <button type="button" className={`seg-btn ${draft.withBox !== false ? 'on yes' : ''}`} aria-pressed={draft.withBox !== false} onClick={() => setDraft((d) => ({ ...d, withBox: true }))}>📦 With Box</button>
                    <button type="button" className={`seg-btn ${draft.withBox === false ? 'on no' : ''}`} aria-pressed={draft.withBox === false} onClick={() => setDraft((d) => ({ ...d, withBox: false }))}>🚫 No Box</button>
                  </div>
                </div>
                <div className="size-rows">
                  <div className="muted sm">Tap a size to add it (tap again for +1), or “+ Custom”.</div>
                  {/* One-tap size boxes — faster and clearer than a dropdown:
                      every option is visible and a single tap adds/increments. */}
                  <div className="size-chips">
                    {sizePool(draft).map((s) => (
                      <button type="button" key={s} className="size-chip" onClick={() => addDraftSize(s)}>{s}</button>
                    ))}
                    <button type="button" className="size-chip custom" onClick={addCustomSize}>+ Custom</button>
                  </div>
                  {draft.rows.map((r) => (
                    <div className="size-line" key={r.key}>
                      <input className={`sz ${!String(r.size).trim() ? 'need' : ''}`} placeholder="Size" value={r.size} onChange={(e) => setRowSize(r.key, e.target.value)} autoFocus={!String(r.size).trim()} />
                      <div className="qty-stepper">
                        <button type="button" className="btn icon ghost step" onClick={() => bumpRow(r.key, -1)}>−</button>
                        <input className="qty" type="number" min="1" value={r.qty} onChange={(e) => setRowQty(r.key, e.target.value)} />
                        <button type="button" className="btn icon ghost step" onClick={() => bumpRow(r.key, 1)}>+</button>
                      </div>
                      <button type="button" className="btn icon ghost remove" title="Remove size" onClick={() => removeDraftRow(r.key)}>×</button>
                    </div>
                  ))}
                </div>
                <div className="modal-actions">
                  <button type="button" className="btn primary wide" onClick={completeItem}>Complete item ✓</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Different-shoe prompt (mid-scan) */}
      {pendingSwitch && (
        <div className="modal-overlay" style={{ zIndex: 130 }}>
          <div className="modal confirm" role="dialog" aria-modal="true">
            <h3 className="modal-title">Different shoe detected</h3>
            <p className="modal-msg">You scanned <b>{pendingSwitch.name || pendingSwitch.sku || 'a new item'}</b>, different from <b>{draft?.name || draft?.sku || 'the current shoe'}</b>. Finish the current shoe and start the new one?</p>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setPendingSwitch(null)}>Keep current</button>
              <button className="btn primary" onClick={confirmSwitch}>End &amp; start new</button>
            </div>
          </div>
        </div>
      )}

      {showConfirm && (
        <div className="modal-overlay">
          <div className="modal confirm" role="dialog" aria-modal="true">
            <h3 className="modal-title">{isRescale ? 'Commit this rescale?' : 'Commit this batch?'}</h3>
            <div className="confirm-summary">
              {isRescale
                ? (<>
                    <div><b>{rescaledCount}</b> existing VIN{rescaledCount === 1 ? '' : 's'} rescanned{totalItems ? <> · <b>{totalItems}</b> new unit{totalItems === 1 ? '' : 's'}</> : ''}</div>
                    <div className="muted">Rescale · {header.origin === 'other' ? effectiveOrigin : (RESCALE_REASONS.find(([v]) => v === header.origin)?.[1] || effectiveOrigin)} · {header.dateReceived}</div>
                    <p className="muted sm">Rescanned units keep their VIN &amp; history (a “Rescaled” event + your chosen status is added). New stock gets a fresh VIN.</p>
                  </>)
                : (<>
                    <div><b>{totalItems}</b> units ({items.length} shoe{items.length === 1 ? '' : 's'}) · total <b>${totalCost.toFixed(2)}</b></div>
                    <div className="muted">Supplier: {header.supplier || '—'} · Buyer: {header.buyer || '—'}</div>
                    <div className="muted">Tracking: {header.tracking || '—'} · {header.dateReceived}</div>
                    {(autoIssues.length + issues.length) > 0 && <div className="muted">{autoIssues.length + issues.length} issue(s) recorded</div>}
                    <p className="muted sm">Each unit gets its own VIN. History starts “Scanned by you”.</p>
                  </>)}
            </div>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setShowConfirm(false)} disabled={committing}>No</button>
              <button className="btn primary" onClick={doCommit} disabled={committing}>{committing ? 'Saving…' : 'Yes, commit'}</button>
            </div>
          </div>
        </div>
      )}

      {result && (
        <Modal type="success"
          title={result.batchCode ? `Batch ${result.batchCode} saved` : 'Rescale saved'}
          message={[
            result.rescaledCount ? `${result.rescaledCount} existing unit(s) rescanned & updated.` : '',
            result.newCount ? `${result.newCount} new item(s) recorded — VINs ${result.vins?.[0]}…${result.vins?.[result.vins.length - 1]}.` : '',
          ].filter(Boolean).join(' ')}
          onClose={() => setResult(null)}>
          {result.printItems?.length > 0 && (
            <button className="btn primary" onClick={() => setPrintLabels({ batchCode: result.batchCode, items: result.printItems })}>🖨 Print labels</button>
          )}
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
function BatchList({ kind, onOpenItem, onSignOut }) {
  const [batches, setBatches] = useState(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(null); // batch id -> details
  const [detail, setDetail] = useState(null);
  const [labels, setLabels] = useState(null); // { batchCode, items }

  useEffect(() => {
    api.batchList(kind)
      .then(({ batches }) => setBatches(batches))
      .catch((err) => { if (err.unauthorized) return onSignOut(); setError(err.message); });
  }, [kind]); // eslint-disable-line react-hooks/exhaustive-deps

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
        <div className="batch-list">
          {batches.map((b) => {
            const isOpen = open === b.id;
            return (
              <div className={`batch-item ${isOpen ? 'open' : ''}`} key={b.id}>
                <button className="batch-head" onClick={() => toggle(b.id)}>
                  <span className="batch-caret">{isOpen ? '▾' : '▸'}</span>
                  <div className="batch-head-main">
                    <div className="batch-head-top">
                      <span className="batch-code">{b.batch_code}</span>
                      <span className="batch-date muted sm">{(b.date_received || b.created_at || '').slice(0, 10)}</span>
                    </div>
                    <div className="batch-head-sub">
                      <span>{b.supplier_name || '—'}</span>
                      <span className="batch-pill">{b.item_count} item{b.item_count === 1 ? '' : 's'}</span>
                      <span className="batch-pill">${Number(b.total_cost).toFixed(2)}</span>
                      {b.issue_count > 0 && <span className="batch-pill warn">{b.issue_count} ⚠</span>}
                    </div>
                  </div>
                </button>
                {isOpen && (
                  <div className="batch-detail">
                    {!detail ? <p className="muted">Loading…</p> : (
                      <>
                        <div className="batch-detail-actions">
                          <button className="btn sm primary" onClick={() => setLabels({ batchCode: detail.batch.batch_code, items: detail.items })}>🖨 Print labels</button>
                        </div>
                        {detail.items.map((it) => (
                          <div className="batch-detail-row" key={it.id}>
                            <button className="vin vin-link" onClick={() => onOpenItem?.(it.vin)} title="View full shoe detail">{it.vin}</button>
                            <span className="batch-row-name">{it.name}</span>
                            <span className="muted sm">{it.sku || '—'} · sz {it.size || '—'} · ${Number(it.cost || 0).toFixed(2)}</span>
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
            );
          })}
        </div>
      </div>
      {labels && <LabelSheet batchCode={labels.batchCode} items={labels.items} onClose={() => setLabels(null)} />}
    </>
  );
}

/* ------------------------------ Inventory ------------------------------ */
// One page: search/scan inventory, filter (date/supplier/status) with totals +
// CSV (the daily report), select rows → print VIN labels, and click a row (or
// scan a VIN) to open an item's detail + history + status/notes.
function Inventory({ navBack, openVin, onConsumedVin, onHome, onSignOut }) {
  const today = new Date().toISOString().slice(0, 10);
  const [mode, setMode] = useState('list'); // 'list' | 'detail'

  // list / filters
  const [q, setQ] = useState('');
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [supplier, setSupplier] = useState('');
  const [status, setStatus] = useState('');
  const [intake, setIntake] = useState(''); // '' | 'receiving' | 'rescale'
  const [data, setData] = useState(null); // { rows, totals }
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sel, setSel] = useState(() => new Set());
  const [labels, setLabels] = useState(null);
  const [expanded, setExpanded] = useState(() => new Set()); // vins with the accordion open
  const [hist, setHist] = useState({}); // vin -> { loading, events, error } (lazily loaded)
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkStatusSel, setBulkStatusSel] = useState('needs_shelf');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [statusDrafts, setStatusDrafts] = useState({}); // vin -> picked status (applied on Save)
  const [savingStatusVin, setSavingStatusVin] = useState(null);

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
  const [detailStatusDraft, setDetailStatusDraft] = useState(null); // staged status/tag — applied only on Save
  const [customTag, setCustomTag] = useState(''); // free-text custom tag being typed
  const [busy, setBusy] = useState(false);
  useUnsavedGuard(Object.keys(statusDrafts).length > 0 || !!detailStatusDraft); // guard staged status edits

  async function load(over = {}) {
    setLoading(true); setError(''); setSel(new Set()); setExpanded(new Set()); setHist({});
    const f = { q, from, to, supplier, status, intake, ...over };
    const params = {};
    if (f.q) params.q = f.q;
    if (f.from) params.from = f.from;
    if (f.to) params.to = f.to;
    if (f.supplier) params.supplier = f.supplier;
    if (f.status) params.status = f.status;
    if (f.intake) params.kind = f.intake;
    try { setData(await api.itemsQuery(params)); }
    catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Keep the search box focused in list mode so a scanner gun types into it.
  useEffect(() => { if (mode === 'list' && !showCam) searchRef.current?.focus(); }, [mode, showCam, data]);

  // Opened from another page (e.g. Recent batches → a VIN): jump to its detail.
  useEffect(() => {
    if (openVin) { openDetail(openVin); onConsumedVin?.(); }
  }, [openVin]); // eslint-disable-line react-hooks/exhaustive-deps

  // Device Back button: close a modal/camera, else leave the detail view, else
  // fall through to the app (→ home).
  useEffect(() => {
    if (!navBack) return undefined;
    navBack.current = () => {
      if (bulkOpen) { setBulkOpen(false); return true; }
      if (showPrefs) { setShowPrefs(false); return true; }
      if (labels) { setLabels(null); return true; }
      if (showCam) { setShowCam(false); return true; }
      if (mode === 'detail') { backToList(); return true; }
      return false;
    };
    return () => { if (navBack) navBack.current = null; };
  }, [navBack, bulkOpen, showPrefs, labels, showCam, mode]);

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
    setQ(''); setFrom(today); setTo(today); setSupplier(''); setStatus(''); setIntake('');
    load({ q: '', from: today, to: today, supplier: '', status: '', intake: '' });
  }

  async function openDetail(vin) {
    const v = String(vin).trim();
    if (!v) return;
    setMode('detail'); setDetail(null); setError(''); setShowCam(false);
    setDetailStatusDraft(null); setCustomTag(''); setStatusNote(''); // reset staged status for the new item
    try { setDetail(await api.itemLookup(v)); }
    catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
  }
  function backToList() { setMode('list'); setDetail(null); setError(''); load(); }

  // Report: status edits are staged in statusDrafts and only persisted on Save.
  const setStatusDraft = (vin, status) => setStatusDrafts((d) => ({ ...d, [vin]: status }));
  async function saveRowStatus(vin, current) {
    const status = statusDrafts[vin];
    if (!status || status === current) return;
    setSavingStatusVin(vin); setError('');
    try {
      const res = await api.itemEvent(vin, 'status_change', { status });
      // Merge the server's updated item so cascades (e.g. sold → sync flags
      // cleared) reflect in the row immediately, not just the status text.
      const u = res?.item || {};
      setData((d) => (d ? { ...d, rows: d.rows.map((r) => (r.vin === vin ? {
        ...r, status,
        added_to_intel_inv: u.added_to_intel_inv ?? r.added_to_intel_inv,
        synced_alias: u.synced_alias ?? r.synced_alias,
        synced_stockx: u.synced_stockx ?? r.synced_stockx,
        synced_shopify: u.synced_shopify ?? r.synced_shopify,
      } : r)) } : d));
      setStatusDrafts((d) => { const n = { ...d }; delete n[vin]; return n; }); // clear → Save disabled again
      setHist((h) => { const n = { ...h }; delete n[vin]; return n; }); // reload history on next expand
    } catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setSavingStatusVin(null); }
  }
  // Report: bulk status change over the selected VINs.
  async function applyBulkStatus() {
    setBulkBusy(true); setError('');
    try { await api.bulkStatus([...sel], bulkStatusSel); setBulkOpen(false); load(); }
    catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setBulkBusy(false); }
  }

  // Accordion: toggle a row open/closed; the first time it opens, lazily fetch
  // that item's audit notes & history (keeps the list query light).
  function toggleRow(vin) {
    setExpanded((s) => { const n = new Set(s); n.has(vin) ? n.delete(vin) : n.add(vin); return n; });
    if (hist[vin]) return;
    setHist((h) => ({ ...h, [vin]: { loading: true } }));
    api.itemLookup(vin)
      .then((d) => setHist((h) => ({ ...h, [vin]: { loading: false, events: d.events || [] } })))
      .catch((err) => {
        if (err.unauthorized) return onSignOut();
        setHist((h) => ({ ...h, [vin]: { loading: false, error: err.message } }));
      });
  }

  const STATUS = STATUSES.map((s) => s.key);
  // The currently-staged status/tag for the open item (defaults to its real
  // status until the user picks a preset or types a custom tag).
  const draftStatus = detailStatusDraft ?? detail?.item?.status ?? null;
  const stageStatus = (s) => { setDetailStatusDraft(s); setCustomTag(''); };
  const stageCustomTag = () => { const v = customTag.trim(); if (v) setDetailStatusDraft(v); };
  const clearStatusDraft = () => { setDetailStatusDraft(null); setCustomTag(''); };
  // Persist the staged status/tag — only runs when the user hits Save.
  async function saveItemStatus() {
    if (!detail) return;
    const s = draftStatus;
    if (!s || s === detail.item.status) return;
    const reason = statusNote.trim();
    setBusy(true); setError('');
    try {
      setDetail(await api.itemEvent(detail.item.vin, 'status_change', { status: s, from: detail.item.status, note: reason || undefined }));
      setStatusNote(''); setDetailStatusDraft(null); setCustomTag('');
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
  // Each history line names WHO did it. System-driven changes (e.g. the sold →
  // delist cascade) are tagged "(system-generated)" since no person did them.
  const eventLabel = (e) => {
    const by = e.created_by || '—';
    if (e.type === 'scanned') return `Scanned by ${e.details?.by || by}`;
    if (e.type === 'received') return `Received into inventory (by ${by})`;
    if (e.type === 'rescaled') return `Rescaled${e.details?.reason ? ` (${e.details.reason})` : ''}${e.details?.note ? ` — ${e.details.note}` : ''} (by ${by})`;
    if (e.type === 'status_change') return `Status → ${statusLabel(e.details?.status)}${e.details?.note ? ` — ${e.details.note}` : ''} (marked by: ${by})`;
    if (e.type === 'ph_update') return `${e.details?.text || 'Updated'} ${e.details?.soldCascade ? '(system-generated)' : `(by ${by})`}`;
    if (e.type === 'note') return `Note: ${e.details?.text || ''} (by ${by})`;
    if (e.type === 'issue') return `Issue: ${e.details?.text || e.details?.type || ''} (by ${by})`;
    return `${e.type} (by ${by})`;
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
                    <div><dt>Status</dt><dd><StatusPill status={it.status} /></dd></div>
                    <div><dt>Batch</dt><dd>{it.batch_code || '—'}</dd></div>
                    <div><dt>Intake</dt><dd>{it.kind === 'rescale' ? `Rescaled${it.origin ? ` (${it.origin})` : ''}` : 'Received'}</dd></div>
                    <div><dt>Supplier</dt><dd>{it.supplier_name || '—'}</dd></div>
                    <div><dt>Received</dt><dd>{(it.date_received || '').slice(0, 10) || '—'}</dd></div>
                    <div><dt>Price</dt><dd>{it.price != null ? `$${Number(it.price).toFixed(2)}` : '—'}</dd></div>
                    <div><dt>Listed</dt><dd><SyncBadges item={it} /></dd></div>
                  </dl>
                </div>
              </div>

              <h3 className="rows-title">Set status / tag</h3>
              {/* Pick a preset or type a custom tag. Nothing is saved until "Save". */}
              <div className="status-actions">
                {STATUS.map((s) => (
                  <button key={s} className={`btn sm ${draftStatus === s ? 'primary' : 'ghost'}`} disabled={busy} onClick={() => stageStatus(s)}>{statusLabel(s)}</button>
                ))}
              </div>
              <div className="custom-tag-row">
                <input className="custom-tag-input" placeholder="Custom tag…" value={customTag} maxLength={40} disabled={busy}
                  onChange={(e) => setCustomTag(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); stageCustomTag(); } }} />
                <button type="button" className="btn sm ghost" disabled={busy || !customTag.trim()} onClick={stageCustomTag}>Use tag</button>
              </div>
              <input className="status-reason" placeholder="Optional reason — saved with the status change (e.g. why it was returned)" value={statusNote} onChange={(e) => setStatusNote(e.target.value)} />
              {draftStatus && draftStatus !== it.status && (
                <div className="status-save-row">
                  <span className="muted sm">Pending change → <StatusPill status={draftStatus} /></span>
                  <button className="btn primary sm" disabled={busy} onClick={saveItemStatus}>{busy ? 'Saving…' : 'Save'}</button>
                  <button className="btn ghost sm" disabled={busy} onClick={clearStatusDraft}>Cancel</button>
                </div>
              )}

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
                      <div className="muted sm">{new Date(e.created_at).toLocaleString()}</div>
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
              {STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </label>
          <label>Intake
            <select value={intake} onChange={(e) => setIntake(e.target.value)}>
              <option value="">All</option>
              <option value="receiving">Received</option>
              <option value="rescale">Rescaled</option>
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
              {Object.entries(data.totals.byStatus).map(([s, n]) => <span key={s} className="muted"> · {statusLabel(s)}: {n}</span>)}
            </div>
            <span className="report-actions">
              <button className="btn sm ghost" disabled={!sel.size} onClick={() => setBulkOpen(true)}>Edit status{sel.size ? ` (${sel.size})` : ''}</button>
              <button className="btn sm primary" disabled={!sel.size} onClick={() => setLabels(selectedItems)}>🖨 Print {sel.size || ''} label{sel.size === 1 ? '' : 's'}</button>
              <button className="btn sm ghost" disabled={!rows.length} onClick={() => downloadCSV(`inventory_${from || 'all'}_${to || ''}.csv`, toCSV(rows))}>Export CSV</button>
            </span>
          </div>
          <div className="card">
            {!rows.length ? <p className="muted">No items.</p> : (
              <div className="inv-tablewrap">
                <table className="inv-table">
                  <thead>
                    <tr>
                      <th className="inv-col-check">
                        <input type="checkbox" checked={sel.size === rows.length && rows.length > 0} onChange={toggleAll} aria-label="Select all" />
                      </th>
                      <th className="inv-col-vin">VIN</th>
                      <th>Shoe</th>
                      <th className="inv-col-size">Size</th>
                      <th className="inv-col-sku">SKU</th>
                      <th className="inv-col-status">Status &amp; sync</th>
                    </tr>
                  </thead>
                  <tbody>
                  {rows.map((r) => {
                    const open = expanded.has(r.vin);
                    const h = hist[r.vin];
                    return (
                      <React.Fragment key={r.vin}>
                        <tr className={`inv-trow ${open ? 'open' : ''}`} onClick={() => toggleRow(r.vin)}>
                          <td className="inv-col-check" onClick={(e) => e.stopPropagation()}>
                            <input type="checkbox" checked={sel.has(r.vin)} onChange={() => toggle(r.vin)} aria-label={`Select ${r.vin}`} />
                          </td>
                          <td className="inv-col-vin"><span className="inv-caret">{open ? '▾' : '▸'}</span><span className="vin">{r.vin}</span></td>
                          <td className="inv-name" title={r.name}>{r.name}</td>
                          <td className="inv-col-size">{r.size ? `US ${r.size}` : '—'}</td>
                          <td className="inv-col-sku">{r.sku || '—'}</td>
                          <td className="inv-col-status"><span className="inv-status"><StatusPill status={r.status} /><SyncBadges item={r} /></span></td>
                        </tr>
                        {open && (
                          <tr className="inv-drow">
                            <td colSpan={6}>
                          <div className="inv-detail">
                            <dl className="inv-metrics">
                              <div><dt>Date received</dt><dd>{(r.date_received || '').slice(0, 10) || '—'}</dd></div>
                              <div><dt>Cost</dt><dd>${Number(r.cost || 0).toFixed(2)}</dd></div>
                              <div><dt>Batch ID</dt><dd>{r.batch_code || '—'}</dd></div>
                              <div><dt>Supplier / Buyer</dt><dd>{r.supplier_name || '—'}{r.buyer_name ? ` / ${r.buyer_name}` : ''}</dd></div>
                              <div><dt>Received by</dt><dd>{r.created_by || '—'}</dd></div>
                              <div><dt>Size</dt><dd>{r.size || '—'}</dd></div>
                              <div><dt>Price</dt><dd>{r.price != null ? `$${Number(r.price).toFixed(2)}` : '—'}</dd></div>
                              <div className="inv-metrics-wide"><dt>Listed / synced</dt><dd><SyncBadges item={r} /></dd></div>
                            </dl>
                            <div className="inv-history">
                              <div className="inv-history-title">Audit notes &amp; history</div>
                              {!h || h.loading ? <p className="muted sm">Loading…</p>
                                : h.error ? <p className="error sm">{h.error}</p>
                                : !h.events?.length ? <p className="muted sm">No history yet.</p>
                                : (
                                  <div className="timeline">
                                    {h.events.map((e) => (
                                      <div className="tl-item" key={e.id}>
                                        <div className="tl-dot" />
                                        <div className="tl-body">
                                          <div>{eventLabel(e)}</div>
                                          <div className="muted sm">{new Date(e.created_at).toLocaleString()}</div>
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                )}
                            </div>
                            <div className="inv-actions">
                              <label className="inv-status-edit">Status
                                <select value={statusDrafts[r.vin] ?? r.status} onChange={(e) => setStatusDraft(r.vin, e.target.value)}>
                                  {STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                                </select>
                              </label>
                              <button className="btn sm primary" disabled={(statusDrafts[r.vin] ?? r.status) === r.status || savingStatusVin === r.vin} onClick={() => saveRowStatus(r.vin, r.status)}>
                                {savingStatusVin === r.vin ? 'Saving…' : 'Save'}
                              </button>
                              <button className="btn sm ghost" onClick={() => setLabels([{ vin: r.vin, sku: r.sku, size: r.size }])}>🖨 Print label</button>
                              <button className="btn sm ghost" onClick={() => openDetail(r.vin)}>Details →</button>
                            </div>
                          </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {bulkOpen && (
        <div className="modal-overlay" onClick={() => !bulkBusy && setBulkOpen(false)}>
          <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Change status — {sel.size} item{sel.size === 1 ? '' : 's'}</h3>
            <div className="status-pick">
              {STATUSES.map((s) => (
                <label key={s.key} className={`status-pick-row ${bulkStatusSel === s.key ? 'sel' : ''}`}>
                  <input type="radio" name="bulkstatus" checked={bulkStatusSel === s.key} onChange={() => setBulkStatusSel(s.key)} />
                  <StatusPill status={s.key} />
                </label>
              ))}
            </div>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setBulkOpen(false)} disabled={bulkBusy}>Cancel</button>
              <button className="btn primary" onClick={applyBulkStatus} disabled={bulkBusy}>{bulkBusy ? 'Applying…' : 'Apply'}</button>
            </div>
          </div>
        </div>
      )}

      {labels && <LabelSheet items={labels} onClose={() => setLabels(null)} />}
      {showPrefs && <PreferencesModal prefs={prefs} onCameraZoom={setCameraZoom} onClose={() => setShowPrefs(false)} />}
    </div>
  );
}

/* ------------------------------ PH Team -------------------------------- */
// Monthly listing of every scanned shoe (by EST scan date) with editable
// pricing + cross-store sync flags. Frozen left columns (through Qty) so the
// many editable columns scroll horizontally inside a fixed-height box. Every
// edit is audited to the item's history.
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const PH_DATE = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: '2-digit', day: '2-digit', year: '2-digit' });
const PH_DATETIME = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: '2-digit', day: '2-digit', hour: 'numeric', minute: '2-digit', hour12: true });
// Frozen columns and their fixed widths (px): Date, Title, SKU, Size, Qty.
// (Rows are CONSOLIDATED — identical units collapse into one row with a Qty —
// so there's no per-VIN column; Qty replaces it.)
const PH_FROZEN_W = [86, 200, 110, 64, 50];
const PH_LEFTS = PH_FROZEN_W.reduce((a, _w, i) => { a.push(i ? a[i - 1] + PH_FROZEN_W[i - 1] : 0); return a; }, []);
const frozenStyle = (i) => ({ position: 'sticky', left: PH_LEFTS[i], minWidth: PH_FROZEN_W[i], width: PH_FROZEN_W[i] });
// Right-frozen columns: Action then Added by (Added by is rightmost).
const PH_ACTION_W = 104;
const PH_ADDEDBY_W = 150;
const rightStyle = (which) => (which === 'addedby'
  ? { position: 'sticky', right: 0, minWidth: PH_ADDEDBY_W, width: PH_ADDEDBY_W }
  : { position: 'sticky', right: PH_ADDEDBY_W, minWidth: PH_ACTION_W, width: PH_ACTION_W });

// Small reactive media-query hook (used to switch the Report to cards on phones).
function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => (typeof window !== 'undefined' ? window.matchMedia(query).matches : false));
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

const PH_FLAGS = [
  ['added_to_intel_inv', 'Intelligent Inv.'], ['synced_alias', 'Alias'],
  ['synced_stockx', 'StockX'], ['synced_shopify', 'Shopify'],
];

// Consolidate identical units into one row so the PH team lists by SKU+size+qty
// instead of counting individual VINs. Units group only when ALL listing-
// relevant details match (name, sku, size, gender, status, cost, price, every
// sync flag, note) — so applying one edit to the whole group is always correct.
// The group carries every member VIN (`vins`) for the bulk save + a `qty`.
function groupPhRows(list) {
  const map = new Map();
  for (const r of list) {
    const key = ['name', 'sku', 'size', 'gender', 'status', 'cost', 'price',
      'added_to_intel_inv', 'synced_alias', 'synced_stockx', 'synced_shopify', 'ph_note']
      .map((k) => (r[k] == null ? '' : String(r[k]))).join('|#|');
    let g = map.get(key);
    if (!g) {
      g = { ...r, key, vins: [], qty: 0, _mixedBy: false };
      map.set(key, g);
    }
    g.vins.push(r.vin);
    g.qty += 1;
    if (r.created_by !== g.created_by) g._mixedBy = true;
    if (r.created_at < g.created_at) g.created_at = r.created_at; // earliest scan
    // Most recent editor stamp across the group.
    if (r.last_edit_at && (!g.last_edit_at || r.last_edit_at > g.last_edit_at)) {
      g.last_edit_at = r.last_edit_at; g.last_edit_by = r.last_edit_by;
    }
  }
  return [...map.values()];
}

function YesNo({ value, editing, onChange }) {
  if (!editing) return <span className={`ph-yn ${value ? 'yes' : 'no'}`}>{value ? 'Yes' : 'No'}</span>;
  return (
    <select className={`ph-yn-sel ${value ? 'yes' : 'no'}`} value={value ? 'yes' : 'no'} onChange={(e) => onChange(e.target.value === 'yes')}>
      <option value="no">No</option>
      <option value="yes">Yes</option>
    </select>
  );
}

// PH Team home: pick which monthly report to work — New Inventory (newly
// received stock) or Rescale Stock (units re-scanned for re-listing). Both do
// the same job: price + sync to Intelligent Inventory / Alias / StockX / Shopify.
function PHTeamApp({ user, onSignOut }) {
  const [page, setPage] = useState(null); // null = home chooser | 'receiving' | 'rescale' | 'nobox'
  if (page === 'nobox') return <NoBoxReport user={user} onHome={() => setPage(null)} onSignOut={onSignOut} />;
  if (page) return <PHGrid user={user} kind={page} onHome={() => setPage(null)} onSignOut={onSignOut} />;
  return (
    <div className="app">
      <TopBar onSignOut={onSignOut} />
      <div className="home-greeting">Hi {user.name} <span className="role-badge">{roleLabel(user.role)}</span></div>
      <div className="home-grid">
        <button className="home-card" onClick={() => setPage('receiving')}>
          <span className="home-card-icon">📥</span>
          <span className="home-card-title">New Inventory</span>
          <span className="home-card-sub">Price &amp; list newly received stock — Intelligent Inventory, Alias, StockX, Shopify</span>
        </button>
        <button className="home-card" onClick={() => setPage('rescale')}>
          <span className="home-card-icon">♻️</span>
          <span className="home-card-title">Rescale Stock</span>
          <span className="home-card-sub">Re-list rescanned units (returns, relistings, recounts, transfers) across the stores</span>
        </button>
        <button className="home-card" onClick={() => setPage('nobox')}>
          <span className="home-card-icon">🚫</span>
          <span className="home-card-title">No Box / Not Ready</span>
          <span className="home-card-sub">Units bought without a box — not yet postable (view-only; warehouse resolves)</span>
        </button>
      </div>
    </div>
  );
}

// PH edit-lock (B2) timings — heartbeat keeps a lock alive (silent), TTL frees a
// crashed/closed editor server-side, idle auto-releases a forgotten-open edit.
const HEARTBEAT_MS = 10_000;       // keep MY lock alive (well under the 30s server TTL)
const PRESENCE_POLL_MS = 2_000;    // how fast OTHERS see a lock appear/clear — kept snappy
const IDLE_RELEASE_MS = 60 * 60 * 1000; // 1 hour — PH needs time to process the upload

// `kind`: 'receiving' (New Inventory) · 'rescale' (Rescale Stock) · null (all — admin Report).
function PHGrid({ user, kind = null, onHome, onSignOut }) {
  const canEdit = user?.role === 'ph_team'; // admin + warehouse are read-only
  const title = kind === 'rescale' ? 'Rescale Stock' : kind === 'receiving' ? 'New Inventory' : 'Report';
  const emptyKind = kind === 'rescale' ? 'rescaled' : kind === 'receiving' ? 'received' : 'scanned';
  const isMobile = useMediaQuery('(max-width: 768px)'); // phones get cards, not the wide grid
  const estNow = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'numeric', year: 'numeric' }).formatToParts(new Date());
  const curMonth = Number(estNow.find((p) => p.type === 'month').value);
  const curYear = Number(estNow.find((p) => p.type === 'year').value);

  const [month, setMonth] = useState(curMonth);
  const [year, setYear] = useState(String(curYear));
  const [rows, setRows] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(() => new Set()); // group keys in edit mode
  const [drafts, setDrafts] = useState({});                // group key -> edited fields
  const [savingKey, setSavingKey] = useState(null);
  const [sortDir, setSortDir] = useState('asc'); // by scan date: asc = oldest first
  useUnsavedGuard(editing.size > 0); // unsaved edits → guard Back/refresh

  // ---- B2 edit locks / presence ----
  const [locks, setLocks] = useState({});    // vin -> { holder, holder_id } (active locks)
  const [notice, setNotice] = useState('');  // transient (idle release / lost lock)
  const holderIdRef = useRef(null);
  if (!holderIdRef.current) holderIdRef.current = `${user?.username || 'ph'}-${Math.random().toString(36).slice(2, 10)}`;
  const editVinsRef = useRef({});            // group key -> [vins] I currently hold
  const heartbeatRef = useRef(null);
  const idleRef = useRef(null);
  const heldVins = () => [...new Set(Object.values(editVinsRef.current).flat())];

  function stopTimers() {
    if (heartbeatRef.current) { clearInterval(heartbeatRef.current); heartbeatRef.current = null; }
    if (idleRef.current) { clearTimeout(idleRef.current); idleRef.current = null; }
  }
  function onIdle() {
    releaseAll();
    setEditing(new Set()); setDrafts({});
    setNotice('Your edit was released after 1 hour of inactivity. Click Edit again to continue.');
  }
  function resetIdle() {
    if (idleRef.current) clearTimeout(idleRef.current);
    idleRef.current = setTimeout(onIdle, IDLE_RELEASE_MS);
  }
  function releaseAll() {
    const v = heldVins();
    editVinsRef.current = {};
    if (v.length) api.lockRelease(v, holderIdRef.current).catch(() => {});
    stopTimers();
  }
  function closeEdit(key, { release = true } = {}) {
    const vins = editVinsRef.current[key];
    delete editVinsRef.current[key];
    if (release && vins?.length) api.lockRelease(vins, holderIdRef.current).catch(() => {});
    setEditing((s) => { const n = new Set(s); n.delete(key); return n; });
    setDrafts((d) => { const n = { ...d }; delete n[key]; return n; });
    if (!Object.keys(editVinsRef.current).length) stopTimers();
  }
  async function doHeartbeat() {
    const v = heldVins();
    if (!v.length) { stopTimers(); return; }
    try {
      const { held } = await api.lockHeartbeat(v, holderIdRef.current);
      const heldSet = new Set(held || []);
      for (const [key, vins] of Object.entries(editVinsRef.current)) {
        if (!vins.some((x) => heldSet.has(x))) { // lost the lock (expired & stolen)
          setNotice('A lock expired and was taken by another editor — your unsaved change on that row was discarded.');
          closeEdit(key, { release: false });
        }
      }
    } catch { /* transient network blip — TTL is generous */ }
  }
  async function refreshLocks() {
    try { const { locks: ls } = await api.lockList(); const m = {}; for (const l of ls) m[l.vin] = l; setLocks(m); }
    catch { /* ignore */ }
  }
  const myId = holderIdRef.current;
  const lockHolder = (g) => { for (const v of g.vins) { const l = locks[v]; if (l && l.holder_id !== myId) return l.holder; } return null; };

  async function load(m = month, y = year) {
    releaseAll();
    setLoading(true); setError(''); setNotice('');
    try {
      const { rows: r } = await api.phList(m, Number(y) || curYear, kind);
      setRows(r); setEditing(new Set()); setDrafts({});
    } catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Poll presence so "being edited by X" stays current (editors only).
  useEffect(() => {
    if (!canEdit) return undefined;
    refreshLocks();
    const t = setInterval(refreshLocks, PRESENCE_POLL_MS);
    return () => clearInterval(t);
  }, [canEdit]); // eslint-disable-line react-hooks/exhaustive-deps
  // Release my locks when leaving the page.
  useEffect(() => () => { releaseAll(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Claim the lock first; only enter edit mode if no one else holds it.
  async function startEdit(g) {
    setError(''); setNotice('');
    try {
      await api.lockClaim(g.vins, holderIdRef.current);
    } catch (err) {
      if (err.unauthorized) return onSignOut();
      if (err.conflict) {
        const who = err.data?.blockers?.[0]?.holder;
        setError(`🔒 ${who || 'Another PH user'} is editing this item right now. Try again in a moment.`);
        refreshLocks();
        return;
      }
      return setError(err.message);
    }
    editVinsRef.current[g.key] = g.vins;
    setEditing((s) => new Set(s).add(g.key));
    setDrafts((d) => ({ ...d, [g.key]: {
      price: g.price ?? '', added_to_intel_inv: !!g.added_to_intel_inv,
      synced_alias: !!g.synced_alias, synced_stockx: !!g.synced_stockx,
      synced_shopify: !!g.synced_shopify, ph_note: g.ph_note || '',
    } }));
    if (!heartbeatRef.current) heartbeatRef.current = setInterval(doHeartbeat, HEARTBEAT_MS);
    resetIdle();
    refreshLocks();
  }
  const setField = (key, k, v) => { setDrafts((d) => ({ ...d, [key]: { ...d[key], [k]: v } })); resetIdle(); };
  // Save a consolidated group — same edit applied to every member VIN, with an
  // optimistic-concurrency baseline (A). On conflict, reload so they see fresh data.
  async function submitGroup(g) {
    setSavingKey(g.key); setError('');
    try {
      const { rows: updated } = await api.phUpdateMany(g.vins, drafts[g.key], g.last_edit_at || null);
      const byVin = new Map((updated || []).map((u) => [u.vin, u]));
      setRows((rs) => rs.map((x) => byVin.get(x.vin) || x));
      closeEdit(g.key, { release: true });
      refreshLocks();
    } catch (err) {
      if (err.unauthorized) return onSignOut();
      if (err.conflict) { setError(err.message); closeEdit(g.key, { release: true }); load(); return; }
      setError(err.message);
    } finally { setSavingKey(null); }
  }

  // Consolidate, then sort groups by scan date (asc = oldest first).
  const groups = groupPhRows(rows || []);
  groups.sort((a, b) => (sortDir === 'desc' ? (a.created_at < b.created_at ? 1 : -1) : (a.created_at < b.created_at ? -1 : 1)));
  const totalUnits = (rows || []).length;
  return (
    <div className="app app-wide">
      <TopBar title={title} onHome={onHome} onSignOut={onSignOut} />
      <div className="card">
        <div className="ph-filters">
          <label>Month
            <select value={month} onChange={(e) => setMonth(Number(e.target.value))}>
              {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
          </label>
          <label>Year<input value={year} onChange={(e) => setYear(e.target.value.replace(/\D/g, '').slice(0, 4))} inputMode="numeric" /></label>
          <button className="btn primary" onClick={() => load()} disabled={loading}>{loading ? '…' : 'Load'}</button>
          <button className="btn ghost" type="button" onClick={() => setSortDir((s) => (s === 'asc' ? 'desc' : 'asc'))} title="Sort by scan date">
            Date {sortDir === 'asc' ? '↑ oldest' : '↓ newest'}
          </button>
          <span className="muted sm">{groups.length} line{groups.length === 1 ? '' : 's'} · {totalUnits} unit{totalUnits === 1 ? '' : 's'} · all times EST{canEdit ? '' : ' · view only'}</span>
        </div>
      </div>

      {error && <div className="error mt">{error}</div>}
      {notice && <div className="notice mt">{notice}</div>}

      <div className="card">
        {!rows ? <p className="muted">Loading…</p> : !groups.length ? <p className="muted">No items {emptyKind} in {MONTHS[month - 1]} {year}.</p> : isMobile ? (
          <div className="ph-cards">
            {groups.map((g) => {
              const ed = editing.has(g.key);
              const d = drafts[g.key] || {};
              return (
                <div className={`ph-card ${ed ? 'editing' : ''}`} key={g.key}>
                  <div className="ph-card-top">
                    <span className="ph-qty-badge">×{g.qty}</span>
                    <span className="muted sm">{PH_DATE.format(new Date(g.created_at))} · {g._mixedBy ? 'multiple' : (g.created_by || '—')}</span>
                  </div>
                  <div className="ph-card-title">{g.name || '—'} <span className="muted">— {g.sku || '—'}</span></div>
                  <div className="ph-card-subline muted sm">
                    Size <b>{g.size || '—'}</b>{g.gender ? <> · {g.gender}</> : ''} · <StatusPill status={g.status} />
                  </div>
                  <div className="ph-card-line">
                    <span>Cost <b>{g.cost != null ? `$${Number(g.cost).toFixed(2)}` : '—'}</b></span>
                    <span className="ph-card-price">Price {ed
                      ? <input className="ph-price" type="number" min="0" step="0.01" value={d.price} onChange={(e) => setField(g.key, 'price', e.target.value)} />
                      : <b>{g.price != null ? `$${Number(g.price).toFixed(2)}` : '—'}</b>}</span>
                  </div>
                  <div className="ph-card-flags">
                    {PH_FLAGS.map(([k, label]) => (
                      <div className="ph-card-flag" key={k}>
                        <span className="muted sm">{label}</span>
                        <YesNo value={ed ? d[k] : g[k]} editing={ed} onChange={(v) => setField(g.key, k, v)} />
                      </div>
                    ))}
                  </div>
                  <div className="ph-card-note">
                    <span className="muted sm">Note</span>
                    {ed
                      ? <textarea className="ph-note" rows={2} value={d.ph_note} onChange={(e) => setField(g.key, 'ph_note', e.target.value)} />
                      : <div>{g.ph_note || '—'}</div>}
                  </div>
                  <div className="ph-card-foot">
                    <span className="muted sm">{g.last_edit_by ? `By ${g.last_edit_by}${g.last_edit_at ? ` · ${PH_DATETIME.format(new Date(g.last_edit_at))} EST` : ''}` : '—'}</span>
                    {canEdit && (() => {
                      const locked = !ed && lockHolder(g);
                      if (ed) return (
                        <span className="ph-edit-actions">
                          <button className="btn sm primary" disabled={savingKey === g.key} onClick={() => submitGroup(g)}>{savingKey === g.key ? '…' : `Submit ×${g.qty}`}</button>
                          <button className="btn sm ghost" disabled={savingKey === g.key} onClick={() => closeEdit(g.key)}>Cancel</button>
                        </span>
                      );
                      if (locked) return <span className="lock-badge" title={`Being edited by ${locked}`}>🔒 {locked}</span>;
                      return <button className="btn sm ghost" onClick={() => startEdit(g)}>Edit</button>;
                    })()}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="ph-wrap">
            <table className="ph-table">
              <thead>
                <tr>
                  <th style={frozenStyle(0)} className="ph-frozen">Date</th>
                  <th style={frozenStyle(1)} className="ph-frozen">Shoe Title</th>
                  <th style={frozenStyle(2)} className="ph-frozen">SKU</th>
                  <th style={frozenStyle(3)} className="ph-frozen">Size</th>
                  <th style={frozenStyle(4)} className="ph-frozen ph-frozen-last">Qty</th>
                  <th>Gender</th><th>Status</th><th>Scanned by</th><th>Cost</th><th>Price</th>
                  <th>Intelligent Inv.</th><th>Alias</th><th>StockX</th><th>Shopify</th><th>Note</th>
                  <th style={rightStyle('action')} className="ph-rfrozen ph-rfrozen-first">Action</th>
                  <th style={rightStyle('addedby')} className="ph-rfrozen">Added by</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => {
                  const ed = editing.has(g.key);
                  const d = drafts[g.key] || {};
                  const val = (k, fallback) => (ed ? d[k] : fallback);
                  return (
                    <tr key={g.key} className={ed ? 'ph-editing' : ''}>
                      <td style={frozenStyle(0)} className="ph-frozen">{PH_DATE.format(new Date(g.created_at))}</td>
                      <td style={frozenStyle(1)} className="ph-frozen ph-title">{g.name || '—'}</td>
                      <td style={frozenStyle(2)} className="ph-frozen">{g.sku || '—'}</td>
                      <td style={frozenStyle(3)} className="ph-frozen ph-size">{g.size || '—'}</td>
                      <td style={frozenStyle(4)} className="ph-frozen ph-frozen-last" title={g.vins.join(', ')}><b>×{g.qty}</b></td>
                      <td>{g.gender || '—'}</td>
                      <td><StatusPill status={g.status} /></td>
                      <td>{g._mixedBy ? <span className="muted">multiple</span> : (g.created_by || '—')}</td>
                      <td>{g.cost != null ? `$${Number(g.cost).toFixed(2)}` : '—'}</td>
                      <td>
                        {ed
                          ? <input className="ph-price" type="number" min="0" step="0.01" value={d.price} onChange={(e) => setField(g.key, 'price', e.target.value)} />
                          : (g.price != null ? `$${Number(g.price).toFixed(2)}` : '—')}
                      </td>
                      <td><YesNo value={val('added_to_intel_inv', g.added_to_intel_inv)} editing={ed} onChange={(v) => setField(g.key, 'added_to_intel_inv', v)} /></td>
                      <td><YesNo value={val('synced_alias', g.synced_alias)} editing={ed} onChange={(v) => setField(g.key, 'synced_alias', v)} /></td>
                      <td><YesNo value={val('synced_stockx', g.synced_stockx)} editing={ed} onChange={(v) => setField(g.key, 'synced_stockx', v)} /></td>
                      <td><YesNo value={val('synced_shopify', g.synced_shopify)} editing={ed} onChange={(v) => setField(g.key, 'synced_shopify', v)} /></td>
                      <td className="ph-note-cell">
                        {ed
                          ? <textarea className="ph-note" rows={1} value={d.ph_note} onChange={(e) => setField(g.key, 'ph_note', e.target.value)} />
                          : <span className="ph-note-view" title={g.ph_note || ''}>{g.ph_note || '—'}</span>}
                      </td>
                      <td style={rightStyle('action')} className="ph-rfrozen ph-rfrozen-first">
                        {!canEdit ? <span className="muted">—</span>
                          : ed
                            ? (<span className="ph-edit-actions">
                                <button className="btn sm primary" disabled={savingKey === g.key} onClick={() => submitGroup(g)}>{savingKey === g.key ? '…' : `Submit ×${g.qty}`}</button>
                                <button className="btn sm ghost" disabled={savingKey === g.key} onClick={() => closeEdit(g.key)}>Cancel</button>
                              </span>)
                            : (lockHolder(g)
                                ? <span className="lock-badge" title={`Being edited by ${lockHolder(g)}`}>🔒 {lockHolder(g)}</span>
                                : <button className="btn sm ghost" onClick={() => startEdit(g)}>Edit</button>)}
                      </td>
                      <td style={rightStyle('addedby')} className="ph-rfrozen ph-addedby">
                        {g.last_edit_by ? <>{g.last_edit_by}<div className="muted sm">{g.last_edit_at ? `${PH_DATETIME.format(new Date(g.last_edit_at))} EST` : ''}</div></> : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------ No Box --------------------------------- */
// Pending "Bought Without Box" units — not postable, so hidden from the PH
// report. Visible to admin + PH; admin/warehouse change the status to resolve a
// unit (it then leaves this queue and re-appears in the PH report). PH is
// read-only (the status endpoint is warehouse/admin-gated anyway).
function NoBoxReport({ user, onHome, onSignOut }) {
  const canEdit = user.role === 'admin' || user.role === 'warehouse';
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [drafts, setDrafts] = useState({}); // vin -> chosen status
  const [savingVin, setSavingVin] = useState(null);
  useUnsavedGuard(Object.keys(drafts).length > 0); // guard staged no-box resolutions

  async function load() {
    setError('');
    try { const { rows: r } = await api.noBoxList(); setRows(r); setDrafts({}); }
    catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
  }
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const setDraft = (vin, status) => setDrafts((d) => ({ ...d, [vin]: status }));
  async function save(vin) {
    const status = drafts[vin];
    if (!status || status === 'no_box') return;
    setSavingVin(vin); setError('');
    try {
      await api.itemEvent(vin, 'status_change', { status, from: 'no_box', note: 'Resolved from No Box' });
      setRows((rs) => rs.filter((r) => r.vin !== vin)); // resolved → leaves the queue
    } catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setSavingVin(null); }
  }

  return (
    <div className="app">
      <TopBar title="No Box — Not Ready" onHome={onHome} onSignOut={onSignOut} />
      <div className="card">
        <p className="muted sm">
          Units received <b>without a box</b> — not ready for posting, so they’re hidden from the PH report.{' '}
          {canEdit
            ? 'Change a unit’s status once a box is sourced (or it’s cleared to sell without one) — it then returns to the report.'
            : 'Warehouse/admin resolves these; this view is read-only for you.'}
        </p>
        {error && <div className="error mt">{error}</div>}
        {!rows ? <p className="muted">Loading…</p> : !rows.length ? <p className="muted">No “Bought Without Box” items. 🎉</p> : (
          <div className="inv-tablewrap">
            <table className="inv-table">
              <thead>
                <tr>
                  <th className="inv-col-vin">VIN</th>
                  <th>Shoe</th>
                  <th className="inv-col-size">Size</th>
                  <th className="inv-col-sku">SKU</th>
                  <th>Received</th>
                  <th>{canEdit ? 'Resolve → status' : 'Status'}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.vin}>
                    <td className="inv-col-vin"><span className="vin">{r.vin}</span></td>
                    <td className="inv-name" title={r.name}>{r.name}</td>
                    <td className="inv-col-size">{r.size ? `US ${r.size}` : '—'}</td>
                    <td className="inv-col-sku">{r.sku || '—'}</td>
                    <td className="muted sm" style={{ whiteSpace: 'nowrap' }}>{(r.created_at || '').slice(0, 10)}{r.created_by ? ` · ${r.created_by}` : ''}</td>
                    <td>
                      {canEdit ? (
                        <span className="nobox-resolve">
                          <select value={drafts[r.vin] ?? 'no_box'} onChange={(e) => setDraft(r.vin, e.target.value)}>
                            <option value="no_box">Bought Without Box</option>
                            {STATUSES.filter((s) => s.key !== 'no_box').map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                          </select>
                          <button className="btn sm primary" disabled={!drafts[r.vin] || drafts[r.vin] === 'no_box' || savingVin === r.vin} onClick={() => save(r.vin)}>
                            {savingVin === r.vin ? '…' : 'Save'}
                          </button>
                        </span>
                      ) : <StatusPill status={r.status} />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/* -------------------------- Mark Sold / Shipped ------------------------ */
// Warehouse bulk action: scan many VINs (VIN only — not UPC) and mark them all
// Sold or Shipped at once. Reuses the bulk-status endpoint (sold cascades the
// delist). Unsaved scans are guarded against accidental Back/refresh.
function StatusScanPage({ target, navBack, onHome, onSignOut }) {
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
          <button type="button" className={`btn ${showCam ? 'primary' : 'ghost'}`} onClick={() => setShowCam((v) => !v)} title="Scan with camera">📷</button>
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
