// One page: search/scan inventory, filter (date/supplier/status) with totals +
// CSV (the daily report), select rows → print VIN labels, and click a row (or
// scan a VIN) to open an item's detail + history + status/notes.
import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { loadPrefs, savePrefs } from '../prefs.js';
import { STATUSES, statusLabel } from '../statuses.js';
import { TopBar, StatusPill, SyncBadges, SizesQty, LabelSheet, PreferencesModal } from '../components/common.jsx';
import { useUnsavedGuard, useMediaQuery } from '../hooks.js';
import { groupPhRows } from '../lib/ph.js';
import { eventLabel } from '../lib/history.js';
import { toCSV, downloadCSV } from '../lib/csv.js';
import { ymd, periodRange, periodLabel, shiftAnchor } from '../lib/format.js';
import { SUPPLIERS } from '../lib/constants.js';

// Lazy-loaded so the barcode library only downloads when the camera is opened.
const CameraScanner = lazy(() => import('../components/CameraScanner.jsx'));

export function Inventory({ navBack, openVin, onConsumedVin, onHome, onSignOut }) {
  const today = new Date().toISOString().slice(0, 10);
  const [mode, setMode] = useState('list'); // 'list' | 'detail'

  // list / filters
  const [q, setQ] = useState('');
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [supplier, setSupplier] = useState('');
  const [status, setStatus] = useState('');
  const [intake, setIntake] = useState(''); // '' | 'receiving' | 'rescale'
  const [periodMode, setPeriodMode] = useState('day'); // 'day' | 'week' | 'month' | 'custom'
  const [anchor, setAnchor] = useState(() => new Date()); // reference date for the current period
  const [data, setData] = useState(null); // { rows, totals }
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sel, setSel] = useState(() => new Set());
  const [labels, setLabels] = useState(null);
  const [expanded, setExpanded] = useState(() => new Set()); // vins with the accordion open
  const [hist, setHist] = useState({}); // vin -> { loading, events, error } (lazily loaded)
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkStatusSel, setBulkStatusSel] = useState('needs_shelf');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [statusDrafts, setStatusDrafts] = useState({}); // vin -> picked status (applied on Save)
  const [savingStatusVin, setSavingStatusVin] = useState(null);

  // scan (camera optional; a scanner gun just types into the search box)
  const [showCam, setShowCam] = useState(false);
  const [prefs, setPrefs] = useState(loadPrefs);
  const [showPrefs, setShowPrefs] = useState(false);
  const setCameraZoom = (z) => setPrefs((p) => { const n = { ...p, cameraZoom: z }; savePrefs(n); return n; });
  const searchRef = useRef(null);
  const isMobile = useMediaQuery('(max-width: 768px)');

  // detail
  const [detail, setDetail] = useState(null); // { item, events }
  const [note, setNote] = useState('');
  const [statusNote, setStatusNote] = useState(''); // optional reason saved with a status change
  const [detailStatusDraft, setDetailStatusDraft] = useState(null); // staged status/tag — applied only on Save
  const [customTag, setCustomTag] = useState(''); // free-text custom tag being typed
  const [busy, setBusy] = useState(false);
  useUnsavedGuard(Object.keys(statusDrafts).length > 0 || !!detailStatusDraft); // guard staged status edits

  async function load(over = {}) {
    setLoading(true); setError(''); setSel(new Set()); setExpanded(new Set()); setHist({});
    const f = { q, from, to, supplier, status, intake, ...over };
    const params = {};
    if (f.q) params.q = f.q;
    if (f.from) params.from = f.from;
    if (f.to) params.to = f.to;
    if (f.supplier) params.supplier = f.supplier;
    if (f.status) params.status = f.status;
    if (f.intake) params.kind = f.intake;
    try { setData(await api.itemsQuery(params)); }
    catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Keep the search box focused in list mode so a scanner gun types into it.
  useEffect(() => { if (mode === 'list' && !showCam) searchRef.current?.focus(); }, [mode, showCam, data]);

  // Opened from another page (e.g. Recent batches → a VIN): jump to its detail.
  useEffect(() => {
    if (openVin) { openDetail(openVin); onConsumedVin?.(); }
  }, [openVin]); // eslint-disable-line react-hooks/exhaustive-deps

  // Device Back button: close a modal/camera, else leave the detail view, else
  // fall through to the app (→ home).
  useEffect(() => {
    if (!navBack) return undefined;
    navBack.current = () => {
      if (bulkOpen) { setBulkOpen(false); return true; }
      if (showPrefs) { setShowPrefs(false); return true; }
      if (labels) { setLabels(null); return true; }
      if (showCam) { setShowCam(false); return true; }
      if (mode === 'detail') { backToList(); return true; }
      return false;
    };
    return () => { if (navBack) navBack.current = null; };
  }, [navBack, bulkOpen, showPrefs, labels, showCam, mode]);

  // One box for everything: a scanned/typed VIN opens its detail; anything else
  // searches the whole inventory (dates cleared so search isn't limited to today).
  function submit() {
    const v = q.trim();
    if (!v) return;
    if (/^s[a-z]*-?\d/i.test(v)) { openDetail(v); setQ(''); return; } // looks like a VIN (SBM-…/SB-…)
    // Text search: clear the date window (so it isn't limited to today) but keep
    // the query visible in the box so the user can see/refine what they searched.
    setFrom(''); setTo(''); load({ q: v, from: '', to: '' });
  }
  function viewToday() {
    setQ(''); setFrom(today); setTo(today); setSupplier(''); setStatus(''); setIntake('');
    setPeriodMode('day'); setAnchor(new Date());
    load({ q: '', from: today, to: today, supplier: '', status: '', intake: '' });
  }
  // Calendar-style navigation: switch period (day/week/month) or step ‹ / › and
  // immediately load that range — no Apply needed.
  function gotoPeriod(mode, a) {
    const [s, e] = periodRange(mode, a);
    const fs = ymd(s); const es = ymd(e);
    setPeriodMode(mode); setAnchor(a); setFrom(fs); setTo(es); setQ('');
    load({ q: '', from: fs, to: es });
  }

  async function openDetail(vin) {
    const v = String(vin).trim();
    if (!v) return;
    setMode('detail'); setDetail(null); setError(''); setShowCam(false);
    setDetailStatusDraft(null); setCustomTag(''); setStatusNote(''); // reset staged status for the new item
    try { setDetail(await api.itemLookup(v)); }
    catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
  }
  function backToList() { setMode('list'); setDetail(null); setError(''); load(); }

  // Report: status edits are staged in statusDrafts and only persisted on Save.
  const setStatusDraft = (vin, status) => setStatusDrafts((d) => ({ ...d, [vin]: status }));
  async function saveRowStatus(vin, current) {
    const status = statusDrafts[vin];
    if (!status || status === current) return;
    setSavingStatusVin(vin); setError('');
    try {
      const res = await api.itemEvent(vin, 'status_change', { status });
      // Merge the server's updated item so cascades (e.g. sold → sync flags
      // cleared) reflect in the row immediately, not just the status text.
      const u = res?.item || {};
      setData((d) => (d ? { ...d, rows: d.rows.map((r) => (r.vin === vin ? {
        ...r, status,
        added_to_intel_inv: u.added_to_intel_inv ?? r.added_to_intel_inv,
        synced_alias: u.synced_alias ?? r.synced_alias,
        synced_stockx: u.synced_stockx ?? r.synced_stockx,
        synced_shopify: u.synced_shopify ?? r.synced_shopify,
      } : r)) } : d));
      setStatusDrafts((d) => { const n = { ...d }; delete n[vin]; return n; }); // clear → Save disabled again
      setHist((h) => { const n = { ...h }; delete n[vin]; return n; }); // reload history on next expand
    } catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setSavingStatusVin(null); }
  }
  // Report: bulk status change over the selected VINs.
  async function applyBulkStatus() {
    setBulkBusy(true); setError('');
    try { await api.bulkStatus([...sel], bulkStatusSel); setBulkOpen(false); load(); }
    catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setBulkBusy(false); }
  }

  // Accordion: toggle a row open/closed; the first time it opens, lazily fetch
  // that item's audit notes & history (keeps the list query light).
  function toggleRow(vin) {
    setExpanded((s) => { const n = new Set(s); n.has(vin) ? n.delete(vin) : n.add(vin); return n; });
    if (hist[vin]) return;
    setHist((h) => ({ ...h, [vin]: { loading: true } }));
    api.itemLookup(vin)
      .then((d) => setHist((h) => ({ ...h, [vin]: { loading: false, events: d.events || [] } })))
      .catch((err) => {
        if (err.unauthorized) return onSignOut();
        setHist((h) => ({ ...h, [vin]: { loading: false, error: err.message } }));
      });
  }

  const STATUS = STATUSES.map((s) => s.key);
  // The currently-staged status/tag for the open item (defaults to its real
  // status until the user picks a preset or types a custom tag).
  const draftStatus = detailStatusDraft ?? detail?.item?.status ?? null;
  const stageStatus = (s) => { setDetailStatusDraft(s); setCustomTag(''); };
  const stageCustomTag = () => { const v = customTag.trim(); if (v) setDetailStatusDraft(v); };
  const clearStatusDraft = () => { setDetailStatusDraft(null); setCustomTag(''); };
  // Persist the staged status/tag — only runs when the user hits Save.
  async function saveItemStatus() {
    if (!detail) return;
    const s = draftStatus;
    if (!s || s === detail.item.status) return;
    const reason = statusNote.trim();
    setBusy(true); setError('');
    try {
      setDetail(await api.itemEvent(detail.item.vin, 'status_change', { status: s, from: detail.item.status, note: reason || undefined }));
      setStatusNote(''); setDetailStatusDraft(null); setCustomTag('');
    }
    catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setBusy(false); }
  }
  async function submitNote() {
    const text = note.trim();
    if (!text || !detail) return;
    setBusy(true); setError('');
    try { setDetail(await api.itemEvent(detail.item.vin, 'note', { text })); setNote(''); }
    catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setBusy(false); }
  }

  /* ----- detail view ----- */
  if (mode === 'detail') {
    const it = detail?.item;
    return (
      <div className="app">
        <TopBar title="Inventory" onHome={onHome} onSignOut={onSignOut}
          right={<button className="btn ghost sm" onClick={backToList}>← Back to list</button>} />
        {error && <div className="error mt">{error}</div>}
        {!detail ? <p className="muted">Loading…</p> : (
          <>
            <div className="card result">
              <div className="result-grid">
                {it.image_url ? <img className="shoe-img" src={it.image_url} alt="" loading="lazy" /> : <div className="shoe-img placeholder">No image</div>}
                <div className="details">
                  <h2>{it.name}</h2>
                  <dl>
                    <div><dt>VIN</dt><dd><span className="vin">{it.vin}</span></dd></div>
                    <div><dt>SKU</dt><dd>{it.sku || '—'}</dd></div>
                    <div><dt>Size</dt><dd>{it.size || '—'}</dd></div>
                    <div><dt>Cost</dt><dd>${Number(it.cost || 0).toFixed(2)}</dd></div>
                    <div><dt>Status</dt><dd><StatusPill status={it.status} /></dd></div>
                    <div><dt>Batch</dt><dd>{it.batch_code || '—'}</dd></div>
                    <div><dt>Intake</dt><dd>{it.kind === 'rescale' ? `Rescaled${it.origin ? ` (${it.origin})` : ''}` : 'Received'}</dd></div>
                    <div><dt>Supplier</dt><dd>{it.supplier_name || '—'}</dd></div>
                    <div><dt>Received</dt><dd>{(it.date_received || '').slice(0, 10) || '—'}</dd></div>
                    <div><dt>Price</dt><dd>{it.price != null ? `$${Number(it.price).toFixed(2)}` : '—'}</dd></div>
                    <div><dt>Listed</dt><dd><SyncBadges item={it} /></dd></div>
                  </dl>
                </div>
              </div>

              <h3 className="rows-title">Set status / tag</h3>
              {/* Pick a preset or type a custom tag. Nothing is saved until "Save". */}
              <div className="status-actions">
                {STATUS.map((s) => (
                  <button key={s} className={`btn sm ${draftStatus === s ? 'primary' : 'ghost'}`} disabled={busy} onClick={() => stageStatus(s)}>{statusLabel(s)}</button>
                ))}
              </div>
              <div className="custom-tag-row">
                <input className="custom-tag-input" placeholder="Custom tag…" value={customTag} maxLength={40} disabled={busy}
                  onChange={(e) => setCustomTag(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); stageCustomTag(); } }} />
                <button type="button" className="btn sm ghost" disabled={busy || !customTag.trim()} onClick={stageCustomTag}>Use tag</button>
              </div>
              <input className="status-reason" placeholder="Optional reason — saved with the status change (e.g. why it was returned)" value={statusNote} onChange={(e) => setStatusNote(e.target.value)} />
              {draftStatus && draftStatus !== it.status && (
                <div className="status-save-row">
                  <span className="muted sm">Pending change → <StatusPill status={draftStatus} /></span>
                  <button className="btn primary sm" disabled={busy} onClick={saveItemStatus}>{busy ? 'Saving…' : 'Save'}</button>
                  <button className="btn ghost sm" disabled={busy} onClick={clearStatusDraft}>Cancel</button>
                </div>
              )}

              <h3 className="rows-title">Add note</h3>
              <form className="searchrow" onSubmit={(e) => { e.preventDefault(); submitNote(); }}>
                <input placeholder="Note about this item…" value={note} onChange={(e) => setNote(e.target.value)} />
                <button className="btn primary" disabled={busy || !note.trim()}>Add</button>
              </form>

              <div className="send"><button className="btn ghost wide" onClick={() => setLabels([{ vin: it.vin, sku: it.sku, size: it.size, name: it.name, upc: it.upc, colorway: it.colorway, gender: it.gender, withBox: it.with_box }])}>🖨 Print this label</button></div>
            </div>

            <div className="card">
              <h3 className="rows-title">History</h3>
              <div className="timeline">
                {detail.events.map((e) => (
                  <div className="tl-item" key={e.id}>
                    <div className="tl-dot" />
                    <div className="tl-body">
                      <div>{eventLabel(e)}</div>
                      <div className="muted sm">{new Date(e.created_at).toLocaleString()}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
        {labels && <LabelSheet items={labels} onClose={() => setLabels(null)} />}
        {showPrefs && <PreferencesModal prefs={prefs} onCameraZoom={setCameraZoom} onClose={() => setShowPrefs(false)} />}
      </div>
    );
  }

  /* ----- list view ----- */
  const rows = data?.rows || [];
  // Merge by SKU + status (sizes aggregated), same as the PH report.
  const groups = groupPhRows(rows);
  const groupItems = (g) => rows.filter((r) => g.vins.includes(r.vin));
  const toggle = (vin) => setSel((s) => { const n = new Set(s); n.has(vin) ? n.delete(vin) : n.add(vin); return n; });
  const toggleAll = () => setSel((s) => (s.size === rows.length ? new Set() : new Set(rows.map((r) => r.vin))));
  const groupChecked = (g) => g.vins.every((v) => sel.has(v));
  const toggleGroup = (g) => setSel((s) => { const n = new Set(s); const all = g.vins.every((v) => n.has(v)); g.vins.forEach((v) => (all ? n.delete(v) : n.add(v))); return n; });
  const selectedItems = rows.filter((r) => sel.has(r.vin));

  // Status change over a whole SKU group (all its VINs) via bulk-status.
  async function saveGroupStatus(g) {
    const status = statusDrafts[g.key];
    if (!status || status === g.status) return;
    setSavingStatusVin(g.key); setError('');
    try {
      await api.bulkStatus(g.vins, status);
      setStatusDrafts((d) => { const n = { ...d }; delete n[g.key]; return n; });
      load();
    } catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setSavingStatusVin(null); }
  }

  // Expanded detail for a SKU group — metrics, group status change, print all,
  // and a per-VIN units list (drill into any one for its full history).
  const invDetail = (g) => (
    <div className="inv-detail">
      <dl className="inv-metrics">
        <div><dt>Date received</dt><dd>{(g.date_received || '').slice(0, 10) || '—'}</dd></div>
        <div><dt>Cost</dt><dd>{g.cost != null ? `${g.costMixed ? '~' : ''}$${Number(g.cost).toFixed(2)}` : '—'}</dd></div>
        <div><dt>Supplier / Buyer</dt><dd>{g.supplier_name || '—'}{g.buyer_name ? ` / ${g.buyer_name}` : ''}</dd></div>
        <div><dt>Total units</dt><dd>{g.qty}</dd></div>
        <div className="inv-metrics-wide"><dt>Sizes</dt><dd><SizesQty sizes={g.sizes} /></dd></div>
        <div><dt>Price</dt><dd>{g.price != null ? `${g.priceMixed ? '~' : ''}$${Number(g.price).toFixed(2)}` : '—'}</dd></div>
        <div className="inv-metrics-wide"><dt>Listed / synced</dt><dd><SyncBadges item={g} /></dd></div>
      </dl>
      <div className="inv-actions">
        <label className="inv-status-edit">Status (all {g.qty})
          <select value={statusDrafts[g.key] ?? g.status} onChange={(e) => setStatusDraft(g.key, e.target.value)}>
            {STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </label>
        <button className="btn sm primary" disabled={(statusDrafts[g.key] ?? g.status) === g.status || savingStatusVin === g.key} onClick={() => saveGroupStatus(g)}>
          {savingStatusVin === g.key ? 'Saving…' : 'Save'}
        </button>
        <button className="btn sm ghost" onClick={() => setLabels(groupItems(g))}>🖨 Print labels ({g.qty})</button>
      </div>
      <div className="inv-units">
        <div className="inv-history-title">Units</div>
        {groupItems(g).map((r) => (
          <div className="inv-unit-row" key={r.vin}>
            <span className="vin">{r.vin}</span>
            <span className="muted sm">{r.size ? `US ${r.size}` : '—'}</span>
            <button className="btn sm ghost" onClick={() => openDetail(r.vin)}>Details →</button>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div className="app">
      <TopBar title="Inventory" onHome={onHome} onSignOut={onSignOut}
        right={<button className="btn ghost sm" onClick={() => setShowPrefs(true)} title="Preferences">⚙</button>} />

      <div className="card">
        {/* One box: scan a VIN (gun or camera) to open it, or type to search. */}
        <form className="searchrow" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <input ref={searchRef} placeholder="Scan a VIN, or search VIN / SKU / name…" value={q}
            onChange={(e) => setQ(e.target.value)} autoCapitalize="characters" />
          <button className="btn primary" disabled={loading}>Go</button>
          <button type="button" className={`btn ${showCam ? 'primary' : 'ghost'}`} onClick={() => setShowCam((v) => !v)} title="Scan with camera">📷</button>
        </form>
        {showCam && (
          <Suspense fallback={<p className="muted">Loading camera…</p>}>
            <CameraScanner mode="vin" onDetected={(c) => openDetail(c)} onClose={() => setShowCam(false)}
              zoom={prefs.cameraZoom} onZoomChange={setCameraZoom} />
          </Suspense>
        )}

        <div className="cal-bar mt">
          <div className="seg cal-modes" role="group" aria-label="Date range">
            {[['day', 'Day'], ['week', 'Week'], ['month', 'Month'], ['custom', 'Custom']].map(([m, lbl]) => (
              <button key={m} type="button" className={`seg-btn ${periodMode === m ? 'on' : ''}`}
                onClick={() => (m === 'custom' ? setPeriodMode('custom') : gotoPeriod(m, anchor))}>{lbl}</button>
            ))}
          </div>
          {periodMode !== 'custom' && (
            <div className="cal-nav">
              <button type="button" className="btn ghost sm" onClick={() => gotoPeriod(periodMode, shiftAnchor(periodMode, anchor, -1))} aria-label="Previous">‹</button>
              <span className="cal-label">{periodLabel(periodMode, anchor)}</span>
              <button type="button" className="btn ghost sm" onClick={() => gotoPeriod(periodMode, shiftAnchor(periodMode, anchor, 1))} aria-label="Next">›</button>
              <button type="button" className="btn ghost sm" onClick={viewToday}>Today</button>
            </div>
          )}
        </div>

        <div className="report-filters mt">
          {periodMode === 'custom' && <label>From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>}
          {periodMode === 'custom' && <label>To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>}
          <label>Supplier
            <select value={supplier} onChange={(e) => setSupplier(e.target.value)}>
              <option value="">All</option>
              {SUPPLIERS.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label>Status
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All</option>
              {STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </label>
          <label>Intake
            <select value={intake} onChange={(e) => setIntake(e.target.value)}>
              <option value="">All</option>
              <option value="receiving">Received</option>
              <option value="rescale">Rescaled</option>
            </select>
          </label>
          <button className="btn primary" onClick={() => load()} disabled={loading}>{loading ? '…' : 'Apply filters'}</button>
        </div>
      </div>

      {error && <div className="error mt">{error}</div>}

      {data && (
        <>
          <div className="batch-bar">
            <div className="batch-totals">
              <b>{data.totals.count}</b> items · <b>${data.totals.totalCost.toFixed(2)}</b>
              {Object.entries(data.totals.byStatus).map(([s, n]) => <span key={s} className="muted"> · {statusLabel(s)}: {n}</span>)}
            </div>
            <span className="report-actions">
              <button className="btn sm ghost" disabled={!sel.size} onClick={() => setBulkOpen(true)}>Edit status{sel.size ? ` (${sel.size})` : ''}</button>
              <button className="btn sm primary" disabled={!sel.size} onClick={() => setLabels(selectedItems)}>🖨 Print {sel.size || ''} label{sel.size === 1 ? '' : 's'}</button>
              <button className="btn sm ghost" disabled={!rows.length} onClick={() => downloadCSV(`inventory_${from || 'all'}_${to || ''}.csv`, toCSV(rows))}>Export CSV</button>
            </span>
          </div>
          <div className="card">
            {!rows.length ? <p className="muted">No items.</p> : isMobile ? (
              <div className="dcards">
                <label className="dcard-selectall"><input type="checkbox" checked={sel.size === rows.length && rows.length > 0} onChange={toggleAll} /> Select all ({rows.length} units)</label>
                {groups.map((g) => {
                  const open = expanded.has(g.key);
                  return (
                    <div className={`dcard ${open ? 'open' : ''}`} key={g.key}>
                      <div className="dcard-top">
                        <label onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={groupChecked(g)} onChange={() => toggleGroup(g)} /> <span className="dcard-name">{g.name}</span></label>
                        <button className="btn icon ghost sm" onClick={() => toggleRow(g.key)} aria-expanded={open}>{open ? '▾' : '▸'}</button>
                      </div>
                      <button className="dcard-main" onClick={() => toggleRow(g.key)}>
                        <div className="dcard-line"><span className="muted">{g.sku || '—'}</span><span>×{g.qty}</span></div>
                        <div className="dcard-line"><span className="muted sm"><SizesQty sizes={g.sizes} /></span></div>
                        <div className="inv-status"><StatusPill status={g.status} /><SyncBadges item={g} /></div>
                      </button>
                      {open && invDetail(g)}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="inv-tablewrap">
                <table className="inv-table">
                  <thead>
                    <tr>
                      <th className="inv-col-check">
                        <input type="checkbox" checked={sel.size === rows.length && rows.length > 0} onChange={toggleAll} aria-label="Select all" />
                      </th>
                      <th>Shoe</th>
                      <th className="inv-col-sku">SKU</th>
                      <th>Sizes (qty)</th>
                      <th className="inv-col-size">Qty</th>
                      <th className="inv-col-status">Status &amp; sync</th>
                    </tr>
                  </thead>
                  <tbody>
                  {groups.map((g) => {
                    const open = expanded.has(g.key);
                    return (
                      <React.Fragment key={g.key}>
                        <tr className={`inv-trow ${open ? 'open' : ''}`} onClick={() => toggleRow(g.key)}>
                          <td className="inv-col-check" onClick={(e) => e.stopPropagation()}>
                            <input type="checkbox" checked={groupChecked(g)} onChange={() => toggleGroup(g)} aria-label={`Select ${g.sku}`} />
                          </td>
                          <td className="inv-name" title={g.name}><span className="inv-caret">{open ? '▾' : '▸'}</span>{g.name}</td>
                          <td className="inv-col-sku">{g.sku || '—'}</td>
                          <td className="ph-sizes"><SizesQty sizes={g.sizes} /></td>
                          <td className="inv-col-size"><b>×{g.qty}</b></td>
                          <td className="inv-col-status"><span className="inv-status"><StatusPill status={g.status} /><SyncBadges item={g} /></span></td>
                        </tr>
                        {open && (
                          <tr className="inv-drow">
                            <td colSpan={6}>{invDetail(g)}</td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {bulkOpen && (
        <div className="modal-overlay" onClick={() => !bulkBusy && setBulkOpen(false)}>
          <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Change status — {sel.size} item{sel.size === 1 ? '' : 's'}</h3>
            <div className="status-pick">
              {STATUSES.map((s) => (
                <label key={s.key} className={`status-pick-row ${bulkStatusSel === s.key ? 'sel' : ''}`}>
                  <input type="radio" name="bulkstatus" checked={bulkStatusSel === s.key} onChange={() => setBulkStatusSel(s.key)} />
                  <StatusPill status={s.key} />
                </label>
              ))}
            </div>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setBulkOpen(false)} disabled={bulkBusy}>Cancel</button>
              <button className="btn primary" onClick={applyBulkStatus} disabled={bulkBusy}>{bulkBusy ? 'Applying…' : 'Apply'}</button>
            </div>
          </div>
        </div>
      )}

      {labels && <LabelSheet items={labels} onClose={() => setLabels(null)} />}
      {showPrefs && <PreferencesModal prefs={prefs} onCameraZoom={setCameraZoom} onClose={() => setShowPrefs(false)} />}
    </div>
  );
}
