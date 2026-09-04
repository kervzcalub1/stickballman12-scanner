// Inbound — what is coming, from whom, and what has stopped moving.
//
// The question this answers is the one the warehouse opens the day with, and until
// now it could only be answered by opening purchase orders one at a time and reading
// each label's tracking. That is how a shipment of 169 pairs arrived 8 short and
// nobody noticed until the supplier asked to be paid.
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
import { INBOUND_STATES, STATE_ORDER, groupShipments, countStates, needsAttention } from '../lib/inbound.js';
import { estDate } from '../lib/format.js';

// "box" pluralises to "boxes", not "boxs" — the one irregular this screen needs.
const plural = (n, s) => `${n} ${n === 1 ? s : (/(?:s|x|z|ch|sh)$/.test(s) ? `${s}es` : `${s}s`)}`;

export function Inbound({ onHome, onSignOut, onOpenPo }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');      // '' = everything still open
  const [showDone, setShowDone] = useState(false);
  const [open, setOpen] = useState(() => new Set());
  const [openDone, setOpenDone] = useState(() => new Set());

  async function load() {
    setError('');
    try { const r = await api.inbound(); setRows(r.boxes || []); }
    catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
  }
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const counts = countStates(rows || []);
  const shipments = groupShipments(rows || []);
  // A shipment whose every box has landed is done watching, and there are far more of
  // those than of the ones that matter. Hidden by default rather than dropped: "where
  // did the order I received this morning go" is a fair question.
  const done = (s) => s.boxes.every((b) => b.state === 'delivered');
  const visible = shipments.filter((s) => (filter ? s.state === filter : (showDone || !done(s))));
  const attention = shipments.filter((s) => needsAttention(s.state)).length;

  const flip = (setter) => (id) => setter((o) => {
    const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n;
  });
  const toggle = flip(setOpen);
  const toggleDone = flip(setOpenDone);
  // A shipment with NOTHING but delivered boxes still has to show them, or opening it
  // shows an empty panel and reads as a bug.
  const boxesFor = (s, withDone) => {
    const live = s.boxes.filter((b) => b.state !== 'delivered');
    return withDone || !live.length ? s.boxes : live;
  };

  return (
    <div className="page">
      <TopBar title="Inbound" onHome={onHome} onSignOut={onSignOut} />

      <div className="card">
        <div className="step-head">
          <h3 className="rows-title">
            Today’s inbound
            {rows && <span className="muted"> ({plural(shipments.length, 'shipment')})</span>}
          </h3>
          <button className="btn ghost sm" onClick={load} disabled={!rows}><Icon name="refresh" /> Refresh</button>
        </div>
        <p className="muted sm">
          Every box on an order that hasn’t been reconciled yet, with the carrier’s last word on it.
          {' '}Nothing is fetched from the courier here — this is what the tracking feed has already told us.
        </p>

        {/* Worst first, and each count is a filter: the number you are alarmed by is
            the one you want to click. */}
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
        </div>

        {attention > 0 && !filter && (
          <p className="inbound-lede">
            <b>{plural(attention, 'shipment')}</b> {attention === 1 ? 'needs' : 'need'} somebody to look at {attention === 1 ? 'it' : 'them'}.
          </p>
        )}
      </div>

      {error && <div className="error mt">{error}</div>}
      {!rows && !error && <p className="muted mt">Loading…</p>}

      {rows && (
        <div className="card">
          <div className="step-head">
            <h3 className="rows-title">
              {filter ? INBOUND_STATES[filter].label : 'Still open'}
              <span className="muted"> ({visible.length})</span>
            </h3>
            {!filter && (
              <label className="inbound-toggle">
                <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} />
                Show fully delivered
              </label>
            )}
          </div>
          {!visible.length ? (
            <p className="muted">{filter ? 'Nothing in that state.' : 'Everything open has landed. Toggle above to see it.'}</p>
          ) : visible.map((s) => {
            const isOpen = open.has(s.poId);
            // Only meaningful once something has been counted in — before that,
            // "outstanding 169" is just the order restating itself.
            const short = s.outstanding != null && s.outstanding > 0;
            const over = s.outstanding != null && s.outstanding < 0;
            return (
              <div className={`inbound-ship ${INBOUND_STATES[s.state].tone}`} key={s.poId}>
                <button className="inbound-head" onClick={() => toggle(s.poId)}>
                  <span className="inbound-caret">{isOpen ? '▾' : '▸'}</span>
                  <span className={`inbound-chip ${INBOUND_STATES[s.state].tone}`}>{INBOUND_STATES[s.state].label}</span>
                  <span className="inbound-supplier">{s.supplier || 'Unknown supplier'}</span>
                  <span className="muted sm inbound-po">{s.poCode || `PO ${s.poId}`}</span>
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
                    {boxesFor(s, openDone.has(s.poId)).map((b) => (
                      <div className="inbound-box" key={b.box_id}>
                        <div className="inbound-box-line">
                          <span className={`inbound-chip sm ${INBOUND_STATES[b.state].tone}`}>{INBOUND_STATES[b.state].label}</span>
                          <span className="box-num">Box {b.box_number ?? '—'}</span>
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
                    ))}
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
