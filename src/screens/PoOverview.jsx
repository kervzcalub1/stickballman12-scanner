// PH "Purchase Orders" overview — every PO the team opened, with its status and
// per-label shipment tracking. Read-only: PH can see what they submitted to suppliers
// (draft → shipped → receiving → reconciled/closed) and where each label is, and pull
// fresh tracking (all labels or one at a time). Complements PO Reconciliation, which
// only shows POs already received against. Uses /api/po/list + /api/po/get +
// /api/po/track-refresh. See docs/context/purchase-orders.md.
import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { TopBar } from '../components/common.jsx';
import { Icon } from '../components/NavIcons.jsx';

const PO_STATUS = {
  draft:      { label: 'Filling',    cls: 'draft' },
  shipped:    { label: 'Shipped',    cls: 'shipped' },
  receiving:  { label: 'Receiving',  cls: 'receiving' },
  reconciled: { label: 'Reconciled', cls: 'ok' },
  closed:     { label: 'Closed',     cls: 'muted' },
};
const boxStatusLabel = (s) => (s === 'delivered' ? 'Delivered ✓'
  : s === 'in_transit' ? 'In transit'
  : s === 'shipped' ? 'Shipped'
  : s === 'packed' ? 'Ready to ship' : 'Filling');
const boxChipCls = (s) => (s === 'delivered' ? 'ok' : s === 'in_transit' ? 'receiving' : s === 'shipped' ? 'shipped' : s === 'packed' ? 'packed' : 'draft');

function PoStatusChip({ status }) {
  const s = PO_STATUS[status] || { label: status, cls: 'muted' };
  return <span className={`po-chip ${s.cls}`}>{s.label}</span>;
}

export function PoOverview({ onHome, onSignOut }) {
  const [pos, setPos] = useState(null);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState(null);
  const [detail, setDetail] = useState(null);          // { po, boxes, lines }
  const [detailBusy, setDetailBusy] = useState(false);
  const [trackBusy, setTrackBusy] = useState(false);    // whole-PO refresh
  const [trackBoxBusy, setTrackBoxBusy] = useState(null);

  const loadList = () => {
    api.poList()
      .then((r) => setPos(r.pos || []))
      .catch((e) => { if (e.unauthorized) return onSignOut(); setError(e.message); });
  };
  useEffect(loadList, []); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (id) => {
    if (openId === id) { setOpenId(null); setDetail(null); return; }
    setOpenId(id); setDetail(null); setDetailBusy(true); setError('');
    api.poGet(id)
      .then((r) => setDetail({ po: r.po, boxes: r.boxes, lines: r.lines }))
      .catch((e) => { if (e.unauthorized) return onSignOut(); setError(e.message); })
      .finally(() => setDetailBusy(false));
  };

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
                const open = openId === p.id;
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
                            {detail.boxes.map((box) => (
                              <div key={box.id} className="po-ov-label">
                                <div className="po-ov-label-top">
                                  <div>
                                    <b>Label {box.box_number}</b>
                                    <div className="po-track muted sm">{box.tracking_number || '— no tracking #'}</div>
                                  </div>
                                  <span className={`po-chip ${boxChipCls(box.status)}`}>{boxStatusLabel(box.status)}</span>
                                </div>
                                {(box.tracking_status || box.last_checkpoint) && (
                                  <div className="po-track-status muted sm">
                                    {box.carrier ? <span className="po-track-carrier">{box.carrier}</span> : null}
                                    {box.tracking_status ? <span> · {box.tracking_status}</span> : null}
                                    {box.last_checkpoint ? <div className="po-track-checkpoint">{box.last_checkpoint}</div> : null}
                                  </div>
                                )}
                                {box.tracking_number && ['shipped', 'in_transit', 'delivered'].includes(box.status) && (
                                  <button className="btn ghost sm po-track-refresh-one" disabled={trackBusy || trackBoxBusy != null}
                                    onClick={() => refreshTracking(p.id, box.id)}>
                                    <Icon name="refresh" /> {trackBoxBusy === Number(box.id) ? 'Checking…' : 'Refresh this label'}
                                  </button>
                                )}
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
    </div>
  );
}
