// Line icons for the Home navigation cards (replaces emoji). currentColor stroke,
// Feather/Lucide-style. Keyed by the home-card key. ~22px inside the icon tile.
import React from 'react';

const base = {
  width: '100%', height: '100%', viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
};

const PATHS = {
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
  // Report — bar chart
  report: (<>
    <path d="M3 20h18" />
    <path d="M6 20v-6M12 20V8M18 20v-9" />
  </>),
};

export function NavIcon({ name, ...props }) {
  return <svg {...base} {...props} aria-hidden="true">{PATHS[name] || PATHS.inventory}</svg>;
}
