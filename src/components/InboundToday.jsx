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
import { arrivalPlan, inboundProgress } from '../lib/inbound.js';
import { estToday } from '../lib/format.js';

const plural = (n, s) => `${n} ${n === 1 ? s : `${s}es`}`;

export function InboundToday({ onOpen }) {
  const [rows, setRows] = useState(null);

  useEffect(() => {
    let on = true;
    // Silent on failure. A warehouse hand's home screen must not show an error because a
    // summary could not load — the chores below it are the point, and this is context.
    api.inbound().then((r) => { if (on) setRows(r.boxes || []); }).catch(() => {});
    return () => { on = false; };
  }, []);

  // Nothing to say until it has loaded, and nothing to say when every order is
  // reconciled. A card reading "0 boxes" every day is a card people stop seeing.
  if (!rows || !rows.length) return null;

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
          {overdue.boxes > 0 && (
            <span className="inb-today-overdue"> · {plural(overdue.boxes, 'box')} overdue</span>
          )}
        </span>

        <span className="inb-progress" role="img"
          aria-label={`${progress.landed} of ${progress.total} inbound boxes have landed`}>
          <span className="inb-progress-fill" style={{ width: `${progress.pct}%` }} />
        </span>

        <span className="inb-today-foot muted sm">
          {progress.landed} of {progress.total} inbound boxes landed ({progress.pct}%) · open Inbound →
        </span>
      </button>
    </section>
  );
}
