// POIZON → Prices (docs/context/poizon-reprice.md) — cut every POIZON listing priced above
// today's market down to market + markup, never up. A section of the one POIZON page
// (PoizonOrders.jsx is the shell). Three steps, like eBay / SHEIN / Temu Reprice:
//   1 Files      POIZON's Smart Listing export (.xlsx) + the store inventory report (its
//                SKU is the export's Barcode → Style ID). POIZON's Price & Inventory
//                template is built in; a newer one can be dropped in instead.
//   2 Prices     the shared, resumable market-price step (same lookups + daily cache)
//   3 Reprice    markup (default 15 %, never remembered), rounded UP to a whole dollar,
//                verify, then POIZON's own template filled + an audit report
// The reading / filling / verifying is all src/lib/poizonReprice.js — pure.
import React, { useEffect, useMemo, useState } from 'react';
import { useMarketPrices, MarketPricesStep } from '../components/MarketPrices.jsx';
import { estToday } from '../lib/format.js';
import { readInventoryFile, parseMarkup, multiplierLabel } from '../lib/ebayReprice.js';
import {
  readExportFile, readTemplateFile, resolveStyles, skipReason, jobsFor, poizonRepriceDollars, applyReprice,
  fillTemplate, verifyOutput, outputName, reportText, METHOD,
} from '../lib/poizonReprice.js';

const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const money = (cents) => `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
const BUILT_IN = '/templates/poizon-price-inventory.xlsx';
const XLSX_ACCEPT = '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
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

export function PoizonReprice({ onSignOut }) {
  const [exportFile, setExportFile] = useState(null);
  const [exp, setExp] = useState(null);
  const [invFile, setInvFile] = useState(null);
  const [inv, setInv] = useState(null);
  const [tplFile, setTplFile] = useState(null);   // null = the built-in template
  const [tpl, setTpl] = useState(null);
  const [markup, setMarkup] = useState('15');     // never remembered: every fresh run starts at 15 %
  const [soldOut, setSoldOut] = useState(true);
  const [more, setMore] = useState(false);
  const [result, setResult] = useState(null);

  // The built-in template, fetched once. A dropped-in one replaces it for this run.
  useEffect(() => {
    let live = true;
    fetch(BUILT_IN).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((buf) => { if (live && !tplFile) { const t = readTemplateFile(new Uint8Array(buf)); setTpl(t.ok ? { ...t, summary: 'POIZON Price & Inventory template (built in)' } : t); } })
      .catch((e) => { if (live && !tplFile) setTpl({ ok: false, error: `Could not load the built-in template (${e.message}) — drop POIZON’s Price & Inventory Template in under More options.` }); });
    return () => { live = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function pickExport(f) {
    setExportFile(f); setResult(null);
    const r = readExportFile(new Uint8Array(await f.arrayBuffer()));
    setExp(r.ok ? { ...r, summary: `${fmt(r.stats.rows)} listings · ${fmt(r.stats.listed)} listed · ${fmt(r.stats.unable)} unable to list · ${fmt(r.stats.soldOut)} sold out` } : r);
  }
  async function pickInv(f) {
    setInvFile(f); setResult(null);
    const r = readInventoryFile(await f.text());
    setInv(r.ok ? { ...r, summary: `${fmt(r.units)} units · ${fmt(r.sku2style.size)} SKUs · columns “${r.columns.style}” + “${r.columns.sku}”` } : r);
  }
  async function pickTemplate(f) {
    setTplFile(f); setResult(null);
    const t = readTemplateFile(new Uint8Array(await f.arrayBuffer()));
    setTpl(t.ok ? { ...t, summary: t.extra ? `Template has ${fmt(t.extra)} filled rows — they’ll be replaced` : 'Template is empty — ready' } : t);
  }

  const resolved = useMemo(() => (exp?.ok && inv?.ok ? resolveStyles(exp.rows, inv) : null), [exp, inv]);
  const rows = resolved?.rows || null;
  const opts = useMemo(() => ({ soldOut }), [soldOut]);
  const jobs = useMemo(() => (rows ? jobsFor(rows, opts) : []), [rows, opts]);
  const skipped = useMemo(() => {
    if (!rows) return [];
    const by = new Map();
    for (const x of rows) {
      const why = skipReason(x, opts);
      if (!why) continue;
      const k = why.startsWith('Size "') ? 'Size isn’t a shoe size (clothing: S, XL, 2XL…)' : why.startsWith('Not on POIZON yet') ? 'Not on POIZON yet (unmatched or still matching)'
        : why.startsWith('No current price') ? 'No current price' : why.startsWith('Currency') ? 'Not priced in USD' : why;
      by.set(k, (by.get(k) || 0) + 1);
    }
    return [...by];
  }, [rows, opts]);
  const nSkipped = skipped.reduce((n, [, c]) => n + c, 0);
  const mp = useMarketPrices(jobs, onSignOut);
  const pctH = parseMarkup(markup);
  const pctLabel = pctH == null ? '' : (pctH / 100).toString();

  function run() {
    if (pctH == null || !tpl?.ok) return;
    const out = applyReprice(rows, mp.cacheRef.current, pctH, opts);
    const bytes = out.upload.length ? fillTemplate(tpl.bytes, out.upload) : null;
    const verify = bytes ? verifyOutput(tpl.bytes, bytes, out.upload, rows) : null;
    setResult({ ...out, bytes, verify, pctH, name: outputName(exportFile?.name, estToday()) });
  }

  const canPrice = !!rows && jobs.length > 0;
  const canRun = mp.ready && pctH != null && !!tpl?.ok;

  return (
    <>
      <div className="card er-step" data-poizon-reprice="">
        <h3 className="er-step-title"><span className="er-num">1</span> Files</h3>
        <p className="sm">Cut POIZON prices that are above today’s market. Nothing changes on POIZON until you upload the file this makes.</p>
        <div className="er-files">
          <FileField id="pz-export" label="POIZON listing export" file={exportFile} result={exp} onFile={pickExport} accept={XLSX_ACCEPT}
            hint="POIZON Seller Dashboard → Listing → Smart Listing → Export All — e.g. Export Smart Listing20261118.xlsx" />
          <FileField id="pz-inv" label="Store inventory report" file={invFile} result={inv} onFile={pickInv} accept=".csv,text/csv"
            hint="The CSV with SKU and Style ID — e.g. StoreInventoryReport-2026-11-19….csv. Its SKU is POIZON’s Barcode." />
        </div>
        <button type="button" className="linklike xs mt" aria-expanded={more} onClick={() => setMore((v) => !v)}>{more ? '▾' : '▸'} More options</button>
        {more && (
          <>
            <div className="er-files">
              <FileField id="pz-template" label="Price & Inventory Template (optional)" file={tplFile} result={tpl} onFile={pickTemplate} accept={XLSX_ACCEPT}
                hint="Built in — only drop a file here if POIZON changes their template (Batch Import → Price & Inventory Template)." />
            </div>
          </>
        )}
        <p className="muted xs">Your files are only read. The download is POIZON’s own template with the SPU ID, SKU ID, new price, Discount 0 and “{METHOD}” filled in, checked before you can download it. Only price cuts go in it; stock is not touched.</p>
        {rows && (
          <>
            <div className="er-stats mt">
              <Stat n={fmt(rows.length - nSkipped)} label="listings to price" />
              <Stat n={fmt(resolved.n.report)} label="Style ID from the report" />
              <Stat n={fmt(resolved.n.article + resolved.n.name)} label="Style ID from POIZON’s export" />
              <Stat n={fmt(nSkipped)} label="skipped (left as they are)" tone={nSkipped ? 'warn' : ''} />
            </div>
            {skipped.length > 0 && <ul className="muted xs mt">{skipped.map(([why, n]) => <li key={why}>{fmt(n)} — {why}</li>)}</ul>}
            <label className="er-check mt">
              <input type="checkbox" checked={soldOut} onChange={(e) => { setSoldOut(e.target.checked); setResult(null); }} />
              <span>Also reprice <b>Sold Out</b> listings{exp.stats.soldOut ? ` (${fmt(exp.stats.soldOut)})` : ''} <span className="muted xs">— so the price is right when stock comes back</span></span>
            </label>
            {exp.dupes > 0 && <div className="notice mt">{fmt(exp.dupes)} SKU ID{exp.dupes === 1 ? ' appears' : 's appear'} twice in the export.</div>}
            {!jobs.length && <div className="notice mt">No listing in this file can be priced.</div>}
          </>
        )}
      </div>

      {canPrice && <MarketPricesStep mp={mp} num={2} lookups="prices to look up" hint="Keep this tab open while it runs; closing the tab pauses it. Prices fetched today on eBay, SHEIN or Temu Reprice are reused." onCleared={() => setResult(null)} />}

      {canPrice && (
        <div className="card er-step">
          <h3 className="er-step-title"><span className="er-num">3</span> Build the price file</h3>
          <p className="muted sm">Every listing priced <b>above</b> market + markup is cut to it, <b>rounded up</b> to a whole dollar. Nothing is ever raised. Only the cuts go in the file, each marked <b>{METHOD}</b> — from then on POIZON keeps the price you upload for those listings instead of the one sent by the API.</p>
          <div className="er-controls">
            <label className="er-markup">
              <span className="muted xs">Markup over market</span>
              <span className="er-markup-field">
                <input type="text" inputMode="decimal" value={markup} aria-label="Markup percent" onChange={(e) => { setMarkup(e.target.value); setResult(null); }} />
                <span>%</span>
              </span>
              {pctH == null ? <span className="error xs">0 to 100, up to 2 decimals</span> : <span className="muted xs">× {multiplierLabel(pctH)} · $100 → ${poizonRepriceDollars(10000, pctH)} · $104.35 → ${poizonRepriceDollars(10435, pctH)}</span>}
            </label>
            <button type="button" className="btn primary" disabled={!canRun} onClick={run}>Build upload file</button>
          </div>
          {!mp.done && <p className="muted xs">Waiting for every price in step 2.</p>}
          {tpl && !tpl.ok && <p className="error xs">{tpl.error}</p>}

          {result && (
            <div className="er-result">
              <div className="er-result-head">Run at <b>{(result.pctH / 100).toString()}% markup (× {multiplierLabel(result.pctH)}), rounded up</b></div>
              <div className="er-stats">
                <Stat n={fmt(result.n.lower)} label="lowered" tone="ok" />
                <Stat n={fmt(result.n.higher)} label="kept (market higher)" />
                <Stat n={fmt(result.n.equal)} label="kept (equal)" />
                <Stat n={fmt(result.n.nodata)} label="no price data" tone={result.n.nodata ? 'warn' : ''} />
                <Stat n={fmt(result.n.skipped)} label="skipped" />
              </div>
              <p className="sm">Total reduction: <b>{money(result.n.reductionCents)}</b> across {fmt(result.n.lower)} listing{result.n.lower === 1 ? '' : 's'}.</p>
              {result.n.overLimit > 0 && <div className="notice">{fmt(result.n.overLimit)} of the cuts {result.n.overLimit === 1 ? 'is' : 'are'} still above the price limit POIZON names for that listing, so {result.n.overLimit === 1 ? 'it' : 'they'} may stay unlisted. The audit report says which.</div>}
              {result.verify && (
                <div className={`er-verify ${result.verify.ok ? 'pass' : 'fail'}`}>
                  <b>{result.verify.ok ? '✓ Verified — POIZON’s template with only the price cuts added' : '✗ Verification FAILED — download blocked'}</b>
                  <ul>{result.verify.checks.map((c) => <li key={c.label}>{c.ok ? '✓' : '✗'} {c.label} <span className="muted">— {c.detail}</span></li>)}</ul>
                </div>
              )}
              {!result.bytes && <p className="sm">Nothing to cut — no listing is above market + {pctLabel}% today.</p>}
              <div className="er-actions">
                {result.bytes && (
                  <button type="button" className="btn primary" disabled={!result.verify?.ok} onClick={() => download(result.name, result.bytes, XLSX_TYPE)}>
                    Download upload file — {result.name}</button>
                )}
                <button type="button" className="btn" onClick={() => download(result.name.replace(/^POIZON reprice/, 'POIZON reprice report').replace(/\.xlsx$/, '.csv'), reportText(result.report, (result.pctH / 100).toString()), 'text/csv;charset=utf-8')}>
                  Download audit report</button>
              </div>
              {result.bytes && <p className="muted xs">Upload it on POIZON: Listing → Smart Listing → Batch Import → <b>Import Updated Price &amp; Inventory</b>.</p>}
            </div>
          )}
        </div>
      )}
    </>
  );
}
