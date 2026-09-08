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
import { TopBar, PriceInput, FormModal } from '../components/common.jsx';
import { BuyCartAdd, VerdictChip, lineCall } from '../components/BuyCartAdd.jsx';
import { BuyCartGiftCards } from '../components/BuyCartGiftCards.jsx';
import { BuyCartReceipt } from '../components/BuyCartReceipt.jsx';
import { BuyCartCosts } from '../components/BuyCartCosts.jsx';
import { estDate, estTime } from '../lib/format.js';
import { PLATFORMS } from '../lib/payout.js';
import { hasPriv } from '../lib/constants.js';

const money = (n) => (n == null ? '—' : `$${(Number(n) || 0).toFixed(2)}`);
// `best_platform` stores the KEY ('alias'), and printing it raw read "92.7% ROI via
// alias" beside a calculator that says "via Alias" — the same call looking like two
// tools' opinions.
const platform = (key) => PLATFORMS.find((p) => p.key === key)?.label || key || '—';

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

// The Payout Calculator's verdict card, for a line that already has one. Same shape and
// the same sentence, because a buy call read on the request and the same call read on the
// calculator must not look like two different tools' opinions.
//
// The NUMBERS come off the stored snapshot; only the prose is re-derived (`lineCall`), so
// there is one source of truth for anything a person decides on.
function LineCall({ line, stack, onPrice, canPrice, busy }) {
  const v = lineCall(line, stack);
  const alias = Number(line.alias_price) > 0 ? Number(line.alias_price) : null;
  const stockx = Number(line.stockx_price) > 0 ? Number(line.stockx_price) : null;
  return (
    <div className={`bc-call ${line.verdict || 'none'}`}>
      <div className="bc-call-top">
        <VerdictChip verdict={line.verdict} />
        <span className="muted sm">
          Lands at {money(line.final_cost)} a pair
          {line.profit != null && ` · ${money(line.profit)} profit · ${Number(line.roi).toFixed(1)}% ROI via ${platform(line.best_platform)}`}
        </span>
        {v?.risk && <span className={`bc-risk ${v.risk}`}>{v.risk} risk</span>}
      </div>
      {v && <p className="bc-call-note">{v.note}</p>}
      {/* Why there is no call, in the words of what actually happened. "Not priced" on
          its own sends people looking for a setting that doesn't exist. */}
      {!v && (
        <p className="bc-call-note muted">
          No Alias or StockX price was captured for this size when it was added, so no call
          could be made — the market lookup came back empty or timed out.
          {canPrice ? ' Price it now to get one.' : ''}
        </p>
      )}
      <div className="bc-market">
        <span>Alias <b>{alias ? money(alias) : '—'}</b></span>
        <span>StockX <b>{stockx ? money(stockx) : '—'}</b></span>
        {line.liquidity && <span>sells <b>{line.liquidity}</b></span>}
        {line.basis && <span className="muted sm">{line.basis === 'consigned' ? 'consigned' : 'you hold it'}</span>}
        {line.quoted_at && <span className="muted sm">quoted {estDate(line.quoted_at)} EST</span>}
      </div>
      {canPrice && (
        <div className="bc-call-actions">
          <button type="button" className={`btn sm ${v ? 'ghost' : 'primary'}`} disabled={busy}
            onClick={onPrice}>
            {busy ? 'Reading the market…' : v ? 'Re-price against today’s market' : 'Price it'}
          </button>
          {v && <span className="muted xs">This replaces the call an approver is reading, and says so in the history.</span>}
        </div>
      )}
    </div>
  );
}

function Lines({ cart, canDecide, canEditLines, canPrice, isBuyer, onChanged, onSignOut }) {
  const [sel, setSel] = useState([]);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  // `null` = not asking. `{ all }` = asking why, for one line or for the lot.
  const [rejecting, setRejecting] = useState(null);
  // The line being corrected, if any. A misread shelf ticket is the common case and it
  // used to mean pulling the whole request back to fix one number.
  const [fixing, setFixing] = useState(null);
  // Which line's working is open. One at a time: the panel is tall, and two of them open
  // is a table you have to scroll to compare two rows of.
  const [open, setOpen] = useState(null);
  const lines = cart.lines || [];
  const pending = lines.filter((l) => l.status === 'pending');
  const editable = isBuyer && cart.status === 'draft';
  const canFix = editable || canEditLines;
  // Kept in one place: the detail row has to span exactly the header, and a colSpan that
  // drifts from the columns leaves a ragged edge nobody notices in review.
  const cols = 7 + (canDecide && pending.length > 0 ? 1 : 0) + (canFix ? 1 : 0);

  const toggle = (id) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  // Turning something down always asks why; approving does not. The reason travels to
  // the buyer, who is standing in the shop deciding what to do next.
  function decide(action, all) {
    if (action === 'reject') return setRejecting({ all });
    return commit(action, all, null);
  }

  async function commit(action, all, reason) {
    setBusy(action); setErr('');
    try {
      await api.cartDecide(cart.id, all ? { action, all: true, reason } : { action, lineIds: sel, reason });
      setSel([]); setRejecting(null); onChanged();
    } catch (e) { if (e.unauthorized) return onSignOut(); setErr(e.message); }
    finally { setBusy(''); }
  }

  async function remove(id) {
    setBusy('rm'); setErr('');
    try { await api.cartRemoveLine(cart.id, id); onChanged(); }
    catch (e) { if (e.unauthorized) return onSignOut(); setErr(e.message); }
    finally { setBusy(''); }
  }

  // Re-read the market for one pair. Explicit and named — see api/cart/price-line.js.
  async function price(id) {
    setBusy(`px${id}`); setErr('');
    try {
      const r = await api.cartPriceLine(cart.id, id);
      // A successful call that found nothing is not an error, and it must not read as
      // one — but it does have to say so, or the button looks broken.
      if (r.priced === false) setErr(r.error || 'No market price for that size right now.');
      onChanged();
    } catch (e) { if (e.unauthorized) return onSignOut(); setErr(e.message); }
    finally { setBusy(''); }
  }

  // Not through `act`-style error swallowing: FormModal keeps the typed values when the
  // server refuses, which is the whole reason these stopped being window.prompts.
  async function fix({ size, qty, shelfPrice }) {
    await api.cartEditLine(cart.id, fixing.id, {
      size: String(size ?? '').trim() || null,
      qty: Number(qty) || fixing.qty,
      shelfPrice: String(shelfPrice ?? '').trim() === '' ? null : Number(shelfPrice),
    });
    setFixing(null); onChanged();
  }

  return (
    <section className="card bc-lines">
      {rejecting && (
        <FormModal
          title={rejecting.all ? 'Turn down every pending line' : `Turn down ${sel.length} line${sel.length === 1 ? '' : 's'}`}
          message="The buyer reads this in the shop, so say what would change your mind."
          submitLabel="Turn it down" danger
          onClose={() => setRejecting(null)}
          onSubmit={({ reason }) => commit('reject', rejecting.all, reason.trim())}
          fields={[{ name: 'reason', label: 'Why?', type: 'textarea', required: true,
            placeholder: 'e.g. Too close to retail — only worth it under $95' }]} />
      )}
      {fixing && (
        <FormModal
          title={`Correct ${fixing.sku}`}
          message={isBuyer
            ? 'Fix what you typed. The buy call re-prices against the same market prices it was quoted at.'
            : 'The buyer read the ticket in a shop. Correcting it here re-prices the line and the change is recorded against your name.'}
          submitLabel="Save the correction"
          onClose={() => setFixing(null)}
          onSubmit={fix}
          fields={[
            { name: 'size', label: 'Size', value: fixing.size || '', maxLength: 20 },
            { name: 'qty', label: 'Pairs', type: 'number', value: String(fixing.qty ?? 1), min: 1, max: 999, required: true },
            { name: 'shelfPrice', label: 'Price on the shelf', type: 'number', step: '0.01',
              value: fixing.shelf_price == null ? '' : String(fixing.shelf_price), min: 0, required: true,
              hint: 'What the sticker says, before any discount — it is what the gift cards have to cover.' },
          ]} />
      )}
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
                <th>Shoe</th><th>Size</th><th className="num">Qty</th><th className="num">Shelf</th>
                {/* Two columns, not one. Unstyled they ran together and read as a single
                    "Call Status" heading, so a blank buy call looked like a request whose
                    STATUS was the word Pending sitting in the wrong place. */}
                <th className="num">Lands at</th><th>Buy call</th><th>Approval</th>{canFix && <th />}
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const id = Number(l.id);
                const shown = open === id;
                return (
                <React.Fragment key={l.id}>
                <tr className={`bc-line ${l.status}${shown ? ' open' : ''}`}
                  onClick={() => setOpen(shown ? null : id)} tabIndex={0}
                  aria-expanded={shown}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(shown ? null : id); } }}>
                  {canDecide && pending.length > 0 && (
                    // Ticking a line to approve it must not also open its working.
                    <td onClick={(e) => e.stopPropagation()}>{l.status === 'pending' && (
                      <input type="checkbox" checked={sel.includes(id)}
                        onChange={() => toggle(id)} aria-label={`Select ${l.sku}`} />
                    )}</td>
                  )}
                  <td>
                    <b>{l.sku}</b>
                    {l.name && <div className="muted xs">{l.name}</div>}
                  </td>
                  <td>{l.size || '—'}</td>
                  <td className="num">{l.qty}</td>
                  <td className="num">{money(l.shelf_price)}</td>
                  <td className="num">{money(l.final_cost)}</td>
                  {/* The call and its working together — the profit and ROI used to sit
                      under "Lands at", a column away from the verdict they justify.
                      No verdict means nobody priced it, which is a different answer from
                      "we priced it and it's a Pass". */}
                  <td className="bc-call-cell">
                    {l.verdict ? <VerdictChip verdict={l.verdict} />
                      : <span className="muted xs">Not priced</span>}
                    {l.profit != null ? (
                      <div className="muted xs">
                        {money(l.profit)} · {Number(l.roi).toFixed(1)}% via {platform(l.best_platform)}
                      </div>
                    ) : (
                      <div className="muted xs">{shown ? 'why ▴' : 'why ▾'}</div>
                    )}
                  </td>
                  <td>
                    <span className={`bc-line-status ${l.status}`}>{l.status}</span>
                    {l.decided_by && <div className="muted xs">{l.decided_by}</div>}
                    {l.decided_reason && <div className="muted xs">{l.decided_reason}</div>}
                  </td>
                  {canFix && (
                    <td className="bc-line-actions" onClick={(e) => e.stopPropagation()}>
                      <button type="button" className="btn sm ghost" onClick={() => setFixing(l)}
                        aria-label={`Correct ${l.sku}`} title="Correct the size, quantity or shelf price">✎</button>
                      {editable && (
                        <button type="button" className="btn sm ghost" disabled={busy === 'rm'}
                          onClick={() => remove(l.id)} aria-label={`Remove ${l.sku}`}>×</button>
                      )}
                    </td>
                  )}
                </tr>
                {shown && (
                  <tr className="bc-line-detail">
                    <td colSpan={cols} onClick={(e) => e.stopPropagation()}>
                      <LineCall line={l} stack={cart.cost_stack || {}} canPrice={canPrice}
                        busy={busy === `px${id}`} onPrice={() => price(id)} />
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
  // Two questions that used to be native prompts: how many boxes the PO covers, and why
  // a request is being cancelled.
  const [asking, setAsking] = useState(null);
  const [cart, setCart] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');

  const role = user.role;
  const isBuyer = role === 'supplier';
  // What to DRAW, from the privileges the account holds. Never what is allowed — every
  // one of these actions is re-checked against the database on the way in, so a button
  // drawn off a stale list simply answers 403 rather than doing anything.
  const canDecide = !isBuyer && hasPriv(user, 'approve_buying');
  const canIssue = !isBuyer && hasPriv(user, 'issue_gift_cards');
  const canAudit = !isBuyer && hasPriv(user, 'audit_buying');
  // The cost side is the BUYER'S first — they are the one in the shop who can read the
  // tax off the register — and either desk can then overwrite anything they typed. The
  // control is the trail, not the lock: every version is named in the history. Shelf
  // prices are the exception and still freeze once the cards are out, because that is
  // the number the money was released against.
  const canCost = isBuyer || canDecide || canAudit;

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
              onClick={() => setAsking('po')}>
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
              onClick={() => setAsking('cancel')}>Cancel</button>
          )}
        </div>
        {err && <div className="error mt">{err}</div>}

        {asking === 'po' && (
          <FormModal
            title="Raise the purchase order"
            message="This opens the order the shipment is received against, and prints its labels."
            submitLabel="Raise it"
            onClose={() => setAsking(null)}
            onSubmit={async ({ boxes }) => {
              // A blank or nonsense count is one box, the same as the old prompt's default —
              // but the field says so rather than silently deciding it.
              await api.cartRaisePo(cart.id, Math.max(1, Number(boxes) || 1));
              setAsking(null); await load();
            }}
            fields={[{ name: 'boxes', label: 'How many boxes is the buyer sending?', type: 'number',
              value: '1', min: 1, max: 99, hint: 'One label is printed per box. Left blank, it is one.' }]} />
        )}

        {asking === 'cancel' && (
          <FormModal
            title="Cancel this request"
            message="It stays on the record as cancelled — nothing is deleted."
            submitLabel="Cancel the request" danger
            onClose={() => setAsking(null)}
            onSubmit={async ({ reason }) => {
              await api.cartCancel(cart.id, reason.trim());
              setAsking(null); await load();
            }}
            fields={[{ name: 'reason', label: 'Why is this being cancelled?', type: 'textarea', required: true,
              placeholder: 'e.g. Buyer got to the store and the price had gone back up' }]} />
        )}
      </section>

      {isBuyer && cart.status === 'draft' && (
        <BuyCartAdd cart={cart} onAdded={load} onSignOut={onSignOut} />
      )}

      {/* Before the lines, because it is what the "Lands at" column on them means. */}
      <BuyCartCosts cart={cart} canEdit={canCost && !['closed', 'cancelled'].includes(cart.status)}
        onChanged={load} onSignOut={onSignOut} />

      <Lines cart={cart} canDecide={canDecide} isBuyer={isBuyer}
        canEditLines={(canDecide || canAudit) && ['draft', 'submitted', 'approved'].includes(cart.status)}
        canPrice={canCost && !['closed', 'cancelled'].includes(cart.status)}
        onChanged={load} onSignOut={onSignOut} />

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
