// Cost lookup — the Costs page's third tab (docs/context/costs.md → "Cost lookup").
//
// Search a SKU (or a shoe name) and see every time we bought it, from BOTH ways we buy:
// supplier PO lines (shelf price → landed cost through the supplier's preset) and PH's
// online orders (the actual cost per pair). One spreadsheet: sortable columns, a filter
// per source, a per-size summary on top, and a CSV of exactly what's on screen.
// Read-only — fixing a pair's cost is the other two tabs' job.
import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Icon } from './NavIcons.jsx';
import { useLive } from '../hooks.js';
import { useQueryParam } from '../lib/urlstate.js';
import { estToday, estCivilFromYmd, PH_DATE } from '../lib/format.js';
import { sizeLabel } from '../lib/codes.js';
import { downloadCSV } from '../lib/csv.js';
import { sizeSummary, sortCostRows, costLookupCsv, SOURCE_LABEL, bareCode } from '../lib/costLookup.js';

const usd = (v) => (v == null || !Number.isFinite(Number(v)) ? '' : `$${Number(v).toFixed(2)}`);
const day = (ymd) => {
  if (!ymd) return '—';
  try { return PH_DATE.format(estCivilFromYmd(ymd)); } catch { return ymd; }
};

const COLS = [
  ['bought_on', 'Bought'], ['source', 'Source'], ['ref', 'Order'], ['party', 'Supplier / store'],
  ['sku', 'SKU'], ['name', 'Shoe'], ['size', 'Size'], ['qty', 'Pairs', 'num'],
  ['paid', 'Price paid ea', 'num'], ['cost', 'Actual cost ea', 'num'], ['status', 'Status'],
];

export function CostLookup({ onSignOut }) {
  const [query, setQuery] = useQueryParam('lq');
  const [srcRaw, setSrc] = useQueryParam('src', 'all');
  const src = srcRaw === 'po' || srcRaw === 'online' ? srcRaw : 'all';
  const [searched, setSearched] = useState(null);   // the term loaded ('' = newest lines)
  const [rows, setRows] = useState(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState('');
  const [sort, setSort] = useState({ key: 'bought_on', dir: 'desc' });
  const [openNote, setOpenNote] = useState(null);   // row index whose breakdown is shown

  // Only the LATEST request may land: a search typed while the opening "newest lines"
  // list is still loading must not be overwritten when that slower answer arrives.
  const seq = useRef(0);
  async function load(term) {
    const n = ++seq.current;
    setError(''); setRows(null);
    try {
      const r = await api.costLookup(term);
      if (n !== seq.current) return;
      setRows(r.rows || []); setTruncated(!!r.truncated); setSearched(term);
    } catch (err) {
      if (n !== seq.current) return;
      if (err.unauthorized) return onSignOut();
      setError(err.message); setRows([]);
    }
  }
  // Arrive with ?lq= (a refresh, a shared link) → run it; else the newest purchases.
  useEffect(() => { load(query.trim()); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // A price typed on a PO or an online order elsewhere shows up without a refresh.
  useLive(['po_lines', 'purchase_orders', 'online_orders', 'online_order_lines'], async () => {
    if (searched == null) return;
    const n = seq.current;
    const r = await api.costLookup(searched);
    if (n !== seq.current) return;
    setRows(r.rows || []); setTruncated(!!r.truncated);
  }, { mount: false, paused: rows == null });

  function submit(e) {
    e.preventDefault();
    setOpenNote(null);
    load(query.trim());
  }
  function clear() { setQuery(''); load(''); }

  const all = rows || [];
  const counts = { all: all.length, po: all.filter((r) => r.source === 'po').length, online: all.filter((r) => r.source === 'online').length };
  const shown = sortCostRows(src === 'all' ? all : all.filter((r) => r.source === src), sort.key, sort.dir);
  const summary = searched ? sizeSummary(shown) : [];
  const manySkus = new Set(summary.map((s) => bareCode(s.sku))).size > 1;
  const pairs = shown.reduce((n, r) => n + (Number(r.qty) || 0), 0);
  const uncosted = shown.filter((r) => r.cost == null).length;

  const sortBy = (key) => { setOpenNote(null); setSort((s) => (s.key === key
    ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
    : { key, dir: key === 'bought_on' || key === 'cost' || key === 'paid' ? 'desc' : 'asc' })); };

  function downloadCsv() {
    const name = searched ? searched.replace(/[^A-Za-z0-9-]+/g, '_') : 'recent';
    downloadCSV(`costs-${name}-${estToday()}.csv`, costLookupCsv(shown));
  }

  return (
    <div className="cl">
      <p className="muted sm cl-intro">
        Search a SKU to see every time we bought it — from <b>supplier POs</b> and <b>online orders</b> —
        and what one pair actually cost us.
      </p>
      <details className="cl-how sm">
        <summary>How “Actual cost ea” is worked out</summary>
        <ul>
          <li><b>Supplier PO</b> — the shelf price on the PO through the supplier’s preset (tax, gift card,
            tip, shipping), the same maths receiving uses. No preset linked → no cost.</li>
          <li><b>Online order</b> — the price, less its share of the coupon, plus its share of tax and
            shipping, less the gift card % and cashback %.</li>
          <li>Cancelled and not-delivered pairs are left out. A blank means it can’t be known yet — not $0.
            Tap or hover a cost to see how it was worked out.</li>
        </ul>
      </details>

      <form className="cost-search" onSubmit={submit}>
        <input
          className="cost-search-input"
          placeholder="Search a SKU or shoe name — e.g. DZ5485-612"
          value={query} onChange={(e) => setQuery(e.target.value)}
          aria-label="Search a SKU or shoe name"
        />
        <button className="btn sm primary" type="submit"><Icon name="search" /> Find</button>
        {searched && <button className="btn sm ghost" type="button" onClick={clear}>Clear</button>}
      </form>

      <div className="cl-bar">
        <div className="seg sm" role="tablist" aria-label="Where it was bought">
          {[['all', 'All'], ['po', 'Supplier POs'], ['online', 'Online orders']].map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={src === k}
              className={`seg-btn${src === k ? ' on' : ''}`} onClick={() => setSrc(k)}>
              {label}{rows ? <span className="seg-n" aria-hidden="true">{counts[k]}</span> : null}
            </button>
          ))}
        </div>
        <button className="btn sm ghost" type="button" onClick={downloadCsv} disabled={!shown.length}>
          <Icon name="download" /> CSV
        </button>
      </div>

      {error && <div className="error mt">{error}</div>}

      {rows == null ? <p className="muted">Loading…</p> : !shown.length ? (
        <p className="muted">
          {all.length ? `No ${src === 'po' ? 'supplier PO' : 'online order'} lines${searched ? ` for “${searched}”` : ''} — try All.`
            : searched ? `Nothing bought matching “${searched}”.` : 'No purchases on file yet.'}
        </p>
      ) : (
        <>
          <p className="muted sm cl-count">
            {searched ? <>Showing <b>{shown.length}</b> line{shown.length === 1 ? '' : 's'} for <b>{searched}</b></>
              : <>The newest <b>{shown.length}</b> purchase line{shown.length === 1 ? '' : 's'} — search a SKU to see its full history</>}
            {' '}· {pairs} pair{pairs === 1 ? '' : 's'}
            {uncosted > 0 && <> · <b>{uncosted}</b> without a cost</>}
            {truncated && searched && <> · <b>more matches than shown</b> — type more of the SKU</>}
          </p>

          {summary.length > 0 && (
            <div className="cl-summary">
              <div className="cl-summary-head sm">Cost by size</div>
              <table className="und-table cl-table">
                <thead>
                  <tr>
                    {manySkus && <th>SKU</th>}
                    <th>Size</th><th className="num">Latest cost</th><th className="num">Lowest – highest</th>
                    <th className="num">Average ea</th><th className="num">Pairs bought</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.map((s) => (
                    <tr key={s.key}>
                      {manySkus && <td data-label="SKU"><code>{s.sku}</code></td>}
                      <td data-label="Size">US {sizeLabel(s.size, s.gender, s.name)}</td>
                      <td data-label="Latest cost" className="num">
                        {s.latest == null ? <span className="muted">no cost</span>
                          : <><b>{usd(s.latest)}</b> <span className="muted sm">{day(s.latestOn)} · {s.latestSource === 'po' ? 'PO' : 'online'}</span></>}
                      </td>
                      <td data-label="Lowest – highest" className="num">
                        {s.min == null ? '—' : s.min === s.max ? usd(s.min) : `${usd(s.min)} – ${usd(s.max)}`}
                      </td>
                      <td data-label="Average ea" className="num">{s.avg == null ? '—' : usd(s.avg)}</td>
                      <td data-label="Pairs bought" className="num">
                        {s.pairs}{s.costedPairs < s.pairs ? <span className="muted sm"> ({s.pairs - s.costedPairs} no cost)</span> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="cl-scroll">
            <table className="und-table cl-table cl-sheet">
              <thead>
                <tr>
                  {COLS.map(([k, label, cls]) => (
                    <th key={k} className={cls || ''} aria-sort={sort.key === k ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                      <button type="button" className="cl-sort" onClick={() => sortBy(k)}>
                        {label}{sort.key === k ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((r, i) => (
                  <tr key={`${r.source}|${r.ref}|${r.sku}|${r.size}|${r.paid}|${i}`}>
                    <td data-label="Bought">{day(r.bought_on)}</td>
                    <td data-label="Source"><span className={`cl-src ${r.source}`}>{SOURCE_LABEL[r.source] || r.source}</span></td>
                    <td data-label="Order"><code>{r.ref}</code></td>
                    <td data-label="Supplier / store">{r.party || '—'}</td>
                    <td data-label="SKU"><code>{r.sku || '—'}</code></td>
                    <td data-label="Shoe">{r.name || '—'}</td>
                    <td data-label="Size">{r.size ? sizeLabel(r.size, r.gender, r.name) : '—'}</td>
                    <td data-label="Pairs" className="num">{r.qty}</td>
                    <td data-label="Price paid ea" className="num">{r.paid == null ? <span className="muted">—</span> : usd(r.paid)}</td>
                    <td data-label="Actual cost ea" className="num">
                      {r.cost == null ? (
                        <span>
                          <span className="cl-nocost">no cost</span>
                          {r.note && <span className="muted cl-note">{r.note}</span>}
                        </span>
                      ) : (
                        <button type="button" className="cl-cost" title={r.note || ''}
                          aria-expanded={openNote === i} onClick={() => setOpenNote(openNote === i ? null : i)}>
                          <b>{usd(r.cost)}</b>
                          {openNote === i && r.note && <span className="muted cl-note">{r.note}</span>}
                        </button>
                      )}
                    </td>
                    <td data-label="Status">{r.status || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
