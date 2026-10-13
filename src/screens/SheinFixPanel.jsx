// SHEIN listing fix (docs/context/shein-fix.md) — the panel under the SHEIN check. One
// download sets every SHEIN size's stock from Shopify by the hard-coded rules
// (src/lib/sheinFix.js); the fix list says which seller SKUs to change and which sizes to
// add. The AI helper only suggests links for dead SKUs the rules couldn't place, and each
// suggestion is re-checked by the rules before it's used. Nothing is written to SHEIN or
// Shopify from here — the file is uploaded in SHEIN Seller Center.
import React, { useMemo, useState } from 'react';
import { api } from '../api.js';
import { downloadCSV } from '../lib/csv.js';
import { estToday } from '../lib/format.js';
import { XLSX_MIME } from '../lib/xlsx.js';
import {
  readSheinOrders, readInventoryTemplate, fillInventoryTemplate, verifyInventoryFile, plainInventoryXlsx,
  stockRows, fixListCsv, candidatesFor, verifyAiLink, addLabel, REASONS,
} from '../lib/sheinFix.js';

const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const AI_BATCH = 6;

function saveBytes(name, bytes, type = XLSX_MIME) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

function FilePick({ label, hint, onFile, picked }) {
  return (
    <label className="shf-pick">
      <span className="shf-pick-label">{label}</span>
      <span className="muted xs">{picked || hint}</span>
      <input type="file" hidden accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" aria-label={label}
        onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ''; }} />
    </label>
  );
}

// `fix` is computed by the page (SheinCheck) so the Match tab sees the same answer; the
// orders file and the AI's links live there too.
export function SheinFixPanel({ fix, variants, exportName, orders, setOrders, aiLinks, setAiLinks, onSignOut }) {
  const [tpl, setTpl] = useState(null);           // readInventoryTemplate + name
  const [ai, setAi] = useState(null);             // { done, total, running, model, tried, error }
  const [err, setErr] = useState('');
  const [verify, setVerify] = useState(null);
  const s = fix.summary;
  const changes = useMemo(() => stockRows(fix), [fix]);
  const relinks = fix.rows.filter((r) => r.linkTo);
  const toAdd = fix.sizesToAdd.filter((x) => !x.pendingSwap);
  const stamp = estToday();

  // The SHEIN sizes the rules couldn't place and that SHEIN still offers — grouped per
  // SHEIN product, each with the Shopify products most like it.
  const aiWork = useMemo(() => {
    const by = new Map();
    for (const r of fix.rows) {
      if (r.reason !== 'no_shopify' || r.linkTo || !(Number(r.qty) > 0)) continue;   // decided / linked ones never reach here
      const k = r.spu || r.name;
      let p = by.get(k);
      if (!p) { p = { key: k, name: r.name, sizes: [] }; by.set(k, p); }
      p.sizes.push({ line: r.line, sellerSku: r.sellerSku, size: r.size });
    }
    return [...by.values()].map((p) => ({ ...p, candidates: candidatesFor(p.name, variants) })).filter((p) => p.candidates.length);
  }, [fix, variants]);

  async function pickOrders(f) {
    if (!f) return;
    setErr('');
    const r = readSheinOrders(new Uint8Array(await f.arrayBuffer()));
    if (!r.ok) return setErr(r.error);
    setOrders({ name: f.name, bySku: r.bySku, open: r.open });
  }
  async function pickTemplate(f) {
    if (!f) return;
    setErr('');
    const t = readInventoryTemplate(new Uint8Array(await f.arrayBuffer()));
    if (!t.ok) return setErr(t.error);
    setTpl({ ...t, name: f.name });
  }

  async function askAi() {
    setErr('');
    const st = { done: 0, total: aiWork.length, running: true, model: null, tried: 0, accepted: 0, error: null };
    setAi({ ...st });
    const rowsByLine = new Map(fix.rows.map((r) => [r.line, r]));
    const found = { ...aiLinks };
    for (let i = 0; i < aiWork.length; i += AI_BATCH) {
      const batch = aiWork.slice(i, i + AI_BATCH);
      try {
        const r = await api.sheinFixAi(batch.map((p) => ({ key: p.key, name: p.name, sizes: p.sizes,
          candidates: p.candidates.map((c) => ({ productId: c.productId, title: c.title, variants: c.variants.map((v) => ({ sku: v.sku, size: v.size })) })) })));
        st.model = r.model;
        for (const m of r.matches || []) {
          if (!m.productId || m.confidence < 0.6) continue;
          for (const x of m.sizes || []) {
            st.tried++;
            const row = rowsByLine.get(x.line);
            const link = row && verifyAiLink(row, { productId: m.productId, shopifySku: x.shopifySku, reason: m.reason }, variants);
            if (link) { found[x.line] = link; st.accepted++; }
          }
        }
      } catch (e) {
        if (e.unauthorized) return onSignOut();
        st.error = e.message;
        break;
      }
      st.done += batch.length;
      setAi({ ...st });
    }
    setAiLinks(found);
    setAi({ ...st, running: false });
  }

  function downloadInventory() {
    setVerify(null);
    if (tpl) {
      const out = fillInventoryTemplate(tpl, changes);
      const v = verifyInventoryFile(tpl, out, changes);
      setVerify(v);
      if (!v.ok) return;
      saveBytes(`SHEIN inventory fix (${stamp}).xlsx`, out);
    } else {
      saveBytes(`SHEIN inventory fix (${stamp}) - plain.xlsx`, plainInventoryXlsx(changes));
    }
  }

  return (
    <div className="card shf">
      <h3 className="er-step-title">Fix the listings</h3>
      <div className="notice sm"><b>First, pause 4seller’s SHEIN inventory sync.</b> Otherwise its next sync puts the wrong numbers back.</div>
      <p className="muted sm mt">The rules: every SHEIN size gets the <b>exact Shopify stock</b> of the variant its seller SKU points at, minus SHEIN orders not shipped yet. A SHEIN size whose seller SKU is <b>another size</b>, gone from Shopify, blank or in EUR/CN gets <b>0</b>, because the warehouse ships whatever SKU the order carries. Those are listed below with the exact change to make on SHEIN, and they sell again on the next fix.</p>

      <div className="shf-picks">
        <FilePick label="SHEIN orders export (optional)" hint="Holds back pairs sold on SHEIN but not shipped yet" picked={orders && `${orders.name} · ${fmt(orders.open.length)} open order line${orders.open.length === 1 ? '' : 's'} held back`} onFile={pickOrders} />
        <FilePick label="SHEIN inventory template (optional)" hint="Seller Center → batch edit inventory → download template; we fill it so it uploads as-is" picked={tpl && `${tpl.name} · sheet “${tpl.sheet}”, columns ${tpl.headers[tpl.cols.sku]} + ${tpl.headers[tpl.cols.qty]}${tpl.cols.wh >= 0 ? ` + ${tpl.headers[tpl.cols.wh]}` : ''}`} onFile={pickTemplate} />
      </div>
      {err && <div className="error mt">{err}</div>}

      <div className="er-stats mt">
        <div className="er-stat"><b>{fmt(s.changed)}</b><span>SHEIN sizes change stock</span></div>
        <div className="er-stat bad"><b>{fmt(s.toZero)}</b><span>stop selling (set to 0)</span></div>
        <div className="er-stat"><b>{fmt(s.pairsBefore)} → {fmt(s.pairsAfter)}</b><span>pairs offered on SHEIN</span></div>
        <div className="er-stat"><b>{fmt(relinks.length)}</b><span>seller SKUs to change{s.linksAi ? ` (${fmt(s.linksAi)} by AI)` : ''}</span></div>
        <div className="er-stat"><b>{fmt(toAdd.length)}</b><span>Shopify sizes to add on SHEIN</span></div>
      </div>

      <div className="er-actions">
        <button type="button" className="btn primary" disabled={!changes.length} onClick={downloadInventory}>⬇ SHEIN inventory file ({fmt(changes.length)} SKUs)</button>
        <button type="button" className="btn" onClick={() => downloadCSV(`SHEIN fix list (${stamp}).csv`, fixListCsv(fix))}>⬇ Fix list — what to change on SHEIN (CSV)</button>
      </div>
      {!tpl && <p className="muted xs">Without SHEIN’s template you get a plain sheet (SHEIN SKU · new inventory) to copy into SHEIN’s. Load the template once and the file uploads as-is.</p>}
      {verify && <p className={verify.ok ? 'muted xs' : 'error xs'}>{verify.ok ? `✓ Checked: ${verify.detail}` : `✗ Not downloaded — ${verify.detail}`}</p>}
      {exportName && <p className="muted xs">Built from {exportName}. Upload the file in SHEIN Seller Center, then export again and re-check: the list should be down to the seller-SKU changes.</p>}

      <div className="shf-ai mt">
        <div>
          <b className="sm">AI helper</b>
          <p className="muted xs">{fmt(s.unresolved)} SHEIN size{s.unresolved === 1 ? '' : 's'} still offered point at a seller SKU Shopify no longer has, and the rule (same style code + size) couldn’t place them. The AI suggests which Shopify variant each should link to; a suggestion is used only if the rules confirm the same shoe and the same size. It never changes stock.</p>
        </div>
        {ai?.running
          ? <span className="muted sm">Asking AI… {fmt(ai.done)} of {fmt(ai.total)} products</span>
          : <button type="button" className="btn" disabled={!aiWork.length} onClick={askAi}>✨ Match {fmt(aiWork.length)} product{aiWork.length === 1 ? '' : 's'} with AI</button>}
      </div>
      {ai && !ai.running && <p className={ai.error ? 'error xs' : 'muted xs'}>{ai.error ? `AI stopped: ${ai.error}` : `${ai.model || 'AI'}: ${fmt(ai.accepted)} link${ai.accepted === 1 ? '' : 's'} confirmed by the rules (of ${fmt(ai.tried)} suggested) — added to the fix list.`}</p>}

      {relinks.length > 0 && (
        <details className="mt" open={relinks.length <= 30}>
          <summary className="sm"><b>Seller SKUs to change on SHEIN ({fmt(relinks.length)})</b></summary>
          <div className="ap-tablewrap">
            <table className="table shc-table">
              <thead><tr><th>SHEIN product</th><th>SHEIN size</th><th>Seller SKU now</th><th>Change to</th><th>Why</th></tr></thead>
              <tbody>
                {relinks.map((r) => (
                  <tr key={r.line}>
                    <td className="xs">{r.name}</td><td>{r.size}</td><td className="ebl-sku">{r.sellerSku}</td>
                    <td className="ebl-sku"><b>{r.linkTo.sku}</b> <span className="muted xs">(size {r.linkTo.size}{r.linkTo.by === 'ai' ? ', AI' : ''})</span></td>
                    <td className="xs">{r.reason === 'swap' ? 'Linked to another size' : r.linkTo.by === 'ai' ? `AI: ${r.linkTo.why}` : 'SKU gone; same style + size found'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
      {toAdd.length > 0 && (
        <details className="mt">
          <summary className="sm"><b>Shopify sizes in stock that SHEIN doesn’t sell — add them ({fmt(toAdd.length)})</b></summary>
          <p className="muted xs">If SHEIN’s size list hasn’t got the size (4, 4.5, 15.5W…), add it as a custom size value on SHEIN — never map it to the nearest size.</p>
          <div className="ap-tablewrap">
            <table className="table shc-table">
              <thead><tr><th>SHEIN product</th><th>Add size</th><th>Seller SKU</th><th className="num">Shopify stock</th></tr></thead>
              <tbody>
                {toAdd.map((a) => <tr key={a.sku}><td className="xs">{a.sheinName}</td><td><b>{addLabel(a.size)}</b></td><td className="ebl-sku">{a.sku}</td><td className="num">{a.qty}</td></tr>)}
              </tbody>
            </table>
          </div>
        </details>
      )}
      <details className="mt">
        <summary className="sm">Why each SHEIN size gets its number</summary>
        <ul className="xs">
          {Object.entries(s.byReason).sort((a, b) => b[1] - a[1]).map(([k, n]) => <li key={k}><b>{fmt(n)}</b> — {REASONS[k]}</li>)}
        </ul>
      </details>
    </div>
  );
}
