// Costs → "From emails". Reads what each pair was PAID out of the stores' own emails: the
// parcel's tracking number finds the shipping email, that names the order, and the order's
// confirmation has the price after the store's discount (before any gift card). The run
// happens on the server and waits here as a preview; nothing is written until Apply, and
// Apply only fills pairs that still have no cost (docs/context/costs.md → "Fill from emails").
import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { downloadCSV } from '../lib/csv.js';
import { PH_DATETIME, estToday } from '../lib/format.js';
import { useQueryParam } from '../lib/urlstate.js';

const money = (n) => (n == null ? '—' : `$${Number(n).toFixed(2)}`);
const when = (ts) => (ts ? `${PH_DATETIME.format(new Date(ts))} EST` : '');
const isYmd = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
const nf = (n) => Number(n || 0).toLocaleString('en-US');

export function CostsFromEmails({ onSignOut, onApplied }) {
  // The run's own filters, on this tab and in the URL (?esup= ?ef= ?et=). They are NOT the
  // "No cost on file" tab's: what is set here is exactly what Read the emails will read.
  const [sup, setSup] = useQueryParam('esup');
  const [fromRaw, setFrom] = useQueryParam('ef');
  const [toRaw, setTo] = useQueryParam('et');
  const from = isYmd(fromRaw) ? fromRaw : '';
  const to = isYmd(toRaw) && (!from || toRaw >= from) ? toRaw : '';
  const [scope, setScope] = useState(null);     // { pairs, parcels, noTracking, suppliers } for the filters

  const [state, setState] = useState(null);     // { configured, run, needsSetup }
  const [rows, setRows] = useState(null);       // the preview, loaded once the run is done
  const [show, setShow] = useState('priced');   // priced | not
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);   // Apply asks once before it saves
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [sku, setSku] = useState('');
  const [order, setOrder] = useState('');
  const run = state?.run || null;
  const running = run?.status === 'running' && !run.stalled;

  async function load() {
    try { setState(await api.costEmails()); }
    catch (e) { if (e.unauthorized) return onSignOut?.(); setError(e.message); }
  }
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // What the filters match, counted on the server; again after a run is applied.
  const skuKey = sku.trim().length >= 5 ? sku.trim() : '';
  useEffect(() => {
    let off = false;
    setScope(null);
    const t = setTimeout(() => {
      api.costEmailsScope({ supplier: sup, from, to, sku: skuKey }).then((r) => { if (!off) setScope(r.scope); })
        .catch((e) => { if (e.unauthorized) return onSignOut?.(); if (!off) setScope({ failed: true, suppliers: [] }); });
    }, 250);
    return () => { off = true; clearTimeout(t); };
  }, [sup, from, to, skuKey, state?.run?.applied_at]); // eslint-disable-line react-hooks/exhaustive-deps
  // Progress: look again every 3 s while the server is reading the mailbox.
  useEffect(() => {
    if (!running) return undefined;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [running]); // eslint-disable-line react-hooks/exhaustive-deps
  // The preview rows are big; fetch them once, when there is a finished run to show.
  useEffect(() => {
    setRows(null);
    if (!run || !['done', 'applied'].includes(run.status)) return;
    let off = false;
    api.costEmails(run.id, true).then((r) => { if (!off) setRows(r.run?.rows || []); })
      .catch((e) => { if (e.unauthorized) return onSignOut?.(); if (!off) setError(e.message); });
    return () => { off = true; };
  }, [run?.id, run?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  async function act(body, after) {
    setBusy(true); setError(''); setNotice('');
    try { const r = await api.costEmailsAct(body); await load(); after?.(r); }
    catch (e) { if (e.unauthorized) return onSignOut?.(); setError(e.message); await load(); }
    finally { setBusy(false); }
  }

  const s = run?.summary || null;
  const priced = useMemo(() => (rows || []).filter((r) => r.each != null), [rows]);
  const not = useMemo(() => (rows || []).filter((r) => r.each == null), [rows]);
  // Prices to look at before saving: the email showed no order total (`check`), or the price is
  // well above what the same shoe cost on the other pairs of this run (2026-11-26: a line of
  // three pairs was read as one pair's price and nothing on the page said so).
  const flags = useMemo(() => {
    const bySku = new Map();
    for (const r of priced) { if (!bySku.has(r.sku)) bySku.set(r.sku, []); bySku.get(r.sku).push(Number(r.each)); }
    const out = new Map();
    for (const r of priced) {
      const v = [...bySku.get(r.sku)].sort((x, y) => x - y);
      const mid = v[Math.floor((v.length - 1) / 2)];
      if (v.length >= 3 && Number(r.each) > mid * 1.5) out.set(r.id, `well above the other pairs of this shoe (${money(mid)})`);
      else if (r.check) out.set(r.id, 'the email shows no order total — a discount could not be checked');
    }
    return out;
  }, [priced]);
  const list = show === 'priced' ? [...priced].sort((x, y) => Number(flags.has(y.id)) - Number(flags.has(x.id))) : not;
  const scopeLine = `${sup || 'Every supplier'}${from || to ? ` · received ${from || 'the start'} to ${to || 'today'}` : ' · any date'}${skuKey ? ` · SKU ${skuKey.toUpperCase()}` : ''}`;
  const mins = scope?.parcels ? Math.max(1, Math.round((Math.min(scope.parcels, 1500) * 9) / 60)) : 0;
  const supplierOptions = scope?.suppliers || [];
  const runScope = run ? `${run.supplier || 'Every supplier'}${run.date_from || run.date_to ? ` · ${run.date_from || '…'} to ${run.date_to || '…'}` : ' · any date'}${run.sku ? ` · SKU ${run.sku}` : ''}${run.order_number ? ` · order ${run.order_number}` : ''}` : '';

  function exportCsv() {
    const head = ['VIN', 'SKU', 'Size', 'Shoe', 'Batch', 'Supplier', 'Tracking', 'Store (email)', 'Order #', 'Name in the email', 'Listed', 'Paid', 'How', 'Note', 'Check', 'Not priced because'];
    const body = (rows || []).map((r) => [r.vin, r.sku, r.size, r.name, r.batch, r.supplier, r.trk, r.store, r.order, r.email_name, r.full, r.each, r.how, r.note, flags.get(r.id) || '', r.reason]);
    const esc = (v) => { const t = String(v ?? ''); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
    downloadCSV(`costs-from-emails-run-${run.id}.csv`, [head, ...body].map((r) => r.map(esc).join(',')).join('\n'));
  }

  if (!state) return <p className="muted">{error || 'Loading…'}</p>;
  return (
    <div className="cfe">
      <p className="muted sm">
        Reads the price <b>paid</b> for each pair from the store’s own emails: the parcel’s tracking number
        finds the shipping email, that names the order, and the order’s confirmation has the price after the
        store’s discount (gift cards are not taken off). Parcels on a purchase order are left out.
        Nothing is saved until you press Apply, and only pairs with no cost are filled.
      </p>
      {state.needsSetup && <div className="error sm">This server has not been set up for it yet (db:setup).</div>}
      {!state.configured && <div className="error sm">The mailbox search is not set up on this server, so a run cannot start here.</div>}

      <h3 className="rows-title cfe-h">What to read</h3>
      <div className="cost-filters cfe-filters">
        <label className="cost-filter">
          <span>Supplier</span>
          <select value={sup} onChange={(e) => setSup(e.target.value)} aria-label="Supplier to read">
            <option value="">Every supplier</option>
            {sup && !supplierOptions.some((o) => o.value.toLowerCase() === sup.toLowerCase()) && <option value={sup}>{sup} (0)</option>}
            {supplierOptions.map((o) => <option key={o.value} value={o.value}>{o.value} ({nf(o.pairs)})</option>)}
          </select>
        </label>
        <label className="cost-filter">
          <span>Received from</span>
          <input type="date" value={from} max={estToday()} aria-label="Received from" onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="cost-filter">
          <span>to</span>
          <input type="date" value={to} min={from || undefined} max={estToday()} aria-label="Received to" onChange={(e) => setTo(e.target.value)} />
        </label>
        {(sup || from || to) && <button type="button" className="btn ghost sm" onClick={() => { setSup(''); setFrom(''); setTo(''); }}>Clear</button>}
      </div>
      <p className="muted xs">Dates are the day the pair was received (EST). Empty dates = any date. The counts beside each supplier are pairs with no cost in these dates.</p>
      <div className="cfe-narrow">
        <label><span className="muted xs">Only this SKU (optional)</span>
          <input value={sku} onChange={(e) => setSku(e.target.value)} placeholder="IG6226" aria-label="Only this SKU" autoCapitalize="characters" /></label>
        <label><span className="muted xs">Order number, if you know it (optional)</span>
          <input value={order} onChange={(e) => setOrder(e.target.value)} placeholder="SP2520297" aria-label="Order number" autoCapitalize="characters" /></label>
        <p className="muted sm">A pair is priced the most exact way available: its <b>tracking number</b> first, then the <b>order number</b> you give,
          then its <b>SKU</b> (only stores whose emails print the code — adidas today). A SKU bought at two prices is shown with both and left blank.</p>
      </div>
      <div className="cfe-start">
        <div role="status"><span className="muted xs">This run will read</span><br /><b>{scopeLine}</b>
          <div className="sm">
            {scope == null ? <span className="muted">Counting…</span>
              : scope.failed ? <span className="muted">Could not count the pairs.</span>
              : scope.pairs === 0 ? <span>No pairs without a cost match these filters.</span>
              : <><b>{nf(scope.pairs)}</b> pair{scope.pairs === 1 ? '' : 's'} with no cost · <b>{nf(scope.parcels)}</b> parcel{scope.parcels === 1 ? '' : 's'} to look up{mins ? ` · about ${mins} min` : ''}
                {scope.noTracking > 0 && <span className="muted"> · {nf(scope.noTracking)} with no tracking number (SKU or order number only)</span>}
                {scope.parcels > 1500 && <span className="muted"> · 1,500 parcels a run, so run it again for the rest</span>}</>}
          </div></div>
        <button type="button" className="btn primary" disabled={busy || running || !state.configured || scope?.pairs === 0}
          onClick={() => act({ action: 'start', supplier: sup, from, to, sku: sku.trim(), order: order.trim() })}>
          {running ? 'Reading the emails…' : 'Read the emails'}
        </button>
      </div>
      {error && <div className="error sm mt" role="alert">{error}</div>}
      {notice && <div className="notice mt" role="status">{notice}</div>}

      {run && (
        <div className="cfe-run">
          <h3 className="rows-title">Run #{run.id} <span className="muted">· {runScope} · started {when(run.created_at)}{run.created_by ? ` by ${run.created_by}` : ''}</span></h3>
          {run.status === 'running' && (
            <>
              <div className="progress-bar"><span style={{ width: `${run.parcels_total ? Math.round((run.parcels_done / run.parcels_total) * 100) : 0}%` }} /></div>
              <p className="sm" role="status">
                {run.stalled ? 'Stopped part-way (the server restarted). ' : 'Reading the mailbox: '}
                <b>{run.parcels_done}</b> of <b>{run.parcels_total || '…'}</b> searches (parcels, then SKUs). About 5 seconds a parcel — you can leave this page.
              </p>
              <div className="cfe-btns">
                {run.stalled && <button type="button" className="btn primary sm" disabled={busy} onClick={() => act({ action: 'continue', id: run.id })}>Continue</button>}
                <button type="button" className="btn ghost sm" disabled={busy} onClick={() => act({ action: 'stop', id: run.id })}>Stop</button>
              </div>
            </>
          )}
          {run.status === 'failed' && <div className="error sm">The run failed: {run.error || 'unknown error'}. Start it again — what it already read is remembered.</div>}
          {run.status === 'stopped' && <p className="muted sm">Stopped at {run.parcels_done} of {run.parcels_total} parcels. Nothing was saved. Start it again to carry on — what it already read is remembered.</p>}

          {s && ['done', 'applied'].includes(run.status) && (
            <>
              <div className="cfe-stats">
                <div><b>{s.priced.toLocaleString('en-US')}</b><span className="muted sm"> of {s.pairs.toLocaleString('en-US')} pairs priced</span></div>
                <div><b>{s.parcels.toLocaleString('en-US')}</b><span className="muted sm"> parcels read</span></div>
                {run.status === 'applied' && <div><b>{run.applied_pairs}</b><span className="muted sm"> costs saved {when(run.applied_at)}{run.applied_by ? ` by ${run.applied_by}` : ''}</span></div>}
              </div>
              {s.capped && <p className="batch-po-hint sm">This run reached its limit (1,500 parcels, 200 SKUs). Apply these, then run it again for the rest.</p>}
              <table className="cfe-table cfe-stores">
                <thead><tr><th>Store (from the email)</th><th>Pairs</th><th>Priced</th></tr></thead>
                <tbody>{Object.entries(s.stores || {}).sort((a, b) => b[1].pairs - a[1].pairs).map(([k, v]) => (
                  <tr key={k}><td>{k}</td><td>{v.pairs}</td><td>{v.priced}</td></tr>))}</tbody>
              </table>
              {Object.keys(s.reasons || {}).length > 0 && (
                <ul className="cfe-reasons sm">
                  {Object.entries(s.reasons).sort((a, b) => b[1] - a[1]).map(([k, n]) => <li key={k}><b>{n}</b> not priced — {k}</li>)}
                </ul>
              )}
              <div className="cfe-btns">
                {run.status === 'done' && s.priced > 0 && !run.stale && !confirming && (
                  <button type="button" className="btn primary" disabled={busy || rows == null} onClick={() => setConfirming(true)}>
                    {`Apply — save the cost on ${s.priced.toLocaleString('en-US')} pairs`}
                  </button>
                )}
                {rows && <button type="button" className="btn ghost sm" onClick={exportCsv}>Download the whole preview (CSV)</button>}
              </div>

              {run.stale && (
                <div className="error sm" role="alert">
                  <b>Do not use these prices.</b> This run was read before a fix to the Foot Locker / Champs / JD Sports prices
                  (a line of several pairs was read as one pair’s price, and store discounts were missed). Press <b>Read the emails</b> again for the same supplier — it cannot be applied.
                </div>
              )}
              {confirming && run.status === 'done' && !run.stale && (
                <div className="cfe-confirm" role="alertdialog" aria-label="Save these costs">
                  <p className="sm">
                    Save the cost on <b>{s.priced.toLocaleString('en-US')}</b> pairs? Only pairs that still have no cost are filled.
                    {flags.size > 0 && <> <b>{flags.size}</b> of these prices are marked <span className="cfe-flag">check</span> — they are listed first below.</>}
                  </p>
                  <div className="cfe-btns">
                    <button type="button" className="btn primary sm" disabled={busy}
                      onClick={() => act({ action: 'apply', id: run.id }, (r) => { setConfirming(false); setNotice(`Cost saved on ${r.filled} pair${r.filled === 1 ? '' : 's'}.`); onApplied?.(); })}>
                      {busy ? 'Saving…' : `Yes, save ${s.priced.toLocaleString('en-US')} costs`}
                    </button>
                    <button type="button" className="btn ghost sm" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
                  </div>
                </div>
              )}
              {run.status === 'done' && !run.stale && !confirming && flags.size > 0 && (
                <p className="batch-po-hint sm"><b>{flags.size}</b> price{flags.size === 1 ? '' : 's'} to check before saving — marked <span className="cfe-flag">check</span>, listed first.</p>
              )}

              <div className="seg cfe-seg" role="tablist">
                <button type="button" role="tab" aria-selected={show === 'priced'} className={`seg-btn${show === 'priced' ? ' on' : ''}`} onClick={() => setShow('priced')}>Priced ({priced.length})</button>
                <button type="button" role="tab" aria-selected={show === 'not'} className={`seg-btn${show === 'not' ? ' on' : ''}`} onClick={() => setShow('not')}>Not priced ({not.length})</button>
              </div>
              {rows == null ? <p className="muted sm">Loading the pairs…</p> : !list.length ? <p className="muted sm">None.</p> : (
                <div className="cfe-scroll">
                  <table className="cfe-table">
                    <thead><tr><th>Pair</th><th>Size</th><th>Batch</th><th>Store · order</th>{show === 'priced' ? <><th>Listed</th><th>Paid</th><th>From</th></> : <th>Why not</th>}</tr></thead>
                    <tbody>
                      {list.slice(0, 300).map((r) => (
                        <tr key={r.id}>
                          <td><b>{r.sku}</b> <span className="muted sm">{r.name}</span>{r.email_name ? <div className="muted xs">email: {r.email_name}</div> : null}</td>
                          <td>{r.size}</td>
                          <td>{r.batch}<div className="muted xs cfe-ord">{r.trk}</div></td>
                          <td>{r.store || '—'}{r.order ? <div className="muted xs cfe-ord">#{r.order}</div> : null}</td>
                          {show === 'priced'
                            ? <><td className="muted">{r.full != null && r.full > r.each ? money(r.full) : ''}</td>
                              <td><b>{money(r.each)}</b>{flags.has(r.id) ? <div className="xs"><span className="cfe-flag" title={flags.get(r.id)}>check</span> <span className="muted">{flags.get(r.id)}</span></div> : null}</td><td className="muted sm">{r.how === 'order' ? 'the order' : r.how === 'sku' ? 'a receipt with this SKU' : 'the parcel’s email'}{r.note ? ` · ${r.note}` : ''}</td></>
                            : <td className="sm">{r.reason}</td>}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {list.length > 300 && <p className="muted sm">Showing the first 300 of {list.length}. The CSV has all of them.</p>}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
