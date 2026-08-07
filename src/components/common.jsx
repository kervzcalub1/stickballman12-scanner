// Shared presentational components used across screens: chrome (TopBar, clock),
// status/sync indicators, modals (Modal, HistoryModal, PreferencesModal), the
// calendar switcher, size chips, the Yes/No flag control, barcodes + labels, and
// the rescale reported-vs-actual table.
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api.js';
import { STATUS_MAP, statusLabel } from '../statuses.js';
import { EST_FMT, PH_DATETIME, periodLabel, shiftAnchor } from '../lib/format.js';
import { SYNC_FIELDS, sumQty } from '../lib/constants.js';
import { eventLabel, dedupeEvents, eventPhotos } from '../lib/history.js';
import { Icon } from './NavIcons.jsx';
import { upcDigits, upcFormat, sizeNum, sizeParts } from '../lib/codes.js';
import { priceBasisChip } from '../lib/ph.js';
import { LABEL_STOCKS, buildLabelPdf, dispatchPdf, isTouchPrint, loadJsBarcode, isChunkLoadError } from '../lib/labelPdf.js';

// Live clock, always rendered in US Eastern with a literal "EST" suffix so the
// PH team (in PH time) is never confused about which timezone a time is in.
export function EstClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);
  return <span className="topbar-clock" title="US Eastern time">{EST_FMT.format(now)} EST</span>;
}

// Item-status pill driven by the central status map (soft colors).
export function StatusPill({ status }) {
  const s = STATUS_MAP[status];
  return <span className="status-pill" style={s ? { color: s.fg, background: s.bg } : undefined}>{statusLabel(status)}</span>;
}

// PH-Team sync indicators surfaced in the admin/warehouse views: Intelligent
// Inventory + Alias / StockX / Shopify. `compact` shows only the lit ones (for a
// list row); otherwise all four show, dim when not yet done.
export function SyncBadges({ item, compact, goatOnly }) {
  let fields = compact ? SYNC_FIELDS.filter(([k]) => item[k]) : SYNC_FIELDS;
  // "GOAT only" shoes list to II + Alias only — StockX/Shopify don't apply.
  if (goatOnly) fields = fields.filter(([k]) => k !== 'synced_stockx' && k !== 'synced_shopify');
  if (!fields.length) return null;
  return (
    <span className="sync-badges">
      {fields.map(([k, ab, label]) => (
        <span key={k} className={`sync-badge ${item[k] ? 'on' : ''}`}
          title={`${label}: ${item[k] ? 'added / synced' : 'not yet'}`}>{ab}</span>
      ))}
    </span>
  );
}

// Where a pair came from, when that changes how it's handled. Only the two
// PH-excluded kinds get a chip — ordinary received/rescaled stock is the 95% case
// and tagging it too would just add noise to every row. So no chip = normal stock.
// `mixed` is for a grouped row where only SOME of the units are that kind.
export function IntakeChip({ kind, mixed }) {
  if (kind === 'existing')
    return (
      <span className="inv-existing-chip" title="Existing stock — counted in from the shelves, predates this system and was already listed to II and the stores">
        {mixed ? 'Part existing' : 'Existing'}
      </span>
    );
  if (kind === 'instore')
    return (
      <span className="inv-instore-chip" title="Bought in-store — listed to Alias by hand, never through the PH team">
        {mixed ? 'Part in-store' : 'In-store'}
      </span>
    );
  return null;
}

// Full-screen viewer for one or more photos (defect-issue photos in history).
export function PhotoLightbox({ photos, onClose }) {
  if (!photos?.length) return null;
  return createPortal(
    <div className="lightbox-overlay" onClick={onClose}>
      <div className="lightbox" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="btn icon ghost lightbox-close" onClick={onClose} aria-label="Close">×</button>
        <div className="lightbox-imgs">
          {photos.map((url, i) => <img key={`${url}-${i}`} src={url} alt={`photo ${i + 1}`} />)}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// A history timeline line + a "view photos" button when the event has photos.
// Shared by the History modal and the Inventory detail view.
export function HistoryLine({ event, onViewPhotos }) {
  const photos = eventPhotos(event);
  return (
    <>
      <div>
        {eventLabel(event)}
        {photos.length > 0 && (
          <button type="button" className="btn xs ghost tl-photos" onClick={() => onViewPhotos(photos)}>
            <Icon name="camera" /> {photos.length} photo{photos.length === 1 ? '' : 's'}
          </button>
        )}
      </div>
    </>
  );
}

// Read-only change history for a PH grid line (its VINs) — who changed what, when.
// Visible to PH team, warehouse, and admin.
export function HistoryModal({ vins, title, onClose }) {
  const [state, setState] = useState({ loading: true, events: [], error: '' });
  const [lightbox, setLightbox] = useState(null);
  useEffect(() => {
    let cancelled = false;
    api.itemHistory(vins)
      .then((d) => { if (!cancelled) setState({ loading: false, events: dedupeEvents(d.events || []), error: '' }); })
      .catch((e) => { if (!cancelled) setState({ loading: false, events: [], error: e.message || 'Failed to load history.' }); });
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal hist-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">History — {title}</h3>
        {state.loading ? <p className="muted">Loading…</p>
          : state.error ? <div className="error">{state.error}</div>
            : !state.events.length ? <p className="muted">No history yet.</p>
              : (
                <div className="timeline hist-timeline">
                  {state.events.map((e) => (
                    <div className="tl-item" key={e.id}>
                      <div className="tl-dot" />
                      <div className="tl-body">
                        <HistoryLine event={e} onViewPhotos={setLightbox} />
                        <div className="muted sm">{PH_DATETIME.format(new Date(e.created_at))} EST{e.vin ? ` · ${e.vin}` : ''}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
        <div className="modal-actions"><button className="btn ghost" onClick={onClose}>Close</button></div>
        <PhotoLightbox photos={lightbox} onClose={() => setLightbox(null)} />
      </div>
    </div>,
    document.body,
  );
}

// Lightweight result dialog used to confirm a success or surface a failure.
// Click the backdrop or press Escape to dismiss.
export function Modal({ type, title, message, onClose, children }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className={`modal ${type}`}
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={`modal-icon ${type}`}>{type === 'success' ? '✓' : type === 'warn' ? '!' : '✕'}</div>
        <h3 className="modal-title">{title}</h3>
        <p className="modal-msg">{message}</p>
        <div className="modal-actions">{children}</div>
      </div>
    </div>
  );
}

export function TopBar({ title, onHome, onSignOut, right }) {
  return (
    <header className="topbar">
      <div className="brand">
        <img className="brand-logo" src="/logo.png" alt="" />
        <span>{title || 'Stickballman12'}</span>
      </div>
      <EstClock />
      <div className="topbar-actions">
        {right}
        {onHome && <button className="btn ghost sm" onClick={onHome}>← Home</button>}
        <button className="btn ghost sm" onClick={onSignOut}>Sign out</button>
      </div>
    </header>
  );
}

// Small count pills under a home card. `badges` = [[label, n], …]; only n>0 show.
export function CardBadges({ badges }) {
  // Each badge: [label, count, variant?] — variant 'ok' (green) | default (amber).
  const shown = (badges || []).filter(([, n]) => Number(n) > 0);
  if (!shown.length) return null;
  return (
    <span className="card-badges">
      {shown.map(([label, n, variant]) => (
        <span key={label} className={`card-badge${variant ? ` card-badge--${variant}` : ''}`}>{label} {n}</span>
      ))}
    </span>
  );
}

// Progress bar for any waiting process. Pass `value` (0–1) for real/determinate
// progress, or `indeterminate` for a moving bar when the total isn't known. `label`
// is optional text under the bar (e.g. "Rendering 3 of 7 slides…").
export function ProgressBar({ value, label, indeterminate = false }) {
  const pct = Math.max(0, Math.min(1, Number(value) || 0)) * 100;
  return (
    <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round(pct)}>
      <div className="progress-track">
        <div className={`progress-fill${indeterminate ? ' indet' : ''}`}
          style={indeterminate ? undefined : { width: `${pct}%` }} />
      </div>
      {label && <div className="progress-label muted sm">{label}</div>}
    </div>
  );
}

// Shipment tracking as a milestone timeline — the full checkpoint history (newest first)
// from 17TRACK. A connecting line runs down the nodes; the latest checkpoint is emphasized
// (green check on delivery, otherwise an accent node with a soft pulse), earlier ones dim.
const fmtEventTime = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};
export function TrackingTimeline({ events, status }) {
  const list = Array.isArray(events) ? events.filter((e) => e && (e.description || e.time)) : [];
  if (!list.length) return null;
  const isDeliveredStage = (e, top) => /deliver/i.test(e?.stage || '') || (top && /deliver/i.test(status || ''));
  return (
    <ol className="tl" aria-label="Tracking history">
      {list.map((e, i) => {
        const top = i === 0;
        const delivered = isDeliveredStage(e, top);
        return (
          <li key={i} className={`tl-row${top ? ' current' : ''}${delivered ? ' delivered' : ''}`}>
            <span className="tl-marker"><span className="tl-dot">{delivered ? '✓' : ''}</span></span>
            <div className="tl-content">
              <div className="tl-desc">{e.description || e.stage || '—'}</div>
              <div className="tl-meta">
                {e.location ? <span className="tl-loc">📍 {e.location}</span> : null}
                {e.time ? <span className="tl-time">{fmtEventTime(e.time)}</span> : null}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// Reusable Day/Week/Month calendar switcher. Controlled: parent owns
// {mode, anchor} and reloads when onChange fires. Pages compute from/to with
// periodRange(mode, anchor).map(ymd).
export function DateRangeBar({ mode, anchor, onChange, right }) {
  return (
    <div className="cal-bar">
      <div className="seg cal-modes" role="group" aria-label="Date range">
        {[['day', 'Day'], ['week', 'Week'], ['month', 'Month']].map(([m, lbl]) => (
          <button key={m} type="button" className={`seg-btn ${mode === m ? 'on' : ''}`} onClick={() => onChange(m, anchor)}>{lbl}</button>
        ))}
      </div>
      <div className="cal-nav">
        <button type="button" className="btn ghost sm" onClick={() => onChange(mode, shiftAnchor(mode, anchor, -1))} aria-label="Previous">‹</button>
        <span className="cal-label">{periodLabel(mode, anchor)}</span>
        <button type="button" className="btn ghost sm" onClick={() => onChange(mode, shiftAnchor(mode, anchor, 1))} aria-label="Next">›</button>
        <button type="button" className="btn ghost sm" onClick={() => onChange(mode, new Date())}>Today</button>
      </div>
      {right}
    </div>
  );
}

// Sizes as discrete chips (clearer than a run-on string when there are many).
export function SizesQty({ sizes }) {
  if (!sizes || !sizes.length) return <span className="muted">—</span>;
  return (
    <span className="szq">
      {sizes.map((s) => <span className="szq-chip" key={s.size}><span className="szq-size">{s.size}</span><span className="szq-qty">×{s.qty}</span></span>)}
    </span>
  );
}

// Edit-mode price / global-indicator field. Money inputs used to share the
// exact background of the panel they sat in (--panel-2 on --panel-2), so a
// blank "fill me in" field for brand-new inventory read as invisible. A
// contrasting background + leading "$" + placeholder make it unmistakable.
export function PriceInput({ value, onChange, className = '', ...rest }) {
  return (
    <span className="ph-price-wrap">
      <span className="ph-price-prefix" aria-hidden="true">$</span>
      <input
        className={`ph-price ${className}`.trim()}
        type="number" min="0" step="0.01" inputMode="decimal" placeholder="0.00"
        value={value} onChange={onChange} {...rest}
      />
    </span>
  );
}

// Small chip beside an indicator that came from below rank 1 of the pricing
// hierarchy — "WY", "LOW", "LAST·WY" and so on, so PH can see at a glance WHICH
// level priced the size. Nothing renders for the plain consigned Global Indicator
// (the normal case) or for a hand-typed price. Shared by the PH grid and the
// Rescale Requests listing editor. See docs/context/ph-report.md.
export function BasisChip({ basis }) {
  const chip = priceBasisChip(basis);
  if (!chip) return null;
  return <span className={`ph-basis-chip ph-basis-${chip.tone}`} title={chip.title}>{chip.short}</span>;
}

export function YesNo({ value, editing, onChange }) {
  if (!editing) return <span className={`ph-yn ${value ? 'yes' : 'no'}`}>{value ? 'Yes' : 'No'}</span>;
  // Edit mode: a colored checkbox (blue = checked/yes, red = unchecked/no) — a
  // ✓/✕ glyph marks the state too (color alone isn't enough contrast/signal).
  // Wrapped in a <label> so the tap target is bigger than the visible control
  // (native browser behavior — clicking anywhere in the label toggles the
  // nested checkbox, no JS needed) — mobile-friendly without a huge glyph.
  return (
    <label className="ph-yn-hit" title={value ? 'Yes' : 'No'}>
      <input type="checkbox" className={`ph-yn-check ${value ? 'yes' : 'no'}`} checked={!!value}
        onChange={(e) => onChange(e.target.checked)} aria-label={value ? 'Yes' : 'No'} />
    </label>
  );
}

// Barcode via jsbarcode (lazy-loaded). `format` defaults to CODE128 (our VIN);
// for product UPCs pass a retail format — falls back to CODE128 if the value
// doesn't satisfy that symbology (wrong length / bad check digit).
// A barcode that can't be drawn used to leave an EMPTY <svg> behind — on a box
// label that's a blank barcode column, which looks like a label with no barcode
// rather than a broken page, so the fix (reload) is invisible. Say it instead.
export function Barcode({ value, format = 'CODE128', displayValue = false, height = 42 }) {
  const ref = useRef(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    loadJsBarcode().then((JsBarcode) => {
      if (cancelled || !ref.current) return;
      const opts = { displayValue, height, width: 1.6, margin: 0, fontSize: 13 };
      // CODE128 encodes anything the retail symbologies reject (wrong length, bad
      // check digit), so the fallback all but always draws.
      try { JsBarcode(ref.current, value, { format, ...opts }); }
      catch {
        try { JsBarcode(ref.current, value, { format: 'CODE128', ...opts }); }
        catch { setFailed(true); }
      }
    }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [value, format, displayValue, height]);
  if (failed) return <span className="barcode-fail">Barcode didn’t load — reload the page</span>;
  return <svg ref={ref} className="barcode-svg" />;
}

// Small square shoe thumbnail for list rows — the SKU's listing photo (side view
// preferred, chosen server-side), falling back to the app logo when there are no
// listing photos (or the image fails to load). When `onOpen` is given AND a photo
// exists, it renders as a button (opens the photo viewer/download).
export function ShoeThumb({ url, onOpen, size = 36 }) {
  const [broken, setBroken] = useState(false);
  const hasPhoto = !!url && !broken;
  const img = (
    <img className={`shoe-thumb${hasPhoto ? '' : ' is-logo'}`} src={hasPhoto ? url : '/logo.png'} alt=""
      loading="lazy" width={size} height={size} onError={() => setBroken(true)} />
  );
  // Clickable whenever the caller offers a viewer (it gates onOpen on photo_count>0),
  // even if there's no representative `url` — e.g. a SKU with only extra1/extra2
  // photos has photo_count>0 but photo_url=null, and must still be openable.
  if (onOpen) {
    return (
      <button type="button" className="shoe-thumb-btn" title="View / download listing photos"
        onClick={(e) => { e.stopPropagation(); onOpen(); }}>{img}</button>
    );
  }
  return <span className="shoe-thumb-wrap">{img}</span>;
}

// Full-screen single-image preview with zoom in/out/reset. Works for both remote
// URLs and local object: URLs. Zoom widens the image inside a scrollable viewport
// (so panning is native scroll/touch on every device); double-click toggles 1x↔2x.
// Esc / +/- are wired; click the backdrop to close.
// Optional `onPrev`/`onNext` (falsy = hidden) add left/right browsing through a set.
export function ImageZoomModal({ url, label, onClose, onPrev, onNext }) {
  const [scale, setScale] = useState(1);
  const MIN = 1; const MAX = 4; const STEP = 0.5;
  const zoomIn = () => setScale((s) => Math.min(MAX, +(s + STEP).toFixed(2)));
  const zoomOut = () => setScale((s) => Math.max(MIN, +(s - STEP).toFixed(2)));
  const reset = () => setScale(1);
  useEffect(() => { setScale(1); }, [url]); // reset zoom when the image changes
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === '+' || e.key === '=') zoomIn();
      else if (e.key === '-' || e.key === '_') zoomOut();
      else if (e.key === '0') reset();
      else if (e.key === 'ArrowLeft' && onPrev) onPrev();
      else if (e.key === 'ArrowRight' && onNext) onNext();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, onPrev, onNext]);
  if (!url) return null;
  return createPortal(
    <div className="modal-overlay izm-overlay" onClick={onClose}>
      <div className="izm" role="dialog" aria-modal="true" aria-label={label || 'Image preview'} onClick={(e) => e.stopPropagation()}>
        <div className="izm-bar">
          <span className="izm-label">{label || ''}</span>
          <div className="izm-tools">
            <button type="button" className="btn icon ghost" onClick={zoomOut} disabled={scale <= MIN} title="Zoom out" aria-label="Zoom out">−</button>
            <span className="izm-scale">{Math.round(scale * 100)}%</span>
            <button type="button" className="btn icon ghost" onClick={zoomIn} disabled={scale >= MAX} title="Zoom in" aria-label="Zoom in">+</button>
            <button type="button" className="btn icon ghost" onClick={reset} disabled={scale === 1} title="Reset zoom" aria-label="Reset zoom">⤢</button>
            <button type="button" className="btn icon ghost" onClick={onClose} title="Close" aria-label="Close">×</button>
          </div>
        </div>
        <div className={`izm-viewport ${scale > 1 ? 'zoomed' : ''}`} onDoubleClick={() => setScale((s) => (s > 1 ? 1 : 2))}>
          {onPrev && <button type="button" className="izm-nav prev" onClick={onPrev} title="Previous" aria-label="Previous">‹</button>}
          <img src={url} alt={label || ''} className={`izm-img ${scale > 1 ? 'zoomed' : ''}`}
            style={scale > 1 ? { width: `${scale * 100}%` } : undefined} draggable={false} />
          {onNext && <button type="button" className="izm-nav next" onClick={onNext} title="Next" aria-label="Next">›</button>}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// Copy `text` to the clipboard; falls back to a hidden <textarea> + execCommand
// when the async Clipboard API is unavailable (older browser / insecure origin).
export async function copyToClipboard(text) {
  const s = String(text ?? '');
  if (!s) return false;
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(s); return true; }
  } catch { /* fall through to legacy path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = s; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.focus(); ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}

// Inline click-to-copy text. Clicking copies `text` (defaults to the rendered
// children) and briefly shows a "Copied" cue. Stops propagation so it never
// triggers a parent row's expand/select. Renders plain (non-interactive) when
// there's nothing to copy — e.g. a "—" placeholder.
export function CopyText({ text, children, className = '', title }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const value = text ?? (typeof children === 'string' ? children : '');
  if (!value) return <span className={className}>{children}</span>;
  const onCopy = async (e) => {
    e.stopPropagation();
    if (await copyToClipboard(value)) {
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1200);
    }
  };
  return (
    <span
      role="button" tabIndex={0}
      className={`copytext ${copied ? 'copied' : ''} ${className}`.trim()}
      title={title || `Copy “${value}”`}
      aria-label={`Copy ${value}`}
      onClick={onCopy}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onCopy(e); } }}
    >
      {children ?? value}
      <span className="copytext-cue" aria-hidden="true">{copied ? 'Copied ✓' : 'Copy'}</span>
    </span>
  );
}

// Printable labels for label-printer rolls (Rollo / Dymo). Two types:
//  • VIN label  — our SBM- barcode (used to track every unit)
//  • UPC label  — the product's box-style barcode (name / size / colorway / SKU)
//    for NO-BOX shoes, recreating the manufacturer's box label so it scans like
//    a normal boxed pair downstream.
// `mode`: 'vin' (default — our SBM tracking label) or 'upc' (box-style label with
// the product UPC barcode, used only from the No Box page). Box-style matches the
// real shoe-box label: vertical UPC barcode on the left, text stacked on the right.
// Printing generates an exact-size, one-label-per-page PDF (see lib/labelPdf.js) —
// this is what makes labels come out at the right scale, without the browser's
// url/date footer, on the warehouse's iPhone → Brother QL label printers.
// Big size with the men's/women's marker beside it ("9 W"), mirroring the PDF.
// Why the Print button did nothing, shown ON the preview — the one place the
// user is looking. A stale chunk is the common cause and the fix is a reload, so
// offer the reload rather than making them work that out.
function PrintError({ error }) {
  if (!error) return null;
  return (
    <div className="label-error no-print" role="alert">
      <span>{error.message || String(error)}</span>
      {isChunkLoadError(error)
        ? <button className="btn sm" onClick={() => window.location.reload()}>Reload</button>
        : null}
    </div>
  );
}

function BoxLabelSize({ item }) {
  const { num, suffix } = sizeParts(item.size, item.gender, item.name);
  return (
    <div className="blabel-size">
      {num || '—'}{suffix ? <span className="blabel-size-g">{suffix}</span> : null}
    </div>
  );
}

export function LabelSheet({ items, onClose, mode = 'vin' }) {
  const list = items || [];
  const [size, setSize] = useState(mode === 'upc' ? 'box' : 'rollo');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const s = LABEL_STOCKS[size];
  const doPrint = () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const preWin = isTouchPrint() ? window.open('', '_blank') : null;
    buildLabelPdf({ kind: mode === 'upc' ? 'box' : 'vin', items: list, stock: size })
      .then((doc) => dispatchPdf(doc, preWin, `${mode === 'upc' ? 'box' : 'vin'}-labels.pdf`))
      .catch((e) => { if (preWin) preWin.close(); setError(e); })
      .finally(() => setBusy(false));
  };
  return createPortal(
    <div className="label-overlay" style={{ '--lw': `${s.long}mm`, '--lh': `${s.short}mm` }}>
      <div className="label-toolbar no-print">
        <span>{list.length} {mode === 'upc' ? 'box' : 'VIN'} label(s)</span>
        <span className="label-tools">
          <select value={size} onChange={(e) => setSize(e.target.value)}>
            {Object.entries(LABEL_STOCKS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          <button className="btn ghost sm" onClick={onClose}>Close</button>
          <button className="btn primary sm" onClick={doPrint} disabled={busy}><Icon name="print" /> {busy ? 'Building…' : 'Print'}</button>
        </span>
      </div>
      <PrintError error={error} />
      <div className="label-roll">
        {list.map((it, i) => (mode === 'upc' ? (
          upcDigits(it.upc) ? (
            // Box-style label: vertical UPC barcode (left) + text block (right).
            <div className="rlabel boxlabel" key={it.vin || i}>
              <div className="blabel-bc"><Barcode value={upcDigits(it.upc)} format={upcFormat(it.upc)} displayValue height={44} /></div>
              <div className="blabel-text">
                <div className="blabel-name">{(it.name || '—').toUpperCase()}</div>
                {it.colorway ? <div className="blabel-cw">{String(it.colorway).toUpperCase()}</div> : null}
                <BoxLabelSize item={it} />
                <div className="blabel-sku">{it.sku || '—'}</div>
              </div>
            </div>
          ) : (
            <div className="rlabel boxlabel missing" key={it.vin || i}>
              <div className="blabel-text">
                <div className="blabel-name">{(it.name || '—').toUpperCase()}</div>
                {it.colorway ? <div className="blabel-cw">{String(it.colorway).toUpperCase()}</div> : null}
                <BoxLabelSize item={it} />
                <div className="blabel-sku">{it.sku || '—'}</div>
                <div className="rlabel-vinlabel">No UPC on file{it.vin ? ` — ${it.vin}` : ''}</div>
              </div>
            </div>
          )
        ) : (
          <div className="rlabel" key={it.vin || i}>
            {it.name ? <div className="rlabel-name">{String(it.name).toUpperCase()}</div> : null}
            <div className="rlabel-top">
              <span className="rlabel-sku">{it.sku || '—'}</span>
              <span className="rlabel-sep">|</span>
              <span className="rlabel-size">{it.size || '—'}</span>
            </div>
            <div className="rlabel-vinlabel">VIN: <b>{it.vin}</b></div>
            <Barcode value={it.vin} />
            <div className="rlabel-vin">{it.vin}</div>
          </div>
        )))}
      </div>
    </div>,
    document.body,
  );
}

// Shelf-location labels — a big name + a CODE128 barcode of the location code.
// Printing generates an exact-size, one-label-per-page PDF (see lib/labelPdf.js),
// so a single location prints on a single label — not spilled across a sheet by
// the browser's print dialog.
export function ShelfLabelSheet({ locations, onClose }) {
  const list = locations || [];
  const [size, setSize] = useState('cr80');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const s = LABEL_STOCKS[size];
  const doPrint = () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const preWin = isTouchPrint() ? window.open('', '_blank') : null;
    buildLabelPdf({ kind: 'shelf', items: list, stock: size })
      .then((doc) => dispatchPdf(doc, preWin, 'shelf-labels.pdf'))
      .catch((e) => { if (preWin) preWin.close(); setError(e); })
      .finally(() => setBusy(false));
  };
  return createPortal(
    <div className="label-overlay shelf-overlay" style={{ '--lw': `${s.long}mm`, '--lh': `${s.short}mm` }}>
      <div className="label-toolbar no-print">
        <span>{list.length} shelf label{list.length === 1 ? '' : 's'}</span>
        <span className="label-tools">
          <select value={size} onChange={(e) => setSize(e.target.value)}>
            {Object.entries(LABEL_STOCKS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          <button className="btn ghost sm" onClick={onClose}>Close</button>
          <button className="btn primary sm" onClick={doPrint} disabled={busy}><Icon name="print" /> {busy ? 'Building…' : 'Print'}</button>
        </span>
      </div>
      <PrintError error={error} />
      <div className="shelf-sheet">
        {list.map((loc) => (
          <div className="shelf-label" key={loc.code}>
            <div className="shelf-label-name">{loc.label || loc.code}</div>
            <div className="shelf-label-sub">{loc.warehouse}{loc.area ? ` · ${loc.area}` : ''}</div>
            <div className="shelf-label-bc"><Barcode value={loc.code} format="CODE128" height={48} /></div>
            <div className="shelf-label-code">{loc.code}</div>
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
}

// Preferences — saved automatically (localStorage) as the user toggles.
export function PreferencesModal({ prefs, onCameraZoom, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal prefs"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="modal-title">Preferences</h3>

        <div className="pref-row">
          <div className="pref-text">
            <div className="pref-label">Camera zoom</div>
            <div className="pref-help">Zoom in so you can scan from farther away.</div>
          </div>
          <div className="zoom-toggle" role="group" aria-label="Camera zoom">
            {[1, 2].map((z) => (
              <button
                key={z}
                type="button"
                className={`btn sm ${prefs.cameraZoom === z ? 'primary' : 'ghost'}`}
                aria-pressed={prefs.cameraZoom === z}
                onClick={() => onCameraZoom(z)}
              >
                {z}×
              </button>
            ))}
          </div>
        </div>

        <div className="modal-actions">
          <button className="btn primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

// Rescale reported-vs-actual comparison table (size columns + totals).
export function RescaleCompare({ reported, actual }) {
  const sizes = [...new Set([...(reported || []).map((s) => String(s.size)), ...(actual || []).map((s) => String(s.size))])]
    .sort((a, b) => (sizeNum(a) - sizeNum(b)) || a.localeCompare(b));
  const rep = Object.fromEntries((reported || []).map((s) => [String(s.size), s.qty]));
  const act = actual ? Object.fromEntries(actual.map((s) => [String(s.size), s.qty])) : null;
  return (
    <table className="rcmp">
      <tbody>
        <tr className="rcmp-head"><td>Size →</td><>{sizes.map((s) => <td key={s}>{s}</td>)}</><td>Total</td></tr>
        <tr><td className="rcmp-lbl">Reported</td>{sizes.map((s) => <td key={s}>{rep[s] ?? '·'}</td>)}<td><b>{sumQty(reported)}</b></td></tr>
        <tr><td className="rcmp-lbl">Actual</td>{sizes.map((s) => {
          if (!act) return <td key={s} className="muted">—</td>;
          const a = act[s] ?? 0; const r = rep[s] ?? 0;
          return <td key={s} className={a !== r ? 'rcmp-diff' : 'rcmp-match'}>{a}</td>;
        })}<td>{act ? <b>{sumQty(actual)}</b> : <span className="muted">pending</span>}</td></tr>
      </tbody>
    </table>
  );
}
