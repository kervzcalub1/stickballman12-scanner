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
import { PoScanModal } from '../components/PoScanModal.jsx';
import { ManifestPrint } from '../components/ManifestPrint.jsx';

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

function PoStatusChip({ status }) {
  const s = PO_STATUS[status] || { label: status, cls: 'muted' };
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

  // Reload the open PO's detail after entering items on behalf of the supplier.
  const refreshOpenDetail = () => {
    if (openId == null) return;
    api.poGet(openId)
      .then((r) => setDetail({ po: r.po, boxes: r.boxes, lines: r.lines }))
      .catch((e) => { if (e.unauthorized) return onSignOut(); setError(e.message); });
    loadList(); // unit counts on the list may have advanced
  };

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
      .then((r) => { if (!cancelled) setDetail({ po: r.po, boxes: r.boxes, lines: r.lines }); })
      .catch((e) => { if (cancelled) return; if (e.unauthorized) return onSignOut(); setError(e.message); })
      .finally(() => { if (!cancelled) setDetailBusy(false); });
    return () => { cancelled = true; };
  }, [openId]); // eslint-disable-line react-hooks/exhaustive-deps

  // p.id is a BIGINT that arrives as a STRING; openId is numeric — compare coerced.
  const toggle = (id) => setOpenId(Number(openId) === Number(id) ? null : id);

  // Refresh tracking — omit boxId for the whole PO, pass it for a single label.
  const refreshTracking = async (poId, boxId) => {
    if (boxId != null) setTrackBoxBusy(Number(boxId)); else setTrackBusy(true);
    setError('');
    try {
      const r = await api.poTrackRefresh(poId, boxId != null ? Number(boxId) : undefined);
      setDetail({ po: r.po, boxes: r.boxes, lines: r.lines });
      loadList(); // label counts on the list may have advanced
    } catch (e) { if (e.unauthorized) return onSignOut(); setError(e.message); }
    finally { if (boxId != null) setTrackBoxBusy(null); else setTrackBusy(false); }
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
                        <PoStatusChip status={p.status} />
                      </div>
                      <div className="po-ov-meta muted sm">
                        {p.tag_code && <span><Icon name="tag" /> {p.tag_code}</span>}
                        <span>{p.shipped_count}/{p.box_count} label{p.box_count === 1 ? '' : 's'} shipped</span>
                        {p.delivered_count > 0 && <span>{p.delivered_count} delivered</span>}
                        <span>{p.unit_count} unit{p.unit_count === 1 ? '' : 's'}</span>
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
                            </div>
                            <ManifestPrint poId={p.id} poCode={p.po_code} onSignOut={onSignOut} />
                            {(() => {
                              // Whole-order manifest (Path C): one list for the whole purchase, no per-box
                              // breakdown. Shown when it's already in use, or available (draft PO with no
                              // per-box lines yet). Receiving still happens per box, like a blind receive.
                              const orderLines = (detail.lines || []).filter((l) => l.po_box_id == null);
                              const hasBoxLines = (detail.lines || []).some((l) => l.po_box_id != null);
                              const isDraft = detail.po.status === 'draft';
                              if (!orderLines.length && (!isDraft || hasBoxLines)) return null;
                              return (
                                <div className="po-ov-order">
                                  <div className="po-ov-order-head">
                                    <b>Whole-order manifest</b>
                                    <span className="muted xs">One list for the whole purchase — no per-box breakdown. Warehouse still receives box by box.</span>
                                  </div>
                                  {orderLines.length > 0 && (
                                    <ul className="po-lines po-ov-lines">
                                      {orderLines.map((l) => (
                                        <li key={l.id}>
                                          <span className="po-line-name">{l.name || l.sku}</span>
                                          <span className="po-line-meta">{l.sku} · size {l.size} · ×{l.qty_expected}</span>
                                          {l.entered_on_behalf && (
                                            <span className="po-line-attribution muted xs">
                                              Entered by {l.entered_by_name || l.entered_by_username || 'staff'} · on supplier’s behalf
                                            </span>
                                          )}
                                        </li>
                                      ))}
                                    </ul>
                                  )}
                                  {isDraft && !hasBoxLines && (
                                    <button className="btn sm po-ov-fill-btn" onClick={() => setScanOrderPo(detail.po)}>
                                      <Icon name="camera" /> {orderLines.length ? 'Add more to the order manifest' : 'Add whole-order manifest'}
                                    </button>
                                  )}
                                </div>
                              );
                            })()}
                            {detail.boxes.map((box) => (
                              <div key={box.id} className={`po-ov-label${box.kind === 'replacement' ? ' replacement' : ''}`}>
                                <div className="po-ov-label-top">
                                  <div>
                                    {/* A reship we added to cover a shortage — not one of the
                                        supplier's original labels, so don't number it as one. */}
                                    <b>{box.kind === 'replacement' ? 'Replacement shipment' : `Label ${box.box_number}`}</b>
                                    <div className="po-track muted sm">
                                      {carrierName(box.carrier || box.carrier_key) ? <span className="po-carrier">{carrierName(box.carrier || box.carrier_key)}</span> : null}
                                      {carrierName(box.carrier || box.carrier_key) && box.tracking_number ? ' · ' : ''}
                                      {box.tracking_number || (carrierName(box.carrier || box.carrier_key) ? '' : '— no tracking #')}
                                    </div>
                                  </div>
                                  <span className={`po-chip ${boxChipCls(box.status)}`}>{boxStatusLabel(box.status)}</span>
                                </div>
                                {(box.tracking_status || box.last_checkpoint || box.tracking_sub_status) && (
                                  <div className="po-track-status muted sm">
                                    {box.carrier ? <span className="po-track-carrier">{box.carrier}</span> : null}
                                    {box.tracking_status ? <span> · {box.tracking_status}</span> : null}
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
                                    {box.last_checkpoint ? <div className="po-track-checkpoint">{box.last_checkpoint}</div> : null}
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
                                  const canFill = isReplacement
                                    ? detail.po.status !== 'closed'
                                    : (detail.po.status === 'draft' && box.status === 'pending' && detail.po.manifest_scope !== 'po');
                                  return (
                                    <>
                                      {lines.length > 0 && (
                                        <ul className="po-lines po-ov-lines">
                                          {lines.map((l) => (
                                            <li key={l.id}>
                                              <span className="po-line-name">{l.name || l.sku}</span>
                                              <span className="po-line-meta">{l.sku} · size {l.size} · ×{l.qty_expected}</span>
                                              {l.entered_on_behalf && (
                                                <span className="po-line-attribution muted xs">
                                                  Entered by {l.entered_by_name || l.entered_by_username || 'staff'} · on supplier’s behalf
                                                </span>
                                              )}
                                            </li>
                                          ))}
                                        </ul>
                                      )}
                                      {canFill && lines.length === 0 && (
                                        <p className="muted xs po-ov-fill-hint">{isReplacement
                                          ? 'No items declared yet — enter what the supplier says they’re reshipping so the warehouse can check the box off against it. It won’t change the shortage on the original order.'
                                          : 'No items yet — if the supplier sent a manual list of the box contents, enter it here so the warehouse can receive against this PO.'}</p>
                                      )}
                                      {canFill && (
                                        <button className="btn sm po-ov-fill-btn" onClick={() => setScanBox(box)}>
                                          <Icon name="camera" /> {lines.length ? 'Add more items on their behalf' : 'Add items on their behalf'}
                                        </button>
                                      )}
                                    </>
                                  );
                                })()}
                              </div>
                            ))}
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
