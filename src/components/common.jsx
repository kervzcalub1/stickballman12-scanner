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
import { eventLabel, dedupeEvents } from '../lib/history.js';
import { upcDigits, upcFormat, sizeNum } from '../lib/codes.js';

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
export function SyncBadges({ item, compact }) {
  const fields = compact ? SYNC_FIELDS.filter(([k]) => item[k]) : SYNC_FIELDS;
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

// Read-only change history for a PH grid line (its VINs) — who changed what, when.
// Visible to PH team, warehouse, and admin.
export function HistoryModal({ vins, title, onClose }) {
  const [state, setState] = useState({ loading: true, events: [], error: '' });
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
                        <div>{eventLabel(e)}</div>
                        <div className="muted sm">{PH_DATETIME.format(new Date(e.created_at))} EST{e.vin ? ` · ${e.vin}` : ''}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
        <div className="modal-actions"><button className="btn ghost" onClick={onClose}>Close</button></div>
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
        <div className={`modal-icon ${type}`}>{type === 'success' ? '✓' : '✕'}</div>
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

export function YesNo({ value, editing, onChange }) {
  if (!editing) return <span className={`ph-yn ${value ? 'yes' : 'no'}`}>{value ? 'Yes' : 'No'}</span>;
  // Edit mode: a colored checkbox (blue = checked/yes, red = unchecked/no) —
  // one click to toggle, no dropdown.
  return (
    <input type="checkbox" className={`ph-yn-check ${value ? 'yes' : 'no'}`} checked={!!value}
      onChange={(e) => onChange(e.target.checked)} aria-label={value ? 'Yes' : 'No'} title={value ? 'Yes' : 'No'} />
  );
}

// Barcode via jsbarcode (lazy-loaded). `format` defaults to CODE128 (our VIN);
// for product UPCs pass a retail format — falls back to CODE128 if the value
// doesn't satisfy that symbology (wrong length / bad check digit).
export function Barcode({ value, format = 'CODE128', displayValue = false, height = 42 }) {
  const ref = useRef(null);
  useEffect(() => {
    let cancelled = false;
    import('jsbarcode').then(({ default: JsBarcode }) => {
      if (cancelled || !ref.current) return;
      const opts = { displayValue, height, width: 1.6, margin: 0, fontSize: 13 };
      try { JsBarcode(ref.current, value, { format, ...opts }); }
      catch {
        try { JsBarcode(ref.current, value, { format: 'CODE128', ...opts }); } catch { /* ignore */ }
      }
    });
    return () => { cancelled = true; };
  }, [value, format, displayValue, height]);
  return <svg ref={ref} className="barcode-svg" />;
}

// Printable labels for label-printer rolls (Rollo / Dymo). Two types:
//  • VIN label  — our SBM- barcode (used to track every unit)
//  • UPC label  — the product's box-style barcode (name / size / colorway / SKU)
//    for NO-BOX shoes, recreating the manufacturer's box label so it scans like
//    a normal boxed pair downstream.
const LABEL_SIZES = {
  rollo: { w: 2.25, h: 1.25, label: 'Rollo 30256/30327 — 2.25 × 1.25"' },
  dymo: { w: 2.125, h: 1.125, label: 'Dymo 30334 — 2.125 × 1.125"' },
  box: { w: 3.14, h: 1.96, label: 'Box label — 3.14 × 1.96"' },
};

// `mode`: 'vin' (default — our SBM tracking label) or 'upc' (box-style label with
// the product UPC barcode, used only from the No Box page). Box-style matches the
// real shoe-box label: vertical UPC barcode on the left, text stacked on the right.
export function LabelSheet({ items, onClose, mode = 'vin' }) {
  const list = items || [];
  const [size, setSize] = useState(mode === 'upc' ? 'box' : 'rollo');
  const s = LABEL_SIZES[size];
  return createPortal(
    <div className="label-overlay" style={{ '--lw': `${s.w}in`, '--lh': `${s.h}in` }}>
      <style>{`@media print { @page { size: ${s.w}in ${s.h}in; margin: 0; } }`}</style>
      <div className="label-toolbar no-print">
        <span>{list.length} {mode === 'upc' ? 'box' : 'VIN'} label(s)</span>
        <span className="label-tools">
          <select value={size} onChange={(e) => setSize(e.target.value)}>
            {Object.entries(LABEL_SIZES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          <button className="btn ghost sm" onClick={onClose}>Close</button>
          <button className="btn primary sm" onClick={() => window.print()}>🖨 Print</button>
        </span>
      </div>
      <div className="label-roll">
        {list.map((it) => (mode === 'upc' ? (
          upcDigits(it.upc) ? (
            // Box-style label: vertical UPC barcode (left) + text block (right).
            <div className="rlabel boxlabel" key={it.vin}>
              <div className="blabel-bc"><Barcode value={upcDigits(it.upc)} format={upcFormat(it.upc)} displayValue height={44} /></div>
              <div className="blabel-text">
                <div className="blabel-name">{(it.name || '—').toUpperCase()}</div>
                <div className="blabel-size">{it.size || '—'}</div>
                {it.colorway ? <div className="blabel-cw">{String(it.colorway).toUpperCase()}</div> : null}
                <div className="blabel-sku">{it.sku || '—'}</div>
              </div>
            </div>
          ) : (
            <div className="rlabel boxlabel missing" key={it.vin}>
              <div className="blabel-text">
                <div className="blabel-name">{(it.name || '—').toUpperCase()}</div>
                <div className="blabel-size">{it.size || '—'}</div>
                <div className="blabel-sku">{it.sku || '—'}</div>
                <div className="rlabel-vinlabel">No UPC on file — {it.vin}</div>
              </div>
            </div>
          )
        ) : (
          <div className="rlabel" key={it.vin}>
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
