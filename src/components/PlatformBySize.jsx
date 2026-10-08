// "Which platform does each size sell best on?" — the Payout Calculator's per-size view.
//
// The one-pair view answers for the size in your hand. This answers for the whole run:
// size 8 can pay more on StockX while size 9 of the same shoe pays more on Alias, and
// you only see that with every size side by side. Each size's LOWEST ASK on both
// platforms goes through the same payout maths (calcPayout: the platform's fee comes off
// the ask) against the ONE final cost from the Store cost step above — the shelf price,
// tax, tip, shipping and gift card are the same whichever size you pick up.
//
// Prices come from api/payout/batch.js — the endpoint batch analysis already uses, so a
// size here and a size there can never be priced by two code paths that disagree.
// Fetched on a tap, not on look-up: it's one StockX call per size against a shared
// daily quota, and the one-pair lookup shouldn't wait on thirty of them.
import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { platformBySize, PLATFORMS, DEFAULT_FEE_PCT } from '../lib/payout.js';
import { BasisChip } from './common.jsx';

const money = (v) => `${Number(v) < 0 ? '−' : ''}$${Math.abs(Number(v || 0)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (v) => `${Number(v || 0).toFixed(1)}%`;
// Alias reports 0 for a size with no listing, so 0 reads as "no ask" here too.
const ask = (v) => (v == null || Number(v) <= 0 ? null : Number(v));
// The batch endpoint prices up to 24 sizes per style per request.
const CHUNK = 24;
const LABEL = Object.fromEntries(PLATFORMS.map((p) => [p.key, p.label]));

// `sizes` is `[{ size, cost? }]`. A size's own cost wins over `finalCost` — the PH grid
// passes what those pairs landed at; the calculator passes one cost for any size.
// `compact` drops the intro and footnote for the PH grid, where it sits under a table.
// `hierarchy` (PH): Alias is priced by the 8-level pricing hierarchy — the GI column's
// number, With You when consigned is empty — instead of the lowest ask on `basis`.
export function PlatformBySize({ sku, sizes: sizeRows, basis, hierarchy = false, finalCost = 0, fees = DEFAULT_FEE_PCT, currentSize, onPickSize, onSignOut, compact = false, title = 'Best platform by size' }) {
  const [quotes, setQuotes] = useState(null);   // [{ size, alias, stockx, stockxInexact }]
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sxNote, setSxNote] = useState('');

  // A new shoe or a new Alias basis makes every number here a statement about something
  // else — drop them rather than leave a stale table looking current.
  const key = `${sku || ''}|${basis}`;
  useEffect(() => { setQuotes(null); setError(''); setSxNote(''); }, [key]);

  const sizes = useMemo(() => (sizeRows || []).map((r) => String(r.size)), [sizeRows]);
  const costBySize = useMemo(() => new Map((sizeRows || []).map((r) => [String(r.size), r.cost ?? null])), [sizeRows]);
  const rows = useMemo(
    () => (quotes ? platformBySize(quotes.map((q) => ({ ...q, cost: costBySize.get(q.size) })), finalCost, fees) : null),
    [quotes, costBySize, finalCost, fees],
  );
  const costed = (r) => Number(r.cost) > 0;
  const anyUncosted = (rows || []).some((r) => !costed(r) && r.best);

  const tally = useMemo(() => {
    const t = { alias: 0, stockx: 0, tie: 0, none: 0 };
    for (const r of rows || []) t[r.best || 'none'] += 1;
    return t;
  }, [rows]);

  async function run() {
    if (!sku || !sizes.length) return;
    setBusy(true); setError(''); setSxNote('');
    try {
      const all = sizes;
      const alias = new Map();
      const sx = new Map();
      let sxConfigured = false;
      let sxError = '';
      // Sequential chunks: the endpoint de-duplicates by style, so a long size run is
      // split across requests rather than across entries of one.
      for (let i = 0; i < all.length; i += CHUNK) {
        const res = await api.payoutBatch([{ sku, sizes: all.slice(i, i + CHUNK) }], basis === 'consigned', { hierarchy });
        const q = res.quotes?.[String(sku).toUpperCase()] || Object.values(res.quotes || {})[0];
        if (!q) continue;
        if (q.alias?.error) setError(q.alias.error);
        for (const r of q.alias?.results || []) alias.set(String(r.size), r);
        sxConfigured = sxConfigured || !!q.stockx?.configured;
        if (q.stockx?.error) sxError = q.stockx.error;
        for (const r of q.stockx?.results || []) sx.set(String(r.size), r);
      }
      setQuotes(all.map((s) => ({
        size: s,
        alias: ask(hierarchy ? alias.get(s)?.alias_price : alias.get(s)?.lowest_listing),
        aliasBasis: hierarchy ? alias.get(s)?.alias_basis || null : null,
        stockx: ask(sx.get(s)?.lowest_ask),
        stockxInexact: !!sx.get(s)?.inexact,
      })));
      // Said, not left as a column of dashes: "StockX has no ask" and "we couldn't ask
      // StockX" are opposite answers.
      if (!sxConfigured) setSxNote('StockX prices aren’t configured on this server — only Alias is compared.');
      else if (sxError) setSxNote(sxError);
    } catch (e) {
      if (e.unauthorized) return onSignOut?.();
      setError(e.message);
    } finally { setBusy(false); }
  }

  if (!sku || !sizes.length) return null;
  const anyInexact = (rows || []).some((r) => r.stockxInexact && r.stockx);

  return (
    <div className="pc-bysize">
      <div className="pc-h-row">
        <h3 className="pc-h">{title}</h3>
        <button type="button" className="btn ghost sm" onClick={run} disabled={busy}>
          {busy ? 'Pricing every size…' : quotes ? 'Refresh' : 'Compare every size'}
        </button>
      </div>
      {!compact && (
        <p className="muted sm pc-bysize-intro">
          Each size’s lowest ask on Alias ({basis === 'with_you' ? 'With You' : 'Consigned'}) and StockX,
          less that platform’s fee, less the final cost above — so you know where to list each size.
        </p>
      )}

      {error && <div className="error mt">{error}</div>}
      {sxNote && <div className="notice mt">{sxNote}</div>}

      {rows && (
        <>
          <p className="pc-bysize-tally sm">
            <b>Alias</b> wins {tally.alias} size{tally.alias === 1 ? '' : 's'} · <b>StockX</b> wins {tally.stockx}
            {tally.tie ? ` · ${tally.tie} tied` : ''}
            {tally.none ? ` · ${tally.none} with no ask on either` : ''}
          </p>
          {anyUncosted && (
            <p className="muted sm">
              {compact
                ? 'Sizes with no cost on file rank by payout — fill the cost on the Costs page to see profit.'
                : 'Enter a shelf price above to see profit — until then this ranks by payout, which picks the same platform.'}
            </p>
          )}
          <BySizeTable rows={rows} onPickSize={onPickSize} currentSize={currentSize} />
          {anyInexact && (
            <p className="muted sm mt">≈ StockX matched a different listing than this exact style for that size — check it before trusting it.</p>
          )}
          <p className="pc-note muted sm">
            Profit is after the platform fee ({PLATFORMS.map((p) => `${p.label} ${pct(fees[p.key])}`).join(', ')}){compact
              ? `, against each size’s cost on file. ${hierarchy ? 'Alias priced like the GI column (GI Consigned → GI With You → Lowest …); StockX lowest ask.' : `Alias ${basis === 'with_you' ? 'With You' : 'Consigned'} lowest ask.`}`
              : ' and uses the market price — markup isn’t applied here. Tap a size to load it into the calculator.'}
          </p>
        </>
      )}
    </div>
  );
}

// The rows themselves — shared by the calculator/PH-grid view above and the Platform
// Profit report, so a size reads the same wherever it's shown. `rows` come from
// platformBySize(); a row's `qty` (report only) prints beside its size.
export function BySizeTable({ rows, onPickSize, currentSize }) {
  const Row = onPickSize ? 'button' : 'div';
  return (
    <div className="pc-bysize-table" role="table" aria-label="Best platform by size">
      <div className="pc-bysize-row head" role="row">
        <span role="columnheader">Size</span>
        <span role="columnheader">Alias</span>
        <span role="columnheader">StockX</span>
        <span role="columnheader">Sell on</span>
      </div>
      {rows.map((r) => (
        // A row is a button only where tapping it does something (the calculator
        // loads that size); on the PH grid it's a plain row.
        <Row key={r.size} role="row"
          {...(onPickSize ? { type: 'button', title: 'Price this size in the calculator above', onClick: () => onPickSize(r.size) } : {})}
          className={`pc-bysize-row${onPickSize ? ' pickable' : ''}${String(r.size) === String(currentSize) ? ' current' : ''}`}>
          <span role="cell" className="pc-bysize-size">{r.size}{r.qty ? <span className="muted sm pc-bysize-qty"> ×{r.qty}</span> : null}</span>
          {PLATFORMS.map(({ key: k }) => {
            const p = r[k];
            const hasCost = Number(r.cost) > 0;
            // Green means "take it", not "the less bad of two": the better platform on a
            // size that loses money either way is outlined, never tinted green.
            return (
              <span role="cell" key={k} className={`pc-bysize-cell${r.best === k ? (hasCost && p && p.profit < 0 ? ' win loss' : ' win') : ''}`}>
                {p ? (
                  <>
                    <span className="pc-bysize-ask">
                      {money(p.salePrice)}{k === 'alias' && r.aliasBasis ? <> <BasisChip basis={r.aliasBasis} /></> : null}{k === 'stockx' && r.stockxInexact ? <span className="pc-batch-warn" title="StockX matched a different listing for this style"> ≈</span> : null}
                    </span>
                    <span className={`pc-bysize-profit ${hasCost ? (p.profit >= 0 ? 'up' : 'down') : 'muted'}`}>
                      {hasCost ? `${money(p.profit)} · ${pct(p.roi)}` : `pays ${money(p.payout)}`}
                    </span>
                  </>
                ) : <span className="muted">no ask</span>}
              </span>
            );
          })}
          <span role="cell" className="pc-bysize-best">
            {r.best === 'tie' ? <span className="muted">Either</span>
              : r.best ? (
                <>
                  <b>{LABEL[r.best]}</b>
                  {r.edge != null && <span className="muted sm">+{money(r.edge)}</span>}
                </>
              ) : <span className="muted">—</span>}
          </span>
        </Row>
      ))}
    </div>
  );
}
