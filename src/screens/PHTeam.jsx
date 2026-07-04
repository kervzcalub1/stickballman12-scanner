// PH Team workspace: the home chooser (New Inventory / Rescale / No Box /
// Request) and the editable PHGrid (per-size pricing + cross-store sync flags,
// edit locks, live refresh, history). PHGrid is also used read-only as the
// admin/warehouse Report.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAutoAnimate } from '@formkit/auto-animate/react';
import { autoAnimate } from '@formkit/auto-animate';
import { api } from '../api.js';
import { TopBar, CardBadges, StatusPill, SyncBadges, SizesQty, YesNo, PriceInput, HistoryModal, DateRangeBar, ShoeThumb } from '../components/common.jsx';
import { NavIcon, Icon } from '../components/NavIcons.jsx';
import { usePendingCounts, useUnsavedGuard, useMediaQuery } from '../hooks.js';
import { roleLabel, SYNC_BADGES } from '../lib/constants.js';
import { rangeOf, PH_DATE, PH_DATETIME } from '../lib/format.js';
import {
  frozenStyle, rightStyle, PH_FLAGS, calcFinalPrice, groupPhSized,
  phPathForPage, phPageForPath, HEARTBEAT_MS, PRESENCE_POLL_MS, IDLE_RELEASE_MS, LIST_POLL_MS,
} from '../lib/ph.js';
import { NoBoxReport } from './NoBoxReport.jsx';
import { RescaleRequestsReport } from './RescaleRequests.jsx';
import { PhEditedPhotos } from './PhEditedPhotos.jsx';

// PH Team home: pick which report to work — New Inventory (newly received stock)
// or Rescale Stock (units re-scanned for re-listing). Both do the same job: price
// + sync to Intelligent Inventory / Alias / StockX / Shopify. PH pages are
// URL-routed under /ph/* (their own namespace) so a refresh restores the page.
export function PHTeamApp({ user, onSignOut }) {
  // page <-> URL: null = home chooser | 'receiving' | 'rescale' | 'nobox' | 'request'
  const [page, setPage] = useState(() => phPageForPath(window.location.pathname));
  const counts = usePendingCounts();
  // Navigate + push the matching /ph/* URL; Back/Forward + refresh restore it.
  const goPage = (p) => {
    setPage(p);
    const path = phPathForPage(p);
    if (window.location.pathname !== path) window.history.pushState(null, '', path);
  };
  useEffect(() => {
    const onPop = () => setPage(phPageForPath(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  if (page === 'nobox') return <NoBoxReport user={user} onHome={() => goPage(null)} onSignOut={onSignOut} />;
  if (page === 'request') return <RescaleRequestsReport canCreate onHome={() => goPage(null)} onSignOut={onSignOut} />;
  if (page === 'photos') return <PhEditedPhotos onHome={() => goPage(null)} onSignOut={onSignOut} />;
  if (page) return <PHGrid user={user} kind={page} onHome={() => goPage(null)} onSignOut={onSignOut} />;
  return (
    <div className="app">
      <TopBar onSignOut={onSignOut} />
      <div className="home-greeting">Hi {user.name} <span className="role-badge">{roleLabel(user.role)}</span></div>
      <section className="home-section">
        <h2 className="home-section-title">Work</h2>
        <div className="home-grid">
          <button className="home-card" onClick={() => goPage('receiving')}>
            <span className="home-card-icon"><NavIcon name="receiving" /></span>
            <span className="home-card-title">New Inventory</span>
            <span className="home-card-sub">Price &amp; list newly received stock — Intelligent Inventory, Alias, StockX, Shopify</span>
            <CardBadges badges={counts ? SYNC_BADGES(counts) : []} />
          </button>
          <button className="home-card" onClick={() => goPage('rescale')}>
            <span className="home-card-icon"><NavIcon name="rescale" /></span>
            <span className="home-card-title">Rescale Stock</span>
            <span className="home-card-sub">Re-list rescanned units (returns, relistings, recounts, transfers) across the stores</span>
            <CardBadges badges={counts ? [['Restock', counts.restock_pending]] : []} />
          </button>
          <button className="home-card" onClick={() => goPage('photos')}>
            <span className="home-card-icon"><NavIcon name="instore-listing" /></span>
            <span className="home-card-title">Edited Photos</span>
            <span className="home-card-sub">Upload your edited listing images per SKU — used as the listing photos &amp; thumbnail</span>
          </button>
        </div>
      </section>
      <section className="home-section">
        <h2 className="home-section-title">Track</h2>
        <div className="home-grid">
          <button className="home-card" onClick={() => goPage('nobox')}>
            <span className="home-card-icon"><NavIcon name="nobox" /></span>
            <span className="home-card-title">No Box / Not Ready</span>
            <span className="home-card-sub">Units bought without a box — not yet postable (view-only; warehouse resolves)</span>
            <CardBadges badges={counts ? [['No box', counts.no_box]] : []} />
          </button>
          <button className="home-card" onClick={() => goPage('request')}>
            <span className="home-card-icon"><NavIcon name="rescalereq" /></span>
            <span className="home-card-title">Request Rescale</span>
            <span className="home-card-sub">Flag a SKU for the warehouse to recount / rescan (mismatch, quantity…)</span>
            <CardBadges badges={counts ? [['Pending audit', counts.rescale_requests], ['Audited', counts.rescale_requests_audited, 'ok']] : []} />
          </button>
        </div>
      </section>
    </div>
  );
}

// `kind`: 'receiving' (New Inventory) · 'rescale' (Rescale Stock) · null (all — the
// admin/warehouse "Listings & Sync" page).
export function PHGrid({ user, kind = null, onHome, onSignOut }) {
  const canEdit = user?.role === 'ph_team'; // admin + warehouse are read-only
  const showPricing = user?.role !== 'warehouse'; // GI + Final price hidden from warehouse
  const title = kind === 'rescale' ? 'Rescale Stock' : kind === 'receiving' ? 'New Inventory' : 'Listings & Sync';
  const emptyKind = kind === 'rescale' ? 'rescaled' : kind === 'receiving' ? 'received' : 'scanned';
  const isMobile = useMediaQuery('(max-width: 768px)'); // phones get cards, not the wide grid
  // Date range: Report (kind null/receiving) defaults to Month; Rescale to Day.
  const [dr, setDr] = useState(() => ({ mode: kind === 'rescale' ? 'day' : 'month', anchor: new Date() }));
  const [rows, setRows] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(() => new Set()); // group keys in edit mode
  const [drafts, setDrafts] = useState({});                // group key -> edited fields
  const [savingKey, setSavingKey] = useState(null);
  const [refreshing, setRefreshing] = useState(false); // re-fetching GI from Alias (all shown)
  const [giFillKey, setGiFillKey] = useState(null);    // group whose GI is being pulled into its draft
  const [sortDir, setSortDir] = useState('asc'); // by scan date: asc = oldest first
  const [expanded, setExpanded] = useState(() => new Set()); // group keys showing per-size detail
  const toggleExpand = (key) => setExpanded((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });
  const [historyFor, setHistoryFor] = useState(null); // { vins, title } — open History modal
  const [photosSku, setPhotosSku] = useState(null);   // SKU whose listing photos are shown
  useUnsavedGuard(editing.size > 0); // unsaved edits → guard Back/refresh

  // Subtle motion (auto-animate, respects reduced-motion): rows/cards ease in as
  // quietRefresh adds new ones, and the per-size drawer eases open/closed. Turned
  // off while a row is being edited/saved — nothing should visually shift under
  // an in-progress draft.
  const [tbodyAnimRef, setTbodyAnimEnabled] = useAutoAnimate({ duration: 180 });
  const [cardsAnimRef, setCardsAnimEnabled] = useAutoAnimate({ duration: 180 });
  useEffect(() => {
    const on = editing.size === 0 && savingKey == null;
    setTbodyAnimEnabled(on);
    setCardsAnimEnabled(on);
  }, [editing.size, savingKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // Per-size drawer (desktop + mobile) — a stable ref callback (not a hook) so it
  // can be attached inside a .map() without breaking the rules of hooks.
  const drawerAnimRef = useCallback((el) => { if (el) autoAnimate(el, { duration: 160 }); }, []);

  // Horizontal scroll-shadow on the wide desktop table (.ph-wrap): a subtle cue
  // that there are more columns off-screen. Overlaid via a sibling wrapper
  // (not the scrolling element itself) so it stays visible above the frozen
  // sticky columns' opaque backgrounds.
  const scrollWrapRef = useRef(null);
  const [scrollShadow, setScrollShadow] = useState({ left: false, right: false });
  const updateScrollShadow = () => {
    const el = scrollWrapRef.current; if (!el) return;
    const left = el.scrollLeft > 2;
    const right = el.scrollLeft < el.scrollWidth - el.clientWidth - 2;
    // Only update on an actual change — the effect below runs after EVERY render,
    // so setting a fresh {left,right} object unconditionally re-triggered it forever
    // ("Maximum update depth exceeded" + constant CPU burn). Same-value → same ref.
    setScrollShadow((s) => (s.left === left && s.right === right ? s : { left, right }));
  };
  useEffect(() => { updateScrollShadow(); }); // re-check after every render (rows/cols can change width)

  // ---- B2 edit locks / presence ----
  const [locks, setLocks] = useState({});    // vin -> { holder, holder_id } (active locks)
  const [notice, setNotice] = useState('');  // transient (idle release / lost lock)
  const holderIdRef = useRef(null);
  // Per-SESSION id (one per tab/device) — unique even across two sessions of the
  // SAME account, so each session locks/edits independently and can't override
  // another's row. Prefer a UUID; fall back to a random suffix.
  if (!holderIdRef.current) {
    const rand = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : Math.random().toString(36).slice(2, 12);
    holderIdRef.current = `${user?.username || 'ph'}-${rand}`;
  }
  const editVinsRef = useRef({});            // group key -> [vins] I currently hold
  const heartbeatRef = useRef(null);
  const idleRef = useRef(null);
  const heldVins = () => [...new Set(Object.values(editVinsRef.current).flat())];

  function stopTimers() {
    if (heartbeatRef.current) { clearInterval(heartbeatRef.current); heartbeatRef.current = null; }
    if (idleRef.current) { clearTimeout(idleRef.current); idleRef.current = null; }
  }
  function onIdle() {
    releaseAll();
    setEditing(new Set()); setDrafts({});
    setNotice('Your edit was released after 1 hour of inactivity. Click Edit again to continue.');
  }
  function resetIdle() {
    if (idleRef.current) clearTimeout(idleRef.current);
    idleRef.current = setTimeout(onIdle, IDLE_RELEASE_MS);
  }
  function releaseAll() {
    const v = heldVins();
    editVinsRef.current = {};
    if (v.length) api.lockRelease(v, holderIdRef.current).catch(() => {});
    stopTimers();
  }
  function closeEdit(key, { release = true } = {}) {
    const vins = editVinsRef.current[key];
    delete editVinsRef.current[key];
    if (release && vins?.length) api.lockRelease(vins, holderIdRef.current).catch(() => {});
    setEditing((s) => { const n = new Set(s); n.delete(key); return n; });
    setDrafts((d) => { const n = { ...d }; delete n[key]; return n; });
    if (!Object.keys(editVinsRef.current).length) stopTimers();
  }
  async function doHeartbeat() {
    const v = heldVins();
    if (!v.length) { stopTimers(); return; }
    try {
      const { held } = await api.lockHeartbeat(v, holderIdRef.current);
      const heldSet = new Set(held || []);
      for (const [key, vins] of Object.entries(editVinsRef.current)) {
        if (!vins.some((x) => heldSet.has(x))) { // lost the lock (expired & stolen)
          setNotice('A lock expired and was taken by another editor — your unsaved change on that row was discarded.');
          closeEdit(key, { release: false });
        }
      }
    } catch { /* transient network blip — TTL is generous */ }
  }
  async function refreshLocks() {
    try { const { locks: ls } = await api.lockList(); const m = {}; for (const l of ls) m[l.vin] = l; setLocks(m); }
    catch { /* ignore */ }
  }
  const myId = holderIdRef.current;
  const lockHolder = (g) => { for (const v of g.vins) { const l = locks[v]; if (l && l.holder_id !== myId) return l.holder; } return null; };

  async function load() {
    releaseAll();
    setLoading(true); setError(''); setNotice('');
    try {
      const [from, to] = rangeOf(dr.mode, dr.anchor);
      const { rows: r } = await api.phList(from, to, kind);
      setRows(r); setEditing(new Set()); setDrafts({}); setExpanded(new Set());
    } catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, [dr]); // eslint-disable-line react-hooks/exhaustive-deps
  // Poll presence so "being edited by X" stays current (editors only).
  useEffect(() => {
    if (!canEdit) return undefined;
    refreshLocks();
    const t = setInterval(refreshLocks, PRESENCE_POLL_MS);
    return () => clearInterval(t);
  }, [canEdit]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live list: quietly re-fetch so new shoes from the warehouse and other users'
  // saved edits appear without a manual reload. Skips while THIS session is
  // editing or saving (so an in-progress draft is never disturbed) and while a
  // fetch is already in flight; no spinner, and expanded rows stay open.
  const editingCountRef = useRef(0); editingCountRef.current = editing.size;
  const savingRef = useRef(false); savingRef.current = savingKey != null;
  const pollBusyRef = useRef(false);
  async function quietRefresh() {
    if (editingCountRef.current > 0 || savingRef.current || pollBusyRef.current) return;
    pollBusyRef.current = true;
    try {
      const [from, to] = rangeOf(dr.mode, dr.anchor);
      const { rows: r } = await api.phList(from, to, kind);
      // Re-check: the user may have started editing during the fetch.
      if (editingCountRef.current === 0 && !savingRef.current) setRows(r);
    } catch { /* transient — try again next tick */ }
    finally { pollBusyRef.current = false; }
  }
  useEffect(() => {
    const t = setInterval(quietRefresh, LIST_POLL_MS);
    return () => clearInterval(t);
  }, [dr, kind]); // eslint-disable-line react-hooks/exhaustive-deps
  // Release my locks when leaving the page.
  useEffect(() => () => { releaseAll(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Claim the lock first; only enter edit mode if no one else holds it.
  async function startEdit(g) {
    setError(''); setNotice('');
    // One row at a time per session — finish or cancel the current edit first.
    if (editing.size > 0 && !editing.has(g.key)) {
      setNotice('You can only edit one row at a time on this device — submit or cancel the current edit first.');
      return;
    }
    try {
      await api.lockClaim(g.vins, holderIdRef.current);
    } catch (err) {
      if (err.unauthorized) return onSignOut();
      if (err.conflict) {
        const who = err.data?.blockers?.[0]?.holder;
        setError(`${who || 'Another PH user'} is editing this right now — give them a moment, then try again.`);
        refreshLocks();
        return;
      }
      return setError(err.message);
    }
    editVinsRef.current[g.key] = g.vins;
    setEditing((s) => new Set(s).add(g.key));
    setExpanded((s) => new Set(s).add(g.key)); // editing reveals the per-size detail
    // Everything is per-size — GI, final price, II/AL/SX/SH, and Note (a size can
    // sync / be noted independently of the others).
    const sizes = {};
    for (const s of g.sizes) sizes[s.size] = {
      global_indicator: s.global_indicator ?? '', price: s.price ?? '',
      added_to_intel_inv: !!s.added_to_intel_inv, synced_alias: !!s.synced_alias,
      synced_stockx: !!s.synced_stockx, synced_shopify: !!s.synced_shopify,
      ph_note: s.note || '',
    };
    setDrafts((d) => ({ ...d, [g.key]: { sizes } }));
    if (!heartbeatRef.current) heartbeatRef.current = setInterval(doHeartbeat, HEARTBEAT_MS);
    resetIdle();
    refreshLocks();
  }
  // Update one field of one size's draft (preserving the size's other fields).
  const setSizeField = (key, size, patch) => {
    setDrafts((d) => ({ ...d, [key]: { ...d[key], sizes: { ...d[key].sizes, [size]: { ...d[key].sizes[size], ...patch } } } }));
    resetIdle();
  };
  // Per-size Global indicator drives that size's Final price (entered amount + 20%).
  const setSizeGI = (key, size, v) => setSizeField(key, size, { global_indicator: v, price: calcFinalPrice(v) });
  const setSizePrice = (key, size, v) => setSizeField(key, size, { price: v });
  const setSizeFlag = (key, size, flagKey, v) => setSizeField(key, size, { [flagKey]: v });
  const setSizeNote = (key, size, v) => setSizeField(key, size, { ph_note: v });
  // Save a group: every field is per-size now (GI, final price, II/AL/SX/SH, Note).
  // ONE atomic request covers every size — the server applies all sizes' updates
  // in a single transaction after ONE optimistic-concurrency check (see
  // phUpdateGroup in db.js), so a conflict on any size aborts the WHOLE group
  // instead of leaving it half-saved.
  async function submitGroup(g) {
    setSavingKey(g.key); setError('');
    const d = drafts[g.key] || {};
    try {
      const sizes = g.sizes.map((s) => {
        const sd = d.sizes?.[s.size] || {};
        return {
          vins: s.vins,
          fields: {
            global_indicator: sd.global_indicator, price: sd.price,
            added_to_intel_inv: sd.added_to_intel_inv, synced_alias: sd.synced_alias,
            synced_stockx: sd.synced_stockx, synced_shopify: sd.synced_shopify,
            ph_note: sd.ph_note,
          },
        };
      });
      const result = await api.phUpdateGroup(sizes, g.last_edit_at || null);
      const byVin = new Map((result.rows || []).map((u) => [u.vin, u]));
      setRows((rs) => rs.map((x) => byVin.get(x.vin) || x));
      closeEdit(g.key, { release: true });
      refreshLocks();
    } catch (err) {
      if (err.unauthorized) return onSignOut();
      if (err.conflict) { setError(err.message); closeEdit(g.key, { release: true }); load(); return; }
      setError(err.message);
    } finally { setSavingKey(null); }
  }
  // Rescale worklist: mark a group restocked → clears restock_pending so it drops
  // off this list and behaves as normal inventory.
  async function markRestockedGroup(g) {
    setSavingKey(g.key); setError('');
    try {
      await api.restockDone(g.vins);
      setRows((rs) => rs.filter((x) => !g.vins.includes(x.vin)));
    } catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setSavingKey(null); }
  }
  // Re-fetch the Global Indicator from Alias for every item currently shown and
  // recompute Final = GI + 20% (manual price overrides are preserved server-side),
  // then reload so the new prices show. PH Team + admin only (button hidden from
  // warehouse via showPricing).
  async function refreshPrices() {
    if (refreshing) return;
    if (editing.size > 0) { setNotice('Finish or cancel your current edit before refreshing prices.'); return; }
    const vins = [...new Set((rows || []).map((r) => r.vin).filter(Boolean))];
    if (!vins.length) { setNotice('Nothing to refresh in this view.'); return; }
    setRefreshing(true); setError(''); setNotice('');
    try {
      const res = await api.phRefreshGi(vins);
      if (res.configured === false) {
        setNotice('Alias pricing isn’t configured, so prices can’t be refreshed.');
      } else {
        setNotice(res.updated
          ? `Refreshed ${res.updated} price${res.updated === 1 ? '' : 's'} from Alias (checked ${res.checked}).`
          : `Prices are already up to date (checked ${res.checked}).`);
        await load();
      }
    } catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setRefreshing(false); }
  }

  // Per-group GI refresh (edit mode): pull the current Alias GI for THIS group's
  // sizes straight into the open draft (Final recomputes as GI + 20%). Beside the
  // Global-indicator column while editing — a focused alternative to the toolbar's
  // bulk "Refresh prices".
  async function fillGroupGi(g) {
    setGiFillKey(g.key); setError('');
    try {
      const { results, configured } = await api.phGiLookup(g.sku, g.sizes.map((s) => s.size));
      if (configured === false) { setError('Alias pricing isn’t configured, so GI can’t be fetched.'); return; }
      const bySize = new Map((results || []).map((x) => [String(x.size), x]));
      setDrafts((d) => {
        const cur = d[g.key]; if (!cur) return d;
        const sizes = { ...cur.sizes };
        for (const s of g.sizes) {
          const hit = bySize.get(String(s.size));
          if (hit) sizes[s.size] = { ...sizes[s.size], global_indicator: hit.global_indicator, price: calcFinalPrice(hit.global_indicator) };
        }
        return { ...d, [g.key]: { ...cur, sizes } };
      });
      if (!results?.length) setError('No Alias prices found for this SKU’s sizes.');
    } catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setGiFillKey(null); }
  }

  const isRescale = kind === 'rescale';

  // Consolidate per SKU+status (with per-size detail), then sort by scan date.
  const groups = groupPhSized(rows || []);
  groups.sort((a, b) => (sortDir === 'desc' ? (a.created_at < b.created_at ? 1 : -1) : (a.created_at < b.created_at ? -1 : 1)));
  const totalUnits = (rows || []).length;
  return (
    <div className="app app-wide">
      <TopBar title={title} onHome={onHome} onSignOut={onSignOut} />
      <div className="card">
        <DateRangeBar mode={dr.mode} anchor={dr.anchor} onChange={(mode, anchor) => setDr({ mode, anchor })}
          right={(
            <span className="muted sm">
              {isRescale ? 'pending restocks · ' : ''}{groups.length} line{groups.length === 1 ? '' : 's'} · {totalUnits} unit{totalUnits === 1 ? '' : 's'}{canEdit ? '' : ' · view only'}
              {!isRescale && <button className="btn ghost sm" type="button" style={{ marginLeft: 8 }} onClick={() => setSortDir((s) => (s === 'asc' ? 'desc' : 'asc'))}>Date {sortDir === 'asc' ? '↑' : '↓'}</button>}
              {showPricing && <button className="btn sm ph-gi-refresh-btn" type="button" style={{ marginLeft: 8 }} disabled={refreshing || loading} onClick={refreshPrices} title="Re-fetch Global Indicator from Alias and update Final price (GI + 20%)"><Icon name="refresh" className={refreshing ? 'spin' : ''} /> {refreshing ? 'Refreshing…' : 'Refresh prices'}</button>}
            </span>
          )} />
      </div>

      {error && <div className="error mt">{error}</div>}
      {notice && <div className="notice mt">{notice}</div>}

      <div className="card">
        {!rows ? <p className="muted">Loading…</p> : !groups.length ? <p className="muted">No {emptyKind} items in this range.</p> : isMobile ? (
          <div className="ph-cards" ref={cardsAnimRef}>
            {groups.map((g) => {
              const ed = editing.has(g.key);
              const d = drafts[g.key] || {};
              const open = ed || expanded.has(g.key);
              return (
                <div className={`ph-card ${ed ? 'editing' : ''}`} key={g.key}>
                  <div className="ph-card-top">
                    <span className="ph-qty-badge">×{g.qty}</span>
                    <span className="muted sm">{PH_DATE.format(new Date(g.created_at))} · {g._mixedBy ? 'multiple' : (g.created_by || '—')}</span>
                  </div>
                  <div className="ph-card-title">
                    <ShoeThumb url={g.photo_url} size={40} onOpen={g.photo_count > 0 ? () => setPhotosSku(g.sku) : null} />
                    <span>{g.name || '—'} <span className="muted">— {g.sku || '—'}</span></span>
                  </div>
                  <div className="ph-card-subline muted sm">
                    {g.gender ? <>{g.gender} · </> : ''}<StatusPill status={g.status} />
                    {g.priceChanged && <span className="ph-drift" title="Final price changed since it was listed — the store price is now stale">⚠ Price changed</span>}
                  </div>
                  <button type="button" className="ph-card-sizes ph-card-sizes-btn" onClick={() => toggleExpand(g.key)} aria-expanded={open}>
                    <span className="ph-caret">{open ? '▾' : '▸'}</span><SizesQty sizes={g.sizes} />
                  </button>
                  {open && (
                    <div className="ph-sizedetail" ref={drawerAnimRef}>
                      {g.sizes.map((s) => {
                        const sd = ed ? (d.sizes?.[s.size] || {}) : null;
                        return (
                          <div className="ph-sizedetail-row" key={s.size}>
                            <span className="ph-sizedetail-size">US {s.size} <span className="muted">×{s.qty}</span></span>
                            <span className="muted sm">Cost {s.cost != null ? `${s.costMixed ? '~' : ''}$${Number(s.cost).toFixed(2)}` : '—'}</span>
                            {showPricing && <span className="ph-card-price">GI {ed
                              ? <PriceInput value={sd.global_indicator} onChange={(e) => setSizeGI(g.key, s.size, e.target.value)} />
                              : <b>{s.global_indicator != null ? `${s.globalMixed ? '~' : ''}$${Number(s.global_indicator).toFixed(2)}` : '—'}</b>}</span>}
                            {showPricing && <span className="ph-card-price">Final {ed
                              ? <PriceInput value={sd.price} onChange={(e) => setSizePrice(g.key, s.size, e.target.value)} />
                              : <><b>{s.price != null ? `${s.priceMixed ? '~' : ''}$${Number(s.price).toFixed(2)}` : '—'}</b>{s.priceChanged && s.listed_price != null && <span className="ph-drift-was" title="Price it was listed at">was ${Number(s.listed_price).toFixed(2)}</span>}</>}</span>}
                            <span className="ph-sizedetail-flags">
                              {PH_FLAGS.map(([k, label]) => (
                                <span className="ph-sizedetail-flag" key={k}>
                                  <span className="muted sm">{label}</span>
                                  <YesNo value={ed ? sd[k] : s[k]} editing={ed} onChange={(v) => setSizeFlag(g.key, s.size, k, v)} />
                                </span>
                              ))}
                            </span>
                            <span className="ph-sizedetail-note">
                              <span className="muted sm">Note</span>
                              {ed
                                ? <textarea className="ph-note" rows={1} value={sd.ph_note} onChange={(e) => setSizeNote(g.key, s.size, e.target.value)} />
                                : <span className="ph-note-view" title={s.note || ''}>{s.note || '—'}</span>}
                            </span>
                            <span className="ph-sizedetail-hist">
                              <button type="button" className="btn sm ghost" onClick={() => setHistoryFor({ vins: s.vins, title: `${g.name || g.sku || ''} · US ${s.size}` })}>🕘 History</button>
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {/* Saved-state badges — while editing, the live draft checkboxes below are
                      the source of truth, so this is captioned "Last saved" instead of
                      "Listed / synced" to avoid reading as contradicting the open draft. */}
                  <div className="ph-card-synced"><span className="muted sm">{ed ? 'Last saved (all sizes)' : 'Listed / synced (all sizes)'}</span> <SyncBadges item={g} /></div>
                  <div className="ph-card-foot">
                    <span className="muted sm ph-card-credit">
                      {g.first_edit_by ? (
                        <>
                          Added by {g.first_edit_by}{g.first_edit_at ? ` · ${PH_DATETIME.format(new Date(g.first_edit_at))} EST` : ''}
                          {g._hasSubsequent && g.last_edit_by && (
                            <div>Last edited by: {g.last_edit_by}{g.last_edit_at ? ` · ${PH_DATETIME.format(new Date(g.last_edit_at))} EST` : ''}</div>
                          )}
                        </>
                      ) : '—'}
                    </span>
                    {canEdit && (() => {
                      const locked = !ed && lockHolder(g);
                      if (ed) return (
                        <span className="ph-edit-actions">
                          <button className="btn sm primary" disabled={savingKey === g.key} onClick={() => submitGroup(g)}>{savingKey === g.key ? '…' : 'Submit'}</button>
                          <button className="btn sm ghost" disabled={savingKey === g.key} onClick={() => closeEdit(g.key)}>Cancel</button>
                        </span>
                      );
                      if (locked) return <span className="presence-badge" title={`${locked} is editing this right now`}>{locked} editing…</span>;
                      return (
                        <span className="ph-edit-actions">
                          <button className="btn sm ghost" disabled={editing.size > 0} title={editing.size > 0 ? 'Finish your current edit first' : ''} onClick={() => startEdit(g)}>Edit</button>
                          {isRescale && <button className="btn sm primary" disabled={savingKey === g.key} onClick={() => markRestockedGroup(g)}>{savingKey === g.key ? '…' : '✓ Restocked'}</button>}
                        </span>
                      );
                    })()}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="ph-scrollbox">
            <div className={`ph-scroll-shadow left ${scrollShadow.left ? 'show' : ''}`} />
            <div className={`ph-scroll-shadow right ${scrollShadow.right ? 'show' : ''}`} />
            <div className="ph-wrap" ref={scrollWrapRef} onScroll={updateScrollShadow}>
            <table className="ph-table">
              <thead>
                <tr>
                  <th style={frozenStyle(0)} className="ph-frozen">Date</th>
                  <th style={frozenStyle(1)} className="ph-frozen">Shoe Title</th>
                  <th style={frozenStyle(2)} className="ph-frozen">SKU</th>
                  <th style={frozenStyle(3)} className="ph-frozen ph-frozen-last">Qty</th>
                  <th>Sizes (qty)</th><th>Gender</th><th>Status</th><th>Listed / synced</th><th>Scanned by</th>
                  <th style={rightStyle('action')} className="ph-rfrozen ph-rfrozen-first">Action</th>
                  <th style={rightStyle('addedby')}>Added by</th>
                </tr>
              </thead>
              <tbody ref={tbodyAnimRef}>
                {groups.map((g) => {
                  const ed = editing.has(g.key);
                  const d = drafts[g.key] || {};
                  const open = ed || expanded.has(g.key);
                  return (
                    <React.Fragment key={g.key}>
                      <tr className={`ph-trow ${ed ? 'ph-editing' : ''} ${open ? 'open' : ''}`} onClick={() => toggleExpand(g.key)}>
                        <td style={frozenStyle(0)} className="ph-frozen">{PH_DATE.format(new Date(g.created_at))}</td>
                        <td style={frozenStyle(1)} className="ph-frozen ph-title"><span className="ph-title-inner"><span className="ph-caret">{open ? '▾' : '▸'}</span><ShoeThumb url={g.photo_url} size={30} onOpen={g.photo_count > 0 ? () => setPhotosSku(g.sku) : null} /><span className="ph-title-name">{g.name || '—'}</span>{g.priceChanged && <span className="ph-drift" title="Final price changed since it was listed — the store price is now stale">⚠ Price changed</span>}</span></td>
                        <td style={frozenStyle(2)} className="ph-frozen">{g.sku || '—'}</td>
                        <td style={frozenStyle(3)} className="ph-frozen ph-frozen-last" title={g.vins.join(', ')}><b>×{g.qty}</b></td>
                        <td className="ph-sizes"><SizesQty sizes={g.sizes} /></td>
                        <td>{g.gender || '—'}</td>
                        <td><StatusPill status={g.status} /></td>
                        <td><SyncBadges item={g} /></td>
                        <td>{g._mixedBy ? <span className="muted">multiple</span> : (g.created_by || '—')}</td>
                        <td style={rightStyle('action')} className="ph-rfrozen ph-rfrozen-first" onClick={(e) => e.stopPropagation()}>
                          {!canEdit ? <span className="muted">—</span>
                            : ed
                              ? (<span className="ph-edit-actions">
                                  <button className="btn sm primary" disabled={savingKey === g.key} onClick={() => submitGroup(g)}>{savingKey === g.key ? '…' : 'Submit'}</button>
                                  <button className="btn sm ghost" disabled={savingKey === g.key} onClick={() => closeEdit(g.key)}>Cancel</button>
                                </span>)
                              : (lockHolder(g)
                                  ? <span className="presence-badge" title={`${lockHolder(g)} is editing this right now`}>{lockHolder(g)} editing…</span>
                                  : (<span className="ph-edit-actions">
                                      <button className="btn sm ghost" disabled={editing.size > 0} title={editing.size > 0 ? 'Finish your current edit first' : ''} onClick={() => startEdit(g)}>Edit</button>
                                      {isRescale && <button className="btn sm primary" disabled={savingKey === g.key} onClick={() => markRestockedGroup(g)}>{savingKey === g.key ? '…' : '✓ Restocked'}</button>}
                                    </span>))}
                        </td>
                        <td style={rightStyle('addedby')} className="ph-addedby">
                          {g.first_edit_by ? (
                            <>
                              {g.first_edit_by}
                              <div className="muted sm">{g.first_edit_at ? `${PH_DATETIME.format(new Date(g.first_edit_at))} EST` : ''}</div>
                              {g._hasSubsequent && g.last_edit_by && (
                                <div className="ph-lastedit muted sm">Last edited by: {g.last_edit_by}{g.last_edit_at ? ` · ${PH_DATETIME.format(new Date(g.last_edit_at))} EST` : ''}</div>
                              )}
                            </>
                          ) : '—'}
                        </td>
                      </tr>
                      {open && (
                        <tr className="ph-drow">
                          <td colSpan={11}>
                            <div className="ph-detail" ref={drawerAnimRef}>
                              <table className="ph-sizetable">
                                <thead><tr>
                                  <th>Size</th><th>Qty</th><th>Cost</th>
                                  {showPricing && <><th><span className="ph-gi-th">Global indicator{ed && <button type="button" className="btn icon ph-gi-refresh" title="Re-fetch GI from Alias for this shoe’s sizes" disabled={giFillKey === g.key} onClick={(e) => { e.stopPropagation(); fillGroupGi(g); }}><Icon name="refresh" size="1em" className={giFillKey === g.key ? 'spin' : ''} /></button>}</span></th><th>Final Price (GI+20%)</th></>}
                                  {PH_FLAGS.map(([k, label]) => <th key={k}>{label}</th>)}
                                  <th>Note</th><th>History</th>
                                </tr></thead>
                                <tbody>
                                  {g.sizes.map((s) => {
                                    const sd = ed ? (d.sizes?.[s.size] || {}) : null;
                                    return (
                                      <tr key={s.size}>
                                        <td>US {s.size}</td>
                                        <td>×{s.qty}</td>
                                        <td>{s.cost != null ? `${s.costMixed ? '~' : ''}$${Number(s.cost).toFixed(2)}` : '—'}</td>
                                        {showPricing && (
                                          <td>{ed
                                            ? <PriceInput value={sd.global_indicator} onChange={(e) => setSizeGI(g.key, s.size, e.target.value)} />
                                            : (s.global_indicator != null ? `${s.globalMixed ? '~' : ''}$${Number(s.global_indicator).toFixed(2)}` : '—')}</td>
                                        )}
                                        {showPricing && (
                                          <td>{ed
                                            ? <PriceInput value={sd.price} onChange={(e) => setSizePrice(g.key, s.size, e.target.value)} />
                                            : (s.price != null
                                              ? <>{s.priceMixed ? '~' : ''}${Number(s.price).toFixed(2)}{s.priceChanged && s.listed_price != null && <span className="ph-drift-was" title="Price it was listed at">was ${Number(s.listed_price).toFixed(2)}</span>}</>
                                              : '—')}</td>
                                        )}
                                        {PH_FLAGS.map(([k]) => (
                                          <td key={k}><YesNo value={ed ? sd[k] : s[k]} editing={ed} onChange={(v) => setSizeFlag(g.key, s.size, k, v)} /></td>
                                        ))}
                                        <td className="ph-note-cell">
                                          {ed
                                            ? <textarea className="ph-note" rows={1} value={sd.ph_note} onChange={(e) => setSizeNote(g.key, s.size, e.target.value)} />
                                            : <span className="ph-note-view" title={s.note || ''}>{s.note || '—'}</span>}
                                        </td>
                                        <td>
                                          <button type="button" className="btn sm ghost" title="View change history"
                                            onClick={() => setHistoryFor({ vins: s.vins, title: `${g.name || g.sku || ''} · US ${s.size}` })}>🕘 History</button>
                                        </td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
            </div>
          </div>
        )}
      </div>
      {historyFor && <HistoryModal vins={historyFor.vins} title={historyFor.title} onClose={() => setHistoryFor(null)} />}
      {photosSku && <PhotosModal sku={photosSku} onClose={() => setPhotosSku(null)} onSignOut={onSignOut} />}
    </div>
  );
}

// Listing-photos viewer for a SKU (all roles): shows every uploaded angle and
// downloads them — a single image, or a .zip when there's more than one.
function PhotosModal({ sku, onClose, onSignOut }) {
  const [photos, setPhotos] = useState(null);
  const [error, setError] = useState('');
  const [dl, setDl] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.photoList(sku)
      .then(({ photos: p }) => { if (!cancelled) setPhotos(p || []); })
      .catch((err) => { if (cancelled) return; if (err.unauthorized) return onSignOut(); setError(err.message); });
    return () => { cancelled = true; };
  }, [sku]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function download() {
    setDl(true); setError('');
    try {
      const { blob, filename } = await api.photoDownload(sku);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setDl(false); }
  }

  const count = photos?.length || 0;
  // Two sources can coexist per angle — show the PH edited set (what the listing
  // uses) first, then the warehouse originals. Grouped so it's clear which is which.
  const edited = (photos || []).filter((p) => p.source === 'ph_edited');
  const original = (photos || []).filter((p) => p.source !== 'ph_edited');
  const groups = [['PH edited · used for the listing', edited], ['Warehouse originals', original]].filter(([, arr]) => arr.length);
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal photos-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">Listing photos <span className="muted">— {sku}</span></h3>
        {error && <div className="error mt">{error}</div>}
        {photos == null ? <p className="muted">Loading…</p> : !count ? <p className="muted">No photos on file for this SKU.</p> : (
          groups.map(([label, arr]) => (
            <div className="photos-group" key={label}>
              <div className="photos-group-lbl">{label} <span className="muted">({arr.length})</span></div>
              <div className="photos-grid">
                {arr.map((p) => (
                  <a className="photos-cell" key={`${p.source}-${p.angle}`} href={p.url} target="_blank" rel="noreferrer" title={`Open ${p.angle} full size`}>
                    <img src={p.url} alt={p.angle} loading="lazy" />
                    <span className="photos-angle">{p.angle}</span>
                  </a>
                ))}
              </div>
            </div>
          ))
        )}
        <div className="modal-actions">
          {count > 0 && (
            <button className="btn primary" disabled={dl} onClick={download}>
              <Icon name="download" /> {dl ? 'Preparing…' : (count === 1 ? 'Download photo' : `Download all (${count}) as ZIP`)}
            </button>
          )}
          <button className="btn ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
