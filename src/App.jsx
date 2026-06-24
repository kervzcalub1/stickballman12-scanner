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

// One history line, naming WHO did it. System-driven changes (e.g. the sold →
// delist cascade) are tagged "(system-generated)". Shared by the Inventory detail
// view and the PH/admin/warehouse History modal.
function eventLabel(e) {
  const by = e.created_by || '—';
  if (e.type === 'scanned') return `Scanned by ${e.details?.by || by}`;
  if (e.type === 'received') return `Received into inventory (by ${by})`;
  if (e.type === 'rescaled') return `Rescaled${e.details?.reason ? ` (${e.details.reason})` : ''}${e.details?.note ? ` — ${e.details.note}` : ''} (by ${by})`;
  if (e.type === 'status_change') return `Status → ${statusLabel(e.details?.status)}${e.details?.note ? ` — ${e.details.note}` : ''} (marked by: ${by})`;
  if (e.type === 'ph_update') return `${e.details?.text || 'Updated'} ${(e.details?.soldCascade || e.details?.system) ? '(system-generated)' : `(by ${by})`}`;
  if (e.type === 'note') return `Note: ${e.details?.text || ''} (by ${by})`;
  if (e.type === 'issue') return `Issue: ${e.details?.text || e.details?.type || ''} (by ${by})`;
  return `${e.type} (by ${by})`;
}

// One PH edit applies to several VINs at once → identical events. Collapse exact
// duplicates (same type / details / who / time) so the timeline reads once.
function dedupeEvents(events) {
  const seen = new Set();
  const out = [];
  for (const e of events || []) {
    const k = `${e.type}|${e.created_by}|${e.created_at}|${JSON.stringify(e.details)}`;
    if (seen.has(k)) continue;
    seen.add(k); out.push(e);
  }
  return out;
}

// Read-only change history for a PH grid line (its VINs) — who changed what, when.
// Visible to PH team, warehouse, and admin.
function HistoryModal({ vins, title, onClose }) {
  const [state, setState] = useState({ loading: true, events: [], error: '' });
  useEffect(() => {
    let cancelled = false;
    api.itemHistory(vins)
      .then((d) => { if (!cancelled) setState({ loading: false, events: dedupeEvents(d.events || []), error: '' }); })
      .catch((e) => { if (!cancelled) setState({ loading: false, events: [], error: e.message || 'Failed to load history.' }); });
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal hist-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">History — {title}</h3>
        {state.loading ? <p className="muted">Loading…</p>
          : state.error ? <div className="error">{state.error}</div>
            : !state.events.length ? <p className="muted">No history yet.</p>
              : (
                <div className="timeline hist-timeline">
                  {state.events.map((e) => (
                    <div className="tl-item" key={e.id}>
                      <div className="tl-dot" />
                      <div className="tl-body">
                        <div>{eventLabel(e)}</div>
                        <div className="muted sm">{PH_DATETIME.format(new Date(e.created_at))} EST{e.vin ? ` · ${e.vin}` : ''}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
        <div className="modal-actions"><button className="btn ghost" onClick={onClose}>Close</button></div>
      </div>
    </div>,
    document.body,
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
const ROUTES = ['receiving', 'rescale', 'inventory', 'report', 'access', 'nobox', 'sold', 'shipped', 'rescalereq'];
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
    // PH users route under /ph/* inside PHTeamApp, which reads the URL itself —
    // don't rewrite it here or we'd clobber a /ph/... deep link.
    if (u.role === 'ph_team') return;
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
  if (view === 'rescalereq') return <RescaleRequestsReport canAudit onHome={() => go('home')} onSignOut={signOut} />;
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
// Pending-work counts for home badges (fetched once when a home screen mounts).
function usePendingCounts() {
  const [counts, setCounts] = useState(null);
  useEffect(() => {
    let on = true;
    api.pendingCounts().then(({ counts: c }) => { if (on) setCounts(c); }).catch(() => {});
    return () => { on = false; };
  }, []);
  return counts;
}
// Small count pills under a home card. `badges` = [[label, n], …]; only n>0 show.
function CardBadges({ badges }) {
  // Each badge: [label, count, variant?] — variant 'ok' (green) | default (amber).
  const shown = (badges || []).filter(([, n]) => Number(n) > 0);
  if (!shown.length) return null;
  return (
    <span className="card-badges">
      {shown.map(([label, n, variant]) => (
        <span key={label} className={`card-badge${variant ? ` card-badge--${variant}` : ''}`}>{label} {n}</span>
      ))}
    </span>
  );
}
// Which badges a given home-card key shows. The four store badges (II/AL/SX/SH)
// go on the listing card; the others on their matching card.
const SYNC_BADGES = (c) => [['II', c.not_ii], ['AL', c.not_alias], ['SX', c.not_stockx], ['SH', c.not_shopify]];
function homeCardBadges(key, c) {
  if (!c) return [];
  if (key === 'report') return SYNC_BADGES(c);
  if (key === 'inventory') return [['Needs shelf', c.needs_shelf]];
  if (key === 'nobox') return [['No box', c.no_box]];
  if (key === 'rescale') return [['Restock', c.restock_pending]];
  if (key === 'rescalereq') return [['Pending', c.rescale_requests], ['Done', c.rescale_requests_audited, 'ok']];
  return [];
}

const HOME_SECTIONS = [
  { title: 'Administration', adminOnly: true, cards: [
    { key: 'access', icon: '🔑', title: 'Check Access', sub: 'Approve, change role, or remove accounts' },
  ] },
  { title: 'Receiving & Stock', cards: [
    { key: 'receiving', icon: '📥', title: 'Receive New', sub: 'Scan a new shipment into a batch' },
    { key: 'rescale', icon: '♻️', title: 'Rescale Stock', sub: 'Re-scan in-hand stock (no shipment)' },
    { key: 'rescalereq', icon: '📨', title: 'Rescale Requests', sub: 'PH-flagged SKUs to recount / rescan' },
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
  const counts = usePendingCounts();
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
                <CardBadges badges={homeCardBadges(c.key, counts)} />
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
        // Keep the UPC whether it was scanned directly or returned by a SKU
        // lookup — it's needed to print the no-box box-style barcode label.
        upc: (isUpc ? c : '') || p.upc || '', scannedSize: p.scannedSize || null, sizeOptions: p.sizes || [],
        gender: p.gender || null, colorway: p.colorway || '',
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
  // Build a completed item from the draft, RESERVING real VINs up front so they
  // are visible in the cart before submit — the warehouse needs the VIN while
  // handling each unit (especially no-box shoes, which must be stickered/noted
  // by hand). Reserved-but-uncommitted numbers are never reused (a gap is safer
  // than risking the same VIN on two different shoes), so abandoning a session
  // can leave harmless gaps in the sequence.
  async function buildItemFromDraft(d) {
    if (!d || !String(d.name).trim()) { setMError('Scan or type a product first.'); return null; }
    const rows = (d.rows || []).filter((r) => String(r.size).trim());
    if (!rows.length) { setMError('Add at least one size.'); return null; }
    const total = rows.reduce((a, r) => a + Math.max(1, Number(r.qty) || 1), 0);
    let vins = [];
    try { const res = await api.reserveVins(total, header.dateReceived); vins = res.vins || []; }
    catch (err) { if (err.unauthorized) { onSignOut(); return null; } /* else proceed; server assigns on commit */ }
    let idx = 0;
    const sizes = rows.map((r) => {
      const qty = Math.max(1, Number(r.qty) || 1);
      const vs = vins.slice(idx, idx + qty); idx += qty;
      return { key: r.key, size: r.size, qty, vins: vs };
    });
    return { key: cartKey++, name: d.name, sku: d.sku, image: d.image, source: d.source, upc: d.upc, gender: d.gender || null, colorway: d.colorway || null, withBox: d.withBox !== false, sizes };
  }
  // Add a completed item to the cart, MERGING into an existing item when it's the
  // same product + same box status (so the same shoe scanned in two sessions
  // shows as one line with combined sizes/quantities/VINs). Different box status
  // stays separate (boxed vs no-box are tracked apart).
  function addOrMergeItem(item) {
    setItems((arr) => {
      const i = arr.findIndex((x) => x.withBox === item.withBox && sameSku(x.sku, item.sku));
      if (i === -1) return [...arr, item];
      const sizes = arr[i].sizes.map((s) => ({ ...s, vins: [...(s.vins || [])] }));
      for (const s of item.sizes) {
        const j = sizes.findIndex((z) => z.size === s.size);
        if (j === -1) sizes.push({ key: cartKey++, size: s.size, qty: s.qty, vins: s.vins || [] });
        else { sizes[j].qty += s.qty; sizes[j].vins = [...sizes[j].vins, ...(s.vins || [])]; }
      }
      const copy = [...arr]; copy[i] = { ...arr[i], sizes }; return copy;
    });
  }
  async function completeItem() {
    setMBusy(true);
    try {
      const item = await buildItemFromDraft(draftRef.current);
      if (!item) return;
      addOrMergeItem(item);
      closeAddItem();
    } finally { setMBusy(false); }
  }
  async function confirmSwitch() {
    setMBusy(true);
    try {
      const item = await buildItemFromDraft(draftRef.current);
      if (!item) return; // current invalid — keep editing it (prompt stays)
      addOrMergeItem(item);
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
              out.push({ name: it.name, sku: it.sku, size: r.size, upc: it.upc, image: it.image, source: it.source, gender: it.gender, colorway: it.colorway, cost: defaultCostNum, withBox: it.withBox, vin: r.vins?.[n] || null });
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
      const printItems = (batchRes?.vins || []).map((vin, i) => ({
        vin, name: out[i]?.name, sku: out[i]?.sku, size: out[i]?.size,
        upc: out[i]?.upc, colorway: out[i]?.colorway, gender: out[i]?.gender, withBox: out[i]?.withBox,
      }));
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
// Calendar-style date navigation helpers for the Inventory period switcher.
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function periodRange(mode, a) {
  if (mode === 'week') { const s = new Date(a); s.setDate(a.getDate() - a.getDay()); const e = new Date(s); e.setDate(s.getDate() + 6); return [s, e]; }
  if (mode === 'month') return [new Date(a.getFullYear(), a.getMonth(), 1), new Date(a.getFullYear(), a.getMonth() + 1, 0)];
  return [new Date(a), new Date(a)]; // day
}
function shiftAnchor(mode, a, dir) {
  const n = new Date(a);
  if (mode === 'week') n.setDate(a.getDate() + 7 * dir);
  else if (mode === 'month') n.setMonth(a.getMonth() + dir);
  else n.setDate(a.getDate() + dir);
  return n;
}
function periodLabel(mode, a) {
  if (mode === 'month') return a.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const [s, e] = periodRange(mode, a);
  if (mode === 'day') return s.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  // Week — built explicitly so it reads e.g. "Jun 21 – 27, 2026" (same month),
  // "Jun 28 – Jul 4, 2026" (cross-month), "Dec 29, 2025 – Jan 4, 2026" (cross-year).
  const mon = (d) => d.toLocaleDateString('en-US', { month: 'short' });
  if (s.getFullYear() !== e.getFullYear()) return `${mon(s)} ${s.getDate()}, ${s.getFullYear()} – ${mon(e)} ${e.getDate()}, ${e.getFullYear()}`;
  if (s.getMonth() !== e.getMonth()) return `${mon(s)} ${s.getDate()} – ${mon(e)} ${e.getDate()}, ${e.getFullYear()}`;
  return `${mon(s)} ${s.getDate()} – ${e.getDate()}, ${e.getFullYear()}`;
}

// Reusable Day/Week/Month calendar switcher. Controlled: parent owns
// {mode, anchor} and reloads when onChange fires. Pages compute from/to with
// periodRange(mode, anchor).map(ymd).
function DateRangeBar({ mode, anchor, onChange, right }) {
  return (
    <div className="cal-bar">
      <div className="seg cal-modes" role="group" aria-label="Date range">
        {[['day', 'Day'], ['week', 'Week'], ['month', 'Month']].map(([m, lbl]) => (
          <button key={m} type="button" className={`seg-btn ${mode === m ? 'on' : ''}`} onClick={() => onChange(m, anchor)}>{lbl}</button>
        ))}
      </div>
      <div className="cal-nav">
        <button type="button" className="btn ghost sm" onClick={() => onChange(mode, shiftAnchor(mode, anchor, -1))} aria-label="Previous">‹</button>
        <span className="cal-label">{periodLabel(mode, anchor)}</span>
        <button type="button" className="btn ghost sm" onClick={() => onChange(mode, shiftAnchor(mode, anchor, 1))} aria-label="Next">›</button>
        <button type="button" className="btn ghost sm" onClick={() => onChange(mode, new Date())}>Today</button>
      </div>
      {right}
    </div>
  );
}
// from/to (YYYY-MM-DD) for the current period.
const rangeOf = (mode, anchor) => periodRange(mode, anchor).map(ymd);

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
  const [periodMode, setPeriodMode] = useState('day'); // 'day' | 'week' | 'month' | 'custom'
  const [anchor, setAnchor] = useState(() => new Date()); // reference date for the current period
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
  const isMobile = useMediaQuery('(max-width: 768px)');

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
    setPeriodMode('day'); setAnchor(new Date());
    load({ q: '', from: today, to: today, supplier: '', status: '', intake: '' });
  }
  // Calendar-style navigation: switch period (day/week/month) or step ‹ / › and
  // immediately load that range — no Apply needed.
  function gotoPeriod(mode, a) {
    const [s, e] = periodRange(mode, a);
    const fs = ymd(s); const es = ymd(e);
    setPeriodMode(mode); setAnchor(a); setFrom(fs); setTo(es); setQ('');
    load({ q: '', from: fs, to: es });
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

              <div className="send"><button className="btn ghost wide" onClick={() => setLabels([{ vin: it.vin, sku: it.sku, size: it.size, name: it.name, upc: it.upc, colorway: it.colorway, gender: it.gender, withBox: it.with_box }])}>🖨 Print this label</button></div>
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
  // Merge by SKU + status (sizes aggregated), same as the PH report.
  const groups = groupPhRows(rows);
  const groupItems = (g) => rows.filter((r) => g.vins.includes(r.vin));
  const toggle = (vin) => setSel((s) => { const n = new Set(s); n.has(vin) ? n.delete(vin) : n.add(vin); return n; });
  const toggleAll = () => setSel((s) => (s.size === rows.length ? new Set() : new Set(rows.map((r) => r.vin))));
  const groupChecked = (g) => g.vins.every((v) => sel.has(v));
  const toggleGroup = (g) => setSel((s) => { const n = new Set(s); const all = g.vins.every((v) => n.has(v)); g.vins.forEach((v) => (all ? n.delete(v) : n.add(v))); return n; });
  const selectedItems = rows.filter((r) => sel.has(r.vin));

  // Status change over a whole SKU group (all its VINs) via bulk-status.
  async function saveGroupStatus(g) {
    const status = statusDrafts[g.key];
    if (!status || status === g.status) return;
    setSavingStatusVin(g.key); setError('');
    try {
      await api.bulkStatus(g.vins, status);
      setStatusDrafts((d) => { const n = { ...d }; delete n[g.key]; return n; });
      load();
    } catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setSavingStatusVin(null); }
  }

  // Expanded detail for a SKU group — metrics, group status change, print all,
  // and a per-VIN units list (drill into any one for its full history).
  const invDetail = (g) => (
    <div className="inv-detail">
      <dl className="inv-metrics">
        <div><dt>Date received</dt><dd>{(g.date_received || '').slice(0, 10) || '—'}</dd></div>
        <div><dt>Cost</dt><dd>{g.cost != null ? `${g.costMixed ? '~' : ''}$${Number(g.cost).toFixed(2)}` : '—'}</dd></div>
        <div><dt>Supplier / Buyer</dt><dd>{g.supplier_name || '—'}{g.buyer_name ? ` / ${g.buyer_name}` : ''}</dd></div>
        <div><dt>Total units</dt><dd>{g.qty}</dd></div>
        <div className="inv-metrics-wide"><dt>Sizes</dt><dd><SizesQty sizes={g.sizes} /></dd></div>
        <div><dt>Price</dt><dd>{g.price != null ? `${g.priceMixed ? '~' : ''}$${Number(g.price).toFixed(2)}` : '—'}</dd></div>
        <div className="inv-metrics-wide"><dt>Listed / synced</dt><dd><SyncBadges item={g} /></dd></div>
      </dl>
      <div className="inv-actions">
        <label className="inv-status-edit">Status (all {g.qty})
          <select value={statusDrafts[g.key] ?? g.status} onChange={(e) => setStatusDraft(g.key, e.target.value)}>
            {STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </label>
        <button className="btn sm primary" disabled={(statusDrafts[g.key] ?? g.status) === g.status || savingStatusVin === g.key} onClick={() => saveGroupStatus(g)}>
          {savingStatusVin === g.key ? 'Saving…' : 'Save'}
        </button>
        <button className="btn sm ghost" onClick={() => setLabels(groupItems(g))}>🖨 Print labels ({g.qty})</button>
      </div>
      <div className="inv-units">
        <div className="inv-history-title">Units</div>
        {groupItems(g).map((r) => (
          <div className="inv-unit-row" key={r.vin}>
            <span className="vin">{r.vin}</span>
            <span className="muted sm">{r.size ? `US ${r.size}` : '—'}</span>
            <button className="btn sm ghost" onClick={() => openDetail(r.vin)}>Details →</button>
          </div>
        ))}
      </div>
    </div>
  );

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

        <div className="cal-bar mt">
          <div className="seg cal-modes" role="group" aria-label="Date range">
            {[['day', 'Day'], ['week', 'Week'], ['month', 'Month'], ['custom', 'Custom']].map(([m, lbl]) => (
              <button key={m} type="button" className={`seg-btn ${periodMode === m ? 'on' : ''}`}
                onClick={() => (m === 'custom' ? setPeriodMode('custom') : gotoPeriod(m, anchor))}>{lbl}</button>
            ))}
          </div>
          {periodMode !== 'custom' && (
            <div className="cal-nav">
              <button type="button" className="btn ghost sm" onClick={() => gotoPeriod(periodMode, shiftAnchor(periodMode, anchor, -1))} aria-label="Previous">‹</button>
              <span className="cal-label">{periodLabel(periodMode, anchor)}</span>
              <button type="button" className="btn ghost sm" onClick={() => gotoPeriod(periodMode, shiftAnchor(periodMode, anchor, 1))} aria-label="Next">›</button>
              <button type="button" className="btn ghost sm" onClick={viewToday}>Today</button>
            </div>
          )}
        </div>

        <div className="report-filters mt">
          {periodMode === 'custom' && <label>From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>}
          {periodMode === 'custom' && <label>To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>}
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
          <button className="btn primary" onClick={() => load()} disabled={loading}>{loading ? '…' : 'Apply filters'}</button>
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
            {!rows.length ? <p className="muted">No items.</p> : isMobile ? (
              <div className="dcards">
                <label className="dcard-selectall"><input type="checkbox" checked={sel.size === rows.length && rows.length > 0} onChange={toggleAll} /> Select all ({rows.length} units)</label>
                {groups.map((g) => {
                  const open = expanded.has(g.key);
                  return (
                    <div className={`dcard ${open ? 'open' : ''}`} key={g.key}>
                      <div className="dcard-top">
                        <label onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={groupChecked(g)} onChange={() => toggleGroup(g)} /> <span className="dcard-name">{g.name}</span></label>
                        <button className="btn icon ghost sm" onClick={() => toggleRow(g.key)} aria-expanded={open}>{open ? '▾' : '▸'}</button>
                      </div>
                      <button className="dcard-main" onClick={() => toggleRow(g.key)}>
                        <div className="dcard-line"><span className="muted">{g.sku || '—'}</span><span>×{g.qty}</span></div>
                        <div className="dcard-line"><span className="muted sm"><SizesQty sizes={g.sizes} /></span></div>
                        <div className="inv-status"><StatusPill status={g.status} /><SyncBadges item={g} /></div>
                      </button>
                      {open && invDetail(g)}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="inv-tablewrap">
                <table className="inv-table">
                  <thead>
                    <tr>
                      <th className="inv-col-check">
                        <input type="checkbox" checked={sel.size === rows.length && rows.length > 0} onChange={toggleAll} aria-label="Select all" />
                      </th>
                      <th>Shoe</th>
                      <th className="inv-col-sku">SKU</th>
                      <th>Sizes (qty)</th>
                      <th className="inv-col-size">Qty</th>
                      <th className="inv-col-status">Status &amp; sync</th>
                    </tr>
                  </thead>
                  <tbody>
                  {groups.map((g) => {
                    const open = expanded.has(g.key);
                    return (
                      <React.Fragment key={g.key}>
                        <tr className={`inv-trow ${open ? 'open' : ''}`} onClick={() => toggleRow(g.key)}>
                          <td className="inv-col-check" onClick={(e) => e.stopPropagation()}>
                            <input type="checkbox" checked={groupChecked(g)} onChange={() => toggleGroup(g)} aria-label={`Select ${g.sku}`} />
                          </td>
                          <td className="inv-name" title={g.name}><span className="inv-caret">{open ? '▾' : '▸'}</span>{g.name}</td>
                          <td className="inv-col-sku">{g.sku || '—'}</td>
                          <td className="ph-sizes"><SizesQty sizes={g.sizes} /></td>
                          <td className="inv-col-size"><b>×{g.qty}</b></td>
                          <td className="inv-col-status"><span className="inv-status"><StatusPill status={g.status} /><SyncBadges item={g} /></span></td>
                        </tr>
                        {open && (
                          <tr className="inv-drow">
                            <td colSpan={6}>{invDetail(g)}</td>
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
const PH_DATE = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: '2-digit', day: '2-digit', year: '2-digit' });
const PH_DATETIME = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: '2-digit', day: '2-digit', hour: 'numeric', minute: '2-digit', hour12: true });
// Frozen columns and their fixed widths (px): Date, Title, SKU, Qty.
// Rows are merged per SKU+status; the size breakdown is a scrolling column.
const PH_FROZEN_W = [86, 210, 120, 54];
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

// Final price auto-derives from the global indicator: entered amount + 20%.
// Empty/non-numeric global indicator clears the final price.
const PRICE_MARKUP = 1.2;
function calcFinalPrice(globalIndicator) {
  if (globalIndicator === '' || globalIndicator == null) return '';
  const n = Number(globalIndicator);
  if (!Number.isFinite(n)) return '';
  return (Math.round(n * PRICE_MARKUP * 100) / 100).toFixed(2);
}

// Merge into ONE row per SKU + status (regardless of size), because the PH team
// encodes a SKU to Intelligent Inventory once for all its sizes. The row lists
// each size with its quantity; Price + II/AL/SX/SH + Note are set once for the
// whole SKU and applied to every member VIN. A sync flag reads "Yes" only when
// ALL units have it (so a partially-synced SKU shows as not-done).
const sizeNum = (s) => { const m = String(s).match(/[\d.]+/); return m ? parseFloat(m[0]) : NaN; };
function groupPhRows(list) {
  const map = new Map();
  for (const r of list) {
    const key = `${r.sku || ''}|#|${r.status || ''}`;
    let g = map.get(key);
    if (!g) {
      g = {
        ...r, key, vins: [], qty: 0, _mixedBy: false, _sizeMap: {}, _prices: new Set(), _globals: new Set(), _costs: new Set(),
        _flags: { added_to_intel_inv: true, synced_alias: true, synced_stockx: true, synced_shopify: true },
      };
      map.set(key, g);
    }
    g.vins.push(r.vin);
    g.qty += 1;
    const sz = r.size || '—';
    g._sizeMap[sz] = (g._sizeMap[sz] || 0) + 1;
    g._prices.add(r.price == null ? '' : String(r.price));
    g._globals.add(r.global_indicator == null ? '' : String(r.global_indicator));
    g._costs.add(r.cost == null ? '' : String(r.cost));
    for (const f of ['added_to_intel_inv', 'synced_alias', 'synced_stockx', 'synced_shopify']) g._flags[f] = g._flags[f] && !!r[f];
    if (r.created_by !== g.created_by) g._mixedBy = true;
    if (r.created_at < g.created_at) g.created_at = r.created_at; // earliest scan
    if (r.last_edit_at && (!g.last_edit_at || r.last_edit_at > g.last_edit_at)) {
      g.last_edit_at = r.last_edit_at; g.last_edit_by = r.last_edit_by;
    }
  }
  return [...map.values()].map((g) => ({
    ...g,
    ...g._flags, // representative flags = all-units-true
    priceMixed: g._prices.size > 1,
    globalMixed: g._globals.size > 1,
    costMixed: g._costs.size > 1,
    sizes: Object.entries(g._sizeMap).sort((a, b) => (sizeNum(a[0]) - sizeNum(b[0])) || String(a[0]).localeCompare(b[0])).map(([size, qty]) => ({ size, qty })),
  }));
}

// Like groupPhRows, but keeps a per-SIZE breakdown inside each SKU+status group
// (the PH grid's expandable detail). Cost / global indicator / final price are
// tracked PER SIZE (each can differ); II/AL/SX/SH + Note stay per-SKU (set once,
// applied to all sizes). `sizes[]` carries each size's vins, qty and its own
// cost/global_indicator/price (+ *Mixed flags when units within a size differ).
const FLAG_KEYS = ['added_to_intel_inv', 'synced_alias', 'synced_stockx', 'synced_shopify'];
function groupPhSized(list) {
  const map = new Map();
  for (const r of list) {
    const key = `${r.sku || ''}|#|${r.status || ''}`;
    let g = map.get(key);
    if (!g) {
      g = {
        key, sku: r.sku, name: r.name, status: r.status, gender: r.gender,
        created_at: r.created_at, created_by: r.created_by, _mixedBy: false,
        vins: [], qty: 0,
        first_edit_at: null, first_edit_by: null, _hasSubsequent: false,
        last_edit_at: r.last_edit_at, last_edit_by: r.last_edit_by,
        _flags: { added_to_intel_inv: true, synced_alias: true, synced_stockx: true, synced_shopify: true },
        _sizes: new Map(),
      };
      map.set(key, g);
    }
    g.vins.push(r.vin); g.qty += 1;
    if (r.created_by !== g.created_by) g._mixedBy = true;
    if (r.created_at < g.created_at) g.created_at = r.created_at;
    if (r.last_edit_at && (!g.last_edit_at || r.last_edit_at > g.last_edit_at)) { g.last_edit_at = r.last_edit_at; g.last_edit_by = r.last_edit_by; }
    // First editor = earliest first_edit_at across the group ("Added by").
    if (r.first_edit_at && (!g.first_edit_at || r.first_edit_at < g.first_edit_at)) { g.first_edit_at = r.first_edit_at; g.first_edit_by = r.first_edit_by; }
    // A unit edited more than once has last_edit_at strictly after its own
    // first_edit_at (per-VIN, same-submit edits share now()) → subsequent edits exist.
    if (r.first_edit_at && r.last_edit_at && new Date(r.last_edit_at) > new Date(r.first_edit_at)) g._hasSubsequent = true;
    for (const f of FLAG_KEYS) g._flags[f] = g._flags[f] && !!r[f]; // group badge = all units true
    const sz = r.size || '—';
    let s = g._sizes.get(sz);
    if (!s) {
      s = { size: sz, vins: [], qty: 0, cost: null, global_indicator: null, price: null, note: null, _costs: new Set(), _globals: new Set(), _prices: new Set(),
        _flags: { added_to_intel_inv: true, synced_alias: true, synced_stockx: true, synced_shopify: true } };
      g._sizes.set(sz, s);
    }
    s.vins.push(r.vin); s.qty += 1;
    s._costs.add(r.cost == null ? '' : String(r.cost));
    s._globals.add(r.global_indicator == null ? '' : String(r.global_indicator));
    s._prices.add(r.price == null ? '' : String(r.price));
    if (s.cost == null && r.cost != null) s.cost = r.cost;
    if (s.global_indicator == null && r.global_indicator != null) s.global_indicator = r.global_indicator;
    if (s.price == null && r.price != null) s.price = r.price;
    if (!(s.note || '') && (r.ph_note || '')) s.note = r.ph_note; // per-size note (first non-empty)
    for (const f of FLAG_KEYS) s._flags[f] = s._flags[f] && !!r[f]; // per-size flag = all units of that size true
  }
  return [...map.values()].map((g) => ({
    ...g, ...g._flags,
    sizes: [...g._sizes.values()]
      .sort((a, b) => (sizeNum(a.size) - sizeNum(b.size)) || String(a.size).localeCompare(b.size))
      .map((s) => ({
        size: s.size, vins: s.vins, qty: s.qty,
        cost: s.cost, costMixed: s._costs.size > 1,
        global_indicator: s.global_indicator, globalMixed: s._globals.size > 1,
        price: s.price, priceMixed: s._prices.size > 1,
        note: s.note,
        ...s._flags,
      })),
  }));
}
// "9 ×2 · 9.5 ×3 · 10 ×1"
const sizesLabel = (g) => (g.sizes || []).map((s) => `${s.size} ×${s.qty}`).join(', ');
// Sizes as discrete chips (clearer than a run-on string when there are many).
function SizesQty({ sizes }) {
  if (!sizes || !sizes.length) return <span className="muted">—</span>;
  return (
    <span className="szq">
      {sizes.map((s) => <span className="szq-chip" key={s.size}><span className="szq-size">{s.size}</span><span className="szq-qty">×{s.qty}</span></span>)}
    </span>
  );
}

function YesNo({ value, editing, onChange }) {
  if (!editing) return <span className={`ph-yn ${value ? 'yes' : 'no'}`}>{value ? 'Yes' : 'No'}</span>;
  // Edit mode: a colored checkbox (blue = checked/yes, red = unchecked/no) —
  // one click to toggle, no dropdown.
  return (
    <input type="checkbox" className={`ph-yn-check ${value ? 'yes' : 'no'}`} checked={!!value}
      onChange={(e) => onChange(e.target.checked)} aria-label={value ? 'Yes' : 'No'} title={value ? 'Yes' : 'No'} />
  );
}

// PH Team home: pick which monthly report to work — New Inventory (newly
// received stock) or Rescale Stock (units re-scanned for re-listing). Both do
// the same job: price + sync to Intelligent Inventory / Alias / StockX / Shopify.
// PH pages are URL-routed under /ph/* (their own namespace, separate from the
// warehouse/admin ROUTES) so a refresh restores the page and Back/Forward work.
const PH_PATHS = { receiving: '/ph/new-inventory', rescale: '/ph/rescale', nobox: '/ph/nobox', request: '/ph/request' };
const phPathForPage = (page) => (page && PH_PATHS[page]) || '/';
const phPageForPath = (p) => {
  const path = String(p || '/').replace(/\/+$/, '') || '/';
  return Object.keys(PH_PATHS).find((k) => PH_PATHS[k] === path) || null;
};

function PHTeamApp({ user, onSignOut }) {
  // page <-> URL: null = home chooser | 'receiving' | 'rescale' | 'nobox' | 'request'
  const [page, setPage] = useState(() => phPageForPath(window.location.pathname));
  const counts = usePendingCounts();
  // Navigate + push the matching /ph/* URL; Back/Forward + refresh restore it.
  const goPage = (p) => {
    setPage(p);
    const path = phPathForPage(p);
    if (window.location.pathname !== path) window.history.pushState(null, '', path);
  };
  useEffect(() => {
    const onPop = () => setPage(phPageForPath(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  if (page === 'nobox') return <NoBoxReport user={user} onHome={() => goPage(null)} onSignOut={onSignOut} />;
  if (page === 'request') return <RescaleRequestsReport canCreate onHome={() => goPage(null)} onSignOut={onSignOut} />;
  if (page) return <PHGrid user={user} kind={page} onHome={() => goPage(null)} onSignOut={onSignOut} />;
  return (
    <div className="app">
      <TopBar onSignOut={onSignOut} />
      <div className="home-greeting">Hi {user.name} <span className="role-badge">{roleLabel(user.role)}</span></div>
      <div className="home-grid">
        <button className="home-card" onClick={() => goPage('receiving')}>
          <span className="home-card-icon">📥</span>
          <span className="home-card-title">New Inventory</span>
          <span className="home-card-sub">Price &amp; list newly received stock — Intelligent Inventory, Alias, StockX, Shopify</span>
          <CardBadges badges={counts ? SYNC_BADGES(counts) : []} />
        </button>
        <button className="home-card" onClick={() => goPage('rescale')}>
          <span className="home-card-icon">♻️</span>
          <span className="home-card-title">Rescale Stock</span>
          <span className="home-card-sub">Re-list rescanned units (returns, relistings, recounts, transfers) across the stores</span>
          <CardBadges badges={counts ? [['Restock', counts.restock_pending]] : []} />
        </button>
        <button className="home-card" onClick={() => goPage('nobox')}>
          <span className="home-card-icon">🚫</span>
          <span className="home-card-title">No Box / Not Ready</span>
          <span className="home-card-sub">Units bought without a box — not yet postable (view-only; warehouse resolves)</span>
          <CardBadges badges={counts ? [['No box', counts.no_box]] : []} />
        </button>
        <button className="home-card" onClick={() => goPage('request')}>
          <span className="home-card-icon">📨</span>
          <span className="home-card-title">Request Rescale</span>
          <span className="home-card-sub">Flag a SKU for the warehouse to recount / rescan (mismatch, quantity…)</span>
          <CardBadges badges={counts ? [['Pending audit', counts.rescale_requests], ['Audited', counts.rescale_requests_audited, 'ok']] : []} />
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
const LIST_POLL_MS = 15_000;       // quietly re-fetch the list (new shoes / others' saved edits)

// `kind`: 'receiving' (New Inventory) · 'rescale' (Rescale Stock) · null (all — admin Report).
function PHGrid({ user, kind = null, onHome, onSignOut }) {
  const canEdit = user?.role === 'ph_team'; // admin + warehouse are read-only
  const showPricing = user?.role !== 'warehouse'; // GI + Final price hidden from warehouse
  const title = kind === 'rescale' ? 'Rescale Stock' : kind === 'receiving' ? 'New Inventory' : 'Report';
  const emptyKind = kind === 'rescale' ? 'rescaled' : kind === 'receiving' ? 'received' : 'scanned';
  const isMobile = useMediaQuery('(max-width: 768px)'); // phones get cards, not the wide grid
  // Date range: Report (kind null/receiving) defaults to Month; Rescale to Day.
  const [dr, setDr] = useState(() => ({ mode: kind === 'rescale' ? 'day' : 'month', anchor: new Date() }));
  const [rows, setRows] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(() => new Set()); // group keys in edit mode
  const [drafts, setDrafts] = useState({});                // group key -> edited fields
  const [savingKey, setSavingKey] = useState(null);
  const [sortDir, setSortDir] = useState('asc'); // by scan date: asc = oldest first
  const [expanded, setExpanded] = useState(() => new Set()); // group keys showing per-size detail
  const toggleExpand = (key) => setExpanded((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });
  const [historyFor, setHistoryFor] = useState(null); // { vins, title } — open History modal
  useUnsavedGuard(editing.size > 0); // unsaved edits → guard Back/refresh

  // ---- B2 edit locks / presence ----
  const [locks, setLocks] = useState({});    // vin -> { holder, holder_id } (active locks)
  const [notice, setNotice] = useState('');  // transient (idle release / lost lock)
  const holderIdRef = useRef(null);
  // Per-SESSION id (one per tab/device) — unique even across two sessions of the
  // SAME account, so each session locks/edits independently and can't override
  // another's row. Prefer a UUID; fall back to a random suffix.
  if (!holderIdRef.current) {
    const rand = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : Math.random().toString(36).slice(2, 12);
    holderIdRef.current = `${user?.username || 'ph'}-${rand}`;
  }
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

  async function load() {
    releaseAll();
    setLoading(true); setError(''); setNotice('');
    try {
      const [from, to] = rangeOf(dr.mode, dr.anchor);
      const { rows: r } = await api.phList(from, to, kind);
      setRows(r); setEditing(new Set()); setDrafts({}); setExpanded(new Set());
    } catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, [dr]); // eslint-disable-line react-hooks/exhaustive-deps
  // Poll presence so "being edited by X" stays current (editors only).
  useEffect(() => {
    if (!canEdit) return undefined;
    refreshLocks();
    const t = setInterval(refreshLocks, PRESENCE_POLL_MS);
    return () => clearInterval(t);
  }, [canEdit]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live list: quietly re-fetch so new shoes from the warehouse and other users'
  // saved edits appear without a manual reload. Skips while THIS session is
  // editing or saving (so an in-progress draft is never disturbed) and while a
  // fetch is already in flight; no spinner, and expanded rows stay open.
  const editingCountRef = useRef(0); editingCountRef.current = editing.size;
  const savingRef = useRef(false); savingRef.current = savingKey != null;
  const pollBusyRef = useRef(false);
  async function quietRefresh() {
    if (editingCountRef.current > 0 || savingRef.current || pollBusyRef.current) return;
    pollBusyRef.current = true;
    try {
      const [from, to] = rangeOf(dr.mode, dr.anchor);
      const { rows: r } = await api.phList(from, to, kind);
      // Re-check: the user may have started editing during the fetch.
      if (editingCountRef.current === 0 && !savingRef.current) setRows(r);
    } catch { /* transient — try again next tick */ }
    finally { pollBusyRef.current = false; }
  }
  useEffect(() => {
    const t = setInterval(quietRefresh, LIST_POLL_MS);
    return () => clearInterval(t);
  }, [dr, kind]); // eslint-disable-line react-hooks/exhaustive-deps
  // Release my locks when leaving the page.
  useEffect(() => () => { releaseAll(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Claim the lock first; only enter edit mode if no one else holds it.
  async function startEdit(g) {
    setError(''); setNotice('');
    // One row at a time per session — finish or cancel the current edit first.
    if (editing.size > 0 && !editing.has(g.key)) {
      setNotice('You can only edit one row at a time on this device — submit or cancel the current edit first.');
      return;
    }
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
    setExpanded((s) => new Set(s).add(g.key)); // editing reveals the per-size detail
    // Everything is per-size — GI, final price, II/AL/SX/SH, and Note (a size can
    // sync / be noted independently of the others).
    const sizes = {};
    for (const s of g.sizes) sizes[s.size] = {
      global_indicator: s.global_indicator ?? '', price: s.price ?? '',
      added_to_intel_inv: !!s.added_to_intel_inv, synced_alias: !!s.synced_alias,
      synced_stockx: !!s.synced_stockx, synced_shopify: !!s.synced_shopify,
      ph_note: s.note || '',
    };
    setDrafts((d) => ({ ...d, [g.key]: { sizes } }));
    if (!heartbeatRef.current) heartbeatRef.current = setInterval(doHeartbeat, HEARTBEAT_MS);
    resetIdle();
    refreshLocks();
  }
  // Update one field of one size's draft (preserving the size's other fields).
  const setSizeField = (key, size, patch) => {
    setDrafts((d) => ({ ...d, [key]: { ...d[key], sizes: { ...d[key].sizes, [size]: { ...d[key].sizes[size], ...patch } } } }));
    resetIdle();
  };
  // Per-size Global indicator drives that size's Final price (entered amount + 20%).
  const setSizeGI = (key, size, v) => setSizeField(key, size, { global_indicator: v, price: calcFinalPrice(v) });
  const setSizePrice = (key, size, v) => setSizeField(key, size, { price: v });
  const setSizeFlag = (key, size, flagKey, v) => setSizeField(key, size, { [flagKey]: v });
  const setSizeNote = (key, size, v) => setSizeField(key, size, { ph_note: v });
  // Save a group: every field is per-size now (GI, final price, II/AL/SX/SH, Note).
  // Sizes touch disjoint VINs, so the per-size updates run in parallel; each uses
  // the group's last_edit_at as the optimistic-concurrency base.
  async function submitGroup(g) {
    setSavingKey(g.key); setError('');
    const d = drafts[g.key] || {};
    try {
      const results = await Promise.all(g.sizes.map((s) => {
        const sd = d.sizes?.[s.size] || {};
        return api.phUpdateMany(s.vins, {
          global_indicator: sd.global_indicator, price: sd.price,
          added_to_intel_inv: sd.added_to_intel_inv, synced_alias: sd.synced_alias,
          synced_stockx: sd.synced_stockx, synced_shopify: sd.synced_shopify,
          ph_note: sd.ph_note,
        }, g.last_edit_at || null);
      }));
      const byVin = new Map();
      for (const r of results) for (const u of (r.rows || [])) byVin.set(u.vin, u);
      setRows((rs) => rs.map((x) => byVin.get(x.vin) || x));
      closeEdit(g.key, { release: true });
      refreshLocks();
    } catch (err) {
      if (err.unauthorized) return onSignOut();
      if (err.conflict) { setError(err.message); closeEdit(g.key, { release: true }); load(); return; }
      setError(err.message);
    } finally { setSavingKey(null); }
  }
  // Rescale worklist: mark a group restocked → clears restock_pending so it drops
  // off this list and behaves as normal inventory.
  async function markRestockedGroup(g) {
    setSavingKey(g.key); setError('');
    try {
      await api.restockDone(g.vins);
      setRows((rs) => rs.filter((x) => !g.vins.includes(x.vin)));
    } catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setSavingKey(null); }
  }
  const isRescale = kind === 'rescale';

  // Consolidate per SKU+status (with per-size detail), then sort by scan date.
  const groups = groupPhSized(rows || []);
  groups.sort((a, b) => (sortDir === 'desc' ? (a.created_at < b.created_at ? 1 : -1) : (a.created_at < b.created_at ? -1 : 1)));
  const totalUnits = (rows || []).length;
  return (
    <div className="app app-wide">
      <TopBar title={title} onHome={onHome} onSignOut={onSignOut} />
      <div className="card">
        <DateRangeBar mode={dr.mode} anchor={dr.anchor} onChange={(mode, anchor) => setDr({ mode, anchor })}
          right={(
            <span className="muted sm">
              {isRescale ? 'pending restocks · ' : ''}{groups.length} line{groups.length === 1 ? '' : 's'} · {totalUnits} unit{totalUnits === 1 ? '' : 's'}{canEdit ? '' : ' · view only'}
              {!isRescale && <button className="btn ghost sm" type="button" style={{ marginLeft: 8 }} onClick={() => setSortDir((s) => (s === 'asc' ? 'desc' : 'asc'))}>Date {sortDir === 'asc' ? '↑' : '↓'}</button>}
            </span>
          )} />
      </div>

      {error && <div className="error mt">{error}</div>}
      {notice && <div className="notice mt">{notice}</div>}

      <div className="card">
        {!rows ? <p className="muted">Loading…</p> : !groups.length ? <p className="muted">No {emptyKind} items in this range.</p> : isMobile ? (
          <div className="ph-cards">
            {groups.map((g) => {
              const ed = editing.has(g.key);
              const d = drafts[g.key] || {};
              const open = ed || expanded.has(g.key);
              return (
                <div className={`ph-card ${ed ? 'editing' : ''}`} key={g.key}>
                  <div className="ph-card-top">
                    <span className="ph-qty-badge">×{g.qty}</span>
                    <span className="muted sm">{PH_DATE.format(new Date(g.created_at))} · {g._mixedBy ? 'multiple' : (g.created_by || '—')}</span>
                  </div>
                  <div className="ph-card-title">{g.name || '—'} <span className="muted">— {g.sku || '—'}</span></div>
                  <div className="ph-card-subline muted sm">
                    {g.gender ? <>{g.gender} · </> : ''}<StatusPill status={g.status} />
                  </div>
                  <button type="button" className="ph-card-sizes ph-card-sizes-btn" onClick={() => toggleExpand(g.key)} aria-expanded={open}>
                    <span className="ph-caret">{open ? '▾' : '▸'}</span><SizesQty sizes={g.sizes} />
                  </button>
                  {open && (
                    <div className="ph-sizedetail">
                      {g.sizes.map((s) => {
                        const sd = ed ? (d.sizes?.[s.size] || {}) : null;
                        return (
                          <div className="ph-sizedetail-row" key={s.size}>
                            <span className="ph-sizedetail-size">US {s.size} <span className="muted">×{s.qty}</span></span>
                            <span className="muted sm">Cost {s.cost != null ? `${s.costMixed ? '~' : ''}$${Number(s.cost).toFixed(2)}` : '—'}</span>
                            {showPricing && <span className="ph-card-price">GI {ed
                              ? <input className="ph-price" type="number" min="0" step="0.01" value={sd.global_indicator} onChange={(e) => setSizeGI(g.key, s.size, e.target.value)} />
                              : <b>{s.global_indicator != null ? `${s.globalMixed ? '~' : ''}$${Number(s.global_indicator).toFixed(2)}` : '—'}</b>}</span>}
                            {showPricing && <span className="ph-card-price">Final {ed
                              ? <input className="ph-price" type="number" min="0" step="0.01" value={sd.price} onChange={(e) => setSizePrice(g.key, s.size, e.target.value)} />
                              : <b>{s.price != null ? `${s.priceMixed ? '~' : ''}$${Number(s.price).toFixed(2)}` : '—'}</b>}</span>}
                            <span className="ph-sizedetail-flags">
                              {PH_FLAGS.map(([k, label]) => (
                                <span className="ph-sizedetail-flag" key={k}>
                                  <span className="muted sm">{label}</span>
                                  <YesNo value={ed ? sd[k] : s[k]} editing={ed} onChange={(v) => setSizeFlag(g.key, s.size, k, v)} />
                                </span>
                              ))}
                            </span>
                            <span className="ph-sizedetail-note">
                              <span className="muted sm">Note</span>
                              {ed
                                ? <textarea className="ph-note" rows={1} value={sd.ph_note} onChange={(e) => setSizeNote(g.key, s.size, e.target.value)} />
                                : <span className="ph-note-view" title={s.note || ''}>{s.note || '—'}</span>}
                            </span>
                            <span className="ph-sizedetail-hist">
                              <button type="button" className="btn sm ghost" onClick={() => setHistoryFor({ vins: s.vins, title: `${g.name || g.sku || ''} · US ${s.size}` })}>🕘 History</button>
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  <div className="ph-card-synced"><span className="muted sm">Listed / synced (all sizes)</span> <SyncBadges item={g} /></div>
                  <div className="ph-card-foot">
                    <span className="muted sm ph-card-credit">
                      {g.first_edit_by ? (
                        <>
                          Added by {g.first_edit_by}{g.first_edit_at ? ` · ${PH_DATETIME.format(new Date(g.first_edit_at))} EST` : ''}
                          {g._hasSubsequent && g.last_edit_by && (
                            <div>Last edited by: {g.last_edit_by}{g.last_edit_at ? ` · ${PH_DATETIME.format(new Date(g.last_edit_at))} EST` : ''}</div>
                          )}
                        </>
                      ) : '—'}
                    </span>
                    {canEdit && (() => {
                      const locked = !ed && lockHolder(g);
                      if (ed) return (
                        <span className="ph-edit-actions">
                          <button className="btn sm primary" disabled={savingKey === g.key} onClick={() => submitGroup(g)}>{savingKey === g.key ? '…' : `Submit ×${g.qty}`}</button>
                          <button className="btn sm ghost" disabled={savingKey === g.key} onClick={() => closeEdit(g.key)}>Cancel</button>
                        </span>
                      );
                      if (locked) return <span className="lock-badge" title={`Being edited by ${locked}`}>🔒 {locked}</span>;
                      return (
                        <span className="ph-edit-actions">
                          <button className="btn sm ghost" disabled={editing.size > 0} title={editing.size > 0 ? 'Finish your current edit first' : ''} onClick={() => startEdit(g)}>Edit</button>
                          {isRescale && <button className="btn sm primary" disabled={savingKey === g.key} onClick={() => markRestockedGroup(g)}>{savingKey === g.key ? '…' : '✓ Restocked'}</button>}
                        </span>
                      );
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
                  <th style={frozenStyle(3)} className="ph-frozen ph-frozen-last">Qty</th>
                  <th>Sizes (qty)</th><th>Gender</th><th>Status</th><th>Listed / synced</th><th>Scanned by</th>
                  <th style={rightStyle('action')} className="ph-rfrozen ph-rfrozen-first">Action</th>
                  <th style={rightStyle('addedby')} className="ph-rfrozen">Added by</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => {
                  const ed = editing.has(g.key);
                  const d = drafts[g.key] || {};
                  const open = ed || expanded.has(g.key);
                  return (
                    <React.Fragment key={g.key}>
                      <tr className={`ph-trow ${ed ? 'ph-editing' : ''} ${open ? 'open' : ''}`} onClick={() => toggleExpand(g.key)}>
                        <td style={frozenStyle(0)} className="ph-frozen">{PH_DATE.format(new Date(g.created_at))}</td>
                        <td style={frozenStyle(1)} className="ph-frozen ph-title"><span className="ph-caret">{open ? '▾' : '▸'}</span>{g.name || '—'}</td>
                        <td style={frozenStyle(2)} className="ph-frozen">{g.sku || '—'}</td>
                        <td style={frozenStyle(3)} className="ph-frozen ph-frozen-last" title={g.vins.join(', ')}><b>×{g.qty}</b></td>
                        <td className="ph-sizes"><SizesQty sizes={g.sizes} /></td>
                        <td>{g.gender || '—'}</td>
                        <td><StatusPill status={g.status} /></td>
                        <td><SyncBadges item={g} /></td>
                        <td>{g._mixedBy ? <span className="muted">multiple</span> : (g.created_by || '—')}</td>
                        <td style={rightStyle('action')} className="ph-rfrozen ph-rfrozen-first" onClick={(e) => e.stopPropagation()}>
                          {!canEdit ? <span className="muted">—</span>
                            : ed
                              ? (<span className="ph-edit-actions">
                                  <button className="btn sm primary" disabled={savingKey === g.key} onClick={() => submitGroup(g)}>{savingKey === g.key ? '…' : `Submit ×${g.qty}`}</button>
                                  <button className="btn sm ghost" disabled={savingKey === g.key} onClick={() => closeEdit(g.key)}>Cancel</button>
                                </span>)
                              : (lockHolder(g)
                                  ? <span className="lock-badge" title={`Being edited by ${lockHolder(g)}`}>🔒 {lockHolder(g)}</span>
                                  : (<span className="ph-edit-actions">
                                      <button className="btn sm ghost" disabled={editing.size > 0} title={editing.size > 0 ? 'Finish your current edit first' : ''} onClick={() => startEdit(g)}>Edit</button>
                                      {isRescale && <button className="btn sm primary" disabled={savingKey === g.key} onClick={() => markRestockedGroup(g)}>{savingKey === g.key ? '…' : '✓ Restocked'}</button>}
                                    </span>))}
                        </td>
                        <td style={rightStyle('addedby')} className="ph-rfrozen ph-addedby">
                          {g.first_edit_by ? (
                            <>
                              {g.first_edit_by}
                              <div className="muted sm">{g.first_edit_at ? `${PH_DATETIME.format(new Date(g.first_edit_at))} EST` : ''}</div>
                              {g._hasSubsequent && g.last_edit_by && (
                                <div className="ph-lastedit muted sm">Last edited by: {g.last_edit_by}{g.last_edit_at ? ` · ${PH_DATETIME.format(new Date(g.last_edit_at))} EST` : ''}</div>
                              )}
                            </>
                          ) : '—'}
                        </td>
                      </tr>
                      {open && (
                        <tr className="ph-drow">
                          <td colSpan={11}>
                            <div className="ph-detail">
                              <table className="ph-sizetable">
                                <thead><tr>
                                  <th>Size</th><th>Qty</th><th>Cost</th>
                                  {showPricing && <><th>Global indicator</th><th>Final Price (GI+20%)</th></>}
                                  {PH_FLAGS.map(([k, label]) => <th key={k}>{label}</th>)}
                                  <th>Note</th><th>History</th>
                                </tr></thead>
                                <tbody>
                                  {g.sizes.map((s) => {
                                    const sd = ed ? (d.sizes?.[s.size] || {}) : null;
                                    return (
                                      <tr key={s.size}>
                                        <td>US {s.size}</td>
                                        <td>×{s.qty}</td>
                                        <td>{s.cost != null ? `${s.costMixed ? '~' : ''}$${Number(s.cost).toFixed(2)}` : '—'}</td>
                                        {showPricing && (
                                          <td>{ed
                                            ? <input className="ph-price" type="number" min="0" step="0.01" value={sd.global_indicator} onChange={(e) => setSizeGI(g.key, s.size, e.target.value)} />
                                            : (s.global_indicator != null ? `${s.globalMixed ? '~' : ''}$${Number(s.global_indicator).toFixed(2)}` : '—')}</td>
                                        )}
                                        {showPricing && (
                                          <td>{ed
                                            ? <input className="ph-price" type="number" min="0" step="0.01" value={sd.price} onChange={(e) => setSizePrice(g.key, s.size, e.target.value)} />
                                            : (s.price != null ? `${s.priceMixed ? '~' : ''}$${Number(s.price).toFixed(2)}` : '—')}</td>
                                        )}
                                        {PH_FLAGS.map(([k]) => (
                                          <td key={k}><YesNo value={ed ? sd[k] : s[k]} editing={ed} onChange={(v) => setSizeFlag(g.key, s.size, k, v)} /></td>
                                        ))}
                                        <td className="ph-note-cell">
                                          {ed
                                            ? <textarea className="ph-note" rows={1} value={sd.ph_note} onChange={(e) => setSizeNote(g.key, s.size, e.target.value)} />
                                            : <span className="ph-note-view" title={s.note || ''}>{s.note || '—'}</span>}
                                        </td>
                                        <td>
                                          <button type="button" className="btn sm ghost" title="View change history"
                                            onClick={() => setHistoryFor({ vins: s.vins, title: `${g.name || g.sku || ''} · US ${s.size}` })}>🕘 History</button>
                                        </td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
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
      {historyFor && <HistoryModal vins={historyFor.vins} title={historyFor.title} onClose={() => setHistoryFor(null)} />}
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
  const [labels, setLabels] = useState(null); // box-style UPC labels to print
  const [dr, setDr] = useState(() => ({ mode: 'day', anchor: new Date() }));
  const isMobile = useMediaQuery('(max-width: 768px)');
  useUnsavedGuard(Object.keys(drafts).length > 0); // guard staged no-box resolutions

  async function load() {
    setError('');
    try { const [from, to] = rangeOf(dr.mode, dr.anchor); const { rows: r } = await api.noBoxList(from, to); setRows(r); setDrafts({}); }
    catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
  }
  useEffect(() => { load(); }, [dr]); // eslint-disable-line react-hooks/exhaustive-deps

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
  // A box was sourced → mark With Box (now sellable; we never sell without a box).
  async function boxFound(vin) {
    setSavingVin(vin); setError('');
    try {
      await api.boxFound(vin);
      setRows((rs) => rs.filter((r) => r.vin !== vin)); // now With Box → leaves the queue
    } catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setSavingVin(null); }
  }

  // Shared controls (used by both the desktop table and the mobile cards).
  // Primary action: "Box found → With Box". A secondary dropdown handles edge
  // cases (e.g. mark Missing/Issue) without selling a no-box pair.
  const resolveCtl = (r) => (canEdit ? (
    <span className="nobox-resolve">
      <button className="btn sm primary" disabled={savingVin === r.vin} onClick={() => boxFound(r.vin)}>
        {savingVin === r.vin ? '…' : '📦 Box found → With Box'}
      </button>
      <select value={drafts[r.vin] ?? ''} onChange={(e) => setDraft(r.vin, e.target.value)}>
        <option value="">Other status…</option>
        {STATUSES.filter((s) => s.key !== 'no_box' && s.key !== 'needs_shelf').map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
      </select>
      <button className="btn sm ghost" disabled={!drafts[r.vin] || savingVin === r.vin} onClick={() => save(r.vin)}>Set</button>
    </span>
  ) : <StatusPill status={r.status} />);
  const boxBtn = (r) => (
    <button className="btn sm ghost" title={upcDigits(r.upc) ? 'Print box label' : 'No UPC on file'} onClick={() => setLabels([r])}>🖨 Box label</button>
  );

  return (
    <div className="app">
      <TopBar title="No Box — Not Ready" onHome={onHome} onSignOut={onSignOut} />
      <div className="card">
        <p className="muted sm">
          Units received <b>without a box</b> — not ready for posting, so they’re hidden from the PH report.{' '}
          {canEdit
            ? 'Once a box is found, “Box found → With Box” makes it sellable.'
            : 'Warehouse/admin resolves these; this view is read-only for you.'}
        </p>
        <DateRangeBar mode={dr.mode} anchor={dr.anchor} onChange={(mode, anchor) => setDr({ mode, anchor })}
          right={<span className="muted sm">{rows ? `${rows.length} unit${rows.length === 1 ? '' : 's'}` : ''}</span>} />
        {canEdit && rows?.length > 0 && (
          <div className="nobox-actions">
            <button className="btn sm primary" onClick={() => setLabels(rows)}>🖨 Print box labels (all {rows.length})</button>
            <span className="muted sm">Box-style UPC labels for no-box shoes — recreate the original box label so it scans normally.</span>
          </div>
        )}
        {error && <div className="error mt">{error}</div>}
        {!rows ? <p className="muted">Loading…</p> : !rows.length ? <p className="muted">No “Bought Without Box” items. 🎉</p> : isMobile ? (
          <div className="dcards">
            {rows.map((r) => (
              <div className="dcard" key={r.vin}>
                <div className="dcard-top"><span className="vin">{r.vin}</span>{!canEdit && <StatusPill status={r.status} />}</div>
                <div className="dcard-name">{r.name || '—'}</div>
                <div className="dcard-line"><span>Size {r.size ? `US ${r.size}` : '—'}</span><span className="muted">{r.sku || '—'}</span></div>
                <div className="dcard-line muted sm">{(r.created_at || '').slice(0, 10)}{r.created_by ? ` · ${r.created_by}` : ''}</div>
                {canEdit && <div className="dcard-actions">{resolveCtl(r)}{boxBtn(r)}</div>}
              </div>
            ))}
          </div>
        ) : (
          <div className="inv-tablewrap">
            <table className="inv-table">
              <thead>
                <tr>
                  <th className="inv-col-vin">VIN</th>
                  <th>Shoe</th>
                  <th className="inv-col-size">Size</th>
                  <th className="inv-col-sku">SKU</th>
                  <th>Received</th>
                  {canEdit && <th aria-label="label" />}
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
                    {canEdit && <td>{boxBtn(r)}</td>}
                    <td>{resolveCtl(r)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {labels && <LabelSheet items={labels} mode="upc" onClose={() => setLabels(null)} />}
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

/* ------------------------- Rescale requests ---------------------------- */
const REQUEST_REASONS = [['mismatch', 'Mismatch'], ['quantity', 'Quantity mismatch'], ['recount', 'Recount'], ['returned', 'Returned'], ['relisting', 'Re-listing'], ['other', 'Other']];

// PH form: flag a SKU (sizes/qty, current price, reason) for the warehouse to
// recount / rescan. Lands in the warehouse Rescale Requests inbox.
function RescaleRequestForm({ onHome, onSignOut, backLabel = '← Home' }) {
  const [sku, setSku] = useState('');
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [reason, setReason] = useState('mismatch');
  const [reasonOther, setReasonOther] = useState('');
  const [note, setNote] = useState('');
  const [sizes, setSizes] = useState(() => [{ key: cartKey++, size: '', qty: 1 }]);
  const [busy, setBusy] = useState(false);
  const [lookupBusy, setLookupBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const dirty = !done && (sku.trim() || name.trim() || note.trim() || sizes.some((s) => String(s.size).trim()));
  useUnsavedGuard(!!dirty);

  // Look the SKU up and auto-fill the shoe name (KicksDB).
  async function lookupSku() {
    const s = sku.trim();
    if (!s) return;
    setLookupBusy(true); setError('');
    try {
      const { product } = await api.searchSku(s);
      if (product?.name) setName(product.name);
      if (product?.sku) setSku(product.sku);
    } catch (err) { if (err.unauthorized) return onSignOut(); setError(`Lookup failed: ${err.message}`); }
    finally { setLookupBusy(false); }
  }

  const addSize = () => setSizes((a) => [...a, { key: cartKey++, size: '', qty: 1 }]);
  const setSize = (k, patch) => setSizes((a) => a.map((s) => (s.key === k ? { ...s, ...patch } : s)));
  const removeSize = (k) => setSizes((a) => a.filter((s) => s.key !== k));

  async function submit() {
    setError('');
    if (!sku.trim()) { setError('Enter the SKU.'); return; }
    if (reason === 'other' && !reasonOther.trim()) { setError('Enter a custom reason.'); return; }
    const cleanSizes = sizes.filter((s) => String(s.size).trim()).map((s) => ({ size: String(s.size).trim(), qty: Math.max(1, Number(s.qty) || 1) }));
    if (!cleanSizes.length) { setError('Add at least one size + quantity.'); return; }
    setBusy(true);
    try {
      await api.rescaleRequestCreate({
        sku: sku.trim(), name: name.trim(), sizes: cleanSizes,
        price: price === '' ? null : Number(price),
        reason: reason === 'other' ? reasonOther.trim() : reason, note: note.trim(),
      });
      setDone(true);
    } catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setBusy(false); }
  }

  if (done) return (
    <div className="app">
      <TopBar title="Request Rescale" onHome={onHome} onSignOut={onSignOut} />
      <div className="card">
        <div className="modal-icon success">✓</div>
        <h3 className="modal-title">Rescale requested</h3>
        <p className="muted">The warehouse will see it in their <b>Rescale Requests</b> inbox.</p>
        <div className="modal-actions">
          <button className="btn primary" onClick={() => { setDone(false); setSku(''); setName(''); setPrice(''); setNote(''); setReason('mismatch'); setReasonOther(''); setSizes([{ key: cartKey++, size: '', qty: 1 }]); }}>New request</button>
          <button className="btn ghost" onClick={onHome}>{backLabel}</button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="app">
      <TopBar title="Request Rescale" onHome={onHome} onSignOut={onSignOut} />
      <div className="card">
        <h3 className="rows-title">Request a rescale</h3>
        <div className="batch-form">
          <label><span className="cap">SKU / Style *</span>
            <span className="searchrow">
              <input value={sku} onChange={(e) => setSku(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); lookupSku(); } }} autoCapitalize="characters" autoCorrect="off" placeholder="e.g. FV5104-004" />
              <button type="button" className="btn ghost" disabled={lookupBusy || !sku.trim()} onClick={lookupSku}>{lookupBusy ? '…' : 'Search'}</button>
            </span>
          </label>
          <label><span className="cap">Shoe name <span className="muted">(auto-fills from SKU)</span></span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Search a SKU to fill this" /></label>
          <label><span className="cap">Reason *</span>
            <select value={reason} onChange={(e) => setReason(e.target.value)}>
              {REQUEST_REASONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          {reason === 'other' && <label><span className="cap">Custom reason *</span><input value={reasonOther} maxLength={80} onChange={(e) => setReasonOther(e.target.value)} /></label>}
          <label><span className="cap">Current price ($)</span><input type="number" min="0" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} /></label>
          <label className="batch-form-wide"><span className="cap">Note <span className="muted">(optional)</span></span><input value={note} onChange={(e) => setNote(e.target.value)} /></label>
        </div>
        <div className="size-rows">
          <div className="muted sm">Sizes &amp; quantities *</div>
          {sizes.map((s) => (
            <div className="size-line" key={s.key}>
              <input className="sz" placeholder="Size" value={s.size} onChange={(e) => setSize(s.key, { size: e.target.value })} />
              <div className="qty-stepper">
                <button type="button" className="btn icon ghost step" onClick={() => setSize(s.key, { qty: Math.max(1, (Number(s.qty) || 1) - 1) })}>−</button>
                <input className="qty" type="number" min="1" value={s.qty} onChange={(e) => setSize(s.key, { qty: e.target.value })} />
                <button type="button" className="btn icon ghost step" onClick={() => setSize(s.key, { qty: (Number(s.qty) || 1) + 1 })}>+</button>
              </div>
              <button type="button" className="btn icon ghost remove" title="Remove" onClick={() => removeSize(s.key)}>×</button>
            </div>
          ))}
          <button type="button" className="btn sm ghost" onClick={addSize}>+ Add size</button>
        </div>
        {error && <div className="error mt">{error}</div>}
      </div>
      <div className="batch-bar">
        <button className="btn ghost" onClick={onHome}>{backLabel}</button>
        <button className="btn primary" disabled={busy} onClick={submit}>{busy ? 'Submitting…' : 'Submit request'}</button>
      </div>
    </div>
  );
}

const sumQty = (arr) => (Array.isArray(arr) ? arr : []).reduce((n, s) => n + (Number(s.qty) || 0), 0);

// Reported (top) vs actual-on-shelf (bottom) per size; discrepancies highlighted.
function RescaleCompare({ reported, actual }) {
  const sizes = [...new Set([...(reported || []).map((s) => String(s.size)), ...(actual || []).map((s) => String(s.size))])]
    .sort((a, b) => (sizeNum(a) - sizeNum(b)) || a.localeCompare(b));
  const rep = Object.fromEntries((reported || []).map((s) => [String(s.size), s.qty]));
  const act = actual ? Object.fromEntries(actual.map((s) => [String(s.size), s.qty])) : null;
  return (
    <table className="rcmp">
      <tbody>
        <tr className="rcmp-head"><td>Size →</td><>{sizes.map((s) => <td key={s}>{s}</td>)}</><td>Total</td></tr>
        <tr><td className="rcmp-lbl">Reported</td>{sizes.map((s) => <td key={s}>{rep[s] ?? '·'}</td>)}<td><b>{sumQty(reported)}</b></td></tr>
        <tr><td className="rcmp-lbl">Actual</td>{sizes.map((s) => {
          if (!act) return <td key={s} className="muted">—</td>;
          const a = act[s] ?? 0; const r = rep[s] ?? 0;
          return <td key={s} className={a !== r ? 'rcmp-diff' : 'rcmp-match'}>{a}</td>;
        })}<td>{act ? <b>{sumQty(actual)}</b> : <span className="muted">pending</span>}</td></tr>
      </tbody>
    </table>
  );
}

// Shared report of rescale requests — reported vs actual. Warehouse can audit
// (enter actual shelf counts); PH can view + create. Both see the comparison.
function RescaleRequestsReport({ canAudit, canCreate, onHome, onSignOut }) {
  const [mode, setMode] = useState('list'); // 'list' | 'new'
  const [requests, setRequests] = useState(null);
  const [error, setError] = useState('');
  const [statusF, setStatusF] = useState(canAudit ? 'open' : 'all');
  const [dr, setDr] = useState(() => ({ mode: 'day', anchor: new Date() }));
  const [auditId, setAuditId] = useState(null);
  const [auditRows, setAuditRows] = useState([]);
  const [auditNote, setAuditNote] = useState('');
  const [busyId, setBusyId] = useState(null);

  async function load() {
    setError('');
    try { const [from, to] = rangeOf(dr.mode, dr.anchor); const { requests: r } = await api.rescaleRequestList(statusF, from, to); setRequests(r); }
    catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
  }
  useEffect(() => { if (mode === 'list') load(); }, [dr, statusF, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  function startAudit(r) {
    setError(''); setAuditId(r.id);
    setAuditRows((r.sizes || []).map((s) => ({ key: cartKey++, size: String(s.size), qty: s.qty })));
    setAuditNote('');
  }
  const setAuditRow = (k, patch) => setAuditRows((a) => a.map((x) => (x.key === k ? { ...x, ...patch } : x)));
  const addAuditRow = () => setAuditRows((a) => [...a, { key: cartKey++, size: '', qty: 0 }]);
  const rmAuditRow = (k) => setAuditRows((a) => a.filter((x) => x.key !== k));

  async function submitAudit(r) {
    const actual = auditRows.filter((x) => String(x.size).trim()).map((x) => ({ size: String(x.size).trim(), qty: Math.max(0, Number(x.qty) || 0) }));
    if (!actual.length) { setError('Enter the actual count for at least one size.'); return; }
    setBusyId(r.id); setError('');
    try { await api.rescaleRequestAudit(r.id, actual, auditNote.trim()); setAuditId(null); load(); }
    catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setBusyId(null); }
  }

  if (mode === 'new') return <RescaleRequestForm onHome={() => setMode('list')} onSignOut={onSignOut} backLabel="← Requests" />;

  return (
    <div className="app app-wide">
      <TopBar title="Rescale Requests" onHome={onHome} onSignOut={onSignOut} />
      <div className="card">
        <p className="muted sm">{canAudit
          ? 'PH-flagged SKUs. Audit the shelf and enter the actual count per size — both teams then see reported vs actual.'
          : 'Track your rescale requests and the warehouse audit (reported vs actual on shelf).'}</p>
        <DateRangeBar mode={dr.mode} anchor={dr.anchor} onChange={(m, a) => setDr({ mode: m, anchor: a })}
          right={(
            <span className="ph-edit-actions">
              <span className="seg">
                {[['open', 'Open'], ['audited', 'Audited'], ['all', 'All']].map(([v, l]) =>
                  <button key={v} type="button" className={`seg-btn ${statusF === v ? 'on' : ''}`} onClick={() => setStatusF(v)}>{l}</button>)}
              </span>
              {canCreate && <button className="btn sm primary" onClick={() => setMode('new')}>+ New request</button>}
            </span>
          )} />
        {error && <div className="error mt">{error}</div>}
        {!requests ? <p className="muted">Loading…</p> : !requests.length ? <p className="muted">No requests in this range.</p> : (
          <div className="rc-list">
            {requests.map((r) => (
              <div className="rc-item" key={r.id}>
                <div className="rc-head">
                  <div>
                    <div className="rc-title">{r.name || r.sku}</div>
                    <div className="muted sm">{r.sku} · {r.reason}{r.price != null ? ` · $${Number(r.price).toFixed(2)}` : ''}</div>
                  </div>
                  <span className={`rc-pill ${r.status}`}>{r.status === 'audited' ? 'Audited' : 'Open'}</span>
                </div>
                <RescaleCompare reported={r.sizes} actual={r.actual_sizes} />
                {r.note ? <div className="muted sm">Request note: “{r.note}”</div> : null}
                {r.audit_note ? <div className="muted sm">Audit note: “{r.audit_note}”</div> : null}
                <div className="rc-foot muted sm">
                  Requested by {r.requested_by || '—'} · {new Date(r.created_at).toLocaleString()}
                  {r.status === 'audited' && r.resolved_by ? ` · audited by ${r.resolved_by}` : ''}
                </div>
                {canAudit && r.status === 'open' && (auditId === r.id ? (
                  <div className="rc-audit">
                    <div className="muted sm">Actual on shelf (per size):</div>
                    {auditRows.map((row) => (
                      <div className="size-line" key={row.key}>
                        <input className="sz" placeholder="Size" value={row.size} onChange={(e) => setAuditRow(row.key, { size: e.target.value })} />
                        <div className="qty-stepper">
                          <button type="button" className="btn icon ghost step" onClick={() => setAuditRow(row.key, { qty: Math.max(0, (Number(row.qty) || 0) - 1) })}>−</button>
                          <input className="qty" type="number" min="0" value={row.qty} onChange={(e) => setAuditRow(row.key, { qty: e.target.value })} />
                          <button type="button" className="btn icon ghost step" onClick={() => setAuditRow(row.key, { qty: (Number(row.qty) || 0) + 1 })}>+</button>
                        </div>
                        <button type="button" className="btn icon ghost remove" title="Remove" onClick={() => rmAuditRow(row.key)}>×</button>
                      </div>
                    ))}
                    <button type="button" className="btn sm ghost" onClick={addAuditRow}>+ Add size</button>
                    <input className="rc-auditnote" placeholder="Audit note (optional)" value={auditNote} onChange={(e) => setAuditNote(e.target.value)} />
                    <div className="ph-edit-actions">
                      <button className="btn sm primary" disabled={busyId === r.id} onClick={() => submitAudit(r)}>{busyId === r.id ? '…' : 'Submit audit'}</button>
                      <button className="btn sm ghost" onClick={() => setAuditId(null)}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <div className="rc-foot"><button className="btn sm primary" onClick={() => startAudit(r)}>🔍 Audit shelf</button></div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ----------------------------- VIN labels ------------------------------ */
// Barcode via jsbarcode (lazy-loaded). `format` defaults to CODE128 (our VIN);
// for product UPCs pass a retail format — falls back to CODE128 if the value
// doesn't satisfy that symbology (wrong length / bad check digit).
function Barcode({ value, format = 'CODE128', displayValue = false, height = 42 }) {
  const ref = useRef(null);
  useEffect(() => {
    let cancelled = false;
    import('jsbarcode').then(({ default: JsBarcode }) => {
      if (cancelled || !ref.current) return;
      const opts = { displayValue, height, width: 1.6, margin: 0, fontSize: 13 };
      try { JsBarcode(ref.current, value, { format, ...opts }); }
      catch {
        try { JsBarcode(ref.current, value, { format: 'CODE128', ...opts }); } catch { /* ignore */ }
      }
    });
    return () => { cancelled = true; };
  }, [value, format, displayValue, height]);
  return <svg ref={ref} className="barcode-svg" />;
}

// Pick the retail symbology for a product UPC by digit length.
const upcDigits = (u) => String(u || '').replace(/\D/g, '');
function upcFormat(u) {
  const d = upcDigits(u);
  if (d.length === 12) return 'UPC';
  if (d.length === 13) return 'EAN13';
  if (d.length === 8) return 'EAN8';
  return 'CODE128';
}

// Printable labels for label-printer rolls (Rollo / Dymo). Two types:
//  • VIN label  — our SBM- barcode (used to track every unit)
//  • UPC label  — the product's box-style barcode (name / size / colorway / SKU)
//    for NO-BOX shoes, recreating the manufacturer's box label so it scans like
//    a normal boxed pair downstream.
const LABEL_SIZES = {
  rollo: { w: 2.25, h: 1.25, label: 'Rollo 30256/30327 — 2.25 × 1.25"' },
  dymo: { w: 2.125, h: 1.125, label: 'Dymo 30334 — 2.125 × 1.125"' },
  box: { w: 3.14, h: 1.96, label: 'Box label — 3.14 × 1.96"' },
};

// `mode`: 'vin' (default — our SBM tracking label) or 'upc' (box-style label with
// the product UPC barcode, used only from the No Box page). Box-style matches the
// real shoe-box label: vertical UPC barcode on the left, text stacked on the right.
function LabelSheet({ items, onClose, mode = 'vin' }) {
  const list = items || [];
  const [size, setSize] = useState(mode === 'upc' ? 'box' : 'rollo');
  const s = LABEL_SIZES[size];
  return createPortal(
    <div className="label-overlay" style={{ '--lw': `${s.w}in`, '--lh': `${s.h}in` }}>
      <style>{`@media print { @page { size: ${s.w}in ${s.h}in; margin: 0; } }`}</style>
      <div className="label-toolbar no-print">
        <span>{list.length} {mode === 'upc' ? 'box' : 'VIN'} label(s)</span>
        <span className="label-tools">
          <select value={size} onChange={(e) => setSize(e.target.value)}>
            {Object.entries(LABEL_SIZES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          <button className="btn ghost sm" onClick={onClose}>Close</button>
          <button className="btn primary sm" onClick={() => window.print()}>🖨 Print</button>
        </span>
      </div>
      <div className="label-roll">
        {list.map((it) => (mode === 'upc' ? (
          upcDigits(it.upc) ? (
            // Box-style label: vertical UPC barcode (left) + text block (right).
            <div className="rlabel boxlabel" key={it.vin}>
              <div className="blabel-bc"><Barcode value={upcDigits(it.upc)} format={upcFormat(it.upc)} displayValue height={44} /></div>
              <div className="blabel-text">
                <div className="blabel-name">{(it.name || '—').toUpperCase()}</div>
                <div className="blabel-size">{it.size || '—'}</div>
                {it.colorway ? <div className="blabel-cw">{String(it.colorway).toUpperCase()}</div> : null}
                <div className="blabel-sku">{it.sku || '—'}</div>
              </div>
            </div>
          ) : (
            <div className="rlabel boxlabel missing" key={it.vin}>
              <div className="blabel-text">
                <div className="blabel-name">{(it.name || '—').toUpperCase()}</div>
                <div className="blabel-size">{it.size || '—'}</div>
                <div className="blabel-sku">{it.sku || '—'}</div>
                <div className="rlabel-vinlabel">No UPC on file — {it.vin}</div>
              </div>
            </div>
          )
        ) : (
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
        )))}
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
