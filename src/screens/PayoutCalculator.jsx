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
//
// The other thing it reads: SUPPLIER PRESETS (api/payout/presets.js) — the fixed cost
// stack a given supplier buys at (tip fee, shipping, sales tax, gift-card discount).
// Those live in the DATABASE, not in prefs, because a supplier's tip fee is a fact
// about the supplier rather than about the phone it was typed on.
import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useQueryParam } from '../lib/urlstate.js';
import { TopBar, ShoeThumb } from '../components/common.jsx';
import { BatchAnalysis } from '../components/BatchAnalysis.jsx';
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
// Rates people TYPE are quoted back exactly: a sales tax of 8.25% is not 8.3%, and a
// supplier chip that rounds the number it just filled in reads as a different number.
// pct() keeps its one decimal for the things we CALCULATE — ROI, margin, fees.
const ratePct = (v) => `${Number(Number(v || 0).toFixed(3))}%`;

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

// A supplier preset carries the WHOLE register stack, not just the four numbers that
// differ between suppliers. Applying one that left store/promo/cashback alone would
// quietly carry the last store trip's discount into the next supplier's cost — the
// exact wrong-number-in-a-buy-call this screen exists to prevent.
//   · rate keys (RATE_KEYS) go to prefs.payoutRates, which persists per device
//   · amount keys (tip, shipping) are per-pair fields, which do not
const RATE_KEYS = ['taxPct', 'giftPct', 'storePct', 'promoPct', 'cashbackPct'];
const PRESET_FIELDS = [
  ['tipAmt', 'Tip fee', '$'],
  ['shippingAmt', 'Shipping', '$'],
  ['taxPct', 'Sales tax', '%'],
  ['giftPct', 'Gift card', '%'],
  ['storePct', 'Store discount', '%'],
  ['promoPct', 'Promo / birthday', '%'],
  ['cashbackPct', 'Cashback', '%'],
];
const BLANK_PRESET = { id: null, name: '', note: '', supplierUserId: '', tipAmt: '', shippingAmt: '', taxPct: '', giftPct: '', storePct: '', promoPct: '', cashbackPct: '' };
// Empty box === 0, so a preset always states the whole stack. Compared numerically
// because '8.25' from the form and 8.25 from the server are the same fee.
const same = (a, b) => Number(a || 0) === Number(b || 0);

// One market strip — a row of tappable quotes that fill a platform's sale price.
function MarketStrip({ title, cols, row, onUse, note, activeValue }) {
  return (
    <div className="pc-market mt">
      <div className="pc-market-head muted sm">{title}</div>
      {note ? <div className="pc-market-note">{note}</div> : null}
      <div className="pc-market-grid">
        {cols.map(([key, label]) => {
          const v = quoted(row[key]);
          // Which number is actually being used. Derived from the sale price rather
          // than remembered, so it follows a tap, follows the auto-fill, and quietly
          // goes away the moment someone types a price of their own.
          const on = !!v && String(activeValue ?? '').trim() !== '' && Number(activeValue) === v;
          return (
            <button type="button" key={key} className={`pc-market-cell${on ? ' on' : ''}`} disabled={!v}
              aria-pressed={on} onClick={() => onUse(String(v))}>
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

// The supplier editor. Its own overlay rather than <Modal>, whose children all land in
// a single flex row — this is a form, not a row of buttons.
//
// One list, one form, no separate "add" screen: the ＋ button just opens the same form
// with a blank preset, because "add Marcus" and "Chris charges $7 now" are the same
// job, done in the same aisle, on the same phone.
function PresetManager({ presets, onClose, onSaved, onDeleted, onSignOut }) {
  const [draft, setDraft] = useState(null);   // null = the list; otherwise the form
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(null);
  const [err, setErr] = useState('');
  // Supplier ACCOUNTS (users with role 'supplier'), for the link that decides who can
  // read this stack from their own sign-in. Same list the create-PO picker uses. It
  // failing is not fatal — the rest of the form still saves.
  const [accounts, setAccounts] = useState([]);
  useEffect(() => {
    let live = true;
    api.poSuppliers()
      .then(({ suppliers }) => { if (live) setAccounts(suppliers || []); })
      .catch(() => { /* the link field just stays empty */ });
    return () => { live = false; };
  }, []);

  const field = (k, v) => setDraft((d) => ({ ...d, [k]: v }));

  // Escape backs out one level — the form first, then the overlay — the way <Modal>
  // does, so the two dialogs on this screen don't behave differently.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape' || busy) return;
      if (draft) setDraft(null); else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [draft, busy, onClose]);

  async function save(e) {
    e?.preventDefault();
    if (!String(draft.name || '').trim()) { setErr('Give the supplier a name.'); return; }
    setBusy(true); setErr('');
    try {
      const { preset } = await api.payoutPresetSave(draft);
      onSaved(preset);
      setDraft(null);
    } catch (ex) {
      if (ex.unauthorized) return onSignOut();
      setErr(ex.message);
    } finally { setBusy(false); }
  }

  async function remove(p) {
    setBusy(true); setErr('');
    try {
      await api.payoutPresetDelete(p.id);
      onDeleted(p.id);
      setConfirmDel(null);
    } catch (ex) {
      if (ex.unauthorized) return onSignOut();
      setErr(ex.message);
    } finally { setBusy(false); }
  }

  return (
    <div className="modal-overlay" onClick={() => (busy ? null : onClose())}>
      <div className="modal pc-preset-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">{draft ? (draft.id ? `Edit ${draft.name || 'supplier'}` : 'New supplier') : 'Suppliers'}</h3>
        <p className="modal-msg">
          {draft
            ? 'What this supplier costs on every pair. A blank box is zero — the preset states the whole stack.'
            : 'The cost stack each supplier buys at. Tap one on the calculator to fill Store cost in one go.'}
        </p>

        {!draft && (
          <div className="pc-preset-list">
            {presets.length === 0 && <p className="muted sm">No suppliers yet — add the first one.</p>}
            {presets.map((p) => (
              <div className="pc-preset-row" key={p.id}>
                <div className="pc-preset-row-main">
                  <span className="pc-preset-row-name">{p.name}</span>
                  <span className="muted sm">
                    tip {money(p.tipAmt)} · ship {money(p.shippingAmt)} · tax {ratePct(p.taxPct)} · gift {ratePct(p.giftPct)}
                    {p.storePct || p.promoPct || p.cashbackPct
                      ? ` · store ${ratePct(p.storePct)} · promo ${ratePct(p.promoPct)} · cashback ${ratePct(p.cashbackPct)}`
                      : ''}
                    {p.note ? ` · ${p.note}` : ''}
                  </span>
                  {p.supplierUserId && (
                    <span className="pc-preset-linked" title="This supplier signs in and sees this stack on their own Payout Calculator">
                      ⇄ signs in as {p.supplierUsername || `#${p.supplierUserId}`}
                    </span>
                  )}
                </div>
                <div className="pc-preset-row-acts">
                  <button type="button" className="btn ghost sm" disabled={busy}
                    onClick={() => { setErr(''); setDraft({ ...BLANK_PRESET, ...p }); }}>Edit</button>
                  <button type="button" className="btn ghost sm danger" disabled={busy}
                    onClick={() => { setErr(''); setConfirmDel(p); }}>Delete</button>
                </div>
                {confirmDel?.id === p.id && (
                  <div className="pc-preset-confirm">
                    <span>Delete {p.name}? Nothing else references it.</span>
                    <button type="button" className="btn danger sm" disabled={busy} onClick={() => remove(p)}>
                      {busy ? 'Deleting…' : 'Delete'}
                    </button>
                    <button type="button" className="btn ghost sm" disabled={busy} onClick={() => setConfirmDel(null)}>Keep</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {draft && (
          <form className="pc-preset-form" onSubmit={save}>
            <label className="pc-field">
              <span className="pc-field-label">Supplier</span>
              <input type="text" value={draft.name} maxLength={60} placeholder="e.g. Andrew"
                onChange={(e) => field('name', e.target.value)} />
            </label>
            <div className="pc-grid">
              <NumField label="Tip fee" prefix="$" value={draft.tipAmt} onChange={(v) => field('tipAmt', v)} placeholder="0.00" />
              <NumField label="Shipping" prefix="$" value={draft.shippingAmt} onChange={(v) => field('shippingAmt', v)} placeholder="0.00"
                hint="incl. box swap fee + labour" />
            </div>
            <div className="pc-grid">
              <NumField label="Sales tax" suffix="%" value={draft.taxPct} onChange={(v) => field('taxPct', v)} hint="0 for a no-tax state" />
              <NumField label="Gift card" suffix="%" value={draft.giftPct} onChange={(v) => field('giftPct', v)} />
            </div>
            <div className="pc-grid three">
              <NumField label="Store discount" suffix="%" value={draft.storePct} onChange={(v) => field('storePct', v)} />
              <NumField label="Promo" suffix="%" value={draft.promoPct} onChange={(v) => field('promoPct', v)} />
              <NumField label="Cashback" suffix="%" value={draft.cashbackPct} onChange={(v) => field('cashbackPct', v)} />
            </div>
            <label className="pc-field">
              <span className="pc-field-label">Note <span className="muted sm">optional</span></span>
              <input type="text" value={draft.note} maxLength={200} placeholder="e.g. No sales tax"
                onChange={(e) => field('note', e.target.value)} />
            </label>
            {/* The link is by ACCOUNT ID, not by matching the name above — rename
                either side and a name match would start showing one supplier another's
                costs. Linked is also the ONLY way a supplier sees this screen filled. */}
            <label className="pc-field">
              <span className="pc-field-label">Supplier sign-in <span className="muted sm">optional</span></span>
              <select value={draft.supplierUserId ?? ''} onChange={(e) => field('supplierUserId', e.target.value)}>
                <option value="">Not linked — staff only</option>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.username})</option>)}
              </select>
              <span className="muted sm">
                Linked, this supplier sees this stack — and only this one — on their own Payout Calculator. They can’t edit it.
              </span>
            </label>
          </form>
        )}

        {err && <div className="error mt">{err}</div>}

        <div className="modal-actions">
          {draft ? (
            <>
              <button type="button" className="btn" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
              <button type="button" className="btn ghost" disabled={busy} onClick={() => { setDraft(null); setErr(''); }}>Cancel</button>
            </>
          ) : (
            <>
              <button type="button" className="btn" disabled={busy}
                onClick={() => { setErr(''); setDraft({ ...BLANK_PRESET }); }}>＋ New supplier</button>
              <button type="button" className="btn ghost" disabled={busy} onClick={onClose}>Done</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function PayoutCalculator({ user, onHome, onSignOut }) {
  // A SUPPLIER gets this screen too (they're the one in the shop). Two differences, and
  // the server enforces both independently — this flag only decides what's drawn:
  //   · the preset list they receive holds their own stack and nothing else, so there's
  //     no supplier row to pick BETWEEN; it applies itself,
  //   · and they can't edit it — their cost stack is an input to our buy call.
  const isSupplier = user?.role === 'supplier';

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

  // Supplier presets — the fixed cost stack a given supplier buys at. These live in the
  // DATABASE, unlike the rates above: a supplier's tip fee is a fact about the supplier,
  // not about this phone, so the buyer on the floor and whoever checks the maths later
  // must read the same one. `presetId` is only a label for what was applied — every
  // field stays editable afterwards.
  const [presets, setPresets] = useState([]);
  const [presetId, setPresetId] = useState(null);
  const [manageOpen, setManageOpen] = useState(false);

  useEffect(() => {
    let live = true;
    api.payoutPresets()
      .then(({ presets: list }) => {
        if (!live) return;
        setPresets(list || []);
        // A supplier's list is their own stack. Nobody should have to tap their own
        // name to get the numbers they always buy at — so it applies itself, once, on
        // load. Still fully editable afterwards: the coupon and the shelf price change
        // per pair, and a one-off promo shouldn't need a call to the office.
        if (isSupplier && (list || []).length === 1) applyPreset(list[0], { toggle: false });
      })
      // A preset list that won't load must not break the calculator: every number it
      // fills is typeable by hand, which is how this screen worked before presets existed.
      .catch((e) => { if (e.unauthorized) onSignOut(); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activePreset = presets.find((p) => p.id === presetId) || null;
  // Derived, never a flag: the moment a number diverges from the supplier the chip
  // claims, the chip has to stop claiming it.
  const presetEdited = !!activePreset && (
    !same(tipAmt, activePreset.tipAmt)
    || !same(shippingAmt, activePreset.shippingAmt)
    || RATE_KEYS.some((k) => !same(rates[k], activePreset[k]))
  );

  // Applying replaces the WHOLE register stack in one write — the rates into prefs
  // (which persist per device), tip and shipping into the per-pair fields (which don't).
  // Tapping the applied supplier again drops the label but LEAVES the numbers: they're
  // what you're about to buy at, and zeroing them mid-decision would be worse.
  // `toggle:false` is how a just-edited preset re-applies itself: presetId is still the
  // stale value in that render, so the toggle would read it as a second tap and turn the
  // supplier off instead of taking its new numbers.
  function applyPreset(p, { toggle = true } = {}) {
    if (toggle && presetId === p.id) { setPresetId(null); return; }
    setPrefs((prev) => {
      const next = { ...prev, payoutRates: { ...(prev.payoutRates || {}) } };
      for (const k of RATE_KEYS) next.payoutRates[k] = String(p[k] ?? 0);
      savePrefs(next);
      return next;
    });
    setTipAmt(String(p.tipAmt ?? ''));
    setShippingAmt(String(p.shippingAmt ?? ''));
    setPresetId(p.id);
  }


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
      if (res.velocity?.liquidity && res.velocity.sold > 0 && !liquidityTouched) {
        setLiquidity(res.velocity.liquidity);
      }
      const sxHit = res.stockx?.results?.[0] || null;
      setSx({
        configured: !!res.stockx?.configured,
        row: sxHit,
        error: res.stockx?.error || '',
      });
      const aliasHit = res.results?.[0] || null;
      // **Lowest ask fills the sale price, per platform, without a tap.** It's the first
      // column for a reason — it's what the pair actually sells for — and needing a tap
      // before any verdict appeared meant the screen looked like it had no opinion.
      // Each platform fills from ITS OWN ask; the other three cells are still one tap
      // away, and typing over it wins.
      //
      // Overwriting on every fetch is deliberate: a fetch only happens on a new SIZE or
      // a basis switch, and both make the previous number a statement about a different
      // thing. (Basis switching already re-prices for exactly this reason.)
      setSale({
        alias: quoted(aliasHit?.lowest_listing) ? String(quoted(aliasHit.lowest_listing)) : '',
        stockx: quoted(sxHit?.lowest_ask) ? String(quoted(sxHit.lowest_ask)) : '',
      });
      if (!res.configured) { setNotConfigured(true); return; }
      setMarket(aliasHit || { size: String(sz), _empty: true });
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
    // The rates survive Clear (they're the store trip), but tip and shipping don't — so
    // the stack no longer IS the supplier's, and the chip must stop saying it is.
    setPresetId(null);
  }

  const sizes = product?.sizes || [];
  const hasMarket = market && !market._empty;
  const sxRow = sx?.row || null;
  // "Measured" only while it still matches the data — the moment someone overrides it,
  // the number on screen is theirs. The evidence line still shows (what the shoe did is
  // true either way); this flag is what tells the advisor whose call the band is.
  const measured = !!velocity && velocity.sold > 0 && !liquidityTouched && liquidity === velocity.liquidity;

  // Publish what this screen is showing, so the app-wide advisor (the floating button)
  // can answer about the pair in front of you. Rebuilt whenever the numbers change, so a
  // question typed after editing a cost is answered against the new one.
  useAdvisorContext(() => ({
    page: 'the Payout Calculator',
    sku: product?.sku || null,
    name: product?.name || null,
    size: size || null,
    basis,
    supplier: activePreset ? `${activePreset.name}${presetEdited ? ' (stack edited by hand)' : ''}` : null,
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
    liquiditySource: measured ? 'measured from Shopify sales, all channels' : (liquidity ? 'chosen by the buyer' : 'not set'),
    salesVelocity: velocity && velocity.sold > 0
      ? `${velocity.sold} sold in ${velocity.days} days (${Object.entries(velocity.channels || {}).map(([c, n]) => `${c} ${n}`).join(', ')}), ${velocity.per_week}/week`
      : null,
    verdict: verdict
      ? `${CALL_LABEL[verdict.call]} — best on ${verdict.best.label}, profit ${money(verdict.best.profit)}, ROI ${pct(verdict.best.roi)}, risk ${RISK_LABEL[verdict.risk]}`
      : 'not enough entered for a call yet',
  }), [product, size, basis, shelfPrice, couponAmt, tipAmt, shippingAmt, liquidity,
    breakdown.finalCost, payouts, market, sxRow, rates, velocity, measured,
    activePreset, presetEdited]);

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
            title={`Size ${market.size} · live Alias market · ${basis === 'with_you' ? 'With You' : 'Consigned'} — lowest ask is filled in below; tap another to use it instead`}
            cols={MARKET_COLS} row={market} activeValue={sale.alias}
            onUse={(v) => setSale((s) => ({ ...s, alias: v }))} />
        )}

        {sxRow && (
          <MarketStrip
            title={`Size ${size} · live StockX market — lowest ask is filled in below; tap another to use it instead`}
            cols={SX_MARKET_COLS} row={sxRow} activeValue={sale.stockx}
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
        {/* Who's buying it. One tap fills the whole stack below — four numbers nobody
            should be retyping per pair, on a phone, in a shop. */}
        <div className="pc-preset-bar">
          <span className="pc-field-label">{isSupplier ? 'Your cost stack' : 'Supplier'}</span>
          <div className="pc-preset-chips">
            {presets.map((p) => (
              <button type="button" key={p.id}
                className={`pi-chip ${p.id === presetId ? 'on' : ''}`.trim()}
                aria-pressed={p.id === presetId}
                title={`tip ${money(p.tipAmt)} · shipping ${money(p.shippingAmt)} · tax ${ratePct(p.taxPct)} · gift card ${ratePct(p.giftPct)}`}
                onClick={() => applyPreset(p)}>{p.name}</button>
            ))}
            {/* Suppliers don't get Manage: their stack is what WE buy at through them,
                so it's the floor's number to change, not theirs. */}
            {!isSupplier && (
              <button type="button" className="btn ghost sm" onClick={() => setManageOpen(true)}>
                {presets.length ? 'Manage' : '＋ Add a supplier'}
              </button>
            )}
          </div>
          <span className="muted sm pc-preset-why">
            {isSupplier && !presets.length
              ? 'No cost stack set up for you yet — ask the Stickballman12 team, or just type the numbers below.'
              : !activePreset
                ? (isSupplier ? 'Tap your name to refill the stack below, or just type it.'
                  : 'Tap one to fill the whole stack below, or just type it.')
                : presetEdited
                  ? `${activePreset.name}’s stack, edited below — the numbers on screen are the ones being used.`
                  : `${activePreset.name}: tip ${money(activePreset.tipAmt)} · shipping ${money(activePreset.shippingAmt)} · tax ${ratePct(activePreset.taxPct)} · gift card ${ratePct(activePreset.giftPct)}${activePreset.note ? ` · ${activePreset.note}` : ''}`}
          </span>
        </div>
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
          A supplier preset fills all of it at once and is shared with the whole team.
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
              <BreakRow label={`Store discount (${ratePct(rates.storePct)})`} value={breakdown.storeSaved} sign="−" />
              <BreakRow label={`Promo (${ratePct(rates.promoPct)})`} value={breakdown.promoSaved} sign="−" />
              <BreakRow label={`Gift card (${ratePct(rates.giftPct)})`} value={breakdown.giftSaved} sign="−" />
              {breakdown.couponSaved > 0 && <BreakRow label="Coupon" value={breakdown.couponSaved} sign="−" />}
              {breakdown.cashback > 0 && <BreakRow label={`Cashback (${ratePct(rates.cashbackPct)})`} value={breakdown.cashback} sign="−" />}
              <BreakRow label={`Tax (${ratePct(rates.taxPct)})`} value={breakdown.tax} sign="+" />
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
          {velocity && velocity.sold > 0 ? (
            <span className="pc-liq-why muted sm">
              <strong>{velocity.sold}</strong> sold in {velocity.days} days · {velocity.per_week}/week
              {Object.keys(velocity.channels || {}).length
                ? ` · ${Object.entries(velocity.channels).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${n}`).join(', ')}`
                : ''}
              {liquidityTouched ? ' — you overrode this' : ''}
            </span>
          ) : velocity ? (
            <span className="pc-liq-why muted sm">no sales in the last {velocity.days} days — pick one</span>
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

        {/* 5 — the same question, asked about a whole list. It lives DOWN HERE, under the
            cost stack, on purpose: every pasted price is run through the register above,
            so a supplier preset tapped once at the top prices forty rows. Behind a mode
            toggle it would have meant re-entering a stack that was already on screen. */}
        <div className="pc-batch-sep">
          <h3 className="pc-h">Or price a whole list</h3>
          <p className="muted sm pc-batch-intro">
            A supplier sent you forty pairs? Paste the message. Every row is priced against
            the same market and the same cost stack you just filled in above.
          </p>
          <BatchAnalysis
            stack={{
              storePct: rates.storePct, promoPct: rates.promoPct, giftPct: rates.giftPct,
              cashbackPct: rates.cashbackPct, taxPct: rates.taxPct,
              tipAmt, shippingAmt,
            }}
            feeOverride={feeOverride}
            basis={basis}
            onSignOut={onSignOut}
          />
        </div>

      </div>

      {manageOpen && (
        <PresetManager
          presets={presets}
          onClose={() => setManageOpen(false)}
          onSignOut={onSignOut}
          onSaved={(saved) => {
            setPresets((list) => {
              const next = list.some((x) => x.id === saved.id)
                ? list.map((x) => (x.id === saved.id ? saved : x))
                : [...list, saved];
              return next.sort((a, b) => a.name.localeCompare(b.name));
            });
            // Editing the supplier currently applied has to move the numbers on screen
            // too — otherwise the chip names a stack the calculator isn't using.
            if (saved.id === presetId) applyPreset(saved, { toggle: false });
          }}
          onDeleted={(id) => {
            setPresets((list) => list.filter((x) => x.id !== id));
            if (id === presetId) setPresetId(null);
          }}
        />
      )}
    </div>
  );
}
