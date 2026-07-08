// Supplier-facing scan-out app (Phase 1). A supplier account signs in — ideally
// on supplier.stickballman12.com — sees the pending "batches" (POs) the PH team
// opened for them, opens one, scans items under each shipping label, and ships
// each label. The batch closes (PO → 'shipped') once every label is shipped.
// Reuses the shared product search (UPC/SKU) and camera scanner; writes only the
// PO tables via /api/po/* (never the receiving path). See docs/context/purchase-orders.md.
import React, { lazy, Suspense, useEffect, useState } from 'react';
import { api } from '../api.js';
import { TopBar } from '../components/common.jsx';
import { Icon } from '../components/NavIcons.jsx';
import { isUpcCode } from '../lib/codes.js';

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
  const [busy, setBusy] = useState(false);

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
            </div>

            {detail.boxes.map((box) => {
              const lines = linesFor(box.id);
              const units = lines.reduce((n, l) => n + (l.qty_expected || 0), 0);
              const shipped = box.status !== 'pending';
              return (
                <div key={box.id} className={`card po-box ${shipped ? 'shipped' : ''}`}>
                  <div className="po-card-top">
                    <div>
                      <b>Label {box.box_number}</b>
                      <div className="po-track muted sm">{box.tracking_number || '— no tracking #'}</div>
                    </div>
                    {shipped ? <span className="po-chip shipped">Shipped ✓</span> : <span className="muted sm">{units} unit{units === 1 ? '' : 's'}</span>}
                  </div>

                  {lines.length > 0 && (
                    <ul className="po-lines">
                      {lines.map((l) => (
                        <li key={l.id}>
                          <span className="po-line-name">{l.name || l.sku}</span>
                          <span className="po-line-meta">{l.sku} · sz {l.size} · ×{l.qty_expected}</span>
                        </li>
                      ))}
                    </ul>
                  )}

                  {!shipped && po.status === 'draft' && (
                    <div className="po-box-actions">
                      <button className="btn sm" onClick={() => setScanBox(box)}><Icon name="camera" /> Add items</button>
                      <button className="btn sm primary" disabled={units < 1 || busy} onClick={() => shipLabel(box)}>Ship label</button>
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
    </div>
  );
}

// Scan / type a UPC or SKU → resolve product → set size + qty → add to the label.
function ScanModal({ box, onClose, onAdded, onSignOut }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [product, setProduct] = useState(null); // resolved { name, sku, upc, colorway, gender }
  const [size, setSize] = useState('');
  const [qty, setQty] = useState('1');
  const [cam, setCam] = useState(false);

  const resolve = async (raw) => {
    const c = String(raw).trim();
    if (!c) return;
    setBusy(true); setError(''); setFlash('');
    try {
      const isUpc = isUpcCode(c);
      const { product: p } = isUpc ? await api.searchUpc(c) : await api.searchSku(c);
      setProduct({
        name: p.name || '', sku: p.sku || (isUpc ? '' : c), upc: (isUpc ? c : '') || p.upc || '',
        colorway: p.colorway || '', gender: p.gender || null,
      });
      setSize(p.scannedSize || '');
    } catch (e) {
      if (e.unauthorized) return onSignOut();
      setError(e.message || 'Could not find that code.');
    } finally { setBusy(false); }
  };

  const add = async () => {
    if (!product?.sku || !size.trim()) { setError('A SKU and size are required.'); return; }
    setBusy(true); setError('');
    try {
      await api.poScan({
        poBoxId: Number(box.id), sku: product.sku, size: size.trim(),
        qty: Math.max(1, parseInt(qty, 10) || 1),
        name: product.name, upc: product.upc, colorway: product.colorway, gender: product.gender,
      });
      setFlash(`Added ${product.name || product.sku} · sz ${size.trim()} ×${Math.max(1, parseInt(qty, 10) || 1)}`);
      setProduct(null); setCode(''); setSize(''); setQty('1');
      onAdded();
    } catch (e) {
      if (e.unauthorized) return onSignOut();
      setError(e.message);
    } finally { setBusy(false); }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal po-scan" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="po-card-top">
          <h3 className="modal-title">Add items · Label {box.box_number}</h3>
          <button className="btn ghost sm" onClick={onClose}>Close</button>
        </div>

        <form className="searchrow" onSubmit={(e) => { e.preventDefault(); resolve(code); }}>
          <input value={code} autoCapitalize="characters" autoCorrect="off" placeholder="Scan or type a UPC / SKU"
            onChange={(e) => setCode(e.target.value)} />
          <button type="submit" className="btn" disabled={busy || !code.trim()}>{busy ? '…' : 'Find'}</button>
          <button type="button" className="btn ghost" title="Scan with camera" onClick={() => setCam(true)}><Icon name="camera" /></button>
        </form>

        {error && <div className="po-err">{error}</div>}
        {flash && <div className="po-flash">✓ {flash}</div>}

        {product && (
          <div className="po-confirm">
            <div className="po-confirm-name">{product.name || product.sku}</div>
            <div className="muted sm">{product.sku}{product.colorway ? ` · ${product.colorway}` : ''}</div>
            <div className="po-confirm-row">
              <label>Size<input value={size} autoCapitalize="off" placeholder="e.g. 9.5" onChange={(e) => setSize(e.target.value)} /></label>
              <label>Qty<input type="number" inputMode="numeric" min="1" value={qty} onChange={(e) => setQty(e.target.value)} /></label>
            </div>
            <button className="btn primary" disabled={busy || !size.trim()} onClick={add}>Add to label</button>
          </div>
        )}

        {cam && (
          <div className="modal-overlay" onClick={() => setCam(false)}>
            <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
              <h3 className="modal-title">Scan a UPC</h3>
              <Suspense fallback={<p className="muted">Loading camera…</p>}>
                <CameraScanner mode="product" onDetected={(c) => { setCam(false); setCode(c); resolve(c); }} onClose={() => setCam(false)} />
              </Suspense>
              <div className="modal-actions"><button className="btn ghost" onClick={() => setCam(false)}>Cancel</button></div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
