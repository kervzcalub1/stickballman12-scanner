// Small shared pieces of the SHEIN Listings page (docs/context/shein-listings.md): the status
// chip, a rendered blocker with its fix button, EST times, the custom-size form. Every word a
// blocker says comes from src/lib/sheinListings.js (BLOCKERS) via the server's renderBlocker —
// never re-typed here.
import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api.js';
import { PH_DATETIME } from '../lib/format.js';
import { STATUSES, validateCustomText, customTextConflict, sizeKey } from '../lib/sheinListings.js';
import { compareSize } from '../lib/sheinCheck.js';

export const fmt = (n) => Number(n || 0).toLocaleString('en-US');
export const when = (t) => {
  if (!t) return '—';
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? '—' : `${PH_DATETIME.format(d)} EST`;
};
export const money = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? '—' : `$${Number(v).toFixed(2).replace(/\.00$/, '')}`);
// A SHEIN write that belongs to a later phase is drawn, disabled, with this.
export const NEXT_PHASE = 'Coming in a later phase — this doesn’t send anything to SHEIN yet';
export const NEEDS_PRIV = 'Needs an admin or the “Connect integrations” privilege';

// status → the edge / dot colour of a row or tile.
export const TONE = { blocked: 'bad', error: 'warn', out_of_date: 'info', not_on_shein: 'muted', shein_only: 'warn', in_review: 'violet', synced: 'ok', excluded: 'muted', unknown: 'muted' };

export function StatusChip({ status }) {
  const s = STATUSES[status] || STATUSES.unknown;
  return <span className={s.chip} title={s.meaning}>{s.label}</span>;
}

// In the PH workspace or the admin app — the same page lives under both.
export const inPh = () => typeof window !== 'undefined' && window.location.pathname.startsWith('/ph');
// Move to another page of the SPA without a reload: both routers follow popstate.
export function goPath(href) {
  window.history.pushState(null, '', href);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
export const checkPath = () => (inPh() ? '/ph/shein-check' : '/shein-check');

// The fix button a blocker carries. Kinds that only touch OUR database (a size spelling, a
// "leave off SHEIN") or open another page are live; everything that would change SHEIN, or
// belongs to a later phase, is shown disabled with NEXT_PHASE.
// Phase 4: the fixes for publishing a new product live in its drawer's checklist — a row's button opens it.
export const PUBLISH_FIX_KINDS = ['choose_category', 'set_attr', 'review_title', 'use_ph_photos', 'set_defaults', 'publish_again'];
const LIVE_KINDS = new Set(['add_custom_size', 'edit_size_map', 'leave_off', 'include', 'open_shopify', 'open_match', 'open_shopify_listings', 'open_seller_center', ...PUBLISH_FIX_KINDS]);
// open_match with `here`: the fix is this shoe's own "Fix SHEIN sizes" (onMatch — the drawer opens /
// scrolls to it); without it (another SHEIN product holds the SKU) the SHEIN check page.
export function FixButton({ action, shopifyUrl, onAct, busy, onMatch }) {
  if (!action) return null;
  const k = action.kind;
  const cls = 'btn xs shl-fix';
  if (!LIVE_KINDS.has(k)) return <button type="button" className={cls} disabled title={NEXT_PHASE}>{action.label}</button>;
  if (k === 'open_shopify') {
    return shopifyUrl
      ? <a className={cls} href={shopifyUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{action.label}</a>
      : <button type="button" className={cls} disabled title="No Shopify link for this product">{action.label}</button>;
  }
  if (k === 'open_seller_center') {
    return <a className={cls} href="https://sellerhub.shein.com/" target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{action.label}</a>;
  }
  if (k === 'open_match') {
    return <button type="button" className={cls} onClick={(e) => { e.stopPropagation(); if (action.here && onMatch) onMatch(); else goPath(checkPath()); }}>{action.label}</button>;
  }
  if (k === 'open_shopify_listings') {
    return inPh()
      ? <button type="button" className={cls} onClick={(e) => { e.stopPropagation(); goPath('/ph/shopify-listings'); }}>{action.label}</button>
      : <button type="button" className={cls} disabled title="Shopify Listings is a PH workspace page">{action.label}</button>;
  }
  return <button type="button" className={cls} disabled={!!busy} onClick={(e) => { e.stopPropagation(); onAct?.(k); }}>{action.label}</button>;
}

// One rendered blocker / note: what's wrong (bold), what to do, SHEIN's own words.
export function BlockerSay({ b, compact = false }) {
  if (!b) return null;
  return (
    <span className="shl-say">
      <b>{b.title}</b>{!compact && b.fix ? <> {b.fix}</> : null}
      {b.sheinSaid && <span className="shl-shein-said">SHEIN said: “{b.sheinSaid}”</span>}
    </span>
  );
}

// "9.5|W" → "9.5W" (what a person reads).
export const keyToSize = (k) => { const [n, g] = String(k || '').split('|'); return !n ? '' : g === 'M' ? n : `${n}${g || ''}`; };

// The custom-size form (DB only). A custom size is store-wide and permanent on SHEIN, so a
// person confirms each spelling ONCE; this only records it — a later phase's add-sizes run is
// what sends it. Checked here with the same rules the server and SHEIN use: ≤ 50 characters,
// half-width, no emoji — and it must still read as the same size. A SHEIN size that IS the
// same size (e.g. "US9" for our 9W in a women's category) can be picked instead; a different
// number is never offered.
export function CustomSizeModal({ size, categoryId, suggestion, onClose, onSaved, onSignOut }) {
  const key = sizeKey(size);
  const [cat, setCat] = useState(undefined);   // undefined = loading, null = not found
  const [loadErr, setLoadErr] = useState('');
  const [storeCustom, setStoreCustom] = useState([]);   // every custom size text the store already has
  const [text, setText] = useState(suggestion || '');
  const [pick, setPick] = useState('');        // a SHEIN value id, '' = custom spelling
  const [foot, setFoot] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    let live = true;
    api.sheinSizeMaps()
      .then((r) => { if (!live) return; setStoreCustom(r.customValues || []); setCat((r.categories || []).find((c) => Number(c.categoryId) === Number(categoryId)) || null); })
      .catch((e) => { if (e.unauthorized) onSignOut?.(); else if (live) { setLoadErr(e.message); setCat(null); } });
    return () => { live = false; };
  }, [categoryId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const same = useMemo(() => (cat?.sheinSizes || []).filter((v) => !v.custom && ['ok', 'ok_suffix', 'check_group'].includes(compareSize(v.label, size))), [cat, size]);
  // The server runs the same checks (api/shein/listing-maps.js): text rules, same size, a category where
  // SHEIN allows custom sizes, no look-alike of a store value or of one of SHEIN's own sizes.
  const permProblem = !categoryId ? 'Custom sizes are confirmed per SHEIN category — open it from a product in that category.'
    : cat && cat.hasPermission !== 1 ? `SHEIN doesn’t allow custom sizes in this category${cat.hasPermission == null ? ' (not asked yet — Ask SHEIN on the Sizes tab)' : ''}.` : null;
  const problem = pick ? null : (validateCustomText(text) || (compareSize(text, size) !== 'ok' ? `“${text}” doesn’t read as size ${size} — a custom size must say the same size (e.g. US${size}).` : null)
    || (cat ? customTextConflict(text, { values: cat.sheinSizes || [], customValues: storeCustom }) : null) || permProblem);
  const footBad = foot !== '' && !(Number(foot) > 0 && Number(foot) <= 100);
  const canSave = !busy && cat !== undefined && !problem && !footBad && !!key;

  async function save(e) {
    e.preventDefault();
    if (!canSave) return;
    setBusy(true); setErr('');
    try {
      const body = { categoryId: Number(categoryId) || 0, attributeId: cat?.attributeId ?? 0, sizeKey: key, footLength: foot === '' ? null : Number(foot) };
      if (pick) body.attributeValueId = Number(pick); else body.customValue = text;
      const r = await api.sheinSizeMapSave(body);
      onSaved?.(r);
    } catch (e2) { if (e2.unauthorized) onSignOut?.(); else { setErr(e2.message); setBusy(false); } }
  }

  return createPortal(
    <div className="modal-overlay" onClick={() => (busy ? null : onClose())}>
      <form className="modal form-modal shl-size-modal" role="dialog" aria-modal="true" aria-label={`SHEIN size for ${size}`} onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <h3 className="modal-title">SHEIN size for {size}</h3>
        <p className="shl-modal-lede">{categoryId ? `SHEIN category ${categoryId}` : 'Any category'}{cat?.hasPermission === 1 ? ' · custom sizes allowed' : cat?.hasPermission === 0 ? ' · custom sizes NOT allowed' : ''}</p>
        {cat === undefined && <p className="shl-modal-lede">Reading SHEIN’s size list for this category…</p>}
        {loadErr && <div className="error sm">{loadErr}</div>}
        {!!same.length && (
          <fieldset className="shl-size-pick">
            <legend>SHEIN already has this size</legend>
            {same.map((v) => (
              <label key={v.id} className="shl-radio"><input type="radio" name="shl-pick" checked={pick === String(v.id)} onChange={() => setPick(String(v.id))} /> Use SHEIN’s own <b>{v.label}</b></label>
            ))}
            <label className="shl-radio"><input type="radio" name="shl-pick" checked={!pick} onChange={() => setPick('')} /> A custom size instead</label>
          </fieldset>
        )}
        {!pick && (
          <label className="form-modal-label">
            <span>Custom size name</span>
            <input className="input" value={text} maxLength={80} disabled={busy} autoComplete="off" spellCheck={false}
              aria-label="Custom size name" aria-invalid={!!problem} onChange={(e) => setText(e.target.value)} />
            {problem
              ? <i className="shl-field-bad" role="alert">{problem}</i>
              : <i className="form-modal-hint">{text.length} of 50 characters · shoppers see it exactly like this.</i>}
          </label>
        )}
        {cat?.hasSizeTable && (
          <label className="form-modal-label">
            <span>Foot length (cm) — this SHEIN product has a size chart</span>
            <input className="input" type="number" step="0.1" min="0" inputMode="decimal" value={foot} disabled={busy} onChange={(e) => setFoot(e.target.value)} />
            {footBad && <i className="shl-field-bad">A positive number of cm, up to 100.</i>}
          </label>
        )}
        <p className="notice shl-modal-note">{pick
          ? 'Saved here only. Every size like this one then maps to SHEIN’s own size.'
          : <>A custom size is <b>store-wide and permanent</b> on SHEIN — a typo stays forever. Saving here only records the spelling; nothing is sent to SHEIN until someone confirms a dry run that adds it.</>}</p>
        {err && <div className="error sm">{err}</div>}
        <div className="modal-actions">
          <button type="button" className="btn ghost" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={!canSave}>{busy ? 'Saving…' : pick ? 'Use this SHEIN size' : 'Confirm this spelling'}</button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
