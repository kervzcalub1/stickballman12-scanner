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

  const [trackBusy, setTrackBusy] = useState(false);
  const refreshTracking = async () => {
    setTrackBusy(true); setError('');
    try {
      const r = await api.poTrackRefresh(openId);
      setDetail({ po: r.po, boxes: r.boxes, lines: r.lines });
    } catch (e) { if (e.unauthorized) return onSignOut(); setError(e.message); }
    finally { setTrackBusy(false); }
  };
  const boxStatusLabel = (b) => (b.status === 'delivered' ? 'Delivered ✓'
    : b.status === 'in_transit' ? 'In transit'
    : b.status === 'shipped' ? 'Shipped ✓' : null);

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
                <button className="btn ghost sm po-track-refresh" disabled={trackBusy} onClick={refreshTracking}>
                  <Icon name="refresh" /> {trackBusy ? 'Checking…' : 'Refresh tracking'}
                </button>
              )}
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
                    {shipped ? <span className={`po-chip ${box.status === 'delivered' ? 'ok' : box.status === 'in_transit' ? 'receiving' : 'shipped'}`}>{boxStatusLabel(box)}</span> : <span className="muted sm">{units} unit{units === 1 ? '' : 's'}</span>}
                  </div>

                  {shipped && (box.tracking_status || box.last_checkpoint) && (
                    <div className="po-track-status muted sm">
                      {box.carrier ? <span className="po-track-carrier">{box.carrier}</span> : null}
                      {box.tracking_status ? <span> · {box.tracking_status}</span> : null}
                      {box.last_checkpoint ? <div className="po-track-checkpoint">{box.last_checkpoint}</div> : null}
                    </div>
                  )}

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

// Scan / type a UPC or SKU → resolve the product → tap size chips (tap again for
// +1) → add the whole shoe (every size) to the label at once, like the warehouse
// Add-Item flow. Each size posts one po_line via /api/po/scan.
let rowKey = 0;
function ScanModal({ box, onClose, onAdded, onSignOut }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  // draft = { name, sku, upc, colorway, gender, image, sizeOptions, rows:[{key,size,qty}] }
  const [draft, setDraft] = useState(null);
  const [cam, setCam] = useState(false);
  const [recent, setRecent] = useState([]); // running "added to this label" tally (this session)

  // Merge a server-returned po_line into the running tally (its live incremented qty).
  const recordScan = (line, fallbackName) => setRecent((rs) => {
    if (!line) return rs;
    const key = `${line.sku}|#|${line.size}`;
    return [{ key, name: line.name || fallbackName || line.sku, size: line.size, qty: line.qty_expected ?? 1 },
      ...rs.filter((r) => r.key !== key)];
  });

  const resolve = async (raw) => {
    const c = String(raw).trim();
    if (!c) return;
    setBusy(true); setError(''); setFlash('');
    try {
      const isUpc = isUpcCode(c);
      const { product: p } = isUpc ? await api.searchUpc(c) : await api.searchSku(c);
      const sku = p.sku || (isUpc ? '' : c);
      // Warehouse-style: a code that resolves to a SKU *and* a size auto-adds to the
      // label immediately — the server increments the line on a re-scan, so scanning
      // the same shoe again just bumps its quantity. No per-scan tap. When the catalog
      // gives no size (a SKU-only match / StockX miss), fall back to the manual draft.
      if (sku && p.scannedSize) {
        const size = String(p.scannedSize);
        const { line } = await api.poScan({
          poBoxId: Number(box.id), sku, size, qty: 1,
          name: p.name, upc: (isUpc ? c : '') || p.upc || '', colorway: p.colorway, gender: p.gender,
        });
        recordScan(line, p.name);
        setDraft(null); setCode('');
        setFlash(`✓ ${p.name || sku} · sz ${size} · ×${line?.qty_expected ?? 1}`);
        onAdded();
      } else {
        setDraft({
          name: p.name || '', sku, upc: (isUpc ? c : '') || p.upc || '',
          colorway: p.colorway || '', gender: p.gender || null, image: p.image || '',
          sizeOptions: p.sizes || [], rows: [],
        });
        setCode('');
      }
    } catch (e) {
      if (e.unauthorized) return onSignOut();
      setError(e.message || 'Could not find that code.');
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

  const addToLabel = async () => {
    const rows = (draft?.rows || [])
      .map((r) => ({ size: String(r.size).trim(), qty: Math.max(1, parseInt(r.qty, 10) || 1) }))
      .filter((r) => r.size);
    if (!draft?.sku) { setError('A SKU is required.'); return; }
    if (rows.length === 0) { setError('Tap at least one size.'); return; }
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
      setFlash(`Added ${draft.name || draft.sku} · ${rows.length} size${rows.length === 1 ? '' : 's'} · ${total} unit${total === 1 ? '' : 's'}`);
      setDraft(null); setCode('');
      onAdded();
    } catch (e) {
      if (e.unauthorized) return onSignOut();
      setError(e.message);
      onAdded(); // reflect whatever landed before the failure
    } finally { setBusy(false); }
  };

  const totalUnits = (draft?.rows || []).reduce((n, r) => n + (parseInt(r.qty, 10) || 0), 0);

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
        {flash && !draft && <div className="po-flash">✓ {flash}</div>}
        {!draft && (
          <p className="muted sm po-scan-hint">Scan a shoe's UPC — it's added to the label automatically, and scanning the same shoe again bumps its quantity.</p>
        )}
        {recent.length > 0 && (
          <div className="po-scan-recent">
            <div className="muted sm">Added to Label {box.box_number}</div>
            <ul className="po-lines">
              {recent.map((r) => (
                <li key={r.key}>
                  <span className="po-line-name">{r.name}</span>
                  <span className="po-line-meta">sz {r.size} · ×{r.qty}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {draft && (
          <div className="additem-draft">
            <div className="additem-product">
              {draft.image ? <img className="cart-thumb" src={draft.image} alt="" /> : <div className="cart-thumb placeholder">—</div>}
              <div className="cart-fields">
                <input className="cart-name" placeholder="Product name" value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
                <input placeholder="SKU" value={draft.sku} onChange={(e) => setDraft((d) => ({ ...d, sku: e.target.value }))} />
              </div>
            </div>
            <div className="size-rows">
              <div className="muted sm">Tap each size you’re shipping, then set its quantity with −/+. Use “+ Custom” for anything not listed.</div>
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

        {cam && (
          <div className="modal-overlay" onClick={() => setCam(false)}>
            <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
              <h3 className="modal-title">Scan a UPC</h3>
              <Suspense fallback={<p className="muted">Loading camera…</p>}>
                {/* CameraScanner renders its own Cancel/controls — no extra Cancel here
                    (that made two stacked Cancel buttons). Backdrop tap also closes. */}
                <CameraScanner mode="product" onDetected={(c) => { setCam(false); resolve(c); }} onClose={() => setCam(false)} />
              </Suspense>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
