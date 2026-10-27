// SHEIN Listings → Products tab: one row per product (photo, name, style code, Shopify ↔ SHEIN
// ids, rolled-up status, "8 of 11 sizes on SHEIN", the worst blocker), expanding to one row per
// size (Shopify stock / price, SHEIN size, seller SKU, SHEIN stock / price, status, what to do).
// Ticked products are in memory only — never restored from the URL.
import React, { useEffect, useState } from 'react';
import { CopyText, Pager, RemoteThumb } from '../components/common.jsx';
import { api } from '../api.js';
import { useLive } from '../hooks.js';
import { STATUSES, STATUS_ORDER } from '../lib/sheinListings.js';
import { PH_DATE } from '../lib/format.js';
import { fmt, money, StatusChip, BlockerSay, FixButton, TONE, NEXT_PHASE, CustomSizeModal, PUBLISH_FIX_KINDS } from '../components/SheinListingsBits.jsx';

const EMPTY = {
  '': 'No products match these filters.',
  blocked: 'Nothing is blocked.', error: 'SHEIN hasn’t refused anything.', out_of_date: 'Nothing needs an update — every listed size matches Shopify.',
  not_on_shein: 'Every in-stock size is on SHEIN (or blocked).', in_review: 'Nothing is waiting on a SHEIN review.', synced: 'No product is fully in step yet.',
  shein_only: 'Every SHEIN size is in Shopify.', excluded: 'Nothing is marked “Not listing”.', unknown: 'Every product has been checked.',
};

// The two dry runs a person can start (they never mix: one partialEdit per product at a time).
export const UPDATE_OPS = ['price', 'edit'];
// A shoe on SHEIN with an in-stock size SHEIN doesn't have → "Add missing sizes".
export const canAdd = (p) => !!p?.spu && Number(p.counts?.sizes || 0) > Number(p.counts?.on_shein || 0);
// A product with a size that needs an update (price, turned off, wrong SKU) → "Update prices & sizes".
export const needsUpdate = (p) => p?.status === 'out_of_date' || Number(p?.counts?.by?.out_of_date || 0) > 0;
// A Shopify shoe not on SHEIN at all → "Publish new products" (Phase 4).
export const canPublish = (p) => !!p && !p.spu && !p.excluded && !String(p.shopify_product_id).startsWith('shein:');

// The one-liner under a product's name when nothing is blocking it.
function healthLine(p) {
  const c = p.counts || {};
  const missing = Math.max(0, (c.sizes || 0) - (c.on_shein || 0));
  switch (p.status) {
    case 'synced': return ['ok', 'Every in-stock size is on SHEIN and matches Shopify.'];
    case 'not_on_shein': return ['muted', p.spu ? `${fmt(missing)} in-stock size${missing === 1 ? ' isn’t' : 's aren’t'} on SHEIN yet. Nothing is wrong — tick it and Dry run to add them.` : 'Not on SHEIN yet. Tick it → “Publish new products” to dry run it (Details shows what publishing needs).'];
    case 'out_of_date': { const n = c.by?.out_of_date || 0; return ['info', `${n ? `${fmt(n)} size${n === 1 ? '' : 's'} on SHEIN need${n === 1 ? 's' : ''}` : 'On SHEIN, but it needs'} an update (price, a size turned off, or a wrong SKU). Tick it → “Update prices & sizes” to dry run the fix.`]; }
    case 'in_review': return ['violet', 'SHEIN is reviewing an earlier edit. Nothing to do.'];
    case 'shein_only': return ['warn', 'Not in Shopify — Shopify has none of these seller SKUs. The live fix holds them at 0.'];
    case 'excluded': return ['muted', p.excluded ? `Not listing — ${p.excluded_by || 'a person'} chose not to list it on SHEIN${p.excluded_at ? ` (${PH_DATE.format(new Date(p.excluded_at))} EST)` : ''}.` : 'Not listing — draft on Shopify.'];
    default: return ['muted', 'Not checked yet.'];
  }
}

function Coverage({ p }) {
  const c = p.counts || {};
  const by = c.by || {};
  const total = Object.values(by).reduce((n, x) => n + Number(x || 0), 0);
  const label = c.sizes ? <><b>{fmt(c.on_shein)} of {fmt(c.sizes)}</b> <span className="muted xs">sizes on SHEIN</span></>
    : c.shein_only && !c.all ? <><b>{fmt(c.shein_only)}</b> <span className="muted xs">SHEIN sizes not in Shopify</span></>
      : <span className="muted xs">No size in stock on Shopify</span>;
  return (
    <span className="shl-cover">
      {label}
      {total > 0 && (
        <span className="shl-cover-bar" aria-hidden="true">
          {STATUS_ORDER.slice().reverse().filter((st) => by[st]).map((st) => <i key={st} className={`shl-seg ${TONE[st]}`} style={{ width: `${(100 * by[st]) / total}%` }} />)}
        </span>
      )}
    </span>
  );
}

// One diff of a Needs update size, as a person reads it: what SHEIN has → what it will be.
// Exported for the drawer. A SHEIN price going UP may start SHEIN's price review (In review).
export const isRise = (x) => x?.field === 'shein_price' && Number(x.to) > Number(x.from);
export function diffText(x) {
  if (x.field === 'shein_price') {
    return <>SHEIN <span className="shl-was">{money(x.from)}</span> → <b>{money(x.to)}</b>
      {isRise(x) && <span className="shl-rise"> ↑ SHEIN may review it</span>}
      {x.why && <span className="muted xs"> · {x.why}</span>}</>;
  }
  if (x.field === 'price' || x.field === 'compareAt') return <>Shopify {x.field === 'price' ? 'price' : 'compare-at'} changed: <span className="shl-was">{money(x.from)}</span> → <b>{money(x.to)}</b></>;
  if (x.field === 'seller_sku') return <>SHEIN has the wrong SKU: <span className="shl-was">{x.from || '—'}</span> → will change to <b>{x.to}</b></>;
  if (x.field === 'mall_state') return <>Turned off on SHEIN — will turn back on <span className="muted xs">(Shopify sells it)</span></>;
  if (x.field === 'listing') return <>Changed on Shopify since the last sync.</>;
  return <>{x.field} <span className="shl-was">{x.from ?? '—'}</span> → <b>{x.to ?? '—'}</b></>;
}

// One size. `onFix(kind, v, blocker)` handles the live kinds (custom size, leave off, include).
function VariantRow({ v, shopifyUrl, onFix, busy, onUpdate }) {
  const b = v.blockers?.[0] || null;
  const zero = v.shopify_variant_id && !(Number(v.shopify_qty) > 0);
  const tone = TONE[v.status];
  const plan = v.size_plan;
  const notes = (v.notes || []).filter((n) => n.code !== 'excluded_by_person' || v.status === 'excluded');
  const sheinSize = v.shein_size || (plan?.label ? <>{plan.label} <span className="muted xs">({plan.kind === 'custom' ? 'custom size, new' : 'SHEIN size'})</span></> : <span className="muted">— none —</span>);
  const priceDiff = (v.diffs || []).find((x) => x.field === 'price');
  const sheinDiff = (v.diffs || []).find((x) => x.field === 'shein_price');
  const offDiff = (v.diffs || []).some((x) => x.field === 'mall_state');
  return (
    <tr className={`st-${tone}${zero ? ' zero' : ''}`} data-row={v.row_key}>
      <td className="c-size"><b>{v.shopify_size || v.shein_size || '—'}</b></td>
      <td className={`c-shop num${v.shopify_variant_id ? '' : ' shl-noshop'}`}>{v.shopify_variant_id ? fmt(v.shopify_qty) : <span className="muted">not on Shopify</span>}</td>
      <td className="c-hide num">{priceDiff ? <b>{money(v.shopify_price)}</b> : money(v.shopify_price)}</td>
      <td className="c-hide">{sheinSize}</td>
      <td className="c-hide"><CopyText className="shl-mono" text={v.seller_sku || v.shein_seller_sku || ''}>{v.seller_sku || v.shein_seller_sku || '—'}</CopyText></td>
      <td className="c-hide num">{v.shein_sku ? <>{offDiff ? <span className="shl-was" title="Turned off on SHEIN">off</span> : v.shein_qty == null ? '—' : fmt(v.shein_qty)} · {sheinDiff ? <><span className="shl-was">{money(sheinDiff.from)}</span> → <b>{money(sheinDiff.to)}</b></> : priceDiff ? <span className="shl-was">{money(v.shein_price)}</span> : money(v.shein_price)}</> : <span className="muted">not listed</span>}</td>
      <td className="c-status"><StatusChip status={v.status} /></td>
      <td className="c-todo">
        {b ? (
          <div className="shl-todo">
            <BlockerSay b={b} />
            <FixButton action={b.action} shopifyUrl={shopifyUrl} busy={busy} onAct={(k) => onFix(k, v, b)} />
            {v.blockers.length > 1 && <span className="muted xs">+ {v.blockers.length - 1} more: {v.blockers.slice(1).map((x) => x.title).join(' ')}</span>}
          </div>
        ) : v.diffs?.length ? (
          <div className="shl-todo"><span className="shl-say">{v.diffs.map((x, i) => <span key={i} className="shl-diff">{diffText(x)}</span>)}</span>
            {onUpdate
              ? <button type="button" className="btn xs shl-fix" disabled={!!busy || onUpdate === 'busy'} title={onUpdate === 'busy' ? 'A job is running — dry run when it finishes' : 'Dry run “Update prices & sizes” for this product — shows exactly what would be sent. Nothing is sent.'}
                onClick={(e) => { e.stopPropagation(); if (typeof onUpdate === 'function') onUpdate(); }}>Dry run the update</button>
              : <button type="button" className="btn xs shl-fix" disabled title={NEXT_PHASE}>Dry run the update</button>}</div>
        ) : null}
        {notes.map((n, i) => (
          <div key={i} className="shl-note"><BlockerSay b={n} compact={!n.fix} />{n.action && <FixButton action={n.action} shopifyUrl={shopifyUrl} busy={busy} onAct={(k) => onFix(k, v, n)} />}</div>
        ))}
        {!b && !v.diffs?.length && !notes.length && (v.status === 'not_on_shein'
          ? <span className="muted xs">Ready — tick the product and Dry run to add it.</span>
          : v.status === 'shein_only' ? <span className="muted xs">Shopify has no SKU {v.shein_seller_sku || '(blank)'}. The live fix holds this SHEIN size at 0 — change the SKU on Match sizes if it’s a typo.</span>
            : zero ? <span className="muted xs">Out of stock on Shopify — listed at 0, not counted.</span> : null)}
        {v.shopify_variant_id && !v.excluded && v.status !== 'excluded' && (
          <details className="shl-more" onClick={(e) => e.stopPropagation()}>
            <summary>More ▾</summary>
            <div className="shl-more-pop">
              <button type="button" className="btn xs ghost" disabled={!!busy} onClick={() => onFix('leave_off', v)}>Don’t list this size on SHEIN</button>
            </div>
          </details>
        )}
      </td>
    </tr>
  );
}

export function VariantTable({ variants, shopifyUrl, onFix, busy, onUpdate }) {
  if (!variants.length) return <p className="muted xs shl-pad">No sizes.</p>;
  return (
    <table className="shl-vtable">
      <thead><tr><th>Size</th><th className="num">Shopify</th><th className="num">Price</th><th>SHEIN size</th><th>Seller SKU</th><th className="num">SHEIN stock · price</th><th>Status</th><th>What to do</th></tr></thead>
      <tbody>{variants.map((v) => <VariantRow key={v.row_key} v={v} shopifyUrl={shopifyUrl} onFix={onFix} busy={busy} onUpdate={onUpdate} />)}</tbody>
    </table>
  );
}

// The live fix kinds, shared by the product rows and the drawer.
export function useFixes({ onAct, onSignOut, reload, onOpen }) {
  const [custom, setCustom] = useState(null);   // { size, categoryId, suggestion }
  async function onFix(kind, v, b) {
    if (PUBLISH_FIX_KINDS.includes(kind)) { onOpen?.(); return; }   // the fix is in the drawer's publishing checklist
    if (kind === 'add_custom_size' || kind === 'edit_size_map') {
      setCustom({ size: v.shopify_size, categoryId: b?.params?.categoryId ?? 0, suggestion: b?.params?.suggestion || b?.params?.text || '' });
      return;
    }
    if (kind === 'leave_off') { if (await onAct('exclude', { variantKeys: [v.row_key] }, `Size ${v.shopify_size}: Don’t list on SHEIN (our records only).`)) reload?.(); return; }
    if (kind === 'include') { if (await onAct('include', { variantKeys: [v.row_key] }, `Size ${v.shopify_size}: listed on SHEIN again.`)) reload?.(); }
  }
  const modal = custom && (
    <CustomSizeModal {...custom} onSignOut={onSignOut} onClose={() => setCustom(null)}
      onSaved={() => { setCustom(null); reload?.(); }} />
  );
  return { onFix, modal };
}

function ProductRow({ p, open, onToggle, picked, onPick, onOpen, onAct, busy, onSignOut, inJob, onUpdate }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  async function loadVariants() {
    try { const r = await api.sheinListingProduct(p.shopify_product_id); setRows(r.variants || []); setErr(''); }
    catch (e) { if (e.unauthorized) onSignOut(); else setErr(e.message); }
  }
  useEffect(() => { if (open && !rows) loadVariants(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useLive(open ? ['shein_listing_variants', 'shein_size_map'] : [], loadVariants, { mount: false, every: open ? 60_000 : 0 });
  const { onFix, modal } = useFixes({ onAct, onSignOut, reload: loadVariants, onOpen: () => onOpen(p.shopify_product_id) });

  const tone = TONE[p.status];
  const w = p.worst && !['note'].includes(p.worst.level) ? p.worst : null;
  const [ht, hl] = healthLine(p);
  const nSizes = (p.counts?.all || 0) + (p.counts?.shein_only || 0);
  const isSheinOnly = String(p.shopify_product_id).startsWith('shein:');
  return (
    <div className={`shl-product e-${tone}${picked ? ' sel' : ''}${open ? ' open' : ''}`} data-product={p.shopify_product_id}>
      <div className="shl-phead" onClick={onToggle}>
        <span className="shl-chk" onClick={(e) => e.stopPropagation()}>
          <input type="checkbox" checked={picked && !inJob} disabled={isSheinOnly || !!inJob} aria-label={`Select ${p.title || 'product'}`}
            title={isSheinOnly ? 'Not a Shopify product' : inJob ? `In job #${inJob} (running) — pick it again when it finishes` : undefined} onChange={(e) => onPick(e.target.checked)} />
        </span>
        <RemoteThumb src={p.image_url} className="ebl-thumb shl-thumb" />
        <span className="shl-main">
          <span className="shl-pname">{p.title || '(no title)'}</span>
          <span className="shl-pmeta" onClick={(e) => e.stopPropagation()}>
            {p.style && <CopyText className="shl-mono" text={p.style}>{p.style}</CopyText>}
            {p.vendor && <span>{p.vendor}</span>}
            {p.shopifyUrl && <a className="ebl-link" href={p.shopifyUrl} target="_blank" rel="noreferrer">Shopify ↗</a>}
            {p.spu ? <span>SHEIN SPU <CopyText className="shl-mono" text={p.spu}>{p.spu}</CopyText>{p.spu_count > 1 ? ` (+${p.spu_count - 1})` : ''}</span> : <span>not on SHEIN yet</span>}
          </span>
          {w ? (
            <span className={`shl-pline ${w.level === 'error' ? 'warn' : 'bad'}`}>
              {w.sizes > 1 ? `${fmt(w.sizes)} sizes: ` : ''}<b>{w.title}</b> {w.fix}
            </span>
          ) : <span className={`shl-pline ${ht}`}>{hl}</span>}
        </span>
        <span className="shl-rollup"><StatusChip status={p.status} />
          {p.status !== 'in_review' && (p.counts?.by?.in_review || 0) > 0 && <span className="ebo-chip violet shl-inrev" title={STATUSES.in_review.meaning}>{fmt(p.counts.by.in_review)} in review</span>}
          {p.status !== 'out_of_date' && (p.counts?.by?.out_of_date || 0) > 0 && <span className="ebo-chip info shl-inrev" data-needs-update="" title="These sizes are on SHEIN but differ (price, turned off, wrong SKU) — tick the product → Update prices & sizes">{fmt(p.counts.by.out_of_date)} need{p.counts.by.out_of_date === 1 ? 's' : ''} an update</span>}
          {inJob > 0 && <span className="ebo-chip info" title="A dry run or a send is working on this product right now">In job #{inJob}</span>}</span>
        <Coverage p={p} />
        <span className="shl-pact" onClick={(e) => e.stopPropagation()}>
          <button type="button" className="btn xs" onClick={() => onOpen(p.shopify_product_id)}>Details</button>
          <button type="button" className="shl-caret" aria-expanded={open} onClick={onToggle}>{open ? '▾' : '▸'} {fmt(nSizes)} size{nSizes === 1 ? '' : 's'}</button>
        </span>
      </div>
      {open && (
        <div className="shl-vwrap">
          {err && <p className="error sm shl-pad">{err}</p>}
          {!rows && !err && <div className="shl-pad"><div className="shl-skel shl-skel-row" /></div>}
          {rows && <VariantTable variants={rows} shopifyUrl={p.shopifyUrl} onFix={onFix} busy={busy} onUpdate={onUpdate} />}
          {rows && (
            <div className="shl-vfoot">
              <span className="muted xs">{p.category_id ? `SHEIN category ${p.category_id}` : 'No SHEIN category yet'}{p.review_reason ? ` · SHEIN: ${p.review_reason}` : ''}</span>
              <button type="button" className="btn xs" onClick={() => onOpen(p.shopify_product_id)}>What SHEIN will receive →</button>
            </div>
          )}
        </div>
      )}
      {modal}
    </div>
  );
}

// The products a running dry run / send is working on: their ticks are disabled.
function useInJob(active, onSignOut) {
  const [ids, setIds] = useState(() => new Map());
  const id = ['preview', 'run'].includes(active?.kind) ? active.id : 0;
  useEffect(() => {
    if (!id) { setIds(new Map()); return undefined; }
    let live = true;
    api.sheinListingJob(id).then((r) => { if (live) setIds(new Map((r.items || []).map((i) => [i.shopify_product_id, id]))); })
      .catch((e) => { if (e.unauthorized) onSignOut(); });
    return () => { live = false; };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  return ids;
}

export function SheinListingsProducts({ setStatusAll, d, status, q, setQ, brand, setBrand, blocker, setBlocker, page, setPage, pageSize, onOpen, onAct, busy, onSignOut, active, onDryRun }) {
  const [text, setText] = useState(q);
  const [open, setOpen] = useState(() => new Set());
  const [picked, setPicked] = useState(() => new Set());   // in memory only — ticks are never restored
  useEffect(() => { setText(q); }, [q]);
  useEffect(() => {
    if (text === q) return undefined;
    const t = setTimeout(() => setQ(text.trim()), 350);
    return () => clearTimeout(t);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps

  const s = d.summary;
  const products = d.products || [];
  const inJob = useInJob(active, onSignOut);
  const toggle = (id) => setOpen((o) => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const pick = (id, on) => setPicked((o) => { const n = new Set(o); if (on) n.add(id); else n.delete(id); return n; });
  const pageIds = products.filter((p) => !String(p.shopify_product_id).startsWith('shein:')).map((p) => p.shopify_product_id);
  const allPicked = pageIds.length > 0 && pageIds.every((id) => picked.has(id));
  const pickedRows = products.filter((p) => picked.has(p.shopify_product_id));
  const pickedSizes = pickedRows.reduce((n, p) => n + (p.counts?.sizes || 0), 0);
  const pickedBlocked = pickedRows.filter((p) => p.status === 'blocked').length;
  const pickedOff = pickedRows.filter((p) => !p.spu).length;
  const pickedAdd = pickedRows.filter(canAdd).length;
  const pickedUpd = pickedRows.filter(needsUpdate).length;
  const pickedNew = pickedRows.filter(canPublish).length;
  const lead = Math.max(pickedAdd, pickedUpd, pickedNew);
  const primary = (n, first) => (n && n === lead && first ? 'primary' : 'ghost');
  const running = active ? `Job #${active.id} is running — dry run when it finishes` : '';
  const addTitle = running || (pickedAdd ? `Dry run: the in-stock sizes SHEIN doesn’t have yet, added to ${fmt(pickedAdd)} shoe${pickedAdd === 1 ? '' : 's'} already on SHEIN. Nothing is sent.` : 'None of the ticked shoes is on SHEIN with a size missing');
  const updTitle = running || (pickedUpd ? `Dry run: SHEIN prices, sizes turned off on SHEIN and wrong SKUs, for ${fmt(pickedUpd)} product${pickedUpd === 1 ? '' : 's'} that need an update. Nothing is sent.` : 'None of the ticked products needs an update');
  const pubTitle = running || (pickedNew ? `Dry run: what SHEIN would receive for ${fmt(pickedNew)} shoe${pickedNew === 1 ? '' : 's'} not on SHEIN yet — category, brand, photos, sizes, prices. Each one that can’t go yet says why. Nothing is sent.` : 'None of the ticked shoes is new to SHEIN');
  const first = d.total ? (page - 1) * pageSize + 1 : 0;
  const last = Math.min(d.total, page * pageSize);

  return (
    <div className="card">
      <div className="ebl-filters shl-filters">
        <input type="search" className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Search name, style code, seller SKU, SHEIN SKU, SPU…" aria-label="Search products" />
        <select className="input shl-select" value={brand} onChange={(e) => setBrand(e.target.value)} aria-label="Brand">
          <option value="">All brands</option>
          {(s.brands || []).map((b) => <option key={b.brand} value={b.brand}>{b.brand} ({fmt(b.products)})</option>)}
          {brand && !(s.brands || []).some((b) => b.brand === brand) && <option value={brand}>{brand}</option>}
        </select>
        <select className="input shl-select" value={blocker} onChange={(e) => setBlocker(e.target.value)} aria-label="Blocker">
          <option value="">Any reason</option>
          {(s.topBlockers || []).map((b) => <option key={b.code} value={b.code}>{b.title.replace(/\.$/, '')} ({fmt(b.products)})</option>)}
          {blocker && !(s.topBlockers || []).some((b) => b.code === blocker) && <option value={blocker}>{blocker}</option>}
        </select>
      </div>
      <div className="shl-listhead">
        <span className="muted xs">{d.total ? `${fmt(first)}–${fmt(last)} of ${fmt(d.total)} products` : '0 products'}{status ? ` · ${STATUSES[status]?.label || status}` : ''} · worst first · tap a product for its sizes</span>
        {pageIds.length > 0 && (
          <label className="shl-pickall"><input type="checkbox" checked={allPicked} onChange={(e) => setPicked((o) => { const n = new Set(o); for (const id of pageIds) { if (e.target.checked) n.add(id); else n.delete(id); } return n; })} /> Select all on this page</label>
        )}
      </div>
      {!products.length && (
        <div className="empty-state">
          {!q && !brand && !blocker && status === 'out_of_date' && (s.byStatus?.out_of_date?.sizes || 0) > 0 ? (
            <>No product needs <i>only</i> an update — but <b>{fmt(s.byStatus.out_of_date.sizes)} size{s.byStatus.out_of_date.sizes === 1 ? '' : 's'}</b> need{s.byStatus.out_of_date.sizes === 1 ? 's' : ''} one inside products that are also blocked (a product shows its worst status). They carry a blue “need an update” chip.
              <div className="mt"><button type="button" className="btn ghost sm" onClick={() => setStatusAll?.()}>Show all products</button></div></>
          ) : (q || brand || blocker) ? <>No products match{q ? <> “<b>{q}</b>”</> : ''}{brand ? ` in ${brand}` : ''}{blocker ? ' with that reason' : ''}{status ? ` among ${STATUSES[status]?.label || status}` : ''}.</> : EMPTY[status] || EMPTY['']}
          {(q || brand || blocker) && <div className="mt"><button type="button" className="btn ghost sm" onClick={() => { setText(''); setQ(''); setBrand(''); setBlocker(''); }}>Clear search and filters</button></div>}
        </div>
      )}
      {products.map((p) => (
        <ProductRow key={p.shopify_product_id} p={p} open={open.has(p.shopify_product_id)} onToggle={() => toggle(p.shopify_product_id)}
          picked={picked.has(p.shopify_product_id)} onPick={(on) => pick(p.shopify_product_id, on)} onOpen={onOpen} onAct={onAct} busy={busy} onSignOut={onSignOut} inJob={inJob.get(p.shopify_product_id) || 0}
          onUpdate={active ? 'busy' : () => onDryRun([p.shopify_product_id], UPDATE_OPS)} />
      ))}
      <Pager page={page} pageSize={pageSize} total={d.total} onPage={setPage} label="products" />

      {picked.size > 0 && (
        <div className="batch-bar shl-bar">
          <span className="shl-bar-tot"><b>{fmt(picked.size)} product{picked.size === 1 ? '' : 's'}</b> · {fmt(pickedSizes)} sizes in stock{pickedBlocked ? <span className="muted"> · {fmt(pickedBlocked)} blocked (their blocked sizes are skipped)</span> : null}{pickedOff ? <span className="muted"> · {fmt(pickedOff)} not on SHEIN yet</span> : null}</span>
          <span className="shl-bar-btns">
            <button type="button" className="btn ghost sm" data-bar="clear" onClick={() => setPicked(new Set())}>Clear</button>
            <button type="button" className="btn ghost sm" data-bar="off" disabled={!!busy} title="Our records only — nothing changes on SHEIN"
              onClick={async () => { if (await onAct('exclude', { productIds: [...picked] }, `${fmt(picked.size)} product${picked.size === 1 ? '' : 's'} marked “Don’t list on SHEIN” (our records only).`)) setPicked(new Set()); }}>Don’t list on SHEIN</button>
            <span className="shl-bar-lead muted xs">Dry run first — nothing is sent:</span>
            <button type="button" className={`btn ${primary(pickedAdd, true)}`} disabled={!!busy || !!active || !pickedAdd} title={addTitle} data-dry="add"
              onClick={async () => { if (await onDryRun([...picked])) setPicked(new Set()); }}>{busy === 'preview' ? 'Starting…' : 'Add missing sizes'}{pickedAdd ? <> <span className="shl-bar-n">{fmt(pickedAdd)}</span></> : null}</button>
            <button type="button" className={`btn ${primary(pickedUpd, pickedAdd !== lead)}`} disabled={!!busy || !!active || !pickedUpd} title={updTitle} data-dry="update"
              onClick={async () => { if (await onDryRun(pickedRows.filter(needsUpdate).map((p) => p.shopify_product_id), UPDATE_OPS)) setPicked(new Set()); }}>{busy === 'preview' ? 'Starting…' : 'Update prices & sizes'}{pickedUpd ? <> <span className="shl-bar-n">{fmt(pickedUpd)}</span></> : null}</button>
            <button type="button" className={`btn ${primary(pickedNew, pickedAdd !== lead && pickedUpd !== lead)}`} disabled={!!busy || !!active || !pickedNew} title={pubTitle} data-dry="publish"
              onClick={async () => { if (await onDryRun(pickedRows.filter(canPublish).map((p) => p.shopify_product_id), ['publish'])) setPicked(new Set()); }}>{busy === 'preview' ? 'Starting…' : 'Publish new products'}{pickedNew ? <> <span className="shl-bar-n">{fmt(pickedNew)}</span></> : null}</button>
          </span>
        </div>
      )}
    </div>
  );
}
