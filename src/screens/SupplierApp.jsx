// Supplier-facing scan-out app (Phase 1). A supplier account signs in — ideally
// on supplier.stickballman12.com — sees the pending "batches" (POs) the PH team
// opened for them, opens one, scans items under each shipping label, and ships
// each label. The batch closes (PO → 'shipped') once every label is shipped.
// Reuses the shared product search (UPC/SKU) and camera scanner; writes only the
// PO tables via /api/po/* (never the receiving path). See docs/context/purchase-orders.md.
import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { TopBar, TrackingTimeline } from '../components/common.jsx';
import { carrierName } from '../lib/carriers.js';
import { subStatusLabel, subStatusTone } from '../lib/trackstatus.js';
import { Icon } from '../components/NavIcons.jsx';
import { PoScanModal, PoLineRow } from '../components/PoScanModal.jsx';

const PO_STATUS = {
  draft:      { label: 'Filling',     cls: 'draft' },
  shipped:    { label: 'Shipped',     cls: 'shipped' },
  receiving:  { label: 'Receiving',   cls: 'receiving' },
  reconciled: { label: 'Reconciled',  cls: 'ok' },
  closed:     { label: 'Closed',      cls: 'muted' },
};

function PoStatusChip({ status }) {
  const s = PO_STATUS[status] || { label: status, cls: 'muted' };
  return <span className={`po-chip ${s.cls}`}>{s.label}</span>;
}

export function SupplierApp({ user, onSignOut }) {
  const [pos, setPos] = useState(null);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState(null);
  const [detail, setDetail] = useState(null); // { po, boxes, lines }
  const [businessName, setBusinessName] = useState(''); // for "…'s Staff" on-behalf attribution
  // The supplier only ever sees that a line was entered by the business's staff — never
  // which staff member (the server strips the identity from their /po/get response).
  const staffLabel = `${businessName || 'Stickballman12 LLC'}'s Staff`;
  const [scanBox, setScanBox] = useState(null); // po_box currently being scanned into
  const [closeReview, setCloseReview] = useState(null); // po_box being reviewed before closing
  const [busy, setBusy] = useState(false);
  const [lineBusy, setLineBusy] = useState(null); // po_line id currently being saved

  // Edit an already-scanned line (size and/or qty) while its label is still filling.
  // qty:0 removes it. The server merges a size change into a matching SKU+size line.
  const patchLine = async (line, patch) => {
    setLineBusy(Number(line.id)); setError('');
    try {
      await api.poLine(Number(line.id), patch);
      refreshDetail();
    } catch (e) {
      if (e.unauthorized) return onSignOut();
      setError(e.message);
    } finally { setLineBusy(null); }
  };

  const loadList = () => {
    api.poList()
      .then((r) => setPos(r.pos || []))
      .catch((e) => { if (e.unauthorized) return onSignOut(); setError(e.message); });
  };
  useEffect(loadList, []); // eslint-disable-line react-hooks/exhaustive-deps

  const openPo = (id) => {
    setOpenId(id); setDetail(null); setError('');
    api.poGet(id)
      .then((r) => { setDetail({ po: r.po, boxes: r.boxes, lines: r.lines }); setBusinessName(r.businessName || ''); })
      .catch((e) => { if (e.unauthorized) return onSignOut(); setError(e.message); });
  };
  const refreshDetail = () => { if (openId) openPo(openId); };

  const [trackBusy, setTrackBusy] = useState(false);  // whole-PO refresh
  const [trackBoxBusy, setTrackBoxBusy] = useState(null); // po_box id being refreshed on its own
  const [historyOpen, setHistoryOpen] = useState(() => new Set()); // box ids showing the tracking timeline
  const toggleHistory = (id) => setHistoryOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  // Refresh tracking status. Omit `boxId` to refresh every label at once; pass one to
  // refresh just that label (one tracking-API call instead of all — saves credits).
  const refreshTracking = async (boxId) => {
    if (boxId != null) setTrackBoxBusy(Number(boxId)); else setTrackBusy(true);
    setError('');
    try {
      const r = await api.poTrackRefresh(openId, boxId != null ? Number(boxId) : undefined);
      setDetail({ po: r.po, boxes: r.boxes, lines: r.lines });
    } catch (e) { if (e.unauthorized) return onSignOut(); setError(e.message); }
    finally { if (boxId != null) setTrackBoxBusy(null); else setTrackBusy(false); }
  };
  const boxStatusLabel = (b) => (b.status === 'delivered' ? 'Delivered ✓'
    : b.status === 'in_transit' ? 'In transit'
    : b.status === 'pre_transit' ? 'Label made · with supplier'
    : b.status === 'shipped' ? 'Shipped ✓'
    : b.status === 'packed' ? 'Ready to ship' : null);

  // Close a reviewed box for shipment (pending → packed). Opened from the review modal.
  const doCloseBox = async (box) => {
    setBusy(true); setError('');
    try {
      const r = await api.poCloseBox(Number(box.id));
      setDetail({ po: r.po, boxes: r.boxes, lines: r.lines });
      setCloseReview(null);
    } catch (e) {
      if (e.unauthorized) return onSignOut();
      setError(e.message);
    } finally { setBusy(false); }
  };

  // Reopen a closed (not yet shipped) box to keep editing (packed → pending).
  const reopenBox = async (box) => {
    setBusy(true); setError('');
    try {
      const r = await api.poReopenBox(Number(box.id));
      setDetail({ po: r.po, boxes: r.boxes, lines: r.lines });
    } catch (e) {
      if (e.unauthorized) return onSignOut();
      setError(e.message);
    } finally { setBusy(false); }
  };

  const shipLabel = async (box) => {
    if (!window.confirm(`Ship label ${box.box_number}${box.tracking_number ? ` (${box.tracking_number})` : ''}? You won't be able to edit its items after.`)) return;
    setBusy(true);
    try {
      const r = await api.poShip(Number(box.id));
      setDetail({ po: r.po, boxes: r.boxes, lines: r.lines });
      loadList();
    } catch (e) {
      if (e.unauthorized) return onSignOut();
      setError(e.message);
    } finally { setBusy(false); }
  };

  // ---- List view ----------------------------------------------------------
  if (!openId) {
    return (
      <div className="app">
        <TopBar title="Outbound Shipments" onSignOut={onSignOut} />
        <div className="wrap-narrow">
          <p className="muted sm">Signed in as <b>{user.name || user.username}</b> · your batches from Stickballman12.</p>
          {error && <div className="po-err">{error}</div>}
          {pos == null ? <p className="muted">Loading…</p>
            : pos.length === 0 ? <div className="card empty-state">No shipments assigned yet. When the Stickballman12 team opens a batch for you, it shows up here.</div>
            : (
              <div className="po-list">
                {pos.map((p) => (
                  <button key={p.id} className="po-card" onClick={() => openPo(p.id)}>
                    <div className="po-card-top">
                      <span className="po-code">{p.po_code}</span>
                      <PoStatusChip status={p.status} />
                    </div>
                    <div className="po-card-meta">
                      {p.tag_code && <span><Icon name="tag" /> {p.tag_code}</span>}
                      <span>{p.shipped_count}/{p.box_count} labels shipped</span>
                      <span>{p.unit_count} unit{p.unit_count === 1 ? '' : 's'}</span>
                    </div>
                    {p.reconcile_note && <div className="po-note-peek">{p.reconcile_note}</div>}
                  </button>
                ))}
              </div>
            )}
        </div>
      </div>
    );
  }

  // ---- Detail view --------------------------------------------------------
  const po = detail?.po;
  const linesFor = (boxId) => (detail?.lines || []).filter((l) => Number(l.po_box_id) === Number(boxId));
  return (
    <div className="app">
      <TopBar title={po ? po.po_code : 'Shipment'} onSignOut={onSignOut}
        right={<button className="btn ghost sm" onClick={() => { setOpenId(null); setDetail(null); }}>← Shipments</button>} />
      <div className="wrap-narrow">
        {error && <div className="po-err">{error}</div>}
        {!po ? <p className="muted">Loading…</p> : (
          <>
            <div className="card">
              <div className="po-card-top">
                <h3 className="rows-title">{po.po_code}{po.tag_code ? ` · ${po.tag_code}` : ''}</h3>
                <PoStatusChip status={po.status} />
              </div>
              <p className="muted sm">
                From {po.supplier_name}{po.date_of_purchase ? ` · purchased ${String(po.date_of_purchase).slice(0, 10)}` : ''}
              </p>
              {po.status !== 'draft'
                ? <p className="po-shipped-note">✓ All labels shipped — this batch is on its way to the warehouse.</p>
                : <p className="muted sm">Match each label to the tracking numbers we sent in the group chat, scan its items, then ship it. The batch closes when every label is shipped.</p>}
              {po.status !== 'draft' && (
                <button className="btn ghost sm po-track-refresh" disabled={trackBusy || trackBoxBusy != null} onClick={() => refreshTracking()}
                  title="Check every label at once">
                  <Icon name="refresh" /> {trackBusy ? 'Checking…' : 'Refresh all tracking'}
                </button>
              )}
              {/* The warehouse's reconciliation note, read-only. Attributed to the business,
                  never to the individual who wrote it — the server strips that name. */}
              {po.reconcile_note && (
                <div className="po-note">
                  <div className="po-note-head">
                    From {businessName || 'Stickballman12 LLC'}
                    {po.reconcile_note_at ? ` · ${String(po.reconcile_note_at).slice(0, 10)}` : ''}
                  </div>
                  {po.reconcile_note}
                </div>
              )}
            </div>

            {detail.boxes.map((box) => {
              const lines = linesFor(box.id);
              const units = lines.reduce((n, l) => n + (l.qty_expected || 0), 0);
              // A replacement label was added by the warehouse to cover a shortage on this
              // order — the supplier never packed it. Without saying so it reads as a box
              // they forgot to fill: numbered like their own, and empty.
              const isReplacement = box.kind === 'replacement';
              const isFilling = !isReplacement && box.status === 'pending';
              const isPacked = box.status === 'packed';
              // "En route" states carry live tracking (show the status line + refresh). pre_transit
              // means the label's made but the parcel is still with the supplier — tracking is active.
              const isShipped = ['shipped', 'in_transit', 'delivered', 'pre_transit'].includes(box.status);
              return (
                <div key={box.id} className={`card po-box ${isShipped ? 'shipped' : ''} ${isPacked ? 'packed' : ''} ${isReplacement ? 'replacement' : ''}`}>
                  <div className="po-card-top">
                    <div>
                      <b>{isReplacement ? 'Replacement shipment' : `Label ${box.box_number}`}</b>
                      <div className="po-track muted sm">
                        {carrierName(box.carrier || box.carrier_key) ? <span className="po-carrier">{carrierName(box.carrier || box.carrier_key)}</span> : null}
                        {carrierName(box.carrier || box.carrier_key) && box.tracking_number ? ' · ' : ''}
                        {box.tracking_number || (carrierName(box.carrier || box.carrier_key) ? '' : '— no tracking #')}
                      </div>
                    </div>
                    {isFilling
                      ? <span className="muted sm">{units} unit{units === 1 ? '' : 's'}</span>
                      : <span className={`po-chip ${box.status === 'delivered' ? 'ok' : box.status === 'in_transit' ? 'receiving' : box.status === 'pre_transit' ? 'pretransit' : box.status === 'packed' ? 'packed' : 'shipped'}`}>{boxStatusLabel(box)}</span>}
                  </div>

                  {isReplacement && (
                    <p className="po-box-note sm">
                      Tracking for the replacement covering the pairs that came up short.
                      {' '}{businessName || 'Stickballman12 LLC'} added it here so both sides can
                      follow the same number — there’s no manifest to fill in.
                    </p>
                  )}

                  {isShipped && (box.tracking_status || box.last_checkpoint || box.tracking_sub_status) && (
                    <div className="po-track-status muted sm">
                      {box.carrier ? <span className="po-track-carrier">{box.carrier}</span> : null}
                      {box.tracking_status ? <span> · {box.tracking_status}</span> : null}
                      {/* The detail behind the coarse status — "Exception" alone doesn't say
                          whether customs is holding it or it's already on its way back. */}
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
                    {isShipped && box.tracking_number && (
                      <button className="btn ghost sm po-track-refresh-one" disabled={trackBusy || trackBoxBusy != null}
                        onClick={() => refreshTracking(box.id)} title="Check just this label (saves credits)">
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

                  {lines.length > 0 && (
                    isFilling ? (
                      <ul className="po-lines po-lines-edit">
                        {lines.map((l) => (
                          <PoLineRow key={l.id} line={l} disabled={busy || lineBusy === Number(l.id)}
                            onSave={(patch) => patchLine(l, patch)}
                            attribution={l.entered_on_behalf ? `Entered for you by ${staffLabel}` : null} />
                        ))}
                      </ul>
                    ) : (
                      <ul className="po-lines">
                        {lines.map((l) => (
                          <li key={l.id}>
                            <span className="po-line-name">{l.name || l.sku}</span>
                            <span className="po-line-meta">{l.sku} · size {l.size} · ×{l.qty_expected}</span>
                            {l.entered_on_behalf && <span className="po-line-attribution muted xs">Entered for you by {staffLabel}</span>}
                          </li>
                        ))}
                      </ul>
                    )
                  )}

                  {isFilling && (
                    <div className="po-box-actions">
                      <button className="btn sm" onClick={() => setScanBox(box)}><Icon name="camera" /> Add items</button>
                      <button className="btn sm primary" disabled={units < 1 || busy} onClick={() => setCloseReview(box)}>Review &amp; close box</button>
                    </div>
                  )}
                  {isPacked && (
                    <div className="po-box-actions">
                      <button className="btn sm ghost" disabled={busy} onClick={() => reopenBox(box)}>Reopen to edit</button>
                      <button className="btn sm primary" disabled={busy} onClick={() => shipLabel(box)}>Ship label</button>
                    </div>
                  )}
                </div>
              );
            })}

            {(() => {
              // Whole-order manifest (Path C): lines the Stickballman12 team entered for the
              // whole purchase, not tied to a single label. Read-only on the supplier side.
              const orderLines = (detail.lines || []).filter((l) => l.po_box_id == null);
              if (!orderLines.length) return null;
              const units = orderLines.reduce((n, l) => n + (l.qty_expected || 0), 0);
              return (
                <div className="card po-box">
                  <div className="po-card-top">
                    <div><b>Order manifest</b><div className="po-track muted sm">Entered for the whole purchase</div></div>
                    <span className="muted sm">{units} unit{units === 1 ? '' : 's'}</span>
                  </div>
                  <ul className="po-lines">
                    {orderLines.map((l) => (
                      <li key={l.id}>
                        <span className="po-line-name">{l.name || l.sku}</span>
                        <span className="po-line-meta">{l.sku} · size {l.size} · ×{l.qty_expected}</span>
                        {l.entered_on_behalf && <span className="po-line-attribution muted xs">Entered for you by {staffLabel}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })()}
          </>
        )}
      </div>

      {scanBox && (
        <PoScanModal box={scanBox} onClose={() => setScanBox(null)}
          onAdded={refreshDetail} onSignOut={onSignOut} />
      )}

      {closeReview && (() => {
        const lines = linesFor(closeReview.id);
        const units = lines.reduce((n, l) => n + (l.qty_expected || 0), 0);
        return (
          <div className="modal-overlay" onClick={() => setCloseReview(null)}>
            <div className="modal confirm" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
              <h3 className="modal-title">Review Label {closeReview.box_number}</h3>
              <p className="modal-msg">Check everything you’re shipping under this label. Closing it marks the box <b>ready to ship</b> — you can still reopen it to edit until you actually ship.</p>
              {lines.length === 0 ? <p className="muted">No items scanned yet.</p> : (
                <ul className="po-lines po-review-lines">
                  {lines.map((l) => (
                    <li key={l.id}>
                      <span className="po-line-name">{l.name || l.sku}</span>
                      <span className="po-line-meta">{l.sku} · size {l.size} · ×{l.qty_expected}</span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="po-review-total"><b>{units}</b> unit{units === 1 ? '' : 's'} · <b>{lines.length}</b> line{lines.length === 1 ? '' : 's'}</p>
              <div className="modal-actions">
                <button type="button" className="btn ghost" disabled={busy} onClick={() => setCloseReview(null)}>Keep editing</button>
                <button type="button" className="btn primary" disabled={busy || units < 1} onClick={() => doCloseBox(closeReview)}>Close box for shipment</button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
