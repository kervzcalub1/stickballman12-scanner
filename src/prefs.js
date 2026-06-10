// User preferences persisted in localStorage (survives reloads & sessions).
// Keep this small and JSON-serializable; merge with DEFAULTS on load so new
// keys added later still get a sane value for existing users.

const KEY = 'sb_prefs';

export const DEFAULTS = {
  cameraZoom: 1, // 1 = normal, 2 = zoomed in (scan from farther away)
};

export function loadPrefs() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

export function savePrefs(prefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* storage unavailable (private mode / quota) — ignore, prefs stay in-memory */
  }
}
