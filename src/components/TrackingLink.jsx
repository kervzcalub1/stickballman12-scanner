// A tracking number that opens the COURIER'S own tracking page (UPS, FedEx, USPS…) with
// the number filled in — the live answer, where our 17TRACK copy can lag behind.
// Never put this inside a <button>: an anchor in a button is invalid and the click
// would open the row instead.
import React from 'react';
import { courierTrackLink } from '../lib/carriers.js';

export function TrackingLink({ number, carrier, className = '', children }) {
  const link = courierTrackLink(number, carrier);
  if (!link) return children ?? null;
  return (
    <a className={`trk-link ${className}`.trim()} href={link.url} target="_blank" rel="noopener noreferrer"
      title={`Open on ${link.name} — the courier's live status`} onClick={(e) => e.stopPropagation()}>
      {children ?? String(number).trim()}<span className="trk-link-via" aria-hidden="true"> ↗</span>
    </a>
  );
}
