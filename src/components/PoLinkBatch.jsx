// Attach an ALREADY-RECEIVED batch to its purchase order.
//
// "Receive against a purchase order" is a step-1 choice in the receiving wizard, so when
// PH opens the order while the warehouse is already scanning the box — it arrived before
// the paperwork did — the two could never be joined afterwards. The order read as
// outstanding forever and its reconciliation showed nothing arriving, while the stock was
// already on the shelf.
//
// This screen is that repair: pick the batch, confirm which received box is which label,
// and say so. See docs/context/purchase-orders.md.
import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { Icon } from './NavIcons.jsx';

const SHIPPED = ['shipped', 'in_transit', 'delivered'];
const fmtDate = (d) => (d ? String(d).slice(0, 10) : '—');

export function PoLinkBatchModal({ po, lines = [], onClose, onLinked, onSignOut }) {
  const [batches, setBatches] = useState(null);
  const [pick, setPick] = useState(null);      // chosen batch id
  const [preview, setPreview] = useState(null); // { batch, units, boxes, labels }
  const [choice, setChoice] = useState({});     // received box key -> po_box id ('' = none)
  const [shipLabels, setShipLabels] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.poLinkCandidates(po.id)
      .then((r) => setBatches(r.batches || []))
      .catch((e) => { if (e.unauthorized) return onSignOut?.(); setError(e.message); });
  }, [po.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load the chosen batch's boxes, pre-matched to the order's labels by tracking number.
  useEffect(() => {
    if (pick == null) { setPreview(null); return; }
    setError(''); setPreview(null);
    api.poLinkCandidates(po.id, pick)
      .then((r) => {
        setPreview(r.preview || null);
        const init = {};
        for (const b of r.preview?.boxes || []) init[String(b.id ?? 'batch')] = b.matchedPoBoxId ?? '';
        setChoice(init);
      })
      .catch((e) => { if (e.unauthorized) return onSignOut?.(); setError(e.message); });
  }, [pick, po.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const labels = preview?.labels || [];
  const chosenIds = Object.values(choice).map(Number).filter(Boolean);
  // Labels the supplier never scanned out. They matter more than they look: a per-label
  // manifest counts only lines on SHIPPED labels, so leaving these behind makes a fully
  // delivered order read as "received blind" with every pair an overage.
  const stuck = labels.filter((l) => chosenIds.includes(Number(l.id)) && ['pending', 'packed'].includes(l.status));
  const perLabel = po.manifest_scope !== 'po';

  // What the order will read once this is linked — the same arithmetic reconciliation
  // does, so a surprise shows up here rather than after the fact.
  const expectedUnits = useMemo(() => {
    const willShip = shipLabels ? stuck.map((l) => Number(l.id)) : [];
    return (lines || []).filter((l) => {
      if (po.manifest_scope === 'po') return l.po_box_id == null;
      const lb = labels.find((b) => Number(b.id) === Number(l.po_box_id));
      if (!lb || lb.kind === 'replacement') return false;
      return SHIPPED.includes(lb.status) || willShip.includes(Number(lb.id));
    }).reduce((n, l) => n + (l.qty_expected || 0), 0);
  }, [lines, labels, shipLabels, stuck, po.manifest_scope]);

  const unmatched = (preview?.boxes || []).filter((b) => !Number(choice[String(b.id ?? 'batch')]));

  async function submit() {
    setBusy(true); setError('');
    try {
      const boxMap = Object.entries(choice)
        .filter(([, poBoxId]) => Number(poBoxId))
        .map(([key, poBoxId]) => ({ boxId: key === 'batch' ? null : Number(key), poBoxId: Number(poBoxId) }));
      await api.poLinkBatch({ poId: po.id, batchId: pick, boxMap, shipLabels: shipLabels && stuck.length > 0 });
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

        {/* 2 — which box is which label */}
        {preview && (
          <>
            <div className="po-link-step">
              <div className="po-link-step-head">
                <b>2. Which box is which label?</b>
                <span className="muted xs">Matched by tracking number where the warehouse entered one.</span>
              </div>
              <div className="po-link-rows">
                {preview.boxes.map((b) => {
                  const key = String(b.id ?? 'batch');
                  return (
                    <div className="po-link-row" key={key}>
                      <span className="po-link-box">
                        Box {b.box_number} <span className="muted sm">· {b.units} unit{b.units === 1 ? '' : 's'}</span>
                        <span className="po-link-track muted xs">{b.tracking_number || 'no tracking entered'}</span>
                      </span>
                      <select value={choice[key] ?? ''} onChange={(e) => setChoice((c) => ({ ...c, [key]: e.target.value }))}>
                        <option value="">— not on this order —</option>
                        {labels.map((l) => (
                          <option key={l.id} value={l.id}>
                            Label #{l.box_number} · {l.tracking_number || 'no tracking'}{l.kind === 'replacement' ? ' (replacement)' : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                  );
                })}
              </div>
              {unmatched.length > 0 && (
                <p className="po-link-warn">
                  {unmatched.length} box{unmatched.length === 1 ? '' : 'es'} left unmatched. Its units still
                  count toward this order — a batch belongs to one order as a whole — so only link a batch
                  whose boxes really are this shipment.
                </p>
              )}
            </div>

            {/* 3 — the trap: labels the supplier never scanned out */}
            {perLabel && stuck.length > 0 && (
              <div className="po-link-step">
                <div className="po-link-step-head"><b>3. The supplier never marked these shipped</b></div>
                <label className="po-link-check">
                  <input type="checkbox" checked={shipLabels} onChange={(e) => setShipLabels(e.target.checked)} />
                  <span>
                    Record label{stuck.length === 1 ? '' : 's'} {stuck.map((l) => `#${l.box_number}`).join(', ')} as
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
              This order will read <b>{preview.units}</b> received against <b>{expectedUnits}</b> expected
              {expectedUnits === 0 ? <span className="po-link-warn-inline"> — nothing declared counts yet</span>
                : preview.units === expectedUnits ? <span className="po-link-ok-inline"> — the totals match</span>
                  : <span className="po-link-warn-inline"> — off by {preview.units - expectedUnits}</span>}.
            </div>
          </>
        )}

        {error && <div className="error sm mt">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn primary" disabled={!pick || busy || !preview} onClick={submit}>
            {busy ? 'Linking…' : <><Icon name="box" /> Link this shipment</>}
          </button>
        </div>
      </div>
    </div>
  );
}
