// Alias Cross-Listing (docs/context/alias-cross-listing.md) — one pair listed on Alias under
// several SKUs that are the same shoe (re-releases with a new style code), to take whichever
// SKU's price is better. A sale on any SKU takes one listing down on every other.
//   New       search Alias by NAME → tick the entries that are the same shoe (photo, SKU,
//             release) → every size with each SKU's market → pairs, cost, a price per SKU → list
//   Listed    each group: per size the pairs / sold / left / cost and what each SKU holds
//   Sales     every sale: which SKU it sold under, price, payout, cost, net
//   Settings  the Telegram chat the sales post to (admin / Check Access)
// The rules (how many listings a SKU may hold, the money) are src/lib/crossListing.js.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TopBar } from '../components/common.jsx';
import { api } from '../api.js';
import { useLive } from '../hooks.js';
import { useQueryParam } from '../lib/urlstate.js';
import { PH_DATETIME } from '../lib/format.js';
import { bySize, pairsLeft, priceCents, costValue, saleMoney, money, MAX_SKUS, MAX_PAIRS, MAX_NEW_LISTINGS } from '../lib/crossListing.js';

const TABS = [['new', 'New'], ['listed', 'Listed'], ['sales', 'Sales'], ['settings', 'Settings']];
const when = (v) => { const d = new Date(v); return Number.isNaN(d.getTime()) ? '' : `${PH_DATETIME.format(d)} EST`; };
const errText = (e) => e?.message || 'Something went wrong — try again.';

function Thumb({ src, alt = '' }) {
  return src ? <img className="xl-thumb" src={src} alt={alt} /> : <span className="xl-thumb xl-thumb-none" aria-hidden="true">no photo</span>;
}

/* ---------------------------------- New ---------------------------------- */

function NewTab({ seed, onSeedUsed, onListed }) {
  const [q, setQ] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState(null);
  const [error, setError] = useState('');
  const [picked, setPicked] = useState([]);          // [{ catalogId, sku, name, image, sizes:[{label,value}] }]
  const [group, setGroup] = useState(null);          // an existing group being added to
  const [step, setStep] = useState('pick');
  const [name, setName] = useState('');
  const [prices, setPrices] = useState({});          // catalogId → { label → {...} } | 'loading' | 'error'
  const [rows, setRows] = useState({});              // label → { qty, cost, price: { catalogId: '' } }
  const [activate, setActivate] = useState(true);
  const [busy, setBusy] = useState('');
  const [done, setDone] = useState(null);
  const run = useRef(0);

  // "＋ Add pairs" on a listed group lands here with its SKUs already picked.
  useEffect(() => {
    if (!seed) return;
    setGroup({ id: seed.id, name: seed.name });
    setPicked(seed.skus.map((k) => ({ catalogId: k.catalogId, sku: k.sku, name: k.name, image: k.image, sizes: Object.entries(k.sizes || {}).map(([label, value]) => ({ label, value })) })));
    setName(seed.name); setRows({}); setDone(null); setStep('sizes');
    onSeedUsed();
  }, [seed]); // eslint-disable-line react-hooks/exhaustive-deps

  async function search(e) {
    e?.preventDefault();
    if (q.trim().length < 3) { setError('Type at least 3 letters of the shoe’s name or SKU.'); return; }
    setSearching(true); setError('');
    try { setResults((await api.crossSearch(q.trim())).results || []); } catch (x) { setError(errText(x)); } finally { setSearching(false); }
  }
  const isPicked = (c) => picked.some((p) => p.catalogId === c.catalogId);
  function toggle(c) {
    setError('');
    setPicked((cur) => (cur.some((p) => p.catalogId === c.catalogId) ? cur.filter((p) => p.catalogId !== c.catalogId)
      : cur.length >= MAX_SKUS ? cur : [...cur, c]));
  }

  // Step 2: every SKU's market, one SKU at a time (each is one Alias call per size).
  useEffect(() => {
    if (step !== 'sizes') return undefined;
    const mine = ++run.current;
    (async () => {
      for (const p of picked) {
        if (run.current !== mine) return;
        if (prices[p.catalogId] && prices[p.catalogId] !== 'error') continue;
        setPrices((cur) => ({ ...cur, [p.catalogId]: 'loading' }));
        try {
          const r = await api.crossPrices(p.catalogId, p.sizes);
          if (run.current === mine) setPrices((cur) => ({ ...cur, [p.catalogId]: r.prices || {} }));
        } catch { if (run.current === mine) setPrices((cur) => ({ ...cur, [p.catalogId]: 'error' })); }
      }
    })();
    return () => { run.current++; };
  }, [step, picked]); // eslint-disable-line react-hooks/exhaustive-deps

  const sizes = useMemo(() => [...new Set(picked.flatMap((p) => p.sizes.map((s) => s.label)))].sort(bySize), [picked]);
  const has = (p, label) => p.sizes.some((s) => s.label === label);
  const row = (label) => rows[label] || { qty: '', cost: '', price: {} };
  const setRow = (label, patch) => { setDone(null); setRows((cur) => ({ ...cur, [label]: { ...row(label), ...patch } })); };
  const setPrice = (label, catalogId, v) => setRow(label, { price: { ...row(label).price, [catalogId]: v } });
  const market = (p, label) => { const m = prices[p.catalogId]; return m && typeof m === 'object' ? m[label] : null; };

  function fillLowest() {
    setDone(null);
    setRows((cur) => {
      const next = { ...cur };
      for (const label of sizes) {
        const r = next[label] || { qty: '', cost: '', price: {} };
        if (!(Number(r.qty) > 0)) continue;
        const price = { ...r.price };
        for (const p of picked) { const m = market(p, label); if (has(p, label) && !price[p.catalogId] && m?.lowestListing) price[p.catalogId] = String(Math.round(m.lowestListing)); }
        next[label] = { ...r, price };
      }
      return next;
    });
  }
  function costForAll(v) { setDone(null); setRows((cur) => Object.fromEntries(sizes.map((l) => [l, { ...(cur[l] || { qty: '', price: {} }), cost: (cur[l]?.qty ? v : cur[l]?.cost) ?? '' }]))); }

  // What would be sent, and the first thing wrong with it.
  const plan = useMemo(() => {
    const lines = []; let problem = ''; let listings = 0; let pairs = 0;
    for (const label of sizes) {
      const r = rows[label];
      if (!r || r.qty === '' || r.qty == null) continue;
      const qty = Number(r.qty);
      if (!Number.isInteger(qty) || qty < 1 || qty > MAX_PAIRS) { problem ||= `Size ${label}: pairs is a whole number from 1 to ${MAX_PAIRS}.`; continue; }
      if (Number.isNaN(costValue(r.cost))) { problem ||= `Size ${label}: the cost is not an amount.`; continue; }
      const skus = picked.filter((p) => has(p, label) && String(r.price?.[p.catalogId] ?? '').trim() !== '').map((p) => ({ catalogId: p.catalogId, price: r.price[p.catalogId] }));
      if (skus.some((k) => Number.isNaN(priceCents(k.price)))) { problem ||= `Size ${label}: a price has to be from $1 to $100,000.`; continue; }
      if (skus.length < 2) { problem ||= `Size ${label}: give at least 2 SKUs a price.`; continue; }
      pairs += qty; listings += qty * skus.length;
      lines.push({ size: label, qty, cost: r.cost === '' ? null : r.cost, skus });
    }
    if (!problem && !lines.length) problem = 'Type the pairs for at least one size.';
    if (!problem && !group && !name.trim()) problem = 'Give the shoe group a name.';
    return { lines, problem, listings, pairs };
  }, [rows, sizes, picked, name, group]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit() {
    if (plan.problem || busy) return;
    // Whole sizes per request, under the server's cap; the first request makes the group.
    const batches = []; let cur = []; let n = 0;
    for (const l of plan.lines) {
      const add = l.qty * l.skus.length;
      if (cur.length && n + add > MAX_NEW_LISTINGS) { batches.push(cur); cur = []; n = 0; }
      cur.push(l); n += add;
    }
    if (cur.length) batches.push(cur);
    let groupId = group?.id || null; const out = []; let failure = '';
    for (const [i, lines] of batches.entries()) {
      setBusy(`Listing on Alias… ${i + 1} of ${batches.length}`);
      try {
        const r = await api.crossCreate(groupId ? { groupId, activate, lines } : { name: name.trim(), skus: picked, activate, lines });
        groupId = r.groupId; out.push(...(r.lines || []));
      } catch (x) { failure = errText(x); if (x?.data?.groupId) groupId = x.data.groupId; out.push(...(x?.data?.lines || [])); break; }
    }
    setBusy('');
    setDone({ lines: out, failure, groupId });
    if (groupId) { setGroup({ id: groupId, name: name.trim() || group?.name }); onListed(); }
    // Sizes that went through are cleared, so a second press can't add their pairs again.
    const sent = new Set(out.map((l) => l.size));
    setRows((curRows) => Object.fromEntries(Object.entries(curRows).filter(([label]) => !sent.has(label))));
  }

  function startOver() { setPicked([]); setGroup(null); setRows({}); setPrices({}); setName(''); setDone(null); setResults(null); setQ(''); setStep('pick'); }

  if (step === 'pick') {
    return (
      <>
        <div className="card">
          <h3 className="xl-h">1 · Find the shoe on Alias</h3>
          <p className="muted sm">Search by name, then tick every entry that is the <b>same shoe</b> under a different SKU. Check each photo and SKU yourself — Alias verifies the pair against the SKU it sells under.</p>
          <form className="xl-search" onSubmit={search}>
            <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. Nike Dunk Low Light Carbon" aria-label="Shoe name or SKU" />
            <button type="submit" className="btn primary" disabled={searching}>{searching ? 'Searching…' : 'Search Alias'}</button>
          </form>
          {error && <div className="error sm mt">{error}</div>}
          {results && !results.length && <p className="muted sm mt">Alias found nothing for that. Try fewer words.</p>}
          {results && results.length > 0 && (
            <div className="xl-results">
              {results.map((c) => (
                <button type="button" key={c.catalogId} className={`xl-card${isPicked(c) ? ' on' : ''}`} aria-pressed={isPicked(c)} onClick={() => toggle(c)}>
                  <Thumb src={c.image} />
                  <span className="xl-card-body">
                    <b>{c.name || c.sku}</b>
                    <span className="xl-sku">{c.sku}</span>
                    <span className="muted xs">{[c.gender, c.released && `released ${c.released}`, `${c.sizes.length} sizes`].filter(Boolean).join(' · ')}</span>
                  </span>
                  <span className="xl-tick" aria-hidden="true">{isPicked(c) ? '✓' : '+'}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {picked.length > 0 && (
          <div className="card xl-picked">
            <h3 className="xl-h">Picked — {picked.length} SKU{picked.length === 1 ? '' : 's'}</h3>
            <div className="xl-chips">
              {picked.map((p) => (
                <span key={p.catalogId} className="xl-chip"><Thumb src={p.image} /><span><b>{p.sku}</b><br /><span className="muted xs">{p.name}</span></span>
                  <button type="button" className="btn xs" aria-label={`Remove ${p.sku}`} onClick={() => toggle(p)}>✕</button></span>
              ))}
            </div>
            <div className="xl-actions">
              {picked.length < 2 && <span className="muted sm">Pick at least 2 — you can search again, the picks stay.</span>}
              <button type="button" className="btn primary" disabled={picked.length < 2} onClick={() => { if (!name) setName(picked[0].name || picked[0].sku); setStep('sizes'); }}>Next: sizes and prices</button>
            </div>
          </div>
        )}
      </>
    );
  }

  const loading = picked.some((p) => prices[p.catalogId] === 'loading' || prices[p.catalogId] == null);
  return (
    <div className="card">
      <div className="xl-head">
        <h3 className="xl-h">2 · Pairs, cost and a price per SKU</h3>
        {!group && <button type="button" className="btn sm" onClick={() => setStep('pick')}>← Change the SKUs</button>}
        {group && <button type="button" className="btn sm" onClick={startOver}>Start a new group</button>}
      </div>
      {group ? <p className="sm">Adding pairs to <b>{group.name}</b>.</p> : (
        <label className="xl-field"><span className="muted xs">Name of this shoe group</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} aria-label="Group name" /></label>
      )}
      <p className="muted sm">Pairs is how many you really have of that size — every priced SKU gets that many Alias listings. When one sells, one comes down on each of the others. Market = Alias lowest ask (shipped by us){loading ? ' — still loading…' : ''}.</p>
      <div className="xl-tools">
        <button type="button" className="btn sm" onClick={fillLowest} disabled={loading}>Price blanks at the lowest ask</button>
        <label className="xl-inline"><span className="muted xs">Cost for every size with pairs</span>
          <input className="input xl-num" inputMode="decimal" placeholder="$" aria-label="Cost for all sizes" onChange={(e) => costForAll(e.target.value)} /></label>
        <label className="xl-inline"><input type="checkbox" checked={activate} onChange={(e) => setActivate(e.target.checked)} /> Go live now</label>
      </div>
      <div className="ap-tablewrap xl-sizes">
        <table className="table xl-table">
          <thead>
            <tr><th>Size</th><th>Pairs</th><th>Cost / pair</th>
              {picked.map((p) => <th key={p.catalogId}><span className="xl-th"><Thumb src={p.image} /><span>{p.sku}<br /><span className="muted xs">{prices[p.catalogId] === 'error' ? 'prices failed' : prices[p.catalogId] === 'loading' ? 'loading…' : 'price'}</span></span></span></th>)}
            </tr>
          </thead>
          <tbody>
            {sizes.map((label) => {
              const r = row(label);
              return (
                <tr key={label} className={Number(r.qty) > 0 ? 'xl-on' : ''}>
                  <td><b>{label}</b></td>
                  <td><input className="input xl-num" inputMode="numeric" value={r.qty} aria-label={`Pairs, size ${label}`} onChange={(e) => setRow(label, { qty: e.target.value.replace(/[^\d]/g, '') })} /></td>
                  <td><input className="input xl-num" inputMode="decimal" value={r.cost} placeholder="$" aria-label={`Cost, size ${label}`} onChange={(e) => setRow(label, { cost: e.target.value })} /></td>
                  {picked.map((p) => {
                    if (!has(p, label)) return <td key={p.catalogId} className="muted xs">not made</td>;
                    const m = market(p, label);
                    return (
                      <td key={p.catalogId}>
                        <input className="input xl-num" inputMode="numeric" placeholder="$" value={r.price?.[p.catalogId] ?? ''} aria-label={`${p.sku} price, size ${label}`} onChange={(e) => setPrice(label, p.catalogId, e.target.value.replace(/[^\d]/g, ''))} />
                        <div className="xl-mkt">
                          {m?.lowestListing ? <button type="button" className="xl-use" title="Use this price" onClick={() => setPrice(label, p.catalogId, String(Math.round(m.lowestListing)))}>ask {money(m.lowestListing)}</button> : <span className="muted">{m ? 'no ask' : ''}</span>}
                          {m?.lastSold ? <span className="muted"> · sold {money(m.lastSold)}</span> : null}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="xl-actions">
        <span className="sm">{plan.problem ? <span className="muted">{plan.problem}</span> : <><b>{plan.pairs}</b> pair{plan.pairs === 1 ? '' : 's'} → <b>{plan.listings}</b> Alias listings</>}</span>
        <button type="button" className="btn primary" disabled={!!plan.problem || !!busy} onClick={submit}>{busy || `List on Alias${plan.listings ? ` (${plan.listings})` : ''}`}</button>
      </div>
      {done && (
        <div className={`xl-done${done.failure || done.lines.some((l) => l.skus.some((k) => k.errors.length)) ? ' warn' : ''}`} role="status">
          {done.failure && <div className="error sm">{done.failure}</div>}
          {done.lines.map((l) => (
            <div key={l.size} className="sm">Size {l.size}: {l.skus.map((k) => `${k.sku} ${k.created}/${k.wanted} listed${k.errors.length ? ` — ${k.errors[0]}` : ''}`).join(' · ')}</div>
          ))}
          {!done.failure && done.lines.length > 0 && <div className="muted xs">See them under Listed. A SKU that came up short can be listed again from there.</div>}
        </div>
      )}
    </div>
  );
}

/* --------------------------------- Listed -------------------------------- */

function PoolEditor({ group, pool, onDone }) {
  const [qty, setQty] = useState(String(pool.qty));
  const [cost, setCost] = useState(pool.unit_cost == null ? '' : String(pool.unit_cost));
  const [price, setPrice] = useState(() => Object.fromEntries(group.skus.map((k) => [k.id, String(Math.round((pool.listings.find((l) => l.groupSkuId === k.id)?.price_cents || 0) / 100) || '')])));
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  async function act(label, body, okText) {
    setBusy(label); setMsg('');
    try {
      const r = await api.crossAction({ poolId: pool.id, ...body });
      const errs = [...(r.errors || []), ...(r.removed || []).filter((x) => !x.ok).map((x) => `${x.sku}: ${x.error}`)];
      setMsg(errs.length ? `⚠ ${errs[0]}` : okText(r));
      onDone();
    } catch (x) { setMsg(`⚠ ${errText(x)}`); } finally { setBusy(''); }
  }
  const left = pairsLeft(pool);
  return (
    <div className="xl-edit">
      <div className="xl-edit-row">
        <label className="xl-inline"><span className="muted xs">Pairs (sold {pool.sold})</span>
          <input className="input xl-num" inputMode="numeric" value={qty} aria-label={`Pairs, size ${pool.size}`} onChange={(e) => setQty(e.target.value.replace(/[^\d]/g, ''))} /></label>
        <button type="button" className="btn sm" disabled={!!busy || qty === '' || Number(qty) === pool.qty} onClick={() => act('qty', { action: 'qty', qty: Number(qty) }, (r) => `Pairs saved${r.removed?.length ? ` — ${r.removed.length} listing(s) taken down` : ''}.`)}>Save pairs</button>
        <label className="xl-inline"><span className="muted xs">Cost / pair</span>
          <input className="input xl-num" inputMode="decimal" value={cost} placeholder="$" aria-label={`Cost, size ${pool.size}`} onChange={(e) => setCost(e.target.value)} /></label>
        <button type="button" className="btn sm" disabled={!!busy || Number.isNaN(costValue(cost))} onClick={() => act('cost', { action: 'cost', cost }, () => 'Cost saved.')}>Save cost</button>
        <button type="button" className="btn sm danger" disabled={!!busy || !pool.listings.length} onClick={() => act('down', { action: 'down' }, (r) => `${r.removed.filter((x) => x.ok).length} listing(s) taken down.`)}>Take every listing down</button>
      </div>
      {group.skus.map((k) => {
        const mine = pool.listings.filter((l) => l.groupSkuId === k.id);
        const room = Math.max(0, left - mine.length);
        const made = k.sizes?.[pool.size] != null;
        const bad = Number.isNaN(priceCents(price[k.id]));
        return (
          <div key={k.id} className="xl-edit-row">
            <span className="xl-edit-sku"><b>{k.sku}</b> <span className="muted xs">{made ? `${mine.length} listed` : 'not made in this size'}</span></span>
            {made && <input className="input xl-num" inputMode="numeric" placeholder="$" value={price[k.id] ?? ''} aria-label={`${k.sku} price, size ${pool.size}`} onChange={(e) => setPrice((c) => ({ ...c, [k.id]: e.target.value.replace(/[^\d]/g, '') }))} />}
            {made && mine.length > 0 && <button type="button" className="btn sm" disabled={!!busy || bad} onClick={() => act('price', { action: 'price', groupSkuId: k.id, price: price[k.id] }, (r) => `${k.sku}: ${r.changed} price(s) changed.`)}>Change price</button>}
            {made && room > 0 && <button type="button" className="btn sm" disabled={!!busy || bad} onClick={() => act('list', { action: 'list', groupSkuId: k.id, price: price[k.id] }, (r) => `${k.sku}: ${r.created} of ${r.wanted} listed.`)}>List {room} more</button>}
            {mine.length > 0 && <button type="button" className="btn sm danger" disabled={!!busy} onClick={() => act('down', { action: 'down', groupSkuId: k.id }, (r) => `${k.sku}: ${r.removed.filter((x) => x.ok).length} taken down.`)}>Take down</button>}
          </div>
        );
      })}
      {busy && <div className="muted xs">Working…</div>}
      {msg && <div className={`sm${msg.startsWith('⚠') ? ' error' : ''}`} role="status">{msg}</div>}
    </div>
  );
}

function ListedTab({ data, reload, onAdd }) {
  const [open, setOpen] = useQueryParam('size', '');
  const [q, setQ] = useQueryParam('q', '');
  const groups = (data?.groups || []).filter((g) => !q || `${g.name} ${g.skus.map((k) => k.sku).join(' ')}`.toLowerCase().includes(q.toLowerCase()));
  if (!data) return <div className="card muted">Loading…</div>;
  return (
    <>
      <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a group or SKU" aria-label="Search cross-listed shoes" />
      {!groups.length && <div className="card muted mt">{data.groups.length ? 'Nothing matches.' : 'Nothing cross-listed yet. Start on the New tab.'}</div>}
      {groups.map((g) => (
        <div className="card mt" key={g.id}>
          <div className="xl-head">
            <h3 className="xl-h">{g.name}</h3>
            <button type="button" className="btn sm" onClick={() => onAdd(g)}>＋ Add pairs</button>
          </div>
          <div className="xl-chips">{g.skus.map((k) => <span key={k.id} className="xl-chip"><Thumb src={k.image} /><span><b>{k.sku}</b><br /><span className="muted xs">{k.name}</span></span></span>)}</div>
          <div className="ap-tablewrap">
            <table className="table xl-table">
              <thead><tr><th>Size</th><th>Pairs</th><th>Sold</th><th>Left</th><th>Cost</th>{g.skus.map((k) => <th key={k.id}>{k.sku}</th>)}<th></th></tr></thead>
              <tbody>
                {[...g.pools].sort((a, b) => bySize(a.size, b.size)).map((p) => {
                  const left = pairsLeft(p);
                  const key = String(p.id);
                  return (
                    <React.Fragment key={p.id}>
                      <tr>
                        <td><b>{p.size}</b></td><td>{p.qty}</td><td>{p.sold}</td><td><b>{left}</b></td><td>{p.unit_cost == null ? <span className="muted">—</span> : money(p.unit_cost)}</td>
                        {g.skus.map((k) => {
                          const mine = p.listings.filter((l) => l.groupSkuId === k.id);
                          const err = mine.find((l) => l.last_error);
                          const live = mine.filter((l) => l.status === 'live').length;
                          const pr = [...new Set(mine.map((l) => l.price_cents))].sort((a, b) => a - b);
                          return (
                            <td key={k.id} className={mine.length < left ? 'xl-short' : ''}>
                              {mine.length ? <>{live} live{mine.length - live ? ` · ${mine.length - live} off` : ''} <span className="muted">@ {pr.length > 1 ? `${money(pr[0] / 100)}–${money(pr[pr.length - 1] / 100)}` : money(pr[0] / 100)}</span></> : <span className="muted">none</span>}
                              {mine.length < left && <div className="xs">short by {left - mine.length}</div>}
                              {err && <div className="error xs" title={err.last_error}>⚠ problem</div>}
                            </td>
                          );
                        })}
                        <td><button type="button" className="btn sm" aria-expanded={open === key} onClick={() => setOpen(open === key ? '' : key)}>{open === key ? 'Close' : 'Edit'}</button></td>
                      </tr>
                      {open === key && <tr><td colSpan={6 + g.skus.length}><PoolEditor group={g} pool={p} onDone={reload} /></td></tr>}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </>
  );
}

/* ---------------------------------- Sales -------------------------------- */

function SalesTab({ data }) {
  if (!data) return <div className="card muted">Loading…</div>;
  if (!data.sales.length) return <div className="card muted">No sale yet. Each one shows here and posts to the Telegram chat.</div>;
  return (
    <div className="card">
      <div className="ap-tablewrap">
        <table className="table xl-table">
          <thead><tr><th>Sold</th><th>Shoe</th><th>Sold as</th><th>Size</th><th>Price</th><th>Payout</th><th>Cost</th><th>Net</th><th>Order</th><th>Telegram</th></tr></thead>
          <tbody>
            {data.sales.map((s) => {
              const m = saleMoney(s);
              return (
                <tr key={s.id}>
                  <td>{when(s.sold_at)}</td><td>{s.group_name}</td><td><b>{s.sku || '—'}</b></td><td>{s.size}</td>
                  <td>{money(m.price)}</td><td>{money(m.payout)}{m.estimated ? <span className="muted xs"> est.</span> : null}</td>
                  <td>{m.cost == null ? <span className="muted">—</span> : money(m.cost)}</td>
                  <td className={m.net == null ? '' : m.net < 0 ? 'error' : 'xl-good'}>{m.net == null ? <span className="muted">—</span> : `${m.net < 0 ? '−' : ''}${money(Math.abs(m.net))}`}</td>
                  <td className="xs">{s.order_id}</td>
                  <td>{s.notified_at ? '✓' : <span className="error xs" title={s.notify_error || ''}>not sent</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* -------------------------------- Settings ------------------------------- */

function SettingsTab({ onSaved }) {
  const [s, setS] = useState(null);
  const [chat, setChat] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.crossSettings().then((r) => { setS(r); setChat(r.chatId || ''); }).catch((x) => setMsg(`⚠ ${errText(x)}`)); }, []);
  async function go(body, ok) {
    setBusy(true); setMsg('');
    try { const r = await api.crossSettingsSave(body); if (body.test !== true) setS((c) => ({ ...c, chatId: r.chatId })); setMsg(ok); onSaved(); }
    catch (x) { setMsg(`⚠ ${errText(x)}`); } finally { setBusy(false); }
  }
  if (!s) return <div className="card muted">{msg || 'Loading…'}</div>;
  if (!s.canEdit) return <div className="card muted">Only an admin, or someone with Check Access, can set the Telegram chat.</div>;
  return (
    <div className="card">
      <h3 className="xl-h">Telegram chat for cross-listing sales</h3>
      <p className="muted sm">Every sale of a cross-listed pair posts here: which SKU it sold under, the money, and what came down on the other SKUs. This is its own chat, separate from the pre-sell group.</p>
      <ol className="muted sm xl-steps">
        <li>Make the Telegram group and add the Stickballman12 bot to it.</li>
        <li>Paste the group’s chat id below. It is a number that starts with <b>-100</b>, e.g. -1001234567890.</li>
        <li>Save, then press Send a test — the message should appear in the group.</li>
      </ol>
      <div className="xl-search">
        <input className="input" value={chat} onChange={(e) => setChat(e.target.value)} placeholder="-1001234567890" aria-label="Telegram chat id" />
        <button type="button" className="btn primary" disabled={busy || chat.trim() === (s.chatId || '')} onClick={() => go({ chatId: chat.trim() }, chat.trim() ? 'Saved.' : 'Chat removed — sales will not be posted.')}>Save</button>
        <button type="button" className="btn" disabled={busy || !s.chatId} onClick={() => go({ test: true }, 'Test sent — check the group.')}>Send a test</button>
      </div>
      {msg && <div className={`sm mt${msg.startsWith('⚠') ? ' error' : ''}`} role="status">{msg}</div>}
    </div>
  );
}

/* ---------------------------------- page --------------------------------- */

export function AliasCross({ onHome, onSignOut }) {
  const [tab, setTab] = useQueryParam('tab', 'new');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [seed, setSeed] = useState(null);
  const load = useCallback(async () => {
    try { setData(await api.crossList()); setError(''); }
    catch (x) { if (x?.unauthorized) return; setError(errText(x)); }
  }, []);
  useEffect(() => { load(); }, [load]);
  useLive(['cross_pool', 'cross_listings', 'cross_sales', 'app_settings'], load, { mount: false });
  const tabs = TABS.filter(([k]) => k !== 'settings' || data?.canSettings);
  const cur = tabs.some(([k]) => k === tab) ? tab : 'new';
  return (
    <div className="app">
      <TopBar title="Alias Cross-Listing" onHome={onHome} onSignOut={onSignOut} />
      <div className="tabs" role="tablist" aria-label="Alias Cross-Listing">
        {tabs.map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={cur === k} className={`tab${cur === k ? ' active' : ''}`} onClick={() => setTab(k)}>
            {label}{k === 'listed' && data?.groups.length ? ` (${data.groups.length})` : ''}{k === 'sales' && data?.sales.length ? ` (${data.sales.length})` : ''}
          </button>
        ))}
      </div>
      {error && <div className="error sm">{error}</div>}
      {data && !data.chatSet && <div className="notice">No Telegram chat is set for cross-listing sales yet — sales are still recorded and listings still come down, but nobody is told.{data.canSettings ? ' Set it under Settings.' : ' Ask an admin to set it under Settings.'}</div>}
      {/* New stays mounted so a half-filled size table survives a look at another tab. */}
      <div hidden={cur !== 'new'}><NewTab seed={seed} onSeedUsed={() => setSeed(null)} onListed={load} /></div>
      {cur === 'listed' && <ListedTab data={data} reload={load} onAdd={(g) => { setSeed(g); setTab('new'); }} />}
      {cur === 'sales' && <SalesTab data={data} />}
      {cur === 'settings' && <SettingsTab onSaved={load} />}
    </div>
  );
}
