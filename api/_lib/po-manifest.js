// "Can this manifest still be edited?" — one answer over two very different lifecycles,
// shared by `po/scan` (add a line) and `po/line` (edit/remove one).
//
// A SUPPLIER'S OWN label is gated on THE LABEL, not the order: it's open while the parcel
// is still with them (`pending` or `pre_transit`), `packed` is reopened first, and one the
// carrier has actually taken is settled and closed to edits.
//
// `pre_transit` is the one that bit us. Tracking is registered when the PO is CREATED, so
// the carrier acknowledges the label within minutes and 17TRACK reports InfoReceived —
// "Label Created, UPS has not received the package yet". That flipped every box out of
// `pending` before the supplier had packed a thing, and with it went their ability to add
// items, close the box, or ship it. The parcel is demonstrably still in their hands; the
// chip on their own screen says "Label made · with supplier".
//
// Keying it on the ORDER being a `draft` was wrong for the same family of reason: a
// multi-label order flips to `receiving` the moment the first box lands, which locked
// every label still sitting at the supplier, including one added afterwards.
//
// The order-level bar is only that its count is FROZEN — reconciled or archived — because
// at that point the manifest is the evidence the reconciliation was settled against.
//
// A REPLACEMENT label is the mirror image. It only exists BECAUSE the order was already
// received and came up short, so `addReplacementBox` creates it already `shipped` on a
// `receiving`/`reconciled` PO — it could never pass the draft/pending test. That's the
// whole reason reships used to carry no manifest at all, which left the warehouse
// re-scanning a reship blind with nothing to check it against. Its declaration stays open
// until the order is ARCHIVED, and its units are excluded from the reconciliation
// `expected` count (see `getPoReconciliation`), so a late edit can never move the
// shortage numbers in either direction.
//
// Label states where the parcel is still in the supplier's hands, so its manifest is
// still theirs to write. `pre_transit` = the carrier has the label on file but not the box.
export const STILL_WITH_SUPPLIER = ['pending', 'pre_transit'];

// Returns null when the edit is allowed, else { code, error } to send straight back.
export function manifestEditBlock({ po, box }) {
  if (box && box.kind === 'replacement') {
    if (po.status === 'closed') {
      return { code: 409, error: 'This order is archived — bring it back before editing the replacement manifest.' };
    }
    return null;
  }
  if (po.status === 'reconciled' || po.status === 'closed') {
    return { code: 409, error: 'This order is already reconciled — its manifest is settled and can no longer be edited.' };
  }
  if (box && box.status === 'packed') {
    return { code: 409, error: 'This label is closed — reopen it to add items.' };
  }
  if (box && !STILL_WITH_SUPPLIER.includes(box.status)) {
    return { code: 409, error: 'This label is already on its way — it can no longer be edited.' };
  }
  // No label in hand = a whole-order manifest line. Same window as ADDING one
  // (`po/scan-order`): a list from a supplier who doesn't use the portal routinely turns
  // up after the boxes do. Being able to add a line but not fix it was never intended.
  if (!box && po.status !== 'draft' && po.status !== 'receiving') {
    return { code: 409, error: 'This order is no longer being received — its manifest can no longer be edited.' };
  }
  return null;
}

// Is this box a reship the warehouse raised, rather than one of the supplier's own labels?
export const isReplacementBox = (box) => !!box && box.kind === 'replacement';

// The supplier's per-pair money (cost, tip) off a request body. Three outcomes, kept
// distinct because they mean different things to the row:
//   undefined -> the field wasn't sent; leave whatever is stored alone
//   null      -> sent empty; CLEAR it. "I don't know what this cost" is not "it was free",
//                so this must never collapse to 0.
//   NaN       -> sent, but not a usable amount; the caller decides (scan ignores it,
//                an explicit edit rejects it)
export function parseMoney(v) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1e7) return NaN;
  return Math.round(n * 100) / 100;
}

// Scan-time variant: money is optional there and a junk value shouldn't fail the scan,
// so anything unusable is simply not recorded.
export function money(v) {
  const m = parseMoney(v);
  return m === undefined || Number.isNaN(m) ? null : m;
}
