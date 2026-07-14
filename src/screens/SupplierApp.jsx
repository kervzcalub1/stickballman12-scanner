// Supplier-facing scan-out app (Phase 1). A supplier account signs in — ideally
// on supplier.stickballman12.com — sees the pending "batches" (POs) the PH team
// opened for them, opens one, scans items under each shipping label, and ships
// each label. The batch closes (PO → 'shipped') once every label is shipped.
// Reuses the shared product search (UPC/SKU) and camera scanner; writes only the
// PO tables via /api/po/* (never the receiving path). See docs/context/purchase-orders.md.
import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { TopBar, TrackingTimeline } from '../components/common.jsx';
import { carrierName } from '../lib/carriers.js';
import { Icon } from '../components/NavIcons.jsx';
import { isUpcCode, usSizeChart, compareSizes } from '../lib/codes.js';

const CameraScanner = lazy(() => import('../components/CameraScanner.jsx'));

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
      .then((r) => setDetail({ po: r.po, boxes: r.boxes, lines: r.lines }))
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
            </div>

            {detail.boxes.map((box) => {
              const lines = linesFor(box.id);
              const units = lines.reduce((n, l) => n + (l.qty_expected || 0), 0);
              const isFilling = box.status === 'pending';
              const isPacked = box.status === 'packed';
              const isShipped = box.status === 'shipped' || box.status === 'in_transit' || box.status === 'delivered';
              return (
                <div key={box.id} className={`card po-box ${isShipped ? 'shipped' : ''} ${isPacked ? 'packed' : ''}`}>
                  <div className="po-card-top">
                    <div>
                      <b>Label {box.box_number}</b>
                      <div className="po-track muted sm">
                        {carrierName(box.carrier || box.carrier_key) ? <span className="po-carrier">{carrierName(box.carrier || box.carrier_key)}</span> : null}
                        {carrierName(box.carrier || box.carrier_key) && box.tracking_number ? ' · ' : ''}
                        {box.tracking_number || (carrierName(box.carrier || box.carrier_key) ? '' : '— no tracking #')}
                      </div>
                    </div>
                    {isFilling
                      ? <span className="muted sm">{units} unit{units === 1 ? '' : 's'}</span>
                      : <span className={`po-chip ${box.status === 'delivered' ? 'ok' : box.status === 'in_transit' ? 'receiving' : box.status === 'packed' ? 'packed' : 'shipped'}`}>{boxStatusLabel(box)}</span>}
                  </div>

                  {isShipped && (box.tracking_status || box.last_checkpoint) && (
                    <div className="po-track-status muted sm">
                      {box.carrier ? <span className="po-track-carrier">{box.carrier}</span> : null}
                      {box.tracking_status ? <span> · {box.tracking_status}</span> : null}
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
                            onSave={(patch) => patchLine(l, patch)} />
                        ))}
                      </ul>
                    ) : (
                      <ul className="po-lines">
                        {lines.map((l) => (
                          <li key={l.id}>
                            <span className="po-line-name">{l.name || l.sku}</span>
                            <span className="po-line-meta">{l.sku} · size {l.size} · ×{l.qty_expected}</span>
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
          </>
        )}
      </div>

      {scanBox && (
        <ScanModal box={scanBox} onClose={() => setScanBox(null)}
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

// One editable scanned line on a still-filling label: rename-free, but the size can be
// corrected and the qty nudged (or the line removed at ×0). Size commits on blur/Enter;
// qty posts on each ± tap. The parent reloads the PO after each save.
function PoLineRow({ line, disabled, onSave }) {
  const [size, setSize] = useState(String(line.size ?? ''));
  useEffect(() => { setSize(String(line.size ?? '')); }, [line.size]);
  const commitSize = () => {
    const v = size.trim();
    if (!v || v === String(line.size)) { setSize(String(line.size ?? '')); return; }
    onSave({ size: v });
  };
  return (
    <li className="po-line-edit">
      <div className="po-line-head">
        <span className="po-line-name">{line.name || line.sku}</span>
        <span className="po-line-meta">{line.sku}</span>
      </div>
      <div className="po-line-controls">
        <label className="po-line-size">
          <span className="muted xs">Size</span>
          <input className="sz" value={size} disabled={disabled} inputMode="decimal"
            onChange={(e) => setSize(e.target.value)} onBlur={commitSize}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }} />
        </label>
        <div className="qty-stepper">
          <button type="button" className="btn icon ghost step" disabled={disabled || line.qty_expected <= 1}
            onClick={() => onSave({ qty: line.qty_expected - 1 })}>−</button>
          <span className="qty-val">×{line.qty_expected}</span>
          <button type="button" className="btn icon ghost step" disabled={disabled}
            onClick={() => onSave({ qty: line.qty_expected + 1 })}>+</button>
        </div>
        <button type="button" className="btn icon ghost remove" title="Remove item" disabled={disabled}
          onClick={() => onSave({ qty: 0 })}>×</button>
      </div>
    </li>
  );
}

// Scan / type a UPC or SKU → resolve the product → tap size chips (tap again for
// +1) → add the whole shoe (every size) to the label at once, like the warehouse
// Add-Item flow. Each size posts one po_line via /api/po/scan.
let rowKey = 0;
const sameSku = (a, b) => String(a || '').toUpperCase().replace(/[\s-]/g, '') === String(b || '').toUpperCase().replace(/[\s-]/g, '');

function ScanModal({ box, onClose, onAdded, onSignOut }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState(null); // { type, text } — matches the warehouse scan flash
  // draft = { name, sku, upc, colorway, gender, image, sizeOptions, rows:[{key,size,qty}] }
  const [draft, setDraft] = useState(null);
  const [mCam, setMCam] = useState(false);            // inline live camera toggle (like warehouse)
  const [camZoom, setCamZoom] = useState(1);          // 1× / 2× camera zoom (like warehouse)
  const [recent, setRecent] = useState([]);           // running "added to this label" tally (session)
  const [pendingSwitch, setPendingSwitch] = useState(null); // a different shoe scanned mid-draft
  const draftRef = useRef(null); draftRef.current = draft; // so the camera callback sees the live draft
  const recentRef = useRef({});                       // code -> last-seen ms (dedup gun/camera re-reads)
  const inputRef = useRef(null);

  // Merge a server-returned po_line into the running tally (its live incremented qty).
  const recordScan = (line, fallbackName) => setRecent((rs) => {
    if (!line) return rs;
    const key = `${line.sku}|#|${line.size}`;
    return [{ key, name: line.name || fallbackName || line.sku, size: line.size, qty: line.qty_expected ?? 1 },
      ...rs.filter((r) => r.key !== key)];
  });

  // Scan/type a code → resolve → build/accumulate the draft, exactly like the
  // warehouse Add-Item flow: the catalog size auto-fills, re-scanning the same shoe
  // bumps that size, and a *different* shoe prompts to finish the current one first.
  // Repeat reads within 1.2s (gun / continuous camera) are ignored.
  const resolve = async (raw, { showInField = false } = {}) => {
    const c = String(raw).trim();
    if (!c) return;
    const now = Date.now();
    if (recentRef.current[c] && now - recentRef.current[c] < 1200) return; // gun/camera re-read
    recentRef.current[c] = now;
    setCode(showInField ? c : ''); setError('');
    setBusy(true);
    try {
      const isUpc = isUpcCode(c);
      const { product: p } = isUpc ? await api.searchUpc(c) : await api.searchSku(c);
      const incoming = {
        name: p.name || '', sku: p.sku || (isUpc ? '' : c), image: p.image || '',
        upc: (isUpc ? c : '') || p.upc || '', colorway: p.colorway || '', gender: p.gender || null,
        scannedSize: p.scannedSize ? String(p.scannedSize) : null, sizeOptions: p.sizes || [],
      };
      const d = draftRef.current;
      if (!d) {
        const rows = incoming.scannedSize ? [{ key: rowKey++, size: incoming.scannedSize, qty: 1 }] : [];
        setDraft({ ...incoming, rows });
        setFlash(incoming.scannedSize
          ? { type: 'added', text: `✓ ${incoming.name || c} · size ${incoming.scannedSize}` }
          : { type: 'warn', text: `Scanned ${incoming.name || c} — no size from the catalog. Tap the size below.` });
      } else if (!sameSku(d.sku, incoming.sku)) {
        setPendingSwitch(incoming); // different shoe → confirm switch (finish current first)
      } else if (incoming.scannedSize) {
        addSize(incoming.scannedSize);
        setFlash({ type: 'added', text: `+1 · size ${incoming.scannedSize}` });
      } else {
        setFlash({ type: 'warn', text: 'Scanned, but no size from the catalog. Tap the size below.' });
      }
    } catch (e) {
      if (e.unauthorized) return onSignOut();
      setError(e.message || 'Could not find that code.'); setFlash({ type: 'dup', text: 'Not found' });
    } finally { setBusy(false); }
  };

  // Size helpers — mirror the warehouse Add-Item behavior.
  const sizePool = () => {
    const apiSizes = draft?.sizeOptions || [];
    const tokens = [...apiSizes, ...(draft?.rows || []).map((r) => r.size)].map((s) => String(s || ''));
    const kind = tokens.some((s) => /y$/i.test(s)) ? 'y' : tokens.some((s) => /w$/i.test(s)) ? 'w' : '';
    const pool = apiSizes.length > 1 ? apiSizes : [...new Set([...apiSizes, ...usSizeChart(kind)])];
    return pool.filter((s) => !(draft?.rows || []).some((r) => String(r.size) === String(s)));
  };
  const addSize = (s) => setDraft((d) => {
    const i = d.rows.findIndex((r) => String(r.size) === String(s));
    if (i >= 0) { const rows = d.rows.slice(); rows[i] = { ...rows[i], qty: rows[i].qty + 1 }; return { ...d, rows }; }
    return { ...d, rows: [...d.rows, { key: rowKey++, size: String(s), qty: 1 }] };
  });
  const addCustom = () => setDraft((d) => ({ ...d, rows: [...d.rows, { key: rowKey++, size: '', qty: 1 }] }));
  const setRow = (key, patch) => setDraft((d) => ({ ...d, rows: d.rows.map((r) => (r.key === key ? { ...r, ...patch } : r)) }));
  const bump = (key, by) => setDraft((d) => ({ ...d, rows: d.rows.map((r) => (r.key === key ? { ...r, qty: Math.max(1, r.qty + by) } : r)) }));
  const removeRow = (key) => setDraft((d) => ({ ...d, rows: d.rows.filter((r) => r.key !== key) }));

  // Commit the whole draft (every size) to the label. Returns true on success.
  const addToLabel = async () => {
    const rows = (draft?.rows || [])
      .map((r) => ({ size: String(r.size).trim(), qty: Math.max(1, parseInt(r.qty, 10) || 1) }))
      .filter((r) => r.size);
    if (!draft?.sku) { setError('A SKU is required.'); return false; }
    if (rows.length === 0) { setError('Tap at least one size.'); return false; }
    setBusy(true); setError('');
    try {
      for (const r of rows) {
        const { line } = await api.poScan({
          poBoxId: Number(box.id), sku: draft.sku, size: r.size, qty: r.qty,
          name: draft.name, upc: draft.upc, colorway: draft.colorway, gender: draft.gender,
        });
        recordScan(line, draft.name);
      }
      const total = rows.reduce((n, r) => n + r.qty, 0);
      setFlash({ type: 'added', text: `Added ${draft.name || draft.sku} · ${total} unit${total === 1 ? '' : 's'} to Label ${box.box_number}` });
      setDraft(null); onAdded();
      return true;
    } catch (e) {
      if (e.unauthorized) { onSignOut(); return false; }
      setError(e.message); onAdded(); return false; // reflect whatever landed before the failure
    } finally { setBusy(false); }
  };

  // "Different shoe" prompt: commit the current shoe, then open the new one.
  const confirmSwitch = async () => {
    const next = pendingSwitch;
    const ok = await addToLabel();
    setPendingSwitch(null);
    if (ok && next) {
      const rows = next.scannedSize ? [{ key: rowKey++, size: next.scannedSize, qty: 1 }] : [];
      setDraft({ ...next, rows });
      setFlash(next.scannedSize
        ? { type: 'added', text: `✓ ${next.name || next.sku} · size ${next.scannedSize}` }
        : { type: 'warn', text: `Scanned ${next.name || next.sku} — tap the size below.` });
    }
  };

  const totalUnits = (draft?.rows || []).reduce((n, r) => n + (parseInt(r.qty, 10) || 0), 0);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal additem" role="dialog" aria-modal="true"
        onClick={(e) => { e.stopPropagation(); if (!mCam) inputRef.current?.focus({ preventScroll: true }); }}>
        <div className="modal-head">
          <h3 className="modal-title">Add items · Label {box.box_number}</h3>
          <button type="button" className="btn icon ghost" onClick={onClose}>×</button>
        </div>

        <form className="searchrow" onSubmit={(e) => { e.preventDefault(); resolve(code, { showInField: true }); }}>
          <input ref={inputRef} autoFocus autoCapitalize="characters" autoCorrect="off"
            placeholder="Scan or type UPC / SKU" value={code} onChange={(e) => setCode(e.target.value)} disabled={busy} />
          <button className="btn primary" disabled={busy}>{busy ? '…' : 'Add'}</button>
          <button type="button" className={`btn ${mCam ? 'primary' : 'ghost'}`} onClick={() => setMCam((v) => !v)} title="Scan with camera"><Icon name="camera" /></button>
        </form>
        {mCam && (
          <Suspense fallback={<p className="muted">Loading camera…</p>}>
            <CameraScanner continuous mode="product" onDetected={(c) => resolve(c, { showInField: true })} onClose={() => setMCam(false)}
              zoom={camZoom} onZoomChange={setCamZoom} />
          </Suspense>
        )}

        <div className="scan-flash-live" role="status" aria-live="polite">
          {flash && <div className={`scan-flash ${flash.type}`}>{flash.text}</div>}
        </div>
        {error && <div className="error sm mt">{error}</div>}
        {!draft && !busy && (
          <p className="muted sm mt">Scan a shoe’s UPC to begin — its size auto-fills. Add other sizes with the chips, or “+ Custom” if a size isn’t listed. Re-scanning the same shoe bumps its size by 1.</p>
        )}

        {recent.length > 0 && (
          <div className="po-scan-recent">
            <div className="muted sm">Added to Label {box.box_number}</div>
            <ul className="po-lines">
              {recent.map((r) => (
                <li key={r.key}>
                  <span className="po-line-name">{r.name}</span>
                  <span className="po-line-meta">size {r.size} · ×{r.qty}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {draft && (
          // Any interaction with the draft closes the live camera so it can't keep
          // detecting in the background.
          <div className="additem-draft" onPointerDownCapture={() => { if (mCam) setMCam(false); }}>
            <div className="additem-product">
              {draft.image ? <img className="cart-thumb" src={draft.image} alt="" /> : <div className="cart-thumb placeholder">—</div>}
              <div className="cart-fields">
                <input className="cart-name" placeholder="Product name" value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
                <input placeholder="SKU" value={draft.sku} onChange={(e) => setDraft((d) => ({ ...d, sku: e.target.value }))} />
              </div>
            </div>
            <div className="size-rows">
              <div className="muted sm">The scanned size is filled in below. Tap a chip to add another size (tap again for +1), or “+ Custom” if a size isn’t listed.</div>
              <div className="size-chips">
                {sizePool().map((s) => (
                  <button type="button" key={s} className="size-chip" onClick={() => addSize(s)}>{s}</button>
                ))}
                <button type="button" className="size-chip custom" onClick={addCustom}>+ Custom</button>
              </div>
              {[...draft.rows].sort((a, b) => compareSizes(a.size, b.size)).map((r) => (
                <div className="size-line" key={r.key}>
                  <input className={`sz ${!String(r.size).trim() ? 'need' : ''}`} placeholder="Size" value={r.size} onChange={(e) => setRow(r.key, { size: e.target.value })} autoFocus={!String(r.size).trim()} />
                  <div className="qty-stepper">
                    <button type="button" className="btn icon ghost step" onClick={() => bump(r.key, -1)}>−</button>
                    <input className="qty" type="number" inputMode="numeric" min="1" value={r.qty} onChange={(e) => setRow(r.key, { qty: Math.max(1, parseInt(e.target.value, 10) || 1) })} />
                    <button type="button" className="btn icon ghost step" onClick={() => bump(r.key, 1)}>+</button>
                  </div>
                  <button type="button" className="btn icon ghost remove" title="Remove size" onClick={() => removeRow(r.key)}>×</button>
                </div>
              ))}
            </div>
            <div className="modal-actions">
              <button type="button" className="btn ghost" onClick={() => setDraft(null)}>Cancel</button>
              <button type="button" className="btn primary wide" disabled={busy || totalUnits < 1} onClick={addToLabel}>
                Add {totalUnits > 0 ? `${totalUnits} unit${totalUnits === 1 ? '' : 's'} ` : ''}to label
              </button>
            </div>
          </div>
        )}

        {pendingSwitch && (
          <div className="modal-overlay" style={{ zIndex: 130 }} onClick={() => setPendingSwitch(null)}>
            <div className="modal confirm" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
              <h3 className="modal-title">Different shoe detected</h3>
              <p className="modal-msg">You scanned <b>{pendingSwitch.name || pendingSwitch.sku || 'a new item'}</b>, different from <b>{draft?.name || draft?.sku || 'the current shoe'}</b>. Add the current shoe to the label and start the new one?</p>
              <div className="modal-actions">
                <button type="button" className="btn ghost" disabled={busy} onClick={() => setPendingSwitch(null)}>Keep current</button>
                <button type="button" className="btn primary" disabled={busy} onClick={confirmSwitch}>Add &amp; switch</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
