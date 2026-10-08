// "Receive as men's" — the dialog on a Receive New cart card (docs/context/receiving.md,
// "GS received as men's").
//
// Some Grade School Jordan Retros sell better under the men's product, and Alias lets
// them be listed there. The warehouse converts them as they are received: the pair goes
// in under the MEN'S style code and size (GS 7Y → men's 7), and keeps the GS code + size
// it arrived as (items.original_sku / original_size) for the record. Nothing is written
// here — the choice rides on the cart line and is applied when the box is submitted.
//
// The men's code is OFFERED, never applied on its own: from the last time this GS code was
// received as men's, or — the first time — found in the Alias catalogue (the men's product
// with the same name minus "GS"; api/items/mens-for.js). The warehouse can't read the men's
// code off a GS box, so the first box of a new shoe used to stop here. A size can be left as GS (untick it) when Alias
// doesn't take that size as men's.
import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { gsToMensSize, compareSizes } from '../lib/codes.js';

export function MensConvertModal({ item, onClose, onSave }) {
  const current = item.mens || null;
  const [sku, setSku] = useState(current?.sku || '');
  const [product, setProduct] = useState(current ? { name: current.name, image: current.image, colorway: current.colorway } : null);
  const [lookedUp, setLookedUp] = useState(current?.sku || '');
  const [skip, setSkip] = useState(() => new Set(current?.skip || []));
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [suggested, setSuggested] = useState('');   // '' | 'history' | 'catalogue'
  const [finding, setFinding] = useState(false);
  const [candidates, setCandidates] = useState([]);
  const typed = useRef(!!current);   // they typed (or it was already set) — a late answer must not overwrite it
  const code = sku.trim().toUpperCase();
  const sizes = [...new Set((item.sizes || []).map((s) => s.size).filter(Boolean))].sort(compareSizes);

  // What this GS code was received as last time, else what the catalogue says the men's
  // version is — offered, never applied on its own.
  const offer = (m, source) => {
    setSku(m.sku);
    setProduct({ name: m.name, image: m.image, colorway: m.colorway });
    setLookedUp(m.sku);
    setSuggested(source);
    setErr('');
  };
  useEffect(() => {
    if (current || !item.sku) return;
    setFinding(true);
    api.mensFor(item.sku, item.name || '').then((r) => {
      setCandidates(r?.candidates || []);
      if (r?.mens?.sku && !typed.current) offer(r.mens, r.mens.source || 'history');
    }).catch(() => {}).finally(() => setFinding(false));
  }, [item.sku]); // eslint-disable-line react-hooks/exhaustive-deps

  async function lookUp() {
    if (!code) return;
    setBusy('look'); setErr(''); setProduct(null); setSuggested('');
    try {
      const { product: p } = await api.searchSku(code);
      setProduct(p || null); setLookedUp(code);
      if (!p) setErr('The catalogue has nothing under that code — check it against Alias. You can still use it; the name stays the GS one.');
    } catch (e) { setErr(e.message); } finally { setBusy(''); }
  }

  const same = code === String(item.sku || '').toUpperCase();
  const ok = code.length >= 3 && !same && lookedUp === code;
  const toggle = (s) => setSkip((x) => { const n = new Set(x); if (n.has(s)) n.delete(s); else n.add(s); return n; });
  const converting = sizes.filter((s) => !skip.has(s));

  return (
    <div className="modal-overlay" onClick={() => onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Receive as men's" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">Receive as men’s</h3>
        <p className="muted sm">
          <b>{item.sku}</b> is the Grade School code on the box. These pairs go in under the <b>men’s</b> code and size
          instead — the GS code and size are kept on each pair for the record.
        </p>
        <div className="sku-edit-row">
          <input className="input" value={sku} onChange={(e) => { typed.current = true; setSku(e.target.value); setSuggested(''); }} placeholder={finding ? 'Finding the men’s code…' : 'Men’s style code, e.g. CT8019-100'}
            aria-label="Men's style code" autoComplete="off" spellCheck={false} maxLength={40}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); lookUp(); } }} />
          <button type="button" className="btn" disabled={busy === 'look' || !code} onClick={lookUp}>
            {busy === 'look' ? 'Looking…' : 'Look up'}
          </button>
        </div>
        {suggested === 'history' && <p className="muted xs">Last time {item.sku} was received as men’s, it went in as this code.</p>}
        {suggested === 'catalogue' && <p className="muted xs mens-found">Found in the Alias catalogue — the men’s version of this shoe. Check the name and picture match.</p>}
        {!finding && !code && !candidates.length && <p className="muted xs">No men’s version found in the catalogue — type the code if you know it.</p>}
        {!suggested && candidates.length > 0 && !(product && lookedUp === code) && (
          <div className="mens-cands">
            <div className="muted xs">Men’s shoes with a similar name — tap the right one:</div>
            {candidates.map((c) => (
              <button key={c.sku} type="button" className="mens-cand" onClick={() => offer(c, 'catalogue')}>
                {c.image ? <img src={c.image} alt="" /> : null}
                <span><b>{c.sku}</b><span className="muted xs">{c.name}</span></span>
              </button>
            ))}
          </div>
        )}
        {product && lookedUp === code && (
          <div className="sku-edit-hit">
            {product.image ? <img src={product.image} alt="" /> : null}
            <div>
              <b>{product.name || code}</b>
              {product.colorway && <div className="muted sm">{product.colorway}</div>}
            </div>
          </div>
        )}
        {same && <div className="error sm">That’s the GS code itself.</div>}
        {sizes.length > 0 && (
          <div className="mens-sizes">
            <div className="muted xs">Sizes — untick any Alias doesn’t take as men’s; it stays GS.</div>
            {sizes.map((s) => (
              <label key={s} className={`check-pill sm ${skip.has(s) ? '' : 'on'}`}>
                <input type="checkbox" checked={!skip.has(s)} onChange={() => toggle(s)} />
                {s} → <b>{gsToMensSize(s)}</b>
              </label>
            ))}
          </div>
        )}
        {err && <div className="error sm">{err}</div>}
        <div className="modal-actions">
          {current && <button type="button" className="btn ghost" onClick={() => onSave(null)}>Keep as GS</button>}
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={!ok || (sizes.length > 0 && !converting.length)}
            onClick={() => onSave({ sku: code, name: product?.name || null, image: product?.image || null, colorway: product?.colorway || null, skip: [...skip] })}>
            {lookedUp !== code && code ? 'Look it up first' : `Receive as ${code || '…'}`}
          </button>
        </div>
      </div>
    </div>
  );
}
