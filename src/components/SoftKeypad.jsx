// An on-screen keypad the APP draws, for the day a Bluetooth scanner is paired to the
// phone.
//
// iOS treats a paired Bluetooth scanner as a hardware keyboard and hides the software
// keyboard for EVERY field — there is no web API that brings it back. The floor's
// workaround was to type on a second phone and paste. This keypad does not depend on
// iOS at all: tap a field (focus still works with a scanner paired — only the keyboard
// is suppressed), tap the ⌨ button, and the keys type into whichever input was focused
// last. Values go in through the element's native setter + an `input` event, so React
// state updates exactly as if the keys had been pressed. Enter submits the field's form.
//
// It is a keypad, not a keyboard: capitals, digits, the characters that appear in a
// SKU / UPC / tracking number / size, and space. That covers every field on Receiving.
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { loadPrefs } from '../prefs.js';

const ROWS = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
  ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'],
  ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L', '-'],
  ['Z', 'X', 'C', 'V', 'B', 'N', 'M', '.', '/', '⌫'],
];

const TYPABLE = (el) => !!el && (
  (el.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit', 'file', 'date', 'range', 'color'].includes(el.type))
  || el.tagName === 'TEXTAREA'
) && !el.disabled && !el.readOnly;

// Set the value the way a keypress would, so React's onChange sees it.
function typeInto(el, next) {
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, next); else el.value = next;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

// A hardware keyboard (which is what a paired scanner IS, to the OS) only ever shows up
// on a touch device. On a desktop the real keyboard is right there.
export const isTouchDevice = () => typeof window !== 'undefined' && ('ontouchstart' in window || (navigator.maxTouchPoints || 0) > 0);

export function SoftKeypad() {
  // Off by preference (Preferences → On-screen keypad); `sb-prefs` is fired by the
  // toggle so the button goes away at once rather than on the next navigation.
  const [enabled, setEnabled] = useState(() => loadPrefs().softKeypad !== false);
  useEffect(() => {
    const onPrefs = () => setEnabled(loadPrefs().softKeypad !== false);
    window.addEventListener('sb-prefs', onPrefs);
    return () => window.removeEventListener('sb-prefs', onPrefs);
  }, []);
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState(null);   // the input the keys go into
  const [label, setLabel] = useState('');
  const panelRef = useRef(null);

  // Remember the last typable field the person tapped. `focusin` bubbles; `focus` doesn't.
  useEffect(() => {
    if (!enabled) return undefined;
    const onFocus = (e) => {
      const el = e.target;
      if (!TYPABLE(el)) return;
      if (panelRef.current && panelRef.current.contains(el)) return;
      setTarget(el);
      setLabel(el.getAttribute('aria-label') || el.placeholder || el.closest('label')?.textContent?.trim().split('\n')[0] || '');
      // Bring the field up above the sheet — a focused field under the keys can't be read.
      if (panelRef.current) setTimeout(() => el.scrollIntoView?.({ block: 'center', behavior: 'smooth' }), 0);
    };
    document.addEventListener('focusin', onFocus);
    return () => document.removeEventListener('focusin', onFocus);
  }, [enabled]);

  // While the sheet is open the page gets that much bottom padding, so the field under
  // it can still be scrolled into view (and the browser's own scroll-into-view on focus
  // has somewhere to put it). Removed on close.
  useEffect(() => {
    if (!open) return undefined;
    const apply = () => { document.body.style.paddingBottom = `${(panelRef.current?.offsetHeight || 0) + 8}px`; };
    apply();
    document.body.classList.add('keypad-open');
    window.addEventListener('resize', apply);
    return () => { window.removeEventListener('resize', apply); document.body.style.paddingBottom = ''; document.body.classList.remove('keypad-open'); };
  }, [open]);

  // A target that has left the page (a modal closed, a step changed) is no target.
  useEffect(() => {
    if (!open || !target) return undefined;
    const t = setInterval(() => { if (!document.contains(target)) setTarget(null); }, 500);
    return () => clearInterval(t);
  }, [open, target]);

  if (!enabled) return null;

  const live = target && document.contains(target) ? target : null;
  const press = (key) => {
    if (!live) return;
    const cur = String(live.value ?? '');
    if (key === '⌫') typeInto(live, cur.slice(0, -1));
    else if (key === 'Enter') {
      // The same thing the gun does at the end of a code: a keydown Enter for handlers
      // listening for it, then the form's submit for the rest.
      live.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
      const form = live.form || live.closest('form');
      if (form) form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    } else if (key === 'Clear') typeInto(live, '');
    else typeInto(live, cur + key);
    // Keep the field the active element so the next tap on a key still lands here.
    try { live.focus({ preventScroll: true }); } catch { /* ignore */ }
  };
  // Buttons must not steal focus from the field — the mousedown default would. Only
  // mousedown: cancelling touchstart would cancel the tap's click with it.
  const keep = (e) => e.preventDefault();

  return createPortal(
    <>
      <button type="button" className={`keypad-fab${open ? ' on' : ''}`} onClick={() => setOpen((v) => !v)}
        title={open ? 'Hide the on-screen keypad' : 'On-screen keypad — for when a Bluetooth scanner hides the phone’s keyboard'}
        aria-label="On-screen keypad" aria-pressed={open}>⌨</button>
      {open && (
        <div className="keypad" ref={panelRef} role="group" aria-label="On-screen keypad" onMouseDown={keep}>
          <div className="keypad-head">
            <span className="keypad-target">
              {live ? <>Typing into <b>{label || 'the selected field'}</b></> : <span className="muted">Tap a field first, then type here.</span>}
            </span>
            <button type="button" className="btn xs ghost" onClick={() => setOpen(false)}>Hide</button>
          </div>
          {ROWS.map((row, i) => (
            <div className="keypad-row" key={i}>
              {row.map((k) => (
                <button type="button" key={k} className="keypad-key" disabled={!live}
                  onClick={() => press(k)} aria-label={k === '⌫' ? 'Backspace' : k}>{k}</button>
              ))}
            </div>
          ))}
          <div className="keypad-row">
            <button type="button" className="keypad-key" disabled={!live} onClick={() => press('Clear')}>Clear</button>
            <button type="button" className="keypad-key space" disabled={!live} onClick={() => press(' ')} aria-label="Space">space</button>
            <button type="button" className="keypad-key enter" disabled={!live} onClick={() => press('Enter')}>Enter</button>
          </div>
        </div>
      )}
    </>,
    document.body,
  );
}
