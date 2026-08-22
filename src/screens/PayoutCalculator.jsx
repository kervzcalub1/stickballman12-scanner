// Payout Calculator — "should I buy this pair?", answered standing in the store.
//
// Three steps down the page: what it costs at the register (the discount stack), what
// each platform pays out after its fees, and the buy call that falls out of the two.
// Nothing is saved — it never touches inventory; it's a scratchpad with the right math
// in it. Admin + warehouse + PH. See docs/context/payout-calculator.md.
//
// The one thing it fetches: tapping a size pulls that size's LIVE prices from BOTH
// markets in one call (api/payout/quote.js) — Alias, and StockX via its official
// Public API — so the sale prices fill themselves instead of being typed off another
// app. StockX is optional: with no StockX credentials on the server that column just
// stays manual, and the Alias half still works.
import React, { useMemo, useState } from 'react';
import { api } from '../api.js';
import { useQueryParam } from '../lib/urlstate.js';
import { TopBar, ShoeThumb } from '../components/common.jsx';
import { Icon } from '../components/NavIcons.jsx';
import { loadPrefs, savePrefs } from '../prefs.js';
import { useAdvisorContext } from '../lib/advisorContext.js';
import {
  calcCostBreakdown, calcPayout, dealVerdict, DEFAULT_FEE_PCT, PLATFORMS, LIQUIDITY,
  BUY_MIN_PROFIT, BUY_MIN_ROI,
} from '../lib/payout.js';

const money = (v) => `$${Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
// Alias reports 0 for a size with no listing/offer/sale, so 0 reads as "no data" here.
const quoted = (v) => (v == null || Number(v) <= 0 ? null : Number(v));
const pct = (v) => `${Number(v || 0).toFixed(1)}%`;

const CALL_LABEL = { buy: 'Buy', watch: 'Watch', pass: 'Pass' };
const RISK_LABEL = { low: 'Low', medium: 'Medium', high: 'High', loss: 'Loss' };

// The market numbers a size can be priced at, in the order they answer "what would
// this actually sell for": the live ask first, then the bid, then what one last went
// for. Tapping one drops it into the Alias sale price.
const MARKET_COLS = [
  ['lowest_listing', 'Lowest ask'],
  ['highest_offer', 'Highest offer'],
  ['last_sold', 'Last sold'],
  ['global_indicator', 'Global indicator'],
];
// StockX's Public API gives both sides of the book plus two seller nudges — and NO
// last sale (there is no such field anywhere in their OpenAPI spec, however plainly
// stockx.com shows one). "Earn more" is the ask that maximises earnings; "sell faster"
// is the ask that becomes the lowest. Both are inclusive of duties and taxes.
const SX_MARKET_COLS = [
  ['lowest_ask', 'Lowest ask'],
  ['highest_bid', 'Highest bid'],
  ['earn_more', 'Earn more'],
  ['sell_faster', 'Sell faster'],
];

// One market strip — a row of tappable quotes that fill a platform's sale price.
function MarketStrip({ title, cols, row, onUse, note }) {
  return (
    <div className="pc-market mt">
      <div className="pc-market-head muted sm">{title}</div>
      {note ? <div className="pc-market-note">{note}</div> : null}
      <div className="pc-market-grid">
        {cols.map(([key, label]) => {
          const v = quoted(row[key]);
          return (
            <button type="button" key={key} className="pc-market-cell" disabled={!v}
              onClick={() => onUse(String(v))}>
              <span className="pc-market-label">{label}</span>
              <span className="pc-market-val">{v ? money(v) : '—'}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// A labelled number box. Kept local: every field on this screen is a bare number with
// either a $ in front or a % behind, which no shared input does.
function NumField({ label, value, onChange, prefix, suffix, placeholder = '0', hint }) {
  return (
    <label className="pc-field">
      <span className="pc-field-label">{label}</span>
      <span className={`pc-input-wrap${prefix ? ' has-prefix' : ''}${suffix ? ' has-suffix' : ''}`}>
        {prefix ? <span className="pc-affix" aria-hidden="true">{prefix}</span> : null}
        <input
          type="number" min="0" step="0.01" inputMode="decimal" placeholder={placeholder}
          value={value} onChange={(e) => onChange(e.target.value)} />
        {suffix ? <span className="pc-affix suffix" aria-hidden="true">{suffix}</span> : null}
      </span>
      {hint ? <span className="pc-field-hint muted sm">{hint}</span> : null}
    </label>
  );
}

function BreakRow({ label, value, sign, bold }) {
  return (
    <tr className={bold ? 'pc-break-total' : ''}>
      <td>{label}</td>
      <td className={`pc-break-val${sign === '−' ? ' down' : sign === '+' ? ' up' : ''}`}>
        {sign || ''}{money(value)}
      </td>
    </tr>
  );
}

export function PayoutCalculator({ onHome, onSignOut }) {
  // The shoe rides in the URL so a refresh (or a link to the person who asked) comes
  // back to the same pair. The money is NOT in the URL: a shared link that carries
  // someone else's cost basis around is a leak, not a convenience.
  const [skuInput, setSkuInput] = useQueryParam('sku');
  const [size, setSize] = useQueryParam('size');
  // Alias quotes two bases and they differ a lot — $120 vs $105 on FZ9033-102 size 11,
  // which is $13.51 of payout, i.e. the gap between a buy and a pass.
  //   · consigned  — Alias holds your stock. The daily-ops basis, and what every OTHER
  //                  pricing surface here defaults to (PH grid, Price Inquiry).
  //   · with_you   — you hold the pair and ship when it sells.
  // This screen defaults to **with_you** on purpose, unlike the rest of the app: the
  // person using it is standing in a shop deciding whether to buy a pair they will then
  // hold and ship themselves, so that is the basis that describes what actually happens
  // to the shoe. It also matches the numbers the floor already quotes each other. The
  // toggle is there because a consignment buy is still a real case.
  const [basis, setBasis] = useQueryParam('basis', 'with_you');
  const [product, setProduct] = useState(null);
  const [market, setMarket] = useState(null);     // Alias row for `size`, or { _empty: true }
  const [sx, setSx] = useState(null);            // { configured, row, error } for `size`
  const [pricing, setPricing] = useState(false);
  const [looking, setLooking] = useState(false);
  const [notConfigured, setNotConfigured] = useState(false);
  const [error, setError] = useState('');

  // The RATES persist per device (prefs.js), the per-shoe amounts don't. Store %, tax
  // and cashback are the same all afternoon in one store — retyping them for every
  // pair is how a wrong number ends up in a buy call. Shelf price, coupon, tip and the
  // sale prices are per pair and start empty every time on purpose.
  const [prefs, setPrefs] = useState(loadPrefs);
  const rates = prefs.payoutRates || {};
  const setRate = (key, v) => setPrefs((p) => {
    const n = { ...p, payoutRates: { ...(p.payoutRates || {}), [key]: v } };
    savePrefs(n);
    return n;
  });

  const [shelfPrice, setShelfPrice] = useState('');
  const [couponAmt, setCouponAmt] = useState('');
  const [tipAmt, setTipAmt] = useState('');
  const [shippingAmt, setShippingAmt] = useState('');
  const [sale, setSale] = useState({ alias: '', stockx: '' });
  const [feeOverride, setFeeOverride] = useState({ alias: '', stockx: '' });
  // Liquidity: measured if we have sales data, chosen if the buyer picked. `touched`
  // is what stops a measured value from stomping a deliberate choice — someone who
  // knows this shoe is about to drop can say "daily" and keep it.
  const [liquidity, setLiquidity] = useState('');
  const [liquidityTouched, setLiquidityTouched] = useState(false);
  const [velocity, setVelocity] = useState(null);   // { sold_30d, per_week, liquidity, … }


  const breakdown = useMemo(() => calcCostBreakdown({
    shelfPrice,
    storePct: rates.storePct, promoPct: rates.promoPct, giftPct: rates.giftPct,
    couponAmt, cashbackPct: rates.cashbackPct, taxPct: rates.taxPct,
    tipAmt, shippingAmt,
  }), [shelfPrice, rates.storePct, rates.promoPct, rates.giftPct, couponAmt,
    rates.cashbackPct, rates.taxPct, tipAmt, shippingAmt]);

  // A blank fee box means "use the default", not "0% fees" — which would quietly
  // inflate every payout on the screen.
  const feeFor = (key) => (String(feeOverride[key] ?? '').trim() === ''
    ? DEFAULT_FEE_PCT[key]
    : Number(feeOverride[key]));

  const payouts = useMemo(
    () => PLATFORMS.map((p) => calcPayout(p.key, sale[p.key], breakdown.finalCost, feeFor(p.key))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sale.alias, sale.stockx, breakdown.finalCost, feeOverride.alias, feeOverride.stockx],
  );
  const verdict = useMemo(
    () => dealVerdict(payouts, breakdown.finalCost, liquidity),
    [payouts, breakdown.finalCost, liquidity],
  );

  async function lookUp(e) {
    e?.preventDefault();
    const sku = String(skuInput || '').trim();
    if (!sku) return;
    setLooking(true); setError(''); setNotConfigured(false); setProduct(null); setMarket(null);
    setVelocity(null); setLiquidityTouched(false);
    // Drop the selected size too. It belonged to the previous shoe: leaving it set left a
    // chip highlighted with no market behind it, and tapping that chip DESELECTED it
    // instead of pricing it — the one action a highlighted size invites.
    setSize(''); setSx(null);
    try {
      const { product: p } = await api.searchSku(sku);
      setProduct(p);
    } catch (err) {
      if (err.unauthorized) return onSignOut();
      setError(err.message);
    } finally { setLooking(false); }
  }

  // Tap a size → live Alias prices for that size. Tapping the priced size again drops
  // it, so a mis-tap costs nothing but the call already made.
  // `basisOverride` lets the basis toggle re-price the size already on screen without
  // waiting for the state update to land.
  async function tapSize(sz, basisOverride) {
    const nextBasis = basisOverride || basis;
    if (!basisOverride && String(sz) === String(size)) { setSize(''); setMarket(null); setSx(null); return; }
    setSize(String(sz)); setMarket(null); setSx(null); setError(''); setNotConfigured(false);
    if (!product?.sku) return;
    setPricing(true);
    try {
      const res = await api.payoutQuote(product.sku, [String(sz)], nextBasis === 'consigned');
      // StockX is read first and independently: Alias being unconfigured must not
      // hide a StockX quote we did get, and vice versa.
      // Per style, not per size — it rides beside the results.
      setVelocity(res.velocity || null);
      if (res.velocity?.liquidity && res.velocity.sold_total > 0 && !liquidityTouched) {
        setLiquidity(res.velocity.liquidity);
      }
      setSx({
        configured: !!res.stockx?.configured,
        row: res.stockx?.results?.[0] || null,
        error: res.stockx?.error || '',
      });
      if (!res.configured) { setNotConfigured(true); return; }
      setMarket(res.results?.[0] || { size: String(sz), _empty: true });
    } catch (err) {
      if (err.unauthorized) return onSignOut();
      setError(err.message);
    } finally { setPricing(false); }
  }

  // Switching basis re-prices whatever size is on screen — leaving the old number under
  // a new label would be worse than showing nothing.
  function changeBasis(next) {
    if (next === basis) return;
    setBasis(next);
    if (size && product?.sku) tapSize(size, next);
  }

  function resetPair() {
    setShelfPrice(''); setCouponAmt(''); setTipAmt(''); setShippingAmt('');
    setSale({ alias: '', stockx: '' }); setFeeOverride({ alias: '', stockx: '' });
    setLiquidity(''); setLiquidityTouched(false); setVelocity(null);
    setMarket(null); setSx(null); setSize(''); setProduct(null); setSkuInput('');
    setError(''); setNotConfigured(false);
  }

  const sizes = product?.sizes || [];
  const hasMarket = market && !market._empty;
  const sxRow = sx?.row || null;
  // "Measured" only while it still matches the data — the moment someone overrides it,
  // the number on screen is theirs. The evidence line still shows (what the shoe did is
  // true either way); this flag is what tells the advisor whose call the band is.
  const measured = !!velocity && velocity.sold_total > 0 && !liquidityTouched && liquidity === velocity.liquidity;

  // Publish what this screen is showing, so the app-wide advisor (the floating button)
  // can answer about the pair in front of you. Rebuilt whenever the numbers change, so a
  // question typed after editing a cost is answered against the new one.
  useAdvisorContext(() => ({
    page: 'the Payout Calculator',
    sku: product?.sku || null,
    name: product?.name || null,
    size: size || null,
    basis,
    cost: {
      shelf: shelfPrice, storePct: rates.storePct, promoPct: rates.promoPct,
      giftPct: rates.giftPct, couponAmt, cashbackPct: rates.cashbackPct,
      taxPct: rates.taxPct, tipAmt, shippingAmt, finalCost: breakdown.finalCost,
    },
    payouts: payouts.map((p) => ({
      label: p.label, salePrice: p.salePrice, feePct: p.feePct,
      payout: p.payout, profit: p.profit, roi: p.roi,
    })),
    market: {
      alias: hasMarket ? MARKET_COLS.map(([k, l]) => `${l} ${quoted(market[k]) ? money(quoted(market[k])) : '—'}`).join(', ') : null,
      stockx: sxRow ? SX_MARKET_COLS.map(([k, l]) => `${l} ${quoted(sxRow[k]) ? money(quoted(sxRow[k])) : '—'}`).join(', ') : null,
    },
    liquidity,
    // Without this he'd cheerfully argue with a figure that came from the same table he
    // reads — "you've marked it weekly, but…" is only useful against a human guess.
    liquiditySource: measured ? 'measured from our sales data' : (liquidity ? 'chosen by the buyer' : 'not set'),
    salesVelocity: velocity && velocity.sold_total > 0
      ? `${velocity.sold_30d} sold in 30 days, ${velocity.sold_90d} in 90, ${velocity.per_week}/week`
      : null,
    verdict: verdict
      ? `${CALL_LABEL[verdict.call]} — best on ${verdict.best.label}, profit ${money(verdict.best.profit)}, ROI ${pct(verdict.best.roi)}, risk ${RISK_LABEL[verdict.risk]}`
      : 'not enough entered for a call yet',
  }), [product, size, basis, shelfPrice, couponAmt, tipAmt, shippingAmt, liquidity,
    breakdown.finalCost, payouts, market, sxRow, rates, velocity, measured]);

  return (
    <div className="app">
      <TopBar title="Payout Calculator" onHome={onHome} onSignOut={onSignOut} />

      <div className="card">
        <div className="pc-head">
          <p className="muted sm">
            What a pair costs at the register, what each store pays out after fees, and whether that’s a buy.
            Nothing here is saved — it never touches inventory.
          </p>
          <button type="button" className="btn ghost sm" onClick={resetPair}>Clear</button>
        </div>

        {/* 1 — the shoe (optional: the maths works with a typed sale price alone) */}
        <h3 className="pc-h">Shoe <span className="muted sm">optional — fills the sale prices for you</span></h3>
        <form className="pi-lookup" onSubmit={lookUp}>
          <input
            className="pi-sku-input" type="text" inputMode="text" autoCapitalize="characters"
            placeholder="Enter a SKU (e.g. DZ5485-612)" value={skuInput}
            onChange={(e) => setSkuInput(e.target.value)} disabled={looking} />
          <button type="submit" className="btn" disabled={looking || !String(skuInput || '').trim()}>
            <Icon name="eye" /> {looking ? 'Looking…' : 'Look up'}
          </button>
        </form>

        {error && <div className="error mt">{error}</div>}
        {notConfigured && <div className="notice mt">Alias pricing isn’t configured on the server, so live prices can’t be fetched. Type the sale price instead.</div>}

        {product && (
          <div className="pi-product mt">
            <ShoeThumb url={product.image} size={52} />
            <div className="pi-product-info">
              <div className="pi-product-name">{product.name || '—'}</div>
              <div className="muted sm">
                <span className="pi-product-sku">{product.sku || '—'}</span>
                {product.colorway ? <span> · {product.colorway}</span> : null}
              </div>
            </div>
          </div>
        )}

        {product && sizes.length > 0 && (
          <div className="pi-sizes mt">
            <div className="pc-basis">
              <span className="pc-field-label">Alias pricing basis</span>
              <div className="seg sm">
                <button type="button" className={`seg-btn ${basis === 'with_you' ? 'on' : ''}`}
                  aria-pressed={basis === 'with_you'} onClick={() => changeBasis('with_you')}>With You</button>
                <button type="button" className={`seg-btn ${basis === 'consigned' ? 'on' : ''}`}
                  aria-pressed={basis === 'consigned'} onClick={() => changeBasis('consigned')}>Consigned</button>
              </div>
              <span className="muted sm">
                {basis === 'with_you' ? 'You hold the pair and ship it when it sells' : 'Alias holds your stock (the basis the PH pages use)'}
              </span>
            </div>
            <div className="pi-sizes-head">
              <span className="pi-sizes-label">Tap the size you’re holding</span>
            </div>
            <div className="pi-sizegrid">
              {sizes.map((sz) => (
                <button type="button" key={sz}
                  className={`pi-chip ${String(sz) === String(size) ? (pricing ? 'loading' : 'on') : ''}`.trim()}
                  aria-pressed={String(sz) === String(size)} aria-busy={pricing && String(sz) === String(size)}
                  onClick={() => tapSize(sz)}>
                  {pricing && String(sz) === String(size) ? <span className="pi-chip-spin" aria-hidden="true" /> : null}
                  {sz}
                </button>
              ))}
            </div>
          </div>
        )}

        {market && market._empty && (
          <p className="muted mt">Alias has no live prices for size {size} — type the sale price below.</p>
        )}

        {hasMarket && (
          <MarketStrip
            title={`Size ${market.size} · live Alias market · ${basis === 'with_you' ? 'With You' : 'Consigned'} — tap one to use it as the sale price`}
            cols={MARKET_COLS} row={market}
            onUse={(v) => setSale((s) => ({ ...s, alias: v }))} />
        )}

        {sxRow && (
          <MarketStrip
            title={`Size ${size} · live StockX market — tap one to use it as the sale price`}
            cols={SX_MARKET_COLS} row={sxRow}
            onUse={(v) => setSale((s) => ({ ...s, stockx: v }))}
            // A near-miss on the catalogue is usually the right shoe in the wrong
            // colourway. Better to say so than to price the wrong pair silently.
            note={sxRow.inexact
              ? `StockX matched “${sxRow.title || 'a different listing'}” rather than this exact style — check before trusting it.`
              : null} />
        )}
        {sx?.error && <div className="notice mt">{sx.error}</div>}
        {sx && sx.configured && !sxRow && !sx.error && (
          <p className="muted mt">StockX has no market for size {size}.</p>
        )}

        {/* 2 — what it costs at the register */}
        <h3 className="pc-h">Store cost</h3>
        <div className="pc-grid">
          <NumField label="Shelf price" prefix="$" value={shelfPrice} onChange={setShelfPrice} placeholder="0.00" />
          <NumField label="Tax" suffix="%" value={rates.taxPct ?? ''} onChange={(v) => setRate('taxPct', v)} />
        </div>
        <div className="pc-grid three">
          <NumField label="Store discount" suffix="%" value={rates.storePct ?? ''} onChange={(v) => setRate('storePct', v)} />
          <NumField label="Promo / birthday" suffix="%" value={rates.promoPct ?? ''} onChange={(v) => setRate('promoPct', v)} />
          <NumField label="Gift card" suffix="%" value={rates.giftPct ?? ''} onChange={(v) => setRate('giftPct', v)} />
        </div>
        <div className="pc-grid">
          <NumField label="Coupon" prefix="$" value={couponAmt} onChange={setCouponAmt} placeholder="0.00" />
          <NumField label="Cashback" suffix="%" value={rates.cashbackPct ?? ''} onChange={(v) => setRate('cashbackPct', v)} />
        </div>
        <div className="pc-grid">
          <NumField label="Tip" prefix="$" value={tipAmt} onChange={setTipAmt} placeholder="0.00" />
          <NumField label="Shipping" prefix="$" value={shippingAmt} onChange={setShippingAmt} placeholder="0.00" />
        </div>
        <p className="pc-note muted sm">
          The three percentages compound — each comes off what’s left, not off the shelf price — then the coupon, then tax.
          Rates stick on this device; the shelf price, coupon, tip and shipping clear with every pair.
        </p>

        <div className="pc-stats">
          <div className="pc-stat">
            <span className="pc-stat-label">Final cost</span>
            <span className="pc-stat-val">{money(breakdown.finalCost)}</span>
          </div>
          <div className="pc-stat">
            <span className="pc-stat-label">Saved off sticker</span>
            <span className="pc-stat-val up">{money(breakdown.totalSaved)}</span>
          </div>
        </div>

        <details className="pc-details">
          <summary>Breakdown</summary>
          <table className="pc-break">
            <tbody>
              <BreakRow label="Shelf" value={breakdown.shelf} />
              <BreakRow label={`Store discount (${pct(rates.storePct)})`} value={breakdown.storeSaved} sign="−" />
              <BreakRow label={`Promo (${pct(rates.promoPct)})`} value={breakdown.promoSaved} sign="−" />
              <BreakRow label={`Gift card (${pct(rates.giftPct)})`} value={breakdown.giftSaved} sign="−" />
              {breakdown.couponSaved > 0 && <BreakRow label="Coupon" value={breakdown.couponSaved} sign="−" />}
              {breakdown.cashback > 0 && <BreakRow label={`Cashback (${pct(rates.cashbackPct)})`} value={breakdown.cashback} sign="−" />}
              <BreakRow label={`Tax (${pct(rates.taxPct)})`} value={breakdown.tax} sign="+" />
              {breakdown.tip > 0 && <BreakRow label="Tip" value={breakdown.tip} sign="+" />}
              {breakdown.shipping > 0 && <BreakRow label="Shipping" value={breakdown.shipping} sign="+" />}
              <BreakRow label="Final cost" value={breakdown.finalCost} bold />
            </tbody>
          </table>
        </details>

        {/* 3 — what each platform pays */}
        <h3 className="pc-h">Expected payouts</h3>
        <div className="pc-payouts">
          {payouts.map((p) => (
            <div className="pc-payout" key={p.platform}>
              <div className="pc-payout-head">{p.label}</div>
              <div className="pc-grid">
                <NumField label="Sale price" prefix="$" value={sale[p.platform]}
                  onChange={(v) => setSale((s) => ({ ...s, [p.platform]: v }))} placeholder="0.00" />
                <NumField label="Fee" suffix="%" value={feeOverride[p.platform]}
                  onChange={(v) => setFeeOverride((f) => ({ ...f, [p.platform]: v }))}
                  placeholder={String(DEFAULT_FEE_PCT[p.platform])}
                  hint={`default ${pct(DEFAULT_FEE_PCT[p.platform])}`} />
              </div>
              {p.salePrice > 0 ? (
                <table className="pc-break">
                  <tbody>
                    <BreakRow label="Sale" value={p.salePrice} />
                    <BreakRow label={`Fees (${pct(p.feePct)})`} value={p.feeAmount} sign="−" />
                    <tr className="pc-break-total"><td>Payout</td><td className="pc-break-val">{money(p.payout)}</td></tr>
                    <tr className={p.profit >= 0 ? 'pc-profit up' : 'pc-profit down'}>
                      <td>Profit</td><td className="pc-break-val">{money(p.profit)}</td>
                    </tr>
                    <tr className={p.profit >= 0 ? 'pc-profit up' : 'pc-profit down'}>
                      <td>ROI</td><td className="pc-break-val">{breakdown.finalCost > 0 ? pct(p.roi) : '—'}</td>
                    </tr>
                  </tbody>
                </table>
              ) : (
                <p className="muted sm pc-payout-empty">
                  {p.platform === 'alias' || sx?.configured
                    ? 'Enter a sale price, or tap a size above.'
                    : 'Enter a sale price — StockX prices aren’t configured on this server.'}
                </p>
              )}
            </div>
          ))}
        </div>

        {/* 4 — the call */}
        <h3 className="pc-h">The call</h3>
        <div className="pc-liq">
          <span className="pc-field-label">How often does it sell?</span>
          <div className="seg">
            {LIQUIDITY.map((l) => (
              <button type="button" key={l.key} className={`seg-btn ${liquidity === l.key ? 'on' : ''}`}
                aria-pressed={liquidity === l.key}
                onClick={() => { setLiquidityTouched(true); setLiquidity(liquidity === l.key ? '' : l.key); }}>{l.label}</button>
            ))}
          </div>
          {/* Say WHERE the answer came from. A picker that fills itself and doesn't
              explain why is a number nobody trusts — and this one drives the risk band. */}
          {velocity && velocity.sold_total > 0 ? (
            <span className="pc-liq-why muted sm">
              from our sales: <strong>{velocity.sold_30d}</strong> sold in 30 days
              {velocity.sold_90d > velocity.sold_30d ? `, ${velocity.sold_90d} in 90` : ''}
              {' · '}{velocity.per_week}/week
              {liquidityTouched ? ' — you overrode this' : ''}
            </span>
          ) : velocity ? (
            <span className="pc-liq-why muted sm">no sales on record for this style — pick one</span>
          ) : null}
        </div>

        {verdict ? (
          <div className={`pc-verdict ${verdict.call}`}>
            <div className="pc-verdict-top">
              <span className="pc-verdict-call">{CALL_LABEL[verdict.call]}</span>
              <span className="muted sm">best on {verdict.best.label}</span>
            </div>
            <div className="pc-verdict-rows">
              <div><span className="muted sm">Payout</span><span>{money(verdict.best.payout)}</span></div>
              <div><span className="muted sm">Profit / pair</span><span className={verdict.best.profit >= 0 ? 'up' : 'down'}>{money(verdict.best.profit)}</span></div>
              <div><span className="muted sm">ROI</span><span className={verdict.best.profit >= 0 ? 'up' : 'down'}>{pct(verdict.best.roi)}</span></div>
              <div><span className="muted sm">Risk</span><span className={`pc-risk ${verdict.risk}`}>{RISK_LABEL[verdict.risk]}</span></div>
              {verdict.spread != null && (
                <div><span className="muted sm">Platform spread</span><span>{money(verdict.spread)}</span></div>
              )}
            </div>
            <p className="pc-verdict-note">{verdict.note}</p>
          </div>
        ) : (
          <p className="muted mt">Enter a shelf price and at least one sale price to get a call.</p>
        )}
        <p className="pc-note muted sm">
          “Buy” needs both: at least {money(BUY_MIN_PROFIT)} profit a pair and {pct(BUY_MIN_ROI)} ROI. One of the two is a “Watch”.
        </p>

      </div>
    </div>
  );
}
