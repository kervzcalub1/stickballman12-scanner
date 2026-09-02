// "This shipment was sold before it landed." One chip, shown anywhere a batch, a box or a
// unit is on screen, because the flag changes what may be done with the stock: none of it
// is listed to II or the stores until somebody has said which orders the arrivals cover.
// Someone standing over a shelf has no other way to tell.
//
// Only the UNUSUAL state gets a chip — unlike PoKindChip, where every order is either
// shoes or boxes and a missing chip would be ambiguous. Here the overwhelming majority of
// shipments are ordinary, and chipping all of them is noise that teaches people to stop
// reading chips.
//
// Its own class rather than `.badge` or `.batch-pill`: it appears alongside both, and the
// point of it is to be the thing your eye catches on a row that otherwise looks routine.
import React from 'react';

export function PreSellChip({ on, sold = false, mixed = false, count = 0, className = '' }) {
  if (!on && !sold && !mixed) return null;
  // "Some of these are spoken for" is a different, more dangerous fact than "all of
  // them are" — a grouped row that hid the split would offer a pair that isn't ours.
  if (mixed) {
    return (
      <span className={`presell-chip mixed ${className}`.trim()}
        title="Part of this group was sold before it landed. Those pairs are held out of II and the stores; the rest are ordinary stock.">
        {count ? `${count} pre-sell` : 'Part pre-sell'}
      </span>
    );
  }
  // `pre_sold` is the per-unit half — spoken for by a specific order. NOT `sold`: the pair
  // is still on our floor and hasn't shipped, so it reads calmer than the shipment chip.
  return sold
    ? (
      <span className={`presell-chip sold ${className}`.trim()}
        title="Covered by a pre-sale. Still here and not yet shipped — it leaves through the normal scan-out.">
        Pre-sold
      </span>
    )
    : (
      <span className={`presell-chip ${className}`.trim()}
        title="Sold before it landed. Held out of II and the stores until the remainder is released for listing.">
        Pre-sell
      </span>
    );
}
