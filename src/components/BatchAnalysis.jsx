// Batch analysis — the Payout Calculator with a list in front of it instead of one pair.
//
// The question is the same ("should we buy this?"), asked about forty rows at once: a
// supplier sends a list, you paste it, and it comes back priced, called, and totalled.
// Ported from GemsClean/payout-calculator's bulk analyser; the arithmetic and the
// verdict are this app's own (src/lib/batch.js explains the three divergences).
//
// The shape of the screen is Paste → **Review** → Analyse, and the middle step is not
// optional. Parsing someone's chat message is guesswork however carefully it's done, so
// every row lands in an editable table first: you can see what it read, fix a size it
// misread, and delete the line that was actually a greeting. Going straight from text to
// verdicts would mean a wrong number decided a purchase and nobody saw it happen.
import React, { useMemo, useState } from 'react';
import { api } from '../api.js';
import { parseBatch, blankBatchRow, MAX_ROWS } from '../lib/batchParse.js';
import { analyseBatch, batchSummary, STATUS_LABEL } from '../lib/batch.js';

// −$9.09, not $-9.09. A minus sign wedged between the symbol and the digits reads as a
// typo at a glance, and a loss is the one number here nobody should have to squint at.
const money = (n) => {
  const v = Number(n || 0);
  return `${v < 0 ? '−' : ''}$${Math.abs(v).toFixed(2)}`;
};
const pct = (n) => `${Number(n || 0).toFixed(1)}%`;

const SAMPLE = `DD1391-100 Dunk Low Panda $95
9 x 2
9.5 x 1
10 x 3`;

// Sorted the way the decision is made: the rows worth money first. Within a status,
// biggest line profit first — a $6 margin over forty pairs outranks $40 over one.
const ORDER = { buy: 0, watch: 1, pass: 2, no_cost: 3, no_price: 4 };

const tone = (r) => (r.best?.profit < 0 ? 'down' : r.status === 'buy' ? 'up' : '');

export function BatchAnalysis({ feeOverride, basis, onSignOut }) {
  const [text, setText] = useState('');
  const [rows, setRows] = useState(null);      // parsed + editable, before pricing
  const [shape, setShape] = useState('');
  const [analysed, setAnalysed] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [filter, setFilter] = useState('all');

  function doParse(src) {
    const t = String(src ?? text);
    const { rows: parsed, shape: sh } = parseBatch(t);
    setAnalysed(null); setError(''); setNotice('');
    setRows(parsed); setShape(sh);
    if (!parsed.length) setError('Nothing recognisable in that. Each line needs a style code, and a size — or a header line with the code, then its sizes underneath.');
    else if (parsed.length >= MAX_ROWS) setNotice(`Only the first ${MAX_ROWS} rows were read.`);
  }

  const setRow = (key, patch) => { setRows((a) => a.map((r) => (r.key === key ? { ...r, ...patch } : r))); setAnalysed(null); };
  const dropRow = (key) => { setRows((a) => a.filter((r) => r.key !== key)); setAnalysed(null); };
  const addRow = () => { setRows((a) => [...(a || []), blankBatchRow()]); setAnalysed(null); };

  const ready = (rows || []).filter((r) => String(r.sku).trim() && String(r.size).trim());

  async function analyse() {
    if (!ready.length) { setError('Every row needs a style code and a size before it can be priced.'); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      // One request for the whole list, grouped by style — see api/payout/batch.js.
      const bySku = new Map();
      for (const r of ready) {
        const k = String(r.sku).toUpperCase();
        if (!bySku.has(k)) bySku.set(k, new Set());
        bySku.get(k).add(String(r.size));
      }
      const payload = [...bySku.entries()].map(([sku, sizes]) => ({ sku, sizes: [...sizes] }));
      const res = await api.payoutBatch(payload, basis === 'consigned');
      setAnalysed(analyseBatch(ready, res.quotes, { feePct: feeOverride }));
      if (res.skipped) setNotice(`${res.skipped} style${res.skipped === 1 ? '' : 's'} past the ${res.limit}-style limit weren’t priced — run them as a second batch.`);
    } catch (e) {
      if (e.unauthorized) return onSignOut();
      setError(e.message);
    } finally { setBusy(false); }
  }

  const summary = useMemo(() => (analysed ? batchSummary(analysed) : null), [analysed]);
  const shown = useMemo(() => {
    const list = (analysed || []).filter((r) => (filter === 'all' ? true : filter === 'problems' ? (r.status === 'no_cost' || r.status === 'no_price') : r.status === filter));
    return [...list].sort((a, b) => (ORDER[a.status] - ORDER[b.status]) || ((b.lineProfit || 0) - (a.lineProfit || 0)));
  }, [analysed, filter]);

  return (
    <div className="pc-batch">
      <h3 className="pc-h">Paste the list</h3>
      <p className="muted sm pc-batch-help">
        A style code and a size on every line, or a header line with the code and its sizes underneath —
        <code> 9 x 2</code>. Prices, quantities and names are picked up where they’re there.
      </p>
      <textarea className="pc-batch-text" rows={7} value={text} spellCheck={false}
        placeholder={SAMPLE} onChange={(e) => setText(e.target.value)} />
      <div className="pc-batch-actions">
        <button type="button" className="btn primary" disabled={!text.trim()} onClick={() => doParse()}>Read the list</button>
        {!text.trim() && (
          <button type="button" className="btn ghost sm" onClick={() => { setText(SAMPLE); doParse(SAMPLE); }}>Try the example</button>
        )}
        {rows && <button type="button" className="btn ghost sm" onClick={() => { setText(''); setRows(null); setAnalysed(null); setError(''); setNotice(''); }}>Start over</button>}
      </div>

      {error && <div className="error mt">{error}</div>}
      {notice && <div className="notice mt">{notice}</div>}

      {rows && rows.length > 0 && (
        <>
          <h3 className="pc-h">
            Check what it read
            <span className="muted sm pc-batch-shape">
              {shape === 'grouped' ? ' · read as a header + size run' : ' · read one row per line'}
            </span>
          </h3>
          <p className="muted sm">
            Fix anything it got wrong before pricing — a misread size prices a different shoe.
          </p>
          <div className="pc-batch-rows">
            <div className="pc-batch-row head muted xs">
              <span>Style</span><span>Size</span><span>Qty</span><span>Cost / pair</span><span />
            </div>
            {rows.map((r) => (
              <div className={`pc-batch-row ${String(r.sku).trim() && String(r.size).trim() ? '' : 'incomplete'}`} key={r.key}>
                <label className="pc-batch-sku">
                  <input value={r.sku} placeholder="Style code" autoCapitalize="characters" autoCorrect="off"
                    onChange={(e) => setRow(r.key, { sku: e.target.value.toUpperCase() })} />
                  {r.name && <span className="muted xs">{r.name}</span>}
                </label>
                <input className="pc-batch-size" value={r.size} placeholder="Size"
                  onChange={(e) => setRow(r.key, { size: e.target.value })} />
                <input className="pc-batch-qty" type="number" min="1" inputMode="numeric" value={r.qty}
                  onChange={(e) => setRow(r.key, { qty: Math.max(1, Number(e.target.value) || 1) })} />
                <input className="pc-batch-cost" type="number" min="0" step="0.01" value={r.cost} placeholder="—"
                  onChange={(e) => setRow(r.key, { cost: e.target.value })} />
                <button type="button" className="btn icon ghost remove" title="Drop this row" onClick={() => dropRow(r.key)}>×</button>
              </div>
            ))}
          </div>

          <div className="pc-batch-foot">
            <button type="button" className="btn ghost sm" onClick={addRow}>+ Add a row</button>
            {/* Said once, plainly: the register stack from the one-pair mode is NOT applied
                here. A pasted list routinely spans several store trips, so there is no one
                stack that's right for it. */}
            <span className="muted sm">Cost is what you’ll pay per pair, landed — no discounts or tax are applied to it here.</span>
          </div>

          <div className="pc-batch-actions">
            <button type="button" className="btn primary" disabled={busy || !ready.length} onClick={analyse}>
              {busy ? 'Pricing…' : `Analyse ${ready.length} row${ready.length === 1 ? '' : 's'}`}
            </button>
            <span className="muted sm">{ready.length} of {rows.length} rows priceable</span>
          </div>
        </>
      )}

      {summary && (
        <>
          <h3 className="pc-h">The deal</h3>
          <div className="pc-stats pc-batch-stats">
            <div className="pc-stat"><span className="pc-stat-label">Pairs</span><span className="pc-stat-val">{summary.pricedPairs}</span></div>
            <div className="pc-stat"><span className="pc-stat-label">Total cost</span><span className="pc-stat-val">{money(summary.totalCost)}</span></div>
            <div className="pc-stat"><span className="pc-stat-label">Total payout</span><span className="pc-stat-val">{money(summary.totalPayout)}</span></div>
            <div className="pc-stat">
              <span className="pc-stat-label">Total profit</span>
              <span className={`pc-stat-val ${summary.totalProfit > 0 ? 'up' : summary.totalProfit < 0 ? 'down' : ''}`.trim()}>{money(summary.totalProfit)}</span>
            </div>
            <div className="pc-stat"><span className="pc-stat-label">Blended ROI</span><span className="pc-stat-val">{pct(summary.blendedRoi)}</span></div>
          </div>
          {/* The gaps, said out loud. A batch that quietly left a third of itself out of
              the totals reads as a worse deal — or a better one — than it is. */}
          {(summary.noPrice > 0 || summary.noCost > 0) && (
            <p className="muted sm pc-batch-gaps">
              Not in those totals:
              {summary.noPrice > 0 && <> <b>{summary.noPrice}</b> with no market for that size</>}
              {summary.noPrice > 0 && summary.noCost > 0 ? ' and' : ''}
              {summary.noCost > 0 && <> <b>{summary.noCost}</b> with no cost entered</>}.
            </p>
          )}

          <div className="pc-batch-filters">
            {[['all', `All ${analysed.length}`], ['buy', `Buy ${summary.buys.length}`], ['watch', 'Watch'], ['pass', 'Pass'], ['problems', `Gaps ${summary.noPrice + summary.noCost}`]].map(([k, l]) => (
              <button type="button" key={k} className={`pi-chip ${filter === k ? 'on' : ''}`.trim()}
                aria-pressed={filter === k} onClick={() => setFilter(k)}>{l}</button>
            ))}
          </div>

          <div className="pc-batch-results">
            {shown.length === 0 && <p className="muted sm">Nothing in this filter.</p>}
            {shown.map((r) => (
              <div className={`pc-batch-result ${r.status}`} key={r.key}>
                <div className="pc-batch-result-head">
                  <span className={`pc-call ${r.status}`}>{STATUS_LABEL[r.status]}</span>
                  <b className="mono">{r.sku}</b>
                  <span className="muted sm">US {r.size} · ×{r.qty}</span>
                  {r.inexact && <span className="pc-batch-warn" title="StockX matched a different style — check before trusting its price">⚠ StockX match</span>}
                </div>
                {r.name && <div className="muted sm pc-batch-result-name">{r.name}</div>}
                <div className="pc-batch-result-nums muted sm">
                  <span>Alias {r.aliasSale ? money(r.aliasSale) : '—'}</span>
                  <span>StockX {r.stockxSale ? money(r.stockxSale) : '—'}</span>
                  <span>Cost {r.finalCost ? money(r.finalCost) : '—'}</span>
                  {r.best && <span>Payout <b>{money(r.best.payout)}</b> · {r.best.label}</span>}
                </div>
                {r.best ? (
                  <div className="pc-batch-result-money">
                    {/* Green means "take it", not "the arithmetic came out positive".
                        An $11 profit at 11.9% ROI is a Pass, and it was reading green
                        beside its own red PASS chip. Red stays for an actual loss. */}
                    <span className={tone(r)}>{money(r.best.profit)}/pair</span>
                    <span className="muted">·</span>
                    <span>{pct(r.best.roi)} ROI</span>
                    <span className="muted">·</span>
                    <span className={tone(r)}><b>{money(r.lineProfit)}</b> on {r.qty}</span>
                  </div>
                ) : (
                  <div className="muted sm">
                    {r.status === 'no_cost'
                      ? 'Priced, but no cost entered — add one above to get a call.'
                      : 'No market for that size on either platform.'}
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
