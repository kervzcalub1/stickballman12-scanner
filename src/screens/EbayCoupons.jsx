// eBay Listings → Coupons (docs/context/ebay-coupons.md). Coded coupons on eBay: a code a
// buyer types at checkout for $X off the listings you picked, limited to N uses per buyer
// (default 1). eBay holds the coupons; this lists them (with which of our listings each
// covers), makes new ones, and pauses / resumes / deletes them.
import React, { useEffect, useMemo, useState } from 'react';
import { Modal } from '../components/common.jsx';
import { api } from '../api.js';
import { estToday, estDate, PH_DATETIME } from '../lib/format.js';
import { AMOUNTS, MIN_SPEND, MAX_LISTINGS, codeProblem, randomCode, couponTerms } from '../lib/ebayCoupons.js';

const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const money = (n) => (n == null ? '—' : `$${Number(n).toFixed(2).replace(/\.00$/, '')}`);
const when = (iso) => (iso ? `${PH_DATETIME.format(new Date(iso))} EST` : '—');
const STATUS = {
  RUNNING: ['Running', 'ok'], SCHEDULED: ['Scheduled', 'warn'], PAUSED: ['Paused', 'warn'],
  DRAFT: ['Draft', 'muted'], ENDED: ['Ended', 'muted'], INVALID: ['Invalid', 'bad'],
};
const LIVE = new Set(['RUNNING', 'SCHEDULED', 'PAUSED', 'DRAFT']);
// 'YYYY-MM-DD' + n days, as a calendar date (no clock involved).
const addDays = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const priceRange = (g) => (g.min == null ? '—' : g.min === g.max ? money(g.min) : `${money(g.min)}–${money(g.max)}`);

function Thumb({ src }) {
  return src ? <img className="ebl-thumb" src={src} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <span className="ebl-thumb ebl-thumb-empty" aria-hidden="true" />;
}

export function EbayCoupons({ listings, isAdmin, onSignOut, onConnect }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [busy, setBusy] = useState('');
  const [ask, setAsk] = useState(null);   // { action, c }

  async function load() {
    setErr('');
    try { setData(await api.ebayCoupons()); } catch (e) { if (e.unauthorized) onSignOut(); else setErr(e.message); }
  }
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const byId = useMemo(() => new Map(listings.map((g) => [String(g.item_id), g])), [listings]);
  // listing id → the live coupons it's in (for the picker's "in a coupon" chips)
  const couponsOf = useMemo(() => {
    const m = new Map();
    for (const c of data?.coupons || []) {
      if (!LIVE.has(c.promotionStatus)) continue;
      for (const id of c.listingIds || []) { const a = m.get(String(id)) || []; a.push(c); m.set(String(id), a); }
    }
    return m;
  }, [data]);

  async function act() {
    const { action, c } = ask;
    setAsk(null); setBusy(c.promotionId); setErr('');
    try { await api.ebayCouponAction(action, c); await load(); }
    catch (e) { if (e.unauthorized) onSignOut(); else setErr(e.data?.needsReconnect ? `${e.message} — eBay needs re-approving (Connect eBay again).` : e.message); }
    finally { setBusy(''); }
  }

  const needsReconnect = data && (data.needsReconnect || !data.canMarket);
  const coupons = data?.coupons || [];
  const live = coupons.filter((c) => LIVE.has(c.promotionStatus));
  const ended = coupons.filter((c) => !LIVE.has(c.promotionStatus));

  return (
    <>
      {err && <div className="error mt">{err}</div>}
      {needsReconnect && (
        <div className="card">
          <p className="sm"><b>Coupons need one more eBay permission.</b> The account was approved before coupons existed, so eBay won’t let us read or make them yet.
            {' '}{isAdmin ? <button type="button" className="btn sm primary" onClick={onConnect}>Connect eBay again</button> : 'An admin presses Connect eBay again (on this page) and approves.'}</p>
          {data?.error && <p className="muted xs">eBay said: {data.error}</p>}
        </div>
      )}

      {creating
        ? <CouponForm listings={listings} couponsOf={couponsOf} onCancel={() => setCreating(false)} onSignOut={onSignOut}
            onCreated={async () => { setCreating(false); await load(); }} />
        : (
          <div className="card">
            <div className="ebl-endbar">
              <h3 className="er-step-title">Coupons on eBay</h3>
              <span className="ebr-sel-actions">
                <button type="button" className="btn ghost sm" onClick={load}>↻ Refresh</button>
                <button type="button" className="btn primary" disabled={!data || needsReconnect} onClick={() => setCreating(true)}>＋ New coupon</button>
              </span>
            </div>
            <p className="muted sm">A coupon is a code a buyer types at checkout for <b>$ off each item</b> on the listings you pick. Set how many times one buyer can use it (1 = once per buyer).</p>
            {!data ? <p className="muted">Loading coupons from eBay…</p> : data.coupons == null ? null : !live.length ? <p className="muted">No running or scheduled coupons.</p> : (
              <div className="ebl-orphans">
                {live.map((c) => <CouponCard key={c.promotionId} c={c} byId={byId} open={openId === c.promotionId} busy={busy === c.promotionId}
                  onToggle={() => setOpenId((o) => (o === c.promotionId ? null : c.promotionId))} onAsk={(action) => setAsk({ action, c })} />)}
              </div>
            )}
            {ended.length > 0 && (
              <details className="mt">
                <summary className="muted sm">Ended ({fmt(ended.length)})</summary>
                <div className="ebl-orphans">
                  {ended.map((c) => <CouponCard key={c.promotionId} c={c} byId={byId} open={false} onToggle={() => {}} onAsk={() => {}} />)}
                </div>
              </details>
            )}
          </div>
        )}

      {data?.log?.length > 0 && (
        <div className="card">
          <details>
            <summary className="muted sm">What was done from here ({fmt(data.log.length)})</summary>
            <div className="ebl-orphans">
              {data.log.map((l) => (
                <div key={l.id} className="ebl-orphan ebc-log">
                  <span className={`ebl-note ${l.ok ? 'ok' : 'bad'}`}>{l.ok ? '✓' : '✗'} {l.action}</span>
                  <span className="ebl-orphan-main">
                    <span className="sm"><b className="ebl-sku">{l.code || ''}</b> {l.name || ''}</span>
                    <span className="muted xs">{when(l.done_at)}{l.done_by ? ` · ${l.done_by}` : ''}</span>
                    {l.error && <span className="error xs">{l.error}</span>}
                  </span>
                </div>
              ))}
            </div>
          </details>
        </div>
      )}

      {ask && (
        <Modal type="warn" title={`${ask.action === 'delete' ? 'Delete' : ask.action === 'pause' ? 'Pause' : 'Resume'} coupon ${ask.c.couponCode || ask.c.name}?`}
          message={ask.action === 'delete' ? 'Buyers can no longer use the code. This can’t be undone — make a new coupon to bring it back.'
            : ask.action === 'pause' ? 'Buyers can’t use the code until you resume it.' : 'Buyers can use the code again.'}
          onClose={() => setAsk(null)}>
          <button type="button" className="btn ghost" onClick={() => setAsk(null)}>Cancel</button>
          <button type="button" className={`btn ${ask.action === 'delete' ? 'danger' : 'primary'}`} onClick={act}>{ask.action === 'delete' ? 'Delete' : ask.action === 'pause' ? 'Pause' : 'Resume'}</button>
        </Modal>
      )}
    </>
  );
}

function CouponCard({ c, byId, open, busy, onToggle, onAsk }) {
  const [q, setQ] = useState('');
  const [label, tone] = STATUS[c.promotionStatus] || [c.promotionStatus, 'muted'];
  const ids = c.listingIds || [];
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const inList = ids.map((id) => byId.get(String(id)) || { item_id: id, title: null, sizes: [] })
    .filter((g) => !words.length || words.every((w) => [g.title, g.style, g.item_id, g.item_sku].join(' ').toLowerCase().includes(w)));
  return (
    <div className="ebc-card">
      <button type="button" className="ebc-head" onClick={onToggle} aria-expanded={open}>
        <span className="ebc-code">{c.couponCode || '—'}</span>
        <span className="ebl-orphan-main">
          <span className="sm"><b>{c.name}</b> <span className={`ebl-note ${tone}`}>● {label}</span></span>
          <span className="muted xs">{couponTerms(c) || c.description}</span>
          <span className="muted xs">{c.startDate ? estDate(c.startDate) : '—'} → {c.endDate ? estDate(c.endDate) : '—'}{c.listingIds ? ` · ${fmt(ids.length)} listing${ids.length === 1 ? '' : 's'}` : ''}</span>
          {c.detailError && <span className="error xs">{c.detailError}</span>}
        </span>
        {LIVE.has(c.promotionStatus) && <span className="muted xs" aria-hidden="true">{open ? '▾' : '▸'}</span>}
      </button>
      {open && (
        <div className="ebc-body">
          <div className="ebc-actions">
            {c.promotionStatus === 'RUNNING' && <button type="button" className="btn sm" disabled={busy} onClick={() => onAsk('pause')}>Pause</button>}
            {c.promotionStatus === 'PAUSED' && <button type="button" className="btn sm" disabled={busy} onClick={() => onAsk('resume')}>Resume</button>}
            <button type="button" className="btn sm danger" disabled={busy} onClick={() => onAsk('delete')}>Delete</button>
            {busy && <span className="muted xs">Working…</span>}
          </div>
          {ids.length > 0 && (
            <>
              <input type="search" className="input mt" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the listings in this coupon…" aria-label="Search listings in this coupon" />
              <div className="ebc-listings">
                {inList.slice(0, 200).map((g) => (
                  <div key={g.item_id} className="ebc-li">
                    <Thumb src={g.image_url} />
                    <span className="ebl-orphan-main">
                      <span className="ebl-title sm">{g.title || <span className="muted">Not in our last pull (ended?)</span>}</span>
                      <span className="muted xs">#{g.item_id}{g.style ? ` · ${g.style}` : ''}{g.sizes?.length ? ` · ${priceRange(g)}` : ''}</span>
                    </span>
                  </div>
                ))}
                {!inList.length && <p className="muted xs">No listing in this coupon matches.</p>}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function CouponForm({ listings, couponsOf, onCancel, onCreated, onSignOut }) {
  const today = estToday();
  const [f, setF] = useState(() => ({
    name: '', description: '', code: randomCode(), amount: 10, perUser: 1, visibility: 'private',
    startYmd: today, endYmd: addDays(today, 30), minSpend: '', budget: '',
  }));
  const [pick, setPick] = useState(() => new Set());
  const [q, setQ] = useState('');
  const [view, setView] = useState('all');   // all | picked | free | incoupon
  const [shown, setShown] = useState(80);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const descDefault = `$${f.amount} off select sneakers`;

  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const filtered = useMemo(() => listings.filter((g) => {
    const id = String(g.item_id);
    if (view === 'picked' && !pick.has(id)) return false;
    if (view === 'free' && couponsOf.has(id)) return false;
    if (view === 'incoupon' && !couponsOf.has(id)) return false;
    if (!words.length) return true;
    const hay = [g.title, g.style, g.item_sku, g.item_id, ...g.sizes.map((s) => s.sku)].join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  }), [listings, view, pick, couponsOf, q]); // eslint-disable-line react-hooks/exhaustive-deps
  const allPicked = filtered.length > 0 && filtered.every((g) => pick.has(String(g.item_id)));
  const setMany = (gs, on) => setPick((cur) => { const n = new Set(cur); for (const g of gs) { if (on) n.add(String(g.item_id)); else n.delete(String(g.item_id)); } return n; });
  const codeErr = codeProblem(f.code);
  const tooMany = pick.size > MAX_LISTINGS;
  const noPhoto = pick.size > 0 && ![...pick].some((id) => listings.find((g) => String(g.item_id) === id)?.image_url);

  async function create() {
    setBusy(true); setErr('');
    try {
      await api.ebayCouponCreate({ ...f, name: f.name.trim() || `${f.code} $${f.amount} off`, description: f.description.trim() || descDefault,
        code: f.code.trim().toUpperCase(), amount: Number(f.amount), perUser: Number(f.perUser), listingIds: [...pick] });
      onCreated();
    } catch (e) {
      if (e.unauthorized) return onSignOut();
      setErr(e.message);
    } finally { setBusy(false); }
  }

  return (
    <div className="card">
      <h3 className="er-step-title">New coupon</h3>
      <div className="ebc-form">
        <label className="ebc-field"><span>Coupon code (buyers type this)</span>
          <span className="ebc-code-row">
            <input className="input ebl-sku" value={f.code} maxLength={15} onChange={(e) => setF((x) => ({ ...x, code: e.target.value.toUpperCase().replace(/\s/g, '') }))} aria-label="Coupon code" />
            <button type="button" className="btn ghost sm" onClick={() => setF((x) => ({ ...x, code: randomCode() }))}>Generate</button>
          </span>
          {codeErr ? <span className="error xs">{codeErr}</span> : <span className="muted xs">Must be unique across all of eBay.</span>}
        </label>
        <label className="ebc-field"><span>Amount off each item</span>
          <select className="input" value={f.amount} onChange={set('amount')}>{AMOUNTS.map((a) => <option key={a} value={a}>${a} off</option>)}</select>
          <span className="muted xs">eBay allows only these amounts.</span>
        </label>
        <label className="ebc-field"><span>Uses per buyer</span>
          <select className="input" value={f.perUser} onChange={set('perUser')}>{Array.from({ length: 10 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n === 1 ? 'Once per buyer' : `${n} times per buyer`}</option>)}</select>
        </label>
        <label className="ebc-field"><span>Who can see the code</span>
          <select className="input" value={f.visibility} onChange={set('visibility')}>
            <option value="private">Private — you share it</option>
            <option value="public">Public — eBay shows it</option>
          </select>
        </label>
        <label className="ebc-field"><span>Starts (EST)</span><input type="date" className="input" value={f.startYmd} min={today} onChange={set('startYmd')} /></label>
        <label className="ebc-field"><span>Ends (EST, end of day)</span><input type="date" className="input" value={f.endYmd} min={f.startYmd} onChange={set('endYmd')} /></label>
        <label className="ebc-field"><span>Minimum spend (optional)</span>
          <select className="input" value={f.minSpend} onChange={set('minSpend')}><option value="">No minimum</option>{MIN_SPEND.map((a) => <option key={a} value={a}>${a}+</option>)}</select>
        </label>
        <label className="ebc-field"><span>Total budget (optional)</span>
          <input type="text" inputMode="numeric" className="input" value={f.budget} placeholder="e.g. 500 — blank = no cap" onChange={set('budget')} />
          <span className="muted xs">Stops the coupon once this much has been discounted ($100+).</span>
        </label>
        <label className="ebc-field"><span>Name (only you see it)</span><input className="input" value={f.name} maxLength={90} placeholder={`${f.code} $${f.amount} off`} onChange={set('name')} /></label>
        <label className="ebc-field"><span>Tag line (buyers see it)</span><input className="input" value={f.description} maxLength={50} placeholder={descDefault} onChange={set('description')} /></label>
      </div>

      <h4 className="mt">Listings in this coupon <span className="muted sm">· {fmt(pick.size)} picked{tooMany ? ` — at most ${MAX_LISTINGS}` : ''}</span></h4>
      <div className="ebl-filters">
        <input type="search" className="input" value={q} onChange={(e) => { setQ(e.target.value); setShown(80); }} placeholder="Search title, style code, Custom label, item #…" aria-label="Search listings to add" />
        <div className="seg sm">
          {[['all', 'All'], ['picked', `Picked ${fmt(pick.size)}`], ['free', 'Not in a coupon'], ['incoupon', 'Already in a coupon']].map(([k, l]) => (
            <button key={k} type="button" className={`seg-btn${view === k ? ' on' : ''}`} aria-pressed={view === k} onClick={() => { setView(k); setShown(80); }}>{l}</button>
          ))}
        </div>
      </div>
      <div className="ebl-endbar">
        <label className="ebl-check"><input type="checkbox" checked={allPicked} disabled={!filtered.length} onChange={(e) => setMany(filtered, e.target.checked)} /> Select all {fmt(filtered.length)} shown</label>
        {pick.size > 0 && <button type="button" className="btn ghost sm" onClick={() => setPick(new Set())}>Clear</button>}
      </div>
      <div className="ebl-orphans">
        {filtered.slice(0, shown).map((g) => {
          const id = String(g.item_id);
          const inC = couponsOf.get(id) || [];
          return (
            <label key={id} className={`ebl-orphan ebc-pick${pick.has(id) ? ' on' : ''}`}>
              <input type="checkbox" checked={pick.has(id)} onChange={(e) => setMany([g], e.target.checked)} aria-label={`Add ${g.title}`} />
              <Thumb src={g.image_url} />
              <span className="ebl-orphan-main">
                <span className="ebl-title">{g.title}</span>
                <span className="muted xs">#{id}{g.style ? ` · ${g.style}` : ''} · {priceRange(g)} · {fmt(g.available)} avail.</span>
                {inC.length > 0 && <span className="xs">{inC.map((c) => <span key={c.promotionId} className="ebr-chip">in {c.couponCode || c.name}</span>)}</span>}
              </span>
            </label>
          );
        })}
        {filtered.length > shown && <button type="button" className="btn ghost sm" onClick={() => setShown((n) => n + 200)}>Show more ({fmt(filtered.length - shown)} left)</button>}
        {!filtered.length && <p className="muted">Nothing matches.</p>}
      </div>

      {err && <div className="error mt">{err}</div>}
      {noPhoto && <div className="error xs mt">None of the picked listings has a photo — eBay needs one for the coupon.</div>}
      <div className="er-actions ebc-submit">
        <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="button" className="btn primary" disabled={busy || !!codeErr || !pick.size || tooMany || noPhoto || !f.startYmd || !f.endYmd || f.endYmd < f.startYmd} onClick={create}>
          {busy ? 'Creating on eBay…' : `Create coupon · $${f.amount} off · ${fmt(pick.size)} listing${pick.size === 1 ? '' : 's'}`}</button>
      </div>
    </div>
  );
}
