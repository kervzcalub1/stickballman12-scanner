// POIZON Orders (docs/context/poizon-orders.md) — /poizon (admin), /ph/poizon (PH). POIZON sales
// land in Shopify as orders made by the "POIZON" app; the server keeps a copy of them
// (poizon_orders, read every 10 minutes on the live server). This page only watches: every order
// with its pairs and where it stands (to ship · shipped · cancelled), and a pick list — tick the
// orders, Download a 4 x 6 in PDF (src/lib/pickList.js), the same label eBay and SHEIN print.
// Read-only: nothing here changes Shopify or POIZON.
import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { TopBar } from '../components/common.jsx';
import { TrackingLink } from '../components/TrackingLink.jsx';
import { useLive } from '../hooks.js';
import { useQueryParam } from '../lib/urlstate.js';
import { estToday, PH_DATETIME } from '../lib/format.js';
import { poizonOrdersSorted, poizonPickEntries, poizonLineShoe, poizonToShip, POIZON_ORDER_STATES, POIZON_AWAITING, POIZON_ORDER_RANK } from '../lib/pickList.js';
import { PickListBar } from '../components/PickListBar.jsx';

const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const when = (iso) => (iso ? `${PH_DATETIME.format(new Date(iso))} EST` : '—');
const addDays = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const RANGES = [['7', 'Last 7 days'], ['30', 'Last 30 days'], ['60', 'Last 60 days']];
const FILTERS = ['all', ...POIZON_ORDER_RANK];
const RUNNING_STALE_MS = 10 * 60 * 1000;

export function PoizonOrders({ onHome, onSignOut }) {
  const [range, setRange] = useQueryParam('days', '30');
  const [filter, setFilter] = useQueryParam('state', 'to_ship');
  const [q, setQ] = useQueryParam('q', '');
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState(() => new Set());
  const today = estToday();
  const from = addDays(today, -Number(range || 30));

  async function load() {
    try { setData(await api.poizonOrders(from, today)); setErr(''); }
    catch (e) { if (e.unauthorized) onSignOut(); else setErr(e.message); }
  }
  useEffect(() => { load(); }, [range]); // eslint-disable-line react-hooks/exhaustive-deps
  useLive(['poizon_orders', 'app_settings'], load, { mount: false });

  const sync = data?.sync || null;
  const running = sync?.state === 'running' && Date.now() - Date.parse(sync.startedAt) < RUNNING_STALE_MS;
  async function checkNow() {
    setBusy(true); setErr('');
    try { await api.poizonOrdersSync(); await load(); }
    catch (e) { if (e.unauthorized) onSignOut(); else setErr(e.message); }
    finally { setBusy(false); }
  }

  const orders = useMemo(() => poizonOrdersSorted(data?.orders || []), [data]);
  const counts = useMemo(() => {
    const c = { all: orders.length };
    for (const o of orders) c[o.state] = (c[o.state] || 0) + 1;
    return c;
  }, [orders]);
  const shown = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return orders.filter((o) => (filter === 'all' || o.state === filter)
      && (!words.length || words.every((w) => [o.order_no, ...(o.tracking || []).map((t) => t.number), ...(o.lines || []).flatMap((l) => { const s = poizonLineShoe(l); return [s.name, s.sku, s.size, l.sku]; })]
        .join(' ').toLowerCase().includes(w))));
  }, [orders, filter, q]);
  const pickable = (o) => o.state === 'to_ship' && (o.lines || []).some((l) => poizonToShip(l) > 0);
  const pickedOrders = useMemo(() => orders.filter((o) => picked.has(o.order_no) && pickable(o)), [orders, picked]);
  const pickedPairs = useMemo(() => poizonPickEntries(pickedOrders).length, [pickedOrders]);
  const awaiting = useMemo(() => orders.filter((o) => POIZON_AWAITING.has(o.state) && pickable(o)), [orders]);
  const shownPickable = shown.filter(pickable);
  const allShownPicked = shownPickable.length > 0 && shownPickable.every((o) => picked.has(o.order_no));
  const toggle = (id) => setPicked((cur) => { const n = new Set(cur); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const setMany = (list, on) => setPicked((cur) => { const n = new Set(cur); for (const o of list) { if (on) n.add(o.order_no); else n.delete(o.order_no); } return n; });

  const never = data && !sync?.lastAt && !running;
  return (
    <div className="app">
      <TopBar title="POIZON Orders" onHome={onHome} onSignOut={onSignOut} />
      {err && <div className="error mt" role="alert">Couldn’t read POIZON orders: {err}</div>}
      <div className="card" data-poizon-orders="">
        <p className="muted sm">Every POIZON order, read from Shopify (the orders made by the POIZON app). Tick the ones to pick and download the pick list. This page only watches: nothing here changes Shopify or POIZON.</p>
        <div className="pzo-sync">
          <button type="button" className="btn sm" disabled={busy || running || data?.configured === false} onClick={checkNow}>{running ? 'Reading Shopify…' : '↻ Check now'}</button>
          <span className="muted xs" data-poizon-sync="">
            {data?.configured === false ? 'Shopify isn’t set up on this server.'
              : running ? `Reading Shopify’s orders… ${fmt(sync.read)} read, ${fmt(sync.found)} POIZON so far.`
              : sync?.state === 'error' ? `The last check failed: ${sync.error}${sync.lastAt ? ` Last good check ${when(sync.lastAt)}.` : ''}`
              : sync?.lastAt ? `Last checked ${when(sync.lastAt)}.${sync.more ? ' Still catching up on older orders.' : ''}${data?.auto ? ' Checked every 10 minutes.' : ' Not checked automatically on this server.'}`
              : data ? 'Not read yet. Press Check now: the first read covers the last 30 days and takes a minute or two.' : ''}
          </span>
        </div>
        <div className="ebl-filters">
          <input type="search" className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search order #, shoe, SKU, size, tracking…" aria-label="Search POIZON orders" />
          <select className="input ebo-range" value={range} onChange={(e) => setRange(e.target.value)} aria-label="Orders from">
            {RANGES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </div>
        <div className="seg sm ebo-filters">
          {FILTERS.map((k) => (
            <button key={k} type="button" className={`seg-btn${filter === k ? ' on' : ''}`} aria-pressed={filter === k}
              onClick={() => setFilter(k)}>{k === 'all' ? 'All' : POIZON_ORDER_STATES[k][0]} <span className="seg-n">{fmt(counts[k] || 0)}</span></button>
          ))}
        </div>
        <p className="muted xs">Orders sold in the period, plus every order still to ship. “Shipped” means the order is marked fulfilled in Shopify.</p>
        {!!orders.length && (
          <PickListBar platform="poizon" picked={pickedOrders.length} pairs={pickedPairs} awaiting={awaiting.length}
            onSelectAwaiting={() => setMany(awaiting, true)} onClear={() => setPicked(new Set())} entries={() => poizonPickEntries(pickedOrders)} />
        )}
        {!data && !err ? <p className="muted">Loading…</p> : !shown.length ? (
          <p className="muted">{never ? 'No POIZON orders read yet.' : !orders.length ? 'No POIZON orders in this period.' : filter === 'to_ship' && !q.trim() ? 'Nothing to ship right now.' : 'Nothing matches.'}</p>
        ) : (
          <div className="ap-tablewrap">
            <table className="table ebo-table sho-table">
              <thead><tr><th className="pk-cell"><input type="checkbox" className="pk-check" aria-label="Select every order shown" checked={allShownPicked}
                disabled={!shownPickable.length} onChange={(e) => setMany(shownPickable, e.target.checked)} /></th><th>Order</th><th>Shoe</th><th>Status</th></tr></thead>
              <tbody>
                {shown.map((o) => {
                  const [label, tone] = POIZON_ORDER_STATES[o.state];
                  const can = pickable(o);
                  const pairs = (o.lines || []).reduce((n, l) => n + (Number(l.qty) || 0), 0);
                  return (
                    <tr key={o.shopify_order_id} className={`ebo-row ${tone === 'warn' ? tone : ''}${picked.has(o.order_no) && can ? ' pk-on' : ''}`} data-order={o.order_no}>
                      <td className="pk-cell">
                        <input type="checkbox" className="pk-check" aria-label={`Pick order ${o.order_no}`} checked={picked.has(o.order_no) && can}
                          disabled={!can} title={can ? undefined : 'Nothing to pick on this order'} onChange={() => toggle(o.order_no)} />
                      </td>
                      <td data-label="Order">
                        <span className="ebl-sku">{o.order_no}</span>
                        <div className="muted xs">{when(o.ordered_at)}</div>
                        <div className="muted xs">{pairs} pair{pairs === 1 ? '' : 's'}</div>
                      </td>
                      <td data-label="Shoe">
                        {(o.lines || []).map((l, i) => {
                          const s = poizonLineShoe(l);
                          const left = poizonToShip(l);
                          const gone = (Number(l.current ?? l.qty) || 0) === 0;
                          return (
                            <div key={i} className={`ebo-line sho-line${gone ? ' sho-off' : ''}`}>
                              <span>
                                <span className="ebl-title">{s.name || '—'}</span>
                                <span className="muted xs ebo-meta">SKU <b className="ebl-sku">{s.sku || '—'}</b>{s.size ? <> · size <b>{s.size}</b></> : ''}
                                  {Number(l.qty) > 1 ? <> · qty <b>{l.qty}</b></> : ''}
                                  {gone ? ' · refunded' : o.state === 'to_ship' && left < (Number(l.current ?? l.qty) || 0) ? ` · ${left} still to ship` : ''}</span>
                              </span>
                            </div>
                          );
                        })}
                      </td>
                      <td data-label="Status">
                        <span className={`ebo-chip ${tone}`}>{label}</span>
                        {(o.tracking || []).map((t) => (
                          <div key={t.number} className="muted xs pzo-track">{t.company ? `${t.company} ` : ''}<TrackingLink number={t.number} carrier={t.company}>{t.number}</TrackingLink></div>
                        ))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
