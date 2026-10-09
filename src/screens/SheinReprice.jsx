// SHEIN Reprice (PH) — cut every SHEIN listing priced above today's market down to
// market + markup, never up (docs/context/shein-reprice.md). Three steps on one page:
//   1 Files      SHEIN's Export Products .xlsx (+ the Edit+Price template — built in, a
//                newer one can be dropped in instead)
//   2 Prices     the shared, resumable market-price step (same lookups + daily cache as
//                eBay Reprice, so a style priced there today costs nothing here)
//   3 Reprice    markup (default 15 %, never remembered), rounded UP to a whole dollar,
//                verify, then the filled template + an audit report
// The reading / filling / verifying is all src/lib/sheinReprice.js — pure.
import React, { useEffect, useMemo, useState } from 'react';
import { TopBar } from '../components/common.jsx';
import { useMarketPrices, MarketPricesStep } from '../components/MarketPrices.jsx';
import { estToday } from '../lib/format.js';
import { parseMarkup, multiplierLabel } from '../lib/ebayReprice.js';
import {
  readExportFile, readTemplateFile, jobsFor, skipReason, sheinRepriceDollars, applyReprice,
  fillTemplate, verifyOutput, outputName, reportText,
} from '../lib/sheinReprice.js';

const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const money = (cents) => `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
const BUILT_IN = '/templates/shein-edit-price.xlsx';
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function download(name, data, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function FileField({ id, label, hint, file, result, onFile }) {
  return (
    <div className={`er-file${result?.ok ? ' ok' : result && !result.ok ? ' bad' : ''}`}>
      <label htmlFor={id} className="er-file-label">{label}</label>
      <div className="muted xs">{hint}</div>
      <input id={id} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
      {file && <div className="er-file-name">{file.name}</div>}
      {result && !result.ok && <div className="error xs">{result.error}</div>}
      {result?.ok && result.summary && <div className="er-file-ok xs">✓ {result.summary}</div>}
    </div>
  );
}

function Stat({ n, label, tone }) {
  return <div className={`er-stat${tone ? ` ${tone}` : ''}`}><b>{n}</b><span>{label}</span></div>;
}

export function SheinReprice({ onHome, onSignOut }) {
  const [exportFile, setExportFile] = useState(null);
  const [exp, setExp] = useState(null);
  const [tplFile, setTplFile] = useState(null);   // null = the built-in template
  const [tpl, setTpl] = useState(null);
  const [markup, setMarkup] = useState('15');   // never remembered: every fresh run starts at 15 %
  const [result, setResult] = useState(null);

  // The built-in template, fetched once. A dropped-in one replaces it for this run.
  useEffect(() => {
    let live = true;
    fetch(BUILT_IN).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((buf) => { if (live && !tplFile) { const t = readTemplateFile(new Uint8Array(buf)); setTpl(t.ok ? { ...t, summary: 'SHEIN Edit+Price template (built in)' } : t); } })
      .catch((e) => { if (live && !tplFile) setTpl({ ok: false, error: `Could not load the built-in template (${e.message}) — drop SHEIN’s Edit+Price file in below.` }); });
    return () => { live = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function pickExport(f) {
    setExportFile(f); setResult(null);
    const r = readExportFile(new Uint8Array(await f.arrayBuffer()));
    setExp(r.ok ? { ...r, summary: `${fmt(r.stats.rows)} listings (SKUs)` } : r);
  }
  async function pickTemplate(f) {
    setTplFile(f); setResult(null);
    const t = readTemplateFile(new Uint8Array(await f.arrayBuffer()));
    setTpl(t.ok ? { ...t, summary: t.extra ? `sheet1 has ${fmt(t.extra)} filled rows — they’ll be replaced` : 'sheet1 is empty — ready' } : t);
  }

  const rows = exp?.ok ? exp.rows : null;
  const jobs = useMemo(() => (rows ? jobsFor(rows) : []), [rows]);
  const skipped = useMemo(() => {
    if (!rows) return [];
    const by = new Map();
    for (const x of rows) {
      const why = skipReason(x);
      if (!why) continue;
      const k = why.startsWith('Size "') ? 'Size isn’t a single US size (EUR, CN, Toddler, 7-8…)' : why;
      by.set(k, (by.get(k) || 0) + 1);
    }
    return [...by];
  }, [rows]);
  const mp = useMarketPrices(jobs, onSignOut);
  const pctH = parseMarkup(markup);

  function run() {
    if (pctH == null || !tpl?.ok) return;
    const out = applyReprice(rows, mp.cacheRef.current, pctH);
    const bytes = out.upload.length ? fillTemplate(tpl.bytes, out.upload) : null;
    const verify = bytes ? verifyOutput(tpl.bytes, bytes, out.upload, rows) : null;
    setResult({ ...out, bytes, verify, pctH, name: outputName(exportFile?.name, estToday()) });
  }

  const canPrice = !!rows && jobs.length > 0;
  const canRun = mp.ready && pctH != null && !!tpl?.ok;
  const pctLabel = pctH == null ? '' : (pctH / 100).toString();

  return (
    <div className="app">
      <TopBar title="SHEIN Reprice" onHome={onHome} onSignOut={onSignOut} />

      <div className="card er-step">
        <h3 className="er-step-title"><span className="er-num">1</span> Files</h3>
        <p className="muted sm">Your file is only read, never changed. The upload is SHEIN’s own Edit+Price template, filled from row 4 down and checked before you can download it.</p>
        <div className="er-files">
          <FileField id="sr-export" label="SHEIN Export Products file" file={exportFile} result={exp} onFile={pickExport}
            hint="SHEIN Seller Center → Products → Export Products — e.g. Export Products_2026-10-09 13_36_02.xlsx" />
          <FileField id="sr-template" label="Edit+Price template (optional)" file={tplFile} result={tpl} onFile={pickTemplate}
            hint="Built in — only drop a file here if SHEIN changes their template." />
        </div>
        {rows && (
          <>
            <div className="er-stats mt">
              <Stat n={fmt(rows.length - skipped.reduce((n, [, c]) => n + c, 0))} label="listings to price" />
              <Stat n={fmt(jobs.length)} label="style + size lookups" />
              <Stat n={fmt(skipped.reduce((n, [, c]) => n + c, 0))} label="skipped (left as they are)" tone={skipped.length ? 'warn' : ''} />
            </div>
            {skipped.length > 0 && (
              <ul className="muted xs mt">{skipped.map(([why, n]) => <li key={why}>{fmt(n)} — {why}</li>)}</ul>
            )}
            {exp.dupes > 0 && <div className="notice mt">{fmt(exp.dupes)} SKU{exp.dupes === 1 ? ' appears' : 's appear'} twice in the export — only one price per SKU is sent.</div>}
          </>
        )}
      </div>

      {canPrice && <MarketPricesStep mp={mp} num={2} hint="Keep this tab open while it runs — prices fetched today on eBay Reprice are reused." onCleared={() => setResult(null)} />}

      {canPrice && (
        <div className="card er-step">
          <h3 className="er-step-title"><span className="er-num">3</span> Reprice</h3>
          <p className="muted sm">Every listing priced <b>above</b> market + markup is cut to it, <b>rounded up</b> to a whole dollar. Nothing is ever raised. Only the cuts go in the upload file; everything else on SHEIN stays as it is.</p>
          <div className="er-controls">
            <label className="er-markup">
              <span className="muted xs">Markup over market</span>
              <span className="er-markup-field">
                <input type="text" inputMode="decimal" value={markup} aria-label="Markup percent" onChange={(e) => { setMarkup(e.target.value); setResult(null); }} />
                <span>%</span>
              </span>
              {pctH == null ? <span className="error xs">0 to 100, up to 2 decimals</span> : <span className="muted xs">× {multiplierLabel(pctH)} · $100 → ${sheinRepriceDollars(10000, pctH)} · $104.35 → ${sheinRepriceDollars(10435, pctH)}</span>}
            </label>
            <button type="button" className="btn primary" disabled={!canRun} onClick={run}>Build upload file</button>
          </div>
          {!mp.done && <p className="muted xs">Waiting for every price in step 2.</p>}
          {tpl && !tpl.ok && <p className="error xs">{tpl.error}</p>}

          {result && (
            <div className="er-result">
              <div className="er-result-head">Run at <b>{pctLabel}% markup (× {multiplierLabel(result.pctH)}), rounded up</b></div>
              <div className="er-stats">
                <Stat n={fmt(result.n.lower)} label="lowered" tone="ok" />
                <Stat n={fmt(result.n.higher)} label="kept (market higher)" />
                <Stat n={fmt(result.n.equal)} label="kept (equal)" />
                <Stat n={fmt(result.n.special)} label="kept (special offer in the way)" tone={result.n.special ? 'warn' : ''} />
                <Stat n={fmt(result.n.nodata)} label="no price data" tone={result.n.nodata ? 'warn' : ''} />
                <Stat n={fmt(result.n.skipped)} label="skipped" />
              </div>
              <p className="sm">Total reduction: <b>{money(result.n.reductionCents)}</b> across {fmt(result.n.lower)} listing{result.n.lower === 1 ? '' : 's'}.</p>
              {result.verify && (
                <div className={`er-verify ${result.verify.ok ? 'pass' : 'fail'}`}>
                  <b>{result.verify.ok ? '✓ Verified — SHEIN’s template with only the price cuts added' : '✗ Verification FAILED — download blocked'}</b>
                  <ul>{result.verify.checks.map((c) => <li key={c.label}>{c.ok ? '✓' : '✗'} {c.label} <span className="muted">— {c.detail}</span></li>)}</ul>
                </div>
              )}
              {!result.bytes && <p className="sm">Nothing to cut — no listing is above market + {pctLabel}% today.</p>}
              <div className="er-actions">
                {result.bytes && (
                  <button type="button" className="btn primary" disabled={!result.verify?.ok} onClick={() => download(result.name, result.bytes, XLSX_TYPE)}>
                    Download upload file — {result.name}</button>
                )}
                <button type="button" className="btn" onClick={() => download(result.name.replace(/^SHEIN reprice/, 'SHEIN reprice report').replace(/\.xlsx$/, '.csv'), reportText(result.report, pctLabel), 'text/csv;charset=utf-8')}>
                  Download audit report</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
