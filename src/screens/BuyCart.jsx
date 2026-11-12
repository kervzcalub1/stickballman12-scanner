// One buying request, from "what are you buying?" to CLOSED / RECONCILED.
//
// ONE screen for four jobs, not four screens. The buyer, the approver, the gift card
// desk and the auditor are all looking at the same transaction, and the thing that
// matters most about it — what happened, in order, and what is still outstanding — is
// the same for all of them. What changes per role is which buttons exist, and that is
// decided by the server on every write regardless of what this file renders.
//
// The ten conditions come from the server (`cart.checks`) rather than being worked out
// here, so the list a person reads is byte-for-byte the list `cart/close` will enforce.
// A gate that lives in the UI is a gate a stale tab walks straight through.
import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useLive } from '../hooks.js';
import { poHref } from '../lib/poLink.js';
import { BuyCartProgress } from '../components/BuyCartProgress.jsx';
import { TopBar, PriceInput, FormModal } from '../components/common.jsx';
import { BuyCartAdd, VerdictChip, lineCall } from '../components/BuyCartAdd.jsx';
import { BuyCartGiftCards } from '../components/BuyCartGiftCards.jsx';
import { BuyCartReceipt } from '../components/BuyCartReceipt.jsx';
import { BuyCartCosts } from '../components/BuyCartCosts.jsx';
import { BuyCartPack } from '../components/BuyCartPack.jsx';
import { BuyCartTasks } from '../components/BuyCartTasks.jsx';
import { estDate, estTime, PH_DATE, estClock } from '../lib/format.js';
import { PLATFORMS } from '../lib/payout.js';
import { hasPriv } from '../lib/constants.js';
import { notHereLines } from '../lib/notHere.js';
import { auditTarget, fundingBreakdown, LIST_ADDABLE, decisionsOpen, decisionsClosedBecause, decisionsPendingOnly, buyerCanAdd, buyerCanClose, buyerCanReopen, reopenRefusedBecause, listOpen, cardsIssuable, nextStep, linesByDecision } from '../lib/buycartRules.js';
import { NudgeButton } from '../components/NudgeButton.jsx';
import { GIFT_CARD_MERCHANTS, merchantLabel, merchantEditable } from '../lib/giftCardMerchants.js';

const money = (n) => (n == null ? '—' : `$${(Number(n) || 0).toFixed(2)}`);
// `best_platform` stores the KEY ('alias'), and printing it raw read "92.7% ROI via
// alias" beside a calculator that says "via Alias" — the same call looking like two
// tools' opinions.
const platform = (key) => PLATFORMS.find((p) => p.key === key)?.label || key || '—';

// The request's own state, in the words of the process rather than the column value.
const STATUS = {
  draft: { label: 'Being written', cls: 'draft' },
  submitted: { label: 'Waiting on approval', cls: 'warn' },
  approved: { label: 'Approved — needs gift cards', cls: 'shipped' },
  denied: { label: 'Denied', cls: 'muted' },
  funded: { label: 'Cards released — waiting on the receipt', cls: 'shipped' },
  receipted: { label: 'Receipt in — needs auditing', cls: 'warn' },
  audited: { label: 'Audited — waiting on the shipment', cls: 'shipped' },
  closed: { label: 'Closed / reconciled', cls: 'ok' },
  cancelled: { label: 'Cancelled', cls: 'muted' },
  // Neither closed nor open. A request that could not be completed says so, with a
  // reason and a name — never a false "received" or "refunded".
  written_off: { label: 'Written off — documented loss', cls: 'danger' },
};

function StatusChip({ status }) {
  const s = STATUS[status] || { label: status, cls: 'muted' };
  return <span className={`po-chip ${s.cls}`}>{s.label}</span>;
}

// Whether the buyer is STILL ADDING. The status column cannot say it — a request is
// `submitted` from the first pair onward, whether the buyer is mid-aisle or has gone
// home — and it is the one thing the gift-card desk has to know before funding a total.
function ListChip({ cart }) {
  if (['closed', 'cancelled', 'written_off', 'receipted', 'audited'].includes(cart.status)) return null;
  if (cart.status === 'draft' && !Number(cart.line_count)) return null;
  return listOpen(cart)
    ? <span className="po-chip warn bc-list-chip" title="The buyer can still add pairs. Cards wait until they close it.">Buyer still adding</span>
    : <span className="po-chip muted bc-list-chip" title={`Closed by ${cart.list_closed_by || 'the buyer'} ${estDate(cart.list_closed_at)} EST`}>List closed</span>;
}

// The three groups the lines fall into once the list is closed, and the heading row above
// each one. The heading is a button spanning the table: tap to show or hide that group.
const lineGroup = (l) => (l.status === 'approved' ? 'approved' : l.status === 'pending' ? 'pending' : 'out');
const GROUP_LABEL = { approved: 'Approved', pending: 'Waiting on an answer', out: 'Turned down or not buying' };
function GroupRow({ group, lines, cols, shut, onToggle }) {
  const these = lines.filter((l) => lineGroup(l) === group);
  const n = these.length;
  // "2 turned down · 1 not buying": the out group holds two different endings.
  const detail = group === 'out'
    ? [[these.filter((l) => l.status === 'rejected').length, 'turned down'], [these.filter((l) => l.status === 'skipped').length, 'not buying']]
      .filter(([c]) => c > 0).map(([c, w]) => `${c} ${w}`).join(' · ')
    : null;
  return (
    <tr className={`bc-group-row ${group}`}>
      <td colSpan={cols}>
        <button type="button" className="bc-group-toggle" aria-expanded={!shut} onClick={onToggle}>
          <span className="bc-group-caret" aria-hidden="true">{shut ? '▸' : '▾'}</span>
          <b>{GROUP_LABEL[group]}</b>
          <span className="muted sm">{n} line{n === 1 ? '' : 's'}{detail && detail !== `${n} turned down` && detail !== `${n} not buying` ? ` · ${detail}` : ''}</span>
          <span className="muted xs bc-group-hint">{shut ? 'Show' : 'Hide'}</span>
        </button>
      </td>
    </tr>
  );
}

// Which merchant's gift cards the request needs. Picked when the request is opened. A
// request opened before the list existed has none, so the row turns amber and asks for
// one: the list can't be closed until it's picked (cart/submit). It can be changed until
// the desk records a card, and after that it's locked (merchantEditable).
function MerchantRow({ cart, canChange, busy, onPick }) {
  const label = merchantLabel(cart.gc_merchant);
  if (!label && !canChange) return null;
  return (
    <div className="bc-merchant" data-accent={label ? undefined : 'attention'}>
      <b>Gift cards for:</b>
      {canChange ? (
        <select className="input" value={cart.gc_merchant || ''} disabled={busy}
          aria-label="Gift cards for" onChange={(e) => e.target.value && onPick(e.target.value)}>
          {!label && <option value="">Pick a merchant…</option>}
          {GIFT_CARD_MERCHANTS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
        </select>
      ) : <span>{label}</span>}
      {!label && <span className="muted sm">Pick one so the desk sends the right cards.</span>}
    </div>
  );
}

// The closing checklist. Rendered whatever the state, because the useful question on
// day one is "what is this still waiting on" — but a group is only OPENED once it can be
// answered. Twelve unticked conditions on a request written ten minutes ago are twelve
// rows everybody learns to scroll past, and then nobody reads them on the day they
// matter. A group that is not answerable yet is one line with its count; tap to see it.
const MONEY_LIVE = ['funded', 'receipted', 'audited', 'closed', 'written_off'];
const GOODS_LIVE = ['receipted', 'audited', 'closed', 'written_off'];

function Checks({ checks, status }) {
  if (!checks?.length) return null;
  const done = checks.filter((c) => c.ok).length;
  // TWO groups, because they are answerable at different times from different evidence.
  // The money can be reconciled the day the receipt lands; the goods not until the boxes
  // are in the building. Showing them as one list of ten made a request look stuck on the
  // money for weeks when it was only ever waiting for a parcel.
  const groups = [
    { scope: 'money', title: 'The money', note: 'Answerable as soon as the receipt is in.', live: MONEY_LIVE.includes(status) },
    { scope: 'goods', title: 'The goods', note: 'Not answerable until the boxes have landed.', live: GOODS_LIVE.includes(status) },
  ];
  return (
    <section className="card bc-checks">
      <h3 className="bc-h">
        Closing conditions <span className="muted sm">{done} of {checks.length}</span>
      </h3>
      {groups.map((g) => {
        const list = checks.filter((c) => (c.scope || 'money') === g.scope);
        if (!list.length) return null;
        const gd = list.filter((c) => c.ok).length;
        const pct = Math.round((gd / list.length) * 100);
        // Outstanding first WITHIN each group. The order that matters on a checklist is
        // "what is left", and a done row sitting above three outstanding ones is a row
        // you have to read past every time you open the request.
        const ordered = [...list].sort((a, b) => Number(a.ok) - Number(b.ok));
        const expand = g.live && gd < list.length;
        return (
          <details key={g.scope} className="bc-check-group" open={expand}>
            <summary className="bc-check-group-h">
              <h4>{g.title}</h4>
              <span className={gd === list.length ? 'bc-covered sm' : 'muted sm'}>{gd} of {list.length}</span>
              {!g.live && gd < list.length && <span className="muted xs">not yet</span>}
              <span className="bc-check-bar" aria-hidden="true">
                <span className={`bc-check-fill${gd === list.length ? ' done' : ''}`} style={{ width: `${pct}%` }} />
              </span>
            </summary>
            <p className="muted xs bc-check-blurb">{g.note}</p>
            <ul className="bc-check-list">
              {ordered.map((c) => (
                <li key={c.key} className={c.ok ? 'ok' : ''}>
                  <span className="bc-check-mark" aria-hidden="true">{c.ok ? '\u2713' : '\u25cb'}</span>
                  <span className="bc-check-body">
                    <span className="bc-check-label">{c.label}</span>
                    {/* On its OWN line. Run together, "Receipt was parsed  The receipt
                        has not been read into lines yet." reads as one long sentence and
                        the condition stops being scannable. */}
                    {c.detail && <span className="bc-check-detail">{c.detail}</span>}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        );
      })}
      {done < checks.length && GOODS_LIVE.includes(status) && (
        <p className="muted sm">
          A transaction isn’t finished because the money was spent. It’s finished when every
          line above is true.
        </p>
      )}
    </section>
  );
}

// The Payout Calculator's verdict card, for a line that already has one. Same shape and
// the same sentence, because a buy call read on the request and the same call read on the
// calculator must not look like two different tools' opinions.
//
// The NUMBERS come off the stored snapshot; only the prose is re-derived (`lineCall`), so
// there is one source of truth for anything a person decides on.
function LineCall({ line, stack, onPrice, canPrice, busy }) {
  const v = lineCall(line, stack);
  const alias = Number(line.alias_price) > 0 ? Number(line.alias_price) : null;
  const stockx = Number(line.stockx_price) > 0 ? Number(line.stockx_price) : null;
  return (
    <div className={`bc-call ${line.verdict || 'none'}`}>
      <div className="bc-call-top">
        <VerdictChip verdict={line.verdict} />
        <span className="muted sm">
          Cost per unit {money(line.final_cost)}
          {line.profit != null && ` · ${money(line.profit)} profit · ${Number(line.roi).toFixed(1)}% ROI via ${platform(line.best_platform)}`}
        </span>
        {v?.risk && <span className={`bc-risk ${v.risk}`}>{v.risk} risk</span>}
      </div>
      {v && <p className="bc-call-note">{v.note}</p>}
      {/* Why there is no call, in the words of what actually happened. "Not priced" on
          its own sends people looking for a setting that doesn't exist. */}
      {!v && (
        <p className="bc-call-note muted">
          No Alias or StockX price was captured for this size when it was added, so no call
          could be made — the market lookup came back empty or timed out.
          {canPrice ? ' Price it now to get one.' : ''}
        </p>
      )}
      <div className="bc-market">
        <span>Alias <b>{alias ? money(alias) : '—'}</b></span>
        <span>StockX <b>{stockx ? money(stockx) : '—'}</b></span>
        {line.liquidity && <span>sells <b>{line.liquidity}</b></span>}
        {line.basis && <span className="muted sm">{line.basis === 'consigned' ? 'consigned' : 'you hold it'}</span>}
        {line.quoted_at && <span className="muted sm">quoted {estDate(line.quoted_at)} EST</span>}
      </div>
      {canPrice && (
        <div className="bc-call-actions">
          <button type="button" className={`btn sm ${v ? 'ghost' : 'primary'}`} disabled={busy}
            onClick={onPrice}>
            {busy ? 'Reading the market…' : v ? 'Re-price against today’s market' : 'Price it'}
          </button>
          {v && <span className="muted xs">This replaces the call an approver is reading, and says so in the history.</span>}
        </div>
      )}
    </div>
  );
}

// The buyer's photo of the shoe, on the approver's row.
//
// Keyed by STYLE CODE, not by line: a request carrying a 7, an 8 and a 9 of one pair has
// one set of shots, and showing the same thumbnail on all three rows is the correct
// answer rather than a shortcut. The bytes are PROXIED like every other file here — the
// bucket never serves one by URL — so this fetches with the session token and turns it
// into an object URL, revoked when the row unmounts.
// One fetch per photo, however many rows show it: every size of a shoe shows the same picture,
// and a run of twenty sizes used to fetch the full-size file twenty times at once, which is how
// a photo that was there could sit on "photo…" or fail until a refresh. A failure retries.
const shotUrls = new Map();
function shotUrl(cartId, fileId) {
  if (!shotUrls.has(fileId)) {
    const load = async () => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          const { blob } = await api.cartFileBlob(cartId, fileId, 'shoe');
          return URL.createObjectURL(blob);
        } catch (e) {
          if (e?.unauthorized || attempt >= 2) throw e;
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        }
      }
    };
    const p = load();
    shotUrls.set(fileId, p);
    p.catch(() => shotUrls.delete(fileId));   // so the next look tries again
  }
  return shotUrls.get(fileId);
}

function ShoeShots({ cart, sku, onSignOut }) {
  const shots = (cart.files || []).filter((f) => f.kind === 'shoe'
    && String(f.sku || '').toUpperCase() === String(sku || '').toUpperCase());
  const [url, setUrl] = useState('');
  // Three states, not two. A fetch that fails has to STOP saying "loading" — a spinner
  // that never resolves reads as a slow network, so nobody reports it and the approver
  // quietly decides without the one thing on the request that shows the shoe.
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const first = shots[0];

  useEffect(() => {
    let dead = false;
    setUrl(''); setFailed(false);
    if (!first) return undefined;
    shotUrl(cart.id, first.id)
      .then((u) => { if (!dead) setUrl(u); })
      .catch((e) => {
        if (e?.unauthorized) return onSignOut?.();
        if (!dead) setFailed(true);
      });
    return () => { dead = true; };
  }, [cart.id, first?.id]);

  if (!shots.length) return <span className="bc-shot-none">no photo</span>;
  return (
    <>
      {url
        ? <img className="bc-shot-thumb" src={url} alt={`${sku}`} onClick={(e) => { e.stopPropagation(); setOpen(true); }} />
        : <span className={`bc-shot-none${failed ? ' bc-shot-bad' : ''}`}>{failed ? 'photo failed' : 'photo…'}</span>}
      {open && url && (
        <div className="bc-shot-lightbox" onClick={(e) => { e.stopPropagation(); setOpen(false); }}>
          <img src={url} alt={sku} />
          <span className="muted sm">{sku} · {shots.length} photo{shots.length === 1 ? '' : 's'} · tap to close</span>
        </div>
      )}
    </>
  );
}

// What we ALREADY hold of this shoe, in this size — the half of the picture the buy
// call never had. See `api/cart/stock.js` for why the basis is Shopify plus what is
// not yet listed, and why our own listed count is shown but not added.
// HOW FAST THIS SIZE SELLS on the market — Alias/GOAT recent sales, snapshotted when the
// pair was asked about (or last "Price it"). What StockX's Sales tab shows, which is what
// Alex asked to see on a request (floor feedback, 2026-11-02). Approver-only: the server
// strips `market_sales` from a buyer's copy with the rest of the call.
function SalesPanel({ ms, size }) {
  if (!ms) return null;
  const d = (n) => (n == null ? '—' : `$${Number(n).toFixed(0)}`);
  return (
    <div className="bc-stock bc-sales">
      <div className="bc-stock-top">
        <b className="bc-stock-n">{ms.sold_30d}{ms.capped ? '+' : ''}</b>
        <span>sold in the last 30 days in size <b>{size}</b> · <b>{ms.sold_7d}</b> this week</span>
      </div>
      {ms.sold_30d > 0 && (
        <p className="bc-stock-sum">Avg {d(ms.avg_30d)} · low {d(ms.low_30d)} · high {d(ms.high_30d)} (30 days)</p>
      )}
      {ms.last?.length > 0 && (
        <ul className="bc-sales-list">
          {ms.last.map((x, i) => (
            <li key={i}><b>{d(x.price)}</b><span className="muted">{PH_DATE.format(new Date(x.at))} · {estClock(x.at)} EST</span></li>
          ))}
        </ul>
      )}
      <p className="muted xs">
        Market sales on GOAT/Alias, new with a good box · read {estDate(ms.read_at)} {estClock(ms.read_at)} EST.
        StockX doesn’t share sales history; “Price it” re-reads this.
      </p>
    </div>
  );
}

function StockPanel({ s }) {
  if (!s || !s.checked) return null;
  const o = s.ours || {};
  const shopDown = s.shopify?.qty == null && s.basis !== 'no_size';
  return (
    <div className="bc-stock">
      <div className="bc-stock-top">
        <b className="bc-stock-n">
          {s.we_hold == null ? '—' : s.we_hold}
        </b>
        <span>
          {s.basis === 'no_size'
            ? <>already on hand across every size — <b>this line has no size</b>, so there is no per-size figure</>
            : <>already on hand in size <b>{s.size}</b></>}
        </span>
      </div>
      {s.basis === 'shopify_plus_unlisted' && (
        <p className="bc-stock-sum">
          {s.shopify.qty} listed on Shopify (every channel) + {o.not_listed} of ours it cannot see yet.
        </p>
      )}
      {s.basis === 'our_records_only' && (
        <p className="bc-stock-sum warn">
          {s.shopify?.unavailable || 'Shopify is unavailable'} — this is <b>our own records only</b>
          {' '}({o.listed_shopify} listed, {o.not_listed} not), which can lag a sale that has already happened.
        </p>
      )}
      {/* The three middle tags are all subsets of the not-listed half, not additions to
          it — a no-box pair is also an unlisted one. Written "of them" because the
          first draft listed "6 not listed yet · 6 held for pre-sell" side by side and
          read as twelve pairs. */}
      <div className="bc-stock-tags">
        {o.not_listed > 0 && <span>{o.not_listed} not listed yet</span>}
        {o.no_box > 0 && <span>{o.no_box} of them without a box</span>}
        {o.in_store_or_existing > 0 && <span>{o.in_store_or_existing} of them in-store / existing stock</span>}
        {o.pre_sell > 0 && <span>{o.pre_sell} of them held for pre-sell</span>}
        {/* Spoken for, and deliberately NOT in the count above. */}
        {o.pre_sold > 0 && <span className="warn">{o.pre_sold} already pre-sold — not counted</span>}
        {s.other_sizes > 0 && <span>{s.other_sizes} in other sizes</span>}
      </div>
      {/* Our records say listed, Shopify no longer shows them. Almost always a channel
          sale nobody has scanned out yet — a finding, not arithmetic to fold in. */}
      {s.unscanned_gap > 0 && (
        <p className="bc-stock-sum warn">
          We have {o.listed_shopify} marked as listed but Shopify shows {s.shopify.qty}
          {' '}— {s.unscanned_gap} likely sold and not yet scanned out.
        </p>
      )}
      {!shopDown && s.we_hold === 0 && o.pre_sold === 0 && (
        <p className="bc-stock-sum muted">None of this size anywhere — nothing here argues against buying it.</p>
      )}
      <p className="muted xs">
        Shopify’s figures and our own records — <b>not a physical count</b>. For a number
        to act on, ask the warehouse.
      </p>
    </div>
  );
}

// What became of a premium shoe's proposed tip, in one chip.
function TipChip({ line: l }) {
  const $ = (n) => `$${Number(n).toFixed(2)}`;
  // Premium with no tip proposed: the desk's call (a blank tip box on the form).
  if (l.tip_proposed == null) {
    if (l.tip_status === 'approved')
      return <span className="po-chip ok" title={l.tip_decided_by ? `Set by ${l.tip_decided_by}` : undefined}>Tip {$(l.tip_approved)}/pair set by the desk</span>;
    if (l.tip_status === 'declined')
      return <span className="po-chip muted" title={l.tip_decided_by ? `Decided by ${l.tip_decided_by}` : undefined}>No tip</span>;
    return <span className="po-chip muted">No tip proposed — desk decides</span>;
  }
  if (l.tip_status === 'approved') {
    const changed = l.tip_approved != null && Number(l.tip_approved) !== Number(l.tip_proposed);
    return <span className="po-chip ok" title={l.tip_decided_by ? `Approved by ${l.tip_decided_by}` : undefined}>
      Tip {$(l.tip_approved ?? l.tip_proposed)}/pair approved{changed ? ` (asked ${$(l.tip_proposed)})` : ''}</span>;
  }
  if (l.tip_status === 'declined')
    return <span className="po-chip bad" title={l.tip_decided_by ? `Declined by ${l.tip_decided_by}` : undefined}>Tip {$(l.tip_proposed)} declined</span>;
  return <span className="po-chip warn">Tip {$(l.tip_proposed)}/pair proposed</span>;
}

// The Telegram card's "Not in warehouse yet", in the card's own words. Staff only, because the
// count crosses every supplier. Read again whenever a decision on this request changes it.
function NotHere({ cart, onSignOut }) {
  const [shoes, setShoes] = useState(null);
  const [failed, setFailed] = useState(false);
  const decisions = (cart.lines || []).map((l) => `${l.id}:${l.status}:${l.qty}`).join(',');
  useEffect(() => {
    let live = true;
    api.cartNotHere(cart.id)
      .then((r) => { if (live) { setShoes(r.shoes || []); setFailed(false); } })
      .catch((e) => { if (e.unauthorized) return onSignOut(); if (live) setFailed(true); });
    return () => { live = false; };
  }, [cart.id, decisions]); // eslint-disable-line react-hooks/exhaustive-deps
  if (failed) return <p className="muted sm bc-not-here">Not in warehouse yet: could not be read.</p>;
  if (!shoes) return null;
  const coming = shoes.filter((s) => !s.summary || s.summary.total > 0);
  if (!coming.length) return <p className="muted sm bc-not-here">Not in warehouse yet: none.</p>;
  return (
    <div className="bc-not-here">
      {coming.map((s) => (
        <div key={s.sku} className="bc-not-here-shoe">
          <div className="bc-not-here-sku">{s.name ? `${s.name} · ` : ''}{s.sku}</div>
          {notHereLines(s.summary).map((line, i) => (
            <div key={line} className={i === 0 ? 'bc-not-here-total' : 'muted xs'}>{line}</div>
          ))}
        </div>
      ))}
    </div>
  );
}

function Lines({ cart, canDecide, canTip = false, whyNoDecide, canEditLines, canPrice, isBuyer, autoStock, onChanged, onSignOut }) {
  const [sel, setSel] = useState([]);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  // Not an error and not nothing: something about the last price that a person should
  // read once. Cleared by the next action.
  const [note, setNote] = useState('');
  // `null` = not asking. `{ all }` = asking why, for one line or for the lot.
  const [rejecting, setRejecting] = useState(null);
  // The line being corrected, if any. A misread shelf ticket is the common case and it
  // used to mean pulling the whole request back to fix one number.
  const [fixing, setFixing] = useState(null);
  // The decided line an approver is CHANGING their mind on (James: "indecisive"). Allowed
  // until the cards go out — the server already took overrides; the screen had no button.
  const [changing, setChanging] = useState(null);
  // Which line's working is open. One at a time: the panel is tall, and two of them open
  // is a table you have to scroll to compare two rows of.
  const [open, setOpen] = useState(null);
  // What we already hold, per line. `null` until somebody asks — this reads Shopify,
  // so it is a deliberate press and not something every cart open pays for.
  const [stock, setStock] = useState(null);
  const [stockNote, setStockNote] = useState('');
  // HOW MANY to buy, per line, typed by the approver. The buyer never stated one — they
  // reported what they found — so this starts empty and approving without it is refused
  // by name rather than defaulted to a number nobody chose.
  const [qty, setQty] = useState({});
  const [addingMore, setAddingMore] = useState(null);
  // Is this quantity above what the buyer counted on the shelf? Only ever true when they
  // ACTUALLY counted — a blank `available_qty` means "didn't count", and treating that as
  // zero would flag every uncounted line as an over-approval.
  const overAvail = (l, n) => {
    const want = Number(n);
    return l?.available_qty != null && Number.isFinite(want) && want > l.available_qty;
  };
  const setQtyFor = (id, v) => setQty((q) => ({ ...q, [id]: v }));
  // Approved on top, then pending, then turned down / not buying (`linesByDecision`).
  const lines = linesByDecision(cart.lines);
  const pending = lines.filter((l) => l.status === 'pending');
  // ONCE THE BUYER CLOSES THE LIST the lines split into three groups under headings, each
  // one opens and shuts on a tap (owner, 2026-11-10). What's turned down or not being
  // bought starts SHUT: the list is final and those rows are just noise by then. Approved
  // and still-waiting start open, because those are what somebody still acts on (the
  // buyer buys the approved ones, the approver answers the waiting ones). While the list
  // is open it stays one plain list, because the buyer is still adding to it.
  const grouped = !!cart.list_closed_at && lines.length > 0;
  const [shut, setShut] = useState({ approved: false, pending: false, out: true });
  const toggleGroup = (g) => setShut((s) => ({ ...s, [g]: !s[g] }));
  // The buyer's ✎ only ever made sense on a draft — after the first add the pair is in
  // front of the desk with its price written into a Telegram card, and a price that is
  // wrong after asking is a remove-and-re-add, not an edit.
  const editable = isBuyer && cart.status === 'draft';
  // …and after sending (Andrew, 2026-11-02): the buyer fixes their OWN pair while it is
  // still PENDING — size, shelf price, count, full box, premium + tip. The pair is re-posted
  // to the group with what changed. Never the quantity; never once it's been answered.
  const buyerEdit = (l) => isBuyer && l.status === 'pending' && LIST_ADDABLE.includes(cart.status);
  // The × is per LINE: a pending pair the buyer has not had an answer on is theirs to
  // withdraw while their list is open. A decided one is part of an approval.
  const canRemove = (l) => l.status === 'pending' && (
    (isBuyer && buyerCanAdd(cart)) || (!isBuyer && canEditLines));
  // NOT BUYING IT ("X out", Andrew): an APPROVED pair the buyer isn't grabbing, so the cards
  // aren't sized for it — before any card is recorded (gc_total counts only live cards).
  const beforeCards = ['submitted', 'approved', 'denied'].includes(cart.status) && !(Number(cart.gc_total) > 0);
  const canSkip = (l) => beforeCards && (isBuyer || canEditLines) && l.status === 'approved';
  const canUnskip = (l) => beforeCards && (isBuyer || canEditLines) && l.status === 'skipped';
  // CHANGE A DECISION already made — until the cards go out (`decisionsPendingOnly` from
  // `funded`). A skipped pair is the buyer's call, not ours, so it has no Change.
  const canChange = (l) => canDecide && !decisionsPendingOnly(cart.status) && ['approved', 'rejected'].includes(l.status);
  // FOUND MORE after sending it, while the list is open: more of this size (an unanswered or
  // approved pair), or ANOTHER size of the same shoe from any row (Andrew, 2026-11-10), so a
  // turned-down or X'd-out row offers it too, with the size box left for them to fill.
  const canAddMore = (l) => isBuyer && buyerCanAdd(cart);
  const sameSizeOk = (l) => ['pending', 'approved'].includes(l.status);
  const canFix = editable || canEditLines || lines.some(canRemove) || lines.some(buyerEdit)
    || lines.some(canSkip) || lines.some(canUnskip) || lines.some(canAddMore);
  // Kept in one place: the detail row has to span exactly the header, and a colSpan that
  // drifts from the columns leaves a ragged edge nobody notices in review.
  // A buyer has no "Buy call" column — the call is the approver's (`canSeeBuyCall` on
  // the server, which also strips it from the payload, so there is nothing to draw).
  const cols = (isBuyer ? 5 : 7) + (canDecide && pending.length > 0 ? 1 : 0) + (canFix ? 1 : 0);
  // A row only opens onto something. For staff that is always the buy call; for a buyer
  // it is the stock panel, which does not exist until they ask for it — and a row that
  // expands into an empty box reads as a bug.
  const canExpand = (id) => !isBuyer || !!stock?.[id]?.checked;

  const toggle = (id) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  // Turning something down always asks why; approving does not. The reason travels to
  // the buyer, who is standing in the shop deciding what to do next.
  function decide(action, all) {
    if (action === 'reject') return setRejecting({ all });
    return commit(action, all, null);
  }

  async function commit(action, all, reason) {
    setBusy(action); setErr('');
    // What was typed, and 1 where an approved line's box was left empty (approvers' feedback,
    // 2026-11-06; the box shows the 1). Stated here, so the server still refuses a call that
    // names no number at all.
    const qtyMap = {};
    if (action === 'approve') {
      for (const l of all ? pending : lines.filter((x) => sel.includes(Number(x.id)))) {
        if (!(Number(l.qty) > 0)) qtyMap[Number(l.id)] = 1;
      }
    }
    for (const [id, v] of Object.entries(qty)) {
      const n = Number(v);
      if (Number.isInteger(n) && n > 0) qtyMap[id] = n;
    }
    try {
      await api.cartDecide(cart.id, all
        ? { action, all: true, reason, qty: qtyMap }
        : { action, lineIds: sel, reason, qty: qtyMap });
      setSel([]); setRejecting(null); setQty({}); onChanged();
    } catch (e) { if (e.unauthorized) return onSignOut(); setErr(e.message); }
    finally { setBusy(''); }
  }

  async function remove(id) {
    setBusy('rm'); setErr('');
    try { await api.cartRemoveLine(cart.id, id); onChanged(); }
    catch (e) { if (e.unauthorized) return onSignOut(); setErr(e.message); }
    finally { setBusy(''); }
  }

  // Re-read the market for one pair. Explicit and named — see api/cart/price-line.js.
  async function price(id) {
    setBusy(`px${id}`); setErr(''); setNote('');
    try {
      const r = await api.cartPriceLine(cart.id, id);
      // A successful call that found nothing is not an error, and it must not read as
      // one — but it does have to say so, or the button looks broken.
      if (r.priced === false) setErr(r.error || 'No market price for that size right now.');
      // StockX had no product carrying this style code and was matched on the name
      // instead. Worth saying once, out loud: it is usually the right shoe in another
      // colourway, and occasionally it is not the shoe at all.
      else if (r.market?.stockxInexact && r.market?.stockx != null) {
        setNote(`StockX had no product with the style code ${cart.lines.find((l) => Number(l.id) === id)?.sku || ''} — its ${r.market.stockxTitle || 'closest match'} was used. The Alias price is the style-code one.`);
      }
      onChanged();
    } catch (e) { if (e.unauthorized) return onSignOut(); setErr(e.message); }
    finally { setBusy(''); }
  }

  // "How many of these do we already have?" — every line at once, because an approver
  // reading twelve lines wants to spot the one we are about to buy a third of, and
  // checking them one at a time is how that gets skipped.
  async function loadStock() {
    setBusy('stock'); setErr(''); setStockNote('');
    try {
      const r = await api.cartStock(cart.id);
      setStock(Object.fromEntries((r.lines || []).map((x) => [Number(x.lineId), x])));
      if (r.truncated) setStockNote(r.truncated);
    } catch (e) { if (e.unauthorized) return onSignOut(); setErr(e.message); }
    finally { setBusy(''); }
  }

  // The desk does not have to ASK what we already hold — it loads with the request.
  //
  // This was a deliberate press because it calls Shopify, and that was the wrong call:
  // the one moment the figure decides anything is while somebody is looking at pending
  // lines, and a number you have to go and fetch is one that gets skipped on the busy
  // days when over-buying actually happens. It stays a press for a buyer (they are not
  // the one deciding) and for a settled request (nothing left to judge).
  //
  // Bounded: once per opened request, Shopify is cached ten minutes per style, and our
  // own half is one indexed query. `lines.length` is in the deps because the request
  // arrives before its lines do.
  useEffect(() => {
    if (!autoStock || stock || busy === 'stock' || !lines.length) return;
    loadStock();
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [autoStock, lines.length]);

  // A premium shoe's proposed tip — the whole SKU at once (api/cart/tip.js). `tipping` holds
  // the line whose "Other amount" form is open.
  const [tipping, setTipping] = useState(null);
  async function tipAnswer(l, action, amount = null) {
    setBusy(`tip${l.id}`); setErr('');
    try { await api.cartTip(cart.id, l.sku, action, amount); setTipping(null); onChanged(); }
    catch (e) { if (e.unauthorized) return onSignOut(); setErr(e.message); }
    finally { setBusy(''); }
  }
  // The tip's buttons sit on the FIRST size of the shoe only — it's one answer for the run.
  const firstTipLine = new Map();
  for (const l of lines) if ((l.tip_status != null || l.premium) && !firstTipLine.has(l.sku)) firstTipLine.set(l.sku, Number(l.id));

  // Not through `act`-style error swallowing: FormModal keeps the typed values when the
  // server refuses, which is the whole reason these stopped being window.prompts.
  async function fix({ size, qty, shelfPrice, availableQty, fullBox, premium, tip }) {
    const base = {
      size: String(size ?? '').trim() || null,
      shelfPrice: String(shelfPrice ?? '').trim() === '' ? null : Number(shelfPrice),
      fullBox: fullBox === 'yes',
    };
    await api.cartEditLine(cart.id, fixing.id, isBuyer
      ? {
        ...base,
        // Blank = "didn't count" — sent as '' so the server clears it rather than keeps it.
        availableQty: String(availableQty ?? '').trim() === '' ? '' : Number(availableQty),
        premium: premium === 'yes',
        tipProposed: premium === 'yes' ? String(tip ?? '').trim() : '',
      }
      : { ...base, qty: Number(qty) || fixing.qty });
    setFixing(null); onChanged();
  }

  async function skip(l, on) {
    setBusy(`sk${l.id}`); setErr('');
    // X-ing a pair out moves it into the "Turned down or not buying" group, so that group is
    // opened: the pair, and its Undo, must not disappear from under the buyer's thumb.
    try { await api.cartSkipLine(cart.id, l.id, on); if (on) setShut((s) => ({ ...s, out: false })); onChanged(); }
    catch (e) { if (e.unauthorized) return onSignOut(); setErr(e.message); }
    finally { setBusy(''); }
  }

  // One line, re-decided. Turning down still asks why — the buyer reads it in the shop.
  async function change({ decision, qty: n, reason }) {
    const id = Number(changing.id);
    if (decision === 'reject' && !String(reason ?? '').trim()) throw new Error('Say why it’s turned down — the buyer reads it.');
    await api.cartDecide(cart.id, decision === 'approve'
      ? { action: 'approve', lineIds: [id], qty: { [id]: Number(n) > 0 ? Number(n) : 1 }, reason: String(reason ?? '').trim() || null }
      : { action: 'reject', lineIds: [id], reason: String(reason).trim() });
    setChanging(null); onChanged();
  }

  return (
    <section className="card bc-lines">
      {rejecting && (
        <FormModal
          title={rejecting.all ? 'Turn down every pending line' : `Turn down ${sel.length} line${sel.length === 1 ? '' : 's'}`}
          message="The buyer reads this in the shop, so say what would change your mind."
          submitLabel="Turn it down" danger
          onClose={() => setRejecting(null)}
          onSubmit={({ reason }) => commit('reject', rejecting.all, reason.trim())}
          fields={[{ name: 'reason', label: 'Why?', type: 'textarea', required: true,
            placeholder: 'e.g. Too close to retail — only worth it under $95' }]} />
      )}
      {addingMore && (
        <FormModal
          title={`Found more of ${addingMore.sku}`}
          message={sameSizeOk(addingMore)
            ? (addingMore.status === 'approved'
              ? `Size ${addingMore.size} is approved ×${addingMore.qty}, and that stays. Change the size if you found a different one. The desk gets a new card either way.`
              : 'Keep the size to raise this pair’s count, or change it if you found a different size. The desk gets a new card.')
            : `Size ${addingMore.size} was ${addingMore.status === 'skipped' ? 'marked as not buying' : 'turned down'}. Enter the other size you found. The desk gets a new card.`}
          submitLabel="Send to the desk"
          onClose={() => setAddingMore(null)}
          onSubmit={({ size, more, shelfPrice }) => {
            const s = String(size ?? '').trim();
            const other = s && s.toUpperCase().replace(/\s+/g, '') !== String(addingMore.size ?? '').toUpperCase().replace(/\s+/g, '');
            return api.cartMoreOfLine(cart.id, addingMore.id, Number(more), other
              ? { size: s, ...(String(shelfPrice ?? '').trim() !== '' && Number(shelfPrice) !== Number(addingMore.shelf_price) ? { shelfPrice: Number(shelfPrice) } : {}) }
              : {}).then(() => { setAddingMore(null); onChanged(); });
          }}
          fields={[
            { name: 'size', label: 'Size', required: true, maxLength: 20,
              value: sameSizeOk(addingMore) ? (addingMore.size || '') : '', placeholder: 'e.g. 10.5' },
            { name: 'more', label: 'How many did you find?', type: 'number', min: 1, max: 999, required: true },
            { name: 'shelfPrice', label: 'Price on the shelf', type: 'number', step: '0.01', min: 0,
              value: addingMore.shelf_price == null ? '' : String(addingMore.shelf_price),
              hint: 'Only used for a size that isn’t on the request yet. Change it if that size is priced differently.' },
          ]} />
      )}
      {tipping && (
        <FormModal
          title={`Tip for ${tipping.sku}`}
          message={tipping.tip_proposed == null
            ? `${cart.buyer_name || 'The supplier'} proposed no tip for this premium shoe. Set one per pair — it applies to every size of this shoe and goes into what each pair costs.`
            : `${cart.buyer_name || 'The supplier'} proposed $${Number(tipping.tip_proposed).toFixed(2)} a pair. Approve a different amount — it applies to every size of this shoe.`}
          submitLabel={tipping.tip_proposed == null ? 'Set this tip' : 'Approve this tip'}
          onClose={() => setTipping(null)}
          onSubmit={({ amount }) => api.cartTip(cart.id, tipping.sku, 'approve', Number(amount)).then(() => { setTipping(null); onChanged(); })}
          fields={[{ name: 'amount', label: 'Tip per pair ($)', type: 'number', step: '0.01', min: 0.01, required: true }]} />
      )}
      {changing && (
        <FormModal
          title={`Change the decision on ${changing.sku}${changing.size ? ` size ${changing.size}` : ''}`}
          message={`Now: ${changing.status === 'approved' ? `approved ×${changing.qty}` : 'turned down'}${changing.decided_by ? ` by ${changing.decided_by}` : ''}. The change is recorded under your name and the earlier decision stays on the row.`}
          submitLabel="Change it"
          onClose={() => setChanging(null)}
          onSubmit={change}
          fields={[
            { name: 'decision', label: 'Decision', type: 'select',
              value: changing.status === 'approved' ? 'reject' : 'approve',
              options: [{ value: 'approve', label: 'Approve' }, { value: 'reject', label: 'Turn it down' }] },
            { name: 'qty', label: 'How many to buy (if approving)', type: 'number', min: 1, max: 999, hint: 'Blank = 1.',
              value: changing.qty != null ? String(changing.qty) : (changing.overrode_qty != null ? String(changing.overrode_qty) : '') },
            { name: 'reason', label: 'Why? (needed to turn it down)', type: 'textarea',
              placeholder: 'e.g. Market dropped — only worth it under $95' },
          ]} />
      )}
      {fixing && (
        <FormModal
          title={`Correct ${fixing.sku}${fixing.size ? ` size ${fixing.size}` : ''}`}
          message={isBuyer
            ? (cart.status === 'draft'
              ? 'Fix what you typed.'
              : 'Fix what you sent. The desk gets the pair again with what you changed — it hasn’t been answered yet.')
            : 'The buyer read the ticket in a shop. Correcting it here re-prices the line and the change is recorded against your name.'}
          submitLabel="Save the correction"
          onClose={() => setFixing(null)}
          onSubmit={fix}
          fields={[
            { name: 'size', label: 'Size', value: fixing.size || '', maxLength: 20 },
            // The quantity is the approver's answer — never on the buyer's form.
            ...(isBuyer ? [] : [{ name: 'qty', label: 'Pairs', type: 'number', value: String(fixing.qty ?? 1), min: 1, max: 999, required: true }]),
            { name: 'shelfPrice', label: 'Price on the shelf', type: 'number', step: '0.01',
              value: fixing.shelf_price == null ? '' : String(fixing.shelf_price), min: 0, required: true,
              hint: 'What the sticker says, before any discount — it is what the gift cards have to cover.' },
            ...(isBuyer ? [{ name: 'availableQty', label: 'How many in the shop', type: 'number', min: 1, max: 999,
              value: fixing.available_qty == null ? '' : String(fixing.available_qty), hint: 'Blank = you didn’t count.' }] : []),
            { name: 'fullBox', label: 'Full box?', type: 'select', value: fixing.full_box ? 'yes' : 'no',
              options: [{ value: 'no', label: 'Not said' }, { value: 'yes', label: 'Yes — its own box, complete' }] },
            ...(isBuyer ? [
              { name: 'premium', label: 'Premium shoe?', type: 'select', value: fixing.premium ? 'yes' : 'no',
                options: [{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes' }] },
              { name: 'tip', label: 'Tip per pair (premium only)', type: 'number', step: '0.01', min: 0,
                value: fixing.tip_proposed == null ? '' : String(fixing.tip_proposed),
                hint: 'Blank = no tip proposed; the desk decides.' },
            ] : []),
          ]} />
      )}
      {/* The heading and its one action on one line. `.bc-h` is left alone deliberately:
          it is a plain heading in ten other places, and turning it into a flex row to
          seat a button here would re-space every one of them. */}
      <div className="bc-h-row">
        <h3 className="bc-h">
          What’s being asked for <span className="muted sm">{lines.length} line{lines.length === 1 ? '' : 's'}</span>
        </h3>
        {lines.length > 0 && (
          <button type="button" className={`btn sm ${stock ? 'ghost' : ''}`} disabled={busy === 'stock'}
            onClick={loadStock}
            title="Shopify’s live figure for what we have listed, plus our own pairs it cannot see yet">
            {busy === 'stock' ? 'Reading stock…' : stock ? 'Recheck what we hold' : 'What do we already hold?'}
          </button>
        )}
      </div>
      {!lines.length && <p className="muted sm">Nothing on the request yet.</p>}
      {!isBuyer && lines.length > 0 && <NotHere cart={cart} onSignOut={onSignOut} />}
      {lines.length > 0 && (
        <div className="bc-scroll">
          <table className="table bc-table">
            <thead>
              <tr>
                {canDecide && pending.length > 0 && <th className="bc-w-sm" />}
                <th>Shoe</th><th>Size</th><th className="num">Qty</th><th className="num">Shelf</th>
                {/* Two columns, not one. Unstyled they ran together and read as a single
                    "Call Status" heading, so a blank buy call looked like a request whose
                    STATUS was the word Pending sitting in the wrong place. */}
                {!isBuyer && <th className="num">Cost / unit</th>}
                {!isBuyer && <th>Buy call</th>}
                <th>Approval</th>{canFix && <th />}
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                const id = Number(l.id);
                const shown = open === id;
                const g = lineGroup(l);
                const head = grouped && (i === 0 || lineGroup(lines[i - 1]) !== g);
                if (grouped && shut[g]) {
                  return head ? <GroupRow key={`g-${g}`} group={g} lines={lines} cols={cols} shut onToggle={() => toggleGroup(g)} /> : null;
                }
                return (
                <React.Fragment key={l.id}>
                {head && <GroupRow group={g} lines={lines} cols={cols} shut={false} onToggle={() => toggleGroup(g)} />}
                <tr className={`bc-line ${l.status}${shown ? ' open' : ''}`}
                  onClick={() => canExpand(id) && setOpen(shown ? null : id)}
                  tabIndex={canExpand(id) ? 0 : -1}
                  aria-expanded={canExpand(id) ? shown : undefined}
                  onKeyDown={(e) => {
                    if (!canExpand(id)) return;
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(shown ? null : id); }
                  }}>
                  {canDecide && pending.length > 0 && (
                    // Ticking a line to approve it must not also open its working.
                    <td onClick={(e) => e.stopPropagation()}>{l.status === 'pending' && (
                      <input type="checkbox" checked={sel.includes(id)}
                        onChange={() => toggle(id)} aria-label={`Select ${l.sku}`} />
                    )}</td>
                  )}
                  <td className="bc-td-shoe">
                    <b>{l.sku}</b>
                    {l.name && <div className="muted xs">{l.name}</div>}
                    {(l.premium || l.tip_status) && (
                      <div className="bc-premium-tag" onClick={(e) => e.stopPropagation()}>
                        <span className="po-chip warn">Premium</span>
                        <TipChip line={l} />
                        {canTip && l.tip_status === 'proposed' && firstTipLine.get(l.sku) === Number(l.id) && (
                          <span className="bc-tip-actions">
                            <button type="button" className="btn sm primary" disabled={!!busy}
                              onClick={() => tipAnswer(l, 'approve')}>Approve tip</button>
                            <button type="button" className="btn sm ghost" disabled={!!busy}
                              onClick={() => setTipping(l)}>Other amount</button>
                            <button type="button" className="btn sm ghost" disabled={!!busy}
                              onClick={() => tipAnswer(l, 'decline')}>Decline</button>
                          </span>
                        )}
                        {canTip && l.premium && l.tip_proposed == null && firstTipLine.get(l.sku) === Number(l.id) && (
                          <span className="bc-tip-actions">
                            <button type="button" className="btn sm ghost" disabled={!!busy}
                              onClick={() => setTipping(l)}>{l.tip_status === 'approved' ? 'Change the tip' : 'Set a tip'}</button>
                          </span>
                        )}
                      </div>
                    )}
                    {l.full_box && <div className="bc-premium-tag"><span className="po-chip">Full box</span></div>}
                    <ShoeShots cart={cart} sku={l.sku} onSignOut={onSignOut} />
                    {/* Amber only when we already hold at least as many as are being
                        asked for. Any-stock-is-amber made a single spare pair look like
                        a reason to stop; this rule is the one that actually is. */}
                    {stock?.[id]?.checked && (
                      <span className={`bc-hold${stock[id].we_hold >= l.qty && stock[id].we_hold > 0 ? ' warn' : ''}`}>
                        {stock[id].we_hold == null
                          ? `${stock[id].style_on_hand} on hand (no size on this line)`
                          : stock[id].we_hold === 0 ? 'none on hand' : `${stock[id].we_hold} on hand`}
                      </span>
                    )}
                    {/* Past the 25-SKU cap the line was never looked up. Say so on the
                        line itself — a missing tag reads as "nothing to report". */}
                    {stock?.[id] && !stock[id].checked && (
                      <span className="bc-hold" title="This SKU was past the first 25 on the request, so Shopify was not asked">on hand not checked</span>
                    )}
                  </td>
                  <td data-label="Size">
                    {l.size || '—'}
                    {/* What the BUYER counted on the shelf. Sits under the size because
                        it is a fact about this size, and because the quantity box beside
                        it is the decision it informs. Absent means they didn't count —
                        printed as nothing rather than as a 0, which would read as "the
                        shop has none" and argue against a purchase nobody argued against. */}
                    {l.available_qty != null && (
                      <div className="muted xs bc-avail">{l.available_qty} in store</div>
                    )}
                  </td>
                  {/* HOW MANY. Empty on a line nobody has decided yet, because the buyer
                      never said — an approver types it here and approving carries it.
                      A decided line prints the number that was approved. */}
                  <td className="num" data-label="Qty" onClick={(e) => e.stopPropagation()}>
                    {canDecide && l.status === 'pending' ? (
                      <>
                        <input className={`input bc-qty-in${overAvail(l, qty[id]) ? ' over' : ''}`}
                          type="number" min="1" max="999"
                          inputMode="numeric" placeholder="1"
                          aria-label={`How many ${l.sku}${l.size ? ` size ${l.size}` : ''} to buy`}
                          value={qty[id] ?? ''}
                          onChange={(e) => setQtyFor(id, e.target.value)} />
                        {/* Warned, never blocked. Stock moves between the buyer walking
                            the aisle and the desk deciding, and refusing here would
                            strand a legitimate "take more if they restock". But the
                            funding target is shelf × qty, so approving above the count
                            funds pairs that may not exist — it has to be visible. */}
                        {overAvail(l, qty[id]) && (
                          <div className="bc-over-avail">more than the {l.available_qty} counted</div>
                        )}
                      </>
                    ) : (
                      <>
                        {l.qty ?? <span className="muted xs">—</span>}
                        {overAvail(l, l.qty) && (
                          <div className="bc-over-avail">over the {l.available_qty} counted</div>
                        )}
                      </>
                    )}
                  </td>
                  <td className="num" data-label="Shelf">{money(l.shelf_price)}</td>
                  {!isBuyer && <td className="num" data-label="Cost">{money(l.final_cost)}</td>}
                  {/* The call and its working together — the profit and ROI used to sit
                      under the cost column, a column away from the verdict they justify.
                      No verdict means nobody priced it, which is a different answer from
                      "we priced it and it's a Pass". */}
                  {!isBuyer && (
                    <td className="bc-call-cell" data-label="Call">
                      {l.verdict ? <VerdictChip verdict={l.verdict} />
                        : <span className="muted xs">Not priced</span>}
                      {l.profit != null ? (
                        <div className="muted xs">
                          {money(l.profit)} · {Number(l.roi).toFixed(1)}% via {platform(l.best_platform)}
                        </div>
                      ) : (
                        <div className="muted xs">{shown ? 'why ▴' : 'why ▾'}</div>
                      )}
                      {l.market_sales && (
                        <div className="muted xs bc-sales-mini" title="Market sales on GOAT/Alias for this size — open the row for the list">
                          {l.market_sales.sold_30d}{l.market_sales.capped ? '+' : ''} sold/30d
                          {l.market_sales.avg_30d != null ? ` · avg $${Number(l.market_sales.avg_30d).toFixed(0)}` : ''}
                        </div>
                      )}
                    </td>
                  )}
                  <td className="bc-td-status">
                    <span className={`bc-line-status ${l.status}`}>{l.status === 'skipped' ? 'not buying' : l.status}</span>
                    {l.status === 'skipped'
                      ? <div className="muted xs">{l.skipped_by || 'the buyer'} X’d it out · was approved{l.qty ? ` ×${l.qty}` : ''}{l.decided_by ? ` by ${l.decided_by}` : ''}</div>
                      : l.decided_by && <div className="muted xs">{l.decided_by}</div>}
                    {/* One approver reversing another's call is a real thing here, and
                        the last write must not be able to present itself as the only
                        one. Both names, in the order they happened. */}
                    {l.overrode_by && (
                      <div className="bc-override xs">
                        {l.overrode_by} said {l.overrode_status}
                        {l.overrode_qty ? ` ×${l.overrode_qty}` : ''} — overridden
                      </div>
                    )}
                    {l.decided_reason && <div className="muted xs">{l.decided_reason}</div>}
                    {canChange(l) && (
                      <button type="button" className="btn sm ghost bc-change" disabled={!!busy}
                        onClick={(e) => { e.stopPropagation(); setChanging(l); }}
                        title="Approve or turn it down instead — allowed until the gift cards go out">Change</button>
                    )}
                  </td>
                  {canFix && (
                    <td className="bc-line-actions" onClick={(e) => e.stopPropagation()}>
                      {(editable || canEditLines || buyerEdit(l)) && (
                        <button type="button" className="btn sm ghost" onClick={() => setFixing(l)}
                          aria-label={`Correct ${l.sku}`} title={isBuyer ? 'Fix the size, price, count, full box or premium' : 'Correct the size, quantity or shelf price'}>✎</button>
                      )}
                      {canAddMore(l) && (
                        <button type="button" className="btn sm ghost" onClick={() => setAddingMore(l)}
                          aria-label={`Found more of ${l.sku}${l.size ? ` size ${l.size}` : ''}`}
                          title="Found more of this shoe in the shop, in this size or another one. Asks the desk about the extra pairs">＋ Found more</button>
                      )}
                      {canSkip(l) && (
                        <button type="button" className="btn sm ghost bc-skip" disabled={busy === `sk${l.id}`}
                          onClick={() => skip(l, true)} aria-label={`Not buying ${l.sku}${l.size ? ` size ${l.size}` : ''}`}
                          title="Not grabbing this pair — takes it off what the gift cards cover">✕ Not buying</button>
                      )}
                      {canUnskip(l) && (
                        <button type="button" className="btn sm ghost" disabled={busy === `sk${l.id}`}
                          onClick={() => skip(l, false)} title="Buying it after all — back to approved">Undo</button>
                      )}
                      {canRemove(l) && (
                        <button type="button" className="btn sm ghost" disabled={busy === 'rm'}
                          onClick={() => remove(l.id)} aria-label={`Remove ${l.sku}`}
                          title="Withdraw this pair — nobody has decided on it yet">×</button>
                      )}
                    </td>
                  )}
                </tr>
                {shown && canExpand(id) && (
                  <tr className="bc-line-detail">
                    <td colSpan={cols} onClick={(e) => e.stopPropagation()}>
                      {!isBuyer && (
                        <LineCall line={l} stack={cart.cost_stack || {}} canPrice={canPrice}
                          busy={busy === `px${id}`} onPrice={() => price(id)} />
                      )}
                      {!isBuyer && <SalesPanel ms={l.market_sales} size={l.size} />}
                      <StockPanel s={stock?.[id]} />
                    </td>
                  </tr>
                )}
                </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Says which of the two it is: "wait" and "too late" are not interchangeable,
          and an approver told the wrong one goes and does the wrong thing about it. */}
      {whyNoDecide && pending.length > 0 && (
        <p className="muted sm bc-no-decide">{whyNoDecide}</p>
      )}

      {canDecide && pending.length > 0 && (
        <div className="bc-decide">
          <span className="muted sm">{pending.length} awaiting a decision{sel.length ? ` · ${sel.length} selected` : ''}</span>
          <button type="button" className="btn primary" disabled={!sel.length || busy} onClick={() => decide('approve', false)}>Approve selected</button>
          <button type="button" className="btn ghost" disabled={!sel.length || busy} onClick={() => decide('reject', false)}>Turn down selected</button>
          <button type="button" className="btn" disabled={busy} onClick={() => decide('approve', true)}>Approve all {pending.length}</button>
          <button type="button" className="btn ghost" disabled={busy} onClick={() => decide('reject', true)}>Turn down all</button>
        </div>
      )}
      {err && <div className="error mt">{err}</div>}
      {note && <p className="bc-till-warn mt">{note}</p>}
      {stockNote && <p className="bc-till-warn mt">{stockNote}</p>}
    </section>
  );
}

// Step 7. Each card's own spend and what is left on it — not one blended figure, because
// "the company can account for the funds" means per card, not on average.
function Audit({ cart, onChanged, onSignOut }) {
  const cards = (cart.giftCards || []).filter((c) => !c.voided_at);
  const [vals, setVals] = useState(() => Object.fromEntries(cards.map((c) => [c.id, {
    spent: c.spent_amount != null ? String(c.spent_amount) : '',
    remaining: c.remaining != null ? String(c.remaining) : '',
  }])));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newCard, setNewCard] = useState({ code: '', spent: '', remark: '', personal: true });
  const [note, setNote] = useState('');
  const notes = (cart.events || []).filter((e) => e.kind === 'audit_note');

  // A card added since this panel opened has no typed figures yet, so it shows what's on file.
  const valOf = (c, k) => {
    const typed = vals[c.id]?.[k];
    if (typed !== undefined) return typed;
    const v = k === 'spent' ? c.spent_amount : c.remaining;
    return v != null ? String(v) : '';
  };
  const spentSum = cards.reduce((n, c) => n + (Number(valOf(c, 'spent')) || 0), 0);
  const personalSum = cards.filter((c) => c.personal).reduce((n, c) => n + (Number(valOf(c, 'spent')) || 0), 0);
  // No total is not a $0 receipt: blank cards against it used to read "balanced".
  const notRead = cart.receipt_total == null;
  const { target, usesPrinted } = auditTarget(cart);
  const receipt = Number(target) || 0;
  const gap = Math.round((spentSum - receipt) * 100) / 100;

  const set = (id, k, v) => setVals((s) => ({ ...s, [id]: { ...s[id], [k]: v } }));

  async function addCard(e) {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      await api.cartAuditAddCard(cart.id, { ...newCard, spent: Number(newCard.spent) });
      setNewCard({ code: '', spent: '', remark: '', personal: true });
      setAdding(false);
      onChanged();
    } catch (ex) { if (ex.unauthorized) return onSignOut(); setErr(ex.message); }
    finally { setBusy(false); }
  }
  async function removeCard(c) {
    setBusy(true); setErr('');
    try { await api.cartAuditRemoveCard(cart.id, Number(c.id)); onChanged(); }
    catch (ex) { if (ex.unauthorized) return onSignOut(); setErr(ex.message); }
    finally { setBusy(false); }
  }
  async function addNote(e) {
    e.preventDefault();
    setBusy(true); setErr('');
    try { await api.cartAuditNote(cart.id, note.trim()); setNote(''); onChanged(); }
    catch (ex) { if (ex.unauthorized) return onSignOut(); setErr(ex.message); }
    finally { setBusy(false); }
  }

  async function save() {
    setBusy(true); setErr('');
    try {
      await api.cartAudit(cart.id, cards.map((c) => ({
        id: Number(c.id), spent: Number(valOf(c, 'spent')), remaining: Number(valOf(c, 'remaining')),
      })));
      setSaved(true);
      onChanged();
    } catch (e) { if (e.unauthorized) return onSignOut(); setSaved(false); setErr(e.message); }
    finally { setBusy(false); }
  }

  const recorded = !!cart.audited_at;
  // Cards the desk recorded after the receipt came in carry no spend yet — the audit on
  // file was made without them, so it has to be recorded again with them in it.
  const unaudited = recorded ? cards.filter((c) => c.spent_amount == null) : [];
  return (
    <section className="card bc-audit">
      <h3 className="bc-h">Financial audit</h3>
      <p className="muted sm">
        Cards issued {money(cart.gc_total)} → receipt {notRead ? 'not read in yet' : `${money(receipt)}${usesPrinted && cart.receipt_printed_total != null ? ' as printed' : ''}`}. Say what each card was
        actually spent and what is left sitting on it.
      </p>
      {/* SAYS IT WAS RECORDED. Pressing the button used to save and then re-render the
          same boxes with the same numbers — nothing on the panel moved, so it read as a
          dead button. The gap is a finding, not a blocker: it is recorded as stated, and
          the closing checklist below is what holds the request open over it. */}
      {recorded && (
        <p className="bc-audit-recorded">
          Recorded by <b>{cart.audited_by}</b> {estDate(cart.audited_at)} {estTime(cart.audited_at)} EST.
          {Math.abs(gap) > 0.01
            ? ` The ${money(Math.abs(gap))} gap stays on the record — see “Gift card spending was reconciled” in the checklist. Correct the figures and record again if a card was misread.`
            : ' The cards and the receipt agree.'}
        </p>
      )}
      {unaudited.length > 0 && (
        <p className="bc-till-warn">
          {unaudited.map((c) => `•••• ${c.code_last4}`).join(', ')} {unaudited.length === 1 ? 'was' : 'were'} recorded
          after this audit. Fill in what {unaudited.length === 1 ? 'it was' : 'they were'} spent and what is left, then record it again.
        </p>
      )}
      <ul className="bc-audit-list">
        {cards.map((c) => (
          <li key={c.id}>
            <span className="bc-gc-num">•••• {c.code_last4}</span>
            {c.personal && <span className="po-chip bc-personal">Personal</span>}
            <span className="muted sm">{c.remark ? c.remark : `${money(c.balance)} issued`}</span>
            {c.personal && <button type="button" className="btn sm ghost" disabled={busy} onClick={() => removeCard(c)}>Remove</button>}
            <label className="field"><span className="field-label">Spent</span>
              <PriceInput value={valOf(c, 'spent')} onChange={(e) => set(c.id, 'spent', e.target.value)} /></label>
            <label className="field"><span className="field-label">Left on it</span>
              <PriceInput value={valOf(c, 'remaining')} onChange={(e) => set(c.id, 'remaining', e.target.value)} /></label>
          </li>
        ))}
      </ul>
      {!adding && !notRead && (
        <button type="button" className="btn sm ghost bc-audit-add" onClick={() => setAdding(true)}>Add a card with a remark</button>
      )}
      {adding && (
        <form className="bc-audit-card-form" onSubmit={addCard}>
          <label className="field"><span className="field-label">Card number <span className="muted xs">· or its last 4</span></span>
            <input className="input" value={newCard.code} autoComplete="off" onChange={(e) => setNewCard((n) => ({ ...n, code: e.target.value }))} /></label>
          <label className="field"><span className="field-label">Paid at the till</span>
            <PriceInput value={newCard.spent} onChange={(e) => setNewCard((n) => ({ ...n, spent: e.target.value }))} /></label>
          <label className="field bc-audit-remark"><span className="field-label">Remark</span>
            <input className="input" value={newCard.remark} maxLength={300} placeholder={`e.g. ${cart.buyer_name || 'the buyer'}'s personal gift card`}
              onChange={(e) => setNewCard((n) => ({ ...n, remark: e.target.value }))} /></label>
          <label className="bc-check">
            <input type="checkbox" checked={newCard.personal} onChange={(e) => setNewCard((n) => ({ ...n, personal: e.target.checked }))} />
            <span>Personal card, not company money</span>
          </label>
          <span className="bc-audit-card-actions">
            <button type="submit" className="btn sm primary" disabled={busy || !newCard.code.trim() || !(Number(newCard.spent) > 0) || newCard.remark.trim().length < 3}>Add the card</button>
            <button type="button" className="btn sm ghost" onClick={() => setAdding(false)}>Cancel</button>
          </span>
        </form>
      )}
      {personalSum > 0 && !(cart.removedReceiptLines || []).length && (
        <p className="muted sm">The buyer’s own shoes are still on the receipt and the order. Take them off in the Receipt section so we don’t expect them.</p>
      )}
      <div className="bc-audit-foot">
        {notRead ? (
          <span className="bc-short">The receipt’s lines have not been saved, so there is no total to audit against. Read it in above first.</span>
        ) : (
          <span className={Math.abs(gap) > 0.01 ? 'bc-short' : 'bc-covered'}>
            Cards account for {money(spentSum)}{personalSum > 0 ? ` (${money(personalSum)} on personal cards)` : ''} against a {money(receipt)} receipt
            {Math.abs(gap) > 0.01 ? ` — a ${money(Math.abs(gap))} gap` : ' — balanced'}
          </span>
        )}
        <button type="button" className="btn primary" disabled={busy || notRead} onClick={save}>
          {busy ? 'Saving…' : recorded ? 'Record it again' : 'Record the audit'}
        </button>
      </div>
      {saved && !err && <p className="bc-audit-saved">Saved — the figures above are what is on the record now.</p>}
      {err && <div className="error mt">{err}</div>}

      <div className="bc-audit-notes">
        <h4 className="bc-h">Audit notes <span className="muted sm">· for the record, not shown to the buyer</span></h4>
        {notes.length > 0 && (
          <ul>
            {notes.map((n) => (
              <li key={n.id}>
                <div>{n.body}</div>
                <div className="muted xs">{n.actor_name || 'Someone'} · {estDate(n.created_at)} {estTime(n.created_at)} EST</div>
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={addNote}>
          <textarea className="input" rows={2} value={note} maxLength={2000} aria-label="Audit note" placeholder="What happened, and what was agreed"
            onChange={(e) => setNote(e.target.value)} />
          <button type="submit" className="btn sm" disabled={busy || note.trim().length < 3}>Add note</button>
        </form>
      </div>
    </section>
  );
}

function Thread({ cart, onChanged, onSignOut }) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const events = cart.events || [];

  async function post(e) {
    e.preventDefault();
    setBusy(true);
    try { await api.cartComment(cart.id, body); setBody(''); onChanged(); }
    catch (ex) { if (ex.unauthorized) return onSignOut(); }
    finally { setBusy(false); }
  }

  return (
    <section className="card bc-thread">
      <h3 className="bc-h">History</h3>
      <form className="bc-thread-add" onSubmit={post}>
        <input className="input" value={body} onChange={(e) => setBody(e.target.value)}
          placeholder="Ask the buyer what this is for, or leave a note…" />
        <button type="submit" className="btn" disabled={busy || !body.trim()}>Post</button>
      </form>
      <ul className="bc-events">
        {events.map((e) => (
          <li key={e.id} className={`bc-ev ${e.kind}`}>
            <span className="bc-ev-kind">{String(e.kind).replace(/_/g, ' ')}</span>
            <span className="bc-ev-who">{e.actor_name || 'system'}</span>
            {/* Rows written before the removal text was fixed carry a literal "×null" (a
                line with no quantity yet); they are history, so they are cleaned on the
                way out rather than rewritten. */}
            {e.body && <span className="bc-ev-body">{String(e.body).replace(/ ×null\b/g, '')}</span>}
            <span className="muted xs">{estDate(e.created_at)} {estTime(e.created_at)} EST</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// Whose turn it is, in one line at the top — see `nextStep`. When it is the viewer's,
// it is drawn as a call to action with a button that scrolls to where they act;
// otherwise it is a quiet "waiting on …" so nobody reads a pile as theirs.
function NextStep({ step }) {
  if (!step) return null;
  const go = () => {
    const el = step.target && document.getElementById(`bc-sec-${step.target}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  return (
    <div className={`bc-next${step.mine ? ' mine' : ''}`} role="status">
      <span className="bc-next-tag">{step.mine ? 'Your turn' : 'Next'}</span>
      <span className="bc-next-text">{step.text}</span>
      {step.action && step.target && (
        <button type="button" className={`btn sm ${step.mine ? 'primary' : 'ghost'}`} onClick={go}>{step.action}</button>
      )}
    </div>
  );
}

// Who a request is waiting on, first — the choice the Nudge form opens on. A buyer can't
// nudge themselves; everyone else may nudge the buyer.
function nudgeTargets(cart, isBuyer) {
  const all = {
    buyer: { to: 'buyer', label: `The buyer (${cart.buyer_name || 'buyer'})` },
    approvers: { to: 'approvers', label: 'The approvers' },
    desk: { to: 'desk', label: 'The gift card desk' },
    auditors: { to: 'auditors', label: 'The auditors' },
  };
  const order = cart.status === 'submitted' ? ['approvers', 'buyer', 'desk', 'auditors']
    : cart.status === 'approved' ? ['desk', 'buyer', 'approvers', 'auditors']
    : ['buyer', 'auditors', 'desk', 'approvers'];
  return order.filter((k) => !(isBuyer && k === 'buyer')).map((k) => all[k]);
}

export function BuyCart({ user, cartId, onBack, onSignOut }) {
  // Two questions that used to be native prompts: how many boxes the PO covers, and why
  // a request is being cancelled.
  const [asking, setAsking] = useState(null);
  const [cart, setCart] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');

  const role = user.role;
  const isBuyer = role === 'supplier';
  // What to DRAW, from the privileges the account holds. Never what is allowed — every
  // one of these actions is re-checked against the database on the way in, so a button
  // drawn off a stale list simply answers 403 rather than doing anything.
  // Holding the privilege is not the same as there being anything to decide. Drawing
  // the checkboxes and "Approve all" on a DRAFT gave an approver a full set of controls
  // whose only possible outcome was a refusal — the server has always said no, and the
  // screen was asking anyway. `decisionsOpen` is the endpoint's own predicate.
  const mayDecide = !isBuyer && hasPriv(user, 'approve_buying');
  const canDecide = mayDecide && decisionsOpen(cart?.status);
  const canIssue = !isBuyer && hasPriv(user, 'issue_gift_cards');
  const canAudit = !isBuyer && hasPriv(user, 'audit_buying');
  // The cost side is the BUYER'S first — they are the one in the shop who can read the
  // tax off the register — and either desk can then overwrite anything they typed. The
  // control is the trail, not the lock: every version is named in the history. Shelf
  // prices are the exception and still freeze once the cards are out, because that is
  // the number the money was released against.
  // NOT the buyer. The stack is what turns a shelf price into a profit, so it is the
  // basis for approving or turning a request down — the same kind of number as the buy
  // call, on the same side of the table. The buyer states the ticket price; the desk
  // decides what it means (`canWriteCosts`).
  const canCost = mayDecide || canAudit;

  async function load() {
    try { const { cart: c } = await api.cartGet(cartId); setCart(c); setErr(''); }
    catch (e) { if (e.unauthorized) return onSignOut(); setErr(e.message); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [cartId]);

  // LIVE, without a refresh. The buyer is in a shop watching for the desk's answer and
  // the desk is watching for the buyer's next pair — both used to be an F5 away. A quiet
  // re-read the moment anything on it is written (live-updates.md), and when the tab comes back to the front, keeps the dots,
  // the chips and the lines current. Only the cart is replaced, and only when it actually
  // changed, so a form somebody is mid-way through typing into is never disturbed — every
  // input on this page keeps its own draft state, exactly as it already had to for the
  // reload `act()` does after each write. A request that can no longer move is left alone.
  const settled = ['closed', 'cancelled', 'written_off'].includes(cart?.status);
  useLive(['buy_carts', 'buy_cart_lines', 'buy_cart_events', 'buy_cart_files', 'buy_cart_card_reads', 'buy_cart_gift_cards', 'buy_cart_receipt_lines', 'buy_cart_tasks', 'purchase_orders', 'po_boxes', 'po_lines', 'items'], async () => {
    try {
      const { cart: c } = await api.cartGet(cartId);
      setCart((cur) => (JSON.stringify(cur) === JSON.stringify(c) ? cur : c));
    } catch (e) { if (e.unauthorized) onSignOut(); /* anything else: next change */ }
  }, { every: cart && !settled ? 60_000 : 0, paused: !!busy, mount: false });

  async function act(fn, key) {
    setBusy(key); setErr('');
    try { await fn(); await load(); }
    catch (e) { if (e.unauthorized) return onSignOut(); setErr(e.message); }
    finally { setBusy(''); }
  }

  if (!cart) {
    return (
      <div className="app">
        <TopBar title="Buying request" onHome={onBack} onSignOut={onSignOut} />
        {err ? <div className="error mt">{err}</div> : <p className="muted">Loading…</p>}
      </div>
    );
  }

  const checksDone = (cart.checks || []).every((c) => c.ok);
  // The goods half on its own — a shipment can be verified while a card balance is still
  // outstanding, and vice versa.
  const goodsDone = (cart.checks || []).filter((c) => c.scope === 'goods').every((c) => c.ok);

  return (
    <div className="app bc">
      <TopBar title={cart.cart_code} onHome={onBack} onSignOut={onSignOut} />

      <section className="card bc-head">
        <div className="bc-head-top">
          <div>
            <h2 className="bc-code">{cart.cart_code}</h2>
            <div className="muted sm">
              {cart.buyer_name}{cart.retailer ? ` · ${cart.retailer}` : ''} · opened {estDate(cart.created_at)} EST
            </div>
          </div>
          <span className="bc-head-chips"><ListChip cart={cart} /><StatusChip status={cart.status} /></span>
        </div>
        {/* Where it is, as a row of dots. The status chip above says the column value;
            this says the STOP on the route, including the half that lives on the order. */}
        <MerchantRow cart={cart} busy={busy === 'merchant'}
          canChange={(isBuyer || mayDecide || canIssue) && merchantEditable(cart)}
          onPick={(m) => act(() => api.cartSetMerchant(cart.id, m), 'merchant')} />
        <BuyCartProgress cart={cart} />
        <NextStep step={nextStep(cart, { isBuyer, canDecide, canIssue, canAudit })} />
        {!settled && (
          <div className="bc-nudge">
            <NudgeButton kind="cart" id={cart.id} targets={nudgeTargets(cart, isBuyer)} />
          </div>
        )}
        {cart.status === 'written_off' && (
          <p className="bc-writeoff"><b>Written off:</b> {cart.write_off_reason}</p>
        )}
        {cart.purpose && <p className="bc-purpose"><b>Buying:</b> {cart.purpose}</p>}
        {cart.restrictions && <p className="muted sm"><b>Limits:</b> {cart.restrictions}</p>}
        <div className="bc-money">
          <span>Approved <b>{money(cart.approved_amount)}</b></span>
          {cart.funding_method !== 'company_card' && (() => {
            const f = fundingBreakdown(cart);
            return (
              <>
                {f.tax > 0
                  ? <span>Tax{f.pct != null ? ` (${f.pct}%)` : ''} <b>{money(f.tax)}</b></span>
                  : f.rate > 0
                    ? f.shelf === 0 && <span>Tax <b>{f.rate}%</b></span>
                    : <span>Tax <b>none declared</b></span>}
                <span>Gift cards needed <b>{money(f.target)}</b></span>
              </>
            );
          })()}
          {cart.funding_method === 'company_card'
            ? <span>Card charge <b>{money(cart.card_authorized)}</b></span>
            : <span>Cards <b>{money(cart.gc_total)}</b></span>}
          <span>Receipt <b>{money(cart.receipt_total)}</b></span>
          <span>Left over <b>{money(cart.balance_remaining)}</b></span>
          {cart.po && (
            <span>Order <a className="bc-po-link" href={poHref(user, cart.po.id)} title="Open the order — boxes, labels, tracking"><b>{cart.po.po_code}</b></a> ({cart.po.status})</span>
          )}
        </div>
        {cart.approved_by && (
          <p className="muted xs">
            Approved by {cart.approved_by} ({cart.approved_by_role}) {estDate(cart.approved_at)}
            {cart.funded_by ? ` · cards released by ${cart.funded_by}` : ''}
            {cart.audited_by ? ` · money audited by ${cart.audited_by}` : ''}
            {cart.goods_audited_by ? ` · goods audited by ${cart.goods_audited_by}` : ''}
            {cart.closed_by ? ` · closed by ${cart.closed_by}` : ''}
            {cart.written_off_by ? ` · written off by ${cart.written_off_by}` : ''}
          </p>
        )}

        <div className="bc-head-actions">
          {/* No "send": adding a pair IS asking about it. What the buyer presses at the
              end of the trip is CLOSE — the list is complete, fund what you approved.
              Until then the desk decides pair by pair and the cards wait. */}
          {isBuyer && listOpen(cart) && ['draft', 'submitted', 'approved', 'denied', 'funded'].includes(cart.status) && (
            <button className="btn primary" disabled={busy === 'sub' || !buyerCanClose(cart)}
              title={buyerCanClose(cart) ? 'Nothing more to add — send it for the gift cards' : 'Add at least one pair first'}
              onClick={() => act(() => api.cartCloseList(cart.id), 'sub')}>
              {busy === 'sub' ? 'Closing…' : 'Close the request'}
            </button>
          )}
          {isBuyer && cart.list_closed_at && (buyerCanReopen(cart) || reopenRefusedBecause(cart)) && (
            <button className="btn ghost" disabled={busy === 'reopen' || !buyerCanReopen(cart)}
              title={reopenRefusedBecause(cart) || 'The desk is told you are adding more'}
              onClick={() => setAsking('reopen')}>Re-open to add more</button>
          )}
          {/* The BUYER can start their own shipment. They are the one standing over the
              pile with the receipt already read, and waiting for a desk to guess a box
              count for them was the only thing stopping any of it. Named for what it
              does on their side — they are not raising paperwork, they are packing. */}
          {(canDecide || isBuyer) && cart.status === 'receipted' && !cart.po_id && (
            <button className="btn primary" disabled={busy === 'po'}
              onClick={() => setAsking('po')}>
              {isBuyer ? 'Start packing this shipment' : 'Raise the purchase order'}
            </button>
          )}
          {/* Only once there is something to close against. It used to sit here, primary
              and disabled, from the day a request was written — the most prominent
              button on the page for weeks, and one nobody could press. */}
          {canAudit && ['receipted', 'audited'].includes(cart.status) && (
            <button className="btn primary" disabled={busy === 'close' || !checksDone}
              title={checksDone ? '' : 'Not every closing condition is met yet.'}
              onClick={() => act(() => api.cartClose(cart.id), 'close')}>
              {busy === 'close' ? 'Closing…' : 'Close / reconciled'}
            </button>
          )}
          {/* The third ending, and deliberately not a force-close: it needs a reason and
              it reads as a loss everywhere it is shown afterwards. Offered only once
              money has actually moved — before that, cancelling is the honest word. */}
          {canAudit && ['funded', 'receipted', 'audited'].includes(cart.status) && !checksDone && (
            <button className="btn ghost danger" disabled={busy === 'wo'}
              onClick={() => setAsking('writeoff')}>Write off…</button>
          )}
          {canDecide && ['draft', 'submitted', 'denied'].includes(cart.status) && (
            <button className="btn danger" disabled={busy === 'cx'}
              onClick={() => setAsking('cancel')}>Cancel</button>
          )}
          {/* Delete, as distinct from cancel: the record goes (archived server-side).
              Open to everyone who can reach the request, with one exception the server
              enforces and the button says out loud — once cards have been issued the
              buyer cannot erase the record of the money, only an approver can. An order
              already raised has its own delete. */}
          {(() => {
            const carded = (cart.giftCards || []).length > 0 || Number(cart.gc_total) > 0;
            const blockedForMe = carded && !mayDecide;
            const why = cart.po_id ? 'This request raised a purchase order — delete the order first.'
              : blockedForMe ? 'Gift cards have been issued on this request — only an approver can delete it.'
                : undefined;
            return (
              <button className="btn ghost danger" disabled={busy === 'del' || !!why} title={why}
                onClick={() => setAsking('delete')}>Delete…</button>
            );
          })()}
        </div>
        {err && <div className="error mt">{err}</div>}

        {asking === 'po' && (
          <FormModal
            title={isBuyer ? 'Start packing this shipment' : 'Raise the purchase order'}
            message={isBuyer
              ? 'This opens the shipment and gives you your first boxes. A rough count is fine — you can add more as you pack.'
              : 'This opens the order the shipment is received against, and prints its labels.'}
            submitLabel={isBuyer ? 'Start packing' : 'Raise it'}
            onClose={() => setAsking(null)}
            onSubmit={async ({ boxes }) => {
              // A blank or nonsense count is one box, the same as the old prompt's default —
              // but the field says so rather than silently deciding it.
              await api.cartRaisePo(cart.id, Math.max(1, Number(boxes) || 1));
              setAsking(null); await load();
            }}
            fields={[{ name: 'boxes', label: isBuyer ? 'How many boxes are you sending?' : 'How many boxes is the buyer sending?',
              type: 'number', value: '1', min: 1, max: 99,
              hint: 'A guess is fine — you can add another box at any point while packing.' }]} />
        )}

        {asking === 'reopen' && (
          <FormModal
            title="Re-open this request?"
            message={Number(cart.gc_total) > 0
              ? `The approvers are told you are adding more. The ${money(cart.gc_total)} in cards already issued stays yours to spend; if the new pairs are approved, the desk records a top-up.`
              : 'The approvers are told you are adding more. Close it again when you are done, and the gift cards follow.'}
            submitLabel="Re-open it"
            onClose={() => setAsking(null)}
            onSubmit={async () => {
              await api.cartReopenList(cart.id);
              setAsking(null); await load();
            }}
            fields={[]} />
        )}

        {asking === 'cancel' && (
          <FormModal
            title="Cancel this request"
            message="It stays on the record as cancelled — nothing is deleted."
            submitLabel="Cancel the request" danger
            onClose={() => setAsking(null)}
            onSubmit={async ({ reason }) => {
              await api.cartCancel(cart.id, reason.trim());
              setAsking(null); await load();
            }}
            fields={[{ name: 'reason', label: 'Why is this being cancelled?', type: 'textarea', required: true,
              placeholder: 'e.g. Buyer got to the store and the price had gone back up' }]} />
        )}

        {asking === 'delete' && (
          <FormModal
            title={`Delete ${cart.cart_code}?`}
            message={`The request, its ${(cart.lines || []).length} line${(cart.lines || []).length === 1 ? '' : 's'}${(cart.giftCards || []).length ? `, ${(cart.giftCards || []).length} gift card${(cart.giftCards || []).length === 1 ? '' : 's'}` : ''}${(cart.files || []).length ? ` and ${(cart.files || []).length} file${(cart.files || []).length === 1 ? '' : 's'}` : ''} are removed. A copy is kept in the archive, but it cannot be undone from here. To keep it on the record instead, use Cancel.`}
            submitLabel="Delete the request" danger
            onClose={() => setAsking(null)}
            onSubmit={async ({ reason }) => {
              await api.cartDelete(cart.id, reason.trim());
              setAsking(null); onBack();
            }}
            fields={[{ name: 'reason', label: 'Why is this being deleted?', type: 'textarea', required: true,
              placeholder: 'e.g. Raised twice by mistake — BC-41 is the real one' }]} />
        )}

        {asking === 'writeoff' && (
          <FormModal
            title="Write this request off"
            message="This is a documented loss, not a shortcut past the checks. It stays visible as written off, with your name on it, and never reads as closed."
            submitLabel="Write it off" danger
            onClose={() => setAsking(null)}
            onSubmit={async ({ reason }) => {
              await api.cartWriteOff(cart.id, reason.trim());
              setAsking(null); await load();
            }}
            fields={[{ name: 'reason', label: 'What could not be recovered, and why?', type: 'textarea', required: true,
              placeholder: 'e.g. Receipt lost and the retailer cannot reprint it; $184.98 of gift card balance unaccounted for',
              hint: 'Escalate first. A write-off is a management decision — say what was tried.' }]} />
        )}
      </section>

      {/* For as long as the buyer's LIST IS OPEN — every add goes straight to the desk,
          and the list stays open through approvals and even funding until they close it
          (or re-open it) themselves. */}
      {isBuyer && buyerCanAdd(cart) && (
        <div id="bc-sec-add" className="bc-sec"><BuyCartAdd cart={cart} onAdded={load} onSignOut={onSignOut} /></div>
      )}
      {isBuyer && cart.list_closed_at && ['submitted', 'approved', 'denied', 'funded'].includes(cart.status) && (
        <p className="muted sm bc-list-note">
          You closed this request {estDate(cart.list_closed_at)} EST — it is with the desk for
          {cart.status === 'funded' ? ' the cards already issued' : Number(cart.pending_count) > 0 ? ' approval' : ' the gift cards'}.
          Found one more pair? <b>Re-open to add more</b> above.
        </p>
      )}

      {/* Before the lines, because it is what the cost-per-unit column on them means. Not
          drawn for a buyer at all — the server sends them no stack, so the card would be
          a row of empty boxes explaining an arithmetic they cannot see. */}
      {!isBuyer && (
        <BuyCartCosts cart={cart} canEdit={canCost && !['closed', 'cancelled'].includes(cart.status)}
          onChanged={load} onSignOut={onSignOut} />
      )}

      <div id="bc-sec-lines" className="bc-sec" />
      <Lines cart={cart} canDecide={canDecide} isBuyer={isBuyer}
        canTip={mayDecide && !['closed', 'cancelled'].includes(cart?.status)}
        // Load it WITHOUT being asked for whoever would act on it, while there is still
        // something to act on. `mayDecide`, not `canDecide`: an approver reading a draft
        // that has not been sent yet is exactly who benefits from seeing we already hold
        // eight of that size — before it is submitted and the conversation hardens.
        autoStock={(mayDecide || canAudit) && !['closed', 'cancelled', 'written_off'].includes(cart.status)}
        // Only shown to somebody who WOULD be deciding — telling a buyer their own
        // request has nothing to approve is noise.
        whyNoDecide={mayDecide ? (decisionsClosedBecause(cart.status)
          || (decisionsPendingOnly(cart.status) && Number(cart.pending_count) > 0
            ? 'The cards have already gone out against the decided lines, so those are frozen — only the pairs added since can be decided.'
            : null)) : null}
        // `mayDecide`, not `canDecide`: correcting a misread shelf ticket is a cost-side
        // act and stays open through draft/submitted/approved. Gating it on the DECISION
        // window would have taken the ✎ away on a draft, which is the state where a
        // typo is most likely to still be there.
        canEditLines={(mayDecide || canAudit) && ['draft', 'submitted', 'approved'].includes(cart.status)}
        // The server's own predicate, mirrored: `canWriteCosts` (a cost privilege) AND
        // `costStackEditable` AND `canSeeBuyCall`. Deliberately NOT `canCost` — that is
        // the cost stack's rule and it carries two differences that are both wrong here:
        // it is true for a BUYER, who may state what a pair costs but never make the
        // call on it, and it hangs off `canDecide`, which is closed on a draft — so an
        // approver looking at an unpriced line before it was sent in had no way to
        // price it, while the endpoint would have accepted it.
        canPrice={(mayDecide || canAudit) && !['closed', 'cancelled'].includes(cart.status)}
        onChanged={load} onSignOut={onSignOut} />

      {/* The cards, once there is something to fund — an approved request whose buyer
          has closed the list. On a re-opened one the panel stays (the cards are still
          out there) and just says why no more can be recorded yet. */}
      {cart.funding_method !== 'company_card'
        && ['approved', 'funded', 'receipted', 'audited', 'closed', 'written_off'].includes(cart.status)
        && (cardsIssuable(cart) || (cart.giftCards || []).length > 0
          || (cart.files || []).some((f) => f.kind === 'gift_card') || !['approved'].includes(cart.status)) && (
        <div id="bc-sec-cards" className="bc-sec"><BuyCartGiftCards cart={cart} role={role} canIssue={canIssue} isBuyer={isBuyer} canAudit={canAudit}
          onChanged={load} onSignOut={onSignOut} /></div>
      )}

      {['funded', 'receipted', 'audited', 'closed', 'written_off'].includes(cart.status) && (
        <div id="bc-sec-receipt" className="bc-sec"><BuyCartReceipt cart={cart}
          // ATTACHING the receipt is open to everyone who can reach the request: the
          // buyer standing in the shop, and any staff member the paper reaches first.
          // It is evidence, and a request that sits waiting because the one person with
          // the button is asleep in another timezone is the whole problem this process
          // was meant to solve. The server scopes a buyer to their own request.
          canUpload={!['closed', 'cancelled', 'written_off'].includes(cart.status)}
          // STATING what it says is a claim about money — the total the reconciliation
          // runs against and the lines the order is raised from. That stays with the
          // buyer, either desk, or the auditor.
          canEdit={!['closed', 'cancelled', 'written_off'].includes(cart.status)
            && (isBuyer || canDecide || canIssue || canAudit)}
          // Shoes on the receipt that aren't ours: the auditor or approver only, never the
          // buyer, because taking a row off lowers what the buyer has to account for.
          canRemove={(mayDecide || canAudit) && !['closed', 'cancelled', 'written_off'].includes(cart.status)}
          onChanged={load} onSignOut={onSignOut} /></div>
      )}

      {/* Step 6, second half. Appears the moment the order exists, because that is when
          the buyer starts filling cartons — and the count of what is still loose is the
          thing that decides whether the last box may ship. */}
      {cart.po_id && (
        <div id="bc-sec-pack" className="bc-sec"><BuyCartPack cart={cart} user={user} onChanged={load} onSignOut={onSignOut}
          canPack={(isBuyer || canDecide || canAudit) && !['closed', 'cancelled', 'written_off'].includes(cart.status)}
          // Who may ASK for labels is the order's rule, not the request's: the buyer,
          // PH (who buy the labels and may ask on a buyer's behalf) and admin — the same
          // set `po/request-labels` accepts, so the button never leads to a 403.
          canAskLabels={['supplier', 'ph_team', 'admin', 'superadmin'].includes(role)
            && !['closed', 'cancelled', 'written_off'].includes(cart.status)} /></div>
      )}

      {canAudit && ['receipted', 'audited'].includes(cart.status) && (
        <div id="bc-sec-audit" className="bc-sec"><Audit cart={cart} onChanged={load} onSignOut={onSignOut} /></div>
      )}

      {/* The goods sign-off is separate from the money one and can be weeks later, so it
          hangs off the goods conditions rather than the cart's status. */}
      {canAudit && cart.po_id && !cart.goods_audited_at && !['cancelled', 'written_off'].includes(cart.status) && (
        <section className="card bc-goods-audit bc-sec" id="bc-sec-goods">
          <h3 className="bc-h">The shipment against the receipt</h3>
          <p className="muted sm">
            Three lists have to agree: what the receipt says was paid for, what the buyer packed
            into each box, and what the warehouse counted. Reconciliation only ever compared the
            last two — this is the one that takes nobody’s word for anything.
          </p>
          <button type="button" className="btn primary" disabled={busy === 'ga' || !goodsDone}
            title={goodsDone ? '' : 'The goods conditions below are not all met yet.'}
            onClick={() => act(() => api.cartAuditGoods(cart.id, null), 'ga')}>
            {busy === 'ga' ? 'Signing off\u2026' : 'Sign off the shipment'}
          </button>
        </section>
      )}

      <BuyCartTasks cart={cart} canManage={canDecide} onChanged={load} onSignOut={onSignOut} />

      <div id="bc-sec-checks" className="bc-sec"><Checks checks={cart.checks} status={cart.status} /></div>
      <Thread cart={cart} onChanged={load} onSignOut={onSignOut} />
    </div>
  );
}
