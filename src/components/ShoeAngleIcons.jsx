// Shoe-angle line icons for the listing-photo slots (Feature 5). White line-art
// sneakers (currentColor stroke, no fill) matching the five capture angles:
// side · diagonal pair · outsole · top-down · rear/heel. Stylized but distinct.
import React from 'react';

const base = {
  width: '100%', height: '100%', viewBox: '0 0 48 48', fill: 'none',
  stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round',
};

// Side profile — a low-top sneaker seen from the side.
function Side(props) {
  return (
    <svg {...base} {...props} aria-hidden="true">
      <path d="M3 31c0-2.4 1.8-3.6 4-4.4l8-2.8 6.4-6.6c2-2 5-2 6.9.1l4.6 5.2c3 1 6.4 1.6 8.1 4.6" />
      <path d="M3 31h39c1.1 0 2 .9 2 2v1c0 1.1-.9 2-2 2H7c-2.2 0-4-1.8-4-4z" />
      <path d="M18 20.5l3 4M22.5 18l3.2 4.2M27 17.5l3 4" />
    </svg>
  );
}

// Diagonal — a pair, one shoe behind and one in front at an angle.
function Diagonal(props) {
  return (
    <svg {...base} {...props} aria-hidden="true">
      <path d="M6 22c0-1.8 1.4-2.7 3-3.3l5.6-2 4.5-4.6c1.4-1.4 3.5-1.4 4.8.1l3.2 3.6c2.1.7 4.5 1.1 5.7 3.2" />
      <path d="M6 22h26c.9 0 1.6.7 1.6 1.6v.8c0 .9-.7 1.6-1.6 1.6H9c-1.7 0-3-1.3-3-3z" />
      <path d="M16 32c0-1.8 1.4-2.7 3-3.3l5.6-2 4.5-4.6c1.4-1.4 3.5-1.4 4.8.1l3.2 3.6c2.1.7 4.5 1.1 5.7 3.2" />
      <path d="M16 32h26c.9 0 1.6.7 1.6 1.6v.8c0 .9-.7 1.6-1.6 1.6H19c-1.7 0-3-1.3-3-3z" />
    </svg>
  );
}

// Outsole — the bottom of the shoe with tread lines.
function Outsole(props) {
  return (
    <svg {...base} {...props} aria-hidden="true">
      <path d="M24 4c6 0 10 5 10 12 0 5-1 9-1 14s1 8-2 11c-2 2-12 2-14 0-3-3-2-6-2-11s-1-9-1-14C14 9 18 4 24 4z" />
      <path d="M24 8v32" />
      <path d="M16 14h16M15 20h18M15 27h18M16 34h16" />
    </svg>
  );
}

// Top-down — looking straight down at the opening + laces.
function TopView(props) {
  return (
    <svg {...base} {...props} aria-hidden="true">
      <path d="M24 4c6 0 10 5 10 12 0 5-1 9-1 14s1 8-2 11c-2 2-12 2-14 0-3-3-2-6-2-11s-1-9-1-14C14 9 18 4 24 4z" />
      <ellipse cx="24" cy="18" rx="6.5" ry="9" />
      <path d="M20.5 14h7M20.5 18h7M20.5 22h7" />
    </svg>
  );
}

// Rear / heel — the back of the shoe with collar and center seam.
function Rear(props) {
  return (
    <svg {...base} {...props} aria-hidden="true">
      <path d="M11 37V24c0-7.2 5.4-12 13-12s13 4.8 13 12v13z" />
      <path d="M9 37h30" />
      <path d="M16 16c2.6-3 13.4-3 16 0" />
      <path d="M24 12.5V22" />
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
