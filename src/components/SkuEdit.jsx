// The "Correct the style code" dialog — shared by the Inventory unit page and Edit box in
// Receiving (docs/context/receiving.md). Moved out of Inventory.jsx unchanged apart from
// the third scope, 'same_box'.
import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

// Correct the style code on a pair the catalogue resolved wrongly off its box UPC —
// Jordan re-coded 553558-100 → -136 for some sizes in 2022 and kept the same barcode, so
// a scan of 196149780863 (size 10.5) lands as -100 while the box says -136. Everything
// else on the unit is right, so this is one field: the new code, looked up so the name
// and colorway travel with it, applied to this pair or to every pair that was scanned in
// the same wrong way (same old code + size + UPC — the count is fetched, not guessed).
export function SkuEditModal({ item, onClose, onSaved, onSignOut, defaultScope = 'one' }) {
  const [sku, setSku] = useState('');
  const [product, setProduct] = useState(null);   // catalogue hit for the NEW code
  const [lookedUp, setLookedUp] = useState('');    // the code `product` answers for
  const [sibs, setSibs] = useState(null);          // other pairs scanned in the same way
  const [boxSibs, setBoxSibs] = useState([]);      // other pairs of this code in this box, any size
  const [scope, setScope] = useState(defaultScope);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const code = sku.trim().toUpperCase();

  useEffect(() => {
    api.skuSiblings(item.vin).then((r) => {
      setSibs(r.siblings || []); setBoxSibs(r.boxSiblings || []);
      // "Whole shoe in this box" was asked for, but the box holds only this pair: fall
      // back to the one pair rather than offer a choice that isn't there.
      if (defaultScope === 'same_box' && !(r.boxSiblings || []).length) setScope('one');
    }).catch(() => setSibs([]));
  }, [item.vin]);

  async function lookUp() {
    if (!code) return;
    setBusy('look'); setErr(''); setProduct(null);
    try {
      const { product: p } = await api.searchSku(code);
      setProduct(p || null); setLookedUp(code);
      if (!p) setErr('The catalogue has nothing under that code. You can still save it — the name stays as it is.');
    } catch (e) {
      if (e.unauthorized) return onSignOut();
      setLookedUp(code); setErr(`${e.message} You can still save the code — the name stays as it is.`);
    } finally { setBusy(''); }
  }

  async function save() {
    setBusy('save'); setErr('');
    try {
      const r = await api.setItemSku({
        vin: item.vin, sku: code, scope,
        product: lookedUp === code && product ? product : null,
        reason: reason.trim() || null,
      });
      onSaved(r);
    } catch (e) { if (e.unauthorized) return onSignOut(); setErr(e.message); }
    finally { setBusy(''); }
  }

  const others = scope === 'same_box' ? boxSibs : (sibs || []);
  const listedOthers = others.filter((o) => o.listed).length;
  const many = scope !== 'one';
  return (
    <div className="modal-overlay" onClick={() => busy !== 'save' && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">Correct the style code</h3>
        <p className="muted sm">
          {item.vin} is on record as <b>{item.sku || '—'}</b>{item.size ? ` size ${item.size}` : ''}{item.upc ? ` · box UPC ${item.upc}` : ''}.
          Type the code printed on the box.
        </p>
        <div className="sku-edit-row">
          <input className="input" value={sku} onChange={(e) => setSku(e.target.value)} placeholder="e.g. 553558-136"
            autoComplete="off" spellCheck={false} maxLength={40}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); lookUp(); } }} />
          <button type="button" className="btn" disabled={busy === 'look' || !code} onClick={lookUp}>
            {busy === 'look' ? 'Looking…' : 'Look up'}
          </button>
        </div>
        {product && lookedUp === code && (
          <div className="sku-edit-hit">
            {product.image ? <img src={product.image} alt="" /> : null}
            <div>
              <b>{product.name}</b>
              {product.colorway && <div className="muted sm">{product.colorway}</div>}
              <div className="muted xs">The name and colorway above are saved with the code.</div>
            </div>
          </div>
        )}
        {((sibs || []).length > 0 || boxSibs.length > 0) && (
          <div className="sku-edit-scope">
            <label className="check-pill sm"><input type="radio" name="sku-scope" checked={scope === 'one'} onChange={() => setScope('one')} /> Just this pair</label>
            {(sibs || []).length > 0 && (
              <label className="check-pill sm"><input type="radio" name="sku-scope" checked={scope === 'same_upc'} onChange={() => setScope('same_upc')} />
                This pair and the {sibs.length} other{sibs.length === 1 ? '' : 's'} scanned in as {item.sku}{item.size ? ` size ${item.size}` : ''}{item.upc ? ' with this UPC' : ' in this batch'}
              </label>
            )}
            {/* Edit box: the carton's one shoe went in under the wrong code, so every
                size of it in this box is wrong the same way. */}
            {boxSibs.length > 0 && (
              <label className="check-pill sm"><input type="radio" name="sku-scope" checked={scope === 'same_box'} onChange={() => setScope('same_box')} />
                Every pair of {item.sku} in this box — {boxSibs.length + 1} pairs, all sizes
              </label>
            )}
          </div>
        )}
        {sibs === null && <p className="muted xs">Checking for other pairs scanned in the same way…</p>}
        {(item.synced_alias || item.synced_stockx || item.synced_shopify || item.added_to_intel_inv || (many && listedOthers > 0)) && (
          <p className="notice sm">
            {many && listedOthers > 0 ? `${listedOthers + (item.synced_alias || item.synced_stockx || item.synced_shopify ? 1 : 0)} of these are` : 'This pair is'} already listed to a store under the old code.
            Our record is corrected here; the store listing still says {item.sku} and PH has to fix it there.
          </p>
        )}
        <input className="input sku-edit-why" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300}
          placeholder="Why (optional) — e.g. box says -136; Jordan re-coded this size in 2022" />
        {err && <div className="error sm">{err}</div>}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy === 'save'}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy === 'save' || !code || code === String(item.sku || '').toUpperCase()} onClick={save}>
            {busy === 'save' ? 'Saving…' : many ? `Change ${others.length + 1} pairs to ${code || '…'}` : `Change to ${code || '…'}`}
          </button>
        </div>
      </div>
    </div>
  );
}

