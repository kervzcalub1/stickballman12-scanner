// In-Store Listing worklist (Step 2). In-store buys bypass the PH team — they're
// listed to the stores BY HAND — so admin/warehouse track which pairs have been
// listed to Alias / StockX / Shopify here. Grouped by SKU (you list a SKU once,
// covering all its sizes); each store is an independent toggle applied to the
// whole SKU group. A group drops off the "Needs listing" view once all three
// stores are ticked. Read/edit is warehouse + admin only (ph_team never sees it).
import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { TopBar, DateRangeBar, ShoeThumb, StatusPill } from '../components/common.jsx';
import { Icon } from '../components/NavIcons.jsx';
import { rangeOf } from '../lib/format.js';

const STORES = [['alias', 'Alias'], ['stockx', 'StockX'], ['shopify', 'Shopify']];

// Group the flat per-VIN rows by SKU. Since this page is the only writer of the
// listing flags and always toggles a whole SKU group at once, every VIN in a
// group shares the same flags — so `every` reflects the group's true state.
function groupBySku(rows) {
  const map = new Map();
  for (const r of rows) {
    const key = r.sku || `∅|${r.name || ''}`;
    let g = map.get(key);
    if (!g) { g = { key, sku: r.sku, name: r.name, photo_url: r.photo_url, origin: r.origin, rows: [], _sizes: {} }; map.set(key, g); }
    g.rows.push(r);
    const sz = r.size || '—';
    g._sizes[sz] = (g._sizes[sz] || 0) + 1;
    if (r.created_at > (g.created_at || '')) g.created_at = r.created_at;
  }
  return [...map.values()].map((g) => ({
    ...g,
    vins: g.rows.map((r) => r.vin),
    qty: g.rows.length,
    statuses: [...new Set(g.rows.map((r) => r.status))],
    sizes: Object.entries(g._sizes).sort((a, b) => String(a[0]).localeCompare(b[0], undefined, { numeric: true })),
    flags: {
      alias: g.rows.every((r) => r.instore_listed_alias),
      stockx: g.rows.every((r) => r.instore_listed_stockx),
      shopify: g.rows.every((r) => r.instore_listed_shopify),
    },
  }));
}

export function InstoreListing({ onHome, onSignOut }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [dr, setDr] = useState(() => ({ mode: 'month', anchor: new Date() }));
  // Default OFF so staff see ALL in-store buys (and their statuses) at a glance;
  // ticking it narrows to only pairs still needing store listing.
  const [needsOnly, setNeedsOnly] = useState(false);
  const [savingSku, setSavingSku] = useState(null);

  async function load() {
    setError('');
    try { const [from, to] = rangeOf(dr.mode, dr.anchor); const { rows: r } = await api.instoreList(from, to); setRows(r); }
    catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
  }
  useEffect(() => { load(); }, [dr]); // eslint-disable-line react-hooks/exhaustive-deps

  const groups = useMemo(() => {
    const g = groupBySku(rows || []);
    const shown = needsOnly ? g.filter((x) => !(x.flags.alias && x.flags.stockx && x.flags.shopify)) : g;
    return shown.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  }, [rows, needsOnly]);

  // Toggle one store for a whole SKU group — send the full desired triple so the
  // update is race-free, then reflect it locally on every VIN in the group.
  async function toggleStore(g, store) {
    const next = { ...g.flags, [store]: !g.flags[store] };
    setSavingSku(g.key); setError('');
    try {
      await api.instoreListed(g.vins, next);
      setRows((rs) => rs.map((r) => (g.vins.includes(r.vin)
        ? { ...r, instore_listed_alias: next.alias, instore_listed_stockx: next.stockx, instore_listed_shopify: next.shopify }
        : r)));
    } catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setSavingSku(null); }
  }

  const totalUnlisted = useMemo(() => groupBySku(rows || [])
    .filter((x) => !(x.flags.alias && x.flags.stockx && x.flags.shopify)).length, [rows]);

  return (
    <div className="app">
      <TopBar title="In-Store Listing" onHome={onHome} onSignOut={onSignOut} />
      <div className="card">
        <p className="muted sm">
          In-store buys are listed to the stores <b>by hand</b> (they skip the PH team). Tick each store as you list a
          SKU. A pair drops off once Alias, StockX &amp; Shopify are all ticked.
        </p>
        <DateRangeBar mode={dr.mode} anchor={dr.anchor} onChange={(mode, anchor) => setDr({ mode, anchor })} />
        <div className="istore-filterbar">
          <span className="muted sm">{totalUnlisted} SKU{totalUnlisted === 1 ? '' : 's'} still need listing</span>
          <label className="check-pill"><input type="checkbox" checked={needsOnly} onChange={(e) => setNeedsOnly(e.target.checked)} /> Needs listing only</label>
        </div>
        {error && <div className="error mt">{error}</div>}
        {!rows ? <p className="muted">Loading…</p>
          : !groups.length ? <p className="ok">{needsOnly ? 'All in-store pairs are listed everywhere ✓' : 'No in-store pairs in this range.'}</p>
            : (
              <>
                <div className="istore-list">
                  {groups.map((g) => {
                    const done = g.flags.alias && g.flags.stockx && g.flags.shopify;
                    return (
                      <div className={`istore-row ${done ? 'done' : ''}`} key={g.key}>
                        <div className="istore-main">
                          <ShoeThumb url={g.photo_url} size={40} />
                          <div className="istore-info">
                            <div className="istore-name">{g.name || '—'}</div>
                            <div className="istore-sub muted sm">
                              <span className="istore-sku">{g.sku || '—'}</span>
                              <span> · ×{g.qty}</span>
                              {g.origin ? <span> · {g.origin}</span> : null}
                            </div>
                            <div className="istore-meta">
                              {g.statuses.map((s) => <StatusPill status={s} key={s} />)}
                              {g.sizes.map(([sz, n]) => <span className="istore-size" key={sz}>{sz}<span className="muted">×{n}</span></span>)}
                            </div>
                          </div>
                        </div>
                        <div className="istore-toggles" role="group" aria-label="Listed to stores">
                          {STORES.map(([k, label]) => (
                            <button key={k} type="button"
                              className={`istore-toggle ${g.flags[k] ? 'on' : ''}`}
                              disabled={savingSku === g.key}
                              aria-pressed={g.flags[k]}
                              onClick={() => toggleStore(g, k)}>
                              {g.flags[k] ? <Icon name="report" /> : null}{label}
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
      </div>
    </div>
  );
}
