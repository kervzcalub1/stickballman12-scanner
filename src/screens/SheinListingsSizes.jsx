// SHEIN Listings → Sizes tab: every size our Shopify shoes use, per SHEIN category, and what we
// would send SHEIN for it — SHEIN's own size (standard), a person's pick, a confirmed custom
// spelling, or nothing yet. "Add as a custom size" saves to shein_size_map (OUR database only;
// a later phase sends it). Above it, the Phase 0 probe: "Ask SHEIN (read-only)".
import React, { useMemo, useState } from 'react';
import { api } from '../api.js';
import { useLive } from '../hooks.js';
import { fmt, when, NEEDS_PRIV, CustomSizeModal } from '../components/SheinListingsBits.jsx';

const GROUPS = [['M', 'Men’s / adult'], ['W', 'Women’s (W)'], ['Y', 'GS / youth (Y)'], ['C', 'Kids & toddler (C)'], ['?', 'Not a US size we can read']];
const groupOf = (u) => (u.size_key ? u.size_key.split('|')[1] : '?');
const FILTERS = [['needs', 'Needs mapping'], ['custom', 'Custom'], ['all', 'All']];
const num = (k) => Number(String(k || '').split('|')[0]) || 0;
const bySize = (a, b) => (Number(a.category_id) ? 0 : 1) - (Number(b.category_id) ? 0 : 1) || Number(a.category_id) - Number(b.category_id) || num(a.size_key) - num(b.size_key);
const needs = (u) => u.needs_map > 0 || u.not_allowed > 0 || u.unreadable > 0;

function YesNo({ v }) {
  return v === 1 || v === true ? <span className="ebo-chip ok">Yes</span> : v === 0 || v === false ? <span className="ebo-chip bad">No</span> : <span className="ebo-chip">Not known</span>;
}

// Phase 0: one read-only server job that asks SHEIN, per category we use, which US sizes it
// has, whether it takes custom sizes, whether our products carry a size chart — and the exact
// spelling of any custom size already in the store. The answer is kept (shein_listing_cache).
export function ProbePanel({ canWrite, connected, active, onAct, busy, onSignOut }) {
  const [pr, setPr] = useState(null);
  const [err, setErr] = useState('');
  const [spu, setSpu] = useState('');
  async function load() {
    try { setPr(await api.sheinListingProbe()); setErr(''); }
    catch (e) { if (e.unauthorized) onSignOut(); else setErr(e.message); }
  }
  useLive(['shein_listing_jobs'], load);
  const p = pr?.probe;
  const running = active?.kind === 'probe';
  const title = !canWrite ? NEEDS_PRIV : !connected ? 'Connect SHEIN first' : active ? 'A job is already running' : 'Reads only — nothing on SHEIN changes';
  const spuOk = !spu || /^[A-Za-z0-9_-]+$/.test(spu);
  return (
    <div className="card shl-probe">
      <h3 className="er-step-title">What SHEIN allows (Ask SHEIN)</h3>
      <p className="muted sm">For each SHEIN category our shoes are in: SHEIN’s own US sizes, whether it takes <b>custom sizes</b> (like 14.5W), whether the product has a size chart, and any custom size already in the store — the spelling every new one must copy.</p>
      <div className="shl-probe-ask">
        <input className="input" value={spu} onChange={(e) => setSpu(e.target.value.trim())} placeholder="Also read one SHEIN product (SPU), optional" aria-label="SHEIN SPU to read" disabled={!canWrite} />
        <button type="button" className="btn primary sm" disabled={!canWrite || !connected || !!active || !!busy || !spuOk} title={title}
          onClick={() => onAct('probe', spu ? { spu } : {}, 'Asking SHEIN on the server — reads only.')}>{busy === 'probe' || running ? 'Asking SHEIN…' : 'Ask SHEIN (read-only)'}</button>
      </div>
      {!spuOk && <p className="error sm">That isn’t a SHEIN SPU code.</p>}
      {err && <p className="error sm">{err}</p>}
      {!pr && !err && <div className="shl-skel shl-skel-row" />}
      {pr && !p && <p className="muted xs mt">Not asked yet.{canWrite ? '' : ' An admin (or someone with Connect integrations) asks once; the answer stays here.'}</p>}
      {p && (
        <>
          <p className="muted xs mt">Asked at {when(p.askedAt)}{p.by ? ` by ${p.by}` : ''} · {fmt(p.store?.spus)} SHEIN products in {fmt(p.store?.categories)} categories · {fmt(p.calls)} SHEIN reads, {fmt(p.writes)} writes.</p>
          <table className="shl-rtable">
            <thead><tr><th>SHEIN category</th><th className="num">Our products</th><th>Size field</th><th>Custom sizes allowed</th><th>Size chart</th><th>SHEIN’s sizes</th><th>Custom sizes in the store</th></tr></thead>
            <tbody>
              {p.categories.map((c) => (
                <tr key={c.categoryId}>
                  <td data-label="Category"><b>{c.categoryId}</b>{c.sampleName && <span className="muted xs shl-block">e.g. {c.sampleName}</span>}</td>
                  <td data-label="Our products" className="num">{fmt(c.spuCount)}</td>
                  <td data-label="Size field">{c.sizeAttributeId ? <>{c.sizeAttributeName || 'Size'} <span className="muted xs">#{c.sizeAttributeId}</span></> : <span className="muted">—</span>}{c.sizeFieldStatus === 1 && <span className="shl-bad-text xs shl-block">retired by SHEIN</span>}</td>
                  <td data-label="Custom allowed"><YesNo v={c.hasPermission} /></td>
                  <td data-label="Size chart"><YesNo v={c.hasSizeTable} /></td>
                  <td data-label="SHEIN’s sizes" className="xs">{c.sheinSizes?.length ? c.sheinSizes.map((x) => x.label).join(', ') : <span className="muted">none read</span>}</td>
                  <td data-label="Custom in store" className="xs">{c.customValues?.length ? c.customValues.map((x) => <code key={x} className="shl-code">{x}</code>) : <span className="muted">none</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {p.customValues?.length > 0 && <p className="sm mt">Custom sizes already in the store (exact spelling): {p.customValues.map((x) => <code key={x} className="shl-code">{x}</code>)}</p>}
          {p.spuChecked && (
            <p className="sm mt">Product <b>{p.spuChecked.spu}</b>{p.spuChecked.name ? ` (${p.spuChecked.name})` : ''}: {p.spuChecked.sizes.map((z) => <code key={`${z.size}-${z.valueId}`} className="shl-code">{z.size}{z.custom ? ' · custom' : ''}</code>)}</p>
          )}
          {p.errors?.length > 0 && <div className="notice mt">{p.errors.map((e, i) => <div key={i}>{e.spu || e.call}: {e.error}</div>)}</div>}
        </>
      )}
    </div>
  );
}

function SizeRow({ u, onAdd, onClear, goBlocker, busy }) {
  const m = u.map;
  let state;
  if (m?.custom_value) {
    state = <><span className={m.verified ? 'ebo-chip ok' : 'ebo-chip violet'}>{m.verified ? 'Custom · on SHEIN' : 'Custom · not on SHEIN yet'}</span> <code className="shl-code">{m.custom_value}</code> <span className="muted xs">confirmed by {m.set_by || '—'} {when(m.set_at)}</span></>;
  } else if (m?.attribute_value_id) {
    state = <><span className="ebo-chip ok">Mapped</span> → <b>{m.shein_label}</b> <span className="muted xs">by {m.set_by || '—'} {when(m.set_at)}</span></>;
  } else if (u.unreadable > 0) {
    state = <><span className="ebo-chip bad">Blocked</span> <span className="xs">Not a US size we can read — fix it on Shopify.</span></>;
  } else if (u.needs_map > 0) {
    state = <><span className="ebo-chip bad">Blocked</span> <span className="xs"><b>{u.size} isn’t a SHEIN size yet.</b> Custom sizes are allowed here.</span></>;
  } else if (u.not_allowed > 0) {
    state = <><span className="ebo-chip bad">Blocked</span> <span className="xs"><b>SHEIN has no {u.size} and won’t take a custom size here.</b> Leave it off SHEIN — never a different size.</span></>;
  } else if (!Number(u.category_id)) {
    state = <span className="muted xs">No SHEIN category yet (new product — a later phase).</span>;
  } else if (u.plan?.kind === 'value' || u.shein_size) {
    state = <><span className="ebo-chip ok">SHEIN size</span> → <b>{u.plan?.label || u.shein_size}</b></>;
  } else state = <span className="muted xs">—</span>;
  return (
    <tr data-size={`${u.category_id}|${u.size_key}`}>
      <td data-label="Our size"><b>{u.size || u.sample || '—'}</b></td>
      <td data-label="Category">{Number(u.category_id) ? u.category_id : <span className="muted">none</span>}</td>
      <td data-label="Shopify sizes" className="num">{fmt(u.sizes)} <span className="muted xs">· {fmt(u.on_shein)} on SHEIN</span></td>
      <td data-label="SHEIN size">{state}</td>
      <td data-label="" className="shl-rt-act">
        {u.needs_map > 0 && !m && <button type="button" className="btn xs shl-fix" disabled={!!busy} onClick={() => onAdd(u)}>Add {u.size} as a custom size</button>}
        {u.not_allowed > 0 && !m && <button type="button" className="btn xs ghost" onClick={() => goBlocker('size_not_on_shein')}>Show the products</button>}
        {m && <button type="button" className="btn xs ghost" disabled={!!busy} onClick={() => onClear(m)}>Clear</button>}
      </td>
    </tr>
  );
}

export function SheinListingsSizes({ sz, setSz, canWrite, connected, active, onAct, busy, goBlocker, onSignOut }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [adding, setAdding] = useState(null);
  const [working, setWorking] = useState(false);
  const [msg, setMsg] = useState('');
  const filter = FILTERS.some(([k]) => k === sz) ? sz : 'needs';
  async function load() {
    try { setD(await api.sheinSizeMaps()); setErr(''); }
    catch (e) { if (e.unauthorized) onSignOut(); else setErr(e.message); }
  }
  useLive(['shein_size_map', 'shein_listing_variants'], load);
  const usage = d?.usage || [];
  const counts = useMemo(() => ({ needs: usage.filter(needs).length, custom: usage.filter((u) => u.map?.custom_value).length, all: usage.length }), [usage]);
  const rows = usage.filter((u) => (filter === 'all' ? true : filter === 'custom' ? !!u.map?.custom_value : needs(u) && !u.map));
  async function clear(m) {
    if (!window.confirm(`Clear the mapping for ${m.custom_value || m.shein_label}? The sizes go back to “needs mapping”. Nothing on SHEIN changes.`)) return;
    setWorking(true); setMsg('');
    try { await api.sheinSizeMapClear(m.id); setMsg('Cleared.'); await load(); }
    catch (e) { if (e.unauthorized) onSignOut(); else setErr(e.message); }
    finally { setWorking(false); }
  }

  return (
    <>
      <ProbePanel canWrite={canWrite} connected={connected} active={active} onAct={onAct} busy={busy} onSignOut={onSignOut} />
      <div className="card">
        <h3 className="er-step-title">Our sizes → SHEIN’s sizes</h3>
        <p className="muted sm">Every size our Shopify shoes use, per SHEIN category. SHEIN’s own size is taken only when it’s <b>exactly</b> the same size — never the nearest one. A size SHEIN doesn’t have needs a person to confirm its custom spelling once; it is saved here only and goes to SHEIN with the add-sizes step (next phase).</p>
        <div className="seg sm shl-sz-filter" role="group" aria-label="Which sizes">
          {FILTERS.map(([k, l]) => <button key={k} type="button" className={`seg-btn${filter === k ? ' on' : ''}`} aria-pressed={filter === k} onClick={() => setSz(k === 'needs' ? '' : k)}>{l} <span className="seg-n">{fmt(counts[k])}</span></button>)}
        </div>
        {err && <p className="error sm mt">{err}</p>}
        {msg && <p className="ebl-ok sm mt">{msg}</p>}
        {!d && !err && <><div className="shl-skel shl-skel-row" /><div className="shl-skel shl-skel-row" /></>}
        {d && !rows.length && (
          <div className="empty-state">{filter === 'needs' ? 'No size needs mapping — every size is a SHEIN size, mapped, or not checked yet.' : filter === 'custom' ? 'No custom size confirmed yet.' : 'No sizes read yet — re-read Shopify + SHEIN.'}</div>
        )}
        {d && GROUPS.map(([g, label]) => {
          const list = rows.filter((u) => groupOf(u) === g).sort(bySize);
          if (!list.length) return null;
          return (
            <div key={g} className="shl-sz-group">
              <h4 className="shl-h4">{label} <span className="muted xs">{fmt(list.length)}</span></h4>
              <table className="shl-rtable shl-sztable">
                <thead><tr><th>Our size</th><th>SHEIN category</th><th className="num">Shopify sizes</th><th>SHEIN size</th><th /></tr></thead>
                <tbody>{list.map((u) => <SizeRow key={`${u.category_id}|${u.size_key}`} u={u} busy={working || !!busy} onAdd={setAdding} onClear={clear} goBlocker={goBlocker} />)}</tbody>
              </table>
            </div>
          );
        })}
      </div>
      {adding && (
        <CustomSizeModal size={adding.size} categoryId={adding.category_id} suggestion={adding.suggestion || ''} onSignOut={onSignOut}
          onClose={() => setAdding(null)} onSaved={async (r) => { setAdding(null); setMsg(`Saved ${r?.map?.custom_value || r?.map?.shein_label || ''} for ${adding.size} — our records only.`); await load(); }} />
      )}
    </>
  );
}

export default SheinListingsSizes;
