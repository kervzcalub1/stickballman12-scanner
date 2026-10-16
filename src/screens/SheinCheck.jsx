// SHEIN ↔ Shopify check (docs/context/shein-check.md). Upload SHEIN's Export Products
// file; every SHEIN size is matched to the live Shopify variant with the same seller SKU and
// checked: same size? same age group? does SHEIN offer more pairs than Shopify has? does
// the SKU still exist in Shopify? Read-only — nothing on SHEIN or Shopify changes. The fix
// list downloads as a CSV.
import React, { useEffect, useMemo, useState } from 'react';
import { TopBar } from '../components/common.jsx';
import { api } from '../api.js';
import { downloadCSV } from '../lib/csv.js';
import { estToday, PH_DATETIME } from '../lib/format.js';
import { SheinFixPanel } from './SheinFixPanel.jsx';
import { SheinMatch } from './SheinMatch.jsx';
import { SheinLivePanel } from './SheinLivePanel.jsx';
import { useLive } from '../hooks.js';
import { buildFix } from '../lib/sheinFix.js';
import { readSheinExport, checkRows, tally, groupByProduct, issuesCsv, exportDate, ISSUES, ISSUE_ORDER } from '../lib/sheinCheck.js';

const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const SHOW = 60;

function Thumb({ src }) {
  const [bad, setBad] = useState(false);
  return src && !bad ? <img className="ebl-thumb" src={src} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBad(true)} />
    : <span className="ebl-thumb ebl-thumb-empty" aria-hidden="true" />;
}

export function SheinCheck({ user, onHome, onSignOut }) {
  const isAdmin = user?.role === 'admin' || user?.role === 'superadmin';
  const [file, setFile] = useState(null);       // { name, rows }
  const [variants, setVariants] = useState(null);
  const [loadedAt, setLoadedAt] = useState(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [filter, setFilter] = useState('problems');   // problems | all | <issue key>
  const [q, setQ] = useState('');
  const [shown, setShown] = useState(SHOW);
  const [tab, setTab] = useState('check');           // check | match | fix
  const [links, setLinks] = useState({});            // SHEIN SKU → saved match (shein_links)
  const [orders, setOrders] = useState(null);        // SHEIN order export: { name, bySku, open }
  const [aiLinks, setAiLinks] = useState({});        // export line → AI link the rules verified
  const [sheinApi, setSheinApi] = useState(null);

  async function loadLinks() {
    try { const r = await api.sheinLinks(); setLinks(Object.fromEntries((r.links || []).map((l) => [l.shein_sku, l]))); }
    catch (e) { if (e.unauthorized) onSignOut(); }
  }
  useEffect(() => {
    loadLinks();
    api.sheinStatus().then(setSheinApi).catch(() => setSheinApi(null));
    // Back from SHEIN's approval page.
    const p = new URLSearchParams(window.location.search);
    if (p.get('shein_error')) setErr(p.get('shein_error'));
    if (p.get('shein') || p.get('shein_error')) window.history.replaceState(null, '', window.location.pathname);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useLive(['shein_links'], loadLinks, { mount: false });
  async function connectShein() {
    setErr('');
    try { const r = await api.sheinConnect(); window.location.href = r.url; }
    catch (e) { if (e.unauthorized) onSignOut(); else setErr(e.message); }
  }

  async function loadShopify() {
    setBusy('shopify'); setErr('');
    try {
      const r = await api.shopifyListingsVariants();
      setVariants(r.variants || []); setLoadedAt(new Date().toISOString());
      if (r.truncated) setErr('Shopify has more variants than one load reads — some SKUs may show as “Not in Shopify”.');
    } catch (e) { if (e.unauthorized) onSignOut(); else setErr(e.message); }
    finally { setBusy(''); }
  }
  async function pick(f) {
    if (!f) return;
    setErr(''); setBusy('file');
    try {
      const r = readSheinExport(new Uint8Array(await f.arrayBuffer()));
      if (!r.ok) { setErr(r.error); setFile(null); return; }
      setFile({ name: f.name, rows: r.rows });
      setShown(SHOW);
      if (!variants) await loadShopify();
    } catch (e) { setErr(`Couldn’t read that file: ${e.message}`); }
    finally { setBusy(''); }
  }

  const checked = useMemo(() => (file && variants ? checkRows(file.rows, variants) : null), [file, variants]);
  const t = useMemo(() => (checked ? tally(checked) : null), [checked]);
  const fix = useMemo(() => (checked ? buildFix(checked, variants, { openBySku: orders?.bySku || {}, aiLinks, decisions: links }) : null), [checked, variants, orders, aiLinks, links]);
  const products = useMemo(() => {
    if (!checked) return [];
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const keep = (r) => (filter === 'all' ? true
      : filter === 'problems' ? r.issues.some((i) => ISSUES[i].tone === 'bad' || ISSUES[i].tone === 'warn')
        : r.issues.includes(filter));
    return groupByProduct(checked)
      .map((g) => ({ ...g, rows: g.rows.filter(keep) }))
      .filter((g) => g.rows.length && (!words.length || words.every((w) => [g.name, g.spu, g.brand, ...g.rows.flatMap((r) => [r.sellerSku, r.size, r.variant?.productTitle])]
        .join(' ').toLowerCase().includes(w))));
  }, [checked, filter, q]);
  const sizesShown = products.reduce((n, g) => n + g.rows.length, 0);
  const age = file && exportDate(file.name);
  const stale = age && age < estToday();

  return (
    <div className="app">
      <TopBar title="SHEIN listings — check & fix" onHome={onHome} onSignOut={onSignOut} />
      {sheinApi?.connected && <SheinLivePanel isAdmin={isAdmin} onSignOut={onSignOut} />}
      <div className="card">
        <p className="muted sm">{sheinApi?.connected && <><b>From an export file</b> (the old way — the live fix above doesn’t need one). </>}Upload SHEIN’s <b>Export Products</b> file (Seller Center → Products → Export). Every SHEIN size is matched to the Shopify variant with the same <b>seller SKU</b> and checked for the wrong size, wrong age group, a SKU that’s gone from Shopify, and more stock on SHEIN than in Shopify. Nothing on SHEIN or Shopify is changed.</p>
        <div className="shc-upload">
          <label className="btn primary">
            {busy === 'file' ? 'Reading…' : file ? 'Choose another export' : 'Choose SHEIN export (.xlsx)'}
            <input type="file" hidden accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" aria-label="SHEIN export file"
              onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
          </label>
          {file && <span className="sm"><b>{file.name}</b> · {fmt(file.rows.length)} SHEIN sizes</span>}
          {variants && <button type="button" className="btn ghost sm" disabled={!!busy} onClick={loadShopify}>{busy === 'shopify' ? 'Reading Shopify…' : '↻ Re-read Shopify'}</button>}
          {busy === 'shopify' && !variants && <span className="muted sm">Reading every Shopify variant…</span>}
        </div>
        {variants && <p className="muted xs">Shopify read {PH_DATETIME.format(new Date(loadedAt))} EST · {fmt(variants.length)} variants.</p>}
        {sheinApi && (
          <p className="muted xs">SHEIN API: {sheinApi.connected ? <b className="ebl-ok">connected</b>
            : !sheinApi.configured ? 'waiting for SHEIN to approve our developer app — until then, fixes go through SHEIN’s upload files.'
              : isAdmin ? <button type="button" className="btn xs" onClick={connectShein}>Connect SHEIN</button> : 'not connected yet — an admin connects it.'}</p>
        )}
        {stale && <p className="notice xs">This export is from <b>{age}</b>. Sizes don’t change with time, but the stock columns do — export again for an exact stock check.</p>}
        {err && <div className="error mt">{err}</div>}
      </div>

      {t && (
        <div className="ebl-tabs seg">
          {[['check', 'Problems'], ['match', 'Match sizes'], ['fix', 'Fix & download']].map(([k, l]) => (
            <button key={k} type="button" className={`seg-btn${tab === k ? ' on' : ''}`} aria-pressed={tab === k} onClick={() => setTab(k)}>{l}</button>
          ))}
        </div>
      )}
      {t && tab === 'match' && <SheinMatch fix={fix} variants={variants} links={links} sheinApi={sheinApi} onSaved={loadLinks} onSignOut={onSignOut} />}
      {t && tab === 'fix' && <SheinFixPanel fix={fix} variants={variants} exportName={file?.name} orders={orders} setOrders={setOrders} aiLinks={aiLinks} setAiLinks={setAiLinks} onSignOut={onSignOut} />}
      {t && tab === 'check' && (
        <>
          <div className="card">
            <div className="shc-tiles">
              {ISSUE_ORDER.filter((k) => t[k] > 0 || ISSUES[k].tone === 'bad').map((k) => (
                <button key={k} type="button" className={`shc-tile ${ISSUES[k].tone}${filter === k ? ' on' : ''}`} aria-pressed={filter === k}
                  onClick={() => { setFilter(filter === k ? 'problems' : k); setShown(SHOW); }} title={ISSUES[k].help}>
                  <b>{fmt(t[k])}</b><span>{ISSUES[k].label}</span>
                </button>
              ))}
              <div className="shc-tile ok"><b>{fmt(t.clean)}</b><span>of {fmt(t.total)} sizes OK</span></div>
            </div>
            {filter !== 'problems' && filter !== 'all' && <p className="muted xs mt">{ISSUES[filter].help}</p>}
            <div className="er-actions">
              <button type="button" className="btn primary" onClick={() => downloadCSV(`SHEIN check ${age || estToday()}.csv`, issuesCsv(checked))}>⬇ Fix list (CSV)</button>
            </div>
          </div>

          <div className="card">
            <div className="ebl-filters">
              <input type="search" className="input" value={q} onChange={(e) => { setQ(e.target.value); setShown(SHOW); }} placeholder="Search product, seller SKU, size…" aria-label="Search SHEIN sizes" />
              <div className="seg sm">
                {[['problems', 'Problems'], ['all', 'Everything']].map(([k, l]) => (
                  <button key={k} type="button" className={`seg-btn${filter === k ? ' on' : ''}`} aria-pressed={filter === k} onClick={() => { setFilter(k); setShown(SHOW); }}>{l}</button>
                ))}
              </div>
            </div>
            <p className="muted xs">{fmt(products.length)} product{products.length === 1 ? '' : 's'} · {fmt(sizesShown)} size{sizesShown === 1 ? '' : 's'} — worst first.</p>
            {!products.length ? <p className="muted">{filter === 'problems' ? 'No problems found.' : 'Nothing matches.'}</p> : products.slice(0, shown).map((g) => (
              <div key={g.key} className="shc-product">
                <div className="shc-head">
                  <Thumb src={g.image} />
                  <span className="ebl-orphan-main">
                    <span className="ebl-title">{g.name || '(no name)'}</span>
                    <span className="muted xs">{[g.brand, g.spu && `SPU ${g.spu}`].filter(Boolean).join(' · ')}{g.link && <> · <a className="ebl-link" href={g.link} target="_blank" rel="noreferrer">on SHEIN ↗</a></>}</span>
                  </span>
                </div>
                <div className="ap-tablewrap">
                  <table className="table shc-table">
                    <thead><tr><th>Seller SKU</th><th>SHEIN size</th><th>Shopify size</th><th className="num">SHEIN stock</th><th className="num">Shopify stock</th><th>Finding</th></tr></thead>
                    <tbody>
                      {g.rows.map((r) => {
                        const worst = r.issues.find((i) => ISSUES[i].tone === 'bad') || r.issues.find((i) => ISSUES[i].tone === 'warn');
                        return (
                          <tr key={r.line} className={worst ? ISSUES[worst].tone : ''}>
                            <td className="ebl-sku">{r.sellerSku || '—'}</td>
                            <td className={r.issues.some((i) => ['wrong_size', 'wrong_group', 'blank', 'check_group', 'other_system'].includes(i)) ? 'shc-bad' : ''}>{r.size || '—'}</td>
                            <td>{r.variant ? r.variant.size || '—' : <span className="muted">—</span>}</td>
                            <td className={`num${r.issues.includes('over_stock') ? ' shc-bad' : ''}`}>{fmt(r.qty)}</td>
                            <td className="num">{r.shopifyQty == null ? '—' : fmt(r.shopifyQty)}</td>
                            <td className="xs">
                              {r.issues.length ? r.issues.map((i) => <span key={i} className={`ebo-chip ${ISSUES[i].tone === 'info' ? 'info' : ISSUES[i].tone}`} title={ISSUES[i].help}>{ISSUES[i].label}</span>)
                                : <span className="ebo-chip ok">{r.sizeVerdict === 'ok_suffix' ? ISSUES.ok_suffix.label : 'OK'}</span>}
                              {r.variant && r.variant.productTitle !== g.name && <div className="muted xs">Shopify: {r.variant.productTitle}</div>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
            {products.length > shown && <button type="button" className="btn ghost sm mt" onClick={() => setShown((n) => n + SHOW * 3)}>Show more ({fmt(products.length - shown)} left)</button>}
          </div>
        </>
      )}
    </div>
  );
}
