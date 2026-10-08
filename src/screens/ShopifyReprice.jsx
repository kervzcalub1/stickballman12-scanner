// Shopify Reprice (PH) — pull every Shopify variant, price it off the Alias market, and
// set it to market + markup in BOTH directions, written straight to Shopify
// (docs/context/shopify-reprice.md). Three steps + a log:
//   1 Products   pull from Shopify (style code read off the product title)
//   2 Prices     the shared resumable market fetch (components/MarketPrices.jsx)
//   3 Reprice    markup (default 12 %), review, tick, Apply → LIVE Shopify prices
//   Recent changes — what this page has changed, from shopify_price_changes
// The server recomputes every new price from the market price and re-reads Shopify's
// current price first, so a price that moved since the pull is never overwritten.
import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { TopBar, Modal, ProgressBar } from '../components/common.jsx';
import { useMarketPrices, MarketPricesStep } from '../components/MarketPrices.jsx';
import { useUnsavedGuard } from '../hooks.js';
import { PH_DATETIME, estToday } from '../lib/format.js';
import { parseMarkup, multiplierLabel } from '../lib/ebayReprice.js';
import { jobsFromVariants, planChanges, defaultSelected, changeLogText, inStock, BIG_SWING } from '../lib/shopifyReprice.js';

const APPLY_CHUNK = 100;
const PAGE = 200;
const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const usd = (cents) => (cents == null ? '—' : `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`);
const signed = (cents) => `${cents > 0 ? '+' : cents < 0 ? '−' : ''}${usd(Math.abs(cents))}`;
const KINDS = [['lower', 'Cut'], ['raise', 'Raise'], ['same', 'No change'], ['no_data', 'No price data'], ['no_style', 'No style code']];

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function Stat({ n, label, tone }) {
  return <div className={`er-stat${tone ? ` ${tone}` : ''}`}><b>{n}</b><span>{label}</span></div>;
}

function RecentChanges({ stamp, onSignOut }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api.shopifyRepriceHistory().then((r) => { setRows(r.rows || []); setError(''); })
      .catch((err) => { if (err.unauthorized) return onSignOut(); setError(err.message); });
  }, [stamp]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="card er-step">
      <h3 className="er-step-title">Recent changes on Shopify</h3>
      {error ? <div className="error">{error}</div> : rows == null ? <p className="muted">Loading…</p> : !rows.length ? <p className="muted">No prices changed from here yet.</p> : (
        <div className="ap-tablewrap">
          <table className="table sr-table">
            <thead><tr><th>When</th><th>Product</th><th>Size</th><th>Old</th><th>New</th><th>Market</th><th>By</th></tr></thead>
            <tbody>
              {rows.slice(0, 50).map((r) => (
                <tr key={r.id}>
                  <td className="xs muted">{PH_DATETIME.format(new Date(r.changed_at))} EST</td>
                  <td><div className="sr-title">{r.product_title}</div><div className="muted xs">{r.style}</div></td>
                  <td>{r.size}</td>
                  <td>${Number(r.old_price).toFixed(2)}</td>
                  <td><b>${Number(r.new_price).toFixed(2)}</b></td>
                  <td className="muted">{usd(r.market_cents)} <span className="xs">+{Number(r.markup_pct)}%</span></td>
                  <td className="xs">{r.changed_by}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function ShopifyReprice({ onHome, onSignOut }) {
  const [variants, setVariants] = useState(null);
  const [pulling, setPulling] = useState(false);
  const [pullError, setPullError] = useState('');
  const [inStockOnly, setInStockOnly] = useState(true);
  const [markup, setMarkup] = useState('12');   // never remembered: every run starts at 12 %
  const [kind, setKind] = useState('lower');
  const [selected, setSelected] = useState(null);
  const [shown, setShown] = useState(PAGE);
  const [confirm, setConfirm] = useState(false);
  const [applying, setApplying] = useState(null);   // { done, total }
  const [applied, setApplied] = useState(null);     // { results, rows, pctH, code }
  const [stamp, setStamp] = useState(0);
  useUnsavedGuard(!!applying);

  async function pull() {
    setPulling(true); setPullError(''); setApplied(null); setSelected(null);
    try {
      const r = await api.shopifyRepriceVariants();
      setVariants(r.variants || []);
      if (r.truncated) setPullError('Shopify returned more variants than one pull reads (20,000) — the rest were left out.');
    } catch (err) { if (err.unauthorized) return onSignOut(); setPullError(err.message); } finally { setPulling(false); }
  }

  const jobs = useMemo(() => (variants ? jobsFromVariants(variants, { inStockOnly }) : []), [variants, inStockOnly]);
  const mp = useMarketPrices(jobs, onSignOut);
  const pctH = parseMarkup(markup);
  const rows = useMemo(() => (variants && mp.ready && pctH != null ? planChanges(variants, mp.cache, pctH, { inStockOnly }) : null), [variants, mp.ready, mp.cache, pctH, inStockOnly]);
  // A fresh plan (new markup, new pull, prices finished) starts from the safe default.
  useEffect(() => { setSelected(rows ? defaultSelected(rows) : null); setShown(PAGE); }, [rows]);

  const summary = useMemo(() => {
    if (!variants) return null;
    const products = new Set(variants.map((v) => v.productId)).size;
    const stocked = variants.filter(inStock);
    const pool = inStockOnly ? stocked : variants;
    return { products, variants: variants.length, inStock: stocked.length, withStyle: pool.filter((v) => v.style).length, noStyle: pool.filter((v) => !v.style).length };
  }, [variants, inStockOnly]);
  const counts = useMemo(() => Object.fromEntries(KINDS.map(([k]) => [k, rows ? rows.filter((r) => r.kind === k).length : 0])), [rows]);
  const visible = useMemo(() => (rows || []).filter((r) => r.kind === kind)
    .sort((a, b) => Math.abs(b.diffCents || 0) - Math.abs(a.diffCents || 0)), [rows, kind]);
  const picked = useMemo(() => (rows && selected ? rows.filter((r) => selected.has(r.variantId)) : []), [rows, selected]);
  const pickedCut = picked.filter((r) => r.kind === 'lower');
  const pickedRaise = picked.filter((r) => r.kind === 'raise');
  const sum = (list) => list.reduce((n, r) => n + r.diffCents, 0);

  function toggle(id, on) { setSelected((cur) => { const n = new Set(cur); if (on) n.add(id); else n.delete(id); return n; }); }
  function setAllVisible(on) {
    setSelected((cur) => { const n = new Set(cur); for (const r of visible) if (r.kind === 'lower' || r.kind === 'raise') { if (on) n.add(r.variantId); else n.delete(r.variantId); } return n; });
  }

  async function apply() {
    setConfirm(false);
    const list = picked;
    const results = [];
    let code;
    setApplying({ done: 0, total: list.length });
    for (let i = 0; i < list.length; i += APPLY_CHUNK) {
      const chunk = list.slice(i, i + APPLY_CHUNK);
      try {
        const r = await api.shopifyRepriceApply({
          markupPctH: pctH,
          changes: chunk.map((c) => ({ variantId: c.variantId, productId: c.productId, oldPrice: c.price, marketCents: c.marketCents, productTitle: c.productTitle, style: c.style, size: c.size })),
        });
        results.push(...(r.results || []));
        code = r.code || code;
      } catch (err) {
        if (err.unauthorized) return onSignOut();
        code = err.data?.code || code;
        results.push(...chunk.map((c) => ({ variantId: c.variantId, status: 'failed', error: err.message })));
      }
      setApplying({ done: Math.min(list.length, i + APPLY_CHUNK), total: list.length });
      if (code === 'denied' || code === 'unauthorized') {
        results.push(...list.slice(i + APPLY_CHUNK).map((c) => ({ variantId: c.variantId, status: 'failed', error: 'Not attempted — Shopify refused the change.' })));
        break;
      }
    }
    // What Shopify now holds becomes our "current" price, so the plan re-reads as done.
    const byId = new Map(results.filter((x) => x.status === 'updated' || x.status === 'conflict').map((x) => [x.variantId, x.price]));
    setVariants((vs) => vs.map((v) => (byId.has(v.variantId) ? { ...v, price: byId.get(v.variantId) } : v)));
    setApplied({ results, rows: list, pctH, code });
    setApplying(null);
    setStamp((n) => n + 1);
  }

  const tallyApplied = applied ? applied.results.reduce((t, r) => ({ ...t, [r.status]: (t[r.status] || 0) + 1 }), {}) : null;

  return (
    <div className="app">
      <TopBar title="Shopify Reprice" onHome={onHome} onSignOut={onSignOut} />

      <div className="card er-step">
        <h3 className="er-step-title"><span className="er-num">1</span> Shopify products</h3>
        <p className="muted sm">Pull every product and size from Shopify. The style code is read from the product title — “… (Q47101)”, “… - HQ7901-300”.</p>
        <div className="er-actions">
          <button type="button" className="btn primary" onClick={pull} disabled={pulling || !!applying}>{pulling ? 'Pulling from Shopify…' : variants ? 'Pull again' : 'Pull Shopify products'}</button>
          {variants && <label className="er-dry"><input type="checkbox" checked={inStockOnly} onChange={(e) => setInStockOnly(e.target.checked)} /> In-stock sizes only</label>}
        </div>
        {pullError && <div className="error mt">{pullError}</div>}
        {summary && (
          <div className="er-stats mt">
            <Stat n={fmt(summary.products)} label="products" />
            <Stat n={fmt(summary.variants)} label={`sizes · ${fmt(summary.inStock)} in stock`} />
            <Stat n={fmt(summary.withStyle)} label="with a style code" />
            <Stat n={fmt(summary.noStyle)} label="no style code (left alone)" tone={summary.noStyle ? 'warn' : ''} />
          </div>
        )}
      </div>

      {variants && jobs.length > 0 && <MarketPricesStep mp={mp} num={2} hint="Keep this tab open while it runs." />}

      {variants && jobs.length > 0 && (
        <div className="card er-step">
          <h3 className="er-step-title"><span className="er-num">3</span> Reprice</h3>
          <p className="muted sm">Every ticked size is set to <b>market + markup</b>, rounded half-up to a whole dollar — <b>cut</b> if it’s above, <b>raised</b> if it’s below. Changes over {Math.round(BIG_SWING * 100)}% either way start unticked: a big swing is usually a wrong style code.</p>
          <div className="er-controls">
            <label className="er-markup">
              <span className="muted xs">Markup over market</span>
              <span className="er-markup-field">
                <input type="text" inputMode="decimal" value={markup} aria-label="Markup percent" disabled={!!applying} onChange={(e) => setMarkup(e.target.value)} />
                <span>%</span>
              </span>
              {pctH == null ? <span className="error xs">0 to 100, up to 2 decimals</span> : <span className="muted xs">× {multiplierLabel(pctH)}</span>}
            </label>
          </div>
          {!mp.ready && <p className="muted xs mt">Waiting for every price in step 2.</p>}

          {rows && (
            <>
              <div className="er-stats mt">
                <Stat n={fmt(counts.lower)} label="would be cut" tone="ok" />
                <Stat n={fmt(counts.raise)} label="would be raised" tone="warn" />
                <Stat n={fmt(counts.same)} label="already right" />
                <Stat n={fmt(counts.no_data + counts.no_style)} label="no price data / no code" />
              </div>
              <div className="sr-tabs" role="tablist">
                {KINDS.map(([k, label]) => (
                  <button key={k} type="button" role="tab" aria-selected={kind === k} className={`seg-btn${kind === k ? ' on' : ''}`} onClick={() => { setKind(k); setShown(PAGE); }}>
                    {label} <span className="seg-n">{fmt(counts[k])}</span></button>
                ))}
              </div>
              {(kind === 'lower' || kind === 'raise') && visible.length > 0 && (
                <div className="er-actions sr-bulk">
                  <button type="button" className="btn xs" onClick={() => setAllVisible(true)}>Tick all {fmt(visible.length)}</button>
                  <button type="button" className="btn xs ghost" onClick={() => setAllVisible(false)}>Untick all</button>
                </div>
              )}
              {!visible.length ? <p className="muted mt">Nothing here.</p> : (
                <div className="ap-tablewrap">
                  <table className="table sr-table sr-plan">
                    <thead><tr>{(kind === 'lower' || kind === 'raise') && <th />}<th>Product</th><th>Size</th><th>Qty</th><th>Now</th><th>Market</th><th>New</th><th>Change</th></tr></thead>
                    <tbody>
                      {visible.slice(0, shown).map((r) => (
                        <tr key={r.variantId} className={r.big ? 'sr-big' : ''}>
                          {(kind === 'lower' || kind === 'raise') && (
                            <td><input type="checkbox" checked={!!selected?.has(r.variantId)} disabled={!!applying}
                              aria-label={`Change ${r.productTitle} size ${r.size}`} onChange={(e) => toggle(r.variantId, e.target.checked)} /></td>
                          )}
                          <td className="sr-prod"><div className="sr-title">{r.productTitle}</div><div className="muted xs">{r.style || '—'}{r.marketCode && r.marketCode !== r.style ? ` · priced on ${r.marketCode}` : ''}</div></td>
                          <td data-label="Size">{r.size}</td>
                          <td data-label="Qty" className="muted">{r.qty ?? '—'}</td>
                          <td data-label="Now">{usd(r.oldCents)}</td>
                          <td data-label="Market" className="muted">{r.marketCents != null ? usd(r.marketCents) : <span className="xs">{r.why}</span>}</td>
                          <td data-label="New"><b>{r.nextCents != null ? usd(r.nextCents) : '—'}</b></td>
                          <td data-label="Change" className={r.diffCents < 0 ? 'sr-down' : r.diffCents > 0 ? 'sr-up' : 'muted'}>
                            {r.diffCents != null ? signed(r.diffCents) : '—'}{r.big && <span className="sr-flag" title="Over 50% — check the style code"> big swing</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {visible.length > shown && <button type="button" className="btn ghost sm mt" onClick={() => setShown((n) => n + PAGE)}>Show {fmt(Math.min(PAGE, visible.length - shown))} more</button>}
                </div>
              )}

              <div className="sr-apply">
                <div className="sm">
                  <b>{fmt(picked.length)}</b> ticked — {fmt(pickedCut.length)} cut ({signed(sum(pickedCut))}), {fmt(pickedRaise.length)} raised ({signed(sum(pickedRaise))})
                </div>
                {applying
                  ? <ProgressBar value={applying.done / applying.total} label={`Writing to Shopify… ${fmt(applying.done)} of ${fmt(applying.total)}`} />
                  : <button type="button" className="btn primary" disabled={!picked.length} onClick={() => setConfirm(true)}>Apply {fmt(picked.length)} price{picked.length === 1 ? '' : 's'} to Shopify</button>}
              </div>
            </>
          )}

          {applied && (
            <div className={`er-verify ${applied.code ? 'fail' : 'pass'} mt`}>
              <b>{applied.code ? '✗ Shopify refused some changes' : '✓ Done'}</b>
              <ul>
                <li>{fmt(tallyApplied.updated || 0)} updated on Shopify</li>
                {tallyApplied.conflict ? <li>{fmt(tallyApplied.conflict)} skipped — the price had changed in Shopify since the pull</li> : null}
                {tallyApplied.same ? <li>{fmt(tallyApplied.same)} already at the new price</li> : null}
                {tallyApplied.missing ? <li>{fmt(tallyApplied.missing)} no longer in Shopify</li> : null}
                {tallyApplied.failed ? <li>{fmt(tallyApplied.failed)} failed — {applied.results.find((x) => x.status === 'failed')?.error}</li> : null}
              </ul>
              <button type="button" className="btn sm mt" onClick={() => download(`shopify reprice ${estToday()}.csv`, changeLogText(applied.rows, applied.results, applied.pctH))}>Download change log</button>
            </div>
          )}
        </div>
      )}

      <RecentChanges stamp={stamp} onSignOut={onSignOut} />

      {confirm && (
        <Modal type="warn" title={`Change ${fmt(picked.length)} live prices on Shopify?`}
          message={`${fmt(pickedCut.length)} cut (${signed(sum(pickedCut))}) and ${fmt(pickedRaise.length)} raised (${signed(sum(pickedRaise))}), at ${(pctH / 100).toString()}% over market. They change on the store straight away — and on any sales channel that takes its price from Shopify.`}
          onClose={() => setConfirm(false)}>
          <button type="button" className="btn ghost" onClick={() => setConfirm(false)}>Cancel</button>
          <button type="button" className="btn primary" onClick={apply}>Change {fmt(picked.length)} prices</button>
        </Modal>
      )}
    </div>
  );
}
