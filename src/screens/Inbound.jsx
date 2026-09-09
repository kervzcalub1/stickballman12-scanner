// Inbound — what lands today, what is coming, and what has stopped moving.
//
// The question this answers is the one the warehouse opens the day with, and until
// now it could only be answered by opening purchase orders one at a time and reading
// each label's tracking. That is how a shipment of 169 pairs arrived 8 short and
// nobody noticed until the supplier asked to be paid.
//
// **It used to answer only half of it.** Every box was classified by WHERE it was —
// in transit, delayed, delivered — and never by WHEN it was due, so "in transit"
// covered both a parcel on a truck two streets away and one that leaves Guangzhou on
// Thursday. A floor cannot plan a morning from that. The carrier's own estimated
// delivery window is in the 17TRACK payload we already receive; the top of this screen
// is now that window, in boxes and pairs, for today and the days after it.
//
// PAIRS as well as boxes, because pairs are what cost time: twelve boxes of two is a
// quiet morning and two boxes of a hundred and sixty is not.
//
// Deliberately NOT folded into Home. Home is a chore list — things somebody must go
// and do. This is a feed of things happening to us, most of which need watching
// rather than doing, and burying it among the chores is how it stops being read.
//
// Nothing here is fetched from the courier: the 17TRACK webhook has already written
// every field, so opening this screen costs one query and no quota. Classification
// lives in src/lib/inbound.js so this screen, its summary strip and the Home tile
// can never disagree about whether a shipment is in trouble.
import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { TopBar } from '../components/common.jsx';
import { Icon } from '../components/NavIcons.jsx';
import { DeliveryStatusLine } from '../components/DeliveryStatus.jsx';
import {
  INBOUND_STATES, STATE_ORDER, ARRIVAL_BUCKETS, ARRIVAL_ORDER,
  groupShipments, countStates, needsAttention, arrivalBucket, arrivalPlan, inboundProgress,
} from '../lib/inbound.js';
import { estDate, estToday, estCivilFromYmd } from '../lib/format.js';
import { useQueryParam } from '../lib/urlstate.js';

// "box" pluralises to "boxes", not "boxs" — the one irregular this screen needs.
const plural = (n, s) => `${n} ${n === 1 ? s : (/(?:s|x|z|ch|sh)$/.test(s) ? `${s}es` : `${s}s`)}`;

// "Thu, Sep 11". Formatted in EST like everything else on screen — `estCivilFromYmd`
// parses at noon UTC precisely so the day survives being read from Manila.
const DUE_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric',
});
const dayLabel = (d) => DUE_FMT.format(estCivilFromYmd(d));

// An ETA in the words somebody would use out loud. A bare date makes the reader do the
// arithmetic every single time they glance at the row — and a WINDOW has to read as a
// window, because "Tue–Thu" is what the carrier actually promised.
function etaWords(box, today) {
  const from = box.eta_from; const to = box.eta_to || box.eta_from;
  if (!from) return null;
  if (from <= today && today <= to) return 'due today';
  if (to < today) return `was due ${dayLabel(to)}`;
  if (from === to) return `due ${dayLabel(from)}`;
  return `due ${dayLabel(from)} – ${dayLabel(to)}`;
}

// One bucket in the day strip. The number IS the filter — the figure somebody is
// alarmed by is the one they want to click.
function DueTile({ k, plan, on, onClick }) {
  const b = plan[k];
  const meta = ARRIVAL_BUCKETS[k];
  return (
    <button type="button" className={`inb-due ${k} ${on ? 'on' : ''}`} title={meta.blurb} onClick={onClick}>
      <span className="inb-due-lbl">{meta.label}</span>
      <span className="inb-due-n">{b.boxes}</span>
      <span className="inb-due-sub">
        {plural(b.boxes, 'box')}
        {b.units > 0 && <> · <b>{b.units}</b> pairs</>}
        {/* A box nobody declared a manifest for contributes no pair count, and that is
            said out loud rather than counted as zero. "No pairs expected" and "we don't
            know how many" are different answers, and only one lets you stop planning. */}
        {b.unknownUnits > 0 && <> · {b.unknownUnits} uncounted</>}
      </span>
    </button>
  );
}

export function Inbound({ onHome, onSignOut, onOpenPo }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');      // state: investigate / delayed / …
  const [showDone, setShowDone] = useState(false);
  // Supplier, the date window and the day filter live in the URL, like the other
  // filtered pages: a narrowed feed is something you send to somebody ("look at what
  // lands today"), and it has to survive the refresh you do after chasing a carrier.
  const [supplier, setSupplier] = useQueryParam('supplier');
  const [from, setFrom] = useQueryParam('from');
  const [to, setTo] = useQueryParam('to');
  const [due, setDue] = useQueryParam('due');
  const [open, setOpen] = useState(() => new Set());
  const [openDone, setOpenDone] = useState(() => new Set());

  // The EST day, because that is the day the warehouse works to. Read once per render
  // rather than per row — and never `new Date().toISOString()`, which is UTC and rolls
  // over five hours early.
  const today = estToday();

  async function load() {
    setError('');
    try { const r = await api.inbound(); setRows(r.boxes || []); }
    catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
  }
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Filters apply to SHIPMENTS, and the counts are computed from the same filtered
  // set — a strip that kept counting the whole warehouse while the list below showed
  // one supplier is a strip that lies.
  const inWindow = (r) => {
    const d = r.po_created_at ? estDate(r.po_created_at) : '';
    return (!from || (d && d >= from)) && (!to || (d && d <= to));
  };
  const matches = (r) => (!supplier || (r.supplier_name || '') === supplier) && inWindow(r);
  const scoped = (rows || []).filter(matches);
  const suppliers = [...new Set((rows || []).map((r) => r.supplier_name).filter(Boolean))].sort();
  const narrowed = Boolean(supplier || from || to);

  const counts = countStates(scoped);
  const plan = arrivalPlan(scoped, today);
  const progress = inboundProgress(scoped);
  const shipments = groupShipments(scoped);

  // A shipment whose every box has landed is done watching, and there are far more of
  // those than of the ones that matter. Hidden by default rather than dropped: "where
  // did the order I received this morning go" is a fair question.
  const done = (s) => s.boxes.every((b) => b.state === 'delivered');
  const inDue = (s) => !due || s.boxes.some((b) => arrivalBucket(b, today, b.state) === due);
  const visible = shipments
    .filter(inDue)
    .filter((s) => (filter ? s.state === filter : (showDone || due === 'landed' || !done(s))));
  const attention = shipments.filter((s) => needsAttention(s.state)).length;

  const flip = (setter) => (id) => setter((o) => {
    const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n;
  });
  const toggle = flip(setOpen);
  const toggleDone = flip(setOpenDone);
  const boxesFor = (s, withDone) => {
    const live = s.boxes.filter((b) => b.state !== 'delivered');
    return withDone || !live.length ? s.boxes : live;
  };

  const arrivingToday = plan.today;
  const anyDue = ARRIVAL_ORDER.some((k) => k !== 'landed' && plan[k].boxes > 0);

  return (
    <div className="page">
      <TopBar title="Inbound" onHome={onHome} onSignOut={onSignOut} />

      {/* ---- The day, first. Everything else on this screen is context for it. ---- */}
      <div className="card inb-hero">
        <div className="step-head">
          <h3 className="rows-title">Expected today</h3>
          <button className="btn ghost sm" onClick={load} disabled={!rows}><Icon name="refresh" /> Refresh</button>
        </div>

        {!rows && !error && <p className="muted">Loading…</p>}

        {rows && (
          <>
            <p className="inb-headline">
              {arrivingToday.boxes === 0 ? (
                <span className="muted">Nothing is due on the floor today.</span>
              ) : (
                <>
                  <b className="inb-big">{arrivingToday.boxes}</b>
                  <span> {arrivingToday.boxes === 1 ? 'box' : 'boxes'} from </span>
                  <b>{plural(arrivingToday.shipments, 'shipment')}</b>
                  {/* Three different sentences, because "0 pairs" and "we can't say"
                      are different answers and only one of them means a quiet morning. */}
                  {arrivingToday.units > 0 && <> — about <b>{arrivingToday.units}</b> pairs to receive</>}
                  {arrivingToday.units > 0 && arrivingToday.unknownUnits > 0 && (
                    <span className="muted">, plus {arrivingToday.unknownUnits} nobody has declared a manifest for</span>
                  )}
                  {arrivingToday.units === 0 && arrivingToday.unknownUnits > 0 && (
                    <span className="muted"> — no manifest yet, so the pair count is unknown</span>
                  )}
                </>
              )}
              {plan.overdue.boxes > 0 && (
                <span className="inb-overdue-note">
                  {' '}· <b>{plural(plan.overdue.boxes, 'box')}</b> past the carrier’s own estimate.
                </span>
              )}
            </p>

            {/* Every box still inbound, and how much of it is already here. The bar is
                the answer to "are we nearly through it" that the list below cannot give
                without scrolling. */}
            <div className="inb-progress" role="img"
              aria-label={`${progress.landed} of ${progress.total} inbound boxes have landed`}>
              <div className="inb-progress-fill" style={{ width: `${progress.pct}%` }} />
            </div>
            <p className="muted sm">
              <b>{progress.landed}</b> of {progress.total} inbound {progress.total === 1 ? 'box has' : 'boxes have'} landed
              {' '}({progress.pct}%){narrowed ? ' in this view' : ''}.
            </p>

            {/* The days, worst and soonest first. Each is a filter on the list below. */}
            <h4 className="inb-strip-h">When it lands</h4>
            <div className="inb-due-strip">
              {ARRIVAL_ORDER.filter((k) => plan[k].boxes > 0).map((k) => (
                <DueTile key={k} k={k} plan={plan} on={due === k}
                  onClick={() => setDue(due === k ? '' : k)} />
              ))}
              {!anyDue && <span className="muted">Nothing outstanding — every inbound box has landed.</span>}
            </div>

            {/* Trouble is a different axis from timing: a parcel can be due today AND
                stuck. Kept as its own strip rather than mixed into the days, because a
                delayed box has no meaningful arrival date to sit under. */}
            <h4 className="inb-strip-h">How it is travelling</h4>
            <div className="inbound-strip">
              {STATE_ORDER.filter((k) => counts[k]).map((k) => (
                <button key={k} type="button"
                  className={`inbound-stat ${INBOUND_STATES[k].tone} ${filter === k ? 'on' : ''}`}
                  title={INBOUND_STATES[k].blurb}
                  onClick={() => setFilter(filter === k ? '' : k)}>
                  <span className="inbound-n">{counts[k]}</span>
                  <span className="inbound-lbl">{INBOUND_STATES[k].label}</span>
                </button>
              ))}
              {rows && !rows.length && <span className="muted">Nothing inbound — every order is reconciled or closed.</span>}
              {rows && rows.length > 0 && !scoped.length && (
                <span className="muted">No shipments match those filters.</span>
              )}
            </div>

            {attention > 0 && !filter && (
              <p className="inbound-lede">
                <b>{plural(attention, 'shipment')}</b> {attention === 1 ? 'needs' : 'need'} somebody to look at {attention === 1 ? 'it' : 'them'}.
              </p>
            )}
          </>
        )}
      </div>

      <div className="card">
        <div className="inbound-filters">
          <label className="inbound-field">
            <span className="muted sm">Supplier</span>
            <select value={supplier} onChange={(e) => setSupplier(e.target.value)}>
              <option value="">All suppliers</option>
              {suppliers.map((sup) => <option key={sup} value={sup}>{sup}</option>)}
            </select>
          </label>
          <label className="inbound-field">
            <span className="muted sm">Raised from</span>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="inbound-field">
            <span className="muted sm">to</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          {(narrowed || due || filter) && (
            <button type="button" className="btn ghost sm"
              onClick={() => { setSupplier(''); setFrom(''); setTo(''); setDue(''); setFilter(''); }}>
              Clear filters
            </button>
          )}
        </div>
        {narrowed && rows && (
          <p className="muted sm inbound-scope">
            Showing <b>{shipments.length}</b> of {groupShipments(rows).length} shipments
            {supplier ? <> from <b>{supplier}</b></> : null}
            {from || to ? <> raised {from || 'any time'} → {to || 'now'}</> : null}.
          </p>
        )}
      </div>

      {error && <div className="error mt">{error}</div>}

      {rows && (
        <div className="card">
          <div className="step-head">
            <h3 className="rows-title">
              {due ? ARRIVAL_BUCKETS[due].label : filter ? INBOUND_STATES[filter].label : 'Still open'}
              <span className="muted"> ({visible.length})</span>
            </h3>
            {!filter && !due && (
              <label className="inbound-toggle">
                <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} />
                Show fully delivered
              </label>
            )}
          </div>
          {!visible.length ? (
            <p className="muted">
              {due ? `Nothing is due ${ARRIVAL_BUCKETS[due].label.toLowerCase()}.`
                : filter ? 'Nothing in that state.'
                  : 'Everything open has landed. Toggle above to see it.'}
            </p>
          ) : visible.map((s) => {
            const isOpen = open.has(s.poId);
            const short = s.outstanding != null && s.outstanding > 0;
            const over = s.outstanding != null && s.outstanding < 0;
            // How much of THIS order is on the shelf. Boxes rather than pairs, because
            // a box is what turns up: the pair count only becomes real once somebody
            // has scanned the contents in.
            const pct = s.boxCount ? Math.round((s.delivered / s.boxCount) * 100) : 0;
            return (
              <div className={`inbound-ship ${INBOUND_STATES[s.state].tone}`} key={s.poId}>
                <button className="inbound-head" onClick={() => toggle(s.poId)}>
                  <span className="inbound-caret">{isOpen ? '▾' : '▸'}</span>
                  <span className={`inbound-chip ${INBOUND_STATES[s.state].tone}`}>{INBOUND_STATES[s.state].label}</span>
                  <span className="inbound-supplier">{s.supplier || 'Unknown supplier'}</span>
                  <span className="muted sm inbound-po">{s.poCode || `PO ${s.poId}`}</span>
                  <span className="inb-ship-bar" title={`${s.delivered} of ${s.boxCount} boxes landed`}>
                    <span className="inb-ship-fill" style={{ width: `${pct}%` }} />
                  </span>
                  <span className="muted sm">{s.delivered}/{s.boxCount} boxes</span>
                  {s.expected > 0 && (
                    <span className="inbound-units">
                      {s.received}<span className="muted">/{s.expected} pairs</span>
                    </span>
                  )}
                  {short && <span className="inbound-var short">−{s.outstanding} outstanding</span>}
                  {over && <span className="inbound-var over">+{-s.outstanding} over</span>}
                </button>
                {isOpen && (
                  <div className="inbound-boxes">
                    {/* Delivered boxes are folded away even inside an open shipment. On
                        the order that prompted this screen, twelve landed boxes sat above
                        the one stuck in Chicago — the row you opened the shipment to read
                        was the one you had to scroll past everything else to find. */}
                    {boxesFor(s, openDone.has(s.poId)).map((b) => {
                      const bucket = arrivalBucket(b, today, b.state);
                      const eta = etaWords(b, today);
                      return (
                        <div className="inbound-box" key={b.box_id}>
                          <div className="inbound-box-line">
                            <span className={`inbound-chip sm ${INBOUND_STATES[b.state].tone}`}>{INBOUND_STATES[b.state].label}</span>
                            <span className="box-num">Box {b.box_number ?? '—'}</span>
                            {Number(b.box_units) > 0 && <span className="muted sm">{plural(Number(b.box_units), 'pair')}</span>}
                            {/* The date the whole screen now turns on, said in words. */}
                            {eta && <span className={`inb-eta ${bucket}`}>{eta}</span>}
                            {!eta && b.state !== 'delivered' && (
                              <span className="muted sm" title="The carrier has not given a delivery estimate for this parcel">no ETA</span>
                            )}
                            <span className="box-track muted sm">{b.tracking_number || 'no tracking number'}</span>
                            {b.idleDays != null && b.state !== 'delivered' && (
                              <span className="muted sm" title="Since the carrier last scanned it — not since we last looked">
                                {b.idleDays < 1 ? 'moved today' : `${Math.floor(b.idleDays)}d since last scan`}
                              </span>
                            )}
                            {b.last_location && <span className="muted sm">· {b.last_location}</span>}
                          </div>
                          <DeliveryStatusLine box={b} />
                        </div>
                      );
                    })}
                    <div className="inbound-actions">
                      <span className="muted sm">
                        Raised {estDate(s.createdAt)}
                        {s.delivered > 0 && (
                          <>
                            {' · '}
                            <button type="button" className="linklike" onClick={() => toggleDone(s.poId)}>
                              {openDone.has(s.poId) ? 'hide' : 'show'} {plural(s.delivered, 'delivered box')}
                            </button>
                          </>
                        )}
                      </span>
                      {onOpenPo && (
                        <button className="btn ghost sm" onClick={() => onOpenPo(s.poId)}>
                          Open the order →
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
