// SHEIN Listings → Products tab: one row per product (photo, name, style code, Shopify ↔ SHEIN
// ids, rolled-up status, "8 of 11 sizes on SHEIN", the worst blocker), expanding to one row per
// size (Shopify stock / price, SHEIN size, SKU, SHEIN stock / price, status, what to do).
// Ticked products are in memory only — never restored from the URL, and dropped whenever the list changes
// (page, tile, any-size mode, search, brand, reason, Shopify filter, sort — 2026-11-17).
// Above the list: every filter that is on is a chip with ✕, plus Clear all (the owner: "we filter the errors, but we
// can't remove the filter"); the reason filter ("What's stopping it") only on Blocked / Error.
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CopyText, FormModal, Pager, RemoteThumb } from '../components/common.jsx';
import { api } from '../api.js';
import { useLive } from '../hooks.js';
import { useQueryParam } from '../lib/urlstate.js';
import { STATUSES, STATUS_ORDER, rowSyncable, rowSyncWhy, blockerLabel } from '../lib/sheinListings.js';
import { TERMS, plain } from '../lib/sheinWords.js';
import { SheinBulkPublish } from '../components/SheinBulkPublish.jsx';
import { ModelFixStrip } from '../components/SheinModelFix.jsx';
import { PH_DATE } from '../lib/format.js';
import { fmt, money, StatusChip, BlockerSay, FixButton, TONE, NEXT_PHASE, CustomSizeModal, PUBLISH_FIX_KINDS, REJECTION_PREVIEW_OPS, ActNote,
  SIZE_PHRASE, REASON_STATUSES, SORTS } from '../components/SheinListingsBits.jsx';

// A tile = shoes whose OWN status (their worst in-stock size) is it (2026-11-17) — every sentence below says so.
const EMPTY = {
  '': 'No shoes here yet.',
  blocked: 'No shoe is Blocked — nothing is waiting on a fix.', error: 'No shoe is in Error — nothing SHEIN refused is still standing.',
  out_of_date: 'No shoe’s own status is Needs update.', not_on_shein: 'No shoe is simply waiting to be listed.',
  in_review: 'No shoe is waiting on a SHEIN review.', synced: 'No shoe is fully in step with Shopify yet.',
  shein_only: 'Every SHEIN size is in Shopify.', excluded: 'Nothing is marked “Not listing”.', unknown: 'Every shoe has been checked.',
};

// The two previews a person can start (they never mix: one partialEdit per product at a time).
export const UPDATE_OPS = ['price', 'edit'];
// A shoe on SHEIN with an in-stock size SHEIN doesn't have → "Add missing sizes".
// Live on SHEIN = SHEIN holds at least one of its sizes (ours or only SHEIN's). A shoe whose publish SHEIN rejected
// has an SPU but nothing live — the live-shoe tools (add sizes, photo swap) can't touch it (2026-11-11).
export const isLiveOnShein = (p) => !!p?.spu && Number(p.counts?.on_shein || 0) + Number(p.counts?.shein_only || 0) > 0;
export const canAdd = (p) => isLiveOnShein(p) && Number(p.counts?.sizes || 0) > Number(p.counts?.on_shein || 0);
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
    case 'not_on_shein':
      // nothing in stock: the shoe is judged on every size, but there is nothing to add until Shopify has a pair
      if (!c.sizes) return ['muted', 'Nothing in stock on Shopify — nothing to add until a pair is back.'];
      return ['muted', p.spu ? `${fmt(missing)} in-stock size${missing === 1 ? ' isn’t' : 's aren’t'} on SHEIN yet. Nothing is wrong — tick it and Preview to add them.` : 'Not on SHEIN yet. Tick it → “Publish new products” to preview it (Details shows what publishing needs).'];
    case 'out_of_date': { const n = c.by?.out_of_date || 0; return ['info', `${n ? `${fmt(n)} size${n === 1 ? '' : 's'} on SHEIN need${n === 1 ? 's' : ''}` : 'On SHEIN, but it needs'} an update (price, a size turned off, or a wrong SKU). Tick it → “Update prices & sizes” to preview the fix.`]; }
    case 'in_review': return ['violet', 'SHEIN is reviewing an earlier edit. Nothing to do.'];
    case 'shein_only': return ['warn', 'Not in Shopify — Shopify has none of these SKUs. Automatic sync holds them at 0.'];
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
  if (x.field === 'shein_special') {
    return <>SHEIN special <span className="shl-was">{money(x.from)}</span> is live → <b>{money(x.to)}</b> only if a preview ends the special
      {x.base != null && <span className="muted xs"> · regular price {money(x.base)}</span>}</>;
  }
  if (x.field === 'price' || x.field === 'compareAt') return <>Shopify {x.field === 'price' ? 'price' : 'compare-at'} changed: <span className="shl-was">{money(x.from)}</span> → <b>{money(x.to)}</b></>;
  if (x.field === 'size') return <>Size changed on Shopify: <span className="shl-was">{x.from || '—'}</span> → <b>{x.to || '—'}</b> <span className="muted xs">(SHEIN still has the old size)</span></>;
  if (x.field === 'sku') return <>SKU changed on Shopify: <span className="shl-was">{x.from || '—'}</span> → <b>{x.to || '—'}</b> <span className="muted xs">(SHEIN gets the new one with the update)</span></>;
  if (x.field === 'barcode') return <>Barcode changed on Shopify: <span className="shl-was">{x.from || '—'}</span> → <b>{x.to || '—'}</b></>;
  if (x.field === 'seller_sku') return <>SHEIN has the wrong SKU: <span className="shl-was">{x.from || '—'}</span> → will change to <b>{x.to}</b></>;
  if (x.field === 'mall_state') return <>Turned off on SHEIN — will turn back on <span className="muted xs">(Shopify sells it)</span></>;
  if (x.field === 'listing') return <>Changed on Shopify since the last sync.</>;
  return <>{x.field} <span className="shl-was">{x.from ?? '—'}</span> → <b>{x.to ?? '—'}</b></>;
}

// One size. `onFix(kind, v, blocker)` handles the live kinds (custom size, leave off, include).
function VariantRow({ v, shopifyUrl, onFix, busy, onUpdate, onMatch }) {
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
            <FixButton action={b.action} shopifyUrl={shopifyUrl} busy={busy} onMatch={onMatch} onAct={(k) => onFix(k, v, b)} />
            {v.blockers.length > 1 && <span className="muted xs">+ {v.blockers.length - 1} more: {v.blockers.slice(1).map((x) => x.title).join(' ')}</span>}
          </div>
        ) : v.diffs?.length ? (
          <div className="shl-todo"><span className="shl-say">{v.diffs.map((x, i) => <span key={i} className="shl-diff">{diffText(x)}</span>)}</span>
            {onUpdate
              ? <button type="button" className="btn xs shl-fix" disabled={!!busy || onUpdate === 'busy'} title={onUpdate === 'busy' ? 'A job is running — preview when it finishes' : 'Preview “Update prices & sizes” for this product — shows exactly what would be sent. Nothing is sent.'}
                onClick={(e) => { e.stopPropagation(); if (typeof onUpdate === 'function') onUpdate(); }}>Preview the update</button>
              : <button type="button" className="btn xs shl-fix" disabled title={NEXT_PHASE}>Preview the update</button>}</div>
        ) : null}
        {notes.map((n, i) => (n.code === 'price_no_market'
          // a quiet note, not a warning: SHEIN's price is left alone until there is a market price (stage 2)
          ? <div key={i} className="shl-note shl-quiet" data-note={n.code} title={n.fix || undefined}>{n.title}</div>
          : <div key={i} className="shl-note" data-note={n.code}><BlockerSay b={n} compact={!n.fix} />{n.action && <FixButton action={n.action} shopifyUrl={shopifyUrl} busy={busy} onMatch={onMatch} onAct={(k) => onFix(k, v, n)} />}</div>
        ))}
        {!b && !v.diffs?.length && !notes.length && (v.status === 'not_on_shein'
          ? <span className="muted xs">Ready — tick the product and Preview to add it.</span>
          : v.status === 'shein_only' ? <span className="muted xs">Shopify has no SKU {v.shein_seller_sku || '(blank)'}. Automatic sync holds this SHEIN size at 0 — change the SKU on Match sizes if it’s a typo.</span>
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

export function VariantTable({ variants, shopifyUrl, onFix, busy, onUpdate, onMatch }) {
  if (!variants.length) return <p className="muted xs shl-pad">No sizes.</p>;
  return (
    <table className="shl-vtable">
      <thead><tr><th>Size</th><th className="num">Shopify</th><th className="num">Price</th><th>SHEIN size</th><th>SKU</th><th className="num">SHEIN stock · price</th><th>Status</th><th>What to do</th></tr></thead>
      <tbody>{variants.map((v) => <VariantRow key={v.row_key} v={v} shopifyUrl={shopifyUrl} onFix={onFix} busy={busy} onUpdate={onUpdate} onMatch={onMatch} />)}</tbody>
    </table>
  );
}

// The fix buttons' kinds, shared by the product rows and the drawer. `onOpen(at?)` opens (or, in the drawer, moves to)
// the shoe's Details — at 'photos' for Fix photos; `onDryRun(ids, ops)` starts a preview; `onPublishAgain` (drawer only).
export function useFixes({ onAct, onSignOut, reload, onOpen, productId = null, onDryRun = null, onPublishAgain = null }) {
  const [custom, setCustom] = useState(null);   // { size, categoryId, suggestion }
  async function onFix(kind, v, b) {
    // 2026-11-17: "this outlier price is right" for THIS size at THIS price (PH ok); a new price asks again
    if (kind === 'confirm_price') {
      const price = b?.action?.price ?? b?.params?.price;
      if (await onAct('price_ok', { variantKey: v.row_key, price }, `Size ${v.shopify_size}: ${money(price)} confirmed — it goes with the next preview.`)) reload?.();
      return;
    }
    // a SHEIN rejection's real next step: a preview of what was rejected (reads only)
    if (kind in REJECTION_PREVIEW_OPS) {
      if (onDryRun && productId) { const ops = REJECTION_PREVIEW_OPS[kind]; onDryRun([productId], ops || undefined); } else onOpen?.();
      return;
    }
    if (kind === 'fix_photos') { onOpen?.('photos'); return; }
    if (kind === 'publish_again' && onPublishAgain) { onPublishAgain(); return; }
    if (PUBLISH_FIX_KINDS.includes(kind)) { onOpen?.(); return; }   // the fix is in the drawer's editor
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

function ProductRow({ p, open, onToggle, picked, onPick, onOpen, onAct, busy, onSignOut, inJob, onUpdate, onDryRun, anyStatus = '' }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  async function loadVariants() {
    try { const r = await api.sheinListingProduct(p.shopify_product_id); setRows(r.variants || []); setErr(''); }
    catch (e) { if (e.unauthorized) onSignOut(); else setErr(plain(e.message)); }
  }
  // read again EVERY time it opens (the sizes may have changed since — a stale table was the bug)
  useEffect(() => { if (open) loadVariants(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useLive(open ? ['shein_listing_variants', 'shein_size_map'] : [], loadVariants, { mount: false, every: open ? 60_000 : 0 });
  const where = `row:${p.shopify_product_id}`;
  const { onFix, modal } = useFixes({ onAct: (a, x, done) => onAct(a, x, done, where), onSignOut, reload: loadVariants, onOpen: (at) => onOpen(p.shopify_product_id, at),
    productId: p.shopify_product_id, onDryRun: (ids, ops) => onDryRun(ids, ops, where) });

  const tone = TONE[p.status];
  // a Synced shoe never carries a red one-liner (its reasons sit on 0-stock sizes — idleBlockers, greyed below)
  const w = p.status !== 'synced' && p.worst && !['note'].includes(p.worst.level) ? p.worst : null;
  const idle = (p.idleBlockers || []).filter((b) => !['note', 'review'].includes(b.level));
  const anyN = anyStatus ? Number(p.counts?.by?.[anyStatus] || 0) : 0;
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
            {p.spu ? <span>On SHEIN <CopyText className="shl-mono" text={p.spu}>{p.spu}</CopyText>{p.spu_count > 1 ? ` (+${p.spu_count - 1})` : ''}</span> : <span>not on SHEIN yet</span>}
          </span>
          {w ? (
            <span className={`shl-pline ${w.level === 'error' ? 'warn' : 'bad'}`}>
              {w.sizes > 1 ? `${fmt(w.sizes)} sizes: ` : ''}<b>{w.title}</b> {w.fix}
            </span>
          ) : <span className={`shl-pline ${ht}`}>{hl}</span>}
          {idle.length > 0 && (
            <span className="shl-pline shl-idle" data-idle="" title="Only sizes with 0 pairs on Shopify have this — it doesn’t count until they are back in stock.">
              {idle.map((b) => `${b.label}${b.sizes > 1 ? ` (${fmt(b.sizes)} sizes)` : ''}`).join(' · ')} <span className="shl-idle-tag">(out of stock)</span>
            </span>
          )}
        </span>
        <span className="shl-rollup"><StatusChip status={p.status} />
          {anyStatus && anyStatus !== p.status && anyN > 0 && <span className={`ebo-chip shl-anymatch ${TONE[anyStatus]}`} data-any-match={anyN} title={`The shoe’s own status is ${STATUSES[p.status]?.label}; ${fmt(anyN)} of its sizes are ${STATUSES[anyStatus]?.label}`}>{fmt(anyN)} {STATUSES[anyStatus]?.label.toLowerCase()}</span>}
          {p.status !== 'in_review' && (p.counts?.by?.in_review || 0) > 0 && <span className="ebo-chip violet shl-inrev" title={STATUSES.in_review.meaning}>{fmt(p.counts.by.in_review)} in review</span>}
          {p.status !== 'out_of_date' && (p.counts?.by?.out_of_date || 0) > 0 && <span className="ebo-chip info shl-inrev" data-needs-update="" title="These sizes are on SHEIN but differ (price, turned off, wrong SKU) — tick the product → Update prices & sizes">{fmt(p.counts.by.out_of_date)} need{p.counts.by.out_of_date === 1 ? 's' : ''} an update</span>}
          {inJob > 0 && <span className="ebo-chip info" title="A preview or a send is working on this product right now">In job #{inJob}</span>}</span>
        <Coverage p={p} />
        <span className="shl-pact" onClick={(e) => e.stopPropagation()}>
          <button type="button" className="btn xs" onClick={() => onOpen(p.shopify_product_id)}>Details</button>
          <button type="button" className="shl-caret" aria-expanded={open} onClick={onToggle}>{open ? '▾' : '▸'} {fmt(nSizes)} size{nSizes === 1 ? '' : 's'}</button>
        </span>
      </div>
      {open && (
        <div className="shl-vwrap">
          <ActNote where={where} className="shl-pad" />
          {err && <p className="error sm shl-pad">{err}</p>}
          {!rows && !err && <div className="shl-pad"><div className="shl-skel shl-skel-row" /></div>}
          {rows && <VariantTable variants={rows} shopifyUrl={p.shopifyUrl} onFix={onFix} busy={busy} onUpdate={onUpdate} onMatch={() => onOpen(p.shopify_product_id, 'match')} />}
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

// The products a running preview / send is working on: their ticks are disabled.
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

// The Shopify filter (2026-10-28): active = ACTIVE on Shopify with stock > 0; the rest can't be synced.
const SHOP_FILTERS = [['', 'All'], ['active', 'Active (in stock)'], ['inactive', 'Inactive or no stock']];
const SHOP_WORDS = { active: 'Active (in stock)', inactive: 'Inactive or no stock' };
const BULK_MAX = 100;
const SORT_WORDS = Object.fromEntries(SORTS);
const plural = (n, w, many = `${w}s`) => `${fmt(n)} ${n === 1 ? w : many}`;

// The search box: typed text → ?q= after a pause. The box follows the URL only when the URL changed on its own (a
// chip's ✕, Clear all) — never while typing, so "air " keeps its space and "air max" searches "air max".
export function useSearchBox(q, setQ) {
  const [text, setText] = useState(q);
  const textRef = useRef(text);
  textRef.current = text;
  useEffect(() => { if (q !== textRef.current.trim()) setText(q); }, [q]);
  useEffect(() => {
    if (text.trim() === q) return undefined;
    const t = setTimeout(() => setQ(text.trim()), 350);
    return () => clearTimeout(t);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps
  return [text, setText];
}

// Every filter that is on, as a chip: ✕ takes off just that one; Clear all takes them all, the tile included.
function FilterChips({ chips, onClearAll }) {
  if (!chips.length) return null;
  return (
    <div className="shl-chips" role="group" aria-label="Filters that are on" data-active-filters="">
      <span className="muted xs shl-chips-lead">Showing only:</span>
      {chips.map((c) => (
        <button key={c.key} type="button" className="shl-fchip" data-chip={c.key} aria-label={`Remove filter: ${c.label}`} title="Remove this filter" onClick={c.off}>
          <span>{c.label}</span><span className="shl-fchip-x" aria-hidden="true">✕</span>
        </button>
      ))}
      <button type="button" className="btn ghost xs shl-clearall" data-chip="all" onClick={onClearAll}>Clear all</button>
    </div>
  );
}
export { FilterChips };

export function SheinListingsProducts({ d, status, any = false, sort = 'worst', setSort, setStatus, setAny, clearAll, q, setQ, brand, setBrand, blocker, setBlocker, shop = '', setShop,
  page, setPage, pageSize, onOpen, onAct, busy, onSignOut, active, onDryRun }) {
  const [text, setText] = useSearchBox(q, setQ);
  const [open, setOpen] = useState(() => new Set());
  const [picked, setPicked] = useState(() => new Set());   // in memory only — ticks are never restored
  const [dropped, setDropped] = useState(0);                // "3 ticks cleared — the list changed" (said once, quietly)
  const [askOff, setAskOff] = useState(null);               // "Don't list on SHEIN" asks first: the ids it would mark
  const [barOpen, setBarOpen] = useState(false);            // phone: the bar is one line until it is opened
  const [bulk, setBulk] = useState(null);                   // the bulk-edit sheet: { ids, leftOut, intent } — in memory only
  const [checking, setChecking] = useState(false);
  const [moreRaw, setMore] = useQueryParam('more', '');     // More filters (brand): open / closed, kept in the URL
  const more = moreRaw === '1';
  const reasonHere = REASON_STATUSES.includes(status);

  // Ticks belong to the list they were made on: any change of it drops them (and says so once).
  const listKey = [page, status, any ? 1 : 0, q, brand, blocker, shop, sort].join('|');
  const lastKey = useRef(listKey);
  useEffect(() => {
    if (lastKey.current === listKey) return;
    lastKey.current = listKey;
    setBarOpen(false);
    if (picked.size) { setDropped(picked.size); setPicked(new Set()); }
  }, [listKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!dropped) return undefined;
    const t = setTimeout(() => setDropped(0), 6000);
    return () => clearTimeout(t);
  }, [dropped]);

  const s = d.summary;
  const products = d.products || [];
  const inJob = useInJob(active, onSignOut);
  const toggle = (id) => setOpen((o) => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const pick = (id, on) => { setDropped(0); setPicked((o) => { const n = new Set(o); if (on) n.add(id); else n.delete(id); return n; }); };
  // what can be ticked on this page: Shopify shoes not in a running preview / send
  const pickable = products.filter((p) => !String(p.shopify_product_id).startsWith('shein:') && !inJob.get(p.shopify_product_id));
  const pageIds = pickable.map((p) => p.shopify_product_id);
  const allPicked = pageIds.length > 0 && pageIds.every((id) => picked.has(id));
  // THE set every count and every button of the bar acts on: the ticked rows on screen (never a tick that left the page)
  const pickedRows = pickable.filter((p) => picked.has(p.shopify_product_id));
  const nPicked = pickedRows.length;
  const pickedIds = pickedRows.map((p) => p.shopify_product_id);
  const pickedSizes = pickedRows.reduce((n, p) => n + (p.counts?.sizes || 0), 0);
  const pickedBlocked = pickedRows.filter((p) => p.status === 'blocked').length;
  const pickedOff = pickedRows.filter((p) => !p.spu).length;
  // 2026-10-28: a shoe inactive on Shopify or at 0 pairs is never sent by the listing syncs — left out
  // here (and refused again by the server's preview). The stock sync still keeps SHEIN at 0.
  const syncRows = pickedRows.filter((p) => canAdd(p) || needsUpdate(p) || canPublish(p));
  const deadRows = syncRows.filter((p) => !rowSyncable(p));
  const addRows = pickedRows.filter((p) => canAdd(p) && rowSyncable(p));
  const updRows = pickedRows.filter((p) => needsUpdate(p) && rowSyncable(p));
  const pubRows = pickedRows.filter((p) => canPublish(p) && rowSyncable(p));
  const pickedAdd = addRows.length;
  const pickedUpd = updRows.length;
  const pickedNew = pubRows.length;
  // 2026-11-11: shoes ON SHEIN whose photos can be replaced (the same Shopify gate as every listing sync)
  const photoRows = pickedRows.filter((p) => isLiveOnShein(p) && rowSyncable(p)).slice(0, BULK_MAX);
  // a ticked new shoe that still has a ✕ to fix → the button opens the fix step first, never the preview
  const pubNeedsFix = pubRows.filter((p) => ['blocked', 'error'].includes(p.status)).length;
  const deadWhy = [...new Set(deadRows.map(rowSyncWhy))].join(' / ');
  const leftOutFor = (rows) => [
    ...pickedRows.filter((p) => canPublish(p) && !rowSyncable(p)).map((p) => ({ productId: p.shopify_product_id, title: p.title, why: `${rowSyncWhy(p)} — not sent to SHEIN` })),
    ...rows.slice(BULK_MAX).map((p) => ({ productId: p.shopify_product_id, title: p.title, why: `over ${BULK_MAX} at a time — do it in a second batch` })),
  ];
  const clearPicks = () => { setPicked(new Set()); setBarOpen(false); };
  const [photoAsk, setPhotoAsk] = useState(null);   // { ids, cover } — the "Replace SHEIN photos" question
  async function photoPreview() {
    const { ids, cover } = photoAsk;
    try {
      if (cover) await api.sheinListingAction({ action: 'publish_choices_bulk', productIds: ids, patch: { skipCover: true } });
      setPhotoAsk(null);
      if (await onDryRun(ids, ['photos'], 'bar')) clearPicks();
    } catch (e) { if (e.unauthorized) onSignOut(); else setPhotoAsk({ ...photoAsk, err: plain(e.message) }); }
  }
  const openBulk = (intent) => setBulk({ ids: pubRows.slice(0, BULK_MAX).map((p) => p.shopify_product_id), leftOut: leftOutFor(pubRows), intent });
  // "Publish new products": straight to the preview only when EVERY ticked new shoe is ready (the server's
  // checklist, one call); otherwise the bulk-edit sheet opens on the fix step.
  async function publishOrFix() {
    const ids = pubRows.slice(0, BULK_MAX).map((p) => p.shopify_product_id);
    setChecking(true);
    try {
      const r = await api.sheinPublishSetup(ids);
      const allReady = (r.products || []).length === ids.length && r.products.every((x) => x.ready) && pubRows.length <= BULK_MAX;
      if (allReady) { if (await onDryRun(ids, ['publish'], 'bar')) clearPicks(); }
      else setBulk({ ids, leftOut: leftOutFor(pubRows), intent: 'fix' });
    } catch (e) {
      if (e.unauthorized) onSignOut(); else setBulk({ ids, leftOut: leftOutFor(pubRows), intent: 'fix' });
    } finally { setChecking(false); }
  }
  const lead = Math.max(pickedAdd, pickedUpd, pickedNew);
  const primaryKey = !lead ? '' : pickedAdd === lead ? 'add' : pickedUpd === lead ? 'update' : 'publish';
  const cls = (k, n) => `btn ${k === primaryKey ? 'primary shl-bar-primary' : 'ghost'}${n ? '' : ' shl-bar-none'}`;
  const running = active ? `Job #${active.id} is running — preview when it finishes` : '';
  const addTitle = running || (pickedAdd ? `Preview: the in-stock sizes SHEIN doesn’t have yet, added to ${plural(pickedAdd, 'shoe')} already on SHEIN. Nothing is sent.` : 'None of the ticked shoes is on SHEIN with a size missing');
  const updTitle = running || (pickedUpd ? `Preview: SHEIN prices, sizes turned off on SHEIN and wrong SKUs, for ${plural(pickedUpd, 'shoe')} that need an update. Nothing is sent.` : 'None of the ticked shoes needs an update');
  const pubTitle = running || (!pickedNew ? (deadRows.some(canPublish) ? 'The ticked new shoes have no Shopify stock (or aren’t active) — nothing to publish' : 'None of the ticked shoes is new to SHEIN')
    : pubNeedsFix ? `${fmt(pubNeedsFix)} of the ${fmt(pickedNew)} still need${pubNeedsFix === 1 ? 's' : ''} fixing — this opens the fix step first (category, brand, details, photos…). Only the ready ones are previewed, and nothing is sent.`
      : `Checks every ticked new shoe first; when all ${fmt(pickedNew)} are ready, previews what SHEIN would receive. Any that still need fixing open the fix step instead. Nothing is sent.`);
  // the page the server actually returned (a stale ?p= reads the last page)
  const first = d.total ? (page - 1) * pageSize + 1 : 0;
  const last = Math.min(d.total, page * pageSize);
  const label = STATUSES[status]?.label || '';

  // every filter that is on → a chip
  const reasonLabel = (code) => (s.topBlockers || []).find((b) => b.code === code)?.label || blockerLabel(code);
  const chips = [
    status && { key: 'status', label: status === 'excluded' ? 'Not listing' : status === 'all' ? 'Everything (Not listing too)' : `Status: ${label}`, off: () => setStatus('') },
    any && status && { key: 'any', label: `Has a ${SIZE_PHRASE[status] || 'size like that'}`, off: () => setAny(false) },
    q && { key: 'q', label: `Search: “${q}”`, off: () => { setText(''); setQ(''); } },
    brand && { key: 'brand', label: `Brand: ${brand}`, off: () => setBrand('') },
    blocker && { key: 'blocker', label: `${TERMS.stopping}: ${reasonLabel(blocker)}`, off: () => setBlocker('') },
    shop && { key: 'shop', label: `Shopify: ${SHOP_WORDS[shop]}`, off: () => setShop('') },
    sort !== 'worst' && { key: 'sort', label: `Sort: ${SORT_WORDS[sort]}`, off: () => setSort('worst') },
  ].filter(Boolean);
  const narrowed = !!(q || brand || blocker || shop);
  const bStat = s.byStatus?.[status] || null;
  const clearEverything = () => { setText(''); clearAll(); };

  return (
    <div className="card">
      <ModelFixStrip active={active} busy={busy} onDryRun={(ids, ops) => onDryRun(ids, ops, 'model')} onSignOut={onSignOut} />
      <ActNote where="model" />
      <div className="ebl-filters shl-filters">
        <input type="search" className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Search name, style code, SKU or SHEIN code…" aria-label="Search products" />
        {reasonHere && (
          <select className="input shl-select" value={blocker} onChange={(e) => setBlocker(e.target.value)} aria-label={TERMS.stopping} data-reason-filter="">
            <option value="">{TERMS.stopping}: any reason</option>
            {(s.topBlockers || []).map((b) => <option key={b.code} value={b.code}>{b.label} ({plural(b.products, 'shoe')} · {plural(b.sizes, 'size')})</option>)}
            {blocker && !(s.topBlockers || []).some((b) => b.code === blocker) && <option value={blocker}>{reasonLabel(blocker)}</option>}
          </select>
        )}
        <button type="button" className="btn ghost sm shein-filterbtn" aria-expanded={more} data-more-toggle="" onClick={() => setMore(more ? '' : '1')}>
          More filters{brand ? ' (1)' : ''} {more ? '▴' : '▾'}</button>
      </div>
      {more && (
        <div className="ebl-filters shl-filters" data-more-filters="">
          <select className="input shl-select" value={brand} onChange={(e) => setBrand(e.target.value)} aria-label="Brand">
            <option value="">All brands</option>
            {(s.brands || []).map((b) => <option key={b.brand} value={b.brand}>{b.brand} ({fmt(b.products)})</option>)}
            {brand && !(s.brands || []).some((b) => b.brand === brand) && <option value={brand}>{brand}</option>}
          </select>
        </div>
      )}
      {setShop && (
        <div className="seg sm shl-shopfilter" role="group" aria-label="Shopify: active or not" data-shopfilter="">
          <span className="muted xs shl-shopfilter-lead">Shopify:</span>
          {SHOP_FILTERS.map(([k, lbl]) => {
            const n = k === 'active' ? d.shopifyCounts?.active : k === 'inactive' ? d.shopifyCounts?.inactive : null;
            return (
              <button key={k || 'all'} type="button" className={`seg-btn${shop === k ? ' on' : ''}`} aria-pressed={shop === k} data-shop={k || 'all'}
                title={k === 'active' ? 'Active on Shopify with at least one pair in stock — the ones the listing syncs can send' : k === 'inactive' ? 'Draft / archived on Shopify, or 0 pairs — the listing syncs skip them (the stock sync still keeps SHEIN at 0)' : 'Every product'}
                onClick={() => setShop(k)}>{lbl}{n != null && <span className="seg-n">{fmt(n)}</span>}</button>
            );
          })}
        </div>
      )}
      <FilterChips chips={chips} onClearAll={clearEverything} />
      <div className="shl-listhead">
        <span className="muted xs shl-listhead-say" data-list-head="">
          {any && status
            ? <><b>Shoes with at least one {SIZE_PHRASE[status]}</b> — the chip on each row is the shoe’s own status; the second chip says how many of its sizes are {label}. </>
            : status && status !== 'all' && status !== 'excluded' ? <><b>Shoes whose own status is {label}</b> (their worst in-stock size). </> : null}
          {d.total ? `${fmt(first)}–${fmt(last)} of ${plural(d.total, 'shoe')}` : '0 shoes'} · tap a shoe for its sizes
        </span>
        <span className="shl-listhead-acts">
          <label className="shl-sort"><span className="muted xs">Sort</span>
            <select className="input shl-select" value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort">
              {SORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
          {pageIds.length > 0 && (
            <label className="shl-pickall" title={products.length > pageIds.length ? 'Shoes in a running preview / send (and SHEIN-only rows) are skipped' : undefined}>
              <input type="checkbox" checked={allPicked} onChange={(e) => { setDropped(0); setPicked((o) => { const n = new Set(o); for (const id of pageIds) { if (e.target.checked) n.add(id); else n.delete(id); } return n; }); }} /> Select all on this page</label>
          )}
        </span>
      </div>
      {dropped > 0 && <p className="muted xs shl-dropped" role="status" data-ticks-dropped={dropped}>{plural(dropped, 'tick')} cleared — the list changed.</p>}
      {!products.length && (
        <div className="empty-state" data-empty="">
          {narrowed
            ? <>No shoes match{q ? <> “<b>{q}</b>”</> : ''}{brand ? ` in ${brand}` : ''}{blocker ? ` stopped by “${reasonLabel(blocker)}”` : ''}{shop ? (shop === 'active' ? ' that are active on Shopify with stock' : ' that are inactive or out of stock on Shopify') : ''}{status ? ` among ${any ? `shoes with a ${SIZE_PHRASE[status]}` : label || status}` : ''}.</>
            : any && status ? <>No shoe has a {SIZE_PHRASE[status]}.</>
              : <>{EMPTY[status] || EMPTY['']}
                {status && bStat && bStat.anySize > 0 && <> But {plural(bStat.anySize, 'shoe has', 'shoes have')} a {SIZE_PHRASE[status]} — their own status is worse.
                  <span className="shl-block mt"><button type="button" className="btn ghost sm" data-empty-any="" onClick={() => setAny(true)}>Show {bStat.anySize === 1 ? 'it' : `those ${fmt(bStat.anySize)}`}</button></span></>}</>}
          {chips.length > 0 && <div className="mt"><button type="button" className="btn ghost sm" onClick={clearEverything}>Clear all filters</button></div>}
        </div>
      )}
      {products.map((p) => (
        <ProductRow key={p.shopify_product_id} p={p} open={open.has(p.shopify_product_id)} onToggle={() => toggle(p.shopify_product_id)}
          picked={picked.has(p.shopify_product_id)} onPick={(on) => pick(p.shopify_product_id, on)} onOpen={onOpen} onAct={onAct} busy={busy} onSignOut={onSignOut} inJob={inJob.get(p.shopify_product_id) || 0}
          onDryRun={onDryRun} anyStatus={any ? status : ''}
          onUpdate={active ? 'busy' : () => onDryRun([p.shopify_product_id], UPDATE_OPS, `row:${p.shopify_product_id}`)} />
      ))}
      <Pager page={page} pageSize={pageSize} total={d.total} onPage={setPage} label="shoes" />
      {/* the bar's answer once the bar is gone (its action cleared the ticks) */}
      {nPicked === 0 && <ActNote where="bar" />}

      {nPicked > 0 && (
        <div className={`batch-bar shl-bar${barOpen ? ' open' : ''}`} data-bar="">
          <span className="shl-bar-tot" data-bar-count={nPicked}><b>{plural(nPicked, 'shoe')}</b><span className="shl-bar-extra"> · {plural(pickedSizes, 'size')} in stock</span>
            <span className="shl-bar-extra">{pickedBlocked ? <span className="muted"> · {fmt(pickedBlocked)} blocked (their blocked sizes are skipped)</span> : null}{pickedOff ? <span className="muted"> · {fmt(pickedOff)} not on SHEIN yet</span> : null}
              {deadRows.length > 0 && <span className="shl-bar-dead" data-left-out=""> · {fmt(deadRows.length)} left out: {deadWhy} — not sent to SHEIN</span>}</span></span>
          <button type="button" className="btn ghost sm shl-bar-toggle" aria-expanded={barOpen} data-bar="more" onClick={() => setBarOpen(!barOpen)}>{barOpen ? 'Less ▴' : 'More ▾'}</button>
          <span className="shl-bar-btns">
            <button type="button" className="btn ghost sm" data-bar="clear" onClick={clearPicks}>Clear</button>
            <button type="button" className="btn ghost sm" data-bar="off" disabled={!!busy} title="Asks first. Our records only — nothing changes on SHEIN"
              onClick={() => setAskOff(pickedIds)}>Don’t list on SHEIN</button>
            {pickedNew > 0 && (
              <button type="button" className="btn ghost sm" data-bar="bulk" disabled={!!checking}
                title={`Set category, brand, SHEIN details, photos and titles for the ${plural(pickedNew, 'ticked shoe')} not on SHEIN yet — in one place. Our records only.`}
                onClick={() => openBulk('edit')}>Bulk edit <span className="shl-bar-n">{fmt(Math.min(pickedNew, BULK_MAX))}</span></button>
            )}
            <span className="shl-bar-lead muted xs">Preview first. Nothing is sent:</span>
            <button type="button" className={cls('add', pickedAdd)} disabled={!!busy || !!active || !pickedAdd} title={addTitle} data-dry="add"
              onClick={async () => { if (await onDryRun(addRows.map((p) => p.shopify_product_id), undefined, 'bar')) clearPicks(); }}>{busy === 'preview' ? 'Starting…' : 'Add missing sizes'}{pickedAdd ? <> <span className="shl-bar-n">{fmt(pickedAdd)}</span></> : null}</button>
            <button type="button" className={cls('update', pickedUpd)} disabled={!!busy || !!active || !pickedUpd} title={updTitle} data-dry="update"
              onClick={async () => { if (await onDryRun(updRows.map((p) => p.shopify_product_id), UPDATE_OPS, 'bar')) clearPicks(); }}>{busy === 'preview' ? 'Starting…' : 'Update prices & sizes'}{pickedUpd ? <> <span className="shl-bar-n">{fmt(pickedUpd)}</span></> : null}</button>
            {photoRows.length > 0 && (
              <button type="button" className="btn ghost sm" data-dry="photos" disabled={!!busy || !!active}
                title={running || `Preview new photos for the ${plural(photoRows.length, 'ticked shoe')} already on SHEIN — what SHEIN has now → what it would get. Nothing is sent.`}
                onClick={() => setPhotoAsk({ ids: photoRows.map((p) => p.shopify_product_id), cover: true })}>Replace SHEIN photos <span className="shl-bar-n">{fmt(photoRows.length)}</span></button>
            )}
            <button type="button" className={cls('publish', pickedNew)} disabled={!!busy || !!active || !pickedNew || checking} title={pubTitle} data-dry="publish" data-needs-fix={pubNeedsFix || undefined}
              onClick={publishOrFix}>{checking ? 'Checking…' : busy === 'preview' ? 'Starting…' : pubNeedsFix ? 'Fix & publish' : 'Publish new products'}{pickedNew ? <> <span className="shl-bar-n">{fmt(pickedNew)}</span></> : null}</button>
          </span>
          <ActNote where="bar" className="shl-bar-note" />
        </div>
      )}
      {askOff && createPortal(
        <FormModal title={`Don’t list ${plural(askOff.length, 'shoe')} on SHEIN?`} submitLabel={`Don’t list ${plural(askOff.length, 'shoe')}`}
          message={<>The {plural(askOff.length, 'ticked shoe')} leave{askOff.length === 1 ? 's' : ''} every tile and move{askOff.length === 1 ? 's' : ''} to <b>Not listing</b>. Nothing is sent to SHEIN — this is our records only. “List on SHEIN again” (in Details) undoes it.</>}
          onClose={() => setAskOff(null)}
          onSubmit={async () => {
            const ids = askOff; setAskOff(null);
            if (await onAct('exclude', { productIds: ids }, `${plural(ids.length, 'shoe')} marked “Don’t list on SHEIN” (our records only).`, 'bar')) clearPicks();
          }} />,
        document.body,
      )}
      {bulk && (
        <SheinBulkPublish ids={bulk.ids} leftOut={bulk.leftOut} intent={bulk.intent} active={active} busy={busy} onSignOut={onSignOut}
          onClose={() => setBulk(null)} onOpen={(id) => { setBulk(null); onOpen(id); }}
          onDryRun={async (ids, ops) => { const r = await onDryRun(ids, ops, 'bulk'); if (r) clearPicks(); return r; }} />
      )}
      {photoAsk && (
        <div className="modal-overlay" onClick={() => setPhotoAsk(null)}>
          <div className="modal form-modal shl-photo-ask" role="dialog" aria-modal="true" aria-label="Replace SHEIN photos" data-photo-ask="" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Replace the SHEIN photos of {plural(photoAsk.ids.length, 'shoe')}</h3>
            <p className="sm">Each shoe gets the photos picked for it (its own “Choose photos” in Details: the clean photos — the shoe on white — when its style has them, else the PH edited photos when that is on, else Shopify’s). The preview shows what SHEIN has now next to what it would get — nothing is sent until someone confirms.</p>
            <label className="shl-pub-ph"><input type="checkbox" checked={photoAsk.cover} onChange={(e) => setPhotoAsk({ ...photoAsk, cover: e.target.checked })} />
              <span>First leave out Shopify’s cover photo (photo 1) on all {fmt(photoAsk.ids.length)} <span className="muted xs shl-block">The branded cover — text, a logo or the store name on it — is what SHEIN calls a watermark. Our records only; Shopify isn’t changed.</span></span></label>
            {photoAsk.err && <p className="error xs" role="alert">{photoAsk.err}</p>}
            <div className="shl-pub-acts">
              <button type="button" className="btn ghost sm" onClick={() => setPhotoAsk(null)}>Cancel</button>
              <button type="button" className="btn primary sm" data-act="photos-preview" disabled={!!busy} onClick={photoPreview}>Preview new photos</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
