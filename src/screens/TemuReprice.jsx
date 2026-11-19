// Temu Reprice (PH) — answer Temu's price recommendations against today's market
// (docs/context/temu-reprice.md). Same idea as eBay and SHEIN Reprice; three steps:
//   1 Files      Temu's pricing template (.xlsx) + the store inventory report (SKU → Style ID)
//   2 Prices     the shared, resumable market-price step (same lookups + daily cache as
//                eBay / SHEIN Reprice)
//   3 Answer     markup (default 15 %, never remembered): Accept where Temu's price is at or
//                above market + markup, counter with market + markup where it is under,
//                verify, then Temu's own file filled + an audit report
// The reading / filling / verifying is all src/lib/temuReprice.js — pure.
import React, { useMemo, useState } from 'react';
import { TopBar } from '../components/common.jsx';
import { useMarketPrices, MarketPricesStep } from '../components/MarketPrices.jsx';
import { estToday } from '../lib/format.js';
import { readInventoryFile, parseMarkup, multiplierLabel } from '../lib/ebayReprice.js';
import {
  readTemuFile, resolveStyles, skipReason, jobsFor, temuFloorCents, applyReprice, partsOf,
  fillTemplate, verifyOutput, outputName, reportText, DEFAULT_REASON, MAX_FILLED,
} from '../lib/temuReprice.js';

const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const money = (cents) => `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
const usd = (cents) => (cents / 100).toFixed(2);
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function download(name, data, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function FileField({ id, label, hint, accept, file, result, onFile }) {
  return (
    <div className={`er-file${result?.ok ? ' ok' : result && !result.ok ? ' bad' : ''}`}>
      <label htmlFor={id} className="er-file-label">{label}</label>
      <div className="muted xs">{hint}</div>
      <input id={id} type="file" accept={accept} onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
      {file && <div className="er-file-name">{file.name}</div>}
      {result && !result.ok && <div className="error xs">{result.error}</div>}
      {result?.ok && result.summary && <div className="er-file-ok xs">✓ {result.summary}</div>}
    </div>
  );
}

function Stat({ n, label, tone }) {
  return <div className={`er-stat${tone ? ` ${tone}` : ''}`}><b>{n}</b><span>{label}</span></div>;
}

export function TemuReprice({ onHome, onSignOut }) {
  const [temuFile, setTemuFile] = useState(null);
  const [temu, setTemu] = useState(null);
  const [invFile, setInvFile] = useState(null);
  const [inv, setInv] = useState(null);
  const [markup, setMarkup] = useState('15');   // never remembered: every fresh run starts at 15 %
  const [counter, setCounter] = useState(true);
  const [activeOnly, setActiveOnly] = useState(false);
  const [reason, setReason] = useState(DEFAULT_REASON);
  const [result, setResult] = useState(null);

  async function pickTemu(f) {
    setTemuFile(f); setResult(null);
    const r = readTemuFile(new Uint8Array(await f.arrayBuffer()));
    setTemu(r.ok ? { ...r, summary: `${fmt(r.stats.rows)} SKUs · ${fmt(r.stats.acceptOnly)} can only be accepted${r.stats.inactive ? ` · ${fmt(r.stats.inactive)} inactive` : ''}` } : r);
    if (r.ok && !r.reasons.includes(reason)) setReason(r.reasons[0] || DEFAULT_REASON);
  }
  async function pickInv(f) {
    setInvFile(f); setResult(null);
    const r = readInventoryFile(await f.text());
    setInv(r.ok ? { ...r, summary: `${fmt(r.units)} units · ${fmt(r.sku2style.size)} SKUs · columns “${r.columns.style}” + “${r.columns.sku}”` } : r);
  }

  const resolved = useMemo(() => (temu?.ok && inv?.ok ? resolveStyles(temu.rows, inv) : null), [temu, inv]);
  const rows = resolved?.rows || null;
  const opts = useMemo(() => ({ activeOnly }), [activeOnly]);
  const jobs = useMemo(() => (rows ? jobsFor(rows, opts) : []), [rows, opts]);
  const skipped = useMemo(() => {
    if (!rows) return [];
    const by = new Map();
    for (const x of rows) {
      const why = skipReason(x, opts);
      if (!why) continue;
      const k = why.startsWith('No single US size') ? 'Variation has no single US size' : why.startsWith('Already answered') ? 'Already answered in the file' : why.startsWith('Product is') ? 'Product is not active' : why;
      by.set(k, (by.get(k) || 0) + 1);
    }
    return [...by];
  }, [rows, opts]);
  const nSkipped = skipped.reduce((n, [, c]) => n + c, 0);
  const mp = useMarketPrices(jobs, onSignOut);
  const pctH = parseMarkup(markup);
  const pctLabel = pctH == null ? '' : (pctH / 100).toString();

  function run() {
    if (pctH == null) return;
    const out = applyReprice(rows, mp.cacheRef.current, pctH, { counter, reason, activeOnly });
    const floors = new Map(out.report.filter((r) => r.floor).map((r) => [r.skuId, Math.round(Number(r.floor) * 100)]));
    const parts = partsOf(out.fills);
    const files = parts.map((fills, i) => {
      const bytes = fillTemplate(temu, fills);
      return { bytes, fills, verify: verifyOutput(temu, bytes, fills, floors), name: outputName(estToday(), i + 1, parts.length) };
    });
    setResult({ ...out, files, pctH });
  }

  const canPrice = !!rows && jobs.length > 0;
  const canRun = mp.ready && pctH != null;
  const allOk = !!result && result.files.every((f) => f.verify.ok);

  return (
    <div className="app">
      <TopBar title="Temu Reprice" onHome={onHome} onSignOut={onSignOut} />

      <div className="card er-step">
        <h3 className="er-step-title"><span className="er-num">1</span> Files</h3>
        <p className="sm">Temu recommends a lower base price for each SKU. This fills in their file: <b>Accept</b> where their price is at or above today’s market + markup, and <b>our own price</b> where it is under. Nothing changes on Temu until you upload the file this makes.</p>
        <div className="er-files">
          <FileField id="tr-temu" label="Temu pricing template" file={temuFile} result={temu} onFile={pickTemu}
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            hint="Temu Seller Center → Pricing health → batch template — e.g. Traffic boost opportunity_1795113600672.xlsx" />
          <FileField id="tr-inv" label="Store inventory report" file={invFile} result={inv} onFile={pickInv} accept=".csv,text/csv"
            hint="The CSV with SKU and Style ID — e.g. StoreInventoryReport-2026-11-19….csv (the one eBay Reprice uses)" />
        </div>
        <p className="muted xs">Your files are only read. The download is Temu’s own file with the Action, New base price and Reasons columns filled, checked before you can download it.</p>
        {rows && (
          <>
            <div className="er-stats mt">
              <Stat n={fmt(rows.length - nSkipped)} label="SKUs to price" />
              <Stat n={fmt(resolved.n.report)} label="Style ID from the report" />
              <Stat n={fmt(resolved.n.name)} label="Style ID from the product name" />
              <Stat n={fmt(nSkipped)} label="skipped (left blank)" tone={nSkipped ? 'warn' : ''} />
            </div>
            {skipped.length > 0 && <ul className="muted xs mt">{skipped.map(([why, n]) => <li key={why}>{fmt(n)} — {why}</li>)}</ul>}
            <label className="er-check mt">
              <input type="checkbox" checked={activeOnly} onChange={(e) => { setActiveOnly(e.target.checked); setResult(null); }} />
              <span>Only answer <b>Active</b> products{temu.stats.inactive ? ` (leaves ${fmt(temu.stats.inactive)} inactive SKUs blank)` : ''}</span>
            </label>
            {!jobs.length && <div className="notice mt">No SKU in this file can be priced.</div>}
          </>
        )}
      </div>

      {canPrice && <MarketPricesStep mp={mp} num={2} lookups="prices to look up" hint="Keep this tab open while it runs; closing the tab pauses it. Prices fetched today on eBay or SHEIN Reprice are reused." onCleared={() => setResult(null)} />}

      {canPrice && (
        <div className="card er-step">
          <h3 className="er-step-title"><span className="er-num">3</span> Answer Temu</h3>
          <p className="muted sm">Our price for a shoe is today’s market + markup, <b>rounded up</b> to the cent. Temu’s price at or above it → <b>Accept</b>. Under it → <b>New proposal</b> at our price. A price is never raised: where our price is at or above today’s base price, the row is left blank.</p>
          <div className="er-controls">
            <label className="er-markup">
              <span className="muted xs">Markup over market</span>
              <span className="er-markup-field">
                <input type="text" inputMode="decimal" value={markup} aria-label="Markup percent" onChange={(e) => { setMarkup(e.target.value); setResult(null); }} />
                <span>%</span>
              </span>
              {pctH == null ? <span className="error xs">0 to 100, up to 2 decimals</span> : <span className="muted xs">× {multiplierLabel(pctH)} · $100 → ${usd(temuFloorCents(10000, pctH))} · $104.35 → ${usd(temuFloorCents(10435, pctH))}</span>}
            </label>
            <button type="button" className="btn primary" disabled={!canRun} onClick={run}>Build Temu file</button>
          </div>
          <label className="er-check">
            <input type="checkbox" checked={counter} onChange={(e) => { setCounter(e.target.checked); setResult(null); }} />
            <span>Propose our price where Temu’s is too low</span>
          </label>
          {counter && (
            <label className="er-check">
              <span className="muted xs">Reason sent with each proposal</span>
              <select value={reason} aria-label="Reason for a new proposal" onChange={(e) => { setReason(e.target.value); setResult(null); }}>
                {temu.reasons.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </label>
          )}
          {!mp.done && <p className="muted xs">Waiting for every price in step 2.</p>}

          {result && (
            <div className="er-result">
              <div className="er-result-head">Run at <b>{(result.pctH / 100).toString()}% markup (× {multiplierLabel(result.pctH)})</b></div>
              <div className="er-stats">
                <Stat n={fmt(result.n.accept)} label="accepted" tone="ok" />
                <Stat n={fmt(result.n.propose)} label="our price proposed" tone="ok" />
                <Stat n={fmt(result.n.tooLow)} label="left blank (our price isn’t lower)" />
                <Stat n={fmt(result.n.noCounter)} label="left blank (Temu too low, can’t counter)" tone={result.n.noCounter ? 'warn' : ''} />
                <Stat n={fmt(result.n.nodata)} label="no price data" tone={result.n.nodata ? 'warn' : ''} />
                <Stat n={fmt(result.n.skipped)} label="skipped" />
              </div>
              <p className="sm">Total reduction if Temu takes every answer: <b>{money(result.n.reductionCents)}</b> across {fmt(result.fills.length)} SKU{result.fills.length === 1 ? '' : 's'}.</p>
              {result.files.length > 1 && <div className="notice">Temu takes up to {fmt(MAX_FILLED)} answered lines per file, so this run is {result.files.length} files. Upload each one.</div>}
              {result.files.map((f) => (
                <div key={f.name} className={`er-verify ${f.verify.ok ? 'pass' : 'fail'}`}>
                  <b>{f.verify.ok ? `✓ Verified — ${f.name}` : `✗ Verification FAILED — ${f.name} — download blocked`}</b>
                  <ul>{f.verify.checks.map((c) => <li key={c.label}>{c.ok ? '✓' : '✗'} {c.label} <span className="muted">— {c.detail}</span></li>)}</ul>
                </div>
              ))}
              {!result.files.length && <p className="sm">Nothing to answer — no SKU can be accepted or countered at {pctLabel}% today.</p>}
              <div className="er-actions">
                {result.files.map((f) => (
                  <button key={f.name} type="button" className="btn primary" disabled={!allOk} onClick={() => download(f.name, f.bytes, XLSX_TYPE)}>
                    Download — {f.name} ({fmt(f.fills.length)})</button>
                ))}
                <button type="button" className="btn" onClick={() => download(outputName(estToday(), 1, 1).replace(/^Temu reprice/, 'Temu reprice report').replace(/\.xlsx$/, '.csv'), reportText(result.report, (result.pctH / 100).toString()), 'text/csv;charset=utf-8')}>
                  Download audit report</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
