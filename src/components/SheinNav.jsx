// Small pieces shared by the sections of the one SHEIN page (src/screens/Shein.jsx): moving between
// sections without a reload, the "Advanced" area that remembers it is open in the URL, and the
// "How this works" toggle that holds the detail a screen's one short sentence leaves out.
import React, { createContext, useContext } from 'react';
import { useQueryParam } from '../lib/urlstate.js';
import { TERMS } from '../lib/sheinWords.js';

export const SheinNavContext = createContext(() => {});
// go('check', { chk: 'match' }): show that section, optionally opening it in a given state.
export const useSheinNav = () => useContext(SheinNavContext);

// A closed-by-default area. Its children stay in the page (a half-filled form survives closing it);
// `param` puts the open state in the URL, so a refresh or a shared link comes back open. `force` keeps
// it open while something inside needs to be seen, such as a running check.
export function SheinAdvanced({ param, label = TERMS.advanced, hint, force = false, children, className = '' }) {
  const [v, setV] = useQueryParam(param, '');
  const open = force || v === '1';
  return (
    <details className={`shein-adv ${className}`.trim()} open={open} data-adv={param}
      onToggle={(e) => { if (e.currentTarget.open !== open) setV(e.currentTarget.open ? '1' : ''); }}>
      <summary><span className="shein-adv-label">{label}</span>{hint && <span className="muted xs shein-adv-hint">{hint}</span>}</summary>
      <div className="shein-adv-body">{children}</div>
    </details>
  );
}

export function HowItWorks({ children, label = TERMS.how }) {
  return (
    <details className="shein-how">
      <summary>{label}</summary>
      <div className="shein-how-body">{children}</div>
    </details>
  );
}
