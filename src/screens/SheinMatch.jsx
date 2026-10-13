// SHEIN match screen (docs/context/shein-fix.md → "Match screen"). Search a shoe — SHEIN
// name, style code, seller SKU or SHEIN SKU — and see its SHEIN sizes next to the Shopify
// variants. For each SHEIN size, pick the Shopify SKU it should carry; only SAME-size
// variants are offered (a size SHEIN writes in EUR/CN or leaves blank shows them all, marked).
// The tool's own suggestions (swap / same style + size / AI) come pre-filled. Saved matches
// are shared by the team and feed the fix. Writing to SHEIN waits for the API keys.
import React, { useMemo, useState } from 'react';
import { api } from '../api.js';
import { compareSize, parseSize } from '../lib/sheinCheck.js';
import { addLabel } from '../lib/sheinFix.js';

const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const NEEDS = new Set(['swap', 'wrong_size', 'no_shopify', 'no_size', 'other_system', 'duplicate', 'no_seller_sku', 'pending_change']);
const PAGE = 40;
const sameSize = (sheinSize, shopifySize) => ['ok', 'ok_suffix', 'check_group'].includes(compareSize(sheinSize, shopifySize));
const checkable = (sheinSize) => parseSize(sheinSize).system === 'US';

// Shopify products, each with its variants in size order.
function productsOf(variants) {
  const by = new Map();
  for (const v of variants) {
    let p = by.get(v.productId);
    if (!p) { p = { productId: v.productId, title: v.productTitle, style: v.style, status: v.status, image: v.image, variants: [] }; by.set(v.productId, p); }
    p.variants.push(v);
  }
  for (const p of by.values()) p.variants.sort((a, b) => String(a.size).localeCompare(String(b.size), 'en', { numeric: true }));
  return by;
}

export function SheinMatch({ fix, variants, links, sheinApi, onSaved, onSignOut }) {
  const [q, setQ] = useState('');
  const [view, setView] = useState('needs');   // needs | decided | all
  const [openKey, setOpenKey] = useState(null);
  const [shown, setShown] = useState(PAGE);
  const products = useMemo(() => productsOf(variants), [variants]);

  // SHEIN products (by SPU) with their sizes and what the fix thinks of each.
  const groups = useMemo(() => {
    const by = new Map();
    for (const r of fix.rows) {
      const k = r.spu || r.name || r.sellerSku;
      let g = by.get(k);
      if (!g) { g = { key: k, name: r.name, spu: r.spu, image: r.image, rows: [] }; by.set(k, g); }
      g.rows.push(r);
    }
    return [...by.values()].map((g) => ({ ...g,
      needs: g.rows.filter((r) => NEEDS.has(r.reason) && !(links[r.sheinSku] && r.reason !== 'pending_change')).length,
      decided: g.rows.filter((r) => links[r.sheinSku]).length }));
  }, [fix, links]);
  const shownGroups = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return groups.filter((g) => (view === 'all' || (view === 'needs' ? g.needs > 0 : g.decided > 0))
      && (!words.length || words.every((w) => [g.name, g.spu, ...g.rows.flatMap((r) => [r.sellerSku, r.sheinSku, r.variant?.productTitle, r.variant?.style])]
        .join(' ').toLowerCase().includes(w))))
      .sort((a, b) => b.needs - a.needs || String(a.name).localeCompare(String(b.name)));
  }, [groups, q, view]);
  const counts = { needs: groups.filter((g) => g.needs > 0).length, decided: groups.filter((g) => g.decided > 0).length, all: groups.length };

  return (
    <div className="card">
      <h3 className="er-step-title">Match sizes</h3>
      <p className="muted sm">Pick, for each SHEIN size, the Shopify SKU it should carry. Only the <b>same size</b> is offered. Matches are saved for the whole team; each one becomes a seller-SKU change to make on SHEIN, and the size sells Shopify’s stock again once SHEIN shows the new SKU.</p>
      <div className="ebl-filters">
        <input type="search" className="input" value={q} onChange={(e) => { setQ(e.target.value); setShown(PAGE); }} placeholder="Search shoe, style code, seller SKU, SHEIN SKU…" aria-label="Search SHEIN shoes to match" />
        <div className="seg sm">
          {[['needs', 'Needs a match'], ['decided', 'Matched'], ['all', 'All']].map(([k, l]) => (
            <button key={k} type="button" className={`seg-btn${view === k ? ' on' : ''}`} aria-pressed={view === k} onClick={() => { setView(k); setShown(PAGE); }}>{l} <span className="seg-n">{fmt(counts[k])}</span></button>
          ))}
        </div>
      </div>
      {!shownGroups.length ? <p className="muted">{view === 'needs' ? 'Nothing needs a match.' : 'Nothing matches.'}</p> : shownGroups.slice(0, shown).map((g) => (
        <div key={g.key} className={`shm-group${openKey === g.key ? ' open' : ''}`}>
          <button type="button" className="shm-head" aria-expanded={openKey === g.key} onClick={() => setOpenKey(openKey === g.key ? null : g.key)}>
            {g.image ? <img className="ebl-thumb" src={g.image} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <span className="ebl-thumb ebl-thumb-empty" aria-hidden="true" />}
            <span className="ebl-orphan-main">
              <span className="ebl-title">{g.name || '(no name)'}</span>
              <span className="muted xs">{g.rows.length} SHEIN size{g.rows.length === 1 ? '' : 's'}{g.spu ? ` · SPU ${g.spu}` : ''}</span>
              <span className="xs">{g.needs > 0 && <span className="ebo-chip bad">{g.needs} need a match</span>}{g.decided > 0 && <span className="ebo-chip ok">{g.decided} matched</span>}</span>
            </span>
            <span className="muted" aria-hidden="true">{openKey === g.key ? '▾' : '▸'}</span>
          </button>
          {openKey === g.key && <MatchEditor group={g} products={products} variants={variants} links={links} sheinApi={sheinApi} onSaved={onSaved} onSignOut={onSignOut} />}
        </div>
      ))}
      {shownGroups.length > shown && <button type="button" className="btn ghost sm mt" onClick={() => setShown((n) => n + PAGE * 3)}>Show more ({fmt(shownGroups.length - shown)} left)</button>}
    </div>
  );
}

function MatchEditor({ group, products, variants, links, sheinApi, onSaved, onSignOut }) {
  // The Shopify product to match against: the one most of its sizes already point at (or are
  // suggested to), else the first suggestion.
  const guess = useMemo(() => {
    const votes = new Map();
    for (const r of group.rows) {
      const sku = links[r.sheinSku]?.link_sku || r.linkTo?.sku || r.variant?.sku;
      const v = sku && variants.find((x) => String(x.sku) === String(sku));
      if (v) votes.set(v.productId, (votes.get(v.productId) || 0) + 1);
    }
    return [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  }, [group, links, variants]);
  const [productId, setProductId] = useState(guess);
  const [find, setFind] = useState('');
  const [pick, setPick] = useState(() => Object.fromEntries(group.rows.map((r) => {
    const d = links[r.sheinSku];
    if (d) return [r.sheinSku, d.decision === 'delist' ? 'delist' : d.link_sku];
    if (r.linkTo?.sku) return [r.sheinSku, r.linkTo.sku];
    return [r.sheinSku, r.reason === 'ok' ? r.sellerSku : ''];
  })));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const product = productId ? products.get(productId) : null;

  const found = useMemo(() => {
    const words = find.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    return [...products.values()].filter((p) => words.every((w) => [p.title, p.style, ...p.variants.map((v) => v.sku)].join(' ').toLowerCase().includes(w))).slice(0, 8);
  }, [find, products]);

  // What changed against what's saved / what SHEIN already carries.
  const changes = group.rows.filter((r) => r.sheinSku).map((r) => {
    const want = pick[r.sheinSku] || '';
    const saved = links[r.sheinSku];
    const savedVal = saved ? (saved.decision === 'delist' ? 'delist' : saved.link_sku) : null;
    return { r, want, dirty: want !== '' && want !== (savedVal ?? (r.reason === 'ok' ? r.sellerSku : '')) };
  }).filter((c) => c.dirty);

  async function save() {
    setBusy(true); setMsg('');
    try {
      await api.sheinLinksSave(changes.map(({ r, want }) => ({
        sheinSku: r.sheinSku, spu: r.spu, skc: r.skc, sheinSize: r.size, sellerSkuWas: r.sellerSku,
        linkSku: want === 'delist' ? null : want, decision: want === 'delist' ? 'delist' : 'link',
        source: r.linkTo?.sku === want ? (r.linkTo.by === 'ai' ? 'ai' : r.reason === 'swap' ? 'swap' : 'rule') : 'person',
      })));
      setMsg(`Saved ${changes.length} match${changes.length === 1 ? '' : 'es'}.`);
      onSaved();
    } catch (e) { if (e.unauthorized) onSignOut(); else setMsg(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="shm-editor">
      <div className="shm-product">
        <span className="muted xs">Shopify product</span>
        {product ? <b className="sm">{product.title}</b> : <span className="sm error">None chosen — search for it</span>}
        <input type="search" className="input" value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find another Shopify product (name, style code, SKU)…" aria-label="Find Shopify product" />
        {found.length > 0 && (
          <div className="shm-found">
            {found.map((p) => <button key={p.productId} type="button" className={`btn ghost sm${p.productId === productId ? ' on' : ''}`} onClick={() => { setProductId(p.productId); setFind(''); }}>{p.title}{p.status && p.status !== 'ACTIVE' ? ` (${p.status.toLowerCase()})` : ''}</button>)}
          </div>
        )}
      </div>
      <div className="ap-tablewrap">
        <table className="table shc-table">
          <thead><tr><th>SHEIN size</th><th>Seller SKU on SHEIN now</th><th>Should carry</th><th className="num">Shopify stock</th></tr></thead>
          <tbody>
            {group.rows.map((r) => {
              const options = (product?.variants || []).filter((v) => !checkable(r.size) || sameSize(r.size, v.size));
              const val = pick[r.sheinSku] || '';
              const chosen = val && val !== 'delist' ? variants.find((v) => String(v.sku) === String(val)) : null;
              const suggested = r.linkTo?.sku && !links[r.sheinSku] ? r.linkTo : null;
              // Keep a saved/suggested SKU selectable even if it's from another product.
              const extra = chosen && !options.some((o) => o.sku === chosen.sku) ? [chosen] : [];
              return (
                <tr key={r.line} className={r.reason === 'ok' && !links[r.sheinSku] ? '' : links[r.sheinSku] ? '' : 'warn'}>
                  <td><b>{r.size || '—'}</b>{!checkable(r.size) && <div className="ebl-note warn xs">can’t be size-checked</div>}<div className="muted xs ebl-sku">{r.sheinSku}</div></td>
                  <td>
                    <span className="ebl-sku">{r.sellerSku || '—'}</span>
                    <div className="muted xs">{r.variant ? `= Shopify size ${r.variant.size}` : r.sellerSku ? 'not in Shopify' : ''}</div>
                    {r.reason === 'ok' && !links[r.sheinSku] ? <span className="ebo-chip ok">correct</span> : null}
                  </td>
                  <td>
                    <select className="input shm-select" value={val} disabled={!r.sheinSku} aria-label={`Shopify SKU for SHEIN ${r.size}`}
                      onChange={(e) => setPick((p) => ({ ...p, [r.sheinSku]: e.target.value }))}>
                      <option value="">— choose —</option>
                      {[...extra, ...options].map((v) => <option key={v.sku} value={v.sku}>{v.sku} · size {v.size} · {Math.max(0, Number(v.qty || 0))} in stock{checkable(r.size) ? '' : ' (check the size!)'}</option>)}
                      <option value="delist">Stop selling this size (delist)</option>
                    </select>
                    {suggested && <div className="xs muted">suggested: {suggested.sku} ({suggested.by === 'ai' ? 'AI, size verified' : r.reason === 'swap' ? 'swap' : 'same style + size'})</div>}
                    {links[r.sheinSku] && <div className="xs muted">saved by {links[r.sheinSku].decided_by || '—'}</div>}
                    {product && !options.length && checkable(r.size) && (() => {
                      const takenBy = group.rows.find((o) => o !== r && pick[o.sheinSku] === r.sellerSku);
                      return <div className="xs ebl-note warn">No Shopify size {r.size.replace(/^US/i, '')} in this product — choose “Stop selling”.{r.variant
                        ? takenBy ? ` Its SKU moves to SHEIN ${takenBy.size}.` : ` Shopify size ${r.variant.size} then needs its own SHEIN size (${addLabel(r.variant.size)}).`
                        : ''}</div>;
                    })()}
                  </td>
                  <td className="num">{chosen ? fmt(Math.max(0, Number(chosen.qty || 0))) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="er-actions">
        <button type="button" className="btn primary" disabled={busy || !changes.length} onClick={save}>{busy ? 'Saving…' : `Save ${changes.length || ''} match${changes.length === 1 ? '' : 'es'}`}</button>
        <button type="button" className="btn" disabled title="Waiting for SHEIN API access">Save to SHEIN</button>
        <span className="muted xs">{sheinApi?.connected ? 'SHEIN is connected — writing straight to SHEIN is the next build.' : 'Save to SHEIN turns on when SHEIN approves our API access.'}</span>
        {msg && <span className="xs">{msg}</span>}
      </div>
    </div>
  );
}
