// What an order is FOR, as one chip: shoes, or the empty shoe boxes we buy to replace
// the crushed and missing ones. Shown to every role — PH raising the order, the supplier
// packing it, the warehouse unpacking it — because nothing else on those screens says
// which it is, and a box manifest read as a shoe manifest is a shipment counted wrong.
//
// Both kinds get a chip rather than only the unusual one: an order with NO kind chip is
// indistinguishable from an order on a screen that hasn't been updated yet.
import React from 'react';
import { orderKindChip } from '../lib/postatus.js';

export function PoKindChip({ po }) {
  if (!po) return null;
  const k = orderKindChip(po);
  return <span className={`po-chip kind ${k.cls}`} title={k.title}>{k.label}</span>;
}
