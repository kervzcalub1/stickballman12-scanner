// One page: search/scan inventory, filter (date/supplier/status) with totals +
// CSV (the daily report), select rows → print VIN labels, and click a row (or
// scan a VIN) to open an item's detail + history + status/notes.
import React, { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { useQueryParam } from '../lib/urlstate.js';
import { loadPrefs, savePrefs } from '../prefs.js';
import { STATUSES, statusLabel } from '../statuses.js';
import { TopBar, StatusPill, SyncBadges, SizesQty, LabelSheet, PreferencesModal, HistoryLine, PhotoLightbox, ShoeThumb, IntakeChip, CopyText, RemoveUnitsModal } from '../components/common.jsx';
import { Icon } from '../components/NavIcons.jsx';
import { useUnsavedGuard, useMediaQuery } from '../hooks.js';
import { groupPhRows } from '../lib/ph.js';
import { isLocationCode } from '../lib/codes.js';
import { toCSV, downloadCSV } from '../lib/csv.js';
import { ymd, periodRange, periodLabel, shiftAnchor, estToday } from '../lib/format.js';
import { SUPPLIERS } from '../lib/constants.js';

// Lazy-loaded so the barcode library only downloads when the camera is opened.
const CameraScanner = lazy(() => import('../components/CameraScanner.jsx'));

// What sits next to the status pill. The PH sync badges only mean something for
// PH-managed stock: in-store is listed to the stores by hand, and existing (old)
// stock was already listed long before this system — so both show a chip naming
// where the pair came from instead of four badges that would always read the same.
function intakeChip(g) {
  if (g.kind === 'instore' || g.kind === 'existing') return <IntakeChip kind={g.kind} />;
  return <SyncBadges item={g} />;
}

// `canEditStock` is the warehouse/PH split. PH team gets the same page — search,
// filters, detail, history, photos, labels, CSV, and Remove pairs (they already have
// that on their own grid) — but NOT the physical-stock writes: status changes and
// Move to shelf. Those endpoints stay warehouse-only server-side, so this flag hides
// buttons that would 403 rather than granting anything (docs/context/inventory.md).
export function Inventory({ navBack, openVin, onConsumedVin, onHome, onSignOut, canEditStock = true }) {
  const today = estToday();
  const [mode, setMode] = useState('list'); // 'list' | 'detail'

  // list / filters — mirrored into the query string so a refresh (or a link shared
  // with a colleague) comes back to the same view instead of resetting to "this week,
  // no filters". These are all short, non-sensitive and safe for someone else to open.
  const [q, setQ] = useQueryParam('q');
  const [from, setFrom] = useQueryParam('from', ymd(periodRange('week', new Date())[0]));
  const [to, setTo] = useQueryParam('to', ymd(periodRange('week', new Date())[1]));
  const [supplier, setSupplier] = useQueryParam('supplier');
  const [status, setStatus] = useQueryParam('status');
  const [intake, setIntake] = useQueryParam('intake'); // '' | 'receiving' | 'rescale'
  const [periodMode, setPeriodMode] = useQueryParam('period', 'week'); // 'day' | 'week' | 'month' | 'custom'
  // The period anchor is a Date; it round-trips through the URL as a plain ymd string.
  // Falls back to today if absent or unparseable, so a hand-edited URL can't produce an
  // Invalid Date that would poison every period calculation downstream.
  const [anchorYmd, setAnchorYmd] = useQueryParam('anchor', ymd(new Date()));
  const anchor = useMemo(() => {
    const d = new Date(`${anchorYmd}T00:00:00`);
    return Number.isNaN(d.getTime()) ? new Date() : d;
  }, [anchorYmd]);
  const setAnchor = (d) => setAnchorYmd(ymd(d instanceof Date ? d : new Date(d)));
  const [data, setData] = useState(null); // { rows, totals }
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState(''); // transient confirmation (e.g. pairs removed)
  const [sel, setSel] = useState(() => new Set());
  const [labels, setLabels] = useState(null);
  // Supplier filter options: the live list (seeded + names staff typed while
  // receiving + anything already on a batch), not a hard-coded array — a supplier
  // added during intake was invisible here until the constant was edited by hand.
  // Falls back to the static SUPPLIERS constant if the fetch fails.
  const [supplierOptions, setSupplierOptions] = useState(SUPPLIERS);
  // Keep the active filter in the list even if it isn't in the fetched names (a
  // shared/refreshed URL, or a name that has since changed) — otherwise the select
  // would read "All" while the results are still filtered to that supplier.
  const supplierNames = useMemo(() => (
    supplier && !supplierOptions.includes(supplier) ? [...supplierOptions, supplier] : supplierOptions
  ), [supplierOptions, supplier]);
  const [lightbox, setLightbox] = useState(null);  // defect-issue photos viewer
  const [expanded, setExpanded] = useState(() => new Set()); // vins with the accordion open
  const [removing, setRemoving] = useState(null); // { title, sku, units } — remove-pairs modal
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
  const setRawVins = (on) => setPrefs((p) => { const n = { ...p, rawVins: !!on }; savePrefs(n); return n; });

  // "Move to shelf" (put-away) — place selected units on a scanned shelf, which
  // is the only way a unit becomes In Stock (invariant: in_stock ⟺ shelved).
  const [shelveFor, setShelveFor] = useState(null); // { title, units:[{vin,size,noBox}] } | null
  const [shelfCode, setShelfCode] = useState('');
  const [shelfInfo, setShelfInfo] = useState(null); // resolved location | { error } | null
  const [shelveBusy, setShelveBusy] = useState(false);
  const [shelveCam, setShelveCam] = useState(false);
  const [boxFound, setBoxFound] = useState(() => new Set()); // no-box VINs the user confirmed now have a box
  // A finalized (sold/shipped) unit can't be shelved/reactivated (anti double-sell,
  // mirrors TERMINAL_STATUSES on the server); exclude it from put-away.
  const isTerminal = (s) => s === 'sold' || s === 'shipped';
  const shelvable = (r) => !r.location_code && !isTerminal(r.status);
  const searchRef = useRef(null);
  const isMobile = useMediaQuery('(max-width: 768px)');

  // detail
  const [detail, setDetail] = useState(null); // { item, events }
  const [detailPhotos, setDetailPhotos] = useState(null); // SKU listing photos (view/delete)
  const [photoBusy, setPhotoBusy] = useState('');         // angle currently being deleted
  const [photoDl, setPhotoDl] = useState(false);          // download in flight
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
  useEffect(() => {
    let cancelled = false;
    api.suppliers()
      .then(({ suppliers }) => { if (!cancelled && suppliers?.length) setSupplierOptions(suppliers); })
      .catch(() => { /* keep the static fallback */ });
    return () => { cancelled = true; };
  }, []);
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
      if (shelveFor) { if (!shelveBusy) closeShelve(); return true; }
      if (bulkOpen) { setBulkOpen(false); return true; }
      if (showPrefs) { setShowPrefs(false); return true; }
      if (labels) { setLabels(null); return true; }
      if (showCam) { setShowCam(false); return true; }
      if (mode === 'detail') { backToList(); return true; }
      return false;
    };
    return () => { if (navBack) navBack.current = null; };
  }, [navBack, bulkOpen, showPrefs, labels, showCam, mode, shelveFor, shelveBusy]);

  // One box for everything: a scanned/typed VIN opens its detail; anything else
  // searches the whole inventory (dates cleared so search isn't limited to today).
  function submit() {
    const v = q.trim();
    if (!v) return;
    if (/^s[a-z]*-?\d/i.test(v)) { openDetail(v); setQ(''); return; } // looks like a VIN (SBM-…/SB-…)
    // Text search (incl. a shelf code → shelf contents): clear the date window so
    // it isn't limited to today, but keep the query visible so it can be refined.
    setFrom(''); setTo(''); load({ q: v, from: '', to: '' });
  }
  // Route a camera scan: a VIN opens its detail; a shelf barcode searches that
  // shelf's contents; anything else falls back to a text search.
  function routeScan(code) {
    const c = String(code).trim();
    if (isLocationCode(c)) { setShowCam(false); setQ(c); setFrom(''); setTo(''); load({ q: c, from: '', to: '' }); return; }
    openDetail(c);
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
    setMode('detail'); setDetail(null); setDetailPhotos(null); setError(''); setShowCam(false);
    setDetailStatusDraft(null); setCustomTag(''); setStatusNote(''); // reset staged status for the new item
    try { const d = await api.itemLookup(v); setDetail(d); loadDetailPhotos(d.item?.sku); }
    catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
  }
  // Listing photos for the open item's SKU (view + delete; warehouse/admin).
  async function loadDetailPhotos(sku) {
    setDetailPhotos(null);
    if (!sku) { setDetailPhotos([]); return; }
    try { const { photos } = await api.photoList(sku); setDetailPhotos(photos || []); }
    catch { setDetailPhotos([]); }
  }
  async function deleteDetailPhoto(sku, angle) {
    setPhotoBusy(angle); setError('');
    try { await api.photoRemove(sku, angle); await loadDetailPhotos(sku); }
    catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setPhotoBusy(''); }
  }
  async function downloadDetailPhotos(sku) {
    setPhotoDl(true); setError('');
    try {
      const { blob, filename } = await api.photoDownload(sku);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setPhotoDl(false); }
  }
  function backToList() { setMode('list'); setDetail(null); setError(''); load(); }

  // Report: status edits are staged in statusDrafts and only persisted on Save.
  const setStatusDraft = (vin, status) => setStatusDrafts((d) => ({ ...d, [vin]: status }));
  async function saveRowStatus(vin, current) {
    if (!canEditStock) return;
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
  // A removal deletes rows, so nothing local can be patched — reload from the server
  // and say what happened, including anything the server refused (sold/shipped).
  function onRemoved(res) {
    setRemoving(null);
    const gone = res?.deleted?.length || 0;
    const kept = res?.blocked?.length || 0;
    setNotice(`${gone} pair${gone === 1 ? '' : 's'} removed${kept ? ` — ${kept} refused (already sold/shipped)` : ''}.`);
    setSel(new Set());
    load();
  }

  // Report: bulk status change over the selected VINs.
  async function applyBulkStatus() {
    if (!canEditStock) return;
    setBulkBusy(true); setError('');
    // Picking "In Stock" for unshelved units isn't a status change — it's a
    // put-away. Route to the shelf scanner instead of a doomed bulk-status call.
    if (bulkStatusSel === 'in_stock') {
      const items = selectedItems.filter(shelvable);
      if (items.length) { setBulkBusy(false); setBulkOpen(false); openShelve(items, `${items.length} selected unit${items.length === 1 ? '' : 's'}`); return; }
    }
    try { await api.bulkStatus([...sel], bulkStatusSel); setBulkOpen(false); load(); }
    catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setBulkBusy(false); }
  }

  /* ----- Move to shelf (put-away) ----- */
  function openShelve(items, title) {
    if (!canEditStock) return;
    const units = items.map((r) => ({ vin: r.vin, size: r.size, noBox: r.status === 'no_box' || r.with_box === false }));
    if (!units.length) return;
    setShelveFor({ title, units });
    setShelfCode(''); setShelfInfo(null); setShelveCam(false); setBoxFound(new Set());
  }
  function closeShelve() {
    setShelveFor(null); setShelfCode(''); setShelfInfo(null); setShelveBusy(false); setShelveCam(false); setBoxFound(new Set());
  }
  const toggleBoxFound = (vin) => setBoxFound((s) => { const n = new Set(s); n.has(vin) ? n.delete(vin) : n.add(vin); return n; });
  // Resolve a scanned/typed shelf code so we can show its name before committing.
  async function lookupShelf(code) {
    const c = String(code || '').trim().toUpperCase();
    setShelfCode(c); setShelfInfo(null);
    if (!isLocationCode(c)) return;
    try { const { location } = await api.locationLookup(c); setShelfInfo(location); }
    catch (err) { if (err.unauthorized) return onSignOut(); setShelfInfo({ error: err.message || 'Unknown shelf.' }); }
  }
  function shelfScan(raw) {
    setShelveCam(false);
    const c = String(raw || '').trim().toUpperCase();
    if (isLocationCode(c)) lookupShelf(c);
    else setShelfInfo({ error: `“${c}” isn’t a shelf barcode.` });
  }
  async function doShelve() {
    if (!shelveFor) return;
    const code = shelfCode.trim().toUpperCase();
    if (!isLocationCode(code)) { setShelfInfo({ error: 'Scan or enter a valid shelf code.' }); return; }
    setShelveBusy(true); setError('');
    try {
      const res = await api.shelveItems(code, shelveFor.units.map((u) => ({ vin: u.vin, nowHasBox: u.noBox ? boxFound.has(u.vin) : true })));
      // A no-box unit whose box wasn't confirmed is refused (can't shelve a boxless
      // shoe). If ANYTHING landed we close; otherwise keep the modal open to explain.
      if (!res.updated) {
        setShelfInfo({ error: res.noBoxBlocked
          ? `A no-box shoe can’t go on a shelf. Tick “Box found now” for any that now have a box, or resolve them in the No Box queue first.`
          : 'Nothing was shelved — those units may have just been sold/shipped. Refresh and retry.' });
        return;
      }
      const skipped = shelveFor.units.length - res.updated;
      closeShelve(); setSel(new Set());
      if (res.noBoxBlocked > 0) setError(`Shelved ${res.updated} · ${res.noBoxBlocked} refused — still no box (resolve in the No Box queue).`);
      else if (skipped > 0) setError(`Shelved ${res.updated} — skipped ${skipped} (already sold/shipped).`);
      // Refresh so the moved units show their shelf + flip to In Stock.
      if (mode === 'detail' && detail?.item?.vin) await openDetail(detail.item.vin);
      else load();
    } catch (err) {
      if (err.unauthorized) return onSignOut();
      setShelfInfo({ error: err.message || 'Could not shelve these units.' });
    } finally { setShelveBusy(false); }
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
  const stageStatus = (s) => {
    // "In Stock" isn't a manual status — it means shelved. Route to put-away
    // (unless the unit is finalized, which can't be shelved/reactivated).
    if (s === 'in_stock' && detail?.item && !detail.item.location_id && !isTerminal(detail.item.status)) {
      openShelve([{ vin: detail.item.vin, size: detail.item.size }], detail.item.name); return;
    }
    setDetailStatusDraft(s); setCustomTag('');
  };
  const stageCustomTag = () => { const v = customTag.trim(); if (v) setDetailStatusDraft(v); };
  const clearStatusDraft = () => { setDetailStatusDraft(null); setCustomTag(''); };
  // Persist the staged status/tag — only runs when the user hits Save.
  async function saveItemStatus() {
    if (!canEditStock) return;
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
    if (!canEditStock) return;
    const text = note.trim();
    if (!text || !detail) return;
    setBusy(true); setError('');
    try { setDetail(await api.itemEvent(detail.item.vin, 'note', { text })); setNote(''); }
    catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setBusy(false); }
  }

  // Shared "Move to shelf" modal — used from the list (group/bulk) and the
  // item detail view, so it's rendered in both returns below.
  const shelveModal = shelveFor && (
    <div className="modal-overlay" onClick={() => !shelveBusy && closeShelve()}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">Move to shelf — {shelveFor.units.length} unit{shelveFor.units.length === 1 ? '' : 's'}</h3>
        {shelveFor.title && <p className="muted sm" style={{ marginTop: '-4px' }}>{shelveFor.title}</p>}
        <div className="searchrow mt">
          <input autoFocus placeholder="Scan or type shelf barcode (e.g. MNH-WH-A2-04)…" value={shelfCode}
            autoCapitalize="characters" disabled={shelveBusy}
            onChange={(e) => setShelfCode(e.target.value.toUpperCase())}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); lookupShelf(shelfCode); } }} />
          <button type="button" className={`btn ${shelveCam ? 'primary' : 'ghost'}`} onClick={() => setShelveCam((v) => !v)} title="Scan with camera"><Icon name="camera" /></button>
        </div>
        {shelveCam && (
          <Suspense fallback={<p className="muted">Loading camera…</p>}>
            <CameraScanner mode="vin" onDetected={shelfScan} onClose={() => setShelveCam(false)}
              zoom={prefs.cameraZoom} onZoomChange={setCameraZoom} />
          </Suspense>
        )}
        {shelfInfo && (shelfInfo.error
          ? <div className="error sm mt">{shelfInfo.error}</div>
          : <div className="shelve-resolved mt"><Icon name="pin" /> {shelfInfo.warehouse ? `${shelfInfo.warehouse} · ` : ''}{shelfInfo.label || shelfInfo.code}{shelfInfo.active === false ? ' — inactive' : ''}</div>)}
        {shelveFor.units.some((u) => u.noBox) && (
          <div className="shelve-nobox-note mt"><Icon name="nobox" /> Some of these were bought <b>without a box</b>. A no-box shoe can’t go on a shelf — tick <b>Box found now</b> for any that now have one, or resolve the rest in the No Box queue.</div>
        )}
        <div className="inv-units mt">
          <div className="inv-history-title">Placing these units</div>
          {shelveFor.units.map((u) => (
            <div className={`inv-unit-row ${u.noBox && !boxFound.has(u.vin) ? 'blocked' : ''}`} key={u.vin}>
              <span className="vin">{u.vin}</span>
              <span className="muted sm">{u.size ? `US ${u.size}` : '—'}</span>
              {u.noBox && (
                <label className="check-pill sm shelve-boxfound"><input type="checkbox" checked={boxFound.has(u.vin)} onChange={() => toggleBoxFound(u.vin)} /> Box found now</label>
              )}
            </div>
          ))}
        </div>
        <div className="modal-actions">
          <button className="btn ghost" onClick={closeShelve} disabled={shelveBusy}>Cancel</button>
          <button className="btn primary" onClick={doShelve} disabled={shelveBusy || !isLocationCode(shelfCode)}>
            {shelveBusy ? 'Shelving…' : `Shelve ${shelveFor.units.length} here`}
          </button>
        </div>
      </div>
    </div>
  );

  /* ----- detail view ----- */
  if (mode === 'detail') {
    const it = detail?.item;
    return (
      <div className="app">
        <TopBar title="Inventory" onHome={onHome} onSignOut={onSignOut}
          right={<button className="btn ghost sm" onClick={backToList}>← Back to list</button>} />
        {error && <div className="error mt">{error}</div>}
        {notice && <div className="notice mt">{notice}</div>}
        {!detail ? <p className="muted">Loading…</p> : (
          <>
            <div className="card result">
              <div className="result-grid">
                {it.image_url ? <img className="shoe-img" src={it.image_url} alt="" loading="lazy" /> : <div className="shoe-img placeholder">No image</div>}
                <div className="details">
                  <h2><CopyText text={it.name}>{it.name}</CopyText></h2>
                  <dl>
                    <div><dt>VIN</dt><dd><CopyText text={it.vin} className="vin">{it.vin}</CopyText></dd></div>
                    <div><dt>SKU</dt><dd><CopyText text={it.sku}>{it.sku || '—'}</CopyText></dd></div>
                    <div><dt>UPC</dt><dd><CopyText text={it.upc}>{it.upc || '—'}</CopyText></dd></div>
                    <div><dt>Size</dt><dd>{it.size || '—'}</dd></div>
                    <div><dt>Cost</dt><dd>${Number(it.cost || 0).toFixed(2)}</dd></div>
                    <div><dt>Status</dt><dd><StatusPill status={it.status} /></dd></div>
                    <div><dt>Location</dt><dd>{it.location_code
                      ? <span className="loc-chip" title={it.location_code}><Icon name="pin" /> {it.location_warehouse ? `${it.location_warehouse} · ` : ''}{it.location_label || it.location_code}</span>
                      : <span className="muted">Not shelved</span>}</dd></div>
                    <div><dt>Batch</dt><dd>{it.batch_code || '—'}</dd></div>
                    <div><dt>Intake</dt><dd>{it.kind === 'rescale' ? `Rescaled${it.origin ? ` (${it.origin})` : ''}`
                      : it.kind === 'instore' ? `In-store${it.origin ? ` (${it.origin})` : ''}`
                        : it.kind === 'existing' ? `Existing stock${it.origin ? ` (${it.origin})` : ''}` : 'Received'}</dd></div>
                    <div><dt>Supplier</dt><dd>{it.supplier_name || '—'}</dd></div>
                    <div><dt>Received</dt><dd>{(it.date_received || '').slice(0, 10) || '—'}</dd></div>
                    <div><dt>Price</dt><dd>{it.price != null ? `$${Number(it.price).toFixed(2)}` : '—'}</dd></div>
                    <div><dt>Listed</dt><dd><SyncBadges item={it} /></dd></div>
                  </dl>
                </div>
              </div>

              {canEditStock && (<>
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
              </>)}

              <div className="send"><button className="btn ghost wide" onClick={() => setLabels([{ vin: it.vin, sku: it.sku, size: it.size, name: it.name, upc: it.upc, colorway: it.colorway, gender: it.gender, withBox: it.with_box }])}><Icon name="print" /> Print this label</button></div>
            </div>

            <div className="card">
              <h3 className="rows-title">Listing photos{detailPhotos?.length ? <span className="muted"> ({detailPhotos.length})</span> : null}</h3>
              {detailPhotos == null ? <p className="muted">Loading…</p> : !detailPhotos.length ? <p className="muted">No listing photos for this SKU.</p> : (
                <>
                  <div className="photos-grid">
                    {detailPhotos.map((p) => (
                      <div className="photos-cell" key={p.angle}>
                        <a href={p.url} target="_blank" rel="noreferrer" title={`Open ${p.angle} full size`}><img src={p.url} alt={p.angle} loading="lazy" /></a>
                        <span className="photos-angle">{p.angle}</span>
                        <button type="button" className="photos-del" title="Delete this photo" disabled={photoBusy === p.angle} onClick={() => deleteDetailPhoto(it.sku, p.angle)}>{photoBusy === p.angle ? '…' : '×'}</button>
                      </div>
                    ))}
                  </div>
                  <div className="send"><button className="btn ghost wide" disabled={photoDl} onClick={() => downloadDetailPhotos(it.sku)}><Icon name="download" /> {photoDl ? 'Preparing…' : (detailPhotos.length === 1 ? 'Download photo' : `Download all (${detailPhotos.length}) as ZIP`)}</button></div>
                </>
              )}
            </div>

            <div className="card">
              <h3 className="rows-title">History</h3>
              <div className="timeline">
                {detail.events.map((e) => (
                  <div className="tl-item" key={e.id}>
                    <div className="tl-dot" />
                    <div className="tl-body">
                      <HistoryLine event={e} onViewPhotos={setLightbox} />
                      <div className="muted sm">{new Date(e.created_at).toLocaleString()}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
        {labels && <LabelSheet items={labels} onClose={() => setLabels(null)} />}
        {removing && <RemoveUnitsModal {...removing} onClose={() => setRemoving(null)} onDone={onRemoved} />}
        {shelveModal}
        <PhotoLightbox photos={lightbox} onClose={() => setLightbox(null)} />
        {showPrefs && <PreferencesModal prefs={prefs} onCameraZoom={setCameraZoom} onRawVins={setRawVins} onClose={() => setShowPrefs(false)} />}
      </div>
    );
  }

  /* ----- list view ----- */
  const rows = data?.rows || [];
  // Merge by SKU + status (sizes aggregated), same as the PH report.
  const groups = groupPhRows(rows);
  const groupItems = (g) => rows.filter((r) => g.vins.includes(r.vin));
  // Compact shelf summary for a merged row: one code, "N shelves", or null.
  const groupLoc = (g) => {
    const locs = [...new Set(groupItems(g).map((r) => r.location_code).filter(Boolean))];
    return locs.length === 0 ? null : locs.length === 1 ? locs[0] : `${locs.length} shelves`;
  };
  const toggle = (vin) => setSel((s) => { const n = new Set(s); n.has(vin) ? n.delete(vin) : n.add(vin); return n; });
  const toggleAll = () => setSel((s) => (s.size === rows.length ? new Set() : new Set(rows.map((r) => r.vin))));
  const groupChecked = (g) => g.vins.every((v) => sel.has(v));
  const toggleGroup = (g) => setSel((s) => { const n = new Set(s); const all = g.vins.every((v) => n.has(v)); g.vins.forEach((v) => (all ? n.delete(v) : n.add(v))); return n; });
  const selectedItems = rows.filter((r) => sel.has(r.vin));

  // Status change over a whole SKU group (all its VINs) via bulk-status.
  async function saveGroupStatus(g) {
    if (!canEditStock) return;
    const status = statusDrafts[g.key];
    if (!status || status === g.status) return;
    // In Stock requires a shelf — route unshelved units to put-away instead.
    if (status === 'in_stock') {
      const items = groupItems(g).filter(shelvable);
      if (items.length) {
        setStatusDrafts((d) => { const n = { ...d }; delete n[g.key]; return n; });
        openShelve(items, g.name); return;
      }
    }
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
  const invDetail = (g) => {
    const gItems = groupItems(g);
    const locs = [...new Set(gItems.map((r) => r.location_code).filter(Boolean))];
    const locLabel = locs.length === 0 ? null : locs.length === 1 ? locs[0] : `${locs.length} shelves`;
    const unshelved = gItems.filter(shelvable);
    return (
    <div className="inv-detail">
      <dl className="inv-metrics">
        <div><dt>Date received</dt><dd>{(g.date_received || '').slice(0, 10) || '—'}</dd></div>
        <div><dt>Location</dt><dd>{locLabel ? <span className="loc-chip" title={locs.join(', ')}><Icon name="pin" /> {locLabel}</span> : <span className="muted">Not shelved</span>}</dd></div>
        <div><dt>Cost</dt><dd>{g.cost != null ? `${g.costMixed ? '~' : ''}$${Number(g.cost).toFixed(2)}` : '—'}</dd></div>
        <div><dt>Supplier / Buyer</dt><dd>{g.supplier_name || '—'}{g.buyer_name ? ` / ${g.buyer_name}` : ''}</dd></div>
        <div><dt>Total units</dt><dd>{g.qty}</dd></div>
        <div className="inv-metrics-wide"><dt>Sizes</dt><dd><SizesQty sizes={g.sizes} /></dd></div>
        <div><dt>Price</dt><dd>{g.price != null ? `${g.priceMixed ? '~' : ''}$${Number(g.price).toFixed(2)}` : '—'}</dd></div>
        <div className="inv-metrics-wide"><dt>Listed / synced</dt><dd><SyncBadges item={g} /></dd></div>
      </dl>
      <div className="inv-actions">
        {canEditStock && (
          <>
            <label className="inv-status-edit">Status (all {g.qty})
              <select value={statusDrafts[g.key] ?? g.status} onChange={(e) => setStatusDraft(g.key, e.target.value)}>
                {STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
            </label>
            <button className="btn sm primary" disabled={(statusDrafts[g.key] ?? g.status) === g.status || savingStatusVin === g.key} onClick={() => saveGroupStatus(g)}>
              {savingStatusVin === g.key ? 'Saving…' : 'Save'}
            </button>
            {unshelved.length > 0 && (
              <button className="btn sm ghost" onClick={() => openShelve(unshelved, g.name)}>
                <Icon name="pin" /> Move to shelf ({unshelved.length})
              </button>
            )}
          </>
        )}
        <button className="btn sm ghost" onClick={() => setLabels(gItems)}><Icon name="print" /> Print labels ({g.qty})</button>
        <button className="btn sm ghost danger" title="Correct the count — deletes pairs and files them under Deleted"
          onClick={() => setRemoving({ title: g.name || g.sku || 'Unknown shoe', sku: g.sku, units: gItems })}>
          Remove pairs…
        </button>
      </div>
      <div className="inv-units">
        <div className="inv-history-title">Units</div>
        {gItems.map((r) => (
          <div className="inv-unit-row" key={r.vin}>
            <CopyText text={r.vin} className="vin">{r.vin}</CopyText>
            <span className="muted sm">{r.size ? `US ${r.size}` : '—'}</span>
            {/* UPC lives on the UNIT, not the SKU group — it's per size. */}
            {r.upc ? <CopyText text={r.upc} className="muted sm" title={`Copy UPC ${r.upc}`}>UPC {r.upc}</CopyText> : null}
            {r.location_code ? <span className="loc-chip sm" title={r.location_code}><Icon name="pin" /> {r.location_code}</span> : <span className="muted sm">unshelved</span>}
            {canEditStock && shelvable(r) && <button className="btn sm ghost" onClick={() => openShelve([r], r.name || g.name)} title="Place this unit on a shelf"><Icon name="pin" /> Shelve</button>}
            <button className="btn sm ghost" onClick={() => openDetail(r.vin)}>Details →</button>
          </div>
        ))}
      </div>
    </div>
    );
  };

  return (
    <div className="app">
      <TopBar title="Inventory" onHome={onHome} onSignOut={onSignOut}
        right={<button className="btn ghost sm" onClick={() => setShowPrefs(true)} title="Preferences"><Icon name="gear" /></button>} />

      <div className="card">
        {/* One box: scan a VIN (gun or camera) to open it, or type to search. */}
        <form className="searchrow" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <input ref={searchRef} placeholder="Scan a VIN or shelf — or search by keywords: name, SKU, UPC, shelf…" value={q}
            onChange={(e) => setQ(e.target.value)} autoCapitalize="characters" />
          <button className="btn primary" disabled={loading}>Go</button>
          <button type="button" className={`btn ${showCam ? 'primary' : 'ghost'}`} onClick={() => setShowCam((v) => !v)} title="Scan with camera"><Icon name="camera" /> {showCam ? 'Close camera' : 'Scan with camera'}</button>
        </form>
        {showCam && (
          <Suspense fallback={<p className="muted">Loading camera…</p>}>
            <CameraScanner mode="vin" onDetected={routeScan} onClose={() => setShowCam(false)}
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
              {supplierNames.map((s) => <option key={s} value={s}>{s}</option>)}
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
              <option value="instore">In-store</option>
              <option value="existing">Existing stock</option>
            </select>
          </label>
          <button className="btn primary" onClick={() => load()} disabled={loading}>{loading ? '…' : 'Apply filters'}</button>
        </div>
      </div>

      {error && <div className="error mt">{error}</div>}
      {notice && <div className="notice mt">{notice}</div>}

      {data && (
        <>
          <div className="batch-bar">
            <div className="batch-totals">
              <b>{data.totals.count}</b> items · <b>${data.totals.totalCost.toFixed(2)}</b>
              {Object.entries(data.totals.byStatus).map(([s, n]) => <span key={s} className="muted"> · {statusLabel(s)}: {n}</span>)}
            </div>
            <span className="report-actions">
              {canEditStock && <button className="btn sm ghost" disabled={!sel.size} onClick={() => setBulkOpen(true)}>Edit status{sel.size ? ` (${sel.size})` : ''}</button>}
              {canEditStock && (() => { const u = selectedItems.filter(shelvable); return (
                <button className="btn sm ghost" disabled={!u.length} title="Place selected units on a shelf (marks them In Stock)"
                  onClick={() => openShelve(u, `${u.length} selected unit${u.length === 1 ? '' : 's'}`)}>
                  <Icon name="pin" /> Move to shelf{u.length ? ` (${u.length})` : ''}
                </button>
              ); })()}
              <button className="btn sm primary" disabled={!sel.size} onClick={() => setLabels(selectedItems)}><Icon name="print" /> Print {sel.size || ''} label{sel.size === 1 ? '' : 's'}</button>
              <button className="btn sm ghost" disabled={!rows.length} onClick={() => downloadCSV(`inventory_${from || 'all'}_${to || ''}.csv`, toCSV(rows))}>Export CSV</button>
            </span>
          </div>
          <div className="card">
            {!rows.length ? (
              <p className="muted inv-empty">No items in this range.{' '}
                {periodMode !== 'month' && <button className="btn ghost sm" onClick={() => setPeriodMode('month')}>Try this month</button>}{' '}
                <button className="btn ghost sm" onClick={() => { setPeriodMode('custom'); setFrom(''); setTo(''); }}>Show all dates</button>
                {' '}— or search a VIN / SKU above.
              </p>
            ) : isMobile ? (
              <div className="dcards">
                <label className="dcard-selectall"><input type="checkbox" checked={sel.size === rows.length && rows.length > 0} onChange={toggleAll} /> Select all ({rows.length} units)</label>
                {groups.map((g) => {
                  const open = expanded.has(g.key);
                  return (
                    <div className={`dcard ${open ? 'open' : ''}`} key={g.key}>
                      <div className="dcard-top">
                        <label onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={groupChecked(g)} onChange={() => toggleGroup(g)} /> <ShoeThumb url={g.photo_url} size={34} /> <CopyText text={g.name} className="dcard-name">{g.name}</CopyText></label>
                        <button className="btn icon ghost sm" onClick={() => toggleRow(g.key)} aria-expanded={open}>{open ? '▾' : '▸'}</button>
                      </div>
                      {/* SKU sits OUTSIDE the expand button — click-to-copy can't be nested in one. */}
                      <div className="dcard-line"><CopyText text={g.sku} className="muted">{g.sku || '—'}</CopyText><span>×{g.qty}</span></div>
                      <button className="dcard-main" onClick={() => toggleRow(g.key)}>
                        <div className="dcard-line"><span className="muted sm"><SizesQty sizes={g.sizes} /></span></div>
                        <div className="inv-status"><StatusPill status={g.status} />{intakeChip(g)}{groupLoc(g) && <span className="loc-chip sm" title="Shelf location"><Icon name="pin" /> {groupLoc(g)}</span>}</div>
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
                          <td className="inv-name" title={g.name}><span className="inv-name-inner"><span className="inv-caret">{open ? '▾' : '▸'}</span><ShoeThumb url={g.photo_url} size={28} /><CopyText text={g.name} className="inv-name-text">{g.name}</CopyText></span></td>
                          <td className="inv-col-sku"><CopyText text={g.sku}>{g.sku || '—'}</CopyText></td>
                          <td className="ph-sizes"><SizesQty sizes={g.sizes} /></td>
                          <td className="inv-col-size"><b>×{g.qty}</b></td>
                          <td className="inv-col-status"><span className="inv-status"><StatusPill status={g.status} />{intakeChip(g)}{groupLoc(g) && <span className="loc-chip sm" title="Shelf location"><Icon name="pin" /> {groupLoc(g)}</span>}</span></td>
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
      {removing && <RemoveUnitsModal {...removing} onClose={() => setRemoving(null)} onDone={onRemoved} />}
      {shelveModal}
      {showPrefs && <PreferencesModal prefs={prefs} onCameraZoom={setCameraZoom} onRawVins={setRawVins} onClose={() => setShowPrefs(false)} />}
    </div>
  );
}
