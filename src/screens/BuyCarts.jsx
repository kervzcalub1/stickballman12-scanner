// The buying-request queue. Every desk's list of what it is holding up, and the buyer's
// list of their own requests.
//
// The counts along the top are the point: four numbers, each naming a desk rather than
// a status, so a person can see at a glance whether the thing waiting is theirs. A
// request sitting for three days because nobody knew it was their turn is the failure
// mode this screen exists to prevent.
import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { poHref } from '../lib/poLink.js';
import { TopBar, FormModal } from '../components/common.jsx';
import { estDate } from '../lib/format.js';
import { useQueryParam } from '../lib/urlstate.js';
import { useLiveRefresh } from '../hooks.js';
import { BuyCart } from './BuyCart.jsx';

const money = (n) => `$${(Number(n) || 0).toFixed(2)}`;

// "Still adding" beside the status: a request is `submitted` from its first pair
// onward, whether the buyer is mid-aisle or done — and the queue is where the desk
// decides what to pick up next. Only while it matters (before the cards are out).
const stillAdding = (c) => !c.list_closed_at && ['submitted', 'approved', 'denied'].includes(c.status) && Number(c.line_count) > 0;

const STATUS = {
  draft: { label: 'Being written', cls: 'draft' },
  submitted: { label: 'Waiting on approval', cls: 'warn' },
  approved: { label: 'Needs gift cards', cls: 'shipped' },
  denied: { label: 'Denied', cls: 'muted' },
  funded: { label: 'Waiting on the receipt', cls: 'shipped' },
  receipted: { label: 'Needs auditing', cls: 'warn' },
  audited: { label: 'Waiting on the shipment', cls: 'shipped' },
  closed: { label: 'Closed / reconciled', cls: 'ok' },
  cancelled: { label: 'Cancelled', cls: 'muted' },
};

// Which desk each count belongs to, named as a job rather than as a state — "needs gift
// cards" tells the issuer it is theirs in a way "approved" never does.
const QUEUES = [
  { key: 'carts_to_approve', status: 'submitted', label: 'To approve' },
  { key: 'carts_to_fund', status: 'approved', label: 'Needs gift cards' },
  { key: 'carts_awaiting_receipt', status: 'funded', label: 'Waiting on receipts' },
  { key: 'carts_to_audit', status: 'receipted', label: 'To audit' },
];

export function BuyCarts({ user, onHome, onSignOut }) {
  const [carts, setCarts] = useState(null);
  const [counts, setCounts] = useState(null);
  const [buyers, setBuyers] = useState(null);
  const [filter, setFilter] = useState('');
  // In the URL, like the other filtered lists: "look at Eric's requests" is a link
  // somebody sends, and it has to survive the refresh you do after approving one.
  const [buyer, setBuyer] = useQueryParam('buyer');
  // The open request rides in `?request=`, like `?po=` on the order pages: a refresh
  // inside BC-2400 used to land back on the queue, and a link to one could not be sent.
  const [openRaw, setOpen] = useQueryParam('request');
  const open = /^\d+$/.test(openRaw) ? Number(openRaw) : null;
  const [err, setErr] = useState('');
  const [asking, setAsking] = useState(false);

  const isBuyer = user.role === 'supplier';
  // Names that more than one account carries — see the dropdown below.
  const dupeNames = new Set(
    (buyers || []).map((b) => b.name)
      .filter((n, i, all) => all.indexOf(n) !== i),
  );

  async function load() {
    try {
      const { carts: c, counts: n, buyers: b } = await api.cartList(filter || undefined, buyer || undefined);
      setCarts(c); setCounts(n); if (b) setBuyers(b); setErr('');
    } catch (e) { if (e.unauthorized) return onSignOut(); setErr(e.message); }
  }
  // Filtered SERVER-side, not in the browser: the list is capped at 100, so narrowing
  // the loaded page would quietly show a fraction of somebody's requests and read as
  // though that were all of them.
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [filter, buyer]);
  // The queue counts and the status chips move when somebody else acts — a buyer closing
  // a list, a tap in the group — so the desk's pile is re-read quietly rather than on F5.
  useLiveRefresh(async () => {
    const { carts: c, counts: n, buyers: b } = await api.cartList(filter || undefined, buyer || undefined);
    setCarts(c); setCounts(n); if (b) setBuyers(b);
  }, { every: 20_000, paused: !!asking || !!open });

  // Both questions in ONE modal. As two chained prompts, answering the first and then
  // cancelling the second threw the first answer away with nothing on screen to say so.
  async function newRequest({ purpose, retailer }) {
    try {
      const { cart } = await api.cartCreate({ purpose: purpose.trim(), retailer: retailer.trim() });
      setAsking(false);
      setOpen(cart.id);
    } catch (e) { if (e.unauthorized) return onSignOut(); throw e; }
  }

  if (open) {
    return <BuyCart user={user} cartId={open} onSignOut={onSignOut}
      onBack={() => { setOpen(''); load(); }} />;
  }

  return (
    <div className="app bc-list">
      {/* One name on both sides. The staff half used to say "Gift card buying", which
          named the funding rather than the process — the buyer is asking to purchase
          stock, and the cards are how we pay for it. */}
      <TopBar title="Buying requests" onHome={onHome} onSignOut={onSignOut}
        right={isBuyer ? <button className="btn sm primary" onClick={() => setAsking(true)}>New request</button> : null} />

      {asking && (
        <FormModal
          title="New buying request"
          message="An approver sees only what you write here, so write it for someone who isn't in the shop with you."
          submitLabel="Start the request"
          onClose={() => setAsking(false)}
          onSubmit={newRequest}
          fields={[
            { name: 'purpose', label: 'What are you buying, and why?', type: 'textarea', required: true,
              placeholder: 'e.g. Restocking Jordan 1 lows — Nike outlet has them at $90',
              hint: 'An approver has to be able to tell from this alone.' },
            { name: 'retailer', label: 'Which store?', required: true, maxLength: 80,
              placeholder: 'e.g. Nike Outlet — Orlando' },
          ]} />
      )}

      {counts && (
        <div className="bc-queues">
          {QUEUES.map((q) => (
            <button key={q.key} type="button"
              className={`bc-queue ${filter === q.status ? 'on' : ''} ${counts[q.key] > 0 ? 'live' : ''}`}
              onClick={() => setFilter(filter === q.status ? '' : q.status)}>
              <span className="bc-queue-n">{counts[q.key] || 0}</span>
              <span className="bc-queue-l">{q.label}</span>
            </button>
          ))}
          {(filter || buyer) && (
            <button type="button" className="btn sm ghost"
              onClick={() => { setFilter(''); setBuyer(''); }}>Show all</button>
          )}
        </div>
      )}

      {/* The person is "Buyer" here and everywhere else on these screens, never
          "supplier". They hold the `supplier` ROLE, but the gift card SUPPLIERS are a
          different set of people entirely — and two different people reading as one is
          how a separation-of-duties control quietly stops being one. */}
      {!isBuyer && buyers && buyers.length > 1 && (
        <div className="bc-filters">
          <label className="bc-filter">
            <span className="muted sm">Buyer</span>
            <select className="input" value={buyer} onChange={(e) => setBuyer(e.target.value)}>
              <option value="">Every buyer</option>
              {buyers.map((b) => (
                // The live count, not the total: on a queue screen the useful question
                // is who still has something open, and a buyer with 40 closed requests
                // and nothing outstanding should not read as the busiest person here.
                //
                // The username is shown ONLY when the display name is shared, which on
                // live data it is — two accounts are both called "Test Supplier". Two
                // identical options is a filter a person cannot use correctly even
                // though the value behind each one is right; adding @username to every
                // row to cover that case would clutter the common one.
                <option key={b.id} value={b.id}>
                  {b.name}{dupeNames.has(b.name) && b.username ? ` @${b.username}` : ''} ({b.live})
                </option>
              ))}
            </select>
          </label>
          {buyer && carts && (
            <span className="muted sm">
              {carts.length === 0 ? 'No requests' : `${carts.length} request${carts.length === 1 ? '' : 's'}`}
              {filter ? ' in this queue' : ''} from <b>{buyers.find((b) => String(b.id) === String(buyer))?.name || 'that buyer'}</b>.
            </span>
          )}
        </div>
      )}

      {err && <div className="error mt">{err}</div>}
      {!carts && <p className="muted">Loading…</p>}
      {carts && !carts.length && (
        <p className="muted">
          {filter && buyer ? 'Nothing in that queue for that buyer.'
            : filter ? 'Nothing in that queue.'
              : buyer ? 'No requests from that buyer.'
                : isBuyer ? 'No requests yet — start one when you are heading to a store.'
                  : 'No buying requests yet.'}
        </p>
      )}

      {/* Two renderings of one list, swapped by CSS at 768px. The phone one is not the
          table with columns dropped: a buyer standing in a shop wants the request, where
          it has got to, and the money — in that order — and a nine-column table sideways
          gives none of them without dragging. */}
      {carts && carts.length > 0 && (
        <ul className="bc-list-cards">
          {carts.map((c) => {
            const s = STATUS[c.status] || { label: c.status, cls: 'muted' };
            return (
              <li key={c.id}>
                <button type="button" className="bc-card" onClick={() => setOpen(c.id)}>
                  <span className="bc-card-top">
                    <b>{c.cart_code}</b>
                    <span className={`po-chip ${s.cls}`}>{s.label}</span>
                    {stillAdding(c) && <span className="po-chip warn">Buyer still adding</span>}
                  </span>
                  <span className="bc-card-purpose">{c.purpose || <i className="muted">No purpose written</i>}</span>
                  <span className="bc-card-meta">
                    <span>{c.retailer || '—'}</span>
                    {!isBuyer && c.buyer_name && <span>· {c.buyer_name}</span>}
                    <span>· {estDate(c.created_at)}</span>
                    {c.po_code && <span>· <a className="bc-po-link" href={poHref(user, c.po_id)} onClick={(e) => e.stopPropagation()}>{c.po_code}</a></span>}
                  </span>
                  <span className="bc-card-money">
                    <span><i>Approved</i> {money(c.approved_amount)}</span>
                    <span><i>Cards</i> {money(c.gc_total)}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {carts && carts.length > 0 && (
        <div className="bc-scroll bc-table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Request</th>{!isBuyer && <th>Buyer</th>}<th>Store</th><th className="bc-purpose-cell">Buying</th>
                <th className="num">Approved</th><th className="num">Cards</th><th>Status</th><th>Order</th><th>Opened</th>
              </tr>
            </thead>
            <tbody>
              {carts.map((c) => {
                const s = STATUS[c.status] || { label: c.status, cls: 'muted' };
                return (
                  <tr key={c.id} className="bc-row" onClick={() => setOpen(c.id)} tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter') setOpen(c.id); }}>
                    <td><b>{c.cart_code}</b></td>
                    {!isBuyer && <td>{c.buyer_name}</td>}
                    <td>{c.retailer || '—'}</td>
                    <td className="bc-purpose-cell">{c.purpose || <span className="muted">—</span>}</td>
                    <td className="num">{money(c.approved_amount)}</td>
                    <td className="num">{money(c.gc_total)}</td>
                    <td>
                      <span className={`po-chip ${s.cls}`}>{s.label}</span>
                      {stillAdding(c) && <span className="po-chip warn bc-list-chip">Still adding</span>}
                    </td>
                    <td>{c.po_code ? <a className="bc-po-link" href={poHref(user, c.po_id)} onClick={(e) => e.stopPropagation()}>{c.po_code}</a> : '—'}</td>
                    <td className="muted sm">{estDate(c.created_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
