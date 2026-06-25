// Shoe-angle line icons for the listing-photo slots (Feature 5). White line-art
// sneakers (currentColor stroke, no fill) for the five capture angles:
// side · diagonal pair · outsole · top-down · rear/heel. A single clean side
// glyph is reused (scaled) for Side and the Diagonal pair so the set stays
// visually consistent.
import React from 'react';

const base = {
  width: '100%', height: '100%', viewBox: '0 0 48 48', fill: 'none',
  stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
};

// One side-profile sneaker (upper · sole · laces · heel collar).
function ShoeGlyph() {
  return (
    <g>
      <path d="M6 28.5c0-3 2.4-4.6 5.3-5.3l6.4-1.5 5.2-5.8c1.8-2 4.9-2.1 6.8-.1l3.7 4.1c.7.8 1.7 1.3 2.7 1.5l3.3.6c2.5.5 4.3 2.6 4.4 5.1" />
      <path d="M5 28.5h37c1.3 0 2.4 1 2.5 2.3.1 2.2-1.7 4.1-3.9 4.1H10.5C7.5 34.9 5 32.5 5 29.5z" />
      <path d="M19.5 22.2l2.4 3.4M23.4 19.8l2.7 3.8M27.6 18.9l2.5 3.6" />
      <path d="M11.3 23.2c-.6-2.3-.2-3.9 1.2-4.6" />
    </g>
  );
}

function Side(props) {
  return <svg {...base} {...props} aria-hidden="true"><ShoeGlyph /></svg>;
}

function Diagonal(props) {
  return (
    <svg {...base} {...props} aria-hidden="true">
      <g transform="translate(12.5,2.5) scale(0.58)"><ShoeGlyph /></g>
      <g transform="translate(1,16.5) scale(0.58)"><ShoeGlyph /></g>
    </svg>
  );
}

// Outsole — bottom of the shoe with a waisted sole and tread lines.
function Outsole(props) {
  return (
    <svg {...base} {...props} aria-hidden="true">
      <path d="M24 3.5c5.2 0 8.4 3.6 8.9 9 .3 3.6-.5 6.3-.7 9.4-.1 1.6-.1 2.6 0 4.2.2 3.1.9 5.7.5 9-.5 4-3.6 5.9-8.7 5.9s-8.2-1.9-8.7-5.9c-.4-3.3.3-5.9.5-9 .1-1.6.1-2.6 0-4.2-.2-3.1-1-5.8-.7-9.4.5-5.4 3.7-9 8.9-9z" />
      <path d="M24 8.5v31" />
      <path d="M16.5 13.5h15M15.5 19h17M15.5 25.5h17M16.5 32h15" />
    </svg>
  );
}

// Top-down — the opening, collar and laces seen from straight above.
function TopView(props) {
  return (
    <svg {...base} {...props} aria-hidden="true">
      <path d="M24 3.5c5.2 0 8.4 3.6 8.9 9 .3 3.6-.5 6.3-.7 9.4-.1 1.6-.1 2.6 0 4.2.2 3.1.9 5.7.5 9-.5 4-3.6 5.9-8.7 5.9s-8.2-1.9-8.7-5.9c-.4-3.3.3-5.9.5-9 .1-1.6.1-2.6 0-4.2-.2-3.1-1-5.8-.7-9.4.5-5.4 3.7-9 8.9-9z" />
      <path d="M19 11.5c1.4-1.4 8.6-1.4 10 0v9c0 3-2 5-5 5s-5-2-5-5z" />
      <path d="M20.5 14h7M20.5 17.5h7M20.5 21h7" />
    </svg>
  );
}

// Rear / heel — heel counter, collar curve and heel tab.
function Rear(props) {
  return (
    <svg {...base} {...props} aria-hidden="true">
      <path d="M11 38V25c0-7.7 5.4-13 13-13s13 5.3 13 13v13" />
      <path d="M8.5 38h31" />
      <path d="M16.5 17.5c2.4-3.2 14.6-3.2 17 0" />
      <path d="M24 12.5v9.5" />
      <path d="M22 12.2h4l-.5 2.4h-3z" />
    </svg>
  );
}

// angle key -> { label, Icon } in capture order.
export const SHOE_ANGLES = [
  ['side', 'Side', Side],
  ['diagonal', 'Diagonal', Diagonal],
  ['outsole', 'Outsole', Outsole],
  ['top', 'Top', TopView],
  ['rear', 'Rear', Rear],
];

export function ShoeAngleIcon({ angle, ...props }) {
  const found = SHOE_ANGLES.find(([key]) => key === angle);
  const Icon = found?.[2] || Side;
  return <Icon {...props} />;
}
