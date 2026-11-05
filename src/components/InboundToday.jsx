// "What should we expect today" — the one line of the Inbound feed that belongs on Home.
//
// Home is a CHORE LIST: things somebody must go and do. Inbound is a feed of things
// happening to us, which is why it is its own screen rather than a section here. But the
// first question of the morning — how many boxes are landing, and is anything overdue —
// is not a feed, it is a fact, and a fact nobody sees because it is one tap away might as
// well not be recorded.
//
// So this is deliberately NOT the dashboard. It is the headline and the bar, and it opens
// the real screen. Putting the day strip, the state strip and the shipment list here would
// turn the chore list into a second Inbound page and bury the chores.
//
// The numbers come from the same functions the Inbound screen uses (`src/lib/inbound.js`),
// because two places that count the same boxes differently is worse than one place that
// counts them at all.
import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useLive } from '../hooks.js';
import { arrivalPlan, inboundProgress } from '../lib/inbound.js';
import { expectedDashboard } from '../lib/expected.js';
import { estToday } from '../lib/format.js';

const plural = (n, s) => `${n} ${n === 1 ? s : `${s}es`}`;

export function InboundToday({ onOpen }) {
  const [rows, setRows] = useState(null);
  const [expected, setExpected] = useState(null);

  useEffect(() => {
    api.expected().then((r) => setExpected(r)).catch(() => {});
    let on = true;
    // Silent on failure. A warehouse hand's home screen must not show an error because a
    // summary could not load — the chores below it are the point, and this is context.
    api.inbound().then((r) => { if (on) setRows(r.boxes || []); }).catch(() => {});
    return () => { on = false; };
  }, []);
  // Live (docs/context/live-updates.md): a box shipping, a tracking status landing or a
  // box being received moves the headline and the bar without a reload. `items` changes
  // on every scan, so this re-reads at most every 5s while the floor is busy.
  useLive(['purchase_orders', 'po_boxes', 'po_lines', 'batches', 'items', 'online_orders', 'online_order_lines', 'shipment_tracking'], async () => {
    const r = await api.inbound();
    const next = r.boxes || [];
    setRows((cur) => (JSON.stringify(cur) === JSON.stringify(next) ? cur : next));
    setExpected(await api.expected());
  }, { mount: false, minGap: 5000 });

  // Nothing to say until it has loaded, and nothing to say when every order is
  // reconciled. A card reading "0 boxes" every day is a card people stop seeing.
  const online = expected ? expectedDashboard(expected, estToday()).stores.total : null;
  if (!rows || (!rows.length && !online?.today?.count && !online?.week?.count)) return null;

  const today = estToday();
  const plan = arrivalPlan(rows, today);
  const progress = inboundProgress(rows);
  const due = plan.today;
  const overdue = plan.overdue;

  return (
    <section className="home-section" data-accent="attention">
      <h2 className="home-section-title">Expected today</h2>
      <button type="button" className="inb-today" onClick={onOpen}>
        <span className="inb-today-line">
          {due.boxes === 0 ? (
            <span className="muted">Nothing is due on the floor today.</span>
          ) : (
            <>
              <b className="inb-today-n">{due.boxes}</b>
              <span> {due.boxes === 1 ? 'box' : 'boxes'} from {plural(due.shipments, 'shipment')}</span>
              {/* Pairs are what cost time — twelve boxes of two is a quiet morning and
                  two boxes of a hundred and sixty is not. */}
              {due.units > 0 && <span> · <b>{due.units}</b> pairs</span>}
            </>
          )}
          {online?.today?.count > 0 && (
            <span> · <b>{online.today.count}</b> online {online.today.count === 1 ? 'parcel' : 'parcels'}</span>
          )}
          {overdue.boxes > 0 && (
            <span className="inb-today-overdue"> · {plural(overdue.boxes, 'box')} overdue</span>
          )}
        </span>

        <span className="inb-progress" role="img"
          aria-label={`${progress.landed} of ${progress.total} inbound boxes have landed`}>
          <span className="inb-progress-fill" style={{ width: `${progress.pct}%` }} />
        </span>

        <span className="inb-today-foot muted sm">
          {progress.landed} of {progress.total} inbound boxes landed ({progress.pct}%) · see the whole week →
        </span>
      </button>
    </section>
  );
}
