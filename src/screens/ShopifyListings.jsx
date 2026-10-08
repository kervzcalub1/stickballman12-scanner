// Shopify Listings (PH) — the store as a searchable table you work from
// (docs/context/shopify-listings.md). Loads every listing on open; one row per product,
// click to open its sizes. From the table:
//   · price — type one, or "Use suggested" (Alias market + markup, BOTH directions)
//   · compare-at price, product title, status (Active / Draft / Archived)
// Edits are DRAFTS until Save → a confirm listing what changes → written live to Shopify.
// Market prices are fetched on demand — for the products you open, or "Price N sizes"
// for everything the search is showing — and remembered for the day.
import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { TopBar, Modal, ProgressBar, ShoeThumb } from '../components/common.jsx';
import { useMarketPrices } from '../components/MarketPrices.jsx';
import { useUnsavedGuard } from '../hooks.js';
import { PH_DATETIME } from '../lib/format.js';
import { parseMarkup, multiplierLabel, priceCents } from '../lib/ebayReprice.js';
import {
  groupProducts, productMatches, jobsFor, suggestion, inStock, priceable, STATUSES, BIG_SWING,
  emptyDrafts, setVariantDraft, setProductDraft, draftSuggested, summarizeDrafts, savePayloads, centsToPrice,
} from '../lib/shopifyListings.js';

const PAGE = 50;
const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const usd = (cents) => (cents == null ? '—' : `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`);
const signed = (cents) => `${cents > 0 ? '+' : cents < 0 ? '−' : ''}${usd(Math.abs(cents))}`;
const statusLabel = (s) => STATUSES.find(([k]) => k === s)?.[1] || s || '—';
const numericId = (gid) => String(gid || '').split('/').pop();

function StatusPill({ status }) {
  return <span className={`sl-status ${String(status || '').toLowerCase()}`}>{statusLabel(status)}</span>;
}

// One size inside an open product.
function SizeRow({ v, draft, sug, onDraft, error }) {
  const price = draft?.price ?? v.price;
  const compareAt = draft && 'compareAt' in draft ? draft.compareAt ?? '' : v.compareAt ?? '';
  const priceChanged = !!draft && 'price' in draft;
  const cmpChanged = !!draft && 'compareAt' in draft;
  return (
    <tr className={inStock(v) ? '' : 'sl-oos'}>
      <td data-label="Size"><b>{v.size}</b></td>
      <td data-label="Qty" className="muted">{v.qty ?? '—'}</td>
      <td data-label="Price">
        <span className={`sl-money${priceChanged ? ' changed' : ''}`}>$<input type="text" inputMode="decimal" value={price}
          aria-label={`Price size ${v.size}`} onChange={(e) => onDraft({ price: e.target.value, source: 'manual', marketCents: null })} /></span>
        {priceChanged && <div className="muted xs">was ${v.price}{draft.source === 'market' ? ' · market' : ''}</div>}
      </td>
      <td data-label="Compare at">
        <span className={`sl-money${cmpChanged ? ' changed' : ''}`}>$<input type="text" inputMode="decimal" value={compareAt} placeholder="—"
          aria-label={`Compare-at size ${v.size}`} onChange={(e) => onDraft({ compareAt: e.target.value })} /></span>
      </td>
      <td data-label="Market" className="muted">
        {sug.state === 'ok' ? usd(sug.marketCents) : sug.state === 'no_style' ? <span className="xs">no style code</span>
          : sug.state === 'no_data' ? <span className="xs" title={sug.why}>no data</span> : <span className="xs">—</span>}
      </td>
      <td data-label="Suggested">
        {sug.state === 'ok' && (
          <span className="sl-sug">
            <b>{usd(sug.suggestedCents)}</b>
            {sug.kind !== 'same'
              ? <span className={sug.kind === 'lower' ? 'sr-down' : 'sr-up'}> {signed(sug.diffCents)}</span>
              : <span className="muted xs"> ✓</span>}
            {sug.big && <span className="sr-flag" title={`Over ${BIG_SWING * 100}% — check the style code`}> big swing</span>}
          </span>
        )}
      </td>
      <td>
        {sug.state === 'ok' && sug.kind !== 'same' && (
          <button type="button" className="btn xs" onClick={() => onDraft({ price: centsToPrice(sug.suggestedCents), source: 'market', marketCents: sug.marketCents })}>Use</button>
        )}
        {error && <div className="error xs">{error}</div>}
      </td>
    </tr>
  );
}

function ProductPanel({ p, drafts, setDrafts, cache, pctH, errors, onPrice, pricing }) {
  const pd = drafts.products[p.productId] || {};
  const need = p.variants.filter((v) => priceable(v) && suggestion(v, cache, pctH).state === 'not_priced');
  const sugs = p.variants.map((v) => suggestion(v, cache, pctH, drafts.variants[v.variantId]?.price ?? v.price));
  const usable = p.variants.filter((v, i) => sugs[i].state === 'ok' && sugs[i].kind !== 'same' && !sugs[i].big);
  return (
    <div className="sl-panel">
      <div className="sl-fields">
        <label className="sl-field sl-title-field"><span className="muted xs">Title</span>
          <input value={pd.title ?? p.title} aria-label="Product title" className={'title' in pd ? 'changed' : ''}
            onChange={(e) => setDrafts((d) => setProductDraft(d, p, { title: e.target.value }))} />
          {!p.style && <span className="muted xs">No style code in this title, so it can’t be priced — add one, e.g. “… (DD1503-101)”.</span>}
        </label>
        <label className="sl-field"><span className="muted xs">Status</span>
          <select value={pd.status ?? p.status} aria-label="Product status" className={'status' in pd ? 'changed' : ''}
            onChange={(e) => setDrafts((d) => setProductDraft(d, p, { status: e.target.value }))}>
            {STATUSES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
        <div className="sl-panel-actions">
          {need.length > 0 && <button type="button" className="btn sm" disabled={pricing} onClick={() => onPrice(need)}>Get market prices</button>}
          {usable.length > 0 && <button type="button" className="btn sm primary" onClick={() => setDrafts((d) => draftSuggested(d, usable, cache, pctH).drafts)}>Use suggested for {usable.length}</button>}
        </div>
      </div>
      <div className="ap-tablewrap">
        <table className="table sl-sizes">
          <thead><tr><th>Size</th><th>Qty</th><th>Price</th><th>Compare at</th><th>Market</th><th>Suggested (× {pctH == null ? '—' : multiplierLabel(pctH)})</th><th /></tr></thead>
          <tbody>
            {p.variants.map((v, i) => (
              <SizeRow key={v.variantId} v={v} draft={drafts.variants[v.variantId]} sug={sugs[i]} error={errors[v.variantId]}
                onDraft={(patch) => setDrafts((d) => setVariantDraft(d, v, patch))} />
            ))}
          </tbody>
        </table>
      </div>
      {errors[p.productId] && <div className="error xs mt">{errors[p.productId]}</div>}
    </div>
  );
}

function RecentEdits({ stamp, onSignOut }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    api.shopifyListingsHistory().then((r) => { setRows(r.rows || []); setError(''); })
      .catch((err) => { if (err.unauthorized) return onSignOut(); setError(err.message); });
  }, [open, stamp]); // eslint-disable-line react-hooks/exhaustive-deps
  const show = (r) => (r.field === 'price' || r.field === 'compare_at' ? (r.new_value == null ? '—' : `$${Number(r.new_value).toFixed(2)}`) : r.field === 'status' ? statusLabel(r.new_value) : r.new_value);
  const was = (r) => (r.field === 'price' || r.field === 'compare_at' ? (r.old_value == null ? '—' : `$${Number(r.old_value).toFixed(2)}`) : r.field === 'status' ? statusLabel(r.old_value) : r.old_value);
  return (
    <div className="card">
      <button type="button" className="sl-collapse" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span>{open ? '▾' : '▸'}</span> Recent changes made here
      </button>
      {open && (error ? <div className="error mt">{error}</div> : rows == null ? <p className="muted">Loading…</p> : !rows.length ? <p className="muted">Nothing changed from here yet.</p> : (
        <div className="ap-tablewrap mt">
          <table className="table sr-table">
            <thead><tr><th>When</th><th>Product</th><th>Size</th><th>Field</th><th>From</th><th>To</th><th>By</th></tr></thead>
            <tbody>
              {rows.slice(0, 100).map((r) => (
                <tr key={r.id}>
                  <td className="xs muted">{PH_DATETIME.format(new Date(r.changed_at))} EST</td>
                  <td><div className="sr-title">{r.product_title}</div></td>
                  <td>{r.size || '—'}</td>
                  <td className="xs">{r.field.replace('_', '-')}{r.source === 'market' ? <span className="muted"> · market {r.market_cents != null ? usd(r.market_cents) : ''} +{Number(r.markup_pct)}%</span> : ''}</td>
                  <td className="muted">{was(r)}</td>
                  <td><b>{show(r)}</b></td>
                  <td className="xs">{r.changed_by}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

export function ShopifyListings({ onHome, onSignOut }) {
  const [variants, setVariants] = useState(null);
  const [adminStore, setAdminStore] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [q, setQ] = useState('');
  const [statusF, setStatusF] = useState('ACTIVE');
  const [stockOnly, setStockOnly] = useState(true);
  const [changesOnly, setChangesOnly] = useState(false);
  const [markup, setMarkup] = useState('12');   // never remembered: every visit starts at 12 %
  const [open, setOpen] = useState(() => new Set());
  const [shown, setShown] = useState(PAGE);
  const [drafts, setDrafts] = useState(emptyDrafts);
  const [errors, setErrors] = useState({});
  const [confirm, setConfirm] = useState(false);
  const [saving, setSaving] = useState(null);
  const [saved, setSaved] = useState(null);
  const [stamp, setStamp] = useState(0);
  const mp = useMarketPrices([], onSignOut);
  const pctH = parseMarkup(markup);
  const dirty = Object.keys(drafts.variants).length + Object.keys(drafts.products).length > 0;
  useUnsavedGuard(dirty || !!saving);

  async function load() {
    setLoading(true); setLoadError('');
    try {
      const r = await api.shopifyListingsVariants();
      setVariants(r.variants || []);
      setAdminStore(r.adminStore || '');
      if (r.truncated) setLoadError('Shopify has more listings than one load reads (20,000) — the rest are not shown.');
    } catch (err) { if (err.unauthorized) return onSignOut(); setLoadError(err.message); } finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const products = useMemo(() => (variants ? groupProducts(variants) : []), [variants]);
  const variantsById = useMemo(() => new Map((variants || []).map((v) => [v.variantId, v])), [variants]);
  const productsById = useMemo(() => new Map(products.map((p) => [p.productId, p])), [products]);
  // A product's sizes as the filters see them (in-stock only, unless switched off).
  const sizesOf = (p) => (stockOnly ? p.variants.filter(inStock) : p.variants);
  const filtered = useMemo(() => products.filter((p) => {
    if (statusF !== 'ALL' && p.status !== statusF) return false;
    if (stockOnly && !p.variants.some(inStock)) return false;
    if (!productMatches(p, q)) return false;
    if (changesOnly) {
      const any = sizesOf(p).some((v) => { const s = suggestion(v, mp.cache, pctH); return s.state === 'ok' && s.kind !== 'same'; });
      if (!any) return false;
    }
    return true;
  }), [products, statusF, stockOnly, q, changesOnly, mp.cache, pctH]); // eslint-disable-line react-hooks/exhaustive-deps
  const viewSizes = useMemo(() => filtered.flatMap(sizesOf), [filtered]); // eslint-disable-line react-hooks/exhaustive-deps
  const viewJobs = useMemo(() => jobsFor(viewSizes).filter((j) => !mp.cache[`${j.sku}|${j.size}`]), [viewSizes, mp.cache]);
  const viewUsable = useMemo(() => viewSizes.filter((v) => { const s = suggestion(v, mp.cache, pctH); return s.state === 'ok' && s.kind !== 'same' && !s.big; }), [viewSizes, mp.cache, pctH]);
  const sum = useMemo(() => summarizeDrafts(drafts, variantsById), [drafts, variantsById]);
  const pricing = mp.state.running;

  function toggleOpen(p) {
    setOpen((cur) => { const n = new Set(cur); if (n.has(p.productId)) n.delete(p.productId); else n.add(p.productId); return n; });
    // Opening a product prices its sizes if they aren't known yet (cheap: a dozen lookups).
    const need = jobsFor(sizesOf(p)).filter((j) => !mp.cache[`${j.sku}|${j.size}`]);
    if (!open.has(p.productId) && need.length && !pricing) mp.run(need);
  }

  async function save() {
    setConfirm(false);
    const payloads = savePayloads(drafts, variantsById, productsById, pctH);
    const vRes = [];
    const pRes = [];
    let code;
    let done = 0;
    const total = payloads.reduce((n, b) => n + b.variants.length + b.products.length, 0);
    setSaving({ done, total });
    for (const body of payloads) {
      try {
        const r = await api.shopifyListingsSave(body);
        vRes.push(...(r.variants || []));
        pRes.push(...(r.products || []));
        code = code || r.code;
      } catch (err) {
        if (err.unauthorized) return onSignOut();
        code = code || err.data?.code;
        vRes.push(...body.variants.map((v) => ({ variantId: v.variantId, status: 'failed', error: err.message })));
        pRes.push(...body.products.map((p) => ({ productId: p.productId, status: 'failed', error: err.message })));
      }
      done += body.variants.length + body.products.length;
      setSaving({ done, total });
      if (code === 'denied' || code === 'unauthorized') break;
    }
    // Shopify's answer becomes what we hold; succeeded drafts go, failed ones stay with a reason.
    const vBy = new Map(vRes.map((x) => [x.variantId, x]));
    const pBy = new Map(pRes.map((x) => [x.productId, x]));
    setVariants((vs) => vs.map((v) => {
      const x = vBy.get(v.variantId);
      const px = pBy.get(v.productId);
      let next = v;
      if (x && (x.status === 'updated' || x.status === 'conflict' || x.status === 'same')) next = { ...next, price: x.price ?? next.price, compareAt: x.compareAt !== undefined ? x.compareAt : next.compareAt };
      if (px && (px.status === 'updated' || px.status === 'conflict' || px.status === 'same')) next = { ...next, productTitle: px.title ?? next.productTitle, status: px.statusValue ?? next.status };
      return next;
    }));
    setDrafts((d) => ({
      variants: Object.fromEntries(Object.entries(d.variants).filter(([id]) => { const x = vBy.get(id); return x && (x.status === 'failed' || x.status === 'conflict'); })),
      products: Object.fromEntries(Object.entries(d.products).filter(([id]) => { const x = pBy.get(id); return x && (x.status === 'failed' || x.status === 'conflict'); })),
    }));
    setErrors(Object.fromEntries([...vRes, ...pRes].filter((x) => x.error).map((x) => [x.variantId || x.productId, x.error])));
    const all = [...vRes, ...pRes];
    setSaved({ code, n: all.reduce((t, x) => ({ ...t, [x.status]: (t[x.status] || 0) + 1 }), {}), firstError: all.find((x) => x.status === 'failed')?.error });
    setSaving(null);
    setStamp((n) => n + 1);
  }

  const totalInView = filtered.length;
  return (
    <div className="app">
      <TopBar title="Shopify Listings" onHome={onHome} onSignOut={onSignOut} />

      <div className="card sl-toolbar">
        <div className="sl-search-row">
          <input type="search" className="sl-search" value={q} onChange={(e) => { setQ(e.target.value); setShown(PAGE); }}
            placeholder="Search title, style code or SKU…" aria-label="Search listings" />
          <button type="button" className="btn ghost sm" onClick={load} disabled={loading || !!saving || dirty} title={dirty ? 'Save or discard your edits first' : 'Reload from Shopify'}>{loading ? 'Loading…' : '↻ Reload'}</button>
        </div>
        <div className="sl-filters">
          <div className="seg sm" role="group" aria-label="Status">
            {[['ACTIVE', 'Active'], ['DRAFT', 'Draft'], ['ARCHIVED', 'Archived'], ['ALL', 'All']].map(([k, l]) => (
              <button key={k} type="button" className={`seg-btn${statusF === k ? ' on' : ''}`} aria-pressed={statusF === k} onClick={() => { setStatusF(k); setShown(PAGE); }}>{l}</button>
            ))}
          </div>
          <label className="er-dry"><input type="checkbox" checked={stockOnly} onChange={(e) => setStockOnly(e.target.checked)} /> In stock</label>
          <label className="er-dry"><input type="checkbox" checked={changesOnly} onChange={(e) => setChangesOnly(e.target.checked)} /> Price off market</label>
          <label className="sl-markup"><span className="muted xs">Markup</span>
            <input type="text" inputMode="decimal" value={markup} aria-label="Markup percent" onChange={(e) => setMarkup(e.target.value)} /> %
            {pctH == null && <span className="error xs"> 0–100</span>}
          </label>
        </div>
        <div className="sl-pricing">
          <span className="muted sm">{loading && !variants ? 'Loading listings from Shopify…' : `${fmt(totalInView)} product${totalInView === 1 ? '' : 's'} · ${fmt(viewSizes.length)} sizes`}</span>
          {pricing ? (
            <span className="sl-progress">
              <ProgressBar value={mp.state.queued ? mp.state.doneThisRun / mp.state.queued : 0} label={`Getting market prices… ${fmt(mp.state.doneThisRun)} of ${fmt(mp.state.queued || 0)}${mp.state.pausedFor ? ` · pausing ${mp.state.pausedFor}s` : ''}`} />
              <button type="button" className="btn xs" onClick={mp.pause}>Stop</button>
            </span>
          ) : (
            <>
              {viewJobs.length > 0 && <button type="button" className="btn sm" onClick={() => mp.run(viewJobs)}>Get market prices for {fmt(viewJobs.length)} size{viewJobs.length === 1 ? '' : 's'}{viewJobs.length > 300 ? ` (~${Math.ceil(viewJobs.length / 110)} min)` : ''}</button>}
              {viewUsable.length > 0 && <button type="button" className="btn sm primary" onClick={() => setDrafts((d) => draftSuggested(d, viewUsable, mp.cache, pctH).drafts)}>Use suggested for {fmt(viewUsable.length)} size{viewUsable.length === 1 ? '' : 's'}</button>}
            </>
          )}
        </div>
        {mp.state.unresolved.length > 0 && !pricing && <div className="error xs mt">{fmt(mp.state.unresolved.length)} market lookups failed after retries ({mp.state.unresolved[0].error}) — press Get market prices again.</div>}
        {loadError && <div className="error mt">{loadError}</div>}
      </div>

      {saved && (
        <div className={`er-verify ${saved.code || saved.n.failed ? 'fail' : 'pass'}`}>
          <b>{saved.code || saved.n.failed ? '✗ Some changes did not go through' : '✓ Saved to Shopify'}</b>
          <ul>
            <li>{fmt(saved.n.updated || 0)} updated</li>
            {saved.n.conflict ? <li>{fmt(saved.n.conflict)} skipped — changed in Shopify since you loaded it (now showing Shopify’s value; your edit is kept to review)</li> : null}
            {saved.n.failed ? <li>{fmt(saved.n.failed)} failed — {saved.firstError}</li> : null}
          </ul>
          <button type="button" className="btn xs ghost" onClick={() => setSaved(null)}>Dismiss</button>
        </div>
      )}

      <div className="card sl-list">
        {!variants ? <p className="muted">{loading ? 'Loading listings from Shopify…' : 'Couldn’t load the listings.'}</p> : !filtered.length ? <p className="muted">No listings match.</p> : (
          <>
            {filtered.slice(0, shown).map((p) => {
              const sizes = sizesOf(p);
              const isOpen = open.has(p.productId);
              const prices = sizes.map((v) => priceCents(drafts.variants[v.variantId]?.price ?? v.price)).filter((c) => c != null);
              const lo = Math.min(...prices);
              const hi = Math.max(...prices);
              const sugs = sizes.map((v) => suggestion(v, mp.cache, pctH, drafts.variants[v.variantId]?.price ?? v.price)).filter((s) => s.state === 'ok');
              const down = sugs.filter((s) => s.kind === 'lower').length;
              const up = sugs.filter((s) => s.kind === 'raise').length;
              const edited = p.variants.some((v) => drafts.variants[v.variantId]) || !!drafts.products[p.productId];
              const pd = drafts.products[p.productId];
              return (
                <div key={p.productId} className={`sl-product${isOpen ? ' open' : ''}${edited ? ' edited' : ''}`}>
                  <div className="sl-row">
                  <button type="button" className="sl-row-main" aria-expanded={isOpen} onClick={() => toggleOpen(p)}>
                    <span className="sl-caret" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
                    <ShoeThumb url={p.image} size={40} />
                    <span className="sl-name">
                      <span className="sl-title">{pd?.title ?? p.title}</span>
                      <span className="muted xs">{p.style || <span className="sl-nocode">no style code</span>}</span>
                    </span>
                    <StatusPill status={pd?.status ?? p.status} />
                    <span className="sl-cell muted xs">{fmt(sizes.length)} size{sizes.length === 1 ? '' : 's'} · {(() => { const n = sizes.reduce((t, x) => t + Math.max(0, x.qty || 0), 0); return `${fmt(n)} pair${n === 1 ? '' : 's'}`; })()}</span>
                    <span className="sl-cell">{prices.length ? (lo === hi ? usd(lo) : `${usd(lo)}–${usd(hi)}`) : '—'}</span>
                    <span className="sl-cell sl-chips">
                      {down > 0 && <span className="sl-chip down">{down} ↓</span>}
                      {up > 0 && <span className="sl-chip up">{up} ↑</span>}
                      {edited && <span className="sl-chip edit">edited</span>}
                    </span>
                  </button>
                    {adminStore && <a className="sl-admin" href={`https://admin.shopify.com/store/${adminStore}/products/${numericId(p.productId)}`} target="_blank" rel="noreferrer"
                      title="Open in Shopify admin" aria-label={`Open ${p.title} in Shopify admin`}>↗</a>}
                  </div>
                  {isOpen && <ProductPanel p={{ ...p, variants: sizes }} drafts={drafts} setDrafts={setDrafts} cache={mp.cache} pctH={pctH} errors={errors}
                    pricing={pricing} onPrice={(vs) => mp.run(jobsFor(vs))} />}
                </div>
              );
            })}
            {filtered.length > shown && <button type="button" className="btn ghost sm mt" onClick={() => setShown((n) => n + PAGE)}>Show {fmt(Math.min(PAGE, filtered.length - shown))} more of {fmt(filtered.length - shown)}</button>}
          </>
        )}
      </div>

      <RecentEdits stamp={stamp} onSignOut={onSignOut} />

      {(dirty || saving) && (
        <div className="sl-savebar">
          {saving ? <ProgressBar value={saving.total ? saving.done / saving.total : 0} label={`Saving to Shopify… ${fmt(saving.done)} of ${fmt(saving.total)}`} /> : (
            <>
              <span className="sm"><b>{fmt(sum.total)} change{sum.total === 1 ? '' : 's'}</b>
                {sum.prices ? ` · ${fmt(sum.prices)} price${sum.prices === 1 ? '' : 's'} (${signed(sum.cutCents)} / ${signed(sum.raiseCents)})` : ''}
                {sum.compareAt ? ` · ${fmt(sum.compareAt)} compare-at` : ''}{sum.titles ? ` · ${fmt(sum.titles)} title${sum.titles === 1 ? '' : 's'}` : ''}{sum.statuses ? ` · ${fmt(sum.statuses)} status` : ''}</span>
              <span className="sl-savebar-actions">
                <button type="button" className="btn ghost sm" onClick={() => { setDrafts(emptyDrafts()); setErrors({}); }}>Discard</button>
                <button type="button" className="btn primary sm" onClick={() => setConfirm(true)}>Review &amp; save</button>
              </span>
            </>
          )}
        </div>
      )}

      {confirm && (
        <Modal type="warn" title={`Save ${fmt(sum.total)} change${sum.total === 1 ? '' : 's'} to Shopify?`}
          message={[
            sum.prices ? `${fmt(sum.prices)} price${sum.prices === 1 ? '' : 's'}: ${signed(sum.cutCents)} in cuts, ${signed(sum.raiseCents)} in raises.` : '',
            sum.compareAt ? `${fmt(sum.compareAt)} compare-at price${sum.compareAt === 1 ? '' : 's'}.` : '',
            sum.titles ? `${fmt(sum.titles)} title${sum.titles === 1 ? '' : 's'}.` : '',
            sum.statuses ? `${fmt(sum.statuses)} status change${sum.statuses === 1 ? '' : 's'} (Draft / Archived take a product off the store).` : '',
            'Live straight away — and on any sales channel that takes its listing from Shopify.',
          ].filter(Boolean).join(' ')}
          onClose={() => setConfirm(false)}>
          <button type="button" className="btn ghost" onClick={() => setConfirm(false)}>Cancel</button>
          <button type="button" className="btn primary" onClick={save}>Save {fmt(sum.total)}</button>
        </Modal>
      )}
    </div>
  );
}
