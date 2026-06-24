// Sign-in / create-account screen (shown when there's no authenticated user).
import React, { useState } from 'react';
import { api, setToken, setUser } from '../api.js';

export function Auth({ onAuthed }) {
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
