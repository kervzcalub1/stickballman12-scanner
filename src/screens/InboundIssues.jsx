// Inbound Issues — every problem found at receiving, as a case someone owns until it is
// resolved (docs/context/inbound-issues.md).
//
// The owner's ask (2026-10-24): the warehouse found damaged parcels, short counts and wrong
// pairs, set the boxes aside — and they sat there until the owner visited. Now the issue
// recorded at receiving (or reported here) is a CASE: the PH team is told on Telegram, one
// of them TAKES it, works it with the supplier, and RESOLVES it with what happened. Each
// case carries everything a refund claim needs — supplier, PO, tracking number, batch/box,
// the pair and what it cost, and the photos. The warehouse sees the same page: it reports,
// adds photos, and does the physical jobs a case asks for (ship it back, shelve it).
//
// Tabs: New → In progress → Waiting on supplier → Resolved, plus Mine, Warehouse to-do, All.
// Open work shows whatever its age; the period only trims Resolved / All.
import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { TopBar, FormModal } from '../components/common.jsx';
import { DefectPhotos } from '../components/DefectPhotos.jsx';
import { TrackingLink } from '../components/TrackingLink.jsx';
import { useLive } from '../hooks.js';
import { useQueryParam } from '../lib/urlstate.js';
import { estDate, estTime } from '../lib/format.js';
import {
  STATUSES, OUTCOMES, MONEY_OUTCOMES, DISPOSITIONS, SHIPMENT_TYPES, PAIR_TYPES, AGE_FLAGS,
  typeLabel, outcomeLabel, dispositionLabel, ageFlags, ago, inboundIssuesCsv,
} from '../lib/inboundIssues.js';

const TABS = [
  ['open', 'New'], ['in_progress', 'In progress'], ['waiting', 'Waiting on supplier'],
  ['mine', 'Mine'], ['warehouse', 'Warehouse to-do'], ['resolved', 'Resolved'], ['all', 'All'],
];
const PERIODS = [['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['all', 'All time']];
const when = (t) => (t ? `${estDate(t)} ${estTime(t)} EST` : '');
const money = (n) => (n == null ? '—' : `$${Number(n).toFixed(2)}`);
const CHIP = { open: 'warn', in_progress: 'info', waiting: 'info', resolved: 'ok' };
const EVENT_WORDS = {
  reported: 'Reported', claimed: 'Took it', claim: 'Took it', assign: 'Handed over', release: 'Put back to New',
  waiting: 'Waiting on the supplier', working: 'Back in progress', note: 'Note', photos: 'Photos',
  warehouse_task: 'Asked the warehouse', warehouse_done: 'Warehouse done', resolved: 'Resolved', reopened: 'Reopened',
};

function copy(text) { navigator.clipboard?.writeText(text).catch(() => {}); }

// What a refund claim needs, in the order you'd type it into an email to the supplier.
function claimText(r) {
  return [
    `Case #${r.id} — ${typeLabel(r.scope, r.type)}`,
    r.supplier && `Supplier: ${r.supplier}`,
    r.po_code && `PO: ${r.po_code}${r.po_date ? ` (ordered ${r.po_date})` : ''}`,
    r.online_store && `Online order: ${r.online_store}${r.online_order_number ? ` #${r.online_order_number}` : ''}`,
    r.tracking_number && `Tracking #: ${r.tracking_number}`,
    r.date_received && `Received: ${r.date_received}`,
    r.scope === 'pair' && `Pair: ${[r.product, r.sku, r.size && `size ${r.size}`].filter(Boolean).join(' · ')}${r.vin ? ` (VIN ${r.vin})` : ''}`,
    r.cost != null && `Cost: ${money(r.cost)}`,
    (r.expected_count != null || r.received_count != null) && `Expected ${r.expected_count ?? '?'}, received ${r.received_count ?? '?'}`,
    r.description && `Details: ${r.description}`,
    (r.photos || []).length && `Photos:\n${r.photos.join('\n')}`,
  ].filter(Boolean).join('\n');
}

function Fact({ label, children, wide }) {
  if (children == null || children === '' || children === false) return null;
  return <div className={`ii-fact${wide ? ' wide' : ''}`}><span className="muted xs">{label}</span><span>{children}</span></div>;
}

function Trail({ id }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let live = true;
    api.inboundIssue(id).then((r) => { if (live) setRows(r.row.events || []); }).catch((e) => { if (live) setErr(e.message); });
    return () => { live = false; };
  }, [id]);
  if (err) return <div className="error sm">{err}</div>;
  if (!rows) return <p className="muted xs">Loading…</p>;
  return (
    <ol className="ii-trail">
      {rows.map((e) => (
        <li key={e.id}><b>{EVENT_WORDS[e.action] || e.action}</b> — {e.actor || 'system'} · {when(e.created_at)}{e.detail ? <><br /><span className="muted">{e.detail}</span></> : null}</li>
      ))}
    </ol>
  );
}

function Case({ row, canWork, me, assignees, onChanged, onOpenPhoto, onError, setNote, onSignOut, focused }) {
  const [busy, setBusy] = useState('');
  const [ask, setAsk] = useState(null);
  const [showTrail, setShowTrail] = useState(false);
  const [addingPhotos, setAddingPhotos] = useState(false);
  const flags = ageFlags(row);
  const resolved = row.status === 'resolved';
  const mine = me != null && row.owner_user_id === me;
  const pairHeld = row.scope === 'pair' && row.item_status === 'issue';

  async function act(action, extra = {}, msg) {
    setBusy(action); onError('');
    try {
      const r = await api.inboundIssueAction(row.id, action, extra);
      setNote(msg || `#${row.id} saved.`);
      if (r.pair?.removed) setNote(`#${row.id} resolved — ${r.pair.removed} removed from inventory (Deleted page).`);
      else if (r.pair?.released) setNote(`#${row.id} resolved — ${r.pair.released} is back to “${r.pair.status === 'needs_shelf' ? 'needs shelf' : r.pair.status}”.`);
      else if (r.pair?.stillHeld) setNote(`#${row.id} resolved — ${r.pair.stillHeld} stays held: another open case is on it.`);
      else if (r.pair?.blocked) setNote(`#${row.id} resolved — ${r.pair.blocked} was already sold/shipped, so it was not removed.`);
      onChanged();
    } catch (e) { if (e.unauthorized) return onSignOut(); onError(e.message); }
    setBusy('');
  }
  const modal = (fn) => async (v) => { await fn(v); setAsk(null); };
  const send = async (action, extra, msg) => {
    const r = await api.inboundIssueAction(row.id, action, extra);
    setNote(msg); onChanged(); return r;
  };

  return (
    <div className={`ii-case ii-${row.status}${focused ? ' focused' : ''}`} id={`case-${row.id}`}>
      <div className="ii-head">
        <b>#{row.id}</b>
        <span className={`inbound-chip sm ${CHIP[row.status] || ''}`}>{STATUSES[row.status]}</span>
        <span className="inbound-chip sm muted">{row.scope === 'pair' ? 'Pair' : 'Shipment'}</span>
        {flags.map((f) => <span key={f} className="inbound-chip sm bad">{AGE_FLAGS[f]}</span>)}
        {row.warehouse_task && !row.warehouse_done_at && !resolved && <span className="inbound-chip sm warn">Warehouse to-do</span>}
        <span className="muted xs ii-age">{ago(row.created_at)} ago</span>
      </div>
      <div className="ii-title">{typeLabel(row.scope, row.type)}
        {(row.expected_count != null || row.received_count != null) && <span className="muted"> — expected {row.expected_count ?? '?'}, got {row.received_count ?? '?'}</span>}
      </div>
      {row.description && <p className="ii-desc">{row.description}</p>}

      <div className="ii-facts">
        <Fact label="Supplier">{row.supplier}</Fact>
        <Fact label="PO">{row.po_code && <>{row.po_code}{row.po_date ? <span className="muted"> · ordered {row.po_date}</span> : null}</>}</Fact>
        <Fact label="Online order">{row.online_store && <>{row.online_store}{row.online_order_number ? ` #${row.online_order_number}` : ''}</>}</Fact>
        <Fact label="Tracking #">{row.tracking_number ? <TrackingLink number={row.tracking_number} /> : (row.no_tracking ? 'none (stated at receiving)' : null)}</Fact>
        <Fact label="Batch / box">{row.batch_code && <>{row.batch_code}{row.box_number != null ? ` · box ${row.box_number}` : ''}</>}</Fact>
        <Fact label="Received">{row.date_received}</Fact>
        {row.scope === 'pair' && <>
          <Fact label="Pair" wide>{[row.product, row.sku, row.size && `size ${row.size}`].filter(Boolean).join(' · ')}</Fact>
          <Fact label="VIN">{row.vin && <code>{row.vin}</code>}</Fact>
          <Fact label="Cost">{money(row.cost)}</Fact>
          <Fact label="Pair now">{row.item_id == null ? 'removed from inventory' : pairHeld ? 'held — not listed' : row.item_status}</Fact>
        </>}
        <Fact label="Reported">{row.reported_by || '—'} · {when(row.created_at)}</Fact>
        <Fact label="Owner">{row.owner ? <>{row.owner}{row.claimed_at ? <span className="muted"> · since {when(row.claimed_at)}</span> : null}</> : <span className="muted">nobody yet</span>}</Fact>
        <Fact label="Supplier ref / RMA">{row.supplier_ref}</Fact>
      </div>

      {(row.photos || []).length > 0 && (
        <div className="ii-photos">
          {row.photos.map((u) => (
            <button type="button" key={u} className="ii-photo" onClick={() => onOpenPhoto(u)} aria-label="Open the photo"><img src={u} alt="Issue photo" loading="lazy" /></button>
          ))}
        </div>
      )}

      {row.warehouse_task && (
        <div className={`ii-task ${row.warehouse_done_at ? 'done' : ''}`}>
          <span className="muted xs">Warehouse job — asked by {row.warehouse_task_by} · {when(row.warehouse_task_at)}</span>
          <div>{row.warehouse_task}</div>
          {row.warehouse_done_at
            ? <span className="muted xs">✓ Done by {row.warehouse_done_by} · {when(row.warehouse_done_at)}</span>
            : !resolved && <button type="button" className="btn sm primary" disabled={!!busy} onClick={() => setAsk('done')}>✓ Done</button>}
        </div>
      )}

      {resolved && (
        <div className="ii-resolution">
          <b>{outcomeLabel(row.outcome)}</b>{row.refund_amount != null ? ` · ${money(row.refund_amount)}` : ''}
          {row.disposition ? ` · ${dispositionLabel(row.disposition)}` : ''}
          <span className="muted xs"> — {row.resolved_by} · {when(row.resolved_at)}</span>
          {row.resolution_note && <div className="muted sm">{row.resolution_note}</div>}
        </div>
      )}

      <div className="ii-actions">
        {canWork && row.status === 'open' && (
          <button type="button" className="btn sm primary" disabled={!!busy} onClick={() => act('claim', {}, `#${row.id} is yours.`)}>{busy === 'claim' ? 'Taking…' : '✋ Take it'}</button>
        )}
        {canWork && !resolved && <>
          {row.status === 'in_progress' && <button type="button" className="btn sm" disabled={!!busy} onClick={() => setAsk('waiting')}>Waiting on supplier…</button>}
          {row.status === 'waiting' && <button type="button" className="btn sm" disabled={!!busy} onClick={() => act('working', {}, `#${row.id} is back in progress.`)}>Back in progress</button>}
          <button type="button" className="btn sm primary" disabled={!!busy} onClick={() => setAsk('resolve')}>✓ Resolve…</button>
          <button type="button" className="btn sm" disabled={!!busy} onClick={() => setAsk('task')}>Ask the warehouse…</button>
          <button type="button" className="btn sm ghost" disabled={!!busy} onClick={() => setAsk('assign')}>Hand to…</button>
          {(row.status === 'in_progress' || row.status === 'waiting') && (mine || !row.owner_user_id) && (
            <button type="button" className="btn sm ghost" disabled={!!busy} onClick={() => act('release', {}, `#${row.id} is back on New.`)}>Put back</button>
          )}
        </>}
        {canWork && resolved && <button type="button" className="btn sm ghost" disabled={!!busy} onClick={() => setAsk('reopen')}>Reopen…</button>}
        <button type="button" className="btn sm ghost" disabled={!!busy} onClick={() => setAsk('note')}>Note…</button>
        {!resolved && <button type="button" className="btn sm ghost" onClick={() => setAddingPhotos((v) => !v)}>{addingPhotos ? 'Close photos' : '＋ Photos'}</button>}
        <button type="button" className="btn sm ghost" onClick={() => { copy(claimText(row)); setNote(`Copied #${row.id}’s details — paste them into the message to the supplier.`); }}>Copy for supplier</button>
        <button type="button" className="btn sm ghost" onClick={() => setShowTrail((v) => !v)}>{showTrail ? 'Hide history' : 'History'}</button>
      </div>
      {addingPhotos && (
        <div className="ii-addphotos">
          <DefectPhotos photos={[]} max={6} sign={(t) => api.inboundIssuePhotoSign(t, row.id)} onSignOut={onSignOut}
            onChange={(urls) => { const add = urls.filter((u) => !(row.photos || []).includes(u)); if (add.length) act('photos', { photos: add }, `Photo added to #${row.id}.`); }} />
        </div>
      )}
      {showTrail && <Trail id={row.id} key={row.updated_at} />}

      {ask === 'waiting' && (
        <FormModal title={`#${row.id} — waiting on the supplier`} message="You've asked the supplier; nothing to do until they answer. It stays yours."
          submitLabel="Save" fields={[
            { name: 'supplierRef', label: 'Their reference / RMA / ticket # (optional)', value: row.supplier_ref || '', maxLength: 120 },
            { name: 'note', label: 'What you asked for', type: 'textarea', placeholder: 'e.g. emailed Sunny for a refund of the missing pair, photos attached', maxLength: 500 },
          ]}
          onClose={() => setAsk(null)}
          onSubmit={modal((v) => send('waiting', v, `#${row.id} is waiting on the supplier.`))} />
      )}
      {ask === 'resolve' && (
        <FormModal title={`Resolve #${row.id}`}
          message={row.scope === 'pair' && row.item_id ? 'Say what the supplier did, and what happens to the pair. “Keep it” puts it back to stock (PH can list it); “Returned” takes it off the inventory.' : 'Say what the supplier did.'}
          submitLabel="Resolve" fields={[
            { name: 'outcome', label: 'What happened', type: 'select', value: OUTCOMES[0][0], options: OUTCOMES.map(([value, label]) => ({ value, label })) },
            { name: 'refundAmount', label: 'Amount back ($) — for a refund or credit', type: 'number', step: '0.01', min: 0, hint: `Needed for: ${MONEY_OUTCOMES.map(outcomeLabel).join(', ')}` },
            ...(row.scope === 'pair' && row.item_id ? [{ name: 'disposition', label: 'The pair', type: 'select', value: 'keep', options: DISPOSITIONS.map(([value, label]) => ({ value, label })) }] : []),
            { name: 'note', label: 'Note (optional)', type: 'textarea', maxLength: 1000 },
          ]}
          onClose={() => setAsk(null)}
          onSubmit={modal(async (v) => { const r = await send('resolve', v, `#${row.id} resolved.`); if (r.pair?.removed) setNote(`#${row.id} resolved — ${r.pair.removed} removed from inventory (Deleted page).`); else if (r.pair?.released) setNote(`#${row.id} resolved — ${r.pair.released} is back in stock.`); })} />
      )}
      {ask === 'task' && (
        <FormModal title={`#${row.id} — a job for the warehouse`} message="The warehouse is told on Telegram, and it shows on their Warehouse to-do tab until they tap Done."
          submitLabel="Send" fields={[{ name: 'task', label: 'What should they do?', type: 'textarea', required: true, value: row.warehouse_done_at ? '' : (row.warehouse_task || ''),
            placeholder: 'e.g. ship the box back to Sunny — return label emailed to warehouse@ · or: keep it, shelve it', maxLength: 500 }]}
          onClose={() => setAsk(null)}
          onSubmit={modal((v) => send('ask_warehouse', v, `Sent to the warehouse.`))} />
      )}
      {ask === 'assign' && (
        <FormModal title={`Hand #${row.id} to…`} message="They own it from now on and get a Telegram message." submitLabel="Hand over"
          fields={[{ name: 'toUid', label: 'Who', type: 'select', value: String(assignees[0]?.id || ''), options: assignees.map((p) => ({ value: String(p.id), label: `${p.name}${p.role === 'admin' ? ' (admin)' : ''}` })) }]}
          onClose={() => setAsk(null)}
          onSubmit={modal((v) => send('assign', { toUid: Number(v.toUid) }, `#${row.id} handed over.`))} />
      )}
      {ask === 'reopen' && (
        <FormModal title={`Reopen #${row.id}`} message="Back to In progress. A pair that was put back to stock is NOT held again — it may be listed or sold by now." submitLabel="Reopen"
          fields={[{ name: 'why', label: 'Why', required: true, maxLength: 300 }]}
          onClose={() => setAsk(null)}
          onSubmit={modal((v) => send('reopen', v, `#${row.id} reopened.`))} />
      )}
      {ask === 'note' && (
        <FormModal title={`Note on #${row.id}`} submitLabel="Add note"
          fields={[
            { name: 'text', label: 'Note', type: 'textarea', maxLength: 1000, placeholder: 'e.g. supplier says they will refund by Friday' },
            ...(canWork ? [{ name: 'supplierRef', label: 'Supplier ref / RMA (optional)', value: '', maxLength: 120 }] : []),
          ]}
          onClose={() => setAsk(null)}
          onSubmit={modal((v) => send('note', v, `Note added to #${row.id}.`))} />
      )}
      {ask === 'done' && (
        <FormModal title={`#${row.id} — job done?`} message={row.warehouse_task} submitLabel="Mark done"
          fields={[{ name: 'note', label: 'Note (optional)', placeholder: 'e.g. shipped back, UPS 1Z…', maxLength: 500 }]}
          onClose={() => setAsk(null)}
          onSubmit={modal((v) => send('warehouse_done', v, `#${row.id} — warehouse job done.`))} />
      )}
    </div>
  );
}

// Report a problem found after receiving: one pair (by VIN) or a whole delivery (by its
// tracking number or batch code). Same record as the receiving Issues step makes.
function ReportModal({ onClose, onDone, onSignOut }) {
  const [scope, setScope] = useState('pair');
  const [code, setCode] = useState('');
  const [type, setType] = useState(PAIR_TYPES[0][0]);
  const [description, setDescription] = useState('');
  const [expectedCount, setExpected] = useState('');
  const [receivedCount, setReceived] = useState('');
  const [photos, setPhotos] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const types = scope === 'pair' ? PAIR_TYPES : SHIPMENT_TYPES;
  useEffect(() => { setType(types[0][0]); }, [scope]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit(e) {
    e.preventDefault();
    if (!code.trim()) return setErr(scope === 'pair' ? 'Scan or type the VIN.' : 'Scan or type the tracking number (or batch code).');
    setBusy(true); setErr('');
    try {
      const r = await api.reportInboundIssue({
        scope, type, description, photos, expectedCount, receivedCount,
        ...(scope === 'pair' ? { vin: code.trim() } : { code: code.trim() }),
      });
      onDone(r.row);
    } catch (e2) { if (e2.unauthorized) return onSignOut(); setErr(e2.message); setBusy(false); }
  }
  return (
    <div className="modal-overlay" onClick={() => (busy ? null : onClose())}>
      <form className="modal form-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3 className="modal-title">Report a problem</h3>
        <p className="modal-msg">Found after receiving? File it here — the PH team gets it on Telegram, same as one recorded at receiving.</p>
        <div className="seg sm" role="tablist" aria-label="About">
          <button type="button" role="tab" aria-selected={scope === 'pair'} className={`seg-btn ${scope === 'pair' ? 'on' : ''}`} onClick={() => setScope('pair')}>One pair</button>
          <button type="button" role="tab" aria-selected={scope === 'shipment'} className={`seg-btn ${scope === 'shipment' ? 'on' : ''}`} onClick={() => setScope('shipment')}>The delivery</button>
        </div>
        <div className="form-modal-fields">
          <label className="form-modal-label"><span>{scope === 'pair' ? 'VIN (1ID sticker)' : 'Tracking # or batch code'}<i className="form-modal-req" aria-hidden="true">*</i></span>
            <input className="input" value={code} onChange={(e) => setCode(e.target.value)} autoCapitalize="characters" autoCorrect="off" maxLength={80} disabled={busy}
              placeholder={scope === 'pair' ? 'SBM-…' : '1Z… or B-…'} />
          </label>
          <label className="form-modal-label"><span>What is wrong</span>
            <select className="input" value={type} onChange={(e) => setType(e.target.value)} disabled={busy}>
              {types.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          {scope === 'shipment' && type === 'shortfall' && (
            <span className="issue-counts">
              <input className="input" type="number" min="0" placeholder="Expected" value={expectedCount} onChange={(e) => setExpected(e.target.value)} />
              <input className="input" type="number" min="0" placeholder="Got" value={receivedCount} onChange={(e) => setReceived(e.target.value)} />
            </span>
          )}
          <label className="form-modal-label"><span>Details</span>
            <textarea className="input" rows={3} maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} disabled={busy}
              placeholder="What you see — e.g. left shoe is a size 9, box crushed on one corner" />
          </label>
          <div className="form-modal-label"><span>Photos — the parcel, the label, the pair</span>
            <DefectPhotos photos={photos} max={6} onChange={setPhotos} onSignOut={onSignOut} sign={(t) => api.inboundIssuePhotoSign(t)} />
          </div>
        </div>
        {err && <div className="error mt">{err}</div>}
        <div className="modal-actions">
          <button type="button" className="btn ghost" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Sending…' : 'Report it'}</button>
        </div>
      </form>
    </div>
  );
}

export function InboundIssues({ onHome, onSignOut }) {
  const [view, setView] = useQueryParam('view', 'open');
  const [days, setDays] = useQueryParam('days', '30');
  const [q, setQ] = useQueryParam('q', '');
  const [focus, setFocus] = useQueryParam('id', '');
  const [data, setData] = useState(null);
  const [focusRow, setFocusRow] = useState(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [reporting, setReporting] = useState(false);
  const [big, setBig] = useState(null);

  async function load() {
    try {
      setData(await api.inboundIssues(view, days)); setError('');
      if (focus) setFocusRow((await api.inboundIssue(focus)).row);
    } catch (e) { if (e.unauthorized) return onSignOut(); setError(e.message); }
  }
  useEffect(() => { setData(null); load(); }, [view, days, focus]); // eslint-disable-line react-hooks/exhaustive-deps
  useLive(['inbound_issues', 'inbound_issue_events', 'items'], load, { mount: false });

  const rows = useMemo(() => {
    if (focus && focusRow) return [focusRow];
    const t = q.trim().toUpperCase();
    return (data?.rows || []).filter((r) => !t
      || [`#${r.id}`, r.supplier, r.po_code, r.tracking_number, r.batch_code, r.vin, r.sku, r.product, r.owner, r.reported_by,
        r.online_order_number, r.supplier_ref, typeLabel(r.scope, r.type)]
        .some((v) => String(v || '').toUpperCase().includes(t)));
  }, [data, q, focus, focusRow]);
  const canWork = !!data?.canWork;
  const counts = data?.counts || {};

  function downloadCsv() {
    const blob = new Blob([inboundIssuesCsv(rows)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `inbound-issues-${view}-${estDate(Date.now())}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <div className="app ii-page">
      <TopBar title="Inbound Issues" onHome={onHome} onSignOut={onSignOut} />
      <div className="card">
        <p className="muted sm ii-lede">
          Problems found in deliveries — damaged parcels, short counts, missing or wrong pairs, defects. Each one is a <b>case</b>:
          {canWork
            ? <> <b>Take it</b>, contact the supplier (<b>Copy for supplier</b> has the supplier, PO, tracking #, pair, cost and photos), mark it <b>Waiting on supplier</b> while they answer, ask the warehouse for anything physical, then <b>Resolve</b> it with what happened.</>
            : <> the PH team takes it and sorts it out with the supplier. Record problems on the receiving Issues step (or <b>Report a problem</b> here), keep the box aside with its case number, and do the jobs on <b>Warehouse to-do</b>.</>}
          {' '}A flagged pair is held off listing until its case is resolved.
        </p>
        <div className="ii-filters">
          <div className="seg sm ii-tabs" role="tablist" aria-label="Status">
            {TABS.map(([k, l]) => {
              const n = counts[k];
              return (
                <button key={k} type="button" role="tab" aria-selected={view === k && !focus} className={`seg-btn ${view === k && !focus ? 'on' : ''}`}
                  onClick={() => { setFocus(''); setFocusRow(null); setView(k); }}>
                  {l}{n ? ` (${n})` : ''}
                </button>
              );
            })}
          </div>
          {['resolved', 'all'].includes(view) && !focus && (
            <select className="input" value={days} onChange={(e) => setDays(e.target.value)} aria-label="Period">
              {PERIODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          )}
          {!focus && <input className="input ii-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Supplier, PO, tracking #, VIN, SKU, owner or #case" aria-label="Search" />}
          <button type="button" className="btn sm primary" onClick={() => { setNote(''); setReporting(true); }}>+ Report a problem</button>
          <button type="button" className="btn sm" disabled={!rows.length} onClick={downloadCsv}>⬇ CSV</button>
        </div>
        {focus && <div className="ii-focus muted sm">Showing case #{focus}. <button type="button" className="btn xs ghost" onClick={() => { setFocus(''); setFocusRow(null); }}>Show all</button></div>}
        {error && <div className="error mt">{error}</div>}
        {note && <div className="ok mt" role="status">{note}</div>}
      </div>

      <div className="ii-list">
        {!data ? <div className="card"><p className="muted">Loading…</p></div> : !rows.length ? (
          <div className="card"><p className="muted">{data.rows.length ? 'Nothing matches the search.'
            : view === 'open' ? 'Nothing new — every reported problem has an owner.'
              : view === 'mine' ? 'You own no open cases.'
                : view === 'warehouse' ? 'No jobs waiting for the warehouse.' : 'Nothing here.'}</p></div>
        ) : rows.map((r) => (
          <Case key={r.id} row={r} canWork={canWork} me={data.me} assignees={data.assignees || []} focused={String(r.id) === String(focus)}
            onChanged={load} onOpenPhoto={setBig} onError={setError} setNote={setNote} onSignOut={onSignOut} />
        ))}
      </div>

      {big && (
        <div className="modal-overlay" onClick={() => setBig(null)}>
          <div className="cx-big" role="dialog" aria-modal="true" aria-label="Photo"><img src={big} alt="Issue photo" /></div>
        </div>
      )}
      {reporting && (
        <ReportModal onClose={() => setReporting(false)} onSignOut={onSignOut}
          onDone={(row) => { setReporting(false); setNote(row ? `Reported as case #${row.id} — the PH team has been told.` : 'Reported.'); load(); }} />
      )}
    </div>
  );
}
