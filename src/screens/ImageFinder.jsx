// PH Image Finder — build a SKU's branded listing set. Enter/scan a SKU → we resolve
// the shoe + its curated GOAT gallery, pre-pick the confident angles; PH assigns the
// rest by tapping a gallery image or uploading their own for a blank slot. "Brand &
// Fill" then composites each pick onto the Stickballman12 template with the name + SKU,
// auto-builds the spec slide, and appends the static welcome slide — all saved as this
// SKU's edited listing photos (source='ph_edited').
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { useQueryParam } from '../lib/urlstate.js';
import { toUploadableImage } from '../lib/image.js';
import { TopBar, ShoeThumb, ImageZoomModal, ProgressBar } from '../components/common.jsx';
import { Icon } from '../components/NavIcons.jsx';
import { EditedPhotosPanel } from './PhEditedPhotos.jsx';
import tpl1 from '../components/ImageTemplate/previews/1.jpg';
import tpl2 from '../components/ImageTemplate/previews/2.jpg';
import tpl3 from '../components/ImageTemplate/previews/3.jpg';
import tpl4 from '../components/ImageTemplate/previews/4.jpg';
import tpl5 from '../components/ImageTemplate/previews/5.jpg';

// The 5 shoe-angle slots (templates 1–5), in listing order.
const SLOTS = [
  { angle: 'side', label: 'Lateral' },
  { angle: 'diagonal', label: '3/4' },
  { angle: 'top', label: 'Top' },
  { angle: 'outsole', label: 'Sole' },
  { angle: 'rear', label: 'Heel' },
];
// Lightweight template backgrounds for the editor (the real templates are 5 MB each).
const TEMPLATE_PREVIEW = { side: tpl1, diagonal: tpl2, top: tpl3, outsole: tpl4, rear: tpl5 };
const SLOT_LABEL = Object.fromEntries(SLOTS.map((s) => [s.angle, s.label]));
const SHOE_SLOTS = new Set(SLOTS.map((s) => s.angle));
// Labels + listing order for the branded preview (angles + the two extra slides).
const RESULT_LABEL = { ...SLOT_LABEL, spec: 'Spec', welcome: 'Welcome' };
const RESULT_ORDER = ['side', 'diagonal', 'top', 'outsole', 'rear', 'spec', 'welcome'];

// The slot key(s) a single-slide render/commit task covers — used to mark the right slide(s)
// failed when a request throws without carrying per-slide results.
const taskSlots = (tk) =>
  tk.spec ? ['spec'] : tk.welcome ? ['welcome'] : (tk.picks || []).map((p) => p.angle).filter(Boolean);

export function ImageFinder({ onHome, onSignOut }) {
  const [skuInput, setSkuInput] = useState('');
  const [product, setProduct] = useState(null);
  // Every source that matched the SKU (Nike, GOAT, StockX…) — the gallery lists them
  // all so PH can pick the angle they want rather than trusting one catalogue's order.
  const [sources, setSources] = useState([]);
  // The SKU the current gallery was searched with, plus whether the metered GOAT/StockX
  // catalogue is still unqueried (a brand feed answered, so the server skipped it).
  const [searchedSku, setSearchedSku] = useState('');
  const [moreAvailable, setMoreAvailable] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // `?sku=` restores the LOADED SKU on refresh — i.e. you land back on that shoe's
  // photo manager instead of an empty form. Nothing else from this screen is
  // URL-restored, and that's deliberate: `preview` holds full-size rendered slides as
  // data-URIs (too big for a URL), `cutoutUrl` points at a server-staged object that
  // may have been collected, `committed` would lie about whether a set was already
  // saved, and re-running Brand & Fill spends a Replicate cutout per slot. Picks and
  // edits are cheap to re-make; a silent re-render is not cheap to undo.
  const [managedSku, setManagedSku] = useQueryParam('sku');   // the loaded SKU — drives the manage (EditedPhotosPanel) view
  const [panelReload, setPanelReload] = useState(0);  // bump to make the panel re-fetch (after a Brand & Fill save)
  const [title, setTitle] = useState('');             // editable shoe name stamped on each slide
  const [picks, setPicks] = useState({});             // angle -> image url (gallery or uploaded)
  const [uploaded, setUploaded] = useState({});       // angle -> true (came from a PH upload)
  const [editorSlot, setEditorSlot] = useState(null); // slot currently open in the position/resize editor
  const [activeSlot, setActiveSlot] = useState(SLOTS[0].angle);
  const [includeSpec, setIncludeSpec] = useState(true);
  const [includeWelcome, setIncludeWelcome] = useState(true);
  const [outSize, setOutSize] = useState(1600);       // output resolution: 1600 or 1400 (eBay rec.)
  const [looking, setLooking] = useState(false);
  const [branding, setBranding] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [uploading, setUploading] = useState(false);  // committing the preview to R2
  const [uploadingSlot, setUploadingSlot] = useState(null);
  const [notConfigured, setNotConfigured] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  // The reviewable preview set (nothing is saved until Upload). Keyed by slot.
  const [preview, setPreview] = useState(null);       // { [slot]: {ok, preview(dataUri), cutoutUrl, bbox, error, throttled} }
  const [edits, setEdits] = useState({});             // angle -> transform dialed on the canvas (post-preview)
  const [busySlots, setBusySlots] = useState(() => new Set()); // slots currently (re)rendering
  const [committed, setCommitted] = useState(false);  // uploaded to R2 yet?
  const [progress, setProgress] = useState(null);     // { done, total } for the render/upload bar
  const [previewTitle, setPreviewTitle] = useState(''); // title the current preview was rendered with
  const [previewIdx, setPreviewIdx] = useState(null); // index into previewList for the zoom modal
  const fileRefs = useRef({});
  // Bumped whenever the preview is invalidated; async renders capture it and discard
  // their result if it changed underneath them (prevents stale responses clobbering state).
  const genRef = useRef(0);

  const isBusy = busySlots.size > 0;
  const markBusy = (slot, on) => setBusySlots((s) => { const n = new Set(s); if (on) n.add(slot); else n.delete(slot); return n; });
  // Any change to the source set (new SKU, re-assigned slot, upload) invalidates the
  // rendered preview and its commit state, and supersedes any in-flight render.
  const resetPreview = () => {
    genRef.current += 1;
    setPreview(null); setEdits({}); setCommitted(false); setPreviewIdx(null);
    setBusySlots(new Set()); setPreviewTitle('');
  };

  // Load a SKU → show its edited-photos manager (the panel fetches the photos). PH can
  // manage them there, or press "Build from template" to generate a branded set.
  function lookUp(e) {
    e?.preventDefault();
    const sku = skuInput.trim();
    if (!sku) return;
    setError(''); setNotice(''); setNotConfigured(false);
    setProduct(null); setPicks({}); setUploaded({}); resetPreview(); setActiveSlot(SLOTS[0].angle);
    setSources([]); setMoreAvailable(false); setSearchedSku('');
    setManagedSku(sku);
  }

  // Fill any slot a source can that isn't already picked. Used both to seed a fresh search
  // and to top up from a gallery loaded later — never overwrites what PH already chose.
  const seedFrom = (list, existing = {}) => {
    const seeded = { ...existing };
    for (const src of list) {
      for (const s of (src.suggestions || [])) if (!seeded[s.angle]) seeded[s.angle] = s.url;
    }
    return seeded;
  };

  // Run the marketplace image search + seed the angle slots (the Brand & Fill entry point).
  async function runSearch(sku) {
    const { configured, product: p, sources: srcs, more } = await api.imageFinderSearch(sku);
    if (configured === false) { setNotConfigured(true); return; }
    if (!p) { setError('No match found for that SKU.'); return; }
    const list = Array.isArray(srcs) && srcs.length ? srcs : [p];
    setProduct(p); setSources(list); setTitle(p.title || '');
    setSearchedSku(sku); setMoreAvailable(Boolean(more));
    // Seed each slot from the first source that can fill it — sources are ordered
    // best-first (Nike's labelled angles lead), so an unlabelled gallery only fills
    // the slots the labelled one couldn't.
    setPicks(seedFrom(list));
  }

  // "Also search GOAT/StockX" — the default search skips that (metered) catalogue whenever
  // a brand feed answered, since Nike/adidas angles are labelled and land in the right
  // slots. This pulls it in on demand: extra strips are appended and only EMPTY slots are
  // topped up, so nothing PH already picked moves.
  async function loadMoreSources() {
    if (!searchedSku) return;
    setLoadingMore(true); setError('');
    try {
      const { sources: srcs } = await api.imageFinderSearch(searchedSku, true);
      const extra = (Array.isArray(srcs) ? srcs : []).filter((s) => !sources.some((x) => x.source === s.source));
      setMoreAvailable(false);
      if (!extra.length) { setNotice('No extra photos found on GOAT/StockX for this SKU.'); return; }
      setSources((prev) => [...prev, ...extra]);
      setPicks((p) => seedFrom(extra, p));
    } catch (err) {
      if (err.unauthorized) return onSignOut();
      setError(err.message);
    } finally { setLoadingMore(false); }
  }

  // "Build from template" → open the marketplace search + Brand & Fill canvas.
  async function startSearch(sku) {
    setLooking(true); setError(''); setNotConfigured(false);
    try { await runSearch(sku); }
    catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setLooking(false); }
  }

  // Leave the generate flow → back to the photo manager, reloading it so any just-saved slides show.
  function backToPhotos() {
    setProduct(null); setSources([]); setMoreAvailable(false); setSearchedSku('');
    resetPreview(); setPanelReload((k) => k + 1);
  }

  function assignFrame(url) {
    setPicks((p) => ({ ...p, [activeSlot]: url }));
    setUploaded((u) => { const n = { ...u }; delete n[activeSlot]; return n; });
    resetPreview();
  }
  function toggleSlot(angle) {
    setActiveSlot(angle);
    resetPreview();
    setPicks((p) => {
      if (p[angle]) { const n = { ...p }; delete n[angle]; return n; }
      // Re-checking a slot re-fills it from the best source that has that angle.
      const sug = sources.flatMap((s) => s.suggestions || []).find((s) => s.angle === angle);
      return { ...p, [angle]: sug?.url || product?.images?.[0] || product?.hero };
    });
  }

  // Upload a PH photo into a blank (or any) slot: raw bytes → R2 via presign, then the
  // slot points at that R2 URL. Brand & Fill will template it like a gallery pick.
  async function uploadToSlot(angle, file) {
    if (!file || !product) return;
    setUploadingSlot(angle); setError('');
    try {
      // HEIC (straight off an iPhone) and AVIF (what Chrome saves brand-site photos as)
      // are unreadable further down the chain, so convert here rather than stamping
      // `image/jpeg` on bytes that aren't. Throws with a fixable message if it can't.
      const { blob, type } = await toUploadableImage(file);
      const { uploadUrl, publicUrl } = await api.photoSign(product.sku, angle, type, 'ph_edited');
      const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': type }, body: blob });
      if (!put.ok) throw new Error('Upload failed. Try again.');
      setPicks((p) => ({ ...p, [angle]: publicUrl }));
      setUploaded((u) => ({ ...u, [angle]: true }));
      setActiveSlot(angle); resetPreview();
    } catch (err) {
      if (err.unauthorized) return onSignOut();
      setError(err.message);
    } finally { setUploadingSlot(null); }
  }

  const chosen = useMemo(
    () => SLOTS.filter((s) => picks[s.angle]).map((s) => ({ angle: s.angle, url: picks[s.angle] })),
    [picks],
  );
  const slideCount = chosen.length + (includeSpec ? 1 : 0) + (includeWelcome ? 1 : 0);
  const canBrand = chosen.length > 0 || includeSpec || includeWelcome;

  // Step 1 — Brand & Fill = PREVIEW: cut each shoe out once, place it on the template, and
  // show the results. Nothing is saved yet; PH reviews (and can adjust) before uploading.
  async function brandFill() {
    if (!product || !canBrand) return;
    // Re-rendering rebuilds from scratch and drops manual size adjustments — confirm first.
    if (preview && Object.keys(edits).length > 0 &&
      !window.confirm('Re-rendering starts a fresh preview and discards your size adjustments. Continue?')) return;
    const t = title.trim();
    setBranding(true); setError(''); setNotice(''); resetPreview();
    const myGen = genRef.current; // captured after resetPreview bumped it
    setPreviewTitle(t);
    // One request per slide (sequential) so we can show real progress and reveal each slide
    // as it finishes — the server still cuts one shoe at a time (no extra load).
    const tasks = [
      ...chosen.map((c) => ({ picks: [c], spec: false, welcome: false })),
      ...(includeSpec ? [{ picks: [], spec: true, welcome: false }] : []),
      ...(includeWelcome ? [{ picks: [], spec: false, welcome: true }] : []),
    ];
    setProgress({ done: 0, total: tasks.length });
    const acc = {};
    let unauth = false;
    try {
      for (let i = 0; i < tasks.length; i++) {
        const tk = tasks[i];
        try {
          const { results: r } = await api.imageFinderBrand(product.sku, t, tk.picks, tk.spec, tk.welcome, outSize, 'preview');
          if (genRef.current !== myGen) return; // superseded by a newer action
          for (const one of (r || [])) acc[one.slot] = one;
        } catch (err) {
          if (genRef.current !== myGen) return;
          if (err.unauthorized) { unauth = true; break; }
          // A single-slide request whose picks all fail comes back ok:false, and the API
          // client throws on ok:false (api.js) — but it still carries the per-slide results.
          // Record those (so the ! badge shows) and DON'T abort: the remaining shoes and the
          // independent spec/welcome slides must still render. (Previously one failed upload
          // killed the whole run, including spec + welcome.)
          const rr = err.data?.results;
          if (Array.isArray(rr) && rr.length) for (const one of rr) acc[one.slot] = one;
          else for (const s of taskSlots(tk)) acc[s] = { slot: s, ok: false, error: err.message };
        }
        setPreview({ ...acc });
        setProgress({ done: i + 1, total: tasks.length });
      }
      if (unauth) return onSignOut();
      const okCount = Object.values(acc).filter((x) => x.ok).length;
      const failed = Object.values(acc).filter((x) => !x.ok);
      if (okCount > 0) setNotice(`Previewed ${okCount} slide${okCount === 1 ? '' : 's'}. Adjust any shoe, then Upload to save.`);
      if (failed.length) {
        const throttled = failed.some((x) => x.throttled);
        setError(`${failed.length} slide${failed.length === 1 ? '' : 's'} didn’t cut out${throttled
          ? ' — Replicate is rate-limited (add ≥$5 credit or wait ~1 min), then re-run.'
          : ' — see the ! badges and re-run.'}`);
      } else if (okCount === 0) {
        setError('Nothing previewed — see the errors below.');
      }
    } finally { setBranding(false); setProgress(null); }
  }

  // Step 2 — a shoe was repositioned/resized on the canvas: re-render JUST that slide
  // (reuses the staged cutout — no re-cut) and drop the new preview in.
  async function adjustSave(slot, { cutoutUrl, bbox, transform }) {
    setEditorSlot(null);
    const myGen = genRef.current;
    markBusy(slot, true); setError('');
    try {
      const { results: r } = await api.imageFinderBrand(
        product.sku, title.trim(),
        [{ angle: slot, url: cutoutUrl, precut: true, transform }],
        false, false, outSize, 'preview',
      );
      if (genRef.current !== myGen) return; // superseded
      const one = (r || [])[0];
      if (one?.ok) {
        // Only commit the adjustment once the server confirms it rendered — a failed
        // re-render must NOT leave an unverified transform that Upload would ship.
        setPreview((p) => ({ ...p, [slot]: { ...one, cutoutUrl, bbox } }));
        setEdits((e) => ({ ...e, [slot]: transform }));
        setCommitted(false); // an edit invalidates any prior upload
      } else setError(one?.error || 'Could not re-render that slide.');
    } catch (err) {
      if (genRef.current !== myGen) return;
      if (err.unauthorized) return onSignOut();
      setError(err.message);
    } finally { markBusy(slot, false); }
  }

  // Re-cut ONE shoe: send its ORIGINAL source image back to Replicate for a fresh cutout
  // (not the staged one) and re-render just that slide. For a shoe that got throttled (429)
  // or cut out poorly. A fresh cutout has a new shape, so its prior size adjustment is dropped.
  async function recutSlot(slot) {
    const url = picks[slot];
    if (!product || !url || !SHOE_SLOTS.has(slot)) return;
    const myGen = genRef.current;
    markBusy(slot, true); setError(''); setNotice(''); setCommitted(false);
    setEdits((e) => { const n = { ...e }; delete n[slot]; return n; }); // fresh cut → drop old placement
    try {
      const { results: r } = await api.imageFinderBrand(
        product.sku, title.trim(),
        [{ angle: slot, url }],   // fresh (NOT precut) → forces a new Replicate cutout
        false, false, outSize, 'preview',
      );
      if (genRef.current !== myGen) return; // superseded
      const one = (r || [])[0];
      setPreview((p) => ({ ...p, [slot]: one || p?.[slot] }));
      if (!one?.ok) setError(one?.error || 'Could not cut out that shoe — try again.');
    } catch (err) {
      if (genRef.current !== myGen) return;
      if (err.unauthorized) return onSignOut();
      setError(err.message);
    } finally { markBusy(slot, false); }
  }

  // Step 3 — Upload to server: commit the (possibly adjusted) set to R2 + the photo library,
  // reusing each staged cutout + its dialed placement. No re-cut.
  async function uploadToServer() {
    if (!product || !preview || isBusy) return; // don't commit mid-render
    const shoePicks = SLOTS.filter((s) => preview[s.angle]?.ok && preview[s.angle]?.cutoutUrl)
      .map((s) => ({ angle: s.angle, url: preview[s.angle].cutoutUrl, precut: true, transform: edits[s.angle] || null }));
    const spec = !!preview.spec?.ok, welcome = !!preview.welcome?.ok;
    if (!shoePicks.length && !spec && !welcome) { setError('Nothing to upload.'); return; }
    // Completeness gate: warn before shipping a set that's missing shoe angles PH selected.
    const missing = SLOTS.filter((s) => picks[s.angle] && !preview[s.angle]?.ok);
    if (missing.length && !window.confirm(
      `${missing.length} shoe slide${missing.length === 1 ? '' : 's'} didn’t render and won’t be uploaded (${missing.map((s) => s.label).join(', ')}). Upload the rest anyway?`)) return;
    const myGen = genRef.current;
    const t = title.trim();
    // One commit request per slide (sequential) for real upload progress; each reuses its
    // staged cutout + transform (no re-cut).
    const tasks = [
      ...shoePicks.map((p) => ({ picks: [p], spec: false, welcome: false })),
      ...(spec ? [{ picks: [], spec: true, welcome: false }] : []),
      ...(welcome ? [{ picks: [], spec: false, welcome: true }] : []),
    ];
    setUploading(true); setError(''); setNotice('');
    setProgress({ done: 0, total: tasks.length });
    let saved = 0; const failed = []; let unauth = false;
    try {
      for (let i = 0; i < tasks.length; i++) {
        const tk = tasks[i];
        try {
          const { saved: s, results: r } = await api.imageFinderBrand(product.sku, t, tk.picks, tk.spec, tk.welcome, outSize, 'commit');
          if (genRef.current !== myGen) return; // superseded — don't flash stale banners
          saved += s || 0;
          for (const one of (r || [])) if (!one.ok) failed.push(one);
        } catch (err) {
          if (genRef.current !== myGen) return;
          if (err.unauthorized) { unauth = true; break; }
          // ok:false throws in the API client but still carries results; record the failed
          // slide(s) and keep committing the rest (one bad slide must not abort the upload).
          const rr = err.data?.results;
          if (Array.isArray(rr) && rr.length) for (const one of rr) { if (!one.ok) failed.push(one); }
          else for (const s of taskSlots(tk)) failed.push({ slot: s, ok: false, error: err.message });
        }
        setProgress({ done: i + 1, total: tasks.length });
      }
      if (unauth) return onSignOut();
      if (saved > 0) { setCommitted(true); setPanelReload((k) => k + 1); setNotice(`Uploaded ${saved} slide${saved === 1 ? '' : 's'} for ${product.sku}.`); }
      if (failed.length) setError(`${failed.length} slide${failed.length === 1 ? '' : 's'} failed to upload — try Upload again.`);
      else if (saved === 0) setError('Nothing was uploaded.');
    } finally { setUploading(false); setProgress(null); }
  }

  // Download every uploaded slide for this SKU as a zip (all ph_edited photos).
  async function downloadAll() {
    if (!product) return;
    setDownloading(true); setError('');
    try {
      const { blob, filename } = await api.photoDownload(product.sku, 'ph_edited');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = filename || `${product.sku}-listing.zip`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    } catch (err) {
      if (err.unauthorized) return onSignOut();
      setError('Could not download the images.');
    } finally { setDownloading(false); }
  }

  // Every photo across every matched source (the gallery groups them per source).
  const images = sources.flatMap((s) => s.images || []);
  // Ordered preview slides for the review grid + zoom (only the ones that rendered).
  const previewList = useMemo(
    () => RESULT_ORDER.map((slot) => (preview?.[slot]?.ok && preview[slot].preview ? { slot, ...preview[slot] } : null)).filter(Boolean),
    [preview],
  );
  const previewBad = useMemo(
    () => RESULT_ORDER.map((slot) => (preview?.[slot] && !preview[slot].ok ? { slot, ...preview[slot] } : null)).filter(Boolean),
    [preview],
  );
  // The title was changed after the preview was rendered — Upload would ship an
  // unreviewed title, so gate it behind a re-render.
  const titleStale = !!preview && previewTitle !== title.trim();

  return (
    <div className="app">
      <TopBar title="Find Image Listings" onHome={onHome} onSignOut={onSignOut} />
      <div className="card">
        <p className="muted sm">
          Manage a SKU’s listing photos in one place. Load a SKU to see and edit its images —
          <b> upload finished photos</b> directly, or <b>Build from template</b> to auto-source the shoe and
          drop it on your template (cut out, place, resize on the canvas), then save.
        </p>

        <form className="pi-lookup" onSubmit={lookUp}>
          <input
            className="pi-sku-input" type="text" inputMode="text" autoCapitalize="characters"
            placeholder="Enter a SKU (e.g. JR1598)" value={skuInput}
            onChange={(e) => setSkuInput(e.target.value)} disabled={uploading} />
          <button type="submit" className="btn" disabled={uploading || !skuInput.trim()}>
            <Icon name="image" /> Load SKU
          </button>
        </form>

        {error && <div className="error mt">{error}</div>}
        {notice && <div className="notice mt">{notice}</div>}
        {notConfigured && <div className="notice mt">Marketplace image search isn’t configured on the server (KicksDB key missing) — you can still upload photos manually below.</div>}

        {/* Manage view — the SKU's edited-photos panel + a Brand & Fill entry point. */}
        {managedSku && !product && (
          <>
            <div className="if-manage-head mt">
              <span className="pi-product-sku">{managedSku}</span>
              <button type="button" className="btn primary" disabled={looking} onClick={() => startSearch(managedSku)}>
                <Icon name="image" /> {looking ? 'Finding…' : 'Build from template'}
              </button>
            </div>
            <EditedPhotosPanel sku={managedSku} reloadKey={panelReload} onSignOut={onSignOut}
              onBuildFromTemplate={() => startSearch(managedSku)} buildBusy={looking} />
          </>
        )}

        {product && (
          <>
            <button type="button" className="if-back" onClick={backToPhotos}>
              <span className="if-back-arrow" aria-hidden="true">←</span> Back to photos
            </button>
            <div className="pi-product mt">
              <ShoeThumb url={product.hero} size={52} />
              <div className="pi-product-info">
                <div className="pi-product-name">{product.title || '—'}</div>
                <div className="muted sm">
                  <span className="pi-product-sku">{product.sku || '—'}</span>
                  {product.brand ? <span> · {product.brand}</span> : null}
                  {images.length ? <span> · {images.length} photo{images.length === 1 ? '' : 's'} · {sources.map((s) => s.sourceLabel).join(' + ')}</span> : null}
                </div>
                {product.source && product.source !== 'goat' && (
                  <div className="if-fallback-note sm">
                    {product.source === 'stockx_360'
                      ? 'No GOAT gallery — showing the StockX 360° spin (no sole/top). Upload your own for those.'
                      : 'Only a hero image is available — upload your own photos to fill the other angles.'}
                  </div>
                )}
              </div>
            </div>

            {/* Editable title stamped on every branded slide. */}
            <label className="if-title-field mt">
              <span className="if-field-label">Title on the images</span>
              <input className="if-title-input" type="text" value={title} maxLength={120}
                onChange={(e) => setTitle(e.target.value)} placeholder="Shoe name" />
            </label>

            {/* The 5 angle slots — tap to select, Upload to fill from a file. */}
            <div className="if-slots mt">
              {SLOTS.map((s) => {
                const url = picks[s.angle];
                const on = !!url;
                const busy = uploadingSlot === s.angle;
                return (
                  <div key={s.angle}
                    className={`if-slot ${activeSlot === s.angle ? 'active' : ''} ${on ? '' : 'off'}`.trim()}
                    onClick={() => setActiveSlot(s.angle)}>
                    <div className="if-slot-frame">
                      {url ? <img src={url} alt={s.label} loading="lazy" /> : <span className="if-slot-empty">{busy ? 'Uploading…' : 'Empty'}</span>}
                      {uploaded[s.angle] && <span className="if-slot-tag">Uploaded</span>}
                    </div>
                    <div className="if-slot-foot">
                      <span className="if-slot-label">{s.label}</span>
                      <div className="if-slot-acts">
                        <button type="button" className="if-slot-toggle"
                          onClick={(e) => { e.stopPropagation(); fileRefs.current[s.angle]?.click(); }} title="Upload your own photo">Upload</button>
                        {on && (
                          <button type="button" className="if-slot-toggle"
                            onClick={(e) => { e.stopPropagation(); toggleSlot(s.angle); }} title="Clear this slot">Skip</button>
                        )}
                      </div>
                    </div>
                    <input ref={(el) => { fileRefs.current[s.angle] = el; }} type="file" accept="image/*"
                      style={{ display: 'none' }}
                      onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) uploadToSlot(s.angle, f); }} />
                  </div>
                );
              })}
            </div>

            {/* Gallery — tap any image to drop it into the active slot. */}
            {sources.some((s) => (s.images || []).length > 0) && (
              <div className="if-strip-wrap mt">
                <div className="if-strip-head muted sm">Assign to <b>{SLOT_LABEL[activeSlot]}</b> — tap a photo</div>
                {/* One strip per source. Nike labels each shot's angle, so those
                    captions are real; the marketplace galleries fall back to an index. */}
                {sources.map((src) => (src.images || []).length > 0 && (
                  <div className="if-strip-group" key={src.source}>
                    <div className="if-strip-src muted sm">
                      {src.sourceLabel}
                      <span className="muted"> · {src.images.length} photo{src.images.length === 1 ? '' : 's'}</span>
                    </div>
                    <div className="if-strip">
                      {src.images.map((url, i) => {
                        const caption = src.labels?.[i] || `Photo ${i + 1}`;
                        return (
                          <button type="button" key={`${src.source}-${i}`}
                            className={`if-frame ${picks[activeSlot] === url ? 'sel' : ''}`.trim()}
                            onClick={() => assignFrame(url)} title={`${src.sourceLabel} — ${caption}`}>
                            <img src={url} alt={caption} loading="lazy" />
                            <span className="if-frame-cap">{caption}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
                {/* The GOAT/StockX catalogue is metered, so a search that a brand feed
                    already answered skips it. Offer it on demand — extra angles are one
                    tap away without every search paying for them. */}
                {moreAvailable && (
                  <button type="button" className="btn sm mt" disabled={loadingMore} onClick={loadMoreSources}>
                    <Icon name="search" /> {loadingMore ? 'Searching…' : 'Also search GOAT/StockX'}
                  </button>
                )}
              </div>
            )}

            {/* Extra slides. */}
            <div className="if-extras mt">
              <label className="if-check">
                <input type="checkbox" checked={includeSpec} onChange={(e) => { setIncludeSpec(e.target.checked); resetPreview(); }} />
                <span>Spec slide <span className="muted sm">— colour + materials, auto-filled</span></span>
                {preview?.spec && <span className={`if-slot-badge inline ${preview.spec.ok ? 'ok' : 'bad'}`}>{preview.spec.ok ? '✓' : '!'}</span>}
              </label>
              <label className="if-check">
                <input type="checkbox" checked={includeWelcome} onChange={(e) => { setIncludeWelcome(e.target.checked); resetPreview(); }} />
                <span>Welcome slide <span className="muted sm">— static store intro</span></span>
                {preview?.welcome && <span className={`if-slot-badge inline ${preview.welcome.ok ? 'ok' : 'bad'}`}>{preview.welcome.ok ? '✓' : '!'}</span>}
              </label>
            </div>

            {/* Output resolution — 1600 (design size) or 1400 (eBay's recommendation). */}
            <div className="if-res mt">
              <span className="if-field-label">Output size</span>
              <div className="if-res-toggle">
                {[1600, 1400].map((s) => (
                  <button type="button" key={s}
                    className={`if-res-opt ${outSize === s ? 'sel' : ''}`.trim()}
                    onClick={() => { setOutSize(s); setCommitted(false); }}>
                    {s}×{s}{s === 1400 ? <span className="muted xs"> · eBay</span> : null}
                  </button>
                ))}
              </div>
            </div>

            <div className="if-actions mt">
              <button type="button" className="btn primary" disabled={branding || uploading || !canBrand} onClick={brandFill}>
                <Icon name="image" /> {branding ? 'Rendering…' : preview ? `Re-render preview (${slideCount})` : `Brand & Fill (${slideCount})`}
              </button>
            </div>
            {branding && progress && (
              <div className="mt">
                <ProgressBar value={progress.done / progress.total}
                  label={`Cutting out & placing — ${progress.done} of ${progress.total} slides`} />
              </div>
            )}

            {/* Review the preview set → adjust any shoe → Upload → Download. Nothing is
                saved to the library until Upload. */}
            {preview && (
              <div className="if-preview mt">
                <div className="if-preview-head">
                  <span className="if-preview-title">
                    Preview <span className="muted sm">· tap a slide to zoom{previewList.some((r) => SHOE_SLOTS.has(r.slot)) ? ' · Adjust to resize a shoe' : ''}</span>
                  </span>
                  {committed && <span className="if-committed">✓ Uploaded</span>}
                </div>

                <div className="if-preview-grid">
                  {previewList.map((r, i) => (
                    <div key={r.slot} className="if-preview-item">
                      <button type="button" className="if-preview-img" onClick={() => setPreviewIdx(i)}>
                        <img src={r.preview} alt={RESULT_LABEL[r.slot] || r.slot} loading="lazy" />
                        {busySlots.has(r.slot) && <span className="if-preview-regen">Re-rendering…</span>}
                      </button>
                      <div className="if-preview-foot">
                        <span className="if-preview-label">{RESULT_LABEL[r.slot] || r.slot}{edits[r.slot] ? ' · adjusted' : ''}</span>
                        {SHOE_SLOTS.has(r.slot) && (
                          <div className="if-preview-acts">
                            <button type="button" className="if-slot-toggle" disabled={busySlots.has(r.slot) || uploading || titleStale}
                              onClick={() => recutSlot(r.slot)} title={titleStale ? 'Re-render the preview first (title changed)' : 'Send this shoe to the background remover again'}>Cutout</button>
                            <button type="button" className="if-slot-toggle" disabled={busySlots.has(r.slot) || uploading || titleStale}
                              onClick={() => setEditorSlot(r.slot)} title={titleStale ? 'Re-render the preview first (title changed)' : 'Position & resize the shoe'}>Adjust size</button>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>

                {previewBad.length > 0 && (
                  <div className="if-preview-errs">
                    {previewBad.map((r) => (
                      <div key={r.slot} className="if-preview-err">
                        <span><b>{RESULT_LABEL[r.slot] || r.slot}:</b> {r.error || 'failed'}</span>
                        {SHOE_SLOTS.has(r.slot) && (
                          <button type="button" className="btn sm" disabled={busySlots.has(r.slot) || uploading || titleStale}
                            onClick={() => recutSlot(r.slot)}>{busySlots.has(r.slot) ? 'Cutting…' : 'Cutout'}</button>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                <div className="if-commit-actions">
                  <button type="button" className="btn primary" disabled={uploading || committed || isBusy || titleStale || previewList.length === 0}
                    onClick={uploadToServer}>
                    <Icon name="image" /> {uploading ? 'Uploading…' : committed ? 'Uploaded ✓' : `Upload to server (${previewList.length})`}
                  </button>
                  <button type="button" className="btn" disabled={!committed || downloading} onClick={downloadAll}>
                    <Icon name="download" /> {downloading ? 'Zipping…' : 'Download all'}
                  </button>
                </div>
                {uploading && progress && (
                  <div className="mt">
                    <ProgressBar value={progress.done / progress.total}
                      label={`Uploading — ${progress.done} of ${progress.total} slides`} />
                  </div>
                )}
                {downloading && <div className="mt"><ProgressBar indeterminate label="Zipping the set…" /></div>}
                {titleStale
                  ? <p className="muted sm mt">Title changed since this preview — press <b>Re-render preview</b> to apply it before uploading.</p>
                  : !committed && <p className="muted sm mt">Nothing is saved until you press <b>Upload to server</b>.</p>}
              </div>
            )}
          </>
        )}
      </div>
      {editorSlot && product && preview?.[editorSlot]?.cutoutUrl && (
        <ShoeEditor
          angle={editorSlot}
          label={SLOT_LABEL[editorSlot]}
          sku={product.sku}
          sourceUrl={picks[editorSlot]}
          title={title}
          initial={{ cutoutUrl: preview[editorSlot].cutoutUrl, bbox: preview[editorSlot].bbox, transform: edits[editorSlot] || null }}
          onSignOut={onSignOut}
          onClose={() => setEditorSlot(null)}
          onSave={(payload) => adjustSave(editorSlot, payload)}
        />
      )}
      {previewIdx != null && previewList[previewIdx] && (
        <ImageZoomModal
          url={previewList[previewIdx].preview}
          label={RESULT_LABEL[previewList[previewIdx].slot] || previewList[previewIdx].slot}
          onClose={() => setPreviewIdx(null)}
          onPrev={previewIdx > 0 ? () => setPreviewIdx(previewIdx - 1) : undefined}
          onNext={previewIdx < previewList.length - 1 ? () => setPreviewIdx(previewIdx + 1) : undefined}
        />
      )}
    </div>
  );
}

// ── Live "position & resize" editor ─────────────────────────────────────────
// Cuts the shoe out (server), draws it over a lightweight template background, and
// lets PH drag / pinch / slider-scale it — Canva-style — before it's saved. Geometry
// is tracked in the pipeline's 1600×1600 design space and handed back as an explicit
// { dx, dy, dw, dh } transform, so what PH positions is exactly what Brand & Fill renders.
const DESIGN = 1600;
const DISP = 900;                       // internal canvas resolution (CSS-scaled to fit)
const K = DISP / DESIGN;
// Mirrors branding.js — keep in sync.
const ED_SHOE_BOX = { cx: 800, cy: 812, w: 1050, h: 770 };
const ED_SHOE_SHADOW = { offsetX: 28, offsetY: 30, blur: 42, color: 'rgba(0,0,0,0.78)' };
const ED_TITLE = { y: 188, size: 80 };
const ED_SKU = { y: 1476, size: 104 };
const clampScale = (s) => Math.min(2.5, Math.max(0.2, s));

function ShoeEditor({ angle, label, sku, sourceUrl, title, initial, onClose, onSave, onSignOut }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const [retryTick, setRetryTick] = useState(0);
  const [tf, setTf] = useState({ cx: ED_SHOE_BOX.cx, cy: ED_SHOE_BOX.cy, scale: 1 });

  const canvasRef = useRef(null);
  const bgRef = useRef(null);           // template preview Image
  const cutRef = useRef(null);          // transparent shoe Image
  const dataRef = useRef({ cutoutUrl: null, bbox: null, fitScale: 1 });
  const tfRef = useRef(tf); tfRef.current = tf;
  const pointers = useRef(new Map());   // pointerId -> {x,y}
  const gesture = useRef({ dist: 0 });

  // Resolve the cutout: reuse the stored one when re-opening an edited slot (no
  // re-cut, exact same geometry); otherwise cut it out on the server now.
  useEffect(() => {
    let dead = false;
    (async () => {
      setLoading(true); setError(''); setReady(false);
      // Template background (lightweight preview).
      const bg = new Image();
      bg.onload = () => { bgRef.current = bg; };
      bg.src = TEMPLATE_PREVIEW[angle];
      try {
        let cutoutUrl, bbox;
        if (initial?.cutoutUrl && initial?.bbox) {
          cutoutUrl = initial.cutoutUrl; bbox = initial.bbox;
        } else {
          const r = await api.imageFinderCutout(sku, sourceUrl);
          if (!r?.cutoutUrl) throw new Error('Could not cut out the shoe.');
          cutoutUrl = r.cutoutUrl; bbox = r.bbox;
        }
        const fitScale = Math.min(ED_SHOE_BOX.w / bbox.w, ED_SHOE_BOX.h / bbox.h);
        // refDist = half-diagonal of the fit-size shoe (design px) — a corner drag sets
        // scale = |pointer − centre| / refDist, so the dragged corner tracks the finger.
        const refDist = 0.5 * Math.hypot(bbox.w * fitScale, bbox.h * fitScale);
        dataRef.current = { cutoutUrl, bbox, fitScale, refDist };
        // Initial transform: from a prior edit, else the default auto-fit.
        let start = { cx: ED_SHOE_BOX.cx, cy: ED_SHOE_BOX.cy, scale: 1 };
        if (initial?.transform?.dw > 0) {
          const t = initial.transform;
          start = { cx: t.dx + t.dw / 2, cy: t.dy + t.dh / 2, scale: t.dw / (bbox.w * fitScale) };
        }
        // Draw the shoe (cross-origin drawImage is fine; we never read pixels back).
        const cut = new Image();
        cut.onload = () => { if (dead) return; cutRef.current = cut; setTf(start); tfRef.current = start; setReady(true); setLoading(false); };
        cut.onerror = () => { if (!dead) { setError('Could not load the cutout image.'); setLoading(false); } };
        cut.src = cutoutUrl;
      } catch (e) {
        if (dead) return;
        if (e.unauthorized) return onSignOut();
        setError(e.message || 'Could not cut out the shoe.'); setLoading(false);
      }
    })();
    return () => { dead = true; };
  }, [angle, sku, sourceUrl, retryTick]); // eslint-disable-line react-hooks/exhaustive-deps

  // Redraw whenever the transform changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, DISP, DISP);
    if (bgRef.current) ctx.drawImage(bgRef.current, 0, 0, DISP, DISP);
    else { ctx.fillStyle = '#222'; ctx.fillRect(0, 0, DISP, DISP); }
    const { bbox, fitScale } = dataRef.current;
    if (ready && cutRef.current && bbox) {
      const dw = bbox.w * fitScale * tf.scale, dh = bbox.h * fitScale * tf.scale;
      const dx = tf.cx - dw / 2, dy = tf.cy - dh / 2;
      ctx.save();
      ctx.shadowColor = ED_SHOE_SHADOW.color; ctx.shadowBlur = ED_SHOE_SHADOW.blur * K;
      ctx.shadowOffsetX = ED_SHOE_SHADOW.offsetX * K; ctx.shadowOffsetY = ED_SHOE_SHADOW.offsetY * K;
      ctx.drawImage(cutRef.current, bbox.x, bbox.y, bbox.w, bbox.h, dx * K, dy * K, dw * K, dh * K);
      ctx.restore();
      // Selection frame + corner handles (drag a corner to resize, like Canva).
      const X = dx * K, Y = dy * K, WW = dw * K, HH = dh * K, hs = 15;
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.95)'; ctx.lineWidth = 2; ctx.setLineDash([9, 6]);
      ctx.strokeRect(X, Y, WW, HH); ctx.setLineDash([]);
      ctx.fillStyle = '#fff'; ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineWidth = 1.5;
      [[X, Y], [X + WW, Y], [X, Y + HH], [X + WW, Y + HH]].forEach(([hx, hy]) => {
        ctx.beginPath(); ctx.rect(hx - hs / 2, hy - hs / 2, hs, hs); ctx.fill(); ctx.stroke();
      });
      ctx.restore();
    }
    // Title / SKU clearance guides (approximate fonts — just so PH avoids overlap).
    ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.shadowColor = 'rgba(0,0,0,0.85)'; ctx.shadowBlur = 4; ctx.shadowOffsetX = 3; ctx.shadowOffsetY = 3;
    ctx.font = `${ED_TITLE.size * K}px Georgia, serif`;
    ctx.fillText(String(title || sku || '').slice(0, 28), DESIGN * K / 2, ED_TITLE.y * K);
    ctx.font = `${ED_SKU.size * K}px Arial, sans-serif`;
    ctx.fillText(String(sku || '').toUpperCase(), DESIGN * K / 2, ED_SKU.y * K);
    ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
  }, [tf, ready, title, sku]);

  // Client px → design px (independent of how the canvas is CSS-scaled).
  const toDesign = (dClient) => {
    const rect = canvasRef.current.getBoundingClientRect();
    return dClient * (DESIGN / rect.width);
  };
  const toPointDesign = (clientX, clientY) => {
    const rect = canvasRef.current.getBoundingClientRect();
    return { x: (clientX - rect.left) * (DESIGN / rect.width), y: (clientY - rect.top) * (DESIGN / rect.height) };
  };
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  // Is this pointer starting on one of the shoe's corner handles? (design-space hit test)
  const onHandle = (clientX, clientY) => {
    const { bbox, fitScale } = dataRef.current;
    if (!bbox) return false;
    const t = tfRef.current;
    const dw = bbox.w * fitScale * t.scale, dh = bbox.h * fitScale * t.scale;
    const dx = t.cx - dw / 2, dy = t.cy - dh / 2;
    const p = toPointDesign(clientX, clientY);
    const R = 110; // generous touch target (design px ≈ 44px on a phone-scaled canvas)
    return [[dx, dy], [dx + dw, dy], [dx, dy + dh], [dx + dw, dy + dh]]
      .some(([hx, hy]) => Math.hypot(p.x - hx, p.y - hy) <= R);
  };

  const onPointerDown = (e) => {
    canvasRef.current.setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [p1, p2] = [...pointers.current.values()];
      gesture.current.dist = dist(p1, p2);
      gesture.current.mode = 'pinch';
    } else {
      gesture.current.mode = onHandle(e.clientX, e.clientY) ? 'resize' : 'move';
    }
  };
  const onPointerMove = (e) => {
    if (!pointers.current.has(e.pointerId)) return;
    const prev = pointers.current.get(e.pointerId);
    const cur = { x: e.clientX, y: e.clientY };
    pointers.current.set(e.pointerId, cur);
    if (pointers.current.size >= 2) {
      const [p1, p2] = [...pointers.current.values()];
      const d = dist(p1, p2);
      if (gesture.current.dist > 0) {
        const ratio = d / gesture.current.dist;
        setTf((t) => ({ ...t, scale: clampScale(t.scale * ratio) }));
      }
      gesture.current.dist = d;
    } else if (gesture.current.mode === 'resize') {
      // Drag a corner: scale about the centre so the corner tracks the pointer.
      const { refDist } = dataRef.current;
      const p = toPointDesign(cur.x, cur.y);
      const t = tfRef.current;
      setTf((tf2) => ({ ...tf2, scale: clampScale(Math.hypot(p.x - t.cx, p.y - t.cy) / refDist) }));
    } else {
      const dx = toDesign(cur.x - prev.x), dy = toDesign(cur.y - prev.y);
      setTf((t) => ({ ...t, cx: t.cx + dx, cy: t.cy + dy }));
    }
  };
  const endPointer = (e) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) gesture.current.dist = 0;
  };
  // Wheel-to-zoom must be a NATIVE non-passive listener — React 18 registers `wheel`
  // as passive, so preventDefault() in an onWheel prop is a no-op and the page scrolls.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const onWheelNative = (e) => { e.preventDefault(); setTf((t) => ({ ...t, scale: clampScale(t.scale * Math.exp(-e.deltaY * 0.0012)) })); };
    canvas.addEventListener('wheel', onWheelNative, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheelNative);
  }, []);

  const fit = () => setTf({ cx: ED_SHOE_BOX.cx, cy: ED_SHOE_BOX.cy, scale: 1 });
  const nudgeScale = (mult) => setTf((t) => ({ ...t, scale: clampScale(t.scale * mult) }));

  const save = () => {
    const { cutoutUrl, bbox, fitScale } = dataRef.current;
    if (!cutoutUrl || !bbox) return;
    const dw = bbox.w * fitScale * tf.scale, dh = bbox.h * fitScale * tf.scale;
    onSave({ cutoutUrl, bbox, transform: { dx: tf.cx - dw / 2, dy: tf.cy - dh / 2, dw, dh } });
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal shoe-editor" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3 className="modal-title">Position &amp; resize · {label}</h3>
          <button type="button" className="btn icon ghost" onClick={onClose}>×</button>
        </div>

        <div className="se-stage">
          <canvas ref={canvasRef} width={DISP} height={DISP} className="se-canvas"
            onPointerDown={onPointerDown} onPointerMove={onPointerMove}
            onPointerUp={endPointer} onPointerCancel={endPointer} />
          {loading && (
            <div className="se-overlay">
              <div>Cutting out the shoe…</div>
              <div className="se-overlay-bar"><ProgressBar indeterminate /></div>
            </div>
          )}
          {error && !loading && (
            <div className="se-overlay err">
              <div>{error}</div>
              <button type="button" className="btn sm" onClick={() => { setError(''); setLoading(true); setRetryTick((n) => n + 1); }}>Retry</button>
            </div>
          )}
        </div>

        <p className="muted sm se-hint">Drag the shoe to move · <b>drag a corner</b>, pinch, scroll, or use the slider to resize. Text positions are guides.</p>

        <div className="se-controls">
          <button type="button" className="btn icon ghost" disabled={!ready} onClick={() => nudgeScale(1 / 1.08)} title="Smaller">−</button>
          <input className="se-slider" type="range" min="0.2" max="2" step="0.01" disabled={!ready}
            value={tf.scale} onChange={(e) => setTf((t) => ({ ...t, scale: Number(e.target.value) }))} />
          <button type="button" className="btn icon ghost" disabled={!ready} onClick={() => nudgeScale(1.08)} title="Bigger">+</button>
          <span className="se-scale-val">{Math.round(tf.scale * 100)}%</span>
        </div>

        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={fit} disabled={!ready}>Reset to fit</button>
          <button type="button" className="btn primary" onClick={save} disabled={!ready}>Save placement</button>
        </div>
      </div>
    </div>
  );
}
