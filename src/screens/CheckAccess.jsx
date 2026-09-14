// Admin account management: approve / reject, change role, set PRIVILEGES, delete.
//
// Role and privileges are two different questions and the screen asks them separately.
// A role is the one job somebody does — warehouse, PH, admin, or an external buyer. A
// privilege is a permission on top of it: the gift-card duties belong to a PH team
// member or an admin who ALSO does that, never instead of it, which is why they are
// checkboxes beside the role rather than more entries inside it.
import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { TopBar, Modal, CopyText, FormModal } from '../components/common.jsx';
import { STAFF_PRIVILEGES, BUYER_PRIVILEGES, isAdminRole } from '../lib/constants.js';
import { useMediaQuery } from '../hooks.js';

export function CheckAccess({ onHome, onSignOut }) {
  const [users, setUsers] = useState(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [confirm, setConfirm] = useState(null); // { u, action: 'reject' | 'delete' } | null
  const [tempPw, setTempPw] = useState(null);    // { u, password } — shown once after a reset
  const [linking, setLinking] = useState(null);  // the user whose Telegram id is being asked for
  const [waiting, setWaiting] = useState([]);    // Telegram accounts that tapped and aren't linked
  const isMobile = useMediaQuery('(max-width: 600px)');

  async function load() {
    setError('');
    try {
      const { users, telegramWaiting } = await api.adminListUsers();
      setUsers(users); setWaiting(telegramWaiting || []);
    }
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
  async function setTelegram(u, telegramUserId) {
    setBusyId(u.id); setError(''); setLinking(null);
    try { await api.adminSetTelegram(u.id, telegramUserId); await load(); }
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
  // ticking boxes for one would be theatre — it says why instead of rendering dead
  // checkboxes. A SUPPLIER is an external buyer and is offered exactly one: "Raise
  // buying requests", which switches the buying screens on for that account.
  // Which Telegram account may tap this person's decisions into the system. A button in
  // a group chat is not an identity — everybody in the group can press one — so a tap is
  // only recorded once the number that pressed it is tied to somebody here.
  const Telegram = ({ u }) => {
    if (u.role === 'supplier') return <span className="muted sm">Buyers don’t approve anything</span>;
    const held = u.telegram_user_id ? String(u.telegram_user_id) : '';
    return (
      <div className="tg-link">
        {held ? (
          <>
            <span className="tg-id mono">{held}</span>
            <button type="button" className="btn sm ghost" disabled={busyId === u.id}
              onClick={() => setTelegram(u, '')}>Unlink</button>
          </>
        ) : (
          <button type="button" className="btn sm ghost" disabled={busyId === u.id}
            onClick={() => setLinking(u)}>Link Telegram</button>
        )}
      </div>
    );
  };

  const Privileges = ({ u }) => {
    if (isAdminRole(u.role)) return <span className="muted sm">Admin — holds all privileges</span>;
    const held = Array.isArray(u.privileges) ? u.privileges : [];
    // A supplier gets exactly one box: whether they buy for the company at all. The
    // staff duties never appear for them — a buyer approving their own request is the
    // thing the process exists to prevent, and the server strips them regardless.
    const offered = u.role === 'supplier' ? BUYER_PRIVILEGES : STAFF_PRIVILEGES;
    const both = held.includes('approve_buying') && held.includes('audit_buying');
    return (
      <div className="priv-group">
        {offered.map((p) => (
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
                  <div className="dcard-line priv-line"><span className="muted sm">Telegram</span><Telegram u={u} /></div>
                  <div className="dcard-actions"><Actions u={u} /></div>
                </div>
              ))}
            </div>
          ) : (
            <div className="hscroll">
              <table className="access-table">
                <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Privileges</th><th>Telegram</th><th>Status</th><th aria-label="actions" /></tr></thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id}>
                      <td>{u.name}</td>
                      <td>{u.username}</td>
                      <td><RoleSelect u={u} /></td>
                      <td><Privileges u={u} /></td>
                      <td><Telegram u={u} /></td>
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

      {/* Telegram accounts that have tapped an approval and belong to nobody here yet.
          The number is captured on the first tap because nobody can read their own
          numeric Telegram id off their phone — without this the refusal was a dead end
          for the tapper AND the admin. Linking one makes the row disappear. */}
      {waiting.length > 0 && (
        <section className="card tg-waiting">
          <h3 className="tg-waiting-h">
            Telegram accounts waiting to be linked
            <span className="muted sm">{waiting.length}</span>
          </h3>
          <p className="muted sm">
            These tapped an approval in the group and could not be recorded, because a decision
            has to name a person. Point each one at an account and the next tap goes through.
          </p>
          <ul className="tg-waiting-list">
            {waiting.map((w) => (
              <li key={w.telegram_user_id}>
                <span className="tg-who">
                  <b>{w.name || 'Unnamed'}</b>
                  {w.username && <span className="muted sm"> @{w.username}</span>}
                  <span className="tg-id mono"> {w.telegram_user_id}</span>
                </span>
                <span className="muted xs">
                  {w.taps} tap{Number(w.taps) === 1 ? '' : 's'}
                </span>
                <select className="input sm" defaultValue="" disabled={!!busyId}
                  aria-label={`Link Telegram ${w.telegram_user_id} to an account`}
                  onChange={(e) => {
                    const uid = Number(e.target.value);
                    const u = (users || []).find((x) => Number(x.id) === uid);
                    if (u) setTelegram(u, String(w.telegram_user_id));
                  }}>
                  <option value="" disabled>Link to…</option>
                  {(users || []).filter((u) => u.role !== 'supplier' && !u.telegram_user_id)
                    .map((u) => <option key={u.id} value={u.id}>{u.name} ({u.username})</option>)}
                </select>
              </li>
            ))}
          </ul>
        </section>
      )}

      {linking && (
        <FormModal
          title={`Link ${linking.name || linking.username} to Telegram`}
          message="Their numeric Telegram id — @userinfobot in Telegram replies with it. A tap on an approval card is only recorded once the account that pressed it is tied to somebody here."
          submitLabel="Link it"
          onClose={() => setLinking(null)}
          onSubmit={({ telegramUserId }) => setTelegram(linking, String(telegramUserId || '').trim())}
          fields={[{
            name: 'telegramUserId', label: 'Telegram user id', type: 'number', required: true,
            placeholder: '123456789',
            hint: 'Not the @username — the number. It appears in the refusal message if they have already tried tapping.',
          }]} />
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
