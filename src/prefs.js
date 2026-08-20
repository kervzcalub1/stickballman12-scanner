// User preferences persisted in localStorage (survives reloads & sessions).
// Keep this small and JSON-serializable; merge with DEFAULTS on load so new
// keys added later still get a sane value for existing users.

const KEY = 'sb_prefs';

export const DEFAULTS = {
  cameraZoom: 1, // 1 = normal, 2 = zoomed in (scan from farther away)
  scanSound: true, // audible ok/error tones on the bulk scan-out screens
  // Raw 1ID mode: don't mint a VIN at intake — scan a PRE-PRINTED sticker onto each
  // pair instead. Per person, per device on purpose: someone standing at a working
  // printer and someone across the warehouse with a roll of stickers are doing the
  // same job two different ways, and neither should flip the other's screen.
  rawVins: false,
  // PDF or CSV for the PO reports (ManifestPrint). Per device: the person who files
  // signed paper and the person who works in a spreadsheet are doing the same job two
  // different ways, and neither should flip the other's default.
  reportFormat: 'pdf',
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
