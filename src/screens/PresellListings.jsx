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
import { AliasCodeCheck, aliasOnlyCode } from '../components/AliasCodeCheck.jsx';
import { isUpcCode } from '../lib/codes.js';
import { parsePresellPaste } from '../lib/presellPaste.js';
import { calcPayout, DEFAULT_FEE_PCT } from '../lib/payout.js';
import { parseTrackingList, saleNet, pairsLeft, listableOn, pairsOwed, presellUnitCost, costBasis, costNote, COST_REASON } from '../lib/presellDetails.js';
import { COMP_MODES, compFloor } from '../lib/presellCompete.js';
import { assignWhere, pickGroups, fulfillTotals, urgency, timeLeft, labelLink, WHERE } from '../lib/presellFulfill.js';
import { boxOrder, boxSummary, boxState, shortTrack } from '../lib/presellBoxes.js';

// The cost stack fields a supplier preset carries (payout_presets), in the order the
// Payout Calculator applies them.
const STACK_FIELDS = [
  ['storePct', 'Store discount', '%'], ['promoPct', 'Promo', '%'], ['giftPct', 'Gift card', '%'],
  ['cashbackPct', 'Cashback', '%'], ['taxPct', 'Sales tax', '%'], ['tipAmt', 'Tip / fee', '$'], ['shippingAmt', 'Shipping', '$'],
];
const stackOf = (p) => (p ? Object.fromEntries(STACK_FIELDS.map(([k]) => [k, Number(p[k]) || 0])) : null);
// "Our own fees" in the preset menu (owner, 2026-10-25): a supplier with no preset — the fees
// are typed for this purchase from zero, and nothing is saved as a preset.
const OWN = 'own';
const stackFor = (id, presets) => (id === OWN ? stackOf({}) : stackOf(presets.find((x) => String(x.id) === String(id))));
// The stack as sent: a preset's (named), our own fees, or none (the shelf price is the cost).
const stackToSend = (stack, id, preset, edited, fallbackName = null) => (!stack ? null : id === OWN
  ? { ...stack, preset: null, presetId: null, edited: false, own: true }
  : { ...stack, preset: preset?.name || fallbackName, presetId: preset?.id || null, edited });
const money2 = (n) => (n == null || !Number.isFinite(n) ? '—' : `${n < 0 ? '−' : ''}$${Math.abs(n).toFixed(2)}`);
import { PH_DATE, PH_DATETIME, estToday, estDate, estTime } from '../lib/format.js';

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

// The POs a pre-sell purchase can be linked to (open ones first), loaded once per screen.
function usePresellPos() {
  const [pos, setPos] = useState([]);
  useEffect(() => { api.presellListingsList({ tab: 'pos' }).then((r) => setPos(r.pos || [])).catch(() => {}); }, []);
  return pos;
}
const poLabel = (p) => `${p.po_code} · ${p.supplier_name}${p.tag_code ? ` · ${p.tag_code}` : ''}${p.status && p.status !== 'draft' ? ` (${p.status})` : ''}`;

// Where the pairs come from (2026-10-10): supplier, the PO they were bought on, and every
// tracking number of the shipment — pasted many at once (one per line, commas, spaces,
// or straight out of the supplier's message). value = { supplier, poId, tracking }.
function SourceFields({ value, onChange, pos, presets }) {
  const set = (k, v) => onChange({ ...value, [k]: v });
  const po = pos.find((p) => String(p.id) === String(value.poId));
  const parsed = parseTrackingList(value.tracking);
  const poTracks = (po?.tracking_numbers || []).filter((t) => !parsed.includes(String(t).replace(/[^0-9a-z]/gi, '').toUpperCase()));
  const names = [...new Set([...presets.map((p) => p.name), ...pos.map((p) => p.supplier_name)].filter(Boolean))].sort();
  return (
    <div className="ap-source">
      <label><span className="muted xs">Supplier</span>
        <input className="input" list="ap-supplier-names" value={value.supplier} maxLength={80} placeholder="e.g. the supplier’s preset name"
          onChange={(e) => set('supplier', e.target.value)} aria-label="Supplier" />
        <datalist id="ap-supplier-names">{names.map((n) => <option key={n} value={n} />)}</datalist>
      </label>
      <label><span className="muted xs">Purchase order (optional)</span>
        <select className="input" value={value.poId || ''} aria-label="Purchase order"
          onChange={(e) => {
            const p = pos.find((x) => String(x.id) === e.target.value);
            onChange({ ...value, poId: e.target.value, supplier: value.supplier || p?.supplier_name || '' });
          }}>
          <option value="">— not on a PO —</option>
          {pos.map((p) => <option key={p.id} value={p.id}>{poLabel(p)}</option>)}
        </select>
      </label>
      <label className="ap-source-track"><span className="muted xs">Tracking numbers — paste as many as you have</span>
        <textarea className="input" rows={3} value={value.tracking} placeholder={'1Z999AA10123456784\n1Z999AA10123456785, 9400111899223197428490'}
          onChange={(e) => set('tracking', e.target.value)} aria-label="Tracking numbers" />
        <span className="muted xs">
          {parsed.length ? `${parsed.length} tracking number${parsed.length === 1 ? '' : 's'}` : 'None yet'}
          {poTracks.length > 0 && <> · <button type="button" className="linklike" onClick={() => set('tracking', [value.tracking.trim(), ...poTracks].filter(Boolean).join('\n'))}>
            add the PO’s {poTracks.length} tracking number{poTracks.length === 1 ? '' : 's'}</button></>}
        </span>
      </label>
    </div>
  );
}

// 📄 Report (2026-10-10): a date range (EST) → PDF or CSV. Stock = what's left (pairs first
// listed in the range); Sales = what sold in the range. Built from a fresh read, so the
// file is whole even when the screen shows a search.
const REPORTS = {
  stock: { tab: 'stock', file: 'presell-stock', label: 'Listed from', blurb: 'the pairs we have — pairs, sold, left, in transit, supplier, PO, tracking, cost',
    csv: 'stockReportCsv', pdf: 'stockReportPdf' },
  listings: { tab: 'listings', file: 'presell-listings', label: 'Created from', blurb: 'every Alias / StockX listing — status, price, est. payout, listing id',
    csv: 'listingsReportCsv', pdf: 'listingsReportPdf' },
  sales: { tab: 'sales', file: 'presell-sales', label: 'Sold from', blurb: 'what sold — price, payout, cost, net',
    csv: 'salesReportCsv', pdf: 'salesReportPdf' },
};
// 📄 Report — each tab its own (owner, 2026-10-10): Stock = the pairs we have / sold / left,
// Listings = every listing (the tab's platform + status filters apply), Sales = what sold.
// A date range (EST) → PDF or CSV, built from a fresh read so the file is whole even when the
// screen shows a search. `extra` = the tab's own filters, passed to the read.
// skuFilter = { value, set } puts a SKU box next to the dates (Sales, owner 2026-10-25): part of
// a SKU, any case; it rides into the report's fresh read through `extra` like the dates do.
function ReportBar({ kind, from, to, setFrom, setTo, onSignOut, filtersList = false, extra = {}, scope = '', skuFilter = null }) {
  const R = REPORTS[kind];
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  async function download(fmt) {
    setBusy(fmt); setErr('');
    try {
      const r = await api.presellListingsList({ tab: R.tab, from, to, ...extra });
      const rep = await import('../lib/presellReport.js');
      const now = new Date();
      const name = `${R.file}_${from || 'start'}_to_${to || estToday()}`;
      let blob;
      if (fmt === 'csv') blob = new Blob([rep[R.csv](r.rows || [])], { type: 'text/csv;charset=utf-8' });
      else blob = (await rep[R.pdf](r.rows || [], { from, to, scope, generatedAt: `Generated ${estDate(now)} ${estTime(now)} EST` })).output('blob');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `${name}.${fmt}`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) {
      if (e.unauthorized) return onSignOut();
      setErr(e.message || 'Could not build the report.');
    } finally { setBusy(''); }
  }
  return (
    <div className="ap-report">
      <span className="ap-report-title"><b>📄 {kind === 'stock' ? 'Stock' : kind === 'listings' ? 'Listings' : 'Sales'} report</b> <span className="muted xs">{R.blurb}{scope ? ` · ${scope}` : ''}</span></span>
      <label><span className="muted xs">{R.label}</span>
        <input className="input" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} aria-label="From date" /></label>
      <label><span className="muted xs">to</span>
        <input className="input" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} aria-label="To date" /></label>
      {(from || to) && <button type="button" className="btn sm ghost" onClick={() => { setFrom(''); setTo(''); }}>All dates</button>}
      {skuFilter && (
        <label><span className="muted xs">SKU</span>
          <input className="input ap-sku-filter" type="search" value={skuFilter.value} placeholder="any SKU" maxLength={60}
            onChange={(e) => skuFilter.set(e.target.value)} aria-label="SKU filter" /></label>
      )}
      <button type="button" className="btn sm" disabled={!!busy} onClick={() => download('pdf')}>{busy === 'pdf' ? 'Building…' : '⬇ PDF'}</button>
      <button type="button" className="btn sm" disabled={!!busy} onClick={() => download('csv')}>{busy === 'csv' ? 'Building…' : '⬇ CSV'}</button>
      {filtersList && (from || to || skuFilter?.value?.trim()) && <span className="muted xs">The list below is filtered the same way.</span>}
      {err && <span className="error xs">{err}</span>}
    </div>
  );
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
        <div className="ap-sections"><Seg label="Section" value={tab} onChange={setTab}
          options={[['new', 'List new'], ['stock', 'Stock'], ['listings', 'Listings'], ['compete', '⚔ Compete'], ['sales', 'Sales'], ['fulfill', '📦 Fulfill']]} /></div>
      </div>
      {tab === 'stock' ? <StockTab onSignOut={onSignOut} />
        : tab === 'listings' ? <ListingsTab onSignOut={onSignOut} />
          : tab === 'sales' ? <SalesTab onSignOut={onSignOut} />
          : tab === 'compete' ? <CompeteTab onSignOut={onSignOut} />
          : tab === 'fulfill' ? <FulfillTab onSignOut={onSignOut} />
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
  // Where it comes from: supplier (defaults to the preset's name), PO, tracking numbers.
  const pos = usePresellPos();
  const [source, setSource] = useState({ supplier: '', poId: '', tracking: '' });
  function pickPreset(id) {
    setPresetId(id);
    const p = presets.find((x) => String(x.id) === String(id));
    setStack(stackFor(id, presets)); setStackEdited(false); setEditStack(id === OWN);
    if (p && !source.supplier.trim()) setSource((v) => ({ ...v, supplier: p.name }));
  }
  const costOf = (l) => presellUnitCost(l.shelfPrice, stack);
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
      // Only Alias knew the barcode: the code is a guess until the box is read
      // (src/components/AliasCodeCheck.jsx) — listing it would sell the wrong shoe.
      const prod = { ...r.product, sku: String(r.product.sku).split('/')[0], codeCheck: aliasOnlyCode(r.product, upc ? code : '') };
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

  // Each create call must finish inside Cloudflare's 100 s, or the browser gets a 524 while the
  // server carries on (2026-10-10: one size of 18 pairs, 36 listings, took 90 s with StockX
  // paced). So calls carry at most MAX_PER_CALL listings, and a big size is SPLIT across calls —
  // safe, because each call ADDS its pairs to the stock row and lists exactly those.
  // A call that times out (524/504) or fails on the server MAY have gone through, so it counts
  // as sent: never re-sent from the cart (that would add the pairs twice). The rest stay.
  const MAX_PER_CALL = 20;
  const [progress, setProgress] = useState('');
  async function listAll() {
    setListing(true); setError('');
    const todo = lines.filter((l) => !l.done);
    const pieces = [];
    for (const l of todo) {
      const plats = (l.alias ? 1 : 0) + (l.stockx ? 1 : 0) || 1;
      const per = Math.max(1, Math.floor(MAX_PER_CALL / plats));
      for (let left = Number(l.qty) || 1; left > 0; left -= per) pieces.push({ l, qty: Math.min(per, left), n: Math.min(per, left) * plats });
    }
    const batches = [];
    for (const p of pieces) {
      const last = batches[batches.length - 1];
      if (last && last.n + p.n <= MAX_PER_CALL && !last.pieces.some((x) => x.l.key === p.l.key)) { last.pieces.push(p); last.n += p.n; } else batches.push({ pieces: [p], n: p.n });
    }
    const failed = {};
    const sentQty = {};
    const total = { created: 0, failed: 0, warnings: [] };
    const runStart = new Date().toISOString();
    const stockIds = new Set();
    let unsure = false;
    try {
      for (const [i, b] of batches.entries()) {
        if (batches.length > 1) setProgress(`Batch ${i + 1} of ${batches.length} (${b.n} listings)…`);
        const preset = presets.find((x) => String(x.id) === String(presetId));
        let r;
        try {
          r = await api.presellListingsCreate({
            activate,
            inTransit, transitNote: inTransit ? transitNote.trim() : '', expectedOn: inTransit ? expectedOn : '',
            supplier: source.supplier.trim(), poId: source.poId ? Number(source.poId) : null, trackingNumbers: parseTrackingList(source.tracking),
            costStack: stackToSend(stack, presetId, preset, stackEdited),
            items: b.pieces.map(({ l, qty }) => ({
              sku: l.sku, name: l.name, image: l.image, upc: l.upc, size: l.size, qty,
              shelfPrice: Number(l.shelfPrice) > 0 ? Number(l.shelfPrice) : null,
              alias: l.alias ? { price: Number(l.aliasPrice) } : null, stockx: l.stockx ? { price: Number(l.stockxPrice) } : null,
            })),
          });
        } catch (err) {
          // Timed out / failed on the server: it may have finished anyway — count it as sent.
          if (err.unauthorized) throw err;
          if (!err.status || err.status >= 500) { for (const { l, qty } of b.pieces) sentQty[l.key] = (sentQty[l.key] || 0) + qty; unsure = true; }
          throw err;
        }
        for (const { l, qty } of b.pieces) sentQty[l.key] = (sentQty[l.key] || 0) + qty;
        for (const ln of r.lines || []) if (ln.stockId) stockIds.add(ln.stockId);
        total.created += r.created || 0; total.failed += r.failed || 0;
        for (const w of r.warnings || []) if (!total.warnings.includes(w)) total.warnings.push(w);
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
      setError(unsure
        ? `The marketplaces were slow and the last batch didn't answer in time — it is most likely still finishing on the server. Don't list those again: in a minute, check the Stock tab and use “＋ Fill missing listings” for anything short. What's still in the cart below was NOT sent — List it when ready.`
        : `${err.message}${Object.keys(sentQty).length ? ' — the lines already listed left the cart; what is still here was NOT sent.' : ''}`);
    } finally {
      // Sent pairs leave the cart; a partly sent line keeps only what wasn't sent; failures stay marked.
      setLines((ls) => ls.flatMap((l) => {
        if (failed[l.key]) return [{ ...l, error: `${failed[l.key]} — the pairs are in Stock; retry with “List” there.`, done: true }];
        const left = (Number(l.qty) || 0) - (sentQty[l.key] || 0);
        if (!sentQty[l.key]) return [l];
        return left > 0 ? [{ ...l, qty: String(left) }] : [];
      }));
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
              {product.codeCheck && (
                <AliasCodeCheck key={product.codeCheck} code={product.codeCheck} current={product.sku} onSignOut={onSignOut}
                  onConfirm={() => setProduct((x) => ({ ...x, codeCheck: '' }))}
                  onFix={({ found, sizes, ...fix }) => setProduct((x) => ({
                    ...x, ...fix, name: fix.name || fix.sku, sku: String(fix.sku).split('/')[0], sizes, codeCheck: '',
                  }))} />
              )}
              <div className="ap-sizes">
                {(product.sizes || []).map((s) => <button key={s} type="button" className="btn sm ghost" disabled={!!product.codeCheck} onClick={() => addLine(product, s)}>{s}</button>)}
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
                    <option value="">— none (shelf price only) —</option>
                    <option value={OWN}>Our own fees (supplier has no preset)</option>
                    {presets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </label>
                {stack && <button type="button" className={`btn sm ${editStack ? 'primary' : 'ghost'}`} onClick={() => setEditStack((v) => !v)}>{presetId === OWN ? '✎ Our fees' : '✎ Edit for this purchase'}</button>}
                {stackEdited && presetId !== OWN && <span className="ap-edited xs" title="Changed for this purchase only — the saved preset is untouched">edited for this purchase</span>}
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
                  <button type="button" className="btn sm ghost" onClick={() => pickPreset(presetId)}>{presetId === OWN ? 'Clear the fees' : 'Reset to the preset'}</button>
                </div>
              )}
              <SourceFields value={source} onChange={setSource} pos={pos} presets={presets} />
              {!stack && <p className="muted xs">No fees: each pair costs its shelf price, and the profit is payout − shelf (marked “shelf only”). Pick the supplier’s preset to add tax, shipping and the rest — or <b>Our own fees</b> for a supplier that has no preset.</p>}
              {presetId === OWN && <p className="muted xs">Our own fees, for this purchase only — added on top of each shelf price. Not saved as a preset.</p>}
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
                    <span className="ap-cost-out" title={stack ? 'Shelf price plus the fees (landed cost per pair)' : 'Shelf price only — no fees added'}>
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
                    <label><span className="muted xs">Shipment note (optional)</span>
                      <input className="input" value={transitNote} maxLength={200} placeholder="e.g. Alex · 2 boxes · ships Tue" onChange={(e) => setTransitNote(e.target.value)} /></label>
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
          message={[result.failed ? 'What failed is still shown with the reason — its pairs are in Stock, so retry with “List” there.' : 'StockX may show “Pending…” for a few seconds while it confirms.',
            ...(result.warnings || [])].join(' ')}
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
  const [from, setFrom] = useQueryParam('from', '');
  const [to, setTo] = useQueryParam('to', '');
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [qtyFor, setQtyFor] = useState(null);
  const [listFor, setListFor] = useState(null);   // { stock, platform }
  const [fill, setFill] = useState(false);
  const [detailsFor, setDetailsFor] = useState(null);   // { sku, focus }
  const [restoreFor, setRestoreFor] = useState(null);   // a SKU
  const [boxesFor, setBoxesFor] = useState(null);       // { sku, poId } — the 📦 Box contents grid
  const [ticked, setTicked] = useState(() => new Set()); // rows ticked for "📦 In boxes (count unknown)"
  const [unknownFor, setUnknownFor] = useState(false);
  const [presets, setPresets] = useState([]);
  useEffect(() => { api.payoutPresets().then((r) => setPresets(r.presets || [])).catch(() => {}); }, []);
  const pos = usePresellPos();
  async function load() {
    try { const r = await api.presellListingsList({ tab: 'stock', q: q.trim(), from, to }); setRows(r.rows || []); setError(''); }
    catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
  }
  useEffect(() => { const t = setTimeout(load, q ? 300 : 0); return () => clearTimeout(t); }, [q, from, to]); // eslint-disable-line react-hooks/exhaustive-deps
  useLive(['presell_stock', 'presell_listings', 'presell_box_lines', 'po_lines', 'po_boxes'], load, { mount: false });
  const noCost = (rows || []).filter((s) => s.unit_cost == null).length;
  const tick = (id) => setTicked((t) => { const n = new Set(t); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const tickedRows = (rows || []).filter((r) => ticked.has(r.id));
  return (
    <>
      <div className="card ap-stockbar">
        <input type="search" className="oo-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="SKU, name, supplier, PO or tracking…" aria-label="Search pre-sell stock" />
        <button type="button" className="btn sm" disabled={!rows?.length} onClick={() => setFill(true)}
          title="Create the listings a platform is short of — every size shown, one size at a time">＋ Fill missing listings</button>
        <ReportBar kind="stock" from={from} to={to} setFrom={setFrom} setTo={setTo} onSignOut={onSignOut} filtersList />
      </div>
      {error && <div className="error mt">{error}</div>}
      <div className="card">
        {tickedRows.length > 0 && (
          <div className="ap-tickbar">
            <span><b>{tickedRows.length}</b> size{tickedRows.length === 1 ? '' : 's'} ticked</span>
            <button type="button" className="btn sm" onClick={() => setUnknownFor(true)}
              title="When you know which boxes these sizes are in, but not how many in each">📦 In boxes (count unknown)…</button>
            <button type="button" className="linklike xs" onClick={() => setTicked(new Set())}>clear</button>
          </div>
        )}
        {noCost > 0 && <p className="muted sm">{noCost} size{noCost === 1 ? ' has' : 's have'} <b>no cost</b> yet — tap <b>✎ Cost &amp; shipment</b> to add the shelf price and supplier preset.</p>}
        {rows == null ? <p className="muted">Loading…</p> : !rows.length ? <p className="muted">{from || to ? 'Nothing listed in those dates.' : 'No pre-sell stock yet.'}</p> : (
          <div className="ap-tablewrap">
            <table className="table">
              <thead><tr><th aria-label="Tick" /><th>Shoe</th><th>Size</th><th className="num">Pairs</th><th className="num">Sold</th><th className="num">Left</th><th className="num">Cost</th><th>Alias</th><th>StockX</th><th /></tr></thead>
              <tbody>
                {rows.map((s) => {
                  const left = pairsLeft(s);
                  const tracks = s.tracking_numbers || [];
                  return (
                    <tr key={s.id}>
                      <td><input type="checkbox" checked={ticked.has(s.id)} onChange={() => tick(s.id)} aria-label={`Tick ${s.sku} size ${s.size}`} /></td>
                      <td><div className="ap-shoe"><ShoeThumb url={s.image} size={36} /><div><b>{s.sku}</b><div className="muted xs">{s.name}</div>
                        {s.in_transit && (s.arrived_at
                          ? <span className="ap-transit-chip arrived" title={`Every pair received${s.arrived_batch ? ` (last in ${s.arrived_batch})` : ''}`}>📦 All arrived {PH_DATE.format(new Date(s.arrived_at))}</span>
                          : <span className="ap-transit-chip" title={s.transit_note || 'Arrivals are counted by the pair; a listing comes down when PH lists an arrived pair'}>🚚 In transit{s.expected_on ? ` · exp ${String(s.expected_on).slice(5, 10).replace('-', '/')}` : ''}</span>)}
                        {Number(s.arrived_qty) > 0 && !s.arrived_at && (
                          <div className="muted xs" title="Arrived pairs first cover buyers who bought in transit (set aside); the rest go to PH. A pre-sell listing comes down when PH lists one of them.">
                            📦 {s.arrived_qty} of {s.qty} arrived · {Number(s.arrived_qty) - Number(s.released_qty)} set aside · {s.released_qty} to PH
                            {pairsOwed(s) > 0 ? ` · ${pairsOwed(s)} still owed` : ''}
                          </div>
                        )}
                        {(s.supplier || s.po_code || tracks.length > 0) && (
                          <div className="muted xs ap-source-line" title={tracks.join('\n')}>
                            {[s.supplier, s.po_code, !s.boxes?.length && tracks.length && `${tracks.length} tracking`].filter(Boolean).join(' · ')}
                          </div>
                        )}
                        <BoxBreakdown s={s} onOpen={s.po_id ? () => setBoxesFor({ sku: s.sku, poId: s.po_id }) : null} />
                        {/* Against its order (store-orders-plan §4.9): never pre-list more than
                            the order has, and once it lands, say which sold pairs never came. */}
                        {s.po_code && s.po_expected != null && (
                          <div className={`xs ap-po-cap${s.over_cap ? ' over' : ''}`}
                            title="Pairs pre-listed against this order, against what the order lists for this size">
                            {s.over_cap ? '⚠ ' : ''}{s.po_code} lists {s.po_expected} · pre-listed {s.po_listed}
                          </div>
                        )}
                        {s.po_code && s.po_landed && (
                          <div className={`xs ap-po-risk${s.at_risk ? ' bad' : ''}`}
                            title="Sold against this order vs received on this order's shipment (other shipments counted separately)">
                            sold {s.po_sold}, arrived on {s.po_code} {s.po_received}
                            {s.at_risk ? ` → ${s.at_risk} order${s.at_risk === 1 ? '' : 's'} at risk` : ' ✓'}
                            {s.arrived_any !== s.po_received ? ` · on any shipment ${s.arrived_any}` : ''}
                          </div>
                        )}
                      </div></div></td>
                      <td>{s.size}</td>
                      <td className="num">{s.qty}</td><td className="num">{s.sold}</td><td className="num"><b>{left}</b></td>
                      <td className="num" title={s.shelf_price != null ? `Shelf $${Number(s.shelf_price).toFixed(2)} · ${costBasis(s.cost_stack)}` : 'No cost entered'}>
                        {s.unit_cost != null ? money2(Number(s.unit_cost)) : <span className="muted">—</span>}
                      </td>
                      {['alias', 'stockx'].map((p) => {
                        const open = s[`${p}_live`] + s[`${p}_other`];
                        const can = listableOn(s, p);
                        return (
                          <td key={p}>
                            <span className="xs">{s[`${p}_live`]} live{s[`${p}_other`] ? ` · ${s[`${p}_other`]} other` : ''}</span>
                            {can > open && <button type="button" className="btn sm ghost ap-list-more" onClick={() => setListFor({ stock: s, platform: p })}>List {can - open}</button>}
                          </td>
                        );
                      })}
                      <td className="ap-row-actions">
                        {['alias', 'stockx'].some((p) => listableOn(s, p) > s[`${p}_live`] + s[`${p}_other`]) && (
                          <button type="button" className="btn sm" onClick={() => setRestoreFor(s.sku)} title="List every size of this shoe that's short, on both platforms, in one go">↺ Restore</button>
                        )}
                        <button type="button" className="btn sm ghost" onClick={() => setDetailsFor({ sku: s.sku, focus: s.id })} title="Cost, supplier, PO, tracking numbers, in transit">✎ Cost &amp; shipment</button>
                        {s.po_id && <button type="button" className="btn sm ghost" onClick={() => setBoxesFor({ sku: s.sku, poId: s.po_id })} title="Which of the order's boxes each size is in">📦 Boxes</button>}
                        <button type="button" className="btn sm ghost" onClick={() => setQtyFor(s)}>Pairs…</button>
                      </td>
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
      {fill && <FillMissingDialog rows={rows || []} onSignOut={onSignOut} onClose={() => setFill(false)} onDone={() => { setFill(false); load(); }} />}
      {boxesFor && <BoxGridDialog {...boxesFor} onSignOut={onSignOut} onClose={() => { setBoxesFor(null); load(); }} />}
      {unknownFor && <BoxUnknownDialog rows={tickedRows} onSignOut={onSignOut} onClose={() => setUnknownFor(false)}
        onDone={() => { setUnknownFor(false); setTicked(new Set()); load(); }} />}
      {restoreFor && <RestoreDialog rows={(rows || []).filter((r) => r.sku === restoreFor)} onSignOut={onSignOut} onClose={() => setRestoreFor(null)} onDone={() => { setRestoreFor(null); load(); }} />}
      {detailsFor && (
        <DetailsDialog rows={(rows || []).filter((r) => r.sku === detailsFor.sku)} focus={detailsFor.focus} presets={presets} pos={pos}
          onSignOut={onSignOut} onClose={() => setDetailsFor(null)} onDone={() => { setDetailsFor(null); load(); }} />
      )}
    </>
  );
}

// 📦 BY BOX (docs/presell-box-tracking-plan.md, owner 2026-10-24). We hand out every tracking
// number; the supplier packs, often mixing sizes in a box. So a size's boxes are DERIVED from
// what each box holds (the supplier's per-box list on the PO, else what PH typed in the grid),
// shown in the order the pairs land, plus what isn't in a box yet.
const BOX_SOURCE = { supplier: 'the supplier’s list', staff: 'typed for the supplier on the PO', presell: 'typed here (📦 Box contents)',
  only_box: 'the order’s only box — everything is in it' };
const sizeNumOf = (z) => { const m = String(z || '').match(/\d+(?:\.\d+)?/); return m ? Number(m[0]) : Infinity; };
function BoxBreakdown({ s, onOpen }) {
  const boxes = boxOrder(s.boxes || []);
  if (!boxes.length) {
    if (!s.po_id) return null;
    return (
      <div className="xs ap-boxes none">📦 Not in a box yet
        {onOpen && <> · <button type="button" className="linklike" onClick={onOpen}>which box is it in?</button></>}</div>
    );
  }
  const sum = boxSummary(s);
  const shown = boxes.slice(0, 4);
  return (
    <div className="xs ap-boxes">
      {shown.map((b) => {
        const st = boxState(b);
        return (
          <div key={b.id} className={`ap-box ${st.key}`}
            title={`${b.tracking || 'No tracking number'} · ${b.po_code} box ${b.box_number ?? '?'} · ${st.word} · from ${BOX_SOURCE[b.source] || b.source}`}>
            <b>{b.qty == null ? '?' : b.qty}</b> in <span className="ap-mono">{b.tracking ? shortTrack(b.tracking) : `box ${b.box_number ?? '?'}`}</span> {st.icon} {st.word}
          </div>
        );
      })}
      {boxes.length > shown.length && (onOpen
        ? <button type="button" className="linklike" onClick={onOpen}>+{boxes.length - shown.length} more box{boxes.length - shown.length === 1 ? '' : 'es'}</button>
        : <div className="muted">+{boxes.length - shown.length} more</div>)}
      {sum.unplaced > 0 && (
        <div className="ap-box-gap">{sum.unplaced} {sum.unknown ? 'not in a counted box' : 'not in a box yet'}
          {onOpen && <> · <button type="button" className="linklike" onClick={onOpen}>place them</button></>}</div>
      )}
      {sum.over > 0 && <div className="ap-box-over" title="More pairs of this size in the boxes than the order itself lists — a typo in a box, or the order list is short">⚠ {sum.over} more in boxes than the order lists</div>}
    </div>
  );
}

// 📦 Box contents: one SKU on one order — a row per label (tracking number we gave the
// supplier), a column per size. The supplier's own per-box list is shown read-only (it wins);
// a box nobody declared is typed here: a number, or "?" for "some, count unknown".
// "Same as last box" (even packing) and "Fill the rest" (the last box takes what's left).
function BoxGridDialog({ sku, poId, onSignOut, onClose }) {
  const [grid, setGrid] = useState(null);
  const [vals, setVals] = useState({});        // boxId → { size: '' | '3' | '?' }
  const [dirty, setDirty] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState('');
  function adopt(g) {
    setGrid(g);
    setVals(Object.fromEntries(g.boxes.map((b) => [b.id, Object.fromEntries(b.lines.map((l) => [l.size, l.qty == null ? '?' : String(l.qty)]))])));
    setDirty(new Set());
  }
  async function load() {
    try { adopt(await api.presellListingsList({ tab: 'boxgrid', po: poId, sku })); setErr(''); }
    catch (e) { if (e.unauthorized) return onSignOut(); setErr(e.message); }
  }
  useEffect(() => { load(); }, [poId, sku]); // eslint-disable-line react-hooks/exhaustive-deps
  const sizes = useMemo(() => [...(grid?.sizes || [])].sort((a, b) => sizeNumOf(a.size) - sizeNumOf(b.size)), [grid]);
  const boxes = grid?.boxes || [];
  const num = (v) => (v === '?' ? null : Math.max(0, parseInt(v, 10) || 0));
  // Per size, pairs in THIS order's boxes (as edited). A box holds physical pairs, so the
  // target is the order's own count for the size when it has a list, else our pre-listed pairs.
  const placedOf = (z, exceptBox = null) => boxes.filter((b) => b.id !== exceptBox).reduce((n, b) => n + (num(vals[b.id]?.[z.size] ?? '') || 0), 0);
  const target = (z) => (z.expected != null ? z.expected : z.pairs);
  const setCell = (boxId, size, v) => {
    const clean = v.trim() === '?' ? '?' : v.replace(/[^0-9]/g, '').slice(0, 3);
    setVals((c) => ({ ...c, [boxId]: { ...(c[boxId] || {}), [size]: clean } }));
    setDirty((d) => new Set(d).add(boxId));
    setSaved('');
  };
  const setRow = (boxId, row) => { setVals((c) => ({ ...c, [boxId]: row })); setDirty((d) => new Set(d).add(boxId)); setSaved(''); };
  const editable = boxes.filter((b) => !b.declared);
  const over = sizes.filter((z) => z.expected != null && placedOf(z) > z.expected);
  const onlyBox = boxes.length === 1 && !boxes[0].declared && !Object.values(vals[boxes[0].id] || {}).some((v) => v);
  async function save() {
    setBusy(true); setErr(''); setSaved('');
    const total = (b) => Object.values(vals[b.id] || {}).reduce((n, v) => n + (num(v) || 0), 0);
    const was = (b) => b.lines.reduce((n, l) => n + (Number(l.qty) || 0), 0);
    // Boxes losing pairs first, so moving pairs between boxes never trips the "too many" check.
    const order = editable.filter((b) => dirty.has(b.id)).sort((a, b) => (total(a) - was(a)) - (total(b) - was(b)));
    let last = null;
    try {
      for (const b of order) {
        last = await api.presellListingsAction({ action: 'boxContents', poId: Number(poId), boxId: b.id, sku,
          lines: sizes.map((z) => ({ size: z.size, qty: num(vals[b.id]?.[z.size] ?? '') })) });
      }
      if (last) adopt(last);
      setSaved(`Saved ${order.length} box${order.length === 1 ? '' : 'es'}.`);
    } catch (e) { if (e.unauthorized) return onSignOut(); setErr(e.message); load(); }
    finally { setBusy(false); }
  }
  const title = `📦 ${sku} — what’s in each box${grid ? ` · ${grid.po.po_code}` : ''}`;
  return (
    <Dialog title={title} onClose={() => (busy ? null : onClose())} busy={busy} wide>
      {!grid ? (err ? null : <p className="muted">Loading…</p>) : !boxes.length ? (
        <p className="muted">{grid.po.po_code} has no labels yet — add the tracking numbers we gave the supplier on the purchase order first.</p>
      ) : !sizes.length ? (
        <p className="muted">No size of {sku} is pre-listed against {grid.po.po_code}.</p>
      ) : (
        <>
          {onlyBox ? (
            <p className="sm ap-box-ok">This order has one box — every pair is in it. Nothing to type unless that’s wrong.</p>
          ) : (
            <p className="muted sm">One row per box (a tracking number we gave the supplier). Type how many pairs of each size are in it — <b>all</b> of them, not just the pre-sold ones — or <b>?</b> when it’s in there but you don’t know how many.
              A box the supplier declared on the PO is read-only — their list is used.</p>
          )}
          <div className="ap-boxgrid-wrap">
            <table className="table ap-boxgrid">
              <thead>
                <tr><th>Box</th>{sizes.map((z) => <th key={z.stock_id} className="num">{z.size}</th>)}<th /></tr>
              </thead>
              <tbody>
                {boxes.map((b, i) => {
                  const st = boxState(b);
                  const prev = boxes.slice(0, i).reverse().find((x) => vals[x.id] && Object.values(vals[x.id]).some((v) => v));
                  return (
                    <tr key={b.id} className={b.declared ? 'declared' : ''}>
                      <td>
                        <div><b>Box {b.box_number ?? '?'}</b> {b.tracking ? <CopyText text={b.tracking} className="ap-mono xs">{b.tracking}</CopyText> : <span className="muted xs">no tracking number</span>}</div>
                        <div className="muted xs">{st.icon} {st.word}{b.declared ? ` · ${BOX_SOURCE[b.source]}` : ''}{b.other_pairs ? ` · +${b.other_pairs} pairs of other shoes` : ''}</div>
                        {b.replaced > 0 && <div className="xs ap-box-gap">What was typed here before is no longer used — the supplier’s list replaced it.</div>}
                      </td>
                      {sizes.map((z) => (
                        <td key={z.stock_id} className="num">
                          {b.declared ? <span>{vals[b.id]?.[z.size] || <span className="muted">—</span>}</span> : (
                            <input className="ap-boxcell" inputMode="numeric" value={vals[b.id]?.[z.size] ?? ''} placeholder="0" disabled={busy}
                              onChange={(e) => setCell(b.id, z.size, e.target.value)} aria-label={`Box ${b.box_number ?? '?'} size ${z.size}`} />
                          )}
                        </td>
                      ))}
                      <td className="ap-boxgrid-acts">
                        {!b.declared && (
                          <>
                            {prev && <button type="button" className="linklike xs" disabled={busy} onClick={() => setRow(b.id, { ...vals[prev.id] })}
                              title={`Copy box ${prev.box_number ?? '?'}`}>same as last box</button>}
                            <button type="button" className="linklike xs" disabled={busy}
                              onClick={() => setRow(b.id, Object.fromEntries(sizes.map((z) => { const left = target(z) - placedOf(z, b.id); return [z.size, left > 0 ? String(left) : '']; })))}
                              title="Put every pair not yet in a box into this one">fill the rest</button>
                            {Object.values(vals[b.id] || {}).some((v) => v) && <button type="button" className="linklike xs" disabled={busy} onClick={() => setRow(b.id, {})}>clear</button>}
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td className="muted xs" title="Pairs in this order's boxes / the order's own count for the size (or, with no order list, the pairs we pre-listed)">In boxes / {sizes.some((z) => z.expected != null) ? 'order' : 'pre-listed'}</td>
                  {sizes.map((z) => {
                    const p = placedOf(z); const t = target(z);
                    const bad = z.expected != null && p > z.expected;
                    return (
                      <td key={z.stock_id} className={`num xs ${bad ? 'ap-box-over' : p < t ? 'ap-box-gap' : 'ap-box-ok'}`}
                        title={`${z.pairs} pre-listed on this order${z.expected != null ? ` · the order lists ${z.expected}` : ' · the order has no list to check against'}${p < t ? ` · ${t - p} not in a box yet` : bad ? ` · ${p - z.expected} too many` : ''}`}>
                        {onlyBox ? `${t}/${t}` : `${p}/${t}`}
                      </td>
                    );
                  })}
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
          {over.length > 0 && <div className="error xs">More in boxes than {grid.po.po_code} lists — {over.map((z) => `size ${z.size}: ${placedOf(z)} of ${z.expected}`).join('; ')}.</div>}
        </>
      )}
      {saved && <p className="sm ap-box-ok">{saved}</p>}
      {err && <div className="error mt">{err}</div>}
      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>{dirty.size ? 'Close without saving' : 'Close'}</button>
        {editable.length > 0 && (
          <button type="button" className="btn primary" onClick={save} disabled={busy || !dirty.size || over.length > 0}>
            {busy ? 'Saving…' : dirty.size ? `Save ${dirty.size} box${dirty.size === 1 ? '' : 'es'}` : 'Save'}</button>
        )}
      </div>
    </Dialog>
  );
}

// Split unknown: the ticked sizes are somewhere in these boxes, counts unknown. Kept as "?"
// in each box until someone types the real numbers in the grid. One order at a time.
function BoxUnknownDialog({ rows, onSignOut, onClose, onDone }) {
  const poIds = [...new Set(rows.map((r) => r.po_id).filter(Boolean))];
  const noPo = rows.filter((r) => !r.po_id);
  const poId = poIds.length === 1 && !noPo.length ? poIds[0] : null;
  const [grid, setGrid] = useState(null);
  const [pick, setPick] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!poId) return;
    api.presellListingsList({ tab: 'boxgrid', po: poId, sku: rows[0].sku }).then(setGrid)
      .catch((e) => { if (e.unauthorized) return onSignOut(); setErr(e.message); });
  }, [poId]); // eslint-disable-line react-hooks/exhaustive-deps
  async function save() {
    setBusy(true); setErr('');
    try { await api.presellListingsAction({ action: 'boxUnknown', stockIds: rows.map((r) => r.id), boxIds: [...pick] }); onDone(); }
    catch (e) { if (e.unauthorized) return onSignOut(); setErr(e.message); setBusy(false); }
  }
  const toggle = (id) => setPick((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return (
    <Dialog title="📦 In these boxes — count unknown" onClose={onClose} busy={busy}>
      <p className="sm">{rows.map((r) => `${r.sku} ${r.size}`).join(', ')}</p>
      {!poId ? (
        <p className="error sm">{noPo.length ? `Link ${noPo.map((r) => `size ${r.size}`).join(', ')} to the purchase order first (✎ Cost & shipment).` : 'These sizes are on different orders — tick sizes from one order at a time.'}</p>
      ) : !grid ? <p className="muted">Loading…</p> : !grid.boxes.length ? (
        <p className="muted">{grid.po.po_code} has no labels yet.</p>
      ) : (
        <>
          <p className="muted sm">Tick the boxes these sizes could be in. Each shows as <b>?</b> in that box until the real count is typed in 📦 Boxes. A box the supplier declared can’t be ticked — their list is used.</p>
          <div className="ap-boxpick">
            {grid.boxes.map((b) => (
              <label key={b.id} className={b.declared ? 'muted' : ''}>
                <input type="checkbox" disabled={b.declared || busy} checked={pick.has(b.id)} onChange={() => toggle(b.id)} />
                <span>Box {b.box_number ?? '?'} · <span className="ap-mono">{b.tracking || 'no tracking'}</span> · {boxState(b).word}{b.declared ? ' · declared by the supplier' : ''}</span>
              </label>
            ))}
          </div>
        </>
      )}
      {err && <div className="error mt">{err}</div>}
      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="btn primary" onClick={save} disabled={busy || !poId || !pick.size}>{busy ? 'Saving…' : `Mark in ${pick.size || ''} box${pick.size === 1 ? '' : 'es'}`}</button>
      </div>
    </Dialog>
  );
}

// ↺ Restore (2026-10-11, after the arrival rule wrongly deleted a shipment's listings): every
// size of a shoe that is short on a platform, listed back in one go — per size and platform
// a price (pre-filled with the last one we had; "Use current lowest ask" fills today's
// market). Runs the same "List N" call per size, one at a time, with progress + Stop.
function RestoreDialog({ rows, onSignOut, onClose, onDone }) {
  const sizeNum = (z) => { const m = String(z || '').match(/\d+(?:\.\d+)?/); return m ? Number(m[0]) : Infinity; };
  const short = [...rows].sort((a, b) => sizeNum(a.size) - sizeNum(b.size))
    .map((s) => ({ s, need: Object.fromEntries(['alias', 'stockx'].map((p) => [p, Math.max(0, listableOn(s, p) - (s[`${p}_live`] + s[`${p}_other`]))])) }))
    .filter((x) => x.need.alias || x.need.stockx);
  const [price, setPrice] = useState(() => Object.fromEntries(short.flatMap(({ s }) => ['alias', 'stockx'].map((p) => [`${s.id}|${p}`, s[`${p}_last_cents`] ? String(Math.round(s[`${p}_last_cents`] / 100)) : '']))));
  const [activate, setActivate] = useState(true);
  const [run, setRun] = useState(null);
  const [mkBusy, setMkBusy] = useState(false);
  const [err, setErr] = useState('');
  const stop = useRef(false);
  const sku = rows[0]?.sku;
  async function useMarket() {
    setMkBusy(true); setErr('');
    try {
      const sizes = short.map(({ s }) => s.size);
      const [a, x] = await Promise.all([
        api.presellListingsPrices({ platform: 'alias', sku, sizes, consigned: false }),
        api.presellListingsPrices({ platform: 'stockx', sku, sizes }),
      ]);
      const ac = await api.presellListingsPrices({ platform: 'alias', sku, sizes, consigned: true }).catch(() => ({ prices: {} }));
      setPrice((cur) => {
        const n = { ...cur };
        for (const { s } of short) {
          const al = [a.prices?.[s.size]?.lowestListing, ac.prices?.[s.size]?.lowestListing].filter((v) => Number(v) > 0);
          if (al.length) n[`${s.id}|alias`] = String(Math.round(Math.min(...al)));
          const sx = x.prices?.[s.size]?.lowestAsk;
          if (Number(sx) > 0) n[`${s.id}|stockx`] = String(Math.round(sx));
        }
        return n;
      });
    } catch (e) { if (e.unauthorized) return onSignOut(); setErr(e.message); }
    finally { setMkBusy(false); }
  }
  const jobs = short.flatMap(({ s, need }) => ['alias', 'stockx'].filter((p) => need[p]).map((p) => ({ s, p, n: need[p] })));
  const missing = jobs.some((j) => !(Number(price[`${j.s.id}|${j.p}`]) >= 1));
  async function go() {
    stop.current = false;
    const st = { i: 0, total: jobs.length, made: 0, failed: [], running: true };
    setRun({ ...st });
    for (const j of jobs) {
      if (stop.current) break;
      try {
        const r = await api.presellListingsAction({ stockId: j.s.id, action: 'list', platform: j.p, price: Number(price[`${j.s.id}|${j.p}`]), activate });
        st.made += r.created || 0;
        const bad = (r.results || []).filter((x) => !x.ok);
        if (bad.length) st.failed.push(`Size ${j.s.size} ${PLAT[j.p]}: ${bad.length} failed (${[...new Set(bad.map((x) => x.error))].join(' · ')})`);
      } catch (e) {
        if (e.unauthorized) return onSignOut();
        st.failed.push(`Size ${j.s.size} ${PLAT[j.p]}: ${e.message}`);
      }
      st.i++;
      setRun({ ...st });
    }
    setRun({ ...st, running: false });
  }
  const busy = !!run?.running;
  const total = jobs.reduce((k, j) => k + j.n, 0);
  return (
    <Dialog title={`↺ Restore ${sku}`} onClose={() => (busy ? null : (run ? onDone() : onClose()))} busy={busy}>
      {!jobs.length ? <p className="muted">Nothing to restore — every size already has its listings.</p> : (
        <>
          <p className="muted sm">{total} listing{total === 1 ? '' : 's'} to create across {short.length} size{short.length === 1 ? '' : 's'} — pairs left, less any arrived pairs PH has already listed. Prices start at the last price each size had.</p>
          <div className="oo-actions"><button type="button" className="btn sm ghost" disabled={mkBusy || busy} onClick={useMarket}>{mkBusy ? 'Loading…' : 'Use current lowest ask'}</button></div>
          <div className="ap-restore">
            <div className="ap-restore-row ap-restore-head muted xs"><span>Size</span><span>Alias</span><span>StockX</span></div>
            {short.map(({ s, need }) => (
              <div key={s.id} className="ap-restore-row">
                <b>{s.size}</b>
                {['alias', 'stockx'].map((p) => (need[p] ? (
                  <label key={p} className="ap-restore-cell"><span className="muted xs">{need[p]} ×</span>
                    <input type="number" min="1" step="1" inputMode="decimal" value={price[`${s.id}|${p}`]} disabled={busy} placeholder="$"
                      onChange={(e) => setPrice((c) => ({ ...c, [`${s.id}|${p}`]: e.target.value }))} aria-label={`Size ${s.size} ${PLAT[p]} price`} /></label>
                ) : <span key={p} className="muted xs">✓ listed</span>))}
              </div>
            ))}
          </div>
          <label className="ap-activate"><input type="checkbox" checked={activate} disabled={busy} onChange={(e) => setActivate(e.target.checked)} /><span><b>Go live now</b></span></label>
        </>
      )}
      {run && <p className="sm">{run.running ? `Listing ${run.i + 1} of ${run.total}…` : `Done — ${run.made} listing${run.made === 1 ? '' : 's'} created${run.i < run.total ? ' (stopped)' : ''}.`}</p>}
      {run?.failed?.map((f) => <div key={f} className="error xs">{f}</div>)}
      {err && <div className="error mt">{err}</div>}
      <div className="modal-actions">
        {busy ? <button type="button" className="btn" onClick={() => { stop.current = true; }}>Stop</button>
          : run ? <button type="button" className="btn primary" onClick={onDone}>Close</button>
            : <>
              <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
              <button type="button" className="btn primary" disabled={!jobs.length || missing} onClick={go}>{missing ? 'Every row needs a price' : `Restore ${total} listings`}</button>
            </>}
      </div>
    </Dialog>
  );
}

// ✎ Cost & shipment (2026-10-10): fix a SKU's rows after listing — the cost that was never
// entered (no preset picked, a shelf price forgotten), the supplier, the PO it was bought on,
// every tracking number, in transit. Sizes ticked = the rows changed (all of the SKU's
// sizes to start with — a shipment is per SKU). Only the sections touched are sent, so fixing a cost
// never wipes tracking numbers and vice versa. The server recomputes the landed cost.
function DetailsDialog({ rows, focus, presets, pos, onSignOut, onClose, onDone }) {
  const first = rows.find((r) => r.id === focus) || rows[0];
  const sizeNum = (z) => { const m = String(z || '').match(/\d+(?:\.\d+)?/); return m ? Number(m[0]) : Infinity; };
  const sorted = [...rows].sort((a, b) => sizeNum(a.size) - sizeNum(b.size));
  // A shipment is per SKU, so every size is ticked to start with; each keeps its own shelf price.
  const [picked, setPicked] = useState(() => new Set(rows.map((r) => r.id)));
  // Cost
  const firstStack = first.cost_stack || null;
  const [presetId, setPresetId] = useState(firstStack?.own ? OWN : firstStack?.presetId ? String(firstStack.presetId) : '');
  const [stack, setStack] = useState(firstStack ? Object.fromEntries(STACK_FIELDS.map(([k]) => [k, Number(firstStack[k]) || 0])) : null);
  const [stackEdited, setStackEdited] = useState(!!firstStack?.edited);
  const [editStack, setEditStack] = useState(false);
  const [shelf, setShelf] = useState(() => Object.fromEntries(rows.map((r) => [r.id, r.shelf_price != null ? String(Number(r.shelf_price)) : ''])));
  const [allShelf, setAllShelf] = useState('');
  const [costDirty, setCostDirty] = useState(false);
  function pickPreset(id) {
    setPresetId(id); setCostDirty(true);
    const p = presets.find((x) => String(x.id) === String(id));
    setStack(stackFor(id, presets)); setStackEdited(false); setEditStack(id === OWN);
    if (p && !source.supplier.trim()) { setSource((v) => ({ ...v, supplier: p.name })); setSourceDirty(true); }
  }
  // Where from
  const [source, setSource] = useState(() => ({
    supplier: first.supplier || '', poId: first.po_id ? String(first.po_id) : '',
    tracking: [...new Set(rows.flatMap((r) => r.tracking_numbers || []))].join('\n'),
  }));
  const [sourceDirty, setSourceDirty] = useState(false);
  // In transit
  const [inTransit, setInTransit] = useState(!!first.in_transit);
  const [note, setNote] = useState(first.transit_note || '');
  const [expected, setExpected] = useState(first.expected_on ? String(first.expected_on).slice(0, 10) : '');
  const [transitDirty, setTransitDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const toggle = (id) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const costOf = (id) => presellUnitCost(shelf[id], stack);
  async function save() {
    setBusy(true); setErr('');
    const ids = sorted.filter((r) => picked.has(r.id)).map((r) => r.id);
    const preset = presets.find((x) => String(x.id) === String(presetId));
    const body = { action: 'details', stockIds: ids };
    if (costDirty) {
      body.cost = {
        costStack: stackToSend(stack, presetId, preset, stackEdited, firstStack?.preset || null),
        shelf: Object.fromEntries(ids.map((id) => [id, shelf[id] === '' ? null : Number(shelf[id])])),
      };
    }
    if (sourceDirty) Object.assign(body, { supplier: source.supplier.trim(), poId: source.poId ? Number(source.poId) : null, trackingNumbers: parseTrackingList(source.tracking) });
    if (transitDirty) Object.assign(body, { inTransit, transitNote: inTransit ? note.trim() : '', expectedOn: inTransit ? expected : '' });
    try { await api.presellListingsAction(body); onDone(); }
    catch (e) { if (e.unauthorized) return onSignOut(); setErr(e.message); setBusy(false); }
  }
  const dirty = costDirty || sourceDirty || transitDirty;
  const rearm = transitDirty && inTransit && sorted.some((r) => picked.has(r.id) && r.in_transit === false);
  return (
    <Dialog title={`${first.sku} — cost & shipment`} onClose={onClose} busy={busy}>
      <div className="ap-details">
        <div className="ap-details-sizes">
          <span className="muted xs">Sizes to change</span>
          <div className="ap-sizes">
            {sorted.map((r) => (
              <button key={r.id} type="button" className={`btn sm ${picked.has(r.id) ? 'primary' : 'ghost'}`} aria-pressed={picked.has(r.id)} onClick={() => toggle(r.id)}
                title={`${r.qty} pairs · ${r.unit_cost != null ? `cost ${money2(Number(r.unit_cost))}` : 'no cost'}`}>
                {r.size}{r.unit_cost == null ? ' •' : ''}
              </button>
            ))}
            {rows.length > 1 && <button type="button" className="linklike xs" onClick={() => setPicked(new Set(picked.size === rows.length ? [first.id] : rows.map((r) => r.id)))}>{picked.size === rows.length ? 'just this size' : 'all sizes'}</button>}
          </div>
          <span className="muted xs">• = no cost yet</span>
        </div>

        <fieldset className="ap-details-sec">
          <legend>Cost</legend>
          <div className="ap-cost-row">
            <label className="muted sm">Supplier preset
              <select className="input" value={presetId} onChange={(e) => pickPreset(e.target.value)} aria-label="Supplier preset">
                <option value="">{firstStack?.preset && !firstStack.presetId ? `${firstStack.preset} (as saved)` : '— none (shelf price only) —'}</option>
                <option value={OWN}>Our own fees (supplier has no preset)</option>
                {presets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
            {stack && <button type="button" className={`btn sm ${editStack ? 'primary' : 'ghost'}`} onClick={() => setEditStack((v) => !v)}>{presetId === OWN ? '✎ Our fees' : '✎ Edit for this purchase'}</button>}
            {stackEdited && presetId !== OWN && <span className="ap-edited xs">edited for this purchase</span>}
            <label className="muted sm">Shelf price for the ticked sizes
              <span className="ap-inline"><input type="number" min="1" step="0.01" inputMode="decimal" value={allShelf} placeholder="$" onChange={(e) => setAllShelf(e.target.value)} aria-label="Shelf price for the ticked sizes" />
                <button type="button" className="btn sm" disabled={!(Number(allShelf) > 0)}
                  onClick={() => { setShelf((sh) => ({ ...sh, ...Object.fromEntries([...picked].map((id) => [id, allShelf])) })); setCostDirty(true); }}>Apply</button></span>
            </label>
          </div>
          {stack && editStack && (
            <div className="ap-stack">
              {STACK_FIELDS.map(([k, label, unit]) => (
                <label key={k} className="muted xs">{label} ({unit})
                  <input className="input" type="number" min="0" step="0.01" inputMode="decimal" value={stack[k]}
                    onChange={(e) => { setStack((st) => ({ ...st, [k]: e.target.value === '' ? 0 : Number(e.target.value) })); setStackEdited(true); setCostDirty(true); }}
                    aria-label={`${label} for this purchase`} />
                </label>
              ))}
            </div>
          )}
          <div className="ap-details-shelf">
            {sorted.filter((r) => picked.has(r.id)).map((r) => (
              <label key={r.id} className="ap-qtyfield"><span className="muted xs">Size {r.size} shelf $</span>
                <input className="ap-qty ap-shelf" type="number" min="0" step="0.01" inputMode="decimal" value={shelf[r.id]}
                  onChange={(e) => { const v = e.target.value; setShelf((sh) => ({ ...sh, [r.id]: v })); setCostDirty(true); }} aria-label={`Size ${r.size} shelf price`} />
                <span className="xs">→ cost <b>{money2(costOf(r.id))}</b></span>
              </label>
            ))}
          </div>
          {!stack && <p className="muted xs">No fees: each size costs its shelf price (“shelf only”). Pick the supplier’s preset, or <b>Our own fees</b> for a supplier that has no preset.</p>}
        </fieldset>

        <fieldset className="ap-details-sec">
          <legend>Where it’s from</legend>
          <SourceFields value={source} onChange={(v) => { setSource(v); setSourceDirty(true); }} pos={pos} presets={presets} />
          {!source.poId && <MakePo rows={sorted.filter((r) => picked.has(r.id) && !r.po_id)} source={source} onSignOut={onSignOut} onMade={onDone} />}
        </fieldset>

        <fieldset className="ap-details-sec">
          <legend>In transit</legend>
          <label className="ap-activate">
            <input type="checkbox" checked={inTransit} onChange={(e) => { setInTransit(e.target.checked); setTransitDirty(true); }} />
            <span><b>🚚 In transit</b> — when the warehouse receives this SKU + size, the unsold listings are deleted and the group is told.</span>
          </label>
          {inTransit && (
            <div className="ap-transit">
              <label><span className="muted xs">Shipment note</span>
                <input className="input" value={note} maxLength={200} onChange={(e) => { setNote(e.target.value); setTransitDirty(true); }} /></label>
              <label><span className="muted xs">Expected</span>
                <input className="input" type="date" value={expected} onChange={(e) => { setExpected(e.target.value); setTransitDirty(true); }} /></label>
            </div>
          )}
          {rearm && <p className="muted xs">Ticking this re-arms the arrival check for those sizes.</p>}
        </fieldset>
      </div>
      {err && <div className="error mt">{err}</div>}
      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="btn primary" onClick={save} disabled={busy || !dirty || !picked.size}>
          {busy ? 'Saving…' : `Save ${picked.size} size${picked.size === 1 ? '' : 's'}`}</button>
      </div>
    </Dialog>
  );
}

// "Make a PO for this buy" (docs/presell-box-tracking-plan.md, phase 4). We give the supplier
// every tracking number, so a buy we track is an order of our labels: one label per tracking
// number above, no lines — the supplier scans what's in each box, or PH fills 📦 Boxes.
function MakePo({ rows, source, onSignOut, onMade }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [made, setMade] = useState(null);
  const tracks = parseTrackingList(source.tracking);
  if (!rows.length) return null;
  async function go() {
    setBusy(true); setErr('');
    try {
      const r = await api.presellListingsAction({ action: 'makePo', stockIds: rows.map((x) => x.id), supplierName: source.supplier.trim(), trackingNumbers: tracks });
      setMade(r);
    } catch (e) { if (e.unauthorized) return onSignOut(); setErr(e.message); }
    finally { setBusy(false); }
  }
  if (made) {
    return (
      <div className="ap-makepo ok sm">
        ✓ Opened <b>{made.poCode}</b> with {made.labels} label{made.labels === 1 ? '' : 's'} · {made.linked} size{made.linked === 1 ? '' : 's'} linked.
        Next: tell us what’s in each box (📦 Boxes on the row), or let the supplier scan it.
        <div><button type="button" className="btn sm primary" onClick={onMade}>Done</button></div>
      </div>
    );
  }
  const missing = !source.supplier.trim() ? 'the supplier' : !tracks.length ? 'the tracking numbers we gave them' : '';
  return (
    <div className="ap-makepo sm">
      <span className="muted">Not on a purchase order?</span>{' '}
      <button type="button" className="btn sm" disabled={busy || !!missing} onClick={go}
        title={missing ? `Fill in ${missing} first` : `Opens a PO for ${source.supplier.trim()} with ${tracks.length} label${tracks.length === 1 ? '' : 's'} and links ${rows.length} size${rows.length === 1 ? '' : 's'}`}>
        {busy ? 'Opening…' : `＋ Make a PO for this buy (${tracks.length} box${tracks.length === 1 ? '' : 'es'})`}</button>
      {missing && <span className="muted xs"> — fill in {missing} first</span>}
      {err && <div className="error xs">{err}</div>}
    </div>
  );
}

function useEscape(onClose, busy) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);
}
function Dialog({ title, children, onClose, busy, wide = false }) {
  useEscape(onClose, busy);
  return (
    <div className="modal-overlay" onClick={() => !busy && onClose()}>
      <div className={`modal ap-edit${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
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

// ＋ Fill missing listings (owner, 2026-10-10): after StockX's 429s left 69 Griffey pairs
// with no StockX listing, top every size shown up to its pairs left — ONE size at a time
// (the same "List N" call per row, each waiting for the last), one price, progress + Stop.
// New listings pair up with the Alias ones on the Listings tab by themselves (oldest first).
function FillMissingDialog({ rows, onSignOut, onClose, onDone }) {
  const [platform, setPlatform] = useState('stockx');
  const [price, setPrice] = useState('');
  const [activate, setActivate] = useState(true);
  const [run, setRun] = useState(null);   // { i, total, made, failed:[] , running }
  const stop = useRef(false);
  const short = rows.map((s) => ({ s, n: listableOn(s, platform) - (s[`${platform}_live`] + s[`${platform}_other`]) })).filter((x) => x.n > 0);
  const total = short.reduce((k, x) => k + x.n, 0);
  async function go() {
    stop.current = false;
    const st = { i: 0, total: short.length, made: 0, failed: [], running: true };
    setRun({ ...st });
    for (const { s } of short) {
      if (stop.current) break;
      try {
        const r = await api.presellListingsAction({ stockId: s.id, action: 'list', platform, price: Number(price), activate });
        st.made += r.created || 0;
        const bad = (r.results || []).filter((x) => !x.ok);
        if (bad.length) st.failed.push(`${s.sku} ${s.size}: ${bad.length} failed (${[...new Set(bad.map((x) => x.error))].join(' · ')})`);
      } catch (e) {
        if (e.unauthorized) return onSignOut();
        st.failed.push(`${s.sku} ${s.size}: ${e.message}`);
      }
      st.i++;
      setRun({ ...st });
    }
    setRun({ ...st, running: false });
  }
  const busy = !!run?.running;
  return (
    <Dialog title="Fill missing listings" onClose={() => (busy ? null : (run ? onDone() : onClose()))} busy={busy}>
      <Seg label="Platform" value={platform} onChange={(p) => { if (!busy && !run) setPlatform(p); }} options={[['stockx', 'StockX'], ['alias', 'Alias']]} />
      {!short.length ? <p className="sm mt">Every size shown already has a {PLAT[platform]} listing for each pair left.</p> : (
        <>
          <p className="sm mt"><b>{total} {PLAT[platform]} listing{total === 1 ? '' : 's'}</b> missing across {short.length} size{short.length === 1 ? '' : 's'}:</p>
          <ul className="ap-fill-list xs">{short.map(({ s, n }) => <li key={s.id}>{s.sku} · size {s.size} — {n}</li>)}</ul>
          <div className="ap-edit-fields"><label><span className="muted xs">{PLAT[platform]} price for all (USD)</span>
            <input type="number" min="1" step="1" inputMode="decimal" value={price} disabled={!!run} onChange={(e) => setPrice(e.target.value)} aria-label="Price for the missing listings" /></label></div>
          <label className="ap-activate"><input type="checkbox" checked={activate} disabled={!!run} onChange={(e) => setActivate(e.target.checked)} /><span><b>Go live now</b></span></label>
        </>
      )}
      {run && <p className="sm">{run.running ? `Listing size ${run.i + 1} of ${run.total}…` : `Done: ${run.made} listed${run.i < run.total ? ` (stopped after ${run.i} of ${run.total} sizes)` : ''}.`}</p>}
      {run?.failed?.length > 0 && <div className="error xs">{run.failed.join(' · ')}</div>}
      <div className="modal-actions">
        {busy
          ? <button type="button" className="btn" onClick={() => { stop.current = true; }}>Stop after this size</button>
          : run ? <button type="button" className="btn primary" onClick={onDone}>Close</button>
            : <>
              <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
              <button type="button" className="btn primary" disabled={!short.length || !(Number(price) >= 1)} onClick={go}>List {total} on {PLAT[platform]}</button>
            </>}
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
  const n = listableOn(stock, platform) - (stock[`${platform}_live`] + stock[`${platform}_other`]);
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
  const [from, setFrom] = useQueryParam('from', '');
  const [to, setTo] = useQueryParam('to', '');
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
  // ↻ Re-check pending (owner, 2026-10-10): re-read every PENDING listing from its
  // marketplace — SEQUENTIALLY, one finishes before the next starts, so a few dozen rows
  // never turn into a burst (StockX answered 429 to the first big run). Stop any time.
  const [recheck, setRecheck] = useState(null);   // null · { done, total, fixed, running }
  const stopRecheck = useRef(false);
  async function recheckPending() {
    stopRecheck.current = false;
    let list = [];
    try { list = (await api.presellListingsList({ tab: 'listings', view: 'pending', platform })).rows || []; }
    catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); return; }
    list = list.filter((l) => l.external_id);
    const st = { done: 0, total: list.length, fixed: 0, running: true };
    setRecheck({ ...st });
    for (const l of list) {
      if (stopRecheck.current) break;
      try {
        const r = await api.presellListingsAction({ listingId: l.id, action: 'refresh' });
        if (r?.listing?.status && r.listing.status !== 'pending') st.fixed++;
      } catch (err) {
        if (err.unauthorized) return onSignOut();
        if (err.status === 429) await new Promise((res) => setTimeout(res, 5000));   // our own server says slow down
      }
      st.done++;
      setRecheck({ ...st });
    }
    setRecheck({ ...st, running: false });
    load();
  }

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
  // One CARD per SKU + size (owner, 2026-10-10: 26 rows of the same size was overwhelming,
  // and the team works on phones). The card says how many pairs and what each platform
  // holds; tapping it opens the pairs — each a StockX + Alias listing matched oldest-first
  // (pair 1 = the first listing on each platform), with its own pills and menu as before.
  const sizeNum = (z) => { const m = String(z || '').match(/\d+(?:\.\d+)?/); return m ? Number(m[0]) : Infinity; };
  const groups = useMemo(() => {
    const by = new Map();
    for (const r of [...(rows || [])].reverse()) {
      const g = by.get(r.stock_id) || { stock_id: r.stock_id, sku: r.sku, name: r.name, image: r.image, size: r.size, alias: [], stockx: [], latest: r.created_at };
      g[r.platform]?.push(r);
      if (new Date(r.created_at) > new Date(g.latest)) g.latest = r.created_at;
      by.set(r.stock_id, g);
    }
    const list = [...by.values()].map((g) => {
      const n = Math.max(g.alias.length, g.stockx.length);
      return { ...g, n, pairs: Array.from({ length: n }, (_, i) => ({
        key: `${g.stock_id}-${i}`, i, sku: g.sku, name: g.name, image: g.image, size: g.size, alias: g.alias[i] || null, stockx: g.stockx[i] || null,
      })) };
    });
    // Shoes by their latest activity; within a shoe, sizes smallest first.
    const skuLatest = new Map();
    for (const g of list) if (!skuLatest.has(g.sku) || new Date(g.latest) > new Date(skuLatest.get(g.sku))) skuLatest.set(g.sku, g.latest);
    return list.sort((a, b) => (a.sku === b.sku ? sizeNum(a.size) - sizeNum(b.size) : new Date(skuLatest.get(b.sku)) - new Date(skuLatest.get(a.sku))));
  }, [rows]);
  const [openGroups, setOpenGroups] = useState(() => new Set());
  const [pricesFor, setPricesFor] = useState(null);   // a size card → bulk price edit
  const toggleGroup = (id) => setOpenGroups((o) => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return (
    <>
      <div className="card">
        <div className="oo-toolbar">
          <Seg label="Platform" value={platform} onChange={setPlatform} options={[['', 'Both'], ['alias', 'Alias'], ['stockx', 'StockX']]} />
          <Seg label="Show" value={view} onChange={setView} options={[['all', 'Open', counts.all], ['live', 'Live', counts.live], ['off', 'Not live', counts.off], ['pending', 'Pending', counts.pending], ['sold', 'Sold', counts.sold], ['deleted', 'Deleted', counts.deleted]]} />
          <input type="search" className="oo-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="SKU, name or listing id…" aria-label="Search listings" />
          {recheck?.running
            ? <button type="button" className="btn sm" onClick={() => { stopRecheck.current = true; }}>Stop · {recheck.done}/{recheck.total}</button>
            : <button type="button" className="btn sm ghost" disabled={!counts.pending} onClick={recheckPending}
                title="Re-read every pending listing from Alias / StockX, one at a time">↻ Re-check pending{counts.pending ? ` (${counts.pending})` : ''}</button>}
          {recheck && !recheck.running && <span className="muted xs">Re-checked {recheck.done} — {recheck.fixed} settled{recheck.done < recheck.total ? ' (stopped)' : ''}.</span>}
        </div>
        <ReportBar kind="listings" from={from} to={to} setFrom={setFrom} setTo={setTo} onSignOut={onSignOut}
          extra={{ view, platform }}
          scope={[platform ? PLAT[platform] : 'Alias + StockX', { all: 'open', live: 'live', off: 'not live', pending: 'pending', sold: 'sold', deleted: 'deleted' }[view] || view].join(' · ')} />
      </div>
      {error && <div className="error mt">{error}</div>}
      <div className="card">
        {rows == null ? <p className="muted">Loading…</p> : !groups.length ? <p className="muted">{q ? `Nothing matches “${q}”.` : 'Nothing here.'}</p> : (
          <div className="ap-groups">
            {groups.map((g) => {
              const isOpen = openGroups.has(g.stock_id);
              const errs = [...g.alias, ...g.stockx].filter((l) => l.last_error).length;
              return (
                <div key={g.stock_id} className={`ap-group${isOpen ? ' open' : ''}`}>
                  <button type="button" className="ap-group-head" aria-expanded={isOpen} onClick={() => toggleGroup(g.stock_id)}>
                    <ShoeThumb url={g.image} size={44} />
                    <span className="ap-group-main">
                      <span className="ap-group-title"><b>{g.sku}</b> <span className="muted">· size</span> <b>{g.size}</b></span>
                      <span className="muted xs ap-group-name">{g.name}</span>
                      <span className="ap-group-chips">
                        {['stockx', 'alias'].filter((pl) => !platform || pl === platform).map((pl) => <PlatformSummary key={pl} platform={pl} listings={g[pl]} pairs={g.n} />)}
                      </span>
                      {errs > 0 && <span className="error xs">{errs} with a problem — open to see</span>}
                    </span>
                    <span className="ap-group-count"><b>{g.n}</b><span className="muted xs">pair{g.n === 1 ? '' : 's'}</span><span className="ap-caret">{isOpen ? '▾' : '▸'}</span></span>
                  </button>
                  <div className="ap-group-bar">
                    <button type="button" className="btn sm ghost" onClick={() => setPricesFor(g)}
                      disabled={![...g.alias, ...g.stockx].some((l) => OPEN.includes(l.status))}>✎ Edit prices</button>
                  </div>
                  {isOpen && (
                    <div className="ap-group-pairs">
                      {g.pairs.map((p) => {
                        const open = [p.stockx, p.alias].filter((l) => l && OPEN.includes(l.status));
                        const busy = [p.stockx, p.alias].some((l) => l && busyId === l.id);
                        const errsP = [p.stockx, p.alias].filter((l) => l?.last_error);
                        const first = [p.stockx, p.alias].filter(Boolean).sort((a, b) => new Date(a.created_at) - new Date(b.created_at))[0];
                        return (
                          <div key={p.key} className="ap-pair">
                            <span className="ap-pair-n muted">#{p.i + 1}</span>
                            <div className="ap-pills">
                              {['stockx', 'alias'].filter((pl) => !platform || pl === platform).map((pl) => (
                                <PlatformPill key={pl} platform={pl} listing={p[pl]} busy={busy}
                                  onAct={act} onEdit={setEditing} onDelete={(l) => setDeleting([l])} />
                              ))}
                            </div>
                            <DropMenu label="⋯" className="ap-more ap-more-sm" disabled={busy}
                              head={first ? `Pair #${p.i + 1} · listed ${when(first.created_at)}${first.created_by ? ` by ${first.created_by}` : ''}` : null}
                              items={[
                                { label: 'Switch both on', hidden: !open.some((l) => l.status === 'off'), onClick: () => actMany(open.filter((l) => l.status === 'off'), 'activate') },
                                { label: 'Switch both off', hidden: !open.some((l) => l.status === 'live'), onClick: () => actMany(open.filter((l) => l.status === 'live'), 'deactivate') },
                                { label: 'Re-read from the marketplaces', hidden: ![p.stockx, p.alias].some((l) => l?.external_id), onClick: () => actMany([p.stockx, p.alias].filter((l) => l?.external_id), 'refresh') },
                                { label: open.length > 1 ? 'Delete both' : 'Delete listing', danger: true, hidden: !open.length, onClick: () => setDeleting(open) },
                              ]} />
                            {errsP.map((l) => <div key={l.id} className="error xs ap-pair-err" title={l.last_error}>{PLAT[l.platform]}: {l.last_error}</div>)}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      {editing && <EditListing row={editing} onSignOut={onSignOut} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
      {pricesFor && <BulkPriceDialog group={pricesFor} onSignOut={onSignOut} onClose={() => setPricesFor(null)} onDone={() => { setPricesFor(null); load(); }} />}
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

// A size card's summary for one platform: "StockX 5 ON · 4 PENDING · 17 —" — what the
// platform holds of the pairs, and how many pairs it has NO listing for (the "—").
function PlatformSummary({ platform, listings, pairs }) {
  const c = {};
  for (const l of listings) c[l.status] = (c[l.status] || 0) + 1;
  const missing = Math.max(0, pairs - listings.length);
  const parts = [['live', 'ON', 'on'], ['pending', 'PENDING', 'pending'], ['off', 'OFF', 'off'], ['failed', 'FAILED', 'off'], ['sold', 'SOLD', 'sold'], ['deleted', 'DELETED', 'none']]
    .filter(([k]) => c[k]).map(([k, label, tone]) => <span key={k} className={`ap-sum ${tone}`}>{c[k]} {label}</span>);
  if (missing) parts.push(<span key="none" className="ap-sum none" title={`${missing} pair${missing === 1 ? '' : 's'} with no ${PLAT[platform]} listing`}>{missing} —</span>);
  return <span className="ap-summary"><b>{PLAT[platform]}</b>{parts.length ? parts : <span className="ap-sum none">none</span>}</span>;
}

// One platform's listing for a pair: a coloured pill that opens that listing's actions.
function PlatformPill({ platform, listing: l, busy, onAct, onEdit, onDelete }) {
  if (!l) return <span className="ap-pill none" title={`Not listed on ${PLAT[platform]} — list it from the Stock tab`}>{PLAT[platform]} (—)</span>;
  const [word, tone] = PILL[l.status] || [String(l.status).toUpperCase(), 'none'];
  const open = OPEN.includes(l.status);
  return (
    <div className="ap-pill-wrap">
      <DropMenu label={`${PLAT[platform]} (${word})`} className={`ap-pill ${tone}`} disabled={busy}
        title={`${PLAT[platform]} · ${STATUS[l.status]?.[0] || l.status} · ${money(l.price_cents)}${l.status === 'deleted' ? ` · ${deleteWhy(l)}` : ''}`}
        head={l.external_id ? `${PLAT[platform]} listing ${l.external_id}` : null}
        items={[
          { label: l.status === 'live' ? 'Switch off' : 'Go live', hidden: !open, onClick: () => onAct(l, l.status === 'live' ? 'deactivate' : 'activate') },
          { label: platform === 'alias' ? 'Edit price / size…' : 'Edit price…', hidden: !open, onClick: () => onEdit(l) },
          { label: `Re-read from ${PLAT[platform]}`, hidden: !l.external_id, onClick: () => onAct(l, 'refresh') },
          { label: 'Copy listing id', hidden: !l.external_id, onClick: () => navigator.clipboard?.writeText(l.external_id).catch(() => {}) },
          { label: `Delete from ${PLAT[platform]}`, danger: true, hidden: !open, onClick: () => onDelete(l) },
        ]} />
      <span className="ap-pill-price">{money(l.price_cents)}</span>
      {l.status === 'deleted' && <span className="ap-pill-why xs">{deleteWhy(l)}</span>}
    </div>
  );
}
// Why a listing was deleted, in words (owner, 2026-10-11).
const deleteWhy = (l) => ({
  user: `deleted by ${l.updated_by || 'a user'}`, sold_other: 'sold on the other platform', qty_cut: 'pair count lowered',
  arrived: 'shipment arrived (old rule)', ph_listed: 'PH listed the arrived pair', platform: `deleted on ${PLAT[l.platform]}`,
}[l.delete_reason] || 'deleted');

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
// ✎ Edit prices (owner, 2026-10-10): every open listing of ONE size, per platform, to a
// new price — updated ONE listing at a time (the same per-listing update the ⋯ menu uses,
// each waiting for the last; StockX calls are paced server-side too). A listing StockX is
// still working on (pending) can't take a new price yet — skipped and counted.
function BulkPriceDialog({ group: g, onSignOut, onClose, onDone }) {
  const [basis, setBasis] = useState(loadBasis);
  const plats = ['alias', 'stockx'].filter((p) => g[p].some((l) => OPEN.includes(l.status) || l.status === 'pending'));
  const current = (p) => { const ps = [...new Set(g[p].filter((l) => OPEN.includes(l.status)).map((l) => Math.round(Number(l.price_cents) / 100)))]; return ps; };
  const [price, setPrice] = useState(() => Object.fromEntries(plats.map((p) => [p, current(p).length === 1 ? String(current(p)[0]) : ''])));
  const [run, setRun] = useState(null);   // { done, total, failed:[], skipped, running }
  const stop = useRef(false);
  const aliasMkt = useMarket('alias', plats.includes('alias') ? [{ sku: g.sku, size: g.size }] : [], basis, onSignOut);
  const sxMkt = useMarket('stockx', plats.includes('stockx') ? [{ sku: g.sku, size: g.size }] : [], basis, onSignOut);
  const todo = plats.flatMap((p) => (Number(price[p]) >= 1
    ? g[p].filter((l) => OPEN.includes(l.status) && Math.round(Number(l.price_cents) / 100) !== Math.round(Number(price[p]))).map((l) => ({ l, p }))
    : []));
  const pendingSkip = plats.reduce((n, p) => n + (Number(price[p]) >= 1 ? g[p].filter((l) => l.status === 'pending').length : 0), 0);
  async function go() {
    stop.current = false;
    const st = { done: 0, total: todo.length, failed: [], skipped: pendingSkip, running: true };
    setRun({ ...st });
    for (const { l, p } of todo) {
      if (stop.current) break;
      try { await api.presellListingsAction({ listingId: l.id, action: 'update', price: Number(price[p]) }); }
      catch (e) { if (e.unauthorized) return onSignOut(); st.failed.push(`${PLAT[p]}: ${e.message}`); }
      st.done++;
      setRun({ ...st });
    }
    setRun({ ...st, running: false });
  }
  const busy = !!run?.running;
  return (
    <Dialog title={`Prices · ${g.sku} size ${g.size}`} onClose={() => (busy ? null : (run ? onDone() : onClose()))} busy={busy}>
      <p className="muted sm">{g.name} — {g.n} pair{g.n === 1 ? '' : 's'}. Every open listing of this size on a platform gets the price you set there; leave a box blank to keep that platform as it is.</p>
      {plats.map((p) => {
        const cur = current(p);
        const open = g[p].filter((l) => OPEN.includes(l.status)).length;
        return (
          <div key={p} className="ap-bulkprice">
            <div className="ap-bulkprice-head"><b>{PLAT[p]}</b><span className="muted xs">{open} open · now {cur.length ? cur.map((c) => `$${c}`).join(' / ') : '—'}</span></div>
            {p === 'alias' && <div className="ap-basis"><Seg label="Alias price basis" value={basis} onChange={(b) => { saveBasis(b); setBasis(b); }} options={[['consigned', 'Consigned'], ['with_you', 'With You']]} /></div>}
            <Market platform={p} p={(p === 'alias' ? aliasMkt : sxMkt)(g.sku, g.size)} onPick={(v) => !run && setPrice((x) => ({ ...x, [p]: String(v) }))} />
            <label className="ap-edit-fields"><span className="muted xs">New {PLAT[p]} price (USD)</span>
              <input type="number" min="1" step="1" inputMode="decimal" value={price[p] ?? ''} disabled={!!run} placeholder="keep as is"
                onChange={(e) => setPrice((x) => ({ ...x, [p]: e.target.value }))} aria-label={`New ${PLAT[p]} price`} /></label>
          </div>
        );
      })}
      {!run && pendingSkip > 0 && <p className="muted xs">{pendingSkip} listing{pendingSkip === 1 ? ' is' : 's are'} still pending on StockX — {pendingSkip === 1 ? 'it' : 'they'} can’t take a new price until settled (↻ Re-check pending, then edit again).</p>}
      {run && <p className="sm">{run.running ? `Updating ${run.done + 1} of ${run.total}…` : `Done: ${run.done - run.failed.length} updated${run.done < run.total ? ` (stopped after ${run.done} of ${run.total})` : ''}${run.skipped ? ` · ${run.skipped} pending skipped` : ''}.`}</p>}
      {run?.failed?.length > 0 && <div className="error xs">{[...new Set(run.failed)].join(' · ')}</div>}
      <div className="modal-actions">
        {busy ? <button type="button" className="btn" onClick={() => { stop.current = true; }}>Stop</button>
          : run ? <button type="button" className="btn primary" onClick={onDone}>Close</button>
            : <>
              <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
              <button type="button" className="btn primary" disabled={!todo.length} onClick={go}>Update {todo.length} listing{todo.length === 1 ? '' : 's'}</button>
            </>}
      </div>
    </Dialog>
  );
}

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
  const [from, setFrom] = useQueryParam('from', '');
  const [to, setTo] = useQueryParam('to', '');
  const [sku, setSku] = useQueryParam('sku', '');
  const skuQ = sku.trim();
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
    try { const r = await api.presellListingsList({ tab: 'sales', from, to, sku: skuQ }); setRows(r.rows || []); setError(''); }
    catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
  }
  useEffect(() => { const t = setTimeout(load, skuQ ? 300 : 0); return () => clearTimeout(t); }, [from, to, skuQ]); // eslint-disable-line react-hooks/exhaustive-deps
  // Totals for what's shown: payout is the platform's (est. when it gave none), net only
  // where a cost was entered — a sale without one is counted, not guessed.
  const tot = useMemo(() => {
    const t = { n: 0, price: 0, payout: 0, cost: 0, net: 0, noCost: 0, why: {}, fromPo: 0 };
    for (const x of rows || []) {
      const m = saleNet(x);
      t.n++; t.price += m.price || 0; t.payout += m.payout || 0;
      if (m.cost == null) {
        t.noCost++;
        const k = x.cost_reason || 'unknown';
        t.why[k] = (t.why[k] || 0) + 1;
      } else { t.cost += m.cost; t.net += m.profit; if (x.cost_source === 'po') t.fromPo++; }
    }
    return t;
  }, [rows]);
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
      <div className="card">
        <ReportBar kind="sales" from={from} to={to} setFrom={setFrom} setTo={setTo} onSignOut={onSignOut} filtersList
          skuFilter={{ value: sku, set: setSku }} extra={{ sku: skuQ }} scope={skuQ ? `SKU contains: ${skuQ}` : ''} />
        {rows?.length > 0 && (
          <div className="ap-sales-tot">
            <span><b>{tot.n}</b> <span className="muted xs">sale{tot.n === 1 ? '' : 's'}</span></span>
            <span><b>{money2(tot.price)}</b> <span className="muted xs">sold for</span></span>
            <span><b>{money2(tot.payout)}</b> <span className="muted xs">payout</span></span>
            <span><b>{money2(tot.cost)}</b> <span className="muted xs">cost</span></span>
            <span><b className={tot.net < 0 ? 'neg' : 'pos'}>{money2(tot.net)}</b> <span className="muted xs">net{tot.noCost ? ` · ${tot.noCost} without a cost` : ''}</span></span>
          </div>
        )}
        {tot.noCost > 0 && (
          <p className="xs ap-nocost-why">
            Without a cost: {Object.entries(tot.why).map(([k, n]) => `${n} ${COST_REASON[k] || 'not entered'}`).join(' · ')} — add the shelf price
            under Stock → ✎ Cost &amp; shipment (or on the PO line) and these fill in by themselves.
          </p>
        )}
        {tot.fromPo > 0 && <p className="muted xs">{tot.fromPo} sale{tot.fromPo === 1 ? '' : 's'} costed from the shelf price on the purchase order (none was typed on the pre-sell row).</p>}
      </div>
      {error && <div className="error mt">{error}</div>}
      <div className="card">
        {rows == null ? <p className="muted">Loading…</p> : !rows.length ? <p className="muted">{from || to || skuQ ? 'No sales match those filters.' : 'No pre-sell sales yet — they appear here (and in the Telegram group) within a minute of selling.'}</p> : (
          <div className="ap-tablewrap">
            <table className="table">
              <thead><tr><th>Sold</th><th>Shoe</th><th>Size</th><th>Platform</th><th className="num">Price</th><th className="num">Payout</th><th className="num">Cost</th><th className="num">Net</th><th>Order</th><th>Telegram</th></tr></thead>
              <tbody>
                {rows.map((x) => { const m = saleNet(x); return (
                  <tr key={x.id}>
                    <td className="xs">{when(x.sold_at || x.created_at)}</td>
                    <td><div className="ap-shoe"><ShoeThumb url={x.image} size={36} /><div><b>{x.sku}</b><div className="muted xs">{x.name}</div></div></div></td>
                    <td>{x.size}</td>
                    <td>{PLAT[x.platform] || x.platform}</td>
                    <td className="num">{money(x.price_cents)}</td>
                    <td className="num" title={m.estimated ? 'Estimated from the default fee — the platform gave no payout' : 'The platform’s payout'}>{money2(m.payout)}{m.estimated ? '*' : ''}</td>
                    <td className="num" title={costNote(x)}>
                      {m.cost != null ? <>{money2(m.cost)}{x.cost_source === 'po' && <div className="muted xs">from the PO</div>}</>
                        : <><span className="muted">—</span><div className="xs ap-nocost">{COST_REASON[x.cost_reason] || 'not entered'}</div></>}
                    </td>
                    <td className="num">{m.profit != null ? <b className={m.profit < 0 ? 'neg' : 'pos'}>{money2(m.profit)}</b> : <span className="muted">—</span>}</td>
                    <td><CopyText text={x.order_id} className="ap-mono">{x.order_id}</CopyText></td>
                    <td className="xs">{x.notified_at ? 'Sent' : <span className="error xs" title={x.notify_error || ''}>{x.notify_error ? 'Not sent' : '—'}</span>}</td>
                  </tr>
                ); })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

/* ------------------------------ 📦 Fulfill ------------------------------ */
// docs/context/presell-fulfillment.md. Both platforms make the UPS label AT the sale; this is
// the warehouse's list of pre-sell orders still to ship — one card per SKU + size (pull all the
// 10.5s at once), most urgent ship-by first, where each pair is, the label to print — and the
// same thing as a printable pick list (PDF / CSV).
const SHIP_VIEW = [['to_ship', 'To ship'], ['shipped', 'Shipped'], ['cancelled', 'Cancelled']];
const UPLAT = { alias: 'Alias', stockx: 'StockX' };

function FulfillTab({ onSignOut }) {
  const [view, setView] = useQueryParam('ship', 'to_ship');
  const [q, setQ] = useQueryParam('fq', '');
  const [only, setOnly] = useQueryParam('where', '');
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  const [now, setNow] = useState(() => Date.now());
  async function load() {
    try { setD(await api.presellFulfill({ view, q: q.trim() })); setError(''); }
    catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
  }
  useEffect(() => { load(); }, [view, q]); // eslint-disable-line react-hooks/exhaustive-deps
  useLive(['presell_sales', 'presell_stock'], load, { mount: false });
  // The "time left" words move on by themselves.
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(t); }, []);
  const rows = useMemo(() => (d ? (view === 'to_ship' ? assignWhere(d.rows) : d.rows) : null), [d, view]);
  const shown = useMemo(() => (rows && only && view === 'to_ship' ? rows.filter((x) => x.where === only) : rows), [rows, only, view]);
  const groups = useMemo(() => (shown ? pickGroups(shown) : []), [shown]);
  const tot = useMemo(() => fulfillTotals(rows || [], now), [rows, now]);

  async function check() {
    setBusy('sync'); setNote('');
    try {
      const r = await api.presellFulfillSync();
      const p = r.lastPass;
      setNote(!r.done ? 'Still reading the orders — the list updates by itself as they come in.'
        : `Read ${p.read} order${p.read === 1 ? '' : 's'}, ${p.changed} changed${p.errors?.length ? ` · ${p.errors.length} couldn’t be read` : ''}${p.stoppedBy ? ` · stopped: ${p.stoppedBy} — the rest on the next pass` : ''}.`);
      await load();
    } catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setBusy(''); }
  }
  async function download(fmt) {
    setBusy(fmt); setError('');
    try {
      const rep = await import('../lib/presellReport.js');
      const at = new Date();
      const scope = [only && `Only: ${WHERE[only].word}`, q.trim() && `Search: ${q.trim()}`].filter(Boolean).join('  |  ');
      const blob = fmt === 'csv'
        ? new Blob([rep.pickListCsv(shown, at.getTime())], { type: 'text/csv;charset=utf-8' })
        : (await rep.pickListPdf(shown, { generatedAt: `Generated ${estDate(at)} ${estTime(at)} EST`, scope, now: at.getTime() })).output('blob');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `presell-pick-list_${estToday()}.${fmt}`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (err) { setError(err.message || 'Could not build the pick list.'); }
    finally { setBusy(''); }
  }
  const c = d?.counts || {};
  return (
    <>
      <div className="card">
        <p className="muted sm">
          Alias and StockX make the <b>UPS label the moment a pair sells</b> — there’s nothing to “fulfil” on the platform. Print the label,
          pack the pair, hand it to UPS; the order moves on once UPS scans it. Miss the <b>ship-by</b> and the platform cancels the sale.
        </p>
        <div className="ff-bar">
          <Seg label="Orders" value={view} onChange={setView} options={SHIP_VIEW.map(([k, t]) => [k, t, c[k] || 0])} />
          <input className="input ff-search" placeholder="Search SKU, name, order #, tracking" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search orders" />
          <button type="button" className="btn sm" disabled={!!busy} onClick={check}>{busy === 'sync' ? 'Checking…' : '↻ Check status now'}</button>
          {view === 'to_ship' && <>
            <button type="button" className="btn sm" disabled={!!busy || !shown?.length} onClick={() => download('pdf')}>{busy === 'pdf' ? 'Building…' : '🖨 Pick list PDF'}</button>
            <button type="button" className="btn sm ghost" disabled={!!busy || !shown?.length} onClick={() => download('csv')}>{busy === 'csv' ? 'Building…' : '⬇ CSV'}</button>
          </>}
        </div>
        <p className="muted xs ff-pass">
          {d?.lastPass ? `Last checked ${when(d.lastPass.at)}.` : 'Not checked since the server started.'}
          {d && !d.watching && ' This server doesn’t check by itself (PRESELL_WATCH is off) — use ↻ Check status now.'}
          {d && d.watching && ' Checked by itself every couple of minutes.'}
          {c.unread > 0 && ` ${c.unread} order${c.unread === 1 ? '' : 's'} not read from the platform yet.`}
        </p>
        {note && <p className="muted sm">{note}</p>}
        {view === 'to_ship' && rows?.length > 0 && (
          <div className="ff-tot" role="group" aria-label="Where the pairs are">
            <span><b>{tot.toShip}</b> <span className="muted xs">to ship</span></span>
            {tot.overdue > 0 && <span className="ff-late"><b>{tot.overdue}</b> <span className="xs">late</span></span>}
            {tot.today > 0 && <span className="ff-soon"><b>{tot.today}</b> <span className="xs">due within 24 h</span></span>}
            {['ready', 'shelf', 'transit', 'source'].map((w) => (
              <button key={w} type="button" className={`ff-where ${w}${only === w ? ' on' : ''}`} aria-pressed={only === w}
                onClick={() => setOnly(only === w ? '' : w)} title={only === w ? 'Show all' : `Only: ${WHERE[w].word}`}>
                {WHERE[w].short} {tot[w]}
              </button>
            ))}
            {tot.noLabel > 0 && <span className="muted xs">{tot.noLabel} without a label yet</span>}
          </div>
        )}
      </div>
      {error && <div className="error mt">{error}</div>}
      {shown == null ? <div className="card"><p className="muted">Loading…</p></div>
        : !shown.length ? <div className="card"><p className="muted">{view === 'to_ship' ? (only || q ? 'Nothing matches.' : 'Nothing to ship — every pre-sell order has gone. 🎉') : 'None.'}</p></div>
          : groups.map((g) => (
            <div className="card ff-group" key={g.key}>
              <div className="ff-ghead">
                <ShoeThumb url={g.image} size={44} />
                <div className="ff-gname">
                  <b>{g.sku} · size {g.size}</b>
                  <div className="muted xs">{g.name}</div>
                </div>
                <div className="ff-gcount"><b>{g.orders.length}</b> <span className="muted xs">{view === 'to_ship' ? 'to ship' : 'order'}{g.orders.length === 1 || view === 'to_ship' ? '' : 's'}</span></div>
              </div>
              {g.orders.map((x) => <FulfillOrder key={x.id} x={x} now={now} toShip={view === 'to_ship'} />)}
            </div>
          ))}
    </>
  );
}

function FulfillOrder({ x, now, toShip }) {
  const u = urgency(x.ship_by, now);
  const label = labelLink(x);
  const docs = x.ship_docs || {};
  return (
    <div className="ff-order">
      <div className="ff-o-main">
        <span className="ff-plat">{UPLAT[x.platform] || x.platform}</span>
        <CopyText text={x.order_id} className="ap-mono">{x.order_id}</CopyText>
        {toShip && x.where && <span className={`ff-where ${x.where}`}>{WHERE[x.where].word}</span>}
        {toShip && x.box && (
          <span className="xs ap-ff-box" title={`Coming in ${x.box.po_code} box ${x.box.box_number ?? '?'} — ${x.box.tracking || 'no tracking number'}`}>
            📦 <span className="ap-mono">{x.box.tracking ? shortTrack(x.box.tracking) : `box ${x.box.box_number ?? '?'}`}</span> · {boxState(x.box).word}
          </span>
        )}
      </div>
      <div className="ff-o-when">
        {toShip ? (x.ship_by
          ? <span className={u === 'overdue' ? 'ff-late' : u === 'today' ? 'ff-soon' : ''}>Ship by <b>{when(x.ship_by)}</b> · {timeLeft(x.ship_by, now)}</span>
          : <span className="muted">No ship-by yet</span>)
          : <span className="muted">{x.ship_state === 'shipped' ? 'Shipped' : 'Cancelled'}{x.ship_state_at ? ` · seen ${when(x.ship_state_at)}` : ''}</span>}
        <span className="muted xs"> · sold {when(x.sold_at || x.created_at)} · {money(x.price_cents)}</span>
      </div>
      <div className="ff-o-ship">
        {x.tracking_number
          ? (x.tracking_url
            ? <a href={x.tracking_url} target="_blank" rel="noreferrer">{x.carrier ? `${x.carrier} ` : ''}{x.tracking_number}</a>
            : <span>{x.carrier ? `${x.carrier} ` : ''}{x.tracking_number}</span>)
          : <span className="muted xs">{x.order_status ? 'No tracking yet' : 'Not read from the platform yet'}</span>}
        {label && <a className="btn sm" href={label} target="_blank" rel="noreferrer">🏷 Label</a>}
        {docs.thermal && <a className="btn sm ghost" href={docs.thermal} target="_blank" rel="noreferrer" title="StockX’s shipping instructions, 4×6 thermal">Instructions 4×6</a>}
        {docs.letter && <a className="btn sm ghost" href={docs.letter} target="_blank" rel="noreferrer" title="StockX’s shipping instructions, letter paper">Letter</a>}
      </div>
      {(docs.additionalRequired || (x.order_status && !/LABEL_GENERATED|^CREATED$/.test(x.order_status) && toShip) || (x.where === 'transit' && (x.transit_note || x.expected_on))) && (
        <div className="muted xs">
          {docs.additionalRequired && <span className="error xs">StockX needs extra documents — print the full instructions, not the label only. </span>}
          {x.order_status && !/LABEL_GENERATED|^CREATED$/.test(x.order_status) && toShip && <span>Platform status: {x.order_status}. </span>}
          {x.where === 'transit' && [x.transit_note, x.expected_on && `expected ${String(x.expected_on).slice(0, 10)}`].filter(Boolean).join(' · ')}
        </div>
      )}
    </div>
  );
}

/* ------------------------------ ⚔ Compete ------------------------------- */
// Market competition (owner, 2026-10-11; api/_lib/presell-compete.js): keep live listings at
// the market's lowest ask — undercut by $1 or match it — never more than $5 under the price
// we set, following the market up. Master switch · "All shoes" · per shoe · per size.
const ACTION_WORD = { down: '↓ lowered', up: '↑ raised', floor: '⛔ at the $5 floor', hold: 'held', none: 'no market', drift: '⚠ changed outside the app', error: '⚠ error', skip: 'skipped',
  restore: '🔒 put back (changed outside the app)', rebase: '↻ re-based to the market (under the floor 2 h+)' };
const c2d = (c) => (c == null ? '—' : `$${(Number(c) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}`);

function CompeteTab({ onSignOut }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(() => new Set());
  const [showLog, setShowLog] = useState(false);
  async function load() {
    try { setD(await api.presellCompete()); setError(''); }
    catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
  }
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useLive(['presell_comp_sku', 'presell_comp_log', 'presell_stock'], load, { mount: false, minGap: 3000 });
  async function set(body) {
    setBusy(true); setError('');
    try { setD(await api.presellCompeteSet(body)); }
    catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setBusy(false); }
  }
  if (!d) return <div className="card">{error ? <div className="error">{error}</div> : <p className="muted">Loading…</p>}</div>;
  const toggle = (sku) => setOpen((o) => { const n = new Set(o); if (n.has(sku)) n.delete(sku); else n.add(sku); return n; });
  const competing = d.shoes.reduce((n, s) => n + s.sizes.filter((z) => z.mode).length, 0);
  return (
    <>
      <div className="card ap-comp">
        <label className="ap-comp-master">
          <input type="checkbox" checked={d.master} disabled={busy} onChange={(e) => set({ action: 'master', on: e.target.checked })} />
          <span><b>⚔ Market competition is {d.master ? 'ON' : 'OFF'}</b>
            <span className="muted xs"> · {competing} size{competing === 1 ? '' : 's'} {d.master ? 'taking part' : 'set to take part (paused)'} · checks every {d.everyMin} min{d.lastRun ? ` · last ${when(d.lastRun)}` : ''}{d.running ? ' · running now…' : ''}</span></span>
        </label>
        <label className="ap-comp-master">
          <input type="checkbox" checked={d.lock} disabled={busy} onChange={(e) => set({ action: 'lock', on: e.target.checked })} />
          <span><b>🔒 Lock pre-sell prices is {d.lock ? 'ON' : 'OFF'}</b>
            <span className="muted xs"> · a price changed outside this app (e.g. an Alias bulk reprice) is put back at the next check — every live size, competing or not. Change prices here instead.</span></span>
        </label>
        {!d.alertGroup && <p className="error xs">The price-alert Telegram group isn’t set on this server (PRICE_ALERT_CHAT_ID) — changes are logged below but not posted.</p>}
        <p className="muted xs ap-comp-rules">
          Every check, per size and per platform: if someone is <b>under</b> us, we go to their price (<b>Match</b>) or $1 under it
          (<b>Undercut $1</b>) — but never more than <b>$5 under the price we set</b>. If the market goes <b>up</b>, we follow it up (no cap).
          If the lowest ask is already ours, we hold. If the market stays <b>under the floor for 2 hours</b>, the market becomes the new
          “price we set” and the mode carries on from there. Only <b>live</b> listings move. Editing a price here makes that the new “price we set”.
          Every move is posted to the price-alert group.
        </p>
        <div className="ap-comp-all">
          <label className="ap-activate">
            <input type="checkbox" checked={d.all.on} disabled={busy} onChange={(e) => set({ action: 'all', on: e.target.checked, mode: d.all.mode })} />
            <span><b>All shoes</b> <span className="muted xs">— every shoe not set on its own below</span></span>
          </label>
          <Seg label="Default mode" value={d.all.mode} onChange={(m) => set({ action: 'all', on: d.all.on, mode: m })} options={Object.entries(COMP_MODES)} />
        </div>
        <div className="oo-actions">
          <button type="button" className="btn sm" disabled={busy || !(d.master || d.lock) || d.running || !d.here} onClick={() => set({ action: 'run' })}
            title={d.here ? 'Check every competing size now' : 'Only the live server moves prices'}>▶ Run now</button>
          {!d.here && <span className="muted xs">This server doesn’t move prices — only the live one does (PRESELL_WATCH).</span>}
        </div>
        {error && <div className="error mt">{error}</div>}
      </div>

      <div className="card">
        {!d.shoes.length ? <p className="muted">Nothing listed yet.</p> : (
          <div className="ap-groups">
            {d.shoes.map((sh) => {
              const own = sh.setting;
              const choice = !own ? 'all' : own.enabled ? 'on' : 'off';
              const mode = own?.mode || d.all.mode;
              const on = sh.sizes.filter((z) => z.mode).length;
              const isOpen = open.has(sh.sku);
              return (
                <div key={sh.sku} className={`ap-group${isOpen ? ' open' : ''}`}>
                  <button type="button" className="ap-group-head" aria-expanded={isOpen} onClick={() => toggle(sh.sku)}>
                    <ShoeThumb url={sh.image} size={44} />
                    <span className="ap-group-main">
                      <span className="ap-group-title"><b>{sh.sku}</b></span>
                      <span className="muted xs ap-group-name">{sh.name}</span>
                      <span className="xs">{on ? <span className="ap-comp-on">⚔ {on} of {sh.sizes.length} sizes</span> : <span className="muted">not competing</span>}</span>
                    </span>
                    <span className="ap-caret">{isOpen ? '▾' : '▸'}</span>
                  </button>
                  <div className="ap-group-bar ap-comp-bar">
                    <Seg label={`${sh.sku} competition`} value={choice} onChange={(v) => set(v === 'all' ? { action: 'sku', sku: sh.sku, clear: true } : { action: 'sku', sku: sh.sku, enabled: v === 'on', mode })}
                      options={[['all', `Follow all (${d.all.on ? 'on' : 'off'})`], ['on', 'On'], ['off', 'Off']]} />
                    {choice !== 'off' && <Seg label={`${sh.sku} mode`} value={mode} onChange={(m) => set({ action: 'sku', sku: sh.sku, enabled: choice === 'all' ? d.all.on : true, mode: m })} options={Object.entries(COMP_MODES)} />}
                    {d.here && d.master && on > 0 && <button type="button" className="btn sm ghost" disabled={busy || d.running} onClick={() => set({ action: 'run', sku: sh.sku })}>▶ Run this shoe</button>}
                  </div>
                  {isOpen && (
                    <div className="ap-group-pairs">
                      {sh.sizes.map((z) => (
                        <div key={z.id} className="ap-comp-size">
                          <div className="ap-comp-size-head">
                            <b>Size {z.size}</b>
                            <span className={z.mode ? 'ap-comp-on xs' : 'muted xs'}>{z.mode ? COMP_MODES[z.mode] : 'off'}</span>
                            <Seg label={`Size ${z.size}`} value={z.comp_override || 'shoe'} onChange={(v) => set({ action: 'size', stockId: z.id, override: v === 'shoe' ? null : v })}
                              options={[['shoe', 'Shoe'], ['on', 'On'], ['off', 'Off']]} />
                          </div>
                          {['alias', 'stockx'].map((p) => {
                            const st = z.comp_state?.[p];
                            const base = z[`comp_base_${p}_cents`];
                            if (!z[`${p}_live`]) return <div key={p} className="muted xs">{PLAT[p]}: nothing live</div>;
                            return (
                              <div key={p} className="xs ap-comp-plat">
                                <b>{PLAT[p]}</b> {z[`${p}_live`]} live at <b>{c2d(st?.price ?? z[`${p}_price`])}</b>
                                {st?.market != null && <> · market {c2d(st.market)}</>}
                                {z[`lock_${p}_cents`] != null && <> · 🔒 {c2d(z[`lock_${p}_cents`])}</>}
                                {base != null && <> · set {c2d(base)} → floor <b>{c2d(compFloor(base))}</b></>}
                                {st?.far_since && <span className="error"> · market under the floor since {when(st.far_since)} (re-bases after 2 h)</span>}
                                {st && <span className="muted"> · {ACTION_WORD[st.action] || st.action} {when(st.at)}</span>}
                                {base != null && <>{' · '}<button type="button" className="linklike xs" disabled={busy} title="Use the live price as the new “price we set” at the next check"
                                  onClick={() => set({ action: 'base', stockId: z.id, platform: p })}>reset floor</button></>}
                              </div>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="card">
        <button type="button" className="btn sm ghost" onClick={() => setShowLog((v) => !v)}>{showLog ? '▾' : '▸'} Price changes ({d.log.length})</button>
        {showLog && (!d.log.length ? <p className="muted">No changes yet.</p> : (
          <div className="ap-comp-log">
            {d.log.map((g) => (
              <div key={g.id} className={`ap-comp-logrow ${g.action}`}>
                <span className="muted xs">{when(g.created_at)}</span>
                <span><b>{g.sku}</b> {g.size} · {PLAT[g.platform] || g.platform}</span>
                <span>{ACTION_WORD[g.action] || g.action}{g.from_cents != null && g.to_cents != null ? ` ${c2d(g.from_cents)} → ${c2d(g.to_cents)}` : ''}
                  {g.market_cents != null ? <span className="muted"> · market {c2d(g.market_cents)}</span> : null}
                  {g.changed || g.failed ? <span className="muted"> · {g.changed} moved{g.failed ? `, ${g.failed} failed` : ''}</span> : null}</span>
                {g.note && <span className="muted xs">{g.note}</span>}
              </div>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}
