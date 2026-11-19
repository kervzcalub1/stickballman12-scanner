// Manifest Discrepancies — a parcel whose own paperwork does not match what is in the box
// (docs/context/manifest-reports.md).
//
// The owner's ask (2026-11-20): the packing slip of an online order says 4 pairs and the
// box holds 2 (or a supplier slipped a manifest in the box and it is off). The warehouse
// reports it here on the spot — a photo of the boxes, a photo of the manifest — the PH
// team is told on Telegram at once, and every such report lives on this one page.
//
// Each report is an inbound-issues CASE, so "Take it" here is the same claim as on Inbound
// Issues, and the rest of the work (waiting on the store, asking the warehouse, resolving
// with the refund) is done on the case. Mismatches the app finds by itself against a
// recorded online order are listed here too: same problem, same chase.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { TopBar } from '../components/common.jsx';
import { DefectPhotos } from '../components/DefectPhotos.jsx';
import { ReceivingEvidence } from '../components/ReceivingEvidence.jsx';
import { TrackingLink } from '../components/TrackingLink.jsx';
import { useLive } from '../hooks.js';
import { useQueryParam } from '../lib/urlstate.js';
import { estDate, estTime } from '../lib/format.js';
import { STATUSES, outcomeLabel, ago, typeLabel } from '../lib/inboundIssues.js';
import {
  ORIGINS, VIEWS, originLabel, gapWords, manifestTotals, manifestReportProblem, cleanManifestLines, MAX_LINES,
} from '../lib/manifestReports.js';

const when = (t) => (t ? `${estDate(t)} ${estTime(t)} EST` : '');
const money = (n) => (n == null ? '' : `$${Number(n).toFixed(2)}`);
const CHIP = { open: 'bad', in_progress: 'info', waiting: 'info', resolved: 'ok' };
// The case on Inbound Issues, in the reader's own app (PH has its own copy of every page).
const caseHref = (id) => `${window.location.pathname.startsWith('/ph/') ? '/ph/inbound-issues' : '/inbound-issues'}?id=${id}`;
const blankLine = () => ({ shoe: '', size: '', listed: '', got: '' });

function Fact({ label, children }) {
  if (children == null || children === '' || children === false) return null;
  return <div className="ii-fact"><span className="muted xs">{label}</span><span>{children}</span></div>;
}

function Photos({ label, urls, onOpen }) {
  if (!urls?.length) return null;
  return (
    <div className="mr-photos">
      <span className="muted xs">{label}</span>
      <div className="ii-photos">
        {urls.map((u) => (
          <button type="button" key={u} className="ii-photo" onClick={() => onOpen(u)} aria-label={`Open the photo: ${label}`}>
            <img src={u} alt={label} loading="lazy" />
          </button>
        ))}
      </div>
    </div>
  );
}

function Report({ row, canWork, focused, onTake, busy, onOpenPhoto }) {
  const m = row.manifest || null;
  const lines = cleanManifestLines(m?.lines);
  const resolved = row.status === 'resolved';
  const gap = gapWords(row.expected_count, row.received_count);
  const store = m?.store || row.online_store || row.supplier;
  const orderNo = m?.orderNumber || row.online_order_number;
  // Photos not filed under "boxes" or "manifest": added to the case later, or an automatic find's.
  const other = (row.photos || []).filter((u) => !(m?.boxPhotos || []).includes(u) && !(m?.manifestPhotos || []).includes(u) && !(m?.labelPhotos || []).includes(u));
  return (
    <div className={`ii-case ii-${row.status}${focused ? ' focused' : ''}`} id={`report-${row.id}`}>
      <div className="ii-head">
        <b>#{row.id}</b>
        <span className={`inbound-chip sm ${CHIP[row.status] || ''}`}>{row.status === 'open' ? 'Not taken' : STATUSES[row.status]}</span>
        {row.status === 'open' && <span className="inbound-chip sm bad">Urgent</span>}
        <span className="inbound-chip sm muted">{m ? originLabel(m.origin) : 'Found by the app · online order'}</span>
        <span className="muted xs ii-age">{ago(row.created_at)} ago</span>
      </div>
      <div className="ii-title">
        {m ? 'Manifest' : 'Order'} lists <span className="mr-n">{row.expected_count ?? '?'}</span> · in the box <span className="mr-n">{row.received_count ?? '?'}</span>
        {gap && <span className={`mr-gap ${Number(row.expected_count) > Number(row.received_count) ? 'short' : ''}`}>{gap}</span>}
      </div>

      <div className="ii-facts">
        <Fact label={m?.origin === 'supplier' ? 'Supplier' : 'Store'}>{store}</Fact>
        <Fact label="Order #">{orderNo}</Fact>
        <Fact label="Tracking #">{row.tracking_number ? <TrackingLink number={row.tracking_number} /> : <span className="muted">none given</span>}</Fact>
        <Fact label="Received as">{row.batch_code && <>{row.batch_code}{row.box_number != null ? ` · box ${row.box_number}` : ''}</>}</Fact>
        <Fact label="Reported">{row.reported_by || '—'} · {when(row.created_at)}</Fact>
        <Fact label="Owner">{row.owner ? row.owner : <span className="muted">nobody yet</span>}</Fact>
      </div>

      {lines.length > 0 && (
        <table className="mr-lines">
          <thead><tr><th>Shoe</th><th>Size</th><th>Manifest</th><th>In the box</th></tr></thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i} className={l.listed !== l.got ? 'off' : ''}>
                <td>{l.shoe || '—'}</td><td>{l.size || '—'}</td><td>{l.listed}</td><td>{l.got}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {m?.note && <p className="ii-desc"><span className="muted xs">Note</span><br />{m.note}</p>}
      {!m && row.description && <p className="ii-desc">{row.description}</p>}

      <Photos label="The shipping label" urls={m?.labelPhotos} onOpen={onOpenPhoto} />
      {m?.noLabel && <p className="muted sm">Shipping label: no longer available — the carton was already thrown away.</p>}
      <Photos label="The boxes" urls={m?.boxPhotos} onOpen={onOpenPhoto} />
      <Photos label="The manifest" urls={m?.manifestPhotos} onOpen={onOpenPhoto} />
      <Photos label={m ? 'Added later' : 'Photos'} urls={other} onOpen={onOpenPhoto} />
      <ReceivingEvidence evidence={row.evidence} onOpen={onOpenPhoto} />
      {!m && !(row.photos || []).length && !resolved && (
        <p className="muted sm mr-nophotos">No photos yet. Open the case and add the boxes and the packing slip.</p>
      )}

      {resolved && (
        <div className="ii-resolution">
          <b>{outcomeLabel(row.outcome)}</b>{row.refund_amount != null ? ` · ${money(row.refund_amount)}` : ''}
          <span className="muted xs"> — {row.resolved_by} · {when(row.resolved_at)}</span>
          {row.resolution_note && <div className="muted sm">{row.resolution_note}</div>}
        </div>
      )}

      <div className="ii-actions">
        {canWork && row.status === 'open' && (
          <button type="button" className="btn sm primary" disabled={busy} onClick={() => onTake(row)}>{busy ? 'Taking…' : '✋ Take it'}</button>
        )}
        <a className="btn sm" href={caseHref(row.id)}>
          {canWork ? 'Open the case to work it →' : 'Open the case →'}
        </a>
      </div>
    </div>
  );
}

// The report form. Two numbers and two photos are all it takes; the shoe rows are there
// for when the floor has a minute, because they are what the claim to the store quotes.
function ReportModal({ onClose, onDone, onSignOut }) {
  const [origin, setOrigin] = useState('online');
  const [tracking, setTracking] = useState('');
  const [store, setStore] = useState('');
  const [orderNumber, setOrderNumber] = useState('');
  const [listed, setListed] = useState('');
  const [got, setGot] = useState('');
  const [lines, setLines] = useState([]);
  const [boxPhotos, setBoxPhotos] = useState([]);
  const [manifestPhotos, setManifestPhotos] = useState([]);
  const [labelPhotos, setLabelPhotos] = useState([]);
  const [noLabel, setNoLabel] = useState(false);
  const [note, setNote] = useState('');
  const [order, setOrder] = useState(null);     // the online order this tracking number is on, if any
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [dupe, setDupe] = useState(null);
  const asked = useRef('');

  // Is this parcel an online order we have on file? Then the store and order # are known,
  // and what it should hold can be filled in with one tap.
  async function lookUp() {
    const t = tracking.trim();
    if (t.replace(/\s+/g, '').length < 8 || asked.current === t) return;
    asked.current = t;
    try {
      const r = await api.onlineOrderByTracking(t);
      setOrder(r.order || null);
      if (r.order) {
        setOrigin('online');
        setStore((s) => s || r.order.store || '');
        setOrderNumber((s) => s || r.order.order_number || '');
      }
    } catch (e) { if (e.unauthorized) onSignOut(); }
  }
  const orderLines = (order?.lines || []).filter((l) => !l.cancelled_at);
  function fillFromOrder() {
    setLines(orderLines.slice(0, MAX_LINES).map((l) => ({ shoe: [l.name, l.sku].filter(Boolean).join(' · '), size: l.size || '', listed: String(l.qty), got: '' })));
  }

  const rows = cleanManifestLines(lines);
  const totals = manifestTotals({ lines, listed, got });
  const setLine = (i, k, v) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  const form = { origin, store, orderNumber, lines, listed, got, note, boxPhotos, manifestPhotos, labelPhotos, noLabel: noLabel && !labelPhotos.length };

  async function submit(e) {
    e.preventDefault();
    const problem = manifestReportProblem(form);
    if (problem) return setErr(problem);
    setBusy(true); setErr(''); setDupe(null);
    try {
      const r = await api.reportManifestDiscrepancy({ ...form, tracking: tracking.trim() });
      onDone(r.row);
    } catch (e2) {
      if (e2.unauthorized) return onSignOut();
      setErr(e2.message); setDupe(e2.data?.caseId || null); setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={() => (busy ? null : onClose())}>
      <form className="modal form-modal mr-form" role="dialog" aria-modal="true" aria-label="Report a manifest discrepancy" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3 className="modal-title">Report a manifest discrepancy</h3>
        <p className="modal-msg">The paper in the parcel says one thing and the box holds another. The PH team is told on Telegram the moment you send this. Keep the parcel and its paper together, aside.</p>

        <div className="seg sm" role="tablist" aria-label="Where it is from">
          {ORIGINS.map(([k, l]) => (
            <button key={k} type="button" role="tab" aria-selected={origin === k} className={`seg-btn ${origin === k ? 'on' : ''}`} onClick={() => setOrigin(k)}>{l}</button>
          ))}
        </div>

        <div className="form-modal-fields">
          <label className="form-modal-label"><span>Tracking # on the parcel</span>
            <input className="input" value={tracking} onChange={(e) => setTracking(e.target.value)} onBlur={lookUp} autoCapitalize="characters" autoCorrect="off"
              maxLength={60} disabled={busy} placeholder="Scan or type it. Leave empty if there is none" />
          </label>
          {order && (
            <div className="mr-order">
              On file: <b>{order.store}</b>{order.order_number ? ` · order #${order.order_number}` : ''} · {orderLines.reduce((n, l) => n + Number(l.qty || 0), 0)} pairs ordered.
              {orderLines.length > 0 && <> <button type="button" className="btn xs" onClick={fillFromOrder} disabled={busy}>Fill in its shoes</button></>}
            </div>
          )}
          <label className="form-modal-label"><span>{origin === 'online' ? 'Store (on the packing slip)' : 'Supplier'}<i className="form-modal-req" aria-hidden="true">*</i></span>
            <input className="input" value={store} onChange={(e) => setStore(e.target.value)} maxLength={120} disabled={busy}
              placeholder={origin === 'online' ? 'e.g. Foot Locker, Shoe Palace, Nike' : 'e.g. Sunny'} />
          </label>
          {origin === 'online' && (
            <label className="form-modal-label"><span>Order # (if the slip shows one)</span>
              <input className="input" value={orderNumber} onChange={(e) => setOrderNumber(e.target.value)} maxLength={80} disabled={busy} autoCapitalize="characters" autoCorrect="off" />
            </label>
          )}

          <div className="mr-counts">
            <label className="form-modal-label"><span>Manifest lists (pairs)<i className="form-modal-req" aria-hidden="true">*</i></span>
              <input className="input" type="number" inputMode="numeric" min="0" max="9999" aria-label="Pairs the manifest lists"
                value={rows.length ? totals.listed : listed} onChange={(e) => setListed(e.target.value)} disabled={busy || rows.length > 0} />
            </label>
            <label className="form-modal-label"><span>In the box (pairs)<i className="form-modal-req" aria-hidden="true">*</i></span>
              <input className="input" type="number" inputMode="numeric" min="0" max="9999" aria-label="Pairs in the box"
                value={rows.length ? totals.got : got} onChange={(e) => setGot(e.target.value)} disabled={busy || rows.length > 0} />
            </label>
            {totals.listed != null && totals.got != null && (
              <span className={`mr-gap ${totals.listed > totals.got ? 'short' : ''}`} role="status">{gapWords(totals.listed, totals.got)}</span>
            )}
          </div>

          <div className="form-modal-label"><span>Which shoes? (optional, it helps the claim)</span>
            {lines.map((l, i) => (
              <div className="mr-line" key={i}>
                <input className="input mr-shoe" value={l.shoe} onChange={(e) => setLine(i, 'shoe', e.target.value)} placeholder="Shoe or SKU" maxLength={120} disabled={busy} aria-label={`Shoe ${i + 1}`} />
                <input className="input" value={l.size} onChange={(e) => setLine(i, 'size', e.target.value)} placeholder="Size" maxLength={20} disabled={busy} aria-label={`Size ${i + 1}`} />
                <input className="input" type="number" inputMode="numeric" min="0" value={l.listed} onChange={(e) => setLine(i, 'listed', e.target.value)} placeholder="Manifest" disabled={busy} aria-label={`Manifest quantity ${i + 1}`} />
                <input className="input" type="number" inputMode="numeric" min="0" value={l.got} onChange={(e) => setLine(i, 'got', e.target.value)} placeholder="In box" disabled={busy} aria-label={`In the box ${i + 1}`} />
                <button type="button" className="btn xs ghost" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} disabled={busy} aria-label={`Remove shoe ${i + 1}`}>✕</button>
              </div>
            ))}
            {lines.length < MAX_LINES && (
              <button type="button" className="btn sm ghost mr-add" onClick={() => setLines((ls) => [...ls, blankLine()])} disabled={busy}>+ Add a shoe</button>
            )}
            {rows.length > 0 && <span className="muted xs">The two totals above now add up from these rows.</span>}
          </div>

          <div className="form-modal-label"><span>Photo of the shipping label<i className="form-modal-req" aria-hidden="true">*</i></span>
            <span className="muted xs">Still on the carton, the tracking number readable. The store asks for this before it looks at a claim.</span>
            {!noLabel && <DefectPhotos photos={labelPhotos} max={6} onChange={setLabelPhotos} onSignOut={onSignOut} sign={(t) => api.inboundIssuePhotoSign(t)} />}
            {!labelPhotos.length && (
              <label className="mr-nolabel sm"><input type="checkbox" checked={noLabel} onChange={(e) => setNoLabel(e.target.checked)} disabled={busy} /> The carton is already thrown away — there is no label to photograph</label>
            )}
          </div>
          <div className="form-modal-label"><span>Photo of the boxes that arrived<i className="form-modal-req" aria-hidden="true">*</i></span>
            <span className="muted xs">Every shoe box from the parcel in one picture, so the count can be seen.</span>
            <DefectPhotos photos={boxPhotos} max={6} onChange={setBoxPhotos} onSignOut={onSignOut} sign={(t) => api.inboundIssuePhotoSign(t)} />
          </div>
          <div className="form-modal-label"><span>Photo of the manifest<i className="form-modal-req" aria-hidden="true">*</i></span>
            <span className="muted xs">The packing slip or the paper from inside the box, flat, every line readable.</span>
            <DefectPhotos photos={manifestPhotos} max={6} onChange={setManifestPhotos} onSignOut={onSignOut} sign={(t) => api.inboundIssuePhotoSign(t)} />
          </div>

          <label className="form-modal-label"><span>Note</span>
            <textarea className="input" rows={2} maxLength={600} value={note} onChange={(e) => setNote(e.target.value)} disabled={busy}
              placeholder="Anything else: box was re-taped, wrong shoe inside, label torn" />
          </label>
        </div>
        {err && <div className="error mt">{err}{dupe ? <> <a href={caseHref(dupe)}>Open case #{dupe} →</a></> : null}</div>}
        <div className="modal-actions">
          <button type="button" className="btn ghost" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Sending…' : 'Send to the PH team'}</button>
        </div>
      </form>
    </div>
  );
}

export function ManifestReports({ onHome, onSignOut }) {
  const [view, setView] = useQueryParam('view', 'open');
  const [q, setQ] = useQueryParam('q', '');
  const [focus, setFocus] = useQueryParam('id', '');
  const [newOpen, setNewOpen] = useQueryParam('new', '');
  const [data, setData] = useState(null);
  const [focusRow, setFocusRow] = useState(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [taking, setTaking] = useState(null);
  const [big, setBig] = useState(null);

  async function load() {
    try {
      setData(await api.manifestReports(view)); setError('');
      if (focus) setFocusRow((await api.inboundIssue(focus)).row);
    } catch (e) { if (e.unauthorized) return onSignOut(); setError(e.message); }
  }
  useEffect(() => { setData(null); load(); }, [view, focus]); // eslint-disable-line react-hooks/exhaustive-deps
  useLive(['inbound_issues'], load, { mount: false });

  const rows = useMemo(() => {
    if (focus && focusRow) return [focusRow];
    const t = q.trim().toUpperCase();
    return (data?.rows || []).filter((r) => !t
      || [`#${r.id}`, r.supplier, r.manifest?.store, r.manifest?.orderNumber, r.online_store, r.online_order_number, r.tracking_number,
        r.batch_code, r.owner, r.reported_by, r.description, typeLabel(r.scope, r.type)]
        .some((v) => String(v || '').toUpperCase().includes(t)));
  }, [data, q, focus, focusRow]);
  const canWork = !!data?.canWork;
  const counts = data?.counts || {};

  async function take(row) {
    setTaking(row.id); setError('');
    try {
      await api.inboundIssueAction(row.id, 'claim');
      setNote(`#${row.id} is yours. Work it on its case: contact the ${row.manifest?.origin === 'supplier' ? 'supplier' : 'store'}, then resolve it with what came back.`);
      await load();
    } catch (e) { if (e.unauthorized) return onSignOut(); setError(e.message); }
    setTaking(null);
  }

  return (
    <div className="app ii-page">
      <TopBar title="Manifest Discrepancies" onHome={onHome} onSignOut={onSignOut} />
      <div className="card">
        <p className="muted sm ii-lede">
          A parcel whose own paper (the packing slip of an online order, or a manifest a supplier put in the box) does not match what is inside.
          {canWork
            ? <> These are <b>urgent</b>: <b>Take it</b>, claim from the store or supplier with the photos, and resolve the case with what came back.</>
            : <> <b>Report it here before anything else</b>, with a photo of the boxes and a photo of the manifest. The PH team is told on Telegram at once.</>}
        </p>
        <button type="button" className="btn primary mr-report" onClick={() => { setNote(''); setNewOpen('1'); }}>+ Report a discrepancy</button>
        <div className="ii-filters mr-filters">
          <div className="seg sm" role="tablist" aria-label="Status">
            {VIEWS.map(([k, l]) => (
              <button key={k} type="button" role="tab" aria-selected={view === k && !focus} className={`seg-btn ${view === k && !focus ? 'on' : ''}`}
                onClick={() => { setFocus(''); setFocusRow(null); setView(k); }}>
                {l}{counts[k] ? ` (${counts[k]})` : ''}
              </button>
            ))}
          </div>
          {!focus && <input className="input ii-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Store, supplier, order #, tracking # or #case" aria-label="Search" />}
        </div>
        {focus && <div className="ii-focus muted sm">Showing report #{focus}. <button type="button" className="btn xs ghost" onClick={() => { setFocus(''); setFocusRow(null); }}>Show all</button></div>}
        {error && <div className="error mt">{error}</div>}
        {note && <div className="ok mt" role="status">{note}</div>}
      </div>

      <div className="ii-list">
        {!data ? <div className="card"><p className="muted">Loading…</p></div> : !rows.length ? (
          <div className="card"><p className="muted">{data.rows.length ? 'Nothing matches the search.'
            : view === 'open' ? 'Nothing waiting. Every reported discrepancy has an owner.'
              : view === 'working' ? 'Nothing being worked right now.' : 'Nothing here yet.'}</p></div>
        ) : rows.map((r) => (
          <Report key={r.id} row={r} canWork={canWork} focused={String(r.id) === String(focus)} busy={taking === r.id}
            onTake={take} onOpenPhoto={setBig} />
        ))}
      </div>

      {big && (
        <div className="modal-overlay" onClick={() => setBig(null)}>
          <div className="cx-big" role="dialog" aria-modal="true" aria-label="Photo"><img src={big} alt="Report photo" /></div>
        </div>
      )}
      {newOpen === '1' && (
        <ReportModal onClose={() => setNewOpen('')} onSignOut={onSignOut}
          onDone={(row) => {
            setNewOpen('');
            setNote(row ? `Sent as #${row.id}. The PH team has been told on Telegram. Keep the parcel and its paper together, aside, marked #${row.id}.` : 'Sent.');
            setView('open'); load();
          }} />
      )}
    </div>
  );
}
