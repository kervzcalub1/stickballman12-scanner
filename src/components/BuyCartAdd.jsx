// "What are you buying?" — the buyer's half of a gift-card request.
//
// Enter a SKU or scan the barcode, tap the size in your hand, type what the shelf says,
// and the same arithmetic the Payout Calculator runs gives a Buy / Watch / Pass before
// the pair goes on the list. The cost stack is the buyer's OWN supplier preset, frozen
// onto the request when it was opened — so a rate edited next week can't restate what
// an approver was looking at when they said yes.
//
// **A Pass can still be added, on purpose.** The buyer is standing in the shop and may
// know something the market data doesn't; the verdict travels with the line and stays
// red on the approver's screen, so the disagreement is visible rather than prevented.
// A tool that refuses to record what someone wants to buy just moves the conversation
// to a chat app where nobody can audit it.
import React, { useState, lazy, Suspense } from 'react';
import { api } from '../api.js';
import { PriceInput } from './common.jsx';
import { Icon } from './NavIcons.jsx';
import { calcCostBreakdown, calcPayout, dealVerdict, DEFAULT_FEE_PCT } from '../lib/payout.js';

// Lazy, like every other camera surface here — the decoder is a large chunk and most
// buyers type the code.
const CameraScanner = lazy(() => import('./CameraScanner.jsx'));

const money = (n) => (n == null || !Number.isFinite(Number(n)) ? '—' : `$${Number(n).toFixed(2)}`);
const VERDICT_LABEL = { buy: 'Buy', watch: 'Watch', pass: 'Pass' };

export function VerdictChip({ verdict, className = '' }) {
  if (!verdict) return null;
  return <span className={`bc-verdict ${verdict} ${className}`}>{VERDICT_LABEL[verdict] || verdict}</span>;
}

export function BuyCartAdd({ cart, onAdded, onSignOut }) {
  const [skuInput, setSkuInput] = useState('');
  const [product, setProduct] = useState(null);
  const [size, setSize] = useState('');
  const [qty, setQty] = useState('1');
  const [shelf, setShelf] = useState('');
  const [market, setMarket] = useState(null);   // { alias, stockx } live prices
  const [velocity, setVelocity] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [showCam, setShowCam] = useState(false);

  const stack = cart.cost_stack || {};
  const shelfNum = Number(String(shelf).replace(/[$,\s]/g, ''));
  const qtyNum = Math.max(1, Number(qty) || 1);

  // The verdict is derived on every render from what is on screen — never stored in
  // state. A remembered call is one that can survive the number it was made about.
  const cost = shelfNum > 0 ? calcCostBreakdown({ ...stack, shelfPrice: shelfNum }) : null;
  const payouts = cost && market ? [
    ...(market.alias ? [calcPayout('alias', market.alias, cost.finalCost, DEFAULT_FEE_PCT.alias)] : []),
    ...(market.stockx ? [calcPayout('stockx', market.stockx, cost.finalCost, DEFAULT_FEE_PCT.stockx)] : []),
  ] : [];
  const verdict = cost ? dealVerdict(payouts, cost.finalCost, velocity?.liquidity || '') : null;

  // A scanned code is either a barcode off the box (all digits — a UPC, which names ONE
  // size) or a style code printed on the label. Sending a UPC to the SKU search finds
  // nothing, so route on the shape rather than making the buyer choose.
  async function routeScan(code) {
    const raw = String(code || '').trim();
    if (!raw) return;
    const digits = raw.replace(/\D/g, '');
    if (digits.length >= 12 && digits.length <= 14) {
      setBusy('look'); setError(''); setProduct(null); setSize(''); setMarket(null); setVelocity(null);
      try {
        const { product: p } = await api.searchUpc(digits);
        setProduct(p);
        if (p?.sku) setSkuInput(p.sku);
        // A UPC identifies one size's box, so it comes back with that size already
        // known — price it straight away rather than asking for a tap that has only
        // one possible answer.
        if (p?.size) { setBusy(''); await tapSize(p.size); return; }
      } catch (err) {
        if (err.unauthorized) return onSignOut();
        setError(err.message);
      } finally { setBusy(''); }
      return;
    }
    setSkuInput(raw);
    lookUp(null, raw);
  }

  async function lookUp(e, override) {
    e?.preventDefault();
    const sku = String(override || skuInput || '').trim();
    if (!sku) return;
    setBusy('look'); setError(''); setProduct(null); setSize(''); setMarket(null); setVelocity(null);
    try {
      const { product: p } = await api.searchSku(sku);
      setProduct(p);
      if (p?.sku) setSkuInput(p.sku);
    } catch (err) {
      if (err.unauthorized) return onSignOut();
      setError(err.message);
    } finally { setBusy(''); }
  }

  async function tapSize(sz) {
    if (String(sz) === String(size)) { setSize(''); setMarket(null); return; }
    setSize(String(sz)); setMarket(null); setError('');
    if (!product?.sku) return;
    setBusy('price');
    try {
      // `with_you` — the buyer holds the pair and ships it on sale, which is what
      // actually happens to a shoe bought this way. Same default as the calculator.
      const res = await api.payoutQuote(product.sku, [String(sz)], false);
      const a = res.results?.[0] || null;
      const sx = res.stockx?.results?.[0] || null;
      setVelocity(res.velocity || null);
      setMarket({
        alias: Number(a?.lowest_listing) > 0 ? Number(a.lowest_listing) : null,
        stockx: Number(sx?.lowest_ask) > 0 ? Number(sx.lowest_ask) : null,
        // Named so the strip can say "no market for this size" rather than going blank,
        // which reads as "we didn't look".
        aliasConfigured: !!res.configured,
        stockxError: res.stockx?.error || '',
      });
    } catch (err) {
      if (err.unauthorized) return onSignOut();
      setError(err.message);
    } finally { setBusy(''); }
  }

  async function add() {
    if (!product?.sku || !(shelfNum > 0)) return;
    setBusy('add'); setError('');
    try {
      const best = verdict?.best || null;
      await api.cartAddLine(cart.id, {
        sku: product.sku, size: size || null, qty: qtyNum, shelfPrice: shelfNum,
        name: product.name || null, colorway: product.colorway || null,
        gender: product.gender || null, upc: product.upc || null,
        // The snapshot. Everything an approver needs to see the same picture later,
        // including the two market prices it was computed from.
        verdict: verdict?.call || null,
        finalCost: cost?.finalCost ?? null,
        bestPlatform: best?.platform || null, bestPayout: best?.payout ?? null,
        profit: best?.profit ?? null, roi: best?.roi ?? null,
        aliasPrice: market?.alias ?? null, stockxPrice: market?.stockx ?? null,
        liquidity: velocity?.liquidity || null, basis: 'with_you',
      });
      // Clear the pair, keep the shoe: the next size of the same style is the common
      // next action in a shop, and re-looking it up would spend another call.
      setSize(''); setShelf(''); setQty('1'); setMarket(null);
      onAdded();
    } catch (err) {
      if (err.unauthorized) return onSignOut();
      setError(err.message);
    } finally { setBusy(''); }
  }

  return (
    <section className="card bc-add">
      <h3 className="bc-h">Add a pair</h3>
      <form className="bc-add-find" onSubmit={lookUp}>
        <input className="input" value={skuInput} onChange={(e) => setSkuInput(e.target.value)}
          placeholder="SKU or style code" autoCapitalize="characters" autoCorrect="off" spellCheck={false} />
        <button type="submit" className="btn primary" disabled={busy === 'look' || !skuInput.trim()}>
          {busy === 'look' ? 'Looking…' : 'Look up'}
        </button>
        <button type="button" className="btn ghost" onClick={() => setShowCam((v) => !v)}>
          <Icon name="camera" /> {showCam ? 'Close' : 'Scan'}
        </button>
      </form>

      {error && <div className="error mt">{error}</div>}

      {product && (
        <div className="bc-add-body">
          <div className="bc-add-shoe">
            <b>{product.name || product.sku}</b>
            <span className="muted sm"> {product.sku}{product.colorway ? ` · ${product.colorway}` : ''}</span>
          </div>

          <div className="bc-sizes" role="group" aria-label="Size">
            {(product.sizes || []).map((s) => {
              const label = typeof s === 'string' ? s : (s.size ?? s.label ?? '');
              return (
                <button key={label} type="button"
                  className={`chip ${String(label) === String(size) ? 'on' : ''}`}
                  onClick={() => tapSize(label)}>{label}</button>
              );
            })}
            {!(product.sizes || []).length && <span className="muted sm">No sizes listed — type the price and add it anyway.</span>}
          </div>

          <div className="bc-add-row">
            <label className="field">
              <span className="field-label">Price on the shelf</span>
              <PriceInput value={shelf} onChange={(e) => setShelf(e.target.value)} />
            </label>
            <label className="field bc-qty">
              <span className="field-label">Pairs</span>
              <input className="input" type="number" min="1" max="999" value={qty}
                onChange={(e) => setQty(e.target.value)} />
            </label>
          </div>

          {busy === 'price' && <p className="muted sm">Pricing that size…</p>}

          {market && (
            <div className="bc-market">
              <span>Alias <b>{market.alias ? money(market.alias) : '—'}</b></span>
              <span>StockX <b>{market.stockx ? money(market.stockx) : '—'}</b></span>
              {velocity?.sold > 0 && (
                <span className="muted sm">our sales: {velocity.sold} in {velocity.days} days · {velocity.liquidity}</span>
              )}
              {!market.alias && !market.stockx && <span className="muted sm">No market for this size.</span>}
            </div>
          )}

          {/* The call, and the arithmetic behind it — a verdict with no numbers under it
              is a number nobody checks. */}
          {cost && (
            <div className={`bc-call ${verdict?.call || 'none'}`}>
              <div className="bc-call-top">
                <VerdictChip verdict={verdict?.call} />
                <span className="muted sm">
                  Lands at {money(cost.finalCost)} a pair
                  {verdict ? ` · ${money(verdict.best.profit)} profit · ${verdict.best.roi.toFixed(1)}% ROI via ${verdict.best.label}` : ''}
                </span>
              </div>
              {verdict && <p className="bc-call-note">{verdict.note}</p>}
              {!verdict && <p className="bc-call-note muted">Tap the size to price it, or add it and let the desk decide.</p>}
            </div>
          )}

          <div className="bc-add-actions">
            <button type="button" className="btn primary" disabled={busy === 'add' || !(shelfNum > 0)} onClick={add}>
              {busy === 'add' ? 'Adding…' : 'Add to request'}
            </button>
            {verdict?.call === 'pass' && (
              <span className="muted sm">This one prices as a Pass — you can still add it, and the desk will see why.</span>
            )}
          </div>
        </div>
      )}

      {showCam && (
        <Suspense fallback={<p className="muted">Loading camera…</p>}>
          <CameraScanner mode="rescale" onClose={() => setShowCam(false)}
            onDetected={(c) => { setShowCam(false); routeScan(c); }} />
        </Suspense>
      )}
    </section>
  );
}
