// "I need a box for a size 10.5 Panda" — what empty shoe boxes we hold.
//
// This is the question the warehouse actually asks, and it is asked by SIZE, not by
// carton: the dimensions are what you read once you've found the row, so they identify
// the row rather than filter it. Grouped by shoe → size → carton, because thirty
// identical boxes are one line of stock, not thirty things to scroll past.
//
// Empty boxes are bought on a purchase order marked "Empty boxes" and received through
// the normal Receiving wizard (docs/context/purchase-orders.md); a box that has gone onto
// a pair is `used` and drops out of here. Read-only — a box is SPENT from the No Box
// queue, next to the pair that needs it, which is the only place you know it fits.
import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { TopBar } from '../components/common.jsx';
import { Icon } from '../components/NavIcons.jsx';
import { useQueryParam } from '../lib/urlstate.js';
import { compareSizes } from '../lib/codes.js';

export function BoxStock({ onHome, onSignOut }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  // In the URL so "we have none of these" can be pasted to whoever is asking.
  const [sku, setSku] = useQueryParam('sku');
  const [size, setSize] = useQueryParam('size');
  const [q, setQ] = useState('');

  useEffect(() => {
    setRows(null);
    api.boxStock({ sku, size })
      .then((r) => setRows(r.rows || []))
      .catch((e) => { if (e.unauthorized) return onSignOut(); setError(e.message); });
  }, [sku, size]); // eslint-disable-line react-hooks/exhaustive-deps

  // Free-text narrowing over what's on screen — the server filter is the exact one
  // (SKU / size); this is for "show me the Dunks" without typing a style code.
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return rows || [];
    return (rows || []).filter((r) => `${r.name || ''} ${r.sku || ''} ${r.dimensions || ''}`.toLowerCase().includes(needle));
  }, [rows, q]);

  const total = (shown || []).reduce((n, r) => n + (r.qty || 0), 0);
  const byShoe = useMemo(() => {
    const m = new Map();
    for (const r of shown) {
      const k = r.sku || r.name || '—';
      if (!m.has(k)) m.set(k, { sku: r.sku, name: r.name, rows: [] });
      m.get(k).rows.push(r);
    }
    for (const g of m.values()) g.rows.sort((a, b) => compareSizes(a.size, b.size));
    return [...m.values()].sort((a, b) => String(a.name || a.sku).localeCompare(String(b.name || b.sku)));
  }, [shown]);

  const clear = () => { setSku(''); setSize(''); setQ(''); };
  const filtering = !!(sku || size || q);

  return (
    <div className="app">
      <TopBar title="Empty Box Stock" onHome={onHome} onSignOut={onSignOut} />
      <div className="wrap-narrow">
        <p className="muted sm">
          The empty shoe boxes we hold, for pairs that arrived crushed or with no box. Bought on a
          purchase order marked <b>Empty boxes</b>. To put one on a pair, use <b>Use a box from stock</b>
          {' '}in the <b>No Box</b> queue — that's where we know it fits.
        </p>
        {error && <div className="po-err">{error}</div>}

        <div className="po-ov-filters">
          <label className="po-ov-search"><span className="muted xs">Shoe</span>
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="Name, SKU or carton size" aria-label="Filter by name, SKU or carton" /></label>
          <label><span className="muted xs">SKU</span>
            <input value={sku} onChange={(e) => setSku(e.target.value)} placeholder="e.g. DD1391-100"
              autoCapitalize="characters" autoCorrect="off" /></label>
          <label><span className="muted xs">Size</span>
            <input value={size} onChange={(e) => setSize(e.target.value)} placeholder="e.g. 10.5" inputMode="decimal" /></label>
          {filtering && <button className="btn sm ghost" onClick={clear}>Clear</button>}
        </div>

        {rows == null ? <p className="muted">Loading…</p>
          : rows.length === 0 && !filtering ? (
            <div className="card empty-state">
              No empty boxes in stock. They arrive on a purchase order raised as <b>Empty boxes</b> and are
              counted in through <b>Receive New</b> like any other shipment.
            </div>
          )
          : shown.length === 0 ? (
            <div className="card empty-state">
              Nothing matches that. <button className="btn sm ghost" onClick={clear}>Clear filters</button>
            </div>
          ) : (
            <>
              <div className="muted sm po-ov-count">
                <b>{total}</b> box{total === 1 ? '' : 'es'} on hand across {shown.length} line{shown.length === 1 ? '' : 's'}
              </div>
              {byShoe.map((g) => (
                <div className="card boxstock-shoe" key={g.sku || g.name}>
                  <div className="po-card-top">
                    <h3 className="rows-title">{g.name || g.sku}</h3>
                    <span className="muted sm">{g.sku}</span>
                  </div>
                  <ul className="po-lines">
                    {g.rows.map((r) => (
                      <li key={`${r.size}|${r.dimensions}`}>
                        <span className="po-line-name">
                          US {r.size} <span className="po-size-dims">{r.dimensions || 'no dimensions'}</span>
                        </span>
                        <span className="po-line-meta">
                          {/* Where they physically are. A box still 'needs_shelf' has not
                              been put away yet, which is a different errand from finding
                              one — so say which, rather than showing a blank. */}
                          {(r.locations || []).length
                            ? <><Icon name="pin" /> {(r.locations || []).join(', ')}</>
                            : <span className="muted">not shelved yet</span>}
                          {r.shelved > 0 && r.shelved < r.qty ? ` · ${r.qty - r.shelved} still to shelve` : ''}
                        </span>
                        <span className="boxstock-qty">{r.qty}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </>
          )}
      </div>
    </div>
  );
}
