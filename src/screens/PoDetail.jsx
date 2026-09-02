// One purchase order, on its own page.
//
// This used to be an accordion inside the PO list: tapping an order expanded ~400 lines
// of detail under a row, with every label rendered as a bare block in one long column.
// With nine labels on an order (PO-100005) they ran together — you couldn't tell where
// one box's manifest ended and the next began, and the order's own details were pushed
// off-screen by the first label. So: its own page, reached from the list, and **one card
// per label** — a box is a physical thing, and it reads like one.
//
// Everything on this page is the same data as before (`/api/po/get`), only laid out:
//   • the order card — who it's from, where it is, what it's counting, and the actions
//     that apply to the whole order
//   • the whole-order manifest (Path C) and the supplier's manifest PDF import
//   • Labels — one card each, with its own tracking, manifest and tools
//   • the danger zone, last
// See docs/context/purchase-orders.md.
import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { TopBar, TrackingTimeline } from '../components/common.jsx';
import { Icon } from '../components/NavIcons.jsx';
import { PoManifestImport } from '../components/PoManifestImport.jsx';
import { carrierName } from '../lib/carriers.js';
import { subStatusLabel, subStatusTone } from '../lib/trackstatus.js';
import { PoScanModal, PoLineRow, PoLineHeader } from '../components/PoScanModal.jsx';
import { ManifestPrint } from '../components/ManifestPrint.jsx';
import { PoLinkBatchModal } from '../components/PoLinkBatch.jsx';
import { PoLabelsFile, PoLabelDownload } from '../components/PoLabelsFile.jsx';
import { PoDetailsEdit, PoAddLabels, PoLabelTools } from '../components/PoEdit.jsx';
import { boxStatusLabel, boxChipCls, checkpointAdds, trackWords, isBoxesOrder, shippedProgress } from '../lib/postatus.js';
import { PoStatusChip } from '../components/PoStatusChip.jsx';
import { PoKindChip } from '../components/PoKindChip.jsx';
import { PoBulkDimensions } from '../components/PoBulkDimensions.jsx';

const FROZEN = ['reconciled', 'closed'];

export function PoDetail({ poId, pos = [], onBack, onHome, onSignOut }) {
  const [detail, setDetail] = useState(null);           // { po, boxes, lines, batches }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [trackBusy, setTrackBusy] = useState(false);    // whole-PO refresh
  const [trackBoxBusy, setTrackBoxBusy] = useState(null);
  const [historyOpen, setHistoryOpen] = useState(() => new Set()); // box ids showing the timeline
  const toggleHistory = (id) => setHistoryOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const [scanBox, setScanBox] = useState(null);         // po_box being filled on the supplier's behalf
  const [scanOrderPo, setScanOrderPo] = useState(null); // PO being filled as a whole-order manifest
  const [linkPo, setLinkPo] = useState(null);           // PO being linked to an already-received batch
  const [unlinkBusy, setUnlinkBusy] = useState(null);   // batch id being unlinked
  const [delPo, setDelPo] = useState(null);             // PO being deleted (confirm dialog)
  const [delText, setDelText] = useState('');
  const [delBusy, setDelBusy] = useState(false);
  const [lineBusy, setLineBusy] = useState(null);       // po_line id currently being saved
  const [delLine, setDelLine] = useState(null);         // { line } — remove confirm

  const load = () => api.poGet(poId)
    .then((r) => setDetail({ po: r.po, boxes: r.boxes, lines: r.lines, batches: r.batches || [] }))
    .catch((e) => { if (e.unauthorized) return onSignOut(); setError(e.message); });

  useEffect(() => {
    let cancelled = false;
    setDetail(null); setBusy(true); setError('');
    api.poGet(poId)
      .then((r) => { if (!cancelled) setDetail({ po: r.po, boxes: r.boxes, lines: r.lines, batches: r.batches || [] }); })
      .catch((e) => { if (cancelled) return; if (e.unauthorized) return onSignOut(); setError(e.message); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [poId]); // eslint-disable-line react-hooks/exhaustive-deps

  const po = detail?.po || null;
  const boxes = detail?.boxes || [];
  const lines = detail?.lines || [];
  // Shoes, or the empty shoe boxes we buy to replace the crushed and missing ones. It
  // swaps the manifest's identifying column (size → dimensions) everywhere below.
  const boxesOrder = isBoxesOrder(detail?.po);
  const batches = detail?.batches || [];

  // Units declared per label (and for a whole-order list), summed once. A ten-row label
  // otherwise leaves the reader adding ×1 + ×2 + ×1 … in their head to answer "how many
  // pairs is this box supposed to hold?" — the question the whole screen is about.
  const unitsByBox = useMemo(() => {
    const m = new Map();
    for (const l of lines) {
      const k = String(l.po_box_id ?? 'order');
      m.set(k, (m.get(k) || 0) + (Number(l.qty_expected) || 0));
    }
    return m;
  }, [detail]); // eslint-disable-line react-hooks/exhaustive-deps
  const boxUnits = (box) => unitsByBox.get(String(box.id)) || 0;
  // What the WAREHOUSE counted into that label's box (matched on tracking number, server
  // side). Shown beside the declared total for the same reason the list carries both: an
  // order raised after the boxes landed declares nothing, so "0 units" on a label whose
  // box already has twelve pairs scanned out of it reads as "this box is empty".
  const boxReceived = (box) => Number(box.received_units) || 0;
  // Units under this order that no label can claim — the receiving box carried no tracking
  // number, or one that doesn't match any label here. Without this they'd simply be missing
  // from the per-label totals and the arithmetic would quietly stop adding up.
  const receivedTotal = batches.reduce((n, b) => n + (Number(b.units) || 0), 0);
  const receivedOnLabels = boxes.reduce((n, b) => n + boxReceived(b), 0);
  const receivedUnmatched = Math.max(0, receivedTotal - receivedOnLabels);
  const declaredTotal = lines.reduce((n, l) => n + (Number(l.qty_expected) || 0), 0);
  const originals = boxes.filter((b) => b.kind !== 'replacement');

  // The list's status chip reads counts the detail endpoint doesn't return (it hands back
  // the raw order row), so they're rebuilt here from the labels themselves — the same
  // numbers, from the same facts. Without this the page would say "Filling" under a set of
  // delivered labels, which is the exact contradiction poChipOf exists to end.
  const chipPo = po && (() => {
    const { gone, total, delivered } = shippedProgress(boxes);
    return { ...po, box_count: total, shipped_count: gone, delivered_count: delivered, received_units: receivedTotal };
  })();

  // The manifest is editable until the order's count is FROZEN — the same test the server
  // applies for staff writing on a supplier's behalf (`manifestEditBlock`, onBehalf). Where
  // the parcel is doesn't bind staff: the supplier's list routinely arrives by message
  // after the box has gone, and a correction to it arrives later still.
  const canEditLines = (o, box) => (box?.kind === 'replacement' ? o.status !== 'closed' : !FROZEN.includes(o.status));
  const lineAttribution = (l) => (l.entered_on_behalf
    ? `Entered by ${l.entered_by_name || l.entered_by_username || 'staff'} · on supplier’s behalf`
    : null);

  // Correct a line PH entered on the supplier's behalf — or one the supplier scanned and
  // then corrected by message. Same endpoint the supplier's own portal uses (`po/line`
  // decides on-behalf attribution from the caller's role and re-stamps the surviving row).
  //
  // A REMOVAL (qty 0) is routed through a confirm first: on this screen the row is somebody
  // else's declaration, often for a box that has already shipped.
  const patchLine = async (line, patch) => {
    if (patch.qty === 0) { setDelLine({ line }); return; }
    setLineBusy(Number(line.id)); setError('');
    try {
      await api.poLine(Number(line.id), patch);
      await load();
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
      await load();
    } catch (e) {
      if (e.unauthorized) return onSignOut();
      setDelLine(null); setError(e.message);
    } finally { setLineBusy(null); }
  };

  // Refresh tracking — omit boxId for the whole PO, pass it for a single label.
  const refreshTracking = async (boxId) => {
    if (boxId != null) setTrackBoxBusy(Number(boxId)); else setTrackBusy(true);
    setError('');
    try {
      const r = await api.poTrackRefresh(poId, boxId != null ? Number(boxId) : undefined);
      // track-refresh doesn't return the linked batches — keep the ones already loaded
      // rather than blanking the "received into" panel on every refresh.
      setDetail((d) => ({ po: r.po, boxes: r.boxes, lines: r.lines, batches: d?.batches || [] }));
    } catch (e) { if (e.unauthorized) return onSignOut(); setError(e.message); }
    finally { if (boxId != null) setTrackBoxBusy(null); else setTrackBusy(false); }
  };

  // Undo a link. The batch and its stock are untouched — only the join goes.
  const unlink = async (batchId) => {
    setUnlinkBusy(Number(batchId)); setError('');
    try {
      await api.poUnlinkBatch(poId, Number(batchId));
      await load();
    } catch (e) { if (e.unauthorized) return onSignOut(); setError(e.message); }
    finally { setUnlinkBusy(null); }
  };

  const doDelete = async () => {
    setDelBusy(true); setError('');
    try {
      await api.poDelete(po.id, delText.trim());
      setDelPo(null); setDelText('');
      onBack();                       // the order is gone — back to the list
    } catch (e) { if (e.unauthorized) return onSignOut(); setError(e.message); }
    finally { setDelBusy(false); }
  };

  return (
    <div className="app">
      <TopBar title={po?.po_code || 'Purchase order'} onHome={onHome} onSignOut={onSignOut} />
      <div className="wrap-narrow">
        <button type="button" className="btn ghost sm po-back" onClick={onBack}>← All purchase orders</button>
        {error && <div className="po-err">{error}</div>}
        {busy || !detail ? <p className="muted">Loading…</p> : (
          <>
            <div className="card po-detail">
              <div className="po-detail-head">
                <div className="po-detail-id">
                  <span className="po-code">{po.po_code}</span>
                  <PoStatusChip po={chipPo} />
                  <PoKindChip po={po} />
                </div>
                <div className="po-detail-meta muted sm">
                  <span>From <b>{po.supplier_name}</b></span>
                  {po.tag_code && <span><Icon name="tag" /> {po.tag_code}</span>}
                  {po.date_of_purchase && <span>{String(po.date_of_purchase).slice(0, 10)}</span>}
                  <span>{originals.length} label{originals.length === 1 ? '' : 's'}</span>
                  {/* Two different facts, never one number: `declared` is what the SUPPLIER
                      said, `received` is what we counted. An order received with no manifest
                      is legitimately "0 declared", which read as "nothing here" beside a
                      shelf full of stock. */}
                  <span className={declaredTotal === 0 && receivedTotal > 0 ? 'po-ov-blind' : undefined}
                    title={declaredTotal === 0 && receivedTotal > 0
                      ? 'Nothing was declared for this order, so its reconciliation reads “received blind”. Add the supplier’s manifest to compare against.'
                      : undefined}>
                    {declaredTotal} declared
                  </span>
                  {receivedTotal > 0 && <span>{receivedTotal} received</span>}
                </div>
              </div>

              <div className="po-detail-actions">
                <button className="btn ghost sm" disabled={trackBusy || trackBoxBusy != null} onClick={() => refreshTracking()}>
                  <Icon name="refresh" /> {trackBusy ? 'Checking…' : 'Refresh all tracking'}
                </button>
                {!FROZEN.includes(po.status) && (
                  <button className="btn ghost sm" onClick={() => setLinkPo(po)}>
                    <Icon name="box" /> Link a received shipment
                  </button>
                )}
                <ManifestPrint poId={po.id} poCode={po.po_code} onSignOut={onSignOut} />
              </div>

              {/* The order's own details — supplier, tag, date, boxes expected, notes.
                  Collapsed behind its button: this page is read far more often than edited. */}
              <PoDetailsEdit po={po} boxes={boxes} lineCount={lines.length} onChanged={load} onSignOut={onSignOut} />

              {/* The courier's own labels, so the supplier can print the one for the box
                  they're packing instead of digging through email. */}
              <PoLabelsFile po={po} canUpload={!FROZEN.includes(po.status)} onChanged={load} onSignOut={onSignOut} />

              {/* What this order is actually counting. Receiving normally sets this itself;
                  it's here because it can also be attached (and undone) by hand for an
                  order opened mid-scan. */}
              {batches.length > 0 && (
                <div className="po-ov-batches">
                  <div className="po-ov-batches-head"><b>Received into</b></div>
                  {batches.map((b) => (
                    <div className="po-ov-batch" key={b.id}>
                      <span>
                        {b.batch_code}
                        <span className="muted sm"> · {b.units} unit{b.units === 1 ? '' : 's'} · {b.status}
                          {b.date_received ? ` · ${String(b.date_received).slice(0, 10)}` : ''}</span>
                      </span>
                      {!FROZEN.includes(po.status) && (
                        <button className="btn ghost sm" disabled={unlinkBusy === Number(b.id)} onClick={() => unlink(b.id)}>
                          {unlinkBusy === Number(b.id) ? 'Unlinking…' : 'Unlink'}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {(() => {
              // Whole-order manifest (Path C): one list for the whole purchase, no per-box
              // breakdown. Shown when it's already in use, or available. Receiving still
              // happens per box, like a blind receive.
              //
              // Enterable while the order is DRAFT *or* being RECEIVED: a supplier who
              // doesn't use the portal often sends their list after the boxes land, and
              // draft-only meant that list could never be entered at all.
              const orderLines = lines.filter((l) => l.po_box_id == null);
              const hasBoxLines = lines.some((l) => l.po_box_id != null);
              const canEnter = ['draft', 'receiving'].includes(po.status) && !hasBoxLines;
              if (!orderLines.length && !canEnter) return null;
              return (
                <div className="card po-ov-order">
                  <div className="po-ov-order-head">
                    <b>Whole-order manifest</b>
                    <span className="po-ov-label-units">{unitsByBox.get('order') || 0} unit{(unitsByBox.get('order') || 0) === 1 ? '' : 's'}</span>
                    <span className="muted xs">One list for the whole purchase — no per-box breakdown. Warehouse still receives box by box.</span>
                  </div>
                  {orderLines.length > 0 && (
                    <ul className={`po-lines po-ov-lines${canEditLines(po) ? ' editable' : ''}`}>
                      {canEditLines(po) && <PoLineHeader boxesOrder={boxesOrder} />}
                      {canEditLines(po)
                        ? orderLines.map((l) => (
                          <PoLineRow key={l.id} line={l} disabled={lineBusy === Number(l.id)} boxesOrder={boxesOrder}
                            attribution={lineAttribution(l)} onSave={(patch) => patchLine(l, patch)} />
                        ))
                        : orderLines.map((l) => (
                          <li key={l.id}>
                            <span className="po-line-name">{l.name || l.sku}</span>
                            <span className="po-line-meta">{l.sku} · {`size ${l.size}${boxesOrder ? ` · ${l.dimensions || 'no dimensions'}` : ''}`} · ×{l.qty_expected}</span>
                            {lineAttribution(l) && <span className="po-line-attribution muted xs">{lineAttribution(l)}</span>}
                          </li>
                        ))}
                    </ul>
                  )}
                  {/* One carton size across the whole list, because a boxes order is
                      normally a run of SKUs in the same box. Per-line editing stays on
                      each row. */}
                  {boxesOrder && canEditLines(po) && orderLines.length > 1 && (
                    <PoBulkDimensions lines={orderLines} onApplied={load} onSignOut={onSignOut} />
                  )}
                  {canEnter && (
                    <>
                      <button className="btn sm po-ov-fill-btn" onClick={() => setScanOrderPo(po)}>
                        <Icon name="camera" /> {orderLines.length ? 'Add more to the order manifest' : 'Add whole-order manifest'}
                      </button>
                      {po.status === 'receiving' && (
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

            {/* Bulk on-behalf entry: the supplier's whole manifest PDF at once. Same window
                as filling a single label by hand — a settled order's manifest is closed, and
                a whole-order manifest isn't per-label. */}
            {!FROZEN.includes(po.status) && po.manifest_scope !== 'po' && boxes.length > 0 && (
              /* Draws its own dashed container — wrapping it in a card too made a box
                 inside a box. */
              <PoManifestImport po={po} boxes={boxes} lines={lines} onImported={load} onSignOut={onSignOut} />
            )}

            <div className="po-labels-head">
              <h3 className="rows-title">Labels <span className="muted">({boxes.length})</span></h3>
              {/* Labels get added after the fact all the time: the supplier buys more, or a
                  tracking number only turns up later. */}
              <PoAddLabels po={po} boxes={boxes} onChanged={load} onSignOut={onSignOut} />
            </div>

            {boxes.map((box) => {
              const boxLines = lines.filter((l) => Number(l.po_box_id) === Number(box.id));
              // PH can fill a per-box manifest while it's still editable. Not when the PO is
              // on a whole-order manifest (that's entered against the order, not a label).
              //
              // A REPLACEMENT label runs the other way round: it's created already-shipped on
              // an order that's past draft, so it never passes that test. Its manifest stays
              // open until the order is archived, on any scope — the lines are a checklist for
              // the warehouse, and are excluded from reconciliation.
              const isReplacement = box.kind === 'replacement';
              // Staff writing the manifest FOR the supplier aren't bound by where the parcel
              // is — that's the whole point of the on-behalf path: the list arrives by message
              // after the box has gone, often after it has landed. Only a frozen order is off
              // limits.
              const canFill = isReplacement
                ? po.status !== 'closed'
                : (!FROZEN.includes(po.status) && po.manifest_scope !== 'po');
              // Already gone or landed: entering it now only sets what was EXPECTED. It can't
              // rewrite what the warehouse counted.
              const boxIsOut = !['pending', 'pre_transit'].includes(box.status);
              return (
                <div key={box.id} className={`card po-lbl${isReplacement ? ' replacement' : ''}`}>
                  <div className="po-lbl-head">
                    <div className="po-lbl-id">
                      {/* A reship we added to cover a shortage — not one of the supplier's
                          original labels, so don't number it as one. */}
                      <b>{isReplacement ? 'Replacement shipment' : `Label ${box.box_number}`}</b>
                      <div className="po-track muted sm">
                        {carrierName(box.carrier || box.carrier_key) ? <span className="po-carrier">{carrierName(box.carrier || box.carrier_key)}</span> : null}
                        {carrierName(box.carrier || box.carrier_key) && box.tracking_number ? ' · ' : ''}
                        {box.tracking_number || (carrierName(box.carrier || box.carrier_key) ? '' : '— no tracking #')}
                      </div>
                    </div>
                    <div className="po-lbl-side">
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
                        onClick={() => refreshTracking(box.id)}>
                        <Icon name="refresh" /> {trackBoxBusy === Number(box.id) ? 'Checking…' : 'Refresh this label'}
                      </button>
                    )}
                    {box.tracking_events?.length > 0 && (
                      <button className="btn ghost sm" onClick={() => toggleHistory(Number(box.id))}>
                        <Icon name="tag" /> {historyOpen.has(Number(box.id)) ? 'Hide history' : `Tracking history (${box.tracking_events.length})`}
                      </button>
                    )}
                    {/* Fix the tracking number, move the label to the order it really belongs
                        to, or drop it. `received` decides whether removing is offered at all
                        — see PoEdit.jsx. */}
                    <PoLabelTools po={po} box={box} pos={pos} received={boxReceived(box)}
                      onChanged={load} onSignOut={onSignOut} />
                  </div>
                  {historyOpen.has(Number(box.id)) && box.tracking_events?.length > 0 && (
                    <TrackingTimeline events={box.tracking_events} status={box.tracking_status} />
                  )}

                  {boxLines.length > 0 && (
                    /* Editable for staff, on the same terms as entering the list in the first
                       place: a manifest typed off a message gets a size wrong, a qty wrong, or
                       carries a pair the supplier later says isn't in the box. Being able to
                       ADD a line but never fix or drop one meant the only correction was to
                       delete the whole order and start again. */
                    <ul className={`po-lines po-ov-lines${canEditLines(po, box) ? ' editable' : ''}`}>
                      {canEditLines(po, box) && <PoLineHeader boxesOrder={boxesOrder} />}
                      {canEditLines(po, box)
                        ? boxLines.map((l) => (
                          <PoLineRow key={l.id} line={l} disabled={lineBusy === Number(l.id)} boxesOrder={boxesOrder}
                            attribution={lineAttribution(l)} onSave={(patch) => patchLine(l, patch)} />
                        ))
                        : boxLines.map((l) => (
                          <li key={l.id}>
                            <span className="po-line-name">{l.name || l.sku}</span>
                            <span className="po-line-meta">
                              {l.sku} · {`size ${l.size}${boxesOrder ? ` · ${l.dimensions || 'no dimensions'}` : ''}`} · ×{l.qty_expected}
                              {l.unit_cost != null && l.unit_cost !== '' && ` · $${Number(l.unit_cost).toFixed(2)} ea`}
                              {l.tip != null && l.tip !== '' && ` · tip $${Number(l.tip).toFixed(2)} ea`}
                            </span>
                            {lineAttribution(l) && <span className="po-line-attribution muted xs">{lineAttribution(l)}</span>}
                          </li>
                        ))}
                    </ul>
                  )}
                  {/* One carton size across this label's whole list. Per-line editing
                      stays on each row — this is the "they all ship in the same box" case. */}
                  {boxesOrder && canEditLines(po, box) && boxLines.length > 1 && (
                    <PoBulkDimensions lines={boxLines} onApplied={load} onSignOut={onSignOut} />
                  )}

                  {/* What the supplier says this box cost them — cost and tip are both per
                      pair, on the line for that size. Staff need to see it and this is the only
                      place they can; the totals follow whatever the rows above now say. */}
                  {(() => {
                    let items = 0; let tips = 0; let blank = 0; let any = false;
                    for (const l of boxLines) {
                      const qty = l.qty_expected || 0;
                      const c = l.unit_cost == null || l.unit_cost === '' ? null : Number(l.unit_cost);
                      const t = l.tip == null || l.tip === '' ? null : Number(l.tip);
                      if (c == null && t == null) { blank += qty; continue; }
                      items += (c || 0) * qty; tips += (t || 0) * qty; any = true;
                    }
                    if (!any) return null;
                    const usd = (n) => `$${Number(n || 0).toFixed(2)}`;
                    return (
                      <div className="po-box-total">
                        <span className="muted xs">
                          Cost {usd(items)}{tips > 0 ? ` + tips ${usd(tips)}` : ''}
                          {blank > 0 ? ` · ${blank} ${boxesOrder ? (blank === 1 ? 'box' : 'boxes') : `pair${blank === 1 ? '' : 's'}`} with nothing entered` : ''}
                        </span>
                        <span className="po-box-total-n">{usd(items + tips)}</span>
                      </div>
                    );
                  })()}

                  {canFill && boxLines.length === 0 && (
                    <p className="muted xs po-ov-fill-hint">{isReplacement
                      ? 'No items declared yet — enter what the supplier says they’re reshipping so the warehouse can check the box off against it. It won’t change the shortage on the original order.'
                      : boxIsOut
                        ? 'Nothing was declared for this label. If the supplier has since sent their list, enter it here — it sets what was expected, so the order stops reading as received blind. It can’t change what the warehouse counted.'
                        : 'No items yet — if the supplier sent a manual list of the box contents, enter it here so the warehouse can receive against this PO.'}</p>
                  )}
                  <div className="po-lbl-foot">
                    <PoLabelDownload poId={po.id} box={box} onSignOut={onSignOut} />
                    {canFill && (
                      <button className="btn sm po-ov-fill-btn" onClick={() => setScanBox(box)}>
                        <Icon name="camera" /> {boxLines.length
                          ? `Add more ${boxesOrder ? 'boxes' : 'items'} on their behalf`
                          : `Add ${boxesOrder ? 'boxes' : 'items'} on their behalf`}
                        {boxIsOut && <span className="po-ov-fill-late"> · label already sent</span>}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}

            {receivedUnmatched > 0 && (
              <p className="muted sm po-ov-unmatched">
                <b>{receivedUnmatched}</b> received unit{receivedUnmatched === 1 ? '' : 's'} on this order
                {receivedUnmatched === 1 ? " isn't" : " aren't"} counted against any label above — the box
                {receivedUnmatched === 1 ? ' it' : ' they'} came in has no tracking number, or one that
                doesn’t match a label here. The reconciliation still counts {receivedUnmatched === 1 ? 'it' : 'them'}.
              </p>
            )}

            {/* An order raised by mistake, or a duplicate. Only offered while nothing is
                received against it — otherwise the record of what arrived would go with the
                order. */}
            {!FROZEN.includes(po.status) && (
              batches.length === 0 ? (
                <div className="po-ov-danger">
                  <button className="btn ghost sm danger-link" onClick={() => { setDelPo(po); setDelText(''); }}>
                    Delete this purchase order
                  </button>
                </div>
              ) : (
                <div className="po-ov-danger">
                  <span className="muted xs">
                    Can’t be deleted while {batches.length} receiving batch(es) are linked —
                    unlink first. Deleting must never take the record of received stock with it.
                  </span>
                </div>
              )
            )}
          </>
        )}
      </div>

      {linkPo && (
        <PoLinkBatchModal po={linkPo} lines={lines}
          onClose={() => setLinkPo(null)}
          onLinked={() => { setLinkPo(null); load(); }}
          onSignOut={onSignOut} />
      )}

      {/* Deleting is guarded twice over: the order must have no receiving batch attached
          (the server refuses otherwise, and the database would too), and the PO code has to
          be typed back. Labels, manifest lines, the resolution and the thread go with it —
          there is no undo. */}
      {delPo && (
        <div className="modal-overlay" onClick={() => !delBusy && setDelPo(null)}>
          <div className="modal confirm po-del" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Delete {delPo.po_code}?</h3>
            <p className="modal-msg">
              This removes the order, its {boxes.length} label(s), everything the supplier
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

      {scanBox && <PoScanModal box={scanBox} boxesOrder={boxesOrder} onClose={() => setScanBox(null)} onAdded={load} onSignOut={onSignOut} />}
      {scanOrderPo && <PoScanModal po={scanOrderPo} boxesOrder={boxesOrder} onClose={() => setScanOrderPo(null)} onAdded={load} onSignOut={onSignOut} />}
    </div>
  );
}
