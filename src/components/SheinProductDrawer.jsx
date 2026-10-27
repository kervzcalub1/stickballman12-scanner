// SHEIN Listings → a product's Details drawer (`?product=<gid>`, refresh-proof). Shows the
// requirements checklist (the server's blockers, grouped), what SHEIN would receive per size
// (our size → SHEIN size: standard / custom-new, seller SKU, price, stock; "was …" for what
// changed), and the history (dry runs / sends of this product with their summary + status, SHEIN
// calls, EST). Footer: the two dry runs — "Add missing sizes" (Phase 2) and "Update prices &
// sizes" (Phase 3: SHEIN price, a size turned off, a wrong SKU) — server jobs that only read →
// the review sheet, where Send is; "Don't list on SHEIN" / "List on SHEIN again" only touch our
// database. Phase 3 diffs show as "was …" (amber) → the new value. Phase 4: a Shopify shoe NOT on
// SHEIN shows the server's 18-line publishing checklist instead (src/components/SheinPublishBits.jsx —
// each ✕ with its fix inline) and one dry run, "Publish new product".
import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api.js';
import { useLive } from '../hooks.js';
import { CopyText, RemoteThumb } from './common.jsx';
import { fmt, money, when, StatusChip, BlockerSay, FixButton } from './SheinListingsBits.jsx';
import { itemStatus } from '../lib/sheinListings.js';
import { NEEDS_PRIV } from './SheinListingsBits.jsx';
import { useFixes, UPDATE_OPS, isRise } from '../screens/SheinListingsProducts.jsx';
import { PublishChecklist } from './SheinPublishBits.jsx';

const CHECKS = [
  ['shopify', 'Active on Shopify', ['shopify_inactive']],
  ['skus', 'Every size has its own seller SKU', ['no_seller_sku', 'dup_seller_sku', 'seller_sku_taken']],
  ['links', 'SHEIN sizes carry the right seller SKUs', ['wrong_link', 'spu_spans_products']],
  ['sizes', 'Every in-stock size has a SHEIN size', ['size_needs_map', 'size_not_on_shein', 'size_unreadable', 'custom_text_invalid', 'no_size_table_value', 'multi_skc_size', 'size_field_retired']],
  ['price', 'Every size has a price', ['no_price']],
  ['shein', 'SHEIN hasn’t refused anything', ['review_rejected', 'shein_prevalid', 'api_error']],
];

export function SheinProductDrawer({ id, isAdmin, onClose, onAct, busy, onSignOut, active, connected, onDryRun, onOpenJob }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  async function load() {
    try { setD(await api.sheinListingProduct(id)); setErr(''); }
    catch (e) { if (e.unauthorized) onSignOut(); else setErr(e.message); }
  }
  useEffect(() => { setD(null); setErr(''); }, [id]);
  useLive(['shein_listing_products', 'shein_listing_variants', 'shein_size_map', 'shein_listing_job_items'], load);
  const { onFix, modal } = useFixes({ onAct, onSignOut, reload: load });
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !modal) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, modal]);

  const p = d?.product;
  const variants = d?.variants || [];
  const checks = useMemo(() => {
    if (!p) return [];
    const live = variants.filter((v) => v.status !== 'excluded');
    return CHECKS.map(([key, label, codes]) => {
      const hits = key === 'shopify' ? (p.blockers || []).filter((b) => codes.includes(b.code))
        : live.flatMap((v) => (v.blockers || []).filter((b) => codes.includes(b.code)).map((b) => ({ ...b, size: v.shopify_size })));
      return { key, label, ok: !hits.length, first: hits[0] || null, sizes: [...new Set(hits.map((h) => h.size).filter(Boolean))] };
    });
  }, [p, variants]);
  const reviewOpen = [1, 5].includes(Number(p?.review_state));
  const plan = variants.filter((v) => v.shopify_variant_id && v.status !== 'excluded');
  const onShein = plan.filter((v) => v.shein_sku);
  const toAdd = plan.filter((v) => !v.shein_sku);
  const toAddLive = toAdd.filter((v) => Number(v.shopify_qty) > 0);
  const toUpdate = onShein.filter((v) => v.diffs?.length);
  const isShopify = p && !String(p.shopify_product_id).startsWith('shein:');
  const isNew = isShopify && !p.spu;   // Phase 4: not on SHEIN at all → publish it
  const why = !connected ? 'Connect SHEIN first' : active ? `Job #${active.id} is running — dry run when it finishes` : p?.excluded ? 'Marked “Don’t list on SHEIN”' : '';
  const toFix = (d?.checklist || []).filter((l) => l.ok === false).length;
  // A shoe WE published: its latest publish send (in SHEIN's review, or refused / rejected → Publish again)
  const pubRun = !isNew && isShopify ? (d?.jobItems || []).find((i) => i.op === 'publish' && i.kind === 'run') || null : null;
  const pubRejected = pubRun?.status === 'failed' && (pubRun.blockers || []).some((b) => b.code === 'review_rejected');
  const republish = !!pubRun && pubRun.status === 'failed' && p?.status !== 'synced';

  return createPortal(
    <>
      <div className="shl-drawer-bg" onClick={onClose} aria-hidden="true" />
      <aside className="shl-drawer" role="dialog" aria-modal="true" aria-label="Product details">
        <div className="shl-d-head">
          {p ? <RemoteThumb src={p.image_url} className="ebl-thumb shl-thumb" /> : <span className="ebl-thumb ebl-thumb-empty shl-thumb" />}
          <div className="shl-d-title">
            <div className="shl-pname">{p?.title || (err ? 'Not found' : 'Loading…')}</div>
            {p && (
              <div className="shl-pmeta">
                {p.style && <CopyText className="shl-mono" text={p.style}>{p.style}</CopyText>}
                <StatusChip status={p.status} />
                {p.shopifyUrl && <a className="ebl-link" href={p.shopifyUrl} target="_blank" rel="noreferrer">Shopify ↗</a>}
                {p.spu && <span>SPU <CopyText className="shl-mono" text={p.spu}>{p.spu}</CopyText></span>}
              </div>
            )}
          </div>
          <button type="button" className="btn ghost sm shl-close" aria-label="Close" onClick={onClose}>✕</button>
        </div>
        <div className="shl-d-body">
          {err && <div className="shl-state"><p className="error">{err}</p><button type="button" className="btn ghost sm" onClick={onClose}>Close</button></div>}
          {!d && !err && <>{[0, 1, 2, 3].map((i) => <div key={i} className="shl-skel shl-skel-row" />)}</>}
          {p && (
            <>
              {isNew && d.checklist && <PublishChecklist d={d} canWrite={!!d.canWrite} busy={busy} onFix={onFix} onReload={load} onSignOut={onSignOut} onAct={onAct} />}
              {pubRun && ['in_review', 'failed', 'deferred'].includes(pubRun.status) && (
                <section className="shl-d-sec" data-published={pubRun.status}>
                  <h4 className="shl-h4">Published from this page</h4>
                  {pubRun.status === 'failed'
                    ? <p className="sm shl-pline bad">{pubRejected ? 'SHEIN rejected the new product in its review' : 'SHEIN refused the publish'}{pubRun.error ? <>: “{pubRun.error}”</> : '.'} {pubRejected ? 'Fix it, then an admin presses Publish again and checks a new dry run.' : 'Fix it, then dry run again.'}</p>
                    : <p className="sm shl-pline violet">Sent {when(pubRun.sent_at || pubRun.updated_at)} — SHEIN is reviewing the new product (hours to days). It shows In review until SHEIN approves it; then the live sync sets its stock.</p>}
                  <div className="shl-pub-acts">
                    <button type="button" className="btn ghost sm" onClick={() => onOpenJob?.(pubRun.job_id)}>Open the send #{pubRun.job_id}</button>
                    {pubRejected && (
                      <button type="button" className="btn sm shl-fix" disabled={!d.canWrite || !!busy} title={d.canWrite ? 'Lets it go to SHEIN again, then starts a new dry run for you to check (SHEIN may still count the old SKUs)' : NEEDS_PRIV}
                        onClick={async () => { if (await onAct('publish_again', { productIds: [p.shopify_product_id] }, 'Publish again allowed — check the new dry run, then publish.')) onDryRun?.([p.shopify_product_id], ['publish']); }}>Publish again</button>
                    )}
                  </div>
                </section>
              )}
              {!isNew && <section className="shl-d-sec">
                <h4 className="shl-h4">Requirements</h4>
                {checks.map((c) => (
                  <div key={c.key} className="shl-req">
                    <span className={c.ok ? 'shl-yes' : 'shl-no'} aria-label={c.ok ? 'OK' : 'Not OK'}>{c.ok ? '✓' : '✕'}</span>
                    <span>{c.ok ? c.label : <><BlockerSay b={c.first} />{c.sizes.length > 1 ? <span className="muted xs shl-block">Sizes: {c.sizes.join(', ')}</span> : null}</>}</span>
                    <span>{!c.ok && c.first?.action && <FixButton action={c.first.action} shopifyUrl={p.shopifyUrl} busy={busy}
                      onAct={(k) => onFix(k, variants.find((v) => (v.blockers || []).some((b) => b.code === c.first.code)) || {}, c.first)} />}</span>
                  </div>
                ))}
                <div className="shl-req">
                  <span className={reviewOpen ? 'shl-no' : 'shl-yes'}>{reviewOpen ? '…' : '✓'}</span>
                  <span>{reviewOpen ? 'SHEIN is reviewing an earlier edit — changes wait until it closes.' : 'No SHEIN review open'}</span><span />
                </div>
                {p.category_id && (
                  <div className="shl-req">
                    <span className="shl-yes">✓</span>
                    <span>SHEIN category <b>{p.category_id}</b></span><span />
                  </div>
                )}
              </section>}

              {isShopify && (
                <section className="shl-d-sec">
                  <h4 className="shl-h4">What SHEIN will receive</h4>
                  {!plan.length ? <p className="muted xs">No Shopify size to send.</p> : (
                    <table className="shl-rtable shl-plan">
                      <thead><tr><th>Our size</th><th>SHEIN size</th><th>Seller SKU</th><th className="num">Price</th><th className="num">Stock</th></tr></thead>
                      <tbody>
                        {[...toAdd, ...onShein].map((v) => {
                          const sp = v.size_plan;
                          const price = (v.diffs || []).find((x) => x.field === 'price');
                          const sp3 = (v.diffs || []).find((x) => x.field === 'shein_price');
                          const off = (v.diffs || []).some((x) => x.field === 'mall_state');
                          const sku = (v.diffs || []).find((x) => x.field === 'seller_sku');
                          const isNew = !v.shein_sku;
                          return (
                            <tr key={v.row_key} className={isNew || v.diffs?.length ? 'shl-chg' : ''}>
                              <td data-label="Our size"><b>{v.shopify_size}</b></td>
                              <td data-label="SHEIN size">{v.shein_sku ? <span>{v.shein_size} {off ? <span className="xs"><span className="shl-was">was turned off</span> → back on</span> : <span className="muted xs">on SHEIN</span>}</span>
                                : sp?.kind === 'custom' ? <span>✚ <b>{sp.label}</b> <span className="muted xs">custom size · new</span></span>
                                  : sp?.kind === 'value' ? <span>✚ <b>{sp.label}</b> <span className="muted xs">SHEIN size · new</span></span>
                                    : <span className="shl-bad-text xs">{v.blockers?.[0]?.title || 'no SHEIN size yet'}</span>}</td>
                              <td data-label="Seller SKU" className={sku ? '' : 'shl-mono'}>{sku ? <span><span className="muted xs shl-block">SHEIN has the wrong SKU:</span><span className="shl-was shl-mono">was {sku.from || '—'}</span> → will change to <b className="shl-mono">{sku.to}</b></span> : v.seller_sku || '—'}</td>
                              <td data-label="Price" className="num">{sp3 ? <span><span className="muted xs shl-block">SHEIN price</span><span className="shl-was">was {money(sp3.from)}</span> → <b>{money(sp3.to)}</b>{isRise(sp3) && <span className="shl-rise xs shl-block">↑ SHEIN may review it</span>}</span>
                                : price ? <span><span className="shl-was">was {money(price.from)}</span> → <b>{money(price.to)}</b></span> : money(v.shopify_price)}</td>
                              <td data-label="Stock" className="num">{isNew ? <span>0 <span className="muted xs">at first</span></span> : v.shein_qty == null ? '—' : fmt(v.shein_qty)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                  <p className="muted xs">Highlighted rows are new or changed on SHEIN; amber “was …” is what SHEIN has now. New sizes go up at stock 0; the live sync sets their stock once SHEIN approves. Stock never makes a size need an update.{isAdmin ? ' The exact request is on the dry run’s sheet.' : ''}</p>
                </section>
              )}

              <section className="shl-d-sec">
                <h4 className="shl-h4">History</h4>
                {!d.jobItems?.length && !d.log?.length && <p className="muted xs">Nothing yet{p.last_snapshot_at ? ` — last checked ${when(p.last_snapshot_at)}` : ''}.</p>}
                {d.jobItems?.map((it) => {
                  const st = ['preview', 'run'].includes(it.kind) ? itemStatus(it.kind, it.status) : { label: it.status, chip: 'ebo-chip' };
                  const label = it.kind === 'preview' ? 'Dry run' : it.kind === 'run' ? 'Send' : it.kind === 'snapshot' ? 'Re-read' : it.kind;
                  return (
                    <div key={`i${it.id}`} className="xs shl-hist shl-hist-item" data-hist={it.kind}>
                      <span>{when(it.updated_at || it.created_at)} · {label} #{it.job_id} · <span className={st.chip}>{st.label}</span>
                        {['preview', 'run'].includes(it.kind) && <> · <button type="button" className="shl-linkbtn" onClick={() => onOpenJob?.(it.job_id)}>Open</button></>}</span>
                      {it.summary && it.kind !== 'snapshot' && <span className="shl-block">{it.summary}</span>}
                      {it.status === 'failed' && it.error && it.error !== it.summary && <span className="shl-bad-text shl-block">SHEIN said: “{it.error}”</span>}
                    </div>
                  );
                })}
                {d.log?.map((l) => <p key={`l${l.id}`} className="xs muted shl-hist">{when(l.at)} · SHEIN {l.write ? 'write' : 'read'} {String(l.path || '').split('/').pop()} · {l.code === '0' ? 'OK' : `${l.code || l.http_status}: ${l.msg || ''}`}{l.trace_id ? ` · trace ${l.trace_id}` : ''}</p>)}
              </section>
            </>
          )}
        </div>
        <div className="shl-d-foot">
          {p && isShopify && (p.excluded
            ? <button type="button" className="btn ghost sm" disabled={!!busy} onClick={async () => { if (await onAct('include', { productIds: [p.shopify_product_id] }, 'Listed on SHEIN again.')) load(); }}>List on SHEIN again</button>
            : <button type="button" className="btn ghost sm" disabled={!!busy} title="Our records only — nothing changes on SHEIN" onClick={async () => { if (await onAct('exclude', { productIds: [p.shopify_product_id] }, 'Marked “Don’t list on SHEIN” (our records only).')) load(); }}>Don’t list on SHEIN</button>)}
          {p && isShopify && <span className="muted xs shl-foot-lead">Dry run first — nothing is sent:</span>}
          {(isNew || republish) && (
            <button type="button" className="btn primary sm" disabled={!!busy || !!why} data-dry="publish"
              title={why || `Dry run: what SHEIN would receive for this new product — category, brand, photos, sizes, prices. ${toFix ? `${toFix} line${toFix === 1 ? '' : 's'} still to fix; the dry run says why it can’t go yet.` : ''} Nothing is sent until someone confirms.`}
              onClick={() => onDryRun?.([p.shopify_product_id], ['publish'])}>{busy === 'preview' ? 'Starting…' : 'Publish new product'}</button>
          )}
          {p && isShopify && !isNew && !republish && (
            <button type="button" className={`btn ${toUpdate.length && !toAddLive.length ? 'ghost' : 'primary'} sm`} disabled={!!busy || !!why || !toAdd.length} data-dry="add"
              title={why || (!toAdd.length ? 'Every Shopify size is already on SHEIN' : `Dry run: add ${fmt(toAdd.length)} size${toAdd.length === 1 ? '' : 's'} SHEIN doesn’t have. Nothing is sent until someone confirms.`)}
              onClick={() => onDryRun?.([p.shopify_product_id])}>{busy === 'preview' ? 'Starting…' : 'Add missing sizes'}</button>
          )}
          {p && isShopify && !isNew && !republish && (
            <button type="button" className={`btn ${toUpdate.length && !toAddLive.length ? 'primary' : 'ghost'} sm`} disabled={!!busy || !!why || !toUpdate.length} data-dry="update"
              title={why || (!toUpdate.length ? 'Nothing on SHEIN differs — no size needs an update' : `Dry run: ${fmt(toUpdate.length)} size${toUpdate.length === 1 ? '' : 's'} with a SHEIN price, a size turned off or a wrong SKU. Nothing is sent until someone confirms.`)}
              onClick={() => onDryRun?.([p.shopify_product_id], UPDATE_OPS)}>{busy === 'preview' ? 'Starting…' : 'Update prices & sizes'}</button>
          )}
        </div>
      </aside>
      {modal}
    </>,
    document.body,
  );
}
