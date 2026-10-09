// Put a New Inventory line (or some of its sizes) on the WAITLIST — held out of listing
// until the market corrects (docs/context/waitlist.md). The owner's rule from the 2026-10-09
// review: a shoe one cheap ask has dragged under water waits; it comes back by itself on
// its date and PH is told on Telegram, so nobody has to remember it.
//
// Two ways in, nothing in between (2026-10-09): ⏸ on the ROW holds the entire row, ⏸ on a
// SIZE in the per-size detail holds that size only. The loss is usually ONE size
// (DZ2628-110 lost on size 8 only), and holding the sizes that sell at a profit would cost
// exactly the speed the owner said matters more than margin — so the size button is the
// one for that, and the caller passes `group` already narrowed to it.
import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { estDate, estToday } from '../lib/format.js';
import { WAITLIST_DAY_CHOICES, WAITLIST_DEFAULT_DAYS, waitlistUntil, waitlistXlsx, waitlistFileName } from '../lib/waitlist.js';
import { XLSX_MIME } from '../lib/xlsx.js';

export function WaitlistModal({ group, reason = '', onClose, onDone, onSignOut }) {
  const sizes = group.sizes || [];
  const [days, setDays] = useState(WAITLIST_DEFAULT_DAYS);
  const [note, setNote] = useState(reason);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const vins = sizes.flatMap((s) => s.vins || []);

  async function submit(e) {
    e.preventDefault();
    if (busy || !vins.length) return;
    setBusy(true); setErr('');
    try {
      const r = await api.phWaitlist({ action: 'hold', vins, days, note: note.trim() });
      onDone?.(r);
    } catch (e2) {
      if (e2.unauthorized) return onSignOut?.();
      setErr(e2.message || 'That did not go through.');
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={() => (busy ? null : onClose())}>
      <form className="modal form-modal waitlist-modal" role="dialog" aria-modal="true" aria-label="Put on the waitlist"
        onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3 className="modal-title">⏸ Put on the waitlist</h3>
        <p className="modal-msg">
          <b>{group.name || group.sku}</b>{group.sku ? <span className="muted"> · {group.sku}</span> : null}<br />
          Held off New Inventory until <b>{estDate(waitlistUntil(days))}</b> EST, then back on Pending by itself —
          you get a Telegram message that day. Check the market again before listing.
        </p>
        <div className="form-modal-fields">
          <div className="form-modal-label">
            <span>{sizes.length === 1 ? 'Size' : `Entire row — all ${sizes.length} sizes`}</span>
            <div className="waitlist-sizes">
              {sizes.map((s) => (
                <span key={String(s.size)} className="waitlist-size on">
                  {String(s.size)}{s.qty > 1 ? <span className="muted"> ×{s.qty}</span> : null}
                </span>
              ))}
            </div>
          </div>
          <div className="form-modal-label">
            <span>Hold for</span>
            <div className="seg sm">
              {WAITLIST_DAY_CHOICES.map((d) => (
                <button key={d} type="button" className={`seg-btn${days === d ? ' on' : ''}`} aria-pressed={days === d}
                  disabled={busy} onClick={() => setDays(d)}>
                  {d === 30 ? '1 month' : d === 60 ? '2 months' : `${d} days`}
                </button>
              ))}
            </div>
          </div>
          <label className="form-modal-label">
            <span>Why (goes on the daily report)</span>
            <textarea className="input" rows={2} maxLength={500} value={note} disabled={busy}
              placeholder="e.g. one $70 ask on size 8, next ask $133 — wait for it to sell"
              onChange={(e) => setNote(e.target.value)} />
          </label>
        </div>
        {err && <div className="error">{err}</div>}
        <div className="modal-actions">
          <button type="button" className="btn ghost" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy || !vins.length}>
            {busy ? 'Holding…' : `Hold ${vins.length} pair${vins.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </form>
    </div>
  );
}

// ⬇ Waitlist (Excel) — what's on hold right now (the daily report), or everything that was
// PUT on the waitlist between two EST dates, including holds that have since ended (the
// file's State column says where each line is now). Dates are EST like everything here.
export function WaitlistReportModal({ onClose, onSignOut }) {
  const today = estToday();
  const [mode, setMode] = useState('now'); // 'now' | 'range'
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const range = mode === 'range' ? { from: from || null, to: to || null } : null;
  const badRange = !!(range && range.from && range.to && range.from > range.to);

  async function submit(e) {
    e.preventDefault();
    if (busy || badRange) return;
    setBusy(true); setErr('');
    try {
      const { rows } = await api.phWaitlistList(range || {});
      if (!rows?.length) {
        setErr(range ? 'Nothing was put on the waitlist in those dates.' : 'Nothing is on the waitlist right now.');
        setBusy(false);
        return;
      }
      const url = URL.createObjectURL(new Blob([waitlistXlsx(rows)], { type: XLSX_MIME }));
      const a = document.createElement('a');
      a.href = url; a.download = waitlistFileName(today, range); a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      onClose();
    } catch (e2) {
      if (e2.unauthorized) return onSignOut?.();
      setErr(e2.message || 'Could not load the waitlist.');
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={() => (busy ? null : onClose())}>
      <form className="modal form-modal waitlist-modal" role="dialog" aria-modal="true" aria-label="Waitlist report"
        onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3 className="modal-title">⬇ Waitlist report (Excel)</h3>
        <div className="form-modal-fields">
          <div className="form-modal-label">
            <span>Show</span>
            <div className="seg sm">
              <button type="button" className={`seg-btn${mode === 'now' ? ' on' : ''}`} aria-pressed={mode === 'now'}
                disabled={busy} onClick={() => setMode('now')}>On hold now</button>
              <button type="button" className={`seg-btn${mode === 'range' ? ' on' : ''}`} aria-pressed={mode === 'range'}
                disabled={busy} onClick={() => setMode('range')}>Waitlisted between…</button>
            </div>
          </div>
          {mode === 'range' ? (
            <>
              <div className="waitlist-report-dates">
                <label className="form-modal-label"><span>From (EST)</span>
                  <input type="date" className="input" value={from} max={today} disabled={busy} onChange={(e) => setFrom(e.target.value)} /></label>
                <label className="form-modal-label"><span>To (EST)</span>
                  <input type="date" className="input" value={to} max={today} disabled={busy} onChange={(e) => setTo(e.target.value)} /></label>
              </div>
              <p className="muted sm">By the day each pair was put on the waitlist — still held or already back (the State column says which). Leave a date blank for no limit on that side.</p>
            </>
          ) : (
            <p className="muted sm">Everything on hold right now, whatever day it was held — the same file the daily Telegram report sends.</p>
          )}
        </div>
        {badRange && <div className="error">“From” is after “To”.</div>}
        {err && <div className="error">{err}</div>}
        <div className="modal-actions">
          <button type="button" className="btn ghost" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy || badRange}>{busy ? 'Loading…' : 'Download'}</button>
        </div>
      </form>
    </div>
  );
}
