// "What are you buying?" — the buyer's half of a gift-card request. BUYER-ONLY: staff
// never see this card, which is why nothing in it is conditional on a role.
//
// Enter a SKU or scan the barcode, tap EVERY size you found at that price, photograph
// the shoe, type what the ticket says — and asking is the same press as adding.
//
// What the buyer does NOT see here: the cost stack, what a pair lands at, and the buy
// call. All three are how the desk decides whether the pair is worth buying, and the
// party being judged does not get to read the ruling before asking.
//
// **The buy call is NOT made here (2026-09-10).** This screen used to fetch Alias and
// StockX in the buyer's browser, work out a Buy / Watch / Pass, show it to them, and
// POST it — which meant the person asking for the money supplied the figures that
// justified releasing it, and could read our call before we made it. Both halves were
// wrong. The market is now read server-side when the line is added (`cart/line`), and
// the call belongs to whoever approves the request (`canSeeBuyCall`).
//
// It is the same single upstream read, moved rather than added: tapping a size used to
// block on a quote, so a buyer who tried three sizes and added one spent three calls.
// Now the tap is instant and the add spends one — and if the market cannot be read at
// all, the line is still added, unpriced, because a pair not getting bought is worse
// than an approver pressing "Price it".
//
// **A pair the desk will turn down can still be added, on purpose.** The buyer is
// standing in the shop and may know something the market data doesn't. A tool that
// refuses to record what someone wants to buy just moves the conversation to a chat app
// where nobody can audit it.
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

/**
 * The PROSE behind a stored line's call — the sentence and the risk band the Payout
 * Calculator prints under its verdict, re-derived from the snapshot on the row.
 *
 * The numbers are NOT re-derived: `verdict`, `profit`, `roi` and `best_platform` are
 * rendered from the columns, so there is exactly one source of truth for anything a
 * person decides on. This only fills in what was never stored — `dealVerdict`'s note,
 * risk and spread — from the same inputs the server used, so the two cannot disagree.
 *
 * Returns null when the line carries no market price at all, which is the honest answer:
 * nobody priced it, and that is different from having priced it badly.
 */
export function lineCall(line, stack = {}) {
  const shelf = Number(line?.shelf_price);
  if (!(shelf > 0)) return null;
  const alias = Number(line.alias_price) > 0 ? Number(line.alias_price) : null;
  const stockx = Number(line.stockx_price) > 0 ? Number(line.stockx_price) : null;
  if (!alias && !stockx) return null;
  const cost = calcCostBreakdown({ ...stack, shelfPrice: shelf });
  const payouts = [
    ...(alias ? [calcPayout('alias', alias, cost.finalCost, DEFAULT_FEE_PCT.alias)] : []),
    ...(stockx ? [calcPayout('stockx', stockx, cost.finalCost, DEFAULT_FEE_PCT.stockx)] : []),
  ];
  return dealVerdict(payouts, cost.finalCost, line.liquidity || '');
}

export function BuyCartAdd({ cart, onAdded, onSignOut }) {
  const [skuInput, setSkuInput] = useState('');
  const [product, setProduct] = useState(null);
  // SIZES, plural. A buyer working a shelf finds the same shoe in an 8, a 9 and a 10 at
  // one price, and asking about them one at a time is three round trips and three photo
  // checks for one decision.
  const [sizes, setSizes] = useState([]);
  const [shelf, setShelf] = useState('');
  // ONE PRICE, WITH EXCEPTIONS. A shelf of the same shoe is usually one ticket price, and
  // making the buyer type it once per size would be the kind of retyping that gets a
  // size skipped. But a run often breaks — the 12.5 and the 13 sit at a different price
  // — and before this the only way to send those was a second request at a second price.
  // So `shelf` is what every selected size costs, and this map holds the ones that don't.
  // Keyed by the size label; blank means "use the shelf price".
  const [sizePrice, setSizePrice] = useState({});
  const [shooting, setShooting] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [showCam, setShowCam] = useState(false);

  const shelfNum = Number(String(shelf).replace(/[$,\s]/g, ''));
  // Photos already on this request for the shoe on screen. Keyed by STYLE CODE, so a
  // buyer sending a 7, an 8 and a 9 of one pair photographs it once.
  const shots = (cart.files || []).filter((f) => f.kind === 'shoe'
    && String(f.sku || '').toUpperCase() === String(product?.sku || '').toUpperCase());

  // No "lands at" here any more. The cost stack moved to the desk (`canWriteCosts`), so
  // what a pair lands at is now derived entirely from rates the buyer cannot see — and
  // printing the result would hand them the stack one subtraction at a time. They state
  // the ticket price; the desk decides what it means.

  // A scanned code is either a barcode off the box (all digits — a UPC, which names ONE
  // size) or a style code printed on the label. Sending a UPC to the SKU search finds
  // nothing, so route on the shape rather than making the buyer choose.
  async function routeScan(code) {
    const raw = String(code || '').trim();
    if (!raw) return;
    const digits = raw.replace(/\D/g, '');
    if (digits.length >= 12 && digits.length <= 14) {
      setBusy('look'); setError(''); setProduct(null); setSizes([]);
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
    setBusy('look'); setError(''); setProduct(null); setSizes([]);
    try {
      const { product: p } = await api.searchSku(sku);
      setProduct(p);
      if (p?.sku) setSkuInput(p.sku);
    } catch (err) {
      if (err.unauthorized) return onSignOut();
      setError(err.message);
    } finally { setBusy(''); }
  }

  // Just a selection now. The market read moved to the server, where the call is made
  // (`cart/line`) — so this no longer blocks the buyer on Alias while they are standing
  // at a shelf, and trying three sizes no longer spends three upstream calls.
  function tapSize(sz) {
    const v = String(sz);
    setSizes((cur) => (cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]));
    // Deselecting drops its own price with it. A stale override would come back the next
    // time that size was tapped and send a price the buyer typed for a different shoe.
    setSizePrice((cur) => {
      if (!(v in cur)) return cur;
      const next = { ...cur }; delete next[v]; return next;
    });
    setError('');
  }

  // What one size actually costs: its own price if it has one, the shelf price otherwise.
  function priceFor(sz) {
    const own = Number(String(sizePrice[String(sz)] ?? '').replace(/[$,\s]/g, ''));
    return own > 0 ? own : shelfNum;
  }
  const differing = sizes.filter((sz) => priceFor(sz) !== shelfNum).length;

  // A photo of the SHOE, hung off its style code. Required before the request can be
  // sent — the approver is deciding on something they cannot see, in a shop they are not
  // standing in, off a code that is four characters away from a different shoe.
  async function shoot(file) {
    if (!file || !product?.sku) return;
    setShooting(true); setError('');
    try {
      const { uploadUrl, key } = await api.cartFileSign(cart.id, 'shoe', file.type, product.sku);
      const put = await fetch(uploadUrl, { method: 'PUT', body: file });
      if (!put.ok) throw new Error('The photo did not upload. Try again.');
      await api.cartFileAttach({
        cartId: cart.id, kind: 'shoe', key, sku: product.sku, name: file.name,
        contentType: file.type, sizeBytes: file.size,
      });
      onAdded();
    } catch (err) {
      if (err.unauthorized) return onSignOut();
      setError(err.message);
    } finally { setShooting(false); }
  }

  async function add() {
    if (!product?.sku || !(shelfNum > 0)) return;
    setBusy('add'); setError('');
    try {
      // What the pair IS, and nothing about what it is worth. The server reads the
      // market and derives the call — anything sent from here would be the requester
      // supplying the figures that justify their own request, and is ignored.
      //
      // `with_you` — the buyer holds the pair and ships it on sale, which is what
      // actually happens to a shoe bought this way. Same default as the calculator.
      // One line per size, at the same shelf price. Sent in order and NOT in parallel:
      // each add re-reads the market server-side, and forty simultaneous ones would be
      // forty simultaneous Alias calls off one button.
      for (const sz of (sizes.length ? sizes : [null])) {
        await api.cartAddLine(cart.id, {
          // The price this SIZE is ticketed at, not the one at the top of the form.
          sku: product.sku, size: sz, shelfPrice: sz == null ? shelfNum : priceFor(sz),
          name: product.name || null, colorway: product.colorway || null,
          gender: product.gender || null, upc: product.upc || null,
          basis: 'with_you',
        });
      }
      // Clear the pair, keep the shoe: the next size of the same style is the common
      // next action in a shop, and re-looking it up would spend another call.
      setSizes([]); setShelf(''); setSizePrice({});
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
              const picked = sizes.includes(String(label));
              return (
                // `size-chip` is the app's existing size control (Receiving, the PH grid).
                // These shipped against a bare `chip`, which has no rule anywhere in
                // styles.css — so they rendered as the browser's default buttons: light
                // grey boxes on a dark screen, with no selected state at all. Same failure
                // as the `.table` one, and the same fix: use what already exists rather
                // than define a second chip beside it.
                <button key={label} type="button"
                  className={`size-chip ${picked ? 'on' : ''}`}
                  aria-pressed={picked}
                  onClick={() => tapSize(label)}>{label}</button>
              );
            })}
            {!(product.sizes || []).length && <span className="muted sm">No sizes listed — type the price and add it anyway.</span>}
            {sizes.length > 1 && (
              <p className="muted xs bc-sizes-note">
                {sizes.length} sizes selected — each goes on as its own line{shelfNum > 0 ? ` at ${money(shelfNum)}` : ''}, and the desk decides how many of each.
                {differing > 0 && shelfNum > 0 && ` ${differing} priced differently.`}
              </p>
            )}
          </div>

          <div className="bc-add-row">
            <label className="field">
              <span className="field-label">
                Price on the shelf{sizes.length > 1 ? <span className="muted xs"> · all {sizes.length} sizes</span> : null}
              </span>
              <PriceInput value={shelf} onChange={(e) => setShelf(e.target.value)} />
            </label>

          </div>

          {/* THE EXCEPTIONS, and only once there is a rule to except. A run of one shoe is
              usually one ticket price, so the field above covers it and this list stays
              out of the way; when the 12.5 and the 13 sit higher, they get typed here
              instead of going out as a second request at a second price.

              Blank means "the shelf price" rather than "free" — the placeholder shows
              what a blank box will actually send, because a row reading $0.00 next to a
              size is the kind of thing somebody fixes by typing a zero. */}
          {sizes.length > 1 && shelfNum > 0 && (
            <div className="bc-size-prices">
              <span className="field-label bc-size-prices-head">Different price on some sizes? Type it here.</span>
              <div className="bc-size-prices-grid">
                {sizes.map((sz) => (
                  <label key={sz} className="bc-size-price">
                    <span className="bc-size-price-sz">{sz}</span>
                    <PriceInput
                      value={sizePrice[sz] ?? ''}
                      placeholder={shelfNum.toFixed(2)}
                      aria-label={`Price for size ${sz}`}
                      onChange={(e) => setSizePrice((cur) => ({ ...cur, [sz]: e.target.value }))}
                    />
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* One set of shots per SHOE, not per size. Sending a 7, an 8 and a 9 of the
              same pair is the ordinary case, and photographing it three times is work
              nobody does twice — so it hangs off the style code and every line carrying
              it shows the same photos. */}
          <div className="bc-shots">
            <div className="bc-shots-head">
              <span className={shots.length ? 'bc-covered sm' : 'bc-short sm'}>
                {shots.length
                  ? `${shots.length} photo${shots.length === 1 ? '' : 's'} of this shoe ✓`
                  : 'No photo of this shoe yet — one is required'}
              </span>
              <label className="btn sm ghost bc-shot-btn">
                {shooting ? 'Uploading…' : shots.length ? 'Add another' : 'Take a photo'}
                <input type="file" accept="image/*" capture="environment" hidden
                  disabled={shooting}
                  onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; shoot(f); }} />
              </label>
            </div>
            <p className="muted xs">
              Covers every size of {product.sku} on this request. The desk sees it beside each line.
            </p>
          </div>


          <div className="bc-add-actions">
            {/* ADDING IS ASKING. There is no separate "send for approval" any more: the
                buyer is in a shop and the desk should be able to answer while the shoe
                is still on the shelf. The photo is required BEFORE this, because it is
                what the approver decides on. */}
            <button type="button" className="btn primary"
              disabled={busy === 'add' || !(shelfNum > 0) || !shots.length}
              onClick={add}>
              {busy === 'add'
                ? 'Sending…'
                : sizes.length > 1 ? `Ask about ${sizes.length} sizes` : 'Ask the desk about this'}
            </button>
            <span className="muted sm">
              {!shots.length
                ? 'Take a photo of the shoe first — it is what the desk decides on.'
                : !(shelfNum > 0)
                  ? 'Type the price on the shelf ticket.'
                  : 'Goes straight to the desk. They price it, decide, and say how many to buy.'}
            </span>
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
