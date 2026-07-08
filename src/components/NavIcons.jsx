// Line icons for the Home navigation cards (replaces emoji). currentColor stroke,
// Feather/Lucide-style. Keyed by the home-card key. ~22px inside the icon tile.
import React from 'react';

const base = {
  width: '100%', height: '100%', viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
};

const PATHS = {
  // Reconcile — clipboard with a check
  reconcile: (<>
    <rect x="5" y="4" width="14" height="17" rx="2" />
    <path d="M9 4V3h6v1" />
    <path d="M8.5 13l2.5 2.5L16 10" />
  </>),
  // Check Access — a key
  access: (<>
    <circle cx="8" cy="16" r="5" />
    <path d="M11.5 12.5 20 4" />
    <path d="M16 8l2.5 2.5M18 6l2.5 2.5" />
  </>),
  // Receive New — download into a tray
  receiving: (<>
    <path d="M3 15v3a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3" />
    <path d="M12 3v9M8 9l4 4 4-4" />
  </>),
  // Batches — archive box
  batches: (<>
    <rect x="3" y="4" width="18" height="4" rx="1" />
    <path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8" />
    <path d="M10 12h4" />
  </>),
  // Rescale Stock — refresh
  rescale: (<>
    <path d="M21 12a9 9 0 1 1-2.64-6.36" />
    <path d="M21 4v5h-5" />
  </>),
  // Rescale Requests — envelope
  rescalereq: (<>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M3.5 7l8.5 6 8.5-6" />
  </>),
  // No Box — package with a slash
  nobox: (<>
    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
    <path d="M3.3 7 12 12l8.7-5M12 12v9" />
    <path d="M5 4.5l14 15" />
  </>),
  // Mark Sold — dollar in a circle
  sold: (<>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v10" />
    <path d="M14.8 9.2A3 3 0 0 0 12 8c-1.7 0-3 1-3 2.2 0 1.3 1.3 1.8 3 1.8s3 .6 3 1.9S13.7 16 12 16a3 3 0 0 1-2.8-1.2" />
  </>),
  // Mark Shipped — truck
  shipped: (<>
    <rect x="2.5" y="6.5" width="11" height="9" rx="1" />
    <path d="M13.5 9.5H17l3.5 3.5v2.5h-7z" />
    <circle cx="6.5" cy="17.5" r="1.8" />
    <circle cx="16.5" cy="17.5" r="1.8" />
  </>),
  // Inventory — search
  inventory: (<>
    <circle cx="11" cy="11" r="7" />
    <path d="M21 21l-4.3-4.3" />
  </>),
  // Locations — map pin (where a unit lives)
  locations: (<>
    <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z" />
    <circle cx="12" cy="10" r="3" />
  </>),
  // Shelve / Put-away — a shelving rack (the destination shelf)
  shelve: (<>
    <rect x="3" y="3.5" width="18" height="17" rx="1.5" />
    <path d="M3 9.5h18M3 15h18" />
    <path d="M7 20.5v1.5M17 20.5v1.5" />
  </>),
  // Report — bar chart
  report: (<>
    <path d="M3 20h18" />
    <path d="M6 20v-6M12 20V8M18 20v-9" />
  </>),
  // In-Store Listing — a price tag with a check
  'instore-listing': (<>
    <path d="M3 11.5V4a1 1 0 0 1 1-1h7.5a1 1 0 0 1 .7.3l8.5 8.5a1 1 0 0 1 0 1.4l-7 7a1 1 0 0 1-1.4 0l-8.5-8.5a1 1 0 0 1-.3-.7z" />
    <circle cx="7.5" cy="7.5" r="1.2" />
    <path d="M10.5 13.5l2 2 4-4" />
  </>),
  // In-Store Buying — a shopping bag
  instore: (<>
    <path d="M6 8h12l1 12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1z" />
    <path d="M9 8V6a3 3 0 0 1 6 0v2" />
  </>),
  // PH Team Workspace — a receipt / document
  ph: (<>
    <path d="M6 3h9l3 3v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
    <path d="M8 9h6M8 13h8M8 17h5" />
  </>),
  // Settings — a gear
  settings: (<>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1l2.1-2.1M17 7l2.1-2.1" />
  </>),
};

export function NavIcon({ name, ...props }) {
  return <svg {...base} {...props} aria-hidden="true">{PATHS[name] || PATHS.inventory}</svg>;
}

// Inline icons used inside buttons / text in place of emoji. Sized in `em` so
// they scale with the surrounding text and sit on the baseline like a glyph.
const INLINE = {
  camera: (<>
    <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
    <circle cx="12" cy="13" r="3.4" />
  </>),
  print: (<>
    <path d="M6 9V3h12v6" />
    <path d="M6 18H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2" />
    <rect x="6" y="14" width="12" height="7" rx="1" />
  </>),
  image: (<>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="8.5" cy="8.5" r="1.5" />
    <path d="M21 15l-5-5L5 21" />
  </>),
  tag: (<>
    <path d="M3 11.5V4a1 1 0 0 1 1-1h7.5a1 1 0 0 1 .7.3l8.5 8.5a1 1 0 0 1 0 1.4l-7 7a1 1 0 0 1-1.4 0l-8.5-8.5a1 1 0 0 1-.3-.7z" />
    <circle cx="7.5" cy="7.5" r="1.2" />
  </>),
  gear: (<>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" />
  </>),
  box: (<>
    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
    <path d="M3.3 7 12 12l8.7-5M12 12v9" />
  </>),
  nobox: PATHS.nobox,
  pin: (<>
    <path d="M12 2a7 7 0 0 1 7 7c0 5.25-7 13-7 13S5 14.25 5 9a7 7 0 0 1 7-7z" />
    <circle cx="12" cy="9" r="2.5" />
  </>),
  // refresh-cw — two curved arrows, clearly a "refresh/re-fetch"
  refresh: (<>
    <path d="M21 2v6h-6" />
    <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
    <path d="M3 22v-6h6" />
    <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
  </>),
  download: (<>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="M12 3v12M7 10l5 5 5-5" />
  </>),
  eye: (<>
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
    <circle cx="12" cy="12" r="3" />
  </>),
  'eye-off': (<>
    <path d="M9.9 4.24A9.1 9.1 0 0 1 12 4c6.5 0 10 7 10 7a13.2 13.2 0 0 1-2.16 3.19M6.6 6.6A13.3 13.3 0 0 0 2 11s3.5 7 10 7a9.1 9.1 0 0 0 4.24-1.06" />
    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    <path d="M2 2l20 20" />
  </>),
};

export function Icon({ name, size = '1.05em', ...props }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      style={{ width: size, height: size, verticalAlign: '-0.15em', flex: 'none' }} {...props}>
      {INLINE[name] || INLINE.box}
    </svg>
  );
}
