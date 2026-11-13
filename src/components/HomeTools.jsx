// Tool cards on the staff + PH homes (Home.jsx, PHTeam.jsx), and the "Show descriptions"
// switch above them.
//
// 2026-11-13 the homes went title-only (owner: "hard to look at"). 2026-11-14 the owner
// wanted each card's sentence back WITHOUT losing the clean look, so it lives in two places:
//   - hover (mouse) or keyboard focus → the card stretches down and shows it under the
//     title, lying over the cards below so nothing moves. Phones have no hover, which is
//     what the switch is for;
//   - the switch → every card shows its sentence in full, inline. Remembered per browser.
// The supplier home and the No Box hub share the card classes but not this component.
import React, { useCallback, useState } from 'react';
import { CardBadges } from './common.jsx';
import { NavIcon } from './NavIcons.jsx';

const KEY = 'sbm.home.descriptions';

// Per-viewer convenience only, so storage that throws (private mode, blocked site data)
// just means the switch starts off.
export function useHomeDescriptions() {
  const [on, setOn] = useState(() => {
    try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
  });
  const set = useCallback((v) => {
    setOn(v);
    try { localStorage.setItem(KEY, v ? '1' : '0'); } catch { /* not remembered, still works */ }
  }, []);
  return [on, set];
}

export function HomeDescToggle({ on, onChange }) {
  return (
    <div className="home-desc-bar">
      <label className="home-desc-toggle">
        <span>Show descriptions</span>
        <button type="button" role="switch" aria-checked={on} aria-label="Show descriptions"
          className={`al-switch${on ? ' on' : ''}`} onClick={() => onChange(!on)}>
          <span className="al-knob" aria-hidden="true" />
        </button>
      </label>
    </div>
  );
}

// One tool card. Three ways to its sentence:
//   - `.home-card-sub`: inline, shown with the switch on (and inside a card opened by ⓘ);
//   - `.home-card-tip`: the hover stretch on desktop — drawn as the card's lower half, a
//     SIBLING of the button because the card clips its own overflow (the accent rail);
//   - `.home-card-info`: the ⓘ, phones / no-hover devices only (CSS). It opens THIS card's
//     sentence inside the card; the card's own tap still navigates. Also a sibling — a
//     button can't nest in a button. Picked 11-14 by a desktop + a phone design review over
//     a floating popup and a hover that grows the whole row (it moved the page up to 71px).
export function HomeToolCard({ icon, title, sub, badges, onClick }) {
  const info = !!sub;
  const [open, setOpen] = useState(false);
  return (
    <div className={`home-card-wrap${info ? ' has-info' : ''}${open ? ' info-open' : ''}`}>
      <button type="button" className="home-card" onClick={onClick} aria-description={sub}>
        <span className="home-card-icon"><NavIcon name={icon} /></span>
        <span className="home-card-text">
          <span className="home-card-title">{title}</span>
          <span className="home-card-sub">{sub}</span>
          <CardBadges badges={badges} />
        </span>
      </button>
      {info && (
        // A SIBLING of the card button (a button can't nest in a button). The 44px box is the
        // tap target; the glyph inside is small so the card stays clean.
        <button type="button" className="home-card-info" aria-expanded={open}
          aria-label={`${open ? 'Hide' : 'Show'} what ${title} does`} onClick={() => setOpen((v) => !v)}>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="9.5" /><path d="M12 11v5.5" /><circle cx="12" cy="7.6" r="0.6" fill="currentColor" />
          </svg>
        </button>
      )}
      {sub && <span className="home-card-tip" aria-hidden="true">{sub}</span>}
    </div>
  );
}
