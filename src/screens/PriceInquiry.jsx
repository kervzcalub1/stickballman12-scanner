// PH Price Inquiry — a read-only "what's this worth right now?" lookup. Enter or
// search a SKU (official Alias catalog), then TAP a size to fetch its live Alias
// market prices on the spot: lowest listing (ask), highest offer (bid), last sold,
// the Global Indicator, and our Final = GI + 20%. Tapping a priced size again
// removes it; "Price all" fetches the whole run at once. Nothing is saved — it
// never touches inventory. PH team + admin only (pricing is hidden from warehouse).
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { useQueryParam, readParam, writeParam } from '../lib/urlstate.js';
import { TopBar, ShoeThumb } from '../components/common.jsx';
import { Icon } from '../components/NavIcons.jsx';
import { markupSuffix } from '../lib/config.js';
import { fmtPrice } from '../lib/format.js';

// $1,234.56 — or an em dash when the value is missing/zero (Alias reports "0"
// for a size with no current listing/offer/sale). GI 0 is a genuine low-demand
// value, but a $0.00 quote reads as "no data", so treat 0 as blank everywhere.
const money = (v) => (v == null || Number(v) <= 0
  ? '—'
  : `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
// Final price is a whole dollar (rounded) — drop the trailing ".00".
const moneyFinal = (v) => (v == null || Number(v) <= 0 ? '—' : `$${fmtPrice(v)}`);

const PRICE_COLS = [
  ['lowest_listing', 'Lowest ask'],
  ['highest_offer', 'Highest offer'],
  ['last_sold', 'Last sold'],
  ['global_indicator', 'Global indicator'],
  ['price', 'Final'], // label rendered dynamically as "Final (GI + N%)" — see below
];

export function PriceInquiry({ onHome, onSignOut }) {
  // The SKU lives in `?sku=` so a refresh comes back to the same shoe instead of an
  // empty form. Only the SKU: the per-size Alias prices are deliberately NOT restored
  // automatically (see the effect below).
  const [skuInput, setSkuInput] = useQueryParam('sku');
  const [product, setProduct] = useState(null);        // { name, sku, image, sizes[] }
  const [priced, setPriced] = useState({});            // size -> result row (or { size, _empty } when Alias had nothing)
  const [loading, setLoading] = useState(() => new Set()); // sizes currently fetching
  const [notConfigured, setNotConfigured] = useState(false);
  const [looking, setLooking] = useState(false);       // SKU catalog lookup in flight
  const [error, setError] = useState('');
  // Basis rides in the URL too — it changes every printed number, so restoring the
  // sizes on the wrong basis would silently show different prices than you left.
  const [basis, setBasis] = useQueryParam('basis', 'consigned'); // 'consigned' (daily ops) | 'with_you'

  // Step 1 — resolve the SKU on the Alias catalog (title + size run + catalog_id).
  async function lookUp(e, skuOverride, restoreSizes = []) {
    e?.preventDefault();
    const sku = String(skuOverride ?? skuInput).trim();
    if (!sku) return;
    setLooking(true); setError(''); setNotConfigured(false); setProduct(null); setPriced({}); setLoading(new Set());
    try {
      const { product: p } = await api.searchSku(sku);
      setProduct(p);
      // On a URL restore, re-price exactly the sizes that were on screen before. Keep
      // only sizes this SKU actually has, so a stale/hand-edited ?sizes= can't ask
      // Alias for sizes that don't exist.
      const want = restoreSizes.filter((sz) => (p?.sizes || []).map(String).includes(String(sz)));
      if (want.length) setPendingRestore(want);
    } catch (err) {
      if (err.unauthorized) return onSignOut();
      setError(err.message);
    } finally { setLooking(false); }
  }

  // `fetchSizes` closes over `product`, which is still null inside lookUp — so the
  // restore is staged here and fired by the effect below once product has landed.
  const [pendingRestore, setPendingRestore] = useState(null);
  useEffect(() => {
    if (!product || !pendingRestore?.length) return;
    const want = pendingRestore;
    setPendingRestore(null);
    fetchSizes(want);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product, pendingRestore]);

  // Restore from the URL on mount (refresh / shared link): the SKU, the basis, and the
  // exact sizes that were priced — so you come back to the table you left instead of
  // re-picking chips one at a time.
  //
  // Re-pricing does cost live Alias calls, but the cost is bounded by what the user
  // already chose: we re-fetch ONLY the sizes in `?sizes=`, never the whole run. (A
  // blanket "price all" on restore is what we're avoiding — that's 5+ round-trips
  // nobody asked for.) `restoreSizes` is handed to lookUp so it fires once the catalog
  // resolves and `product` exists.
  const boot = useRef({ sku: readParam('sku'), sizes: readParam('sizes') });
  useEffect(() => {
    const b = boot.current;
    if (!b.sku) return;
    boot.current = { sku: '', sizes: '' };
    lookUp(null, b.sku, b.sizes ? b.sizes.split(',').filter(Boolean) : []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mirror the priced sizes into ?sizes= whenever they change, so a refresh at any
  // moment restores exactly what's on screen.
  useEffect(() => {
    if (!product) return;
    writeParam('sizes', Object.keys(priced).join(','));
  }, [priced, product]);

  const setLoad = (sizes, on) => setLoading((s) => {
    const n = new Set(s); for (const sz of sizes) (on ? n.add(sz) : n.delete(sz)); return n;
  });

  // Fetch sizes from Alias in small chunks, rendering each chunk as it lands so
  // rows appear PROGRESSIVELY (size by size) instead of all at once at the end.
  // An asked-for size with no data is stored as an _empty marker so its chip still
  // reads "fetched" and it gets a dashed row. Read-only; nothing is saved.
  const CHUNK = 3; // sizes per request — small enough to reveal gradually, few enough requests
  async function fetchSizes(sizes, useBasis = basis) {
    if (!product || !sizes.length) return;
    for (let i = 0; i < sizes.length; i += CHUNK) {
      const chunk = sizes.slice(i, i + CHUNK);
      setLoad(chunk, true); setError('');
      try {
        const { configured, results: r } = await api.phPriceInquiry(product.sku, chunk, useBasis === 'consigned');
        if (!configured) { setNotConfigured(true); setLoad(chunk, false); return; }
        const bySize = new Map((r || []).map((row) => [String(row.size), row]));
        setPriced((prev) => {
          const next = { ...prev };
          for (const sz of chunk) next[sz] = bySize.get(String(sz)) || { size: sz, _empty: true };
          return next;
        });
      } catch (err) {
        if (err.unauthorized) return onSignOut();
        setError(err.message);
        setLoad(chunk, false);
        return;
      }
      setLoad(chunk, false);
    }
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
            <div className="pi-basis" role="group" aria-label="Pricing basis">
              <span className="pi-basis-label">Pricing basis</span>
              <div className="seg pi-basis-seg">
                <button type="button" className={`seg-btn ${basis === 'consigned' ? 'on' : ''}`} aria-pressed={basis === 'consigned'} onClick={() => changeBasis('consigned')}>Consigned</button>
                <button type="button" className={`seg-btn ${basis === 'with_you' ? 'on' : ''}`} aria-pressed={basis === 'with_you'} onClick={() => changeBasis('with_you')}>With You</button>
              </div>
              <span className="pi-basis-hint">{basis === 'consigned' ? 'Daily-ops pricing (consigned)' : 'Seller “With You” pricing (non-consigned)'}</span>
            </div>
            <div className="pi-sizes-head">
              <span className="pi-sizes-label">Tap a size to fetch its price {pricedCount > 0 ? <span className="pi-sizes-count">{pricedCount} priced</span> : null}</span>
              <button type="button" className={`btn sm pi-priceall ${allPriced ? 'ghost' : 'primary'}`} onClick={toggleAll}>
                {allPriced ? 'Clear all' : <><Icon name="eye" /> Price all</>}
              </button>
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
                      <td key={k} className={k === 'price' ? 'pi-final' : ''}>{k === 'price' ? moneyFinal(r[k]) : money(r[k])}</td>
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
