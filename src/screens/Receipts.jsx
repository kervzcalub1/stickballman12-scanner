// Receipts — every store receipt found in our order mailboxes (docs/context/receipts.md).
//
// "Check mailboxes" (MailboxCheck below) has Make fetch the mail since the last check and
// our server parses and files each receipt — spam folders included — with where it was bought (the store's address, city, state, ZIP off the
// receipt) and who bought it (the address it was sent to, matched against the emails
// buyers registered). So nobody has to wait for Joey to send his receipts in, and
// Council's buys can be told from Joey's by store and state.
// A receipt whose order number is on a buying request links to it.
import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { TopBar } from '../components/common.jsx';
import { PurchaseEmails } from '../components/PurchaseEmails.jsx';
import { useLive } from '../hooks.js';
import { useQueryParam } from '../lib/urlstate.js';
import { PH_DATE, PH_DATETIME, estToday } from '../lib/format.js';

const money = (v) => (v == null ? '—' : `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const when = (ts) => (ts ? `${PH_DATETIME.format(new Date(ts))} EST` : '—');
const STORE_LABEL = { footlocker: 'Foot Locker', kidsfootlocker: 'Kids Foot Locker', champs: 'Champs Sports', nike: 'Nike', adidas: 'adidas' };
const storeLabel = (s) => STORE_LABEL[s] || s || 'Unknown store';
const inSpam = (folder) => /spam|bulk|junk/i.test(String(folder || ''));
// "Check mailboxes" — the sweep runs only when someone asks (api/receipts/sweep.js). It
// looks at the mail since the last check (minus an hour of overlap); "From a date…" goes
// further back for a catch-up. Make fetches in the background and each receipt appears in
// the list as it is filed (live), so the button only has to say it started.
function MailboxCheck({ onSignOut }) {
  const [st, setSt] = useState(null);       // { configured, last: { at, since, by } }
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [pickDate, setPickDate] = useState(false);
  const [since, setSince] = useState('');
  async function read() {
    try { setSt(await api.receiptSweepStatus()); } catch (e) { if (e.unauthorized) onSignOut(); }
  }
  useEffect(() => { read(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useLive(['app_settings'], read, { mount: false });
  async function run() {
    setBusy(true); setErr(''); setMsg('');
    try {
      const r = await api.receiptSweep(pickDate && since ? { since } : {});
      setMsg(`Checking mail since ${when(r.since)} — receipts appear below as they're filed (usually within a few minutes).`);
      setPickDate(false); setSince('');
      read();
    } catch (e) { if (e.unauthorized) return onSignOut(); setErr(e.message); }
    finally { setBusy(false); }
  }
  if (st && !st.configured) return null;
  const last = st?.last;
  return (
    <div className="rc-check">
      <button type="button" className="btn sm primary" disabled={busy || !st || (pickDate && !since)} onClick={run}>
        {busy ? 'Starting…' : pickDate ? 'Check from this date' : '↻ Check mailboxes'}
      </button>
      {pickDate ? (
        <>
          <input type="date" value={since} max={estToday()} onChange={(e) => setSince(e.target.value)} aria-label="Check mail since" />
          <button type="button" className="btn sm ghost" onClick={() => { setPickDate(false); setSince(''); }}>Cancel</button>
        </>
      ) : (
        <button type="button" className="btn sm ghost" onClick={() => setPickDate(true)}
          title="Look further back than the last check — for receipts that came in while nobody checked">
          From a date…
        </button>
      )}
      <span className="muted sm">
        {last ? `Last checked ${when(last.at)}${last.by ? ` by ${last.by}` : ''}` : 'Never checked — the first check looks at the last 3 days.'}
      </span>
      {msg && <div className="notice sm rc-check-msg">{msg}</div>}
      {err && <div className="error sm rc-check-msg">{err}</div>}
    </div>
  );
}

const place = (r) => [r.city, [r.state, r.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');

export function Receipts({ user, onHome, onSignOut, cartHref = (id) => `/buy-carts?request=${id}` }) {
  const isAdmin = user?.role === 'admin' || user?.role === 'superadmin';
  const [buyer, setBuyer] = useQueryParam('buyer', '');
  const [store, setStore] = useQueryParam('store', '');
  const [state, setState] = useQueryParam('state', '');
  const [from, setFrom] = useQueryParam('from', '');
  const [to, setTo] = useQueryParam('to', '');
  const [q, setQ] = useQueryParam('q', '');
  const [openId, setOpenId] = useQueryParam('r', '');
  const [showEmails, setShowEmails] = useQueryParam('emails', '');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  async function load() {
    try { setData(await api.receipts({ buyer, store, state, from, to, q: q.trim() })); setError(''); }
    catch (e) { if (e.unauthorized) return onSignOut(); setError(e.message); }
  }
  useEffect(() => { const t = setTimeout(load, q ? 300 : 0); return () => clearTimeout(t); }, [buyer, store, state, from, to, q]); // eslint-disable-line react-hooks/exhaustive-deps
  useLive(['email_receipts', 'user_purchase_emails'], load, { mount: false });

  const rows = data?.rows || [];
  const shownTotal = rows.reduce((n, r) => n + (Number(r.total) || 0), 0);
  return (
    <div className="app rc-page">
      <TopBar title="Receipts" onHome={onHome} onSignOut={onSignOut}
        right={isAdmin ? <button type="button" className="btn sm ghost" onClick={() => setShowEmails(showEmails ? '' : '1')}>{showEmails ? 'Hide purchase emails' : 'Purchase emails'}</button> : null} />
      {isAdmin && showEmails && <PurchaseEmails mode="all" onSignOut={onSignOut} />}
      <div className="card">
        <p className="muted sm rc-lede">
          Store receipts found in our order mailboxes (spam included), filed automatically. The buyer is matched by the
          address the receipt was sent to — buyers add theirs on their Buying Requests page.
        </p>
        <MailboxCheck onSignOut={onSignOut} />
        {(data?.byBuyer || []).length > 0 && (
          <div className="rc-buyers" role="group" aria-label="By buyer">
            <button type="button" className={`rc-chip ${!buyer ? 'on' : ''}`} onClick={() => setBuyer('')}>Everyone</button>
            {data.byBuyer.map((b) => {
              const key = b.buyer_user_id == null ? 'none' : String(b.buyer_user_id);
              return (
                <button key={key} type="button" className={`rc-chip ${buyer === key ? 'on' : ''}`} onClick={() => setBuyer(buyer === key ? '' : key)}>
                  {b.name} <b>{b.receipts}</b> <span className="muted">· {money(b.total)}</span>
                </button>
              );
            })}
          </div>
        )}
        <div className="rc-filters">
          <select value={store} onChange={(e) => setStore(e.target.value)} aria-label="Store">
            <option value="">All stores</option>
            {(data?.stores || []).map((s) => <option key={s} value={s}>{storeLabel(s)}</option>)}
          </select>
          <select value={state} onChange={(e) => setState(e.target.value)} aria-label="State">
            <option value="">All states</option>
            {(data?.states || []).map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <label className="rc-date"><span className="muted xs">From</span><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="rc-date"><span className="muted xs">To</span><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          <input className="input rc-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Order #, store, city or email" aria-label="Search receipts" />
        </div>
        {error && <div className="error mt">{error}</div>}
      </div>

      <div className="card">
        {!data ? <p className="muted">Loading…</p> : !rows.length ? (
          <p className="muted">No receipts{buyer || store || state || from || to || q ? ' match these filters' : ' yet — press “Check mailboxes” above to look for new ones'}.</p>
        ) : (
          <>
            <p className="muted sm">{rows.length} receipt{rows.length === 1 ? '' : 's'} · {money(shownTotal)}</p>
            <table className="rc-table">
              <thead><tr><th>Received</th><th>Store</th><th>Order #</th><th>Buyer</th><th>Pairs</th><th>Total</th><th>Request</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="rc-row" onClick={() => setOpenId(String(r.id), { replace: false })}>
                    <td data-label="Received">{when(r.received_at)}{inSpam(r.folder) ? <span className="rc-spam" title={`Found in ${r.folder}`}>spam</span> : null}</td>
                    <td data-label="Store"><b>{r.store_name || storeLabel(r.store)}</b>{place(r) ? <div className="muted xs">{place(r)}</div> : <div className="muted xs">no location on the receipt</div>}</td>
                    <td data-label="Order #">{r.order_number || '—'}</td>
                    <td data-label="Buyer">{r.buyer_name || <span className="rc-unassigned">Unassigned</span>}</td>
                    <td data-label="Pairs">{r.pairs || '—'}</td>
                    <td data-label="Total">{money(r.total)}</td>
                    <td data-label="Request">{r.cart_id ? <a href={cartHref(r.cart_id)} onClick={(e) => e.stopPropagation()}>{r.cart_code}</a> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>

      {openId && <ReceiptDetail id={openId} isAdmin={isAdmin} onClose={() => setOpenId('')} onSignOut={onSignOut} onChanged={load} />}
    </div>
  );
}

function ReceiptDetail({ id, isAdmin, onClose, onSignOut, onChanged }) {
  const [r, setR] = useState(null);
  const [people, setPeople] = useState([]);
  const [error, setError] = useState('');
  const [showText, setShowText] = useState(false);
  useEffect(() => {
    api.receipt(id).then((x) => setR(x.receipt)).catch((e) => { if (e.unauthorized) return onSignOut(); setError(e.message); });
    if (isAdmin) api.purchaseEmails(true).then((x) => setPeople(x.people || [])).catch(() => {});
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function assign(userId) {
    try { await api.assignReceipt(r.id, userId ? Number(userId) : null); setR((x) => ({ ...x, buyer_user_id: userId ? Number(userId) : null, buyer_source: userId ? 'manual' : null, buyer_name: people.find((p) => String(p.id) === String(userId))?.name || null })); onChanged(); }
    catch (e) { if (e.unauthorized) return onSignOut(); setError(e.message); }
  }

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const rc = r?.recipients || {};
  const sentTo = [...(rc.to || []), ...(rc.cc || []), rc.original_to].filter(Boolean);
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal rc-modal" role="dialog" aria-modal="true" aria-label="Receipt" onClick={(e) => e.stopPropagation()}>
      <h3 className="modal-title">{r ? `${r.store_name || storeLabel(r.store)}${r.order_number ? ` · #${r.order_number}` : ''}` : 'Receipt'}</h3>
      {!r ? <p className="muted">{error || 'Loading…'}</p> : (
        <div className="rc-detail">
          <dl className="rc-facts">
            <div><dt>Received</dt><dd>{when(r.received_at)}{inSpam(r.folder) ? ' · found in spam' : ''}</dd></div>
            <div><dt>Store</dt><dd>{[r.store_name || storeLabel(r.store), r.store_number ? `#${r.store_number}` : null].filter(Boolean).join(' ')}{r.address ? <div>{r.address}</div> : null}{place(r) ? <div>{place(r)}</div> : null}</dd></div>
            <div><dt>Sent to</dt><dd>{sentTo.length ? sentTo.join(', ') : '—'}</dd></div>
            <div><dt>Buyer</dt><dd>
              {isAdmin ? (
                <select value={r.buyer_user_id || ''} onChange={(e) => assign(e.target.value)} aria-label="Buyer">
                  <option value="">Unassigned</option>
                  {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              ) : (r.buyer_name || 'Unassigned')}
              {r.buyer_source === 'email' ? <span className="muted xs"> · matched by email</span> : r.buyer_source === 'manual' ? <span className="muted xs"> · set by {r.assigned_by}</span> : null}
            </dd></div>
            <div><dt>Mailbox</dt><dd className="muted sm">{[r.mailbox, r.folder].filter(Boolean).join(' · ')}</dd></div>
          </dl>
          <table className="rc-items">
            <thead><tr><th>Item</th><th>Size</th><th>Qty</th><th>Line total</th></tr></thead>
            <tbody>
              {(r.items || []).length ? r.items.map((it, i) => (
                <tr key={i}><td>{it.name || '—'}{(it.style_id || it.sku) ? <div className="muted xs">{it.style_id || it.sku}</div> : null}</td><td>{it.size || '—'}</td><td>{it.qty}</td><td>{money(it.final_price)}</td></tr>
              )) : <tr><td colSpan={4} className="muted">The parser found no item lines — the email text below is the receipt.</td></tr>}
            </tbody>
          </table>
          <div className="rc-totals">
            <span>Subtotal {money(r.subtotal)}</span><span>Tax {money(r.tax)}</span><span>Shipping {money(r.shipping)}</span><b>Total {money(r.total)}</b>
          </div>
          {(r.warnings || []).length > 0 && <p className="notice sm">Parser notes: {r.warnings.join(', ')}</p>}
          {r.body_text && (
            <>
              <button type="button" className="btn sm ghost" onClick={() => setShowText((v) => !v)}>{showText ? 'Hide the email' : 'Show the email'}</button>
              {showText && <pre className="rc-text">{r.body_text}</pre>}
            </>
          )}
          {error && <div className="error sm">{error}</div>}
        </div>
      )}
      <div className="modal-actions"><button type="button" className="btn ghost" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}
