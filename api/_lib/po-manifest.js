// "Can this manifest still be edited?" — one answer over two very different lifecycles,
// shared by `po/scan` (add a line) and `po/line` (edit/remove one).
//
// A SUPPLIER'S OWN label is declared before anything moves: the PO must still be a draft
// and the label still `pending`. A `packed` label is reopened first; a shipped one is
// settled and closed to edits.
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
// Returns null when the edit is allowed, else { code, error } to send straight back.
export function manifestEditBlock({ po, box }) {
  if (box && box.kind === 'replacement') {
    if (po.status === 'closed') {
      return { code: 409, error: 'This order is archived — bring it back before editing the replacement manifest.' };
    }
    return null;
  }
  if (po.status !== 'draft') {
    return { code: 409, error: 'This order is already shipped — it can no longer be edited.' };
  }
  if (box && box.status === 'packed') {
    return { code: 409, error: 'This label is closed — reopen it to add items.' };
  }
  if (box && box.status !== 'pending') {
    return { code: 409, error: 'This label is already shipped.' };
  }
  return null;
}

// Is this box a reship the warehouse raised, rather than one of the supplier's own labels?
export const isReplacementBox = (box) => !!box && box.kind === 'replacement';
