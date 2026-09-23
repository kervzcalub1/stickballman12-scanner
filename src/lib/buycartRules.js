// When a buying request can still be DECIDED, and when the buyer can still ADD to it —
// in one place both sides read.
//
// It lived only on the server, so `cart/decide` refused a draft while the screen drew
// the checkboxes, "Approve selected" and "Approve all 3" anyway — a full set of controls
// whose only possible outcome was a red line under them. A button that cannot work is
// worse than no button: it reads as a broken feature rather than as a step that has not
// happened yet, and on a money screen it invites somebody to keep clicking.
//
// Shared the same way `payout.js` is: pure functions in `src/lib`, imported by the
// endpoint AND the screen, so the rule cannot drift into two versions that disagree.

// Before the buyer has asked about anything, there is nothing to decide. After the
// request is finished there is nothing left to decide either.
export const DECISIONS_NOT_YET = ['draft'];
export const DECISIONS_FROZEN = ['closed', 'cancelled', 'written_off'];
// Once the cards are out, the approvals they were issued against are what the money was
// released for, and re-deciding one would leave the spend and the approval describing
// two different things. But a pair the buyer added AFTER re-opening the list is still a
// question — so on these statuses only PENDING lines can be decided, and nothing can be
// overridden. The server filters the targets; the screen only ever offers pending lines.
export const DECISIONS_PENDING_ONLY = ['funded', 'receipted', 'audited'];

export const decisionsOpen = (status) =>
  !DECISIONS_NOT_YET.includes(status) && !DECISIONS_FROZEN.includes(status);

export const decisionsPendingOnly = (status) => DECISIONS_PENDING_ONLY.includes(status);

/**
 * WHY they are closed, in the words the person in front of the screen needs.
 *
 * The two reasons are not interchangeable: one is "wait", the other is "too late", and
 * an approver who is told the wrong one goes and does the wrong thing about it.
 * Returns null while decisions are open.
 */
export function decisionsClosedBecause(status) {
  if (DECISIONS_NOT_YET.includes(status)) return 'The buyer hasn’t asked about anything yet — nothing to approve until they add a pair.';
  if (DECISIONS_FROZEN.includes(status)) return 'This request is finished, so its approvals are frozen.';
  return null;
}

// ---------------------------------------------------------------------------
// The buyer's LIST: open until they close it.
//
// A buyer works a shop for an hour and asks about pairs as they find them; each add is
// its own question to the desk. "Close the request" says the list is complete — that is
// when the gift-card desk may fund it. The list can be re-opened (the group is told)
// right up until the receipt is in; from there the purchase has happened and anything
// else is a new request.

// Statuses on which the buyer may still be adding, or may re-open to add.
export const LIST_ADDABLE = ['draft', 'submitted', 'approved', 'denied', 'funded'];

export const listOpen = (cart) => !!cart && !cart.list_closed_at;

/** May the buyer add a pair right now? Open list, and the request has not moved past funding. */
export const buyerCanAdd = (cart) => listOpen(cart) && LIST_ADDABLE.includes(cart?.status);

/** May the buyer close the list? Same window, and there has to be something on it. */
export const buyerCanClose = (cart) => listOpen(cart) && LIST_ADDABLE.includes(cart?.status) && Number(cart?.line_count) > 0;

/** May the buyer re-open a closed list? Until the receipt is in. */
export const buyerCanReopen = (cart) => !!cart?.list_closed_at && ['submitted', 'approved', 'denied', 'funded'].includes(cart?.status);

/** Why a closed list cannot be re-opened, or null. */
export function reopenRefusedBecause(cart) {
  if (!cart?.list_closed_at) return null;
  if (buyerCanReopen(cart)) return null;
  if (['receipted', 'audited', 'closed'].includes(cart.status)) return 'The receipt is already in — open a new request for anything else.';
  return 'This request is finished.';
}

/**
 * May the gift-card desk record a card against this request? The list has to be closed
 * — a card issued against a list still growing is a card issued against an unknown
 * total — and every line decided, so the target is the final one.
 *
 * Still open once the receipt is in and after the money audit (2026-09-23). A receipt
 * the recorded cards don't cover — $400 of cards against a $422.18 till — means a card
 * was spent that nobody recorded, and with the desk locked out the only way to close
 * the request was to misstate a card's spend. Recording it adds a card with no spend
 * yet, which re-opens "Gift card spending was reconciled" until the auditor records it.
 */
export const CARDS_RECORDABLE = ['approved', 'funded', 'receipted', 'audited'];
export const cardsIssuable = (cart) =>
  !!cart?.list_closed_at && CARDS_RECORDABLE.includes(cart?.status) && Number(cart?.pending_count) === 0;

/** A card recorded now is one the buyer already SPENT, not one being handed over. */
export const cardsAfterPurchase = (cart) => ['receipted', 'audited'].includes(cart?.status);

/** Why cards cannot be recorded yet, in words for the desk. Null when they can. */
export function cardsRefusedBecause(cart) {
  if (cardsIssuable(cart)) return null;
  if (['closed', 'cancelled', 'written_off'].includes(cart?.status)) return 'This request is finished.';
  if (!CARDS_RECORDABLE.includes(cart?.status)) {
    return cart?.status === 'submitted' || cart?.status === 'draft'
      ? 'This request has not been approved yet — no approval, no gift cards.'
      : 'Gift cards can only go against an approved request.';
  }
  if (!cart?.list_closed_at) return 'The buyer is still adding to this request — cards wait until they close it.';
  if (Number(cart?.pending_count) > 0) return `${cart.pending_count} line${Number(cart.pending_count) === 1 ? ' is' : 's are'} still waiting for a decision — cards wait until every line is decided.`;
  return 'Gift cards can only go against an approved request.';
}
