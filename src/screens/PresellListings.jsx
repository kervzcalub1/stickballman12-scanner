// Pre-sell Listings — list pairs straight to Alias and/or StockX from a scan
// (docs/context/presell-listings.md).
//
// NOT the Pre-sell screen (PreSell.jsx, pre-sell.md), which holds back units of a shipment
// we already own. Here nothing becomes an inventory unit and nothing goes through Shopify.
// Pre-sell keeps its OWN stock: one row per SKU + size with how many pairs we have; each
// pair can be listed once per platform, every sale deducts, and once a size is sold out the
// listings left on the other platform come down by themselves (presell-worker.js).
import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { TopBar, Modal, CopyText, ShoeThumb } from '../components/common.jsx';
import { Icon } from '../components/NavIcons.jsx';
import { useLive } from '../hooks.js';
import { useQueryParam } from '../lib/urlstate.js';
import { isUpcCode } from '../lib/codes.js';
import { PH_DATETIME } from '../lib/format.js';

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
  const problem = lines.find((l) => !l.alias && !l.stockx) ? 'Every line needs Alias, StockX or both ticked.'
    : lines.find((l) => (l.alias && !(Number(l.aliasPrice) >= 1)) || (l.stockx && !(Number(l.stockxPrice) >= 1))) ? 'Every ticked platform needs a price.' : '';

  async function listAll() {
    setListing(true); setError('');
    try {
      const r = await api.presellListingsCreate({
        activate,
        items: lines.map((l) => ({
          sku: l.sku, name: l.name, image: l.image, upc: l.upc, size: l.size, qty: Number(l.qty) || 1,
          alias: l.alias ? { price: Number(l.aliasPrice) } : null, stockx: l.stockx ? { price: Number(l.stockxPrice) } : null,
        })),
      });
      // Lines that fully listed leave the cart. A line with failures stays, its pairs now in
      // Stock — so it's retried from the Stock tab's "List" (re-sending would add the qty twice).
      const failed = {};
      for (const ln of r.lines || []) {
        const errs = ['alias', 'stockx'].flatMap((p) => (ln[p]?.results || []).filter((x) => !x.ok).map((x) => `${PLAT[p]}: ${x.error}`));
        if (errs.length) failed[lineKey(ln.sku, ln.size)] = [...new Set(errs)].join(' · ');
      }
      setLines((ls) => ls.filter((l) => failed[l.key]).map((l) => ({ ...l, error: `${failed[l.key]} — the pairs are in Stock; retry with “List” there.`, done: true })));
      setResult(r);
    } catch (err) {
      if (err.unauthorized) return onSignOut();
      setError(err.message);
    } finally { setListing(false); setConfirm(false); }
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
        </form>
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
                <div className="oo-actions">
                  <button type="button" className="btn ghost" onClick={() => setLines([])} disabled={listing}>Clear</button>
                  <button type="button" className="btn primary" disabled={listing || !pairs || !!problem} onClick={() => setConfirm(true)}>
                    Create {listings} listing{listings === 1 ? '' : 's'}
                  </button>
                </div>
                {problem && <p className="muted sm">{problem}</p>}
              </>
            )}
          </>
        )}
      </div>

      {confirm && (
        <Modal type="warn" title={`${pairs} pair${pairs === 1 ? '' : 's'} → ${listings} listing${listings === 1 ? '' : 's'}?`}
          message={`${activate ? 'They go LIVE straight away — buyers can purchase them.' : 'They are created switched OFF — nobody can buy them until you switch them on.'} ${pairs} pair${pairs === 1 ? ' is' : 's are'} added to pre-sell stock.`}
          onClose={() => !listing && setConfirm(false)}>
          <button type="button" className="btn ghost" onClick={() => setConfirm(false)} disabled={listing}>Cancel</button>
          <button type="button" className="btn primary" onClick={listAll} disabled={listing}>{listing ? 'Listing…' : activate ? 'List live' : 'Create switched off'}</button>
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
                      <td><div className="ap-shoe"><ShoeThumb url={s.image} size={36} /><div><b>{s.sku}</b><div className="muted xs">{s.name}</div></div></div></td>
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
        {rows == null ? <p className="muted">Loading…</p> : !rows.length ? <p className="muted">{q ? `Nothing matches “${q}”.` : 'Nothing here.'}</p> : (
          <div className="ap-tablewrap">
            <table className="table">
              <thead><tr><th>Shoe</th><th>Size</th><th>Platform</th><th>Price</th><th>Status</th><th>Listing id</th><th>Listed</th><th /></tr></thead>
              <tbody>
                {rows.map((r) => {
                  const [label, tone] = STATUS[r.status] || [r.status, 'muted'];
                  const busy = busyId === r.id;
                  const open = ['live', 'off'].includes(r.status);
                  return (
                    <tr key={r.id}>
                      <td><div className="ap-shoe"><ShoeThumb url={r.image} size={36} /><div><b>{r.sku}</b><div className="muted xs">{r.name}</div></div></div></td>
                      <td>{r.size}</td>
                      <td>{PLAT[r.platform]}</td>
                      <td>{money(r.price_cents)}</td>
                      <td><span className={`ap-chip ${tone}`}>{label}</span>{r.last_error && <div className="error xs" title={r.last_error}>{r.last_error}</div>}</td>
                      <td><CopyText text={r.external_id || ''} className="ap-mono">{r.external_id || '—'}</CopyText></td>
                      <td className="muted xs">{when(r.created_at)}<div>{r.created_by}</div></td>
                      <td className="ap-actions">
                        {open && (
                          <>
                            <button type="button" className="btn sm ghost" disabled={busy} onClick={() => act(r, r.status === 'live' ? 'deactivate' : 'activate')}>{r.status === 'live' ? 'Switch off' : 'Go live'}</button>
                            <button type="button" className="btn sm ghost" disabled={busy} onClick={() => setEditing(r)}>Edit</button>
                          </>
                        )}
                        {r.external_id && <button type="button" className="btn sm ghost" disabled={busy} onClick={() => act(r, 'refresh')} title={`Re-read this listing from ${PLAT[r.platform]}`}>↻</button>}
                        {open && <button type="button" className="btn sm ghost danger" disabled={busy} onClick={() => setDeleting(r)}>Delete</button>}
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
        <Modal type="warn" title={`Delete ${deleting.sku} size ${deleting.size} from ${PLAT[deleting.platform]}?`}
          message="The listing is removed from the marketplace. The pair stays in pre-sell stock — list it again from the Stock tab." onClose={() => setDeleting(null)}>
          <button type="button" className="btn ghost" onClick={() => setDeleting(null)}>Cancel</button>
          <button type="button" className="btn danger" onClick={() => { const r = deleting; setDeleting(null); act(r, 'delete'); }}>Delete from {PLAT[deleting.platform]}</button>
        </Modal>
      )}
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
