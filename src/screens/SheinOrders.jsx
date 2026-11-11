// SHEIN → Orders (docs/context/shein-live-fix.md → "Orders + pick list"). Every SHEIN order the sales
// sync has recorded, one row per order with its pairs and SHEIN's own state in plain words (new order,
// to ship, waiting for pick-up, shipped …). Tick the orders to pick → Download pick list (a 4 x 6 in
// PDF, src/lib/pickList.js). Read-only, from shein_order_units: no SHEIN call per view.
import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useLive } from '../hooks.js';
import { useQueryParam } from '../lib/urlstate.js';
import { estToday, PH_DATETIME } from '../lib/format.js';
import { sheinOrdersFromUnits, sheinPickEntries, sheinUnitShoe, sheinLiveUnit, SHEIN_ORDER_STATES, SHEIN_UNIT_WORDS, SHEIN_AWAITING, SHEIN_ORDER_RANK } from '../lib/pickList.js';
import { PickListBar } from '../components/PickListBar.jsx';

const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const when = (iso) => (iso ? `${PH_DATETIME.format(new Date(iso))} EST` : '—');
const addDays = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const RANGES = [['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['ytd', 'This year']];
const FILTERS = ['all', ...SHEIN_ORDER_RANK];

export function SheinOrders({ onSignOut }) {
  const [range, setRange] = useQueryParam('odays', '30');
  const [filter, setFilter] = useQueryParam('ostate', 'all');
  const [q, setQ] = useQueryParam('oq', '');
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [picked, setPicked] = useState(() => new Set());
  const today = estToday();
  const from = range === 'ytd' ? `${today.slice(0, 4)}-01-01` : addDays(today, -Number(range || 30));

  async function load() {
    try { setData(await api.sheinOrders(from, today)); setErr(''); }
    catch (e) { if (e.unauthorized) onSignOut(); else setErr(e.message); }
  }
  useEffect(() => { load(); }, [range]); // eslint-disable-line react-hooks/exhaustive-deps
  useLive(['shein_order_units'], load, { mount: false });

  const orders = useMemo(() => sheinOrdersFromUnits(data?.units || []), [data]);
  const counts = useMemo(() => {
    const c = { all: orders.length };
    for (const o of orders) c[o.state] = (c[o.state] || 0) + 1;
    return c;
  }, [orders]);
  const shown = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return orders.filter((o) => (filter === 'all' || o.state === filter)
      && (!words.length || words.every((w) => [o.order_no, ...o.units.flatMap((u) => { const s = sheinUnitShoe(u); return [s.name, s.sku, s.size, u.seller_sku, u.title]; })]
        .join(' ').toLowerCase().includes(w))));
  }, [orders, filter, q]);
  // Something to pick = at least one pair still ours to ship (not refunded, not swapped out, ships from us).
  const pickable = (o) => o.state !== 'cancelled' && o.state !== 'shein_ships' && o.units.some(sheinLiveUnit);
  const pickedOrders = useMemo(() => orders.filter((o) => picked.has(o.order_no) && pickable(o)), [orders, picked]);
  const pickedPairs = useMemo(() => sheinPickEntries(pickedOrders).length, [pickedOrders]);
  const awaiting = useMemo(() => orders.filter((o) => SHEIN_AWAITING.has(o.state) && pickable(o)), [orders]);
  const shownPickable = shown.filter(pickable);
  const allShownPicked = shownPickable.length > 0 && shownPickable.every((o) => picked.has(o.order_no));
  const toggle = (id) => setPicked((cur) => { const n = new Set(cur); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const setMany = (list, on) => setPicked((cur) => { const n = new Set(cur); for (const o of list) { if (on) n.add(o.order_no); else n.delete(o.order_no); } return n; });

  const syncOff = data && data.sync?.orders !== 'on';
  return (
    <>
      {err && <div className="error mt" role="alert">Couldn’t read SHEIN orders: {err}</div>}
      <div className="card" data-shein-orders="">
        {syncOff && <p className="notice sm">Automatic sync is off, so new SHEIN orders aren’t being recorded here. Turn it on under Automatic sync.</p>}
        <div className="ebl-filters">
          <input type="search" className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search order #, shoe, SKU, size…" aria-label="Search SHEIN orders" />
          <select className="input ebo-range" value={range} onChange={(e) => setRange(e.target.value)} aria-label="Orders from">
            {RANGES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </div>
        <div className="seg sm ebo-filters">
          {FILTERS.map((k) => (k === 'all' || counts[k]) ? (
            <button key={k} type="button" className={`seg-btn${filter === k ? ' on' : ''}`} aria-pressed={filter === k}
              onClick={() => setFilter(k)}>{k === 'all' ? 'All' : SHEIN_ORDER_STATES[k][0]} <span className="seg-n">{fmt(counts[k] || 0)}</span></button>
          ) : null)}
        </div>
        <p className="muted xs">Orders sold in the period, plus every order still waiting to go. The state is SHEIN’s own, as the sync last read it (within a minute on the live server).{data?.sync?.polledAt ? ` Last checked ${when(data.sync.polledAt)}.` : ''}</p>
        {!!orders.length && (
          <PickListBar platform="shein" picked={pickedOrders.length} pairs={pickedPairs} awaiting={awaiting.length}
            onSelectAwaiting={() => setMany(awaiting, true)} onClear={() => setPicked(new Set())} entries={() => sheinPickEntries(pickedOrders)} />
        )}
        {!data && !err ? <p className="muted">Loading…</p> : !shown.length ? <p className="muted">{orders.length ? 'Nothing matches.' : 'No SHEIN orders recorded in this period.'}</p> : (
          <div className="ap-tablewrap">
            <table className="table ebo-table sho-table">
              <thead><tr><th className="pk-cell"><input type="checkbox" className="pk-check" aria-label="Select every order shown" checked={allShownPicked}
                disabled={!shownPickable.length} onChange={(e) => setMany(shownPickable, e.target.checked)} /></th><th>Order</th><th>Shoe</th><th>Status</th></tr></thead>
              <tbody>
                {shown.map((o) => {
                  const [label, tone] = SHEIN_ORDER_STATES[o.state];
                  const can = pickable(o);
                  return (
                    <tr key={o.order_no} className={`ebo-row ${tone === 'bad' || tone === 'warn' ? tone : ''}${picked.has(o.order_no) && can ? ' pk-on' : ''}`} data-order={o.order_no}>
                      <td className="pk-cell">
                        <input type="checkbox" className="pk-check" aria-label={`Pick order ${o.order_no}`} checked={picked.has(o.order_no) && can}
                          disabled={!can} title={can ? undefined : 'Nothing to pick on this order'} onChange={() => toggle(o.order_no)} />
                      </td>
                      <td data-label="Order">
                        <span className="ebl-sku">{o.order_no}</span>
                        <div className="muted xs">{when(o.sold_at)}</div>
                        <div className="muted xs">{o.units.length} pair{o.units.length === 1 ? '' : 's'}</div>
                      </td>
                      <td data-label="Shoe">
                        {o.units.map((u) => {
                          const s = sheinUnitShoe(u);
                          const live = sheinLiveUnit(u);
                          return (
                            <div key={u.goods_id} className={`ebo-line sho-line${live ? '' : ' sho-off'}`}>
                              <span>
                                <span className="ebl-title">{s.name || '—'}</span>
                                <span className="muted xs ebo-meta">SKU <b className="ebl-sku">{s.sku || '—'}</b>{s.size ? <> · size <b>{s.size}</b></> : ''}
                                  {' · '}{[1, 3].includes(Number(u.exchange_tag ?? 1)) ? (SHEIN_UNIT_WORDS[u.unit_status] || `state ${u.unit_status}`) : 'swapped out'}</span>
                              </span>
                            </div>
                          );
                        })}
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
