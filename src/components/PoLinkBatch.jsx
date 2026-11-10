// Attach an ALREADY-RECEIVED batch to its purchase order.
//
// "Receive against a purchase order" is a step-1 choice in the receiving wizard, so when
// PH opens the order while the warehouse is already scanning the box — it arrived before
// the paperwork did — the two could never be joined afterwards. The order read as
// outstanding forever and its reconciliation showed nothing arriving, while the stock was
// already on the shelf.
//
// Two ways in, one confirmation:
//   • PoLinkBatchModal — from the ORDER (PH Purchase Orders): pick the shipment.
//   • BatchLinkPoModal — from the SHIPMENT (Batch page): pick the order. Added after
//     PO-100107, whose 28 boxes were each scanned in with no order picked — the person
//     looking at the batch is the one who notices, and had no way to fix it there.
// Both then confirm which received box is which label (LinkBoxesSteps) and post the same
// POST /api/po/link-batch. See docs/context/purchase-orders.md.
import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { Icon } from './NavIcons.jsx';
import { expectsAtOrderLevel } from '../lib/postatus.js';

const SHIPPED = ['shipped', 'in_transit', 'delivered'];
const fmtDate = (d) => (d ? String(d).slice(0, 10) : '—');

// The box ↔ label confirmation for one (order, batch) pair: loads the batch's boxes
// pre-matched to the order's labels by tracking number, and works out what the order will
// read once linked. `po` needs id + manifest_scope; `lines` are the order's po_lines.
function useLinkPreview({ po, lines, batchId, onSignOut, setError }) {
  const [preview, setPreview] = useState(null); // { batch, units, boxes, labels }
  const [choice, setChoice] = useState({});     // received box key -> po_box id ('' = none)
  const [shipLabels, setShipLabels] = useState(true);

  useEffect(() => {
    if (!po?.id || batchId == null) { setPreview(null); return; }
    let cancelled = false;
    setError(''); setPreview(null);
    api.poLinkCandidates(po.id, batchId)
      .then((r) => {
        if (cancelled) return;
        setPreview(r.preview || null);
        const init = {};
        for (const b of r.preview?.boxes || []) init[String(b.id ?? 'batch')] = b.matchedPoBoxId ?? '';
        setChoice(init);
      })
      .catch((e) => { if (e.unauthorized) return onSignOut?.(); if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [batchId, po?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const labels = preview?.labels || [];
  const chosenIds = Object.values(choice).map(Number).filter(Boolean);
  // Labels the supplier never scanned out. They matter more than they look: a per-label
  // manifest counts only lines on SHIPPED labels, so leaving these behind makes a fully
  // delivered order read as "received blind" with every pair an overage.
  const stuck = labels.filter((l) => chosenIds.includes(Number(l.id)) && ['pending', 'packed'].includes(l.status));
  // Whether a label's shipping status moves `expected`. It does under a per-label
  // manifest; it does NOT once the order carries its own list — there, a label still
  // sitting at the buyer means pairs are awaiting, not that the order reads blind.
  const perLabel = po ? !expectsAtOrderLevel(po) : true;

  // What the order will read once this is linked — the same arithmetic reconciliation
  // does, so a surprise shows up here rather than after the fact.
  const expectedUnits = useMemo(() => {
    if (!po) return 0;
    const willShip = shipLabels ? stuck.map((l) => Number(l.id)) : [];
    return (lines || []).filter((l) => {
      if (expectsAtOrderLevel(po)) return l.po_box_id == null;
      const lb = labels.find((b) => Number(b.id) === Number(l.po_box_id));
      if (!lb || lb.kind === 'replacement') return false;
      return SHIPPED.includes(lb.status) || willShip.includes(Number(lb.id));
    }).reduce((n, l) => n + (l.qty_expected || 0), 0);
  }, [lines, labels, shipLabels, stuck, po?.manifest_scope]); // eslint-disable-line react-hooks/exhaustive-deps

  const unmatched = (preview?.boxes || []).filter((b) => !Number(choice[String(b.id ?? 'batch')]));

  const payload = () => ({
    poId: po.id,
    batchId,
    boxMap: Object.entries(choice)
      .filter(([, poBoxId]) => Number(poBoxId))
      .map(([key, poBoxId]) => ({ boxId: key === 'batch' ? null : Number(key), poBoxId: Number(poBoxId) })),
    shipLabels: shipLabels && stuck.length > 0,
  });

  return { preview, labels, choice, setChoice, shipLabels, setShipLabels, stuck, perLabel, expectedUnits, unmatched, payload };
}

// Steps 2–3 + the "this order will read …" line, shared by both modals.
function LinkBoxesSteps({ s }) {
  if (!s.preview) return null;
  return (
    <>
      <div className="po-link-step">
        <div className="po-link-step-head">
          <b>2. Which box is which label?</b>
          <span className="muted xs">Matched by tracking number where the warehouse entered one.</span>
        </div>
        <div className="po-link-rows">
          {s.preview.boxes.map((b) => {
            const key = String(b.id ?? 'batch');
            return (
              <div className="po-link-row" key={key}>
                <span className="po-link-box">
                  Box {b.box_number} <span className="muted sm">· {b.units} unit{b.units === 1 ? '' : 's'}</span>
                  <span className="po-link-track muted xs">{b.tracking_number || 'no tracking entered'}</span>
                </span>
                <select value={s.choice[key] ?? ''} onChange={(e) => s.setChoice((c) => ({ ...c, [key]: e.target.value }))}>
                  <option value="">— not on this order —</option>
                  {s.labels.map((l) => (
                    <option key={l.id} value={l.id}>
                      Label #{l.box_number} · {l.tracking_number || 'no tracking'}{l.kind === 'replacement' ? ' (replacement)' : ''}
                    </option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>
        {s.unmatched.length > 0 && (
          <p className="po-link-warn">
            {s.unmatched.length} box{s.unmatched.length === 1 ? '' : 'es'} left unmatched. Its units still
            count toward this order — a batch belongs to one order as a whole — so only link a batch
            whose boxes really are this shipment.
          </p>
        )}
      </div>

      {/* 3 — the trap: labels the supplier never scanned out */}
      {s.perLabel && s.stuck.length > 0 && (
        <div className="po-link-step">
          <div className="po-link-step-head"><b>3. The supplier never marked these shipped</b></div>
          <label className="po-link-check">
            <input type="checkbox" checked={s.shipLabels} onChange={(e) => s.setShipLabels(e.target.checked)} />
            <span>
              Record label{s.stuck.length === 1 ? '' : 's'} {s.stuck.map((l) => `#${l.box_number}`).join(', ')} as
              shipped — they physically did, we received them.
              <span className="muted xs">
                Only shipped labels count as expected. Leave this off and the order reads
                “received blind”, with every pair arriving as an overage.
              </span>
            </span>
          </label>
        </div>
      )}

      <div className="po-link-summary">
        This shipment adds <b>{s.preview.units}</b> received against the order’s <b>{s.expectedUnits}</b> expected
        {s.expectedUnits === 0 ? <span className="po-link-warn-inline"> — nothing declared counts yet</span>
          : s.preview.units === s.expectedUnits ? <span className="po-link-ok-inline"> — the totals match</span>
            : null}.
      </div>
    </>
  );
}

export function PoLinkBatchModal({ po, lines = [], onClose, onLinked, onSignOut }) {
  const [batches, setBatches] = useState(null);
  const [pick, setPick] = useState(null);      // chosen batch id
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const s = useLinkPreview({ po, lines, batchId: pick, onSignOut, setError });

  useEffect(() => {
    api.poLinkCandidates(po.id)
      .then((r) => setBatches(r.batches || []))
      .catch((e) => { if (e.unauthorized) return onSignOut?.(); setError(e.message); });
  }, [po.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit() {
    setBusy(true); setError('');
    try {
      await api.poLinkBatch(s.payload());
      onLinked?.();
    } catch (e) {
      if (e.unauthorized) return onSignOut?.();
      setError(e.message);
    } finally { setBusy(false); }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal po-link" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3 className="modal-title">Link a received shipment · <span className="po-code">{po.po_code}</span></h3>
          <button type="button" className="btn icon ghost" onClick={onClose}>×</button>
        </div>
        <p className="muted sm">
          For a shipment the warehouse already scanned in before this order existed. Linking it
          tells the order what actually arrived — the stock itself isn’t touched.
        </p>

        {/* 1 — which batch */}
        <div className="po-link-step">
          <div className="po-link-step-head"><b>1. Which shipment?</b></div>
          {batches == null ? <p className="muted sm">Looking for batches from {po.supplier_name}…</p>
            : batches.length === 0 ? (
              <p className="muted sm">
                No batch from {po.supplier_name} in the last 120 days, and none carrying one of this
                order’s tracking numbers. If it was received under a different supplier name, fix that
                on the batch first.
              </p>
            ) : (
              <div className="po-link-batches">
                {batches.map((b) => {
                  const on = Number(pick) === Number(b.id);
                  const linked = b.po_id != null;
                  return (
                    <button type="button" key={b.id} className={`po-link-batch ${on ? 'on' : ''}`}
                      onClick={() => setPick(on ? null : Number(b.id))}>
                      <span className="po-link-batch-code">{b.batch_code}</span>
                      <span className="po-link-batch-meta muted sm">
                        {b.units} unit{b.units === 1 ? '' : 's'} · {b.box_count || 1} box{b.box_count === 1 ? '' : 'es'}
                        {' · '}{fmtDate(b.date_received || b.created_at)} · {b.supplier_name || '—'}
                        {linked && <span className="po-link-already"> · already linked</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
        </div>

        <LinkBoxesSteps s={s} />

        {error && <div className="error sm mt">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn primary" disabled={!pick || busy || !s.preview} onClick={submit}>
            {busy ? 'Linking…' : <><Icon name="box" /> Link this shipment</>}
          </button>
        </div>
      </div>
    </div>
  );
}

// From the Batch page: this shipment was received without picking its order. Pick the
// order (a tracking match is pre-selected), confirm the boxes, link.
export function BatchLinkPoModal({ batch, initialPoId = null, onClose, onLinked, onSignOut }) {
  const [orders, setOrders] = useState(null);
  const [pick, setPick] = useState(initialPoId);   // chosen PO id
  const [full, setFull] = useState(null);          // { po, lines } of the chosen order
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const s = useLinkPreview({ po: full?.po, lines: full?.lines, batchId: full ? Number(batch.id) : null, onSignOut, setError });

  useEffect(() => {
    api.batchPoCandidates(batch.id)
      .then((r) => {
        const list = r.orders || [];
        setOrders(list);
        // One order carries this shipment's tracking number: that IS the answer, so
        // start on it rather than making someone find it in the list.
        const matched = list.filter((o) => o.matched_labels?.length);
        if (initialPoId == null && matched.length === 1) setPick(matched[0].id);
      })
      .catch((e) => { if (e.unauthorized) return onSignOut?.(); setError(e.message); });
  }, [batch.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // The order's lines are what "expected" is worked out from.
  useEffect(() => {
    if (pick == null) { setFull(null); return; }
    let cancelled = false;
    setFull(null); setError('');
    api.poGet(pick)
      .then((r) => { if (!cancelled) setFull({ po: r.po, lines: r.lines || [] }); })
      .catch((e) => { if (e.unauthorized) return onSignOut?.(); if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [pick]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit() {
    setBusy(true); setError('');
    try {
      await api.poLinkBatch(s.payload());
      onLinked?.(full?.po);
    } catch (e) {
      if (e.unauthorized) return onSignOut?.();
      setError(e.message);
    } finally { setBusy(false); }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal po-link" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3 className="modal-title">Link to a purchase order · <span className="po-code">{batch.batch_code}</span></h3>
          <button type="button" className="btn icon ghost" onClick={onClose}>×</button>
        </div>
        <p className="muted sm">
          For a shipment received without picking its order. Linking it tells the order what
          arrived, so it shows on Reconciliation — the pairs themselves aren’t touched.
        </p>

        <div className="po-link-step">
          <div className="po-link-step-head"><b>1. Which order?</b></div>
          {orders == null ? <p className="muted sm">Looking for orders…</p>
            : orders.length === 0 ? (
              <p className="muted sm">
                No open order carries this shipment’s tracking number, and none from
                {batch.supplier_name ? <> “{batch.supplier_name}”</> : ' this supplier'} in the last 120 days.
                If the supplier name on this batch is wrong, fix it first; a reconciled order has to be
                reopened before anything can be linked to it.
              </p>
            ) : (
              <div className="po-link-batches">
                {orders.map((o) => {
                  const on = Number(pick) === Number(o.id);
                  const m = o.matched_labels || [];
                  return (
                    <button type="button" key={o.id} className={`po-link-batch ${on ? 'on' : ''}`}
                      onClick={() => setPick(on ? null : Number(o.id))}>
                      <span className="po-link-batch-code">{o.po_code}</span>
                      <span className="po-link-batch-meta muted sm">
                        {o.supplier_name || '—'} · {o.status} · {o.label_count} label{o.label_count === 1 ? '' : 's'}
                        {' · '}{o.expected_units} expected · {fmtDate(o.created_at)}
                        {o.linked_batches > 0 && <> · {o.linked_batches} shipment{o.linked_batches === 1 ? '' : 's'} linked</>}
                        {m.length > 0 && <span className="po-link-match"> · tracking matches label{m.length === 1 ? '' : 's'} #{m.join(', #')}</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
        </div>

        {pick != null && !s.preview && !error && <p className="muted sm">Loading the order…</p>}
        <LinkBoxesSteps s={s} />

        {error && <div className="error sm mt">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn primary" disabled={pick == null || busy || !s.preview || !full} onClick={submit}>
            {busy ? 'Linking…' : <><Icon name="box" /> Link to {full?.po?.po_code || 'this order'}</>}
          </button>
        </div>
      </div>
    </div>
  );
}
