// PH Image Finder — build a SKU's branded listing set. Enter/scan a SKU → we resolve
// the shoe + its curated GOAT gallery, pre-pick the confident angles; PH assigns the
// rest by tapping a gallery image or uploading their own for a blank slot. "Brand &
// Fill" then composites each pick onto the Stickballman12 template with the name + SKU,
// auto-builds the spec slide, and appends the static welcome slide — all saved as this
// SKU's edited listing photos (source='ph_edited').
import React, { useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { TopBar, ShoeThumb, ImageZoomModal } from '../components/common.jsx';
import { Icon } from '../components/NavIcons.jsx';

// The 5 shoe-angle slots (templates 1–5), in listing order.
const SLOTS = [
  { angle: 'side', label: 'Lateral' },
  { angle: 'diagonal', label: '3/4' },
  { angle: 'top', label: 'Top' },
  { angle: 'outsole', label: 'Sole' },
  { angle: 'rear', label: 'Heel' },
];
const SLOT_LABEL = Object.fromEntries(SLOTS.map((s) => [s.angle, s.label]));
// Labels + listing order for the branded preview (angles + the two extra slides).
const RESULT_LABEL = { ...SLOT_LABEL, spec: 'Spec', welcome: 'Welcome' };
const RESULT_ORDER = ['side', 'diagonal', 'top', 'outsole', 'rear', 'spec', 'welcome'];

export function ImageFinder({ onHome, onSignOut }) {
  const [skuInput, setSkuInput] = useState('');
  const [product, setProduct] = useState(null);
  const [title, setTitle] = useState('');             // editable shoe name stamped on each slide
  const [picks, setPicks] = useState({});             // angle -> image url (gallery or uploaded)
  const [uploaded, setUploaded] = useState({});       // angle -> true (came from a PH upload)
  const [activeSlot, setActiveSlot] = useState(SLOTS[0].angle);
  const [includeSpec, setIncludeSpec] = useState(true);
  const [includeWelcome, setIncludeWelcome] = useState(true);
  const [looking, setLooking] = useState(false);
  const [branding, setBranding] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [uploadingSlot, setUploadingSlot] = useState(null);
  const [notConfigured, setNotConfigured] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [results, setResults] = useState(null);
  const [previewIdx, setPreviewIdx] = useState(null); // index into `branded` for the zoom modal
  const fileRefs = useRef({});

  async function lookUp(e) {
    e?.preventDefault();
    const sku = skuInput.trim();
    if (!sku) return;
    setLooking(true); setError(''); setNotice(''); setNotConfigured(false);
    setProduct(null); setPicks({}); setUploaded({}); setResults(null); setActiveSlot(SLOTS[0].angle);
    try {
      const { configured, product: p } = await api.imageFinderSearch(sku);
      if (configured === false) { setNotConfigured(true); return; }
      if (!p) { setError('No match found for that SKU.'); return; }
      setProduct(p); setTitle(p.title || '');
      const seeded = {};
      for (const s of (p.suggestions || [])) seeded[s.angle] = s.url;
      setPicks(seeded);
    } catch (err) {
      if (err.unauthorized) return onSignOut();
      setError(err.message);
    } finally { setLooking(false); }
  }

  function assignFrame(url) {
    setPicks((p) => ({ ...p, [activeSlot]: url }));
    setUploaded((u) => { const n = { ...u }; delete n[activeSlot]; return n; });
    setResults(null);
  }
  function toggleSlot(angle) {
    setActiveSlot(angle);
    setPicks((p) => {
      if (p[angle]) { const n = { ...p }; delete n[angle]; return n; }
      const sug = (product?.suggestions || []).find((s) => s.angle === angle);
      return { ...p, [angle]: sug?.url || product?.images?.[0] || product?.hero };
    });
  }

  // Upload a PH photo into a blank (or any) slot: raw bytes → R2 via presign, then the
  // slot points at that R2 URL. Brand & Fill will template it like a gallery pick.
  async function uploadToSlot(angle, file) {
    if (!file || !product) return;
    const type = /jpeg|jpg|png|webp/i.test(file.type) ? file.type : 'image/jpeg';
    setUploadingSlot(angle); setError('');
    try {
      const { uploadUrl, publicUrl } = await api.photoSign(product.sku, angle, type, 'ph_edited');
      const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': type }, body: file });
      if (!put.ok) throw new Error('Upload failed. Try again.');
      setPicks((p) => ({ ...p, [angle]: publicUrl }));
      setUploaded((u) => ({ ...u, [angle]: true }));
      setActiveSlot(angle); setResults(null);
    } catch (err) {
      if (err.unauthorized) return onSignOut();
      setError(err.message);
    } finally { setUploadingSlot(null); }
  }

  const chosen = useMemo(
    () => SLOTS.filter((s) => picks[s.angle]).map((s) => ({ angle: s.angle, url: picks[s.angle] })),
    [picks],
  );
  const canBrand = chosen.length > 0 || includeSpec || includeWelcome;

  async function brandFill() {
    if (!product || !canBrand) return;
    setBranding(true); setError(''); setNotice(''); setResults(null);
    try {
      const { saved, results: r } = await api.imageFinderBrand(product.sku, title.trim(), chosen, includeSpec, includeWelcome);
      setResults(r || []);
      if (saved > 0) setNotice(`Branded ${saved} slide${saved === 1 ? '' : 's'} for ${product.sku}.`);
      else setError('Nothing was saved — see the errors below.');
    } catch (err) {
      if (err.unauthorized) return onSignOut();
      setError(err.message);
    } finally { setBranding(false); }
  }

  // Download every branded slide for this SKU as a zip (all ph_edited photos).
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

  const images = product?.images || [];
  const resBySlot = useMemo(() => Object.fromEntries((results || []).map((r) => [r.slot, r])), [results]);
  const branded = useMemo(
    () => (results || []).filter((r) => r.ok && r.url)
      .sort((a, b) => RESULT_ORDER.indexOf(a.slot) - RESULT_ORDER.indexOf(b.slot)),
    [results],
  );

  return (
    <div className="app">
      <TopBar title="Image Finder" onHome={onHome} onSignOut={onSignOut} />
      <div className="card">
        <p className="muted sm">
          Build a SKU’s branded listing set. Assign an angle by tapping a gallery photo, or <b>Upload</b> your own for a
          blank slot. <b>Brand &amp; Fill</b> drops each onto your template with the name &amp; SKU, auto-builds the spec
          slide, and adds the welcome slide.
        </p>

        <form className="pi-lookup" onSubmit={lookUp}>
          <input
            className="pi-sku-input" type="text" inputMode="text" autoCapitalize="characters"
            placeholder="Enter a SKU (e.g. JR1598)" value={skuInput}
            onChange={(e) => setSkuInput(e.target.value)} disabled={looking} />
          <button type="submit" className="btn" disabled={looking || !skuInput.trim()}>
            <Icon name="image" /> {looking ? 'Finding…' : 'Find images'}
          </button>
        </form>

        {error && <div className="error mt">{error}</div>}
        {notice && <div className="notice mt">{notice}</div>}
        {notConfigured && <div className="notice mt">Image lookup isn’t configured on the server (KicksDB key missing).</div>}

        {product && (
          <>
            <div className="pi-product mt">
              <ShoeThumb url={product.hero} size={52} />
              <div className="pi-product-info">
                <div className="pi-product-name">{product.title || '—'}</div>
                <div className="muted sm">
                  <span className="pi-product-sku">{product.sku || '—'}</span>
                  {product.brand ? <span> · {product.brand}</span> : null}
                  {images.length ? <span> · {images.length} photo{images.length === 1 ? '' : 's'}{product.sourceLabel ? ` · ${product.sourceLabel}` : ''}</span> : null}
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
                const res = resBySlot[s.angle];
                const on = !!url;
                const busy = uploadingSlot === s.angle;
                return (
                  <div key={s.angle}
                    className={`if-slot ${activeSlot === s.angle ? 'active' : ''} ${on ? '' : 'off'}`.trim()}
                    onClick={() => setActiveSlot(s.angle)}>
                    <div className="if-slot-frame">
                      {url ? <img src={url} alt={s.label} loading="lazy" /> : <span className="if-slot-empty">{busy ? 'Uploading…' : 'Empty'}</span>}
                      {uploaded[s.angle] && <span className="if-slot-tag">Uploaded</span>}
                      {res && <span className={`if-slot-badge ${res.ok ? 'ok' : 'bad'}`}>{res.ok ? '✓' : '!'}</span>}
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
            {images.length > 0 && (
              <div className="if-strip-wrap mt">
                <div className="if-strip-head muted sm">Assign to <b>{SLOT_LABEL[activeSlot]}</b> — tap a photo</div>
                <div className="if-strip">
                  {images.map((url, i) => (
                    <button type="button" key={i}
                      className={`if-frame ${picks[activeSlot] === url ? 'sel' : ''}`.trim()}
                      onClick={() => assignFrame(url)} title={`Photo ${i + 1}`}>
                      <img src={url} alt={`Photo ${i + 1}`} loading="lazy" />
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Extra slides. */}
            <div className="if-extras mt">
              <label className="if-check">
                <input type="checkbox" checked={includeSpec} onChange={(e) => setIncludeSpec(e.target.checked)} />
                <span>Spec slide <span className="muted sm">— colour + materials, auto-filled</span></span>
                {resBySlot.spec && <span className={`if-slot-badge inline ${resBySlot.spec.ok ? 'ok' : 'bad'}`}>{resBySlot.spec.ok ? '✓' : '!'}</span>}
              </label>
              <label className="if-check">
                <input type="checkbox" checked={includeWelcome} onChange={(e) => setIncludeWelcome(e.target.checked)} />
                <span>Welcome slide <span className="muted sm">— static store intro</span></span>
                {resBySlot.welcome && <span className={`if-slot-badge inline ${resBySlot.welcome.ok ? 'ok' : 'bad'}`}>{resBySlot.welcome.ok ? '✓' : '!'}</span>}
              </label>
            </div>

            <div className="if-actions mt">
              <button type="button" className="btn primary" disabled={branding || !canBrand} onClick={brandFill}>
                <Icon name="image" /> {branding ? 'Branding…' : `Brand & Fill (${chosen.length + (includeSpec ? 1 : 0) + (includeWelcome ? 1 : 0)})`}
              </button>
            </div>

            {/* Preview + download the branded set. */}
            {branded.length > 0 && (
              <div className="if-preview mt">
                <div className="if-preview-head">
                  <span className="if-preview-title">Branded set <span className="muted sm">· tap to view full size</span></span>
                  <button type="button" className="btn sm" disabled={downloading} onClick={downloadAll}>
                    <Icon name="download" /> {downloading ? 'Zipping…' : 'Download all'}
                  </button>
                </div>
                <div className="if-preview-grid">
                  {branded.map((r, i) => (
                    <button type="button" key={r.slot} className="if-preview-item" onClick={() => setPreviewIdx(i)}>
                      <img src={r.url} alt={RESULT_LABEL[r.slot] || r.slot} loading="lazy" />
                      <span className="if-preview-label">{RESULT_LABEL[r.slot] || r.slot}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
      {previewIdx != null && branded[previewIdx] && (
        <ImageZoomModal
          url={branded[previewIdx].url}
          label={RESULT_LABEL[branded[previewIdx].slot] || branded[previewIdx].slot}
          onClose={() => setPreviewIdx(null)}
          onPrev={previewIdx > 0 ? () => setPreviewIdx(previewIdx - 1) : undefined}
          onNext={previewIdx < branded.length - 1 ? () => setPreviewIdx(previewIdx + 1) : undefined}
        />
      )}
    </div>
  );
}
