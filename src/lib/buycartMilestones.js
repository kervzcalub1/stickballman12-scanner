// The ten milestones of a buying request, and which one a request is AT.
//
// A courier's tracking page: a row of dots, the ones behind you filled, the one you are
// on lit, the rest waiting. The request's status column does not give this on its own —
// "receipted" covers everything from "the receipt just landed" to "every box is sealed
// and waiting on a label", and the back half of the process lives on the purchase order
// and its boxes rather than on the request at all. So the step is DERIVED from the facts,
// evaluated from the end backwards: the furthest milestone the evidence supports wins.
//
// Pure. Takes the `cart` as `cart/get` returns it (with `po`, `pack`, the audit stamps)
// and never touches the clock.

// Two words per stop. `label` is the stop while the request is ON it or short of it —
// what it is waiting for. `done` is the same stop once it is behind — what happened.
// A dot that is filled green and still reads "Waiting for approval" says two opposite
// things at once, and the buyer reading it from a shop floor believed the words.
export const MILESTONES = [
  { key: 'request',   label: 'Purchase request',     done: 'Requested' },
  { key: 'approval',  label: 'Waiting for approval', done: 'Approved' },
  { key: 'cards',     label: 'Waiting for gift card', done: 'Gift card issued' },
  { key: 'receipt',   label: 'Waiting for receipt',  done: 'Receipt in' },
  { key: 'packing',   label: 'Sorting / packing',    done: 'Packed' },
  { key: 'manifest',  label: 'Waiting for manifest', done: 'Manifest in' },
  { key: 'labels',    label: 'Waiting for labels',   done: 'Labels sent' },
  { key: 'shipping',  label: 'Shipping',             done: 'Shipped' },
  { key: 'delivered', label: 'Delivered',            done: 'Delivered' },
  { key: 'audited',   label: 'Audited',              done: 'Audited' },
];

const STOPPED = { denied: 'Denied', cancelled: 'Cancelled', written_off: 'Written off' };

// The parcel's own milestones are on the boxes, not the order: a replacement box the
// supplier reships is not part of "did the shipment arrive".
const realBoxes = (cart) => (cart?.pack?.boxes || []).filter((b) => b.kind !== 'replacement');

/**
 * @returns {{ index:number, key:string, label:string, complete:boolean, stopped:string|null }}
 *   `index` is the milestone the request is at (0-based). `complete` means the last one
 *   is behind it too. `stopped` names why it will not move again, or null.
 */
export function milestoneFor(cart) {
  const status = cart?.status;
  const po = cart?.po || null;
  const pack = cart?.pack || null;
  const boxes = realBoxes(cart);
  const withTracking = boxes.length > 0 && boxes.every((b) => b.tracking_number);
  const past = (states) => boxes.some((b) => states.includes(b.status));
  const allPacked = !!pack && pack.totalQty > 0 && pack.unpacked === 0;
  const allClosed = boxes.length > 0 && boxes.every((b) => b.status !== 'pending');

  let index;
  if (status === 'closed') index = 10;                                  // everything behind it
  else if (cart?.goods_audited_at || ['reconciled', 'closed'].includes(po?.status)) index = 9;
  else if (po?.status === 'receiving' || (boxes.length > 0 && boxes.every((b) => b.status === 'delivered'))) index = 8;
  else if (po?.status === 'shipped' || past(['shipped', 'in_transit']) || withTracking) index = 7;
  else if (po?.labels_requested_at || (allPacked && allClosed)) index = 6;
  else if (allPacked) index = 5;
  else if (['receipted', 'audited'].includes(status) || cart?.po_id) index = 4;
  else if (status === 'funded') index = 3;
  // Every line approved but the buyer has NOT closed the list yet: the desk cannot fund
  // a total that is still growing, so the request is still at approval, not at cards.
  else if (status === 'approved') index = cart?.list_closed_at ? 2 : 1;
  else if (status === 'submitted') index = 1;
  else index = 0;

  // A request that stopped stays on the dot it stopped at, marked so — "denied" belongs
  // on "waiting for approval", not on a bar that pretends it is still moving.
  const stopped = STOPPED[status] || null;
  if (status === 'denied') index = 1;

  const complete = index >= MILESTONES.length;
  const at = MILESTONES[Math.min(index, MILESTONES.length - 1)];
  return { index: Math.min(index, MILESTONES.length - 1), key: at.key, label: at.label, complete, stopped };
}
