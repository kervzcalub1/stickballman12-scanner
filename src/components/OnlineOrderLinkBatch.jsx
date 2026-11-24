// Batch page → "Link to an online order". A parcel bought from an online store (Shoe
// Palace, JD Sports, …) is not a purchase order, so its batch had nothing to be linked
// to unless the tracking number happened to be typed on the order. Pick the order here:
// the ones carrying the batch's tracking number come first, then the ones that hold the
// most of the batch's pairs. Linking also fills the cost of any pair that has none, from
// the order's actual cost (docs/context/online-orders.md "Linked to a batch").
import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Icon } from './NavIcons.jsx';
import { estCivilFromYmd, PH_DATE } from '../lib/format.js';

const dateOf = (ymd) => (ymd ? PH_DATE.format(estCivilFromYmd(ymd)) : null);

// "IZ2563-133 7 ×10, 8 ×2" — enough to recognise the order without opening it.
function linesText(lines) {
  const list = (lines || []).slice(0, 6).map((l) => `${l.sku} ${l.size}${Number(l.qty) > 1 ? ` ×${l.qty}` : ''}`);
  return list.join(', ') + ((lines || []).length > 6 ? ` +${lines.length - 6} more` : '');
}

export function BatchLinkOnlineModal({ batch, initialOrderId = null, onClose, onLinked, onSignOut }) {
  const [orders, setOrders] = useState(null);
  const [pairs, setPairs] = useState(0);
  const [pick, setPick] = useState(initialOrderId == null ? null : Number(initialOrderId));
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const asked = useRef(0);

  // Only the latest search may land: a slow answer to "jd" must not replace "jd 6003".
  useEffect(() => {
    const n = asked.current + 1; asked.current = n;
    const t = setTimeout(() => {
      api.batchOnlineCandidates(batch.id, q.trim())
        .then((r) => {
          if (asked.current !== n) return;
          const list = r.orders || [];
          setOrders(list); setPairs(r.batch?.pairs || 0); setError('');
          // One order carries this parcel's tracking number: start on it.
          const matched = list.filter((o) => o.tracking_match);
          if (!q.trim() && initialOrderId == null && matched.length === 1) setPick((cur) => cur ?? matched[0].id);
        })
        .catch((e) => { if (e.unauthorized) return onSignOut?.(); if (asked.current === n) setError(e.message); });
    }, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [batch.id, q]); // eslint-disable-line react-hooks/exhaustive-deps

  const chosen = (orders || []).find((o) => Number(o.id) === Number(pick)) || null;

  async function submit() {
    if (pick == null) return;
    setBusy(true); setError('');
    try {
      const r = await api.batchLinkOnlineOrder(batch.id, pick);
      onLinked?.(r);
    } catch (e) {
      if (e.unauthorized) return onSignOut?.();
      setError(e.message);
    } finally { setBusy(false); }
  }

  return (
    <div className="modal-overlay" onClick={() => !busy && onClose()}>
      <div className="modal po-link" role="dialog" aria-modal="true" aria-label="Link to an online order" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3 className="modal-title">Link to an online order · <span className="po-code">{batch.batch_code}</span></h3>
          <button type="button" className="btn icon ghost" aria-label="Close" onClick={onClose} disabled={busy}>×</button>
        </div>
        <p className="muted sm">
          For a parcel bought from an online store, not from a supplier’s purchase order. Linking
          says which order this batch is, and fills the cost of any pair that has none from the
          order. Pairs that already have a cost are not changed.
        </p>

        <div className="po-link-step">
          <label className="oo-link-search">
            <span className="muted xs">Find the order</span>
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} autoFocus
              placeholder="Store, order number, OO-0263, tracking number or SKU"
              aria-label="Search online orders" />
          </label>
          {orders == null ? <p className="muted sm">Looking for orders…</p>
            : orders.length === 0 ? (
              <p className="muted sm">
                {q.trim()
                  ? 'No online order matches that. Check the spelling, or try the order number from the store’s email.'
                  : 'No online order from the last 60 days. Search by store, order number or SKU to find an older one — or it has not been recorded on Online Orders yet.'}
              </p>
            ) : (
              <div className="po-link-batches oo-link-list">
                {orders.map((o) => {
                  const on = Number(pick) === Number(o.id);
                  return (
                    <button type="button" key={o.id} className={`po-link-batch ${on ? 'on' : ''}`} aria-pressed={on}
                      onClick={() => setPick(on ? null : Number(o.id))}>
                      <span className="po-link-batch-code">{o.code} · {o.store}{o.order_number ? ` #${o.order_number}` : ''}</span>
                      <span className="po-link-batch-meta muted sm">
                        {[dateOf(o.ordered_on) || (o.created_at ? PH_DATE.format(new Date(o.created_at)) : null), `${o.pairs} pair${o.pairs === 1 ? '' : 's'}`, o.received_at ? 'counted in' : 'not counted in yet'].filter(Boolean).join(' · ')}
                        {o.tracking_match && <span className="po-link-match"> · tracking number matches</span>}
                        {pairs > 0 && o.on_order > 0 && <span className="po-link-match"> · {o.on_order} of this batch’s {pairs} pair{pairs === 1 ? '' : 's'} on it</span>}
                        {o.linked_batches.length > 0 && <> · already linked: {o.linked_batches.join(', ')}</>}
                      </span>
                      {o.lines.length > 0 && <span className="muted xs">{linesText(o.lines)}</span>}
                    </button>
                  );
                })}
              </div>
            )}
        </div>

        {chosen && pairs > 0 && chosen.on_order < pairs && (
          <p className="batch-po-hint sm mt">
            {chosen.on_order === 0
              ? `None of this batch’s ${pairs} pair${pairs === 1 ? ' is' : 's are'} on ${chosen.code}. Link it only if you are sure — the SKU or size may be typed differently on the order.`
              : `${pairs - chosen.on_order} of this batch’s ${pairs} pairs ${pairs - chosen.on_order === 1 ? 'is' : 'are'} not on ${chosen.code}.`}
          </p>
        )}
        {error && <div className="error sm mt">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn primary" disabled={pick == null || busy} onClick={submit}>
            {busy ? 'Linking…' : <><Icon name="box" /> Link to {chosen?.code || 'this order'}</>}
          </button>
        </div>
      </div>
    </div>
  );
}
