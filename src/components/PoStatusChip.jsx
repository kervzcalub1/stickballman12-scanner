// Where an order is, as one chip. Reads the counts, not just `purchase_orders.status` —
// see poChipOf in src/lib/postatus.js for why those disagree.
import React from 'react';
import { poChipOf } from '../lib/postatus.js';

export function PoStatusChip({ po }) {
  const s = poChipOf(po);
  return <span className={`po-chip ${s.cls}`}>{s.label}</span>;
}
