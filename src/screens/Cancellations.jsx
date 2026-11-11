// Order Cancellations — the record of orders the floor sent to cancel
// (docs/context/cancellations.md).
//
// Karon used to type every order number at the end of the day. Now the floor sends the bot
// the platform (/alias …) and the photo(s); each order is RECORDED — order number, shoe name,
// SKU, size — and the bot answers once per batch with the list. Since 2026-11-12 there is no
// review step (owner: "no verification anymore — just record it"): this page is the record,
// filtered by platform and by the EST day it was sent.
//
// A row whose photo gave no order number stands out (a person still has to type it off the
// photo) — a marker and a filter, not a status. Anyone who sees the page can fix a row.
import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { TopBar, FormModal } from '../components/common.jsx';
import { useLive } from '../hooks.js';
import { useQueryParam } from '../lib/urlstate.js';
import { estDate, estTime, estToday } from '../lib/format.js';
import {
  PLATFORMS, platformLabel, cancellationsCsv, CX_PERIODS, periodDays, detailsFromLabel, orderKey,
} from '../lib/cancellations.js';

const SOURCE = { telegram: 'photo on Telegram', typed: 'typed to the bot', app: 'added in the app' };
const when = (t) => (t ? `${estDate(t)} ${estTime(t)} EST` : '');
const FIELDS = ['platform', 'order_number', 'product', 'sku', 'size', 'reason', 'note'];
const shortSize = (v) => String(v ?? '').trim().replace(/^US\s*/i, '').replace(/^M\s+/i, '').trim();

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

// The whole photo, never cropped (object-fit: contain) — a crop once hid the order number.
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

function copy(text) { navigator.clipboard?.writeText(text).catch(() => {}); }

function Row({ row, me, onChanged, onOpenPhoto, onError, setNote }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  const missing = !row.order_number;
  const canRemove = me?.canRemoveAny || (me?.uid != null && Number(me.uid) === Number(row.sent_by_user_id));
  const set = (k) => (e) => setDraft((d) => ({ ...d, [k]: e.target.value }));
  const open = () => { setDraft(Object.fromEntries(FIELDS.map((k) => [k, row[k] ?? '']))); setEditing(true); };

  async function save() {
    setBusy(true); onError('');
    try {
      await api.saveCancellation({ id: row.id, ...draft });
      setEditing(false); setNote(`#${row.id} saved.`); onChanged();
    } catch (e) { onError(e.message); }
    setBusy(false);
  }

  return (
    <div className={`cx-row${missing ? ' cx-missing' : ''}`} data-id={row.id}>
      <Photo photoId={row.photo_id} onOpen={onOpenPhoto} />
      <div className="cx-body">
        <div className="cx-head">
          <span className="cx-plat">{platformLabel(row.platform) || 'No platform'}</span>
          {missing
            ? <span className="inbound-chip sm bad">No order # read — type it from the photo</span>
            : (
              <span className="cx-numwrap">
                <code className="cx-num">#{row.order_number}</code>
                <button type="button" className="btn xs ghost" onClick={() => { copy(row.order_number); setNote(`Copied ${row.order_number}.`); }}>Copy</button>
              </span>
            )}
          {row.order_match && <span className="inbound-chip sm ok" title="This number is one of our own orders">✓ our {platformLabel(row.platform) || row.order_match} order</span>}
        </div>
        {editing ? (
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
            <label><span>Size</span><input className="input" value={draft.size} onChange={set('size')} maxLength={20} /></label>
            <label className="cx-wide"><span>Shoe name</span><input className="input" value={draft.product} onChange={set('product')} maxLength={200} /></label>
            <label><span>SKU</span><input className="input" value={draft.sku} onChange={set('sku')} maxLength={40} /></label>
            <label><span>Reason</span><input className="input" value={draft.reason} onChange={set('reason')} maxLength={300} /></label>
            <label className="cx-full"><span>Note</span><input className="input" value={draft.note} onChange={set('note')} maxLength={500} /></label>
            <p className="muted xs cx-full">Leave the shoe blank and it is filled from our own order with that number, when we have one.</p>
          </div>
        ) : (
          <div className="cx-shoe">
            <div className="cx-name">{row.product || <span className="muted">No shoe name</span>}</div>
            <div className="cx-sku">
              {row.sku ? <b>{row.sku}</b> : <span className="muted">No SKU</span>}
              {' · '}
              {row.size ? <>size <b>{shortSize(row.size)}</b></> : <span className="muted">no size</span>}
            </div>
            {row.reason && <div className="cx-line"><span className="muted xs">Reason </span>{row.reason}</div>}
            {row.note && <div className="cx-line muted xs">{row.note}</div>}
          </div>
        )}
        <div className="muted xs cx-trail">
          #{row.id} · sent by {row.sent_by || '—'} · {when(row.created_at)} · {SOURCE[row.source] || row.source}
          {row.details_from ? <> · shoe from {detailsFromLabel(row.details_from)}</> : null}
        </div>
        <div className="cx-actions">
          {editing ? <>
            <button type="button" className="btn sm primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
            <button type="button" className="btn sm ghost" disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
          </> : <>
            <button type="button" className="btn sm" onClick={open}>✎ {missing ? 'Type the order #' : 'Edit'}</button>
            {canRemove && <button type="button" className="btn sm ghost" onClick={() => setRemoving(true)}>Remove</button>}
          </>}
        </div>
      </div>
      {removing && (
        <FormModal title={`Remove #${row.id}?`} message="Only for a photo that isn't an order to cancel. It leaves the list and the end-of-shift messages; the number can be recorded again later." submitLabel="Remove" danger
          fields={[{ name: 'reason', label: 'Why', required: true, placeholder: 'e.g. wrong photo · sent twice · not an order', maxLength: 300 }]}
          onClose={() => setRemoving(false)}
          onSubmit={async (v) => { await api.removeCancellation(row.id, v.reason); setRemoving(false); setNote(`#${row.id} removed.`); onChanged(); }} />
      )}
    </div>
  );
}

export function Cancellations({ onHome, onSignOut }) {
  const [period, setPeriod] = useQueryParam('period', 'today');
  const [dayA, setDayA] = useQueryParam('from', '');
  const [dayB, setDayB] = useQueryParam('to', '');
  const [plat, setPlat] = useQueryParam('platform', '');
  const [onlyMissing, setOnlyMissing] = useQueryParam('missing', '');
  const [q, setQ] = useQueryParam('q', '');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [adding, setAdding] = useState(false);
  const [big, setBig] = useState(null);

  // EST days, always — the PH team reads this from Manila, a day ahead.
  const range = useMemo(() => periodDays(period, estToday(), dayA, dayB), [period, dayA, dayB]);
  async function load() {
    try { setData(await api.cancellations(range)); setError(''); }
    catch (e) { if (e.unauthorized) return onSignOut(); setError(e.message); }
  }
  useEffect(() => { setData(null); load(); }, [range.from, range.to]); // eslint-disable-line react-hooks/exhaustive-deps
  useLive(['cancellations'], load, { mount: false });

  const all = data?.rows || [];
  // Counts per platform for the chips: within the period (and search), before the platform pick.
  const searched = useMemo(() => {
    const t = q.trim().toUpperCase();
    const tk = orderKey(t) || '';
    return all.filter((r) => !t
      || (tk && String(r.order_key || '').includes(tk))
      || [r.sku, r.product, r.sent_by].some((v) => String(v || '').toUpperCase().includes(t))
      || (tk && orderKey(r.sku || '')?.includes(tk)));
  }, [all, q]);
  const counts = useMemo(() => {
    const c = { '': searched.length, none: 0, missing: 0 };
    for (const r of searched) {
      if (r.platform && PLATFORMS.some((p) => p.key === r.platform)) c[r.platform] = (c[r.platform] || 0) + 1;
      else c.none += 1;
      if (!r.order_number) c.missing += 1;
    }
    return c;
  }, [searched]);
  const rows = useMemo(() => searched.filter((r) => (!plat || (plat === 'none' ? !PLATFORMS.some((p) => p.key === r.platform) : r.platform === plat))
    && (!onlyMissing || !r.order_number)), [searched, plat, onlyMissing]);

  function downloadCsv() {
    const blob = new Blob([cancellationsCsv([...rows].reverse())], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const span = range.from && range.to ? (range.from === range.to ? range.from : `${range.from}_to_${range.to}`) : range.from ? `from-${range.from}` : range.to ? `to-${range.to}` : 'all';
    a.href = url; a.download = `cancellations-${plat || 'all'}-${span}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const choosePeriod = (v) => {
    setPeriod(v);
    if (v === 'day' && !dayA) setDayA(estToday());
    if (v === 'range' && !dayA) { setDayA(periodDays('7', estToday()).from); setDayB(estToday()); }
  };
  const chips = [['', 'All'], ...PLATFORMS.map((p) => [p.key, p.label]), ['none', 'No platform']]
    .filter(([k]) => k === '' || counts[k] || plat === k);

  return (
    <div className="app cx-page">
      <TopBar title="Order Cancellations" onHome={onHome} onSignOut={onSignOut} />
      <div className="card">
        <p className="muted sm cx-lede">
          Every order sent to cancel, as recorded. <b>To send:</b> in Telegram (🔔 Alerts → Connect Telegram, once), send the
          platform — <code>/alias</code> <code>/stockx</code> <code>/ebay</code> <code>/temu</code> <code>/tiktok</code>{' '}
          <code>/shein</code> <code>/sg</code> (Stadium Goods) <code>/kc</code> (Kicks Crew) — then the photo(s). The bot records
          each order and answers once, under your photos, with the order numbers and shoes. Or type it:{' '}
          <code>/alias 206557037 DD1391-100 9.5</code>. Dates are by the EST day the photo was sent.
        </p>
        <div className="cx-filters">
          <select className="input" value={period} onChange={(e) => choosePeriod(e.target.value)} aria-label="Period">
            {CX_PERIODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          {period === 'day' && (
            <input type="date" className="input" value={dayA || estToday()} max={estToday()} onChange={(e) => setDayA(e.target.value)} aria-label="Day (EST)" />
          )}
          {period === 'range' && <>
            <input type="date" className="input" value={dayA} max={estToday()} onChange={(e) => setDayA(e.target.value)} aria-label="From (EST)" />
            <span className="muted xs">to</span>
            <input type="date" className="input" value={dayB} max={estToday()} onChange={(e) => setDayB(e.target.value)} aria-label="To (EST)" />
          </>}
          <span className="muted xs cx-span">
            {range.from && range.to ? (range.from === range.to ? range.from : `${range.from} → ${range.to}`) : range.from ? `from ${range.from}` : range.to ? `to ${range.to}` : 'all time'} (EST)
          </span>
          <input className="input cx-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Order # or SKU" aria-label="Search" />
          <button type="button" className="btn sm" onClick={() => { setNote(''); setAdding(true); }}>+ Add by hand</button>
          <button type="button" className="btn sm" disabled={!rows.length} onClick={downloadCsv}>⬇ CSV</button>
        </div>
        <div className="cx-filters mt">
          <div className="seg sm" role="tablist" aria-label="Platform">
            {chips.map(([k, l]) => (
              <button key={k || 'all'} type="button" role="tab" aria-selected={plat === k} className={`seg-btn ${plat === k ? 'on' : ''}`} onClick={() => setPlat(k)}>
                {l} ({counts[k] || 0})
              </button>
            ))}
          </div>
          <button type="button" aria-pressed={!!onlyMissing} className={`btn sm ${onlyMissing ? 'primary' : 'ghost'}`}
            onClick={() => setOnlyMissing(onlyMissing ? '' : '1')} disabled={!counts.missing && !onlyMissing}>
            No order # read ({counts.missing})
          </button>
        </div>
        {data?.capped && <div className="error mt">Showing the newest {all.length} only — pick a shorter period to see the rest.</div>}
        {error && <div className="error mt">{error}</div>}
        {note && <div className="ok mt" role="status">{note}</div>}
      </div>

      <div className="card">
        {!data ? <p className="muted">Loading…</p> : !rows.length ? (
          <p className="muted">{all.length ? 'Nothing matches these filters.' : 'Nothing recorded in this period.'}</p>
        ) : rows.map((r) => (
          <Row key={r.id} row={r} me={data.me} onChanged={load} onOpenPhoto={setBig} onError={setError} setNote={setNote} />
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
          message="For a picture that never reached Telegram. When the number is one of our orders, the shoe is filled in from it."
          submitLabel="Add"
          fields={[
            { name: 'platform', label: 'Platform', type: 'select', value: '', options: [{ value: '', label: '— pick —' }, ...PLATFORMS.map((p) => ({ value: p.key, label: p.label }))] },
            { name: 'order_number', label: 'Order number', required: true, maxLength: 60 },
            { name: 'product', label: 'Shoe name', maxLength: 200 },
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
