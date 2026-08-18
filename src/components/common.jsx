// Shared presentational components used across screens: chrome (TopBar, clock),
// status/sync indicators, modals (Modal, HistoryModal, PreferencesModal), the
// calendar switcher, size chips, the Yes/No flag control, the label print dialog,
// and the rescale reported-vs-actual table.
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api.js';
import { STATUS_MAP, statusLabel } from '../statuses.js';
import { EST_FMT, PH_DATETIME, periodLabel, shiftAnchor } from '../lib/format.js';
import { SYNC_FIELDS, sumQty } from '../lib/constants.js';
import { eventLabel, dedupeEvents, eventPhotos } from '../lib/history.js';
import { Icon } from './NavIcons.jsx';
import { sizeNum, compareSizes } from '../lib/codes.js';
import { priceBasisChip } from '../lib/ph.js';
import { LABEL_STOCKS, buildLabelPdf, dispatchPdf, isTouchPrint, canSharePdf, isChunkLoadError } from '../lib/labelPdf.js';

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
//
// Three states, not two. A grouped row's flag is an all-units AND, so a SKU
// received in two waves — sizes 7-9 listed, 10-12 scanned in later — went dark
// again the moment the new pairs joined the group, reading exactly like a SKU
// nobody had touched. When the caller passes a group carrying `flagCounts` (the
// per-flag unit tally from groupPhRows/groupPhSized), a flag that covers some but
// not all of the units renders "partial" with the fraction, so the row says 3/6
// instead of silently understating what's already live.
export function SyncBadges({ item, compact, goatOnly }) {
  const counts = item.flagCounts || null;
  const total = Number(item.qty) || 0;
  const covered = (k) => (counts && total ? counts[k] : (item[k] ? total : 0));
  const isPartial = (k) => !!counts && total > 1 && counts[k] > 0 && counts[k] < total;
  // Compact = the lit ones only, and a partly-listed flag counts as lit (hiding it
  // is what loses the information this whole state exists to surface).
  let fields = compact ? SYNC_FIELDS.filter(([k]) => item[k] || isPartial(k)) : SYNC_FIELDS;
  // "GOAT only" shoes list to Alias and nowhere else — II/StockX/Shopify don't apply.
  if (goatOnly) fields = fields.filter(([k]) => k === 'synced_alias');
  if (!fields.length) return null;
  return (
    <span className="sync-badges">
      {fields.map(([k, ab, label]) => {
        const part = isPartial(k);
        return (
          <span key={k} className={`sync-badge ${item[k] ? 'on' : part ? 'part' : ''}`}
            title={part ? `${label}: ${covered(k)} of ${total} units — the rest still to do`
              : `${label}: ${item[k] ? 'added / synced' : 'not yet'}`}>
            {ab}{part && <span className="sync-badge-frac">{covered(k)}/{total}</span>}
          </span>
        );
      })}
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

export function YesNo({ value, editing, onChange, count, total }) {
  // Same three-state story as SyncBadges, one level down: a size holding two pairs
  // with only one of them listed rolls up to "No", which reads as untouched. Show
  // the fraction instead. (Edit mode stays a plain checkbox — like the "~" mixed
  // cost/price beside it, submitting applies one value to every unit of the size.)
  if (!editing) {
    if (total > 1 && count > 0 && count < total) {
      return <span className="ph-yn part" title={`${count} of ${total} units — the rest still to do`}>{count}/{total}</span>;
    }
    return <span className={`ph-yn ${value ? 'yes' : 'no'}`}>{value ? 'Yes' : 'No'}</span>;
  }
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

// Label printing — one step. Picking Print anywhere in the app opens this dialog:
// choose the stock, hit Print, and the PDF goes straight to the printer (desktop)
// or the OS share sheet (phones), which is where Print actually lives on iOS.
//
// There used to be a full-screen on-screen preview of every label here. It was a
// preview of a preview: the warehouse hit Print, read a page of HTML labels, hit
// Print again, landed in Safari's PDF viewer, and had to dig Print out of the
// share menu — three stages before the print dialog. The PDF is the thing that
// prints, so it's the only preview worth showing, and the share sheet / viewer
// shows it. What's left here is the one choice we can't make for them: the stock.
//
// Two label types:
//  • VIN label  — our SBM- barcode (used to track every unit)
//  • UPC label  — the product's box-style barcode (name / size / colorway / SKU)
//    for NO-BOX shoes, recreating the manufacturer's box label so it scans like
//    a normal boxed pair downstream.
// Both are exact-size, one-label-per-page PDFs (see lib/labelPdf.js) — that's what
// makes them come out at the right scale, without the browser's url/date footer,
// on the warehouse's iPhone → Brother QL label printers.

// Why Print failed, shown in the dialog — the one place the user is looking. A
// stale chunk is the common cause and the fix is a reload, so offer the reload
// rather than making them work that out.
function PrintError({ error }) {
  if (!error) return null;
  return (
    <div className="label-error" role="alert">
      <span>{error.message || String(error)}</span>
      {isChunkLoadError(error)
        ? <button className="btn sm" onClick={() => window.location.reload()}>Reload</button>
        : null}
    </div>
  );
}

// Shared body of the print dialog. `kind` is the labelPdf kind ('vin'|'box'|'shelf').
//
// The PDF is built as soon as the dialog opens (and again whenever the stock
// changes) rather than on the Print click, for one hard reason: iOS only allows
// `navigator.share` inside a live user gesture, and awaiting the build spends it.
// Pre-building keeps the Print handler synchronous, which is what buys the share
// sheet. The build is fast enough that "Preparing…" is rarely seen.
function LabelPrintDialog({ kind, items, count, title, defaultStock, filename, onClose }) {
  const [stock, setStock] = useState(defaultStock);
  const [doc, setDoc] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let dead = false;
    setDoc(null); setError(null);
    buildLabelPdf({ kind, items, stock })
      .then((d) => { if (!dead) setDoc(d); })
      .catch((e) => { if (!dead) setError(e); });
    return () => { dead = true; };
  }, [kind, items, stock]);

  const doPrint = () => {
    if (!doc) return;
    try {
      // Opened here, synchronously, because iOS blocks a `window.open` that comes
      // later — and only when the share sheet isn't available to do the job.
      const preWin = isTouchPrint() && !canSharePdf() ? window.open('', '_blank') : null;
      dispatchPdf(doc, preWin, filename);
      onClose();
    } catch (e) { setError(e); }
  };

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal print-dialog" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">{title}</h3>
        <p className="modal-msg">{count} label{count === 1 ? '' : 's'} — one per page, sized to the stock.</p>
        <label className="print-stock">
          <span className="muted xs">Label stock</span>
          <select value={stock} onChange={(e) => setStock(e.target.value)}>
            {Object.entries(LABEL_STOCKS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </label>
        <PrintError error={error} />
        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={doPrint} disabled={!doc || !!error}>
            <Icon name="print" /> {doc ? 'Print' : 'Preparing…'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// `mode`: 'vin' (default — our SBM tracking label) or 'upc' (box-style label with
// the product UPC barcode, used from the No Box page and the Box Labels tool).
export function LabelSheet({ items, onClose, mode = 'vin' }) {
  const list = items || [];
  const upc = mode === 'upc';
  return (
    <LabelPrintDialog
      kind={upc ? 'box' : 'vin'}
      items={list}
      count={list.length}
      title={upc ? 'Print box labels' : 'Print VIN labels'}
      defaultStock={upc ? 'box' : 'rollo'}
      filename={`${upc ? 'box' : 'vin'}-labels.pdf`}
      onClose={onClose}
    />
  );
}

// Shelf-location labels — a big name + a CODE128 barcode of the location code, one
// location per label so a single shelf never spills across a sheet.
export function ShelfLabelSheet({ locations, onClose }) {
  const list = locations || [];
  return (
    <LabelPrintDialog
      kind="shelf"
      items={list}
      count={list.length}
      title="Print shelf labels"
      defaultStock="cr80"
      filename="shelf-labels.pdf"
      onClose={onClose}
    />
  );
}

// Remove pairs from inventory — the miscount fix, shared by the warehouse Inventory
// page and the PH New Inventory grid so both behave identically.
//
// It's a QUANTITY editor, not a delete button: each size shows what's on file and
// takes a new count, because "there are 3, not 5" is how the warehouse actually finds
// this — nobody knows which two VINs were the phantom ones. Which pairs leave is
// therefore ours to choose, and we pick the NEWEST first: the most recently scanned
// pairs are the least likely to be shelved, priced or already listed. We then name
// them outright before anything happens, because this cannot be undone from the UI.
export function RemoveUnitsModal({ title, sku, units, onClose, onDone }) {
  const sizes = React.useMemo(() => {
    const m = new Map();
    for (const u of units || []) {
      const k = u.size == null || u.size === '' ? '—' : String(u.size);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(u);
    }
    // Newest first within each size — that's the removal order.
    for (const list of m.values()) {
      list.sort((a, b) => (new Date(b.created_at || 0) - new Date(a.created_at || 0))
        || String(b.vin).localeCompare(String(a.vin)));
    }
    return [...m.entries()].sort((a, b) => compareSizes(a[0], b[0]))
      .map(([size, list]) => ({ size, units: list, qty: list.length }));
  }, [units]);

  // keep = how many of that size REMAIN. Starts at the full count (remove nothing).
  const [keep, setKeep] = useState(() => Object.fromEntries(sizes.map((s) => [s.size, s.qty])));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const doomed = sizes.flatMap((s) => {
    const k = Math.max(0, Math.min(s.qty, Number(keep[s.size] ?? s.qty)));
    return s.units.slice(0, s.qty - k);
  });
  const blockedNow = doomed.filter((u) => u.status === 'sold' || u.status === 'shipped');

  async function submit() {
    if (!doomed.length || busy) return;
    setBusy(true); setError('');
    try {
      const res = await api.deleteItems(doomed.map((u) => u.vin), reason.trim());
      onDone(res);
    } catch (e) {
      setError(e.message || 'Could not remove those pairs.');
      setBusy(false);
    }
  }

  return createPortal(
    <div className="modal-overlay" onClick={() => { if (!busy) onClose(); }}>
      <div className="modal remove-units" role="dialog" aria-modal="true" aria-label="Remove pairs" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">Remove pairs</h3>
        <p className="modal-msg">{title}{sku ? <> · <span className="mono">{sku}</span></> : null}</p>

        <div className="rm-sizes">
          {sizes.map((s) => {
            const k = Math.max(0, Math.min(s.qty, Number(keep[s.size] ?? s.qty)));
            const going = s.qty - k;
            return (
              <div className={`rm-size ${going ? 'cut' : ''}`} key={s.size}>
                <span className="rm-size-label">US {s.size}</span>
                <span className="muted sm">on file {s.qty}</span>
                <label className="rm-qty">
                  <span className="muted xs">Keep</span>
                  <input
                    type="number" min={0} max={s.qty} inputMode="numeric" value={k}
                    onChange={(e) => setKeep((o) => ({ ...o, [s.size]: e.target.value === '' ? '' : Number(e.target.value) }))}
                  />
                </label>
                <span className="rm-going">{going ? `− ${going}` : ''}</span>
              </div>
            );
          })}
        </div>

        {doomed.length > 0 && (
          <div className="rm-doomed">
            <div className="muted sm">These {doomed.length} pair{doomed.length === 1 ? '' : 's'} will be deleted — newest scanned first:</div>
            <ul>
              {doomed.slice(0, 12).map((u) => (
                <li key={u.vin}>
                  <span className="mono">{u.vin}</span>
                  <span className="muted sm"> · US {u.size || '—'}{u.location_code ? ` · ${u.location_code}` : ''}{u.status ? ` · ${statusLabel(u.status)}` : ''}</span>
                </li>
              ))}
              {doomed.length > 12 && <li className="muted sm">…and {doomed.length - 12} more</li>}
            </ul>
          </div>
        )}

        {blockedNow.length > 0 && (
          <p className="rm-warn">{blockedNow.length} of these are already sold or shipped — the server will refuse those and remove the rest.</p>
        )}

        <label className="rm-reason">
          <span className="muted xs">Reason (optional — kept with the deleted record)</span>
          <input type="text" value={reason} maxLength={200} placeholder="Miscount, damaged, returned to supplier…"
            onChange={(e) => setReason(e.target.value)} />
        </label>

        {error && <p className="rm-error">{error}</p>}

        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn danger" onClick={submit} disabled={!doomed.length || busy}>
            {busy ? 'Removing…' : `Remove ${doomed.length || ''} pair${doomed.length === 1 ? '' : 's'}`}
          </button>
        </div>
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
