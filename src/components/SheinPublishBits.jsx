// SHEIN Listings Phase 4 — publishing brand-new products: the pieces a person uses to clear the
// requirements checklist (docs/context/shein-listings.md → "Phase 4"). Every save here touches OUR
// database only (listing-maps type=category|attr|brand|box, listings publish_choices); the only SHEIN
// calls are READS (the category suggestion, a seed from one of our SHEIN products, and — for an admin
// / Connect integrations — refreshing SHEIN's tree, brands, rules and store gates). Shared by the
// product drawer (the checklist, each ✕ with its fix inline) and the Setup tab.
//   · CategoryPicker  — SHEIN's leaf categories, searchable by path, SHEIN's own suggestion first;
//                       saved per Shopify product type + size group (every product of that type).
//   · BrandPicker     — Shopify vendor → one of SHEIN's brands for our store.
//   · AttrEditor      — "SHEIN details" defaults per SHEIN product type, from SHEIN's template
//                       (one value / several / typed / value + %), seeded from one of our products.
//   · ColourPicker, TitleEditor — per product (publish_choices).
//   · BoxDefaults     — D6: the default box size + weight per size group; UNCONFIRMED placeholders
//                       block every publish until an admin / Connect integrations saves them.
//   · useStoreGates / StoreGateBanner — SHEIN refusing new listings / quota 0 (previews still run).
//   · PublishChecklist — the server's 18 lines (✓ / ✕ / not read yet), each ✕ with its fix.
import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useLive } from '../hooks.js';
import { fmt, when, NEEDS_PRIV, BlockerSay, FixButton } from './SheinListingsBits.jsx';
import { plain } from '../lib/sheinWords.js';
import { SheinPhotoPicker } from './SheinPhotoPicker.jsx';
import { BOX_PLACEHOLDERS, sizeGroupOf, validateImperialBox, boxToImperial, boxFromImperial, cleanTitle, isKnownBrand, favouriteLeaves } from '../lib/sheinPublish.js';
import { modelFromTitle, PRODUCT_MODEL_ATTR_ID } from '../lib/sheinModel.js';

export const GROUP_LABEL = {
  adult: 'Men’s / adult', women: 'Women’s (W)', youth: 'GS / youth (Y)', child: 'Kids · PS (10.5C and up)', toddler: 'Toddler · TD (up to 10C)',
};
export const BOX_LABEL = { adult: 'Adult — men’s and women’s', youth: 'GS / youth', child: 'Kids (PS)', toddler: 'Toddler (TD)' };
export const SELLER_CENTER = 'https://sellerhub.shein.com/';

// The size groups of a product's Shopify sizes (one = can be mapped; more = mixed_size_groups).
export const productGroups = (variants = []) => [...new Set(variants.filter((v) => v.shopify_variant_id && !v.excluded).map((v) => sizeGroupOf(v.shopify_size)).filter(Boolean))];
// One loader: { d, err, reload }. 401 → sign out.
function useLoad(fn, deps, onSignOut) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  async function reload() {
    try { setD(await fn()); setErr(''); } catch (e) { if (e.unauthorized) onSignOut?.(); else setErr(plain(e.message)); }
  }
  useEffect(() => { setD(null); setErr(''); reload(); }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return { d, err, reload };
}
const choose = (productId, patch) => api.sheinListingAction({ action: 'publish_choices', productId, ...patch });

function ReadButton({ canWrite, label, busyLabel = 'Reading SHEIN…', onRead, hint }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  if (!canWrite) return <p className="muted xs">{hint || 'An admin (or someone with Connect integrations) reads it from SHEIN once; a publish preview reads it too.'}</p>;
  return (
    <span className="shl-pub-read">
      <button type="button" className="btn ghost sm" disabled={busy} title="Reads only — nothing on SHEIN changes"
        onClick={async () => { setBusy(true); setErr(''); try { await onRead(); } catch (e) { setErr(plain(e.message)); } finally { setBusy(false); } }}>{busy ? busyLabel : label}</button>
      {err && <span className="error xs">{err}</span>}
    </span>
  );
}

/* ------------------------------- category ------------------------------- */
// SHEIN only takes a product in a LAST-level category; the path is what a person searches.
// perShoe (2026-11-11): while fixing ONE shoe, the pick can be for this shoe only (publish_choices
// categoryPick — wins over the type's map) or for every shoe of its Shopify type + size group (the map).
// shoePick = the shoe's own category id when it has one ("Use the shared category again").
export function CategoryPicker({ productType, sizeGroup, productId = null, current = null, canWrite, onSaved, onCancel, onSignOut, lede = null, perShoe = false, shoePick = null }) {
  const { d, err, reload } = useLoad(() => api.sheinPublishMaps('category'), [], onSignOut);
  const [sug, setSug] = useState(null);      // null = asking / not asked
  const [sugErr, setSugErr] = useState('');
  const [q, setQ] = useState('');
  const [pick, setPick] = useState(current ? String(current) : '');
  const [busy, setBusy] = useState(false);
  const [saveErr, setSaveErr] = useState('');
  // no category yet → set it up once for the type; changing one a shoe already has → only this shoe
  const [scope, setScope] = useState(perShoe && (shoePick || current || !sizeGroup) ? 'shoe' : 'type');
  useEffect(() => {
    if (!productId) return undefined;
    let live = true;
    api.sheinListingMeta({ suggest: productId })
      .then((r) => { if (live) { setSug(r.suggestions || []); if (!current && r.suggestions?.[0]) setPick(String(r.suggestions[0].categoryId)); } })
      .catch((e) => { if (e.unauthorized) onSignOut?.(); else if (live) { setSug([]); setSugErr(plain(e.message)); } });
    return () => { live = false; };
  }, [productId]); // eslint-disable-line react-hooks/exhaustive-deps
  const leaves = d?.leaves || null;
  const byId = useMemo(() => new Map((leaves || []).map((l) => [String(l.categoryId), l])), [leaves]);
  const suggested = (sug || []).map((s) => ({ ...s, leaf: byId.get(String(s.categoryId)) || null })).filter((s) => s.leaf);
  // the team's most-used categories, found in SHEIN's own tree by their path (never a fixed id) — always on top
  const favs = useMemo(() => (leaves ? favouriteLeaves(leaves) : []), [leaves]);
  const { matches, count } = useMemo(() => {
    if (!leaves) return { matches: [], count: 0 };
    const ws = q.toLowerCase().split(/\s+/).filter(Boolean);
    const hit = (l) => ws.every((w) => l.path.toLowerCase().includes(w) || String(l.categoryId) === w);
    const list = ws.length ? leaves.filter(hit) : leaves.filter((l) => /shoe|sneaker|boot|sandal|footwear/i.test(l.path));
    return { matches: list.slice(0, 40), count: list.length };
  }, [leaves, q]);
  const picked = byId.get(pick) || null;

  async function save() {
    if (!picked) return;
    setBusy(true); setSaveErr('');
    try {
      if (scope === 'shoe') {
        await choose(productId, { categoryPick: { categoryId: Number(pick) } });
        onSaved?.({ category_path: picked.path, shoe: true });
        return;
      }
      const s = suggested.find((x) => String(x.categoryId) === pick);
      const r = await api.sheinPublishMapSave('category', { action: 'set', productType: productType || '', sizeGroup, categoryId: Number(pick), suggestion: s ? { categoryId: s.categoryId, vote: s.vote, order: s.order } : null });
      if (perShoe && shoePick) await choose(productId, { categoryPick: null });   // "every shoe" includes this one: drop its own pick
      onSaved?.(r.map);
    } catch (e) { if (e.unauthorized) onSignOut?.(); else setSaveErr(plain(e.message)); }
    finally { setBusy(false); }
  }
  async function backToShared() {
    setBusy(true); setSaveErr('');
    try { await choose(productId, { categoryPick: null }); onSaved?.({ shoe: true, cleared: true }); }
    catch (e) { if (e.unauthorized) onSignOut?.(); else setSaveErr(plain(e.message)); }
    finally { setBusy(false); }
  }
  const Opt = ({ l, tag }) => {
    const parts = l.path.split(' › ');
    return (
      <label className={`shl-radio shl-cat-opt${pick === String(l.categoryId) ? ' on' : ''}`} data-cat={l.categoryId}>
        <input type="radio" name={`shl-cat-${productType}-${sizeGroup}`} checked={pick === String(l.categoryId)} onChange={() => setPick(String(l.categoryId))} />
        <span className="shl-cat-path"><span className="muted">{parts.slice(0, -1).join(' › ')}{parts.length > 1 ? ' › ' : ''}</span><b>{parts.at(-1)}</b>{tag}</span>
      </label>
    );
  };
  return (
    <div className="shl-pub-panel" data-panel="category">
      {perShoe ? (
        <div className="shl-cat-scope" role="radiogroup" aria-label="Who gets this category" data-scope={scope}>
          <label className="shl-radio"><input type="radio" name={`shl-scope-${productId}`} checked={scope === 'shoe'} onChange={() => setScope('shoe')} /> <span><b>Only this shoe</b> <span className="muted xs">— the other shoes keep their category</span></span></label>
          <label className="shl-radio"><input type="radio" name={`shl-scope-${productId}`} checked={scope === 'type'} disabled={!sizeGroup} onChange={() => setScope('type')} /> <span>For every Shopify <b>“{productType || '(no product type)'}”</b> shoe in <b>{GROUP_LABEL[sizeGroup] || sizeGroup || '—'}</b></span></label>
          <p className="muted xs">Saved on our side; nothing goes to SHEIN until a publish is confirmed.{shoePick ? ' This shoe has its own category now.' : ''}</p>
        </div>
      ) : (
        <p className="xs shl-pub-lede">For every Shopify <b>“{productType || '(no product type)'}”</b> shoe in <b>{GROUP_LABEL[sizeGroup] || sizeGroup}</b>{lede ? <> — {lede}</> : ''}. Saved once on our side; nothing goes to SHEIN.</p>
      )}
      {err && <p className="error xs">{err}</p>}
      {!d && !err && <div className="shl-skel shl-skel-line" />}
      {d && !leaves && (
        <div className="notice xs">SHEIN’s category list hasn’t been read yet.{' '}
          <ReadButton canWrite={canWrite} label="Read SHEIN’s categories (read-only)" onRead={async () => { await api.sheinListingMeta({ tree: 1, refresh: 1 }); await reload(); }} />
        </div>
      )}
      {leaves && (
        <>
          {favs.length > 0 && (
            <div className="shl-cat-fav" data-fav="">
              <span className="muted xs shl-block">Frequently used:</span>
              {favs.flatMap((f) => f.leaves.map((l) => <Opt key={`f${l.categoryId}`} l={l} tag={<span className="ebo-chip ok shl-cat-tag">{f.label}</span>} />))}
            </div>
          )}
          {productId && (
            <div className="shl-cat-sug">
              {sug === null && <span className="muted xs">Asking SHEIN for a suggestion from the photo…</span>}
              {sug && !suggested.length && <span className="muted xs">{sugErr ? `SHEIN couldn’t suggest one: ${sugErr}` : 'SHEIN had no suggestion for this photo.'}</span>}
              {suggested.length > 0 && <span className="muted xs shl-block">SHEIN suggests (from the photo and title):</span>}
              {suggested.map((s) => <Opt key={`s${s.categoryId}`} l={s.leaf} tag={<span className="ebo-chip info shl-cat-tag">SHEIN’s pick{s.vote != null ? ` · ${s.vote} %` : ''}</span>} />)}
            </div>
          )}
          <input type="search" className="input shl-cat-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search SHEIN categories, e.g. men sneakers" aria-label="Search SHEIN categories" />
          <div className="shl-cat-list" role="radiogroup" aria-label="SHEIN categories">
            {matches.map((l) => <Opt key={l.categoryId} l={l} />)}
            {!matches.length && <p className="muted xs">No SHEIN category matches “{q}”.</p>}
          </div>
          <p className="muted xs">{q.trim() ? `${fmt(count)} match${count === 1 ? '' : 'es'}${count > 40 ? ' — showing 40, type more to narrow it' : ''}` : `${fmt(leaves.length)} SHEIN categories · showing the shoe ones${count > 40 ? ' (first 40)' : ''} — type to search all`}</p>
          {saveErr && <p className="error xs" role="alert">{saveErr}</p>}
          <div className="shl-pub-acts">
            {onCancel && <button type="button" className="btn ghost sm" onClick={onCancel}>Cancel</button>}
            {perShoe && shoePick && <button type="button" className="btn ghost sm" disabled={busy} data-act="shared-category" onClick={backToShared}>Use the shared category again</button>}
            <button type="button" className="btn primary sm" disabled={!picked || busy || (scope === 'type' && !sizeGroup)} onClick={save}>{busy ? 'Saving…' : picked ? `Use “${picked.path.split(' › ').at(-1)}”${scope === 'shoe' && perShoe ? ' for this shoe' : ''}` : 'Pick a category'}</button>
          </div>
        </>
      )}
    </div>
  );
}

/* --------------------------------- brand --------------------------------- */
export function BrandPicker({ vendor, canWrite, onSaved, onCancel, onSignOut }) {
  const { d, err, reload } = useLoad(() => api.sheinPublishMaps('brand'), [], onSignOut);
  const key = String(vendor || '').trim().toLowerCase();
  const map = (d?.maps || []).find((m) => m.vendor === key);
  const brands = d?.brands || null;
  const guess = brands?.find((b) => String(b.brand_name || '').toLowerCase() === key)?.brand_code || '';
  const [pick, setPick] = useState('');
  useEffect(() => { if (d) setPick(map?.brand_code || guess || ''); }, [d]); // eslint-disable-line react-hooks/exhaustive-deps
  const [busy, setBusy] = useState(false);
  const [saveErr, setSaveErr] = useState('');
  async function save() {
    setBusy(true); setSaveErr('');
    try { const r = await api.sheinPublishMapSave('brand', { action: 'set', vendor: key, brandCode: pick }); onSaved?.(r.map); }
    catch (e) { if (e.unauthorized) onSignOut?.(); else setSaveErr(plain(e.message)); }
    finally { setBusy(false); }
  }
  return (
    <div className="shl-pub-panel" data-panel="brand">
      <p className="xs shl-pub-lede">Every product whose Shopify vendor is <b>{vendor || '(none)'}</b>. Only brands SHEIN lists as authorised for our store can be picked — a new one is applied for in <a className="ebl-link" href={SELLER_CENTER} target="_blank" rel="noreferrer">Seller Center ↗</a>.</p>
      {err && <p className="error xs">{err}</p>}
      {!d && !err && <div className="shl-skel shl-skel-line" />}
      {d && !brands && (
        <div className="notice xs">SHEIN’s brand list hasn’t been read yet.{' '}
          <ReadButton canWrite={canWrite} label="Read SHEIN’s brands (read-only)" onRead={async () => { await api.sheinListingMeta({ brands: 1, refresh: 1 }); await reload(); }} />
        </div>
      )}
      {brands && (
        <>
          <select className="input" value={pick} onChange={(e) => setPick(e.target.value)} aria-label={`SHEIN brand for ${vendor || 'this vendor'}`}>
            <option value="">— pick a SHEIN brand —</option>
            {[...brands].sort((a, b) => String(a.brand_name).localeCompare(String(b.brand_name))).map((b) => <option key={b.brand_code} value={b.brand_code}>{b.brand_name} ({b.brand_code})</option>)}
          </select>
          {!brands.length && <p className="muted xs">SHEIN lists no authorised brand for the store.</p>}
          {map && <p className="muted xs">Now: {map.no_brand ? 'no brand (generic product)' : map.brand_name || map.brand_code} · set by {map.set_by || '—'} {when(map.set_at)}</p>}
          {/* D5 (review F2): an unmapped vendor blocks publishing; only a real generic one may go up with no brand — never a known brand */}
          {!isKnownBrand(vendor) && !map?.no_brand && (
            <p className="xs">Not a brand at all (a generic product)?{' '}
              <button type="button" className="btn ghost xs" data-act="no-brand" disabled={busy} onClick={async () => { setBusy(true); setSaveErr(''); try { const r = await api.sheinPublishMapSave('brand', { action: 'no_brand', vendor: key }); onSaved?.(r.map); } catch (e) { if (e.unauthorized) onSignOut?.(); else setSaveErr(plain(e.message)); } finally { setBusy(false); } }}>Mark “no brand”</button>
            </p>
          )}
          {isKnownBrand(vendor) && <p className="muted xs">{vendor} is a known brand — it only goes up under its SHEIN brand.</p>}
          {saveErr && <p className="error xs" role="alert">{saveErr}</p>}
          <div className="shl-pub-acts">
            {onCancel && <button type="button" className="btn ghost sm" onClick={onCancel}>Cancel</button>}
            {map && <button type="button" className="btn ghost sm" disabled={busy} onClick={async () => { setBusy(true); try { await api.sheinPublishMapSave('brand', { action: 'clear', vendor: key }); onSaved?.(null); } catch (e) { setSaveErr(plain(e.message)); } finally { setBusy(false); } }}>Clear</button>}
            <button type="button" className="btn primary sm" disabled={!pick || busy || pick === map?.brand_code} onClick={save}>{busy ? 'Saving…' : 'Save brand'}</button>
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------ SHEIN details ------------------------------ */
// attribute mode (SHEIN template): 3 one value · 1 several (≤ inputNum) · 0 typed · 4 value + amount.
const MODE_HINT = { 3: 'Pick one', 1: 'Pick one or more', 0: 'Type it', 4: 'Pick values and give each a share' };
const sameDraft = (a, b) => JSON.stringify({ v: [...(a?.valueIds || [])].map(Number).sort(), x: a?.extraValues || [] }) === JSON.stringify({ v: [...(b?.valueIds || [])].map(Number).sort(), x: b?.extraValues || [] });
function draftProblem(a, dr) {
  const v = dr?.valueIds || []; const x = (dr?.extraValues || []).map((s) => String(s).trim());
  if (a.mode === 3) return v.length === 1 ? null : 'Pick exactly one value.';
  if (a.mode === 1) return !v.length ? 'Pick at least one value.' : a.inputNum && v.length > a.inputNum ? `At most ${a.inputNum}.` : null;
  if (a.mode === 0) return x.length === 1 && x[0] ? null : 'Type one value.';
  if (a.mode === 4) {
    if (!v.length || v.length !== x.length || x.some((n) => !(Number(n) > 0))) return 'Give every value picked an amount.';
    if (a.type === 3 && x.reduce((n, s) => n + Number(s), 0) !== 100) return 'The amounts must add up to 100.';
    return null;
  }
  return v.length ? null : 'Pick a value.';
}

function AttrControl({ a, dr, onChange }) {
  const v = (dr?.valueIds || []).map(Number);
  const x = dr?.extraValues || [];
  if (a.mode === 0) return <input className="input" value={x[0] || ''} maxLength={100} aria-label={a.name} onChange={(e) => onChange({ valueIds: [], extraValues: [e.target.value] })} />;
  if (a.mode === 1 || a.mode === 4) {
    return (
      <div className="shl-attr-multi" role="group" aria-label={a.name}>
        {a.values.map((o) => {
          const i = v.indexOf(o.id); const on = i >= 0;
          return (
            <span key={o.id} className="shl-attr-opt">
              <label className="shl-radio"><input type="checkbox" checked={on} onChange={(e) => {
                if (e.target.checked) onChange({ valueIds: [...v, o.id], extraValues: a.mode === 4 ? [...x, ''] : [] });
                else onChange({ valueIds: v.filter((_, k) => k !== i), extraValues: a.mode === 4 ? x.filter((_, k) => k !== i) : [] });
              }} /> {o.label}</label>
              {a.mode === 4 && on && <input className="input shl-attr-pct" type="number" min="1" max="100" inputMode="numeric" value={x[i] || ''} aria-label={`${o.label} %`}
                onChange={(e) => onChange({ valueIds: v, extraValues: x.map((s, k) => (k === i ? e.target.value : s)) })} />}
            </span>
          );
        })}
      </div>
    );
  }
  return (
    <select className="input" value={v[0] ?? ''} aria-label={a.name} onChange={(e) => onChange({ valueIds: e.target.value ? [Number(e.target.value)] : [], extraValues: [] })}>
      <option value="">— pick —</option>
      {a.values.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
    </select>
  );
}

// Defaults per SHEIN product type: set once, used by every product of that type. `focus` = the
// attribute ids a blocker names (e.g. one SHEIN requires because of another choice).
// 2026-11-14 (owner): a TYPED detail (Product Model, Series) is never a default here — every shoe has its own. It
// shows as "typed per shoe" with no input (the server refuses one too); an old saved default reads "not used" + Clear.
const isTyped = (a) => a.mode === 0;
export function AttrEditor({ productTypeId, categoryId = null, canWrite, onSaved, onSignOut, focus = [] }) {
  const { d, err, reload } = useLoad(() => api.sheinPublishMaps('attr', { productTypeId }), [productTypeId], onSignOut);
  const [drafts, setDrafts] = useState({});
  const [proposedFrom, setProposedFrom] = useState('');
  const [rowErr, setRowErr] = useState({});
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [all, setAll] = useState(false);
  const [spu, setSpu] = useState('');
  const attrs = d?.template?.attributes || [];
  const saved = useMemo(() => new Map((d?.defaults || []).map((x) => [Number(x.attribute_id), x])), [d]);
  const savedDraft = (id) => { const s = saved.get(id); return s ? { valueIds: (s.value_ids || []).map(Number), extraValues: s.extra_values || [] } : null; };
  const draftOf = (id) => drafts[id] || savedDraft(id) || { valueIds: [], extraValues: [] };
  const want = new Set(focus.map(Number));
  const important = (a) => a.status === 3 || want.has(a.attributeId);
  const sorted = [...attrs].sort((a, b) => Number(important(b)) - Number(important(a)) || Number(!saved.has(a.attributeId)) - Number(!saved.has(b.attributeId)));
  const shown = all ? sorted : sorted.filter((a) => important(a) || saved.has(a.attributeId) || drafts[a.attributeId]);
  const dirty = attrs.filter((a) => !isTyped(a) && drafts[a.attributeId] && !sameDraft(drafts[a.attributeId], savedDraft(a.attributeId)));
  const missing = attrs.filter((a) => !isTyped(a) && important(a) && !saved.has(a.attributeId));

  async function saveOne(a) {
    const dr = draftOf(a.attributeId);
    const bad = draftProblem(a, dr);
    if (bad) { setRowErr((m) => ({ ...m, [a.attributeId]: bad })); return false; }
    try {
      await api.sheinPublishMapSave('attr', { action: 'set', productTypeId, attributeId: a.attributeId, valueIds: dr.valueIds, extraValues: dr.extraValues.map((s) => String(s).trim()) });
      setRowErr((m) => ({ ...m, [a.attributeId]: '' }));
      setDrafts((m) => { const n = { ...m }; delete n[a.attributeId]; return n; });
      return true;
    } catch (e) { if (e.unauthorized) onSignOut?.(); setRowErr((m) => ({ ...m, [a.attributeId]: plain(e.message) })); return false; }
  }
  async function run(label, fn) { setBusy(label); setMsg(''); try { await fn(); } finally { setBusy(''); } }
  const saveAll = () => run('all', async () => {
    let ok = 0;
    for (const a of dirty) if (await saveOne(a)) ok += 1;
    await reload(); setProposedFrom(''); setMsg(`Saved ${fmt(ok)} of ${fmt(dirty.length)}.`); onSaved?.();
  });
  const seed = () => run('seed', async () => {
    try {
      const r = await api.sheinPublishMapSave('attr', { action: 'seed', productTypeId, spu: spu.trim() });
      const next = { ...drafts };
      // a typed detail (Product Model) is that product's own — never copied as a default for the type
      for (const p of r.proposed || []) if (attrs.some((a) => a.attributeId === Number(p.attributeId) && !isTyped(a))) next[p.attributeId] = { valueIds: (p.valueIds || []).map(Number), extraValues: p.extraValues || [], proposed: true };
      setDrafts(next); setProposedFrom(spu.trim()); setAll(true);
      setMsg(`${fmt((r.proposed || []).length)} details copied from ${spu.trim()} — nothing is saved yet. Check each one, then “Save all changes”.`);
    } catch (e) { if (e.unauthorized) onSignOut?.(); else setMsg(`Couldn’t copy: ${plain(e.message)}`); }
  });

  if (err) return <p className="error xs">{err}</p>;
  if (!d) return <div className="shl-skel shl-skel-line" />;
  if (!d.template) {
    return (
      <div className="shl-pub-panel" data-panel="attributes">
        <div className="notice xs">SHEIN’s list of details for this product type hasn’t been read yet.{' '}
          {categoryId ? <ReadButton canWrite={canWrite} label="Read SHEIN’s details (read-only)" onRead={async () => { await api.sheinListingMeta({ category: categoryId, refresh: 1 }); await reload(); }} />
            : <span className="muted">A publish preview of a product in this category reads it.</span>}
        </div>
      </div>
    );
  }
  return (
    <div className="shl-pub-panel" data-panel="attributes">
      <p className="xs shl-pub-lede">Shopify has none of these, so a person sets them once for every product of this SHEIN type ({fmt(attrs.length)} details · {fmt(missing.length)} required still missing). Nothing goes to SHEIN until a publish is confirmed.</p>
      <div className="shl-attr-seed">
        <input className="input" value={spu} onChange={(e) => setSpu(e.target.value)} placeholder="Code of one of our approved SHEIN products of this type" aria-label="Copy details from SHEIN product" />
        <button type="button" className="btn ghost sm" disabled={!/^[A-Za-z0-9_-]{3,60}$/.test(spu.trim()) || !!busy} title="Reads that product on SHEIN and fills the boxes below — you check them, then save"
          onClick={seed}>{busy === 'seed' ? 'Reading…' : 'Copy from this product'}</button>
      </div>
      {msg && <p className="ebl-ok xs" role="status">{msg}</p>}
      <div className="shl-attrs">
        {shown.map((a) => {
          const dr = draftOf(a.attributeId);
          const isSaved = saved.has(a.attributeId);
          const changed = drafts[a.attributeId] && !sameDraft(drafts[a.attributeId], savedDraft(a.attributeId));
          const s = saved.get(a.attributeId);
          if (isTyped(a)) {
            return (
              <div key={a.attributeId} className="shl-attr" data-attr={a.attributeId} data-typed="">
                <div className="shl-attr-head">
                  <b>{a.name || `#${a.attributeId}`}</b>
                  {a.status === 3 ? <span className="ebo-chip bad">Required</span> : <span className="ebo-chip">Optional</span>}
                  <span className="ebo-chip warn">Typed per shoe</span>
                </div>
                <p className="muted xs">Every shoe has its own {a.name || 'value'}, so it isn’t set here for every shoe of this type. {a.attributeId === PRODUCT_MODEL_ATTR_ID ? 'It is read from each shoe’s title when we recognise the model; otherwise type it on the shoe: ' : 'Type it on the shoe: '}open the shoe’s <b>Details → SHEIN details</b>.</p>
                {isSaved && (
                  <div className="shl-pub-acts">
                    <span className="muted xs shl-grow" data-old-default="">Old default “{(s.extra_values || [])[0] || '—'}” (by {s.set_by || '—'} {when(s.set_at)}) — not used any more.</span>
                    <button type="button" className="btn ghost xs" disabled={!!busy} onClick={() => run(`c${a.attributeId}`, async () => { await api.sheinPublishMapSave('attr', { action: 'clear', productTypeId, attributeId: a.attributeId }); await reload(); onSaved?.(); })}>Clear</button>
                  </div>
                )}
              </div>
            );
          }
          return (
            <div key={a.attributeId} className={`shl-attr${important(a) && !isSaved ? ' need' : ''}${changed ? ' chg' : ''}`} data-attr={a.attributeId}>
              <div className="shl-attr-head">
                <b>{a.name || `#${a.attributeId}`}</b>
                {a.status === 3 ? <span className="ebo-chip bad">Required</span> : want.has(a.attributeId) ? <span className="ebo-chip bad">Required with your other choices</span> : <span className="ebo-chip">Optional</span>}
                {isSaved && !changed && <span className="ebo-chip ok">Saved</span>}
                {s?.stale && <span className="ebo-chip warn">SHEIN changed this list — check it</span>}
                {drafts[a.attributeId]?.proposed && changed && <span className="ebo-chip violet">Copied from {proposedFrom} — not saved</span>}
                <span className="muted xs">{MODE_HINT[a.mode] || 'Pick'}{a.mode === 1 && a.inputNum ? ` (up to ${a.inputNum})` : ''}{a.mode === 4 && a.type === 3 ? ' (adds up to 100)' : ''}</span>
              </div>
              <AttrControl a={a} dr={dr} onChange={(next) => setDrafts((m) => ({ ...m, [a.attributeId]: { ...next, proposed: m[a.attributeId]?.proposed } }))} />
              {rowErr[a.attributeId] && <p className="shl-field-bad" role="alert">{rowErr[a.attributeId]}</p>}
              <div className="shl-pub-acts">
                {isSaved && <span className="muted xs shl-grow">by {s.set_by || '—'} {when(s.set_at)}</span>}
                {isSaved && <button type="button" className="btn ghost xs" disabled={!!busy} onClick={() => run(`c${a.attributeId}`, async () => { await api.sheinPublishMapSave('attr', { action: 'clear', productTypeId, attributeId: a.attributeId }); await reload(); onSaved?.(); })}>Clear</button>}
                {changed && <button type="button" className="btn ghost xs" disabled={!!busy} onClick={() => setDrafts((m) => { const n = { ...m }; delete n[a.attributeId]; return n; })}>Undo</button>}
                {changed && <button type="button" className="btn primary xs" disabled={!!busy} onClick={() => run(`s${a.attributeId}`, async () => { if (await saveOne(a)) { await reload(); onSaved?.(); } })}>{busy === `s${a.attributeId}` ? 'Saving…' : 'Save'}</button>}
              </div>
            </div>
          );
        })}
      </div>
      <div className="shl-pub-acts">
        {attrs.length > shown.length && <button type="button" className="btn ghost sm" onClick={() => setAll(true)}>Show all {fmt(attrs.length)} details</button>}
        {all && <button type="button" className="btn ghost sm" onClick={() => setAll(false)}>Only the required ones</button>}
        {dirty.length > 0 && <button type="button" className="btn primary sm" disabled={!!busy} onClick={saveAll}>{busy === 'all' ? 'Saving…' : `Save all changes (${fmt(dirty.length)})`}</button>}
      </div>
    </div>
  );
}

/* --------------------------- SHEIN details for ONE shoe --------------------------- */
// 2026-11-11: some details are per shoe — Product Model above all (the old Setup default "Dunk Low" fit one
// Nike, never an adidas). A value typed here is THIS shoe's (publish_choices attr → attr_overrides) and wins over
// Setup's default for the same detail; a TYPED required detail is only ever taken from here. Saved for the
// shoe's current SHEIN product type — after a category change to another type it is asked again.
const ownDraft = (o) => (o ? { valueIds: (o.valueIds || []).map(Number), extraValues: o.extraValues || [] } : null);
const MODEL_HINT = /model|style name|series/i;
export function ShoeAttrEditor({ product, productTypeId, categoryId = null, canWrite, onSaved, onSignOut, focus = [] }) {
  const ptid = Number(productTypeId) || null;
  const { d, err, reload } = useLoad(() => (ptid ? api.sheinPublishMaps('attr', { productTypeId: ptid }) : Promise.resolve({ template: null, defaults: [] })), [ptid], onSignOut);
  const [drafts, setDrafts] = useState({});
  const [rowErr, setRowErr] = useState({});
  const [busy, setBusy] = useState('');
  const [all, setAll] = useState(false);
  const attrs = d?.template?.attributes || [];
  const own = useMemo(() => {
    const m = new Map();
    for (const [id, o] of Object.entries(product?.attr_overrides || {})) if (o && Number(o.ptid) === ptid) m.set(Number(id), o);
    return m;
  }, [product?.attr_overrides, ptid]);
  // 2026-11-14: a Setup row for a TYPED detail (an old "Dunk Low" default) is never used — the server ignores it too
  const typedIds = useMemo(() => new Set([PRODUCT_MODEL_ATTR_ID, ...attrs.filter((a) => a.mode === 0).map((a) => a.attributeId)]), [attrs]);
  const typeDefault = useMemo(() => new Map((d?.defaults || []).filter((x) => !typedIds.has(Number(x.attribute_id))).map((x) => [Number(x.attribute_id), x])), [d, typedIds]);
  const want = new Set(focus.map(Number));
  // Product Model from the shoe's title (sheinModel.js — the server uses it only when `sure`); a typed value wins
  const fromTitle = useMemo(() => modelFromTitle(product?.title || ''), [product?.title]);
  const titleFor = (a) => (a.attributeId === PRODUCT_MODEL_ATTR_ID && a.mode === 0 && !own.has(a.attributeId) && fromTitle.model ? fromTitle : null);
  // typed + required = typed for each shoe (never a Setup default)
  const perShoe = (a) => a.mode === 0 && (a.status === 3 || want.has(a.attributeId));
  const covered = (a) => own.has(a.attributeId) || !!titleFor(a)?.sure || (typeDefault.has(a.attributeId) && !typeDefault.get(a.attributeId)?.stale);
  const needed = (a) => (a.status === 3 || want.has(a.attributeId)) && !covered(a);
  const rank = (a) => (needed(a) ? 0 : own.has(a.attributeId) ? 1 : perShoe(a) || MODEL_HINT.test(a.name || '') ? 2 : 3);
  const sorted = [...attrs].sort((a, b) => rank(a) - rank(b));
  const shown = all ? sorted : sorted.filter((a) => rank(a) < 3 || drafts[a.attributeId]);
  const missing = attrs.filter(needed);
  const titleDraft = (id) => (id === PRODUCT_MODEL_ATTR_ID && !own.has(id) && fromTitle.model ? { valueIds: [], extraValues: [fromTitle.model] } : null);
  const draftOf = (id) => drafts[id] || ownDraft(own.get(id)) || titleDraft(id) || { valueIds: [], extraValues: [] };
  const label = (a, x) => (a.mode === 0 ? (x.extra_values || x.extraValues || [])[0] : (x.value_ids || x.valueIds || []).map((v) => a.values.find((o) => o.id === Number(v))?.label || v).join(', '));

  async function save(a) {
    const dr = draftOf(a.attributeId);
    const bad = draftProblem(a, dr);
    if (bad) { setRowErr((m) => ({ ...m, [a.attributeId]: bad })); return; }
    setBusy(`s${a.attributeId}`);
    try {
      await choose(product.shopify_product_id, { attr: { attributeId: a.attributeId, valueIds: dr.valueIds, extraValues: (dr.extraValues || []).map((x) => String(x).trim()) } });
      setRowErr((m) => ({ ...m, [a.attributeId]: '' }));
      setDrafts((m) => { const n = { ...m }; delete n[a.attributeId]; return n; });
      onSaved?.(`${a.name || 'Detail'} saved for this shoe.`);
    } catch (e) { if (e.unauthorized) onSignOut?.(); else setRowErr((m) => ({ ...m, [a.attributeId]: plain(e.message) })); }
    finally { setBusy(''); }
  }
  async function clear(a) {
    setBusy(`c${a.attributeId}`);
    try { await choose(product.shopify_product_id, { attr: { attributeId: a.attributeId, clear: true } }); onSaved?.(`${a.name || 'Detail'} removed from this shoe.`); }
    catch (e) { if (e.unauthorized) onSignOut?.(); else setRowErr((m) => ({ ...m, [a.attributeId]: plain(e.message) })); }
    finally { setBusy(''); }
  }

  if (!ptid) return <p className="notice xs">Choose this shoe’s SHEIN category first — the details SHEIN asks for depend on it.</p>;
  if (err) return <p className="error xs">{err}</p>;
  if (!d) return <div className="shl-skel shl-skel-line" />;
  if (!d.template) {
    return (
      <div className="notice xs">SHEIN’s list of details for this category hasn’t been read yet.{' '}
        {categoryId ? <ReadButton canWrite={canWrite} label="Read SHEIN’s details (read-only)" onRead={async () => { await api.sheinListingMeta({ category: categoryId, refresh: 1 }); await reload(); }} />
          : <span className="muted">A publish preview reads it.</span>}
      </div>
    );
  }
  return (
    <div className="shl-pub-panel" data-panel="shoe-attributes">
      <p className="xs shl-pub-lede"><b>For this shoe only</b> — {product?.title || 'this shoe'}. Type the model the way the shoe is sold (e.g. Samba OG, Air Jordan 4 Retro, Ultraboost 1.0) — when we recognise it, it is read from the title. A value typed here wins; it is saved for this shoe only, never for other shoes. Nothing goes to SHEIN until a publish is confirmed.{missing.length ? <> <b>{fmt(missing.length)} required still missing.</b></> : ''}</p>
      <div className="shl-attrs">
        {shown.map((a) => {
          const dr = draftOf(a.attributeId);
          const mine = own.get(a.attributeId);
          const def = typeDefault.get(a.attributeId);
          const tt = titleFor(a);
          // an unsure guess from the title waits for a person to check + save it; a sure one is already used
          const changed = drafts[a.attributeId] ? JSON.stringify(drafts[a.attributeId]) !== JSON.stringify(ownDraft(mine) || { valueIds: [], extraValues: [] }) : !!tt && !tt.sure;
          return (
            <div key={a.attributeId} className={`shl-attr${needed(a) ? ' need' : ''}${changed ? ' chg' : ''}`} data-shoe-attr={a.attributeId}>
              <div className="shl-attr-head">
                <b>{a.name || `#${a.attributeId}`}</b>
                {a.status === 3 ? <span className="ebo-chip bad">Required</span> : want.has(a.attributeId) ? <span className="ebo-chip bad">Required with your other choices</span> : <span className="ebo-chip">Optional</span>}
                {mine && !changed && <span className="ebo-chip ok">Set for this shoe</span>}
                {!mine && def && !perShoe(a) && <span className="ebo-chip">From Setup: {label(a, def) || '—'}</span>}
                {tt?.sure && <span className="ebo-chip ok" data-from-title="sure">From the title</span>}
                {tt && !tt.sure && <span className="ebo-chip warn" data-from-title="guess">From the title — check it</span>}
                {!mine && !tt && perShoe(a) && <span className="ebo-chip warn">Typed per shoe</span>}
                <span className="muted xs">{MODE_HINT[a.mode] || 'Pick'}</span>
              </div>
              {a.mode === 0
                ? <input className="input" value={dr.extraValues?.[0] || ''} maxLength={100} aria-label={`${a.name} for this shoe`} placeholder={/model/i.test(a.name || '') ? 'e.g. Samba OG' : ''}
                    onChange={(e) => setDrafts((m) => ({ ...m, [a.attributeId]: { valueIds: [], extraValues: [e.target.value] } }))}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save(a); } }} />
                : <AttrControl a={a} dr={dr} onChange={(next) => setDrafts((m) => ({ ...m, [a.attributeId]: next }))} />}
              {tt && !drafts[a.attributeId] && <p className="muted xs">{tt.sure ? <>Read from the title: SHEIN gets “{tt.model}” for this shoe. Change it here if it’s wrong.</> : <>Our guess from the title — not sent until a person checks it. Fix it if needed, then <b>Save for this shoe</b>.</>}</p>}
              {rowErr[a.attributeId] && <p className="shl-field-bad" role="alert">{rowErr[a.attributeId]}</p>}
              <div className="shl-pub-acts">
                {mine && <span className="muted xs shl-grow">by {mine.by || '—'} {when(mine.at)}</span>}
                {mine && !changed && <button type="button" className="btn ghost xs" disabled={!!busy} onClick={() => clear(a)}>{busy === `c${a.attributeId}` ? 'Removing…' : 'Remove'}</button>}
                {changed && drafts[a.attributeId] && <button type="button" className="btn ghost xs" disabled={!!busy} onClick={() => setDrafts((m) => { const n = { ...m }; delete n[a.attributeId]; return n; })}>Undo</button>}
                {changed && <button type="button" className="btn primary xs" disabled={!!busy} onClick={() => save(a)}>{busy === `s${a.attributeId}` ? 'Saving…' : 'Save for this shoe'}</button>}
              </div>
            </div>
          );
        })}
      </div>
      <div className="shl-pub-acts">
        {attrs.length > shown.length && <button type="button" className="btn ghost sm" onClick={() => setAll(true)}>Show all {fmt(attrs.length)} details</button>}
        {all && <button type="button" className="btn ghost sm" onClick={() => setAll(false)}>Only the ones that matter</button>}
      </div>
    </div>
  );
}

/* --------------------------- colour + title (per product) --------------------------- */
export function ColourPicker({ productId, productTypeId, current, onSaved, onSignOut }) {
  const { d, err } = useLoad(() => api.sheinPublishMaps('attr', { productTypeId }), [productTypeId], onSignOut);
  const [pick, setPick] = useState(current ? String(current) : '');
  const [busy, setBusy] = useState(false);
  const [e2, setE2] = useState('');
  const main = d?.template?.main || null;
  const status = d?.template?.mainStatus;
  const values = (main?.values || []).filter((v) => status !== 3 || !/^(default|默认)$/i.test(v.label));
  async function save(v) {
    setBusy(true); setE2('');
    try { await choose(productId, { skcValueId: v === '' ? null : Number(v) }); onSaved?.(); } catch (e) { if (e.unauthorized) onSignOut?.(); else setE2(plain(e.message)); } finally { setBusy(false); }
  }
  if (err) return <p className="error xs">{err}</p>;
  if (!d) return <div className="shl-skel shl-skel-line" />;
  if (!main) return <p className="notice xs">SHEIN’s colour list for this type hasn’t been read yet — a publish preview reads it.</p>;
  if (status === 1) return <p className="muted xs">SHEIN uses its own “Default” colour for this type — nothing to pick.</p>;
  return (
    <div className="shl-pub-panel" data-panel="colour">
      <p className="xs shl-pub-lede">The colour SHEIN shows for this shoe ({main.name || 'Colour'}). {status === 3 ? 'SHEIN needs a real colour here — not “Default”.' : 'Optional — “Default” is used if none is picked.'}</p>
      <select className="input" value={pick} onChange={(e) => setPick(e.target.value)} aria-label="SHEIN colour">
        <option value="">— pick a colour —</option>
        {values.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
      </select>
      {e2 && <p className="error xs">{e2}</p>}
      <div className="shl-pub-acts">
        {current && <button type="button" className="btn ghost sm" disabled={busy} onClick={() => save('')}>Clear</button>}
        <button type="button" className="btn primary sm" disabled={busy || !pick || pick === String(current || '')} onClick={() => save(pick)}>{busy ? 'Saving…' : 'Save colour'}</button>
      </div>
    </div>
  );
}

export function TitleEditor({ product, max = null, onSaved, onSignOut }) {
  const shop = cleanTitle(product.title || '');
  const [text, setText] = useState(product.title_override || shop);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const t = cleanTitle(text);
  const over = max && t.length > max;
  async function save(v) {
    setBusy(true); setErr('');
    try { await choose(product.shopify_product_id, { titleOverride: v }); onSaved?.(); } catch (e) { if (e.unauthorized) onSignOut?.(); else setErr(plain(e.message)); } finally { setBusy(false); }
  }
  return (
    <div className="shl-pub-panel" data-panel="title">
      <p className="xs shl-pub-lede">The name shoppers see on SHEIN. Shopify’s title is not changed.</p>
      <label className="form-modal-label">
        <input className="input" value={text} maxLength={1000} aria-label="SHEIN title" aria-invalid={!!over} onChange={(e) => setText(e.target.value)} />
        <i className={over ? 'shl-field-bad' : 'form-modal-hint'} data-count="">{fmt(t.length)}{max ? ` of ${fmt(max)}` : ''} characters{over ? ` — ${fmt(t.length - max)} too many for SHEIN` : max ? '' : ' (SHEIN’s limit is read with the preview)'}</i>
      </label>
      {err && <p className="error xs">{err}</p>}
      <div className="shl-pub-acts">
        {product.title_override && <button type="button" className="btn ghost sm" disabled={busy} onClick={() => save(null)}>Use the Shopify title</button>}
        <button type="button" className="btn primary sm" disabled={busy || t.length < 2 || !!over || t === (product.title_override || shop)} onClick={() => save(t === shop ? null : t)}>{busy ? 'Saving…' : 'Save SHEIN title'}</button>
      </div>
    </div>
  );
}

/* --------------------------------- D6 box --------------------------------- */
// Shown and typed in inches / pounds; saved as cm / g (boxFromImperial).
const BOX_FIELDS = [['length', 'Length', 'in'], ['width', 'Width', 'in'], ['height', 'Height', 'in'], ['weight', 'Weight', 'lb']];
export function BoxDefaults({ canWrite, onSaved, onSignOut, compact = false }) {
  const { d, err, reload } = useLoad(() => api.sheinPublishMaps('box'), [], onSignOut);
  useLive(['app_settings'], reload, { mount: false });
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saveErr, setSaveErr] = useState('');
  const box = d?.box;
  const saved = box ? boxToImperial(box.groups || BOX_PLACEHOLDERS) : null;
  useEffect(() => { if (box && !draft) setDraft(boxToImperial(box.groups || BOX_PLACEHOLDERS)); }, [box]); // eslint-disable-line react-hooks/exhaustive-deps
  const bad = draft ? validateImperialBox(draft) : null;
  async function save() {
    setBusy(true); setSaveErr('');
    try {
      await api.sheinPublishMapSave('box', { groups: boxFromImperial(draft) });
      setDraft(null); await reload(); onSaved?.();
    } catch (e) { if (e.unauthorized) onSignOut?.(); else setSaveErr(plain(e.message)); } finally { setBusy(false); }
  }
  if (err) return <p className="error xs">{err}</p>;
  if (!box || !draft) return <div className="shl-skel shl-skel-row" />;
  return (
    <div className="shl-pub-panel" data-panel="box" data-box={box.confirmed ? 'confirmed' : 'unconfirmed'}>
      {box.confirmed
        ? <p className="ebl-ok xs">Confirmed by {box.by || '—'} {when(box.at)}. Every new product is sent with its size group’s box.</p>
        : (
          <div className="shl-banner warn shl-box-banner" role="status">
            <b>{box.problem ? 'UNCONFIRMED — a saved box size looks wrong, publishing is blocked until someone fixes it' : 'UNCONFIRMED — placeholders, publishing is blocked until someone confirms'}</b>
            {box.problem && <span className="xs" data-box-problem="">{box.problem}</span>}
            {!box.problem && <span className="xs">SHEIN needs the box’s length × width × height and the weight on every size. These numbers are guesses nobody has measured; no product is published with them.{canWrite ? ' Check them against a real box, then confirm.' : ' An admin (or someone with Connect integrations) checks and confirms them.'}</span>}
          </div>
        )}
      <table className="shl-rtable shl-boxtable">
        <thead><tr><th>Size group</th>{BOX_FIELDS.map(([k, l, u]) => <th key={k} className="num">{l} ({u})</th>)}</tr></thead>
        <tbody>
          {Object.keys(BOX_PLACEHOLDERS).map((g) => (
            <tr key={g} data-group={g}>
              <td data-label="Size group"><b>{BOX_LABEL[g]}</b></td>
              {BOX_FIELDS.map(([k, l, u]) => (
                <td key={k} data-label={`${l} (${u})`} className="num">
                  <input className="input shl-box-in" inputMode="decimal" value={draft[g]?.[k] ?? ''} disabled={!canWrite || busy} aria-label={`${BOX_LABEL[g]} ${l} (${u})`}
                    onChange={(e) => setDraft((m) => ({ ...m, [g]: { ...m[g], [k]: e.target.value } }))} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {!compact && <p className="muted xs">Women’s shoes use the adult box. Length, width and height in inches, weight in pounds (up to 2 decimals) — the box with the shoes in it. SHEIN gets them in cm and grams; we convert when you save.</p>}
      {canWrite && bad && <p className="shl-field-bad">{bad}</p>}
      {saveErr && <p className="error xs" role="alert">{saveErr}</p>}
      <div className="shl-pub-acts">
        {canWrite && JSON.stringify(draft) !== JSON.stringify(saved) && <button type="button" className="btn ghost sm" disabled={busy} onClick={() => setDraft(saved)}>Undo</button>}
        <button type="button" className="btn primary sm" data-box-save="" disabled={!canWrite || busy || !!bad} title={canWrite ? 'Saving confirms them — publishing can use them from now on' : NEEDS_PRIV}
          onClick={save}>{busy ? 'Saving…' : box.confirmed ? 'Save box sizes' : 'Confirm these box sizes'}</button>
      </div>
      {!canWrite && <p className="muted xs">{NEEDS_PRIV} to save these.</p>}
    </div>
  );
}

/* ------------------------------- store gates ------------------------------- */
// What SHEIN said about taking new products, as last read (a preview reads it; admins can refresh).
export function useStoreGates(onSignOut) {
  const [g, setG] = useState(null);
  async function load() {
    try { setG(await api.sheinListingMeta({ gates: 1 })); } catch (e) { if (e.unauthorized) onSignOut?.(); }
  }
  useLive(['shein_listing_jobs'], load);
  return { gates: g?.gates || null, readAt: g?.readAt || null, reload: load };
}
export function gateProblems(gates) {
  const out = [];
  if (!gates) return out;
  if (gates.perm && gates.perm.canPublishProduct === false) out.push({ key: 'store', text: `SHEIN won’t take new listings: ${gates.perm.reason || 'no reason given'}.` });
  if (gates.quota && gates.quota.isControlled === true && !(Number(gates.quota.availableQuota) > 0)) out.push({ key: 'quota', text: `This month’s SHEIN new-product limit is used up (0 left${gates.quota.totalQuota != null ? ` of ${fmt(gates.quota.totalQuota)}` : ''}).` });
  if (gates.shelf && gates.shelf.need === true && !(Number(gates.shelf.remain_count) > 0)) out.push({ key: 'shelf', text: 'SHEIN’s shelf limit for the store is reached.' });
  return out;
}
export function StoreGateBanner({ gates, readAt }) {
  const probs = gateProblems(gates);
  if (!probs.length) return null;
  return (
    <div className="shl-banner warn" role="status" data-gates="closed">
      <b>SHEIN isn’t taking new products right now</b>
      <span className="sm">{probs.map((p) => <span key={p.key} className="shl-block">{p.text}</span>)}</span>
      <span className="muted xs">Publishing new products is off for everyone until SHEIN opens it again (sort it out in <a className="ebl-link" href={SELLER_CENTER} target="_blank" rel="noreferrer">Seller Center ↗</a>). Previews still work — they show what would be sent. Adding sizes and price updates are not affected.{readAt ? ` As read ${when(readAt)}.` : ''}</span>
    </div>
  );
}

/* ------------------------------- the checklist ------------------------------- */
// The fixes a checklist line opens inline (the rest use the blocker's own button).
const PANEL = { category: 'Choose category', brand: 'Map to a SHEIN brand', title: 'Review title', colour: 'Pick the colour', attributes: 'Set SHEIN details', box: 'Confirm box sizes', photos: 'Choose photos' };
const PANEL_OK = { category: 'Change', brand: 'Change', title: 'Edit SHEIN title', attributes: 'Edit details', photos: 'Choose photos' };
const STORE_KEYS = new Set(['store', 'quota', 'shelf', 'site']);

export function PublishChecklist({ d, canWrite, busy, onFix, onReload, onSignOut, onAct }) {
  const p = d.product;
  const list = d.checklist || [];
  const from = d.checklistFrom || {};
  const groups = productGroups(d.variants || []);
  const group = groups.length === 1 ? groups[0] : null;
  const maps = useLoad(() => api.sheinPublishMaps('category'), [], onSignOut);
  useLive(['shein_category_map', 'shein_brand_map'], maps.reload, { mount: false });
  const typeCat = (maps.d?.maps || []).find((m) => m.shopify_product_type === String(p.product_type || '') && m.size_group === group) || null;
  // the shoe's own category (picked while fixing it) wins over its type's map — 2026-11-11
  const cat = p.category_pick_id ? { category_id: p.category_pick_id, product_type_id: p.category_pick_ptid, category_path: p.category_pick_path, shoe: true } : typeCat;
  const [typeWide, setTypeWide] = useState(false);
  const [open, setOpen] = useState('');
  const [fixed, setFixed] = useState(() => new Set());   // lines saved in this session: re-checked by the next preview
  const [msg, setMsg] = useState('');
  const done = (key, text) => { setFixed((s) => new Set([...s, key])); setOpen(''); setMsg(text); maps.reload(); onReload?.(); };
  const n = { ok: list.filter((l) => l.ok === true).length, no: list.filter((l) => l.ok === false).length, unread: list.filter((l) => l.ok === null).length };
  const line = (k) => list.find((l) => l.key === k);
  const titleMax = (line('title')?.blockers || []).find((b) => b.params?.max)?.params?.max || null;
  const focus = (line('attributes')?.blockers || []).map((b) => b.params?.attributeId).filter(Boolean);

  const panelFor = (key) => {
    const close = () => setOpen('');
    if (key === 'category') return <CategoryPicker productType={p.product_type || ''} sizeGroup={group} productId={p.shopify_product_id} current={cat?.category_id} canWrite={canWrite} onSignOut={onSignOut}
      perShoe shoePick={p.category_pick_id || null}
      onCancel={close} onSaved={(m) => done('category', m?.cleared ? `This shoe uses its type’s category again${typeCat ? ` (${typeCat.category_path || typeCat.category_id})` : ''} — re-checked by the next preview.`
        : m?.shoe ? `Saved for this shoe only: ${m.category_path || 'that category'}. Check its SHEIN details next — they depend on the category.`
          : `Saved: every “${p.product_type || '(no type)'}” shoe in ${GROUP_LABEL[group]} goes to ${m?.category_path || 'that category'} — re-checked by the next preview.`)} />;
    if (key === 'brand') return <BrandPicker vendor={p.vendor} canWrite={canWrite} onSignOut={onSignOut} onCancel={close} onSaved={(m) => done('brand', m ? `Saved: ${p.vendor} → SHEIN brand ${m.brand_name || m.brand_code}.` : 'Brand cleared.')} />;
    if (key === 'title') return <TitleEditor product={p} max={titleMax} onSignOut={onSignOut} onSaved={() => done('title', 'SHEIN title saved (Shopify unchanged).')} />;
    if (!cat && ['colour', 'attributes'].includes(key)) return <p className="notice xs">Choose the SHEIN category first — the colours and details SHEIN asks for depend on it.</p>;
    if (key === 'colour') return <ColourPicker productId={p.shopify_product_id} productTypeId={Number(cat.product_type_id)} current={p.skc_value_id} onSignOut={onSignOut} onSaved={() => done('colour', 'Colour saved.')} />;
    if (key === 'attributes') return (
      <>
        <ShoeAttrEditor product={p} productTypeId={Number(cat.product_type_id)} categoryId={Number(cat.category_id)} canWrite={canWrite} focus={focus} onSignOut={onSignOut}
          onSaved={(t) => { setFixed((s) => new Set([...s, 'attributes'])); setMsg(`${t} Re-checked by the next preview.`); onReload?.(); }} />
        <p className="xs shl-pub-type-wide">
          <button type="button" className="shl-linkbtn" aria-expanded={typeWide} onClick={() => setTypeWide(!typeWide)}>{typeWide ? 'Hide' : 'Set a detail for every shoe of this SHEIN type instead (Setup)'}</button>
        </p>
        {typeWide && <AttrEditor productTypeId={Number(cat.product_type_id)} categoryId={Number(cat.category_id)} canWrite={canWrite} focus={focus} onSignOut={onSignOut} onSaved={() => setFixed((s) => new Set([...s, 'attributes']))} />}
      </>
    );
    if (key === 'box') return <BoxDefaults compact canWrite={canWrite} onSignOut={onSignOut} onSaved={() => done('box', 'Box sizes confirmed for every new product.')} />;
    if (key === 'photos') return <SheinPhotoPicker productId={p.shopify_product_id} onSignOut={onSignOut} onSaved={() => { setFixed((s) => new Set([...s, 'photos'])); onReload?.(); }} />;
    return null;
  };

  return (
    <section className="shl-d-sec" data-checklist="">
      <h4 className="shl-h4">What publishing needs</h4>
      <div className="shl-chiprow shl-pub-sum" data-sum="">
        <span className="ebo-chip ok">{fmt(n.ok)} ✓</span>
        <span className={`ebo-chip ${n.no ? 'bad' : ''}`.trim()}>{fmt(n.no)} to fix</span>
        {n.unread > 0 && <span className="ebo-chip">{fmt(n.unread)} not read yet</span>}
      </div>
      <p className="muted xs shl-pub-from">{from.jobId ? <>As checked by preview #{from.jobId}, {when(from.at)}. Fixed something? Preview again to re-check.</> : <>From our records. SHEIN’s store checks, photos and SKUs are read by the preview (“Publish new product” below — it sends nothing).</>}</p>
      {msg && <p className="ebl-ok xs" role="status">{msg}</p>}
      {list.map((l, idx) => {
        const hard = (l.blockers || []).filter((b) => !['note', 'review'].includes(b.level));
        const notes = (l.blockers || []).filter((b) => ['note', 'review'].includes(b.level));
        const saved = fixed.has(l.key) && l.ok !== true;
        const icon = saved ? ['shl-wait', '…', 'Saved — checked again by the next preview'] : l.ok === true ? ['shl-yes', '✓', 'OK'] : l.ok === false ? ['shl-no', '✕', 'Not OK'] : ['shl-wait', '–', 'Not read yet'];
        const panelLabel = l.ok !== true ? PANEL[l.key] : PANEL_OK[l.key];   // a line not read yet (null) can be fixed too
        const canPanel = !!panelLabel && !(l.key === 'category' && !group);
        const first = hard.find((b) => b.action && !['choose_category', 'set_attr', 'review_title', 'set_defaults', 'use_ph_photos', 'publish_again'].includes(b.action.kind));
        return (
          <React.Fragment key={l.key}>
          {(idx === 0 || (STORE_KEYS.has(list[idx - 1].key) && !STORE_KEYS.has(l.key))) && <p className="shl-pub-group xs">{STORE_KEYS.has(l.key) ? 'The store — SHEIN, for every product' : 'This product'}</p>}
          <div className="shl-req shl-pub-line" data-line={l.key} data-ok={l.ok === true ? 'yes' : l.ok === false ? 'no' : 'unread'}>
            <span className={icon[0]} aria-label={icon[2]} title={icon[2]}>{icon[1]}</span>
            <span>
              <span className="shl-pub-label">{l.n}. {l.label}</span>
              {l.ok === true && <OkDetail k={l.key} p={p} cat={cat} />}
              {l.key === 'attributes' && l.model?.value && <span className="muted xs shl-block" data-model-from={l.model.from}>Product Model “{l.model.value}” · {l.model.from === 'title' ? 'from the title' : 'typed for this shoe'}</span>}
              {l.ok === null && !saved && <span className="muted xs shl-block">Not read yet — the preview checks it.</span>}
              {saved && <span className="xs shl-block shl-pub-saved">Saved — checked again by the next preview.</span>}
              {hard.map((b, i) => <span key={i} className="xs shl-block"><BlockerSay b={b} /></span>)}
              {notes.map((b, i) => <span key={`n${i}`} className="muted xs shl-block"><BlockerSay b={b} compact={!b.fix} /></span>)}
              {l.key === 'category' && !group && (groups.length > 1 ? <span className="xs shl-block shl-bad-text">Mixed size groups ({groups.map((g) => GROUP_LABEL[g]).join(', ')}) — split the product on Shopify first.</span> : <span className="xs shl-block muted">No US size we can read, so no size group.</span>)}
              {l.key === 'photos' && <span className="muted xs shl-block" data-photo-source="">{photoSourceSay(p)} Change it in {PANEL.photos}.</span>}
              {l.key === 'photos' && l.ok !== true && p.photo_skip?.length > 0 && <span className="muted xs shl-block" data-skip-count="">{fmt(p.photo_skip.length)} photo{p.photo_skip.length === 1 ? '' : 's'} left out — SHEIN won’t get {p.photo_skip.length === 1 ? 'it' : 'them'}.</span>}
            </span>
            <span className="shl-pub-btns">
              {canPanel && <button type="button" className={`btn xs ${l.ok === false ? 'shl-fix' : 'ghost'}`} aria-expanded={open === l.key} onClick={() => setOpen(open === l.key ? '' : l.key)}>{open === l.key ? 'Close' : panelLabel}</button>}
              {l.key === 'flight' && hard.some((b) => b.code === 'publish_rejected') && (
                <button type="button" className="btn xs shl-fix" disabled={!canWrite || !!busy} title={canWrite ? 'Lets the next publish go to SHEIN again (SHEIN may still count the old SKUs)' : NEEDS_PRIV}
                  onClick={async () => { if (await onAct?.('publish_again', { productIds: [p.shopify_product_id] }, 'Publish again allowed — preview it, check it, then publish.')) done('flight', 'Publish again allowed — preview it, check it, then publish.'); }}>Publish again</button>
              )}
              {first && <FixButton action={first.action} shopifyUrl={p.shopifyUrl} busy={busy} onAct={(k) => onFix?.(k, (d.variants || []).find((v) => (v.blockers || []).some((b) => b.code === first.code)) || {}, first)} />}
            </span>
            {open === l.key && <div className="shl-req-fix">{panelFor(l.key)}</div>}
          </div>
          </React.Fragment>
        );
      })}
    </section>
  );
}
// Which photos SHEIN gets (2026-11-14): the clean photos (cutouts on white) when the style has them, unless switched off
const photoSourceSay = (p) => (p.clean_photos !== false && Number(p.clean_count) > 0 ? `SHEIN gets the ${p.clean_count} clean photo${Number(p.clean_count) === 1 ? '' : 's'} (the shoe on white, no text).`
  : p.use_ph_photos ? 'SHEIN gets the PH edited photos (branded; never the spec / welcome slides).' : 'SHEIN gets Shopify’s photos.');
function OkDetail({ k, p, cat }) {
  let t = null;
  if (k === 'category' && cat) t = `${cat.category_path || `SHEIN category ${cat.category_id}`}${cat.shoe ? ' · this shoe only' : ''}`;
  if (k === 'attributes') { const n = Object.values(p.attr_overrides || {}).filter((o) => o && Number(o.ptid) === Number(cat?.product_type_id)).length; if (n) t = `${n} detail${n === 1 ? '' : 's'} set for this shoe`; }
  if (k === 'title' && p.title_override) t = `SHEIN title: “${p.title_override}”`;
  if (k === 'photos') t = p.photo_skip?.length ? `${p.photo_skip.length} photo${p.photo_skip.length === 1 ? '' : 's'} left out` : null;   // which set: the line's own data-photo-source
  return t ? <span className="muted xs shl-block">{t}</span> : null;
}
