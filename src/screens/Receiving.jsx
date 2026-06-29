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
import { useUnsavedGuard } from '../hooks.js';
import { isVinCode, isUpcCode, parseTrackingNumber, usSizeChart, compareSizes } from '../lib/codes.js';
import { SUPPLIERS, RESCALE_REASONS, ISSUE_TYPES, DEFECT_TYPES } from '../lib/constants.js';

// Lazy-loaded so the barcode library only downloads when the camera is opened.
const CameraScanner = lazy(() => import('../components/CameraScanner.jsx'));

// Monotonic key source for the cart's React lists (unique among siblings).
let cartKey = 1;

export function Receiving({ mode = 'receiving', navBack, batchContext = null, onBatchDone, onOpenItem, onHome, onSignOut }) {
  const isRescale = mode === 'rescale';
  // "Box mode": adding a box to an existing OPEN multi-box batch (from Batch Page).
  // Step 1 collects only the box tracking #; finish commits the box (boxCommit).
  const isBoxMode = !isRescale && !!batchContext;
  const today = new Date().toISOString().slice(0, 10);
  const [tab, setTab] = useState('intake');   // 'intake' | 'recent'
  const [step, setStep] = useState(1);         // receiving: 1 shipment·2 items·3 review·4 issues | rescale: 1 details·2 items

  const [header, setHeader] = useState({
    buyer: 'stickballman12', supplier: '', tracking: '', dateReceived: today,
    defaultCost: '', notes: '', specialRules: '', origin: 'returned', originOther: '',
    batchTag: '', expectedBoxes: '1', // V6 Feature 7: >1 → open multi-box batch
  });
  // The reason stored on the batch: the custom text when "Other" is picked.
  const effectiveOrigin = header.origin === 'other'
    ? (String(header.originOther || '').trim() || 'Other')
    : header.origin;
  const setH = (k, v) => setHeader((h) => ({ ...h, [k]: v }));
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
    if (isRescale) return undefined;
    let cancelled = false;
    api.suppliers()
      .then(({ suppliers }) => { if (!cancelled && suppliers?.length) setSupplierOptions(suppliers); })
      .catch(() => { /* keep the static fallback */ });
    return () => { cancelled = true; };
  }, [isRescale]);

  // Debounced duplicate-tracking check as the tracking number is typed/scanned.
  useEffect(() => {
    if (isRescale) { setDupBatch(null); return undefined; }
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

  // Keep the scan field focused so a HID scanner gun types straight into it.
  useEffect(() => {
    if (showAdd && !mCam && !photoCam && !pendingSwitch) { const t = setTimeout(() => mInputRef.current?.focus({ preventScroll: true }), 60); return () => clearTimeout(t); }
  }, [showAdd, mCam, photoCam, pendingSwitch, draft]);
  // While the listing-photo camera is open, drop focus so the mobile keyboard
  // closes — capturing a photo must never re-summon it via the hidden scan field.
  useEffect(() => { if (photoCam) document.activeElement?.blur?.(); }, [photoCam]);
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
      if (step > 1) { setStep((s) => s - 1); return true; }
      return false;
    };
    return () => { if (navBack) navBack.current = null; };
  }, [navBack, issueEditorVin, unitIssues, showAddSupplier, pendingSwitch, showAdd, scanTracking, showPrefs, showConfirm, result, printLabels, tab, step]);

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
    // Show the scanned code in the field (camera path); the gun/typed path types
    // straight in and clears on submit so the next scan starts fresh.
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
        setFlash({ type: 'added', text: `✓ ${item.vin}${item.size ? ` · sz ${item.size}` : ''}` }); scanFeedback('added');
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
    return { key: cartKey++, name: d.name, sku: d.sku, image: d.image, source: d.source, upc: d.upc, gender: d.gender || null, colorway: d.colorway || null, withBox: d.withBox !== false, sizes };
  }
  // Add a completed item to the cart, MERGING into an existing item when it's the
  // same product + same box status (so the same shoe scanned in two sessions
  // shows as one line with combined sizes/quantities/VINs). Different box status
  // stays separate (boxed vs no-box are tracked apart).
  function addOrMergeItem(item) {
    setItems((arr) => {
      const i = arr.findIndex((x) => x.withBox === item.withBox && sameSku(x.sku, item.sku));
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
  // V6 Feature 7: expected boxes > 1 starts an OPEN multi-box batch (box #1 here;
  // the rest are added from the Batch Page). Box-mode adds a box to an existing one.
  const expectedBoxesNum = Math.max(1, parseInt(header.expectedBoxes, 10) || 1);
  const isMultiBoxNew = !isRescale && !isBoxMode && expectedBoxesNum > 1;
  const itemUnits = (i) => i.sizes.reduce((a, r) => a + Math.max(1, Number(r.qty) || 1), 0);
  const totalItems = items.reduce((s, i) => s + itemUnits(i), 0);
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

  function goStep2() {
    setError('');
    // Box-mode inherits supplier/buyer/date from the batch — only the box tracking matters.
    if (!isRescale && !isBoxMode && !String(header.supplier).trim()) { setError('Select a supplier.'); return; }
    if (!isRescale && !isBoxMode && !String(header.buyer).trim()) { setError('Enter the buyer.'); return; }
    if (!isRescale && !isBoxMode && !String(header.dateReceived).trim()) { setError('Enter the date.'); return; }
    if (isRescale && header.origin === 'other' && !String(header.originOther).trim()) { setError('Enter a custom reason.'); return; }
    setStep(2);
  }
  function goStep3() {
    setError('');
    if (!items.length) { setError('Add at least one item first.'); return; }
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
          for (let n = 0; n < Math.max(1, Number(r.qty) || 1); n++) {
            out.push({ name: it.name, sku: it.sku, size: r.size, upc: it.upc, image: it.image, source: it.source, gender: it.gender, colorway: it.colorway, cost: defaultCostNum, withBox: it.withBox, vin: r.vins?.[n] || null });
          }
        }
      }
      const flatUnitIssues = Object.entries(unitIssues)
        .flatMap(([vin, arr]) => arr.map((x) => ({ vin, type: x.type, note: x.note, photos: x.photos })));

      // --- Multi-box (V6 Feature 7): commit a BOX, not a whole batch ---------
      if (isBoxMode || isMultiBoxNew) {
        let batchId = batchContext?.id;
        let batchCode = batchContext?.batch_code;
        if (!isBoxMode) {
          const createdBatch = await api.createOpenBatch({
            ...header, defaultCost: defaultCostNum, batchTag: header.batchTag, expectedBoxes: expectedBoxesNum,
          });
          batchId = createdBatch.id; batchCode = createdBatch.batchCode;
        }
        const { box } = await api.batchAddBox(batchId, header.tracking || null);
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
        setItems([]); setIssues([]); setRescanned([]); setUnitIssues({}); setStep(1);
        setResult({ batchCode, newCount: res.count || 0, rescaledCount: 0, vins: res.vins || [], printItems, boxCommit: true, autoCompleted: res.autoCompleted });
        return;
      }

      // --- Single batch (existing flow): commit a whole batch ---------------
      if (items.length) {
        const payload = {
          kind: mode,
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
        title={isRescale ? 'Rescale Stock' : isBoxMode ? 'Add box' : 'Receiving'}
        onHome={onHome}
        onSignOut={onSignOut}
        right={<button className="btn ghost sm" onClick={() => setShowPrefs(true)} title="Preferences"><Icon name="gear" /></button>}
      />

      <div className="tabs auth-tabs">
        <button className={`tab ${tab === 'intake' ? 'active' : ''}`} onClick={() => setTab('intake')}>{isRescale ? 'New Rescale' : 'New Batch'}</button>
        <button className={`tab ${tab === 'recent' ? 'active' : ''}`} onClick={() => setTab('recent')}>Recent</button>
      </div>

      {tab === 'recent' ? <BatchList kind={mode} onOpenItem={onOpenItem} onSignOut={onSignOut} /> : (
        <>
          {/* Stepper */}
          <div className="wizard-steps">
            {(isRescale ? [[1, 'Details'], [2, 'Items']] : [[1, 'Shipment'], [2, 'Items'], [3, 'Review'], [4, 'Issues']]).map(([n, label]) => (
              <button key={n} type="button" className={`wstep ${step === n ? 'active' : ''} ${step > n ? 'done' : ''}`}
                onClick={() => { if (n < step) setStep(n); }}>
                <span className="wstep-num">{step > n ? '✓' : n}</span>{label}
              </button>
            ))}
          </div>

          {step === 1 && (
            <>
              <div className="card">
                <h3 className="rows-title">{isRescale ? 'Rescale details' : isBoxMode ? 'Add a box' : 'Shipment details'}</h3>
                {isBoxMode && (
                  <div className="box-context">
                    Adding a box to <b>{batchContext.batch_code}</b>{batchContext.batch_tag ? <> · <Icon name="tag" /> {batchContext.batch_tag}</> : ''} · {batchContext.supplier_name || '—'}
                  </div>
                )}
                <div className="batch-form">
                  {!isRescale && !isBoxMode && <label>Buyer *<input value={header.buyer} onChange={(e) => setH('buyer', e.target.value)} /></label>}
                  {!isRescale && !isBoxMode && (
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
                  {!isRescale && (
                    <label>Tracking #
                      <span className="track-field">
                        <input value={header.tracking} onChange={(e) => setH('tracking', e.target.value)} placeholder="Type, scan, or upload a photo" />
                        <button type="button" className="btn sm ghost" title="Scan tracking barcode" onClick={() => setScanTracking(true)}><Icon name="camera" /></button>
                        <button type="button" className="btn sm ghost" title="Upload / snap a label photo" onClick={() => fileRef.current?.click()} disabled={ocrBusy}>{ocrBusy ? '…' : <Icon name="image" />}</button>
                      </span>
                    </label>
                  )}
                  {!isRescale && dupBatch && (
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
                  {!isBoxMode && <label>{isRescale ? 'Date *' : 'Date received *'}<input type="date" value={header.dateReceived} onChange={(e) => setH('dateReceived', e.target.value)} /></label>}
                  {!isBoxMode && <label>Default cost ($)<input type="number" min="0" step="0.01" value={header.defaultCost} onChange={(e) => setH('defaultCost', e.target.value)} /></label>}
                  {!isRescale && !isBoxMode && (
                    <label>Boxes expected
                      <input type="number" min="1" step="1" value={header.expectedBoxes}
                        onChange={(e) => setH('expectedBoxes', e.target.value)} title="More than 1 starts a multi-box batch you add boxes to from the Batch Page" />
                    </label>
                  )}
                  {!isRescale && !isBoxMode && expectedBoxesNum > 1 && (
                    <label className="batch-form-wide">Batch tag<input value={header.batchTag} maxLength={120}
                      placeholder="Code on the shipping label (e.g. Joey JP23 AJ40)" onChange={(e) => setH('batchTag', e.target.value)} /></label>
                  )}
                  {!isRescale && !isBoxMode && <label className="batch-form-wide">Special rules<input value={header.specialRules} onChange={(e) => setH('specialRules', e.target.value)} /></label>}
                  {!isBoxMode && <label className="batch-form-wide">Notes<input value={header.notes} onChange={(e) => setH('notes', e.target.value)} /></label>}
                </div>
                {!isRescale && !isBoxMode && expectedBoxesNum > 1 && (
                  <p className="muted sm">This starts an <b>open multi-box batch</b> — you'll scan box 1 now, then add the rest from the <b>Batches</b> page.</p>
                )}
              </div>
              {error && <div className="error mt">{error}</div>}
              <div className="batch-bar">
                <span className="muted sm">Step 1 of {isRescale ? 2 : 4}</span>
                <button className="btn primary" onClick={goStep2}>Next →</button>
              </div>
            </>
          )}

          {step === 2 && (
            <>
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
                              <span className="muted sm">{isRescale ? 'Rescale' : (header.supplier || '—')} · {defaultCostNum != null ? `$${defaultCostNum.toFixed(2)}` : 'no cost'}</span>
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
                            <span className="muted sm">{r.name || '—'} · {r.sku || '—'}{r.size ? ` · sz ${r.size}` : ''}</span>
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
                <button className="btn ghost" onClick={() => setStep(1)}>← Back</button>
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
                            <div className="seg sm" role="group" aria-label="Box status">
                              <button type="button" className={`seg-btn ${it.withBox !== false ? 'on yes' : ''}`} onClick={() => setItemBox(it.key, true)}><Icon name="box" /> Box</button>
                              <button type="button" className={`seg-btn ${it.withBox === false ? 'on no' : ''}`} onClick={() => setItemBox(it.key, false)}><Icon name="nobox" /> No box</button>
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
                                    {Array.from({ length: Math.max(1, Number(s.qty) || 1) }, (_, i) => {
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
                <h3 className="rows-title">Shipment issues <span className="muted">(optional)</span></h3>
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
                  {isBoxMode || isMultiBoxNew ? 'Submit box' : 'Finish batch'}
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
          <div className="modal additem" role="dialog" aria-modal="true" onClick={(e) => { e.stopPropagation(); if (!mCam && !photoCam) mInputRef.current?.focus({ preventScroll: true }); }}>
            <div className="modal-head">
              <h3 className="modal-title">Add item</h3>
              <button type="button" className="btn icon ghost" onClick={closeAddItem}>×</button>
            </div>
            <form className="searchrow" onSubmit={(e) => { e.preventDefault(); addCode(mInput); }}>
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
                {!isRescale && draft.sku && <ListingPhotos sku={draft.sku} onSignOut={onSignOut} onCameraToggle={setPhotoCam} />}
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
            <h3 className="modal-title">{isRescale ? 'Commit this rescale?' : (isBoxMode || isMultiBoxNew) ? 'Submit this box?' : 'Commit this batch?'}</h3>
            <div className="confirm-summary">
              {isRescale
                ? (<>
                    <div><b>{rescaledCount}</b> existing VIN{rescaledCount === 1 ? '' : 's'} rescanned{totalItems ? <> · <b>{totalItems}</b> new unit{totalItems === 1 ? '' : 's'}</> : ''}</div>
                    <div className="muted">Rescale · {header.origin === 'other' ? effectiveOrigin : (RESCALE_REASONS.find(([v]) => v === header.origin)?.[1] || effectiveOrigin)} · {header.dateReceived}</div>
                    <p className="muted sm">Rescanned units keep their VIN &amp; history (a “Rescaled” event + your chosen status is added). New stock gets a fresh VIN.</p>
                  </>)
                : (<>
                    <div><b>{totalItems}</b> units ({items.length} shoe{items.length === 1 ? '' : 's'}) · total <b>${totalCost.toFixed(2)}</b></div>
                    <div className="muted">Supplier: {header.supplier || '—'} · Buyer: {header.buyer || '—'}</div>
                    <div className="muted">Tracking: {header.tracking || '—'} · {header.dateReceived}</div>
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
          title={result.boxCommit
            ? (result.autoCompleted ? `Box saved · ${result.batchCode} complete ✓` : `Box saved to ${result.batchCode}`)
            : (result.batchCode ? `Batch ${result.batchCode} saved` : 'Rescale saved')}
          message={[
            result.rescaledCount ? `${result.rescaledCount} existing unit(s) rescanned & updated.` : '',
            result.newCount ? `${result.newCount} new item(s) recorded — VINs ${result.vins?.[0]}…${result.vins?.[result.vins.length - 1]}.` : '',
            result.boxCommit && !result.autoCompleted ? 'Add the next box from the Batches page.' : '',
          ].filter(Boolean).join(' ')}
          onClose={() => { if (result.boxCommit) onBatchDone?.(); else setResult(null); }}>
          {result.printItems?.length > 0 && (
            <button className="btn primary" onClick={() => setPrintLabels({ batchCode: result.batchCode, items: result.printItems })}><Icon name="print" /> Print labels</button>
          )}
          {result.boxCommit
            ? <button className="btn ghost" onClick={() => onBatchDone?.()}>← Back to Batches</button>
            : <button className="btn ghost" onClick={() => setResult(null)}>Start another</button>}
        </Modal>
      )}

      {printLabels && <LabelSheet batchCode={printLabels.batchCode} items={printLabels.items} onClose={() => setPrintLabels(null)} />}

      {scanTracking && (
        <div className="modal-overlay" onClick={() => setScanTracking(false)}>
          <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Scan tracking barcode</h3>
            <Suspense fallback={<p className="muted">Loading camera…</p>}>
              <CameraScanner mode="tracking"
                onDetected={(code) => { setH('tracking', parseTrackingNumber(code)); setScanTracking(false); }}
                onClose={() => setScanTracking(false)}
                zoom={prefs.cameraZoom} onZoomChange={setCameraZoom} />
            </Suspense>
            <div className="modal-actions"><button className="btn ghost" onClick={() => setScanTracking(false)}>Cancel</button></div>
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

      {showAddSupplier && (
        <div className="modal-overlay" onClick={() => setShowAddSupplier(false)}>
          <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Add new supplier</h3>
            <form onSubmit={(e) => { e.preventDefault(); saveNewSupplier(); }}>
              <label>Supplier name
                <input autoFocus value={newSupplier} maxLength={80} placeholder="e.g. JD Sports"
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
                            <span className="muted sm">{it.sku || '—'} · sz {it.size || '—'} · ${Number(it.cost || 0).toFixed(2)}</span>
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
