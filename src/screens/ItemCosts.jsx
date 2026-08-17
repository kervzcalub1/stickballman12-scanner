// Costs — fill in what a pair cost when the supplier didn't.
//
// `items.cost` is written once, at intake, and suppliers routinely leave cost off a
// PO manifest. Before this page a blank cost stayed blank forever. Two halves, both
// on one screen: a WORKLIST of everything with no cost on file (the backlog you
// clear), and a SEARCH for fixing a cost that's already there but wrong.
//
// One amount covers every pair of that size in that shipment — the same granularity
// as po_lines.unit_cost, and the same as the PH grid's per-size layout.
import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { TopBar, DateRangeBar, PriceInput } from '../components/common.jsx';
import { Icon } from '../components/NavIcons.jsx';
import { usePendingCounts } from '../hooks.js';
import { rangeOf, PH_DATE } from '../lib/format.js';
import { sizeLabel } from '../lib/codes.js';
import { groupCostRows, costFieldValue, costChanged } from '../lib/costs.js';

export function ItemCosts({ onHome, onSignOut }) {
  const [rows, setRows] = useState(null);
  const [drafts, setDrafts] = useState({});      // `${groupKey}|${size}` -> typed string
  const [savingKey, setSavingKey] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  // Month, not Day: this is a backlog. A Day filter would read "all clear" while the
  // home badge still shows dozens waiting — the same reason No Box defaults to Month.
  const [dr, setDr] = useState(() => ({ mode: 'month', anchor: new Date() }));
  const [query, setQuery] = useState('');
  const [searched, setSearched] = useState('');  // the term actually loaded, '' = worklist
  // 'blank' = no cost on file · 'zero' = recorded as free. Two lists, not one: a $0 is
  // a claim already on file, so folding it into the backlog would assert it's a gap
  // when we don't know that. Most are blanks skipped before toCost was fixed; a few
  // may be real. See the note the page prints when this tab is open.
  const [tab, setTab] = useState('blank');
  const counts = usePendingCounts();

  async function loadWorklist(nextTab = tab) {
    setError(''); setRows(null);
    try {
      const [from, to] = rangeOf(dr.mode, dr.anchor);
      const { rows: r } = await api.costsList(from, to, nextTab === 'zero' ? 'zero' : null);
      setRows(r); setDrafts({}); setSearched('');
    } catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
  }
  useEffect(() => { if (!searched) loadWorklist(); }, [dr, tab]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const totalPairs = groups ? groups.reduce((n, g) => n + g.qty, 0) : 0;
  const totalMissing = groups ? groups.reduce((n, g) => n + g.missing, 0) : 0;

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
            <div className="seg cost-tabs" role="tablist">
              <button type="button" role="tab" aria-selected={tab === 'blank'}
                className={`seg-btn${tab === 'blank' ? ' on' : ''}`} onClick={() => setTab('blank')}>
                No cost on file{counts?.missing_cost ? ` (${counts.missing_cost})` : ''}
              </button>
              <button type="button" role="tab" aria-selected={tab === 'zero'}
                className={`seg-btn${tab === 'zero' ? ' on' : ''}`} onClick={() => setTab('zero')}>
                $0 — check these{counts?.zero_cost ? ` (${counts.zero_cost})` : ''}
              </button>
            </div>
            {tab === 'zero' && (
              <p className="cost-zero-note sm">
                These are recorded as costing <b>$0</b> — a real claim, not a gap, which is why
                they’re kept out of the backlog and its badge. Most are blanks from before a
                skipped cost box started saving as “not known”; a few may genuinely be free.
                Type the real amount, or leave the ones that are correct alone.
              </p>
            )}
            <DateRangeBar mode={dr.mode} anchor={dr.anchor} onChange={(mode, anchor) => setDr({ mode, anchor })}
              right={<span className="muted sm">{groups ? `${totalPairs} pair${totalPairs === 1 ? '' : 's'} ${tab === 'zero' ? 'at $0' : 'with no cost'}` : ''}</span>} />
          </>
        )}

        {error && <div className="error mt">{error}</div>}
        {notice && <div className="ok mt">{notice}</div>}

        {!groups ? <p className="muted">Loading…</p>
          : !groups.length ? (
            <p className="ok">
              {searched ? 'No pairs found.' : 'All clear — every pair in this range has a cost on file.'}
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
