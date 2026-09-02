// Who raised this order. Purchase orders now start from either end — PH buys labels and
// opens the order around them, or the supplier packs first, declares the boxes, and asks
// for labels afterwards. The two behave differently enough (a supplier-raised order can
// have boxes with no tracking numbers at all) that every list has to say which it is.
//
// Only the unusual one gets a chip: nearly every order is still PH-raised, and a chip on
// all of them would be noise on the common case.
import React from 'react';
import { isSupplierRaised } from '../lib/postatus.js';

export function PoOriginChip({ po }) {
  if (!isSupplierRaised(po)) return null;
  return (
    <span className="po-chip kind supplier" title="The supplier raised this order and declared its boxes; the labels are assigned afterwards.">
      From supplier
    </span>
  );
}
