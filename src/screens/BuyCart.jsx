// One gift-card buying request, from "what are you buying?" to CLOSED / RECONCILED.
//
// ONE screen for four jobs, not four screens. The buyer, the approver, the gift card
// desk and the auditor are all looking at the same transaction, and the thing that
// matters most about it — what happened, in order, and what is still outstanding — is
// the same for all of them. What changes per role is which buttons exist, and that is
// decided by the server on every write regardless of what this file renders.
//
// The ten conditions come from the server (`cart.checks`) rather than being worked out
// here, so the list a person reads is byte-for-byte the list `cart/close` will enforce.
// A gate that lives in the UI is a gate a stale tab walks straight through.
import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { TopBar, PriceInput } from '../components/common.jsx';
import { BuyCartAdd, VerdictChip } from '../components/BuyCartAdd.jsx';
import { BuyCartGiftCards } from '../components/BuyCartGiftCards.jsx';
import { BuyCartReceipt } from '../components/BuyCartReceipt.jsx';
import { estDate, estTime } from '../lib/format.js';

const money = (n) => (n == null ? '—' : `$${(Number(n) || 0).toFixed(2)}`);

// The request's own state, in the words of the process rather than the column value.
const STATUS = {
  draft: { label: 'Being written', cls: 'draft' },
  submitted: { label: 'Waiting on approval', cls: 'warn' },
  approved: { label: 'Approved — needs gift cards', cls: 'shipped' },
  denied: { label: 'Denied', cls: 'muted' },
  funded: { label: 'Cards released — waiting on the receipt', cls: 'shipped' },
  receipted: { label: 'Receipt in — needs auditing', cls: 'warn' },
  audited: { label: 'Audited — waiting on the shipment', cls: 'shipped' },
  closed: { label: 'Closed / reconciled', cls: 'ok' },
  cancelled: { label: 'Cancelled', cls: 'muted' },
};

function StatusChip({ status }) {
  const s = STATUS[status] || { label: status, cls: 'muted' };
  return <span className={`po-chip ${s.cls}`}>{s.label}</span>;
}

// The closing checklist. Rendered whatever the state, because the useful question on
// day one is "what is this still waiting on", not only on the last day.
function Checks({ checks }) {
  if (!checks?.length) return null;
  const done = checks.filter((c) => c.ok).length;
  return (
    <section className="card bc-checks">
      <h3 className="bc-h">
        Closing conditions <span className="muted sm">{done} of {checks.length}</span>
      </h3>
      <ul className="bc-check-list">
        {checks.map((c) => (
          <li key={c.key} className={c.ok ? 'ok' : ''}>
            <span className="bc-check-mark" aria-hidden="true">{c.ok ? '✓' : '○'}</span>
            <span className="bc-check-label">{c.label}</span>
            {c.detail && <span className="bc-check-detail muted sm">{c.detail}</span>}
          </li>
        ))}
      </ul>
      {done < checks.length && (
        <p className="muted sm">
          A transaction isn’t finished because the cards were spent. It’s finished when every
          line above is true.
        </p>
      )}
    </section>
  );
}

function Lines({ cart, canDecide, isBuyer, onChanged, onSignOut }) {
  const [sel, setSel] = useState([]);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const lines = cart.lines || [];
  const pending = lines.filter((l) => l.status === 'pending');
  const editable = isBuyer && cart.status === 'draft';

  const toggle = (id) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  async function decide(action, all) {
    const reason = action === 'reject'
      ? window.prompt(all ? 'Why are these being turned down?' : 'Why is this being turned down?')
      : null;
    if (action === 'reject' && reason === null) return;
    setBusy(action); setErr('');
    try {
      await api.cartDecide(cart.id, all ? { action, all: true, reason } : { action, lineIds: sel, reason });
      setSel([]); onChanged();
    } catch (e) { if (e.unauthorized) return onSignOut(); setErr(e.message); }
    finally { setBusy(''); }
  }

  async function remove(id) {
    setBusy('rm'); setErr('');
    try { await api.cartRemoveLine(cart.id, id); onChanged(); }
    catch (e) { if (e.unauthorized) return onSignOut(); setErr(e.message); }
    finally { setBusy(''); }
  }

  return (
    <section className="card bc-lines">
      <h3 className="bc-h">
        What’s being asked for <span className="muted sm">{lines.length} line{lines.length === 1 ? '' : 's'}</span>
      </h3>
      {!lines.length && <p className="muted sm">Nothing on the request yet.</p>}
      {lines.length > 0 && (
        <div className="bc-scroll">
          <table className="table bc-table">
            <thead>
              <tr>
                {canDecide && pending.length > 0 && <th className="bc-w-sm" />}
                <th>Shoe</th><th>Size</th><th>Qty</th><th>Shelf</th>
                <th>Lands at</th><th>Call</th><th>Status</th>{editable && <th />}
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.id} className={`bc-line ${l.status}`}>
                  {canDecide && pending.length > 0 && (
                    <td>{l.status === 'pending' && (
                      <input type="checkbox" checked={sel.includes(Number(l.id))}
                        onChange={() => toggle(Number(l.id))} aria-label={`Select ${l.sku}`} />
                    )}</td>
                  )}
                  <td>
                    <b>{l.sku}</b>
                    {l.name && <div className="muted xs">{l.name}</div>}
                  </td>
                  <td>{l.size || '—'}</td>
                  <td>{l.qty}</td>
                  <td>{money(l.shelf_price)}</td>
                  <td>
                    {money(l.final_cost)}
                    {/* The snapshot's own working, so an approver can see WHY it said
                        what it said rather than taking the chip on trust. */}
                    {l.profit != null && (
                      <div className="muted xs">
                        {money(l.profit)} · {Number(l.roi).toFixed(1)}% via {l.best_platform || '—'}
                      </div>
                    )}
                  </td>
                  <td><VerdictChip verdict={l.verdict} /></td>
                  <td>
                    <span className={`bc-line-status ${l.status}`}>{l.status}</span>
                    {l.decided_by && <div className="muted xs">{l.decided_by}</div>}
                    {l.decided_reason && <div className="muted xs">{l.decided_reason}</div>}
                  </td>
                  {editable && (
                    <td><button type="button" className="btn sm ghost" disabled={busy === 'rm'}
                      onClick={() => remove(l.id)} aria-label={`Remove ${l.sku}`}>×</button></td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canDecide && pending.length > 0 && (
        <div className="bc-decide">
          <span className="muted sm">{pending.length} awaiting a decision{sel.length ? ` · ${sel.length} selected` : ''}</span>
          <button type="button" className="btn primary" disabled={!sel.length || busy} onClick={() => decide('approve', false)}>Approve selected</button>
          <button type="button" className="btn ghost" disabled={!sel.length || busy} onClick={() => decide('reject', false)}>Turn down selected</button>
          <button type="button" className="btn" disabled={busy} onClick={() => decide('approve', true)}>Approve all {pending.length}</button>
          <button type="button" className="btn ghost" disabled={busy} onClick={() => decide('reject', true)}>Turn down all</button>
        </div>
      )}
      {err && <div className="error mt">{err}</div>}
    </section>
  );
}

// Step 7. Each card's own spend and what is left on it — not one blended figure, because
// "the company can account for the funds" means per card, not on average.
function Audit({ cart, onChanged, onSignOut }) {
  const cards = (cart.giftCards || []).filter((c) => !c.voided_at);
  const [vals, setVals] = useState(() => Object.fromEntries(cards.map((c) => [c.id, {
    spent: c.spent_amount != null ? String(c.spent_amount) : '',
    remaining: c.remaining != null ? String(c.remaining) : '',
  }])));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const spentSum = cards.reduce((n, c) => n + (Number(vals[c.id]?.spent) || 0), 0);
  const receipt = Number(cart.receipt_total) || 0;
  const gap = Math.round((spentSum - receipt) * 100) / 100;

  const set = (id, k, v) => setVals((s) => ({ ...s, [id]: { ...s[id], [k]: v } }));

  async function save() {
    setBusy(true); setErr('');
    try {
      await api.cartAudit(cart.id, cards.map((c) => ({
        id: Number(c.id), spent: Number(vals[c.id]?.spent), remaining: Number(vals[c.id]?.remaining),
      })));
      onChanged();
    } catch (e) { if (e.unauthorized) return onSignOut(); setErr(e.message); }
    finally { setBusy(false); }
  }

  return (
    <section className="card bc-audit">
      <h3 className="bc-h">Financial audit</h3>
      <p className="muted sm">
        Cards issued {money(cart.gc_total)} → receipt {money(receipt)}. Say what each card was
        actually spent and what is left sitting on it.
      </p>
      <ul className="bc-audit-list">
        {cards.map((c) => (
          <li key={c.id}>
            <span className="bc-gc-num">•••• {c.code_last4}</span>
            <span className="muted sm">{money(c.balance)} issued</span>
            <label className="field"><span className="field-label">Spent</span>
              <PriceInput value={vals[c.id]?.spent ?? ''} onChange={(e) => set(c.id, 'spent', e.target.value)} /></label>
            <label className="field"><span className="field-label">Left on it</span>
              <PriceInput value={vals[c.id]?.remaining ?? ''} onChange={(e) => set(c.id, 'remaining', e.target.value)} /></label>
          </li>
        ))}
      </ul>
      <div className="bc-audit-foot">
        <span className={Math.abs(gap) > 0.01 ? 'bc-short' : 'bc-covered'}>
          Cards account for {money(spentSum)} against a {money(receipt)} receipt
          {Math.abs(gap) > 0.01 ? ` — a ${money(Math.abs(gap))} gap` : ' — balanced'}
        </span>
        <button type="button" className="btn primary" disabled={busy} onClick={save}>
          {busy ? 'Saving…' : 'Record the audit'}
        </button>
      </div>
      {err && <div className="error mt">{err}</div>}
    </section>
  );
}

function Thread({ cart, onChanged, onSignOut }) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const events = cart.events || [];

  async function post(e) {
    e.preventDefault();
    setBusy(true);
    try { await api.cartComment(cart.id, body); setBody(''); onChanged(); }
    catch (ex) { if (ex.unauthorized) return onSignOut(); }
    finally { setBusy(false); }
  }

  return (
    <section className="card bc-thread">
      <h3 className="bc-h">History</h3>
      <form className="bc-thread-add" onSubmit={post}>
        <input className="input" value={body} onChange={(e) => setBody(e.target.value)}
          placeholder="Ask the buyer what this is for, or leave a note…" />
        <button type="submit" className="btn" disabled={busy || !body.trim()}>Post</button>
      </form>
      <ul className="bc-events">
        {events.map((e) => (
          <li key={e.id} className={`bc-ev ${e.kind}`}>
            <span className="bc-ev-kind">{String(e.kind).replace(/_/g, ' ')}</span>
            <span className="bc-ev-who">{e.actor_name || 'system'}</span>
            {e.body && <span className="bc-ev-body">{e.body}</span>}
            <span className="muted xs">{estDate(e.created_at)} {estTime(e.created_at)} EST</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function BuyCart({ user, cartId, onBack, onSignOut }) {
  const [cart, setCart] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');

  const role = user.role;
  const isAdmin = role === 'admin' || role === 'superadmin';
  const isBuyer = role === 'supplier';
  const canDecide = !isBuyer && (isAdmin || ['warehouse', 'ph_team'].includes(role));
  const canIssue = isAdmin || ['ph_team', 'gc_issuer'].includes(role);
  const canAudit = isAdmin || role === 'auditor';

  async function load() {
    try { const { cart: c } = await api.cartGet(cartId); setCart(c); setErr(''); }
    catch (e) { if (e.unauthorized) return onSignOut(); setErr(e.message); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [cartId]);

  async function act(fn, key) {
    setBusy(key); setErr('');
    try { await fn(); await load(); }
    catch (e) { if (e.unauthorized) return onSignOut(); setErr(e.message); }
    finally { setBusy(''); }
  }

  if (!cart) {
    return (
      <div className="app">
        <TopBar title="Buying request" onHome={onBack} onSignOut={onSignOut} />
        {err ? <div className="error mt">{err}</div> : <p className="muted">Loading…</p>}
      </div>
    );
  }

  const checksDone = (cart.checks || []).every((c) => c.ok);

  return (
    <div className="app bc">
      <TopBar title={cart.cart_code} onHome={onBack} onSignOut={onSignOut} />

      <section className="card bc-head">
        <div className="bc-head-top">
          <div>
            <h2 className="bc-code">{cart.cart_code}</h2>
            <div className="muted sm">
              {cart.buyer_name}{cart.retailer ? ` · ${cart.retailer}` : ''} · opened {estDate(cart.created_at)} EST
            </div>
          </div>
          <StatusChip status={cart.status} />
        </div>
        {cart.purpose && <p className="bc-purpose"><b>Buying:</b> {cart.purpose}</p>}
        {cart.restrictions && <p className="muted sm"><b>Limits:</b> {cart.restrictions}</p>}
        <div className="bc-money">
          <span>Approved <b>{money(cart.approved_amount)}</b></span>
          <span>Cards <b>{money(cart.gc_total)}</b></span>
          <span>Receipt <b>{money(cart.receipt_total)}</b></span>
          <span>Left over <b>{money(cart.balance_remaining)}</b></span>
          {cart.po && <span>Order <b>{cart.po.po_code}</b> ({cart.po.status})</span>}
        </div>
        {cart.approved_by && (
          <p className="muted xs">
            Approved by {cart.approved_by} ({cart.approved_by_role}) {estDate(cart.approved_at)}
            {cart.funded_by ? ` · cards released by ${cart.funded_by}` : ''}
            {cart.audited_by ? ` · audited by ${cart.audited_by}` : ''}
            {cart.closed_by ? ` · closed by ${cart.closed_by}` : ''}
          </p>
        )}

        <div className="bc-head-actions">
          {isBuyer && cart.status === 'draft' && (
            <button className="btn primary" disabled={busy === 'sub'}
              onClick={() => act(() => api.cartSubmit(cart.id), 'sub')}>Send for approval</button>
          )}
          {isBuyer && cart.status === 'submitted' && (
            <button className="btn ghost" disabled={busy === 'wd'}
              onClick={() => act(() => api.cartWithdraw(cart.id), 'wd')}>Pull it back</button>
          )}
          {canDecide && cart.status === 'receipted' && !cart.po_id && (
            <button className="btn primary" disabled={busy === 'po'}
              onClick={() => act(() => api.cartRaisePo(cart.id, Number(window.prompt('How many boxes is the buyer sending?', '1')) || 1), 'po')}>
              Raise the purchase order
            </button>
          )}
          {canAudit && cart.status !== 'closed' && (
            <button className="btn primary" disabled={busy === 'close' || !checksDone}
              title={checksDone ? '' : 'Not every closing condition is met yet.'}
              onClick={() => act(() => api.cartClose(cart.id), 'close')}>
              {busy === 'close' ? 'Closing…' : 'Close / reconciled'}
            </button>
          )}
          {canDecide && ['draft', 'submitted', 'denied'].includes(cart.status) && (
            <button className="btn danger" disabled={busy === 'cx'}
              onClick={() => {
                const r = window.prompt('Why is this being cancelled?');
                if (r !== null) act(() => api.cartCancel(cart.id, r), 'cx');
              }}>Cancel</button>
          )}
        </div>
        {err && <div className="error mt">{err}</div>}
      </section>

      {isBuyer && cart.status === 'draft' && (
        <BuyCartAdd cart={cart} onAdded={load} onSignOut={onSignOut} />
      )}

      <Lines cart={cart} canDecide={canDecide} isBuyer={isBuyer} onChanged={load} onSignOut={onSignOut} />

      {['approved', 'funded', 'receipted', 'audited', 'closed'].includes(cart.status) && (
        <BuyCartGiftCards cart={cart} role={role} canIssue={canIssue} isBuyer={isBuyer}
          onChanged={load} onSignOut={onSignOut} />
      )}

      {['funded', 'receipted', 'audited', 'closed'].includes(cart.status) && (
        <BuyCartReceipt cart={cart} canEdit={cart.status !== 'closed' && (isBuyer || canDecide || canIssue)}
          onChanged={load} onSignOut={onSignOut} />
      )}

      {canAudit && ['receipted', 'audited'].includes(cart.status) && (
        <Audit cart={cart} onChanged={load} onSignOut={onSignOut} />
      )}

      <Checks checks={cart.checks} />
      <Thread cart={cart} onChanged={load} onSignOut={onSignOut} />
    </div>
  );
}
