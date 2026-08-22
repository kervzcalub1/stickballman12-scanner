// What the advisor can see about the screen you're standing on.
//
// A module-level slot rather than React context, on purpose: the advisor is mounted
// once beside the router (App.jsx) while the thing it needs to know about is whatever
// screen is rendered *inside* it. A provider would mean wrapping every screen; this
// means a screen opts in with one hook and everything else keeps working.
//
// Screens publish plain, already-formatted values — the server turns this into prose
// for the prompt, so `finalCost: 83.16` is useful and a React element is not.
import { useEffect } from 'react';

let current = {};

export function setAdvisorContext(next) {
  current = next && typeof next === 'object' ? next : {};
}

export function getAdvisorContext() {
  return current;
}

/**
 * Publish this screen's context for as long as it's mounted, and clear it on the way
 * out — a stale context is worse than none, because the advisor would answer
 * confidently about a shoe you navigated away from ten minutes ago.
 *
 * `build` is called on every change in `deps`, so pass the values that actually alter
 * what's on screen. Keep it cheap; it runs on render, not on ask.
 */
export function useAdvisorContext(build, deps = []) {
  useEffect(() => {
    setAdvisorContext(typeof build === 'function' ? build() : build);
    return () => setAdvisorContext({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
