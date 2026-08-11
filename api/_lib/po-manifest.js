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
