// The milestone bar at the top of a buying request — a courier tracking page's row of
// dots. Ten fixed stops; the ones behind are filled, the current one is lit, the rest
// wait. On a phone the labels would not fit ten across, so the dots stay and a caption
// names the stop ("Step 5 of 10 · Sorting / packing") — the dots still show how far
// along it is at a glance, which is the whole point of the shape.
import React from 'react';
import { MILESTONES, milestoneFor } from '../lib/buycartMilestones.js';

export function BuyCartProgress({ cart }) {
  const m = milestoneFor(cart);
  const stateOf = (i) => {
    if (m.stopped) return i < m.index ? 'done' : i === m.index ? 'stopped' : 'todo';
    if (m.complete) return 'done';
    return i < m.index ? 'done' : i === m.index ? 'active' : 'todo';
  };
  const caption = m.stopped
    ? `${m.stopped} at step ${m.index + 1} of ${MILESTONES.length} · ${m.label}`
    : m.complete
      ? `Done — all ${MILESTONES.length} steps`
      : `Step ${m.index + 1} of ${MILESTONES.length} · ${m.label}`;
  return (
    <div className={`bc-progress ${m.stopped ? 'stopped' : ''}`} aria-label={caption}>
      <ol className="bc-steps">
        {MILESTONES.map((s, i) => (
          <li key={s.key} className={`bc-step ${stateOf(i)}`} aria-current={!m.stopped && !m.complete && i === m.index ? 'step' : undefined}>
            <span className="bc-step-dot" aria-hidden="true" />
            <span className="bc-step-label">{s.label}</span>
          </li>
        ))}
      </ol>
      <p className="bc-steps-caption sm">{caption}</p>
    </div>
  );
}
