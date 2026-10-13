// eBay → Orders (docs/context/ebay-orders.md). Every eBay order as a table — order #,
// buyer, the shoe (photo, SKU, size), ship-by, tracking with the carrier's word — so a
// shipment that's late (not shipped by eBay's ship-by date, or not delivered by its
// latest estimate) is impossible to miss. Synced from eBay every 30 min in production,
// or now with Sync.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { useLive } from '../hooks.js';
import { useQueryParam } from '../lib/urlstate.js';
import { estDate, estToday, PH_DATETIME } from '../lib/format.js';
import { SHIP_STATES, shipState, shippedLate } from '../lib/ebayOrders.js';

const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const usd = (c) => (c == null ? '—' : `$${(c / 100).toFixed(2)}`);
const when = (iso) => (iso ? `${PH_DATETIME.format(new Date(iso))} EST` : '—');
const addDays = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const ORDER_URL = (id) => `https://www.ebay.com/sh/ord/details?orderid=${encodeURIComponent(id)}`;
// The carrier's own tracking page when we know the carrier, else 17TRACK.
export function trackUrl(number, carrier) {
  const n = encodeURIComponent(number);
  const c = String(carrier || '').toUpperCase();
  if (c.includes('UPS')) return `https://www.ups.com/track?tracknum=${n}`;
  if (c.includes('USPS')) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`;
  if (c.includes('FEDEX')) return `https://www.fedex.com/fedextrack/?trknbr=${n}`;
  if (c.includes('DHL')) return `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${n}`;
  return `https://t.17track.net/en#nums=${n}`;
}
const STEP = { orders: 'Reading orders', tracking: 'Reading tracking', photos: 'Finding photos', money: 'Reading sales & fees' };
const FILTERS = ['all', 'late', 'due_today', 'to_ship', 'late_delivery', 'shipped', 'delivered', 'cancelled'];
const RANGES = [['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['ytd', 'This year']];

function Thumb({ src }) {
  const [bad, setBad] = useState(false);
  return src && !bad ? <img className="ebl-thumb" src={src} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBad(true)} />
    : <span className="ebl-thumb ebl-thumb-empty" aria-hidden="true" />;
}

export function EbayOrders({ isAdmin, onSignOut, onConnect }) {
  const [range, setRange] = useQueryParam('days', '30');
  const [filter, setFilter] = useQueryParam('ship', 'all');
  const [q, setQ] = useQueryParam('oq', '');
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const today = estToday();
  const from = range === 'ytd' ? `${today.slice(0, 4)}-01-01` : addDays(today, -Number(range || 30));

  async function load() {
    try { setData(await api.ebayOrders(from, today)); setErr(''); }
    catch (e) { if (e.unauthorized) onSignOut(); else setErr(e.message); }
  }
  useEffect(() => { load(); }, [range]); // eslint-disable-line react-hooks/exhaustive-deps
  useLive(['ebay_orders', 'app_settings'], load, { mount: false });
  // While a sync runs, the progress lives in app_settings — live updates carry it; this is
  // the fallback if they're off.
  const running = data?.sync?.state === 'running';
  const timer = useRef(null);
  useEffect(() => {
    if (!running) return undefined;
    timer.current = setInterval(load, 5000);
    return () => clearInterval(timer.current);
  }, [running]); // eslint-disable-line react-hooks/exhaustive-deps

  async function sync(backfillFrom) {
    setBusy(true); setErr('');
    try { await api.ebayOrdersSync(backfillFrom); await load(); }
    catch (e) { if (e.unauthorized) onSignOut(); else setErr(e.message); }
    finally { setBusy(false); }
  }

  const now = new Date();
  const orders = useMemo(() => (data?.orders || []).map((o) => {
    const tracking = Object.fromEntries((o.fulfillments || []).map((f) => [f.number, { status: f.status }]));
    return { ...o, state: shipState(o, tracking, now), late: shippedLate(o) };
  }), [data]); // eslint-disable-line react-hooks/exhaustive-deps
  const counts = useMemo(() => {
    const c = { all: orders.length };
    for (const o of orders) c[o.state] = (c[o.state] || 0) + 1;
    return c;
  }, [orders]);
  const shown = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return orders.filter((o) => (filter === 'all' || o.state === filter)
      && (!words.length || words.every((w) => [o.order_id, o.buyer, ...(o.lines || []).flatMap((l) => [l.title, l.sku, l.size, l.item_id]),
        ...(o.fulfillments || []).map((f) => f.number)].join(' ').toLowerCase().includes(w))))
      // The ones that need someone first: late, then due today, then the rest newest-first.
      .sort((a, b) => (rank(a) - rank(b)) || String(b.created_at).localeCompare(String(a.created_at)));
  }, [orders, filter, q]);

  const s = data?.sync;
  const never = data && !s?.lastOrdersAt && s?.state !== 'running';
  if (data && !data.canOrders) {
    return (
      <div className="card">
        <p className="sm"><b>Orders need one more eBay permission.</b> The account was approved before orders were added here.
          {' '}{isAdmin ? <button type="button" className="btn sm primary" onClick={onConnect}>Connect eBay again</button> : 'An admin presses Connect eBay again and approves.'}</p>
      </div>
    );
  }
  return (
    <>
      {err && <div className="error mt">{err}</div>}
      <div className="card">
        <div className="ebl-pullbar">
          {never
            ? <button type="button" className="btn primary" disabled={busy} onClick={() => sync(`${today.slice(0, 4)}-01-01`)}>Load this year’s orders from eBay</button>
            : <button type="button" className="btn" disabled={busy || running} onClick={() => sync()}>{running ? 'Syncing…' : '↻ Sync now'}</button>}
          {running && <span className="muted sm">{STEP[s.step] || 'Working'}… {s.total ? `${fmt(s.done)} of ${fmt(s.total)}` : s.done ? fmt(s.done) : ''}</span>}
          {!running && s?.state === 'done' && <span className="muted sm">Synced {when(s.finishedAt)}{s.by && s.by !== 'auto' ? ` by ${s.by}` : ''} · checks again every 30 min</span>}
          {!running && s?.state === 'failed' && <span className="error xs">Last sync failed {when(s.finishedAt)}: {s.error}{s.needsReconnect && isAdmin ? ' ' : ''}{s.needsReconnect && isAdmin && <button type="button" className="btn xs" onClick={onConnect}>Connect eBay again</button>}</span>}
        </div>
        {never && <p className="muted xs">The first load reads every order since Jan 1 with its tracking — a few minutes for a busy year. After that it only reads what changed.</p>}
      </div>

      <div className="card">
        <div className="ebl-filters">
          <input type="search" className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search order #, buyer, shoe, SKU, tracking…" aria-label="Search eBay orders" />
          <select className="input ebo-range" value={range} onChange={(e) => setRange(e.target.value)} aria-label="Orders from">
            {RANGES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </div>
        <div className="seg sm ebo-filters">
          {FILTERS.map((k) => (k === 'all' || counts[k]) ? (
            <button key={k} type="button" className={`seg-btn${filter === k ? ' on' : ''}${(k === 'late' || k === 'late_delivery') && counts[k] ? ' no' : ''}`} aria-pressed={filter === k}
              onClick={() => setFilter(k)}>{k === 'all' ? 'All' : SHIP_STATES[k][0]} <span className="seg-n">{fmt(counts[k] || 0)}</span></button>
          ) : null)}
        </div>
        <p className="muted xs">Orders placed in the period, plus every order still waiting to ship. Late = past eBay’s ship-by date and not shipped; Delivery late = shipped, past eBay’s latest delivery estimate, and the carrier hasn’t said delivered.</p>
        {!data ? <p className="muted">Loading…</p> : !shown.length ? <p className="muted">{orders.length ? 'Nothing matches.' : 'No orders yet — load them from eBay.'}</p> : (
          <div className="ap-tablewrap">
            <table className="table ebo-table">
              <thead><tr><th aria-label="Photo" /><th>Order</th><th>Buyer</th><th>Shoe</th><th>Ship by</th><th>Tracking</th><th>Status</th></tr></thead>
              <tbody>
                {shown.map((o) => {
                  const [label, tone] = SHIP_STATES[o.state];
                  return (
                    <tr key={o.order_id} className={`ebo-row ${tone}`}>
                      <td className="ebl-thumb-cell"><Thumb src={o.lines?.[0]?.image_url} /></td>
                      <td data-label="Order">
                        <a className="ebl-link ebl-sku" href={ORDER_URL(o.order_id)} target="_blank" rel="noreferrer">{o.order_id} ↗</a>
                        <div className="muted xs">{when(o.created_at)}</div>
                        <div className="muted xs">{usd(o.total_cents)}</div>
                      </td>
                      <td data-label="Buyer" className="ebl-sku">{o.buyer || '—'}</td>
                      <td data-label="Shoe">
                        {(o.lines || []).map((l) => (
                          <div key={l.line_item_id} className="ebo-line">
                            {o.lines.length > 1 && <Thumb src={l.image_url} />}
                            <span>
                              <span className="ebl-title">{l.title}</span>
                              <span className="muted xs ebo-meta">SKU <b className="ebl-sku">{l.sku || '—'}</b>{l.size ? <> · size <b>{l.size}</b></> : ''}{l.qty > 1 ? ` · qty ${l.qty}` : ''}</span>
                            </span>
                          </div>
                        ))}
                      </td>
                      <td data-label="Ship by" className="ebl-nowrap">{o.ship_by ? estDate(o.ship_by) : '—'}{o.late && <div className="ebl-note warn xs">shipped late</div>}</td>
                      <td data-label="Tracking">
                        {(o.fulfillments || []).length ? o.fulfillments.map((f) => (
                          <div key={f.id || f.number} className="ebo-track">
                            {f.number ? <a className="ebl-link ebl-sku" href={trackUrl(f.number, f.carrier)} target="_blank" rel="noreferrer">{f.number}</a> : <span className="muted">no number</span>}
                            <span className="muted xs">{[f.carrier, f.shipped_at ? `shipped ${estDate(f.shipped_at)}` : null].filter(Boolean).join(' · ')}</span>
                            {(f.status || f.detail) && <span className="xs">{f.status}{f.detail ? ` — ${f.detail}` : ''}</span>}
                          </div>
                        )) : <span className="muted">—</span>}
                      </td>
                      <td data-label="Status"><span className={`ebo-chip ${tone}`}>{label}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
const ORDER = ['late', 'late_delivery', 'due_today', 'to_ship', 'shipped', 'delivered', 'cancelled'];
const rank = (o) => ORDER.indexOf(o.state);
