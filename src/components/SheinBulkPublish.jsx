// SHEIN Listings → "Bulk edit before publishing" (docs/context/shein-listings.md → "Bulk edit before
// publishing"). The ticked shoes NOT on SHEIN yet, in one sheet: what blocks each one (the server's
// publishing checklist, read for all of them in ONE call: GET ?publishSetup=), and the fixes grouped by
// what they are keyed on, so one decision covers many shoes:
//   · category   per Shopify product type × size group (CategoryPicker, saved in the category map)
//   · brand      per Shopify vendor (BrandPicker)
//   · details    per SHEIN product type (AttrEditor)
//   · colour     per SHEIN product type → set on every ticked shoe of that type (publish_choices_bulk)
//   · photos     "Use PH edited photos" on / off for all of them (publish_choices_bulk)
//   · titles     a tidy-up preview (tidyTitle) → apply; each title editable inline too
//   · box        D6 (BoxDefaults — saving stays admin / Connect integrations)
// Every save is OUR database only; the sheet re-reads after each one. "Dry run publish (n ready)" starts
// the same publish dry run as the drawer, for the shoes with no ✕ — nothing goes to SHEIN until the
// dry run's own confirm. Opened from the ticked-products bar ("Bulk edit", or "Fix & publish" when a
// ticked shoe still needs fixing). In memory only — never in the URL.
import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api.js';
import { useLive } from '../hooks.js';
import { RemoteThumb, CopyText } from './common.jsx';
import { fmt, NEEDS_PRIV } from './SheinListingsBits.jsx';
import { CategoryPicker, BrandPicker, AttrEditor, BoxDefaults, GROUP_LABEL } from './SheinPublishBits.jsx';
import { tidyTitle, cleanTitle } from '../lib/sheinPublish.js';

const saveChoices = (body) => api.sheinListingAction({ action: 'publish_choices_bulk', ...body });
const lineOf = (p, key) => (p.checklist || []).find((l) => l.key === key) || null;
const isNo = (p, key) => lineOf(p, key)?.ok === false;
const plural = (n, one, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`;
// "Not active / no stock" first: it can't be fixed here.
const stockWhy = (p) => (String(p.shopifyStatus || '').toUpperCase() !== 'ACTIVE' ? 'Not active on Shopify' : 'No Shopify stock');

export function SheinBulkPublish({ ids, leftOut = [], intent = 'edit', active, busy, onClose, onDryRun, onOpen, onSignOut }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [brandMaps, setBrandMaps] = useState(null);
  const [open, setOpen] = useState('');   // the one fix panel open: 'cat:<type>|<group>' · 'brand:<vendor>' · 'attr:<ptid>' · 'box'
  async function reload() {
    try {
      const [r, bm] = await Promise.all([api.sheinPublishSetup(ids), api.sheinPublishMaps('brand').catch(() => null)]);
      setD(r); setBrandMaps(bm?.maps || []); setErr('');
    } catch (e) { if (e.unauthorized) onSignOut?.(); else setErr(e.message); }
  }
  useEffect(() => { setD(null); reload(); }, [ids.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  useLive(['shein_category_map', 'shein_brand_map', 'shein_listing_products', 'app_settings'], reload, { mount: false });
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const saved = async (text) => { setMsg(text); setOpen(''); await reload(); };

  const products = d?.products || [];
  const canWrite = !!d?.canWrite;
  const ready = products.filter((p) => p.ready);
  const fixing = products.filter((p) => !p.ready);
  const skipped = [...leftOut, ...(d?.skipped || [])];

  // ---- what each bulk fix is keyed on ----
  const groups = useMemo(() => {
    const cat = new Map(); const mixed = []; const noGroup = [];
    const brand = new Map(); const attr = new Map(); const colour = new Map(); const noCat = [];
    const bm = new Set((brandMaps || []).map((m) => m.vendor));
    for (const p of products) {
      if (!p.syncable) continue;   // inactive / no stock: never published, nothing to fix here
      if (isNo(p, 'category') || !p.category) {
        if (p.sizeGroups.length > 1) mixed.push(p);
        else if (!p.sizeGroups.length) noGroup.push(p);
        else { const k = `${p.productType}|${p.sizeGroups[0]}`; const g = cat.get(k) || { productType: p.productType, sizeGroup: p.sizeGroups[0], list: [] }; g.list.push(p); cat.set(k, g); }
      }
      const vk = String(p.vendor || '').trim().toLowerCase();
      const bl = lineOf(p, 'brand');
      if (bl?.ok === false || (bl?.ok == null && !bm.has(vk))) { const g = brand.get(vk) || { vendor: p.vendor || '', list: [] }; g.list.push(p); brand.set(vk, g); }
      if (!p.productTypeId) { if (isNo(p, 'colour') || isNo(p, 'attributes') || p.category == null) noCat.push(p); continue; }
      const al = lineOf(p, 'attributes');
      if (al?.ok !== true) {
        const g = attr.get(p.productTypeId) || { ptid: p.productTypeId, categoryId: p.category?.categoryId || null, path: p.category?.path || '', list: [], focus: new Set() };
        g.list.push(p); for (const b of al?.blockers || []) if (b.params?.attributeId) g.focus.add(Number(b.params.attributeId));
        attr.set(p.productTypeId, g);
      }
      const g = colour.get(p.productTypeId) || { ptid: p.productTypeId, path: p.category?.path || '', list: [] };
      g.list.push(p); colour.set(p.productTypeId, g);
    }
    return { cat: [...cat.values()], mixed, noGroup, brand: [...brand.values()], attr: [...attr.values()], colour: [...colour.values()], noCat };
  }, [products, brandMaps]);
  const boxNo = products.some((p) => p.syncable && isNo(p, 'box'));
  const live = products.filter((p) => p.syncable);
  const phOn = live.filter((p) => p.usePhPhotos).length;
  const photoNo = live.filter((p) => isNo(p, 'photos')).length;
  const tidy = live.map((p) => { const cur = p.titleOverride || cleanTitle(p.title || ''); const next = tidyTitle(cur, p.titleMax); return { p, cur, next }; }).filter((x) => x.next !== x.cur && x.next.length >= 2);
  const titleMaxKnown = live.some((p) => p.titleMax);

  async function bulk(body, text) {
    setErr('');
    try { const r = await saveChoices(body); await saved(typeof text === 'function' ? text(r) : text); return true; }
    catch (e) { if (e.unauthorized) onSignOut?.(); else setErr(e.message); return false; }
  }
  const why = active ? `Job #${active.id} is running — dry run when it finishes` : '';

  return createPortal(
    <>
      <div className="shl-drawer-bg shl-sheet-bg" onClick={onClose} aria-hidden="true" />
      <aside className="shl-drawer shl-sheet shl-bulk" role="dialog" aria-modal="true" aria-label="Bulk edit before publishing" data-bulk="">
        <div className="shl-d-head shl-sheet-head">
          <div className="shl-d-title">
            <div className="shl-pname">{intent === 'fix' ? 'Fix first, then publish' : 'Bulk edit before publishing'}</div>
            <div className="muted xs">{d ? <>{plural(products.length, 'shoe')} not on SHEIN yet · <b>{fmt(ready.length)} ready</b> · <b className={fixing.length ? 'shl-bad-text' : ''}>{fmt(fixing.length)} still need{fixing.length === 1 ? 's' : ''} fixing</b></> : 'Reading what each shoe needs…'}</div>
          </div>
          <button type="button" className="btn ghost sm shl-close" aria-label="Close" onClick={onClose}>✕</button>
        </div>
        <div className="shl-d-body">
          {err && <p className="error sm" role="alert">{err}</p>}
          {msg && <p className="ebl-ok xs" role="status">{msg}</p>}
          {!d && !err && [0, 1, 2].map((i) => <div key={i} className="shl-skel shl-skel-row" />)}
          {d && intent === 'fix' && fixing.length > 0 && (
            <div className="shl-banner warn" role="status" data-fix-first="">
              <b>{plural(fixing.length, 'shoe')} can’t be published yet — fix {fixing.length === 1 ? 'it' : 'them'} first</b>
              <span className="xs">Nothing was sent or dry-run. Each row below says what’s missing; the fixes underneath apply to many shoes at once. “Dry run publish” only takes the ready ones.</span>
            </div>
          )}
          {skipped.length > 0 && (
            <details className="shl-bulk-left" data-left-out="">
              <summary className="xs">{plural(skipped.length, 'ticked product')} left out — tap for why</summary>
              {skipped.map((x, i) => <p key={i} className="xs muted">{x.title || x.productId}: {x.why}</p>)}
            </details>
          )}
          {d && !products.length && (
            <div className="shl-state"><p className="muted">None of the ticked products can be published from here{skipped.length ? ' (see why above)' : ''}.</p><button type="button" className="btn ghost sm" onClick={onClose}>Close</button></div>
          )}

          {products.length > 0 && (
            <section className="shl-d-sec">
              <h4 className="shl-h4">The shoes</h4>
              <table className="shl-rtable shl-bulk-table">
                <thead><tr><th>Shoe</th><th>Style</th><th>Type · size group</th><th>Vendor</th><th>What blocks it</th></tr></thead>
                <tbody>{products.map((p) => <BulkRow key={p.productId} p={p} onOpen={onOpen} onSave={(title) => bulk({ titles: { [p.productId]: title } }, title ? `SHEIN title saved for “${cleanTitle(p.title || '')}” (Shopify unchanged).` : 'Back to the Shopify title.')} />)}</tbody>
              </table>
              <p className="muted xs">✓ / ✕ are from our records (checked again on every save). “Checked by the dry run” lines — SHEIN’s store checks, photos, seller SKUs — are read when you dry run; nothing is sent then either.</p>
            </section>
          )}

          {live.length > 0 && (
            <section className="shl-d-sec" data-bulk-fixes="">
              <h4 className="shl-h4">Fix in bulk</h4>

              <BulkBlock k="category" title="Category" ok={!groups.cat.length && !groups.mixed.length && !groups.noGroup.length} okText="Every shoe here has a SHEIN category.">
                {groups.cat.map((g) => {
                  const key = `cat:${g.productType}|${g.sizeGroup}`;
                  return (
                    <div key={key} className="shl-bulk-grp" data-group={key}>
                      <span className="sm">“{g.productType || '(no product type)'}” · {GROUP_LABEL[g.sizeGroup] || g.sizeGroup} <span className="muted xs">— {plural(g.list.length, 'shoe')}</span></span>
                      <button type="button" className="btn xs shl-fix" aria-expanded={open === key} onClick={() => setOpen(open === key ? '' : key)}>{open === key ? 'Close' : `Choose category (${fmt(g.list.length)})`}</button>
                      {open === key && <div className="shl-bulk-panel"><CategoryPicker productType={g.productType} sizeGroup={g.sizeGroup} productId={g.list.length === 1 ? g.list[0].productId : null} canWrite={canWrite} onSignOut={onSignOut}
                        lede={`applies to ${plural(g.list.length, 'ticked shoe')} (and every other one of this type)`} onCancel={() => setOpen('')} onSaved={(m) => saved(`Category saved: ${plural(g.list.length, 'shoe')} → ${m?.category_path || 'that category'}.`)} /></div>}
                    </div>
                  );
                })}
                {groups.mixed.map((p) => <p key={p.productId} className="xs shl-bad-text" data-mixed="">{cleanTitle(p.title || '')}: sizes from {p.sizeGroups.map((g) => GROUP_LABEL[g] || g).join(' and ')} — a category is per size group, so it can’t be mapped. Split the product on Shopify (or leave those sizes off), then it can.</p>)}
                {groups.noGroup.map((p) => <p key={p.productId} className="xs muted">{cleanTitle(p.title || '')}: no US size we can read, so no size group — fix the sizes on Shopify.</p>)}
              </BulkBlock>

              <BulkBlock k="brand" title="Brand" ok={!groups.brand.length} okText="Every vendor here maps to a SHEIN brand.">
                {groups.brand.map((g) => {
                  const key = `brand:${g.vendor.toLowerCase()}`;
                  return (
                    <div key={key} className="shl-bulk-grp" data-group={key}>
                      <span className="sm">Vendor <b>{g.vendor || '(none)'}</b> <span className="muted xs">— {plural(g.list.length, 'shoe')}</span></span>
                      <button type="button" className="btn xs shl-fix" aria-expanded={open === key} onClick={() => setOpen(open === key ? '' : key)}>{open === key ? 'Close' : 'Map to a SHEIN brand'}</button>
                      {open === key && <div className="shl-bulk-panel"><BrandPicker vendor={g.vendor} canWrite={canWrite} onSignOut={onSignOut} onCancel={() => setOpen('')}
                        onSaved={(m) => saved(m ? `Saved: ${g.vendor} → SHEIN brand ${m.brand_name || m.brand_code || '(no brand)'} — ${plural(g.list.length, 'shoe')}.` : 'Brand cleared.')} /></div>}
                    </div>
                  );
                })}
              </BulkBlock>

              <BulkBlock k="attributes" title="SHEIN details" ok={!groups.attr.length && !groups.noCat.length} okText="Every SHEIN product type here has its details set.">
                {groups.noCat.length > 0 && <p className="xs muted">{plural(groups.noCat.length, 'shoe')} need{groups.noCat.length === 1 ? 's' : ''} a category first — the details and colours SHEIN asks for depend on it.</p>}
                {groups.attr.map((g) => {
                  const key = `attr:${g.ptid}`;
                  return (
                    <div key={key} className="shl-bulk-grp" data-group={key}>
                      <span className="sm">{g.path || `SHEIN type ${g.ptid}`} <span className="muted xs">— {plural(g.list.length, 'shoe')}</span></span>
                      <button type="button" className="btn xs shl-fix" aria-expanded={open === key} onClick={() => setOpen(open === key ? '' : key)}>{open === key ? 'Close' : 'Set SHEIN details'}</button>
                      {open === key && <div className="shl-bulk-panel"><AttrEditor productTypeId={g.ptid} categoryId={g.categoryId} canWrite={canWrite} focus={[...g.focus]} onSignOut={onSignOut} onSaved={() => reload()} /></div>}
                    </div>
                  );
                })}
              </BulkBlock>

              <BulkBlock k="colour" title="Colour" ok={!groups.colour.some((g) => g.list.some((p) => isNo(p, 'colour') || p.skcValueId == null))} okText="Every shoe here has its SHEIN colour.">
                {groups.colour.map((g) => <BulkColour key={g.ptid} g={g} onSignOut={onSignOut} onSave={(v) => bulk({ productIds: g.list.map((p) => p.productId), patch: { skcValueId: v }, productTypeId: g.ptid }, v == null ? `Colour cleared on ${plural(g.list.length, 'shoe')}.` : `Colour set on ${plural(g.list.length, 'shoe')}.`)} />)}
                {groups.colour.length > 1 && <p className="muted xs">One colour list per SHEIN product type — so each type is set on its own (a colour from one type can’t go on another).</p>}
              </BulkBlock>

              <BulkBlock k="photos" title="Photos" ok={!photoNo} okText={`${fmt(phOn)} of ${fmt(live.length)} use the PH edited photos.`}>
                <p className="xs">{fmt(phOn)} of {fmt(live.length)} use the PH edited photos{photoNo ? <> · <span className="shl-bad-text">{fmt(photoNo)} short of photos</span></> : ''}. The PH team’s photos for each style are used when there are any, else Shopify’s.</p>
                <div className="shl-pub-acts">
                  <button type="button" className="btn ghost xs" disabled={phOn === 0} onClick={() => bulk({ productIds: live.map((p) => p.productId), patch: { usePhPhotos: false } }, `Back to the Shopify photos on ${plural(live.length, 'shoe')}.`)}>Shopify photos on all</button>
                  <button type="button" className="btn xs shl-fix" disabled={phOn === live.length} onClick={() => bulk({ productIds: live.map((p) => p.productId), patch: { usePhPhotos: true } }, `PH edited photos on ${plural(live.length, 'shoe')} — checked again by the dry run.`)}>Use PH photos on all {fmt(live.length)}</button>
                </div>
              </BulkBlock>

              <BulkBlock k="titles" title="Titles" ok={!tidy.length && !live.some((p) => isNo(p, 'title'))} okText={`Every title is clean${titleMaxKnown ? ' and within SHEIN’s limit' : ''}.`}>
                {tidy.length > 0 && (
                  <>
                    <p className="xs">Tidied: extra spaces and emoji removed{titleMaxKnown ? ', cut at the last whole word within SHEIN’s limit' : ''}. Shopify’s titles are not changed.</p>
                    <ul className="shl-bulk-titles">{tidy.slice(0, 20).map((x) => <li key={x.p.productId} className="xs"><span className="shl-was">{x.cur}</span> → <b>{x.next}</b></li>)}</ul>
                    {tidy.length > 20 && <p className="muted xs">+ {fmt(tidy.length - 20)} more</p>}
                    <div className="shl-pub-acts">
                      <button type="button" className="btn xs shl-fix" onClick={() => bulk({ titles: Object.fromEntries(tidy.map((x) => [x.p.productId, x.next === cleanTitle(x.p.title || '') ? null : x.next])) }, `${plural(tidy.length, 'title')} tidied for SHEIN.`)}>Apply to {plural(tidy.length, 'title')}</button>
                    </div>
                  </>
                )}
                {!titleMaxKnown && <p className="muted xs">SHEIN’s title limit is read with the dry run (or with SHEIN’s rules for the category). Each title can also be edited in its row above.</p>}
              </BulkBlock>

              {boxNo && (
                <BulkBlock k="box" title="Box size / weight" ok={false}>
                  <p className="xs">Every new product needs its size group’s box. {canWrite ? 'Check the numbers, then confirm.' : `${NEEDS_PRIV} to confirm them.`}</p>
                  <BoxDefaults compact canWrite={canWrite} onSignOut={onSignOut} onSaved={() => saved('Box sizes confirmed for every new product.')} />
                </BulkBlock>
              )}
            </section>
          )}
        </div>
        <div className="shl-d-foot">
          <span className="muted xs shl-foot-lead">{d ? <>{fmt(ready.length)} ready · {fmt(fixing.length)} still need{fixing.length === 1 ? 's' : ''} fixing · nothing is sent by a dry run</> : ''}</span>
          <button type="button" className="btn ghost sm" onClick={onClose}>Close</button>
          <button type="button" className="btn primary sm" data-dry="publish-ready" disabled={!ready.length || !!busy || !!why}
            title={why || (ready.length ? `Dry run: what SHEIN would receive for the ${plural(ready.length, 'ready shoe')} — the ${fmt(fixing.length)} still to fix are left out. Nothing is sent until someone confirms.` : 'No shoe is ready yet — fix the ✕ lines first')}
            onClick={async () => { if (await onDryRun(ready.map((p) => p.productId), ['publish'])) onClose(); }}>{busy === 'preview' ? 'Starting…' : `Dry run publish (${fmt(ready.length)} ready)`}</button>
        </div>
      </aside>
    </>,
    document.body,
  );
}

function BulkBlock({ k, title, ok, okText, children }) {
  return (
    <div className={`shl-bulk-block${ok ? ' ok' : ''}`} data-fix={k}>
      <div className="shl-bulk-bhead"><span className={ok ? 'shl-yes' : 'shl-no'} aria-hidden="true">{ok ? '✓' : '✕'}</span><b className="sm">{title}</b></div>
      {ok ? (okText ? <p className="muted xs">{okText}</p> : null) : children}
    </div>
  );
}

// One shoe: what blocks it, at a glance. The title can be edited right here (saved per shoe).
function BulkRow({ p, onOpen, onSave }) {
  const [edit, setEdit] = useState(false);
  const shop = cleanTitle(p.title || '');
  const [text, setText] = useState(p.titleOverride || shop);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!edit) setText(p.titleOverride || shop); }, [p.titleOverride, p.title]); // eslint-disable-line react-hooks/exhaustive-deps
  const t = cleanTitle(text);
  const over = p.titleMax && t.length > p.titleMax;
  const no = (p.checklist || []).filter((l) => l.ok === false);
  const unread = (p.checklist || []).filter((l) => l.ok === null).length;
  return (
    <tr data-bulk-row={p.productId} data-ready={p.ready ? 'yes' : 'no'} className={p.ready ? '' : 'shl-chg'}>
      <td data-label="Shoe">
        <span className="shl-bulk-shoe">
          <RemoteThumb src={p.imageUrl} className="ebl-thumb shl-thumb" />
          <span className="shl-bulk-name">
            {!edit && <span className="shl-pname">{p.titleOverride || shop}</span>}
            {!edit && p.titleOverride && <span className="muted xs shl-block">SHEIN title · Shopify: {shop}</span>}
            {edit && (
              <span className="shl-bulk-tedit">
                <input className="input" value={text} maxLength={1000} aria-label={`SHEIN title for ${shop}`} aria-invalid={!!over} onChange={(e) => setText(e.target.value)} />
                <i className={over ? 'shl-field-bad' : 'form-modal-hint'}>{fmt(t.length)}{p.titleMax ? ` of ${fmt(p.titleMax)}` : ''} characters{over ? ` — ${fmt(t.length - p.titleMax)} too many` : ''}</i>
              </span>
            )}
            <span className="shl-pub-acts">
              {!edit && <button type="button" className="btn ghost xs" onClick={() => setEdit(true)}>Edit title</button>}
              {edit && <button type="button" className="btn ghost xs" disabled={busy} onClick={() => { setEdit(false); setText(p.titleOverride || shop); }}>Cancel</button>}
              {edit && p.titleOverride && <button type="button" className="btn ghost xs" disabled={busy} onClick={async () => { setBusy(true); if (await onSave(null)) setEdit(false); setBusy(false); }}>Use Shopify’s</button>}
              {edit && <button type="button" className="btn primary xs" disabled={busy || t.length < 2 || !!over || t === (p.titleOverride || shop)}
                onClick={async () => { setBusy(true); if (await onSave(t === shop ? null : t)) setEdit(false); setBusy(false); }}>{busy ? 'Saving…' : 'Save'}</button>}
              {onOpen && <button type="button" className="btn ghost xs" onClick={() => onOpen(p.productId)}>Details</button>}
            </span>
          </span>
        </span>
      </td>
      <td data-label="Style">{p.style ? <CopyText className="shl-mono" text={p.style}>{p.style}</CopyText> : <span className="muted">—</span>}</td>
      <td data-label="Type · size group">{p.productType || <span className="muted">(no type)</span>} · {p.sizeGroups.length ? p.sizeGroups.map((g) => GROUP_LABEL[g] || g).join(' + ') : <span className="muted">no size group</span>}
        {p.category?.path && <span className="muted xs shl-block">SHEIN: {p.category.path}</span>}</td>
      <td data-label="Vendor">{p.vendor || <span className="muted">—</span>}</td>
      <td data-label="What blocks it">
        <span className="shl-chiprow shl-bulk-chips">
          {!p.syncable && <span className="ebo-chip warn" data-chip="stock">{stockWhy(p)} — won’t be published</span>}
          {p.ready && <span className="ebo-chip ok" data-chip="ready">✓ Ready to dry run</span>}
          {no.filter((l) => !(l.key === 'shopify' && !p.syncable)).map((l) => <span key={l.key} className="ebo-chip bad" data-chip={l.key} title={(l.blockers || []).filter((b) => !['note', 'review'].includes(b.level)).map((b) => `${b.title} ${b.fix || ''}`).join(' · ')}>✕ {l.label}</span>)}
          {unread > 0 && <span className="ebo-chip" title="SHEIN’s store checks, photos, seller SKUs … — read by the dry run">{fmt(unread)} checked by the dry run</span>}
        </span>
        {no.length > 0 && <span className="xs muted shl-block">{(no[0].blockers || []).find((b) => !['note', 'review'].includes(b.level))?.fix || ''}</span>}
      </td>
    </tr>
  );
}

// One SHEIN product type's colour, set on every ticked shoe of that type.
function BulkColour({ g, onSave, onSignOut }) {
  const [t, setT] = useState(null);
  const [err, setErr] = useState('');
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    api.sheinPublishMaps('attr', { productTypeId: g.ptid }).then((r) => { if (live) setT(r); }).catch((e) => { if (e.unauthorized) onSignOut?.(); else if (live) setErr(e.message); });
    return () => { live = false; };
  }, [g.ptid]); // eslint-disable-line react-hooks/exhaustive-deps
  const main = t?.template?.main || null;
  const status = t?.template?.mainStatus;
  const values = (main?.values || []).filter((v) => status !== 3 || !/^(default|默认)$/i.test(v.label));
  const missing = g.list.filter((p) => isNo(p, 'colour') || p.skcValueId == null).length;
  const set = new Set(g.list.map((p) => p.skcValueId).filter((v) => v != null));
  return (
    <div className="shl-bulk-grp" data-group={`colour:${g.ptid}`}>
      <span className="sm">{g.path || `SHEIN type ${g.ptid}`} <span className="muted xs">— {plural(g.list.length, 'shoe')}{missing ? `, ${fmt(missing)} without a colour` : ''}{set.size > 1 ? ' (different colours now)' : ''}</span></span>
      {err && <p className="error xs">{err}</p>}
      {!t && !err && <div className="shl-skel shl-skel-line" />}
      {t && !main && <p className="notice xs">SHEIN’s colour list for this type hasn’t been read yet — a publish dry run reads it.</p>}
      {t && main && status === 1 && <p className="muted xs">SHEIN uses its own “Default” colour for this type — nothing to pick.</p>}
      {t && main && status !== 1 && (
        <span className="shl-bulk-colour">
          <select className="input" value={pick} onChange={(e) => setPick(e.target.value)} aria-label={`SHEIN colour for ${g.path || g.ptid}`}>
            <option value="">— pick a colour —</option>
            {values.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
          </select>
          <button type="button" className="btn xs shl-fix" disabled={busy || !pick} onClick={async () => { setBusy(true); if (await onSave(Number(pick))) setPick(''); setBusy(false); }}>{busy ? 'Saving…' : `Set on all ${fmt(g.list.length)}`}</button>
        </span>
      )}
    </div>
  );
}
