// Pre-sell Listings — list pairs straight to Alias and/or StockX from a scan
// (docs/context/presell-listings.md).
//
// NOT the Pre-sell screen (PreSell.jsx, pre-sell.md), which holds back units of a shipment
// we already own. Here nothing becomes an inventory unit and nothing goes through Shopify.
// Pre-sell keeps its OWN stock: one row per SKU + size with how many pairs we have; each
// pair can be listed once per platform, every sale deducts, and once a size is sold out the
// listings left on the other platform come down by themselves (presell-worker.js).
import React, { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api.js';
import { TopBar, Modal, CopyText, ShoeThumb } from '../components/common.jsx';
import { Icon } from '../components/NavIcons.jsx';
import { useLive } from '../hooks.js';
import { useQueryParam } from '../lib/urlstate.js';
import { isUpcCode } from '../lib/codes.js';
import { parsePresellPaste } from '../lib/presellPaste.js';
import { landedFromShelf } from '../lib/costs.js';
import { calcPayout, DEFAULT_FEE_PCT } from '../lib/payout.js';

// The cost stack fields a supplier preset carries (payout_presets), in the order the
// Payout Calculator applies them.
const STACK_FIELDS = [
  ['storePct', 'Store discount', '%'], ['promoPct', 'Promo', '%'], ['giftPct', 'Gift card', '%'],
  ['cashbackPct', 'Cashback', '%'], ['taxPct', 'Sales tax', '%'], ['tipAmt', 'Tip / fee', '$'], ['shippingAmt', 'Shipping', '$'],
];
const stackOf = (p) => (p ? Object.fromEntries(STACK_FIELDS.map(([k]) => [k, Number(p[k]) || 0])) : null);
const money2 = (n) => (n == null || !Number.isFinite(n) ? '—' : `${n < 0 ? '−' : ''}$${Math.abs(n).toFixed(2)}`);
import { PH_DATE, PH_DATETIME, estToday } from '../lib/format.js';

const CameraScanner = lazy(() => import('../components/CameraScanner.jsx'));

const PLAT = { alias: 'Alias', stockx: 'StockX' };
const money = (cents) => (cents == null ? '—' : `$${(Number(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`);
const dollars = (v) => (v == null ? '—' : `$${Math.round(Number(v)).toLocaleString('en-US')}`);
const when = (ts) => (ts ? `${PH_DATETIME.format(new Date(ts))} EST` : '');
const lineKey = (sku, size) => `${sku}|${size}`;
const STATUS = { pending: ['Pending…', 'info'], live: ['Live', 'ok'], off: ['Not live', 'warn'], sold: ['Sold', 'sold'], deleted: ['Deleted', 'muted'], failed: ['Failed', 'bad'] };

// Each platform's own words for its market numbers (owner, 2026-10-07).
const MARKET = {
  alias: [['globalIndicator', 'Global Indicator'], ['lowestListing', 'Lowest Listing'], ['lastSold', 'Last Sold'], ['highestOffer', 'Highest Offer']],
  stockx: [['lowestAsk', 'Lowest Ask'], ['highestBid', 'Highest Bid'], ['sellFaster', 'Sell Faster'], ['earnMore', 'Earn More'], ['beatUS', 'Beat US']],
};
const BASIS_KEY = 'ap_price_basis';
const loadBasis = () => { try { return localStorage.getItem(BASIS_KEY) === 'with_you' ? 'with_you' : 'consigned'; } catch { return 'consigned'; } };
const saveBasis = (b) => { try { localStorage.setItem(BASIS_KEY, b); } catch { /* private mode */ } };

function Seg({ value, options, onChange, label }) {
  return (
    <div className="seg sm" role="group" aria-label={label}>
      {options.map(([k, text, n]) => (
        <button key={k} type="button" className={`seg-btn${value === k ? ' on' : ''}`} aria-pressed={value === k} onClick={() => onChange(k)}>
          {text}{n ? <span className="seg-n">{n}</span> : null}
        </button>
      ))}
    </div>
  );
}

// One size's market on one platform. Tapping a number uses it as that platform's price.
function Market({ platform, p, onPick }) {
  if (p === 'loading') return <span className="muted xs">Loading…</span>;
  if (!p || p.error) return <span className="muted xs">{p?.error ? 'Couldn’t load' : '—'}</span>;
  if (p.missing) return <span className="muted xs">Not on {PLAT[platform]}</span>;
  return (
    <div className="ap-mkt">
      {MARKET[platform].filter(([k]) => k !== 'beatUS' || p.beatUS != null).map(([k, label]) => (
        <button key={k} type="button" className="ap-mkt-cell" disabled={p[k] == null || !onPick} onClick={() => onPick?.(Math.round(p[k]))}
          title={p[k] == null ? `No ${label} on ${PLAT[platform]}` : `Use ${dollars(p[k])} as the ${PLAT[platform]} price`}>
          <span className="ap-mkt-label">{label}</span><span className="ap-mkt-val">{dollars(p[k])}</span>
        </button>
      ))}
    </div>
  );
}

// Market prices for (platform, sku, size), fetched once per SKU for whatever is missing.
function useMarket(platform, wanted, basis, onSignOut) {
  const [prices, setPrices] = useState({});
  const tag = platform === 'alias' ? `alias:${basis}` : 'stockx';
  const sig = `${tag}#${wanted.map((w) => lineKey(w.sku, w.size)).sort().join(',')}`;
  useEffect(() => {
    const missing = {};
    for (const w of wanted) if (prices[`${tag}|${w.sku}|${w.size}`] === undefined) (missing[w.sku] ||= []).push(w.size);
    const skus = Object.keys(missing);
    if (!skus.length) return;
    const put = (sku, fn) => setPrices((cur) => { const n = { ...cur }; for (const sz of missing[sku]) n[`${tag}|${sku}|${sz}`] = fn(sz); return n; });
    for (const sku of skus) {
      put(sku, () => 'loading');
      api.presellListingsPrices({ platform, sku, sizes: missing[sku], consigned: basis === 'consigned' })
        .then((r) => put(sku, (sz) => r.prices?.[sz] || null))
        .catch((err) => { if (err.unauthorized) return onSignOut(); put(sku, () => (err.status === 404 ? { missing: true } : { error: true })); });
    }
  }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  return (sku, size) => prices[`${tag}|${sku}|${size}`];
}

export function PresellListings({ onHome, onSignOut }) {
  const [tab, setTab] = useQueryParam('tab', 'new');
  return (
    <div className="app">
      <TopBar title="Pre-sell Listings" onHome={onHome} onSignOut={onSignOut} />
      <div className="card">
        <p className="muted sm">
          List pairs <b>straight to Alias and StockX</b> — never added to inventory, never through Shopify.
          Pre-sell keeps its own stock: every sale on either platform deducts a pair, and once a size is sold out
          the listings left on the other platform come down by themselves. Sales are posted to the pre-sell Telegram group.
          (Not the shipment <b>Pre-sell</b> screen.)
        </p>
        <Seg label="Section" value={tab} onChange={setTab}
          options={[['new', 'List new'], ['stock', 'Stock'], ['listings', 'Listings'], ['sales', 'Sales']]} />
      </div>
      {tab === 'stock' ? <StockTab onSignOut={onSignOut} />
        : tab === 'listings' ? <ListingsTab onSignOut={onSignOut} />
          : tab === 'sales' ? <SalesTab onSignOut={onSignOut} />
            : <ListNew onSignOut={onSignOut} onListed={() => setTab('listings')} />}
    </div>
  );
}

/* ------------------------------- List new ------------------------------- */
function ListNew({ onSignOut, onListed }) {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showCam, setShowCam] = useState(false);
  const [product, setProduct] = useState(null);
  // { key, sku, name, image, upc, size, qty, alias:bool, aliasPrice, stockx:bool, stockxPrice, error? }
  const [lines, setLines] = useState([]);
  const [activate, setActivate] = useState(true);
  // In transit (Alex, 2026-10-10): listed while on the truck; the listings are deleted when
  // the warehouse receives the SKU + size (api/_lib/presell-arrival.js).
  const [inTransit, setInTransit] = useState(false);
  const [transitNote, setTransitNote] = useState('');
  const [expectedOn, setExpectedOn] = useState('');
  // Cost for this purchase (2026-10-10): a supplier preset, editable for THIS purchase only
  // (the saved preset is untouched), applied to each line's shelf price → landed cost →
  // projected payout / profit per platform.
  const [presets, setPresets] = useState([]);
  const [presetId, setPresetId] = useState('');
  const [stack, setStack] = useState(null);       // the stack in use (a preset's, maybe edited)
  const [stackEdited, setStackEdited] = useState(false);
  const [editStack, setEditStack] = useState(false);
  const [allShelf, setAllShelf] = useState('');
  useEffect(() => { api.payoutPresets().then((r) => setPresets(r.presets || [])).catch(() => {}); }, []);
  function pickPreset(id) {
    setPresetId(id);
    const p = presets.find((x) => String(x.id) === String(id));
    setStack(stackOf(p)); setStackEdited(false); setEditStack(false);
  }
  const costOf = (l) => (stack ? landedFromShelf(l.shelfPrice, null, stack) : null);
  const [basis, setBasis] = useState(loadBasis);
  const [confirm, setConfirm] = useState(false);
  const [listing, setListing] = useState(false);
  const [result, setResult] = useState(null);
  const [allAlias, setAllAlias] = useState('');
  const [allStockx, setAllStockx] = useState('');
  const inputRef = useRef(null);
  const aliasOf = useMarket('alias', lines.filter((l) => l.alias), basis, onSignOut);
  const stockxOf = useMarket('stockx', lines.filter((l) => l.stockx), basis, onSignOut);

  function addLine(p, size, upc = null) {
    if (!size) return;
    setLines((ls) => {
      const k = lineKey(p.sku, size);
      if (ls.some((l) => l.key === k)) return ls.map((l) => (l.key === k ? { ...l, qty: String((Number(l.qty) || 0) + 1) } : l));
      return [...ls, { key: k, sku: p.sku, name: p.name, image: p.image, upc, size, qty: '1', alias: true, aliasPrice: allAlias, stockx: true, stockxPrice: allStockx }];
    });
  }
  async function find(raw) {
    const code = String(raw || '').trim();
    if (!code) return;
    setBusy(true); setError('');
    try {
      const upc = isUpcCode(code);
      const r = upc ? await api.searchUpc(code) : await api.searchSku(code.toUpperCase());
      if (!r.product?.sku) throw new Error('No product found.');
      // A dual style code: the marketplaces know one code at a time — list under the first.
      const prod = { ...r.product, sku: String(r.product.sku).split('/')[0] };
      setProduct(prod);
      if (upc && r.product.scannedSize) addLine(prod, r.product.scannedSize, code);
      setInput('');
    } catch (err) {
      if (err.unauthorized) return onSignOut();
      setError(err.message || 'Lookup failed.');
    } finally { setBusy(false); inputRef.current?.focus(); }
  }

  const setLine = (key, k, v) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, [k]: v } : l)));
  const pairs = lines.reduce((n, l) => n + (Number(l.qty) || 0), 0);
  const listings = lines.reduce((n, l) => n + (Number(l.qty) || 0) * ((l.alias ? 1 : 0) + (l.stockx ? 1 : 0)), 0);
  // Pairs first (owner, 2026-10-10: "292 listings" read like 292 shoes) — per platform it's
  // one listing per pair, all drawing on the same stock.
  const onAlias = lines.reduce((n, l) => n + (l.alias ? Number(l.qty) || 0 : 0), 0);
  const onStockx = lines.reduce((n, l) => n + (l.stockx ? Number(l.qty) || 0 : 0), 0);
  const platformsLabel = [onAlias && 'Alias', onStockx && 'StockX'].filter(Boolean).join(' + ');
  const perPlatform = [onAlias && `Alias ${onAlias}`, onStockx && `StockX ${onStockx}`].filter(Boolean).join(' + ');
  const problem = lines.find((l) => !l.alias && !l.stockx) ? 'Every line needs Alias, StockX or both ticked.'
    : lines.find((l) => (l.alias && !(Number(l.aliasPrice) >= 1)) || (l.stockx && !(Number(l.stockxPrice) >= 1))) ? 'Every ticked platform needs a price.' : '';

  // The server takes at most MAX_PER_CALL listings a call (pairs × platforms), so a big cart —
  // Alex's 145-pair shipment is 290 listings — goes in batches of whole lines, one after the
  // other. A line is never split across calls: re-sending a line adds its pairs again.
  const MAX_PER_CALL = 100;
  const [progress, setProgress] = useState('');
  async function listAll() {
    setListing(true); setError('');
    const todo = lines.filter((l) => !l.done);
    const batches = [];
    for (const l of todo) {
      const n = (Number(l.qty) || 1) * ((l.alias ? 1 : 0) + (l.stockx ? 1 : 0));
      const last = batches[batches.length - 1];
      if (last && last.n + n <= MAX_PER_CALL) { last.lines.push(l); last.n += n; } else batches.push({ lines: [l], n });
    }
    const failed = {};
    const sent = new Set();
    const total = { created: 0, failed: 0 };
    const runStart = new Date().toISOString();
    const stockIds = new Set();
    try {
      for (const [i, b] of batches.entries()) {
        if (batches.length > 1) setProgress(`Batch ${i + 1} of ${batches.length} (${b.n} listings)…`);
        const preset = presets.find((x) => String(x.id) === String(presetId));
        const r = await api.presellListingsCreate({
          activate,
          inTransit, transitNote: inTransit ? transitNote.trim() : '', expectedOn: inTransit ? expectedOn : '',
          costStack: stack ? { ...stack, preset: preset?.name || null, presetId: preset?.id || null, edited: stackEdited } : null,
          items: b.lines.map((l) => ({
            sku: l.sku, name: l.name, image: l.image, upc: l.upc, size: l.size, qty: Number(l.qty) || 1,
            shelfPrice: Number(l.shelfPrice) > 0 ? Number(l.shelfPrice) : null,
            alias: l.alias ? { price: Number(l.aliasPrice) } : null, stockx: l.stockx ? { price: Number(l.stockxPrice) } : null,
          })),
        });
        for (const l of b.lines) sent.add(l.key);
        for (const ln of r.lines || []) if (ln.stockId) stockIds.add(ln.stockId);
        total.created += r.created || 0; total.failed += r.failed || 0;
        // A line with failures stays (marked done), its pairs now in Stock — retried from the
        // Stock tab's "List" (re-sending would add the qty twice).
        for (const ln of r.lines || []) {
          const errs = ['alias', 'stockx'].flatMap((p) => (ln[p]?.results || []).filter((x) => !x.ok).map((x) => `${PLAT[p]}: ${x.error}`));
          if (errs.length) failed[lineKey(ln.sku, ln.size)] = [...new Set(errs)].join(' · ');
        }
      }
      setResult(total);
    } catch (err) {
      if (err.unauthorized) return onSignOut();
      setError(`${err.message}${sent.size ? ` — ${sent.size} line${sent.size === 1 ? ' was' : 's were'} already listed and left the cart; what's still here was NOT sent.` : ''}`);
    } finally {
      // Lines that went out leave the cart (or stay marked with their failure); unsent ones stay as they were.
      setLines((ls) => ls.filter((l) => !sent.has(l.key) || failed[l.key])
        .map((l) => (failed[l.key] ? { ...l, error: `${failed[l.key]} — the pairs are in Stock; retry with “List” there.`, done: true } : l)));
      setProgress(''); setListing(false); setConfirm(false);
      // ONE post to the pre-sell group for the whole run (Alex) — the server builds it from
      // what actually went through. Best effort: a Telegram hiccup never undoes a listing.
      if (stockIds.size) api.presellListingsAnnounce({ stockIds: [...stockIds], since: runStart }).catch(() => {});
    }
  }

  // 📋 Paste Alex's message: parsed into shoes × sizes × pairs, previewed, then added.
  const [paste, setPaste] = useState(null);   // null = closed · { text, parsed }
  async function addPasted(parsed) {
    setBusy(true); setError('');
    try {
      // Name + photo from our catalogue lookup, best effort — the message's own name wins.
      const found = await Promise.all(parsed.shoes.map((s) => api.searchSku(s.sku).then((r) => r.product || null).catch(() => null)));
      setLines((ls) => {
        let next = [...ls];
        parsed.shoes.forEach((s, i) => {
          const p = found[i];
          for (const z of s.sizes) {
            const k = lineKey(s.sku, z.size);
            const prev = next.find((l) => l.key === k);
            if (prev) next = next.map((l) => (l.key === k ? { ...l, qty: String((Number(l.qty) || 0) + z.qty) } : l));
            else next.push({ key: k, sku: s.sku, name: s.name || p?.name || '', image: p?.image || null, upc: null, size: z.size, qty: String(z.qty),
              alias: true, aliasPrice: allAlias, stockx: true, stockxPrice: allStockx });
          }
        });
        return next;
      });
      // Alex's messages are shipments already bought and on their way.
      setInTransit(true);
      setPaste(null);
    } catch (err) {
      if (err.unauthorized) return onSignOut();
      setError(err.message);
    } finally { setBusy(false); }
  }

  return (
    <>
      <div className="card">
        <form className="searchrow" onSubmit={(e) => { e.preventDefault(); find(input); }}>
          <input ref={inputRef} autoCapitalize="characters" autoCorrect="off" autoComplete="off"
            placeholder="Scan a box UPC — or type a SKU" aria-label="UPC or SKU"
            value={input} onChange={(e) => setInput(e.target.value)} disabled={busy} />
          <button className="btn primary" disabled={busy || !input.trim()}>{busy ? '…' : 'Find'}</button>
          <button type="button" className={`btn ${showCam ? 'primary' : 'ghost'}`} onClick={() => setShowCam((v) => !v)} title="Scan with camera">
            <Icon name="camera" /> {showCam ? 'Close camera' : 'Camera'}
          </button>
          <button type="button" className={`btn ${paste ? 'primary' : 'ghost'}`} onClick={() => setPaste((v) => (v ? null : { text: '', parsed: null }))}
            title="Paste a message like Alex's — style code, shoe name, then “size x pairs” lines">📋 Paste message</button>
        </form>
        {paste && (
          <div className="ap-paste">
            <textarea className="input" rows={8} value={paste.text} autoFocus
              placeholder={'JA1091-100\nNike Air Griffey Max 1 \'Cincinnati Reds\'\n\n8 x 12\n8.5 x 14\n9 x 19'}
              aria-label="Paste the message"
              onChange={(e) => setPaste({ text: e.target.value, parsed: parsePresellPaste(e.target.value) })} />
            {paste.parsed && (paste.parsed.shoes.length ? (
              <div className="ap-paste-preview">
                {paste.parsed.shoes.map((s) => (
                  <div key={s.sku}><b>{s.sku}</b>{s.name ? ` · ${s.name}` : ''}
                    <div className="muted sm">{s.sizes.map((z) => `${z.size} × ${z.qty}`).join(' · ')} — {s.sizes.reduce((n, z) => n + z.qty, 0)} pairs</div>
                    {s.sizes.some((z) => z.qty > 50) && <div className="error xs">Over 50 pairs in one size can't go in one go — lower it to 50 here and list the rest from Stock → List after.</div>}
                  </div>
                ))}
                {paste.parsed.skipped.length > 0 && (
                  <div className="muted xs">Not understood (left out): {paste.parsed.skipped.map((x) => `“${x.line}”`).join(', ')}</div>
                )}
                <div className="oo-actions">
                  <button type="button" className="btn ghost" onClick={() => setPaste(null)}>Cancel</button>
                  <button type="button" className="btn primary" disabled={busy} onClick={() => addPasted(paste.parsed)}>
                    {busy ? 'Adding…' : `Add ${paste.parsed.pairs} pairs to the list`}</button>
                </div>
                <p className="muted xs">Adds every size with its pairs, ticks Alias + StockX and <b>🚚 In transit</b> — set the prices, then Create.</p>
              </div>
            ) : <p className="muted sm">Paste the style code, then one line per size like <code>8 x 12</code> (size × pairs).</p>)}
          </div>
        )}
        {showCam && (
          <Suspense fallback={<p className="muted">Loading camera…</p>}>
            <CameraScanner mode="rescale" onDetected={(c) => { setShowCam(false); find(c); }} onClose={() => setShowCam(false)} />
          </Suspense>
        )}
        {error && <div className="error mt">{error}</div>}
        {product && (
          <div className="ap-product">
            <ShoeThumb url={product.image} size={64} />
            <div className="ap-product-info">
              <b>{product.name}</b>
              <div className="muted sm"><CopyText text={product.sku}>{product.sku}</CopyText>{product.colorway ? ` · ${product.colorway}` : ''}</div>
              <div className="muted xs">Tap a size to add a pair{product.scannedSize ? ` — size ${product.scannedSize} was added from the scan` : ''}.</div>
              <div className="ap-sizes">
                {(product.sizes || []).map((s) => <button key={s} type="button" className="btn sm ghost" onClick={() => addLine(product, s)}>{s}</button>)}
                {!product.sizes?.length && <span className="muted sm">No size run came back for this SKU.</span>}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <h3 className="rows-title">To list {pairs ? `· ${pairs} pair${pairs === 1 ? '' : 's'} → ${listings} listing${listings === 1 ? '' : 's'}` : ''}</h3>
        {!lines.length ? <p className="muted">Nothing yet — scan a box or type a SKU, then tap the sizes.</p> : (
          <>
            <div className="ap-cost">
              <div className="ap-cost-row">
                <label className="muted sm">Supplier preset (costs)
                  <select className="input" value={presetId} onChange={(e) => pickPreset(e.target.value)} aria-label="Supplier preset">
                    <option value="">— none (no cost) —</option>
                    {presets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </label>
                {stack && <button type="button" className={`btn sm ${editStack ? 'primary' : 'ghost'}`} onClick={() => setEditStack((v) => !v)}>✎ Edit for this purchase</button>}
                {stackEdited && <span className="ap-edited xs" title="Changed for this purchase only — the saved preset is untouched">edited for this purchase</span>}
                <label className="muted sm">Shelf price for all
                  <span className="ap-inline"><input type="number" min="1" step="0.01" inputMode="decimal" value={allShelf} placeholder="$" onChange={(e) => setAllShelf(e.target.value)} aria-label="Shelf price for every pair" />
                    <button type="button" className="btn sm" disabled={!(Number(allShelf) > 0)} onClick={() => setLines((ls) => ls.map((l) => ({ ...l, shelfPrice: allShelf })))}>Apply</button></span>
                </label>
              </div>
              {stack && editStack && (
                <div className="ap-stack">
                  {STACK_FIELDS.map(([k, label, unit]) => (
                    <label key={k} className="muted xs">{label} ({unit})
                      <input className="input" type="number" min="0" step="0.01" inputMode="decimal" value={stack[k]}
                        onChange={(e) => { setStack((s) => ({ ...s, [k]: e.target.value === '' ? 0 : Number(e.target.value) })); setStackEdited(true); }}
                        aria-label={`${label} for this purchase`} />
                    </label>
                  ))}
                  <button type="button" className="btn sm ghost" onClick={() => pickPreset(presetId)}>Reset to the preset</button>
                </div>
              )}
              {!stack && <p className="muted xs">Pick the supplier’s preset to turn each shelf price into a landed cost and see the payout and profit per platform. Without one the cost stays blank (the owner’s rule: shelf price alone isn’t the cost).</p>}
            </div>
            <div className="ap-bulk">
              <div className="ap-basis"><span className="muted xs">Alias prices</span>
                <Seg label="Alias price basis" value={basis} onChange={(b) => { saveBasis(b); setBasis(b); }} options={[['consigned', 'Consigned'], ['with_you', 'With You']]} />
              </div>
              <label className="muted sm">Alias price for all
                <span className="ap-inline"><input type="number" min="1" step="1" inputMode="decimal" value={allAlias} placeholder="$" onChange={(e) => setAllAlias(e.target.value)} aria-label="Alias price for every pair" />
                  <button type="button" className="btn sm" disabled={!(Number(allAlias) >= 1)} onClick={() => setLines((ls) => ls.map((l) => ({ ...l, aliasPrice: allAlias })))}>Apply</button></span>
              </label>
              <label className="muted sm">StockX price for all
                <span className="ap-inline"><input type="number" min="1" step="1" inputMode="decimal" value={allStockx} placeholder="$" onChange={(e) => setAllStockx(e.target.value)} aria-label="StockX price for every pair" />
                  <button type="button" className="btn sm" disabled={!(Number(allStockx) >= 1)} onClick={() => setLines((ls) => ls.map((l) => ({ ...l, stockxPrice: allStockx })))}>Apply</button></span>
              </label>
            </div>
            <div className="ap-cart">
              {lines.map((l, i) => (
                <div key={l.key} className="ap-cart-line">
                  <div className="ap-cart-head">
                    <div><b>{l.sku}</b> · size <b>{l.size}</b><div className="muted xs">{l.name}</div></div>
                    <label className="ap-qtyfield"><span className="muted xs">Pairs</span>
                      <input className="ap-qty" type="number" min="1" max="50" inputMode="numeric" value={l.qty} disabled={l.done}
                        onChange={(e) => setLine(l.key, 'qty', e.target.value)} aria-label={`Line ${i + 1} quantity`} /></label>
                    <label className="ap-qtyfield"><span className="muted xs">Shelf $</span>
                      <input className="ap-qty ap-shelf" type="number" min="0" step="0.01" inputMode="decimal" value={l.shelfPrice ?? ''} disabled={l.done}
                        onChange={(e) => setLine(l.key, 'shelfPrice', e.target.value)} aria-label={`Line ${i + 1} shelf price`} /></label>
                    <span className="ap-cost-out" title={stack ? 'Shelf price through the supplier preset (landed cost per pair)' : 'Pick a supplier preset to get the cost'}>
                      <span className="muted xs">Cost</span><b>{money2(costOf(l))}</b></span>
                    <button type="button" className="btn icon ghost remove sm" title="Remove" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>×</button>
                  </div>
                  {l.error && <div className="error xs">{l.error}</div>}
                  {!l.done && ['alias', 'stockx'].map((p) => (
                    <div key={p} className={`ap-plat${l[p] ? '' : ' off'}`}>
                      <label className="ap-plat-tick"><input type="checkbox" checked={l[p]} onChange={(e) => setLine(l.key, p, e.target.checked)} aria-label={`List line ${i + 1} on ${PLAT[p]}`} /> <b>{PLAT[p]}</b>{p === 'stockx' && <span className="muted xs"> · Direct</span>}</label>
                      {l[p] && (
                        <>
                          <Market platform={p} p={(p === 'alias' ? aliasOf : stockxOf)(l.sku, l.size)} onPick={(v) => setLine(l.key, `${p}Price`, String(v))} />
                          <input className="ap-price" type="number" min="1" step="1" inputMode="decimal" placeholder="$" value={l[`${p}Price`]}
                            onChange={(e) => setLine(l.key, `${p}Price`, e.target.value)} aria-label={`Line ${i + 1} ${PLAT[p]} price`} />
                          {Number(l[`${p}Price`]) > 0 && (() => {
                            const c = costOf(l);
                            const o = calcPayout(p, Number(l[`${p}Price`]), c ?? 0, DEFAULT_FEE_PCT[p]);
                            return (
                              <span className="ap-payout xs" title={`${PLAT[p]} fee ${DEFAULT_FEE_PCT[p]}%`}>
                                Payout <b>{money2(o.payout)}</b>
                                {c != null && <> · profit <b className={o.profit < 0 ? 'neg' : 'pos'}>{money2(o.profit)}</b></>}
                              </span>
                            );
                          })()}
                        </>
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </div>
            {lines.some((l) => !l.done) && (
              <>
                <label className="ap-activate">
                  <input type="checkbox" checked={activate} onChange={(e) => setActivate(e.target.checked)} />
                  <span><b>Go live now.</b> Untick to create the listings switched off — switch them on later from “Listings”.</span>
                </label>
                <label className="ap-activate">
                  <input type="checkbox" checked={inTransit} onChange={(e) => setInTransit(e.target.checked)} />
                  <span><b>🚚 In transit.</b> These pairs are still on their way. When the warehouse <b>receives</b> this SKU + size, every unsold Alias / StockX listing for it is <b>deleted</b> and the pre-sell group is told — then PH lists the real pairs.</span>
                </label>
                {inTransit && (
                  <div className="ap-transit">
                    <label><span className="muted xs">PO / tracking / supplier (optional)</span>
                      <input className="input" value={transitNote} maxLength={200} placeholder="e.g. Alex · PO 1042 · 1Z999…" onChange={(e) => setTransitNote(e.target.value)} /></label>
                    <label><span className="muted xs">Expected (optional)</span>
                      <input className="input" type="date" value={expectedOn} min={estToday()} onChange={(e) => setExpectedOn(e.target.value)} /></label>
                  </div>
                )}
                <div className="oo-actions">
                  <button type="button" className="btn ghost" onClick={() => setLines([])} disabled={listing}>Clear</button>
                  <button type="button" className="btn primary" disabled={listing || !pairs || !!problem} onClick={() => setConfirm(true)}>
                    List {pairs} pair{pairs === 1 ? '' : 's'}{platformsLabel ? ` on ${platformsLabel}` : ''}
                  </button>
                  <span className="muted xs">{listings} listing{listings === 1 ? '' : 's'} — one per pair on each platform, sharing ONE stock: a sale on either takes one down on the other.</span>
                </div>
                {problem && <p className="muted sm">{problem}</p>}
              </>
            )}
          </>
        )}
      </div>

      {confirm && (
        <Modal type="warn" title={`List ${pairs} pair${pairs === 1 ? '' : 's'}${platformsLabel ? ` on ${platformsLabel}` : ''}?`}
          message={`${activate ? 'They go LIVE straight away — buyers can purchase them.' : 'They are created switched OFF — nobody can buy them until you switch them on.'} ${pairs} pair${pairs === 1 ? ' is' : 's are'} added to pre-sell stock${perPlatform ? ` — ${perPlatform}` : ''}. Both platforms share that one stock: when a pair sells on either, one listing comes down on the other.${inTransit ? ' 🚚 In transit: when the warehouse receives them, the unsold listings are deleted automatically.' : ''}`}
          onClose={() => !listing && setConfirm(false)}>
          <button type="button" className="btn ghost" onClick={() => setConfirm(false)} disabled={listing}>Cancel</button>
          <button type="button" className="btn primary" onClick={listAll} disabled={listing}>{listing ? (progress || 'Listing…') : activate ? 'List live' : 'Create switched off'}</button>
        </Modal>
      )}
      {result && (
        <Modal type={result.failed ? 'warn' : 'success'}
          title={result.failed ? `${result.created} listed · ${result.failed} failed` : `${result.created} listing${result.created === 1 ? '' : 's'} created`}
          message={result.failed ? 'What failed is still shown with the reason — its pairs are in Stock, so retry with “List” there.' : 'StockX may show “Pending…” for a few seconds while it confirms.'}
          onClose={() => setResult(null)}>
          <button type="button" className="btn ghost" onClick={() => setResult(null)}>Keep listing</button>
          {result.created > 0 && <button type="button" className="btn primary" onClick={() => { setResult(null); onListed(); }}>See them</button>}
        </Modal>
      )}
    </>
  );
}

/* --------------------------------- Stock --------------------------------- */
function StockTab({ onSignOut }) {
  const [q, setQ] = useQueryParam('q', '');
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [qtyFor, setQtyFor] = useState(null);
  const [listFor, setListFor] = useState(null);   // { stock, platform }
  async function load() {
    try { const r = await api.presellListingsList({ tab: 'stock', q: q.trim() }); setRows(r.rows || []); setError(''); }
    catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
  }
  useEffect(() => { const t = setTimeout(load, q ? 300 : 0); return () => clearTimeout(t); }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
  useLive(['presell_stock', 'presell_listings'], load, { mount: false });
  return (
    <>
      <div className="card"><input type="search" className="oo-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="SKU or name…" aria-label="Search pre-sell stock" /></div>
      {error && <div className="error mt">{error}</div>}
      <div className="card">
        {rows == null ? <p className="muted">Loading…</p> : !rows.length ? <p className="muted">No pre-sell stock yet.</p> : (
          <div className="ap-tablewrap">
            <table className="table">
              <thead><tr><th>Shoe</th><th>Size</th><th className="num">Pairs</th><th className="num">Sold</th><th className="num">Left</th><th>Alias</th><th>StockX</th><th /></tr></thead>
              <tbody>
                {rows.map((s) => {
                  const left = Math.max(0, s.qty - s.sold);
                  return (
                    <tr key={s.id}>
                      <td><div className="ap-shoe"><ShoeThumb url={s.image} size={36} /><div><b>{s.sku}</b><div className="muted xs">{s.name}</div>
                        {s.in_transit && (s.arrived_at
                          ? <span className="ap-transit-chip arrived" title={`Received${s.arrived_batch ? ` in ${s.arrived_batch}` : ''} — the unsold listings were deleted`}>📦 Arrived {PH_DATE.format(new Date(s.arrived_at))}</span>
                          : <span className="ap-transit-chip" title={s.transit_note || 'Listings come down when the warehouse receives this SKU + size'}>🚚 In transit{s.expected_on ? ` · exp ${String(s.expected_on).slice(5, 10).replace('-', '/')}` : ''}</span>)}
                      </div></div></td>
                      <td>{s.size}</td>
                      <td className="num">{s.qty}</td><td className="num">{s.sold}</td><td className="num"><b>{left}</b></td>
                      {['alias', 'stockx'].map((p) => {
                        const open = s[`${p}_live`] + s[`${p}_other`];
                        return (
                          <td key={p}>
                            <span className="xs">{s[`${p}_live`]} live{s[`${p}_other`] ? ` · ${s[`${p}_other`]} other` : ''}</span>
                            {left > open && <button type="button" className="btn sm ghost ap-list-more" onClick={() => setListFor({ stock: s, platform: p })}>List {left - open}</button>}
                          </td>
                        );
                      })}
                      <td><button type="button" className="btn sm ghost" onClick={() => setQtyFor(s)}>Pairs…</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {qtyFor && <QtyDialog stock={qtyFor} onSignOut={onSignOut} onClose={() => setQtyFor(null)} onDone={() => { setQtyFor(null); load(); }} />}
      {listFor && <ListMoreDialog {...listFor} onSignOut={onSignOut} onClose={() => setListFor(null)} onDone={() => { setListFor(null); load(); }} />}
    </>
  );
}

function useEscape(onClose, busy) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);
}
function Dialog({ title, children, onClose, busy }) {
  useEscape(onClose, busy);
  return (
    <div className="modal-overlay" onClick={() => !busy && onClose()}>
      <div className="modal ap-edit" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">{title}</h3>
        {children}
      </div>
    </div>
  );
}

function QtyDialog({ stock, onSignOut, onClose, onDone }) {
  const [qty, setQty] = useState(String(stock.qty));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const open = stock.alias_live + stock.alias_other + stock.stockx_live + stock.stockx_other;
  async function save() {
    setBusy(true); setErr('');
    try { await api.presellListingsAction({ stockId: stock.id, action: 'qty', qty: Number(qty) }); onDone(); }
    catch (e) { if (e.unauthorized) return onSignOut(); setErr(e.message); setBusy(false); }
  }
  return (
    <Dialog title={`${stock.sku} size ${stock.size} — pairs we have`} onClose={onClose} busy={busy}>
      <p className="muted sm">{stock.sold} sold so far. Lowering the count takes down any listings beyond the pairs left ({open} open now).</p>
      <div className="ap-edit-fields"><label><span className="muted xs">Pairs (total, incl. sold)</span>
        <input type="number" min={stock.sold} max="999" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} aria-label="Pairs" /></label></div>
      {err && <div className="error mt">{err}</div>}
      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="btn primary" onClick={save} disabled={busy || !(Number(qty) >= stock.sold) || Number(qty) === stock.qty}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </Dialog>
  );
}

function ListMoreDialog({ stock, platform, onSignOut, onClose, onDone }) {
  const [price, setPrice] = useState('');
  const [activate, setActivate] = useState(true);
  const [basis, setBasis] = useState(loadBasis);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const marketOf = useMarket(platform, [{ sku: stock.sku, size: stock.size }], basis, onSignOut);
  const n = Math.max(0, stock.qty - stock.sold) - (stock[`${platform}_live`] + stock[`${platform}_other`]);
  async function go() {
    setBusy(true); setErr('');
    try {
      const r = await api.presellListingsAction({ stockId: stock.id, action: 'list', platform, price: Number(price), activate });
      const bad = (r.results || []).filter((x) => !x.ok);
      if (bad.length) { setErr(`${r.created} listed, ${bad.length} failed: ${[...new Set(bad.map((x) => x.error))].join(' · ')}`); setBusy(false); return; }
      onDone();
    } catch (e) { if (e.unauthorized) return onSignOut(); setErr(e.message); setBusy(false); }
  }
  return (
    <Dialog title={`List ${n} on ${PLAT[platform]} — ${stock.sku} size ${stock.size}`} onClose={onClose} busy={busy}>
      {platform === 'alias' && <div className="ap-basis"><span className="muted xs">Alias prices</span>
        <Seg label="Alias price basis" value={basis} onChange={(b) => { saveBasis(b); setBasis(b); }} options={[['consigned', 'Consigned'], ['with_you', 'With You']]} /></div>}
      <Market platform={platform} p={marketOf(stock.sku, stock.size)} onPick={(v) => setPrice(String(v))} />
      <div className="ap-edit-fields"><label><span className="muted xs">{PLAT[platform]} price (USD)</span>
        <input type="number" min="1" step="1" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} aria-label="Price" /></label></div>
      <label className="ap-activate"><input type="checkbox" checked={activate} onChange={(e) => setActivate(e.target.checked)} /><span><b>Go live now</b></span></label>
      {err && <div className="error mt">{err}</div>}
      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="btn primary" onClick={go} disabled={busy || !(Number(price) >= 1)}>{busy ? 'Listing…' : `List ${n}`}</button>
      </div>
    </Dialog>
  );
}

/* ------------------------------- Listings -------------------------------- */
function ListingsTab({ onSignOut }) {
  const [view, setView] = useQueryParam('view', 'all');
  const [platform, setPlatform] = useQueryParam('platform', '');
  const [q, setQ] = useQueryParam('q', '');
  const [rows, setRows] = useState(null);
  const [counts, setCounts] = useState({});
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  async function load() {
    try {
      const r = await api.presellListingsList({ tab: 'listings', view, platform, q: q.trim() });
      setRows(r.rows || []); setCounts(r.counts || {}); setError('');
    } catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
  }
  useEffect(() => { const t = setTimeout(load, q ? 300 : 0); return () => clearTimeout(t); }, [q, view, platform]); // eslint-disable-line react-hooks/exhaustive-deps
  // The watcher flips StockX "Pending…" rows in the DB; live updates bring them in.
  useLive(['presell_listings'], load, { mount: false });
  async function act(row, action) {
    setBusyId(row.id); setError('');
    try { await api.presellListingsAction({ listingId: row.id, action }); await load(); }
    catch (err) { if (err.unauthorized) return onSignOut(); setError(`${row.sku} ${row.size} (${PLAT[row.platform]}): ${err.message}`); }
    finally { setBusyId(null); }
  }
  // A row-level action ("Switch both off", "Delete both") — one listing at a time, so a
  // failure on one platform is reported without stopping the other.
  async function actMany(list, action) {
    for (const l of list) await act(l, action);
  }
  // One row per PAIR, the way the team's sheet reads: a stock row's StockX and Alias
  // listings matched up oldest-first (pair 1 = the first listing on each platform), so
  // a size with 2 pairs is 2 rows, each with its own StockX and Alias pill.
  const pairs = useMemo(() => {
    const groups = new Map();
    for (const r of [...(rows || [])].reverse()) {
      const g = groups.get(r.stock_id) || { stock_id: r.stock_id, sku: r.sku, name: r.name, image: r.image, size: r.size, alias: [], stockx: [], latest: r.created_at };
      g[r.platform]?.push(r);
      g.latest = r.created_at;
      groups.set(r.stock_id, g);
    }
    return [...groups.values()]
      .sort((a, b) => new Date(b.latest) - new Date(a.latest))
      .flatMap((g) => Array.from({ length: Math.max(g.alias.length, g.stockx.length) }, (_, i) => ({
        key: `${g.stock_id}-${i}`, sku: g.sku, name: g.name, image: g.image, size: g.size, alias: g.alias[i] || null, stockx: g.stockx[i] || null,
      })));
  }, [rows]);
  return (
    <>
      <div className="card">
        <div className="oo-toolbar">
          <Seg label="Platform" value={platform} onChange={setPlatform} options={[['', 'Both'], ['alias', 'Alias'], ['stockx', 'StockX']]} />
          <Seg label="Show" value={view} onChange={setView} options={[['all', 'Open', counts.all], ['live', 'Live', counts.live], ['off', 'Not live', counts.off], ['pending', 'Pending', counts.pending], ['sold', 'Sold', counts.sold], ['deleted', 'Deleted', counts.deleted]]} />
          <input type="search" className="oo-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="SKU, name or listing id…" aria-label="Search listings" />
        </div>
      </div>
      {error && <div className="error mt">{error}</div>}
      <div className="card">
        {rows == null ? <p className="muted">Loading…</p> : !pairs.length ? <p className="muted">{q ? `Nothing matches “${q}”.` : 'Nothing here.'}</p> : (
          <div className="ap-tablewrap">
            <table className="table ap-pairs">
              <thead><tr><th>Product details</th><th>Size</th><th>Platform</th><th>Listing date</th><th>Options</th></tr></thead>
              <tbody>
                {pairs.map((p) => {
                  const open = [p.stockx, p.alias].filter((l) => l && OPEN.includes(l.status));
                  const busy = [p.stockx, p.alias].some((l) => l && busyId === l.id);
                  const errs = [p.stockx, p.alias].filter((l) => l?.last_error);
                  const first = [p.stockx, p.alias].filter(Boolean).sort((a, b) => new Date(a.created_at) - new Date(b.created_at))[0];
                  return (
                    <tr key={p.key}>
                      <td>
                        <div className="ap-shoe"><ShoeThumb url={p.image} size={36} /><div><b>{p.sku}</b><div className="muted xs">{p.name}</div></div></div>
                        {errs.map((l) => <div key={l.id} className="error xs" title={l.last_error}>{PLAT[l.platform]}: {l.last_error}</div>)}
                      </td>
                      <td className="ap-size">{p.size}</td>
                      <td>
                        <div className="ap-pills">
                          {['stockx', 'alias'].filter((pl) => !platform || pl === platform).map((pl) => (
                            <PlatformPill key={pl} platform={pl} listing={p[pl]} busy={busy}
                              onAct={act} onEdit={setEditing} onDelete={(l) => setDeleting([l])} />
                          ))}
                        </div>
                      </td>
                      <td className="ap-date"><b>{first ? PH_DATE.format(new Date(first.created_at)) : '—'}</b><div className="muted xs">{first?.created_by || ''}</div></td>
                      <td>
                        <DropMenu label="More…" className="ap-more" disabled={busy}
                          head={first ? `Listed ${when(first.created_at)}${first.created_by ? ` by ${first.created_by}` : ''}` : null}
                          items={[
                            { label: 'Switch both on', hidden: !open.some((l) => l.status === 'off'), onClick: () => actMany(open.filter((l) => l.status === 'off'), 'activate') },
                            { label: 'Switch both off', hidden: !open.some((l) => l.status === 'live'), onClick: () => actMany(open.filter((l) => l.status === 'live'), 'deactivate') },
                            { label: 'Re-read from the marketplaces', hidden: ![p.stockx, p.alias].some((l) => l?.external_id), onClick: () => actMany([p.stockx, p.alias].filter((l) => l?.external_id), 'refresh') },
                            { label: open.length > 1 ? 'Delete both' : 'Delete listing', danger: true, hidden: !open.length, onClick: () => setDeleting(open) },
                          ]} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {editing && <EditListing row={editing} onSignOut={onSignOut} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
      {deleting && (
        <Modal type="warn" title={`Delete ${deleting[0].sku} size ${deleting[0].size} from ${deleting.map((l) => PLAT[l.platform]).join(' and ')}?`}
          message={`${deleting.length > 1 ? 'Both listings are' : 'The listing is'} removed from the marketplace. The pair stays in pre-sell stock — list it again from the Stock tab.`} onClose={() => setDeleting(null)}>
          <button type="button" className="btn ghost" onClick={() => setDeleting(null)}>Cancel</button>
          <button type="button" className="btn danger" onClick={() => { const ls = deleting; setDeleting(null); actMany(ls, 'delete'); }}>Delete from {deleting.map((l) => PLAT[l.platform]).join(' + ')}</button>
        </Modal>
      )}
    </>
  );
}

const OPEN = ['live', 'off'];
// What each listing status reads as on its pill — the sheet's "StockX (ON)" / "Alias (OFF)".
const PILL = { live: ['ON', 'on'], off: ['OFF', 'off'], pending: ['PENDING', 'pending'], failed: ['FAILED', 'off'], sold: ['SOLD', 'sold'], deleted: ['DELETED', 'none'] };

// One platform's listing for a pair: a coloured pill that opens that listing's actions.
function PlatformPill({ platform, listing: l, busy, onAct, onEdit, onDelete }) {
  if (!l) return <span className="ap-pill none" title={`Not listed on ${PLAT[platform]} — list it from the Stock tab`}>{PLAT[platform]} (—)</span>;
  const [word, tone] = PILL[l.status] || [String(l.status).toUpperCase(), 'none'];
  const open = OPEN.includes(l.status);
  return (
    <div className="ap-pill-wrap">
      <DropMenu label={`${PLAT[platform]} (${word})`} className={`ap-pill ${tone}`} disabled={busy}
        title={`${PLAT[platform]} · ${STATUS[l.status]?.[0] || l.status} · ${money(l.price_cents)}`}
        head={l.external_id ? `${PLAT[platform]} listing ${l.external_id}` : null}
        items={[
          { label: l.status === 'live' ? 'Switch off' : 'Go live', hidden: !open, onClick: () => onAct(l, l.status === 'live' ? 'deactivate' : 'activate') },
          { label: platform === 'alias' ? 'Edit price / size…' : 'Edit price…', hidden: !open, onClick: () => onEdit(l) },
          { label: `Re-read from ${PLAT[platform]}`, hidden: !l.external_id, onClick: () => onAct(l, 'refresh') },
          { label: 'Copy listing id', hidden: !l.external_id, onClick: () => navigator.clipboard?.writeText(l.external_id).catch(() => {}) },
          { label: `Delete from ${PLAT[platform]}`, danger: true, hidden: !open, onClick: () => onDelete(l) },
        ]} />
      <span className="ap-pill-price">{money(l.price_cents)}</span>
    </div>
  );
}

// A button that opens a small menu. Portalled + fixed so the table's horizontal scroll
// box can't clip it; closes on outside tap, Escape, scroll or resize.
function DropMenu({ label, className = '', items, head, disabled, title }) {
  const [pos, setPos] = useState(null);
  const btn = useRef(null);
  const pop = useRef(null);
  const shown = items.filter((i) => !i.hidden);
  useEffect(() => {
    if (!pos) return undefined;
    const close = () => setPos(null);
    const onDown = (e) => { if (!pop.current?.contains(e.target) && !btn.current?.contains(e.target)) close(); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close);
    };
  }, [pos]);
  function toggle() {
    if (pos) return setPos(null);
    const r = btn.current.getBoundingClientRect();
    const w = 230;
    const below = window.innerHeight - r.bottom > 220;
    setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - w - 8)), ...(below ? { top: r.bottom + 4 } : { bottom: window.innerHeight - r.top + 4 }), width: w });
  }
  return (
    <>
      <button type="button" ref={btn} className={`ap-drop ${className}`} disabled={disabled || !shown.length} title={title}
        aria-haspopup="menu" aria-expanded={!!pos} onClick={toggle}>
        <span>{label}</span><span className="ap-drop-caret" aria-hidden="true">▾</span>
      </button>
      {pos && createPortal(
        <div className="ap-menu" role="menu" ref={pop} style={pos}>
          {head && <div className="ap-menu-head">{head}</div>}
          {shown.map((i) => (
            <button key={i.label} type="button" role="menuitem" className={`ap-menu-item${i.danger ? ' danger' : ''}`}
              onClick={() => { setPos(null); i.onClick(); }}>{i.label}</button>
          ))}
        </div>, document.body)}
    </>
  );
}

// Price (both platforms) and size (Alias only — StockX's size IS the listing).
function EditListing({ row, onSignOut, onClose, onSaved }) {
  const [price, setPrice] = useState(String(Math.round(Number(row.price_cents) / 100)));
  const [size, setSize] = useState(row.size);
  const [basis, setBasis] = useState(loadBasis);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const sz = row.platform === 'alias' ? size.trim() : row.size;
  const marketOf = useMarket(row.platform, sz ? [{ sku: row.sku, size: sz }] : [], basis, onSignOut);
  async function save() {
    setBusy(true); setErr('');
    try {
      await api.presellListingsAction({ listingId: row.id, action: 'update', price: Number(price), size: sz !== row.size ? sz : undefined });
      onSaved();
    } catch (e) { if (e.unauthorized) return onSignOut(); setErr(e.message); setBusy(false); }
  }
  const changed = Math.round(Number(price) * 100) !== Number(row.price_cents) || sz !== row.size;
  return (
    <Dialog title={`${row.sku} · ${PLAT[row.platform]}`} onClose={onClose} busy={busy}>
      <p className="muted sm">{row.name} — now size {row.size} at {money(row.price_cents)}.</p>
      <div className="ap-edit-fields">
        {row.platform === 'alias'
          ? <label><span className="muted xs">Size (US)</span><input value={size} onChange={(e) => setSize(e.target.value)} aria-label="Size" /></label>
          : <label><span className="muted xs">Size</span><input value={row.size} disabled aria-label="Size" title="StockX can't change a listing's size" /></label>}
        <label><span className="muted xs">Price (USD)</span><input type="number" min="1" step="1" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} aria-label="Price" /></label>
      </div>
      {row.platform === 'alias' && <p className="muted xs">A new size moves this pair to that size’s pre-sell stock.</p>}
      <div className="ap-edit-mkt">
        {row.platform === 'alias' && <div className="ap-basis"><span className="muted xs">Alias prices for size {sz || '—'}</span>
          <Seg label="Alias price basis" value={basis} onChange={(b) => { saveBasis(b); setBasis(b); }} options={[['consigned', 'Consigned'], ['with_you', 'With You']]} /></div>}
        {row.platform === 'stockx' && <span className="muted xs">StockX Direct market for size {sz}</span>}
        {sz && <Market platform={row.platform} p={marketOf(row.sku, sz)} onPick={(v) => setPrice(String(v))} />}
      </div>
      {err && <div className="error mt">{err}</div>}
      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="btn primary" onClick={save} disabled={busy || !changed || !(Number(price) >= 1) || !sz}>{busy ? 'Updating…' : `Update on ${PLAT[row.platform]}`}</button>
      </div>
    </Dialog>
  );
}

/* --------------------------------- Sales --------------------------------- */
function SalesTab({ onSignOut }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [cfg, setCfg] = useState(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { api.presellListingsSettings().then(setCfg).catch((err) => { if (err.unauthorized) onSignOut(); }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  async function toggleAll(on) {
    setSaving(true);
    try { setCfg(await api.setPresellListingsSettings({ allSales: on })); }
    catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setSaving(false); }
  }
  async function load() {
    try { const r = await api.presellListingsList({ tab: 'sales' }); setRows(r.rows || []); setError(''); }
    catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
  }
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useLive(['presell_sales'], load, { mount: false });
  return (
    <>
      {cfg && (
        <div className="card">
          {!cfg.groupSet && <p className="error sm">The pre-sell Telegram group isn’t set yet (TELEGRAM_PRESELL_CHAT_ID) — sales are recorded here but not posted.</p>}
          <label className="ap-activate">
            <input type="checkbox" checked={!!cfg.allSalesSince} disabled={!cfg.canEdit || saving} onChange={(e) => toggleAll(e.target.checked)} />
            <span>
              <b>Also alert regular Alias + StockX sales (testing).</b> Every sale on either account — not just pre-sell — posts to the
              same group as “🛒 SOLD … regular stock (test alert)”. Only orders placed after it’s switched on.
              {cfg.allSalesSince && <span className="muted"> On since {when(cfg.allSalesSince)}.</span>}
              {!cfg.canEdit && <span className="muted"> (Admins can change this.)</span>}
            </span>
          </label>
        </div>
      )}
      {error && <div className="error mt">{error}</div>}
      <div className="card">
        {rows == null ? <p className="muted">Loading…</p> : !rows.length ? <p className="muted">No pre-sell sales yet — they appear here (and in the Telegram group) within a minute of selling.</p> : (
          <div className="ap-tablewrap">
            <table className="table">
              <thead><tr><th>Sold</th><th>Shoe</th><th>Size</th><th>Platform</th><th className="num">Price</th><th className="num">Payout</th><th>Order</th><th>Telegram</th></tr></thead>
              <tbody>
                {rows.map((x) => (
                  <tr key={x.id}>
                    <td className="xs">{when(x.sold_at || x.created_at)}</td>
                    <td><div className="ap-shoe"><ShoeThumb url={x.image} size={36} /><div><b>{x.sku}</b><div className="muted xs">{x.name}</div></div></div></td>
                    <td>{x.size}</td>
                    <td>{PLAT[x.platform] || x.platform}</td>
                    <td className="num">{money(x.price_cents)}</td>
                    <td className="num">{money(x.payout_cents)}</td>
                    <td><CopyText text={x.order_id} className="ap-mono">{x.order_id}</CopyText></td>
                    <td className="xs">{x.notified_at ? 'Sent' : <span className="error xs" title={x.notify_error || ''}>{x.notify_error ? 'Not sent' : '—'}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
