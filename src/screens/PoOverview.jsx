// PH "Purchase Orders" — the list. Every PO the team opened, its status, and how far its
// labels have got. Tapping one opens it on its OWN page (`PoDetail.jsx`) rather than
// expanding it here: an order carries up to nine labels, each with a tracking history and
// a manifest, and unfolding all of that inside a list row buried the order's own details
// under the first label and made one box hard to tell from the next.
//
// The open order rides in `?po=` so a refresh (or a shared link) lands straight back on it.
// Uses /api/po/list; the page itself uses /api/po/get. See docs/context/purchase-orders.md.
import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useQueryParam } from '../lib/urlstate.js';
import { TopBar } from '../components/common.jsx';
import { Icon } from '../components/NavIcons.jsx';
import { PoStatusChip } from '../components/PoStatusChip.jsx';
import { PoDetail } from './PoDetail.jsx';

export function PoOverview({ onHome, onSignOut }) {
  const [pos, setPos] = useState(null);
  const [error, setError] = useState('');
  // Numeric id — the page re-fetches its own detail, so nothing stale is restored.
  const [openIdRaw, setOpenIdRaw] = useQueryParam('po');
  const openId = openIdRaw ? Number(openIdRaw) : null;
  const setOpenId = (v) => setOpenIdRaw(v == null ? '' : String(v));

  const loadList = () => {
    api.poList()
      .then((r) => setPos(r.pos || []))
      .catch((e) => { if (e.unauthorized) return onSignOut(); setError(e.message); });
  };
  useEffect(loadList, []); // eslint-disable-line react-hooks/exhaustive-deps

  // One order, full screen. `pos` rides along so "move this label to another order" can
  // offer the list without fetching it twice.
  if (openId != null) {
    return (
      <PoDetail
        poId={openId}
        pos={pos || []}
        onBack={() => { setOpenId(null); loadList(); }}
        onHome={onHome}
        onSignOut={onSignOut}
      />
    );
  }

  return (
    <div className="app">
      <TopBar title="Purchase Orders" onHome={onHome} onSignOut={onSignOut} />
      <div className="wrap-narrow">
        <p className="muted sm">Every batch you opened for a supplier — its status and how far its shipping labels have got. Tap one to open it.</p>
        {error && <div className="po-err">{error}</div>}
        {pos == null ? <p className="muted">Loading…</p>
          : pos.length === 0 ? <div className="card empty-state">No purchase orders yet. Open one from <b>New Batch (Purchase Order)</b>.</div>
          : (
            <div className="po-list">
              {pos.map((p) => (
                <div key={p.id} className="card po-ov">
                  <button className="po-ov-head" onClick={() => setOpenId(p.id)}>
                    <div className="po-ov-top">
                      <span className="po-code">{p.po_code}</span>
                      <PoStatusChip po={p} />
                    </div>
                    <div className="po-ov-meta muted sm">
                      {p.tag_code && <span><Icon name="tag" /> {p.tag_code}</span>}
                      <span>{p.shipped_count}/{p.box_count} label{p.box_count === 1 ? '' : 's'} shipped</span>
                      {p.delivered_count > 0 && <span>{p.delivered_count} delivered</span>}
                      {/* Two different facts, and they were being shown as one number:
                          `unit_count` is what the SUPPLIER declared, `received_units` is
                          what we counted. An order received with no manifest is legitimately
                          "0 declared", which read as "nothing here" beside a shelf full of
                          stock. */}
                      <span className={p.unit_count === 0 && p.received_units > 0 ? 'po-ov-blind' : undefined}
                        title={p.unit_count === 0 && p.received_units > 0
                          ? 'Nothing was declared for this order, so its reconciliation reads “received blind”. Add the supplier’s manifest to compare against.'
                          : undefined}>
                        {p.unit_count} declared
                      </span>
                      {p.received_units > 0 && <span>{p.received_units} received</span>}
                    </div>
                  </button>
                  <span className="po-ov-caret" aria-hidden="true">›</span>
                </div>
              ))}
            </div>
          )}
      </div>
    </div>
  );
}
