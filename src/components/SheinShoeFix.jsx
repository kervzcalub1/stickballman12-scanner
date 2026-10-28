// SHEIN Listings → Details → "Fix SHEIN sizes" (docs/context/shein-live-fix.md → "One shoe"). For ONE
// shoe already on SHEIN: Match sizes in place (each SHEIN size → the same-size Shopify SKU it should
// carry, or take it off SHEIN — saved in shein_links, the same decisions the SHEIN check page saves),
// then the live fix for this shoe only: "Dry run this shoe" (reads, writes nothing — PH) and "Fix this
// shoe" (seller SKUs + stock, read back — admin / Connect integrations, after a fresh dry run). A
// server job: closing the drawer never stops it. No store-wide scan.
import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useLive } from '../hooks.js';
import { compareSize } from '../lib/sheinCheck.js';
import { fmt, when, NEEDS_PRIV } from './SheinListingsBits.jsx';

const FRESH_MIN = 30;   // "Fix this shoe" needs a dry run of it from the last 30 minutes
const sameSize = (sheinSize, shopifySize) => ['ok', 'ok_suffix', 'check_group'].includes(compareSize(sheinSize, shopifySize));
const tone = (it) => (it.result === 'failed' || it.result === 'mismatch' ? 'bad' : it.reason !== 'ok' && it.reason !== 'gone' ? 'warn' : it.result === 'changed' || it.wrote === 'dry' ? 'info' : 'ok');
const RESULT = { changed: 'changes', ok: 'no change', skipped: 'not changed', failed: 'refused', mismatch: 'SHEIN shows old stock' };

export function SheinShoeFix({ p, variants, canWrite, connected, open: openProp, onSignOut, onReload }) {
  const spus = useMemo(() => [...new Set(variants.filter((v) => v.shein_sku && v.spu).map((v) => v.spu))], [variants]);
  const [spu, setSpu] = useState(p.spu || spus[0] || null);
  useEffect(() => { if (!spu || !spus.includes(spu)) setSpu(p.spu || spus[0] || null); }, [p.spu, spus.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [pick, setPick] = useState({});   // SHEIN SKU → '' (leave) | Shopify SKU | 'delist'

  async function load() {
    if (!spu) return;
    try { setD(await api.sheinShoe(spu)); setErr(''); }
    catch (e) { if (e.unauthorized) onSignOut(); else setErr(e.message); }
  }
  useEffect(() => { setD(null); setPick({}); load(); }, [spu]); // eslint-disable-line react-hooks/exhaustive-deps
  const run = d?.run || null;
  const running = run?.status === 'running';
  useLive(['shein_live_runs', 'shein_live_items', 'shein_links'], load, { mount: false, every: running ? 3_000 : 60_000 });
  const wasRunning = React.useRef(false);
  useEffect(() => { if (wasRunning.current && !running) onReload?.(); wasRunning.current = running; }, [running]); // eslint-disable-line react-hooks/exhaustive-deps

  // This SHEIN product's sizes (matched + SHEIN-only), and the Shopify sizes of this shoe.
  const shein = useMemo(() => variants.filter((v) => v.shein_sku && v.spu === spu)
    .sort((a, b) => String(a.shein_size).localeCompare(String(b.shein_size), 'en', { numeric: true })), [variants, spu]);
  const shopify = useMemo(() => variants.filter((v) => v.shopify_variant_id && v.seller_sku), [variants]);
  const links = useMemo(() => new Map((d?.links || []).map((l) => [String(l.shein_sku), l])), [d]);
  const savedOf = (sk) => { const l = links.get(String(sk)); return !l ? '' : l.decision === 'delist' ? 'delist' : l.link_sku || ''; };
  const valueOf = (sk) => (pick[sk] !== undefined ? pick[sk] : savedOf(sk));
  const changes = shein.filter((v) => valueOf(v.shein_sku) !== savedOf(v.shein_sku));
  const needs = shein.some((v) => v.status === 'blocked' || v.status === 'shein_only' || (v.blockers || []).some((b) => ['wrong_link', 'spu_spans_products'].includes(b.code)));

  async function save() {
    setBusy('save'); setMsg(''); setErr('');
    try {
      const set = changes.filter((v) => valueOf(v.shein_sku));
      const clear = changes.filter((v) => !valueOf(v.shein_sku)).map((v) => v.shein_sku);
      if (set.length) {
        await api.sheinLinksSave(set.map((v) => {
          const want = valueOf(v.shein_sku);
          return { sheinSku: v.shein_sku, spu: v.spu, skc: v.skc, sheinSize: v.shein_size, sellerSkuWas: v.shein_seller_sku || null,
            linkSku: want === 'delist' ? null : want, decision: want === 'delist' ? 'delist' : 'link', source: 'person' };
        }));
      }
      if (clear.length) await api.sheinLinksClear(clear);
      setPick({}); setMsg(`Saved ${changes.length} choice${changes.length === 1 ? '' : 's'} — now dry run this shoe.`);
      await load(); onReload?.();
    } catch (e) { if (e.unauthorized) onSignOut(); else setErr(e.message); }
    finally { setBusy(''); }
  }
  async function start(mode) {
    if (mode === 'full' && !window.confirm('Fix this shoe on SHEIN now? Seller SKU changes go to SHEIN’s review; stock is set straight away.')) return;
    setBusy(mode); setMsg(''); setErr('');
    try { await api.sheinLiveAction({ action: 'shoe', spu, mode, productId: p.shopify_product_id }); await load(); }
    catch (e) { if (e.unauthorized) onSignOut(); else setErr(e.message); }
    finally { setBusy(''); }
  }

  if (!spu) return null;
  const lastDecided = Math.max(0, ...(d?.links || []).map((l) => new Date(l.decided_at).getTime() || 0));
  const dryOk = run?.mode === 'shoe:dry' && run.status === 'done' && run.finished_at
    && Date.now() - new Date(run.finished_at).getTime() < FRESH_MIN * 60_000 && lastDecided <= new Date(run.started_at).getTime();
  const blocked = !connected ? 'Connect SHEIN first' : running ? 'Running…' : d?.walkRunning ? 'The full SHEIN walk is running — try again when it ends'
    : d?.running && d.running !== spu ? 'Another shoe is being checked — try again in a moment' : changes.length ? 'Save your choices first' : '';
  const fixWhy = blocked || (!canWrite ? NEEDS_PRIV : !dryOk ? `Dry run this shoe first (a dry run from the last ${FRESH_MIN} min, after your last Match sizes save)` : '');
  const c = run?.counts || {};
  const items = d?.items || [];

  return (
    <details className="shl-d-sec shl-shoe" data-shoe-fix open={openProp || needs || !!run} id="shl-shoe-fix">
      <summary className="shl-h4">Fix SHEIN sizes — this shoe only</summary>
      {spus.length > 1 && (
        <div className="seg sm">
          {spus.map((s) => <button key={s} type="button" className={`seg-btn${s === spu ? ' on' : ''}`} aria-pressed={s === spu} onClick={() => setSpu(s)}>SPU {s}</button>)}
        </div>
      )}
      <p className="muted xs">1 · For each SHEIN size, pick the Shopify SKU it should carry — only the <b>same size</b> is offered — or take it off SHEIN. 2 · Dry run this shoe (nothing is written). 3 · Fix this shoe. No store-wide scan: seconds, not the whole store.</p>

      <table className="shl-rtable shl-shoe-match">
        <thead><tr><th>SHEIN size</th><th>Seller SKU on SHEIN</th><th>Carries</th><th>Should carry</th></tr></thead>
        <tbody>
          {shein.map((v) => {
            const opts = shopify.filter((x) => sameSize(v.shein_size, x.shopify_size) && x.seller_sku !== v.shein_seller_sku);
            const wrong = (v.blockers || []).some((b) => b.code === 'wrong_link');
            const val = valueOf(v.shein_sku);
            return (
              <tr key={v.shein_sku} className={wrong || v.status === 'shein_only' ? 'shl-chg' : ''} data-shein-sku={v.shein_sku}>
                <td data-label="SHEIN size"><b>{v.shein_size || '—'}</b></td>
                <td data-label="Seller SKU" className="shl-mono">{v.shein_seller_sku || '—'}</td>
                <td data-label="Carries">{v.shopify_variant_id
                  ? <span className={wrong ? 'shl-bad-text' : ''}>our size {v.shopify_size}{wrong ? ' — wrong size' : ''}</span>
                  : <span className="muted">no Shopify size</span>}</td>
                <td data-label="Should carry">
                  <select className="input sm shl-shoe-sel" value={val} disabled={!!busy || running} aria-label={`SHEIN size ${v.shein_size}: what it should carry`}
                    onChange={(e) => setPick((m) => ({ ...m, [v.shein_sku]: e.target.value }))}>
                    <option value="">{links.has(String(v.shein_sku)) ? 'Forget my choice' : 'Leave as it is'}</option>
                    {opts.map((x) => <option key={x.seller_sku} value={x.seller_sku}>{x.seller_sku} — our size {x.shopify_size}</option>)}
                    {val && val !== 'delist' && !opts.some((x) => x.seller_sku === val) && <option value={val}>{val} (saved)</option>}
                    <option value="delist">Take this size off SHEIN</option>
                  </select>
                  {links.has(String(v.shein_sku)) && <span className="muted xs shl-block">Saved{links.get(String(v.shein_sku)).decided_by ? ` by ${links.get(String(v.shein_sku)).decided_by}` : ''}</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="muted xs">“Take this size off” holds it at 0 and frees its seller SKU (renamed …-off), so the right SHEIN size can carry it — then “Add missing sizes” can add it.</p>

      <div className="shl-pub-acts">
        <button type="button" className="btn sm" disabled={!changes.length || !!busy} onClick={save}>{busy === 'save' ? 'Saving…' : `Save choices${changes.length ? ` (${changes.length})` : ''}`}</button>
        <button type="button" className="btn primary sm" data-shoe="dry" disabled={!!busy || !!blocked} title={blocked || 'Reads this shoe on SHEIN and Shopify and shows what a fix would do — writes nothing'}
          onClick={() => start('dry')}>{busy === 'dry' ? 'Starting…' : 'Dry run this shoe'}</button>
        <button type="button" className="btn sm" data-shoe="full" disabled={!!busy || !!fixWhy} title={fixWhy || 'Writes the seller SKU changes (SHEIN reviews them) and the stock, then reads SHEIN back'}
          onClick={() => start('full')}>{busy === 'full' ? 'Starting…' : 'Fix this shoe'}</button>
      </div>
      {msg && <p className="sm" role="status">{msg}</p>}
      {err && <p className="error xs" role="alert">{err}</p>}

      {run && (
        <div className="shl-shoe-run" data-shoe-run={run.status}>
          <p className="sm"><b>{run.mode === 'shoe:full' ? 'Fix' : 'Dry run'} #{run.id}</b> · {run.status}{run.phase ? ` — ${run.phase}` : ''} · {when(run.started_at)}{run.started_by ? ` by ${run.started_by}` : ''}</p>
          {run.error && <p className="error xs">{run.error}</p>}
          {run.status === 'done' && (
            <p className="xs">{fmt(c.sizes)} SHEIN size{c.sizes === 1 ? '' : 's'} · {run.mode === 'shoe:dry' ? 'stock would change' : 'stock set'}: <b>{fmt(c.stock_changed)}</b> · {run.mode === 'shoe:dry' ? 'seller SKUs to change' : 'seller SKUs changed'}: <b>{fmt(c.links_changed)}</b>
              {Number(c.needs_person) > 0 && <> · <span className="shl-bad-text">need a person: {fmt(c.needs_person)}</span></>}
              {Number(c.products_in_flight) > 0 && <> · a SHEIN Listings send of this shoe is in flight, so seller SKUs were left alone</>}
              {run.mode === 'shoe:dry' && <span className="muted"> · nothing was written</span>}</p>
          )}
          {!!items.length && (
            <table className="shl-rtable shl-shoe-items">
              <thead><tr><th>SHEIN size</th><th>Seller SKU</th><th className="num">SHEIN stock</th><th>What happens</th></tr></thead>
              <tbody>
                {items.map((it) => (
                  <tr key={it.id} className={tone(it) === 'bad' ? 'shl-shoe-bad' : tone(it) === 'warn' ? 'shl-chg' : ''}>
                    <td data-label="SHEIN size"><b>{it.shein_size || '—'}</b>{it.shopify_size ? <span className="muted xs shl-block">our {it.shopify_size}</span> : null}</td>
                    <td data-label="Seller SKU" className="shl-mono">{it.seller_sku || '—'}{it.link_to && <span className="xs shl-block">→ {it.link_to}</span>}</td>
                    <td data-label="SHEIN stock" className="num">{fmt(it.before_qty)} → <b>{fmt(it.target_qty)}</b>{it.after_qty != null && it.after_qty !== it.target_qty && <span className="shl-bad-text xs shl-block">shows {fmt(it.after_qty)}</span>}</td>
                    <td data-label="What happens" className="xs"><span className={`ebo-chip ${tone(it)}`}>{it.wrote === 'dry' ? 'would change' : RESULT[it.result] || it.result}</span> {it.action}{it.error && <span className="shl-bad-text shl-block">{it.error}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </details>
  );
}
