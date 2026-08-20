// Purchase-order status vocabulary, shared by the PO list and the PO page.
//
// Extracted when the order detail moved to its own screen (`PoDetail.jsx`): both places
// have to say the same thing about the same order, and a second copy of poChipOf is
// exactly how a list and a page start disagreeing about where a shipment is.
export const PO_STATUS = {
  draft:      { label: 'Filling',    cls: 'draft' },
  shipped:    { label: 'Shipped',    cls: 'shipped' },
  receiving:  { label: 'Receiving',  cls: 'receiving' },
  reconciled: { label: 'Reconciled', cls: 'ok' },
  closed:     { label: 'Closed',     cls: 'muted' },
};

export const boxStatusLabel = (s) => (s === 'delivered' ? 'Delivered ✓'
  : s === 'in_transit' ? 'In transit'
  : s === 'pre_transit' ? 'With supplier · label made'
  : s === 'shipped' ? 'Shipped'
  : s === 'packed' ? 'Ready to ship' : 'Filling');

export const boxChipCls = (s) => (s === 'delivered' ? 'ok'
  : s === 'in_transit' ? 'receiving'
  : s === 'pre_transit' ? 'pretransit'
  : s === 'shipped' ? 'shipped'
  : s === 'packed' ? 'packed' : 'draft');

// 17TRACK's checkpoint text is very often the status over again, shouted — a label read
// "UPS · Delivered" and then "Delivered, DELIVERED" underneath. Show the checkpoint only
// when it says something the status line didn't.
export const trackWords = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export function checkpointAdds(checkpoint, status) {
  const c = trackWords(checkpoint);
  if (!c) return false;
  const said = new Set(trackWords(status).split(' ').filter(Boolean));
  return c.split(' ').filter(Boolean).some((w) => !said.has(w));
}

// The chip says where the ORDER actually is, which is not the same as the raw status
// column. `purchase_orders.status` only ever advances as far as `receiving`, and an order
// received with nothing declared never auto-reconciles (that decision is a person's), so
// PO-100003 sat reading "Receiving" with all nine labels delivered and 54 pairs counted —
// contradicting the very line underneath it. The same wrong-by-a-stage bug shows one step
// earlier too: a `draft` order whose labels have all shipped read "Filling", as if the
// supplier were still packing.
//
// So: once every label has landed, say so; the reconciliation queue owns what happens next.
// Falls back to the raw status whenever the counts can't say better (a supplier's own
// response carries no `received_units`, and older callers pass no counts at all).
export function poChipOf(p) {
  if (p.status === 'reconciled' || p.status === 'closed') return PO_STATUS[p.status];
  const boxes = Number(p.box_count) || 0;
  const delivered = Number(p.delivered_count) || 0;
  const shipped = Number(p.shipped_count) || 0;
  const received = Number(p.received_units) || 0;
  if (boxes > 0 && delivered === boxes) {
    return received > 0
      ? { label: 'Delivered · to reconcile', cls: 'ok' }
      : { label: 'All delivered', cls: 'ok' };
  }
  if (p.status === 'receiving') return PO_STATUS.receiving;
  // A label out with the carrier means the supplier has stopped filling, whatever the
  // order row still says.
  if (shipped > 0) return PO_STATUS.shipped;
  return PO_STATUS[p.status] || { label: p.status, cls: 'muted' };
}
