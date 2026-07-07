// PH Price Inquiry — a read-only "what's this worth right now?" lookup. Enter or
// search a SKU (official Alias catalog), then TAP a size to fetch its live Alias
// market prices on the spot: lowest listing (ask), highest offer (bid), last sold,
// the Global Indicator, and our Final = GI + 20%. Tapping a priced size again
// removes it; "Price all" fetches the whole run at once. Nothing is saved — it
// never touches inventory. PH team + admin only (pricing is hidden from warehouse).
import React, { useMemo, useState } from 'react';
import { api } from '../api.js';
import { TopBar, ShoeThumb } from '../components/common.jsx';
import { Icon } from '../components/NavIcons.jsx';
import { markupSuffix } from '../lib/config.js';

// $1,234.56 — or an em dash when the value is missing/zero (Alias reports "0"
// for a size with no current listing/offer/sale). GI 0 is a genuine low-demand
// value, but a $0.00 quote reads as "no data", so treat 0 as blank everywhere.
const money = (v) => (v == null || Number(v) <= 0
  ? '—'
  : `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

const PRICE_COLS = [
  ['lowest_listing', 'Lowest ask'],
  ['highest_offer', 'Highest offer'],
  ['last_sold', 'Last sold'],
  ['global_indicator', 'Global indicator'],
  ['price', 'Final'], // label rendered dynamically as "Final (GI + N%)" — see below
];

export function PriceInquiry({ onHome, onSignOut }) {
  const [skuInput, setSkuInput] = useState('');
  const [product, setProduct] = useState(null);        // { name, sku, image, sizes[] }
  const [priced, setPriced] = useState({});            // size -> result row (or { size, _empty } when Alias had nothing)
  const [loading, setLoading] = useState(() => new Set()); // sizes currently fetching
  const [notConfigured, setNotConfigured] = useState(false);
  const [looking, setLooking] = useState(false);       // SKU catalog lookup in flight
  const [error, setError] = useState('');
  const [basis, setBasis] = useState('consigned');     // 'consigned' (daily ops) | 'with_you'

  // Step 1 — resolve the SKU on the Alias catalog (title + size run + catalog_id).
  async function lookUp(e) {
    e?.preventDefault();
    const sku = skuInput.trim();
    if (!sku) return;
    setLooking(true); setError(''); setNotConfigured(false); setProduct(null); setPriced({}); setLoading(new Set());
    try {
      const { product: p } = await api.searchSku(sku);
      setProduct(p);
    } catch (err) {
      if (err.unauthorized) return onSignOut();
      setError(err.message);
    } finally { setLooking(false); }
  }

  const setLoad = (sizes, on) => setLoading((s) => {
    const n = new Set(s); for (const sz of sizes) (on ? n.add(sz) : n.delete(sz)); return n;
  });

  // Fetch one or more sizes from Alias in a single request, then merge the results
  // in (an asked-for size with no data is stored as an _empty marker so its chip
  // still reads "fetched" and it gets a dashed row). Read-only; nothing is saved.
  async function fetchSizes(sizes, useBasis = basis) {
    if (!product || !sizes.length) return;
    setLoad(sizes, true); setError('');
    try {
      const { configured, results: r } = await api.phPriceInquiry(product.sku, sizes, useBasis === 'consigned');
      if (!configured) { setNotConfigured(true); return; }
      const bySize = new Map((r || []).map((row) => [String(row.size), row]));
      setPriced((prev) => {
        const next = { ...prev };
        for (const sz of sizes) next[sz] = bySize.get(String(sz)) || { size: sz, _empty: true };
        return next;
      });
    } catch (err) {
      if (err.unauthorized) return onSignOut();
      setError(err.message);
    } finally { setLoad(sizes, false); }
  }

  // Tap a chip: idle → fetch it · already priced → remove it · loading → ignore.
  function tapSize(sz) {
    if (loading.has(sz)) return;
    if (priced[sz]) { setPriced((p) => { const n = { ...p }; delete n[sz]; return n; }); return; }
    fetchSizes([sz]);
  }

  // Flip the pricing basis: re-fetch any already-priced sizes on the new basis so
  // the table reflects the switch (Consigned ↔ With You). Read-only, nothing saved.
  function changeBasis(next) {
    if (next === basis) return;
    setBasis(next);
    const pricedSizes = Object.keys(priced);
    if (pricedSizes.length) fetchSizes(pricedSizes, next);
  }

  const sizes = product?.sizes || [];
  const allPriced = sizes.length > 0 && sizes.every((s) => priced[s]);
  const pricedCount = Object.keys(priced).length;
  function toggleAll() {
    if (allPriced) { setPriced({}); return; }
    fetchSizes(sizes.filter((s) => !priced[s] && !loading.has(s))); // price the rest in one shot
  }

  // Rows for the table — every priced size, in catalog order.
  const rows = useMemo(
    () => sizes.filter((s) => priced[s]).map((s) => priced[s]),
    [sizes, priced],
  );

  return (
    <div className="app">
      <TopBar title="Price Inquiry" onHome={onHome} onSignOut={onSignOut} />
      <div className="card">
        <p className="muted sm">
          Look up live Alias market prices for any SKU — lowest ask, highest offer, last sold, the Global Indicator, and
          our Final price (GI&nbsp;+&nbsp;{markupSuffix()}). This is a read-only lookup; nothing is saved to inventory.
        </p>

        <form className="pi-lookup" onSubmit={lookUp}>
          <input
            className="pi-sku-input" type="text" inputMode="text" autoCapitalize="characters"
            placeholder="Enter a SKU (e.g. DZ5485-612)" value={skuInput}
            onChange={(e) => setSkuInput(e.target.value)} disabled={looking} />
          <button type="submit" className="btn" disabled={looking || !skuInput.trim()}>
            <Icon name="eye" /> {looking ? 'Looking…' : 'Look up'}
          </button>
        </form>

        {error && <div className="error mt">{error}</div>}
        {notConfigured && <div className="notice mt">Alias pricing isn’t configured on the server, so prices can’t be fetched.</div>}

        {product && (
          <div className="pi-product mt">
            <ShoeThumb url={product.image} size={52} />
            <div className="pi-product-info">
              <div className="pi-product-name">{product.name || '—'}</div>
              <div className="muted sm">
                <span className="pi-product-sku">{product.sku || '—'}</span>
                {product.colorway ? <span> · {product.colorway}</span> : null}
                {product.gender ? <span> · {product.gender}</span> : null}
              </div>
            </div>
          </div>
        )}

        {product && sizes.length > 0 && (
          <div className="pi-sizes mt">
            <div className="pi-sizes-head">
              <span className="pi-sizes-label">Tap a size to fetch its price {pricedCount > 0 ? <span className="pi-sizes-count">{pricedCount} priced</span> : null}</span>
              <button type="button" className="linklike sm" onClick={toggleAll}>{allPriced ? 'Clear all' : 'Price all'}</button>
            </div>
            <div className="pi-basis" role="group" aria-label="Pricing basis">
              <span className="pi-basis-label muted sm">Basis</span>
              <div className="seg sm">
                <button type="button" className={`seg-btn ${basis === 'consigned' ? 'on' : ''}`} aria-pressed={basis === 'consigned'} onClick={() => changeBasis('consigned')}>Consigned</button>
                <button type="button" className={`seg-btn ${basis === 'with_you' ? 'on' : ''}`} aria-pressed={basis === 'with_you'} onClick={() => changeBasis('with_you')}>With You</button>
              </div>
              <span className="muted sm">{basis === 'consigned' ? 'Daily-ops pricing (consigned)' : 'Seller “With You” pricing (non-consigned)'}</span>
            </div>
            <div className="pi-sizegrid">
              {sizes.map((sz) => {
                const isLoading = loading.has(sz);
                const row = priced[sz];
                const cls = isLoading ? 'loading' : row ? (row._empty ? 'on empty' : 'on') : '';
                return (
                  <button type="button" key={sz}
                    className={`pi-chip ${cls}`.trim()}
                    aria-pressed={!!row} aria-busy={isLoading}
                    onClick={() => tapSize(sz)}>
                    {isLoading ? <span className="pi-chip-spin" aria-hidden="true" />
                      : row && !row._empty ? <span className="pi-chip-check" aria-hidden="true">✓</span> : null}
                    {sz}
                  </button>
                );
              })}
            </div>
            <p className="pi-hint muted sm">Tap a priced size again to remove it.</p>
          </div>
        )}

        {product && sizes.length === 0 && (
          <p className="muted mt">No size run on file for this SKU.</p>
        )}

        {rows.length > 0 && (
          <div className="inv-tablewrap mt">
            <table className="inv-table pi-table">
              <thead>
                <tr>
                  <th>Size</th>
                  {PRICE_COLS.map(([k, label]) => <th key={k}>{k === 'price' ? `Final (GI + ${markupSuffix()})` : label}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.size}>
                    <td className="inv-col-size">{r.size}</td>
                    {PRICE_COLS.map(([k]) => (
                      <td key={k} className={k === 'price' ? 'pi-final' : ''}>{money(r[k])}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
