// Platform Profit — "where should each size we're holding be sold?", across all stock.
//
// The PH grid answers it for one shoe at a time (PlatformBySize under the size table).
// This answers it for everything on hand: every SKU + size PH still has to sell, what
// those pairs landed at (items.cost — the supplier's shelf price run through their cost
// preset at receiving), and Alias (pricing hierarchy) vs StockX lowest ask less each platform's fee.
//
// The stock comes from api/ph/platform-profit.js in one call. The MARKET is priced a
// page of styles at a time through api/payout/batch.js (the endpoint batch analysis
// uses) — one StockX call per size against a shared daily quota, so pricing the whole
// warehouse on load would spend thousands of calls every time the page opened.
// Prices live for this visit only; nothing is saved.
import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { TopBar } from '../components/common.jsx';
import { BySizeTable } from '../components/PlatformBySize.jsx';
import { useQueryParam } from '../lib/urlstate.js';
import { downloadCSV } from '../lib/csv.js';
import { estToday } from '../lib/format.js';
import { compareSizes } from '../lib/codes.js';
import { platformBySize, DEFAULT_FEE_PCT, PLATFORMS } from '../lib/payout.js';

const money = (v) => `${Number(v) < 0 ? '−' : ''}$${Math.abs(Number(v || 0)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const ask = (v) => (v == null || Number(v) <= 0 ? null : Number(v));
const LABEL = Object.fromEntries(PLATFORMS.map((p) => [p.key, p.label]));
// Styles per "Price next" tap. The batch endpoint takes 40 and 24 sizes a style, and is
// throttled to 6 runs a minute; 15 keeps one tap to well under a minute of waiting.
const PAGE = 15;
const MAX_SIZES = 24;

const FILTERS = [
  ['all', 'All'],
  ['alias', 'Best on Alias'],
  ['stockx', 'Best on StockX'],
  ['loss', 'Losing money'],
  ['unpriced', 'Not priced yet'],
  ['nocost', 'Missing cost'],
];

export function PlatformProfit({ onHome, onSignOut }) {
  const [stock, setStock] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  // sku -> { [size]: { alias, stockx, stockxInexact } } — this visit only.
  const [quotes, setQuotes] = useState({});
  const [q, setQ] = useQueryParam('q', '');
  const [filter, setFilter] = useQueryParam('f', 'all');

  useEffect(() => {
    let live = true;
    api.platformProfitStock()
      .then(({ rows }) => { if (live) setStock(rows || []); })
      .catch((e) => { if (e.unauthorized) onSignOut(); else if (live) setError(e.message); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // One card per style, most pairs first — that's where a wrong platform costs most.
  const styles = useMemo(() => {
    const map = new Map();
    for (const r of stock || []) {
      let g = map.get(r.sku);
      if (!g) { g = { sku: r.sku, name: r.name, suppliers: new Set(), sizes: [], qty: 0, uncosted: 0 }; map.set(r.sku, g); }
      g.sizes.push(r);
      g.qty += r.qty;
      g.uncosted += r.qty - r.costed;
      for (const s of String(r.suppliers || '').split(', ').filter(Boolean)) g.suppliers.add(s);
    }
    return [...map.values()]
      .map((g) => ({ ...g, suppliers: [...g.suppliers].join(', '), sizes: g.sizes.sort((a, b) => compareSizes(a.size, b.size)) }))
      .sort((a, b) => b.qty - a.qty || a.sku.localeCompare(b.sku));
  }, [stock]);

  // Every priced style run through the same payout maths as the calculator, with each
  // size's own landed cost.
  const analysed = useMemo(() => styles.map((g) => {
    const qs = quotes[g.sku];
    if (!qs) return { ...g, rows: null };
    // `costedQty`: only pairs with a cost count toward profit totals — a size received
    // twice, once costed and once not, shows the costed pairs' average, not a claim
    // about the others.
    const rows = platformBySize(
      g.sizes.map((s) => ({ size: s.size, cost: s.cost, ...(qs[s.size] || { alias: null, stockx: null }) })),
      0, DEFAULT_FEE_PCT,
    ).map((r, i) => ({ ...r, qty: g.sizes[i].qty, costedQty: g.sizes[i].costed, shelf: g.sizes[i].shelf }));
    return { ...g, rows };
  }), [styles, quotes]);

  const shown = useMemo(() => {
    const needle = String(q || '').trim().toUpperCase();
    return analysed.filter((g) => {
      if (needle && !`${g.sku} ${g.name || ''}`.toUpperCase().includes(needle)) return false;
      if (filter === 'unpriced') return !g.rows;
      if (filter === 'nocost') return g.uncosted > 0;
      if (!g.rows) return filter === 'all';
      if (filter === 'alias' || filter === 'stockx') return g.rows.some((r) => r.best === filter);
      if (filter === 'loss') return g.rows.some((r) => Number(r.cost) > 0 && r.best && r.best !== 'tie' && r[r.best].profit < 0);
      return true;
    });
  }, [analysed, q, filter]);

  // The headline: what choosing the platform per size is worth, against listing
  // everything on one platform. Only sizes with a cost AND an ask on both sides count —
  // a blank on either would make the comparison a guess.
  const summary = useMemo(() => {
    const t = { pairs: 0, alias: 0, stockx: 0, tie: 0, best: 0, allAlias: 0, allStockx: 0, compared: 0 };
    for (const g of analysed) {
      for (const r of g.rows || []) {
        t.pairs += r.qty;
        if (r.best && r.best !== 'tie') t[r.best] += r.qty; else if (r.best === 'tie') t.tie += r.qty;
        const n = r.costedQty;
        if (n > 0 && r.alias && r.stockx) {
          t.compared += n;
          t.best += n * Math.max(r.alias.profit, r.stockx.profit);
          t.allAlias += n * r.alias.profit;
          t.allStockx += n * r.stockx.profit;
        }
      }
    }
    return t;
  }, [analysed]);

  const totals = useMemo(() => ({
    styles: styles.length,
    pairs: styles.reduce((n, g) => n + g.qty, 0),
    uncosted: styles.reduce((n, g) => n + g.uncosted, 0),
    priced: styles.filter((g) => quotes[g.sku]).length,
  }), [styles, quotes]);

  async function price(list) {
    if (!list.length) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const payload = list.map((g) => ({ sku: g.sku, sizes: g.sizes.map((s) => String(s.size)).slice(0, MAX_SIZES) }));
      // Consigned, like every other PH pricing surface.
      const res = await api.payoutBatch(payload, true, { hierarchy: true });
      const next = {};
      let sxDown = false;
      for (const g of list) {
        const r = res.quotes?.[String(g.sku).toUpperCase()];
        if (!r) continue;
        if (r.stockx?.error) sxDown = true;
        const a = new Map((r.alias?.results || []).map((x) => [String(x.size), x]));
        const x = new Map((r.stockx?.results || []).map((y) => [String(y.size), y]));
        next[g.sku] = Object.fromEntries(g.sizes.map((s) => [s.size, {
          alias: ask(a.get(String(s.size))?.alias_price),
          aliasBasis: a.get(String(s.size))?.alias_basis || null,
          stockx: ask(x.get(String(s.size))?.lowest_ask),
          stockxInexact: !!x.get(String(s.size))?.inexact,
        }]));
      }
      setQuotes((cur) => ({ ...cur, ...next }));
      if (sxDown) setNotice('StockX didn’t answer for some styles — those sizes compare on Alias alone. Price them again in a minute.');
      if (res.skipped) setNotice(`${res.skipped} style(s) weren’t priced — run them again.`);
    } catch (e) {
      if (e.unauthorized) return onSignOut();
      setError(e.message);
    } finally { setBusy(false); }
  }

  const nextPage = shown.filter((g) => !quotes[g.sku]).slice(0, PAGE);

  function exportCsv() {
    const cols = ['SKU', 'Name', 'Size', 'On hand', 'Cost', 'Shelf', 'Alias ask', 'Alias profit', 'StockX ask', 'StockX profit', 'Sell on', 'By'];
    const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const n = (v) => (v == null ? '' : Number(v).toFixed(2));
    const lines = [cols.join(',')];
    for (const g of analysed) {
      for (const r of g.rows || []) {
        const costed = Number(r.cost) > 0;
        lines.push([
          g.sku, g.name, r.size, r.qty, costed ? n(r.cost) : '', n(r.shelf),
          n(r.alias?.salePrice), costed && r.alias ? n(r.alias.profit) : '',
          n(r.stockx?.salePrice), costed && r.stockx ? n(r.stockx.profit) : '',
          r.best === 'tie' ? 'Either' : (LABEL[r.best] || ''), r.edge != null ? n(r.edge) : '',
        ].map(esc).join(','));
      }
    }
    downloadCSV(`platform-profit-${estToday()}.csv`, lines.join('\n'));
  }

  return (
    <div className="app">
      <TopBar title="Platform Profit" onHome={onHome} onSignOut={onSignOut} />
      <div className="card">
        <p className="muted sm pp-intro">
          Every size we’re holding, against its landed cost: Alias (priced like the PH grid’s GI: consigned, With You when consigned is empty, then lowest …) vs StockX lowest ask, less each
          platform’s fee ({PLATFORMS.map((p) => `${p.label} ${DEFAULT_FEE_PCT[p.key]}%`).join(', ')}). Prices are
          fetched a page at a time and kept for this visit only.
        </p>
        {error && <div className="error mt">{error}</div>}
        {!stock && !error && <p className="muted mt">Loading stock…</p>}
        {stock && (
          <>
            <div className="pc-stats pp-stats">
              <div className="pc-stat"><span className="pc-stat-label">On hand</span><span className="pc-stat-val">{totals.pairs.toLocaleString()} pairs</span><span className="muted sm">{totals.styles.toLocaleString()} styles</span></div>
              <div className="pc-stat"><span className="pc-stat-label">No cost yet</span><span className="pc-stat-val">{totals.uncosted.toLocaleString()}</span><span className="muted sm">rank by payout until costed</span></div>
              <div className="pc-stat"><span className="pc-stat-label">Priced</span><span className="pc-stat-val">{totals.priced} / {totals.styles}</span><span className="muted sm">styles this visit</span></div>
              {summary.compared > 0 && (
                <div className="pc-stat">
                  <span className="pc-stat-label">Best per size</span>
                  <span className={`pc-stat-val ${summary.best >= 0 ? 'up' : 'down'}`}>{money(summary.best)}</span>
                  <span className="muted sm">
                    vs {money(summary.allAlias)} all-Alias · {money(summary.allStockx)} all-StockX ({summary.compared} pairs)
                  </span>
                </div>
              )}
            </div>
            {summary.pairs > 0 && (
              <p className="pc-bysize-tally sm">
                Of {summary.pairs} priced pairs: <b>Alias</b> is better for {summary.alias}, <b>StockX</b> for {summary.stockx}
                {summary.tie ? `, either for ${summary.tie}` : ''}.
              </p>
            )}

            <div className="pp-controls">
              <input className="pp-search" type="search" placeholder="Search SKU or name" value={q}
                onChange={(e) => setQ(e.target.value)} />
              <button type="button" className="btn" disabled={busy || !nextPage.length} onClick={() => price(nextPage)}>
                {busy ? 'Pricing…' : nextPage.length ? `Price next ${nextPage.length} style${nextPage.length === 1 ? '' : 's'}` : 'All shown styles priced'}
              </button>
              <button type="button" className="btn ghost sm" disabled={!totals.priced} onClick={exportCsv}>CSV</button>
            </div>
            <div className="pc-batch-filters">
              {FILTERS.map(([k, label]) => (
                <button type="button" key={k} className={`pi-chip ${filter === k ? 'on' : ''}`.trim()}
                  aria-pressed={filter === k} onClick={() => setFilter(k)}>{label}</button>
              ))}
            </div>
            {notice && <div className="notice mt">{notice}</div>}

            {!shown.length && <p className="muted mt">Nothing matches.</p>}
            <div className="pp-list">
              {shown.slice(0, 200).map((g) => (
                <div className="pp-style" key={g.sku}>
                  <div className="pp-style-head">
                    <div className="pp-style-info">
                      <div className="pp-style-name">{g.name || g.sku}</div>
                      <div className="muted sm">
                        <span className="pi-product-sku">{g.sku}</span> · {g.qty} pair{g.qty === 1 ? '' : 's'}
                        {g.suppliers ? ` · ${g.suppliers}` : ''}
                        {g.uncosted ? <span className="pc-batch-warn"> · {g.uncosted} without a cost</span> : null}
                      </div>
                    </div>
                    {!g.rows && (
                      <button type="button" className="btn ghost sm" disabled={busy} onClick={() => price([g])}>Price</button>
                    )}
                  </div>
                  {g.rows
                    ? <BySizeTable rows={g.rows} />
                    : (
                      <p className="muted sm pp-unpriced">
                        {g.sizes.map((s) => `${s.size} ×${s.qty}${s.cost != null ? ` @ ${money(s.cost)}` : ''}`).join(' · ')}
                      </p>
                    )}
                </div>
              ))}
            </div>
            {shown.length > 200 && <p className="muted sm mt">Showing the first 200 of {shown.length} — search or filter to narrow it.</p>}
          </>
        )}
      </div>
    </div>
  );
}
