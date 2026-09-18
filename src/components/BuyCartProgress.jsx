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
  // On a phone the labels are hidden and this line is all the words there are, so it
  // names the last stop that is BEHIND as well as the one it is on — "Approved ✓ · Step 3
  // of 10 · Waiting for gift card" — otherwise a buyer never sees the completed wording.
  const behind = !m.stopped && !m.complete && m.index > 0 ? `${MILESTONES[m.index - 1].done} \u2713 · ` : '';
  const caption = m.stopped
    ? `${m.stopped} at step ${m.index + 1} of ${MILESTONES.length} · ${m.label}`
    : m.complete
      ? `Done — all ${MILESTONES.length} steps`
      : `${behind}Step ${m.index + 1} of ${MILESTONES.length} · ${m.label}`;
  return (
    <div className={`bc-progress ${m.stopped ? 'stopped' : ''}`} aria-label={caption}>
      <ol className="bc-steps">
        {MILESTONES.map((s, i) => {
          const state = stateOf(i);
          return (
            <li key={s.key} className={`bc-step ${state}`} aria-current={!m.stopped && !m.complete && i === m.index ? 'step' : undefined}>
              <span className="bc-step-dot" aria-hidden="true" />
              {/* A stop that is behind reads as what happened ("Approved"), not as what
                  it was waiting for — the dot says done, so the words must too. */}
              <span className="bc-step-label">{state === 'done' ? s.done : s.label}</span>
            </li>
          );
        })}
      </ol>
      <p className="bc-steps-caption sm">{caption}</p>
    </div>
  );
}
