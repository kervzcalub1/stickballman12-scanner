// Expected This Week: what is coming in, by supplier and by online store. The floor plans the
// week from this, so it stops at "today" and "this week" rather than a date per parcel.
import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { TopBar } from '../components/common.jsx';
import { TrackingLink } from '../components/TrackingLink.jsx';
import { useLive } from '../hooks.js';
import { estToday } from '../lib/format.js';
import { useQueryParam } from '../lib/urlstate.js';
import { EXPECTED_COLUMNS, expectedDashboard } from '../lib/expected.js';

const pairsWord = (c) => {
  if (!c.pairs && c.unknownPairs) return 'pairs not known';
  const more = c.unknownPairs ? '+' : '';
  return `${c.pairs}${more} ${c.pairs === 1 && !more ? 'pair' : 'pairs'}`;
};
const COLUMN_WORD = Object.fromEntries(EXPECTED_COLUMNS.map((c) => [c.key, c.label]));

function Tile({ title, suppliers, stores, late = false }) {
  return (
    <div className={`exp-tile${late ? ' exp-tile-late' : ''}`}>
      <div className="exp-tile-title">{title}</div>
      <div className="exp-tile-row"><span className="muted">Suppliers</span> <b>{suppliers.count}</b> {suppliers.count === 1 ? 'box' : 'boxes'}{suppliers.count > 0 && <span className="muted"> · {pairsWord(suppliers)}</span>}</div>
      <div className="exp-tile-row"><span className="muted">Online</span> <b>{stores.count}</b> {stores.count === 1 ? 'parcel' : 'parcels'}{stores.count > 0 && <span className="muted"> · {pairsWord(stores)}</span>}</div>
    </div>
  );
}

const both = (a, b) => ({ count: a.count + b.count, pairs: a.pairs + b.pairs, unknownPairs: a.unknownPairs + b.unknownPairs });

function Side({ title, unit, side, empty, open, onOpen, kind }) {
  return (
    <section className="card exp-side" data-side={kind}>
      <h2 className="bc-h">{title}</h2>
      {!side.groups.length && <p className="muted sm">{empty}</p>}
      {side.groups.length > 0 && (
        <div className="bc-scroll">
          <table className="table exp-table">
            <thead>
              <tr>
                <th>{unit}</th>
                {EXPECTED_COLUMNS.map((c) => <th key={c.key}>{c.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {side.groups.map((g) => {
                const key = `${kind}:${g.name}`;
                const isOpen = open === key;
                return (
                  <React.Fragment key={key}>
                    <tr className="exp-row" onClick={() => onOpen(isOpen ? '' : key)}>
                      <td>
                        <button type="button" className="exp-name" aria-expanded={isOpen}>{isOpen ? '▾' : '▸'} {g.name}</button>
                      </td>
                      {EXPECTED_COLUMNS.map((c) => {
                        const v = g.cols[c.key];
                        return (
                          <td key={c.key} className={v.count && (c.key === 'overdue' || c.key === 'delayed') ? 'exp-late' : ''}>
                            {v.count ? <><b>{v.count}</b><div className="muted xs">{pairsWord(v)}</div></> : <span className="muted">–</span>}
                          </td>
                        );
                      })}
                    </tr>
                    {isOpen && (
                      <tr className="exp-detail">
                        <td colSpan={EXPECTED_COLUMNS.length + 1}>
                          <ul>
                            {g.items.map((it) => (
                              <li key={it.id}>
                                <b>{it.code}</b>
                                {it.box_number != null && <span className="muted"> · box {it.box_number}</span>}
                                <span className={it.delayedDays != null ? 'exp-late' : 'muted'}> · {it.delayedDays != null ? `Delayed, no movement in ${it.delayedDays} days` : COLUMN_WORD[it.column]}</span>
                                {Number(it.pairs) > 0 && <span className="muted"> · {it.pairs} {Number(it.pairs) === 1 ? 'pair' : 'pairs'}</span>}
                                <span> · </span>
                                {it.tracking_number
                                  ? <TrackingLink number={it.tracking_number} carrier={it.carrier}>{it.tracking_number}</TrackingLink>
                                  : <span className="muted">no tracking yet</span>}
                              </li>
                            ))}
                          </ul>
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
    </section>
  );
}

export function Expected({ onHome, onSignOut }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useQueryParam('open', '');

  useEffect(() => {
    let on = true;
    api.expected().then((r) => { if (on) setData(r); }).catch((e) => {
      if (e.unauthorized) return onSignOut();
      if (on) setError(e.message);
    });
    return () => { on = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useLive(['purchase_orders', 'po_boxes', 'po_lines', 'batches', 'batch_boxes', 'online_orders', 'online_order_lines', 'shipment_tracking'],
    async () => setData(await api.expected()), { mount: false, minGap: 5000 });

  const board = data ? expectedDashboard(data, estToday()) : null;
  const s = board?.suppliers.total;
  const o = board?.stores.total;

  return (
    <div className="app">
      <TopBar title="Expected This Week" onHome={onHome} onSignOut={onSignOut} />
      {error && <p className="error">{error}</p>}
      {!data && !error && <p className="muted">Loading…</p>}
      {board && (
        <>
          <div className="exp-tiles">
            <Tile title="Today" suppliers={s.today} stores={o.today} />
            <Tile title="This whole week" suppliers={both(s.today, s.week)} stores={both(o.today, o.week)} />
            {s.delayed.count + o.delayed.count > 0 && <Tile title="Delayed: no movement in 7+ days" suppliers={s.delayed} stores={o.delayed} late />}
          </div>
          <p className="muted sm exp-note">
            The week is today and the next 7 days, from the carrier’s own estimate. A parcel the carrier
            hasn’t given a date for is under <b>No date yet</b>, not left out.
          </p>
          <Side title="From suppliers" unit="Supplier" kind="supplier" side={board.suppliers} open={open} onOpen={setOpen}
            empty="Nothing is on its way from a supplier." />
          <Side title="From online stores" unit="Store" kind="store" side={board.stores} open={open} onOpen={setOpen}
            empty="Nothing is on its way from an online store." />
        </>
      )}
    </div>
  );
}
