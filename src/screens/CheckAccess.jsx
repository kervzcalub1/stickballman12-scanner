// Admin account management: approve / reject, change role, set PRIVILEGES, delete.
//
// Role and privileges are two different questions and the screen asks them separately.
// A role is the one job somebody does — warehouse, PH, admin, or an external buyer. A
// privilege is a permission on top of it: the gift-card duties belong to a PH team
// member or an admin who ALSO does that, never instead of it, which is why they are
// checkboxes beside the role rather than more entries inside it.
import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { TopBar, Modal, CopyText } from '../components/common.jsx';
import { PRIVILEGES, isAdminRole } from '../lib/constants.js';
import { useMediaQuery } from '../hooks.js';

export function CheckAccess({ onHome, onSignOut }) {
  const [users, setUsers] = useState(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [confirm, setConfirm] = useState(null); // { u, action: 'reject' | 'delete' } | null
  const [tempPw, setTempPw] = useState(null);    // { u, password } — shown once after a reset
  const isMobile = useMediaQuery('(max-width: 600px)');

  async function load() {
    setError('');
    try { const { users } = await api.adminListUsers(); setUsers(users); }
    catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
  }
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function review(id, decision) {
    setBusyId(id); setConfirm(null);
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
  async function togglePriv(u, key) {
    const held = Array.isArray(u.privileges) ? u.privileges : [];
    const next = held.includes(key) ? held.filter((k) => k !== key) : [...held, key];
    setBusyId(u.id); setError('');
    try {
      const { note } = await api.adminSetPrivileges(u.id, next);
      if (note) setError(note);
      await load();
    } catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setBusyId(null); }
  }

  async function remove(id) {
    setBusyId(id); setConfirm(null);
    try { await api.adminDeleteUser(id); await load(); }
    catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setBusyId(null); }
  }
  async function resetPassword(u) {
    setBusyId(u.id); setError('');
    try { const { tempPassword } = await api.adminResetPassword(u.id); setTempPw({ u, password: tempPassword }); }
    catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setBusyId(null); }
  }

  const RoleSelect = ({ u }) => (
    <select className="role-select" value={u.role} disabled={busyId === u.id} onChange={(e) => changeRole(u.id, e.target.value)}>
      <option value="warehouse">Warehouse</option>
      <option value="ph_team">PH Team</option>
      <option value="supplier">Supplier (buyer)</option>
      <option value="admin">Admin</option>
    </select>
  );
  // An ADMIN already holds every privilege implicitly (the server's isPrivileged), so
  // ticking boxes for one would be theatre. A SUPPLIER is an external buyer and can hold
  // none — a buyer with the approve privilege would sign off their own request, which is
  // the one thing this whole process exists to prevent. Both say why instead of
  // rendering dead checkboxes.
  const Privileges = ({ u }) => {
    if (isAdminRole(u.role)) return <span className="muted sm">Admin — holds all privileges</span>;
    if (u.role === 'supplier') return <span className="muted sm">Buyer — holds none, by design</span>;
    const held = Array.isArray(u.privileges) ? u.privileges : [];
    const both = held.includes('approve_buying') && held.includes('audit_buying');
    return (
      <div className="priv-group">
        {PRIVILEGES.map((p) => (
          <label className="priv" key={p.key} title={p.hint}>
            <input type="checkbox" checked={held.includes(p.key)} disabled={busyId === u.id}
              onChange={() => togglePriv(u, p.key)} />
            <span>{p.label}</span>
          </label>
        ))}
        {both && (
          // Allowed, and worth saying out loud: holding both is fine, but the server
          // still refuses to let anyone audit a request THEY approved.
          <span className="priv-note">Holds approve and audit — they still can’t audit a request they approved.</span>
        )}
      </div>
    );
  };

  const Actions = ({ u }) => (
    <>
      {u.status !== 'approved' && <button className="btn sm primary" disabled={busyId === u.id} onClick={() => review(u.id, 'approve')}>Approve</button>}
      {u.status !== 'rejected' && <button className="btn sm ghost" disabled={busyId === u.id} onClick={() => setConfirm({ u, action: 'reject' })}>Reject</button>}
      <button className="btn sm ghost" disabled={busyId === u.id} onClick={() => setConfirm({ u, action: 'reset' })}>Reset password</button>
      <button className="btn sm danger" disabled={busyId === u.id} onClick={() => setConfirm({ u, action: 'delete' })}>Delete</button>
    </>
  );

  return (
    <div className="app">
      <TopBar title="Check Access" onHome={onHome} onSignOut={onSignOut} />
      {error && <div className="error mt">{error}</div>}
      {!users ? <p className="muted">Loading…</p> : (
        <div className="card">
          {users.length === 0 ? <p className="muted">No accounts yet.</p> : isMobile ? (
            <div className="access-cards">
              {users.map((u) => (
                <div className="dcard" key={u.id}>
                  <div className="dcard-top">
                    <span><b>{u.name}</b> <span className="muted sm">{u.username}</span></span>
                    <span className="dcard-pills">
                      {u.reset_requested_at && <span className="reset-req-pill" title="This user asked for a password reset">reset requested</span>}
                      {u.must_change_password && <span className="reset-req-pill pending" title="A temp password was issued; awaiting the user’s change">temp issued</span>}
                      <span className={`status-pill ${u.status}`}>{u.status}</span>
                    </span>
                  </div>
                  <label className="dcard-line">Role <RoleSelect u={u} /></label>
                  <div className="dcard-line priv-line"><span className="muted sm">Privileges</span><Privileges u={u} /></div>
                  <div className="dcard-actions"><Actions u={u} /></div>
                </div>
              ))}
            </div>
          ) : (
            <div className="hscroll">
              <table className="access-table">
                <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Privileges</th><th>Status</th><th aria-label="actions" /></tr></thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id}>
                      <td>{u.name}</td>
                      <td>{u.username}</td>
                      <td><RoleSelect u={u} /></td>
                      <td><Privileges u={u} /></td>
                      <td>
                        <span className={`status-pill ${u.status}`}>{u.status}</span>
                        {u.reset_requested_at && <span className="reset-req-pill" title="This user asked for a password reset">reset requested</span>}
                        {u.must_change_password && <span className="reset-req-pill pending" title="A temp password was issued; awaiting the user’s change">temp issued</span>}
                      </td>
                      <td className="access-actions"><Actions u={u} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {confirm && (
        <Modal
          type={confirm.action === 'delete' ? 'error' : 'warn'}
          title={confirm.action === 'delete' ? `Delete "${confirm.u.username}"?`
            : confirm.action === 'reset' ? `Reset password for "${confirm.u.username}"?`
            : `Reject "${confirm.u.username}"?`}
          message={confirm.action === 'delete'
            ? 'This permanently removes the account and cannot be undone.'
            : confirm.action === 'reset'
            ? 'Generates a new temporary password and replaces the current one. It’s shown once — copy it and relay it to the user. They’ll be required to set their own new password the next time they sign in.'
            : 'This blocks the account from signing in until you approve it.'}
          onClose={() => setConfirm(null)}>
          {confirm.action === 'delete'
            ? <button className="btn danger" onClick={() => remove(confirm.u.id)}>Delete account</button>
            : confirm.action === 'reset'
            ? <button className="btn primary" onClick={() => { const u = confirm.u; setConfirm(null); resetPassword(u); }}>Reset password</button>
            : <button className="btn primary" onClick={() => review(confirm.u.id, 'reject')}>Reject</button>}
          <button className="btn ghost" onClick={() => setConfirm(null)}>Cancel</button>
        </Modal>
      )}

      {tempPw && (
        <Modal
          type="success"
          title={`Temporary password for "${tempPw.u.username}"`}
          message="Shown only once. Copy it now and relay it to the user — they sign in with it, then must set their own new password before using the app."
          onClose={() => setTempPw(null)}>
          <div className="temp-pw-box">
            <CopyText text={tempPw.password} className="temp-pw-value" title="Copy password">
              <code>{tempPw.password}</code>
            </CopyText>
          </div>
          <button className="btn primary" onClick={() => setTempPw(null)}>Done</button>
        </Modal>
      )}
    </div>
  );
}
