// The email addresses a buyer purchases with (docs/context/receipts.md).
//
// A store emails the receipt to the address on the order. Our Make sweep reads our order
// mailboxes and files every receipt it finds; a receipt sent to one of these addresses is
// filed as that person's purchase. We can't know which address a supplier buys under
// unless they tell us — so they add it here, on their Buying Requests page.
//
// mode 'mine': your own addresses (anyone signed in, suppliers included).
// mode 'all':  admin — everyone's, and add one for any person.
import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useLive } from '../hooks.js';

export function PurchaseEmails({ mode = 'mine', onSignOut }) {
  const all = mode === 'all';
  const [emails, setEmails] = useState(null);
  const [people, setPeople] = useState([]);
  const [shared, setShared] = useState(false);
  const [email, setEmail] = useState('');
  const [who, setWho] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await api.purchaseEmails(all);
      setEmails(r.emails || []); setPeople(r.people || []); setShared(!!r.shared);
    } catch (e) { if (e.unauthorized) return onSignOut?.(); setError(e.message); }
  }, [all, onSignOut]);
  useEffect(() => { load(); }, [load]);
  useLive(['user_purchase_emails'], load, { mount: false });

  async function add(e) {
    e.preventDefault();
    setBusy(true); setError(''); setFlash('');
    try {
      const r = await api.addPurchaseEmail(email.trim(), all ? Number(who) || null : null);
      setEmail('');
      setFlash(r.claimed ? `Added — ${r.claimed} receipt${r.claimed === 1 ? '' : 's'} already sent to it ${r.claimed === 1 ? 'is' : 'are'} now filed under ${all ? 'them' : 'you'}.` : 'Added.');
      load();
    } catch (err) { if (err.unauthorized) return onSignOut?.(); setError(err.message); } finally { setBusy(false); }
  }
  async function remove(row) {
    if (!window.confirm(`Stop matching receipts sent to ${row.email}? Receipts already filed stay where they are.`)) return;
    try { await api.removePurchaseEmail(row.id); load(); } catch (err) { if (err.unauthorized) return onSignOut?.(); setError(err.message); }
  }

  if (shared && !all) return null;   // the shared env logins can't own an address
  return (
    <div className="card pe-card" role="region" aria-label="Purchase emails">
      <h3 className="rows-title">{all ? 'Purchase emails — who buys under which address' : 'Emails you buy with'}</h3>
      <p className="muted sm pe-lede">
        {all
          ? 'A receipt sent to one of these addresses is filed as that person’s purchase. One address belongs to one person.'
          : 'Add every email address you use on store accounts when you buy for us. When the store emails the receipt there, we file it under you automatically — no need to send it in.'}
      </p>
      {emails === null ? <p className="muted">Loading…</p> : !emails.length ? (
        <p className="muted sm">{all ? 'Nobody has added one yet.' : 'None yet.'}</p>
      ) : (
        <ul className="pe-list">
          {emails.map((row) => (
            <li key={row.id}>
              <code>{row.email}</code>
              {all && <span className="pe-who">{row.user_name}</span>}
              <button type="button" className="btn sm ghost" onClick={() => remove(row)} aria-label={`Remove ${row.email}`}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      <form className="pe-add" onSubmit={add}>
        {all && (
          <select value={who} onChange={(e) => setWho(e.target.value)} aria-label="Whose address" required>
            <option value="">Whose address…</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.role === 'ph_team' ? 'PH' : p.role})</option>)}
          </select>
        )}
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" aria-label="Email address" maxLength={254} required />
        <button type="submit" className="btn primary sm" disabled={busy || !email.trim() || (all && !who)}>{busy ? 'Adding…' : 'Add'}</button>
      </form>
      {flash && <p className="al-flash">{flash}</p>}
      {error && <div className="error sm">{error}</div>}
    </div>
  );
}
