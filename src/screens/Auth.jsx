// Sign-in / create-account screen (shown when there's no authenticated user).
import React, { useState } from 'react';
import { api, setToken, setUser } from '../api.js';
import { Icon } from '../components/NavIcons.jsx';

// The supplier scan-out portal lives on the `supplier.` subdomain; staff (admin /
// warehouse / PH) sign in on the main domain. The subtitle reflects which one.
const IS_SUPPLIER_HOST = typeof window !== 'undefined' && /^supplier\./i.test(window.location.hostname);
const APP_SUBTITLE = IS_SUPPLIER_HOST ? 'Supplier' : 'Inventory';

// Password field with a show/hide eye toggle. Forwards any input props
// (placeholder, autoComplete, value, onChange…) to the underlying <input>.
function PasswordInput(props) {
  const [show, setShow] = useState(false);
  return (
    <div className="password-field">
      <input {...props} type={show ? 'text' : 'password'} />
      <button type="button" className="password-toggle" onClick={() => setShow((s) => !s)}
        aria-label={show ? 'Hide password' : 'Show password'} aria-pressed={show} tabIndex={-1}>
        <Icon name={show ? 'eye-off' : 'eye'} />
      </button>
    </div>
  );
}

export function Auth({ onAuthed }) {
  const [tab, setTab] = useState('login'); // 'login' | 'signup'
  return (
    <div className="app center">
      <div className="card login">
        <img className="app-logo" src="/logo.png" alt="Stickballman12 logo" />
        <h1>Stickballman12</h1>
        <p className="muted">{APP_SUBTITLE}</p>
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
      <PasswordInput placeholder="Password" autoComplete="current-password" value={password} onChange={(e) => setP(e.target.value)} />
      {error && <div className="error">{error}</div>}
      <button className="btn primary wide" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
    </form>
  );
}

function SignupForm({ onDone }) {
  // On the supplier subdomain, self-signups are always suppliers (the server
  // enforces this too by Host) — hide the staff role picker.
  const supplierHost = IS_SUPPLIER_HOST;
  const [name, setName] = useState('');
  const [username, setU] = useState('');
  const [password, setP] = useState('');
  const [role, setRole] = useState(supplierHost ? 'supplier' : 'warehouse');
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
      <PasswordInput placeholder="Password (min 8 chars)" autoComplete="new-password" value={password} onChange={(e) => setP(e.target.value)} />
      {supplierHost ? (
        <p className="muted sm signup-supplier-note">Creating a <b>Supplier</b> account. An admin will approve it before you can sign in.</p>
      ) : (
        <label className="signup-role">Role
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="warehouse">Warehouse — receiving &amp; inventory</option>
            <option value="ph_team">PH Team — report only</option>
          </select>
        </label>
      )}
      {error && <div className="error">{error}</div>}
      <button className="btn primary wide" disabled={busy}>{busy ? 'Creating…' : 'Create account'}</button>
    </form>
  );
}
