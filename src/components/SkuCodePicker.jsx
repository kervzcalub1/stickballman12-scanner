// "This shoe has more than one style code — which should the warehouse count?"
//
// Shown only when there IS a choice (two or more codes). Options are each code on its
// own, plus **All codes**, which is the default: a rescale request sends somebody to a
// shelf, and a shelf can hold pairs filed under either code. Narrowing to one is a
// deliberate act — widening is the safe state, so it is what you get for free.
import React from 'react';
import { skuCodes, joinSkuCodes } from '../lib/sku.js';

export function SkuCodePicker({ all, value, onChange, label = 'Which style code?' }) {
  const codes = skuCodes(all);
  if (codes.length < 2) return null;
  const chosen = skuCodes(value);
  const isAll = chosen.length === codes.length;
  return (
    <div className="sku-pick">
      <span className="sku-pick-lbl muted sm">{label}</span>
      <div className="sku-pick-opts" role="group" aria-label={label}>
        <button type="button" className={`btn sm ${isAll ? 'primary' : 'ghost'}`}
          title="The warehouse counts pairs filed under any of these codes"
          onClick={() => onChange(joinSkuCodes(codes))}>
          All {codes.length} codes
        </button>
        {codes.map((c) => {
          const on = !isAll && chosen.length === 1 && chosen[0].toUpperCase() === c.toUpperCase();
          return (
            <button key={c} type="button" className={`btn sm ${on ? 'primary' : 'ghost'} mono`}
              title={`Count only pairs filed under ${c}`}
              onClick={() => onChange(c)}>{c}</button>
          );
        })}
      </div>
    </div>
  );
}
