// Rescale requests: the PH form (flag a SKU for the warehouse to recount/rescan)
// and the shared report (reported vs actual on shelf; warehouse audits, PH views
// + creates).
import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { TopBar, DateRangeBar, RescaleCompare, YesNo, PriceInput } from '../components/common.jsx';
import { Icon } from '../components/NavIcons.jsx';
import { useUnsavedGuard } from '../hooks.js';
import { rangeOf } from '../lib/format.js';
import { REQUEST_REASONS } from '../lib/constants.js';
import { PH_FLAGS, calcFinalPrice } from '../lib/ph.js';

// Monotonic key source for this screen's React lists (unique among siblings).
let cartKey = 1;

// PH form: flag a SKU (sizes/qty, current price, reason) for the warehouse to
// recount / rescan. Lands in the warehouse Rescale Requests inbox.
function RescaleRequestForm({ onHome, onSignOut, backLabel = '← Home' }) {
  const [sku, setSku] = useState('');
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [reason, setReason] = useState('mismatch');
  const [reasonOther, setReasonOther] = useState('');
  const [note, setNote] = useState('');
  const [sizes, setSizes] = useState(() => [{ key: cartKey++, size: '', qty: 1 }]);
  const [busy, setBusy] = useState(false);
  const [lookupBusy, setLookupBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const dirty = !done && (sku.trim() || name.trim() || note.trim() || sizes.some((s) => String(s.size).trim()));
  useUnsavedGuard(!!dirty);

  // Look the SKU up and auto-fill the shoe name (Alias catalog).
  async function lookupSku() {
    const s = sku.trim();
    if (!s) return;
    setLookupBusy(true); setError('');
    try {
      const { product } = await api.searchSku(s);
      if (product?.name) setName(product.name);
      if (product?.sku) setSku(product.sku);
    } catch (err) { if (err.unauthorized) return onSignOut(); setError(`Lookup failed: ${err.message}`); }
    finally { setLookupBusy(false); }
  }

  const addSize = () => setSizes((a) => [...a, { key: cartKey++, size: '', qty: 1 }]);
  const setSize = (k, patch) => setSizes((a) => a.map((s) => (s.key === k ? { ...s, ...patch } : s)));
  const removeSize = (k) => setSizes((a) => a.filter((s) => s.key !== k));

  async function submit() {
    setError('');
    if (!sku.trim()) { setError('Enter the SKU.'); return; }
    if (reason === 'other' && !reasonOther.trim()) { setError('Enter a custom reason.'); return; }
    const cleanSizes = sizes.filter((s) => String(s.size).trim()).map((s) => ({ size: String(s.size).trim(), qty: Math.max(1, Number(s.qty) || 1) }));
    if (!cleanSizes.length) { setError('Add at least one size + quantity.'); return; }
    setBusy(true);
    try {
      await api.rescaleRequestCreate({
        sku: sku.trim(), name: name.trim(), sizes: cleanSizes,
        price: price === '' ? null : Number(price),
        reason: reason === 'other' ? reasonOther.trim() : reason, note: note.trim(),
      });
      setDone(true);
    } catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setBusy(false); }
  }

  if (done) return (
    <div className="app">
      <TopBar title="Request Rescale" onHome={onHome} onSignOut={onSignOut} />
      <div className="card">
        <div className="modal-icon success">✓</div>
        <h3 className="modal-title">Rescale requested</h3>
        <p className="muted">The warehouse will see it in their <b>Rescale Requests</b> inbox.</p>
        <div className="modal-actions">
          <button className="btn primary" onClick={() => { setDone(false); setSku(''); setName(''); setPrice(''); setNote(''); setReason('mismatch'); setReasonOther(''); setSizes([{ key: cartKey++, size: '', qty: 1 }]); }}>New request</button>
          <button className="btn ghost" onClick={onHome}>{backLabel}</button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="app">
      <TopBar title="Request Rescale" onHome={onHome} onSignOut={onSignOut} />
      <div className="card">
        <h3 className="rows-title">Request a rescale</h3>
        <div className="batch-form">
          <label><span className="cap">SKU / Style *</span>
            <span className="searchrow">
              <input value={sku} onChange={(e) => setSku(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); lookupSku(); } }} autoCapitalize="characters" autoCorrect="off" placeholder="e.g. FV5104-004" />
              <button type="button" className="btn ghost" disabled={lookupBusy || !sku.trim()} onClick={lookupSku}>{lookupBusy ? '…' : 'Search'}</button>
            </span>
          </label>
          <label><span className="cap">Shoe name <span className="muted">(auto-fills from SKU)</span></span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Search a SKU to fill this" /></label>
          <label><span className="cap">Reason *</span>
            <select value={reason} onChange={(e) => setReason(e.target.value)}>
              {REQUEST_REASONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          {reason === 'other' && <label><span className="cap">Custom reason *</span><input value={reasonOther} maxLength={80} onChange={(e) => setReasonOther(e.target.value)} /></label>}
          <label><span className="cap">Current price ($)</span><input type="number" min="0" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} /></label>
          <label className="batch-form-wide"><span className="cap">Note <span className="muted">(optional)</span></span><input value={note} onChange={(e) => setNote(e.target.value)} /></label>
        </div>
        <div className="size-rows">
          <div className="muted sm">Sizes &amp; quantities *</div>
          {sizes.map((s) => (
            <div className="size-line" key={s.key}>
              <input className="sz" placeholder="Size" value={s.size} onChange={(e) => setSize(s.key, { size: e.target.value })} />
              <div className="qty-stepper">
                <button type="button" className="btn icon ghost step" onClick={() => setSize(s.key, { qty: Math.max(1, (Number(s.qty) || 1) - 1) })}>−</button>
                <input className="qty" type="number" min="1" value={s.qty} onChange={(e) => setSize(s.key, { qty: e.target.value })} />
                <button type="button" className="btn icon ghost step" onClick={() => setSize(s.key, { qty: (Number(s.qty) || 1) + 1 })}>+</button>
              </div>
              <button type="button" className="btn icon ghost remove" title="Remove" onClick={() => removeSize(s.key)}>×</button>
            </div>
          ))}
          <button type="button" className="btn sm ghost" onClick={addSize}>+ Add size</button>
        </div>
        {error && <div className="error mt">{error}</div>}
      </div>
      <div className="batch-bar">
        <button className="btn ghost" onClick={onHome}>{backLabel}</button>
        <button className="btn primary" disabled={busy} onClick={submit}>{busy ? 'Submitting…' : 'Submit request'}</button>
      </div>
    </div>
  );
}

// Shared report of rescale requests — reported vs actual. Warehouse can audit
// (enter actual shelf counts); PH can view + create. Both see the comparison.
export function RescaleRequestsReport({ canAudit, canCreate, showPricing = true, onHome, onSignOut }) {
  const [mode, setMode] = useState('list'); // 'list' | 'new'
  const [requests, setRequests] = useState(null);
  const [error, setError] = useState('');
  const [statusF, setStatusF] = useState(canAudit ? 'open' : 'all');
  const [dr, setDr] = useState(() => ({ mode: 'day', anchor: new Date() }));
  const [auditId, setAuditId] = useState(null);
  const [auditRows, setAuditRows] = useState([]);
  const [auditNote, setAuditNote] = useState('');
  const [busyId, setBusyId] = useState(null);
  // PH listing (per-size GI/Final + II/AL/SX/SH) shown INLINE on every audited
  // request — a draft per request id, editable for PH (canCreate).
  const [listDrafts, setListDrafts] = useState({}); // { [reqId]: rows[] }
  const [giBusyId, setGiBusyId] = useState(null);   // request whose GI is being fetched
  const [saveBusyId, setSaveBusyId] = useState(null);
  const [listDirty, setListDirty] = useState(false);
  useUnsavedGuard(listDirty); // guard unsaved listing edits against Back/refresh

  async function load() {
    setError('');
    try {
      const [from, to] = rangeOf(dr.mode, dr.anchor);
      const { requests: r } = await api.rescaleRequestList(statusF, from, to);
      setRequests(r);
      // Seed an inline listing draft for every audited request (from its saved
      // listing, else the audited size counts).
      setListDrafts(Object.fromEntries((r || []).filter((x) => x.status === 'audited').map((x) => [x.id, buildListRows(x)])));
      setListDirty(false);
    } catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
  }
  useEffect(() => { if (mode === 'list') load(); }, [dr, statusF, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  function startAudit(r) {
    setError(''); setAuditId(r.id);
    setAuditRows((r.sizes || []).map((s) => ({ key: cartKey++, size: String(s.size), qty: s.qty })));
    setAuditNote('');
  }
  const setAuditRow = (k, patch) => setAuditRows((a) => a.map((x) => (x.key === k ? { ...x, ...patch } : x)));
  const addAuditRow = () => setAuditRows((a) => [...a, { key: cartKey++, size: '', qty: 0 }]);
  const rmAuditRow = (k) => setAuditRows((a) => a.filter((x) => x.key !== k));

  async function submitAudit(r) {
    const actual = auditRows.filter((x) => String(x.size).trim()).map((x) => ({ size: String(x.size).trim(), qty: Math.max(0, Number(x.qty) || 0) }));
    if (!actual.length) { setError('Enter the actual count for at least one size.'); return; }
    setBusyId(r.id); setError('');
    try { await api.rescaleRequestAudit(r.id, actual, auditNote.trim()); setAuditId(null); load(); }
    catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setBusyId(null); }
  }

  // ---- PH listing (after the warehouse audit): set GI/Final + II/AL/SX/SH ----
  // Seed rows from the audited actual counts (fallback to reported sizes), merging
  // in any already-saved listing values.
  function buildListRows(r) {
    const base = (r.actual_sizes && r.actual_sizes.length ? r.actual_sizes : (r.sizes || []));
    const saved = new Map((r.listing || []).map((l) => [String(l.size), l]));
    return base.map((s) => {
      const ex = saved.get(String(s.size)) || {};
      return {
        size: String(s.size), qty: s.qty,
        global_indicator: ex.global_indicator ?? '', price: ex.price ?? '',
        added_to_intel_inv: !!ex.added_to_intel_inv, synced_alias: !!ex.synced_alias,
        synced_stockx: !!ex.synced_stockx, synced_shopify: !!ex.synced_shopify,
      };
    });
  }
  const setListRow = (reqId, size, patch) => {
    setListDrafts((d) => ({ ...d, [reqId]: (d[reqId] || []).map((x) => (x.size === size ? { ...x, ...patch } : x)) }));
    setListDirty(true);
  };
  const setListGI = (reqId, size, v) => setListRow(reqId, size, { global_indicator: v, price: calcFinalPrice(v) });

  async function fetchGi(r) {
    setGiBusyId(r.id); setError('');
    try {
      const sizes = (listDrafts[r.id] || []).map((x) => x.size);
      const { results, configured } = await api.phGiLookup(r.sku, sizes);
      if (configured === false) { setError('Alias pricing isn’t configured, so GI can’t be fetched.'); return; }
      const bySize = new Map((results || []).map((x) => [String(x.size), x]));
      setListDrafts((d) => ({ ...d, [r.id]: (d[r.id] || []).map((x) => {
        const g = bySize.get(String(x.size));
        return g ? { ...x, global_indicator: g.global_indicator, price: g.price } : x;
      }) }));
      setListDirty(true);
      if (!results?.length) setError('No Alias prices found for this SKU’s sizes.');
    } catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setGiBusyId(null); }
  }

  async function saveList(r) {
    setSaveBusyId(r.id); setError('');
    const listing = (listDrafts[r.id] || []).map((x) => ({
      size: x.size,
      global_indicator: x.global_indicator === '' || x.global_indicator == null ? null : Number(x.global_indicator),
      price: x.price === '' || x.price == null ? null : Number(x.price),
      added_to_intel_inv: x.added_to_intel_inv, synced_alias: x.synced_alias,
      synced_stockx: x.synced_stockx, synced_shopify: x.synced_shopify,
    }));
    try {
      const { request } = await api.rescaleRequestListUpdate(r.id, listing, r.listed_at || null);
      setRequests((rs) => (rs || []).map((x) => (x.id === request.id ? request : x)));
      setListDrafts((d) => ({ ...d, [request.id]: buildListRows(request) }));
      setListDirty(false);
    } catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setSaveBusyId(null); }
  }

  if (mode === 'new') return <RescaleRequestForm onHome={() => setMode('list')} onSignOut={onSignOut} backLabel="← Requests" />;

  return (
    <div className="app app-wide">
      <TopBar title="Rescale Requests" onHome={onHome} onSignOut={onSignOut} />
      <div className="card">
        <p className="muted sm">{canAudit
          ? 'PH-flagged SKUs. Audit the shelf and enter the actual count per size — both teams then see reported vs actual.'
          : 'Track your rescale requests and the warehouse audit (reported vs actual on shelf).'}</p>
        <DateRangeBar mode={dr.mode} anchor={dr.anchor} onChange={(m, a) => setDr({ mode: m, anchor: a })}
          right={(
            <span className="ph-edit-actions">
              <span className="seg">
                {[['open', 'Open'], ['audited', 'Audited'], ['all', 'All']].map(([v, l]) =>
                  <button key={v} type="button" className={`seg-btn ${statusF === v ? 'on' : ''}`} onClick={() => setStatusF(v)}>{l}</button>)}
              </span>
              {canCreate && <button className="btn sm primary" onClick={() => setMode('new')}>+ New request</button>}
            </span>
          )} />
        {error && <div className="error mt">{error}</div>}
        {!requests ? <p className="muted">Loading…</p> : !requests.length ? <p className="muted">No requests in this range.</p> : (
          <div className="rc-list">
            {requests.map((r) => (
              <div className="rc-item" key={r.id}>
                <div className="rc-head">
                  <div>
                    <div className="rc-title">{r.name || r.sku}</div>
                    <div className="muted sm">{r.sku} · {r.reason}{r.price != null ? ` · $${Number(r.price).toFixed(2)}` : ''}</div>
                  </div>
                  <span className={`rc-pill ${r.status}`}>{r.status === 'audited' ? 'Audited' : 'Open'}</span>
                </div>
                <RescaleCompare reported={r.sizes} actual={r.actual_sizes} />
                {r.note ? <div className="muted sm">Request note: “{r.note}”</div> : null}
                {r.audit_note ? <div className="muted sm">Audit note: “{r.audit_note}”</div> : null}
                <div className="rc-foot muted sm">
                  Requested by {r.requested_by || '—'} · {new Date(r.created_at).toLocaleString()}
                  {r.status === 'audited' && r.resolved_by ? ` · audited by ${r.resolved_by}` : ''}
                </div>
                {canAudit && r.status === 'open' && (auditId === r.id ? (
                  <div className="rc-audit">
                    <div className="muted sm">Actual on shelf (per size):</div>
                    {auditRows.map((row) => (
                      <div className="size-line" key={row.key}>
                        <input className="sz" placeholder="Size" value={row.size} onChange={(e) => setAuditRow(row.key, { size: e.target.value })} />
                        <div className="qty-stepper">
                          <button type="button" className="btn icon ghost step" onClick={() => setAuditRow(row.key, { qty: Math.max(0, (Number(row.qty) || 0) - 1) })}>−</button>
                          <input className="qty" type="number" min="0" value={row.qty} onChange={(e) => setAuditRow(row.key, { qty: e.target.value })} />
                          <button type="button" className="btn icon ghost step" onClick={() => setAuditRow(row.key, { qty: (Number(row.qty) || 0) + 1 })}>+</button>
                        </div>
                        <button type="button" className="btn icon ghost remove" title="Remove" onClick={() => rmAuditRow(row.key)}>×</button>
                      </div>
                    ))}
                    <button type="button" className="btn sm ghost" onClick={addAuditRow}>+ Add size</button>
                    <input className="rc-auditnote" placeholder="Audit note (optional)" value={auditNote} onChange={(e) => setAuditNote(e.target.value)} />
                    <div className="ph-edit-actions">
                      <button className="btn sm primary" disabled={busyId === r.id} onClick={() => submitAudit(r)}>{busyId === r.id ? '…' : 'Submit audit'}</button>
                      <button className="btn sm ghost" onClick={() => setAuditId(null)}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <div className="rc-foot"><button className="btn sm primary" onClick={() => startAudit(r)}>🔍 Audit shelf</button></div>
                ))}

                {/* PH listing — shown INLINE once the warehouse has audited it
                    (feedback received). Editable for PH (canCreate); read-only for
                    others, with GI/Final hidden from warehouse (showPricing). */}
                {r.status === 'audited' && (() => {
                  const rows = listDrafts[r.id] || buildListRows(r);
                  const editable = canCreate;
                  return (
                    <div className="rc-listing">
                      <div className="rc-listing-head">
                        <span className="rc-listing-plan">Listing plan <span className="muted sm">· intended price + store status per size{r.listed_by ? ` · last by ${r.listed_by}` : ''}</span></span>
                        {editable && <button className="btn sm primary" disabled={saveBusyId === r.id} onClick={() => saveList(r)}>{saveBusyId === r.id ? 'Saving…' : 'Save plan'}</button>}
                      </div>
                      <p className="rc-listing-note muted sm">Records what to list once these units are restocked — a plan, <b>not</b> a live store sync. Toggling here doesn’t change the actual items; do that in the PH grid after shelving.</p>
                      <div className="rc-listing-tablewrap">
                        <table className="rc-listing-table">
                          <thead><tr>
                            <th>Size</th><th>Qty</th>
                            {showPricing && <><th><span className="ph-gi-th">Global indicator{editable && <button type="button" className="btn icon ph-gi-refresh" title="Re-fetch GI from Alias for these sizes" disabled={giBusyId === r.id} onClick={() => fetchGi(r)}><Icon name="refresh" size="1em" className={giBusyId === r.id ? 'spin' : ''} /></button>}</span></th><th>Final (GI+20%)</th></>}
                            {PH_FLAGS.map(([k, label]) => <th key={k}>{label}</th>)}
                          </tr></thead>
                          <tbody>
                            {rows.map((row) => (
                              <tr key={row.size}>
                                <td>US {row.size}</td>
                                <td>×{row.qty}</td>
                                {showPricing && (editable ? (
                                  <>
                                    <td><PriceInput value={row.global_indicator} onChange={(e) => setListGI(r.id, row.size, e.target.value)} /></td>
                                    <td><PriceInput value={row.price} onChange={(e) => setListRow(r.id, row.size, { price: e.target.value })} /></td>
                                  </>
                                ) : (
                                  <>
                                    <td>{row.global_indicator !== '' && row.global_indicator != null ? `$${Number(row.global_indicator).toFixed(2)}` : '—'}</td>
                                    <td>{row.price !== '' && row.price != null ? `$${Number(row.price).toFixed(2)}` : '—'}</td>
                                  </>
                                ))}
                                {PH_FLAGS.map(([k]) => (
                                  <td key={k}><YesNo value={row[k]} editing={editable} onChange={(v) => setListRow(r.id, row.size, { [k]: v })} /></td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  );
                })()}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
