// SHEIN live sync + fix (docs/context/shein-live-fix.md). Three things, all through the API —
// no export files, so no window in which a sale elsewhere goes unseen:
//   · SHEIN sales → Shopify: every pair SHEIN sells comes off Shopify within seconds;
//   · Shopify → SHEIN: a Shopify stock change is pushed to the SHEIN sizes selling that SKU;
//   · Fix every listing: walk SHEIN one product at a time — read Shopify live, apply the
//     hard-coded rules (the AI only suggests relinks), write, read back, next.
import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useLive } from '../hooks.js';
import { downloadCSV } from '../lib/csv.js';
import { PH_DATETIME, estToday } from '../lib/format.js';

const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const when = (t) => (t ? `${PH_DATETIME.format(new Date(t))} EST` : '—');
const MODES = [
  ['dry', 'Dry run', 'Reads everything, decides everything, writes NOTHING. Start here.'],
  ['stock', 'Fix stock', 'Sets every SHEIN size to Shopify’s live stock (wrong links → 0). Instant, no SHEIN review.'],
  ['full', 'Fix stock + seller SKUs', 'Also corrects seller SKUs the rules proved (swaps, same style + size, confirmed matches). SHEIN reviews those edits.'],
];
const VIEWS = [['changed', 'Changed'], ['person', 'Needs a person'], ['skipped', 'Not changed'], ['failed', 'Errors'], ['all', 'Every size']];
const UNIT = { 1: 'pending', 2: 'to ship', 4: 'shipped', 5: 'delivered', 6: 'refunded', 7: 'to pick up', 8: 'lost', 9: 'rejected' };
const tone = (it) => (it.result === 'failed' || it.result === 'mismatch' ? 'bad' : it.reason !== 'ok' ? 'warn' : it.result === 'changed' ? 'info' : 'ok');

export function SheinLivePanel({ isAdmin, onSignOut }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [mode, setMode] = useState('dry');
  const [ai, setAi] = useState(true);
  const [paused4seller, setPaused4seller] = useState(false);
  const [openAtStart, setOpenAtStart] = useState(true);
  const [askOrders, setAskOrders] = useState(false);
  const [view, setView] = useState('changed');
  const [q, setQ] = useState('');
  const [shown, setShown] = useState(80);

  async function load() {
    try { setD(await api.sheinLive()); setErr(''); }
    catch (e) { if (e.unauthorized) onSignOut(); else setErr(e.message); }
  }
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useLive(['shein_live_runs', 'shein_live_items', 'shein_order_units', 'app_settings'], load, { mount: false, every: d?.run?.status === 'running' ? 5_000 : 60_000 });

  async function act(action, extra = {}) {
    setBusy(action); setErr(''); setMsg('');
    try {
      const r = await api.sheinLiveAction({ action, ...extra });
      if (action === 'retry') {
        const n = Number(r?.deducted || 0) + Number(r?.restocked || 0);
        setMsg(r?.failed ? `Retried: ${fmt(n)} done, ${fmt(r.failed)} still failing — the reason is under each red row in “Latest SHEIN sales”.`
          : n ? `Retried: ${fmt(n)} done.` : 'Nothing left to retry.');
      }
      await load();
    }
    catch (e) { if (e.unauthorized) onSignOut(); else setErr(e.message); }
    finally { setBusy(''); }
  }

  const run = d?.run;
  const running = run?.status === 'running';
  const c = run?.counts || {};
  const items = useMemo(() => {
    const all = d?.items || [];
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const keep = (it) => (view === 'all' ? true
      : view === 'changed' ? it.result === 'changed' || it.wrote === 'dry'
        : view === 'person' ? it.reason !== 'ok' && !it.link_to && it.result !== 'changed'
          : view === 'skipped' ? it.result === 'skipped'
            : it.result === 'failed' || it.result === 'mismatch');
    return all.filter(keep).filter((it) => !words.length || words.every((w) => [it.product_name, it.seller_sku, it.shein_size, it.shopify_size, it.spu, it.shein_sku, it.action].join(' ').toLowerCase().includes(w)));
  }, [d, view, q]);

  // Every row of the run, fetched for the file — the live list above is capped at 3,000.
  async function csv() {
    setBusy('csv'); setErr('');
    let rows;
    try { rows = (await api.sheinLiveAllItems(run.id)).items || []; }
    catch (e) { if (e.unauthorized) onSignOut(); else setErr(e.message); return; }
    finally { setBusy(''); }
    const cols = ['spu', 'skc', 'shein_sku', 'product_name', 'shein_size', 'seller_sku', 'shopify_sku', 'shopify_size', 'shopify_qty', 'held', 'before_qty', 'target_qty', 'after_qty', 'reason', 'link_to', 'link_by', 'wrote', 'result', 'action', 'error'];
    const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    downloadCSV(`SHEIN live ${run?.mode || ''} run ${run?.id || ''} ${estToday()}.csv`, [cols.join(','), ...rows.map((it) => cols.map((k) => esc(it[k])).join(','))].join('\n'));
  }

  if (!d) return <div className="card"><p className="muted sm">{err || 'Loading the live sync…'}</p></div>;
  if (!d.connected) return null;   // the page header says why (not approved / not connected)
  const sync = d.sync || {};
  const uc = d.unitCounts || {};
  const pct = run?.total ? Math.round((100 * (run.done || 0)) / run.total) : 0;

  return (
    <>
      <div className="card">
        <h3>Live sync</h3>
        {!d.worker && <p className="notice xs">This server doesn’t run the sync (only production does — dev and prod share the SHEIN and Shopify accounts). Switches here still save.</p>}
        <div className="shc-tiles">
          <div className={`shc-tile ${sync.orders === 'on' ? 'ok' : 'bad'}`}>
            <b>{sync.orders === 'on' ? 'ON' : 'OFF'}</b>
            <span>SHEIN sales → Shopify{sync.orders === 'on' ? ` · since ${when(sync.since)}` : ''}</span>
          </div>
          <div className="shc-tile info"><b>{fmt(uc.last24)}</b><span>pairs taken off Shopify, last 24 h</span></div>
          {Number(uc.failing) > 0 && <div className="shc-tile bad"><b>{fmt(uc.failing)}</b><span>SHEIN sales NOT off Shopify yet — see below</span></div>}
          <div className={`shc-tile ${sync.push === 'on' ? 'ok' : 'warn'}`}><b>{sync.push === 'on' ? 'ON' : 'OFF'}</b><span>Shopify stock → SHEIN</span></div>
        </div>
        <p className="muted xs">{sync.orders === 'on'
          ? <>SHEIN tells us the moment an order comes in; every minute we also check SHEIN for anything missed (last check {when(sync.polledAt)}). Each pair is taken off Shopify once — never twice — and put back only if SHEIN cancels it before it ships.</>
          : <>Off: a SHEIN sale is NOT taken off Shopify, so eBay / StockX / Alias can sell the same pair. Turn it on before the first stock fix.</>}</p>
        {isAdmin && (
          <div className="er-actions">
            {sync.orders === 'on'
              ? <button type="button" className="btn ghost sm" disabled={!!busy} onClick={() => { if (window.confirm('Stop taking SHEIN sales off Shopify?')) act('orders_off'); }}>Turn off SHEIN sales → Shopify</button>
              : <button type="button" className="btn primary sm" disabled={!!busy} onClick={() => setAskOrders(true)}>Turn on SHEIN sales → Shopify…</button>}
            {sync.push === 'on'
              ? <button type="button" className="btn ghost sm" disabled={!!busy} onClick={() => act('push_off')}>Turn off Shopify → SHEIN</button>
              : <button type="button" className="btn sm" disabled={!!busy || sync.orders !== 'on' || !paused4seller} title={sync.orders !== 'on' ? 'Turn on SHEIN sales → Shopify first' : !paused4seller ? 'Tick “4seller is paused” below first' : ''} onClick={() => act('push_on')}>{busy === 'push_on' ? 'Registering with Shopify…' : 'Turn on Shopify → SHEIN'}</button>}
            {Number(uc.failing) > 0 && <button type="button" className="btn sm" disabled={!!busy} onClick={() => act('retry')}>{busy === 'retry' ? 'Retrying…' : 'Retry the failed ones'}</button>}
          </div>
        )}
        {msg && <p className="sm mt">{msg}</p>}
        {askOrders && (
          <div className="notice mt">
            <p className="sm"><b>From now on, every pair SHEIN sells comes off Shopify within seconds.</b></p>
            <label className="sm"><input type="checkbox" checked={openAtStart} onChange={(e) => setOpenAtStart(e.target.checked)} /> Also take off the SHEIN orders that are <b>already sold but not shipped yet</b> (nobody has taken those off Shopify).</label>
            <p className="muted xs">Untick only if someone already took those off Shopify by hand — otherwise those pairs can still sell on another channel.</p>
            <div className="er-actions">
              <button type="button" className="btn primary sm" disabled={!!busy} onClick={async () => { await act('orders_on', { openAtStart }); setAskOrders(false); }}>{busy === 'orders_on' ? 'Reading the last 14 days of SHEIN orders…' : 'Turn on'}</button>
              <button type="button" className="btn ghost sm" onClick={() => setAskOrders(false)}>Cancel</button>
            </div>
          </div>
        )}
        {!!d.units?.length && (
          <details className="mt">
            <summary className="sm">Latest SHEIN sales ({fmt(d.units.length)})</summary>
            <div className="ap-tablewrap">
              <table className="table shc-table">
                <thead><tr><th>Sold</th><th>Order</th><th>Seller SKU</th><th>Shoe</th><th>SHEIN</th><th>Shopify</th></tr></thead>
                <tbody>
                  {d.units.map((u) => (
                    <tr key={u.goods_id} className={u.error && !u.deducted_at && u.due ? 'bad' : ''}>
                      <td className="xs">{when(u.order_time)}</td>
                      <td className="ebl-sku">{u.order_no}</td>
                      <td className="ebl-sku">{u.seller_sku || '—'}</td>
                      <td className="xs">{u.title || '—'}</td>
                      <td className="xs">{UNIT[u.unit_status] || u.unit_status}</td>
                      <td className="xs">{u.deducted_at ? <span className="ebo-chip ok">off Shopify</span> : !u.due ? <span className="ebo-chip">before switch-on</span> : u.error ? <span className="ebo-chip bad">not yet</span> : <span className="ebo-chip">—</span>}
                        {u.restocked_at && <span className="ebo-chip info">put back</span>}
                        {(u.note || u.error) && <div className={u.error ? 'shc-bad' : 'muted'}>{u.error || u.note}</div>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}
      </div>

      <div className="card">
        <h3>Fix every SHEIN listing</h3>
        <p className="muted sm">Goes through SHEIN <b>one product at a time</b>: reads that product’s Shopify stock <b>at that moment</b>, checks every size (seller SKU, size, age group, stock, duplicates), fixes it, reads SHEIN back, then moves to the next. The rules decide; the AI only suggests a link for a seller SKU Shopify no longer has, and only a link the rules verify is used.</p>
        <div className="seg sm">
          {MODES.map(([k, l, help]) => (
            <button key={k} type="button" className={`seg-btn${mode === k ? ' on' : ''}`} aria-pressed={mode === k} disabled={running} title={help} onClick={() => setMode(k)}>{l}</button>
          ))}
        </div>
        <p className="muted xs">{MODES.find((m) => m[0] === mode)[2]}</p>
        <p className="sm"><label><input type="checkbox" checked={ai} disabled={running} onChange={(e) => setAi(e.target.checked)} /> Ask the AI about seller SKUs Shopify no longer has</label></p>
        {mode !== 'dry' && (
          <p className="sm"><label><input type="checkbox" checked={paused4seller} onChange={(e) => setPaused4seller(e.target.checked)} /> <b>4seller’s SHEIN sync is paused</b> (otherwise it writes its numbers right back)</label></p>
        )}
        {mode !== 'dry' && sync.orders !== 'on' && <p className="notice xs">SHEIN sales → Shopify is OFF — the fix will hold back what SHEIN holds for open orders, but new SHEIN sales won’t leave Shopify. Turn it on first.</p>}
        <div className="er-actions">
          {running
            ? <button type="button" className="btn" disabled={!!busy || run.stop_requested} onClick={() => act('stop')}>{run.stop_requested ? 'Stopping after this product…' : 'Stop'}</button>
            : <button type="button" className="btn primary" disabled={!!busy || (mode !== 'dry' && !paused4seller)}
              onClick={() => { if (mode === 'dry' || window.confirm(`${MODES.find((m) => m[0] === mode)[1]} on EVERY SHEIN listing?`)) act('start', { mode, ai }); }}>
              {busy === 'start' ? 'Starting…' : `Start: ${MODES.find((m) => m[0] === mode)[1]}`}</button>}
          {!!d.items?.length && <button type="button" className="btn ghost sm" disabled={busy === 'csv'} onClick={csv}>{busy === 'csv' ? 'Preparing CSV…' : `⬇ This run (CSV${d.itemsTotal ? ` · ${fmt(d.itemsTotal)}` : ''})`}</button>}
        </div>
        {err && <div className="error mt">{err}</div>}

        {run && (
          <>
            <p className="sm mt"><b>{MODES.find((m) => m[0] === run.mode)?.[1] || run.mode}</b> · {run.status}{run.phase ? ` — ${run.phase}` : ''} · started {when(run.started_at)}{run.started_by ? ` by ${run.started_by}` : ''}{run.finished_at ? ` · ended ${when(run.finished_at)}` : ''}</p>
            {running && <div className="progress-bar" aria-label="progress"><span style={{ width: `${pct}%` }} /></div>}
            {running && <p className="muted xs">{fmt(run.done)} of {fmt(run.total)} products{run.current ? ` · now ${run.current}` : ''}</p>}
            {run.error && <div className="error">{run.error}</div>}
            <div className="shc-tiles mt">
              <div className="shc-tile ok"><b>{fmt(c.sizes)}</b><span>sizes checked ({fmt(c.products)} products)</span></div>
              <div className="shc-tile info"><b>{fmt(c.stock_changed)}</b><span>{run.mode === 'dry' ? 'stock would change' : 'stock fixed'}</span></div>
              <div className="shc-tile warn"><b>{fmt(c.zeroed)}</b><span>set to 0 (wrong / dead link)</span></div>
              <div className="shc-tile info"><b>{fmt(c.links_changed)}</b><span>{run.mode === 'full' ? 'seller SKUs corrected' : 'seller SKUs to correct'}</span></div>
              <div className="shc-tile warn"><b>{fmt(c.needs_person)}</b><span>need a person</span></div>
              {(Number(c.errors) + Number(c.mismatch) + Number(c.products_failed)) > 0 && <div className="shc-tile bad"><b>{fmt(Number(c.errors) + Number(c.mismatch) + Number(c.products_failed))}</b><span>errors</span></div>}
            </div>
          </>
        )}
      </div>

      {!!d.items?.length && (
        <div className="card">
          <div className="ebl-filters">
            <input type="search" className="input" value={q} onChange={(e) => { setQ(e.target.value); setShown(80); }} placeholder="Search shoe, seller SKU, size…" aria-label="Search the run" />
            <div className="seg sm">
              {VIEWS.map(([k, l]) => <button key={k} type="button" className={`seg-btn${view === k ? ' on' : ''}`} aria-pressed={view === k} onClick={() => { setView(k); setShown(80); }}>{l}</button>)}
            </div>
          </div>
          <p className="muted xs">{fmt(items.length)} size{items.length === 1 ? '' : 's'}.{d.itemsTotal > d.items.length ? ` Showing the first ${fmt(d.items.length)} of ${fmt(d.itemsTotal)} sizes in this run — the CSV has every one.` : ''}</p>
          <div className="ap-tablewrap">
            <table className="table shc-table">
              <thead><tr><th>Shoe</th><th>SHEIN size</th><th>Seller SKU</th><th>Shopify size</th><th className="num">Shopify</th><th className="num">Held</th><th className="num">SHEIN</th><th>What happened</th></tr></thead>
              <tbody>
                {items.slice(0, shown).map((it) => (
                  <tr key={it.id} className={tone(it) === 'bad' ? 'bad' : tone(it) === 'warn' ? 'warn' : ''}>
                    <td className="xs">{it.product_name || it.spu}<div className="muted">{it.spu}</div></td>
                    <td>{it.shein_size || '—'}</td>
                    <td className="ebl-sku">{it.seller_sku || '—'}{it.link_to && <div className="xs">→ {it.link_to} <span className="muted">({it.link_by})</span></div>}</td>
                    <td>{it.shopify_size || '—'}</td>
                    <td className="num">{it.shopify_qty == null ? '—' : fmt(it.shopify_qty)}</td>
                    <td className="num">{fmt(it.held)}</td>
                    <td className="num">{fmt(it.before_qty)} → <b>{fmt(it.target_qty)}</b>{it.after_qty != null && it.after_qty !== it.target_qty && <div className="shc-bad xs">shows {fmt(it.after_qty)}</div>}</td>
                    <td className="xs"><span className={`ebo-chip ${tone(it)}`}>{it.result === 'ok' && it.reason !== 'ok' ? 'needs a person' : it.result}</span> {it.action}{it.error && <div className="shc-bad">{it.error}</div>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {items.length > shown && <button type="button" className="btn ghost sm mt" onClick={() => setShown((n) => n + 240)}>Show more ({fmt(items.length - shown)} left)</button>}
        </div>
      )}
    </>
  );
}
