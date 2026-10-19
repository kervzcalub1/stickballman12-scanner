// Order Cancellations — the review queue for orders the warehouse sent to cancel
// (docs/context/cancellations.md).
//
// Karon used to type every order number at the end of the day. Now the floor sends the
// bot a picture; the reader files one row per order with the photo beside it. The
// reviewers (PH + admin) do the one thing a person must: compare the row with the photo,
// fix it, Verify — then cancel it on the platform and mark it Cancelled. Nothing here
// cancels anything by itself.
//
// Tabs: To review → To cancel (verified) → Cancelled, plus Rejected and All. Open work is
// listed whatever its age; the period only trims the finished tabs.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { TopBar, FormModal } from '../components/common.jsx';
import { useLive } from '../hooks.js';
import { useQueryParam } from '../lib/urlstate.js';
import { estDate, estTime } from '../lib/format.js';
import {
  PLATFORMS, platformLabel, STATUSES, FLAGS, BLOCKING, flagsFor, blockingFlags, cancellationsCsv,
} from '../lib/cancellations.js';

const TABS = [['review', 'To review'], ['verified', 'To cancel'], ['submitted', 'Cancelled'], ['rejected', 'Rejected'], ['all', 'All']];
const PERIODS = [['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['all', 'All time']];
const SOURCE = { telegram: 'photo on Telegram', typed: 'typed to the bot', app: 'added in the app' };
const when = (t) => (t ? `${estDate(t)} ${estTime(t)} EST` : '');
const FIELDS = ['platform', 'order_number', 'sku', 'size', 'product', 'reason', 'note'];

// One photo, fetched with the session (order photos are never public) and kept for the visit.
const photoCache = new Map();
function usePhoto(photoId) {
  const [url, setUrl] = useState(() => photoCache.get(photoId) || null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!photoId || photoCache.has(photoId)) { setUrl(photoCache.get(photoId) || null); return undefined; }
    let live = true;
    api.cancellationPhoto(photoId)
      .then(({ blob }) => { const u = URL.createObjectURL(blob); photoCache.set(photoId, u); if (live) setUrl(u); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [photoId]);
  return { url, failed };
}

function Photo({ photoId, onOpen }) {
  const { url, failed } = usePhoto(photoId);
  if (!photoId) return <div className="cx-photo cx-photo-none"><span>No photo</span><span className="xs">typed in</span></div>;
  if (failed) return <div className="cx-photo cx-photo-none"><span>Photo unavailable</span></div>;
  if (!url) return <div className="cx-photo cx-photo-none">Loading…</div>;
  return (
    <button type="button" className="cx-photo" onClick={() => onOpen(url)} aria-label="Open the photo">
      <img src={url} alt="The photo that was sent" />
    </button>
  );
}

function Flags({ flags }) {
  if (!flags?.length) return null;
  return (
    <div className="cx-flags">
      {flags.map((f) => (
        <span key={f} className={`inbound-chip sm ${BLOCKING.includes(f) || f === 'submit_failed' ? 'bad' : 'warn'}`}>{FLAGS[f] || f}</span>
      ))}
    </div>
  );
}

function copy(text) { navigator.clipboard?.writeText(text).catch(() => {}); }

function Row({ row, canReview, onChanged, onOpenPhoto, onError, setNote }) {
  const editable = canReview && row.status === 'to_review';
  const [draft, setDraft] = useState(() => Object.fromEntries(FIELDS.map((k) => [k, row[k] ?? ''])));
  const [busy, setBusy] = useState('');
  const [ask, setAsk] = useState(null);   // 'reject' | 'submitted' | 'failed'
  const base = useRef(row.updated_at);
  // Someone else's save arrives over the live feed: take it, unless this row is being typed in.
  useEffect(() => {
    if (row.updated_at !== base.current) {
      base.current = row.updated_at;
      setDraft(Object.fromEntries(FIELDS.map((k) => [k, row[k] ?? ''])));
    }
  }, [row]);
  const dirty = FIELDS.some((k) => String(draft[k] ?? '') !== String(row[k] ?? ''));
  const live = editable ? flagsFor(draft) : null;
  // What the chips show: while editing, the hard checks on what is typed plus the reader's
  // doubts until a person changes something; otherwise what the row carries.
  const shownFlags = editable
    ? [...new Set([...live, ...(dirty ? [] : (row.flags || []).filter((f) => !BLOCKING.includes(f) && f !== 'format'))])]
    : row.flags;
  const set = (k) => (e) => setDraft((d) => ({ ...d, [k]: e.target.value }));

  async function run(label, fn) {
    setBusy(label); onError('');
    try { await fn(); onChanged(); } catch (e) { onError(e.message); }
    setBusy('');
  }
  const save = () => run('save', async () => { await api.saveCancellation({ id: row.id, ...draft }); setNote(`#${row.id} saved.`); });
  const verify = () => run('verify', async () => {
    if (dirty) await api.saveCancellation({ id: row.id, ...draft });
    await api.cancellationAction(row.id, 'verify');
    setNote(`#${row.id} verified — it is on "To cancel".`);
  });
  const act = (action, extra, msg) => run(action, async () => { await api.cancellationAction(row.id, action, extra); setNote(msg); });

  const hard = editable ? blockingFlags(live) : [];
  return (
    <div className={`cx-row cx-${row.status}`}>
      <Photo photoId={row.photo_id} onOpen={onOpenPhoto} />
      <div className="cx-body">
        <div className="cx-head">
          <b>#{row.id}</b>
          <span className={`inbound-chip sm ${row.status === 'submitted' ? 'ok' : row.status === 'rejected' ? 'muted' : row.status === 'verified' ? 'info' : 'warn'}`}>{STATUSES[row.status]}</span>
          <span className="muted xs">sent by {row.sent_by || '—'} · {when(row.created_at)} · {SOURCE[row.source] || row.source}</span>
        </div>
        {editable ? (
          <div className="cx-form">
            <label><span>Platform</span>
              <select className="input" value={draft.platform} onChange={set('platform')}>
                <option value="">— pick —</option>
                {PLATFORMS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
              </select>
            </label>
            <label className="cx-wide"><span>Order number</span>
              <input className="input cx-num" value={draft.order_number} onChange={set('order_number')} placeholder="as printed on the photo" maxLength={60} />
            </label>
            <label><span>SKU</span><input className="input" value={draft.sku} onChange={set('sku')} maxLength={40} /></label>
            <label><span>Size</span><input className="input" value={draft.size} onChange={set('size')} maxLength={20} /></label>
            <label className="cx-wide"><span>Product</span><input className="input" value={draft.product} onChange={set('product')} maxLength={200} /></label>
            <label className="cx-wide"><span>Reason</span><input className="input" value={draft.reason} onChange={set('reason')} placeholder="why it is cancelled" maxLength={300} /></label>
            <label className="cx-full"><span>Note</span><input className="input" value={draft.note} onChange={set('note')} maxLength={500} /></label>
          </div>
        ) : (
          <div className="cx-read">
            <div><span className="muted xs">Platform</span><b>{platformLabel(row.platform) || '—'}</b></div>
            <div className="cx-wide"><span className="muted xs">Order number</span>
              <span><code className="cx-num">{row.order_number || '—'}</code>
                {row.order_number && <button type="button" className="btn xs ghost" onClick={() => { copy(row.order_number); setNote(`Copied ${row.order_number}.`); }}>Copy</button>}</span>
            </div>
            {(row.sku || row.size) && <div><span className="muted xs">SKU / size</span>{[row.sku, row.size].filter(Boolean).join(' · ')}</div>}
            {row.product && <div className="cx-wide"><span className="muted xs">Product</span>{row.product}</div>}
            {row.reason && <div className="cx-wide"><span className="muted xs">Reason</span>{row.reason}</div>}
            {row.note && <div className="cx-full"><span className="muted xs">Note</span>{row.note}</div>}
          </div>
        )}
        <Flags flags={shownFlags} />
        <div className="muted xs cx-trail">
          {row.verified_by && <>Verified by {row.verified_by} · {when(row.verified_at)}. </>}
          {row.submitted_by && <>Cancelled by {row.submitted_by} · {when(row.submitted_at)}{row.platform_ref ? ` · ref ${row.platform_ref}` : ''}. </>}
          {row.rejected_reason && <>Rejected: {row.rejected_reason}. </>}
        </div>
        {canReview && (
          <div className="cx-actions">
            {row.status === 'to_review' && <>
              {dirty && <button type="button" className="btn sm" disabled={!!busy} onClick={save}>{busy === 'save' ? 'Saving…' : 'Save'}</button>}
              <button type="button" className="btn sm primary" disabled={!!busy || hard.length > 0} title={hard.length ? hard.map((f) => FLAGS[f]).join('; ') : 'I compared it with the photo'} onClick={verify}>
                {busy === 'verify' ? 'Verifying…' : '✓ Verify'}
              </button>
              <button type="button" className="btn sm ghost" disabled={!!busy} onClick={() => setAsk('reject')}>Reject</button>
            </>}
            {row.status === 'verified' && <>
              <button type="button" className="btn sm primary" disabled={!!busy} onClick={() => setAsk('submitted')}>Cancelled on {platformLabel(row.platform) || 'platform'} ✓</button>
              <button type="button" className="btn sm" disabled={!!busy} onClick={() => setAsk('failed')}>Couldn’t cancel</button>
              <button type="button" className="btn sm ghost" disabled={!!busy} onClick={() => act('reopen', {}, `#${row.id} is back on "To review".`)}>Back to review</button>
              <button type="button" className="btn sm ghost" disabled={!!busy} onClick={() => setAsk('reject')}>Reject</button>
            </>}
            {row.status === 'rejected' && (
              <button type="button" className="btn sm ghost" disabled={!!busy} onClick={() => act('reopen', {}, `#${row.id} is back on "To review".`)}>Reopen</button>
            )}
          </div>
        )}
      </div>
      {ask === 'reject' && (
        <FormModal title={`Reject #${row.id}`} message="It leaves the queue and is not cancelled. The number can be logged again later." submitLabel="Reject" danger
          fields={[{ name: 'reason', label: 'Why', required: true, placeholder: 'e.g. duplicate photo · not an order · shipped after all', maxLength: 300 }]}
          onClose={() => setAsk(null)}
          onSubmit={async (v) => { await api.cancellationAction(row.id, 'reject', { reason: v.reason }); setAsk(null); setNote(`#${row.id} rejected.`); onChanged(); }} />
      )}
      {ask === 'submitted' && (
        <FormModal title={`Cancelled #${row.id}?`} message={`${platformLabel(row.platform)} order ${row.order_number} — only once the platform shows it cancelled.`} submitLabel="Mark cancelled"
          fields={[{ name: 'platformRef', label: 'Confirmation / case number (optional)', maxLength: 80 }]}
          onClose={() => setAsk(null)}
          onSubmit={async (v) => { await api.cancellationAction(row.id, 'submitted', { platformRef: v.platformRef }); setAsk(null); setNote(`#${row.id} marked cancelled.`); onChanged(); }} />
      )}
      {ask === 'failed' && (
        <FormModal title={`Couldn’t cancel #${row.id}`} message="It goes back to “To review”, flagged, with what you write here." submitLabel="Send back"
          fields={[{ name: 'note', label: 'What went wrong', required: true, placeholder: 'e.g. order not found · already shipped · no cancel button', maxLength: 300 }]}
          onClose={() => setAsk(null)}
          onSubmit={async (v) => { await api.cancellationAction(row.id, 'failed', { note: v.note }); setAsk(null); setNote(`#${row.id} is back on "To review".`); onChanged(); }} />
      )}
    </div>
  );
}

export function Cancellations({ onHome, onSignOut }) {
  const [view, setView] = useQueryParam('view', 'review');
  const [days, setDays] = useQueryParam('days', '30');
  const [q, setQ] = useQueryParam('q', '');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [adding, setAdding] = useState(false);
  const [big, setBig] = useState(null);

  async function load() {
    try { setData(await api.cancellations(view, days)); setError(''); }
    catch (e) { if (e.unauthorized) return onSignOut(); setError(e.message); }
  }
  useEffect(() => { setData(null); load(); }, [view, days]); // eslint-disable-line react-hooks/exhaustive-deps
  useLive(['cancellations'], load, { mount: false });

  const rows = useMemo(() => {
    const t = q.trim().toUpperCase();
    const tk = t.replace(/[^A-Z0-9]/g, '');
    return (data?.rows || []).filter((r) => !t
      || (tk && String(r.order_key || '').includes(tk))
      || [r.sku, r.product, r.sent_by, platformLabel(r.platform), `#${r.id}`].some((v) => String(v || '').toUpperCase().includes(t)));
  }, [data, q]);
  // "To cancel": one copy button per platform, numbers one per line — paste and go.
  const byPlatform = useMemo(() => {
    if (view !== 'verified') return [];
    const m = new Map();
    for (const r of rows) { const k = r.platform || ''; m.set(k, [...(m.get(k) || []), r.order_number]); }
    return [...m.entries()];
  }, [rows, view]);
  const canReview = !!data?.canReview;
  const counts = data?.counts || {};

  function downloadCsv() {
    const blob = new Blob([cancellationsCsv(rows)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `cancellations-${view}-${estDate(Date.now())}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <div className="app cx-page">
      <TopBar title="Order Cancellations" onHome={onHome} onSignOut={onSignOut} />
      <div className="card">
        <p className="muted sm cx-lede">
          Orders the warehouse sent to cancel. <b>To send one:</b> open your chat with the Stickballman12 bot on Telegram
          (🔔 Alerts → Connect Telegram, once), send the platform — <code>/alias</code> <code>/stockx</code> <code>/ebay</code>{' '}
          <code>/temu</code> <code>/tiktok</code> <code>/shein</code> <code>/sg</code> (Stadium Goods) <code>/kc</code> (Kicks Crew) — then the
          photo(s) of the label, packing slip or order screen. Or type it: <code>/stockx 12345678-12345678</code>. The reader fills in each row; {canReview ? <>you <b>compare it with the photo</b>, fix anything wrong, <b>Verify</b>, cancel it on the platform, then mark it <b>Cancelled</b>.</> : <>PH checks each one against the photo before anything is cancelled.</>}
        </p>
        <div className="cx-filters">
          <div className="seg sm" role="tablist" aria-label="Status">
            {TABS.map(([k, l]) => {
              const n = k === 'review' ? counts.review : k === 'verified' ? counts.verified : null;
              return (
                <button key={k} type="button" role="tab" aria-selected={view === k} className={`seg-btn ${view === k ? 'on' : ''}`} onClick={() => setView(k)}>
                  {l}{n ? ` (${n})` : ''}
                </button>
              );
            })}
          </div>
          {['submitted', 'rejected', 'all'].includes(view) && (
            <select className="input" value={days} onChange={(e) => setDays(e.target.value)} aria-label="Period">
              {PERIODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          )}
          <input className="input cx-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Order #, SKU, product or who sent it" aria-label="Search" />
          <button type="button" className="btn sm" onClick={() => { setNote(''); setAdding(true); }}>+ Add by hand</button>
          <button type="button" className="btn sm" disabled={!rows.length} onClick={downloadCsv}>⬇ CSV</button>
        </div>
        {error && <div className="error mt">{error}</div>}
        {note && <div className="ok mt" role="status">{note}</div>}
        {byPlatform.length > 0 && (
          <div className="cx-bulk">
            <span className="muted xs">Copy the numbers to cancel:</span>
            {byPlatform.map(([k, nums]) => (
              <button key={k} type="button" className="btn sm ghost" onClick={() => { copy(nums.join('\n')); setNote(`Copied ${nums.length} ${platformLabel(k) || 'unassigned'} number${nums.length === 1 ? '' : 's'}.`); }}>
                {platformLabel(k) || 'No platform'} ({nums.length})
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        {!data ? <p className="muted">Loading…</p> : !rows.length ? (
          <p className="muted">{data.rows.length ? 'Nothing matches the search.'
            : view === 'review' ? 'Nothing to review — every order sent in has been checked.'
              : view === 'verified' ? 'Nothing waiting to be cancelled.' : 'Nothing here in this period.'}</p>
        ) : rows.map((r) => (
          <Row key={r.id} row={r} canReview={canReview} onChanged={load} onOpenPhoto={setBig} onError={setError} setNote={setNote} />
        ))}
      </div>

      {big && (
        <div className="modal-overlay" onClick={() => setBig(null)}>
          <div className="cx-big" role="dialog" aria-modal="true" aria-label="Photo">
            <img src={big} alt="The photo that was sent" />
          </div>
        </div>
      )}
      {adding && (
        <FormModal title="Add an order to cancel"
          message="For a picture that never reached Telegram. It goes on “To review” like any other."
          submitLabel="Add"
          fields={[
            { name: 'platform', label: 'Platform', type: 'select', value: '', options: [{ value: '', label: '— pick —' }, ...PLATFORMS.map((p) => ({ value: p.key, label: p.label }))] },
            { name: 'order_number', label: 'Order number', required: true, maxLength: 60 },
            { name: 'sku', label: 'SKU', maxLength: 40 },
            { name: 'size', label: 'Size', maxLength: 20 },
            { name: 'reason', label: 'Reason', maxLength: 300 },
          ]}
          onClose={() => setAdding(false)}
          onSubmit={async (v) => {
            const r = await api.saveCancellation(v);
            setAdding(false); setNote(`Added as #${r.row.id}.`); load();
          }} />
      )}
    </div>
  );
}
