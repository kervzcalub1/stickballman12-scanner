// "Only Alias knew this barcode — read the box." Shared by every screen that turns a
// box UPC into a shoe: Receiving, supplier scan-out (PoScanModal), Existing Stock, Box
// Labels and Pre-sell Listings (docs/context/receiving.md → "Alias-only barcode").
//
// Why: Alias is the LAST source in the UPC chain (api/upc-search.js) and the only one
// that answers without naming a size. On 2026-10-22 it filed the Jordan 15 'Black Pack'
// boxes (IZ2585-001) under the Jordan 16 (IZ2586-001) — StockX and the Nike feed didn't
// know the new release yet — and 7 pairs were received, listed and priced as the 16.
// So an Alias-only answer is a guess until somebody reads the code on the box label.
import React, { useState } from 'react';
import { api } from '../api.js';

// The code Alias gave when Alias was the only source that knew the barcode, else ''.
// Only a scanned UPC is ever in question: a typed style code is the box already read.
export const aliasOnlyCode = (p, upc) => (upc && p?.upcSource === 'alias' && p?.sku ? String(p.sku) : '');

const flat = (s) => String(s || '').toUpperCase().replace(/[\s-]/g, '');
export const sameCode = (a, b) => !!flat(a) && flat(a) === flat(b);

// Look the box's code up so the NAME and photo change with it — a code changed under
// the old name is how the 7 pairs kept reading "Air Jordan 16" after their SKU was
// fixed. A miss returns the code with no name: the caller makes somebody type it.
export async function lookUpBoxCode(code) {
  const c = String(code || '').trim().toUpperCase();
  let p = null;
  try { p = (await api.searchSku(c)).product || null; } catch (e) {
    if (e.unauthorized || !/not found|no product/i.test(e.message || '')) throw e;
  }
  return p
    ? { found: true, sku: p.sku || c, name: p.name || '', image: p.image || '', colorway: p.colorway || '', gender: p.gender || null, sizes: p.sizes || [] }
    : { found: false, sku: c, name: '', image: '', colorway: '', gender: null, sizes: [] };
}

// code    — what Alias said            current — the code on the line now (typed over?)
// where   — which box(es) to look at, e.g. "the size 9 box"
// onConfirm()  — the box says `code`   onFix(fix) — the box says another code (looked up)
export function AliasCodeCheck({ code, current, where, onConfirm, onFix, onSignOut }) {
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  // Somebody typed a different code over the line instead of answering. The code is
  // right now, but the name and photo are still Alias's shoe — look it up.
  const changed = current && !sameCode(current, code);

  async function fix(c) {
    if (!String(c || '').trim()) return;
    setBusy(true); setErr('');
    try { onFix(await lookUpBoxCode(c)); setTyping(false); setText(''); } catch (e) {
      if (e.unauthorized) return onSignOut?.();
      setErr(e.message || 'Lookup failed — try again.');
    } finally { setBusy(false); }
  }

  return (
    <div className="recv-sku-pick alias-check" role="group" aria-label="Check the style code on the box">
      <span className="recv-sku-pick-lbl">
        {changed
          ? <>The code was changed to <b>{current}</b>, but the name and photo are still Alias’s <b>{code}</b>. Look it up so they match the box.</>
          : <>Only Alias knew this barcode, and Alias has filed boxes under the wrong shoe before.
              Check the style code printed on {where || 'the box label'} — does it say <b>{code}</b>?</>}
      </span>
      {typing ? (
        <div className="recv-sku-pick-opts">
          <input className="input sm" value={text} placeholder="Code on the box, e.g. IZ2585-001"
            autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={40} aria-label="Style code printed on the box"
            onChange={(e) => { setText(e.target.value); setErr(''); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); fix(text); } }} />
          <button type="button" className="btn sm" disabled={busy || !text.trim()} onClick={() => fix(text)}>{busy ? 'Looking…' : 'Use this code'}</button>
          <button type="button" className="btn ghost sm" disabled={busy} onClick={() => { setTyping(false); setErr(''); }}>Cancel</button>
        </div>
      ) : changed ? (
        <div className="recv-sku-pick-opts">
          <button type="button" className="btn sm" disabled={busy} onClick={() => fix(current)}>{busy ? 'Looking…' : `Look up ${current}`}</button>
        </div>
      ) : (
        <div className="recv-sku-pick-opts">
          <button type="button" className="btn sm" onClick={onConfirm}>✓ Box says {code}</button>
          <button type="button" className="btn sm" onClick={() => setTyping(true)}>Box says a different code</button>
        </div>
      )}
      {err && <span className="error sm">{err}</span>}
    </div>
  );
}
