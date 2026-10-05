// Online Orders — shoes the PH team bought from an online store (docs/context/online-orders.md).
//
// Three jobs on one page:
//   · PH records the order: what, from where, the tracking number once it ships, and the
//     order's coupon / tax / shipping / gift-card discount / cashback — which turn into what each
//     pair ACTUALLY cost (orderCosts, src/lib/onlineOrders.js).
//   · The WAREHOUSE sees what to expect ("Expected": shipped, not counted in yet) and
//     counts each parcel in; pairs that never arrived split off as not delivered.
//   · A cancelled or undelivered line's refund is TRACED: refunded, or followed up
//     (asked the store → waiting → refunded with the amount), every step in the history.
//
// Its own list, deliberately not a purchase order (owner's call, 2026-10-01).
import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { TopBar, Modal, FormModal, NumField } from '../components/common.jsx';
import { useLive } from '../hooks.js';
import { useQueryParam } from '../lib/urlstate.js';
import { estToday, estCivilFromYmd, PH_DATE, PH_DATETIME } from '../lib/format.js';
import {
  orderCosts, orderCode, orderStage, STAGE_LABEL, CANCEL_REASONS, REASON_LABEL, REFUND_STATES, needsFollowUp, isCancelled,
} from '../lib/onlineOrders.js';

const money = (v) => (v == null || Number.isNaN(Number(v)) ? '—' : `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const dateOf = (ymdStr) => (ymdStr ? PH_DATE.format(estCivilFromYmd(ymdStr)) : '—');
const when = (ts) => (ts ? `${PH_DATETIME.format(new Date(ts))} EST` : '');
// Whole days since a refund was asked for — "waiting 9 days" is what makes a chase happen.
const daysSince = (ts) => (ts ? Math.max(0, Math.floor((Date.now() - new Date(ts).getTime()) / 86_400_000)) : null);

const VIEWS = [
  ['all', 'All'],
  ['expected', 'Expected', 'expected'],
  ['ordered', 'No tracking yet'],
  ['followup', 'Refund follow-up', 'followup'],
  ['cancelled', 'Cancelled'],
];

const blankLine = () => ({ key: Math.random().toString(36).slice(2), sku: '', name: '', size: '', qty: '1', unit_price: '' });

export function OnlineOrders({ user, onHome, onSignOut }) {
  // PH records and chases; the warehouse reads and counts in. Admin does both.
  const canEdit = user?.role !== 'warehouse';
  const canReceive = true;
  const [view, setView] = useQueryParam('view', canEdit ? 'all' : 'expected');
  const [q, setQ] = useQueryParam('q', '');
  const [openId, setOpenId] = useQueryParam('o', '');
  const [orders, setOrders] = useState(null);
  const [counts, setCounts] = useState({ needs_request: 0, requested: 0, expected: 0 });
  const [error, setError] = useState('');
  // The form is in the URL (?e=new | ?e=<id>) so Back leaves it, like every other step
  // on this page (QA: Back changed the URL but left the form on screen).
  const [editing, setEditingRaw] = useQueryParam('e', '');
  const openEditor = (v) => setEditingRaw(String(v), { replace: false });

  async function load() {
    try {
      const r = await api.onlineOrders({ q: q.trim(), view });
      setOrders(r.orders || []); setCounts(r.counts || {}); setError('');
    } catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
  }
  useEffect(() => { const t = setTimeout(load, q ? 300 : 0); return () => clearTimeout(t); }, [q, view]); // eslint-disable-line react-hooks/exhaustive-deps
  useLive(['online_orders', 'online_order_lines'], async () => {
    const r = await api.onlineOrders({ q: q.trim(), view });
    const next = r.orders || [];
    setOrders((cur) => (JSON.stringify(cur) === JSON.stringify(next) ? cur : next));
    setCounts(r.counts || {});
  }, { mount: false, paused: !!editing });

  if (editing && canEdit) {
    return (
      <div className="app">
        <TopBar title="Online Orders" onHome={onHome} onSignOut={onSignOut} />
        <EditLoader id={editing === 'new' ? null : editing} onSignOut={onSignOut}
          onCancel={() => setEditingRaw('')}
          onSaved={(id) => { setEditingRaw('', { replace: true }); setOpenId(String(id), { replace: true }); load(); }} />
      </div>
    );
  }
  if (openId) {
    return (
      <div className="app">
        <TopBar title="Online Orders" onHome={onHome} onSignOut={onSignOut} />
        <OrderDetail id={openId} canEdit={canEdit} canReceive={canReceive} onSignOut={onSignOut}
          onBack={() => setOpenId('')} onEdit={(o) => openEditor(o.id)} onDeleted={() => { setOpenId(''); load(); }} />
      </div>
    );
  }

  const followUps = (counts.needs_request || 0) + (counts.requested || 0);
  return (
    <div className="app">
      <TopBar title="Online Orders" onHome={onHome} onSignOut={onSignOut} />
      <div className="card">
        <p className="muted sm">
          {canEdit
            ? 'Shoes bought from an online store — what was ordered, the tracking number once it ships, and what each pair actually cost after the coupon, tax, shipping, gift card discount and cashback. Cancelled or missing pairs keep their refund here until it is back.'
            : 'Shoes the PH team bought online. “Expected” is what is on its way — when the parcel lands, open the order and count it in.'}
        </p>
        <div className="oo-toolbar">
          <div className="seg sm" role="group" aria-label="Show">
            {VIEWS.map(([k, label, badge]) => {
              const n = badge === 'expected' ? counts.expected : badge === 'followup' ? followUps : 0;
              return (
                <button key={k} type="button" className={`seg-btn${view === k ? ' on' : ''}`} aria-pressed={view === k}
                  onClick={() => setView(k)}>
                  {label}{n ? <span className="seg-n">{n}</span> : null}
                </button>
              );
            })}
          </div>
          <input type="search" className="oo-search" value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Store, order #, tracking #, SKU…" aria-label="Search online orders" />
          {canEdit && <button type="button" className="btn primary" onClick={() => openEditor('new')}>+ New order</button>}
        </div>
        {view === 'followup' && followUps > 0 && (
          <p className="muted sm">
            <b>{counts.needs_request || 0}</b> not asked for yet · <b>{counts.requested || 0}</b> asked and waiting — oldest first inside each order.
          </p>
        )}
      </div>
      {error && <div className="error mt">{error}</div>}
      <div className="card">
        {orders == null ? <p className="muted">Loading…</p> : !orders.length ? (
          <p className="muted">{q ? `Nothing matches “${q}”.` : view === 'expected' ? 'Nothing on its way right now.' : view === 'followup' ? 'No refunds waiting — every cancelled pair is settled.' : 'No online orders yet.'}</p>
        ) : (
          <div className="oo-list">
            {orders.map((o) => <OrderRow key={o.id} o={o} onOpen={() => setOpenId(String(o.id), { replace: false })} />)}
          </div>
        )}
      </div>
    </div>
  );
}

function StagePill({ stage }) {
  return <span className={`oo-stage ${stage}`}>{STAGE_LABEL[stage] || stage}</span>;
}

function OrderRow({ o, onOpen }) {
  const active = o.lines.filter((l) => !isCancelled(l));
  const cancelledPairs = o.lines.filter(isCancelled).reduce((n, l) => n + l.qty, 0);
  const chase = o.lines.filter(needsFollowUp);
  return (
    <button type="button" className="oo-row" onClick={onOpen}>
      <span className="oo-row-main">
        <span className="oo-row-title"><b>{orderCode(o.id)}</b> · {o.store}{o.order_number ? <span className="muted"> · #{o.order_number}</span> : null} <StagePill stage={o.stage} /></span>
        <span className="muted sm">
          {o.tracking_number ? <>Tracking {o.tracking_number}</> : 'No tracking number yet'} · ordered {dateOf(o.ordered_on)}
        </span>
        <span className="muted sm oo-row-skus">{active.map((l) => `${l.sku} US ${l.size}${l.qty > 1 ? ` ×${l.qty}` : ''}`).join(' · ') || '—'}</span>
      </span>
      <span className="oo-row-side">
        <span><b>{o.totals.units}</b> pair{o.totals.units === 1 ? '' : 's'} · <b>{money(o.totals.total)}</b></span>
        {cancelledPairs > 0 && <span className="oo-chip muted">{cancelledPairs} cancelled / missing</span>}
        {chase.length > 0 && <span className="oo-chip warn">{chase.length} refund{chase.length === 1 ? '' : 's'} to chase</span>}
      </span>
    </button>
  );
}

// ---- One order ---------------------------------------------------------------------
function OrderDetail({ id, canEdit, canReceive, onSignOut, onBack, onEdit, onDeleted }) {
  const [data, setData] = useState(null);   // { order, events }
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState(null); // { kind, line? }

  async function load() {
    try { setData(await api.onlineOrder(id)); setError(''); }
    catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
  }
  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useLive(['online_orders', 'online_order_lines', 'online_order_events'], async () => {
    const d = await api.onlineOrder(id);
    setData((cur) => (JSON.stringify(cur) === JSON.stringify(d) ? cur : d));
  }, { mount: false, paused: !!dialog });

  if (error && !data) return <div className="card"><div className="error">{error}</div><button className="btn ghost sm mt" onClick={onBack}>← Online orders</button></div>;
  if (!data) return <div className="card"><p className="muted">Loading…</p></div>;
  const o = data.order;
  const active = o.lines.filter((l) => !isCancelled(l));
  const gone = o.lines.filter(isCancelled);
  // Dialogs show a failure inside themselves (FormModal catches the throw); the one-tap
  // buttons on a cancelled line have no dialog, so they say it on the page (QA).
  const act = async (body) => { await api.onlineOrderLine(body); setDialog(null); load(); };
  const actNow = async (body) => {
    try { setError(''); await act(body); }
    catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); load(); }
  };

  return (
    <>
      <div className="card">
        <button type="button" className="btn ghost sm" onClick={onBack}>← Online orders</button>
        <h2 className="oo-title">{orderCode(o.id)} · {o.store} <StagePill stage={o.stage} /></h2>
        <div className="oo-facts">
          <span><span className="muted xs">Order #</span> {o.order_number || '—'}</span>
          <span><span className="muted xs">Ordered</span> {dateOf(o.ordered_on)}</span>
          <span><span className="muted xs">Tracking</span> {o.tracking_number || <i className="muted">none yet</i>}</span>
          {o.received_at && <span><span className="muted xs">Counted in</span> {when(o.received_at)}{o.received_by ? ` · ${o.received_by}` : ''}</span>}
          <span><span className="muted xs">Recorded by</span> {o.created_by || '—'}</span>
        </div>
        {o.note && <p className="oo-note">{o.note}</p>}
        <div className="oo-actions">
          {canEdit && <button type="button" className="btn sm" onClick={() => onEdit(o)}>{o.tracking_number ? 'Edit order' : 'Edit · add tracking #'}</button>}
          {/* Ordered too: a parcel that turns up before anyone typed its tracking number
              still gets counted in (QA). */}
          {canReceive && (o.stage === 'shipped' || o.stage === 'ordered') && <button type="button" className="btn sm primary" onClick={() => setDialog({ kind: 'receive' })}>Count it in…</button>}
          {canEdit && !o.received_at && <button type="button" className="btn sm ghost oo-danger" onClick={() => setDialog({ kind: 'delete' })}>Delete</button>}
        </div>
        {error && <div className="error mt">{error}</div>}
      </div>

      <div className="card">
        <h3 className="rows-title">{o.received_at ? 'Received' : 'Coming'} <span className="muted">({active.reduce((n, l) => n + l.qty, 0)} pair{active.reduce((n, l) => n + l.qty, 0) === 1 ? '' : 's'})</span></h3>
        {!active.length ? <p className="muted">Nothing — every line was cancelled.</p> : (
          <table className="oo-lines">
            <thead><tr><th>Shoe</th><th>Size</th><th>Qty</th><th>Price ea</th><th title="Price − coupon share + tax share + shipping share, less the gift card discount and the cashback share">Actual cost ea</th><th /></tr></thead>
            <tbody>
              {active.map((l) => (
                <tr key={l.id}>
                  <td><b>{l.sku}</b>{l.name ? <span className="muted sm"> {l.name}</span> : null}</td>
                  <td>{l.size}</td>
                  <td>{l.qty}</td>
                  <td>{money(l.unit_price)}</td>
                  <td title={l.parts ? `$${l.parts.price} − coupon $${l.parts.coupon} + tax $${l.parts.tax} + shipping $${l.parts.shipping} − gift card $${l.parts.gc}${l.parts.cashback ? ` − cashback $${l.parts.cashback}` : ''}` : ''}><b>{money(l.each)}</b></td>
                  {/* Once counted in, these pairs are on the shelf — nothing left to cancel. */}
                  <td>{canEdit && !o.received_at && <button type="button" className="btn sm ghost" onClick={() => setDialog({ kind: 'cancel', line: l })}>Cancel…</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="oo-money">
          <span>Subtotal {money(o.totals.subtotal)}</span>
          <span>− coupon {money(o.coupon)}</span>
          <span>+ tax {money(o.tax)}</span>
          <span>+ shipping {money(o.shipping)}</span>
          <span>= paid {money(o.totals.paid)}</span>
          {o.gc_pct > 0 && <span>− gift card {Number(o.gc_pct)}%</span>}
          {o.cashback > 0 && <span>− cashback {money(o.cashback)}</span>}
          <b>Actual cost {money(o.totals.total)}</b>
        </div>
      </div>

      {gone.length > 0 && (
        <div className="card">
          <h3 className="rows-title">Cancelled &amp; not delivered <span className="muted">— the refund is tracked until it is back</span></h3>
          <div className="oo-gone">
            {gone.map((l) => <CancelledLine key={l.id} l={l} canEdit={canEdit && !o.received_at} canChase={canEdit} onDialog={setDialog} onAct={actNow} />)}
          </div>
        </div>
      )}

      <div className="card">
        <h3 className="rows-title">History</h3>
        <ol className="oo-history">
          {data.events.map((e) => (
            <li key={e.id}><span className="muted sm">{when(e.at)} · {e.actor || '—'}</span> <b>{EVENT_LABEL[e.action] || e.action}</b>{e.detail ? ` — ${e.detail}` : ''}</li>
          ))}
        </ol>
      </div>

      {dialog?.kind === 'cancel' && (
        <FormModal title={`Cancel ${dialog.line.sku} US ${dialog.line.size}`}
          message="Cancelled pairs come off the order's cost and stay here with their refund until it is settled."
          fields={[
            ...(dialog.line.qty > 1 ? [{ name: 'qty', label: `How many of the ${dialog.line.qty}?`, type: 'number', min: 1, max: dialog.line.qty, value: String(dialog.line.qty), required: true }] : []),
            { name: 'reason', label: 'Why', type: 'select', value: 'oot', options: CANCEL_REASONS.map(([value, label]) => ({ value, label })) },
            { name: 'refund', label: 'Refund', type: 'select', value: 'refunded', options: [{ value: 'refunded', label: 'Refunded with the cancellation' }, { value: 'needs_request', label: 'Not yet — needs follow-up' }] },
            { name: 'amount', label: 'Amount refunded (if refunded)', type: 'number', step: '0.01', min: 0, value: dialog.line.lineTotal != null ? String(dialog.line.lineTotal.toFixed(2)) : '', hint: 'What came back — checked at the audit.' },
            { name: 'note', label: 'Note', type: 'textarea', rows: 2, placeholder: 'e.g. store email 10/01, size sold out' },
          ]}
          submitLabel="Cancel pairs" danger onClose={() => setDialog(null)}
          onSubmit={(v) => act({ lineId: dialog.line.id, action: 'cancel', qty: Number(v.qty || dialog.line.qty), reason: v.reason, refund: v.refund, amount: v.refund === 'refunded' ? v.amount : '', note: v.note })} />
      )}
      {dialog?.kind === 'requested' && (
        <FormModal title="Refund requested" message={`${dialog.line.qty} × ${dialog.line.sku} US ${dialog.line.size} — the line moves to “waiting” and shows how long it has been.`}
          fields={[{ name: 'note', label: 'How was it asked?', type: 'textarea', rows: 2, placeholder: 'e.g. chat with the store, ticket #48213' }]}
          submitLabel="Mark requested" onClose={() => setDialog(null)}
          onSubmit={(v) => act({ lineId: dialog.line.id, action: 'refund', to: 'requested', note: v.note })} />
      )}
      {dialog?.kind === 'refunded' && (
        <FormModal title="Refund received" message={`${dialog.line.qty} × ${dialog.line.sku} US ${dialog.line.size}`}
          fields={[
            { name: 'amount', label: 'Amount that came back', type: 'number', step: '0.01', min: 0, required: true, value: dialog.line.unit_price != null ? String((dialog.line.unit_price * dialog.line.qty).toFixed(2)) : '' },
            { name: 'note', label: 'Note', type: 'textarea', rows: 2, placeholder: 'e.g. back on the card 10/08' },
          ]}
          submitLabel="Mark refunded" onClose={() => setDialog(null)}
          onSubmit={(v) => act({ lineId: dialog.line.id, action: 'refund', to: 'refunded', amount: v.amount, note: v.note })} />
      )}
      {dialog?.kind === 'receive' && (
        <FormModal title={`Count in ${orderCode(o.id)}`}
          message="How many of each actually arrived? Anything short is recorded as not delivered, with its refund to follow up."
          fields={active.map((l) => ({ name: `l${l.id}`, label: `${l.sku} US ${l.size} — ordered ${l.qty}`, type: 'number', min: 0, max: l.qty, value: String(l.qty), required: true }))}
          submitLabel="Record the count" onClose={() => setDialog(null)}
          onSubmit={async (v) => {
            await api.receiveOnlineOrder(o.id, active.map((l) => ({ lineId: l.id, got: Number(v[`l${l.id}`]) })));
            setDialog(null); load();
          }} />
      )}
      {dialog?.kind === 'delete' && (
        <Modal type="warn" title={`Delete ${orderCode(o.id)}?`}
          message="Only for an order recorded by mistake. A real order that fell through is cancelled line by line instead, so its refund stays traceable."
          onClose={() => setDialog(null)}>
          <button className="btn danger" onClick={async () => {
            try { await api.deleteOnlineOrder(o.id); onDeleted(); } catch (err) { setError(err.message); setDialog(null); }
          }}>Delete order</button>
          <button className="btn ghost" onClick={() => setDialog(null)}>Keep it</button>
        </Modal>
      )}
    </>
  );
}

const EVENT_LABEL = {
  created: 'Recorded', edited: 'Edited', cancelled: 'Cancelled', restored: 'Cancellation undone', received: 'Counted in',
  refund_requested: 'Refund requested', refund_refunded: 'Refund received', refund_needs_request: 'Refund back to follow-up',
};

function CancelledLine({ l, canEdit, canChase, onDialog, onAct }) {
  const waited = daysSince(l.refund_requested_at);
  return (
    <div className={`oo-gone-row ${l.refund || ''}`}>
      <div>
        <b>{l.qty} × {l.sku}</b> US {l.size} <span className="muted sm">· {money(l.unit_price)} ea</span>
        <div className="muted sm">
          {REASON_LABEL[l.cancel_reason] || 'Cancelled'}{l.cancel_note ? ` — ${l.cancel_note}` : ''} · {when(l.cancelled_at)}{l.cancelled_by ? ` · ${l.cancelled_by}` : ''}
        </div>
      </div>
      <div className="oo-refund">
        <span className={`oo-refund-state ${l.refund}`}>
          {l.refund === 'refunded'
            ? <>Refunded {money(l.refund_amount)}{l.refunded_at ? ` · ${when(l.refunded_at)}` : ''}</>
            : l.refund === 'requested'
              ? <>Requested {waited === 0 ? 'today' : `${waited} day${waited === 1 ? '' : 's'} ago`} — waiting</>
              : REFUND_STATES.needs_request}
        </span>
        {l.refund_note && <span className="muted sm">{l.refund_note}</span>}
        {canChase && (
          <span className="oo-refund-acts">
            {l.refund === 'needs_request' && <button type="button" className="btn sm" onClick={() => onDialog({ kind: 'requested', line: l })}>Mark requested…</button>}
            {l.refund !== 'refunded' && <button type="button" className="btn sm primary" onClick={() => onDialog({ kind: 'refunded', line: l })}>Refund received…</button>}
            {l.refund === 'refunded' && <button type="button" className="btn sm ghost" onClick={() => onAct({ lineId: l.id, action: 'refund', to: 'needs_request' })}>Not actually back</button>}
            {canEdit && l.cancel_reason !== 'not_delivered' && <button type="button" className="btn sm ghost" onClick={() => onAct({ lineId: l.id, action: 'restore' })}>Undo cancel</button>}
          </span>
        )}
      </div>
    </div>
  );
}

// ---- New / edit ----------------------------------------------------------------------
// The form opens from the URL, so an edit fetches the order it is editing fresh — which
// is also what makes the stale-form guard below meaningful.
function EditLoader({ id, onCancel, onSaved, onSignOut }) {
  const [order, setOrder] = useState(id ? null : false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!id) { setOrder(false); return; }
    api.onlineOrder(id).then((r) => setOrder(r.order)).catch((err) => { if (err.unauthorized) return onSignOut(); setError(err.message); });
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (error) return <div className="card"><div className="error">{error}</div><button className="btn ghost sm mt" onClick={onCancel}>Back</button></div>;
  if (order === null) return <div className="card"><p className="muted">Loading…</p></div>;
  return <OrderForm key={id || 'new'} initial={order || null} onCancel={onCancel} onSaved={onSaved} onSignOut={onSignOut} />;
}

function OrderForm({ initial, onCancel, onSaved, onSignOut }) {
  const [f, setF] = useState(() => ({
    store: initial?.store || '', order_number: initial?.order_number || '', tracking_number: initial?.tracking_number || '',
    ordered_on: initial?.ordered_on || estToday(),
    coupon: initial ? String(initial.coupon || '') : '', tax: initial ? String(initial.tax || '') : '',
    shipping: initial ? String(initial.shipping || '') : '', gc_pct: initial ? String(initial.gc_pct || '') : '',
    cashback: initial ? String(initial.cashback || '') : '',
    note: initial?.note || '',
  }));
  const [lines, setLines] = useState(() => {
    const act = (initial?.lines || []).filter((l) => !isCancelled(l))
      .map((l) => ({ key: String(l.id), sku: l.sku, name: l.name || '', size: l.size, qty: String(l.qty), unit_price: String(l.unit_price) }));
    return act.length ? act : [blankLine()];
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dup, setDup] = useState(null);
  const set = (k) => (v) => setF((s) => ({ ...s, [k]: v }));
  const setLine = (key, k, v) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, [k]: v } : l)));
  // The same function the server applies — what's shown while typing is what gets saved.
  const cost = useMemo(() => orderCosts(f, lines.filter((l) => l.sku || l.unit_price).map((l) => ({ ...l, qty: Number(l.qty) || 0 }))), [f, lines]);
  const cancelledCount = (initial?.lines || []).filter(isCancelled).length;

  async function save(allowDuplicateTracking = false) {
    setBusy(true); setError('');
    try {
      // The active lines this form was built from — the server refuses the save if they
      // changed underneath it (a cancel or a count in another tab).
      const baseLineIds = initial ? initial.lines.filter((l) => !isCancelled(l)).map((l) => l.id) : undefined;
      const r = await api.saveOnlineOrder({ id: initial?.id, ...f, lines: lines.map(({ key, ...l }) => l), allowDuplicateTracking, baseLineIds });
      onSaved(r.id);
    } catch (err) {
      if (err.unauthorized) return onSignOut();
      if (err.status === 409 && err.data?.duplicate) setDup(err.data.duplicate);
      else setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="card oo-form">
      <h2 className="oo-title">{initial ? `Edit ${orderCode(initial.id)}` : 'New online order'}</h2>
      <div className="oo-form-grid">
        <label><span className="muted xs">Store *</span><input value={f.store} onChange={(e) => set('store')(e.target.value)} placeholder="Nike.com, Foot Locker…" maxLength={120} /></label>
        <label><span className="muted xs">Order #</span><input value={f.order_number} onChange={(e) => set('order_number')(e.target.value)} maxLength={80} /></label>
        <label><span className="muted xs">Tracking #</span><input value={f.tracking_number} onChange={(e) => set('tracking_number')(e.target.value)} placeholder="Add it once the order ships" maxLength={60} /></label>
        <label><span className="muted xs">Ordered on</span><input type="date" value={f.ordered_on} onChange={(e) => set('ordered_on')(e.target.value)} /></label>
      </div>
      {!f.tracking_number.trim() && <p className="muted sm">No tracking number yet — the order is saved as <b>Ordered</b> and reaches the warehouse’s “Expected” list once one is added.</p>}

      <h3 className="rows-title">Shoes</h3>
      <table className="oo-lines oo-lines-edit">
        <thead><tr><th>SKU *</th><th>Name</th><th>Size *</th><th>Qty</th><th>Price ea *</th><th>Actual ea</th><th /></tr></thead>
        <tbody>
          {lines.map((l, i) => {
            const c = cost.lines.find((x) => x.key === l.key);
            return (
              <tr key={l.key}>
                <td><input value={l.sku} onChange={(e) => setLine(l.key, 'sku', e.target.value.toUpperCase())} aria-label={`Line ${i + 1} SKU`} maxLength={60} /></td>
                <td><input value={l.name} onChange={(e) => setLine(l.key, 'name', e.target.value)} aria-label={`Line ${i + 1} name`} maxLength={200} /></td>
                <td><input className="oo-size" value={l.size} onChange={(e) => setLine(l.key, 'size', e.target.value)} aria-label={`Line ${i + 1} size`} maxLength={20} /></td>
                <td><input className="oo-qty" type="number" min="1" inputMode="numeric" value={l.qty} onChange={(e) => setLine(l.key, 'qty', e.target.value)} aria-label={`Line ${i + 1} quantity`} /></td>
                <td><input className="oo-price" type="number" min="0" step="0.01" inputMode="decimal" value={l.unit_price} onChange={(e) => setLine(l.key, 'unit_price', e.target.value)} aria-label={`Line ${i + 1} price`} /></td>
                <td className="oo-each">{c?.each != null && l.unit_price !== '' ? money(c.each) : '—'}</td>
                <td>{lines.length > 1 && <button type="button" className="btn icon ghost remove sm" title="Remove line" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>×</button>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <button type="button" className="btn sm ghost" onClick={() => setLines((ls) => [...ls, blankLine()])}>+ Add a shoe</button>
      {cancelledCount > 0 && <p className="muted sm">{cancelledCount} cancelled line{cancelledCount === 1 ? '' : 's'} are kept as they are — their refunds are tracked on the order.</p>}

      <h3 className="rows-title">The order’s money</h3>
      <div className="oo-money-fields">
        <NumField label="Coupon" prefix="$" value={f.coupon} onChange={set('coupon')} hint="Split evenly per pair" />
        <NumField label="Tax" prefix="$" value={f.tax} onChange={set('tax')} hint="Split by price" />
        <NumField label="Shipping" prefix="$" value={f.shipping} onChange={set('shipping')} hint="Split by price" />
        <NumField label="Gift card discount" suffix="%" value={f.gc_pct} onChange={set('gc_pct')} hint="Off everything paid" />
        <NumField label="Cashback" prefix="$" value={f.cashback} onChange={set('cashback')} hint="Off the whole cost, split by price" />
      </div>
      <div className="oo-money">
        <span>{cost.units} pair{cost.units === 1 ? '' : 's'}</span>
        <span>Subtotal {money(cost.subtotal)}</span>
        <span>Paid {money(cost.paid)}</span>
        {cost.cashback > 0 && <span>− cashback {money(cost.cashback)}</span>}
        <b>Actual cost {money(cost.total)}</b>
      </div>
      <label className="oo-note-field"><span className="muted xs">Note</span>
        <textarea rows={2} value={f.note} onChange={(e) => set('note')(e.target.value)} maxLength={1000} placeholder="Anything the audit should know" /></label>
      {error && <div className="error mt">{error}</div>}
      <div className="oo-actions">
        <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>Back</button>
        <button type="button" className="btn primary" onClick={() => save(false)} disabled={busy}>{busy ? 'Saving…' : 'Save order'}</button>
      </div>
      {dup && (
        <Modal type="warn" title="Tracking number already used"
          message={`${orderCode(dup.id)} (${dup.store}${dup.order_number ? ` #${dup.order_number}` : ''}) already has this tracking number. Save anyway only if both orders really came in one parcel.`}
          onClose={() => setDup(null)}>
          <button className="btn primary" onClick={() => { setDup(null); save(true); }}>Save anyway</button>
          <button className="btn ghost" onClick={() => setDup(null)}>Fix the number</button>
        </Modal>
      )}
    </div>
  );
}
