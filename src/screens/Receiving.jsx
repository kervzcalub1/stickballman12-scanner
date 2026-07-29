// Batch intake: fill shipment details, scan many items into a cart (lookups
// resolve in the background so scanning never blocks), add shipment issues,
// then commit once → DB (one VIN per item). Also drives Rescale intake (mode).
import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { loadPrefs, savePrefs } from '../prefs.js';
import { STATUSES } from '../statuses.js';
import { TopBar, Modal, LabelSheet, PreferencesModal } from '../components/common.jsx';
import { ListingPhotos } from '../components/ListingPhotos.jsx';
import { DefectPhotos } from '../components/DefectPhotos.jsx';
import { Icon } from '../components/NavIcons.jsx';
import { ManifestPrint } from '../components/ManifestPrint.jsx';
import { useUnsavedGuard } from '../hooks.js';
import { isVinCode, isUpcCode, parseTrackingNumber, usSizeChart, compareSizes } from '../lib/codes.js';
import { SUPPLIERS, RESCALE_REASONS, ISSUE_TYPES, DEFECT_TYPES } from '../lib/constants.js';
import { estToday } from '../lib/format.js';

// Lazy-loaded so the barcode library only downloads when the camera is opened.
const CameraScanner = lazy(() => import('../components/CameraScanner.jsx'));

// Monotonic key source for the cart's React lists (unique among siblings).
let cartKey = 1;

// Shown on the "batch saved" modal when the PO it was received against doesn't add up.
// Reconciliation is shared between warehouse and PH — whoever is standing here can open
// the report and message the supplier, so this states the problem and hands over a link
// rather than assuming an owner.
function ReconcileAlert({ rc, onOpen }) {
  const parts = [];
  if (rc.shortage) parts.push(`${rc.shortage} short`);
  if (rc.overage) parts.push(`${rc.overage} over`);
  if (rc.wrongSize) parts.push(`${rc.wrongSize} wrong size`);
  if (rc.wrongSku) parts.push(`${rc.wrongSku} not on the PO`);
  return (
    <div className="po-mismatch">
      <div className="po-mismatch-top">
        <b>{rc.poCode} doesn’t match the manifest</b>
        <span className="po-flag bad">{rc.noManifest ? 'No manifest' : parts.join(' · ')}</span>
      </div>
      <p className="muted sm">
        {rc.noManifest
          ? `${rc.receivedUnits} unit${rc.receivedUnits === 1 ? '' : 's'} received with nothing declared — received blind.`
          : `Received ${rc.receivedUnits} of ${rc.expectedUnits} expected units from ${rc.supplierName}.`}
        {' '}Someone needs to tell the supplier — warehouse or PH, whoever gets there first.
      </p>
      {onOpen && (
        <button className="btn sm" onClick={() => onOpen(rc.poId)}>
          <Icon name="reconcile" /> Review &amp; copy the report
        </button>
      )}
    </div>
  );
}

export function Receiving({ mode = 'receiving', navBack, batchContext = null, onBatchDone, onOpenItem, onOpenReconcile, onHome, onSignOut }) {
  const isRescale = mode === 'rescale';
  const isInstore = mode === 'instore';
  // No-shipment intake (rescale OR in-store buying): no supplier/buyer/tracking and
  // no Review/Issues steps — a 2-step Details → Items flow. `isRescale` alone still
  // gates the VIN-rescan behaviour; in-store is fresh stock, scanned like receiving.
  const noShipment = isRescale || isInstore;
  // "Box mode": adding a box to an existing OPEN multi-box batch (from Batch Page).
  // Step 1 collects only the box tracking #; finish commits the box (boxCommit).
  const isBoxMode = !noShipment && !!batchContext;
  const today = estToday();
  const [tab, setTab] = useState('intake');   // 'intake' | 'recent'
  const [step, setStep] = useState(1);         // receiving: 1 shipment·2 items·3 review·4 issues | rescale: 1 details·2 items

  const [header, setHeader] = useState({
    buyer: 'stickballman12', supplier: '', tracking: '', dateReceived: today,
    defaultCost: '', notes: '', specialRules: '', origin: isInstore ? '' : 'returned', originOther: '',
    batchTag: '', expectedBoxes: '1', // V6 Feature 7: >1 → open multi-box batch
  });
  // The reason stored on the batch: the custom text when "Other" is picked.
  const effectiveOrigin = header.origin === 'other'
    ? (String(header.originOther || '').trim() || 'Other')
    : header.origin;
  const setH = (k, v) => setHeader((h) => ({ ...h, [k]: v }));

  // V6 PO Phase 2: receive a shipment against a purchase order. When set, Step 1 is
  // pre-filled from the PO (supplier, tag, each label → a box slot) and the commit
  // links the batch back via poId (server flips the PO to 'receiving').
  const [receivingPo, setReceivingPo] = useState(null); // { po, boxes, lines }
  const [showPoPicker, setShowPoPicker] = useState(false);
  const [poSuggest, setPoSuggest] = useState(null);     // { code, tracking, data } — a typed/scanned tracking matched an open PO
  const poSuggestDismiss = useRef(new Set());           // trackings the user chose to receive plainly
  const emptyBoxAck = useRef(false);                    // "yes, this PO box really is empty" — see goStep3
  function applyPo(data) {
    const boxes = data.boxes || [];
    setReceivingPo(data);
    // Make the PO's supplier selectable so the <select> doesn't show blank when it
    // isn't in the seeded list (the batch still commits with this supplier).
    setSupplierOptions((opts) => (opts.includes(data.po.supplier_name)
      ? opts : [...opts, data.po.supplier_name].sort((a, b) => a.localeCompare(b))));
    setHeader((h) => ({
      ...h,
      supplier: data.po.supplier_name || h.supplier,
      batchTag: data.po.tag_code || h.batchTag,
      tracking: '',
      expectedBoxes: String(Math.max(1, boxes.length)),
    }));
    // Every label becomes a box slot — receiving each is a manifest checklist.
    setBoxSlots(boxes.map((b, i) => ({
      tracking: b.tracking_number || '', status: 'pending', boxNumber: i + 1, itemCount: 0, poBoxId: Number(b.id), boxId: null,
    })));
    setShowPoPicker(false);
    // Resume: if this PO already has a linked receiving batch (returned/refreshed
    // mid-receive), load it so received boxes show done and we REUSE that batch —
    // ensureBatch won't create a duplicate, and received boxes can't be re-added.
    if (data.po.received_batch_id) {
      api.batchFull(data.po.received_batch_id).then((r) => {
        if (!r?.batch) return;
        setActiveBatch({ id: r.batch.id, batchCode: r.batch.batch_code });
        const byNum = new Map((r.boxes || []).map((b) => [Number(b.box_number), b]));
        setBoxSlots(boxes.map((b, i) => {
          const bb = byNum.get(i + 1);
          return {
            tracking: b.tracking_number || '', poBoxId: Number(b.id), boxNumber: i + 1,
            boxId: bb ? Number(bb.id) : null,
            status: bb?.status === 'received' ? 'received' : 'pending',
            itemCount: bb?.item_count ?? 0,
          };
        }));
      }).catch(() => { /* treat as a fresh receive */ });
    }
  }
  const clearPo = () => setReceivingPo(null); // unlink; keep whatever's typed

  // Receive-against-PO = a per-box manifest checklist built from the PO's expected
  // lines for that label (grouped one item per SKU, one row per size).
  //
  // Every row starts UNCHECKED (qty 0), not at the expected qty: the checklist is the
  // guide for what's actually being pulled out of the box, so you tick a size as the
  // pair comes out. Pre-checking made "I received everything" the default and turned
  // the screen into something you skim past — a shortage only got caught if someone
  // remembered to untick it.
  const manifestLinesFor = (poBoxId) => (receivingPo?.lines || []).filter((l) => Number(l.po_box_id) === Number(poBoxId));
  function buildManifestItems(poBoxId) {
    const bySku = new Map();
    for (const l of manifestLinesFor(poBoxId)) {
      const key = l.sku || `?${l.id}`;
      if (!bySku.has(key)) bySku.set(key, {
        key: cartKey++, name: l.name || l.sku || 'Unknown', sku: l.sku || '', image: '',
        source: 'manual', upc: l.upc || '', gender: l.gender || null, colorway: l.colorway || null,
        withBox: true, expected: true, sizes: [],
      });
      bySku.get(key).sizes.push({ key: cartKey++, size: String(l.size), qty: 0, expectedQty: l.qty_expected, vins: [] });
    }
    return [...bySku.values()];
  }
  const setSizeQty = (itemKey, sizeKey, qty) => setItems((arr) => arr.map((it) => (it.key !== itemKey ? it : {
    ...it, sizes: it.sizes.map((s) => (s.key === sizeKey ? { ...s, qty: Math.max(0, parseInt(qty, 10) || 0) } : s)),
  })));
  // Reserve real VINs for the current manifest counts so every received unit shows
  // its VIN on Review and can be flagged with a per-shoe defect (parity with the
  // scan flow). Reserves only the shortfall; trims extras when a count drops.
  async function ensureManifestVins() {
    let need = 0;
    for (const it of items) for (const s of it.sizes) {
      need += Math.max(0, (Math.max(0, Number(s.qty) || 0)) - (s.vins?.length || 0));
    }
    let pool = [];
    if (need > 0) {
      try { const res = await api.reserveVins(need, header.dateReceived); pool = res.vins || []; }
      catch (e) { if (e.unauthorized) { onSignOut(); return false; } /* else server assigns on commit */ }
    }
    let idx = 0;
    setItems((arr) => arr.map((it) => ({
      ...it,
      sizes: it.sizes.map((s) => {
        const q = Math.max(0, Number(s.qty) || 0);
        let vs = (s.vins || []).slice(0, q);
        while (vs.length < q && idx < pool.length) vs = [...vs, pool[idx++]];
        return { ...s, vins: vs };
      }),
    })));
    return true;
  }

  // Add-new-supplier modal (Feature 1): type a vendor → it's appended to the
  // dropdown and selected for this session (persisted to the DB on commit).
  const [showAddSupplier, setShowAddSupplier] = useState(false);
  const [newSupplier, setNewSupplier] = useState('');
  function saveNewSupplier() {
    const name = newSupplier.trim();
    if (!name) return;
    const existing = supplierOptions.find((s) => s.toLowerCase() === name.toLowerCase());
    if (existing) setH('supplier', existing); // already in the list — just select it
    else { setSupplierOptions((opts) => [...opts, name].sort((a, b) => a.localeCompare(b))); setH('supplier', name); }
    setShowAddSupplier(false);
    setNewSupplier('');
  }
  // Supplier dropdown options: seeded list + auto-saved custom names (Feature 1).
  // Falls back to the static SUPPLIERS constant if the fetch fails.
  const [supplierOptions, setSupplierOptions] = useState(SUPPLIERS);
  // Duplicate-tracking alert (Feature 8): the batch_code/id a typed tracking #
  // already belongs to. Non-blocking — proceeding flags the new batch.
  const [dupBatch, setDupBatch] = useState(null);  // { code, id } | null

  useEffect(() => {
    if (noShipment) return undefined;
    let cancelled = false;
    api.suppliers()
      .then(({ suppliers }) => { if (!cancelled && suppliers?.length) setSupplierOptions(suppliers); })
      .catch(() => { /* keep the static fallback */ });
    return () => { cancelled = true; };
  }, [isRescale]);

  // Debounced duplicate-tracking check as the tracking number is typed/scanned.
  useEffect(() => {
    if (noShipment) { setDupBatch(null); return undefined; }
    const t = String(header.tracking || '').trim();
    if (!t) { setDupBatch(null); return undefined; }
    let cancelled = false;
    const id = setTimeout(() => {
      api.checkTracking(t)
        .then(({ exists, batchCode, batchId }) => { if (!cancelled) setDupBatch(exists ? { code: batchCode, id: batchId } : null); })
        .catch(() => { /* ignore — warning is best-effort */ });
    }, 500);
    return () => { cancelled = true; clearTimeout(id); };
  }, [header.tracking, isRescale]);

  // --- In-receiving multi-box builder (Feature 7 UX) ------------------------
  // When "Boxes expected" > 1, the box list renders INLINE on step 1 (the main
  // receiving page): one row per box with its own tracking # + "Add items".
  // The OPEN batch is created lazily on the first box commit, then each box
  // commits independently — progress is always saved/resumable.
  const [activeBatch, setActiveBatch] = useState(null); // { id, batchCode } once created
  const [boxSlots, setBoxSlots] = useState([]);          // [{ tracking, status, boxNumber, itemCount }]
  const [activeSlot, setActiveSlot] = useState(null);    // index being scanned; null = box list (step 1)
  const [trackingSlot, setTrackingSlot] = useState(null); // which box the tracking scanner targets (null = header)
  const setSlotTracking = (i, v) => setBoxSlots((s) => s.map((x, idx) => (idx === i ? { ...x, tracking: v } : x)));
  // Derived (declared early so the Back-button effect below can depend on them).
  const expectedBoxesNum = Math.max(1, parseInt(header.expectedBoxes, 10) || 1);
  // Receiving against a PO always uses the per-box (box-list) flow — even a
  // single-label PO — so every label goes through its manifest checklist.
  const isPoReceive = !!receivingPo && !isBoxMode && !noShipment;
  const isMultiBoxNew = !noShipment && !isBoxMode && (expectedBoxesNum > 1 || isPoReceive);
  const receivedSlots = boxSlots.filter((s) => s.status === 'received').length;

  // Suggest a PO when a typed/scanned tracking number matches an open shipment and the
  // warehouse hasn't already picked one — so a box that shipped/arrived gets linked to its
  // PO instead of leaving the PO open (avoids mismatch). Confirm-first: never auto-links.
  useEffect(() => {
    if (receivingPo || noShipment || isRescale || isBoxMode) { setPoSuggest(null); return undefined; }
    const tracking = [header.tracking, ...boxSlots.map((s) => s.tracking)]
      .map((t) => String(t || '').trim())
      .find((t) => t.length >= 8 && !poSuggestDismiss.current.has(t));
    if (!tracking) { setPoSuggest(null); return undefined; }
    let dead = false;
    const id = setTimeout(async () => {
      try {
        const data = await api.poLookup(tracking);
        if (dead) return;
        if (data?.po && ['draft', 'shipped', 'receiving'].includes(data.po.status)) setPoSuggest({ code: data.po.po_code, tracking, data });
        else setPoSuggest(null);
      } catch { if (!dead) setPoSuggest(null); } // 404 = no PO for this tracking
    }, 600);
    return () => { dead = true; clearTimeout(id); };
  }, [header.tracking, boxSlots, receivingPo, noShipment, isRescale, isBoxMode]); // eslint-disable-line react-hooks/exhaustive-deps

  const [prefs, setPrefs] = useState(loadPrefs);
  const [showPrefs, setShowPrefs] = useState(false);
  const setCameraZoom = (zoom) => setPrefs((p) => { const n = { ...p, cameraZoom: zoom }; savePrefs(n); return n; });

  const [items, setItems] = useState([]);     // completed shoes (each: name,sku,…,withBox,sizes[])
  // Rescale only: EXISTING units re-scanned by VIN — each updates its own record
  // (no new VIN). { key, vin, name, sku, size, image, statusSel, custom }.
  const [rescanned, setRescanned] = useState([]);
  const [openSizes, setOpenSizes] = useState(() => new Set()); // expanded size rows (item:size keys)
  const [issues, setIssues] = useState([]);   // manual shipment issues
  // Per-unit (VIN) defect issues flagged on the Review step (V6 Feature 4):
  // vin -> [{ key, type, note, photos:[url] }]. Sent with commit → 'issue' events.
  const [unitIssues, setUnitIssues] = useState({});
  const [issueEditorVin, setIssueEditorVin] = useState(null);
  const getIssues = (vin) => unitIssues[vin] || [];
  const issueCount = (vin) => (unitIssues[vin] || []).length;
  const hasIssue = (vin) => issueCount(vin) > 0;
  const addUnitIssue = (vin) => setUnitIssues((m) => ({ ...m, [vin]: [...(m[vin] || []), { key: cartKey++, type: DEFECT_TYPES[0][0], note: '', photos: [] }] }));
  const updateUnitIssue = (vin, key, patch) => setUnitIssues((m) => ({ ...m, [vin]: (m[vin] || []).map((x) => (x.key === key ? { ...x, ...patch } : x)) }));
  const removeUnitIssue = (vin, key) => setUnitIssues((m) => {
    const arr = (m[vin] || []).filter((x) => x.key !== key);
    const n = { ...m }; if (arr.length) n[vin] = arr; else delete n[vin]; return n;
  });
  const closeIssueEditor = () => setIssueEditorVin(null);
  const flaggedCount = Object.keys(unitIssues).filter(hasIssue).length;

  // ---- Review-step item edits (box status, qty, delete) ----
  async function reserveMoreVins(n) {
    try { const res = await api.reserveVins(n, header.dateReceived); return res.vins || []; }
    catch (err) { if (err.unauthorized) onSignOut(); return []; }
  }
  const setItemBox = (itemKey, withBox) => setItems((arr) => arr.map((it) => (it.key === itemKey ? { ...it, withBox } : it)));
  const setItemGoat = (itemKey, goatOnly) => setItems((arr) => arr.map((it) => (it.key === itemKey ? { ...it, goatOnly } : it)));
  async function bumpSizeQty(itemKey, sizeKey, delta) {
    if (delta > 0) {
      const vins = await reserveMoreVins(1);
      setItems((arr) => arr.map((it) => (it.key !== itemKey ? it : {
        ...it, sizes: it.sizes.map((s) => (s.key !== sizeKey ? s : { ...s, qty: s.qty + 1, vins: [...(s.vins || []), ...vins] })),
      })));
    } else {
      setItems((arr) => arr.map((it) => (it.key !== itemKey ? it : {
        ...it,
        sizes: it.sizes.flatMap((s) => {
          if (s.key !== sizeKey) return [s];
          const q = Math.max(0, (Number(s.qty) || 1) - 1);
          return q === 0 ? [] : [{ ...s, qty: q, vins: (s.vins || []).slice(0, q) }];
        }),
      })));
    }
  }
  const removeSizeRow = (itemKey, sizeKey) => setItems((arr) => arr.flatMap((it) => {
    if (it.key !== itemKey) return [it];
    const sizes = it.sizes.filter((s) => s.key !== sizeKey);
    return sizes.length ? [{ ...it, sizes }] : []; // drop the line if no sizes remain
  }));
  const toggleSize = (k) => setOpenSizes((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const [error, setError] = useState('');
  const [committing, setCommitting] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [result, setResult] = useState(null);
  const [printLabels, setPrintLabels] = useState(null);

  // Tracking capture (camera + photo-OCR fallback).
  const [scanTracking, setScanTracking] = useState(false);
  const [ocrBusy, setOcrBusy] = useState(false);
  const fileRef = useRef(null);

  // Add Item modal — scan one shoe model at a time into a `draft`.
  const [showAdd, setShowAdd] = useState(false);
  const [draft, setDraft] = useState(null);
  const draftRef = useRef(null); draftRef.current = draft;
  const rescannedRef = useRef([]); rescannedRef.current = rescanned; // mirror so the camera callback dedupes against fresh state
  useUnsavedGuard(items.length > 0 || !!draft || rescanned.length > 0 || issues.length > 0 || flaggedCount > 0); // guard the cart against Back/refresh
  const [mInput, setMInput] = useState('');
  const [mBusy, setMBusy] = useState(false);
  const [mError, setMError] = useState('');
  const [mCam, setMCam] = useState(false);
  const [photoCam, setPhotoCam] = useState(false); // listing-photo camera overlay open
  const [pendingSwitch, setPendingSwitch] = useState(null); // different SKU scanned mid-session
  const [flash, setFlash] = useState(null);
  const mInputRef = useRef(null);
  const recentRef = useRef({}); // code -> last scan time (cooldown vs gun/camera re-reads)
  const reselectRef = useRef(false); // after a typed/gun submit, re-select the code once the lookup finishes

  // After a typed/gun submit the field keeps the searched code (so the manual
  // typist still sees it); re-select it once the lookup finishes and the input is
  // re-enabled, so a barcode gun's next scan REPLACES the text instead of
  // appending to it. Runs when mBusy clears — the input is disabled mid-lookup, so
  // selecting earlier would be a no-op.
  useEffect(() => {
    if (mBusy || !reselectRef.current) return;
    reselectRef.current = false;
    const el = mInputRef.current;
    if (el && !el.disabled) { el.focus({ preventScroll: true }); el.select(); }
  }, [mBusy]);

  // Keep the scan field focused so a HID scanner gun types straight into it. `draft` is a
  // dep so the field re-arms after a scan builds/updates the draft — but that also fires on
  // every size/qty/name edit, so DON'T steal focus when the user is typing in another field
  // (e.g. correcting a size to 5C / 3Y). Only refocus when nothing editable is focused.
  useEffect(() => {
    if (showAdd && !mCam && !photoCam && !pendingSwitch) {
      const t = setTimeout(() => {
        const ae = document.activeElement;
        if (ae && ae !== mInputRef.current && ae.matches?.('input, textarea, select, [contenteditable="true"]')) return;
        mInputRef.current?.focus({ preventScroll: true });
      }, 60);
      return () => clearTimeout(t);
    }
  }, [showAdd, mCam, photoCam, pendingSwitch, draft]);
  // While the listing-photo camera is open, drop focus so the mobile keyboard
  // closes — capturing a photo must never re-summon it via the hidden scan field.
  useEffect(() => { if (photoCam) document.activeElement?.blur?.(); }, [photoCam]);
  // Keep the box-slot rows in sync with "Boxes expected" (until the batch is
  // created/locked). Preserves any tracking already typed into existing rows.
  useEffect(() => {
    if (!isMultiBoxNew || activeBatch) return;
    setBoxSlots((prev) => {
      if (prev.length === expectedBoxesNum) return prev;
      const next = prev.slice(0, expectedBoxesNum);
      while (next.length < expectedBoxesNum) next.push({ tracking: '', status: 'pending', boxNumber: null, itemCount: 0 });
      return next;
    });
  }, [expectedBoxesNum, isMultiBoxNew, activeBatch]);
  useEffect(() => { if (!flash) return; const t = setTimeout(() => setFlash(null), 1800); return () => clearTimeout(t); }, [flash]);

  // Device Back button: close any open modal, else step back, else fall through
  // to the app (→ home). Returns true when it consumed the Back press.
  useEffect(() => {
    if (!navBack) return undefined;
    navBack.current = () => {
      if (issueEditorVin) { closeIssueEditor(); return true; }
      if (showAddSupplier) { setShowAddSupplier(false); return true; }
      if (pendingSwitch) { setPendingSwitch(null); return true; }
      if (showAdd) { closeAddItem(); return true; }
      if (scanTracking) { setScanTracking(false); return true; }
      if (showPrefs) { setShowPrefs(false); return true; }
      if (showConfirm) { setShowConfirm(false); return true; }
      if (result) { setResult(null); return true; }
      if (printLabels) { setPrintLabels(null); return true; }
      if (tab === 'recent') { setTab('intake'); return true; }
      // Multi-box: from a box's scan steps, Back returns to the box list.
      if (isMultiBoxNew && activeSlot != null) { backToBoxList(); return true; }
      if (step > 1) { setStep((s) => s - 1); return true; }
      return false;
    };
    return () => { if (navBack) navBack.current = null; };
  }, [navBack, issueEditorVin, unitIssues, showAddSupplier, pendingSwitch, showAdd, scanTracking, showPrefs, showConfirm, result, printLabels, tab, step, isMultiBoxNew, activeBatch, activeSlot]);

  // Short audible + haptic confirmation that a box registered.
  function scanFeedback(kind) {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) {
        const ctx = new Ctx();
        const o = ctx.createOscillator(); const g = ctx.createGain();
        o.frequency.value = kind === 'added' ? 920 : 330;
        g.gain.value = 0.05; o.connect(g); g.connect(ctx.destination);
        o.start(); setTimeout(() => { o.stop(); ctx.close(); }, 90);
      }
    } catch { /* no audio */ }
    try { navigator.vibrate?.(kind === 'added' ? 70 : [30, 40, 30]); } catch { /* no haptics */ }
  }

  // ---- Add Item modal: scan one shoe model, auto-incrementing sizes ----
  const sameSku = (a, b) => Boolean(a) && Boolean(b)
    && String(a).trim().toUpperCase().replace(/\s+/g, '-') === String(b).trim().toUpperCase().replace(/\s+/g, '-');
  const bumpSize = (rows, size) => {
    const i = rows.findIndex((r) => r.size === size);
    return i === -1 ? [...rows, { key: cartKey++, size, qty: 1 }] : rows.map((r, j) => (j === i ? { ...r, qty: r.qty + 1 } : r));
  };
  // Size options for the modal dropdown: API run when it has >1, else the
  // standard US chart (W/Y suffix detected), minus sizes already added.
  function sizePool(d) {
    const apiSizes = d?.sizeOptions || [];
    const tokens = [...apiSizes, ...(d?.rows || []).map((r) => r.size)].map((s) => String(s || ''));
    const kind = tokens.some((s) => /y$/i.test(s)) ? 'y' : tokens.some((s) => /w$/i.test(s)) ? 'w' : '';
    const pool = apiSizes.length > 1 ? apiSizes : [...new Set([...apiSizes, ...usSizeChart(kind)])];
    return pool.filter((s) => !(d?.rows || []).some((r) => r.size === s));
  }

  function openAddItem() { setDraft(null); setMInput(''); setMError(''); setPendingSwitch(null); setMCam(false); recentRef.current = {}; setShowAdd(true); }
  function closeAddItem() { setShowAdd(false); setDraft(null); setPendingSwitch(null); setMError(''); setMCam(false); }

  // Resolve a scanned/typed code (auto-detect UPC vs SKU) and fold it into the
  // current draft: start the shoe, +1 the matching size, or (different SKU)
  // prompt to finish the current shoe and start a new one.
  async function addCode(code, { showInField = false } = {}) {
    const c = String(code).trim();
    if (!c) return;
    const now = Date.now();
    if (recentRef.current[c] && now - recentRef.current[c] < 1200) return; // gun/camera re-read
    recentRef.current[c] = now;
    // Keep the scanned/typed code visible in the field after a lookup (so the
    // manual typist can still see what they searched). The typed/gun submit path
    // (form onSubmit) re-selects the text afterwards, so a barcode gun's next
    // scan replaces the selection instead of appending to it. Only the legacy
    // showInField=false callers clear the field outright.
    setMInput(showInField ? c : ''); setMError('');

    // Rescale: a scanned/typed VIN is an EXISTING unit — look it up and add it
    // to the rescanned list (its own record gets updated on finish; no new VIN).
    // UPC/SKU still fall through to the product lookup below (new/unlabeled stock).
    if (isRescale && isVinCode(c)) {
      const vin = c.toUpperCase();
      if (rescannedRef.current.some((r) => r.vin === vin)) { setFlash({ type: 'dup', text: `Already added · ${vin}` }); scanFeedback('dup'); return; }
      setMBusy(true);
      try {
        const { item } = await api.itemLookup(vin);
        setRescanned((arr) => [...arr, { key: cartKey++, vin: item.vin, name: item.name, sku: item.sku, size: item.size, image: item.image_url, statusSel: '', custom: '' }]);
        setFlash({ type: 'added', text: `✓ ${item.vin}${item.size ? ` · size ${item.size}` : ''}` }); scanFeedback('added');
      } catch (err) {
        if (err.unauthorized) return onSignOut();
        setMError(err.message); scanFeedback('dup');
      } finally { setMBusy(false); }
      return;
    }

    const isUpc = isUpcCode(c);
    setMBusy(true);
    try {
      const { product: p } = isUpc ? await api.searchUpc(c) : await api.searchSku(c);
      const incoming = {
        name: p.name || '', sku: p.sku || '', image: p.image || '', source: p.source || 'manual',
        // Keep the UPC whether it was scanned directly or returned by a SKU
        // lookup — it's needed to print the no-box box-style barcode label.
        upc: (isUpc ? c : '') || p.upc || '', scannedSize: p.scannedSize || null, sizeOptions: p.sizes || [],
        gender: p.gender || null, colorway: p.colorway || '',
      };
      const d = draftRef.current;
      // The catalog (StockX, or Alias fallback) didn't return a size for this
      // code — tell the user to pick it manually rather than the misleading
      // "already loaded". Happens on first scan or a later size of a loaded shoe.
      const noSize = !incoming.scannedSize;
      if (!d) {
        const rows = incoming.scannedSize ? [{ key: cartKey++, size: incoming.scannedSize, qty: 1 }] : [];
        setDraft({ ...incoming, withBox: true, rows });
        if (noSize) setFlash({ type: 'warn', text: `Scanned ${incoming.name || c} — no size from the catalog. Pick the size manually below.` });
        else setFlash({ type: 'added', text: `✓ ${incoming.name || c}` });
        scanFeedback('added');
      } else if (!sameSku(d.sku, incoming.sku)) {
        setPendingSwitch(incoming); scanFeedback('dup'); // different shoe → confirm switch
      } else if (incoming.scannedSize) {
        setDraft({ ...d, rows: bumpSize(d.rows, incoming.scannedSize) });
        setFlash({ type: 'added', text: `+1 · size ${incoming.scannedSize}` }); scanFeedback('added');
      } else {
        setFlash({ type: 'warn', text: 'Scanned, but no size from the catalog for this code. Pick the size manually below.' }); scanFeedback('dup');
      }
    } catch (err) {
      if (err.unauthorized) return onSignOut();
      setMError(err.message); scanFeedback('dup');
    } finally { setMBusy(false); }
  }

  // Validate the draft and build a completed item from the draft, RESERVING real
  // VINs up front so they are visible in the cart before submit — the warehouse
  // needs the VIN while handling each unit (especially no-box shoes, which must
  // be stickered/noted by hand). Reserved-but-uncommitted numbers are never
  // reused (a gap is safer than risking the same VIN on two different shoes), so
  // abandoning a session can leave harmless gaps in the sequence.
  async function buildItemFromDraft(d) {
    if (!d || !String(d.name).trim()) { setMError('Scan or type a product first.'); return null; }
    const rows = (d.rows || []).filter((r) => String(r.size).trim());
    if (!rows.length) { setMError('Add at least one size.'); return null; }
    const total = rows.reduce((a, r) => a + Math.max(1, Number(r.qty) || 1), 0);
    let vins = [];
    try { const res = await api.reserveVins(total, header.dateReceived); vins = res.vins || []; }
    catch (err) { if (err.unauthorized) { onSignOut(); return null; } /* else proceed; server assigns on commit */ }
    let idx = 0;
    const sizes = rows.map((r) => {
      const qty = Math.max(1, Number(r.qty) || 1);
      const vs = vins.slice(idx, idx + qty); idx += qty;
      return { key: r.key, size: r.size, qty, vins: vs };
    });
    return { key: cartKey++, name: d.name, sku: d.sku, image: d.image, source: d.source, upc: d.upc, gender: d.gender || null, colorway: d.colorway || null, withBox: d.withBox !== false, goatOnly: d.goatOnly === true, sizes };
  }
  // Add a completed item to the cart, MERGING into an existing item when it's the
  // same product + same box status (so the same shoe scanned in two sessions
  // shows as one line with combined sizes/quantities/VINs). Different box status
  // stays separate (boxed vs no-box are tracked apart).
  function addOrMergeItem(item) {
    setItems((arr) => {
      const i = arr.findIndex((x) => x.withBox === item.withBox && x.goatOnly === item.goatOnly && sameSku(x.sku, item.sku));
      // Newest scanned shoe shows on top (Feature 3) — prepend new lines.
      if (i === -1) return [item, ...arr];
      const sizes = arr[i].sizes.map((s) => ({ ...s, vins: [...(s.vins || [])] }));
      for (const s of item.sizes) {
        const j = sizes.findIndex((z) => z.size === s.size);
        if (j === -1) sizes.push({ key: cartKey++, size: s.size, qty: s.qty, vins: s.vins || [] });
        else { sizes[j].qty += s.qty; sizes[j].vins = [...sizes[j].vins, ...(s.vins || [])]; }
      }
      // Float the just-touched shoe to the top too (most recently scanned).
      const updated = { ...arr[i], sizes };
      return [updated, ...arr.filter((_, idx) => idx !== i)];
    });
  }
  async function completeItem() {
    setMBusy(true);
    try {
      const item = await buildItemFromDraft(draftRef.current);
      if (!item) return;
      addOrMergeItem(item);
      closeAddItem();
    } finally { setMBusy(false); }
  }
  async function confirmSwitch() {
    setMBusy(true);
    try {
      const item = await buildItemFromDraft(draftRef.current);
      if (!item) return; // current invalid — keep editing it (prompt stays)
      addOrMergeItem(item);
      const next = pendingSwitch; setPendingSwitch(null);
      const rows = next.scannedSize ? [{ key: cartKey++, size: next.scannedSize, qty: 1 }] : [];
      setDraft({ ...next, withBox: true, rows });
      setFlash({ type: 'added', text: `✓ ${next.name || ''}` });
    } finally { setMBusy(false); }
  }

  // Draft size-row helpers (manual add / steppers / remove).
  const setDraftRows = (fn) => setDraft((d) => (d ? { ...d, rows: fn(d.rows) } : d));
  const addDraftSize = (size) => { if (size) setDraftRows((rows) => (rows.some((r) => r.size === size) ? rows : [...rows, { key: cartKey++, size, qty: 1 }])); };
  const addCustomSize = () => setDraftRows((rows) => [...rows, { key: cartKey++, size: '', qty: 1 }]);
  const bumpRow = (key, delta) => setDraftRows((rows) => rows.map((r) => (r.key === key ? { ...r, qty: Math.max(1, (Number(r.qty) || 1) + delta) } : r)));
  const setRowQty = (key, v) => setDraftRows((rows) => rows.map((r) => (r.key === key ? { ...r, qty: v } : r)));
  const setRowSize = (key, v) => setDraftRows((rows) => rows.map((r) => (r.key === key ? { ...r, size: v } : r)));
  const removeDraftRow = (key) => setDraftRows((rows) => rows.filter((r) => r.key !== key));

  const removeItem = (key) => setItems((arr) => arr.filter((i) => i.key !== key));

  // ---- Rescale: existing-unit (VIN) helpers ----
  // The new status to apply to a rescanned unit: a preset key, or the typed
  // custom tag when "Custom tag…" is chosen. Empty until the user picks one.
  const effRescaleStatus = (r) => (r.statusSel === '__custom__' ? String(r.custom || '').trim() : r.statusSel);
  const setRescannedStatus = (key, statusSel) => setRescanned((arr) => arr.map((r) => (r.key === key ? { ...r, statusSel } : r)));
  const setRescannedCustom = (key, custom) => setRescanned((arr) => arr.map((r) => (r.key === key ? { ...r, custom } : r)));
  const removeRescanned = (key) => setRescanned((arr) => arr.filter((r) => r.key !== key));

  // Tracking photo → barcode decode (zxing) → OCR digits (Tesseract) fallback.
  async function onTrackingFile(e) {
    const file = e.target.files?.[0]; if (e.target) e.target.value = '';
    if (!file) return;
    setOcrBusy(true); setError('');
    try {
      const { decodeTrackingImage } = await import('../trackingOcr.js');
      const { value } = await decodeTrackingImage(file);
      const parsed = parseTrackingNumber(value);
      if (parsed) setH('tracking', parsed);
      else setError('Could not read a tracking number from that photo — type it in.');
    } catch {
      setError('Could not read the photo — type the tracking number in.');
    } finally { setOcrBusy(false); }
  }

  const addIssue = () => setIssues((is) => [...is, { key: cartKey++, type: 'mismatched', description: '', expectedCount: '', receivedCount: '' }]);
  const updateIssue = (key, patch) => setIssues((is) => is.map((i) => (i.key === key ? { ...i, ...patch } : i)));
  const removeIssue = (key) => setIssues((is) => is.filter((i) => i.key !== key));

  const defaultCostNum = header.defaultCost === '' ? null : Number(header.defaultCost);
  // V6 Feature 7: expected boxes > 1 starts an OPEN multi-box batch up front
  // (isMultiBoxNew, see the box list above); box-mode adds a box to an existing one.
  // qty 0 counts as 0 units (PO-manifest shortage) — matches doCommit's expansion.
  // Scan-intake rows are always ≥1, so this is unchanged there.
  const itemUnits = (i) => i.sizes.reduce((a, r) => a + Math.max(0, Number(r.qty) || 0), 0);
  const totalItems = items.reduce((s, i) => s + itemUnits(i), 0);
  // Pairs this label was supposed to hold — the denominator of the "x of y checked"
  // progress on the PO checklist (overage rows have no expectation, so they're excluded).
  const manifestExpected = items.reduce((s, i) => s + i.sizes.reduce((a, r) => a + (Number(r.expectedQty) || 0), 0), 0);
  const totalCost = (defaultCostNum || 0) * totalItems;
  const rescaledCount = rescanned.length; // existing units re-scanned by VIN (rescale only)

  // Rescale finish: allow new stock and/or rescanned VINs, and require a status
  // on every rescanned unit (the warehouse picks it — no auto-default).
  function startRescaleFinish() {
    setError('');
    if (!items.length && !rescanned.length) { setError('Scan at least one item or VIN.'); return; }
    if (rescanned.some((r) => !effRescaleStatus(r))) { setError('Pick a status for every rescanned unit.'); return; }
    setShowConfirm(true);
  }
  // Shoes received without a box are auto-listed as shipment issues: "SKU Size — No box".
  const autoIssues = items.filter((i) => !i.withBox)
    .flatMap((i) => i.sizes.map((s) => ({ key: `auto-${i.key}-${s.key}`, description: `${i.sku || '?'} ${s.size} — No box` })));

  // Multi-box: the open batch is created lazily on the first box commit
  // (see doCommit). Returns the batch { id, batchCode }, creating it if needed.
  async function ensureBatch() {
    if (activeBatch) return activeBatch;
    const created = await api.createOpenBatch({
      ...header, origin: effectiveOrigin, defaultCost: defaultCostNum,
      batchTag: header.batchTag, expectedBoxes: expectedBoxesNum,
      poId: receivingPo?.po?.id ?? null,
    });
    const b = { id: created.id, batchCode: created.batchCode };
    setActiveBatch(b);
    return b;
  }
  // Persist box slots that have a tracking # scanned so tracking-only (0-item)
  // boxes still show on the Batch page — not just committed ones. We only sync
  // slots that carry a tracking number (blank slots stay unmaterialized so the
  // "Add box" flow's next-number logic isn't thrown off); committed boxes persist
  // their own tracking on commit. Best-effort; only meaningful once the batch exists.
  async function persistBoxSlots(batchId, slots = boxSlots) {
    if (!batchId) return;
    const payload = slots
      .map((s, i) => ({ boxNumber: i + 1, trackingNumber: (s.tracking || '').trim() }))
      .filter((x) => x.trackingNumber);
    if (!payload.length) return;
    try { await api.batchSyncBoxes(batchId, payload); }
    catch { /* non-blocking — slots also persist on box commit */ }
  }
  // Start scanning items into box slot i (→ Items step). Details are validated
  // here so the batch can be created with them on the first commit.
  function openBoxSlot(i) {
    setError('');
    if (!activeBatch) {
      if (!String(header.supplier).trim()) { setError('Select a supplier first.'); return; }
      if (!String(header.buyer).trim()) { setError('Enter the buyer first.'); return; }
      if (!String(header.dateReceived).trim()) { setError('Enter the date first.'); return; }
    }
    setActiveSlot(i); setDraft(null);
    setItems(isPoReceive ? buildManifestItems(boxSlots[i]?.poBoxId) : []);
    setIssues([]); setUnitIssues({}); setRescanned([]);
    emptyBoxAck.current = false;
    setStep(2);
  }
  // Leave the current box's scan and go back to the box list on step 1 (discards
  // the in-progress, uncommitted draft for that box).
  function backToBoxList() {
    setActiveSlot(null); setStep(1);
    setItems([]); setIssues([]); setUnitIssues({}); setDraft(null);
    emptyBoxAck.current = false;
  }
  async function finishBatchNow() {
    if (!activeBatch) return;
    setCommitting(true);
    try {
      await persistBoxSlots(activeBatch.id);
      const res = await api.batchSetStatus(activeBatch.id, 'done');
      // Don't navigate away on a discrepancy — hold them here to say the PO came up
      // short, since this is the last moment they're guaranteed to be looking.
      if (res?.reconcile) { setResult({ batchCode: activeBatch.batchCode, finishOnly: true, reconcile: res.reconcile }); return; }
      onBatchDone ? onBatchDone() : onHome?.();
    } catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setCommitting(false); }
  }

  function goStep2() {
    setError('');
    // Box-mode inherits supplier/buyer/date from the batch — only the box tracking matters.
    if (!noShipment && !isBoxMode && !String(header.supplier).trim()) { setError('Select a supplier.'); return; }
    if (!noShipment && !isBoxMode && !String(header.buyer).trim()) { setError('Enter the buyer.'); return; }
    if (!noShipment && !isBoxMode && !String(header.dateReceived).trim()) { setError('Enter the date.'); return; }
    if (isRescale && header.origin === 'other' && !String(header.originOther).trim()) { setError('Enter a custom reason.'); return; }
    setStep(2);
  }
  async function goStep3() {
    setError('');
    if (!items.length) { setError('Add at least one item first.'); return; }
    // The PO checklist now starts fully unchecked, so "nothing ticked" is also what an
    // untouched screen looks like. Say so once before letting it through — an empty box
    // IS a legitimate outcome (the whole label came up short), just never a silent one.
    if (isPoReceive && totalItems === 0 && !emptyBoxAck.current) {
      emptyBoxAck.current = true;
      setError(`Nothing is checked off — tick each pair as you pull it from the box. If this label really arrived empty, press Review again to record all ${manifestExpected} pair${manifestExpected === 1 ? '' : 's'} as short.`);
      return;
    }
    // PO-manifest: reserve VINs for the received units so each shoe is flaggable.
    if (isPoReceive && !(await ensureManifestVins())) return;
    setStep(3);  // Review
  }
  function goStep4() { setError(''); setStep(4); } // Issues (shipment-level)

  async function doCommit() {
    setCommitting(true);
    try {
      let batchRes = null;
      // Expand each shoe's size rows into individual physical items (qty N → N VINs).
      const out = [];
      for (const it of items) {
        for (const r of it.sizes) {
          // qty 0 → 0 units (a PO-manifest shortage / unchecked size). The scan
          // flow's steppers are always ≥1, so this is unchanged for normal intake.
          for (let n = 0; n < Math.max(0, Number(r.qty) || 0); n++) {
            out.push({ name: it.name, sku: it.sku, size: r.size, upc: it.upc, image: it.image, source: it.source, gender: it.gender, colorway: it.colorway, cost: defaultCostNum, withBox: it.withBox, goatOnly: it.goatOnly, vin: r.vins?.[n] || null });
          }
        }
      }
      const flatUnitIssues = Object.entries(unitIssues)
        .flatMap(([vin, arr]) => arr.map((x) => ({ vin, type: x.type, note: x.note, photos: x.photos })));

      // --- Multi-box (V6 Feature 7): commit a BOX, not a whole batch ---------
      if (isBoxMode || isMultiBoxNew) {
        // Box-mode adds to the batch passed in; the in-receiving builder creates
        // the open batch lazily on the first box commit, then commits each box
        // with the slot's tracking + a stable box number (out-of-order safe).
        const batch = isBoxMode
          ? { id: batchContext.id, batchCode: batchContext.batch_code }
          : await ensureBatch();
        const batchId = batch.id;
        const batchCode = batch.batchCode;
        // Materialize every box slot (incl. empty / tracking-only ones) so they all
        // show on the Batch page — do this before adding the active box below.
        if (isMultiBoxNew) await persistBoxSlots(batchId);
        const boxTracking = isBoxMode
          ? (header.tracking || null)
          : (boxSlots[activeSlot]?.tracking?.trim() || null);
        const boxNumber = isBoxMode ? null : activeSlot + 1;
        const { box } = await api.batchAddBox(batchId, boxTracking, boxNumber);
        const res = await api.boxCommit({
          batchId, boxId: box.id, items: out, unitIssues: flatUnitIssues,
          issues: [
            ...autoIssues.map((a) => ({ type: 'no_box', description: a.description })),
            ...issues.map((i) => ({
              type: i.type, description: i.description,
              expectedCount: i.expectedCount === '' ? null : Number(i.expectedCount),
              receivedCount: i.receivedCount === '' ? null : Number(i.receivedCount),
            })),
          ],
        });
        setShowConfirm(false);
        const printItems = (res.vins || []).map((vin, i) => ({
          vin, name: out[i]?.name, sku: out[i]?.sku, size: out[i]?.size,
          upc: out[i]?.upc, colorway: out[i]?.colorway, gender: out[i]?.gender, withBox: out[i]?.withBox,
        }));
        setItems([]); setIssues([]); setRescanned([]); setUnitIssues({});
        if (isMultiBoxNew) {
          // Mark the slot received and drop back to the box list (step 1) to do the next.
          setBoxSlots((slots) => slots.map((s, idx) => (idx === activeSlot
            ? { ...s, status: 'received', boxNumber: box.box_number, itemCount: res.count || 0 } : s)));
          setActiveSlot(null); setStep(1);
          setResult({ batchCode, newCount: res.count || 0, rescaledCount: 0, vins: res.vins || [], printItems, boxCommit: true, inBatchList: true, autoCompleted: res.autoCompleted, reconcile: res.reconcile });
        } else {
          setStep(1);
          setResult({ batchCode, newCount: res.count || 0, rescaledCount: 0, vins: res.vins || [], printItems, boxCommit: true, autoCompleted: res.autoCompleted, reconcile: res.reconcile });
        }
        return;
      }

      // --- Single batch (existing flow): commit a whole batch ---------------
      if (items.length) {
        const payload = {
          kind: mode,
          poId: receivingPo?.po?.id ?? null,
          batch: { ...header, origin: effectiveOrigin, defaultCost: defaultCostNum, duplicateOf: dupBatch?.id ?? null },
          items: out,
          unitIssues: flatUnitIssues,
          issues: isRescale ? [] : [
            ...autoIssues.map((a) => ({ type: 'no_box', description: a.description })),
            ...issues.map((i) => ({
              type: i.type, description: i.description,
              expectedCount: i.expectedCount === '' ? null : Number(i.expectedCount),
              receivedCount: i.receivedCount === '' ? null : Number(i.receivedCount),
            })),
          ],
        };
        batchRes = await api.batchCommit(payload);
      }

      // Rescale: existing units scanned by VIN → update each item's OWN history
      // (a 'rescaled' event + the picked status). No new VIN is minted.
      let rescaledDone = 0;
      if (isRescale && rescanned.length) {
        const reasonLabel = header.origin === 'other'
          ? effectiveOrigin
          : (RESCALE_REASONS.find(([v]) => v === header.origin)?.[1] || effectiveOrigin);
        for (const r of rescanned) {
          await api.rescaleItem(r.vin, effRescaleStatus(r), undefined, reasonLabel);
          rescaledDone++;
        }
      }

      setShowConfirm(false);
      const printItems = (batchRes?.vins || []).map((vin, i) => ({
        vin, name: out[i]?.name, sku: out[i]?.sku, size: out[i]?.size,
        upc: out[i]?.upc, colorway: out[i]?.colorway, gender: out[i]?.gender, withBox: out[i]?.withBox,
      }));
      setResult({
        batchCode: batchRes?.batchCode || null,
        newCount: batchRes?.count || 0,
        rescaledCount: rescaledDone,
        vins: batchRes?.vins || [],
        printItems,
        reconcile: batchRes?.reconcile || null,
      });
      setItems([]); setIssues([]); setRescanned([]); setUnitIssues({}); setStep(1);
      setHeader((h) => ({ ...h, tracking: '', notes: '', specialRules: '' })); // keep buyer/supplier/date/cost
    } catch (err) {
      setShowConfirm(false);
      if (err.unauthorized) return onSignOut();
      setError(err.message);
    } finally {
      setCommitting(false);
    }
  }

  return (
    <div className="app">
      <TopBar
        title={isRescale ? 'Rescale Stock' : isInstore ? 'In-Store Buying' : isBoxMode ? 'Add box' : 'Receiving'}
        onHome={onHome}
        onSignOut={onSignOut}
        right={<button className="btn ghost sm" onClick={() => setShowPrefs(true)} title="Preferences"><Icon name="gear" /></button>}
      />

      <div className="tabs auth-tabs">
        <button className={`tab ${tab === 'intake' ? 'active' : ''}`} onClick={() => setTab('intake')}>{isRescale ? 'New Rescale' : isInstore ? 'New Trip' : 'New Batch'}</button>
        <button className={`tab ${tab === 'recent' ? 'active' : ''}`} onClick={() => setTab('recent')}>Recent</button>
      </div>

      {tab === 'recent' ? <BatchList kind={mode} onOpenItem={onOpenItem} onSignOut={onSignOut} /> : (
        <>
          {/* Stepper */}
          <div className="wizard-steps">
            {(isRescale ? [[1, 'Details'], [2, 'Items']]
              : [[1, isInstore ? 'Store' : isMultiBoxNew ? 'Boxes' : 'Shipment'], [2, 'Items'], [3, 'Review'], [4, 'Issues']]).map(([n, label]) => (
              <button key={n} type="button" className={`wstep ${step === n ? 'active' : ''} ${step > n ? 'done' : ''}`}
                onClick={() => { if (n < step) { if (n === 1 && isMultiBoxNew && activeSlot != null) backToBoxList(); else setStep(n); } }}>
                <span className="wstep-num">{step > n ? '✓' : n}</span><span className="wstep-label">{label}</span>
              </button>
            ))}
          </div>

          {step === 1 && (
            <>
              <div className="card">
                <h3 className="rows-title">{isRescale ? 'Rescale details' : isInstore ? 'In-store trip' : isBoxMode ? 'Add a box' : 'Shipment details'}</h3>
                {isBoxMode && (
                  <div className="box-context">
                    Adding a box to <b>{batchContext.batch_code}</b>{batchContext.batch_tag ? <> · <Icon name="tag" /> {batchContext.batch_tag}</> : ''} · {batchContext.supplier_name || '—'}
                  </div>
                )}
                <div className="batch-form">
                  {/* PO Phase 2: receive against a purchase order (receiving mode only). */}
                  {!noShipment && !isBoxMode && (
                    <div className="batch-form-wide po-receive">
                      {receivingPo ? (
                        <div className="po-receive-banner">
                          <div>
                            <b>Receiving against {receivingPo.po.po_code}</b>
                            <span className="muted sm"> · {receivingPo.po.supplier_name} · {receivingPo.boxes.length} label{receivingPo.boxes.length === 1 ? '' : 's'} · {(receivingPo.lines || []).reduce((n, l) => n + (l.qty_expected || 0), 0)} expected units</span>
                          </div>
                          <button type="button" className="btn sm ghost" onClick={clearPo}>Unlink</button>
                          {/* Print what the supplier says is in the boxes BEFORE unpacking, so
                              pairs can be ticked off on paper as they come out. Per box = a page
                              per label, which is the one you carry to the pallet. */}
                          <ManifestPrint poId={receivingPo.po.id} poCode={receivingPo.po.po_code}
                            label="Print manifest:" onSignOut={onSignOut} />
                        </div>
                      ) : (
                        <>
                          <button type="button" className="btn ghost po-receive-btn" onClick={() => setShowPoPicker(true)}>
                            <Icon name="box" /> Receive against a purchase order
                          </button>
                          {poSuggest && (
                            <div className="po-suggest">
                              <span className="po-suggest-text">Tracking <b>{poSuggest.tracking}</b> matches <b>{poSuggest.code}</b> · {poSuggest.data.po.supplier_name}.</span>
                              <div className="po-suggest-acts">
                                <button type="button" className="btn sm primary" onClick={() => { applyPo(poSuggest.data); setPoSuggest(null); }}>Receive against {poSuggest.code}</button>
                                <button type="button" className="btn sm ghost" onClick={() => { poSuggestDismiss.current.add(poSuggest.tracking); setPoSuggest(null); }}>No, plain receive</button>
                              </div>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}
                  {!noShipment && !isBoxMode && <label>Buyer *<input value={header.buyer} onChange={(e) => setH('buyer', e.target.value)} /></label>}
                  {!noShipment && !isBoxMode && (
                    <label>Supplier *
                      <select
                        value={header.supplier}
                        onChange={(e) => {
                          const v = e.target.value;
                          if (v === '__add__') { setNewSupplier(''); setShowAddSupplier(true); } // open the add-supplier modal
                          else setH('supplier', v);
                        }}
                      >
                        <option value="">Select supplier…</option>
                        {supplierOptions.map((s) => <option key={s} value={s}>{s}</option>)}
                        <option value="__add__">+ Add new supplier name</option>
                      </select>
                    </label>
                  )}
                  {/* Single-box / box-mode: one tracking # here. Multi-box enters
                      a tracking # per box on the box list (next screen). */}
                  {!noShipment && !isMultiBoxNew && (
                    <label>Tracking #
                      <span className="track-field">
                        <input value={header.tracking} onChange={(e) => setH('tracking', e.target.value)} placeholder="Type, scan, or upload a photo" />
                        <button type="button" className="btn sm ghost" title="Scan tracking barcode" onClick={() => { setTrackingSlot(null); setScanTracking(true); }}><Icon name="camera" /></button>
                        <button type="button" className="btn sm ghost" title="Upload / snap a label photo" onClick={() => fileRef.current?.click()} disabled={ocrBusy}>{ocrBusy ? '…' : <Icon name="image" />}</button>
                      </span>
                    </label>
                  )}
                  {!noShipment && !isMultiBoxNew && dupBatch && (
                    <div className="batch-form-wide dup-warn">
                      ⚠ This tracking number was already received in <b>{dupBatch.code}</b>. You can still proceed — this batch will be flagged as a duplicate.
                    </div>
                  )}
                  {isRescale && (
                    <label>Reason / origin *
                      <select value={header.origin} onChange={(e) => setH('origin', e.target.value)}>
                        {RESCALE_REASONS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                      </select>
                    </label>
                  )}
                  {isRescale && header.origin === 'other' && (
                    <label>Custom reason *
                      <input value={header.originOther} placeholder="Describe the reason"
                        maxLength={80} onChange={(e) => setH('originOther', e.target.value)} />
                    </label>
                  )}
                  {isInstore && (
                    <label>Store / location
                      <input value={header.origin} maxLength={80} placeholder="e.g. Nike Outlet — Lancaster"
                        onChange={(e) => setH('origin', e.target.value)} />
                    </label>
                  )}
                  {!isBoxMode && <label>{isInstore ? 'Date' : isRescale ? 'Date *' : 'Date received *'}<input type="date" value={header.dateReceived} onChange={(e) => setH('dateReceived', e.target.value)} /></label>}
                  {!isBoxMode && <label>Default cost ($)<input type="number" min="0" step="0.01" value={header.defaultCost} onChange={(e) => setH('defaultCost', e.target.value)} /></label>}
                  {!noShipment && !isBoxMode && (
                    <label>Boxes expected
                      <input type="number" inputMode="numeric" min="1" step="1" value={header.expectedBoxes}
                        onChange={(e) => setH('expectedBoxes', e.target.value)} title="More than 1 starts a multi-box batch you add boxes to from the Batch Page" />
                    </label>
                  )}
                  {!noShipment && !isBoxMode && expectedBoxesNum > 1 && (
                    <label className="batch-form-wide">Batch tag<input value={header.batchTag} maxLength={120}
                      placeholder="Code on the shipping label (e.g. Joey JP23 AJ40)" onChange={(e) => setH('batchTag', e.target.value)} /></label>
                  )}
                  {!noShipment && !isBoxMode && <label className="batch-form-wide">Special rules<input value={header.specialRules} onChange={(e) => setH('specialRules', e.target.value)} /></label>}
                  {!isBoxMode && <label className="batch-form-wide">Notes<input value={header.notes} onChange={(e) => setH('notes', e.target.value)} /></label>}
                </div>
                {!noShipment && !isBoxMode && expectedBoxesNum > 1 && (
                  <p className="muted sm">This is an <b>open multi-box batch</b>. Enter each box's tracking # below and tap <b>Add items</b> — do them in any order. Progress is saved as you submit each box; finish later from the <b>Batches</b> page.</p>
                )}
              </div>

              {/* Multi-box: per-box tracking + Add items, inline on this page */}
              {isMultiBoxNew && (
                <div className="card">
                  <div className="step-head">
                    <h3 className="rows-title">Boxes <span className="muted">({receivedSlots}/{boxSlots.length})</span></h3>
                    {activeBatch && <span className="muted sm">{activeBatch.batchCode} <span className="badge open">Open</span></span>}
                  </div>
                  <div className="progress-bar"><span style={{ width: `${Math.round((receivedSlots / Math.max(1, boxSlots.length)) * 100)}%` }} /></div>
                  <div className="box-build-list">
                    {boxSlots.map((s, i) => (
                      <div className={`box-build-row ${s.status}`} key={i}>
                        <span className="box-num">Box {i + 1}</span>
                        {s.status === 'received' ? (
                          <>
                            <span className="box-track muted sm">{s.tracking || '—'}</span>
                            <span className="box-count">{s.itemCount} item{s.itemCount === 1 ? '' : 's'}</span>
                            <span className="box-status received">✓ received</span>
                          </>
                        ) : (
                          <>
                            <span className="track-field box-build-track">
                              <input value={s.tracking} placeholder="Tracking # (optional)" onChange={(e) => setSlotTracking(i, e.target.value)}
                                onBlur={() => { if (activeBatch) persistBoxSlots(activeBatch.id); }} />
                              <button type="button" className="btn sm ghost" title="Scan tracking barcode" onClick={() => { setTrackingSlot(i); setScanTracking(true); }}><Icon name="camera" /></button>
                            </span>
                            <button className="btn primary sm" onClick={() => openBoxSlot(i)}>Add items</button>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {error && <div className="error mt">{error}</div>}
              <div className="batch-bar">
                {isMultiBoxNew ? (
                  <>
                    <span className="muted sm">{receivedSlots}/{boxSlots.length} boxes received</span>
                    <button className="btn primary" disabled={committing || !activeBatch} onClick={finishBatchNow}
                      title={!activeBatch ? 'Submit at least one box first' : ''}>{committing ? 'Finishing…' : 'Finish batch'}</button>
                  </>
                ) : (
                  <>
                    <span className="muted sm">Step 1 of {isRescale ? 2 : 4}</span>
                    <button className="btn primary" onClick={goStep2}>Next →</button>
                  </>
                )}
              </div>
            </>
          )}

          {step === 2 && (
            <>
              {isMultiBoxNew && activeSlot != null && (
                <div className="box-context">
                  Scanning <b>Box {activeSlot + 1}</b> of {boxSlots.length} · {activeBatch?.batchCode}
                  {boxSlots[activeSlot]?.tracking ? <> · <Icon name="tag" /> {boxSlots[activeSlot].tracking}</> : ''}
                </div>
              )}
              {isPoReceive && activeSlot != null ? (
                <ManifestChecklist boxNumber={activeSlot + 1} tracking={boxSlots[activeSlot]?.tracking}
                  items={items} totalItems={totalItems} expectedUnits={manifestExpected} onAddUnexpected={openAddItem}
                  onSetQty={setSizeQty} onRemoveSize={removeSizeRow} onRemoveItem={removeItem} />
              ) : (
              <div className="card">
                <div className="step-head">
                  <h3 className="rows-title">{isRescale ? 'New / unlabeled stock' : 'Items'} <span className="muted">({totalItems} unit{totalItems === 1 ? '' : 's'})</span></h3>
                  <button className="btn primary sm" onClick={openAddItem}>+ Add Item</button>
                </div>
                {!items.length ? <p className="muted">{isRescale ? 'No new stock — scan a UPC/SKU here for unlabeled stock, or scan VINs below to rescan existing units.' : 'No items yet — tap “Add Item” and scan a box.'}</p> : (
                  <div className="recv-items">
                    {items.map((it) => (
                      <div className={`recv-item ${it.withBox ? '' : 'nobox'}`} key={it.key}>
                        <div className="recv-item-head">
                          {it.image ? <img className="cart-thumb" src={it.image} alt="" /> : <div className="cart-thumb placeholder">—</div>}
                          <div className="recv-item-info">
                            <div className="recv-item-title">{it.name} <span className="muted">— {it.sku || '—'}</span></div>
                            <div className="recv-item-meta">
                              <span className={`box-badge ${it.withBox ? 'yes' : 'no'}`}>{it.withBox ? <><Icon name="box" /> With box</> : <><Icon name="nobox" /> No box</>}</span>
                              {it.goatOnly && <span className="goat-badge">GOAT only</span>}
                              <span className="muted sm">{isRescale ? 'Rescale' : isInstore ? (header.origin?.trim() || 'In-store') : (header.supplier || '—')} · {defaultCostNum != null ? `$${defaultCostNum.toFixed(2)}` : 'no cost'}</span>
                            </div>
                          </div>
                          <button type="button" className="btn icon ghost remove" title="Remove item" onClick={() => removeItem(it.key)}>×</button>
                        </div>
                        <div className="recv-sizes">
                          <div className="recv-sizes-head"><span>Size</span><span>Qty · tap to see units</span></div>
                          {[...it.sizes].sort(compareSizes).map((s) => {
                            const k = `${it.key}:${s.key}`;
                            const open = openSizes.has(k);
                            return (
                              <div className="recv-size" key={s.key}>
                                <button type="button" className="recv-size-row" onClick={() => toggleSize(k)} aria-expanded={open} title="Show units / VINs">
                                  <span className="recv-caret">{open ? '▾' : '▸'}</span>
                                  <span className="recv-size-name">{s.size}</span>
                                  <span className="recv-size-qty">×{s.qty}</span>
                                </button>
                                {open && (
                                  <div className="recv-units">
                                    {Array.from({ length: Math.max(1, Number(s.qty) || 1) }, (_, i) => (
                                      <div className="recv-unit" key={i}>
                                        <span className="recv-unit-n">{i + 1}.</span>
                                        {s.vins?.[i]
                                          ? <span className="vin">{s.vins[i]}</span>
                                          : <span className="vin pending">VIN on submit</span>}
                                        {!it.withBox && <span className="recv-unit-nobox">no box — sticker carefully</span>}
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              )}

              {isRescale && (
                <div className="card">
                  <h3 className="rows-title">Rescanned existing stock <span className="muted">({rescaledCount} VIN{rescaledCount === 1 ? '' : 's'})</span></h3>
                  {!rescanned.length ? <p className="muted">Scan a VIN (gun or <Icon name="camera" /> in “Add Item”) to rescan a unit already in inventory. Each keeps its own history — no new VIN.</p> : (
                    <div className="rescan-list">
                      {rescanned.map((r) => (
                        <div className="rescan-row" key={r.key}>
                          {r.image ? <img className="cart-thumb sm" src={r.image} alt="" /> : <div className="cart-thumb sm placeholder">—</div>}
                          <div className="rescan-info">
                            <span className="vin">{r.vin}</span>
                            <span className="muted sm">{r.name || '—'} · {r.sku || '—'}{r.size ? ` · size ${r.size}` : ''}</span>
                          </div>
                          <div className="rescan-status">
                            <select value={r.statusSel} onChange={(e) => setRescannedStatus(r.key, e.target.value)}>
                              <option value="">Set status…</option>
                              {STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                              <option value="__custom__">Custom tag…</option>
                            </select>
                            {r.statusSel === '__custom__' && (
                              <input className="custom-tag-input" placeholder="Custom tag…" maxLength={40} value={r.custom} onChange={(e) => setRescannedCustom(r.key, e.target.value)} />
                            )}
                          </div>
                          <button type="button" className="btn icon ghost remove" title="Remove" onClick={() => removeRescanned(r.key)}>×</button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {error && <div className="error mt">{error}</div>}
              <div className="batch-bar">
                <button className="btn ghost" onClick={() => (isMultiBoxNew && activeSlot != null ? backToBoxList() : setStep(1))}>← {isMultiBoxNew && activeSlot != null ? 'Boxes' : 'Back'}</button>
                <div className="batch-totals"><b>{totalItems}</b> new{isRescale ? <> · <b>{rescaledCount}</b> rescanned</> : <> units · <b>${totalCost.toFixed(2)}</b></>}</div>
                {isRescale
                  ? <button className="btn primary" onClick={startRescaleFinish} disabled={committing}>Finish rescale</button>
                  : <button className="btn primary" onClick={goStep3}>Review →</button>}
              </div>
            </>
          )}

          {step === 3 && !isRescale && (
            <>
              <div className="card">
                <div className="step-head">
                  <h3 className="rows-title">Review <span className="muted">({totalItems} unit{totalItems === 1 ? '' : 's'} · {items.length} shoe{items.length === 1 ? '' : 's'})</span></h3>
                  {flaggedCount > 0 && <span className="review-flagged">⚠ {flaggedCount} flagged</span>}
                </div>
                <p className="muted sm">Check counts, fix box status, and flag any defects before submitting. Sizes are sorted smallest→largest.</p>
                {!items.length ? <p className="muted">Nothing to review — go back and add items.</p> : (
                  <div className="recv-items review">
                    {items.map((it) => (
                      <div className={`recv-item ${it.withBox ? '' : 'nobox'}`} key={it.key}>
                        <div className="recv-item-head">
                          {it.image ? <img className="cart-thumb" src={it.image} alt="" /> : <div className="cart-thumb placeholder">—</div>}
                          <div className="recv-item-info">
                            <div className="recv-item-title">{it.name} <span className="muted">— {it.sku || '—'}</span></div>
                            <div className="recv-item-toggles">
                              <div className="seg sm" role="group" aria-label="Box status">
                                <button type="button" className={`seg-btn ${it.withBox !== false ? 'on yes' : ''}`} onClick={() => setItemBox(it.key, true)}><Icon name="box" /> Box</button>
                                <button type="button" className={`seg-btn ${it.withBox === false ? 'on no' : ''}`} onClick={() => setItemBox(it.key, false)}><Icon name="nobox" /> No box</button>
                              </div>
                              <label className="goat-chip-toggle" title="List to Alias (GOAT) + Intelligent Inventory only">
                                <input type="checkbox" checked={it.goatOnly === true} onChange={(e) => setItemGoat(it.key, e.target.checked)} /> GOAT only
                              </label>
                            </div>
                          </div>
                          <button type="button" className="btn icon ghost remove" title="Delete shoe" onClick={() => removeItem(it.key)}>×</button>
                        </div>
                        <div className="recv-sizes">
                          {[...it.sizes].sort(compareSizes).map((s) => {
                            const k = `${it.key}:${s.key}`;
                            const open = openSizes.has(k);
                            return (
                              <div className="recv-size review" key={s.key}>
                                <div className="review-size-row">
                                  <button type="button" className="recv-caret-btn" onClick={() => toggleSize(k)} aria-expanded={open} title="Show units">{open ? '▾' : '▸'}</button>
                                  <span className="recv-size-name">{s.size}</span>
                                  <div className="qty-stepper sm">
                                    <button type="button" className="btn icon ghost step" onClick={() => bumpSizeQty(it.key, s.key, -1)}>−</button>
                                    <span className="qty-val">{s.qty}</span>
                                    <button type="button" className="btn icon ghost step" onClick={() => bumpSizeQty(it.key, s.key, 1)}>+</button>
                                  </div>
                                  <button type="button" className="btn icon ghost remove sm" title="Remove size" onClick={() => removeSizeRow(it.key, s.key)}>×</button>
                                </div>
                                {open && (
                                  <div className="recv-units">
                                    {Array.from({ length: Math.max(0, Number(s.qty) || 0) }, (_, i) => {
                                      const vin = s.vins?.[i];
                                      return (
                                        <div className="recv-unit" key={i}>
                                          <span className="recv-unit-n">{i + 1}.</span>
                                          {vin ? <span className="vin">{vin}</span> : <span className="vin pending">VIN on submit</span>}
                                          {!it.withBox && <span className="recv-unit-nobox">no box</span>}
                                          {vin && (
                                            <button type="button" className={`recv-unit-issue ${hasIssue(vin) ? 'flagged' : ''}`}
                                              onClick={() => setIssueEditorVin(vin)}
                                              title={hasIssue(vin) ? 'Edit defects' : 'Flag a defect'}>
                                              {hasIssue(vin) ? `⚠ ${issueCount(vin)} issue${issueCount(vin) === 1 ? '' : 's'}` : '＋ Issue'}
                                            </button>
                                          )}
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {error && <div className="error mt">{error}</div>}
              <div className="batch-bar">
                <button className="btn ghost" onClick={() => setStep(2)}>← Back</button>
                <div className="batch-totals"><b>{totalItems}</b> units · <b>${totalCost.toFixed(2)}</b>{flaggedCount ? <> · <b>{flaggedCount}</b> flagged</> : null}</div>
                <button className="btn primary" onClick={goStep4}>Next →</button>
              </div>
            </>
          )}

          {step === 4 && !isRescale && (
            <>
              <div className="card">
                <h3 className="rows-title">{isInstore ? 'Issues' : 'Shipment issues'} <span className="muted">(optional)</span></h3>
                {autoIssues.length > 0 && (
                  <div className="auto-issues">
                    <div className="muted sm">Auto-added — shoes received without a box:</div>
                    {autoIssues.map((a) => <div className="auto-issue" key={a.key}>⚠ {a.description}</div>)}
                  </div>
                )}
                {issues.map((i) => (
                  <div className="issue-row" key={i.key}>
                    <select value={i.type} onChange={(e) => updateIssue(i.key, { type: e.target.value })}>
                      {ISSUE_TYPES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                    </select>
                    {i.type === 'shortfall' && (
                      <span className="issue-counts">
                        <input type="number" min="0" placeholder="Exp" value={i.expectedCount} onChange={(e) => updateIssue(i.key, { expectedCount: e.target.value })} />
                        <input type="number" min="0" placeholder="Got" value={i.receivedCount} onChange={(e) => updateIssue(i.key, { receivedCount: e.target.value })} />
                      </span>
                    )}
                    <input placeholder="Description" value={i.description} onChange={(e) => updateIssue(i.key, { description: e.target.value })} />
                    <button type="button" className="btn icon ghost remove" onClick={() => removeIssue(i.key)}>×</button>
                  </div>
                ))}
                <button type="button" className="btn add-size" onClick={addIssue}>+ Add issue</button>
              </div>
              {error && <div className="error mt">{error}</div>}
              <div className="batch-bar">
                <button className="btn ghost" onClick={() => setStep(3)}>← Back</button>
                <div className="batch-totals"><b>{totalItems}</b> units · <b>${totalCost.toFixed(2)}</b></div>
                <button className="btn primary" onClick={() => { setError(''); if (!items.length) { setError('Add at least one item.'); return; } setShowConfirm(true); }} disabled={committing}>
                  {isBoxMode || isMultiBoxNew ? 'Submit box' : isInstore ? 'Save trip' : 'Finish batch'}
                </button>
              </div>
            </>
          )}
        </>
      )}

      {/* hidden file input — tracking label photo (OCR) */}
      <input ref={fileRef} type="file" accept="image/*" capture="environment" hidden onChange={onTrackingFile} />

      {/* Add Item modal */}
      {showAdd && (
        <div className="modal-overlay" onClick={closeAddItem}>
          <div className="modal additem" role="dialog" aria-modal="true" onClick={(e) => {
            e.stopPropagation();
            // Refocus the scan field when tapping empty modal space (keeps the gun aimed),
            // but never when the user tapped another control (size/qty/name inputs, chips) —
            // otherwise the size box can't be typed into (letters like 5C / 3Y).
            if (mCam || photoCam || e.target.closest('input, textarea, select, button, [contenteditable="true"]')) return;
            mInputRef.current?.focus({ preventScroll: true });
          }}>
            <div className="modal-head">
              <h3 className="modal-title">Add item</h3>
              <button type="button" className="btn icon ghost" onClick={closeAddItem}>×</button>
            </div>
            <form className="searchrow" onSubmit={(e) => { e.preventDefault(); reselectRef.current = true; addCode(mInput, { showInField: true }); }}>
              <input ref={mInputRef} autoFocus autoCapitalize="characters" autoCorrect="off"
                placeholder={isRescale ? 'Scan or type VIN / UPC / SKU' : 'Scan or type UPC / SKU'} value={mInput} onChange={(e) => setMInput(e.target.value)} disabled={mBusy} />
              <button className="btn primary" disabled={mBusy}>{mBusy ? '…' : 'Add'}</button>
              <button type="button" className={`btn ${mCam ? 'primary' : 'ghost'}`} onClick={() => setMCam((v) => !v)} title="Scan with camera"><Icon name="camera" /></button>
            </form>
            {mCam && (
              <Suspense fallback={<p className="muted">Loading camera…</p>}>
                <CameraScanner continuous mode={isRescale ? 'rescale' : 'product'} onDetected={(code) => addCode(code, { showInField: true })} onClose={() => setMCam(false)}
                  zoom={prefs.cameraZoom} onZoomChange={setCameraZoom} />
              </Suspense>
            )}
            <div className="scan-flash-live" role="status" aria-live="polite">
              {flash && <div className={`scan-flash ${flash.type}`}>{flash.text}</div>}
            </div>
            {mError && <div className="error sm mt">{mError}</div>}

            {isRescale && rescaledCount > 0 && (
              <p className="muted sm mt">✓ {rescaledCount} VIN{rescaledCount === 1 ? '' : 's'} rescanned — set each unit's status on the Items step.</p>
            )}
            {!draft && !mBusy && (
              <p className="muted sm mt">{isRescale
                ? 'Scan a VIN to rescan an existing unit, or a UPC/SKU for new/unlabeled stock. Re-scanning the same shoe’s boxes auto-increments by size.'
                : 'Scan a box (or type a UPC/SKU) to begin. Re-scanning the same shoe’s boxes auto-increments by size.'}</p>
            )}

            {draft && (
              // Any interaction with the draft (size chips, qty, box toggle, photos,
              // complete) closes the live barcode scanner — so it can't keep
              // detecting in the background or fight the listing-photo camera.
              <div className="additem-draft" onPointerDownCapture={() => { if (mCam) setMCam(false); }}>
                <div className="additem-product">
                  {draft.image ? <img className="cart-thumb" src={draft.image} alt="" /> : <div className="cart-thumb placeholder">—</div>}
                  <div className="cart-fields">
                    <input className="cart-name" placeholder="Product name" value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
                    <input placeholder="SKU" value={draft.sku} onChange={(e) => setDraft((d) => ({ ...d, sku: e.target.value }))} />
                  </div>
                </div>
                <div className="withbox-field">
                  <span className="withbox-q">Does this shoe have its box?</span>
                  <div className="seg" role="group" aria-label="With box?">
                    <button type="button" className={`seg-btn ${draft.withBox !== false ? 'on yes' : ''}`} aria-pressed={draft.withBox !== false} onClick={() => setDraft((d) => ({ ...d, withBox: true }))}><Icon name="box" /> With Box</button>
                    <button type="button" className={`seg-btn ${draft.withBox === false ? 'on no' : ''}`} aria-pressed={draft.withBox === false} onClick={() => setDraft((d) => ({ ...d, withBox: false }))}><Icon name="nobox" /> No Box</button>
                  </div>
                </div>
                <label className="goat-toggle">
                  <input type="checkbox" checked={draft.goatOnly === true} onChange={(e) => setDraft((d) => ({ ...d, goatOnly: e.target.checked }))} />
                  <span><b>GOAT only</b> — PH lists to Alias (GOAT) + Intelligent Inventory only (no StockX/Shopify)</span>
                </label>
                <div className="size-rows">
                  <div className="muted sm">Tap a size to add it (tap again for +1), or “+ Custom”.</div>
                  {/* One-tap size boxes — faster and clearer than a dropdown:
                      every option is visible and a single tap adds/increments. */}
                  <div className="size-chips">
                    {sizePool(draft).map((s) => (
                      <button type="button" key={s} className="size-chip" onClick={() => addDraftSize(s)}>{s}</button>
                    ))}
                    <button type="button" className="size-chip custom" onClick={addCustomSize}>+ Custom</button>
                  </div>
                  {[...draft.rows].sort(compareSizes).map((r) => (
                    <div className="size-line" key={r.key}>
                      <input className={`sz ${!String(r.size).trim() ? 'need' : ''}`} placeholder="Size" value={r.size} onChange={(e) => setRowSize(r.key, e.target.value)} autoFocus={!String(r.size).trim()} />
                      <div className="qty-stepper">
                        <button type="button" className="btn icon ghost step" onClick={() => bumpRow(r.key, -1)}>−</button>
                        <input className="qty" type="number" min="1" value={r.qty} onChange={(e) => setRowQty(r.key, e.target.value)} />
                        <button type="button" className="btn icon ghost step" onClick={() => bumpRow(r.key, 1)}>+</button>
                      </div>
                      <button type="button" className="btn icon ghost remove" title="Remove size" onClick={() => removeDraftRow(r.key)}>×</button>
                    </div>
                  ))}
                </div>
                {!noShipment && draft.sku && <ListingPhotos sku={draft.sku} onSignOut={onSignOut} onCameraToggle={setPhotoCam} />}
                <div className="modal-actions">
                  <button type="button" className="btn primary wide" onClick={completeItem}>Complete item ✓</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Different-shoe prompt (mid-scan) */}
      {pendingSwitch && (
        <div className="modal-overlay" style={{ zIndex: 130 }}>
          <div className="modal confirm" role="dialog" aria-modal="true">
            <h3 className="modal-title">Different shoe detected</h3>
            <p className="modal-msg">You scanned <b>{pendingSwitch.name || pendingSwitch.sku || 'a new item'}</b>, different from <b>{draft?.name || draft?.sku || 'the current shoe'}</b>. Finish the current shoe and start the new one?</p>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setPendingSwitch(null)}>Keep current</button>
              <button className="btn primary" onClick={confirmSwitch}>End &amp; start new</button>
            </div>
          </div>
        </div>
      )}

      {showConfirm && (
        <div className="modal-overlay">
          <div className="modal confirm" role="dialog" aria-modal="true">
            <h3 className="modal-title">{isRescale ? 'Commit this rescale?' : isInstore ? 'Save this trip?' : (isBoxMode || isMultiBoxNew) ? 'Submit this box?' : 'Commit this batch?'}</h3>
            <div className="confirm-summary">
              {isRescale
                ? (<>
                    <div><b>{rescaledCount}</b> existing VIN{rescaledCount === 1 ? '' : 's'} rescanned{totalItems ? <> · <b>{totalItems}</b> new unit{totalItems === 1 ? '' : 's'}</> : ''}</div>
                    <div className="muted">Rescale · {header.origin === 'other' ? effectiveOrigin : (RESCALE_REASONS.find(([v]) => v === header.origin)?.[1] || effectiveOrigin)} · {header.dateReceived}</div>
                    <p className="muted sm">Rescanned units keep their VIN &amp; history (a “Rescaled” event + your chosen status is added). New stock gets a fresh VIN.</p>
                  </>)
                : isInstore
                ? (<>
                    <div><b>{totalItems}</b> pair{totalItems === 1 ? '' : 's'} ({items.length} shoe{items.length === 1 ? '' : 's'}) · total <b>${totalCost.toFixed(2)}</b></div>
                    <div className="muted">In-store{header.origin?.trim() ? ` · ${header.origin.trim()}` : ''} · {header.dateReceived}</div>
                    {(autoIssues.length + issues.length) > 0 && <div className="muted">{autoIssues.length + issues.length} issue(s) recorded</div>}
                    {flaggedCount > 0 && <div className="muted">{flaggedCount} unit(s) flagged with a defect</div>}
                    <p className="muted sm">Each pair gets its own VIN and lands in inventory to shelve. In-store buys skip the PH team — list them to Alias by hand.</p>
                  </>)
                : (<>
                    <div><b>{totalItems}</b> units ({items.length} shoe{items.length === 1 ? '' : 's'}) · total <b>${totalCost.toFixed(2)}</b></div>
                    <div className="muted">Supplier: {header.supplier || '—'} · Buyer: {header.buyer || '—'}</div>
                    {isMultiBoxNew && activeSlot != null
                      ? <div className="muted">Box {activeSlot + 1} of {boxSlots.length} · Tracking: {boxSlots[activeSlot]?.tracking || '—'}</div>
                      : <div className="muted">Tracking: {header.tracking || '—'} · {header.dateReceived}</div>}
                    {(autoIssues.length + issues.length) > 0 && <div className="muted">{autoIssues.length + issues.length} issue(s) recorded</div>}
                    {flaggedCount > 0 && <div className="muted">{flaggedCount} unit(s) flagged with a defect</div>}
                    <p className="muted sm">Each unit gets its own VIN. History starts “Scanned by you”.</p>
                  </>)}
            </div>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setShowConfirm(false)} disabled={committing}>No</button>
              <button className="btn primary" onClick={doCommit} disabled={committing}>{committing ? 'Saving…' : 'Yes, commit'}</button>
            </div>
          </div>
        </div>
      )}

      {result && (
        <Modal type="success"
          title={result.finishOnly ? `${result.batchCode} finished`
            : result.boxCommit
              ? (result.autoCompleted ? `Box saved · ${result.batchCode} complete ✓` : `Box saved to ${result.batchCode}`)
              : (result.batchCode ? `Batch ${result.batchCode} saved` : 'Rescale saved')}
          message={[
            result.rescaledCount ? `${result.rescaledCount} existing unit(s) rescanned & updated.` : '',
            result.newCount ? `${result.newCount} new item(s) recorded — VINs ${result.vins?.[0]}…${result.vins?.[result.vins.length - 1]}.` : '',
            result.boxCommit && !result.autoCompleted
              ? (result.inBatchList ? 'Back to the box list to scan the next box.' : 'Add the next box from the Batches page.') : '',
          ].filter(Boolean).join(' ')}
          onClose={() => {
            if (result.finishOnly) { onBatchDone ? onBatchDone() : onHome?.(); return; }
            if (result.inBatchList) { if (result.autoCompleted) (onBatchDone ? onBatchDone() : onHome?.()); else setResult(null); }
            else if (result.boxCommit) onBatchDone?.();
            else setResult(null);
          }}>
          {/* The PO didn't add up. Say it here — this is the last moment the person who
              received it is guaranteed to be looking, and a shortage needs someone to
              message the supplier today. Either team can pick it up from the report. */}
          {result.reconcile && <ReconcileAlert rc={result.reconcile} onOpen={onOpenReconcile} />}
          {result.printItems?.length > 0 && (
            <button className="btn primary" onClick={() => setPrintLabels({ batchCode: result.batchCode, items: result.printItems })}><Icon name="print" /> Print labels</button>
          )}
          {result.finishOnly
            ? <button className="btn ghost" onClick={() => (onBatchDone ? onBatchDone() : onHome?.())}>Done</button>
            : result.inBatchList
              ? (result.autoCompleted
                  ? <button className="btn ghost" onClick={() => (onBatchDone ? onBatchDone() : onHome?.())}>Done</button>
                  : <button className="btn ghost" onClick={() => setResult(null)}>← Box list</button>)
              : result.boxCommit
                ? <button className="btn ghost" onClick={() => onBatchDone?.()}>← Back to Batches</button>
                : <button className="btn ghost" onClick={() => setResult(null)}>Start another</button>}
        </Modal>
      )}

      {printLabels && <LabelSheet batchCode={printLabels.batchCode} items={printLabels.items} onClose={() => setPrintLabels(null)} />}

      {scanTracking && (
        <div className="modal-overlay" onClick={() => { setScanTracking(false); setTrackingSlot(null); }}>
          <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Scan tracking barcode{trackingSlot != null ? ` · Box ${trackingSlot + 1}` : ''}</h3>
            <Suspense fallback={<p className="muted">Loading camera…</p>}>
              <CameraScanner mode="tracking"
                onDetected={(code) => {
                  const t = parseTrackingNumber(code);
                  if (trackingSlot != null) {
                    setSlotTracking(trackingSlot, t);
                    if (activeBatch) persistBoxSlots(activeBatch.id, boxSlots.map((x, idx) => (idx === trackingSlot ? { ...x, tracking: t } : x)));
                  } else setH('tracking', t);
                  setScanTracking(false); setTrackingSlot(null);
                  // Drop focus after the scanner closes. Otherwise iOS leaves the
                  // tracking field DOM-focused with the keyboard suppressed (blue ring
                  // + accessory bar, no keys); the next tap on that already-focused
                  // field then won't raise the keyboard. Blurring makes a later tap a
                  // clean gesture that does.
                  setTimeout(() => document.activeElement?.blur?.(), 0);
                }}
                onClose={() => { setScanTracking(false); setTrackingSlot(null); setTimeout(() => document.activeElement?.blur?.(), 0); }}
                zoom={prefs.cameraZoom} onZoomChange={setCameraZoom} />
            </Suspense>
            <div className="modal-actions"><button className="btn ghost" onClick={() => { setScanTracking(false); setTrackingSlot(null); }}>Cancel</button></div>
          </div>
        </div>
      )}

      {issueEditorVin && (
        <div className="modal-overlay" onClick={closeIssueEditor}>
          <div className="modal additem" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3 className="modal-title">Defects · <span className="vin">{issueEditorVin}</span></h3>
              <button type="button" className="btn icon ghost" onClick={closeIssueEditor}>×</button>
            </div>
            {getIssues(issueEditorVin).length === 0 && (
              <p className="muted sm">No defects yet. Add one — pick a type, add a note and photos if useful.</p>
            )}
            {getIssues(issueEditorVin).map((iss) => (
              <div className="defect-issue" key={iss.key}>
                <div className="defect-issue-head">
                  <select value={iss.type} onChange={(e) => updateUnitIssue(issueEditorVin, iss.key, { type: e.target.value })}>
                    {DEFECT_TYPES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                  </select>
                  <button type="button" className="btn icon ghost remove" title="Remove defect" onClick={() => removeUnitIssue(issueEditorVin, iss.key)}>×</button>
                </div>
                <input className="defect-note" maxLength={500} placeholder="Note (optional) — e.g. crease on left toe"
                  value={iss.note} onChange={(e) => updateUnitIssue(issueEditorVin, iss.key, { note: e.target.value })} />
                <DefectPhotos
                  vin={issueEditorVin}
                  photos={iss.photos}
                  onChange={(photos) => updateUnitIssue(issueEditorVin, iss.key, { photos })}
                  onSignOut={onSignOut} />
              </div>
            ))}
            <button type="button" className="btn add-size" onClick={() => addUnitIssue(issueEditorVin)}>+ Add defect</button>
            <div className="modal-actions">
              <button type="button" className="btn primary wide" onClick={closeIssueEditor}>Done</button>
            </div>
          </div>
        </div>
      )}

      {showPoPicker && (
        <PoPickerModal onPick={applyPo} onClose={() => setShowPoPicker(false)} onSignOut={onSignOut} />
      )}

      {showAddSupplier && (
        <div className="modal-overlay" onClick={() => setShowAddSupplier(false)}>
          <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Add new supplier</h3>
            <form onSubmit={(e) => { e.preventDefault(); saveNewSupplier(); }}>
              <label>Supplier name
                {/* No autoFocus: on iOS a programmatic focus() sets DOM focus but
                    Safari suppresses the software keyboard, so tapping the (already
                    "focused") field then does nothing. Leaving it unfocused makes the
                    user's tap a clean gesture that reliably raises the keyboard. */}
                <input value={newSupplier} maxLength={80} placeholder="e.g. JD Sports"
                  onChange={(e) => setNewSupplier(e.target.value)} />
              </label>
              <p className="muted sm mt">Added to the list and selected for this batch — saved for next time when you commit.</p>
              <div className="modal-actions">
                <button type="button" className="btn ghost" onClick={() => setShowAddSupplier(false)}>Cancel</button>
                <button type="submit" className="btn primary" disabled={!newSupplier.trim()}>Add supplier</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showPrefs && <PreferencesModal prefs={prefs} onCameraZoom={setCameraZoom} onClose={() => setShowPrefs(false)} />}
    </div>
  );
}

/* PO Phase 2b: receive one box by its manifest. The expected lines are listed but
   every size starts UNCHECKED — tick each pair as it comes out of the box, so the
   list is the picking guide and whatever stays unticked is the shortage. Adjust the
   "got" count for a partial, add unexpected pairs (overage), then Review → per-shoe
   issues → submit the box. */
function ManifestChecklist({ boxNumber, tracking, items, totalItems, expectedUnits, onAddUnexpected, onSetQty, onRemoveSize, onRemoveItem }) {
  const done = expectedUnits > 0 && totalItems >= expectedUnits;
  return (
    <div className="card po-manifest">
      <div className="step-head">
        <h3 className="rows-title">
          Box {boxNumber} · manifest{' '}
          <span className={`po-manifest-progress ${done ? 'done' : ''}`}>
            {totalItems} of {expectedUnits} checked
          </span>
        </h3>
        <button className="btn sm" onClick={onAddUnexpected}>+ Add unexpected</button>
      </div>
      {tracking ? <div className="muted sm po-manifest-track"><Icon name="tag" /> {tracking}</div> : null}
      {items.length === 0 ? (
        <p className="muted">This label had no expected items. Use “Add unexpected” for anything found in the box.</p>
      ) : (
        <div className="po-manifest-list">
          {items.map((it) => (
            <div className={`po-manifest-item ${it.expected ? '' : 'overage'}`} key={it.key}>
              <div className="po-manifest-head">
                <span className="po-manifest-name">{it.name} <span className="muted">— {it.sku || '—'}</span></span>
                {it.expected
                  ? null
                  : <span className="po-chip receiving">Overage · not on PO</span>}
                {!it.expected && <button type="button" className="btn icon ghost remove" title="Remove" onClick={() => onRemoveItem(it.key)}>×</button>}
              </div>
              {[...it.sizes].sort((a, b) => compareSizes(a.size, b.size)).map((s) => {
                const got = Number(s.qty) || 0;
                const exp = s.expectedQty;
                // An untouched row isn't a shortage yet, it's just not pulled — the red
                // "short" flag is reserved for a partial (some pulled, but fewer than
                // expected), or it would scream on every row the moment the box opens.
                const pending = exp != null && exp > 0 && got === 0;
                const short = exp != null && got > 0 && got < exp;
                const over = exp != null && got > exp;
                return (
                  <div className={`po-manifest-size ${got > 0 ? 'on' : 'off'}`} key={s.key}>
                    <label className="po-check">
                      <input type="checkbox" checked={got > 0}
                        onChange={(e) => onSetQty(it.key, s.key, e.target.checked ? (exp ?? 1) : 0)} />
                      <span className="po-size-lbl">size {s.size}{exp != null ? <span className="muted"> · exp {exp}</span> : null}</span>
                    </label>
                    <div className="qty-stepper">
                      <button type="button" className="btn icon ghost step" onClick={() => onSetQty(it.key, s.key, got - 1)}>−</button>
                      <input className="qty" type="number" inputMode="numeric" min="0" value={got} onChange={(e) => onSetQty(it.key, s.key, e.target.value)} />
                      <button type="button" className="btn icon ghost step" onClick={() => onSetQty(it.key, s.key, got + 1)}>+</button>
                    </div>
                    {pending && <span className="po-flag pending">to pull {exp}</span>}
                    {short && <span className="po-flag short">short {exp - got}</span>}
                    {over && <span className="po-flag over">+{got - exp}</span>}
                    {exp == null && got > 0 && <span className="po-flag over">extra</span>}
                    {!it.expected && <button type="button" className="btn icon ghost remove" title="Remove size" onClick={() => onRemoveSize(it.key, s.key)}>×</button>}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
      <p className="muted sm">Check each size off as you pull it from the box. Anything left unchecked is recorded as a shortage; use the stepper for a partial, and “Add unexpected” for pairs that aren’t on the PO. Flag defects per shoe on the next screen.</p>
    </div>
  );
}

/* PO Phase 2: pick an open purchase order to receive against — browse the open
   (shipped/receiving) list or scan a label / type a PO code to pull one up. */
function PoPickerModal({ onPick, onClose, onSignOut }) {
  const [pos, setPos] = useState(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.poOpen()
      .then((r) => setPos(r.pos || []))
      .catch((e) => { if (e.unauthorized) return onSignOut(); setError(e.message); });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const load = async (fn) => {
    setBusy(true); setError('');
    try { const r = await fn(); onPick({ po: r.po, boxes: r.boxes, lines: r.lines }); }
    catch (e) { if (e.unauthorized) return onSignOut(); setError(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal po-picker" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="po-card-top">
          <h3 className="modal-title">Receive against a purchase order</h3>
          <button className="btn ghost sm" onClick={onClose}>Close</button>
        </div>
        <form className="searchrow" onSubmit={(e) => { e.preventDefault(); if (q.trim()) load(() => api.poLookup(q.trim())); }}>
          <input value={q} autoCapitalize="characters" autoCorrect="off" placeholder="Scan a label or type a PO code"
            onChange={(e) => setQ(e.target.value)} />
          <button type="submit" className="btn" disabled={busy || !q.trim()}>{busy ? '…' : 'Find'}</button>
        </form>
        {error && <div className="po-err">{error}</div>}
        <div className="muted sm po-picker-label">Open shipments</div>
        {pos == null ? <p className="muted">Loading…</p>
          : pos.length === 0 ? <div className="muted sm">No shipped purchase orders are waiting to be received.</div>
          : (
            <div className="po-list">
              {pos.map((p) => (
                <button key={p.id} className="po-card" disabled={busy} onClick={() => load(() => api.poGet(p.id))}>
                  <div className="po-card-top">
                    <span className="po-code">{p.po_code}</span>
                    <span className={`po-chip ${p.status === 'receiving' ? 'receiving' : 'shipped'}`}>{p.status === 'receiving' ? 'Receiving' : 'Shipped'}</span>
                  </div>
                  <div className="po-card-meta">
                    <span>{p.supplier_name}</span>
                    {p.tag_code && <span>{p.tag_code}</span>}
                    <span>{p.box_count} label{p.box_count === 1 ? '' : 's'}</span>
                    <span>{p.unit_count} unit{p.unit_count === 1 ? '' : 's'}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
      </div>
    </div>
  );
}

/* Recent batches list (read-only, expand to see items/issues). */
function BatchList({ kind, onOpenItem, onSignOut }) {
  const [batches, setBatches] = useState(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(null); // batch id -> details
  const [detail, setDetail] = useState(null);
  const [labels, setLabels] = useState(null); // { batchCode, items }

  useEffect(() => {
    api.batchList(kind)
      .then(({ batches }) => setBatches(batches))
      .catch((err) => { if (err.unauthorized) return onSignOut(); setError(err.message); });
  }, [kind]); // eslint-disable-line react-hooks/exhaustive-deps

  async function toggle(id) {
    if (open === id) { setOpen(null); setDetail(null); return; }
    setOpen(id); setDetail(null);
    try { setDetail(await api.batchGet(id)); }
    catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
  }

  if (error) return <div className="error mt">{error}</div>;
  if (!batches) return <p className="muted">Loading…</p>;
  if (!batches.length) return <div className="card"><p className="muted">No batches yet.</p></div>;

  return (
    <>
      <div className="card">
        <div className="batch-list">
          {batches.map((b) => {
            const isOpen = open === b.id;
            return (
              <div className={`batch-item ${isOpen ? 'open' : ''}`} key={b.id}>
                <button className="batch-head" onClick={() => toggle(b.id)}>
                  <span className="batch-caret">{isOpen ? '▾' : '▸'}</span>
                  <div className="batch-head-main">
                    <div className="batch-head-top">
                      <span className="batch-code">{b.batch_code}</span>
                      <span className="batch-date muted sm">{(b.date_received || b.created_at || '').slice(0, 10)}</span>
                    </div>
                    <div className="batch-head-sub">
                      <span>{b.supplier_name || '—'}</span>
                      <span className="batch-pill">{b.item_count} item{b.item_count === 1 ? '' : 's'}</span>
                      <span className="batch-pill">${Number(b.total_cost).toFixed(2)}</span>
                      {b.issue_count > 0 && <span className="batch-pill warn">{b.issue_count} ⚠</span>}
                    </div>
                  </div>
                </button>
                {isOpen && (
                  <div className="batch-detail">
                    {!detail ? <p className="muted">Loading…</p> : (
                      <>
                        <div className="batch-detail-actions">
                          <button className="btn sm primary" onClick={() => setLabels({ batchCode: detail.batch.batch_code, items: detail.items })}><Icon name="print" /> Print labels</button>
                        </div>
                        {detail.items.map((it) => (
                          <div className="batch-detail-row" key={it.id}>
                            <button className="vin vin-link" onClick={() => onOpenItem?.(it.vin)} title="View full shoe detail">{it.vin}</button>
                            <span className="batch-row-name">{it.name}</span>
                            <span className="muted sm">{it.sku || '—'} · size {it.size || '—'} · ${Number(it.cost || 0).toFixed(2)}</span>
                          </div>
                        ))}
                        {detail.issues.map((is) => (
                          <div className="batch-detail-row issue" key={is.id}>⚠ {is.type}: {is.description || ''}{is.type === 'shortfall' ? ` (${is.received_count}/${is.expected_count})` : ''}</div>
                        ))}
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      {labels && <LabelSheet batchCode={labels.batchCode} items={labels.items} onClose={() => setLabels(null)} />}
    </>
  );
}
