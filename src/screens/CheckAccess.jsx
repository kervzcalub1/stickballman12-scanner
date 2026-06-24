// Admin account management: approve / reject, change role, delete.
import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { TopBar } from '../components/common.jsx';

export function CheckAccess({ onHome, onSignOut }) {
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
