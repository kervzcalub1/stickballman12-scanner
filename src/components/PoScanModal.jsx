// Shared PO manifest-entry UI, used by BOTH the supplier portal (SupplierApp) and the
// PH "Purchase Orders" overview (PoOverview, entering a supplier's manifest on their
// behalf). Both post to /api/po/scan and /api/po/line — the server decides on-behalf
// attribution from the caller's role, so this UI is identical for either side.
// See docs/context/purchase-orders.md.
import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Icon } from './NavIcons.jsx';
import { isUpcCode, usSizeChart, compareSizes } from '../lib/codes.js';

const CameraScanner = lazy(() => import('./CameraScanner.jsx'));

// One editable scanned line on a still-filling label: rename-free, but the size can be
// corrected and the qty nudged (or the line removed at ×0). Size commits on blur/Enter;
// qty posts on each ± tap. The parent reloads the PO after each save. `attribution` is an
// optional trailing note (e.g. "entered by …") shown under the product name.
export function PoLineRow({ line, disabled, onSave, attribution }) {
  const [size, setSize] = useState(String(line.size ?? ''));
  useEffect(() => { setSize(String(line.size ?? '')); }, [line.size]);
  const commitSize = () => {
    const v = size.trim();
    if (!v || v === String(line.size)) { setSize(String(line.size ?? '')); return; }
    onSave({ size: v });
  };
  // Cost and tip per pair, corrected after the fact. Blank is a real value here — it
  // clears the field back to "not declared", which is not the same as $0.
  const moneyStr = (v) => (v == null || v === '' ? '' : String(Number(v)));
  const [cost, setCost] = useState(moneyStr(line.unit_cost));
  const [tip, setTip] = useState(moneyStr(line.tip));
  useEffect(() => { setCost(moneyStr(line.unit_cost)); }, [line.unit_cost]);
  useEffect(() => { setTip(moneyStr(line.tip)); }, [line.tip]);
  // One committer for both: `field` is what the API expects, `stored` what's on the row.
  const commitMoney = (field, typed, stored, reset) => {
    const v = typed.trim();
    if (v === moneyStr(stored)) return;
    if (v === '') { onSave({ [field]: null }); return; }
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) { reset(moneyStr(stored)); return; }
    onSave({ [field]: n });
  };
  return (
    <li className="po-line-edit">
      <div className="po-line-head">
        <span className="po-line-name">{line.name || line.sku}</span>
        <span className="po-line-meta">{line.sku}</span>
      </div>
      {attribution && <div className="po-line-attribution muted xs">{attribution}</div>}
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
        <label className="po-line-cost">
          <span className="muted xs">Cost ea</span>
          <span className="po-money-input">
            <span className="po-money-sym">$</span>
            <input className="cost" value={cost} disabled={disabled} inputMode="decimal" placeholder="—"
              onChange={(e) => setCost(e.target.value)}
              onBlur={() => commitMoney('unitCost', cost, line.unit_cost, setCost)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }} />
          </span>
        </label>
        <label className="po-line-cost">
          <span className="muted xs">Tip ea</span>
          <span className="po-money-input">
            <span className="po-money-sym">$</span>
            <input className="cost" value={tip} disabled={disabled} inputMode="decimal" placeholder="—"
              onChange={(e) => setTip(e.target.value)}
              onBlur={() => commitMoney('tip', tip, line.tip, setTip)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }} />
          </span>
        </label>
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

// `box` = add to a specific shipping label (per-box manifest). `po` (with no box) = add to
// the whole order (Path C — one list for the whole purchase, no per-box breakdown). Exactly
// one of the two is passed; everything else is identical.
export function PoScanModal({ box, po, onClose, onAdded, onSignOut }) {
  const orderMode = !box;
  // Name the target the way the rest of the app does — a reship is "the replacement
  // shipment" everywhere else, so "Label 3" here would read as a fourth original box.
  const targetLabel = orderMode ? 'the whole order'
    : box.kind === 'replacement' ? 'the replacement shipment' : `Label ${box.box_number}`;
  const targetTitle = orderMode ? 'Whole order'
    : box.kind === 'replacement' ? 'Replacement shipment' : `Label ${box.box_number}`;
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
        const rows = incoming.scannedSize ? [{ key: rowKey++, size: incoming.scannedSize, qty: 1, cost: '', tip: '' }] : [];
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
  // Money is PER SIZE — the same shoe can cost (and be tipped) differently in a 9 than in
  // an 11 — so cost and tip live on the size row. A new row inherits what was typed on the
  // last one, because the common case is still a run of sizes bought at one price: type it
  // once, change only the size that differs.
  const lastMoney = (rows) => {
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].cost !== '' || rows[i].tip !== '') return { cost: rows[i].cost, tip: rows[i].tip };
    }
    return { cost: '', tip: '' };
  };
  const newRow = (rows, size) => ({ key: rowKey++, size: String(size), qty: 1, ...lastMoney(rows) });
  const addSize = (s) => setDraft((d) => {
    const i = d.rows.findIndex((r) => String(r.size) === String(s));
    if (i >= 0) { const rows = d.rows.slice(); rows[i] = { ...rows[i], qty: rows[i].qty + 1 }; return { ...d, rows }; }
    return { ...d, rows: [...d.rows, newRow(d.rows, s)] };
  });
  const addCustom = () => setDraft((d) => ({ ...d, rows: [...d.rows, newRow(d.rows, '')] }));
  const setRow = (key, patch) => setDraft((d) => ({ ...d, rows: d.rows.map((r) => (r.key === key ? { ...r, ...patch } : r)) }));
  const bump = (key, by) => setDraft((d) => ({ ...d, rows: d.rows.map((r) => (r.key === key ? { ...r, qty: Math.max(1, r.qty + by) } : r)) }));
  const removeRow = (key) => setDraft((d) => ({ ...d, rows: d.rows.filter((r) => r.key !== key) }));

  // A typed money field → a number to send, or null for "not declared" (blank or junk).
  const moneyOf = (v) => {
    const s = String(v ?? '').trim();
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };

  // Commit the whole draft (every size) to the label. Returns true on success.
  const addToLabel = async () => {
    const rows = (draft?.rows || [])
      .map((r) => ({ size: String(r.size).trim(), qty: Math.max(1, parseInt(r.qty, 10) || 1),
        unitCost: moneyOf(r.cost), tip: moneyOf(r.tip) }))
      .filter((r) => r.size);
    if (!draft?.sku) { setError('A SKU is required.'); return false; }
    if (rows.length === 0) { setError('Tap at least one size.'); return false; }
    setBusy(true); setError('');
    try {
      for (const r of rows) {
        const common = { sku: draft.sku, size: r.size, qty: r.qty,
          name: draft.name, upc: draft.upc, colorway: draft.colorway, gender: draft.gender,
          unitCost: r.unitCost, tip: r.tip };
        const { line } = orderMode
          ? await api.poScanOrder({ poId: Number(po.id), ...common })
          : await api.poScan({ poBoxId: Number(box.id), ...common });
        recordScan(line, draft.name);
      }
      const total = rows.reduce((n, r) => n + r.qty, 0);
      setFlash({ type: 'added', text: `Added ${draft.name || draft.sku} · ${total} unit${total === 1 ? '' : 's'} to ${targetLabel}` });
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
      const rows = next.scannedSize ? [{ key: rowKey++, size: next.scannedSize, qty: 1, cost: '', tip: '' }] : [];
      setDraft({ ...next, rows });
      setFlash(next.scannedSize
        ? { type: 'added', text: `✓ ${next.name || next.sku} · size ${next.scannedSize}` }
        : { type: 'warn', text: `Scanned ${next.name || next.sku} — tap the size below.` });
    }
  };

  const totalUnits = (draft?.rows || []).reduce((n, r) => n + (parseInt(r.qty, 10) || 0), 0);
  // What this draft adds up to, per size: qty × cost and qty × tip.
  const draftTotal = (draft?.rows || []).reduce((t, r) => {
    const q = parseInt(r.qty, 10) || 0;
    const c = moneyOf(r.cost); const tp = moneyOf(r.tip);
    return { cost: t.cost + (c || 0) * q, tip: t.tip + (tp || 0) * q, any: t.any || c != null || tp != null };
  }, { cost: 0, tip: 0, any: false });

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal additem" role="dialog" aria-modal="true"
        onClick={(e) => {
          e.stopPropagation();
          // Keep the scan gun aimed at the SKU field by refocusing it when the user taps
          // empty modal space — but NEVER when they tapped another control (the size box,
          // qty, product name, a chip/button). That refocus was bouncing every click back
          // to SKU, so the size field was impossible to type letters into (5C, 3Y, …).
          if (mCam || e.target.closest('input, textarea, select, button, [contenteditable="true"]')) return;
          inputRef.current?.focus({ preventScroll: true });
        }}>
        <div className="modal-head">
          <h3 className="modal-title">Add items · {targetTitle}</h3>
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
            <div className="muted sm">Added to {targetLabel}</div>
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
                <div className="size-line po-size-line" key={r.key}>
                  <div className="po-size-line-top">
                    <input className={`sz ${!String(r.size).trim() ? 'need' : ''}`} placeholder="Size" value={r.size} onChange={(e) => setRow(r.key, { size: e.target.value })} autoFocus={!String(r.size).trim()} />
                    <div className="qty-stepper">
                      <button type="button" className="btn icon ghost step" onClick={() => bump(r.key, -1)}>−</button>
                      <input className="qty" type="number" inputMode="numeric" min="1" value={r.qty} onChange={(e) => setRow(r.key, { qty: Math.max(1, parseInt(e.target.value, 10) || 1) })} />
                      <button type="button" className="btn icon ghost step" onClick={() => bump(r.key, 1)}>+</button>
                    </div>
                    <button type="button" className="btn icon ghost remove" title="Remove size" onClick={() => removeRow(r.key)}>×</button>
                  </div>
                  {/* Money is per size, so it belongs on the size's own row. */}
                  <div className="po-size-line-money">
                    <label className="po-size-money">
                      <span className="muted xs">Cost ea</span>
                      <span className="po-money-input">
                        <span className="po-money-sym">$</span>
                        <input type="number" inputMode="decimal" min="0" step="0.01" placeholder="0.00"
                          value={r.cost ?? ''} onChange={(e) => setRow(r.key, { cost: e.target.value })} />
                      </span>
                    </label>
                    <label className="po-size-money">
                      <span className="muted xs">Tip ea</span>
                      <span className="po-money-input">
                        <span className="po-money-sym">$</span>
                        <input type="number" inputMode="decimal" min="0" step="0.01" placeholder="0.00"
                          value={r.tip ?? ''} onChange={(e) => setRow(r.key, { tip: e.target.value })} />
                      </span>
                    </label>
                  </div>
                </div>
              ))}
            </div>
            {/* Cost and tip are optional — blank records nothing rather than $0 — so this
                only appears once there's money to add up. */}
            {draftTotal.any && (
              <p className="po-draft-total muted sm">
                Cost ${draftTotal.cost.toFixed(2)}
                {draftTotal.tip > 0 ? ` + tips $${draftTotal.tip.toFixed(2)}` : ''}
                {' = '}<b>${(draftTotal.cost + draftTotal.tip).toFixed(2)}</b>
              </p>
            )}
            <div className="modal-actions">
              <button type="button" className="btn ghost" onClick={() => setDraft(null)}>Cancel</button>
              <button type="button" className="btn primary wide" disabled={busy || totalUnits < 1} onClick={addToLabel}>
                Add {totalUnits > 0 ? `${totalUnits} unit${totalUnits === 1 ? '' : 's'} ` : ''}to {orderMode ? 'order' : 'label'}
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
