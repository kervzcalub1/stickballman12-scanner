// PH "Purchase Orders" overview — every PO the team opened, with its status and
// per-label shipment tracking. Read-only: PH can see what they submitted to suppliers
// (draft → shipped → receiving → reconciled/closed) and where each label is, and pull
// fresh tracking (all labels or one at a time). Complements PO Reconciliation, which
// only shows POs already received against. Uses /api/po/list + /api/po/get +
// /api/po/track-refresh. See docs/context/purchase-orders.md.
import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useQueryParam } from '../lib/urlstate.js';
import { TopBar, TrackingTimeline } from '../components/common.jsx';
import { Icon } from '../components/NavIcons.jsx';
import { carrierName } from '../lib/carriers.js';
import { subStatusLabel, subStatusTone } from '../lib/trackstatus.js';
import { PoScanModal, PoLineRow, PoLineHeader } from '../components/PoScanModal.jsx';
import { ManifestPrint } from '../components/ManifestPrint.jsx';
import { PoLinkBatchModal } from '../components/PoLinkBatch.jsx';
import { PoLabelsFile, PoLabelDownload } from '../components/PoLabelsFile.jsx';

const PO_STATUS = {
  draft:      { label: 'Filling',    cls: 'draft' },
  shipped:    { label: 'Shipped',    cls: 'shipped' },
  receiving:  { label: 'Receiving',  cls: 'receiving' },
  reconciled: { label: 'Reconciled', cls: 'ok' },
  closed:     { label: 'Closed',     cls: 'muted' },
};
const boxStatusLabel = (s) => (s === 'delivered' ? 'Delivered ✓'
  : s === 'in_transit' ? 'In transit'
  : s === 'pre_transit' ? 'With supplier · label made'
  : s === 'shipped' ? 'Shipped'
  : s === 'packed' ? 'Ready to ship' : 'Filling');
const boxChipCls = (s) => (s === 'delivered' ? 'ok' : s === 'in_transit' ? 'receiving' : s === 'pre_transit' ? 'pretransit' : s === 'shipped' ? 'shipped' : s === 'packed' ? 'packed' : 'draft');

// 17TRACK's checkpoint text is very often the status over again, shouted — a label read
// "UPS · Delivered" and then "Delivered, DELIVERED" underneath. Show the checkpoint only
// when it says something the status line didn't.
const trackWords = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function checkpointAdds(checkpoint, status) {
  const c = trackWords(checkpoint);
  if (!c) return false;
  const said = new Set(trackWords(status).split(' ').filter(Boolean));
  return c.split(' ').filter(Boolean).some((w) => !said.has(w));
}

// The chip says where the ORDER actually is, which is not the same as the raw status
// column. `purchase_orders.status` only ever advances as far as `receiving`, and an order
// received with nothing declared never auto-reconciles (that decision is a person's), so
// PO-100003 sat reading "Receiving" with all nine labels delivered and 54 pairs counted —
// contradicting the very line underneath it. The same wrong-by-a-stage bug shows one step
// earlier too: a `draft` order whose labels have all shipped read "Filling", as if the
// supplier were still packing.
//
// So: once every label has landed, say so; the reconciliation queue owns what happens next.
// Falls back to the raw status whenever the counts can't say better (a supplier's own
// response carries no `received_units`, and older callers pass no counts at all).
function poChipOf(p) {
  if (p.status === 'reconciled' || p.status === 'closed') return PO_STATUS[p.status];
  const boxes = Number(p.box_count) || 0;
  const delivered = Number(p.delivered_count) || 0;
  const shipped = Number(p.shipped_count) || 0;
  const received = Number(p.received_units) || 0;
  if (boxes > 0 && delivered === boxes) {
    return received > 0
      ? { label: 'Delivered · to reconcile', cls: 'ok' }
      : { label: 'All delivered', cls: 'ok' };
  }
  if (p.status === 'receiving') return PO_STATUS.receiving;
  // A label out with the carrier means the supplier has stopped filling, whatever the
  // order row still says.
  if (shipped > 0) return PO_STATUS.shipped;
  return PO_STATUS[p.status] || { label: p.status, cls: 'muted' };
}

function PoStatusChip({ po }) {
  const s = poChipOf(po);
  return <span className={`po-chip ${s.cls}`}>{s.label}</span>;
}

export function PoOverview({ onHome, onSignOut }) {
  const [pos, setPos] = useState(null);
  const [error, setError] = useState('');
  // The open PO rides in ?po= so a refresh reopens it instead of dropping you back on
  // the list to hunt for it again. Numeric id — the detail is re-fetched by the effect
  // below, so nothing stale is restored.
  const [openIdRaw, setOpenIdRaw] = useQueryParam('po');
  const openId = openIdRaw ? Number(openIdRaw) : null;
  const setOpenId = (v) => setOpenIdRaw(v == null ? '' : String(v));
  const [detail, setDetail] = useState(null);          // { po, boxes, lines }
  const [detailBusy, setDetailBusy] = useState(false);
  const [trackBusy, setTrackBusy] = useState(false);    // whole-PO refresh
  const [trackBoxBusy, setTrackBoxBusy] = useState(null);
  const [historyOpen, setHistoryOpen] = useState(() => new Set()); // box ids showing the timeline
  const toggleHistory = (id) => setHistoryOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const [scanBox, setScanBox] = useState(null); // po_box being filled on the supplier's behalf
  const [scanOrderPo, setScanOrderPo] = useState(null); // PO being filled as a whole-order manifest
  const [linkPo, setLinkPo] = useState(null);           // PO being linked to an already-received batch
  const [unlinkBusy, setUnlinkBusy] = useState(null);   // batch id being unlinked
  const [delPo, setDelPo] = useState(null);             // PO being deleted (confirm dialog)
  const [delText, setDelText] = useState('');
  const [delBusy, setDelBusy] = useState(false);
  const [lineBusy, setLineBusy] = useState(null);       // po_line id currently being saved
  const [delLine, setDelLine] = useState(null);         // { line, where } — remove confirm

  // Reload the open PO's detail after entering items on behalf of the supplier.
  const refreshOpenDetail = () => {
    if (openId == null) return;
    api.poGet(openId)
      .then((r) => setDetail({ po: r.po, boxes: r.boxes, lines: r.lines, batches: r.batches || [] }))
      .catch((e) => { if (e.unauthorized) return onSignOut(); setError(e.message); });
    loadList(); // unit counts on the list may have advanced
  };

  // Correct a line PH entered on the supplier's behalf — or one the supplier scanned and
  // then corrected by message. Same endpoint the supplier's own portal uses (`po/line`
  // decides on-behalf attribution from the caller's role and re-stamps the surviving row),
  // so a size fix merges into a matching SKU+size line exactly as it does there.
  //
  // A REMOVAL (qty 0) is routed through a confirm first: on this screen the row is somebody
  // else's declaration, often for a box that has already shipped, and deleting it silently
  // changes what the order is owed. The supplier's own portal needs no such step — there
  // they're fixing their own scan while the box is still open in front of them.
  const patchLine = async (line, patch) => {
    if (patch.qty === 0) { setDelLine({ line }); return; }
    setLineBusy(Number(line.id)); setError('');
    try {
      await api.poLine(Number(line.id), patch);
      refreshOpenDetail();
    } catch (e) {
      if (e.unauthorized) return onSignOut();
      setError(e.message);
    } finally { setLineBusy(null); }
  };
  const confirmRemoveLine = async () => {
    const line = delLine?.line;
    if (!line) return;
    setLineBusy(Number(line.id)); setError('');
    try {
      await api.poLine(Number(line.id), { qty: 0 });
      setDelLine(null);
      refreshOpenDetail();
    } catch (e) {
      if (e.unauthorized) return onSignOut();
      setDelLine(null); setError(e.message);
    } finally { setLineBusy(null); }
  };
  // The manifest is editable until the order's count is FROZEN — the same test the server
  // applies for staff writing on a supplier's behalf (`manifestEditBlock`, onBehalf). Where
  // the parcel is doesn't bind staff: the supplier's list routinely arrives by message
  // after the box has gone, and a correction to it arrives later still.
  const canEditLines = (po, box) => (box?.kind === 'replacement'
    ? po.status !== 'closed'
    : !['reconciled', 'closed'].includes(po.status));
  const lineAttribution = (l) => (l.entered_on_behalf
    ? `Entered by ${l.entered_by_name || l.entered_by_username || 'staff'} · on supplier’s behalf`
    : null);

  const loadList = () => {
    api.poList()
      .then((r) => setPos(r.pos || []))
      .catch((e) => { if (e.unauthorized) return onSignOut(); setError(e.message); });
  };
  useEffect(loadList, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch the open PO's detail whenever the open id changes — covers both a tap and a
  // refresh that restored ?po= from the URL. (Without this the restored PO renders
  // "open" but its detail never loads, so it sits on "Loading…" forever.)
  useEffect(() => {
    if (openId == null) { setDetail(null); return; }
    let cancelled = false;
    setDetail(null); setDetailBusy(true); setError('');
    api.poGet(openId)
      .then((r) => { if (!cancelled) setDetail({ po: r.po, boxes: r.boxes, lines: r.lines, batches: r.batches || [] }); })
      .catch((e) => { if (cancelled) return; if (e.unauthorized) return onSignOut(); setError(e.message); })
      .finally(() => { if (!cancelled) setDetailBusy(false); });
    return () => { cancelled = true; };
  }, [openId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Units declared per label (and for a whole-order list), summed once. A ten-row label
  // otherwise leaves the reader adding ×1 + ×2 + ×1 … in their head to answer "how many
  // pairs is this box supposed to hold?" — the question the whole screen is about.
  const unitsByBox = React.useMemo(() => {
    const m = new Map();
    for (const l of detail?.lines || []) {
      const k = String(l.po_box_id ?? 'order');
      m.set(k, (m.get(k) || 0) + (Number(l.qty_expected) || 0));
    }
    return m;
  }, [detail]);
  const boxUnits = (box) => unitsByBox.get(String(box.id)) || 0;
  // What the WAREHOUSE counted into that label's box (matched on tracking number, server
  // side). Shown beside the declared total for the same reason the list carries both: an
  // order raised after the boxes landed declares nothing, so "0 units" on a label whose
  // box already has twelve pairs scanned out of it reads as "this box is empty".
  const boxReceived = (box) => Number(box.received_units) || 0;
  // Units under this order that no label can claim — the receiving box carried no tracking
  // number, or one that doesn't match any label here. Without this they'd simply be missing
  // from the per-label totals and the arithmetic would quietly stop adding up.
  const receivedTotal = (detail?.batches || []).reduce((n, b) => n + (Number(b.units) || 0), 0);
  const receivedOnLabels = (detail?.boxes || []).reduce((n, b) => n + boxReceived(b), 0);
  const receivedUnmatched = Math.max(0, receivedTotal - receivedOnLabels);

  // p.id is a BIGINT that arrives as a STRING; openId is numeric — compare coerced.
  const toggle = (id) => setOpenId(Number(openId) === Number(id) ? null : id);

  // Refresh tracking — omit boxId for the whole PO, pass it for a single label.
  const refreshTracking = async (poId, boxId) => {
    if (boxId != null) setTrackBoxBusy(Number(boxId)); else setTrackBusy(true);
    setError('');
    try {
      const r = await api.poTrackRefresh(poId, boxId != null ? Number(boxId) : undefined);
      // track-refresh doesn't return the linked batches — keep the ones already loaded
      // rather than blanking the "received into" panel on every refresh.
      setDetail((d) => ({ po: r.po, boxes: r.boxes, lines: r.lines, batches: d?.batches || [] }));
      loadList(); // label counts on the list may have advanced
    } catch (e) { if (e.unauthorized) return onSignOut(); setError(e.message); }
    finally { if (boxId != null) setTrackBoxBusy(null); else setTrackBusy(false); }
  };

  // Undo a link. The batch and its stock are untouched — only the join goes.
  const unlink = async (poId, batchId) => {
    setUnlinkBusy(Number(batchId)); setError('');
    try {
      await api.poUnlinkBatch(poId, Number(batchId));
      refreshOpenDetail();
    } catch (e) { if (e.unauthorized) return onSignOut(); setError(e.message); }
    finally { setUnlinkBusy(null); }
  };

  const doDelete = async () => {
    setDelBusy(true); setError('');
    try {
      await api.poDelete(delPo.id, delText.trim());
      setDelPo(null); setDelText(''); setOpenId(null);
      loadList();
    } catch (e) { if (e.unauthorized) return onSignOut(); setError(e.message); }
    finally { setDelBusy(false); }
  };

  return (
    <div className="app">
      <TopBar title="Purchase Orders" onHome={onHome} onSignOut={onSignOut} />
      <div className="wrap-narrow">
        <p className="muted sm">Every batch you opened for a supplier — its status and where each shipping label is. Tap a PO to see its labels and refresh tracking.</p>
        {error && <div className="po-err">{error}</div>}
        {pos == null ? <p className="muted">Loading…</p>
          : pos.length === 0 ? <div className="card empty-state">No purchase orders yet. Open one from <b>New Batch (Purchase Order)</b>.</div>
          : (
            <div className="po-list">
              {pos.map((p) => {
                const open = Number(openId) === Number(p.id);
                return (
                  <div key={p.id} className="card po-ov">
                    <button className="po-ov-head" onClick={() => toggle(p.id)}>
                      <div className="po-ov-top">
                        <span className="po-code">{p.po_code}</span>
                        <PoStatusChip po={p} />
                      </div>
                      <div className="po-ov-meta muted sm">
                        {p.tag_code && <span><Icon name="tag" /> {p.tag_code}</span>}
                        <span>{p.shipped_count}/{p.box_count} label{p.box_count === 1 ? '' : 's'} shipped</span>
                        {p.delivered_count > 0 && <span>{p.delivered_count} delivered</span>}
                        {/* Two different facts, and they were being shown as one number:
                            `unit_count` is what the SUPPLIER declared, `received_units`
                            is what we counted. An order received with no manifest is
                            legitimately "0 declared", which read as "nothing here" beside
                            a shelf full of stock. */}
                        <span className={p.unit_count === 0 && p.received_units > 0 ? 'po-ov-blind' : undefined}
                          title={p.unit_count === 0 && p.received_units > 0
                            ? 'Nothing was declared for this order, so its reconciliation reads “received blind”. Add the supplier’s manifest to compare against.'
                            : undefined}>
                          {p.unit_count} declared
                        </span>
                        {p.received_units > 0 && <span>{p.received_units} received</span>}
                      </div>
                      <span className="po-ov-caret">{open ? '▾' : '▸'}</span>
                    </button>

                    {open && (
                      <div className="po-ov-detail">
                        {detailBusy || !detail ? <p className="muted sm">Loading…</p> : (
                          <>
                            <div className="po-ov-actions">
                              <span className="muted sm">From {detail.po.supplier_name}{detail.po.date_of_purchase ? ` · ${String(detail.po.date_of_purchase).slice(0, 10)}` : ''}</span>
                              <button className="btn ghost sm" disabled={trackBusy || trackBoxBusy != null} onClick={() => refreshTracking(p.id)}>
                                <Icon name="refresh" /> {trackBusy ? 'Checking…' : 'Refresh all tracking'}
                              </button>
                              {!['reconciled', 'closed'].includes(detail.po.status) && (
                                <button className="btn ghost sm" onClick={() => setLinkPo(detail.po)}>
                                  <Icon name="box" /> Link a received shipment
                                </button>
                              )}
                            </div>

                            {/* What this order is actually counting. Receiving normally sets this
                                itself; it's shown here because it can now be attached (and undone)
                                by hand for an order opened mid-scan. */}
                            {(detail.batches || []).length > 0 && (
                              <div className="po-ov-batches">
                                <div className="po-ov-batches-head"><b>Received into</b></div>
                                {detail.batches.map((b) => (
                                  <div className="po-ov-batch" key={b.id}>
                                    <span>
                                      {b.batch_code}
                                      <span className="muted sm"> · {b.units} unit{b.units === 1 ? '' : 's'} · {b.status}
                                        {b.date_received ? ` · ${String(b.date_received).slice(0, 10)}` : ''}</span>
                                    </span>
                                    {!['reconciled', 'closed'].includes(detail.po.status) && (
                                      <button className="btn ghost sm" disabled={unlinkBusy === Number(b.id)}
                                        onClick={() => unlink(p.id, b.id)}>
                                        {unlinkBusy === Number(b.id) ? 'Unlinking…' : 'Unlink'}
                                      </button>
                                    )}
                                  </div>
                                ))}
                              </div>
                            )}
                            <ManifestPrint poId={p.id} poCode={p.po_code} onSignOut={onSignOut} />
                            {/* The courier's own labels, so the supplier can print the one
                                for the box they're packing instead of digging through email. */}
                            <PoLabelsFile po={detail.po} canUpload={!['reconciled', 'closed'].includes(detail.po.status)}
                              onChanged={refreshOpenDetail} onSignOut={onSignOut} />
                            {(() => {
                              // Whole-order manifest (Path C): one list for the whole purchase, no per-box
                              // breakdown. Shown when it's already in use, or available. Receiving still
                              // happens per box, like a blind receive.
                              //
                              // Enterable while the order is DRAFT *or* being RECEIVED: a supplier who
                              // doesn't use the portal often sends their list after the boxes land, and
                              // draft-only meant that list could never be entered at all.
                              const orderLines = (detail.lines || []).filter((l) => l.po_box_id == null);
                              const hasBoxLines = (detail.lines || []).some((l) => l.po_box_id != null);
                              const canEnter = ['draft', 'receiving'].includes(detail.po.status) && !hasBoxLines;
                              if (!orderLines.length && !canEnter) return null;
                              return (
                                <div className="po-ov-order">
                                  <div className="po-ov-order-head">
                                    <b>Whole-order manifest</b>
                                    <span className="po-ov-label-units">{unitsByBox.get('order') || 0} unit{(unitsByBox.get('order') || 0) === 1 ? '' : 's'}</span>
                                    <span className="muted xs">One list for the whole purchase — no per-box breakdown. Warehouse still receives box by box.</span>
                                  </div>
                                  {orderLines.length > 0 && (
                                    <ul className={`po-lines po-ov-lines${canEditLines(detail.po) ? ' editable' : ''}`}>
                                      {canEditLines(detail.po) && <PoLineHeader />}
                                      {canEditLines(detail.po)
                                        ? orderLines.map((l) => (
                                          <PoLineRow key={l.id} line={l} disabled={lineBusy === Number(l.id)}
                                            attribution={lineAttribution(l)} onSave={(patch) => patchLine(l, patch)} />
                                        ))
                                        : orderLines.map((l) => (
                                          <li key={l.id}>
                                            <span className="po-line-name">{l.name || l.sku}</span>
                                            <span className="po-line-meta">{l.sku} · size {l.size} · ×{l.qty_expected}</span>
                                            {lineAttribution(l) && (
                                              <span className="po-line-attribution muted xs">{lineAttribution(l)}</span>
                                            )}
                                          </li>
                                        ))}
                                    </ul>
                                  )}
                                  {canEnter && (
                                    <>
                                      <button className="btn sm po-ov-fill-btn" onClick={() => setScanOrderPo(detail.po)}>
                                        <Icon name="camera" /> {orderLines.length ? 'Add more to the order manifest' : 'Add whole-order manifest'}
                                      </button>
                                      {detail.po.status === 'receiving' && (
                                        <p className="muted xs po-ov-fill-hint">
                                          The boxes are already being received — entering the supplier's list now still
                                          works. It only sets what was expected; it can't change what the warehouse counted.
                                        </p>
                                      )}
                                    </>
                                  )}
                                </div>
                              );
                            })()}
                            {detail.boxes.map((box) => (
                              <div key={box.id} className={`po-ov-label${box.kind === 'replacement' ? ' replacement' : ''}`}>
                                <div className="po-ov-label-top">
                                  <div className="po-ov-label-id">
                                    {/* A reship we added to cover a shortage — not one of the
                                        supplier's original labels, so don't number it as one. */}
                                    <b>{box.kind === 'replacement' ? 'Replacement shipment' : `Label ${box.box_number}`}</b>
                                    <div className="po-track muted sm">
                                      {carrierName(box.carrier || box.carrier_key) ? <span className="po-carrier">{carrierName(box.carrier || box.carrier_key)}</span> : null}
                                      {carrierName(box.carrier || box.carrier_key) && box.tracking_number ? ' · ' : ''}
                                      {box.tracking_number || (carrierName(box.carrier || box.carrier_key) ? '' : '— no tracking #')}
                                    </div>
                                  </div>
                                  <div className="po-ov-label-side">
                                    <span className={`po-chip ${boxChipCls(box.status)}`}>{boxStatusLabel(box.status)}</span>
                                    <span className="po-ov-label-counts">
                                      <span className={`po-ov-label-units${boxUnits(box) === 0 && boxReceived(box) > 0 ? ' po-ov-blind' : ''}`}
                                        title={boxUnits(box) === 0 && boxReceived(box) > 0
                                          ? 'Nothing was declared for this label — the count beside it is what the warehouse has scanned out of the box so far.'
                                          : undefined}>
                                        {boxUnits(box)} declared
                                      </span>
                                      {boxReceived(box) > 0 && (
                                        <span className="po-ov-label-units received" title="Counted by the warehouse into this label's box.">
                                          {boxReceived(box)} received
                                        </span>
                                      )}
                                    </span>
                                  </div>
                                </div>
                                {(box.tracking_status || box.last_checkpoint || box.tracking_sub_status) && (
                                  <div className="po-track-status muted sm">
                                    {/* The carrier is already on the line above — repeat it only when
                                        tracking came back with a different one than the label claims. */}
                                    {box.carrier && trackWords(box.carrier) !== trackWords(carrierName(box.carrier_key))
                                      ? <span className="po-track-carrier">{box.carrier}{box.tracking_status ? ' · ' : ''}</span> : null}
                                    {box.tracking_status ? <span className="po-track-state">{box.tracking_status}</span> : null}
                                    {/* Why it's stuck, not just that it is. */}
                                    {box.tracking_sub_status && (
                                      <div className="po-substatus">
                                        <span className={`po-flag ${subStatusTone(box.tracking_sub_status)}`}>
                                          {subStatusLabel(box.tracking_sub_status)}
                                        </span>
                                        {box.tracking_sub_status_descr && (
                                          <span className="po-substatus-detail">{box.tracking_sub_status_descr}</span>
                                        )}
                                      </div>
                                    )}
                                    {checkpointAdds(box.last_checkpoint, box.tracking_status)
                                      ? <div className="po-track-checkpoint">{box.last_checkpoint}</div> : null}
                                  </div>
                                )}
                                <div className="po-track-actions">
                                  {box.tracking_number && ['pre_transit', 'shipped', 'in_transit', 'delivered'].includes(box.status) && (
                                    <button className="btn ghost sm po-track-refresh-one" disabled={trackBusy || trackBoxBusy != null}
                                      onClick={() => refreshTracking(p.id, box.id)}>
                                      <Icon name="refresh" /> {trackBoxBusy === Number(box.id) ? 'Checking…' : 'Refresh this label'}
                                    </button>
                                  )}
                                  {box.tracking_events?.length > 0 && (
                                    <button className="btn ghost sm" onClick={() => toggleHistory(Number(box.id))}>
                                      <Icon name="tag" /> {historyOpen.has(Number(box.id)) ? 'Hide history' : `Tracking history (${box.tracking_events.length})`}
                                    </button>
                                  )}
                                </div>
                                {historyOpen.has(Number(box.id)) && box.tracking_events?.length > 0 && (
                                  <TrackingTimeline events={box.tracking_events} status={box.tracking_status} />
                                )}
                                {(() => {
                                  const lines = (detail.lines || []).filter((l) => Number(l.po_box_id) === Number(box.id));
                                  // PH can fill a per-box manifest while it's still editable (draft PO, pending
                                  // label) — the same window the supplier's own scan-out uses. Not when the PO
                                  // is on a whole-order manifest (that's entered against the order, not a label).
                                  //
                                  // A REPLACEMENT label runs the other way round: it's created already-shipped
                                  // on an order that's past draft, so it never passes that test. Its manifest
                                  // stays open until the order is archived, on any scope — the lines are a
                                  // checklist for the warehouse, and are excluded from reconciliation.
                                  const isReplacement = box.kind === 'replacement';
                                  // Staff writing the manifest FOR the supplier aren't bound by where
                                  // the parcel is — that's the whole point of the on-behalf path: the
                                  // list arrives by message after the box has gone, often after it has
                                  // landed. Gating it on "draft + pending" meant the one order that
                                  // needed it most — received with nothing declared — offered nothing.
                                  // Only a frozen order (reconciled/archived) is off limits.
                                  const canFill = isReplacement
                                    ? detail.po.status !== 'closed'
                                    : (!['reconciled', 'closed'].includes(detail.po.status) && detail.po.manifest_scope !== 'po');
                                  // Already gone or landed: entering it now only sets what was
                                  // EXPECTED. It can't rewrite what the warehouse counted.
                                  const boxIsOut = !['pending', 'pre_transit'].includes(box.status);
                                  return (
                                    <>
                                      {lines.length > 0 && (
                                        /* Editable for staff, on the same terms as entering the list in the
                                           first place: a manifest typed off a message gets a size wrong, a
                                           qty wrong, or carries a pair the supplier later says isn't in the
                                           box. Being able to ADD a line but never fix or drop one meant the
                                           only correction was to delete the whole order and start again. */
                                        <ul className={`po-lines po-ov-lines${canEditLines(detail.po, box) ? ' editable' : ''}`}>
                                          {canEditLines(detail.po, box) && <PoLineHeader />}
                                          {canEditLines(detail.po, box)
                                            ? lines.map((l) => (
                                              <PoLineRow key={l.id} line={l} disabled={lineBusy === Number(l.id)}
                                                attribution={lineAttribution(l)} onSave={(patch) => patchLine(l, patch)} />
                                            ))
                                            : lines.map((l) => (
                                              <li key={l.id}>
                                                <span className="po-line-name">{l.name || l.sku}</span>
                                                <span className="po-line-meta">
                                                  {l.sku} · size {l.size} · ×{l.qty_expected}
                                                  {l.unit_cost != null && l.unit_cost !== '' && ` · $${Number(l.unit_cost).toFixed(2)} ea`}
                                                  {l.tip != null && l.tip !== '' && ` · tip $${Number(l.tip).toFixed(2)} ea`}
                                                </span>
                                                {lineAttribution(l) && (
                                                  <span className="po-line-attribution muted xs">{lineAttribution(l)}</span>
                                                )}
                                              </li>
                                            ))}
                                        </ul>
                                      )}
                                      {/* What the supplier says this box cost them — cost and tip are
                                          both per pair, on the line for that size. Staff need to see it
                                          and this is the only place they can; the totals follow whatever
                                          the rows above now say. */}
                                      {(() => {
                                        let items = 0; let tips = 0; let blank = 0; let any = false;
                                        for (const l of lines) {
                                          const q = l.qty_expected || 0;
                                          const c = l.unit_cost == null || l.unit_cost === '' ? null : Number(l.unit_cost);
                                          const t = l.tip == null || l.tip === '' ? null : Number(l.tip);
                                          if (c == null && t == null) { blank += q; continue; }
                                          items += (c || 0) * q; tips += (t || 0) * q; any = true;
                                        }
                                        if (!any) return null;
                                        const usd = (n) => `$${Number(n || 0).toFixed(2)}`;
                                        return (
                                          <div className="po-box-total">
                                            <span className="muted xs">
                                              Cost {usd(items)}{tips > 0 ? ` + tips ${usd(tips)}` : ''}
                                              {blank > 0 ? ` · ${blank} pair${blank === 1 ? '' : 's'} with nothing entered` : ''}
                                            </span>
                                            <span className="po-box-total-n">{usd(items + tips)}</span>
                                          </div>
                                        );
                                      })()}
                                      {canFill && lines.length === 0 && (
                                        <p className="muted xs po-ov-fill-hint">{isReplacement
                                          ? 'No items declared yet — enter what the supplier says they’re reshipping so the warehouse can check the box off against it. It won’t change the shortage on the original order.'
                                          : boxIsOut
                                            ? 'Nothing was declared for this label. If the supplier has since sent their list, enter it here — it sets what was expected, so the order stops reading as received blind. It can’t change what the warehouse counted.'
                                            : 'No items yet — if the supplier sent a manual list of the box contents, enter it here so the warehouse can receive against this PO.'}</p>
                                      )}
                                      <PoLabelDownload poId={p.id} box={box} onSignOut={onSignOut} />
                                      {canFill && (
                                        <button className="btn sm po-ov-fill-btn" onClick={() => setScanBox(box)}>
                                          <Icon name="camera" /> {lines.length ? 'Add more items on their behalf' : 'Add items on their behalf'}
                                          {boxIsOut && <span className="po-ov-fill-late"> · label already sent</span>}
                                        </button>
                                      )}
                                    </>
                                  );
                                })()}
                              </div>
                            ))}

                            {receivedUnmatched > 0 && (
                              <p className="muted sm po-ov-unmatched">
                                <b>{receivedUnmatched}</b> received unit{receivedUnmatched === 1 ? '' : 's'} on this order
                                {receivedUnmatched === 1 ? " isn't" : " aren't"} counted against any label above — the box
                                {receivedUnmatched === 1 ? ' it' : ' they'} came in has no tracking number, or one that
                                doesn’t match a label here. The reconciliation still counts {receivedUnmatched === 1 ? 'it' : 'them'}.
                              </p>
                            )}

                            {/* An order raised by mistake, or a duplicate. Only offered while
                                nothing is received against it — otherwise the record of what
                                arrived would go with the order. */}
                            {!['reconciled', 'closed'].includes(detail.po.status) && (
                              (detail.batches || []).length === 0 ? (
                                <div className="po-ov-danger">
                                  <button className="btn ghost sm danger-link" onClick={() => { setDelPo(detail.po); setDelText(''); }}>
                                    Delete this purchase order
                                  </button>
                                </div>
                              ) : (
                                <div className="po-ov-danger">
                                  <span className="muted xs">
                                    Can’t be deleted while {detail.batches.length} receiving batch(es) are linked —
                                    unlink first. Deleting must never take the record of received stock with it.
                                  </span>
                                </div>
                              )
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
      </div>

      {linkPo && (
        <PoLinkBatchModal po={linkPo} lines={detail?.lines || []}
          onClose={() => setLinkPo(null)}
          onLinked={() => { setLinkPo(null); refreshOpenDetail(); }}
          onSignOut={onSignOut} />
      )}

      {/* Deleting is guarded twice over: the order must have no receiving batch attached
          (the server refuses otherwise, and the database would too), and the PO code has
          to be typed back. Labels, manifest lines, the resolution and the thread go with
          it — there is no undo. */}
      {delPo && (
        <div className="modal-overlay" onClick={() => !delBusy && setDelPo(null)}>
          <div className="modal confirm po-del" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Delete {delPo.po_code}?</h3>
            <p className="modal-msg">
              This removes the order, its {(detail?.boxes || []).length} label(s), everything the supplier
              declared, and the comment thread. It cannot be undone.
            </p>
            <label className="po-del-field">
              <span className="muted sm">Type <b>{delPo.po_code}</b> to confirm</span>
              <input value={delText} autoCapitalize="characters" autoCorrect="off"
                onChange={(e) => setDelText(e.target.value)} placeholder={delPo.po_code} />
            </label>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => { setDelPo(null); setDelText(''); }} disabled={delBusy}>Cancel</button>
              <button className="btn danger" disabled={delBusy || delText.trim().toUpperCase() !== String(delPo.po_code).toUpperCase()}
                onClick={doDelete}>{delBusy ? 'Deleting…' : 'Delete permanently'}</button>
            </div>
          </div>
        </div>
      )}

      {delLine && (
        <div className="modal-overlay" onClick={() => lineBusy == null && setDelLine(null)}>
          <div className="modal confirm" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Remove this item from the manifest?</h3>
            <p className="modal-msg">
              <b>{delLine.line.name || delLine.line.sku}</b> · size {delLine.line.size} · ×{delLine.line.qty_expected}
              {' '}drops off what this order is expected to contain, so the reconciliation stops counting it short.
              {delLine.line.entered_on_behalf ? '' : ' The supplier declared this line themselves.'}
            </p>
            <div className="modal-actions">
              <button className="btn ghost" disabled={lineBusy != null} onClick={() => setDelLine(null)}>Keep it</button>
              <button className="btn danger" disabled={lineBusy != null} onClick={confirmRemoveLine}>
                {lineBusy != null ? 'Removing…' : 'Remove item'}
              </button>
            </div>
          </div>
        </div>
      )}

      {scanBox && (
        <PoScanModal box={scanBox} onClose={() => setScanBox(null)}
          onAdded={refreshOpenDetail} onSignOut={onSignOut} />
      )}
      {scanOrderPo && (
        <PoScanModal po={scanOrderPo} onClose={() => setScanOrderPo(null)}
          onAdded={refreshOpenDetail} onSignOut={onSignOut} />
      )}
    </div>
  );
}
