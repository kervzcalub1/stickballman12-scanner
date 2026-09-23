// "Brent opened Council's box, received the shoe, and declared the wrong size."
//
// The size is the one fact at intake nobody can scan: a `size?` row is typed off the
// tongue label, and a SKU scan answers for whichever size the catalogue chose. Before
// this, the only way back was to remove the pair and receive it again — burning its VIN,
// its shelf and its history over one character.
//
// Shared by the item detail (Inventory) and the batch's own box contents (Batch page),
// because the person who notices is standing in front of the batch they just submitted.
// Server: `api/items/set-size.js`. Rules in docs/context/inventory.md.
import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { normalizeSize } from '../lib/codes.js';

export function SizeEditModal({ item, onClose, onSaved, onSignOut, defaultScope = 'one' }) {
  const [size, setSize] = useState('');
  const [info, setInfo] = useState(null);   // { item, siblings } from the server
  // Edit box opens it from a size CHIP, which stands for every pair of that size in the
  // box — so it starts on the group ('same_group' is exactly that set).
  const [scope, setScope] = useState(defaultScope);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    let live = true;
    api.sizeSiblings(item.vin)
      .then((r) => { if (live) setInfo({ item: r.item, siblings: r.siblings || [] }); })
      .catch((e) => { if (e.unauthorized) return onSignOut(); if (live) setInfo({ item: null, siblings: [] }); });
    return () => { live = false; };
  }, [item.vin]); // eslint-disable-line react-hooks/exhaustive-deps

  // The server has the last word on the spelling; showing the same answer here means
  // nobody types "9 M" and finds out it became "9" only after saving.
  const it = info?.item || item;
  const norm = normalizeSize(size);
  const current = String(it.size || '').trim();
  const same = norm !== null && norm === current;
  // A pair on a store, or one already sold, keeps its numbers: they are what the
  // listing/sale says. Everything else is re-priced at the size it really is.
  const keepsPrice = !!it.listed || ['sold', 'shipped'].includes(String(it.status || ''));
  const others = info?.siblings || [];
  const listedOthers = others.filter((o) => o.listed).length;
  const willChange = scope === 'same_group' ? others.length + 1 : 1;

  async function save() {
    setBusy(true); setErr('');
    try {
      const r = await api.setItemSize({ vin: it.vin, size: norm, scope, reason: reason.trim() || null });
      onSaved(r);
    } catch (e) { if (e.unauthorized) return onSignOut(); setErr(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="modal-overlay" onClick={() => !busy && onClose()}>
      <div className="modal size-edit" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">Correct the size</h3>
        <p className="muted sm">
          {it.vin} is on record as <b>{it.sku || '—'}</b> size <b>{current || '—'}</b>
          {it.batch_code ? ` · ${it.batch_code}` : ''}. Type the size written on the box.
        </p>
        <div className="size-edit-row">
          <input className="input" value={size} onChange={(e) => setSize(e.target.value)} placeholder="e.g. 9.5"
            autoComplete="off" spellCheck={false} maxLength={12} inputMode="text"
            onKeyDown={(e) => { if (e.key === 'Enter' && norm && !same && !busy) { e.preventDefault(); save(); } }} />
        </div>
        {size.trim() !== '' && (norm === null
          ? <p className="error sm">Sizes are written like 9, 10.5, 8.5W, 5Y (apparel: S, M, L, XL).</p>
          : same
            ? <p className="muted sm">This pair is already size {current}.</p>
            : norm !== size.trim().toUpperCase() && <p className="muted xs">Saved as <b>{norm}</b>.</p>)}
        {others.length > 0 && (
          <div className="size-edit-scope">
            <label className="check-pill sm"><input type="radio" name="size-scope" checked={scope === 'one'} onChange={() => setScope('one')} /> Just this pair</label>
            <label className="check-pill sm"><input type="radio" name="size-scope" checked={scope === 'same_group'} onChange={() => setScope('same_group')} />
              This pair and the {others.length} other{others.length === 1 ? '' : 's'} received as {it.sku || 'this shoe'} size {current} in the same box
            </label>
          </div>
        )}
        {info === null && <p className="muted xs">Checking what else went in on this line…</p>}
        {/* The two facts that CANNOT survive a size change, said out loud rather than
            done quietly: a UPC names one size's box, and Alias quotes a price per size. */}
        {it.upc ? <p className="muted xs">The box UPC on record ({it.upc}) is the size {current} box’s, so it’s cleared. Scan the box on Box Labels to put the right one back.</p> : null}
        {(it.listed || (scope === 'same_group' && listedOthers > 0)) ? (
          <p className="notice sm">
            {scope === 'same_group' && listedOthers > 0
              ? `${listedOthers + (it.listed ? 1 : 0)} of these are`
              : 'This pair is'} already listed to a store as size {current}. Our record is
            corrected here; the store listing still says {current} and PH has to fix it there.
          </p>
        ) : (!keepsPrice && (it.price != null || it.global_indicator != null)) ? (
          <p className="muted xs">The size {current || '—'} price on record is dropped — Alias quotes per size, so PH prices this pair at its real one.</p>
        ) : null}
        <p className="muted xs">Re-print this pair’s label: the one on the box still says size {current || '—'}.</p>
        <input className="input size-edit-why" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300}
          placeholder="Why (optional) — e.g. box says 9.5, typed 9 at receiving" />
        {err && <div className="error sm">{err}</div>}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy || !norm || same} onClick={save}>
            {busy ? 'Saving…' : willChange > 1 ? `Change ${willChange} pairs to ${norm || '…'}` : `Change to ${norm || '…'}`}
          </button>
        </div>
      </div>
    </div>
  );
}
