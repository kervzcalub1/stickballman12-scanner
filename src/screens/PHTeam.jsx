// PH Team workspace: the home chooser (New Inventory / Rescale / No Box /
// Request) and the editable PHGrid (per-size pricing + cross-store sync flags,
// edit locks, live refresh, history). PHGrid is also used read-only as the
// admin/warehouse Report.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAutoAnimate } from '@formkit/auto-animate/react';
import { autoAnimate } from '@formkit/auto-animate';
import { api } from '../api.js';
import { TopBar, CardBadges, StatusPill, SyncBadges, SizesQty, YesNo, PriceInput, BasisChip, HistoryModal, DateRangeBar, ShoeThumb, CopyText, Modal, RemoveUnitsModal } from '../components/common.jsx';
import { RescaleRequestModal } from '../components/RescaleRequestModal.jsx';
import { NavIcon, Icon } from '../components/NavIcons.jsx';
import { usePendingCounts, useUnsavedGuard, useMediaQuery } from '../hooks.js';
import { skuCodes } from '../lib/sku.js';
import { roleLabel, SYNC_BADGES, homeCardBadges } from '../lib/constants.js';
import { markupSuffix } from '../lib/config.js';
import { rangeOf, ymd, estCivil, estCivilFromYmd, PH_DATE, PH_DATETIME, fmtPrice } from '../lib/format.js';
import {
  frozenStyle, rightStyle, PH_FLAGS, calcFinalPrice, groupPhSized, PRICE_BASES,
  phListingStatus, PH_TABS, phTabOf, rescaleRequestFor, requiredFlags,
  phPathForPage, phPageForPath, HEARTBEAT_MS, PRESENCE_POLL_MS, IDLE_RELEASE_MS, LIST_POLL_MS,
  phSearchTokens, phRowMatches,
} from '../lib/ph.js';
import { clearQuery, useQueryParam } from '../lib/urlstate.js';
import { NoBoxReport } from './NoBoxReport.jsx';
import { ItemCosts } from './ItemCosts.jsx';
import { RescaleRequestsReport } from './RescaleRequests.jsx';
import { ImageFinder } from './ImageFinder.jsx';
import { PriceInquiry } from './PriceInquiry.jsx';
import { PayoutCalculator } from './PayoutCalculator.jsx';
import { CreatePO } from './CreatePO.jsx';
import { PoOverview } from './PoOverview.jsx';
import { Reconciliation } from './Reconciliation.jsx';
import { Sop } from './Sop.jsx';
import { DeletedItems } from './DeletedItems.jsx';
import { Inventory } from './Inventory.jsx';
import { BatchPage } from './BatchPage.jsx';

// PH Team home: pick which report to work — New Inventory (newly received stock)
// or Rescale Stock (units re-scanned for re-listing). Both do the same job: price
// + sync to Intelligent Inventory / Alias / StockX / Shopify. PH pages are
// URL-routed under /ph/* (their own namespace) so a refresh restores the page.
export function PHTeamApp({ user, onSignOut, onExit }) {
  // page <-> URL: null = home chooser | 'receiving' | 'rescale' | 'nobox' |
  //               'request' | 'photos' | 'inquiry'
  const [page, setPage] = useState(() => phPageForPath(window.location.pathname));
  const counts = usePendingCounts();
  // Navigate + push the matching /ph/* URL; Back/Forward + refresh restore it.
  const goPage = (p) => {
    setPage(p);
    const path = phPathForPage(p);
    // Leaving a page drops its query (?sku=…) — it means nothing on the next screen.
    if (window.location.pathname !== path) window.history.pushState(null, '', path);
    else clearQuery();
  };
  useEffect(() => {
    const onPop = () => setPage(phPageForPath(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  if (page === 'nobox') return <NoBoxReport user={user} onHome={() => goPage(null)} onSignOut={onSignOut} />;
  if (page === 'costs') return <ItemCosts onHome={() => goPage(null)} onSignOut={onSignOut} />;
  if (page === 'request') return <RescaleRequestsReport canCreate onHome={() => goPage(null)} onSignOut={onSignOut} />;
  if (page === 'imagefinder') return <ImageFinder onHome={() => goPage(null)} onSignOut={onSignOut} />;
  if (page === 'inquiry') return <PriceInquiry onHome={() => goPage(null)} onSignOut={onSignOut} />;
  if (page === 'payout') return <PayoutCalculator user={user} onHome={() => goPage(null)} onSignOut={onSignOut} />;
  if (page === 'po') return <CreatePO onHome={() => goPage(null)} onSignOut={onSignOut} />;
  if (page === 'postatus') return <PoOverview onHome={() => goPage(null)} onSignOut={onSignOut} />;
  // PH closes out the stragglers too — they're the ones chasing the supplier over a
  // shortage, so making them wait on warehouse just parked POs in the queue.
  if (page === 'reconcile') return <Reconciliation canReconcile onHome={() => goPage(null)} onSignOut={onSignOut} />;
  if (page === 'sop') return <Sop user={user} onHome={() => goPage(null)} onSignOut={onSignOut} />;
  if (page === 'deleted') return <DeletedItems onHome={() => goPage(null)} onSignOut={onSignOut} />;
  // The warehouse Inventory page, same component. `canEditStock={false}`: PH looks
  // stock up (and can still correct a miscount), but status changes and shelving are
  // warehouse work — and warehouse-only server-side, so the buttons would 403.
  if (page === 'inventory') return <Inventory canEditStock={false} onHome={() => goPage(null)} onSignOut={onSignOut} />;
  // The warehouse Batches page, same component, `readOnly`. PH prices what the warehouse
  // receives, so "which batch did this parcel become, and what was in it" is their
  // question too — but adding boxes, finishing and renumbering are warehouse work (and
  // warehouse-only server-side). The list and detail are filtered for PH_EXCLUDED_KINDS
  // on the server, not here.
  if (page === 'batches') return <BatchPage readOnly onHome={() => goPage(null)} onSignOut={onSignOut} />;
  if (page) return <PHGrid user={user} kind={page} onHome={() => goPage(null)} onSignOut={onSignOut} />;
  return (
    <div className="app">
      <TopBar onSignOut={onSignOut} onHome={onExit} />
      <div className="home-greeting">Hi {user.name} <span className="role-badge">{roleLabel(user.role)}</span></div>
      {/* Sections run daily work first, reference last: the two listing worklists,
          then the PO side, then the queues that block a listing, then the read-only
          lookups you dip into, then Help. A card is filed by what the person is doing
          when they reach for it — not by which screen it happens to open. */}
      <section className="home-section" data-accent="listing">
        <h2 className="home-section-title">Pricing &amp; Listing</h2>
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
          <button className="home-card" onClick={() => goPage('imagefinder')}>
            <span className="home-card-icon"><NavIcon name="image" /></span>
            <span className="home-card-title">Find Image Listings</span>
            <span className="home-card-sub">Manage a SKU’s listing photos — upload finished images, or build a branded set from the template (cut out, place, resize), then save</span>
          </button>
        </div>
      </section>
      <section className="home-section" data-accent="orders">
        <h2 className="home-section-title">Purchase Orders</h2>
        <div className="home-grid">
          <button className="home-card" onClick={() => goPage('po')}>
            <span className="home-card-icon"><NavIcon name="receiving" /></span>
            <span className="home-card-title">New Batch (Purchase Order)</span>
            <span className="home-card-sub">Open a supplier batch — labels + tracking numbers — for a supplier to scan out</span>
          </button>
          <button className="home-card" onClick={() => goPage('postatus')}>
            <span className="home-card-icon"><NavIcon name="shipped" /></span>
            <span className="home-card-title">Purchase Orders</span>
            <span className="home-card-sub">Every PO you opened — status &amp; live shipment tracking for each label</span>
          </button>
          <button className="home-card" onClick={() => goPage('reconcile')}>
            <span className="home-card-icon"><NavIcon name="reconcile" /></span>
            <span className="home-card-title">PO Reconciliation</span>
            <span className="home-card-sub">Received vs. supplier manifest — copy a discrepancy report to send the supplier</span>
            <CardBadges badges={counts ? homeCardBadges('reconcile', counts) : []} />
          </button>
        </div>
      </section>
      {/* The three queues that stand between a pair and a finished listing. All three
          carry a count, so they read as work waiting rather than as tools. */}
      <section className="home-section" data-accent="requests">
        <h2 className="home-section-title">Queues &amp; Requests</h2>
        <div className="home-grid">
          <button className="home-card" onClick={() => goPage('nobox')}>
            <span className="home-card-icon"><NavIcon name="nobox" /></span>
            <span className="home-card-title">No Box / Not Ready</span>
            <span className="home-card-sub">Units bought without a box — not yet postable (view-only; warehouse resolves)</span>
            <CardBadges badges={counts ? [['No box', counts.no_box]] : []} />
          </button>
          <button className="home-card" onClick={() => goPage('costs')}>
            <span className="home-card-icon"><NavIcon name="sold" /></span>
            <span className="home-card-title">Costs</span>
            <span className="home-card-sub">Fill in what a pair cost when the supplier left it off the manifest</span>
            <CardBadges badges={counts ? [['No cost', counts.missing_cost]] : []} />
          </button>
          <button className="home-card" onClick={() => goPage('request')}>
            <span className="home-card-icon"><NavIcon name="rescalereq" /></span>
            <span className="home-card-title">Request Rescale</span>
            <span className="home-card-sub">Flag a SKU for the warehouse to recount / rescan (mismatch, quantity…)</span>
            <CardBadges badges={counts ? [['Pending audit', counts.rescale_requests], ['Audited', counts.rescale_requests_audited, 'ok']] : []} />
          </button>
        </div>
      </section>
      {/* Answer-a-question screens: you arrive with a SKU, a VIN or a tracking number
          and leave with a number. Nothing here is a queue, so nothing here badges. */}
      <section className="home-section" data-accent="inventory">
        <h2 className="home-section-title">Look Up</h2>
        <div className="home-grid">
          <button className="home-card" onClick={() => goPage('inquiry')}>
            <span className="home-card-icon"><NavIcon name="report" /></span>
            <span className="home-card-title">Price Inquiry</span>
            <span className="home-card-sub">Look up live Alias prices for any SKU — lowest ask, highest offer, last sold &amp; Global Indicator</span>
          </button>
          <button className="home-card" onClick={() => goPage('payout')}>
            <span className="home-card-icon"><NavIcon name="payout" /></span>
            <span className="home-card-title">Payout Calculator</span>
            <span className="home-card-sub">Cost after discounts vs. what Alias/StockX pay out after fees — is this pair a buy?</span>
          </button>
          <button className="home-card" onClick={() => goPage('inventory')}>
            <span className="home-card-icon"><NavIcon name="inventory" /></span>
            <span className="home-card-title">Inventory</span>
            <span className="home-card-sub">Search every pair we hold — by name keywords, SKU, VIN or shelf — with its detail, history &amp; photos</span>
          </button>
          <button className="home-card" onClick={() => goPage('batches')}>
            <span className="home-card-icon"><NavIcon name="batches" /></span>
            <span className="home-card-title">Batches</span>
            <span className="home-card-sub">Find a shipment by the tracking number on any of its boxes — what arrived in it, box by box</span>
          </button>
          <button className="home-card" onClick={() => goPage('deleted')}>
            <span className="home-card-icon"><NavIcon name="deleted" /></span>
            <span className="home-card-title">Deleted</span>
            <span className="home-card-sub">Pairs removed from inventory — search by SKU, with the history kept</span>
          </button>
        </div>
      </section>
      {/* Last, and grey: the procedures are a reference you go to deliberately, not a
          queue — so they sit below the work rather than competing with it. */}
      <section className="home-section" data-accent="help">
        <h2 className="home-section-title">Help</h2>
        <div className="home-grid">
          <button className="home-card" onClick={() => goPage('sop')}>
            <span className="home-card-icon"><NavIcon name="sop" /></span>
            <span className="home-card-title">SOP &amp; Help</span>
            <span className="home-card-sub">Step-by-step procedures for every screen, searchable, plus FAQ</span>
          </button>
        </div>
      </section>
    </div>
  );
}

// `kind`: 'receiving' (New Inventory) · 'rescale' (Rescale Stock) · null (all — the
// admin/warehouse "Listings & Sync" page).
export function PHGrid({ user, kind = null, onHome, onSignOut }) {
  const canEdit = user?.role === 'ph_team' || user?.role === 'superadmin'; // admin + warehouse are read-only
  const showPricing = user?.role !== 'warehouse'; // GI + Final price hidden from warehouse
  const title = kind === 'rescale' ? 'Rescale Stock' : kind === 'receiving' ? 'New Inventory' : 'Listings & Sync';
  const emptyKind = kind === 'rescale' ? 'rescaled' : kind === 'receiving' ? 'received' : 'scanned';
  const isMobile = useMediaQuery('(max-width: 768px)'); // phones get cards, not the wide grid
  // Date range: Report (kind null/receiving) defaults to Month; Rescale to Day.
  // Date range in the URL (?dm=month&da=2026-07-21) — PH re-picks the same month on
  // every refresh otherwise. `dr.anchor` is a Date, so it round-trips as ymd and falls
  // back to today if the param is missing or unparseable.
  const [drMode, setDrMode] = useQueryParam('dm', kind === 'rescale' ? 'day' : 'month');
  const [drAnchor, setDrAnchor] = useQueryParam('da', '');
  const dr = useMemo(() => {
    // EST civil dates at both ends — see estCivilFromYmd. A local-midnight parse put a
    // Manila viewer's "today" on the previous EST day, and writing it back moved it again.
    const d = drAnchor ? estCivilFromYmd(drAnchor) : estCivil();
    return { mode: drMode, anchor: d };
  }, [drMode, drAnchor]);
  const setDr = (next) => {
    const v = typeof next === 'function' ? next(dr) : next;
    setDrMode(v.mode);
    const a = v.anchor instanceof Date ? v.anchor : new Date(v.anchor);
    setDrAnchor(Number.isNaN(a.getTime()) ? '' : ymd(estCivil(a)));
  };
  const [rows, setRows] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(() => new Set()); // group keys in edit mode
  const [drafts, setDrafts] = useState({});                // group key -> edited fields
  const [savingKey, setSavingKey] = useState(null);
  const [refreshing, setRefreshing] = useState(false); // re-fetching GI from Alias (all shown)
  const [giFillKey, setGiFillKey] = useState(null);    // group whose GI is being pulled into its draft
  const [sortDir, setSortDir] = useState('asc'); // by scan date: asc = oldest first
  // Search text rides in the URL alongside the date range and status tabs, so a
  // refresh (or a link handed to the person on the next shift) reopens the same view.
  const [q, setQ] = useQueryParam('q', '');
  const searchTokens = useMemo(() => phSearchTokens(q), [q]);
  // New Inventory: filter lines by derived listing status (Pending/In-Progress/Done);
  // multi-select, defaults to Pending (the unfinished worklist).
  const useStatusFilter = kind === 'receiving';
  // Multi-select, so it serialises as a comma list (?st=pending,in_progress). NOTE what
  // is deliberately NOT in the URL on this screen: `editing` and `drafts`. PH edit locks
  // are held server-side on a heartbeat, so restoring "editing" rows after a refresh
  // would open an edit UI for locks that have expired or been taken by someone else, and
  // the drafts would then fail their optimistic-concurrency check on save. Worse, a
  // shared link would carry someone else's pending writes.
  const [statusFilterRaw, setStatusFilterRaw] = useQueryParam('st', 'pending');
  const statusFilter = useMemo(
    () => new Set(statusFilterRaw ? statusFilterRaw.split(',').filter(Boolean) : []),
    [statusFilterRaw],
  );
  const toggleStatus = (k) => {
    const n = new Set(statusFilter);
    n.has(k) ? n.delete(k) : n.add(k);
    setStatusFilterRaw([...n].join(','));
  };
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
  // Rule 3 of groupPhSized: a row being edited stops absorbing new pairs. It only
  // asks whether a unit is locked — the LATE ARRIVAL is what moves, so the edited
  // row keeps the key `editing`/`drafts`/`expanded` are all stored under.
  const isLockedVin = useCallback((vin) => !!locks[vin], [locks]);

  // Pairs that arrived while this page has been open. The live poll folds a fresh
  // delivery straight into a matching untouched row, so a group action clicked
  // afterwards would otherwise silently reach pairs the user never saw arrive.
  // Seeded on the first load of a view (everything there is "already known") and
  // reset whenever the date range or page changes.
  const knownVinsRef = useRef(null);
  const newVinsRef = useRef(new Set());
  const noteArrivals = useCallback((list) => {
    const vins = (list || []).map((r) => r.vin);
    if (!knownVinsRef.current) { knownVinsRef.current = new Set(vins); return; }
    for (const v of vins) {
      if (!knownVinsRef.current.has(v)) { knownVinsRef.current.add(v); newVinsRef.current.add(v); }
    }
  }, []);

  async function load() {
    releaseAll();
    setLoading(true); setError(''); setNotice('');
    try {
      const [from, to] = rangeOf(dr.mode, dr.anchor);
      const { rows: r } = await api.phList(from, to, kind);
      knownVinsRef.current = null; newVinsRef.current = new Set(); noteArrivals(r);
      setRows(r); setEditing(new Set()); setDrafts({}); setExpanded(new Set());
      // Re-read the open rescale requests on an explicit reload, so the row chip
      // clears once the warehouse audits one. The 15s quiet poll deliberately does
      // NOT — it's a courtesy chip, not worth 500 rows every tick.
      loadOpenRequests();
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
      if (editingCountRef.current === 0 && !savingRef.current) { noteArrivals(r); setRows(r); }
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
    // Sold/shipped can't be edited (the server refuses too) — the row shows no Edit
    // button, so this only catches a click from a tab that hasn't refreshed yet.
    if (g.closed) { setNotice('This pair is already sold — there is nothing left to list.'); return; }
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
      global_indicator: s.global_indicator ?? '', price: s.price ?? '', gi_basis: s.gi_basis ?? null,
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
  // Per-size Global indicator drives that size's Final price. A hand-typed GI has no
  // Alias basis, so clear gi_basis (removes the "WY" chip on save).
  const setSizeGI = (key, size, v) => setSizeField(key, size, { global_indicator: v, price: calcFinalPrice(v), gi_basis: null });
  const setSizePrice = (key, size, v) => setSizeField(key, size, { price: v });
  // Intelligent Inventory is the master: a size pushed to II goes out to the stores
  // it feeds in the same pass, so ticking II ticks the stores that apply to this
  // shoe. A GOAT-only shoe never reaches this cascade — II is N/A there, and Alias
  // (its only required store) is ticked directly.
  // The store checkboxes remain individually editable — untick one before Submit if
  // that particular push didn't take. Unticking II deliberately cascades NOTHING:
  // dropping a listing is the case where the stores genuinely diverge, and clearing
  // three flags the user didn't ask to clear would destroy what they recorded.
  const setSizeFlag = (g, size, flagKey, v) => {
    const patch = { [flagKey]: v };
    if (flagKey === 'added_to_intel_inv' && v) for (const f of requiredFlags(g)) patch[f] = true;
    setSizeField(g.key, size, patch);
  };
  // Column "select all": apply one store flag to EVERY size of the row at once —
  // a 13-size shoe is 13 identical clicks otherwise, and PH lists a whole row to a
  // store in one pass. Deliberately routed through the SAME rules as a single cell
  // (ticking II still cascades to the flags this shoe actually requires), so the
  // header control and the cells can never diverge.
  const setAllSizesFlag = (g, flagKey, v) => {
    setDrafts((d) => {
      const cur = d[g.key];
      if (!cur) return d;                      // not in edit mode — nothing to patch
      const sizes = { ...cur.sizes };
      for (const s of g.sizes) {
        const patch = { [flagKey]: v };
        if (flagKey === 'added_to_intel_inv' && v) for (const f of requiredFlags(g)) patch[f] = true;
        sizes[s.size] = { ...sizes[s.size], ...patch };
      }
      return { ...d, [g.key]: { ...cur, sizes } };
    });
    resetIdle();
  };
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
            global_indicator: sd.global_indicator, price: sd.price, gi_basis: sd.gi_basis ?? null,
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
        // Spell out how many sizes fell below the consigned Global Indicator and to
        // which levels — a soft SKU is worth knowing about, not just a chip in a row.
        const parts = Object.entries(res.byBasis || {})
          .sort((a, b) => (PRICE_BASES[a[0]]?.rank || 99) - (PRICE_BASES[b[0]]?.rank || 99))
          .map(([k, n]) => `${n} ${PRICE_BASES[k]?.label || k}`);
        const fell = parts.length ? ` — ${parts.join(', ')}` : '';
        setNotice(res.updated
          ? `Refreshed ${res.updated} price${res.updated === 1 ? '' : 's'} from Alias (checked ${res.checked})${fell}.`
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
          if (hit) sizes[s.size] = { ...sizes[s.size], global_indicator: hit.global_indicator, price: calcFinalPrice(hit.global_indicator), gi_basis: hit.basis ?? null };
        }
        return { ...d, [g.key]: { ...cur, sizes } };
      });
      if (!results?.length) setError('No Alias prices found for this SKU’s sizes.');
    } catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setGiFillKey(null); }
  }

  // "GOAT only": list to Alias(GOAT) and nowhere else. Toggle it for the whole SKU group.
  async function setGoat(g, goatOnly) {
    setError('');
    try {
      await api.phSetGoat(g.vins, goatOnly);
      setRows((rs) => rs.map((x) => (g.vins.includes(x.vin) ? { ...x, goat_only: goatOnly } : x)));
    } catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
  }
  // The chip writes to every pair in the row, and an untouched row can have grown
  // since it was drawn (a second delivery of the same SKU merges into it). When it
  // has, say so and count them before applying — GOAT only takes a pair off II, StockX
  // and Shopify for good, and nothing downstream ever flags a wrongly-flagged pair.
  const [goatConfirm, setGoatConfirm] = useState(null); // { g, goatOnly, fresh: [vin] }
  const [removing, setRemoving] = useState(null);       // { title, sku, units } — remove-pairs modal
  // "Send for rescale": raise a rescale request off a New Inventory row (see
  // components/RescaleRequestModal.jsx). `openReqs` is a SKU -> open request map, used
  // both for the row chip and to warn before a second request for the same shelf.
  const [rescaleFor, setRescaleFor] = useState(null);   // the group whose modal is open
  const [openReqs, setOpenReqs] = useState({});         // CODE -> request (the chip)
  const [reqByVin, setReqByVin] = useState({});         // VIN  -> request (the Rescale tab)
  const canRescaleRequest = canEdit && kind === 'receiving';
  async function loadOpenRequests() {
    if (!canRescaleRequest) return;
    try {
      // Every open request, not just this page's date range — a request raised last
      // month is still open work against this SKU, and the chip has to say so.
      // open AND audited: open is "awaiting a count", audited is the work PH has to
      // finish. Both belong in the Rescale tab, and two round trips for one worklist is
      // a race waiting to happen.
      const { requests } = await api.rescaleRequestList('open,audited');
      // Keyed per CODE, not per sku string: a request raised against one code of a
      // dual-code shoe is still an open request against the row that carries both, and
      // an equality match would say they were unrelated (newest first from the server).
      const m = {};
      const v = {};
      for (const r of requests || []) {
        if (r.status === 'open') {
          for (const c of skuCodes(r.sku)) { const k = c.toUpperCase(); if (!m[k]) m[k] = r; }
        }
        // The pairs it was raised for. Only row-raised requests have these; one typed on
        // the standalone form names a SKU and no pairs, so it chips but moves nothing.
        for (const vin of r.vins || []) if (!v[vin]) v[vin] = r;
      }
      setOpenReqs(m);
      setReqByVin(v);
    } catch { /* the chip is a courtesy — a failed fetch must not break the grid */ }
  }
  useEffect(() => { loadOpenRequests(); }, [canRescaleRequest]); // eslint-disable-line react-hooks/exhaustive-deps
  function onRescaleSent(res) {
    setRescaleFor(null);
    setNotice(`Rescale requested for ${res.sku} — ${res.qty} pair${res.qty === 1 ? '' : 's'} reported. The warehouse will count the shelf and you'll see reported vs actual under Rescale Requests.`);
    loadOpenRequests();
  }
  // A row in the Rescale bucket: which request, and what it says. Two states, one tab —
  // "awaiting count" has nothing to do yet, "counted" IS the work.
  const [closingKey, setClosingKey] = useState(null);
  const rescaleReq = (g) => rescaleRequestFor(g, reqByVin);
  // "Guide mode": the row is under an AUDITED request, so the listing controls live on
  // the count above (the shelf's real sizes) and the per-size table below drops them
  // rather than showing a second, narrower set of the same fields against stale counts.
  const guideModeFor = (g) => canRescaleRequest && rescaleReq(g)?.status === 'audited';
  const daysSince = (d) => Math.max(0, Math.round((Date.now() - new Date(d).getTime()) / 86400000));
  // Reported / actual by size, against what we hold. Δ has THREE readings and the third
  // is the one this warehouse actually hits: MORE on the shelf than we track usually
  // means pre-system stock that was never counted in, not a record that is short.
  function auditRows(g, r) {
    const rep = new Map((r.sizes || []).map((s) => [String(s.size), Number(s.qty) || 0]));
    const act = new Map((r.actual_sizes || []).map((s) => [String(s.size), Number(s.qty) || 0]));
    const file = new Map((g.sizes || []).map((s) => [String(s.size), Number(s.qty) || 0]));
    const sizes = [...new Set([...file.keys(), ...rep.keys(), ...act.keys()])]
      .sort((a, b) => (parseFloat(a) || 0) - (parseFloat(b) || 0) || String(a).localeCompare(String(b)));
    return sizes.map((size) => {
      const onFile = file.get(size) ?? null;
      const reported = rep.get(size) ?? null;
      const actual = act.has(size) ? act.get(size) : null;
      const delta = actual == null || onFile == null ? null : actual - onFile;
      return { size, onFile, reported, actual, delta };
    });
  }
  // ── The rescale listing worksheet ────────────────────────────────────────────
  // After an audit, what PH has to list is the WAREHOUSE'S count, not our own — the
  // shelf held 9x4 / 9.5x5 / 10x3 while `items` knew about one pair of 9. So the
  // pricing and the store ticks belong on the audit table, where the real sizes are;
  // the per-size editor below keeps only what still describes the pairs we hold
  // (qty, note, history).
  //
  // Saving writes BOTH, which is the whole point:
  //   · the request's `listing` blob  — every size the warehouse counted, documented
  //     on the request and visible to both teams on Rescale Requests;
  //   · the real `items` rows         — for the sizes we actually hold, through the
  //     same phUpdateGroup every other row uses, so the flags land on stock and PH
  //     never ticks the same shoe twice.
  // A size the shelf has and we don't (9.5 and 10 above) can only be documented —
  // there is no items row to write to until the warehouse counts it in.
  const [sheets, setSheets] = useState({});      // group key -> { [size]: fields }
  const [sheetBusy, setSheetBusy] = useState(null);
  const [sheetGi, setSheetGi] = useState(null);
  function sheetFor(g, r) {
    const cur = sheets[g.key];
    if (cur) return cur;
    const saved = new Map((r.listing || []).map((x) => [String(x.size), x]));
    const held = new Map((g.sizes || []).map((s) => [String(s.size), s]));
    const seed = {};
    for (const row of auditRows(g, r)) {
      const sv = saved.get(row.size);
      const h = held.get(row.size);
      seed[row.size] = {
        global_indicator: sv?.global_indicator ?? h?.global_indicator ?? '',
        price: sv?.price ?? h?.price ?? '',
        gi_basis: sv?.gi_basis ?? h?.gi_basis ?? null,
        added_to_intel_inv: !!(sv?.added_to_intel_inv ?? h?.added_to_intel_inv),
        synced_alias: !!(sv?.synced_alias ?? h?.synced_alias),
        synced_stockx: !!(sv?.synced_stockx ?? h?.synced_stockx),
        synced_shopify: !!(sv?.synced_shopify ?? h?.synced_shopify),
      };
    }
    return seed;
  }
  const setSheetField = (g, r, size, patch) => setSheets((m) => {
    const cur = m[g.key] || sheetFor(g, r);
    return { ...m, [g.key]: { ...cur, [size]: { ...cur[size], ...patch } } };
  });
  // Same rule as the main grid: II is the master, so ticking it ticks the stores this
  // shoe actually goes to. Turning it OFF cascades nothing — a delist is exactly where
  // the stores diverge.
  const setSheetFlag = (g, r, size, key, on) => {
    const patch = { [key]: on };
    if (key === 'added_to_intel_inv' && on) for (const f of requiredFlags(g)) patch[f] = true;
    setSheetField(g, r, size, patch);
  };
  const setSheetGiValue = (g, r, size, v) =>
    setSheetField(g, r, size, { global_indicator: v, price: calcFinalPrice(v), gi_basis: null });
  // `/api/ph/gi-lookup` answers { configured, results:[{ size, global_indicator, price,
  // basis }] } — an ARRAY, and it returns the server-side Final price too, so don't
  // recompute it here (the server rounds through the configured markup). Same shape the
  // Rescale Requests page consumes; the two must not drift.
  async function fillSheetGi(g, r) {
    setSheetGi(g.key); setError(''); setNotice('');
    try {
      const sizes = auditRows(g, r).map((x) => x.size);
      const { results, configured } = await api.phGiLookup(g.sku, sizes);
      if (configured === false) { setError('Alias pricing isn’t configured, so GI can’t be fetched.'); return; }
      const bySize = new Map((results || []).map((x) => [String(x.size), x]));
      const cur = sheets[g.key] || sheetFor(g, r);
      const next = { ...cur };
      let filled = 0;
      for (const size of sizes) {
        const p = bySize.get(String(size));
        if (!p || p.global_indicator == null) continue;
        next[size] = {
          ...next[size],
          global_indicator: p.global_indicator,
          price: p.price ?? calcFinalPrice(p.global_indicator),
          gi_basis: p.basis ?? null,
        };
        filled += 1;
      }
      setSheets((m) => ({ ...m, [g.key]: next }));
      // Say which sizes Alias had nothing for, rather than leaving blank boxes that
      // look like the button did nothing.
      if (!filled) setError(`No Alias prices found for ${g.sku} in ${sizes.join(', ')}.`);
      else if (filled < sizes.length) setNotice(`Filled ${filled} of ${sizes.length} sizes — Alias had no price for the rest.`);
    } catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setSheetGi(null); }
  }
  async function saveSheet(g, r) {
    setSheetBusy(g.key); setError('');
    const sheet = sheets[g.key] || sheetFor(g, r);
    const rowsOut = auditRows(g, r).map((x) => ({
      size: x.size, qty: x.actual ?? x.reported ?? x.onFile ?? 0, ...sheet[x.size],
    }));
    try {
      // 1) Document every counted size on the request itself.
      await api.rescaleRequestListUpdate(r.id, rowsOut, r.listed_at ?? null);
      // 2) And write the real thing for the sizes we actually hold.
      const held = (g.sizes || []).filter((s) => sheet[String(s.size)]);
      if (held.length) {
        const payload = held.map((s) => {
          const f = sheet[String(s.size)];
          return {
            vins: s.vins,
            fields: {
              global_indicator: f.global_indicator, price: f.price, gi_basis: f.gi_basis ?? null,
              added_to_intel_inv: f.added_to_intel_inv, synced_alias: f.synced_alias,
              synced_stockx: f.synced_stockx, synced_shopify: f.synced_shopify,
              ph_note: s.ph_note ?? null,
            },
          };
        });
        const result = await api.phUpdateGroup(payload, g.last_edit_at || null);
        const byVin = new Map((result.rows || []).map((u) => [u.vin, u]));
        setRows((rs) => rs.map((x) => byVin.get(x.vin) || x));
      }
      const extra = rowsOut.length - held.length;
      setNotice(`Listing saved for ${g.sku}${extra > 0 ? ` — ${extra} size${extra === 1 ? '' : 's'} recorded on the request only (no stock on file yet)` : ''}.`);
      loadOpenRequests();
    } catch (err) {
      if (err.unauthorized) return onSignOut();
      if (err.conflict) { setError(err.message); load(); return; }
      setError(err.message);
    } finally { setSheetBusy(null); }
  }

  async function closeRescale(g, r) {
    setClosingKey(g.key); setError('');
    try {
      await api.rescaleRequestClose(r.id);
      setNotice(`Rescale request for ${r.sku} closed — the row goes back to the normal worklist.`);
      loadOpenRequests();
    } catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setClosingKey(null); }
  }
  // The chip in the Rescale column. Deliberately says how long it has been waiting: the
  // page defaults to Pending, so a request nobody ever audits parks its pairs in a tab
  // nobody has selected, and "asked 9 days ago" is the only thing on screen that says so.
  const rescaleStateChip = (g) => {
    const r = rescaleReq(g);
    if (!r) return null;
    if (r.status === 'open') {
      const d = daysSince(r.created_at);
      return (
        <span className="ph-rescale-chip wait" title={`${r.requested_by || 'Someone'} asked the warehouse to count this shelf. Nothing to do here until they have.`}>
          ⟳ Awaiting count{d > 0 ? ` · ${d}d` : ''}
        </span>
      );
    }
    const rows = auditRows(g, r);
    const short = rows.reduce((n, x) => n + (x.delta != null && x.delta < 0 ? -x.delta : 0), 0);
    const over = rows.reduce((n, x) => n + (x.delta != null && x.delta > 0 ? x.delta : 0), 0);
    return (
      <>
        <span className="ph-rescale-chip ready" title={`Counted by ${r.resolved_by || 'the warehouse'}. Finish listing, then mark the rescale done.`}>✓ Counted</span>
        {short > 0 && <span className="ph-rescale-chip short" title="We hold more on file than the shelf holds">{short} short</span>}
        {over > 0 && <span className="ph-rescale-chip over" title="The shelf holds more than we track — often stock that predates this system">{over} extra</span>}
      </>
    );
  };

  // The row's "already asked" chip. Also the button's own guard-rail: it opens the
  // modal, which repeats the warning with who asked and when.
  const rescaleChip = (g) => {
    const r = g.sku ? (skuCodes(g.sku).map((c) => openReqs[c.toUpperCase()]).find(Boolean) || null) : null;
    if (!r) return null;
    return (
      <span className="ph-rescale-chip" title={`${r.requested_by || 'Someone'} asked the warehouse to recount this SKU${r.created_at ? ` on ${PH_DATETIME.format(new Date(r.created_at))} EST` : ''}. It's still open.`}>
        ⟳ Rescale requested
      </span>
    );
  };
  // A removal deletes rows, so there's nothing local to patch — reload and report,
  // including whatever the server refused (sold/shipped can't be removed).
  function onRemoved(res) {
    setRemoving(null);
    const gone = res?.deleted?.length || 0;
    const kept = res?.blocked?.length || 0;
    setNotice(`${gone} pair${gone === 1 ? '' : 's'} removed${kept ? ` — ${kept} refused (already sold/shipped)` : ''}.`);
    load();
  }
  // The raw units behind a group, which carry the scan time the removal order needs.
  const unitsOf = (g) => {
    const want = new Set(g.vins);
    return (rows || []).filter((r) => want.has(r.vin));
  };
  function askGoat(g, goatOnly) {
    const fresh = g.vins.filter((v) => newVinsRef.current.has(v));
    if (fresh.length && fresh.length < g.vins.length) setGoatConfirm({ g, goatOnly, fresh });
    else setGoat(g, goatOnly);
  }
  const goatChip = (g) => {
    if (!canEdit || g.closed) return g.goat_only ? <span className="goat-badge">GOAT only</span> : null;
    return (
      <button type="button" className={`goat-chip ${g.goat_only ? 'on' : ''}`} disabled={editing.has(g.key)}
        title="GOAT only — PH lists to Alias (GOAT) only; II/StockX/Shopify are N/A"
        onClick={(e) => { e.stopPropagation(); askGoat(g, !g.goat_only); }}>
        {g.goat_only ? '✓ GOAT only' : 'GOAT only'}
      </button>
    );
  };
  const goatConfirmModal = goatConfirm ? (
    <Modal
      type="warn"
      title={goatConfirm.goatOnly ? 'Turn GOAT only on for the whole row?' : 'Turn GOAT only off for the whole row?'}
      message={`This row now holds ${goatConfirm.g.qty} pair${goatConfirm.g.qty === 1 ? '' : 's'} of ${goatConfirm.g.sku || 'this SKU'} — ${goatConfirm.fresh.length} of them arrived from the warehouse while you had this page open. ${goatConfirm.goatOnly ? 'GOAT only means Alias and nowhere else — it takes every one of them off Intelligent Inventory, StockX and Shopify.' : 'This puts every one of them back on Intelligent Inventory, StockX and Shopify.'}`}
      onClose={() => setGoatConfirm(null)}
    >
      <button className="btn ghost" onClick={() => setGoatConfirm(null)}>Cancel</button>
      <button
        className="btn primary"
        onClick={() => { const c = goatConfirm; setGoatConfirm(null); setGoat(c.g, c.goatOnly); }}
      >
        Apply to all {goatConfirm.g.qty}
      </button>
    </Modal>
  ) : null;
  // A pending row deliberately merges every scan day of that SKU, so PH reads one
  // honest "this many still to list" instead of the same SKU pending twice. That
  // makes a single date on the row a half-truth, so it gets a "+Nd" marker naming
  // the other days. Touched rows never span days, so this only ever shows on pending.
  const dateCell = (g) => {
    const first = PH_DATE.format(new Date(g.created_at));
    if (!g.days || g.days.length < 2) return first;
    const all = g.days.map((d) => PH_DATE.format(new Date(`${d}T12:00:00Z`))).join(', ');
    return (
      <>{first}<span className="ph-daycount" title={`Scanned over ${g.days.length} days (${all}) — pairs of this SKU that nobody has started share one row, so the count is the real number still to list`}>+{g.days.length - 1}d</span></>
    );
  };
  // Rows are split by listing state, so the same SKU can legitimately appear more
  // than once — already-listed pairs never merge with pairs that still need work.
  // Only the split rows get the chip: on a SKU that appears once it would be noise,
  // and unexplained twins are exactly what would read as a duplicate-scan bug.
  const SPLIT_CHIP = {
    done: ['✓ Listed', 'These pairs are already live — kept separate so a later scan can’t make them read as unlisted'],
    in_progress: ['◐ Part-listed', 'These pairs are on some stores but not all — separate from the finished and the untouched ones'],
    pending: ['• Not listed', 'These pairs still need listing — separate from the ones already done'],
  };
  const splitChip = (g) => {
    if (!g.splitSku) return null;
    const c = SPLIT_CHIP[phListingStatus(g)];
    if (!c) return null;
    return <span className={`ph-split-chip ${phListingStatus(g)}`} title={c[1]}>{c[0]}</span>;
  };
  // On a GOAT-only group every store but Alias is N/A — it lists to Alias only.
  const flagNA = (g, k) => g.goat_only && k !== 'synced_alias';
  // Sold (or shipped) = read-only for PH. The pair has left the building, so there is
  // nothing to list and nothing to correct — "sold is as good as done" (PH_CLOSED_STATUSES
  // in lib/ph.js also files the row under Done, out of the Pending/In-Progress tabs).
  const closedNote = (g) => (
    <span className="muted sm" title="This pair is already sold — there is nothing left for the PH team to list.">
      {g.status === 'shipped' ? 'Shipped — nothing to list' : 'Sold — nothing to list'}
    </span>
  );
  // The per-column "All" tick, shown in the size table's header while the row is in
  // edit mode. Checked only when EVERY size already carries the flag, so it doubles
  // as a read-out of the column; unticking it clears the column the same way.
  const flagAll = (g, d, k, label) => {
    const sizes = g.sizes || [];
    const on = sizes.length > 0 && sizes.every((sz) => d?.sizes?.[sz.size]?.[k]);
    return (
      <label className="ph-flag-all" title={`${on ? 'Untick' : 'Tick'} ${label} for all ${sizes.length} size${sizes.length === 1 ? '' : 's'}`}>
        <input type="checkbox" checked={on} onChange={(e) => setAllSizesFlag(g, k, e.target.checked)} />
        <span>All</span>
      </label>
    );
  };

  const isRescale = kind === 'rescale';
  // Click-to-copy the shoe name / SKU on the PH work pages (New Inventory +
  // Rescale) only — not the admin/warehouse "Listings & Sync" (kind=null).
  const canCopy = kind === 'receiving' || kind === 'rescale';
  const copyable = (text, node, cls) => (canCopy
    ? <CopyText text={text} className={cls}>{node}</CopyText>
    : (cls ? <span className={cls}>{node}</span> : node));

  // Consolidate per SKU+status (with per-size detail), then sort by scan date.
  const allGroups = groupPhSized(rows || [], isLockedVin);
  allGroups.sort((a, b) => (sortDir === 'desc' ? (a.created_at < b.created_at ? 1 : -1) : (a.created_at < b.created_at ? -1 : 1)));
  // New Inventory only: narrow to the selected listing-status buckets.
  // Rescale outranks the listing state (see phTabOf). Counts come off the SAME
  // function the filter uses, so a tab can never claim rows it wouldn't show — and the
  // page defaults to Pending, so without the counts these rows would simply vanish
  // with nothing on screen saying where they went.
  const tabOf = (g) => phTabOf(g, reqByVin);
  const statusGroups = useStatusFilter ? allGroups.filter((g) => statusFilter.has(tabOf(g))) : allGroups;
  const tabCounts = useStatusFilter
    ? allGroups.reduce((acc, g) => { const k = tabOf(g); acc[k] = (acc[k] || 0) + 1; return acc; }, {})
    : {};
  // A row being EDITED always stays on screen, whatever is typed — hiding it would
  // strand an unsaved draft behind a filter and leave its server-side edit lock held
  // by a row nobody can see.
  const groups = statusGroups.filter((g) => editing.has(g.key) || phRowMatches(g, searchTokens));
  const hiddenBySearch = statusGroups.length - groups.length;
  const totalUnits = groups.reduce((n, g) => n + g.qty, 0);
  return (
    <div className="app app-wide">
      <TopBar title={title} onHome={onHome} onSignOut={onSignOut} />
      <div className="card">
        <DateRangeBar mode={dr.mode} anchor={dr.anchor} onChange={(mode, anchor) => setDr({ mode, anchor })}
          right={(
            <span className="muted sm">
              {isRescale ? 'pending restocks · ' : ''}{groups.length} line{groups.length === 1 ? '' : 's'} · {totalUnits} unit{totalUnits === 1 ? '' : 's'}{canEdit ? '' : ' · view only'}
              {!isRescale && <button className="btn ghost sm" type="button" style={{ marginLeft: 8 }} onClick={() => setSortDir((s) => (s === 'asc' ? 'desc' : 'asc'))}>Date {sortDir === 'asc' ? '↑' : '↓'}</button>}
              {showPricing && <button className="btn sm ph-gi-refresh-btn" type="button" style={{ marginLeft: 8 }} disabled={refreshing || loading} onClick={refreshPrices} title={`Re-fetch Global Indicator from Alias and update Final price (GI + ${markupSuffix()})`}><Icon name="refresh" className={refreshing ? 'spin' : ''} /> {refreshing ? 'Refreshing…' : 'Refresh prices'}</button>}
            </span>
          )} />
        <div className="ph-search">
          {/* No autoFocus: on iOS a programmatic focus takes the caret without raising
              the keyboard, which reads as "the keyboard is broken" (see hooks/Receiving). */}
          <input type="search" className="ph-search-input" value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Search this range — shoe name, SKU or VIN…" aria-label="Search the lines shown" />
          {q ? <button type="button" className="btn ghost sm" onClick={() => setQ('')}>Clear</button> : null}
          {q ? <span className="muted sm">{groups.length} of {statusGroups.length} line{statusGroups.length === 1 ? '' : 's'}{hiddenBySearch > 0 ? '' : ' · nothing filtered'}</span> : null}
        </div>
        {useStatusFilter && (
          <div className="ph-status-filter">
            <span className="muted sm">Status</span>
            <div className="seg sm">
              {PH_TABS.map((s) => (
                <button key={s.key} type="button" aria-pressed={statusFilter.has(s.key)}
                  className={`seg-btn${statusFilter.has(s.key) ? ' on' : ''}${s.key === 'rescale' ? ' rescale' : ''}`}
                  title={`${tabCounts[s.key] || 0} line${(tabCounts[s.key] || 0) === 1 ? '' : 's'} ${s.label.replace('⟳ ', '')}`}
                  onClick={() => toggleStatus(s.key)}>
                  {s.label} <span className="seg-n" aria-hidden="true">{tabCounts[s.key] || 0}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {error && <div className="error mt">{error}</div>}
      {notice && <div className="notice mt">{notice}</div>}

      <div className="card">
        {!rows ? <p className="muted">Loading…</p> : !groups.length ? (
          <p className="muted">
            {q && allGroups.length > 0
              ? `Nothing matches “${q}” in this date range — the search only looks at the lines shown, so try a wider range above.`
              : useStatusFilter && allGroups.length > 0
                ? (statusFilter.size === 0 ? 'Select a status above to show lines.' : 'No lines match the selected status in this range.')
                : `No ${emptyKind} items in this range.`}
          </p>
        ) : isMobile ? (
          <div className="ph-cards" ref={cardsAnimRef}>
            {groups.map((g) => {
              const ed = editing.has(g.key);
              const d = drafts[g.key] || {};
              const open = ed || expanded.has(g.key);
              return (
                <div className={`ph-card ${ed ? 'editing' : ''}`} key={g.key}>
                  <div className="ph-card-top">
                    <span className="ph-qty-badge">×{g.qty}</span>
                    <span className="muted sm">{dateCell(g)} · {g._mixedBy ? 'multiple' : (g.created_by || '—')}</span>
                  </div>
                  <div className="ph-card-title">
                    <ShoeThumb url={g.photo_url} size={40} onOpen={g.photo_count > 0 ? () => setPhotosSku(g.sku) : null} />
                    <span>{copyable(g.name, g.name || '—')} <span className="muted">— {copyable(g.sku, g.sku || '—')}</span></span>
                  </div>
                  <div className="ph-card-subline muted sm">
                    {g.gender ? <>{g.gender} · </> : ''}<StatusPill status={g.status} />
                    {splitChip(g)}
                    {rescaleStateChip(g) || rescaleChip(g)}
                    {g.priceChanged && <span className="ph-drift" title="Final price changed since it was listed — the store price is now stale">⚠ Price changed</span>}
                  </div>
                  <button type="button" className="ph-card-sizes ph-card-sizes-btn" onClick={() => toggleExpand(g.key)} aria-expanded={open}>
                    <span className="ph-caret">{open ? '▾' : '▸'}</span><SizesQty sizes={g.sizes} />
                  </button>
                  {open && (
                    <div className="ph-sizedetail" ref={drawerAnimRef}>
                      {/* Phone: one "all sizes" row above the sizes. Skipped on a single-size
                          row — there it's just a duplicate of the row below it, and vertical
                          space is the scarce thing here (the desktop header control costs
                          none, so it stays put). */}
                      {ed && g.sizes.length > 1 && (
                        <div className="ph-sizedetail-allrow">
                          <span className="muted sm">All {g.sizes.length} sizes</span>
                          <span className="ph-sizedetail-flags">
                            {PH_FLAGS.map(([k, label]) => (
                              <span className="ph-sizedetail-flag" key={k}>
                                <span className="muted sm">{label}</span>
                                {flagNA(g, k)
                                  ? <span className="ph-flag-na" title="GOAT only — not listed to this store">N/A</span>
                                  : flagAll(g, d, k, label)}
                              </span>
                            ))}
                          </span>
                        </div>
                      )}
                      {g.sizes.map((s) => {
                        const sd = ed ? (d.sizes?.[s.size] || {}) : null;
                        return (
                          <div className="ph-sizedetail-row" key={s.size}>
                            <span className="ph-sizedetail-size">US {s.size} <span className="muted">×{s.qty}</span></span>
                            <span className="muted sm">Cost {s.cost != null ? `${s.costMixed ? '~' : ''}$${Number(s.cost).toFixed(2)}` : '—'}</span>
                            {showPricing && <span className="ph-card-price">GI {ed
                              ? <><PriceInput value={sd.global_indicator} onChange={(e) => setSizeGI(g.key, s.size, e.target.value)} /><BasisChip basis={sd.gi_basis} /></>
                              : <><b>{s.global_indicator != null ? `${s.globalMixed ? '~' : ''}$${Number(s.global_indicator).toFixed(2)}` : '—'}</b><BasisChip basis={s.gi_basis} /></>}</span>}
                            {showPricing && <span className="ph-card-price">Final {ed
                              ? <PriceInput value={sd.price} onChange={(e) => setSizePrice(g.key, s.size, e.target.value)} />
                              : <><b>{s.price != null ? `${s.priceMixed ? '~' : ''}$${fmtPrice(s.price)}` : '—'}</b>{s.priceChanged && s.listed_price != null && <span className="ph-drift-was" title="Price it was listed at">was ${fmtPrice(s.listed_price)}</span>}</>}</span>}
                            <span className="ph-sizedetail-flags">
                              {PH_FLAGS.map(([k, label]) => (
                                <span className="ph-sizedetail-flag" key={k}>
                                  <span className="muted sm">{label}</span>
                                  {flagNA(g, k)
                                    ? <span className="ph-flag-na" title="GOAT only — not listed to this store">N/A</span>
                                    : <YesNo value={ed ? sd[k] : s[k]} count={s.flagCounts?.[k]} total={s.qty} editing={ed} onChange={(v) => setSizeFlag(g, s.size, k, v)} />}
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
                  <div className="ph-card-synced"><span className="muted sm">{ed ? 'Last saved (all sizes)' : 'Listed / synced (all sizes)'}</span> <span className="ph-sync-cell"><SyncBadges item={g} goatOnly={g.goat_only} />{goatChip(g)}</span></div>
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
                      const locked = !ed && lockHolder(g) && !g.closed;
                      if (ed) return (
                        <span className="ph-edit-actions">
                          <button className="btn sm primary" disabled={savingKey === g.key} onClick={() => submitGroup(g)}>{savingKey === g.key ? '…' : 'Submit'}</button>
                          <button className="btn sm ghost" disabled={savingKey === g.key} onClick={() => closeEdit(g.key)}>Cancel</button>
                        </span>
                      );
                      if (g.closed) return closedNote(g); // sold/shipped — no Edit, no Remove
                      if (locked) return <span className="presence-badge" title={`${locked} is editing this right now`}>{locked} editing…</span>;
                      return (
                        <span className="ph-edit-actions">
                          <button className="btn sm ghost" disabled={editing.size > 0} title={editing.size > 0 ? 'Finish your current edit first' : ''} onClick={() => startEdit(g)}>Edit</button>
                          <button className="btn sm ghost danger" disabled={editing.size > 0}
                            title="Correct the count — deletes pairs and files them under Deleted"
                            onClick={() => setRemoving({ title: g.name || g.sku || 'Unknown shoe', sku: g.sku, units: unitsOf(g) })}>
                            Remove…
                          </button>
                          {canRescaleRequest && (
                            <button className="btn sm ghost" disabled={editing.size > 0}
                              title="Ask the warehouse to recount this SKU — you report your count, they count the shelf"
                              onClick={() => setRescaleFor(g)}>
                              ⟳ Rescale…
                            </button>
                          )}
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
                  <th style={rightStyle('action', canRescaleRequest)} className="ph-rfrozen ph-rfrozen-first">Action</th>
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
                        <td style={frozenStyle(0)} className="ph-frozen">{dateCell(g)}</td>
                        <td style={frozenStyle(1)} className="ph-frozen ph-title"><span className="ph-title-inner"><span className="ph-caret">{open ? '▾' : '▸'}</span><ShoeThumb url={g.photo_url} size={30} onOpen={g.photo_count > 0 ? () => setPhotosSku(g.sku) : null} />{copyable(g.name, g.name || '—', 'ph-title-name')}{splitChip(g)}{g.priceChanged && <span className="ph-drift" title="Final price changed since it was listed — the store price is now stale">⚠ Price changed</span>}</span></td>
                        <td style={frozenStyle(2)} className="ph-frozen">{copyable(g.sku, g.sku || '—')}</td>
                        <td style={frozenStyle(3)} className="ph-frozen ph-frozen-last" title={g.vins.join(', ')}><b>×{g.qty}</b></td>
                        <td className="ph-sizes"><SizesQty sizes={g.sizes} /></td>
                        <td>{g.gender || '—'}</td>
                        <td className="ph-status-cell"><StatusPill status={g.status} />{rescaleStateChip(g) || rescaleChip(g)}</td>
                        <td><div className="ph-sync-cell"><SyncBadges item={g} goatOnly={g.goat_only} />{goatChip(g)}</div></td>
                        <td>{g._mixedBy ? <span className="muted">multiple</span> : (g.created_by || '—')}</td>
                        <td style={rightStyle('action', canRescaleRequest)} className="ph-rfrozen ph-rfrozen-first" onClick={(e) => e.stopPropagation()}>
                          {!canEdit ? <span className="muted">—</span>
                            : ed
                              ? (<span className="ph-edit-actions">
                                  <button className="btn sm primary" disabled={savingKey === g.key} onClick={() => submitGroup(g)}>{savingKey === g.key ? '…' : 'Submit'}</button>
                                  <button className="btn sm ghost" disabled={savingKey === g.key} onClick={() => closeEdit(g.key)}>Cancel</button>
                                </span>)
                              : g.closed
                                ? closedNote(g)
                                : (lockHolder(g)
                                  ? <span className="presence-badge" title={`${lockHolder(g)} is editing this right now`}>{lockHolder(g)} editing…</span>
                                  : (<span className="ph-edit-actions">
                                      <button className="btn sm ghost" disabled={editing.size > 0} title={editing.size > 0 ? 'Finish your current edit first' : ''} onClick={() => startEdit(g)}>Edit</button>
                                      {canRescaleRequest && (
                                        <button className="btn sm ghost ph-rescale-btn" disabled={editing.size > 0}
                                          title="Ask the warehouse to recount this SKU — you report your count, they count the shelf"
                                          onClick={() => setRescaleFor(g)}>
                                          ⟳ Rescale…
                                        </button>
                                      )}
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
                              {(() => {
                                const r = rescaleReq(g);
                                if (!r) return null;
                                if (r.status === 'open') {
                                  return (
                                    <div className="ph-audit wait">
                                      <b>Waiting on the warehouse.</b> {r.requested_by || 'Someone'} asked them to count this shelf
                                      {r.created_at ? ` on ${PH_DATETIME.format(new Date(r.created_at))} EST` : ''}
                                      {daysSince(r.created_at) > 2 ? ` — ${daysSince(r.created_at)} days ago` : ''}.
                                      {r.note ? <span className="muted"> “{r.note}”</span> : null}
                                    </div>
                                  );
                                }
                                const rows = auditRows(g, r);
                                const short = rows.reduce((n, x) => n + (x.delta != null && x.delta < 0 ? -x.delta : 0), 0);
                                const over = rows.reduce((n, x) => n + (x.delta != null && x.delta > 0 ? x.delta : 0), 0);
                                return (
                                  <div className="ph-audit">
                                    <div className="ph-audit-head">
                                      <b>Counted by {r.resolved_by || 'the warehouse'}</b>
                                      {r.resolved_at ? <span className="muted sm"> · {PH_DATETIME.format(new Date(r.resolved_at))} EST</span> : null}
                                      {r.audit_note ? <span className="muted sm"> · “{r.audit_note}”</span> : null}
                                    </div>
                                    {(() => {
                                      const sheet = sheetFor(g, r);
                                      const held = new Set((g.sizes || []).map((s) => String(s.size)));
                                      const guide = canRescaleRequest;
                                      return (
                                        <div className="ph-audit-scroll">
                                          <table className="ph-audit-table">
                                            <thead><tr>
                                              <th>Size</th><th>On file</th><th>Reported</th><th>Actual</th><th>Δ</th>
                                              {guide && showPricing && (
                                                <>
                                                  <th>
                                                    <span className="ph-gi-th">Global indicator
                                                      <button type="button" className="btn icon ph-gi-refresh" title="Fill GI from Alias for every counted size"
                                                        disabled={sheetGi === g.key} onClick={(e) => { e.stopPropagation(); fillSheetGi(g, r); }}>
                                                        <Icon name="refresh" size="1em" className={sheetGi === g.key ? 'spin' : ''} />
                                                      </button>
                                                    </span>
                                                  </th>
                                                  <th>Final price (GI+{markupSuffix()})</th>
                                                </>
                                              )}
                                              {guide && PH_FLAGS.map(([k, label]) => <th key={k}>{label}</th>)}
                                            </tr></thead>
                                            <tbody>
                                              {rows.map((x) => {
                                                const f = sheet[x.size] || {};
                                                const onFile = held.has(x.size);
                                                return (
                                                  <tr key={x.size} className={onFile ? '' : 'untracked'}>
                                                    <td>
                                                      {x.size}
                                                      {!onFile && <span className="ph-untracked-tag" title="No stock on file for this size yet — what you set here is recorded on the request, not on an inventory row">not on file</span>}
                                                    </td>
                                                    <td>{x.onFile ?? '—'}</td>
                                                    <td>{x.reported ?? '—'}</td>
                                                    <td className={x.delta ? 'diff' : ''}>{x.actual ?? '—'}</td>
                                                    <td className={x.delta ? 'diff' : 'match'}>
                                                      {x.delta == null ? '—' : x.delta === 0 ? 'match' : (x.delta > 0 ? `+${x.delta}` : x.delta)}
                                                    </td>
                                                    {guide && showPricing && (
                                                      <>
                                                        <td onClick={(e) => e.stopPropagation()}>
                                                          <PriceInput value={f.global_indicator} onChange={(e) => setSheetGiValue(g, r, x.size, e.target.value)} />
                                                          <BasisChip basis={f.gi_basis} />
                                                        </td>
                                                        <td onClick={(e) => e.stopPropagation()}>
                                                          <PriceInput value={f.price} onChange={(e) => setSheetField(g, r, x.size, { price: e.target.value })} />
                                                        </td>
                                                      </>
                                                    )}
                                                    {guide && PH_FLAGS.map(([k]) => (
                                                      <td key={k}>
                                                        {flagNA(g, k)
                                                          ? <span className="ph-flag-na" title="GOAT only — not listed to this store">N/A</span>
                                                          : <span onClick={(e) => e.stopPropagation()}>
                                                              <YesNo value={!!f[k]} editing onChange={(v) => setSheetFlag(g, r, x.size, k, v)} />
                                                            </span>}
                                                      </td>
                                                    ))}
                                                  </tr>
                                                );
                                              })}
                                            </tbody>
                                          </table>
                                        </div>
                                      );
                                    })()}
                                    {/* Nothing is adjusted automatically. Short and OVER are different
                                        problems with different fixes, and the over case is usually not a
                                        problem at all — see the note. */}
                                    {short > 0 && (
                                      <div className="ph-audit-note short">
                                        <b>{short} short.</b> We hold more on file than the shelf does. Nothing has been
                                        adjusted — use <b>Remove…</b> on this row once you have settled which pairs are gone.
                                      </div>
                                    )}
                                    {over > 0 && (
                                      <div className="ph-audit-note over">
                                        <b>{over} more on the shelf than we track.</b> Often stock that predates this system
                                        and was never counted in — it has no record here at all, so nothing is missing.
                                        The warehouse fixes it with <b>Count Existing Stock</b> at that shelf; those pairs
                                        list as existing stock and <b>never reach this worklist</b>, so don’t wait for them here.
                                      </div>
                                    )}
                                    {canRescaleRequest && (
                                      <div className="ph-audit-actions">
                                        <button className="btn sm primary" disabled={sheetBusy === g.key}
                                          title="Save this listing — recorded on the request, and written to the pairs we hold"
                                          onClick={(e) => { e.stopPropagation(); saveSheet(g, r); }}>
                                          {sheetBusy === g.key ? '…' : 'Save listing'}
                                        </button>
                                        <button className="btn sm violet" disabled={closingKey === g.key || editing.size > 0}
                                          title="The pairs are listed and the count is settled — close the request"
                                          onClick={(e) => { e.stopPropagation(); closeRescale(g, r); }}>
                                          {closingKey === g.key ? '…' : '✓ Rescale done'}
                                        </button>
                                        <span className="muted sm">Closing puts this row back in the normal worklist.</span>
                                      </div>
                                    )}
                                  </div>
                                );
                              })()}
                              {rescaleReq(g)?.status === 'audited' && canRescaleRequest && (
                                <div className="ph-sizetable-note muted sm">
                                  Pricing and the store ticks moved into the count above — that is what the shelf
                                  actually holds. Below is what we have on file: quantity, cost, note and history.
                                </div>
                              )}
                              <table className="ph-sizetable">
                                <thead><tr>
                                  <th>Size</th><th>Qty</th><th>Cost</th>
                                  {showPricing && !guideModeFor(g) && <><th><span className="ph-gi-th">Global indicator{ed && <button type="button" className="btn icon ph-gi-refresh" title="Re-fetch GI from Alias for this shoe’s sizes" disabled={giFillKey === g.key} onClick={(e) => { e.stopPropagation(); fillGroupGi(g); }}><Icon name="refresh" size="1em" className={giFillKey === g.key ? 'spin' : ''} /></button>}</span></th><th>Final Price (GI+{markupSuffix()})</th></>}
                                  {!guideModeFor(g) && PH_FLAGS.map(([k, label]) => (
                                    <th key={k}>
                                      <span className="ph-flag-th">
                                        <span>{label}</span>
                                        {ed && !flagNA(g, k) && flagAll(g, d, k, label)}
                                      </span>
                                    </th>
                                  ))}
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
                                        {showPricing && !guideModeFor(g) && (
                                          <td>{ed
                                            ? <><PriceInput value={sd.global_indicator} onChange={(e) => setSizeGI(g.key, s.size, e.target.value)} /><BasisChip basis={sd.gi_basis} /></>
                                            : <>{s.global_indicator != null ? `${s.globalMixed ? '~' : ''}$${Number(s.global_indicator).toFixed(2)}` : '—'}<BasisChip basis={s.gi_basis} /></>}</td>
                                        )}
                                        {showPricing && !guideModeFor(g) && (
                                          <td>{ed
                                            ? <PriceInput value={sd.price} onChange={(e) => setSizePrice(g.key, s.size, e.target.value)} />
                                            : (s.price != null
                                              ? <>{s.priceMixed ? '~' : ''}${fmtPrice(s.price)}{s.priceChanged && s.listed_price != null && <span className="ph-drift-was" title="Price it was listed at">was ${fmtPrice(s.listed_price)}</span>}</>
                                              : '—')}</td>
                                        )}
                                        {!guideModeFor(g) && PH_FLAGS.map(([k]) => (
                                          <td key={k}>{flagNA(g, k)
                                            ? <span className="ph-flag-na" title="GOAT only — not listed to this store">N/A</span>
                                            : <YesNo value={ed ? sd[k] : s[k]} count={s.flagCounts?.[k]} total={s.qty} editing={ed} onChange={(v) => setSizeFlag(g, s.size, k, v)} />}</td>
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
      {goatConfirmModal}
      {removing && <RemoveUnitsModal {...removing} onClose={() => setRemoving(null)} onDone={onRemoved} />}
      {rescaleFor && (
        <RescaleRequestModal
          group={rescaleFor}
          existing={rescaleFor.sku ? openReqs[rescaleFor.sku] : null}
          onClose={() => setRescaleFor(null)}
          onDone={onRescaleSent}
        />
      )}
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
