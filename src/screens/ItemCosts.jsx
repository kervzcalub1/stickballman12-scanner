// Costs — fill in what a pair cost when the supplier didn't.
// (Third tab, "Cost lookup": every PO + online order line for a SKU — CostLookup.jsx.)
//
// `items.cost` is written once, at intake, and suppliers routinely leave cost off a
// PO manifest. Before this page a blank cost stayed blank forever. Two halves, both
// on one screen: a WORKLIST of everything with no cost on file (the backlog you
// clear), and a SEARCH for fixing a cost that's already there but wrong.
//
// One amount covers every pair of that size in that shipment — the same granularity
// as po_lines.unit_cost, and the same as the PH grid's per-size layout.
import React, { useEffect, useRef, useState } from 'react';
import { api, getUser } from '../api.js';
import { CostBackfill } from '../components/CostBackfill.jsx';
import { CostLookup } from '../components/CostLookup.jsx';
import { TopBar, DateRangeBar, PriceInput } from '../components/common.jsx';
import { Icon } from '../components/NavIcons.jsx';
import { usePendingCounts, useLive } from '../hooks.js';
import { rangeOf, PH_DATE, estToday } from '../lib/format.js';
import { downloadCSV } from '../lib/csv.js';
import { sizeLabel } from '../lib/codes.js';
import {
  groupCostRows, costFieldValue, costChanged,
  costExportRows, costExportCsv, NO_SUPPLIER,
} from '../lib/costs.js';
import { useQueryParam, useQueryDateRange } from '../lib/urlstate.js';

export function ItemCosts({ onHome, onSignOut }) {
  const [rows, setRows] = useState(null);
  // The backlog's suppliers and its full size, counted on the server over the whole
  // range: `rows` is the newest 5,000 only.
  const [meta, setMeta] = useState({ suppliers: [], total: 0 });
  const [exporting, setExporting] = useState(false);
  const [drafts, setDrafts] = useState({});      // `${groupKey}|${size}` -> typed string
  const [savingKey, setSavingKey] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  // Month, not Day: this is a backlog. A Day filter would read "all clear" while the
  // home badge still shows dozens waiting — the same reason No Box defaults to Month.
  // In the URL (?dm=&da=) so the refresh after a save lands on the same month.
  const [dr, setDr] = useQueryDateRange('month');
  // `?q=` seeds the search so Inventory's "Edit cost" (and a refresh) lands straight
  // on the shoe rather than on the backlog.
  const [query, setQuery] = useQueryParam('q');
  const [searched, setSearched] = useState('');  // the term actually loaded, '' = worklist
  // 'blank' = no cost on file · 'zero' = recorded as free. Two lists, not one: a $0 is
  // a claim already on file, so folding it into the backlog would assert it's a gap
  // when we don't know that. Most are blanks skipped before toCost was fixed; a few
  // may be real. See the note the page prints when this tab is open.
  const [tabRaw, setTab] = useQueryParam('tab', 'blank');
  // 'lookup' = the Cost lookup tab (src/components/CostLookup.jsx): every PO + online
  // order line for a SKU with what a pair cost — read-only, its own search (?lq=).
  const tab = tabRaw === 'zero' ? 'zero' : tabRaw === 'lookup' ? 'lookup' : 'blank'; // the URL is a pointer, not a value to trust
  const counts = usePendingCounts();
  // The two filters on the backlog (2026-11-20), both in the URL and both carried into
  // the CSV: a supplier (?sup=), and a date range typed by hand (?cf= from, ?ct= to;
  // no "to" = up to today). A typed range replaces the Day/Week/Month bar while it is on.
  const [sup, setSup] = useQueryParam('sup');
  const [cfRaw, setCf] = useQueryParam('cf');
  const [ctRaw, setCt] = useQueryParam('ct');
  const isYmd = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
  const cf = isYmd(cfRaw) ? cfRaw : '';
  const ct = cf && isYmd(ctRaw) && ctRaw >= cf ? ctRaw : '';
  const range = () => (cf ? [cf, ct || null] : rangeOf(dr.mode, dr.anchor));

  async function loadWorklist(nextTab = tab) {
    setError(''); setRows(null);
    try {
      const [from, to] = range();
      const { rows: r, suppliers, total } = await api.costsList(from, to, nextTab === 'zero' ? 'zero' : null, sup);
      setRows(r); setMeta({ suppliers: suppliers || [], total: total ?? r.length }); setDrafts({}); setSearched('');
    } catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
  }
  useEffect(() => {
    if (tab === 'lookup') return;   // the lookup loads its own rows
    // Arrived with ?q= (Inventory's "Edit cost", or a refresh mid-search): run it
    // instead of loading the backlog the person didn't ask for.
    if (!searched && query.trim() && rows === null) { runSearch(); return; }
    if (!searched) loadWorklist();
  }, [dr, tab, cf, ct, sup]); // eslint-disable-line react-hooks/exhaustive-deps

  async function runSearch(e) {
    e?.preventDefault?.();
    const q = query.trim();
    if (!q) return backToWorklist();
    setError(''); setNotice(''); setRows(null);
    try {
      const { rows: r } = await api.costsSearch(q);
      setRows(r); setDrafts({}); setSearched(q);
      if (!r.length) setNotice(`Nothing found for “${q}”.`);
    } catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
  }
  function backToWorklist() {
    setQuery(''); setSearched(''); setNotice(''); loadWorklist();
  }

  const groups = rows ? groupCostRows(rows) : null;
  const supplierOptions = searched ? [] : meta.suppliers;
  const capped = !searched && rows != null && meta.total > rows.length;   // more pairs than the page loaded
  const exportSkus = rows && !searched ? costExportRows(rows).length : 0;
  // The file is what the filters say, not what the page managed to load: when the range
  // holds more than the page's 5,000 pairs, the whole of it is fetched for the export.
  async function exportCsv() {
    if (!rows?.length || exporting) return;
    const [from, to] = range();
    setExporting(true); setError('');
    try {
      let all = rows;
      if (capped) ({ rows: all } = await api.costsList(from, to, tab === 'zero' ? 'zero' : null, sup, true));
      const slug = (v) => String(v).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const name = ['costs', tab === 'zero' ? 'at-0' : 'no-cost', sup ? slug(sup === NO_SUPPLIER ? 'no-supplier' : sup) : '',
        `${from}-to-${to || estToday()}`].filter(Boolean).join('-');
      downloadCSV(`${name}.csv`, costExportCsv(all, { zero: tab === 'zero' }));
    } catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setExporting(false); }
  }
  const draftKey = (g, s) => `${g.key}|${s.size}`;
  const draftFor = (g, s) => {
    const k = draftKey(g, s);
    return k in drafts ? drafts[k] : costFieldValue(s);
  };
  const setDraft = (g, s, v) => setDrafts((d) => ({ ...d, [draftKey(g, s)]: v }));
  const changedSizes = (g) => g.sizes.filter((s) => costChanged(draftFor(g, s), s.cost));

  // Save every changed size on one card. Each size is its own request (one amount,
  // one set of VINs) — they're applied one at a time so a rejected amount names the
  // size it came from instead of failing the whole shoe.
  async function saveGroup(g) {
    const changed = changedSizes(g);
    if (!changed.length) return;
    setSavingKey(g.key); setError(''); setNotice('');
    const saved = [];
    try {
      for (const s of changed) {
        const raw = String(draftFor(g, s)).trim();
        await api.setItemsCost(s.vins, raw === '' ? null : raw);
        saved.push(s);
        for (const v of s.vins) keptVins.current.add(v);
      }
      const pairs = saved.reduce((n, s) => n + s.qty, 0);
      setNotice(`Saved ${saved.length} size${saved.length === 1 ? '' : 's'} · ${pairs} pair${pairs === 1 ? '' : 's'} — ${g.name || g.sku}.`);
      // Reflect the save in place rather than refetching: on the worklist a fully
      // costed card would vanish mid-scroll, which loses your place and makes it
      // impossible to check what you just typed.
      setRows((rs) => (rs || []).map((r) => {
        const hit = saved.find((s) => s.vins.includes(r.vin));
        if (!hit) return r;
        const raw = String(draftFor(g, hit)).trim();
        return { ...r, cost: raw === '' ? null : Number(raw) };
      }));
      setDrafts((d) => {
        const next = { ...d };
        for (const s of saved) delete next[draftKey(g, s)];
        return next;
      });
    } catch (err) {
      if (err.unauthorized) return onSignOut();
      setError(saved.length
        ? `${err.message} — ${saved.length} size${saved.length === 1 ? '' : 's'} saved before this, the rest are unchanged.`
        : err.message);
    } finally { setSavingKey(null); }
  }

  // LIVE (docs/context/live-updates.md) — costs typed on another device, and new pairs
  // arriving without one, show up here. Two rules protect the person working the list:
  // it holds while anything is typed and unsaved (or saving), and a pair THIS person
  // just costed is kept on screen even though the backlog no longer returns it — the
  // same reason saveGroup updates in place instead of refetching (a card that vanishes
  // mid-scroll loses your place and hides what you just typed).
  const keptVins = useRef(new Set());
  useLive(['items', 'batches'], async () => {
    let r;
    if (searched) ({ rows: r } = await api.costsSearch(searched));
    else {
      const [from, to] = range();
      let suppliers; let total;
      ({ rows: r, suppliers, total } = await api.costsList(from, to, tab === 'zero' ? 'zero' : null, sup));
      setMeta((m) => {
        const next = { suppliers: suppliers || [], total: total ?? r.length };
        return JSON.stringify(m) === JSON.stringify(next) ? m : next;
      });
    }
    setRows((cur) => {
      if (!cur) return cur;
      const have = new Set(r.map((x) => x.vin));
      const next = [...r, ...cur.filter((x) => !have.has(x.vin) && keptVins.current.has(x.vin))];
      return JSON.stringify(cur) === JSON.stringify(next) ? cur : next;
    });
  }, { mount: false, paused: tab === 'lookup' || rows == null || !!savingKey || Object.keys(drafts).length > 0 });

  const totalPairs = groups ? groups.reduce((n, g) => n + g.qty, 0) : 0;
  const totalMissing = groups ? groups.reduce((n, g) => n + g.missing, 0) : 0;
  const shownPairs = capped ? meta.total : totalPairs;
  const pairsLine = groups ? `${shownPairs.toLocaleString('en-US')} pair${shownPairs === 1 ? '' : 's'} ${tab === 'zero' ? 'at $0' : 'with no cost'}${sup ? ` · ${sup === NO_SUPPLIER ? 'no supplier' : sup}` : ''}` : '';

  const tabs = (
    <div className="seg cost-tabs" role="tablist">
      <button type="button" role="tab" aria-selected={tab === 'blank'}
        className={`seg-btn${tab === 'blank' ? ' on' : ''}`} onClick={() => setTab('blank')}>
        No cost on file{counts?.missing_cost ? ` (${counts.missing_cost})` : ''}
      </button>
      <button type="button" role="tab" aria-selected={tab === 'zero'}
        className={`seg-btn${tab === 'zero' ? ' on' : ''}`} onClick={() => setTab('zero')}>
        $0 — check these{counts?.zero_cost ? ` (${counts.zero_cost})` : ''}
      </button>
      <button type="button" role="tab" aria-selected={tab === 'lookup'}
        className={`seg-btn${tab === 'lookup' ? ' on' : ''}`} onClick={() => setTab('lookup')}>
        <Icon name="search" /> Cost lookup
      </button>
    </div>
  );

  if (tab === 'lookup') {
    return (
      <div className="app">
        <TopBar title="Costs" onHome={onHome} onSignOut={onSignOut} />
        <div className="card">
          {tabs}
          <CostLookup onSignOut={onSignOut} />
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <TopBar title="Costs" onHome={onHome} onSignOut={onSignOut} />
      <div className="card">
        <p className="muted sm">
          What each pair cost. Suppliers often leave it off the manifest, and it’s only
          ever captured at receiving — so anything they skipped shows up here.
          <b> One amount covers every pair of that size in that shipment.</b>{' '}
          Leaving a box empty means <b>“not known”</b>, which is not the same as $0.
        </p>

        <form className="cost-search" onSubmit={runSearch}>
          <input
            className="cost-search-input"
            placeholder="Scan a VIN, or type a SKU / UPC — to fix a cost that’s already there"
            value={query} onChange={(e) => setQuery(e.target.value)}
          />
          <button className="btn sm primary" type="submit"><Icon name="search" /> Find</button>
          {searched && <button className="btn sm ghost" type="button" onClick={backToWorklist}>← Back to the backlog</button>}
        </form>

        {searched ? (
          <p className="muted sm">
            Showing every pair of <b>{searched}</b>, costed or not — {totalPairs} pair{totalPairs === 1 ? '' : 's'}
            {totalMissing > 0 && <> · <b>{totalMissing}</b> with no cost</>}.
          </p>
        ) : (
          <>
            {tabs}
            {tab === 'zero' && (
              <p className="cost-zero-note sm">
                These are recorded as costing <b>$0</b> — a real claim, not a gap, which is why
                they’re kept out of the backlog and its badge. Most are blanks from before a
                skipped cost box started saving as “not known”; a few may genuinely be free.
                Type the real amount, or leave the ones that are correct alone.
              </p>
            )}
            {cf ? (
              <p className="cost-range-on sm">
                Showing pairs received <b>from {cf}</b> {ct ? <>to <b>{ct}</b></> : <>until <b>today</b></>} (EST).{' '}
                <span className="muted">{pairsLine}</span>
              </p>
            ) : (
              <DateRangeBar mode={dr.mode} anchor={dr.anchor} onChange={(mode, anchor) => setDr({ mode, anchor })}
                right={<span className="muted sm">{pairsLine}</span>} />
            )}
            <div className="cost-filters">
              <label className="cost-filter">
                <span>Supplier</span>
                <select value={sup} onChange={(e) => setSup(e.target.value)} aria-label="Supplier">
                  <option value="">All suppliers</option>
                  {sup && !supplierOptions.some((o) => o.value === sup) && (
                    <option value={sup}>{sup === NO_SUPPLIER ? 'No supplier' : sup} (0)</option>
                  )}
                  {supplierOptions.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.value === NO_SUPPLIER ? 'No supplier' : o.value} ({o.pairs})
                    </option>
                  ))}
                </select>
              </label>
              <label className="cost-filter">
                <span>From</span>
                <input type="date" value={cf} max={estToday()} aria-label="From date"
                  onChange={(e) => setCf(e.target.value)} />
              </label>
              <label className="cost-filter">
                <span>To</span>
                <input type="date" value={ct} min={cf || undefined} max={estToday()} disabled={!cf}
                  aria-label="To date" title={cf ? 'Leave empty for “until today”' : 'Pick a From date first'}
                  onChange={(e) => setCt(e.target.value)} />
              </label>
              {(cf || sup) && (
                <button className="btn sm ghost" type="button" onClick={() => { setCf(''); setCt(''); setSup(''); }}>
                  Clear filters
                </button>
              )}
              <button className="btn sm cost-export" type="button" onClick={exportCsv} disabled={!exportSkus || exporting}
                title="One row per SKU, with its sizes — everything the filters above match">
                <Icon name="download" /> {exporting ? 'Exporting…' : `Export CSV${exportSkus && !capped ? ` (${exportSkus} SKU${exportSkus === 1 ? '' : 's'})` : ''}`}
              </button>
            </div>
            {capped && (
              <p className="cost-zero-note sm">
                This range holds <b>{meta.total.toLocaleString('en-US')}</b> pairs; the page shows the newest {rows.length.toLocaleString('en-US')}.
                Pick a supplier or narrow the dates to see the rest. <b>Export CSV includes all of them.</b>
              </p>
            )}
          </>
        )}

        {/* Admin only: fills blank costs from the PO's shelf price in one go. The
            server re-checks the role; this only decides whether to draw it. */}
        {!searched && ['admin', 'superadmin'].includes(getUser()?.role) && (
          <CostBackfill onDone={() => loadWorklist()} onSignOut={onSignOut} />
        )}

        {error && <div className="error mt">{error}</div>}
        {notice && <div className="ok mt">{notice}</div>}

        {!groups ? <p className="muted">Loading…</p>
          : !groups.length ? (
            <p className="ok">
              {searched ? 'No pairs found.'
                : sup ? 'Nothing for this supplier in this range.'
                : 'All clear — every pair in this range has a cost on file.'}
            </p>
          ) : (
            <div className="cost-groups">
              {groups.map((g) => {
                const changed = changedSizes(g);
                const busy = savingKey === g.key;
                return (
                  <div className={`cost-card ${g.missing || tab === 'zero' ? 'needs' : ''}`} key={g.key}>
                    <div className="cost-card-head">
                      <div className="cost-card-title">
                        <b>{g.name || '—'}</b>
                        <span className="muted"> — {g.sku || '—'}</span>
                        {g.colorway && <div className="muted sm">{g.colorway}</div>}
                      </div>
                      <div className="cost-card-meta muted sm">
                        {g.batch_code ? <span className="cost-batch" title="The shipment these pairs came in on">{g.batch_code}</span> : <span className="cost-batch">No batch</span>}
                        {g.supplier_name ? ` · ${g.supplier_name}` : ''}
                        {g.created_at ? ` · ${PH_DATE.format(new Date(g.created_at))}` : ''}
                        {g.kind === 'instore' && <span className="cost-kind">In-store</span>}
                        {g.kind === 'rescale' && <span className="cost-kind">Rescale</span>}
                      </div>
                    </div>

                    <div className="cost-sizes">
                      {g.sizes.map((s) => (
                        <label className={`cost-size ${s.cost == null ? 'blank' : ''}`} key={s.size}>
                          <span className="cost-size-label">
                            US {sizeLabel(s.size, s.gender, g.name)}
                            <span className="muted"> ×{s.qty}</span>
                          </span>
                          <PriceInput
                            value={draftFor(g, s)}
                            onChange={(e) => setDraft(g, s, e.target.value)}
                            disabled={busy}
                          />
                          {s.costMixed && <span className="cost-mixed" title="Pairs of this size don’t all have the same cost on file — saving sets them all to one amount">~ mixed</span>}
                        </label>
                      ))}
                    </div>

                    <div className="cost-card-foot">
                      <span className="muted sm">
                        {changed.length
                          ? `${changed.length} size${changed.length === 1 ? '' : 's'} to save`
                          : g.missing
                            ? `${g.missing} pair${g.missing === 1 ? '' : 's'} still without a cost`
                            : tab === 'zero' && !searched
                              ? `${g.qty} pair${g.qty === 1 ? '' : 's'} recorded as free`
                              : 'All sizes have a cost'}
                      </span>
                      <button className="btn sm primary" disabled={!changed.length || busy} onClick={() => saveGroup(g)}>
                        {busy ? '…' : 'Save'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
      </div>
    </div>
  );
}
