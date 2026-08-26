// PH "Purchase Orders" — the list. Every PO the team opened, its status, and how far its
// labels have got. Tapping one opens it on its OWN page (`PoDetail.jsx`) rather than
// expanding it here: an order carries up to nine labels, each with a tracking history and
// a manifest, and unfolding all of that inside a list row buried the order's own details
// under the first label and made one box hard to tell from the next.
//
// The open order rides in `?po=` so a refresh (or a shared link) lands straight back on it,
// and so do the three filters (`?supplier=`, `?from=`, `?to=`) — the list grows by a few
// orders a week, so "the ones I opened for this supplier last month" has to survive a
// refresh. Filtering is done here on the list we already hold rather than server-side:
// /api/po/list returns every order in one go, so a round trip per keystroke would buy
// nothing.
// Uses /api/po/list; the page itself uses /api/po/get. See docs/context/purchase-orders.md.
import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { estDate } from '../lib/format.js';
import { useQueryParam } from '../lib/urlstate.js';
import { poMatchesSearch } from '../lib/postatus.js';
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
  const [supplier, setSupplier] = useQueryParam('supplier');
  const [from, setFrom] = useQueryParam('from');
  const [to, setTo] = useQueryParam('to');
  // The number off the parcel. In the URL like the other filters, so a link to "the
  // order this tracking number belongs to" can be pasted to whoever is asking.
  const [q, setQ] = useQueryParam('q');
  const filtering = !!(supplier || from || to || q);
  const clearAll = () => { setSupplier(''); setFrom(''); setTo(''); setQ(''); };

  const loadList = () => {
    api.poList()
      .then((r) => setPos(r.pos || []))
      .catch((e) => { if (e.unauthorized) return onSignOut(); setError(e.message); });
  };
  useEffect(loadList, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The date a filter means: the purchase date the PH team typed on the form, and only
  // when that was left blank, the day the order was opened. `date_of_purchase` is a DATE
  // column so it already arrives as 'YYYY-MM-DD'; `created_at` is a timestamp and has to
  // be read in EST — the PH team's own clock is a day ahead and would file an order the
  // team opened on the 25th under the 26th.
  const poDate = (p) => (p.date_of_purchase ? String(p.date_of_purchase).slice(0, 10) : estDate(p.created_at));

  // Suppliers actually on the orders, not a hard-coded list. Keeps the active filter in
  // the options even if nothing matches it any more (a shared link, or a renamed
  // supplier) — otherwise the select would read "All" over a filtered list.
  const supplierNames = useMemo(() => {
    const names = [...new Set((pos || []).map((p) => p.supplier_name).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b));
    return supplier && !names.includes(supplier) ? [...names, supplier] : names;
  }, [pos, supplier]);

  const shown = useMemo(() => (pos || []).filter((p) => {
    if (!poMatchesSearch(p, q)) return false;
    if (supplier && p.supplier_name !== supplier) return false;
    // Both ends inclusive — "from the 1st to the 5th" has to include the 5th.
    const d = poDate(p);
    if (from && (!d || d < from)) return false;
    if (to && (!d || d > to)) return false;
    return true;
  }), [pos, supplier, from, to, q]);

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

        {pos != null && pos.length > 0 && (
          <>
            <div className="po-ov-filters">
              <label className="po-ov-search"><span className="muted xs">Tracking number</span>
                <input type="search" value={q} onChange={(e) => setQ(e.target.value)}
                  placeholder="Paste or scan a tracking number — or a PO code"
                  aria-label="Search by tracking number or PO code" /></label>
              <label><span className="muted xs">Supplier</span>
                <select value={supplier} onChange={(e) => setSupplier(e.target.value)}>
                  <option value="">All suppliers</option>
                  {supplierNames.map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
              <label><span className="muted xs">Purchased from</span>
                <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
              <label><span className="muted xs">to</span>
                <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
              {filtering && (
                <button className="btn sm ghost" onClick={clearAll}>Clear</button>
              )}
            </div>
            {filtering && (
              <div className="muted sm po-ov-count">
                Showing {shown.length} of {pos.length} order{pos.length === 1 ? '' : 's'}
              </div>
            )}
          </>
        )}

        {pos == null ? <p className="muted">Loading…</p>
          : pos.length === 0 ? <div className="card empty-state">No purchase orders yet. Open one from <b>New Batch (Purchase Order)</b>.</div>
          : shown.length === 0 ? (
            <div className="card empty-state">
              {q
                ? <>No order carries a tracking number or PO code matching <b>{q}</b>. A label the supplier has not created yet has no number to find.</>
                : 'No purchase order matches these filters.'}
              {' '}<button className="btn sm ghost" onClick={clearAll}>Clear filters</button>
            </div>
          )
          : (
            <div className="po-list">
              {shown.map((p) => (
                <div key={p.id} className="card po-ov">
                  <button className="po-ov-head" onClick={() => setOpenId(p.id)}>
                    <div className="po-ov-top">
                      <span className="po-code">{p.po_code}</span>
                      <PoStatusChip po={p} />
                    </div>
                    <div className="po-ov-meta muted sm">
                      {/* Supplier and date are what the filters above sort on — a row has to
                          show the fact it was matched by, or a filtered list looks arbitrary. */}
                      <span>{p.supplier_name}</span>
                      <span>{poDate(p)}</span>
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
