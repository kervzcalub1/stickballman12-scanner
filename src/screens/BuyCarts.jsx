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
import { useLive } from '../hooks.js';
import { hasPriv } from '../lib/constants.js';
import { BuyCart } from './BuyCart.jsx';

const money = (n) => `$${(Number(n) || 0).toFixed(2)}`;
// A request with nothing approved or funded yet has no money figure, which is different
// from a figure of zero — a column of "$0.00" on every draft read as a list of requests
// somebody had priced at nothing.
const moneyOr = (n) => (Number(n) > 0 ? money(n) : '—');
const pairs = (c) => {
  const n = Number(c.line_count) || 0;
  return n ? `${n} pair${n === 1 ? '' : 's'}` : 'No pairs yet';
};

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
  written_off: { label: 'Written off', cls: 'muted' },
};

// Which desk each count belongs to, named as a job rather than as a state — "needs gift
// cards" tells the issuer it is theirs in a way "approved" never does.
//
// `priv` marks the desk a person holds, so their own pile says "Yours" — the counts are
// the same for everybody, and "is any of this mine?" was left for each reader to work
// out from their privileges.
const QUEUES = [
  { key: 'carts_to_approve', status: 'submitted', label: 'To approve', priv: 'approve_buying' },
  { key: 'carts_to_fund', status: 'approved', label: 'Needs gift cards', priv: 'issue_gift_cards' },
  { key: 'carts_awaiting_receipt', status: 'funded', label: 'Waiting on receipts' },
  { key: 'carts_to_audit', status: 'receipted', label: 'To audit', priv: 'audit_buying' },
];

// Open by default: the list is capped at 100 and the endings (closed, denied, cancelled)
// pile up forever, so without a split the requests anybody can still act on were a thin
// stripe between finished ones — and on a buyer's phone, a 13,000px scroll.
const VIEWS = [
  { key: 'open', label: 'Open' },
  { key: 'done', label: 'Finished' },
  { key: 'all', label: 'All' },
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
  const [view, setView] = useQueryParam('view', 'open');
  // A desk's queue is always open work, so picking one overrides the Open/Finished split
  // rather than being ANDed with it (Finished + "To approve" would always be empty).
  const listView = filter ? undefined : (view === 'all' ? undefined : view);
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
      const { carts: c, counts: n, buyers: b } = await api.cartList(filter || undefined, buyer || undefined, listView);
      setCarts(c); setCounts(n); if (b) setBuyers(b); setErr('');
    } catch (e) { if (e.unauthorized) return onSignOut(); setErr(e.message); }
  }
  // Filtered SERVER-side, not in the browser: the list is capped at 100, so narrowing
  // the loaded page would quietly show a fraction of somebody's requests and read as
  // though that were all of them.
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [filter, buyer, view]);
  // The queue counts and the status chips move when somebody else acts — a buyer closing
  // a list, a tap in the group — so the desk's pile is re-read the moment it changes
  // (live-updates.md) rather than on F5.
  useLive(['buy_carts', 'buy_cart_lines', 'buy_cart_gift_cards', 'buy_cart_tasks'], async () => {
    const { carts: c, counts: n, buyers: b } = await api.cartList(filter || undefined, buyer || undefined, listView);
    setCarts(c); setCounts(n); if (b) setBuyers(b);
  }, { paused: !!asking || !!open, mount: false });

  // Opening a request asks ONE thing: which store. What is being bought is not known
  // yet — a buyer often works that out standing in the shop — and a field that has to be
  // filled before the trip starts gets filled with a guess. The lines themselves are the
  // answer: a SKU, a photo and a count per pair, added as they are found.
  async function newRequest({ retailer }) {
    try {
      const { cart } = await api.cartCreate({ retailer: retailer.trim() });
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
          message="Just the store to start. Add each pair as you find it — that is what the approver sees."
          submitLabel="Start the request"
          onClose={() => setAsking(false)}
          onSubmit={newRequest}
          fields={[
            { name: 'retailer', label: 'Which store?', required: true, maxLength: 80,
              placeholder: 'e.g. Nike Outlet — Orlando' },
          ]} />
      )}

      <div className="bc-views" role="tablist" aria-label="Which requests">
        {VIEWS.map((v) => (
          <button key={v.key} type="button" role="tab" aria-selected={!filter && view === v.key}
            className={`bc-view ${!filter && view === v.key ? 'on' : ''}`}
            onClick={() => { setFilter(''); setView(v.key); }}>{v.label}</button>
        ))}
      </div>

      {counts && (
        <div className="bc-queues">
          {QUEUES.map((q) => (
            <button key={q.key} type="button"
              className={`bc-queue ${filter === q.status ? 'on' : ''} ${counts[q.key] > 0 ? 'live' : ''}`}
              onClick={() => setFilter(filter === q.status ? '' : q.status)}>
              <span className="bc-queue-n">{counts[q.key] || 0}</span>
              <span className="bc-queue-l">{q.label}</span>
              {q.priv && hasPriv(user, q.priv) && <span className="bc-queue-mine">Yours</span>}
            </button>
          ))}
          {(filter || buyer) && (
            <button type="button" className="btn sm ghost"
              onClick={() => { setFilter(''); setBuyer(''); }}>Clear filters</button>
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
                : view === 'open' ? (isBuyer ? 'Nothing open — start a request when you are heading to a store.' : 'No open buying requests.')
                  : view === 'done' ? 'No finished requests yet.'
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
                  {/* A purpose is no longer asked for, so its absence is not a fault to
                      report — older requests still have one and it still shows. With none,
                      the pairs themselves are the answer, so say how many there are. */}
                  <span className="bc-card-purpose">{c.purpose || <i className="muted">
                    {Number(c.line_count) ? `${c.line_count} pair${Number(c.line_count) === 1 ? '' : 's'} so far` : 'No pairs added yet'}
                  </i>}</span>
                  <span className="bc-card-meta">
                    <span>{c.retailer || '—'}</span>
                    {!isBuyer && c.buyer_name && <span>· {c.buyer_name}</span>}
                    <span>· {estDate(c.created_at)}</span>
                    {c.po_code && <span>· <a className="bc-po-link" href={poHref(user, c.po_id)} onClick={(e) => e.stopPropagation()}>{c.po_code}</a></span>}
                  </span>
                  <span className="bc-card-money">
                    <span><i>Approved</i> {moneyOr(c.approved_amount)}</span>
                    <span><i>Cards</i> {moneyOr(c.gc_total)}</span>
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
                <th>Request</th><th>Status</th>{!isBuyer && <th>Buyer</th>}<th>Store</th><th className="bc-purpose-cell">Buying</th>
                <th className="num">Approved</th><th className="num">Cards</th><th>Order</th><th>Opened</th>
              </tr>
            </thead>
            <tbody>
              {carts.map((c) => {
                const s = STATUS[c.status] || { label: c.status, cls: 'muted' };
                return (
                  <tr key={c.id} className="bc-row" onClick={() => setOpen(c.id)} tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter') setOpen(c.id); }}>
                    <td><b>{c.cart_code}</b></td>
                    {/* Status second, beside the code: it is what a desk scans the list for,
                        and at the far right it was the column that scrolled out of view. */}
                    <td>
                      <span className={`po-chip ${s.cls}`}>{s.label}</span>
                      {stillAdding(c) && <span className="po-chip warn bc-list-chip">Still adding</span>}
                    </td>
                    {!isBuyer && <td>{c.buyer_name}</td>}
                    <td>{c.retailer || '—'}</td>
                    {/* No purpose is asked for any more, so on every new request this column
                        was a dash. The pairs are the answer to "what is being bought". */}
                    <td className="bc-purpose-cell">{c.purpose || <span className="muted">{pairs(c)}</span>}</td>
                    <td className="num">{moneyOr(c.approved_amount)}</td>
                    <td className="num">{moneyOr(c.gc_total)}</td>
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
