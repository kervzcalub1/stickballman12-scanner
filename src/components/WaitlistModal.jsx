// Put a New Inventory line (or some of its sizes) on the WAITLIST — held out of listing
// until the market corrects (docs/context/waitlist.md). The owner's rule from the 2026-10-09
// review: a shoe one cheap ask has dragged under water waits; it comes back by itself on
// its date and PH is told on Telegram, so nobody has to remember it.
//
// Sizes, not just the line: the loss is usually ONE size (DZ2628-110 lost on size 8 only),
// and holding the sizes that sell at a profit would cost exactly the speed the owner said
// matters more than margin.
import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { estDate } from '../lib/format.js';
import { WAITLIST_DAY_CHOICES, WAITLIST_DEFAULT_DAYS, waitlistUntil } from '../lib/waitlist.js';

export function WaitlistModal({ group, reason = '', onClose, onDone, onSignOut }) {
  const sizes = group.sizes || [];
  const [picked, setPicked] = useState(() => new Set(sizes.map((s) => String(s.size))));
  const [days, setDays] = useState(WAITLIST_DEFAULT_DAYS);
  const [note, setNote] = useState(reason);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const vins = sizes.filter((s) => picked.has(String(s.size))).flatMap((s) => s.vins || []);
  const toggle = (sz) => setPicked((p) => { const n = new Set(p); if (n.has(sz)) n.delete(sz); else n.add(sz); return n; });

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
          {sizes.length > 1 && (
            <div className="form-modal-label">
              <span>Sizes to hold</span>
              <div className="waitlist-sizes">
                {sizes.map((s) => {
                  const sz = String(s.size);
                  return (
                    <label key={sz} className={`waitlist-size${picked.has(sz) ? ' on' : ''}`}>
                      <input type="checkbox" checked={picked.has(sz)} disabled={busy} onChange={() => toggle(sz)} />
                      {sz}{s.qty > 1 ? <span className="muted"> ×{s.qty}</span> : null}
                    </label>
                  );
                })}
              </div>
            </div>
          )}
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
